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

    // the lock screen: always steps aside, even with "keep over games" on (a FAKE focus snapshot)
    k.onTopbar({ kind: 'focus', hwnd: '434343', self: false, exe: 'C:\\Windows\\SystemApps\\Microsoft.LockApp_cw5n1h2txyewy\\LockApp.exe', desc: 'LockApp.exe',
      fullscreen: true, game: { stepAside: false } });
    await until(() => S.stepAside && !S.win.isVisible(), 1500);
    const lk = { step: S.stepAside, vis: S.win.isVisible(), signal: S.stepSignal, cover: S.cover };
    const lkOg = await call('topbar.overGames', { on: true });
    const lkStill = S.stepAside && !S.win.isVisible();
    await call('topbar.overGames', { on: false });
    check('lock screen: LockApp.exe in front hides the bar (no "stays over its top 28 DIP"), even with "keep over games" on',
      lk.step && !lk.vis && /LockApp\.exe is in front/.test(lk.signal || '') && !lk.cover && lkOg.ok && lkStill, JSON.stringify({ lk, lkOg, lkStill }));
    k.onTopbar(Object.assign({}, real || { kind: 'focus', hwnd: '0', self: false }, { kind: 'focus', game: { stepAside: false } }));
    await until(() => !S.stepAside && S.win.isVisible() && S.stats_.on, 3000);
    check('lock screen: unlocking (another app in front) brings the bar back', !S.stepAside && S.win.isVisible(), JSON.stringify({ step: S.stepAside }));

    // KNOWN GAMES RUNNING (valofix): a STAND-IN process named by MANTLE_TOPBAR_TEST_GAME, never a game
    if (process.env.MANTLE_TOPBAR_TEST_GAME) {
      try { await gameProcess(k, check, until, call, real); } catch (e) { check('game process: the run finished', false, e.stack || e.message); }
      await fgCheck('after the game process');
    }

    // DROPDOWNS (Owen 2026-09-25: pressing a stat showed "a thin grey strip"): open each through the page
    try { await dropdowns(k, page, check, measured, until); } catch (e) { check('dropdowns: the run finished', false, e.stack || e.message); }
    await fgCheck('after the dropdowns');

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

/* KNOWN GAMES RUNNING (valofix, 2026-09-26). A stand-in exe - compiled here, named by
 * MANTLE_TOPBAR_TEST_GAME, no window at all, exits by itself after 90 s - is started and killed BY
 * PID; topbar.js counts that name as a known game only in --test. Proves: the bar steps aside from
 * the process alone (no window, no focus event), stays aside through a focus change and through
 * "keep over games", and comes back when the process exits - with a plain log line each way. */
let standin = null;
const STANDIN_CS = 'class P { static void Main() { System.Threading.Thread.Sleep(90000); } }';
async function gameProcess(k, check, until, call, real) {
  const { ctx, S } = k;
  const cp = require('child_process');
  const name = String(process.env.MANTLE_TOPBAR_TEST_GAME).split(',')[0].trim();
  if (!/^[\w.-]+\.exe$/i.test(name) || /^(valorant|riot|roblox|minecraft|javaw|java)/i.test(name)) {
    check('game process: the stand-in name is a plain made-up exe name (never a real game\'s)', false, name);
    return;
  }
  const dir = path.join(os.tmpdir(), 'mantle-topbar');
  const exe = path.join(dir, name);
  if (!fs.existsSync(exe)) {
    fs.mkdirSync(dir, { recursive: true });
    const src = path.join(dir, 'standin.cs');
    fs.writeFileSync(src, STANDIN_CS);
    const csc = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
    const r = cp.spawnSync(csc, ['/nologo', '/target:winexe', `/out:${exe}`, src], { windowsHide: true, encoding: 'utf8' });
    if (r.status !== 0) { check('game process: the stand-in compiled', false, (r.stdout || '') + (r.stderr || '')); return; }
  }
  const logs = [];
  const origLog = ctx.log;
  ctx.log = (t) => { logs.push(String(t)); origLog(t); };
  try {
    check('game process: no stand-in is running before the test, and the bar is back', !S.run && !S.stepAside && S.win.isVisible(), JSON.stringify({ run: S.run, step: S.stepAside }));
    const t0 = Date.now();
    standin = cp.spawn(exe, [], { windowsHide: true, detached: false, stdio: 'ignore' });
    const pid = standin.pid;
    await until(() => S.run && S.stepAside && !S.win.isVisible(), 5000);
    const took = Date.now() - t0;
    check(`game process: the bar steps aside from the PROCESS alone, within ${took} ms (no window, no focus event)`,
      !!S.run && S.run.pid === pid && S.stepAside && S.stepKind === 'run' && !S.win.isVisible() && S.stats_.on === false && took < 4000,
      JSON.stringify({ run: S.run && { pid: S.run.pid, file: S.run.file }, pid, step: S.stepAside, kind: S.stepKind, stats: S.stats_, took }));
    check('game process: the drag guard is off and the release was attempted (a dry run in --test)', S.guard.ok === false && S.run && S.run.released === 'dry run', JSON.stringify({ guard: S.guard, released: S.run && S.run.released }));
    check('game process: one plain log line says the game is running and the bar stepped aside until it exits',
      logs.some((l) => l.includes(`${name} is running (a known game); the top bar stepped aside until it exits`)), JSON.stringify(logs.slice(-6)));
    // an alt-tab to a non-game, and the "keep over games" switch: neither brings it back while the game runs
    k.onTopbar(Object.assign({}, real || { kind: 'focus', hwnd: '0', self: false }, { kind: 'focus', game: { stepAside: false } }));
    await new Promise((r) => setTimeout(r, 600));
    const afterFocus = S.stepAside && !S.win.isVisible();
    const og = await call('topbar.overGames', { on: true });
    const afterOg = S.stepAside && !S.win.isVisible();
    await call('topbar.overGames', { on: false });
    check('game process: another app in front and "keep over games" both leave it aside while the game runs', afterFocus && og.ok && og.stepAside === true && afterOg,
      JSON.stringify({ afterFocus, og, afterOg }));
    const st = await call('topbar.status');
    check('game process: topbar.status names the running game and the process watch is healthy', st && st.run && st.run.file.toLowerCase() === name.toLowerCase() && st.runWatch && st.runWatch.ok === true,
      JSON.stringify(st && { run: st.run, runWatch: st.runWatch }));
    // exit: killed BY PID (ours), and the bar, its stats and the guard come back
    const t1 = Date.now();
    try { process.kill(pid); } catch (e) { check('game process: the stand-in was killed', false, e.message); }
    await until(() => !S.run && !S.stepAside && S.win.isVisible() && S.stats_.on && S.guard.ok, 5000);
    const back = Date.now() - t1;
    check(`game process: its exit brings the bar, its stats and the drag guard back, within ${back} ms`,
      !S.run && !S.stepAside && S.win.isVisible() && S.stats_.on && S.guard.ok && back < 4000, JSON.stringify({ run: S.run, step: S.stepAside, stats: S.stats_, guard: S.guard, back }));
    check('game process: plain log lines say it exited and the strip is taken back (nothing to take back in --test)',
      logs.some((l) => new RegExp(`${name.replace(/[.]/g, '\\.')} exited after \\d+ s; the top bar takes back`).test(l)) && logs.some((l) => /back \(game exited\): the game exited/.test(l)) &&
      logs.some((l) => /a --test instance never reserves space/.test(l)), JSON.stringify(logs.slice(-6)));
  } finally {
    ctx.log = origLog;
    if (standin && standin.exitCode === null) { try { standin.kill(); } catch (_) { /* gone */ } }
    standin = null;
  }
}

/* A frame-ful BrowserWindow (Chromium's own full-screen path, the one Chrome's F11 takes), made
   invisible (opacity 0) and harmless (no activation, bottom of the z-order), put in full screen,
   then moved below the bar from OUTSIDE with SetWindowPos exactly as the sidecar would. Measures
   whether Chromium puts it back, whether the page re-lays out, and whether it still thinks it is
   full screen. */
/* DROPDOWNS (2026-09-25). Each stat and two menus are opened by a press delivered to the PAGE
 * (webContents.sendInputEvent: Chromium input straight into this renderer, never an OS event;
 * a dispatched mousedown if that does not arrive), with a FIXTURE app and FIXTURE stats: the real
 * focus / stats pushes are held back while it runs, so nothing of Owen's is in a capture. Measured
 * per dropdown: what the page asked for, the window's bounds, its REGION (GetWindowRgnBox through
 * a hidden PowerShell, read-only), the dropdowns' layout boxes, and a 4 ms log from the press
 * until 900 ms later (was a dropdown ever visible past the window's bottom = a clipped slice?).
 * Captures of THIS window only (capturePage) go to %TEMP%\mantle-topbar\drop-*.png. */
const FIX_FOCUS = (() => {
  let id = 900;
  const it = (label, key, extra) => Object.assign({ t: 'item', pos: 0, label, key: key || '', mn: label[0].toLowerCase(), id: id++, enabled: true, checked: false, radio: false, items: null, lazy: false }, extra || {});
  const pos = (items) => items.map((x, i) => Object.assign(x, { pos: i }));
  const file = it('File', '', { id: null, items: pos([it('New', 'Ctrl+N'), it('Open…', 'Ctrl+O'), { t: 'sep' }, it('Save', 'Ctrl+S'), it('Save As…', 'Ctrl+Shift+S'),
    { t: 'sep' }, it('Page Setup…'), it('Print…', 'Ctrl+P'), { t: 'sep' }, it('Exit')]) });
  const edit = it('Edit', '', { id: null, items: pos([it('Undo', 'Ctrl+Z'), it('Cut', 'Ctrl+X'), it('Copy', 'Ctrl+C'), it('Paste', 'Ctrl+V')]) });
  return { kind: 'focus', hwnd: '515151', cls: 'FixtureClass', title: 'Fixture', exe: 'C:\\fixture\\Fixture.exe', desc: 'Fixture', product: 'Fixture',
    self: false, shell: false, fullscreen: false, zoomed: false, topmost: false, enabled: true, uia: 'not needed', game: { stepAside: false },
    // source 'fixture', not 'win32': the page then never asks the sidecar to read or prepare it (hwnd 515151 is no window of Owen's to touch)
    menu: { source: 'fixture', hwnd: '515151', owner: false, items: pos([file, edit]), count: 16, truncated: false } };
})();
const GB = 2 ** 30;
const FIX_STATS = { t: 1, cpu: { pct: 23.4, cores: [22, 61, 9, 14, 37, 5, 71, 18], top: [{ name: 'fixture-a', pct: 11.2 }, { name: 'fixture-b', pct: 6.1 }, { name: 'fixture-c', pct: 1.3 }] },
  mem: { used: 9.7 * GB, total: 15.7 * GB, commit: 13.1 * GB, commitLimit: 23.4 * GB, top: [{ name: 'fixture-a', bytes: 2.1 * GB }, { name: 'fixture-b', bytes: 1.4 * GB }] },
  gpu: { pct: 7.8, name: 'Fixture GPU', engines: [{ type: '3D', pct: 7.8 }, { type: 'VideoDecode', pct: 2.2 }, { type: 'Copy', pct: 0 }], dedicated: 0.13 * GB, shared: 1.2 * GB,
    top: [{ name: 'fixture-a', pct: 4.1 }] },
  net: { down: 2.4 * 2 ** 20, up: 88 * 1024, adapters: [{ name: 'Fixture adapter', down: 2.4 * 2 ** 20, up: 88 * 1024 }] }, costMs: 1 };

const RGN_PS1 = `param([Int64]$Hwnd)
Add-Type -Namespace MantleSelftest -Name Rgn -MemberDefinition @'
[DllImport("user32.dll")] public static extern int GetWindowRgnBox(IntPtr h, out RECT r);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
[DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int left, top, right, bottom; }
'@
[void][MantleSelftest.Rgn]::SetThreadDpiAwarenessContext([IntPtr](-4))
$b = New-Object MantleSelftest.Rgn+RECT; $w = New-Object MantleSelftest.Rgn+RECT
$k = [MantleSelftest.Rgn]::GetWindowRgnBox([IntPtr]$Hwnd, [ref]$b)
[void][MantleSelftest.Rgn]::GetWindowRect([IntPtr]$Hwnd, [ref]$w)
'{0} {1} {2} {3} {4} {5} {6} {7} {8}' -f $k, $b.left, $b.top, $b.right, $b.bottom, $w.left, $w.top, $w.right, $w.bottom
`;
// The window's rect and region in physical px (region kind 0 = none: the whole window is live).
function regionOf(hwnd) {
  const cp = require('child_process');
  const file = path.join(path.dirname(OUT), 'rgn.ps1');
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, RGN_PS1); } catch (e) { return Promise.resolve({ error: e.message }); }
  return new Promise((resolve) => {
    cp.execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, '-Hwnd', String(hwnd)],
      { windowsHide: true, timeout: 20000 }, (err, out) => {
        const n = String(out || '').trim().split(/\s+/).map(Number);
        if (err || n.length !== 9 || n.some((x) => !Number.isFinite(x))) return resolve({ error: (err && err.message) || `unreadable: ${String(out).slice(0, 80)}` });
        resolve({ kind: n[0], box: { left: n[1], top: n[2], right: n[3], bottom: n[4] }, rect: { left: n[5], top: n[6], right: n[7], bottom: n[8] } });
      });
  });
}

async function dropdowns(k, page, check, measured, until) {
  const { ctx, S, screen, BAR_DIP } = k;
  const scale = screen.getPrimaryDisplay().scaleFactor;
  const dir = path.dirname(OUT);
  // the live height of what is on: the region's box when there is one, else the whole window (DIP)
  const liveDip = (g) => (g.error ? null : (g.kind === 2 || g.kind === 3) ? (g.box.bottom - g.box.top) / scale : (g.rect.bottom - g.rect.top) / scale);
  const realPush = ctx.push;
  let held = false;
  try {
    ctx.push = function (win, ev, payload) {
      if (win === S.win && /^topbar\.(focus|title|stats|uia|geometry)$/.test(ev)) return undefined;
      return realPush.apply(this, arguments);
    };
    held = ctx.push !== realPush;
  } catch (_) { held = false; }
  const rows = [];
  try {
    await ctx.sidecar.send('topbar.stats', { on: false }, { timeoutMs: 3000 });
    realPush.call(ctx, S.win, 'topbar.focus', FIX_FOCUS);
    realPush.call(ctx, S.win, 'topbar.stats', FIX_STATS);
    await sleep(400);
    for (const [name, sel] of [['cpu', '.st[data-k="cpu"]'], ['mem', '.st[data-k="mem"]'], ['gpu', '.st[data-k="gpu"]'], ['net', '.st[data-k="net"]'],
      ['mantle', '.t[data-i="0"]'], ['file', '.t[data-i="2"]']]) {
      const q = JSON.stringify(sel);
      const pos = await page(`(() => { const b = document.querySelector(${q}); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
      if (!pos) { check(`dropdown ${name}: its button is on the bar`, false, sel); continue; }
      const closed0 = { bounds: S.win.getBounds(), rgn: await regionOf(S.hwnd) };
      await page(`(() => { window.__dropLog = []; const t0 = performance.now(); const tick = () => { const dds = [...document.querySelectorAll('#menus .dd')];
        window.__dropLog.push({ t: Math.round(performance.now() - t0), ih: innerHeight, dds: dds.map((d) => ({ b: d.offsetTop + d.offsetHeight, hid: getComputedStyle(d).visibility === 'hidden' })) });
        if (performance.now() - t0 < 900) setTimeout(tick, 4); }; tick(); return true; })()`);
      let via = 'sendInputEvent';
      S.win.webContents.sendInputEvent({ type: 'mouseDown', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
      S.win.webContents.sendInputEvent({ type: 'mouseUp', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
      if (!(await until(() => S.menu.open, 1200))) {
        via = 'dispatched mousedown';
        await page(`document.querySelector(${q}).dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
        await until(() => S.menu.open, 1500);
      }
      await sleep(950);
      const pg = await page(`(() => { const dds = [...document.querySelectorAll('#menus .dd')];
        return { ih: innerHeight, dds: dds.map((d) => ({ top: d.offsetTop, bottom: d.offsetTop + d.offsetHeight, inner: d.scrollHeight, client: d.clientHeight, hidden: getComputedStyle(d).visibility === 'hidden' })),
          scroll: document.scrollingElement.scrollTop + document.getElementById('menus').scrollTop, log: window.__dropLog || [],
          cores: [...document.querySelectorAll('.core i')].map((i) => i.offsetHeight), note: (document.querySelector('.warn') || {}).textContent || '' }; })()`);
      const open = { asked: S.menu.open ? S.menu.height : null, bounds: S.win.getBounds(), shape: S.shape, rgn: await regionOf(S.hwnd) };
      let shot = null;
      if (held) {
        try { const img = await S.win.webContents.capturePage(); if (!img.isEmpty()) { shot = path.join(dir, `drop-${name}.png`); fs.writeFileSync(shot, img.toPNG()); } } catch (e) { shot = 'capture failed: ' + e.message; }
      }
      await page(`(() => { for (let i = 0; i < 3 && window.__topbar.open; i++) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true; })()`);
      await until(() => !S.menu.open, 1500);
      await sleep(300);
      const shut = { bounds: S.win.getBounds(), shape: S.shape, rgn: await regionOf(S.hwnd) };
      const full = pg.dds.length ? Math.max(...pg.dds.map((d) => d.bottom)) : null;
      const live = liveDip(open.rgn);
      const clippedFrames = pg.log.filter((f) => f.dds.some((d) => !d.hid && d.b > f.ih));
      const row = { name, via, full, asked: open.asked, windowOpen: open.bounds.height, liveOpenDip: live, ih: pg.ih, dds: pg.dds, frames: pg.log.length,
        clippedFrames: clippedFrames.length, firstClipped: clippedFrames[0] || null, windowClosed: shut.bounds.height, liveClosedDip: liveDip(shut.rgn),
        rgnOpen: open.rgn, rgnClosed: shut.rgn, closed0: { h: closed0.bounds.height, live: liveDip(closed0.rgn) }, scroll: pg.scroll, note: pg.note, shot };
      if (name === 'cpu') row.cores = pg.cores;
      rows.push(row);
      const tag = `dropdown ${name} (${via})`;
      check(`${tag}: opens, and the height asked for covers the dropdown's full height`, full != null && open.asked >= full, JSON.stringify({ full, asked: open.asked }));
      check(`${tag}: the window grew to it and its live region (shape) holds the whole dropdown`,
        open.bounds.height >= full && live != null && live >= full - 1 && pg.ih >= full, JSON.stringify({ win: open.bounds.height, live, ih: pg.ih, full, rgn: open.rgn }));
      // "no note" means no note about THE MENU (cut off / cannot be shown). Other notes can still be up
      // from earlier steps: the About step's version line stays 8 s and failed cpu + mem on 2026-09-25.
      const menuNote = !!pg.note && /menu (is cut off|cannot be shown)/i.test(pg.note);
      check(`${tag}: shown whole (nothing hidden, nothing scrolling inside on this screen), the page not scrolled, no note about the menu`,
        pg.dds.every((d) => !d.hidden && d.bottom <= pg.ih && d.inner <= d.client + 1) && pg.scroll === 0 && !menuNote, JSON.stringify({ dds: pg.dds, scroll: pg.scroll, note: pg.note }));
      check(`${tag}: no clipped slice was ever shown while the window grew (${pg.log.length} samples)`, pg.log.length > 5 && clippedFrames.length === 0, JSON.stringify(clippedFrames.slice(0, 3)));
      check(`${tag}: closing shrinks the live part back to the ${BAR_DIP} DIP bar`, !S.menu.open && Math.abs(liveDip(shut.rgn) - BAR_DIP) <= 1, JSON.stringify({ shut, live: liveDip(shut.rgn) }));
      if (name === 'cpu') {
        const want = FIX_STATS.cpu.cores.map((p) => Math.round(26 * p / 100));
        check(`${tag}: the per-core bars are drawn (CSSOM heights; the CSP drops inline styles)`, pg.cores.length === 8 && pg.cores.every((h, i) => Math.abs(h - want[i]) <= 1), JSON.stringify([pg.cores, want]));
      }
    }
  } finally {
    measured.dropdowns = rows;
    if (held) ctx.push = realPush;
    if (S.stats_.on && !S.stepAside) await ctx.sidecar.send('topbar.stats', { on: true }, { timeoutMs: 3000 });
    if (S.focus) realPush.call(ctx, S.win, 'topbar.focus', S.focus);
  }
}

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

function stop() { halt = true; if (standin && standin.exitCode === null) { try { standin.kill(); } catch (_) { /* gone */ } } }

module.exports = { start, stop };
