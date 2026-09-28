'use strict';
/* layouts.js - WINDOW LAYOUTS (lane layouts, 2026-09-27).
 *
 * Owen arranges the same windows over and over: "Work" (Quartz with the lesson, his notes), "Code"
 * (terminals, editors). Windows cannot keep that (Snap Groups vanish on a reboot). Here:
 *   Mantle menu > Save layout > New layout…    name what is on screen now (or Replace <name>)
 *   Mantle menu > Layouts > Work             put it back, with one click
 *   the launcher: "school" -> Layout: Work   the same (lib/launcher-layouts.js)
 *   Mantle menu > Layouts > Rename / Delete
 * A pop-up (ui/layouts/, the volume pop-up's look and place) says what happened:
 *   "Work: 3 placed, 1 opened, 1 not found (Notion isn't installed)"
 * and one line for each window that did not go where it was saved, with its reason.
 *
 * The rules are _layouts-core.js (what is saved, matching, rect maths, which apps may be started),
 * the steps _layouts-run.js, the Windows half sidecar/Layouts.cs. Stored in this feature's settings
 * (layouts.json): exe paths, AUMIDs, rects, and title WORDS as short hashes - never a title.
 *
 * MINIMISED windows are left out of a saved layout (it is what is on screen); a matched window that
 * is minimised when the layout comes back is restored into its spot.
 * MISSING apps are STARTED by default (one click is the point), when the start is known to be the
 * right app: an AUMID (Store apps, Terminal, Chrome), Quartz (electron.exe + its folder, as the
 * launcher starts it), or a plain exe. A host exe alone (electron.exe, java, python) is not started:
 * its line says so. Each started app's windows are placed when they appear (up to 10 s).
 *
 * REST: `rest: true` - stopped while a game runs or game mode is on; its commands then answer
 * "resting", the launcher rows go, and a restore in flight stops at its next window.
 * --test: Owen's windows are never saved (fixtures only) and a restore of his windows is a DRY RUN
 * (the pop-up lists what it would do); nothing is started except sidecar/test-layouts.js's fixture.
 * PRIVACY: the log gets counts and app names, never a title or a path.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const core = require('./_layouts-core');
const engine = require('./_layouts-run');
const bridge = require('../launcher-layouts');
const M = require('../../ui/osd/osd-model.js');   // the volume pop-up's placement

const WIDTH = 460;
const MARGIN = 18;              // ui/layouts/layouts.css --m
const TOAST_IDLE_MS = 30000;    // the pop-up's renderer is destroyed after this long unused (RAM)
const FIXTURE_DIR = path.join(os.tmpdir(), 'mantle-layouts');

function spawnApp(exe, args) {
  return new Promise((resolve) => {
    let done = false;
    const end = (r) => { if (!done) { done = true; resolve(r); } };
    try {
      const c = cp.spawn(exe, args || [], { detached: true, stdio: 'ignore', windowsHide: false });
      c.once('error', (e) => end({ ok: false, reason: e && e.code === 'ENOENT' ? 'the program is not there' : String((e && e.message) || e) }));
      c.once('spawn', () => { c.unref(); end({ ok: true }); });
    } catch (e) {
      end({ ok: false, reason: String((e && e.message) || e) });
    }
  });
}

module.exports = {
  name: 'layouts',
  label: 'Window layouts (Mantle menu > Layouts)',
  defaultOn: true,
  chords: [],
  observe: [],
  rest: true,
  install(ctx) {
    const test = !!ctx.flags.test;
    let stopped = false;
    let busy = null;
    let last = null;
    const HEALTHY = 'Mantle menu > Layouts saves and puts back how your windows are arranged';
    /* THE STORED FILE IS CHECKED, NEVER TRUSTED (secreview-win, 2026-09-27). ctx.settings reads an
       unparseable file as empty, and sanitize() drops what it cannot use: both were silent, and the
       next save then wrote over the file. Now either is said (tray health + one log line, with counts
       and never a name) and the file is copied aside first. The JSON error is not quoted: V8 puts a
       piece of the file (layout names) in it. */
    let problem = null;
    function readStored() {
      const why = {};
      const raw = ctx.settings.get('layouts', undefined);
      const file = ctx.settings.file;
      let bad = null;
      if (raw === undefined && file) {
        let size = 0;
        try { size = fs.statSync(file).size; } catch (_) { size = 0; }   // no file yet: nothing was saved
        if (size > 8 * 1024 * 1024) bad = `it is ${Math.round(size / 1048576)} MB, far more than any layouts`;
        else if (size) {
          try {
            const all = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (!all || typeof all !== 'object' || Array.isArray(all)) bad = 'it does not hold a settings object';
          } catch (_) { bad = 'it is not valid JSON'; }
        }
      }
      const out = core.sanitize(raw === undefined ? [] : raw, why);
      if (!bad && (why.layouts || why.entries)) {
        bad = `${why.layouts ? `${why.layouts} saved layout${why.layouts === 1 ? '' : 's'}` : ''}${why.layouts && why.entries ? ' and ' : ''}` +
          `${why.entries ? `${why.entries} saved window${why.entries === 1 ? '' : 's'}` : ''} in it could not be read and ${why.layouts + why.entries === 1 ? 'is' : 'are'} left out`;
      }
      if (bad) {
        const name = path.basename(file || 'layouts.json');
        let kept = '';
        try { fs.copyFileSync(file, file + '.unreadable', fs.constants.COPYFILE_EXCL); kept = `; a copy is kept as ${name}.unreadable`; } catch (err) {
          kept = err && err.code === 'EEXIST' ? `; an earlier copy is kept as ${name}.unreadable` : `; it could not be copied aside (${err && err.code}), and the next save replaces it`;
        }
        problem = `${name}: ${bad}${kept}`;
        ctx.log(`the saved layouts: ${problem}`);
      }
      return out;
    }
    let list = readStored();
    ctx.health(!problem, problem ? `window layouts work, but ${problem}` : HEALTHY);

    const state = () => ({ layouts: list.map(core.brief), enabled: ctx.enabled(), test, busy, problem });
    ctx.replay('layouts.state', state);
    function publish() {
      if (stopped) return;
      ctx.broadcast('layouts.state', state());
      if (ctx.enabled()) bridge.set(list.map(core.brief), (name, o) => restoreCmd({ name, via: o && o.via, dryRun: o && o.dryRun }));
      else bridge.clear('window layouts are switched off in the tray');
    }
    function persist(next) {
      ctx.settings.set('layouts', next);   // throws in plain words if it cannot write
      list = next;
      if (problem) { problem = null; ctx.health(true, HEALTHY); }   // the file is whole again (the unreadable copy stays)
      publish();
    }

    /* ---- the pop-up (ui/layouts/): made on first use, destroyed when idle ---- */
    let win = null, idle = null, backstop = null, winErr = null;
    const heightFor = (p) => 60 + 2 * MARGIN + 18 * Math.min(5, (p.lines || []).length) + (String(p.text || '').length > 58 ? 17 : 0);
    function toastWin() {
      if (win && !win.isDestroyed()) return win;
      const { BrowserWindow } = require('electron');
      win = new BrowserWindow({
        show: false, frame: false, transparent: true, skipTaskbar: true, hasShadow: false, focusable: false,
        resizable: false, movable: false, minimizable: false, maximizable: false, alwaysOnTop: true,
        width: WIDTH + 2 * MARGIN, height: 60 + 2 * MARGIN, x: -32000, y: -32000,
        webPreferences: { preload: ctx.preload, contextIsolation: true, sandbox: true, nodeIntegration: false },
      });
      win.setAlwaysOnTop(true, 'screen-saver');
      win.setIgnoreMouseEvents(true);
      const wc = win.webContents;
      wc.on('will-navigate', (e) => e.preventDefault());
      wc.setWindowOpenHandler(() => ({ action: 'deny' }));
      const broke = (why) => { winErr = why; ctx.log(`the pop-up ${why}; results still go to the log`); try { win.destroy(); } catch (_) { /* gone */ } win = null; };
      wc.on('render-process-gone', (_e, d) => broke(`page crashed (${d && d.reason})`));
      wc.on('did-fail-load', (_e, code, desc) => broke(`page did not load (${desc || code})`));
      win.loadFile(ctx.page('index.html'));
      return win;
    }
    function toast(p) {
      if (stopped || !p) return;
      try {
        const w = toastWin();
        const d = ctx.host.display();
        const size = { w: WIDTH + 2 * MARGIN, h: heightFor(p) };
        const at = M.place(ctx.host.barRect(), d.workArea, size, 0);
        w.setBounds({ x: at.x, y: at.y, width: at.width, height: at.height });
        const payload = { text: p.text, lines: p.lines || [], tone: p.tone || '', below: !!at.below };
        if (w.webContents.isLoading()) w.webContents.once('did-finish-load', () => ctx.push(w, 'layouts.toast', payload));
        else ctx.push(w, 'layouts.toast', payload);
        if (!test) w.showInactive();          // --test: never in front of Owen; the page still draws
        clearTimeout(backstop);
        backstop = setTimeout(hideToast, 2600 + 1400 * Math.min(5, (p.lines || []).length) + 2500);
        clearTimeout(idle);
      } catch (err) {
        ctx.log(`the pop-up could not show (${err && err.message}); the command still answered its caller with the outcome`);
      }
    }
    function hideToast() {
      clearTimeout(backstop);
      if (win && !win.isDestroyed()) { win.hide(); win.setBounds({ x: -32000, y: -32000, width: WIDTH + 2 * MARGIN, height: 60 + 2 * MARGIN }); }
      clearTimeout(idle);
      idle = setTimeout(() => { if (win && !win.isDestroyed()) win.destroy(); win = null; }, TOAST_IDLE_MS);
      if (idle.unref) idle.unref();
    }
    ctx.command('faded', async () => { hideToast(); return { ok: true }; });

    /* ---- the Windows half, fenced by stop() ---- */
    const send = (cmd, args, o) => (stopped ? Promise.resolve({ ok: false, error: 'window layouts stopped (a game started, or Mantle is closing)' })
      : ctx.sidecar.send(cmd, args, o));
    const isFixtureExe = (p) => test && String(p || '').toLowerCase().startsWith((FIXTURE_DIR + path.sep).toLowerCase()) &&
      /mantle-layouts-fixture\.exe$/i.test(String(p));
    const guard = (needSidecar) => {
      if (!ctx.enabled()) return 'window layouts are switched off in the tray';
      if (needSidecar && !ctx.sidecar.ready) return 'the sidecar is not running right now, so Mantle cannot see the windows';
      return null;
    };

    /* ---- save ---- */
    ctx.command('list', async () => Object.assign({ ok: true }, state()));
    ctx.command('save', async (a) => {
      const g = guard(true);
      if (g) return { ok: false, reason: g };
      const n = core.cleanName(a && a.name);
      if (!n.ok) return { ok: false, reason: n.reason };
      const existing = core.findLayout(list, n.name);
      if (existing && !(a && a.replace)) return { ok: false, reason: 'there is already a layout with that name: pick it under Save layout > Replace to overwrite it' };
      if (!existing && list.length >= core.MAX_LAYOUTS) return { ok: false, reason: `Mantle keeps ${core.MAX_LAYOUTS} layouts: delete one first` };
      const r = await send('layouts.windows', {}, { timeoutMs: 6000 });
      if (!r.ok) {
        const why = /unknown command/i.test(String(r.error)) ? 'the sidecar exe is older than window layouts (npm run build:sidecar)' : r.error;
        return { ok: false, reason: `could not read the open windows (${why})` };
      }
      const snap = core.snapshot(r.result, { test });
      const left = core.leftWords(snap.left);
      if (!snap.entries.length) {
        const reason = 'there are no windows on screen to save' + (left.length ? ` (${left.join('; ')})` : '');
        toast({ text: `${n.name}: not saved`, lines: [reason], tone: 'warn' });
        return { ok: false, reason };
      }
      const layout = { name: existing ? existing.name : n.name, savedAt: new Date().toISOString(), entries: snap.entries };
      try {
        persist(existing ? list.map((l) => (l === existing ? layout : l)) : list.concat([layout]));
      } catch (err) {
        return { ok: false, reason: `could not save it (${(err && err.message) || err})` };
      }
      const b = core.brief(layout);
      const text = `${existing ? 'Replaced' : 'Saved'} ${layout.name}: ${b.count} window${b.count === 1 ? '' : 's'}${b.apps.length ? ` (${b.apps.join(', ')})` : ''}`;
      ctx.log(`${existing ? 'replaced' : 'saved'} a layout of ${b.count} windows (${b.apps.join(', ')})${left.length ? '; ' + left.join('; ') : ''}`);
      toast({ text, lines: left });
      return { ok: true, name: layout.name, count: b.count, text, lines: left, replaced: !!existing };
    });

    /* ---- restore ---- */
    async function restoreCmd(a) {
      const g = guard(true);
      if (g) return { ok: false, reason: g };
      const l = core.findLayout(list, a && a.name);
      if (!l) return { ok: false, reason: 'there is no layout with that name (it may have been renamed or deleted)' };
      if (busy) return { ok: false, reason: 'another layout is being put back right now' };
      busy = l.name;
      publish();
      const deps = { send, spawn: spawnApp, exists: (p) => { try { return fs.existsSync(p); } catch (_) { return false; } },
        test, dryRun: !!(a && a.dryRun), isFixtureExe, log: ctx.log };
      const p = engine.restore(l, deps).then((res) => res, (err) => ({ ok: false, reason: `it stopped with an error (${(err && err.message) || err})` }))
        .then((res) => {
          busy = null;
          publish();
          if (!res.ok) {
            ctx.log(`a layout was not put back: ${res.reason}`);
            toast({ text: `${l.name}: not put back`, lines: [res.reason], tone: 'warn' });
            last = { at: new Date().toISOString(), ok: false, text: `${l.name}: not put back`, lines: [res.reason] };
            return res;
          }
          const bad = res.counts.notfound + res.counts.refused + res.counts.failed;
          ctx.log(`put a layout back${res.dryRun ? ' (dry run)' : ''}: ${JSON.stringify(res.counts)}${res.lines.length ? '; ' + res.lines.join('; ') : ''}`);
          toast({ text: res.text, lines: res.lines, tone: bad ? 'warn' : '' });
          last = { at: new Date().toISOString(), ok: true, text: res.text, lines: res.lines, counts: res.counts, dryRun: res.dryRun, via: (a && a.via) || 'the menu' };
          return res;
        });
      // The menu and the launcher close at once; the pop-up tells the outcome (starting an app can take
      // 10 s). A launcher dry run (a --test instance) waits and quotes it instead.
      if (a && (a.wait || a.dryRun)) {
        const res = await p;
        return a.dryRun && res.ok ? Object.assign({}, res, { reason: 'dry run: ' + res.text }) : res;
      }
      return { ok: true, started: true, name: l.name };
    }
    ctx.command('restore', (a) => restoreCmd(a || {}));
    ctx.command('last', async () => (last ? Object.assign({ ok: true }, last) : { ok: true, none: true }));

    /* ---- manage ---- */
    ctx.command('rename', async (a) => {
      const g = guard(false);
      if (g) return { ok: false, reason: g };
      const l = core.findLayout(list, a && a.from);
      if (!l) return { ok: false, reason: 'there is no layout with that name (it may have been renamed or deleted)' };
      const n = core.cleanName(a && a.to);
      if (!n.ok) return { ok: false, reason: n.reason };
      const clash = core.findLayout(list, n.name);
      if (clash && clash !== l) return { ok: false, reason: 'there is already a layout with that name' };
      try { persist(list.map((x) => (x === l ? Object.assign({}, l, { name: n.name }) : x))); } catch (err) {
        return { ok: false, reason: `could not rename it (${(err && err.message) || err})` };
      }
      toast({ text: `Renamed ${l.name} to ${n.name}` });
      return { ok: true, name: n.name };
    });
    ctx.command('delete', async (a) => {
      const g = guard(false);
      if (g) return { ok: false, reason: g };
      const l = core.findLayout(list, a && a.name);
      if (!l) return { ok: false, reason: 'there is no layout with that name (it may have been renamed or deleted)' };
      if (busy === l.name) return { ok: false, reason: 'that layout is being put back right now' };
      try { persist(list.filter((x) => x !== l)); } catch (err) {
        return { ok: false, reason: `could not delete it (${(err && err.message) || err})` };
      }
      toast({ text: `Deleted the layout ${l.name}` });
      return { ok: true };
    });
    ctx.command('state', async () => Object.assign({ ok: true, toastError: winErr, last }, state()));

    ctx.onEnabled(() => publish());
    publish();

    return {
      stop(why, how) {
        stopped = true;
        bridge.clear(how && how.rest ? `window layouts are resting while ${why}` : `window layouts stopped (${why})`);
        clearTimeout(backstop); clearTimeout(idle);
        if (win && !win.isDestroyed()) win.destroy();
        win = null;
      },
    };
  },
};
