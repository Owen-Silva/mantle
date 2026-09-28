'use strict';
/*
 * switcher.js - Mantle's Alt+Tab: the overlay window, its sessions, its off switch.
 *
 * THE SPLIT, AND WHY ALMOST NONE OF ALT+TAB IS IN THIS FILE (2026-09-23). The keys, the list, its
 * order and the switch itself all live in the sidecar (sidecar/Hotkey.cs + sidecar/AltTab.cs).
 * Owen's hard requirement is that Alt+Tab never goes dead: if this process or the overlay's page
 * is slow, hung or has crashed, letting go of Alt must still switch windows. So the sidecar's hook
 * thread owns each session from the first Tab to the switch, and this file only DRAWS it. The
 * sidecar tells us what happened as {ev:'switcher', op, seq, ...}:
 *   hook       the hook's status: installed, which features are on, and why not
 *   open       the first Tab: the windows in most-recently-used order, the selection, the monitor
 *   move       the selection moved (Tab, Shift+Tab, the arrows, a click)
 *   commit     Alt came up, or a tile was clicked: the sidecar is switching RIGHT NOW
 *   cancel     Esc, or the session ended without a switch, with the reason
 *   activated  how the switch went: ok and how ('direct' | 'ladder' | 'already'), or why not
 *   refused    a click that arrived after its Alt+Tab had ended
 *   winkey     Win+N or Win+A, for the bar's notification centre and quick settings
 *
 * ONE ALT+TAB, AND THE ~100 ms BUDGET FROM THE KEYPRESS TO THE FIRST FRAME ON SCREEN:
 *   key   Tab goes down with Alt held. The hook swallows it and wakes its own thread.
 *   open  The sidecar lists and orders the windows and says `open` (its `ms` is that share; its
 *         `keyAt` is the keypress on the QueryPerformanceCounter clock, which process.hrtime
 *         reads too, so key -> on screen is measured end to end across the two processes).
 *         HERE, all at once: the overlay window, which is PARKED off screen next to that
 *         monitor, is sized for the list; the page is handed the session; the one-shot backdrop
 *         capture starts; the sidecar is told how many columns the arrows move through.
 *   paint The page draws while the window is still parked, measures its preview boxes and says
 *         switcher.painted. HERE the DWM thumbnails are registered into the parked window, so
 *         pictures and page arrive on screen in the same frame.
 *   show  SHOW_DELAY_MS after the keypress (or at paint, if that is later) ONE SetWindowPos moves
 *         the window on screen and to the top of the topmost band. The frame is already
 *         composed, so it is visible on DWM's next frame. A tap that lets go of Alt before this
 *         never shows anything, which is Windows' own behaviour.
 *   end   commit/cancel: the thumbnails are unregistered FIRST, then the window is parked, then
 *         the page is told to empty itself. The switch does not wait for any of it.
 *
 * WHY PARKED AND NOT hide()/show(): the bar measured it (main.js, THE BAR IS NEVER hide()-DEN,
 * build 29): after one hide()/showInactive() cycle a transparent, frameless, focusable:false,
 * always-on-top window stops getting mousedowns, and the switcher's tiles are clicked. A parked
 * window also keeps its compositor running, so there is nothing to wake when it comes on screen.
 * It parks BESIDE the monitor it is about to appear on, never on another one: moving a
 * per-monitor-DPI window onto a monitor with a different scale makes Windows resize it
 * (WM_DPICHANGED), which would undo the size and the thumbnail rectangles set while parked.
 *
 * NOTHING FAILS SILENTLY. The state piece `switcher` says in words whether Alt+Tab is Mantle's or
 * Windows' and why; the tray menu shows that line under its off switch; a window that cannot be
 * activated puts a notice on screen naming the window and the reason; every session ends with
 * one log line carrying its timings.
 */
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, screen } = require('electron');
const thumbs = require('./thumbs');
const { hwndOf, noDragHandles } = require('./windows');
const Layout = require('../ui/switcher/layout.js');

const TITLE = 'Mantle switcher';         // main.js MANTLE_TITLES and AltTab.cs MantleTitles know it
const SHOW_DELAY_MS = 100;               // key -> on screen, for a held Alt+Tab (see the timeline)
const PAINT_LATE_MS = 1500;              // a session the page has not drawn by now is logged
const NOTICE_MS = 4500;                  // how long "could not switch to ..." stays up
const ALT_POLL_MS = 200;                 // main's own check that Alt is still down, while shown
const ALT_UP_GRACE_MS = 600;             // ...and how long Alt may be up with no word from the sidecar
const BACKDROP_SCALE = 4;                // as main.js: the page blurs it, so small is free
const OVERSCAN = 14;                     // switcher.css .bdrop canvas: 14 px bigger on every side
const PRESIZE_MS = 500;                  // how often the parked window is re-sized for the next Alt+Tab
const RELOAD_LIMIT = 5;                  // page reloads after a crash, per RELOAD_WINDOW_MS
const RELOAD_WINDOW_MS = 10 * 60 * 1000;

// SetWindowPos
const HWND_TOPMOST = -1;
const SWP_NOSIZE = 0x0001;
const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;
const SWP_SHOWWINDOW = 0x0040;
const SWP_NOOWNERZORDER = 0x0200;
const VK_MENU = 0x12;

const S = {
  started: false,
  stopped: false,
  ctx: null,
  win: null,
  hwnd: 0,
  at: null,                    // where the window was last put, physical px {x, y}
  page: { ready: false, reason: 'the switcher page has not loaded yet' },
  reloads: [],
  settings: { altTab: true, winKeys: true },
  settingsFile: null,
  settingsNote: null,          // why the settings file could not be read or written, if it could not
  live: false,                 // applyLive has run and nothing has put Windows back since
  releasedWhy: null,
  hook: null,                  // the sidecar's last word on the hook
  hookErr: null,
  pendingApply: null,          // a settings change waiting for the open Alt+Tab to end
  applying: 0,                 // hotkey calls in flight (their answer is not in yet)
  sess: null,                  // the Alt+Tab on screen (or being prepared)
  acting: null,                // the session whose switch is under way, until `activated`
  notice: null,                // {id, timer, painted, due, rect}
  noticeSeq: 0,
  native: undefined,           // koffi's user32 bindings, or null
  nativeReason: null,
  last: null,                  // the last finished session, for switcher.status
  tset: null,                  // this window's set of DWM thumbnails (lib/thumbs.js)
  size: null,                  // the window's size as last set here, physical px {w, h}
  monKey: null,                // the monitor it was last parked beside (see sizeParked)
  target: null,                // {mon, work} of the last Alt+Tab: where the next one most likely opens
  presizeTimer: null,
  presizeErr: null,
  loads: 0,                    // how many times the page has said switcher.ready (see warmUp)
  dryDone: false,              // the dry run has been started (test mode only: see dryRun)
};

function log(line) { process.stdout.write(`mantle: switcher: ${line}\n`); }
function now() { return Number(process.hrtime.bigint()) / 1e6; }
function r1(v) { return Math.round(v * 10) / 10; }
function alive() { return !!(S.win && !S.win.isDestroyed() && S.win.webContents && !S.win.webContents.isDestroyed()); }

function send(name, payload) {
  if (!alive()) return false;
  try { S.win.webContents.send('mantle:event', { name, payload }); return true; } catch (_) { return false; }
}

/* ---- user32 through koffi ------------------------------------------------------------------ */

/**
 * SetWindowPos in PHYSICAL px (the sidecar's monitor rectangles are physical), AllowSetForeground
 * Window for the click path, GetAsyncKeyState for the stuck-overlay guard. Bound once; null with
 * a reason if koffi is missing, and then Electron's own calls stand in (see place()).
 */
function native() {
  if (S.native !== undefined) return S.native;
  S.native = null;
  if (process.platform !== 'win32') { S.nativeReason = 'this is not Windows'; return null; }
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    S.native = {
      setWindowPos: user32.func('int __stdcall SetWindowPos(intptr_t hwnd, intptr_t after, int x, int y, int cx, int cy, uint32 flags)'),
      allowSetForeground: user32.func('int __stdcall AllowSetForegroundWindow(uint32 pid)'),
      asyncKey: user32.func('int16 __stdcall GetAsyncKeyState(int vk)'),
    };
  } catch (err) {
    S.nativeReason = `koffi could not bind user32.dll (${String(err && err.message).split('\n')[0]})`;
  }
  return S.native;
}

/**
 * Put the window at x,y (physical px), optionally resizing it, optionally ON TOP of the topmost
 * band (the reveal). Never activates it. Returns {ok, how}.
 */
function place(x, y, w, h, top) {
  if (!alive()) return { ok: false, how: 'there is no switcher window' };
  const n = native();
  if (n && S.hwnd) {
    let flags = SWP_NOACTIVATE | SWP_NOOWNERZORDER;
    if (!(w > 0 && h > 0)) flags |= SWP_NOSIZE;
    flags |= top ? SWP_SHOWWINDOW : SWP_NOZORDER;
    try {
      if (n.setWindowPos(S.hwnd, top ? HWND_TOPMOST : 0, Math.round(x), Math.round(y),
        Math.round(w || 0), Math.round(h || 0), flags) !== 0) {
        S.at = { x: Math.round(x), y: Math.round(y) };
        if (w > 0 && h > 0) S.size = { w: Math.round(w), h: Math.round(h) };
        return { ok: true, how: 'SetWindowPos' };
      }
    } catch (_) { /* Electron's road below */ }
  }
  try {
    if (w > 0 && h > 0) S.win.setBounds(screen.screenToDipRect(null, { x, y, width: w, height: h }));
    else {
      const p = screen.screenToDipPoint({ x, y });
      S.win.setPosition(Math.round(p.x), Math.round(p.y));
    }
    if (top) { S.win.setAlwaysOnTop(true, 'screen-saver'); S.win.moveTop(); }
    S.at = { x: Math.round(x), y: Math.round(y) };
    if (w > 0 && h > 0) S.size = { w: Math.round(w), h: Math.round(h) };
    return { ok: true, how: `Electron setBounds (${S.nativeReason || 'SetWindowPos refused'})` };
  } catch (err) {
    return { ok: false, how: err.message };
  }
}

/* ---- screens --------------------------------------------------------------------------------- */

function rectOf(a) {
  if (!Array.isArray(a) || a.length !== 4 || !a.every((v) => Number.isFinite(Number(v)))) return null;
  const [l, t, r, b] = a.map(Number);
  return r > l && b > t ? { x: l, y: t, w: r - l, h: b - t } : null;
}

/** Every display's bounds in physical px. */
function displaysPhys() {
  const out = [];
  for (const d of screen.getAllDisplays()) {
    try {
      const r = screen.dipToScreenRect(null, d.bounds);
      out.push({ x: r.x, y: r.y, w: r.width, h: r.height });
    } catch (_) {
      out.push({ x: d.bounds.x, y: d.bounds.y, w: d.bounds.width, h: d.bounds.height });
    }
  }
  return out;
}

function primaryPhys() {
  const d = screen.getPrimaryDisplay();
  try {
    const m = screen.dipToScreenRect(null, d.bounds);
    const w = screen.dipToScreenRect(null, d.workArea);
    return { mon: { x: m.x, y: m.y, w: m.width, h: m.height }, work: { x: w.x, y: w.y, w: w.width, h: w.height } };
  } catch (_) {
    const b = d.bounds;
    return { mon: { x: b.x, y: b.y, w: b.width, h: b.height }, work: { x: b.x, y: b.y, w: b.width, h: b.height } };
  }
}

/** The scale factor of the display a physical rectangle is on. */
function scaleFor(mon) {
  try {
    const dip = screen.screenToDipRect(null, { x: mon.x, y: mon.y, width: mon.w, height: mon.h });
    const d = screen.getDisplayMatching(dip);
    if (d && d.scaleFactor > 0) return d.scaleFactor;
  } catch (_) { /* the primary's below */ }
  return screen.getPrimaryDisplay().scaleFactor || 1;
}

/**
 * Where to park a w x h window so that it is on NO display but Windows still counts it as on `mon`
 * (the nearest monitor decides a window's DPI): just above it, else below, left, right. Pure.
 */
function parkSpot(mon, w, h, displays) {
  const GAP = 64;
  const hit = (x, y) => displays.some((d) => x < d.x + d.w && x + w > d.x && y < d.y + d.h && y + h > d.y);
  const cands = [
    { x: mon.x, y: mon.y - h - GAP, side: 'above' },
    { x: mon.x, y: mon.y + mon.h + GAP, side: 'below' },
    { x: mon.x - w - GAP, y: mon.y, side: 'left of' },
    { x: mon.x + mon.w + GAP, y: mon.y, side: 'right of' },
  ];
  for (const c of cands) if (!hit(c.x, c.y)) return c;
  return { x: -32000, y: -32000, side: 'far from' };
}

/** Park the window, keeping its size. */
function park(why) {
  const target = defaultPark();
  const r = place(target.x, target.y, 0, 0, false);
  if (!r.ok) log(`the switcher window could not be parked (${why}): ${r.how}`);
  return r;
}

function defaultPark() {
  const p = primaryPhys();
  let w = 400;
  let h = 300;
  try { const b = S.win.getBounds(); const s = screen.getPrimaryDisplay().scaleFactor || 1; w = Math.round(b.width * s); h = Math.round(b.height * s); } catch (_) { /* 400x300 */ }
  return parkSpot(p.mon, w, h, displaysPhys());
}

/* ---- the window -------------------------------------------------------------------------------- */

function createWindow() {
  const test = !!S.ctx.test;
  const p = primaryPhys();
  const spot = parkSpot(p.mon, 500, 300, displaysPhys());
  const dip = screen.screenToDipPoint({ x: spot.x, y: spot.y });
  const win = new BrowserWindow({
    x: Math.round(dip.x),
    y: Math.round(dip.y),
    width: 400,
    height: 240,
    show: false,
    frame: false,
    transparent: true,
    // NOT resizable (2026-09-27, lane tbdrift): a resizable frameless window has resize bands at all
    // four edges whatever thickFrame says (lib/windows.js noDragHandles). The per-session resize is a
    // raw SetWindowPos, so noDragHandles(rawSized) below lifts the min = max pin Electron puts on it.
    resizable: false,
    thickFrame: false,
    skipTaskbar: true,
    alwaysOnTop: !test,
    // Never activated, not even by a click on a tile: the window being switched FROM keeps the
    // focus until the sidecar switches, exactly as with Windows' own Alt+Tab.
    focusable: false,
    hasShadow: false,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
    title: TITLE,
    backgroundColor: '#00000000',
    // lib/windows.js baseWebPreferences, verbatim (it is not exported).
    webPreferences: {
      preload: path.join(S.ctx.root, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      // Drawn while PARKED off screen; a throttled page would miss the budget.
      backgroundThrottling: false,
    },
  });
  noDragHandles(win, { rawSized: true });   // sized by a raw SetWindowPos (placeNative)
  S.win = win;
  S.hwnd = Number(hwndOf(win)) || 0;
  S.tset = thumbs.set('switcher', 'the switcher window', 'this Alt+Tab');
  const wc = win.webContents;
  wc.on('will-navigate', (e) => e.preventDefault());
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('console-message', (...a) => {
    const d0 = a[1] && typeof a[1] === 'object' && 'message' in a[1] ? a[1] : null;
    const level = d0 ? d0.level : a[1];
    const bad = typeof level === 'string' ? (level === 'error' || level === 'warning') : level >= 2;
    if (bad) process.stderr.write(`mantle: [switcher page] ${d0 ? d0.message : a[2]}\n`);
  });
  wc.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    pageDown(`the switcher page failed to load (${description}, ${code})`, false);
  });
  wc.on('did-start-navigation', (e, ...legacy) => {
    const main = e && typeof e.isMainFrame === 'boolean' ? e.isMainFrame : legacy[2];
    const same = e && typeof e.isSameDocument === 'boolean' ? e.isSameDocument : legacy[1];
    if (main && !same && S.page.ready) pageDown('the switcher page is loading again', false);
  });
  wc.on('render-process-gone', (_e, details) => pageDown(`the switcher page's renderer died (${details && details.reason})`, true));
  wc.on('unresponsive', () => pageDown('the switcher page stopped responding', false));
  wc.on('responsive', () => {
    if (S.page.ready || S.page.reason !== 'the switcher page stopped responding') return;
    pageUp('the switcher page is responding again');
  });
  win.on('closed', () => {
    if (S.win !== win) return;
    if (S.tset) S.tset.clear('the switcher window closed');
    S.win = null;
    S.hwnd = 0;
    if (S.resting) return;              // closed on purpose while a game runs (rest): not a fault
    pageDown('the switcher window was closed', false);
  });
  win.once('ready-to-show', () => {
    if (test || !alive()) return;       // a test run never puts it on screen, parked or not
    park('the switcher window is ready');
    try {
      win.showInactive();
      win.setAlwaysOnTop(true, 'screen-saver');
    } catch (err) {
      pageDown(`the switcher window would not show, even parked: ${err.message}`, false);
    }
  });
  const file = path.join(S.ctx.root, 'ui', 'switcher', 'index.html');
  if (fs.existsSync(file)) win.loadFile(file);
  else pageDown(`${file} does not exist`, false);
}

/** The page cannot draw an Alt+Tab. Alt+Tab goes back to Windows until it can (see applyHook). */
function pageDown(reason, reload) {
  const was = S.page.ready;
  // `failed`: this is a fault, not the first load still under way (computeState's `broken`).
  S.page = { ready: false, reason, failed: true };
  if (S.sess) endVisual(S.sess, reason);
  hideNotice(reason);
  if (was || reload) log(`${reason}; Alt+Tab is Windows' own until the page is back`);
  if (reload && !S.stopped && alive()) {
    const t = Date.now();
    S.reloads = S.reloads.filter((x) => t - x < RELOAD_WINDOW_MS);
    if (S.reloads.length >= RELOAD_LIMIT) {
      S.page.reason = `${reason}, and it has died ${RELOAD_LIMIT} times in ${RELOAD_WINDOW_MS / 60000} minutes, so it is not being reloaded again until Mantle restarts`;
    } else {
      S.reloads.push(t);
      const timer = setTimeout(() => { if (alive() && !S.stopped) S.win.webContents.reload(); }, 1000);
      if (timer.unref) timer.unref();
    }
  }
  applyHook(reason);
}

function pageUp(why) {
  S.page = { ready: true, reason: null };
  applyHook(why);
}

/* ---- settings ------------------------------------------------------------------------------------ */

function loadSettings() {
  try {
    if (!fs.existsSync(S.settingsFile)) return;
    const raw = JSON.parse(fs.readFileSync(S.settingsFile, 'utf8'));
    for (const k of ['altTab', 'winKeys']) if (typeof raw[k] === 'boolean') S.settings[k] = raw[k];
    S.settingsNote = null;
  } catch (err) {
    S.settingsNote = `${S.settingsFile} could not be read (${err.message}), so both switches are at their defaults (on)`;
    log(S.settingsNote);
  }
}

function saveSettings() {
  try {
    const tmp = `${S.settingsFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(S.settings, null, 2));
    fs.renameSync(tmp, S.settingsFile);
    S.settingsNote = null;
  } catch (err) {
    S.settingsNote = `the switch was changed but ${S.settingsFile} could not be written (${err.message}), so it will be back to the old setting after a restart`;
    log(S.settingsNote);
  }
}

function setSettings(patch, who) {
  const changed = [];
  for (const k of ['altTab', 'winKeys']) {
    if (patch && typeof patch[k] === 'boolean' && patch[k] !== S.settings[k]) {
      S.settings[k] = patch[k];
      changed.push(`${k === 'altTab' ? "Mantle's Alt+Tab" : 'Win+N / Win+A'} ${patch[k] ? 'on' : 'off'}`);
    }
  }
  if (!changed.length) return;
  saveSettings();
  log(`${changed.join(', ')} (${who})`);
  applyHook(`${who} turned ${changed.join(', ')}`);
}

/* ---- the hook: what the sidecar is asked for, and what it said ---------------------------------- */

/**
 * Ask the sidecar for exactly what the settings and the page allow. Alt+Tab goes to Mantle only
 * while the page can draw it: a switcher that switches blind (keys work, nothing on screen) is
 * worse than Windows' own. Never while an Alt+Tab is open: pulling the hook out from under a held
 * Alt would end it without a switch, so the change waits for that session to end.
 */
async function applyHook(why) {
  if (!S.started) return;
  if (S.ctx.test || !S.live) { publish(); return; }
  if (S.sess && !S.sess.rehearsal) { S.pendingApply = why; publish(); return; }
  S.pendingApply = null;
  const want = { altTab: S.settings.altTab && S.page.ready, winKeys: S.settings.winKeys };
  const blocked = S.ctx.sidecar.blockedReason();
  if (blocked) {
    S.hookErr = `the sidecar cannot be asked (${blocked})`;
    publish();
    return;
  }
  S.applying++;                          // until the answer, "not confirmed yet" is not a fault
  try {
    const r = await S.ctx.sidecar.call('hotkey', want, 4000);
    S.hook = r && typeof r === 'object' ? r : null;
    S.hookErr = S.hook ? null : 'the sidecar answered "hotkey" with nothing';
  } catch (err) {
    const m = err && err.message ? err.message : String(err);
    // An exe from before this feature asks for winTap and nothing else.
    S.hookErr = /winTap/.test(m) && !/altTab/.test(m)
      ? `the sidecar exe predates Mantle's Alt+Tab (it said: ${m}): run npm run build:sidecar`
      : m;
  } finally {
    S.applying--;
  }
  publish();
  const st = S.ctx.state.get().switcher || {};
  log(`${why}: ${st.reason}${st.winKeysReason ? `; ${st.winKeysReason}` : ''}`);
}

/** The words for the state piece, the tray menu and the log. */
function computeState() {
  return stateWords({
    test: !!S.ctx.test, live: S.live, releasedWhy: S.releasedWhy, hookErr: S.hookErr, hook: S.hook,
    applying: S.applying > 0, pendingApply: !!S.pendingApply, settings: S.settings, page: S.page,
    settingsNote: S.settingsNote, resting: S.resting || null,
  });
}

/*
 * PURE, so every case is testable (lib/switcher.test.js). `broken` is for lib/state.js problems():
 * a switch Owen left ON whose feature is Windows' own anyway, in plain words. NOT broken: a switch
 * he turned off, a test run, before Mantle takes the shell or after it gave it back, a sidecar call
 * still in flight, a change waiting for the Alt+Tab on screen, a page still on its first load.
 */
function stateWords(x) {
  const own = "Alt+Tab is Windows' own";
  const keysOwn = "Win+N and Win+A open Windows' own panels";
  const st = { want: { altTab: x.settings.altTab, winKeys: x.settings.winKeys }, page: x.page.ready ? 'ready' : 'down' };
  const h = x.hook;
  let hold = null;                     // expected, and says so
  let fault = null;                    // not expected: the hook is refused, the exe stale, the sidecar gone
  if (x.test) hold = 'test mode: a test run never installs a keyboard hook';
  else if (!x.live) hold = x.releasedWhy ? `Mantle put Windows back (${x.releasedWhy})` : 'Mantle has not taken over the shell yet';
  else if (x.hookErr) fault = x.hookErr;
  else if (h && h.installed === false) fault = h.reason || 'the sidecar did not install its keyboard hook, and gave no reason';
  const why = hold || fault;
  // The sidecar answered (and nothing is in flight) without turning on what it was asked for.
  const answered = !!h && !x.applying;
  let altBad = false;
  let keysBad = false;

  if (!x.settings.altTab) { st.altTab = false; st.reason = `${own}: Mantle's switcher is turned off in the tray menu`; }
  else if (why) { st.altTab = false; st.reason = `${own}: ${why}`; altBad = !!fault; }
  else if (x.resting) { st.altTab = false; st.reason = `${own} while Mantle rests (${x.resting}); Mantle's switcher is back when it exits`; }
  else if (!x.page.ready) {
    st.altTab = false;
    st.reason = `${own}: ${x.page.reason}, and Mantle will not switch windows blind`;
    altBad = !!x.page.failed;
  } else if (h && h.altTab === true && h.installed) {
    st.altTab = true;
    st.reason = h.tracking === false
      ? "Alt+Tab opens Mantle's switcher (in Windows' stacking order: the most-recently-used watch did not start)"
      : "Alt+Tab opens Mantle's switcher";
  } else if (x.pendingApply) { st.altTab = false; st.reason = `${own} until the Alt+Tab on screen ends`; }
  else if (answered) {
    st.altTab = false;
    st.reason = `${own}: the sidecar answered without turning Mantle's Alt+Tab on${h.reason ? ` (${h.reason})` : ''}`;
    altBad = true;
  } else { st.altTab = false; st.reason = `${own}: the sidecar has not confirmed the Alt+Tab hook yet`; }

  if (!x.settings.winKeys) { st.winKeys = false; st.winKeysReason = `${keysOwn}: turned off in the tray menu`; }
  else if (why) { st.winKeys = false; st.winKeysReason = `${keysOwn}: ${why}`; keysBad = !!fault; }
  else if (h && h.winKeys === true && h.installed) { st.winKeys = true; st.winKeysReason = "Win+N opens Mantle's notifications, Win+A its quick settings"; }
  else if (answered && !x.pendingApply) {
    st.winKeys = false;
    st.winKeysReason = `${keysOwn}: the sidecar answered without turning them on${h.reason ? ` (${h.reason})` : ''}`;
    keysBad = true;
  } else { st.winKeys = false; st.winKeysReason = `${keysOwn}: the sidecar has not confirmed the hook yet`; }

  const bad = [];
  if (altBad) bad.push(st.reason);
  // One cause is said once: a stale exe or a dead sidecar breaks both the same way.
  if (keysBad && !(altBad && fault)) bad.push(st.winKeysReason);
  else if (keysBad) bad.push('Win+N and Win+A too');
  st.broken = bad.length ? bad.join('; ') : null;
  if (x.settingsNote) st.reason += `; ${x.settingsNote}`;
  return st;
}

function publish() {
  if (!S.started) return;
  S.ctx.state.set('switcher', computeState());
}

/* ---- sessions ------------------------------------------------------------------------------------ */

function normItem(it) {
  return {
    hwnd: String(it && it.hwnd),
    title: String((it && it.title) || ''),
    pid: Number(it && it.pid) || 0,
    minimized: !!(it && it.minimized),
    hung: !!(it && it.hung),
  };
}

/** Icons main already has: the bar's pinned list (per window) and the windows push. */
function iconsNow(list) {
  const byHwnd = new Map();
  let pinned = null;
  try { pinned = S.ctx.pinned ? S.ctx.pinned() : null; } catch (_) { pinned = null; }
  for (const item of (pinned && Array.isArray(pinned.items)) ? pinned.items : []) {
    for (const w of Array.isArray(item && item.windows) ? item.windows : []) {
      byHwnd.set(String(w.hwnd), item.icon ? { icon: item.icon } : { icon: null, reason: item.iconReason || null });
    }
  }
  const wins = new Map();
  try { for (const w of (S.ctx.windows ? S.ctx.windows() : []) || []) wins.set(String(w.hwnd), w); } catch (_) { /* none */ }
  const later = [];
  for (const it of list) {
    const hit = byHwnd.get(it.hwnd);
    const w = wins.get(it.hwnd);
    if (hit && hit.icon) { it.icon = hit.icon; continue; }
    if (w && w.icon) { it.icon = w.icon; continue; }
    if (w && w.exe && S.ctx.iconFor) { later.push({ hwnd: it.hwnd, exe: w.exe }); continue; }
    it.icon = null;
    it.iconReason = (hit && hit.reason) || 'no icon: Mantle has no program path for this window yet';
  }
  return later;
}

/**
 * One Alt+Tab from the sidecar, or a REHEARSAL of one (`rehearsal` names it: the warm-up, the
 * dry run): drawn and measured exactly the same, parked, but never revealed, never given the grid
 * and never holding a real one back (applyHook and a real `open` both push it aside).
 */
function onOpen(m, rehearsal) {
  const recv = now();
  if (S.sess) endVisual(S.sess, rehearsal ? `the ${rehearsal} started` : 'a new Alt+Tab started before the last one ended');
  hideNotice('an Alt+Tab started');
  const list = Array.isArray(m.list) ? m.list.map(normItem) : [];
  const prim = primaryPhys();
  const mon = rectOf(m.mon) || prim.mon;
  const work = rectOf(m.work) || mon;
  const scale = scaleFor(mon);
  const lay = Layout.layout(list.length, work.w / scale, work.h / scale);
  const w = Math.round(lay.w * scale);
  const h = Math.round(lay.h * scale);
  const sess = {
    seq: Number(m.seq) || 0,
    keyAt: Number(m.keyAt) || 0,
    keyMs: Number(m.ms) || 0,
    tracking: m.tracking !== false,
    recv,
    list,
    sel: Number.isInteger(m.sel) ? m.sel : -1,
    lay,
    scale,
    mon,
    rect: { x: Math.round(work.x + (work.w - w) / 2), y: Math.round(work.y + (work.h - h) / 2), w, h },
    park: parkSpot(mon, w, h, displaysPhys()),
    painted: null,
    due: false,
    shown: null,
    backdropMs: null,
    backdropErr: null,
    thumbs: null,
    timers: [],
    rehearsal: rehearsal || null,
  };
  S.sess = sess;
  const at = (ms) => (sess.keyAt ? r1(ms - sess.keyAt) : null);
  sess.toMain = at(recv);
  if (!alive() || !S.page.ready || (S.ctx.test && !sess.rehearsal)) {
    // Nothing to draw with. The sidecar still switches on Alt-up; applyHook normally hands
    // Alt+Tab back to Windows before this can happen at all.
    sess.undrawn = !alive() ? 'there is no switcher window' : S.page.reason || 'test mode';
    return;
  }
  // A new size makes the first frame late (see presize), so the log says when it happened.
  sess.resized = !(S.size && S.size.w === w && S.size.h === h);
  const placed = sizeParked(mon, sess.park, w, h);
  if (!placed.ok) sess.undrawn = `the switcher window could not be sized (${placed.how})`;
  S.target = { mon, work };
  const later = iconsNow(list);
  send('switcher.session', {
    seq: sess.seq, sel: sess.sel, current: Number.isInteger(m.current) ? m.current : -1,
    backwards: !!m.backwards, tracking: sess.tracking, list, lay,
  });
  // The arrow keys move by rows, and only main knows how wide a row is.
  if (lay.cols > 0 && !sess.rehearsal) {
    S.ctx.sidecar.call('hotkey', { op: 'grid', seq: sess.seq, cols: lay.cols }, 1000)
      .catch((err) => log(`#${sess.seq}: the arrow keys stay left/right only (the grid could not be sent: ${err.message})`));
  }
  if (later.length) resolveIcons(sess, later);
  captureBackdrop(sess);
  const since = sess.keyAt ? recv - sess.keyAt : sess.keyMs;
  sess.timers.push(setTimeout(() => { sess.due = true; maybeReveal(sess); }, Math.max(0, SHOW_DELAY_MS - since)));
  sess.timers.push(setTimeout(() => {
    if (S.sess === sess && !sess.painted) log(`#${sess.seq}: the page has not drawn this Alt+Tab after ${PAINT_LATE_MS} ms; letting go of Alt still switches (the sidecar does it)`);
  }, PAINT_LATE_MS));
}

/**
 * Size the window at a parking spot beside `mon`. A different monitor from last time can have a
 * different scale, and arriving beside it makes Windows resize the window for the new DPI
 * (WM_DPICHANGED) inside that first SetWindowPos. It is on the new DPI now, so the same call again
 * sticks.
 */
function sizeParked(mon, park, w, h) {
  let placed = place(park.x, park.y, w, h, false);
  const monKey = `${mon.x},${mon.y},${mon.w},${mon.h}`;
  if (placed.ok && S.monKey !== monKey) {
    placed = place(park.x, park.y, w, h, false);
    S.monKey = monKey;
  }
  return placed;
}

/*
 * The page's first frame after the window changes size comes at least a frame late, while
 * Chromium waits for a frame at the new size (dry run, 2026-09-23, same run: first frame at 12-28
 * ms against under 1 ms, open -> drawn median 32 ms against 25 ms; busier runs in which every
 * session changed size had medians of 62-81 ms). So while no Alt+Tab is open the parked window is
 * kept at the size the NEXT one will most likely need: as many tiles as the bar's window list has
 * (the same filter as the sidecar's Alt+Tab list), on the monitor of the last Alt+Tab. A wrong
 * guess costs exactly what not guessing costs.
 */
function presize(n) {
  if (!alive() || !S.page.ready || S.sess || S.notice || !(n >= 0)) return null;
  const t = S.target || primaryPhys();
  const scale = scaleFor(t.mon);
  const lay = Layout.layout(n, t.work.w / scale, t.work.h / scale);
  const w = Math.round(lay.w * scale);
  const h = Math.round(lay.h * scale);
  if (S.size && S.size.w === w && S.size.h === h) return null;
  const r = sizeParked(t.mon, parkSpot(t.mon, w, h, displaysPhys()), w, h);
  if (!r.ok && S.presizeErr !== r.how) log(`the switcher window could not be sized ahead of the next Alt+Tab: ${r.how}`);
  S.presizeErr = r.ok ? null : r.how;
  return r;
}

function presizeTick() {
  // A test run never shows the window (the dry run sizes it itself), and with Alt+Tab switched off
  // in the tray there is no next one: either way there is nothing to keep ready.
  if (S.stopped || S.ctx.test || !S.settings.altTab) return;
  let list = null;
  try { list = S.ctx.windows ? S.ctx.windows() : null; } catch (_) { list = null; }
  if (Array.isArray(list)) presize(list.length);
}

async function resolveIcons(sess, later) {
  const icons = {};
  await Promise.all(later.map(async ({ hwnd, exe }) => {
    try {
      const r = await S.ctx.iconFor([exe]);
      icons[hwnd] = r && r.icon ? { icon: r.icon } : { icon: null, reason: (r && r.reason) || 'no icon' };
    } catch (err) {
      icons[hwnd] = { icon: null, reason: `no icon: ${err.message}` };
    }
  }));
  if (S.sess === sess) send('switcher.icons', { seq: sess.seq, icons });
}

async function captureBackdrop(sess) {
  const m = sess.lay.margin * sess.scale;
  const o = OVERSCAN * sess.scale;
  let x = Math.round(sess.rect.x + m - o);
  let y = Math.round(sess.rect.y + m - o);
  let r = Math.round(sess.rect.x + sess.rect.w - m + o);
  let b = Math.round(sess.rect.y + sess.rect.h - m + o);
  // Inside the monitor, always: a rectangle past the edge is refused by the capture outright.
  x = Math.max(x, sess.mon.x); y = Math.max(y, sess.mon.y);
  r = Math.min(r, sess.mon.x + sess.mon.w); b = Math.min(b, sess.mon.y + sess.mon.h);
  const t0 = now();
  try {
    const res = await S.ctx.sidecar.call('backdrop', { x, y, w: r - x, h: b - y, scale: BACKDROP_SCALE }, 2000);
    if (!res || !res.png) throw new Error('the sidecar answered "backdrop" without a png');
    sess.backdropMs = r1(now() - t0);
    if (S.sess === sess) send('switcher.backdrop', { seq: sess.seq, png: res.png, w: res.w, h: res.h, ms: sess.backdropMs, shown: !!sess.shown });
  } catch (err) {
    sess.backdropErr = err && err.message ? err.message : String(err);
    if (S.sess === sess) send('switcher.backdrop', { seq: sess.seq, png: null, reason: sess.backdropErr });
  }
}

/** On screen once it is due AND the page has drawn it: never an empty or stale panel. */
function maybeReveal(sess) {
  if (S.sess !== sess || sess.shown || !sess.due || !sess.painted || !alive()) return;
  if (sess.rehearsal) { sess.wouldShow = now(); return; }   // a rehearsal stops one step short
  if (S.ctx.test) return;                            // and a test run never comes on screen at all
  const r = place(sess.rect.x, sess.rect.y, 0, 0, true);
  if (!r.ok) { log(`#${sess.seq}: the switcher could not come on screen (${r.how}); letting go of Alt still switches`); return; }
  sess.shown = now();
  armAltGuard(sess);
}

/*
 * The stuck-overlay guard. The sidecar ends every session itself (its own 40 ms watchdog on Alt),
 * but if its word never reaches us (a sidecar that hung or died mid-session) the overlay would sit
 * on screen for good. So while one is shown, main looks at Alt too, and takes the overlay down
 * once Alt has been up for ALT_UP_GRACE_MS with no commit or cancel. It only DRAWS: the switch
 * was, and stays, the sidecar's.
 */
function armAltGuard(sess) {
  const n = native();
  if (!n) return;
  let upSince = null;
  const tick = () => {
    if (S.sess !== sess) return;
    let down = true;
    try { down = (n.asyncKey(VK_MENU) & 0x8000) !== 0; } catch (_) { return; }
    if (down) upSince = null;
    else if (upSince === null) upSince = Date.now();
    else if (Date.now() - upSince >= ALT_UP_GRACE_MS) {
      log(`#${sess.seq}: Alt has been up for ${ALT_UP_GRACE_MS} ms and the sidecar never said this Alt+Tab ended, so Mantle took the overlay down (nothing was switched from here)`);
      endVisual(sess, 'the sidecar went quiet');
      return;
    }
    const t = setTimeout(tick, ALT_POLL_MS);
    sess.timers.push(t);
  };
  sess.timers.push(setTimeout(tick, ALT_POLL_MS));
}

/** Take the session off the screen. Thumbnails FIRST (thumbs.js: THE LEAK). */
function endVisual(sess, why) {
  for (const t of sess.timers) clearTimeout(t);
  sess.timers = [];
  // Once, and only while it is still THE session: the previews, the window's place and the page
  // belong to whichever session is current, and a late call for one already pushed aside (a
  // rehearsal a real Alt+Tab replaced) must not take them from the real one.
  if (sess.ended || S.sess !== sess) { if (!sess.ended) sess.ended = now(); return; }
  S.sess = null;
  if (S.tset) S.tset.clear(`the Alt+Tab ended (${why})`);
  if (alive()) {
    // Only if it moved: a quick tap never left the parking spot it was sized in.
    if (!S.at || S.at.x !== sess.park.x || S.at.y !== sess.park.y) {
      const r = place(sess.park.x, sess.park.y, 0, 0, false);
      if (!r.ok) log(`#${sess.seq}: the switcher window could not be parked (${why}): ${r.how}`);
    }
    send('switcher.end', { seq: sess.seq, why });
  }
  sess.ended = now();
  if (S.pendingApply) applyHook(S.pendingApply);
}

function timingWords(sess) {
  const k = (t) => (sess.keyAt && t ? `${r1(t - sess.keyAt)} ms` : '?');
  const parts = [`key->open ${r1(sess.keyMs)} ms`, `->main ${sess.toMain === null ? '?' : `${sess.toMain} ms`}`];
  if (sess.undrawn) parts.push(`not drawn: ${sess.undrawn}`);
  else {
    parts.push(sess.painted ? `->drawn ${k(sess.painted.at)} (page ${r1(sess.painted.ms)} ms, first frame at ${r1(sess.painted.raf1)}${sess.resized ? ', the window changed size' : ''})` : 'never drawn');
    parts.push(sess.shown ? `->on screen ${k(sess.shown)}` : `never on screen (a tap: under ${SHOW_DELAY_MS} ms)`);
    // How long Alt+Tab was held: the number SHOW_DELAY_MS should be tuned against.
    if (sess.commit) parts.push(`->let go ${k(sess.commit.at)}`);
    parts.push(sess.backdropErr ? `no backdrop: ${sess.backdropErr}` : (sess.backdropMs !== null ? `backdrop ${sess.backdropMs} ms` : 'backdrop not back yet'));
  }
  parts.push(`${sess.list.length} window${sess.list.length === 1 ? '' : 's'}, ${sess.tracking ? 'most recently used first' : "Windows' stacking order"}`);
  return parts.join(', ');
}

function onCommit(m) {
  const sess = S.sess && S.sess.seq === m.seq ? S.sess : null;
  if (!sess) return;
  sess.commit = { at: now(), sel: m.sel, hwnd: String(m.hwnd), via: m.via };
  endVisual(sess, `switching (${m.via})`);
  S.acting = sess;
}

function onCancel(m) {
  const sess = S.sess && S.sess.seq === m.seq ? S.sess : null;
  if (!sess) { log(`#${m.seq}: closed without a switch (${m.why})`); return; }
  endVisual(sess, m.why || 'cancelled');
  log(`#${m.seq}: closed without a switch (${m.why}) | ${timingWords(sess)}`);
  S.last = { seq: m.seq, ok: null, why: m.why, timing: timingWords(sess) };
}

function onActivated(m) {
  const sess = S.acting && S.acting.seq === m.seq ? S.acting : null;
  if (sess) S.acting = null;
  const title = m.title ? `"${String(m.title).slice(0, 80)}"` : `window ${m.hwnd}`;
  const words = m.ok
    ? `switched to ${title} (${m.via}, ${m.how}, ${m.ms} ms)`
    : `could NOT switch to ${title} (${m.via}, ${m.cause || 'no cause given'}): ${m.reason}`;
  log(`#${m.seq}: ${words}${sess ? ` | ${timingWords(sess)}` : ''}`);
  S.last = { seq: m.seq, ok: !!m.ok, how: m.how || null, via: m.via, reason: m.ok ? null : m.reason, timing: sess ? timingWords(sess) : null };
  // An empty list is not a failure: there was nothing to switch to, and nothing happened.
  if (!m.ok && m.cause !== 'none' && !(sess && sess.list.length === 0)) {
    const n = noticeWords(m.cause, nameFor(String(m.hwnd), m.title), m.reason);
    showNotice(n.title, n.text, sess && sess.mon);
  }
}

/** What Owen calls that window: the bar's name for a pinned app, else its title, shortened. */
function nameFor(hwnd, title) {
  try {
    const pinned = S.ctx.pinned ? S.ctx.pinned() : null;
    for (const item of (pinned && Array.isArray(pinned.items)) ? pinned.items : []) {
      if (!item || item.kind !== 'pinned' || !item.name) continue;
      if ((Array.isArray(item.windows) ? item.windows : []).some((w) => String(w && w.hwnd) === hwnd)) return String(item.name);
    }
  } catch (_) { /* the title will do */ }
  const t = String(title || '').trim();
  return t.length > 48 ? `${t.slice(0, 47)}…` : t;
}

/*
 * THE NOTICE LEADS WITH ONE PLAIN SENTENCE, what Owen would say about it himself. The machinery
 * (SetForegroundWindow, the focus ladder) is the small second line and the log line, where it is
 * still there for a screenshot of the notice to carry the diagnosis. PURE (lib/switcher.test.js).
 */
function noticeWords(cause, name, detail) {
  const who = name || 'That window';
  const whom = name || 'that window';
  const small = detail ? String(detail) : null;
  switch (cause) {
    case 'hung': return { title: `${who} isn't responding, so Windows wouldn't bring it to the front.`, text: small };
    case 'closed': return { title: `${who} closed before Mantle could switch to it.`, text: null };
    case 'refused': return { title: `Windows wouldn't bring ${whom} to the front.`, text: small };
    default: return { title: `Mantle couldn't switch to ${whom}.`, text: small || 'The sidecar did not say why.' };
  }
}

function onEvent(m) {
  if (!m || typeof m.op !== 'string') return;
  try {
    switch (m.op) {
      case 'open': onOpen(m); break;
      case 'move':
        if (S.sess && S.sess.seq === m.seq) {
          S.sess.sel = m.sel;
          send('switcher.move', { seq: m.seq, sel: m.sel, key: m.key });
        }
        break;
      case 'commit': onCommit(m); break;
      case 'cancel': onCancel(m); break;
      case 'activated': onActivated(m); break;
      case 'refused': log(`#${m.seq}: a click was not used: ${m.reason}`); break;
      case 'winkey':
        // Phase 2: the letter was swallowed and Windows never saw a solo Win; the bar opens its
        // own panel (ui/bar/bar.js listens for this). The bar page is the one that can say if it
        // could not.
        log(`Win+${String(m.key).toUpperCase()}: asking the bar to open its ${m.key === 'n' ? 'notification centre' : 'quick settings'}`);
        if (S.ctx.onWinKey) S.ctx.onWinKey(m.key);
        break;
      case 'hook':
        S.hook = m;
        publish();
        break;
      default: break;
    }
  } catch (err) {
    log(`the "${m.op}" event threw: ${err && err.stack ? err.stack : err}`);
  }
}

/* ---- the notice ---------------------------------------------------------------------------------- */

function showNotice(title, text, onMon) {
  if (!alive() || !S.page.ready || S.ctx.test || S.sess) { log(`notice not shown (${!alive() ? 'no window' : S.sess ? 'an Alt+Tab is open' : S.page.reason || 'test mode'}): ${title}: ${text}`); return; }
  hideNotice('a newer notice');
  const prim = primaryPhys();
  const mon = onMon || prim.mon;
  const scale = scaleFor(mon);
  const n = Layout.notice();
  const w = Math.round(n.w * scale);
  const h = Math.round(n.h * scale);
  const id = ++S.noticeSeq;
  const note = {
    id,
    rect: { x: Math.round(mon.x + (mon.w - w) / 2), y: Math.round(mon.y + mon.h - h - 120 * scale), w, h },
    park: parkSpot(mon, w, h, displaysPhys()),
    painted: false,
    shown: false,
    timers: [],
  };
  S.notice = note;
  place(note.park.x, note.park.y, w, h, false);
  send('switcher.notice', { id, title, text, lay: n });
  note.timers.push(setTimeout(() => hideNotice('it has been up long enough'), NOTICE_MS));
}

function hideNotice(why) {
  const note = S.notice;
  if (!note) return;
  S.notice = null;
  for (const t of note.timers) clearTimeout(t);
  if (alive()) {
    if (note.shown) place(note.park.x, note.park.y, 0, 0, false);
    send('switcher.notice.end', { id: note.id, why });
  }
}

/* ---- commands the page calls ------------------------------------------------------------------- */

const COMMANDS = {
  /** The page has loaded and is listening. */
  'switcher.ready': async () => {
    if (!S.page.ready) {
      log(`the switcher page is ready (${Math.round(process.uptime() * 1000)} ms after Mantle started)${S.ctx.test ? '; test mode: it is never shown and Alt+Tab stays Windows\' own' : ''}`);
      pageUp('the switcher page is ready');
      // Every page load starts cold (a reload after a crash too), so each one is warmed. A test
      // run's window is never shown, so there only the dry run warms it, as part of what it measures.
      if (!S.ctx.test) scheduleWarmUp(S.loads++ ? 'the page reloaded' : 'the page loaded');
      if (S.ctx.test && process.env.MANTLE_SWITCHER_DRYRUN && !S.dryDone) {
        S.dryDone = true;
        dryRun(Math.max(1, Math.min(20, Number(process.env.MANTLE_SWITCHER_DRYRUN) || 5)))
          .catch((err) => log(`the dry run threw: ${err && err.stack ? err.stack : err}`));
      }
    }
    return { ok: true };
  },

  /**
   * {seq, boxes:[{hwnd,x,y,w,h}], dpr, vw, vh, ms} once the page has drawn a session (and again
   * after a scroll or a resize), or {notice:id, vw, vh}. The previews go in here, while the window
   * is still parked; the reveal waits for this.
   */
  'switcher.painted': async (a) => {
    if (a && a.notice) {
      const note = S.notice;
      if (!note || note.id !== a.notice) return { ok: true, stale: true };
      note.painted = true;
      if (!note.shown) {
        const r = place(note.rect.x, note.rect.y, 0, 0, true);
        if (r.ok) note.shown = true;
        else log(`the notice could not come on screen: ${r.how}`);
      }
      return { ok: true };
    }
    const sess = S.sess;
    if (!sess || !a || a.seq !== sess.seq) return { ok: true, stale: true };
    const lay = sess.lay;
    // The page answers for the window size it has; one from before this session's resize would
    // put the pictures in the wrong places.
    if (Math.abs(Number(a.vw) - lay.w) > 1.5 || Math.abs(Number(a.vh) - lay.h) > 1.5) {
      return { ok: true, waiting: `the page is ${a.vw}x${a.vh}, the window is going to ${lay.w}x${lay.h}` };
    }
    if (!sess.painted) sess.painted = { at: now(), ms: Number(a.ms) || 0, built: Number(a.built) || 0, raf1: Number(a.raf1) || 0, vis: String(a.vis || '?'), why: String(a.why || '?') };
    const origin = S.at || sess.park;
    const res = S.tset.sync(S.hwnd, Array.isArray(a.boxes) ? a.boxes : [], Number(a.dpr), { x: origin.x, y: origin.y });
    sess.thumbs = res;
    send('switcher.thumbs', { seq: sess.seq, ok: res.ok, reason: res.reason || null, thumbs: res.thumbs || [] });
    maybeReveal(sess);
    return { ok: true, thumbs: (res.thumbs || []).length };
  },

  /** A click on a tile: {seq, index}. The sidecar switches, exactly as for Alt-up. */
  'switcher.pick': async (a) => {
    const seq = Number(a && a.seq);
    const index = Number(a && a.index);
    if (!Number.isInteger(seq) || !Number.isInteger(index) || index < 0) return { ok: false, reason: 'switcher.pick needs the seq and index of a tile' };
    // THIS process received the click, so it may hand its right to set the foreground window
    // on to the sidecar, which is the process that switches.
    const n = native();
    const pid = S.ctx.sidecar.info && S.ctx.sidecar.info.pid;
    let granted = false;
    if (n && pid) { try { granted = n.allowSetForeground(Number(pid)) !== 0; } catch (_) { granted = false; } }
    try {
      await S.ctx.sidecar.call('hotkey', { op: 'pick', seq, index }, 1500);
      return { ok: true, granted };
    } catch (err) {
      return { ok: false, reason: `the click could not reach the sidecar: ${err.message}` };
    }
  },

  'switcher.dismiss': async () => { hideNotice('it was clicked'); return { ok: true }; },

  /** {altTab?, winKeys?}: the off switches (the tray menu uses setSettings directly). */
  'switcher.settings': async (a) => {
    setSettings({ altTab: a && a.altTab, winKeys: a && a.winKeys }, 'a Mantle page');
    return Object.assign({ ok: true }, S.ctx.state.get().switcher);
  },

  /** Everything this file knows, for a person reading a log or a test. */
  'switcher.status': async () => ({
    ok: true,
    settings: Object.assign({}, S.settings),
    page: Object.assign({}, S.page),
    hook: S.hook,
    hookErr: S.hookErr,
    live: S.live,
    open: S.sess ? S.sess.seq : null,
    last: S.last,
    native: S.native ? 'koffi user32' : (S.nativeReason || 'not bound yet'),
    thumbs: S.tset ? S.tset.count() : 0,
  }),
};

/* ---- the warm-up ---------------------------------------------------------------------------------- */

/*
 * THE FIRST ALT+TAB PAID FOR EVERYTHING DONE FOR THE FIRST TIME: the page's first real drawing
 * (layout, text, icons, the backdrop canvas and its blur, where the GPU compiles each shader the
 * first time something needs it), the DWM thumbnail calls, and the sidecar's list and capture code
 * (.NET compiles each method on its first call). The dry run measured the first session at 40-320
 * ms from open to drawn, and the ones after it at ~25 ms (2026-09-23). So once the page is up, ONE
 * REHEARSAL pays that instead: the real window list, drawn in the parked window with its previews
 * and its backdrop, then ended. It never comes on screen, never touches the keyboard hook (the
 * list is the sidecar's read-only form), never focuses or switches anything, and a real Alt+Tab
 * that arrives during it simply replaces it (onOpen).
 */
const WARM_SEQ = 800000;                 // a rehearsal's seq: the sidecar's own never get this high
const WARM_WAIT_MS = 3000;               // for the page to draw it and the backdrop to land
const WARM_SETTLE_MS = 150;              // frames for the backdrop to be decoded, blurred and composed

async function warmUp(why) {
  const t0 = now();
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // Nothing is drawn into a hidden window; live mode shows it, parked, at ready-to-show.
  for (let i = 0; i < 40 && alive() && !S.win.isVisible(); i++) await wait(100);
  for (let i = 0; i < 120 && S.ctx.sidecar.blockedReason(); i++) await wait(250);
  if (!alive() || !S.page.ready || S.stopped) return { ok: false, why: S.page.reason || 'there is no switcher window' };
  if (!S.win.isVisible()) return { ok: false, why: 'the window is not shown, so nothing would be drawn' };
  const blocked = S.ctx.sidecar.blockedReason();
  if (blocked) return { ok: false, why: `the sidecar cannot be asked (${blocked})` };
  if (S.sess || S.notice) return { ok: false, why: S.sess ? 'an Alt+Tab is open' : 'a notice is up' };
  const l0 = now();
  let r;
  try { r = await S.ctx.sidecar.call('hotkey', { op: 'list' }, 4000); } catch (err) { return { ok: false, why: `the window list could not be read: ${err.message}` }; }
  const listMs = r1(now() - l0);
  if (S.sess || S.notice || !alive() || !S.page.ready) return { ok: false, why: 'an Alt+Tab started first' };
  onOpen({ seq: WARM_SEQ, keyAt: now(), ms: 0, list: r.list, sel: r.sel, current: r.current, tracking: r.tracking, mon: r.mon, work: r.work }, 'warm-up');
  const sess = S.sess;
  if (!sess || sess.seq !== WARM_SEQ) return { ok: false, why: 'the rehearsal did not open' };
  const deadline = now() + WARM_WAIT_MS;
  while (S.sess === sess && now() < deadline && !(sess.painted && (sess.backdropMs !== null || sess.backdropErr))) await wait(20);
  if (S.sess === sess) await wait(WARM_SETTLE_MS);
  const replaced = S.sess !== sess;
  const p = sess.painted;
  const th = sess.thumbs && Array.isArray(sess.thumbs.thumbs) ? sess.thumbs.thumbs : [];
  const out = {
    ok: !!p && !replaced,
    why: replaced ? 'a real Alt+Tab replaced it' : p ? null : `the page did not draw it within ${WARM_WAIT_MS / 1000} s`,
    drawnMs: p ? r1(p.at - sess.keyAt) : null,
    firstFrame: p ? r1(p.raf1) : null,
    tiles: sess.list.length,
    previews: `${th.filter((t) => t.ok).length}/${th.length}`,
    backdrop: sess.backdropErr ? `failed: ${sess.backdropErr}` : sess.backdropMs !== null ? `${sess.backdropMs} ms` : 'not back',
    listMs,
  };
  endVisual(sess, 'the warm-up is done');
  out.totalMs = r1(now() - t0);
  return out;
}

function warmWords(w) {
  if (!w.ok && w.drawnMs === null) return `skipped: ${w.why}`;
  return `${w.tiles} tiles drawn ${w.drawnMs === null ? 'NEVER' : `in ${w.drawnMs} ms`} (first frame at ${w.firstFrame}), previews ${w.previews}, backdrop ${w.backdrop}, window list ${w.listMs} ms; ${w.totalMs} ms in all${w.why ? ` (${w.why})` : ''}`;
}

function scheduleWarmUp(why) {
  warmUp(why)
    .then((w) => log(`warm-up (${why}): ${warmWords(w)}`))
    .catch((err) => log(`the warm-up threw (${why}): ${err && err.stack ? err.stack : err}`));
}

/* ---- the dry run (test mode with MANTLE_SWITCHER_DRYRUN=<rounds>) ------------------------------- */

/*
 * Everything a real Alt+Tab does in THIS process except the last step, so the live path can be
 * measured with nobody's keyboard: the window is shown PARKED (off every screen, never activated),
 * each round is a real `hotkey {op:'list'}` (read-only) handed to onOpen as a rehearsal, as if a
 * Tab had gone down that instant, the page draws it, the DWM thumbnails are registered into the
 * parked window, and it ends like a real session. It NEVER comes on screen (maybeReveal stops at a
 * rehearsal) and nothing is switched (a test run's sidecar is passive). Rounds change the tile
 * count, padding the real list with tiles for handles that are no window (they must show why they
 * have no preview), so the per-session resize is exercised too. One log line per round, then a
 * summary. The timeline copies a live start: shown, one second, the warm-up, then the rounds after
 * MANTLE_SWITCHER_DRYRUN_SETTLE ms (6000 when unset). MANTLE_SWITCHER_WARMUP=0 leaves the warm-up
 * out, which is how its worth is measured.
 */
const DRY_SIZES = [0, 14, 1, 0, 14, 3, 0, 7];   // 0: the real list as it is

async function dryRun(rounds) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const raw = process.env.MANTLE_SWITCHER_DRYRUN_SETTLE;
  const settle = raw && Number.isFinite(Number(raw)) ? Math.max(0, Math.min(60000, Number(raw))) : 6000;
  const warm = process.env.MANTLE_SWITCHER_WARMUP !== '0';
  for (let i = 0; i < 60 && S.ctx.sidecar.blockedReason(); i++) await wait(500);
  const blocked = S.ctx.sidecar.blockedReason();
  if (blocked) { log(`dry run skipped: the sidecar cannot be asked (${blocked})`); return; }
  if (!alive()) { log('dry run skipped: the switcher window is gone'); return; }
  const fgOf = async () => { try { const f = await S.ctx.sidecar.call('foreground', {}, 1500); return f && f.hwnd ? String(f.hwnd) : '?'; } catch (_) { return '?'; } };
  const fgBefore = await fgOf();
  // A Mantle running live from a build older than this window would list it, visible, as a task
  // button on ITS bar for these seconds. Every build hides its own launcher, so borrow that title.
  const title = S.win.getTitle();
  try { S.win.setTitle('Mantle launcher'); } catch (_) { /* then an older live bar may show it for a moment */ }
  const spot = defaultPark();
  place(spot.x, spot.y, 0, 0, false);
  try { S.win.showInactive(); } catch (err) {
    try { S.win.setTitle(title); } catch (_) { /* it is never shown, so the title shows nowhere */ }
    log(`dry run skipped: the window would not show even parked (${err.message})`);
    return;
  }
  log(`dry run: ${rounds} rounds, ${warm ? 'after the warm-up' : 'WITHOUT the warm-up'}, starting ${settle / 1000} s after that; never on screen`);
  await wait(1000);                     // live, the window has been shown for a while by the first Alt+Tab
  if (warm) log(`dry run warm-up: ${warmWords(await warmUp('dry run'))}`);
  await wait(settle);
  const drawn = [];
  for (let i = 0; i < rounds && alive(); i++) {
    let r;
    const l0 = now();
    try { r = await S.ctx.sidecar.call('hotkey', { op: 'list' }, 4000); } catch (err) { log(`dry run ${i + 1}: hotkey list failed: ${err.message}`); continue; }
    // The sidecar's share of a real Alt+Tab is this same list; its FIRST call pays .NET's compile.
    const listMs = r1(now() - l0);
    const want = DRY_SIZES[i % DRY_SIZES.length];
    const list = (Array.isArray(r.list) ? r.list : []).slice(0, want || undefined);
    for (let j = list.length; j < want; j++) list.push({ hwnd: String(j + 1), title: `Dry run tile ${j + 1}: handle ${j + 1} is no window, so this tile has no preview`, pid: 0 });
    const sel = list.length ? Math.min(Math.max(0, Number(r.sel) || 0), list.length - 1) : -1;
    // Every other round the window is sized ahead, as presize does for a right guess; the rest
    // change size at open, as a wrong guess does.
    if (i % 2 === 0) presize(list.length);
    await wait(300);
    onOpen({ seq: 900000 + i, keyAt: now(), ms: 0, list, sel, current: r.current, tracking: r.tracking, mon: r.mon, work: r.work }, 'dry run');
    const sess = S.sess;
    if (!sess) continue;
    for (let t = 0; t < 40 && !sess.painted; t++) await wait(25);
    await wait(Math.max(0, SHOW_DELAY_MS + 20 - (now() - sess.recv)));   // let `due` pass as well
    let b = null;
    try { b = S.win.getBounds(); } catch (_) { b = null; }
    const th = sess.thumbs && Array.isArray(sess.thumbs.thumbs) ? sess.thumbs.thumbs : [];
    const why = {};
    for (const t of th) if (!t.ok) why[t.reason] = (why[t.reason] || 0) + 1;
    const p = sess.painted;
    const drawnMs = p ? r1(p.at - sess.keyAt) : null;
    if (drawnMs !== null) drawn.push({ ms: drawnMs, resized: !!sess.resized });
    log([
      `dry run ${i + 1}/${rounds}: ${sess.list.length} tiles (${sess.lay.cols}x${sess.lay.rows}, ${sess.lay.tileW} dip, ${sess.resized ? 'resized at open' : 'already that size'}), window list ${listMs} ms`,
      `open -> drawn ${drawnMs === null ? 'NEVER' : `${drawnMs} ms`} (page ${p ? `${r1(p.ms)} ms: drawn in ${r1(p.built)}, first frame ${r1(p.raf1)}, ${p.vis}, from ${p.why}` : '?'})`,
      `would be on screen at ${sess.wouldShow ? `${r1(sess.wouldShow - sess.keyAt)} ms` : 'NEVER'}`,
      `previews ${th.filter((t) => t.ok).length}/${th.length}${Object.keys(why).map((k) => ` [${why[k]}x ${k}]`).join('')}${sess.thumbs && sess.thumbs.reason ? ` (${sess.thumbs.reason})` : ''}`,
      `window ${sess.rect.w}x${sess.rect.h} px at ${JSON.stringify(S.at)}, Electron says ${b ? `${b.width}x${b.height} dip at ${b.x},${b.y}` : '?'} (scale ${sess.scale})`,
      `backdrop ${sess.backdropErr ? `FAILED: ${sess.backdropErr}` : `${sess.backdropMs} ms`}`,
    ].join('; '));
    endVisual(sess, 'dry run');
  }
  try { S.win.hide(); S.win.setTitle(title); } catch (_) { /* test mode: it was hidden before, and nothing drew into it since */ }
  const fgAfter = await fgOf();
  const stats = (xs) => {
    const v = xs.map((d) => d.ms).sort((a, b) => a - b);
    return v.length ? `median ${v[Math.floor(v.length / 2)]} ms, max ${v[v.length - 1]} ms over ${v.length}` : 'none';
  };
  log(`dry run done (${warm ? 'warm-up' : 'no warm-up'}, settle ${settle} ms): open -> drawn ${drawn.length ? `FIRST ${drawn[0].ms} ms; the rest ${stats(drawn.slice(1))}; at the size it already had: ${stats(drawn.filter((d) => !d.resized))}; changing size at open: ${stats(drawn.filter((d) => d.resized))}` : 'NEVER'}; previews left registered: ${S.tset ? S.tset.count() : 'no set'}; the foreground window was ${fgBefore} before and ${fgAfter} after${fgBefore === fgAfter ? ' (unchanged)' : ' (CHANGED: by the dry run, or by whoever is at the keyboard)'}`);
}

/* ---- main.js's side ------------------------------------------------------------------------------ */

/**
 * Called once from app.whenReady.
 *   ctx: { root, test, state, sidecar, commands, pinned(), windows(), iconFor(candidates), onWinKey(key) }
 */
function start(ctx) {
  if (S.started) return;
  S.started = true;
  S.ctx = ctx;
  S.settingsFile = path.join(app.getPath('userData'), 'switcher.json');
  loadSettings();
  Object.assign(ctx.commands, COMMANDS);
  ctx.sidecar.on('switcher', onEvent);
  ctx.sidecar.on('status', ({ status, reason }) => {
    if (status === 'ok') return;
    // The hook died with the sidecar's process, so Alt+Tab is already Windows' own again.
    S.hook = null;
    S.hookErr = `the sidecar is not running (${reason})`;
    if (S.sess) endVisual(S.sess, 'the sidecar stopped');
    S.acting = null;
    publish();
  });
  try {
    createWindow();
  } catch (err) {
    S.page = { ready: false, reason: `the switcher window could not be created (${err.message})`, failed: true };
    log(S.page.reason);
  }
  S.presizeTimer = setInterval(presizeTick, PRESIZE_MS);
  if (S.presizeTimer.unref) S.presizeTimer.unref();
  publish();
}

/** main.js applyLive, after the Win key hook: the sidecar is up and Mantle owns the shell. */
async function applyLive(why) {
  if (!S.started || S.ctx.test) return;
  S.live = true;
  S.releasedWhy = null;
  await applyHook(why || 'Mantle took over the shell');
}

/** main.js markRestored: the restore path already sent hotkey {altTab:false, winKeys:false}. */
function released(why) {
  if (!S.started) return;
  S.live = false;
  S.releasedWhy = why;
  S.hook = null;
  S.hookErr = null;
  if (S.sess) endVisual(S.sess, 'Mantle put Windows back');
  hideNotice('Mantle put Windows back');
  publish();
}

/** main.js shutdown: nothing may stay drawn, nothing may keep ticking. */
function stop(why) {
  if (!S.started || S.stopped) return;
  S.stopped = true;
  if (S.presizeTimer) { clearInterval(S.presizeTimer); S.presizeTimer = null; }
  if (S.sess) endVisual(S.sess, why);
  hideNotice(why);
  if (S.tset) S.tset.clear(why);
}

/*
 * Resting while a game runs (lane memfix, 2026-09-26; main.js restMantle). rest('VALORANT runs'):
 * the switcher window is DESTROYED (its renderer process goes), the 500 ms presize tick stops, and
 * Alt+Tab goes back to Windows (applyHook asks for altTab only when the page is ready). Win+N / Win+A
 * stay as they are: they open the bar's panels, and the bar stays. rest(null): the window is made
 * again exactly as at start, and its page coming up takes Alt+Tab back (pageUp -> applyHook).
 * Returns the number of windows closed (rest) or made (wake).
 */
function rest(why) {
  if (!S.started || S.stopped) return 0;
  if (why) {
    const first = !S.resting;
    S.resting = why;
    if (!first) { publish(); return 0; }
    if (S.sess) endVisual(S.sess, `resting while ${why}`);
    hideNotice(`resting while ${why}`);
    if (S.presizeTimer) { clearInterval(S.presizeTimer); S.presizeTimer = null; }
    const had = alive();
    if (had) { try { S.win.destroy(); } catch (_) { /* gone */ } }
    S.win = null; S.hwnd = 0; S.size = null;
    S.page = { ready: false, reason: `resting while ${why}`, failed: false };
    applyHook(`resting while ${why}`);
    return had ? 1 : 0;
  }
  if (!S.resting) return 0;
  S.resting = null;
  S.page = { ready: false, reason: 'the switcher page is loading again after the game', failed: false };
  let made = 0;
  try { createWindow(); made = 1; } catch (err) {
    S.page = { ready: false, reason: `the switcher window could not be made again after the game (${err.message})`, failed: true };
    log(S.page.reason);
  }
  if (!S.presizeTimer) {
    S.presizeTimer = setInterval(presizeTick, PRESIZE_MS);
    if (S.presizeTimer.unref) S.presizeTimer.unref();
  }
  publish();
  return made;
}

/** The tray menu's rows: the off switches, each with its state line under it. */
function trayItems() {
  if (!S.started) return [];
  const st = S.ctx.state.get().switcher || computeState();
  const line = (s) => {
    const t = String(s || '');
    return `      ${t.length > 110 ? `${t.slice(0, 107)}...` : t}`;
  };
  return [
    {
      label: "Alt+Tab opens Mantle's switcher",
      type: 'checkbox',
      checked: !!S.settings.altTab,
      click: (item) => setSettings({ altTab: !!item.checked }, 'the tray menu'),
    },
    { label: line(st.reason), enabled: false },
    {
      label: "Win+N / Win+A open Mantle's panels",
      type: 'checkbox',
      checked: !!S.settings.winKeys,
      click: (item) => setSettings({ winKeys: !!item.checked }, 'the tray menu'),
    },
    { label: line(st.winKeysReason), enabled: false },
  ];
}

/** The switcher's window, for main's memory log (it names each page's renderer). */
function overlayWindow() { return alive() ? S.win : null; }

module.exports = { start, applyLive, released, stop, rest, trayItems, overlayWindow, parkSpot, stateWords, noticeWords, TITLE, SHOW_DELAY_MS };
