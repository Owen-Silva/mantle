'use strict';
/* ontop.js - KEEP ANY WINDOW ON TOP (lane ontop, 2026-09-27).
 *
 * Windows cannot pin a window above the others (only PowerToys adds it). Owen watches lesson videos,
 * codes and games: a video, notes or a calculator kept over whatever he works in is the win.
 *   Win+Ctrl+T                        flips "on top" for the window in front (PowerToys' own key;
 *                                     not a Windows shortcut: see sidecar/AltTab.cs ChordNames)
 *   bar right-click > Keep on top     the same for that app's window (ui/bar/jumplist.js)
 *   a pin badge on the app's bar icon (ui/bar/ontop.js), a pop-up "Kept on top: <app>" /
 *   "No longer on top: <app>" (ui/ontop/, the volume pop-up's look and place), one log line each.
 * The rules are _ontop-core.js; the Windows half is sidecar/WindowTop.cs (SetWindowPos TOPMOST,
 * verified by re-reading WS_EX_TOPMOST; Mantle's own windows, the shell, hung and elevated windows
 * refused in words).
 *
 * PUT BACK: stop() (quit, "Put Windows back", tray off) takes every Mantle pin off top. A crash
 * skips stop(), so the pins are saved (ctx.settings 'pins') on every change and the next start puts
 * back the ones still on top (core.adopt).
 *
 * REST (a known game runs / game mode on): `rest: true`. Pins are Owen's choice, so they SURVIVE a
 * game, but a window kept on top would sit over a borderless full-screen game (and break its
 * independent flip). So stop(why, {rest:true}) takes them off top and keeps the list HERE, in module
 * scope (the module outlives the rest; install() runs again after); the wake puts each back on top
 * if it is still the same, open window. The chord is Windows' while resting (the seam's rule), and
 * Windows does nothing with Win+Ctrl+T.
 *
 * --test: the sidecar is passive, so every pin of a real window is a DRY RUN ("Dry run: would keep
 * <app> on top"); only sidecar/test-ontop.js's fixture can really be pinned. The pop-up window runs
 * hidden (never in front of Owen); its page still draws and reports.
 */
const { createCore } = require('./_ontop-core');
const M = require('../../ui/osd/osd-model.js');   // the volume pop-up's placement: same spot, same gap
const raiseWin = require('../raise');

const CHORD = 'Win+Ctrl+T';
const SWEEP_MS = 2000;        // pinned windows checked for closed / taken off top (one cheap read, only while pinned)
const TOAST_MS = 1800;        // the page fades itself out after this; the backstop is a little later
const TOAST_IDLE_MS = 30000;  // the pop-up's renderer is destroyed after this long unused (RAM, memfix)
const MARGIN = 18;            // ui/ontop/ontop.css --m

let suspended = null;         // module scope ON PURPOSE: survives stop(rest) -> install() (see REST)

module.exports = {
  name: 'ontop',
  label: 'Keep a window on top (Win+Ctrl+T)',
  defaultOn: true,
  chords: [CHORD],
  observe: [],
  rest: true,
  install(ctx) {
    const test = !!ctx.flags.test;
    let stopped = false;
    let stopping = false;
    let sweepTimer = null;
    let lastSweepErr = '';
    ctx.health(true, 'Win+Ctrl+T or right-click an app on the bar keeps its window on top');

    const state = () => ({ pinned: core.list().map((p) => ({ hwnd: p.hwnd, name: p.name })), test });
    const core = createCore({
      send: (cmd, args) => ctx.sidecar.send(cmd, args, { timeoutMs: cmd === 'ontop.set' ? 6000 : 4000 }),
      log: ctx.log,
      save: (l) => ctx.settings.set('pins', l.map((p) => ({ hwnd: p.hwnd, pid: p.pid, name: p.name }))),
      test,
      onChange: () => { if (!stopped) ctx.broadcast('ontop.state', state()); if (!stopping) arm(); },
    });
    ctx.replay('ontop.state', state);

    function arm() {
      if (core.size && !sweepTimer && !stopped) {
        sweepTimer = setInterval(async () => {
          const r = await core.sweep();
          const e = r.error || '';
          if (e && e !== lastSweepErr) ctx.log(`could not check the windows kept on top (${e}); will keep trying`);
          lastSweepErr = e;
        }, SWEEP_MS);
        if (sweepTimer.unref) sweepTimer.unref();
      } else if (!core.size && sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
    }

    /* ---- the pop-up (ui/ontop/): made on first use, destroyed when idle ---- */
    let win = null, idle = null, backstop = null, winErr = null;
    function toastWin() {
      if (win && !win.isDestroyed()) return win;
      const { BrowserWindow } = require('electron');
      win = new BrowserWindow({
        show: false, frame: false, transparent: true, skipTaskbar: true, hasShadow: false, focusable: false,
        resizable: false, movable: false, minimizable: false, maximizable: false, alwaysOnTop: true,
        width: 360 + 2 * MARGIN, height: 44 + 2 * MARGIN, x: -32000, y: -32000,
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
    function toast(res) {
      if (stopped || !res) return;
      try {
        const w = toastWin();
        const d = ctx.host.display();
        const p = M.place(ctx.host.barRect(), d.workArea, { w: 360 + 2 * MARGIN, h: 44 + 2 * MARGIN }, 0);
        w.setBounds({ x: p.x, y: p.y, width: p.width, height: p.height });
        // a new pin says how to undo it (the shortcut is otherwise only in the bar's tooltip)
        const hint = res.did === 'pinned' ? `${CHORD} again to stop` : '';
        const payload = { text: res.text, reason: res.reason, hint, tone: res.tone, did: res.did, below: !!p.below };
        if (w.webContents.isLoading()) w.webContents.once('did-finish-load', () => ctx.push(w, 'ontop.toast', payload));
        else ctx.push(w, 'ontop.toast', payload);
        if (!test) {                          // --test: never in front of Owen; the page still draws
          w.showInactive();
          // On top EVERY time (r7-ontop): the window just pinned is at the top of the topmost band, and
          // a toast that only showInactive()s would come up UNDER the very window it is talking about.
          raiseWin.up(w, { what: 'the keep-on-top pop-up', log: ctx.log, wanted: () => win === w && !w.isDestroyed() && w.isVisible() });
        }
        clearTimeout(backstop);
        backstop = setTimeout(hideToast, TOAST_MS + 2500);
        clearTimeout(idle);
      } catch (err) {
        ctx.log(`the pop-up could not show (${err && err.message})`);   // never res.text: it names the app
      }
    }
    function hideToast() {
      clearTimeout(backstop);
      if (win && !win.isDestroyed()) { win.hide(); win.setBounds({ x: -32000, y: -32000, width: 360 + 2 * MARGIN, height: 44 + 2 * MARGIN }); }
      clearTimeout(idle);
      idle = setTimeout(() => { if (win && !win.isDestroyed()) win.destroy(); win = null; }, TOAST_IDLE_MS);
      if (idle.unref) idle.unref();
    }
    ctx.command('faded', async () => { hideToast(); return { ok: true }; });

    /* ---- what Owen does ---- */
    async function facts(hwnd) {
      const r = hwnd ? await ctx.sidecar.send('ontop.info', { hwnd: String(hwnd) }) : await ctx.sidecar.send('ontop.front', {});
      if (r.ok) return r.result;
      const why = String(r.error || 'no answer');
      return { hwnd: '0', refuse: why };   // out() turns it into plain words for the pop-up (core.plain)
    }

    ctx.onChord(CHORD, async () => {
      if (!ctx.enabled()) return;
      const res = await core.toggle(await facts(null), CHORD);
      toast(res);
    });

    // bar menu: {hwnd, on} (on omitted = flip)
    ctx.command('set', async (a) => {
      if (!ctx.enabled()) return { ok: false, did: 'off', reason: 'keep on top is switched off in the tray' };
      const hwnd = a && a.hwnd;
      if (!hwnd) return { ok: false, did: 'refused', reason: 'no window was named, so nothing changed' };
      const t = await facts(hwnd);
      // HANDLE REUSE (security review #19): the bar's hwnd can be seconds old. If that window
      // closed and Windows gave its handle to another program's window, facts() describes the NEW
      // window. The caller's pid (the window's own, or its app's: a Store app's window belongs to
      // ApplicationFrameHost) must still match, or nothing is pinned.
      const want = Number(a.pid) || 0;
      if (want && !t.refuse && t.pid != null && want !== Number(t.pid) && want !== Number(t.appPid)) {
        const res = { ok: false, did: 'refused', text: 'That window has closed', reason: 'its handle now belongs to another program', tone: 'warn' };
        ctx.log(`refused (menu): ${res.text}: ${res.reason}`);   // the core's own format (note())
        toast(res);
        return res;
      }
      if (a.name) t.name = String(a.name).slice(0, 48);   // the bar's name is the one Owen sees (his browser's exe is a bare electron.exe)
      const res = typeof a.on === 'boolean' ? await core.set(t, a.on, 'menu') : await core.toggle(t, 'menu');
      toast(res);
      return res;
    });
    ctx.command('state', async () => Object.assign({ ok: true, suspended: (suspended || []).length, toastError: winErr }, state()));

    ctx.onEnabled((on) => { if (!on) core.releaseAll('switched off in the tray'); });

    /* ---- start-up: back after a game, or tidy up after a crash ---- */
    let first = true;
    ctx.sidecar.onReady(async () => {
      if (!first) return;          // a sidecar restart changes nothing in Windows: the pins stand
      first = false;
      if (suspended) {
        const saved = suspended;
        suspended = null;
        const r = await core.resume(saved, 'the game');
        for (const s of r.skipped) if (!/already on top|closed/.test(s)) toast({ text: 'Not back on top', reason: s, tone: 'warn', did: 'failed' });
        return;
      }
      await core.adopt(ctx.settings.get('pins', []));
    });

    return {
      async stop(why, how) {
        stopping = true;
        if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
        clearTimeout(backstop); clearTimeout(idle);
        if (win && !win.isDestroyed()) win.destroy();
        win = null;
        if (how && how.rest) suspended = await core.suspend(why);
        else await core.releaseAll(why);
        stopped = true;
      },
    };
  },
};
