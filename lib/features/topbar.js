'use strict';
/*
 * topbar.js - the macOS-style menu bar across the top of the primary display (wave 3, 2026-09-24).
 *
 * Owen: "the thing that macbooks have at the very top of your screen": left, the Mantle menu and
 * the focused app's name and ITS menus; right, live "ram cpu gpu etc." updating "every 1 sec".
 * And: "nothing should be able to go past the topbar ... unless its like valorant or whatever".
 *
 * THE PIECES
 *   ui/topbar/*            the page (renders, keyboard, menus); mock-mantle.js + shoot.js for shots
 *   sidecar/MenuBar.cs     focus snapshots with the app's Win32 / UIA menus, invoke, window actions,
 *                          the app bar, the drag-end guard, the game verdict
 *   sidecar/TopbarStats.cs one 1 s system sample, pushed as `topbarstats`
 *   this file              the window, the event bridge, the page's commands, and the three rules:
 *
 * NOTHING GOES PAST IT
 *   maximise      the bar is a registered TOP APP BAR round(28 x scale) px tall (LIVE ONLY: a test
 *                 never reserves Owen's screen), so the work area - and every maximised or snapped
 *                 window - starts below it. Checked, not assumed: the work area's top must equal the
 *                 bar's bottom, and the answer is in `topbar.status` and the feature's health.
 *   drag / resize a window dragged or resized up into the strip is put back below it when the drag
 *                 ENDS (topbar.guard, sidecar). Never during the drag.
 *   z-order       the window is topmost (live), so no normal window is ever drawn over it.
 *   borderless full screen (browser F11, video full screen): the bar STAYS, over the window's top
 *                 28 DIP. It is not squeezed below: see NO FIT below.
 * GAMES STEP ASIDE in any full-screen mode (the sidecar's verdict: a known game exe or Windows' Game
 *   Bar list, AND the window covers its monitor or Windows reports exclusive/busy full screen). The
 *   bar hides and its stats sampler stops; it comes back when the game leaves the foreground or
 *   exits. Setting `overGames` ("Keep the top bar over full-screen games") overrides.
 *
 * NO FIT for borderless full-screen windows (MEASURED 2026-09-24, _topbar-selftest.js, on a window
 *   the test made - never Owen's): a frame-ful Electron window in setFullScreen (Chromium's own
 *   full-screen path, the one Chrome's F11 and video full screen take) moved 35 px down from outside
 *   with SetWindowPos(NOZORDER|NOACTIVATE) was back at 0,0 1536x864 within 1.5 s, its page never
 *   re-laid out (innerHeight 864 throughout). Fitting it would be a tug of war. And a window moved
 *   down no longer covers its monitor, which is the ONE definition of full screen the bottom bar,
 *   the wallpaper pause rules and the edge clip share (sidecar/Foreground.cs). So the bar stays
 *   OVER such a window's top 28 DIP, and `topbar.status` .cover names the app it covers.
 *
 * TEST (--test): the sidecar is passive (reads everything, writes nothing but its own fixture);
 * the window is shown inactive and sent to the back (thumbs.toBack), never focused, never topmost;
 * power / new window / Task Manager / Settings are dry runs; UI Automation actions are refused
 * outright (a UIA invoke once activated a test window and took Owen's keyboard, 2026-09-24).
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
const cp = require('child_process');

const BAR_DIP = 28;
const M = require(path.join(__dirname, '..', '..', 'ui', 'topbar', 'model.js'));

/** The app bar's size in the SIDECAR's units: physical px when it is DPI-aware (see main.js placeBar). */
function reserveSize(scale, dpiAware) { return dpiAware ? Math.round(BAR_DIP * (scale || 1)) : BAR_DIP; }

/* THE LOCK SCREEN. mantle.log, live, 2026-09-25: "topbar: LockApp.exe is full screen; the top bar
 * stays over its top 28 DIP". Win+L puts LockApp.exe (the lock curtain) in front of the user's
 * desktop, where a topmost bar draws over it; LogonUI.exe is the sign-in / credential screen. The
 * bar steps aside for both, always: "Keep the top bar over full-screen games" does not apply. */
const LOCK_EXES = ['lockapp.exe', 'logonui.exe'];
/** Pure: the lock / sign-in screen's exe name when this focus snapshot is one of them, else null. */
function lockScreen(f) {
  if (!f || f.self) return null;
  for (const s of [f.exe, f.desc]) {
    const file = String(s || '').split(/[\\/]/).pop().toLowerCase();
    if (LOCK_EXES.includes(file)) return file === 'lockapp.exe' ? 'LockApp.exe' : 'LogonUI.exe';
  }
  return null;
}

/** Pure: should the bar step aside? Always for the lock screen; for a game unless overGames. */
function stepAsideFor(game, overGames, lock) { return !!lock || (!!(game && game.stepAside) && !overGames); }

/** Pure: is the work area's top where the bar's bottom is (DIP, 1 px of rounding allowed)? */
function workAreaCheck(display) {
  const want = display.bounds.y + BAR_DIP;
  const got = display.workArea.y;
  return { ok: Math.abs(got - want) <= 1, want, got };
}

module.exports = {
  name: 'topbar',
  label: 'Top menu bar',
  defaultOn: true,
  chords: [],
  observe: [],
  _test: { reserveSize, stepAsideFor, lockScreen, workAreaCheck, BAR_DIP },

  install(ctx) {
    const { BrowserWindow, screen, shell } = require('electron');
    const { hwndOf } = require('../windows');
    const thumbs = require('../thumbs');
    const test = !!ctx.flags.test;
    const live = !!ctx.flags.live && !test;

    const S = {
      win: null, hwnd: null, pageOk: false, pageReason: 'the page has not loaded yet',
      focus: null, lastApp: null, stats: null, note: null, dpiAware: null,
      overGames: !!ctx.settings.get('overGames', false),
      stepAside: false, stepSignal: null, stepSince: null,
      watch: { ok: null, reason: 'starting' },   // null = not asked yet (not a failure: no strip row)
      stats_: { on: false, reason: 'not started' },
      guard: { ok: false, reason: 'not started', last: null },
      reserve: { reserved: false, reason: live ? 'not reserved yet' : 'a --test instance never reserves space on the screen' },
      menu: { open: false, height: BAR_DIP },
      cover: null, stopped: false, timers: new Set(),
    };
    const later = (ms, fn) => { const t = setTimeout(() => { S.timers.delete(t); fn(); }, ms); S.timers.add(t); return t; };
    const push = (ev, payload) => { if (S.win && !S.win.isDestroyed()) ctx.push(S.win, ev, payload); };
    const sc = async (cmd, args, ms) => {
      const r = await ctx.sidecar.send(cmd, args || {}, { timeoutMs: ms || 4000 });
      return r.ok ? Object.assign({ ok: true }, r.result) : { ok: false, reason: r.error };
    };
    const primary = () => screen.getPrimaryDisplay();
    const barDip = (h) => { const b = primary().bounds; return { x: b.x, y: b.y, width: b.width, height: h || BAR_DIP }; };

    function health() {
      const why = !S.pageOk ? S.pageReason
        : S.watch.ok === false ? `the top bar cannot follow the focused app: ${S.watch.reason}`
        : (live && !S.reserve.reserved) ? `maximised windows can go under the top bar: ${S.reserve.reason}`
        : null;
      ctx.health(!why, why);
    }

    /* ---- the window ------------------------------------------------------------------------- */
    function toBackIfTest() { if (test && S.hwnd) { try { thumbs.toBack(S.hwnd); } catch (_) { /* shown inactive anyway */ } } }
    function show() {
      if (!S.win || S.win.isDestroyed() || !ctx.enabled() || S.stepAside) return;
      if (!S.win.isVisible()) S.win.showInactive();
      if (live) { S.win.setAlwaysOnTop(true, 'screen-saver'); S.win.moveTop(); }
      toBackIfTest();
    }
    function hide() { if (S.win && !S.win.isDestroyed() && S.win.isVisible()) S.win.hide(); }
    function place(height) {
      if (!S.win || S.win.isDestroyed()) return;
      const r = barDip(height);
      S.win.setBounds(r);
      // Windows will not make this window shorter than ~38-40 DIP: 28 came out 40 at creation and
      // 300 -> 28 came out 38, whatever resizable / thickFrame / minHeight / setMinimumSize / type /
      // transparent / useContentSize said (hidden probe windows, 2026-09-24). So the window may be
      // taller than the bar, and a SHAPE crops it to exactly the bar (or the open menu): outside it
      // nothing draws and clicks go straight through (lib/bar-shape.js does the same for the bar).
      const got = S.win.getBounds();
      pinZoom();
      S.shape = { window: got.height, shown: r.height, ok: true, reason: null };
      try { S.win.setShape(got.height > r.height ? [{ x: 0, y: 0, width: got.width, height: r.height }] : []); } catch (e) {
        S.shape.ok = false;
        S.shape.reason = `the window is ${got.height} DIP tall and could not be cropped to ${r.height} (${e.message}), so its bottom ${got.height - r.height} DIP swallow clicks`;
        ctx.log(S.shape.reason);
      }
      toBackIfTest();
    }

    /* DRIFT (2026-09-25). Owen's bar showed "CPU 82%" at the screen's right edge with RAM / GPU / NET
     * past it: the look of a bar WINDOW wider than its display (headless, a 1920 CSS px page on a
     * 1536 px screen reproduces the shot exactly; an Electron probe window resized to 1920 DIP while
     * hidden laid out 1920 CSS px). 1920 is the panel's PHYSICAL width, so a size in the wrong units
     * or a DPI change resizing the window after place() ran (Windows scales the old rect in
     * WM_DPICHANGED) are the suspects. place() only runs on menus and display events, so nothing
     * put such a window back. Now any resize / move that leaves the window off the display's
     * top-left + width is put back (at most 3 times in 10 s) and logged with the numbers, so the
     * next occurrence names its size. The page also sizes itself to its screen (ui/topbar/topbar.js
     * visibleWidth), so the stats stay on screen even while the window is wrong. */
    // The page sizes its strip to the screen assuming page zoom 1 (screen.* is DIP, innerWidth CSS px).
    // Chromium keeps zoom per ORIGIN, so a Ctrl+- in any file:// Mantle page (Electron's default
    // menu accelerators are live: main.js sets no application menu) would zoom this bar too.
    function pinZoom() {
      try {
        const wc = S.win && !S.win.isDestroyed() && S.win.webContents;
        if (wc && wc.getZoomFactor() !== 1) { ctx.log(`the page was zoomed to ${wc.getZoomFactor()}; set back to 1`); wc.setZoomFactor(1); }
      } catch (e) { ctx.log(`could not check the page zoom: ${e.message}`); }
    }

    function driftCheck() {
      if (S.driftT || S.stopped) return;
      S.driftT = later(250, () => {
        S.driftT = null;
        if (!S.win || S.win.isDestroyed() || S.stopped) return;
        const want = barDip(S.menu.open ? S.menu.height : BAR_DIP);
        const got = S.win.getBounds();
        // the height is not compared: Windows' 38-40 DIP floor is expected, and the shape crops it
        if (got.x === want.x && got.y === want.y && got.width === want.width) return;
        const now = Date.now();
        if (!S.drift || now - S.drift.since > 10000) S.drift = { n: 0, since: now, last: null };
        S.drift.n++;
        S.drift.last = `${got.x},${got.y} ${got.width}x${got.height} DIP on a ${want.width} DIP wide display at ${primary().scaleFactor}x`;
        if (S.drift.n > 3) {
          if (S.drift.n === 4) ctx.log(`the window keeps leaving its place (${S.drift.last}) after 3 fixes in 10 s; the page keeps the stats on screen`);
          return;
        }
        ctx.log(`the window drifted to ${S.drift.last}; put back to ${want.x},${want.y} ${want.width} wide`);
        place(S.menu.open ? S.menu.height : BAR_DIP);
      });
    }

    function createWindow() {
      const r = barDip();
      const win = new BrowserWindow({
        x: r.x, y: r.y, width: r.width, height: r.height, show: false, frame: false, transparent: true,
        // resizable:true + thickFrame:false, as lib/windows.js's bar: with resizable:false the window
        // came out 40 DIP tall instead of 28 and would not shrink below 38 after a menu closed
        // (measured in --test, 2026-09-24); no WS_THICKFRAME = no drag handles for the user.
        resizable: true, thickFrame: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
        skipTaskbar: true, hasShadow: false, focusable: true, alwaysOnTop: live, title: M.TITLE || 'Mantle top bar',
        backgroundColor: '#00000000',
        webPreferences: { preload: ctx.preload, contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false },
      });
      S.win = win;
      S.hwnd = hwndOf(win);
      // The sidecar's stale-app-bar check only ever touches a window titled exactly this.
      win.on('page-title-updated', (e) => e.preventDefault());
      win.setTitle('Mantle top bar');
      win.webContents.on('will-navigate', (e) => e.preventDefault());
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      win.webContents.on('render-process-gone', (_e, d) => {
        S.pageOk = false; S.pageReason = `the top bar's page crashed (${d && d.reason}); reloading it`; health();
        later(1000, () => { if (!win.isDestroyed()) win.webContents.reload(); });
      });
      win.webContents.on('did-fail-load', (_e, code, desc) => { S.pageOk = false; S.pageReason = `the top bar's page did not load (${code} ${desc})`; health(); });
      win.on('unresponsive', () => { S.pageOk = false; S.pageReason = 'the top bar\'s page stopped responding'; health(); });
      win.on('responsive', () => { S.pageOk = true; health(); });
      win.on('resize', driftCheck);
      win.on('move', driftCheck);
      win.webContents.on('did-finish-load', () => { S.pageOk = true; S.pageReason = null; health(); pinZoom(); });
      win.once('ready-to-show', () => { if (ctx.enabled()) show(); });
      win.loadFile(ctx.page('index.html'));
    }

    /* ---- games step aside -------------------------------------------------------------------- */
    async function decide(game, from) {
      const lock = lockScreen(S.focus);
      const want = stepAsideFor(game, S.overGames, lock);
      const signal = !want ? null
        : lock ? `${lock} is in front (the ${lock === 'LockApp.exe' ? 'lock' : 'sign-in'} screen): the bar never draws over it`
        : (game.signal || 'the sidecar said so');
      if (want === S.stepAside) {
        if (want && signal !== S.stepSignal) { S.stepSignal = signal; ctx.log(`still stepped aside (${from}): ${signal}`); }
        return;
      }
      const wasLock = /^Lock|^LogonUI/.test(S.stepSignal || '');
      S.stepAside = want;
      S.stepSignal = signal;
      S.stepSince = Date.now();
      if (want) {
        ctx.log(`stepped aside (${from}): ${S.stepSignal}`);
        push('topbar.close', {});   // an open menu goes too, so nothing of it comes back later
        hide();
        await statsOn(false, lock ? 'the screen is locked' : `a game has the screen: ${S.stepSignal}`);
      } else {
        ctx.log(`back (${from}): ${wasLock ? 'the lock screen closed' : 'the game left the foreground or full screen'}`);
        show();
        await statsOn(true);
      }
    }

    function coverNote(f) {
      // A non-game window that covers the monitor: the bar stays over its top strip. Said, not hidden.
      if (f && f.fullscreen && !S.stepAside && !f.self) {
        const note = `${M.appName(f)} is full screen; the top bar stays over its top ${BAR_DIP} DIP (it is not a game, so the bar does not step aside)`;
        if (!S.cover || S.cover.hwnd !== f.hwnd) ctx.log(note);
        S.cover = { hwnd: f.hwnd, app: M.appName(f), coveredDip: BAR_DIP, note };
      } else if (f && !f.self) S.cover = null;
    }

    /* ---- the sidecar ------------------------------------------------------------------------ */
    function onTopbar(ev) {
      const payload = Object.assign({}, ev);
      delete payload.ev;
      if (ev.kind === 'focus') {
        if (!ev.self) { S.focus = payload; S.lastApp = ev.hwnd; decide(ev.game, 'focus'); coverNote(payload); }
        push('topbar.focus', payload);
      } else if (ev.kind === 'title') {
        if (S.focus && S.focus.hwnd === ev.hwnd) S.focus.title = ev.title;
        push('topbar.title', payload);
      } else if (ev.kind === 'geometry') {
        if (S.focus && S.focus.hwnd === ev.hwnd) {
          S.focus.fullscreen = ev.fullscreen; S.focus.zoomed = ev.zoomed;
          if (ev.game) decide(ev.game, 'geometry');
          coverNote(S.focus);
        }
        push('topbar.geometry', payload);
      } else if (ev.kind === 'guard') {
        S.guard.last = { at: Date.now(), cls: ev.cls, how: ev.how, dy: ev.dy, dryRun: ev.dryRun, ok: ev.ok, reason: ev.reason };
        ctx.log(`${ev.dryRun ? 'would have put' : ev.ok ? 'put' : 'could not put'} a ${ev.cls} window back below the bar (${ev.how})${ev.reason ? ': ' + ev.reason : ''}`);
      }
    }
    function onStats(ev) {
      const payload = Object.assign({}, ev);
      delete payload.ev;
      if (S.stepAside && !payload.paused) return;
      if (!payload.paused) S.stats = payload;
      push('topbar.stats', payload);
    }

    async function statsOn(on, why) {
      const r = await sc('topbar.stats', { on });
      S.stats_ = { on: on && r.ok, reason: r.ok ? (on ? null : why || 'off') : r.reason };
      if (!on) push('topbar.stats', { paused: true, reason: why || 'the top bar is off' });
      else if (!r.ok) push('topbar.note', { text: `System stats are unavailable: ${r.reason}` });
    }

    async function guardOn() {
      const d = primary();
      const phys = screen.dipToScreenRect(null, barDip());
      const r = await sc('topbar.guard', { on: true, bar: [phys.x, phys.y, phys.x + phys.width, phys.y + phys.height] });
      S.guard.ok = r.ok;
      S.guard.reason = r.ok ? (r.passive ? 'passive: drags into the strip are measured and logged, nothing is moved' : null) : r.reason;
      S.guard.bar = r.ok ? r.bar : null;
      S.guard.scale = d.scaleFactor;
      if (!r.ok) push('topbar.note', { text: `A window dragged into the top bar will not be put back: ${r.reason}` });
    }

    async function reserve(why) {
      if (!live || !S.hwnd || S.stopped || !ctx.enabled()) return;
      const d = primary();
      const size = reserveSize(d.scaleFactor, S.dpiAware !== false);
      const r = await sc('topbar.reserve', { hwnd: S.hwnd, size });
      if (!r.ok) {
        S.reserve = { reserved: false, size, reason: `the strip could not be reserved (${r.reason}), so maximised windows go under the bar` };
        health();
        return;
      }
      place(S.menu.open ? S.menu.height : BAR_DIP);
      const check = () => {
        const w = workAreaCheck(primary());
        S.reserve = {
          reserved: w.ok, size, rect: r.rect, workTop: w.got, barBottom: w.want, checked: why, at: Date.now(),
          reason: w.ok ? `reserved ${size}px (${BAR_DIP} DIP at ${d.scaleFactor}x); the work area starts at the bar's bottom (${w.got})`
            : `reserved ${size}px, but the work area starts at ${w.got} DIP instead of the bar's bottom ${w.want} DIP`,
        };
        ctx.log(`app bar ${why}: ${S.reserve.reason}`);
        health();
      };
      later(300, check);
    }

    async function release() {
      if (!live || !S.hwnd) return;
      const r = await sc('topbar.release', { hwnd: S.hwnd }, 2000);
      S.reserve = { reserved: false, reason: r.ok ? 'released' : `release failed: ${r.reason}` };
    }

    async function apply(why) {
      if (S.stopped) return;
      if (!ctx.enabled()) { await off('the top bar is switched off in the tray'); return; }
      const p = await sc('ping');
      S.dpiAware = p.ok ? p.dpiAware === true : null;
      const w = await sc('topbar.watch', { on: true });
      S.watch = w.ok ? { ok: true, reason: null } : { ok: false, reason: w.reason };
      if (w.ok && w.focus) onTopbar(Object.assign({ kind: 'focus' }, w.focus));
      await guardOn();
      if (!S.stepAside) await statsOn(true);
      await reserve(why);
      // Asked again once things settle, as main.js does for the bottom bar: right after a Mantle
      // restart Explorer can still hold the previous bar's slot and stack this one below it
      // (seen live for the bottom bar, 2026-09-21). Re-reserving the same window is free.
      if (live) for (const ms of [1500, 6000]) later(ms, () => reserve(`${ms / 1000} s re-check`));
      show();
      health();
    }

    async function off(why) {
      hide();
      await Promise.all([
        sc('topbar.watch', { on: false }, 1500), sc('topbar.guard', { on: false }, 1500),
        sc('topbar.stats', { on: false }, 1500), release(),
      ]);
      S.watch = { ok: false, reason: why };
      S.stats_ = { on: false, reason: why };
    }

    /* ---- the page's calls ------------------------------------------------------------------- */
    const refuseInTest = (what) => ({ ok: true, dryRun: true, reason: `dry run (--test): would have ${what}` });
    ctx.command('hello', async () => ({ focus: S.focus, stats: S.stats, note: S.note, stepAside: S.stepAside, overGames: S.overGames }));
    ctx.command('status', async () => ({
      test, live, dpiAware: S.dpiAware, page: { ok: S.pageOk, reason: S.pageReason },
      bounds: S.win && !S.win.isDestroyed() ? S.win.getBounds() : null, visible: !!(S.win && !S.win.isDestroyed() && S.win.isVisible()),
      watch: S.watch, stats: S.stats_, guard: S.guard, reserve: S.reserve, menu: S.menu, shape: S.shape, drift: S.drift || null,
      stepAside: S.stepAside, stepSignal: S.stepSignal, overGames: S.overGames, cover: S.cover,
      focus: S.focus ? { hwnd: S.focus.hwnd, app: M.appName(S.focus), fullscreen: S.focus.fullscreen, game: S.focus.game } : null,
    }));
    // The page asks for its dropdowns' FULL layout height (capped by the screen, never by this
    // window: a cap from the window's own 38 DIP made every dropdown a 12 px strip, 2026-09-25,
    // ui/topbar/topbar.css .dd) and keeps them hidden until the window has grown to it.
    ctx.command('menuState', async (a) => {
      const open = !!(a && a.open);
      const d = primary();
      const h = open ? Math.max(BAR_DIP, Math.min(Math.ceil(Number(a.height) || BAR_DIP), d.bounds.height)) : BAR_DIP;
      S.menu = { open, height: h };
      place(h);
      if (!open && a && a.refocus && S.lastApp && live) {
        const r = await sc('focus', { hwnd: S.lastApp });
        if (!r.ok) return { ok: false, reason: `the app could not be given the keyboard back: ${r.reason}` };
      }
      return { ok: true, height: h, refocused: !open && !!(a && a.refocus) && live };
    });
    ctx.command('menus', async (a) => sc('topbar.menus', { hwnd: a && a.hwnd, init: a && a.init }));
    ctx.command('uia', async (a) => sc('topbar.uia', { hwnd: a && a.hwnd }, 15000));
    ctx.command('invoke', async (a) => sc('topbar.invoke', { hwnd: a && a.hwnd, item: a && a.item, focus: live }));
    ctx.command('uiaInvoke', async (a) => {
      if (test) return { ok: false, reason: 'a --test instance never runs a UI Automation action (one activated a test window and took the keyboard, 2026-09-24)' };
      return sc('topbar.uiaInvoke', { hwnd: a && a.hwnd, path: a && a.path, names: a && a.names, expand: !!(a && a.expand) }, 15000);
    });
    ctx.command('window', async (a) => sc('topbar.window', { hwnd: a && a.hwnd, action: a && a.action, on: a && a.on, dryRun: test }));
    ctx.command('newWindow', async (a) => {
      const exe = String((a && a.exe) || '');
      const want = M.newWindowArgs(exe);
      const args = Array.isArray(a && a.args) ? a.args.map(String) : [];
      if (!want || JSON.stringify(want) !== JSON.stringify(args)) return { ok: false, reason: `Mantle does not know how to open a new ${path.basename(exe) || 'app'} window` };
      if (!path.isAbsolute(exe) || !fs.existsSync(exe)) return { ok: false, reason: `${exe || 'the app'} is not on disk any more` };
      if (test) return refuseInTest(`run ${exe} ${args.join(' ')}`.trim());
      try {
        const child = cp.spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false });
        child.on('error', (e) => push('topbar.note', { text: `New window: ${e.message}` }));
        child.unref();
        return { ok: true };
      } catch (e) { return { ok: false, reason: e.message }; }
    });
    ctx.command('power', async (a) => {
      const LI = require('../launcher-index');
      const sidecar = async (cmd, args, ms) => {
        const r = await ctx.sidecar.send(cmd, args, { timeoutMs: ms || 4000 });
        if (!r.ok) throw new Error(r.error);
        return r.result;
      };
      return LI.power({ action: a && a.action, confirmed: !!(a && a.confirmed) }, { sidecar, dryRun: test });
    });
    ctx.command('about', async () => {
      let version = '?';
      try { version = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')).version; } catch (_) { /* shown as ? */ }
      const cpu = (os.cpus()[0] || {}).model || 'unknown CPU';
      const text = `Mantle ${version} · Windows ${os.release()} · ${cpu.replace(/\s+/g, ' ').trim()} · ${(os.totalmem() / 2 ** 30).toFixed(1)} GB RAM`;
      S.note = text;
      push('topbar.note', { text });
      later(8000, () => { if (S.note === text) S.note = null; });
      return { ok: true, text };
    });
    ctx.command('settings', async () => {
      if (test) return refuseInTest('opened Windows Settings (ms-settings:)');
      try { await shell.openExternal('ms-settings:'); return { ok: true }; } catch (e) { return { ok: false, reason: `Windows Settings did not open: ${e.message}` }; }
    });
    ctx.command('taskmgr', async () => {
      const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'Taskmgr.exe');
      if (test) return refuseInTest(`run ${exe}`);
      try { cp.spawn(exe, [], { detached: true, stdio: 'ignore' }).unref(); return { ok: true }; } catch (e) { return { ok: false, reason: e.message }; }
    });
    ctx.command('statsDetail', async (a) => {
      if (S.stepAside) return { ok: false, reason: 'the stats are paused while a game has the screen' };
      return sc('topbar.stats', { on: true, detail: String((a && a.kind) || '') });
    });
    ctx.command('overGames', async (a) => {
      S.overGames = !!(a && a.on);
      ctx.settings.set('overGames', S.overGames);
      ctx.log(`keep the top bar over full-screen games: ${S.overGames}`);
      await decide(S.focus && S.focus.game, 'setting');
      return { ok: true, overGames: S.overGames, stepAside: S.stepAside };
    });

    /* ---- wiring ----------------------------------------------------------------------------- */
    ctx.sidecar.on('topbar', onTopbar);
    ctx.sidecar.on('topbarstats', onStats);
    createWindow();
    place(BAR_DIP);
    ctx.sidecar.onReady(() => { apply('sidecar ready').catch((e) => ctx.log(`start failed: ${e.message}`)); });
    ctx.onEnabled((on) => { (on ? apply('switched on') : off('the top bar is switched off in the tray')).catch((e) => ctx.log(e.message)); });
    const onDisplay = () => {
      if (S.stopped) return;
      place(S.menu.open ? S.menu.height : BAR_DIP);
      if (ctx.enabled()) { reserve('display changed'); guardOn(); }
    };
    screen.on('display-metrics-changed', onDisplay);
    screen.on('display-added', onDisplay);
    screen.on('display-removed', onDisplay);

    let selftest = null;
    if (test && process.env.MANTLE_TOPBAR_SELFTEST === '1') {
      selftest = require('./_topbar-selftest.js');
      selftest.start({ ctx, S, screen, BrowserWindow, hwndOf, thumbs, onTopbar, decide, BAR_DIP });
    }

    return {
      async stop() {
        S.stopped = true;
        if (selftest) selftest.stop();
        for (const t of S.timers) clearTimeout(t);
        screen.removeListener('display-metrics-changed', onDisplay);
        screen.removeListener('display-added', onDisplay);
        screen.removeListener('display-removed', onDisplay);
        await off('Mantle is putting Windows back');
        if (S.win && !S.win.isDestroyed()) S.win.destroy();
      },
    };
  },
};
