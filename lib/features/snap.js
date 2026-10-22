'use strict';
/*
 * snap.js - Mantle's window snapping: Win+Left/Right/Up/Down, Snap Assist, and the Win+Z layouts
 * (wave 3, 2026-09-24).
 *
 * THE SPLIT. The moving is the sidecar's (sidecar/Snap.cs): one round trip per key, and the
 * sidecar finds the window, checks it can move, applies Windows' own Win+arrow state machine,
 * moves it with ONE SetWindowPos (SWP_NOACTIVATE, invisible borders corrected) and measures where
 * it landed. Measured 2026-09-24 on the user's 1920x1080 @ 125 %: ~0.3 ms of checks plus 3-5 ms of
 * SetWindowPos + measuring on a WinForms test window (sidecar/test-snap.js; the passive-only fence
 * adds ~10 ms that a live run skips). This file only decides what to SHOW afterwards:
 *   Snap Assist  after a snap into a half or quarter, the other windows as live DWM pictures in the
 *                space left empty; Enter or a click puts one there, Esc or a click away closes it.
 *   the picker   Win+Z: the layouts from ui/snap/layouts.js next to the window; a zone snaps it
 *                there and Snap Assist offers the layout's other zones one by one.
 *   the notice   why a window could not be snapped (fixed size, running as administrator, not
 *                responding, full screen...), in words, for a few seconds. NO SILENT FAILURES.
 *
 * ONE WINDOW, three faces (ui/snap/*), pre-created at install and PARKED off screen beside the
 * monitor it is about to appear on (lib/features/taskview.js parkRect, for the switcher's reasons:
 * a parked window has a warm compositor, and a window moved onto a monitor of another DPI is
 * resized by Windows). A face is drawn while parked; `snap.painted` (or REVEAL_LATE_MS) moves it on
 * screen in one setBounds. The picker and Snap Assist take the keyboard; the notice never does.
 *
 * WHAT IS NOT TOUCHED. Windows' mouse drag-to-edge snapping stays Windows' (the user's brief). Nothing
 * in Windows is changed: the hook takes the five chords only while this feature is on and healthy,
 * and stop() has nothing to put back but its own windows.
 *
 * --test: the snap window is NEVER shown (its page still runs and reports its boxes), nothing is
 * focused, and the chords act only on the test windows this file creates for its self-check
 * (lib/features/_snap-selftest.js, MANTLE_SNAP_SELFTEST=1). The passive sidecar would refuse any
 * other window anyway.
 */
const LAYOUTS = require('../../ui/snap/layouts.js');
const raiseWin = require('../raise');

const PICKER = { w: 400, h: 268 };   // DIP: the picker face plus its 16 px shadow margin
const NOTICE = { w: 440, h: 132 };
const NOTICE_MS = 4500;
const REVEAL_LATE_MS = 150;          // on screen even if the page never says painted
const PARK_GAP = 64;
const PROBE_RETRY_MS = [2000, 5000, 15000, 30000];   // the start-up probe, asked again on a timeout
const NOTICE_MAX = 260;              // DIP: a notice grows to its text (the page measures it), up to this
const ZONE_WORDS = {
  left: 'left half', right: 'right half', tl: 'top-left quarter', tr: 'top-right quarter',
  bl: 'bottom-left quarter', br: 'bottom-right quarter', full: 'whole screen',
};

module.exports = {
  name: 'snap',
  label: 'Window snapping (Win+arrows, Win+Z)',
  defaultOn: true,
  rest: true,                         // its window(s) close while a game runs (lib/features.js restAll)
  chords: ['Win+Left', 'Win+Right', 'Win+Up', 'Win+Down', 'Win+Z'],
  observe: [],

  install(ctx) {
    const { BrowserWindow, screen } = require('electron');
    const thumbs = require('../thumbs');
    const { hwndOf } = require('../windows');
    const test = !!ctx.flags.test;
    const now = () => Number(process.hrtime.bigint() / 1000n) / 1000;
    const r1 = (v) => Math.round(v * 10) / 10;

    const S = {
      win: null, hwnd: '0', seq: 0, sess: null,
      tset: thumbs.set('snap', 'the snap window', 'Snap Assist'),
      sidecar: { ok: null, reason: 'waiting for the sidecar' },
      page: { ok: false, reason: 'the snap page is loading' },
      testTarget: null,          // --test: the ONLY window the chords may act on
      testWindows: [],           // --test: [{ win, hwnd, name }]
      moves: 0,                  // how many chords have been answered (the self-check waits on it)
      last: null,                // the last chord's answer, for the self-check
      stopped: false,
    };

    // ---------------------------------------------------------------- health
    function health() {
      if (S.sidecar.ok === false) return ctx.health(false, S.sidecar.reason);
      if (!S.page.ok) return ctx.health(false, S.page.reason);
      if (S.sidecar.ok) ctx.health(true);
    }

    // The first question to a fresh helper. A busy machine (a game loading, low memory) can hold it
    // past its timeout: that is NOT "snapping is broken", so it is asked again (2026-09-29 quality
    // pass: one 3 s timeout at start-up left the feature marked down for the whole session, and
    // the --test self-check never started). Any later answer from a chord also counts as healthy.
    function probe(attempt) {
      clearTimeout(S.probeTimer);
      if (S.stopped) return;
      const gen = S.probeGen = (S.probeGen || 0) + 1;
      ctx.sidecar.send('snap.monitors', {}, { timeoutMs: 3000 }).then((r) => {
        if (S.stopped || gen !== S.probeGen) return;
        if (r.ok) S.sidecar = { ok: true, reason: null };
        else if (/unknown command/.test(r.error || '')) {
          S.sidecar = { ok: false, reason: 'Mantle\'s window helper is an older version that cannot move windows (built before Snap.cs): restart Mantle to update it' };
        } else if (attempt < PROBE_RETRY_MS.length) {
          S.sidecar = { ok: false, reason: 'waiting for Mantle\'s window helper to answer (it is busy)' };
          S.probeTimer = setTimeout(() => probe(attempt + 1), PROBE_RETRY_MS[attempt]);
        } else S.sidecar = { ok: false, reason: 'Mantle\'s window helper did not answer, so snapping may not work: restart Mantle if Win+arrows do nothing' };
        health();
      });
    }
    function answered() { if (S.sidecar.ok !== true) { clearTimeout(S.probeTimer); S.probeGen = (S.probeGen || 0) + 1; S.sidecar = { ok: true, reason: null }; health(); } }
    ctx.sidecar.onReady(() => probe(0));

    // ---------------------------------------------------------------- the window
    function alive() { return !!(S.win && !S.win.isDestroyed() && !S.win.webContents.isDestroyed()); }

    function pageDown(reason) { S.page = { ok: false, reason }; health(); end(reason); }

    /** Beside the display holding `r`, touching no display (taskview.js's rule). DIP. */
    function parkRect(r) {
      const all = screen.getAllDisplays().map((d) => d.bounds);
      const hit = (x, y) => all.some((d) => x < d.x + d.width && x + r.width > d.x && y < d.y + d.height && y + r.height > d.y);
      const b = screen.getDisplayMatching(r).bounds;
      const cands = [
        { x: r.x, y: b.y - r.height - PARK_GAP }, { x: r.x, y: b.y + b.height + PARK_GAP },
        { x: b.x - r.width - PARK_GAP, y: r.y }, { x: b.x + b.width + PARK_GAP, y: r.y },
      ];
      for (const c of cands) if (!hit(c.x, c.y)) return { x: Math.round(c.x), y: Math.round(c.y), width: Math.round(r.width), height: Math.round(r.height) };
      return { x: -32000, y: -32000, width: Math.round(r.width), height: Math.round(r.height) };
    }

    function createWindow() {
      const p = parkRect({ x: 0, y: 0, width: PICKER.w, height: PICKER.h });
      const win = new BrowserWindow({
        x: p.x, y: p.y, width: p.width, height: p.height,
        show: false, frame: false, transparent: true,
        // NOT resizable (2026-09-27, lane tbdrift): a resizable frameless window has drag handles at its
        // edges whatever thickFrame says (lib/windows.js noDragHandles). Each face is sized by setBounds,
        // which sizes a non-resizable window too.
        resizable: false, thickFrame: false,
        skipTaskbar: true, alwaysOnTop: !test,
        focusable: true,                       // the picker and Snap Assist take the arrow keys
        hasShadow: false, fullscreenable: false, minimizable: false, maximizable: false,
        title: 'Mantle snap', backgroundColor: '#00000000',
        webPreferences: {
          preload: ctx.preload, contextIsolation: true, sandbox: true, nodeIntegration: false,
          spellcheck: false, backgroundThrottling: false,   // drawn while parked
        },
      });
      S.win = win;
      S.hwnd = String(hwndOf(win));
      const wc = win.webContents;
      wc.on('will-navigate', (e) => e.preventDefault());
      wc.setWindowOpenHandler(() => ({ action: 'deny' }));
      wc.on('console-message', (...a) => {
        const d0 = a[1] && typeof a[1] === 'object' && 'message' in a[1] ? a[1] : null;
        const level = d0 ? d0.level : a[1];
        if (typeof level === 'string' ? (level === 'error' || level === 'warning') : level >= 2) ctx.log(`[page] ${d0 ? d0.message : a[2]}`);
      });
      wc.on('did-finish-load', () => { S.page = { ok: true, reason: null }; health(); });
      wc.on('did-fail-load', (_e, code, description, _url, isMainFrame) => {
        if (isMainFrame && code !== -3) pageDown(`the snap page failed to load (${description}, ${code})`);
      });
      wc.on('render-process-gone', (_e, d) => pageDown(`the snap page's renderer died (${d && d.reason})`));
      wc.on('unresponsive', () => pageDown('the snap page stopped responding'));
      wc.on('responsive', () => { if (!S.page.ok) { S.page = { ok: true, reason: null }; health(); } });
      win.on('blur', () => { if (S.sess && S.sess.shown && S.sess.mode !== 'notice') end('click-away'); });
      win.on('closed', () => {
        if (S.win !== win) return;
        S.tset.clear('the snap window closed');
        S.win = null;
        if (!S.stopped) pageDown('the snap window was closed');
      });
      win.once('ready-to-show', () => {
        if (test || !alive()) return;          // a test run never puts it on screen, parked or not
        try { win.showInactive(); win.setAlwaysOnTop(true, 'screen-saver'); } catch (err) { pageDown(`the snap window would not show, even parked: ${err.message}`); }
      });
      win.loadFile(ctx.page('index.html')).catch((err) => pageDown(`the snap page failed to load: ${err.message}`));
    }

    // ---------------------------------------------------------------- sessions (one face at a time)
    function toDip(f) {
      try { return screen.screenToDipRect(null, { x: f.x, y: f.y, width: f.w, height: f.h }); } catch (_) { return { x: f.x, y: f.y, width: f.w, height: f.h }; }
    }

    function begin(mode, rect, payload, extra) {
      end('replaced');
      const seq = ++S.seq;
      const sess = Object.assign({ seq, mode, rect, t0: now(), shown: false, painted: null, placed: [] }, extra || {});
      S.sess = sess;
      if (!alive()) { ctx.log(`#${seq} ${mode}: the snap window is not there (${S.page.reason || 'closed'})`); return sess; }
      try { S.win.setBounds(test ? rect : parkRect(rect)); } catch (err) { ctx.log(`#${seq}: could not size the snap window: ${err.message}`); }
      ctx.push(S.win, 'snap.show', Object.assign({ seq, mode }, payload));
      sess.late = setTimeout(() => reveal(sess, 'late'), REVEAL_LATE_MS);
      // long enough to read: 4.5 s, plus a little for a longer reason (about 18 characters a second)
      if (mode === 'notice') {
        const chars = String((payload && payload.title) || '').length + String((payload && payload.text) || '').length;
        sess.expire = setTimeout(() => { if (S.sess === sess) end('the notice timed out'); }, Math.min(9000, Math.max(NOTICE_MS, 2000 + chars * 55)));
      }
      return sess;
    }

    function reveal(sess, why) {
      if (sess.shown || S.sess !== sess || !alive()) return;
      sess.shown = true;
      sess.shownAt = now();
      sess.revealWhy = why;
      if (test) return;                          // never on screen in a test run
      try {
        S.win.setBounds(sess.rect);
        S.win.setAlwaysOnTop(true, 'screen-saver');
        S.win.moveTop();
        if (sess.mode !== 'notice') S.win.focus();
        // ...and CHECKED (r7-ontop): still covered after one more raise -> one plain log line.
        raiseWin.check(S.win, { what: `snap #${sess.seq}`, log: ctx.log, wanted: () => S.sess === sess && alive() });
      } catch (err) { ctx.log(`#${sess.seq}: could not come on screen: ${err.message}`); }
      if (sess.mode === 'notice') return;
      // The arrows need the keyboard. Windows may refuse a background process the foreground; the
      // sidecar (a child of this process) has the Alt+Tab ladder. Said on screen if both fail.
      setTimeout(async () => {
        if (S.sess !== sess || !alive() || S.win.isFocused()) return;
        const a = await ctx.sidecar.send('focus', { hwnd: S.hwnd }, { timeoutMs: 1500 });
        if (S.sess === sess && alive() && !S.win.isFocused()) {
          ctx.log(`#${sess.seq}: no keyboard for the panel (${a.ok ? 'focus was asked for and not given' : a.error})`);
          ctx.push(S.win, 'snap.nokeys', { seq: sess.seq, text: 'Windows kept the keyboard on another window, so click your choice here.' });
        }
      }, 60);
    }

    function end(why) {
      const sess = S.sess;
      if (!sess) return;
      S.sess = null;
      clearTimeout(sess.late);
      clearTimeout(sess.expire);
      S.tset.clear(why);                         // FIRST: a picture left registered would sit on screen
      if (alive()) {
        try { if (!test && sess.shown) S.win.setBounds(parkRect(sess.rect)); } catch (_) { /* parked next time */ }
        ctx.push(S.win, 'snap.hide', { seq: sess.seq });
      }
      const k = (t) => (t ? r1(t - sess.t0) + ' ms' : 'never');
      ctx.log(`#${sess.seq} ${sess.mode}: drawn ${sess.painted ? k(sess.painted.at) : 'never'}, shown ${k(sess.shownAt)}` +
        `${sess.revealWhy === 'late' ? ' (before the page said painted)' : ''}${test ? ' (test: stays hidden)' : ''}` +
        `${sess.thumbs ? `, pictures ${sess.thumbs.thumbs.filter((t) => t.ok).length}/${sess.thumbs.thumbs.length}` : ''}; ended: ${why}`);
      S.ended = { seq: sess.seq, mode: sess.mode, why };
    }

    function originOf() {
      const b = S.win.getContentBounds();
      return screen.dipToScreenPoint({ x: b.x, y: b.y });
    }

    /** Main gives the keyboard to a window the person chose (Windows does the same). */
    async function giveFocus(hwnd, why) {
      if (!hwnd) return;
      if (test) { ctx.log(`would give the focus to the snapped window (${why}); a test never focuses anything`); return; }
      const r = await ctx.sidecar.send('focus', { hwnd: String(hwnd) }, { timeoutMs: 1500 });
      if (!r.ok) ctx.log(`could not give the focus back after ${why}: ${r.error}`);
    }

    // ---------------------------------------------------------------- the notice
    function notice(title, text, monitor, names) {
      ctx.log(`notice: ${unname(title, names)}: ${unname(text, names)}`);   // the notice names the app; the log never does
      let area = null;
      if (monitor && monitor.work) area = toDip(monitor.work);
      if (!area) { const d = ctx.host.display(); area = d ? d.workArea : screen.getPrimaryDisplay().workArea; }
      const rect = {
        x: Math.round(area.x + (area.width - NOTICE.w) / 2),
        y: Math.round(area.y + area.height - NOTICE.h - 72),
        width: NOTICE.w, height: NOTICE.h,
      };
      return begin('notice', rect, { title, text });
    }

    function why(x) { return cap(x.reason || x.error || 'Windows gave no reason.'); }
    /** A reason as a sentence: capital first letter, full stop. */
    function cap(t) { t = String(t || '').trim(); if (!t) return t; t = t.charAt(0).toUpperCase() + t.slice(1); return /[.!?]$/.test(t) ? t : t + '.'; }
    /** The app's own name ("Task Manager"), else its exe, else "this window". */
    function appOf(x) { return (x && (x.app || x.exe)) || 'this window'; }
    /* NO APP NAMES IN THE LOG (lane r7-names, 2026-10-01; BRIEF privacy rule). The notice names the app;
       the log says "a window", and a reason from the sidecar ("Notes will not go smaller than...") has
       the app's name and exe cut out before it is logged. */
    function namesOf(x) { const exe = x && typeof x.exe === 'string' ? x.exe : ''; return [x && x.app, x && x.title, exe, exe.replace(/\.exe$/i, '')]; }
    function unname(t, names) {
      let out = String(t == null ? '' : t);
      const ns = [...new Set(names || [])].filter((n) => typeof n === 'string' && n.length > 1).sort((a, b) => b.length - a.length);
      // any case: the notice capitalises a bare exe name ("notepad.exe" -> "Notepad.exe does not fit")
      for (const n of ns) out = out.replace(new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), 'the window');
      return out;
    }

    // ---------------------------------------------------------------- Win+arrows
    const DIRS = { 'Win+Left': 'left', 'Win+Right': 'right', 'Win+Up': 'up', 'Win+Down': 'down' };

    async function arrow(chord) {
      const dir = DIRS[chord];
      const t0 = now();
      if (!ctx.enabled()) return null;
      // While the picker or Snap Assist has the keyboard, the arrows are about the window it is for.
      let target = S.sess && S.sess.mode !== 'notice' ? S.sess.target : null;
      if (test) target = target || S.testTarget;
      if (test && !target) {
        notice('Nothing to snap in a test run', 'A --test instance only moves its own test windows, never yours.');
        return done(chord, t0, null);
      }
      if (S.sess) end('another snap key');
      const r = await ctx.sidecar.send('snap.move', target ? { dir, hwnd: String(target) } : { dir }, { timeoutMs: 2500 });
      const ms = r1(now() - t0);
      if (!r.ok) {
        ctx.log(`${chord}: ${r.error} (${ms} ms)`);
        notice('Could not snap this window', cap(r.error));
        return done(chord, t0, r);
      }
      const x = r.result;
      answered();
      ctx.log(`${chord}: a window ${x.from} -> ${x.to} (${x.action}${x.ok ? '' : ', refused'}) sidecar ${x.ms} ms` +
        `${x.timing ? ` [checks ${x.timing.check}, move ${x.timing.move}]` : ''}, key to done ${ms} ms, ${x.moves || 0} move(s)` +
        `${x.corrected ? ' (corrected once)' : ''}`);
      if (!x.ok) notice(`Could not ${x.action === 'maximize' ? 'maximize' : x.action === 'minimize' ? 'minimize' : 'snap'} ${appOf(x)}`, why(x), x.monitor, namesOf(x));
      else if (x.fit === false) notice(`${cap(appOf(x)).replace(/.$/, '')} does not fit the ${ZONE_WORDS[x.to] || 'zone'}`, cap(x.fitReason), x.monitor, namesOf(x));
      else if (x.action === 'snap' && Array.isArray(x.assist) && x.assist.length) await openAssist(x.hwnd, x.assist);
      return done(chord, t0, r);
    }

    function done(chord, t0, r) {
      S.moves++;
      S.last = { chord, ms: r1(now() - t0), r };
      return S.last;
    }

    // ---------------------------------------------------------------- Snap Assist
    function zoneWords(z) {
      if (!z) return 'this space';
      if (ZONE_WORDS[z.name]) return ZONE_WORDS[z.name];
      for (const l of LAYOUTS.LAYOUTS) {
        for (let i = 0; i < l.zones.length; i++) {
          if (l.grid[0] === z.grid[0] && l.grid[1] === z.grid[1] && l.zones[i].every((v, k) => v === z.cell[k])) return l.names[i];
        }
      }
      return 'this space';
    }

    /** The other windows: the sidecar's list live; only our own test windows in a test. */
    async function candidates(first, placed) {
      const skip = new Set([String(first)].concat(placed || []));
      if (test) {
        return S.testWindows.filter((t) => !skip.has(t.hwnd) && !t.win.isDestroyed())
          .map((t) => ({ hwnd: t.hwnd, title: t.win.getTitle(), exe: 'electron.exe', icon: null, minimized: t.win.isMinimized() }));
      }
      const r = await ctx.sidecar.send('windows', {}, { timeoutMs: 1500 });
      if (!r.ok || !Array.isArray(r.result)) { ctx.log(`Snap Assist has no window list: ${r.error || 'not a list'}`); return []; }
      return r.result.filter((w) => !skip.has(String(w.hwnd)))
        .map((w) => ({ hwnd: String(w.hwnd), title: w.title, exe: String(w.exe || '').split(/[\\/]/).pop(), icon: w.icon || null, minimized: !!w.minimized }));
    }

    async function openAssist(first, zones, placed) {
      const cands = await candidates(first, placed);
      if (!cands.length || !zones.length) { await giveFocus(first, 'a snap with nothing to offer'); return null; }
      const z = zones[0];
      return begin('assist', toDip(z.frame), { zone: { name: zoneWords(z.zone) }, candidates: cands, sel: 0, left: zones.length - 1 },
        { target: String(first), zones, cands, placed: placed || [] });
    }

    async function pickWindow(sess, hwnd) {
      const z = sess.zones[0];
      end('a window was picked');
      const r = await ctx.sidecar.send('snap.zone', { hwnd, grid: z.zone.grid, cell: z.zone.cell, of: sess.target }, { timeoutMs: 2500 });
      const x = r.ok ? r.result : null;
      ctx.log(`Snap Assist: ${x ? `a window -> ${x.to}${x.ok ? '' : ` refused: ${unname(x.reason, namesOf(x))}`}, ${x.moves} move(s), sidecar ${x.ms} ms` : r.error}`);
      S.lastPick = { hwnd, r };
      if (x) answered();
      if (!x || !x.ok) { notice(`Could not snap ${x ? appOf(x) : 'that window'}`, x ? why(x) : cap(r.error), x && x.monitor, namesOf(x)); return r; }
      const placed = sess.placed.concat([hwnd]);
      const left = sess.zones.slice(1);
      if (left.length) {
        const next = await openAssist(sess.target, left, placed);
        if (next) return r;
      }
      await giveFocus(hwnd, 'Snap Assist');
      return r;
    }

    // ---------------------------------------------------------------- Win+Z
    async function picker() {
      if (!ctx.enabled()) return null;
      if (S.sess && S.sess.mode === 'picker') { const t = S.sess.target; end('Win+Z again'); await giveFocus(t, 'Win+Z again'); return null; }
      let target = S.sess && S.sess.mode !== 'notice' ? S.sess.target : null;
      if (test) target = target || S.testTarget;
      if (test && !target) return notice('Nothing to snap in a test run', 'A --test instance only moves its own test windows, never yours.');
      const r = await ctx.sidecar.send('snap.info', target ? { hwnd: String(target) } : {}, { timeoutMs: 1500 });
      if (!r.ok) return notice('Snap layouts are not available', cap(r.error));
      const info = r.result;
      answered();
      const app = appOf(info);
      if (!info.resizable) return notice(`Could not snap ${app}`, cap(`${app} has a fixed size, so it cannot be resized to fill a zone`), info.monitor, namesOf(info));
      if (info.elevatedAboveMantle) return notice(`Could not snap ${app}`, cap(`${app} is running as administrator, so Windows does not let Mantle move it. To snap it, run Mantle as administrator too`), info.monitor, namesOf(info));
      // Windows 11 opens its flyout under the maximize button: the window's top-right corner.
      const f = toDip(info.frame);
      const area = screen.getDisplayMatching(f).workArea;
      const x = Math.max(area.x, Math.min(f.x + f.width - PICKER.w - 24, area.x + area.width - PICKER.w));
      const y = Math.max(area.y, Math.min(f.y + 28, area.y + area.height - PICKER.h));
      return begin('picker', { x: Math.round(x), y: Math.round(y), width: PICKER.w, height: PICKER.h },
        { app: { exe: info.exe, name: info.app || null }, start: S.lastZone || null }, { target: info.hwnd });
    }

    async function pickZone(sess, layoutId, zi) {
      const lay = LAYOUTS.byId(layoutId);
      if (!lay || !lay.zones[zi]) return { ok: false, error: `no zone ${zi} in layout ${layoutId}` };
      const rest = LAYOUTS.rest(layoutId, zi);
      end('a zone was picked');
      const r = await ctx.sidecar.send('snap.zone', {
        hwnd: sess.target, grid: lay.grid, cell: lay.zones[zi],
        rest: rest.map((z) => ({ grid: z.grid, cell: z.cell })),
      }, { timeoutMs: 2500 });
      const x = r.ok ? r.result : null;
      ctx.log(`Win+Z ${lay.id}/${lay.names[zi]}: ${x ? `a window -> ${x.to}${x.ok ? '' : ` refused: ${unname(x.reason, namesOf(x))}`}, ${x.moves} move(s), sidecar ${x.ms} ms` : r.error}`);
      S.lastPick = { layout: layoutId, zone: zi, r };
      if (x) answered();
      if (!x || !x.ok) { notice(`Could not snap ${x ? appOf(x) : 'this window'}`, x ? why(x) : cap(r.error), x && x.monitor, namesOf(x)); return r; }
      S.lastZone = { layout: lay.id, zone: zi };     // the picker opens on it next time: Win+Z, Enter repeats it
      if (x.fit === false) notice(`${cap(appOf(x)).replace(/.$/, '')} does not fit the ${lay.names[zi]}`, cap(x.fitReason), x.monitor, namesOf(x));
      else if (Array.isArray(x.assist) && x.assist.length) { if (await openAssist(sess.target, x.assist)) return r; }
      await giveFocus(sess.target, 'Win+Z');
      return r;
    }

    // ---------------------------------------------------------------- the page's calls
    ctx.command('painted', async (a) => {
      const sess = S.sess;
      if (!sess || !a || a.seq !== sess.seq) return { ok: true, stale: true };
      if (!sess.painted) sess.painted = { at: now(), ms: Number(a.ms) || 0 };
      // A notice's reason can run to four lines: grow the window upward (the bottom stays put) to the
      // height the page measured, so no word is cut off. Only ever taller, never past NOTICE_MAX.
      const need = Math.ceil(Number(a.need));
      if (sess.mode === 'notice' && !sess.shown && need > sess.rect.height && need <= 2000) {
        const h = Math.min(NOTICE_MAX, need);
        sess.rect = { x: sess.rect.x, y: sess.rect.y - (h - sess.rect.height), width: sess.rect.width, height: h };
        if (test && alive()) { try { S.win.setBounds(sess.rect); } catch (_) { /* sized at reveal */ } }
      }
      if (sess.mode === 'assist' && alive()) {
        const res = S.tset.sync(S.hwnd, Array.isArray(a.boxes) ? a.boxes : [], Number(a.dpr), originOf());
        sess.thumbs = res;
        ctx.push(S.win, 'snap.thumbs', { seq: sess.seq, ok: res.ok, reason: res.reason || null, thumbs: res.thumbs || [] });
      }
      reveal(sess, 'painted');
      return { ok: true };
    });

    ctx.command('pick', async (a) => {
      const sess = S.sess;
      if (!sess || !a || a.seq !== sess.seq) return { ok: true, stale: true };
      if (sess.mode === 'picker') return pickZone(sess, String(a.layout), Math.trunc(Number(a.zone)));
      if (sess.mode === 'assist') {
        const hwnd = String(a.hwnd);
        if (!sess.cands.some((c) => c.hwnd === hwnd)) return { ok: false, error: 'that window is not one Snap Assist offered' };
        return pickWindow(sess, hwnd);
      }
      return { ok: false, error: 'nothing to pick in a notice' };
    });

    ctx.command('dismiss', async (a) => {
      const sess = S.sess;
      if (!sess || !a || a.seq !== sess.seq) return { ok: true, stale: true };
      end(a.why === 'esc' ? 'Esc' : 'click-away');
      // Esc hands the keyboard back to the window the panel was for; a click elsewhere already moved it.
      if (a.why === 'esc' && sess.target) await giveFocus(sess.target, 'Esc');
      return { ok: true };
    });

    ctx.command('state', async () => ({
      health: { sidecar: S.sidecar, page: S.page }, session: S.sess ? { seq: S.sess.seq, mode: S.sess.mode, shown: S.sess.shown } : null,
      moves: S.moves, testTarget: S.testTarget,
    }));

    ctx.onChord('Win+Left', arrow);
    ctx.onChord('Win+Right', arrow);
    ctx.onChord('Win+Up', arrow);
    ctx.onChord('Win+Down', arrow);
    ctx.onChord('Win+Z', picker);
    ctx.onEnabled((on) => { if (!on) end('snapping was turned off'); });

    createWindow();

    let selftest = null;
    if (test && process.env.MANTLE_SNAP_SELFTEST === '1') {
      selftest = require('./_snap-selftest.js');
      selftest.start({ ctx, S, screen, BrowserWindow, hwndOf, thumbs, end, arrow, picker });
    }

    return {
      stop(why) {
        S.stopped = true;
        clearTimeout(S.probeTimer);
        end(why || 'Mantle is putting Windows back');
        S.tset.clear('snap stopped');
        for (const t of S.testWindows) { try { if (!t.win.isDestroyed()) t.win.destroy(); } catch (_) { /* gone */ } }
        try { if (S.win && !S.win.isDestroyed()) S.win.destroy(); } catch (_) { /* gone */ }
        if (selftest && selftest.stop) selftest.stop();
      },
    };
  },
};
