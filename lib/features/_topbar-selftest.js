'use strict';
/*
 * _topbar-selftest.js - the top bar proving itself inside an Electron --test instance
 * (MANTLE_TOPBAR_SELFTEST=1; loaded only by lib/features/topbar.js, and only in --test).
 *
 * WHAT IT DRIVES: the page's own bridge (window.mantle.call inside the bar's page, through preload
 * and main's command table - the path a click takes), the real passive sidecar (reads everything,
 * writes nothing of Owen's), and the feature's event handler fed a FAKE focus snapshot for the
 * game rules (no game has to run).
 *
 * WHAT IT MOVES: one window it creates itself for the full-screen measurement - opacity 0 (never
 * visible), focusable:false (WS_EX_NOACTIVATE), shown inactive, sent to the bottom of the z-order,
 * destroyed after ~4 s. The foreground window's HANDLE is read before and after every step and the
 * run fails if it ever changed. No titles of Owen's windows are read or written anywhere.
 *
 * Results: one line in mantle.log and %TEMP%\mantle-topbar\selftest.json.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const OUT = path.join(os.tmpdir(), 'mantle-topbar', 'selftest.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let halt = false;

function start(k) {
  const { ctx, S, screen, BrowserWindow, hwndOf, thumbs, BAR_DIP } = k;
  (async () => {
    const checks = [];
    const measured = {};
    const check = (name, ok, detail) => checks.push(ok ? { name, ok: true } : { name, ok: false, detail: String(detail) });
    const page = (js) => S.win.webContents.executeJavaScript(js, true);
    const call = (name, args) => page(`window.mantle.call(${JSON.stringify(name)}, ${JSON.stringify(args || {})})`).catch((e) => ({ ok: false, reason: 'threw: ' + e.message }));
    const fgNow = async () => { const r = await ctx.sidecar.send('topbar.focus', { menu: false }, { timeoutMs: 3000 }); return r.ok ? r.result.hwnd : null; };
    const ours = new Set();
    const fgBad = [];
    const fgCheck = async (when) => { const h = await fgNow(); if (h && ours.has(h)) fgBad.push(when); };
    const until = async (fn, ms) => { const t0 = Date.now(); while (!halt && Date.now() - t0 < ms) { if (fn()) return true; await sleep(80); } return !!fn(); };

    await until(() => S.pageOk && S.watch.ok && S.guard.ok, 20000);
    if (halt) return;
    ours.add(S.hwnd);
    check('page loaded, focus watch and drag guard on', S.pageOk && S.watch.ok && S.guard.ok, JSON.stringify({ page: S.pageReason, watch: S.watch, guard: S.guard }));
    const fg0 = await fgNow();

    // the window
    const b = S.win.getBounds(), p = screen.getPrimaryDisplay().bounds;
    check('window: titled exactly "Mantle top bar"', S.win.getTitle() === 'Mantle top bar', S.win.getTitle());
    const shaped = (h) => S.shape && S.shape.ok && S.shape.shown === h && (S.shape.window === h || S.shape.window > h);
    check('window: 28 DIP across the top of the primary display (cropped by a shape if Windows made it taller)',
      b.x === p.x && b.y === p.y && b.width === p.width && shaped(BAR_DIP), JSON.stringify({ b, shape: S.shape }));
    measured.windowHeight = { asked: BAR_DIP, got: b.height, shape: S.shape };
    check('window: not topmost and nothing reserved in --test', !S.win.isAlwaysOnTop() && S.reserve.reserved === false, JSON.stringify(S.reserve));

    // events reach the page
    await until(() => false, 300);
    const t = await page('({ focus: !!(window.__topbar.focus), stats: !!(window.__topbar.stats && window.__topbar.stats.cpu), titles: window.__topbar.titles.length })');
    await until(() => !!S.stats, 4000);
    const t2 = await page('({ stats: !!(window.__topbar.stats && window.__topbar.stats.cpu), cells: document.querySelectorAll("#right .st").length })');
    check('page: the focused app arrived (hello / topbar.focus) and titles rendered', t.focus && t.titles >= 2, JSON.stringify(t));
    check('page: a system sample arrived (topbarstats -> topbar.stats)', t2.stats, JSON.stringify(t2));
    measured.statCells = t2.cells;

    // the page's commands, through the real bridge
    const lock = await call('topbar.power', { action: 'lock' });
    check('power: Lock is a dry run in --test', lock.ok && lock.dryRun, JSON.stringify(lock));
    const rs = await call('topbar.power', { action: 'restart' });
    check('power: Restart refuses without the second click', rs.ok === false && /asks first/.test(rs.reason), JSON.stringify(rs));
    const rs2 = await call('topbar.power', { action: 'restart', confirmed: true });
    check('power: Restart confirmed is still only a dry run', rs2.ok && rs2.dryRun, JSON.stringify(rs2));
    for (const v of ['taskmgr', 'settings']) { const r = await call('topbar.' + v); check(`${v}: dry run`, r.ok && r.dryRun, JSON.stringify(r)); }
    const nw = await call('topbar.newWindow', { exe: 'C:\\Windows\\explorer.exe', args: [] });
    check('newWindow: File Explorer is a dry run', nw.ok && nw.dryRun, JSON.stringify(nw));
    const nwBad = await call('topbar.newWindow', { exe: 'C:\\Windows\\explorer.exe', args: ['/e,C:\\'] });
    check('newWindow: arguments that are not the known table are refused', nwBad.ok === false, JSON.stringify(nwBad));
    const wmin = await call('topbar.window', { hwnd: fg0, action: 'minimize' });
    check('window action on the foreground app: dry run only', wmin.ok && wmin.dryRun === true, JSON.stringify(wmin));
    const inv = await call('topbar.invoke', { hwnd: fg0, item: 1 });
    check('invoke on an app of Owen\'s: refused (passive), with a reason', inv.ok === false && !!inv.reason, JSON.stringify(inv));
    const ui = await call('topbar.uiaInvoke', { hwnd: fg0, path: [0], names: ['File'] });
    check('uiaInvoke: never in --test', ui.ok === false && /never runs/.test(ui.reason), JSON.stringify(ui));
    const sd = await call('topbar.statsDetail', { kind: 'cpu' });
    check('statsDetail: the sampler adds top processes', sd.ok !== false, JSON.stringify(sd));
    const ab = await call('topbar.about');
    check('about: one line about Mantle and the machine', ab.ok && /^Mantle /.test(ab.text), JSON.stringify(ab));
    await fgCheck('after the commands');

    // a menu open grows the window, closing shrinks it; nothing is focused in --test
    const mo = await call('topbar.menuState', { open: true, height: 300 });
    const hOpen = S.win.getBounds().height;
    const mc = await call('topbar.menuState', { open: false, refocus: true });
    const hShut = S.win.getBounds().height;
    check('menuState: open grows to the menu, close shrinks to 28 (shape), no refocus in --test', mo.ok && hOpen === 300 && mc.ok && shaped(BAR_DIP) && mc.refocused === false,
      JSON.stringify({ mo, hOpen, mc, hShut, shape: S.shape }));

    // games step aside (a FAKE focus snapshot; the verdict itself is proven in sidecar/test-topbar.js)
    const real = S.focus;
    const game = { kind: 'focus', hwnd: '424242', self: false, exe: 'C:\\x\\VALORANT-Win64-Shipping.exe', desc: 'VALORANT', fullscreen: true,
      game: { stepAside: true, signal: 'selftest: a fake Valorant, borderless' } };
    k.onTopbar(game);
    await until(() => S.stepAside && !S.win.isVisible(), 1500);
    await sleep(300);
    const pz = await page('window.__topbar.paused');
    check('game: the bar steps aside (hidden), its stats pause, the signal is kept', S.stepAside && !S.win.isVisible() && S.stats_.on === false && /fake Valorant/.test(S.stepSignal) && !!pz,
      JSON.stringify({ step: S.stepAside, vis: S.win.isVisible(), stats: S.stats_, pz }));
    const og = await call('topbar.overGames', { on: true });
    check('game: "keep the bar over full-screen games" brings it back', og.ok && og.stepAside === false && S.win.isVisible(), JSON.stringify(og));
    const og2 = await call('topbar.overGames', { on: false });
    check('game: switching that off steps aside again', og2.ok && og2.stepAside === true && !S.win.isVisible(), JSON.stringify(og2));
    k.onTopbar(Object.assign({}, real || { kind: 'focus', hwnd: '0', self: false }, { kind: 'focus', game: { stepAside: false } }));
    await until(() => !S.stepAside && S.win.isVisible() && S.stats_.on, 3000);
    check('game: the game leaving the foreground brings the bar and its stats back', !S.stepAside && S.win.isVisible() && S.stats_.on, JSON.stringify({ step: S.stepAside, stats: S.stats_ }));
    await fgCheck('after the game rules');

    // MEASUREMENT: borderless full screen (Chromium, as in a browser's F11 or video full screen) moved below the bar
    try { measured.fullscreen = await measureFullscreen(k, ours); } catch (e) { measured.fullscreen = { error: e.message }; }
    await fgCheck('after the full-screen measurement');

    const fg1 = await fgNow();
    check('the foreground never became a window of this test', fgBad.length === 0 && !ours.has(fg1), fgBad.join('; '));
    const passed = checks.filter((c) => c.ok).length, failed = checks.length - passed;
    const line = `selftest: ${passed} passed, ${failed} failed; ${failed ? 'FAIL ' + checks.filter((c) => !c.ok).map((c) => c.name + ' (' + c.detail + ')').join(' | ') : 'all green'}`;
    ctx.log(line);
    ctx.log(`selftest measured: ${JSON.stringify(measured)}`);
    try { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), passed, failed, checks, measured }, null, 1)); } catch (_) { /* the log line has it */ }
  })().catch((e) => ctx.log(`selftest threw: ${e.stack || e.message}`));
}

/* A frame-ful BrowserWindow (Chromium's own full-screen path, the one Chrome's F11 takes), made
   invisible (opacity 0) and harmless (no activation, bottom of the z-order), put in full screen,
   then moved below the bar from OUTSIDE with SetWindowPos exactly as the sidecar would. Measures
   whether Chromium puts it back, whether the page re-lays out, and whether it still thinks it is
   full screen. */
async function measureFullscreen(k, ours) {
  const { screen, BrowserWindow, hwndOf, thumbs, BAR_DIP } = k;
  const koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  const SetWindowPos = user32.func('bool __stdcall SetWindowPos(intptr_t hwnd, intptr_t after, int x, int y, int cx, int cy, uint32_t flags)');
  const d = screen.getPrimaryDisplay();
  const w = new BrowserWindow({ show: false, frame: true, width: 400, height: 300, x: d.bounds.x + 40, y: d.bounds.y + 80,
    focusable: false, skipTaskbar: true, title: 'Mantle topbar full-screen probe', webPreferences: { sandbox: true, contextIsolation: true } });
  const hwnd = hwndOf(w);
  ours.add(hwnd);
  try {
    await w.loadURL('data:text/html,<body style="margin:0;background:#888">probe</body>');
    w.setOpacity(0);
    w.showInactive();
    thumbs.toBack(hwnd);
    const before = w.getBounds();
    w.setFullScreen(true);
    await sleep(900);
    thumbs.toBack(hwnd);
    const full = { bounds: w.getBounds(), isFull: w.isFullScreen(), innerHeight: await w.webContents.executeJavaScript('innerHeight') };
    const phys = screen.dipToScreenRect(null, d.bounds);
    const bar = Math.round(BAR_DIP * d.scaleFactor);
    const moved = SetWindowPos(BigInt(hwnd), 0n, phys.x, phys.y + bar, phys.width, phys.height - bar, 0x0004 | 0x0010);   // NOZORDER | NOACTIVATE
    await sleep(1500);
    const fit = { bounds: w.getBounds(), isFull: w.isFullScreen(), innerHeight: await w.webContents.executeJavaScript('innerHeight') };
    w.setFullScreen(false);
    await sleep(700);
    const after = { bounds: w.getBounds(), isFull: w.isFullScreen() };
    return {
      display: d.bounds, scale: d.scaleFactor, before, full, setWindowPos: moved, fit, after,
      chromiumPutItBack: fit.bounds.y === d.bounds.y && fit.bounds.height === d.bounds.height,
      pageRelaidOut: fit.innerHeight < full.innerHeight,
      exitRestored: after.bounds.width === before.width && after.bounds.height === before.height,
    };
  } finally {
    if (!w.isDestroyed()) w.destroy();
  }
}

function stop() { halt = true; }

module.exports = { start, stop };
