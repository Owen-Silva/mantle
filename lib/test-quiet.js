'use strict';
/*
 * lib/test-quiet.js -- A TEST INSTANCE PUTS NOTHING ON THE USER'S SCREEN (lane r8-quiet, 2026-10-01).
 *
 * WHY. The user: "when your testing things the testing mantle thing comes up on my screen all the time
 * can you fix that?". Every --test instance (the lanes' probes, the ship's e2e, the top bar self-tests,
 * the screenshot e2e) ran on the real desktop: its framed test bar and launcher, its pop-ups and its
 * overlays came up over whatever they were doing, some took the keyboard, some sat in their bar's app list.
 *
 * WHAT. In a --test run (and only there) every BrowserWindow is made quiet, ONE place for all of them:
 *   - nothing drawn: layered alpha 0 (DWM applies it; Chromium still renders the page, so capturePage,
 *     CDP and executeJavaScript work as before);
 *   - never takes a click: click-through (WS_EX_TRANSPARENT);
 *   - never takes the keyboard: not activatable (focusable:false = WS_EX_NOACTIVATE), show() is
 *     showInactive(), focus() does nothing;
 *   - in no app list: skipTaskbar + WS_EX_TOOLWINDOW (the live bar and the switcher skip tool windows);
 *   - the tray icon is a stand-in that keeps the menu but never draws an icon.
 * The window's OWN code still reads back what it asked for (getOpacity, isFocusable), so feature
 * logic runs unchanged; only the native window stays quiet.
 *
 * HOW. install() runs first thing in main.js. Live, a plain `electron .`, or MANTLE_TEST_VISIBLE=1:
 * it returns false before touching anything, so require('electron') and every window option are
 * exactly what they were (lib/test-quiet.test.js proves it). In a --test run it wraps
 * require('electron') so that BrowserWindow is a constructor proxy (options rewritten, the window
 * quietened) and Tray is the stand-in; a 'browser-window-created' backstop catches any window made
 * another way.
 *
 * OPT OUT. MANTLE_TEST_VISIBLE=1: the few checks that need a REAL on-screen window (WindowFromPoint,
 * z-order, focus, a pixel on the monitor) run the old way, and the test scripts start those only while
 * the user is away from the keyboard (lanes/bin/uislot.sh, the ship's electron.sh).
 *
 * MEASURED (2026-10-01): see lib/test-quiet.test.js (node + an Electron child that checks the native
 * styles, the layered alpha, capturePage, the foreground and the desktop's own pixels).
 */
const Module = require('module');

const WS_EX_TRANSPARENT = 0x20;
const WS_EX_TOOLWINDOW = 0x80;
const WS_EX_LAYERED = 0x80000;
const WS_EX_NOACTIVATE = 0x8000000;
const GWL_EXSTYLE = -20;

let installed = false;
let nat = null;          // user32 through koffi, bound on first use
let natReason = null;
const quieted = new WeakSet();
let toolSaid = false;   // the tool-window failure is said once, not once per window

/* The same name rule as lib/args.js: "--test" or "--test=<anything>" is the test flag;
   "--test-live-bar" and friends are other flags. */
function argName(raw) {
  if (typeof raw !== 'string' || !raw.startsWith('--')) return null;
  const eq = raw.indexOf('=');
  return eq === -1 ? raw.slice(2) : raw.slice(2, eq);
}

/** Is this a run whose windows must stay off the screen? (argv as process.argv, env as process.env) */
function wanted(argv, env) {
  const names = (Array.isArray(argv) ? argv : []).map(argName);
  if (!names.includes('test') || names.includes('live')) return false;
  return String((env && env.MANTLE_TEST_VISIBLE) || '') !== '1';
}

/** The options a quiet window is created with: the caller's, never shown by Electron, never activatable. */
function quietOptions(o) {
  const src = o && typeof o === 'object' ? o : {};
  return Object.assign({}, src, { show: false, focusable: false, skipTaskbar: true, opacity: 0 });
}

function native() {
  if (nat || natReason) return nat;
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    nat = {
      get: user32.func('intptr_t __stdcall GetWindowLongPtrW(intptr_t hwnd, int idx)'),
      set: user32.func('intptr_t __stdcall SetWindowLongPtrW(intptr_t hwnd, int idx, intptr_t v)'),
    };
  } catch (err) {
    natReason = `the window-style call could not load (${err && err.message ? err.message : err})`;
  }
  return nat;
}

function hwndOf(win) {
  const b = win.getNativeWindowHandle();
  return b.length >= 8 ? Number(b.readBigUInt64LE(0)) : b.readUInt32LE(0);
}

/** WS_EX_TOOLWINDOW (out of the live bar's app list, the switcher and Alt+Tab) and WS_EX_NOACTIVATE,
 *  set straight on the window: Electron's setFocusable(false) would also "deactivate" it, which hands
 *  the foreground to the next window in the z-order. -> null or the reason. */
function toolWindow(win) {
  const n = native();
  if (!n) return natReason;
  try {
    const h = hwndOf(win);
    const ex = Number(n.get(h, GWL_EXSTYLE));
    const want = WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE;
    if ((ex & want) !== want) n.set(h, GWL_EXSTYLE, ex | want);
    return null;
  } catch (err) {
    return `the tool-window style could not be set (${err && err.message ? err.message : err})`;
  }
}

function hide(obj, name, fn) {
  Object.defineProperty(obj, name, { value: fn, writable: true, configurable: true, enumerable: false });
}

/**
 * Makes one window quiet. `asked` = the options its code passed (what it reads back stays that).
 * `P` = the real BrowserWindow.prototype (the native methods). Idempotent.
 */
function quiet(win, asked, P, log) {
  if (!win || quieted.has(win) || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return;
  quieted.add(win);
  const o = asked && typeof asked === 'object' ? asked : {};
  const op = Number(o.opacity);
  const st = { opacity: Number.isFinite(op) ? Math.min(1, Math.max(0, op)) : 1, focusable: o.focusable !== false, skip: !!o.skipTaskbar, ignore: false };
  try { P.setOpacity.call(win, 0); } catch (_) { /* a destroyed window */ }
  try { P.setIgnoreMouseEvents.call(win, true); } catch (_) { /* a destroyed window */ }
  try { P.setSkipTaskbar.call(win, true); } catch (_) { /* a destroyed window */ }
  const why = toolWindow(win);
  if (why && log && !toolSaid) { toolSaid = true; log(`test mode: windows may still show in app lists: ${why}`); }
  hide(win, 'setOpacity', (v) => { const n = Number(v); if (Number.isFinite(n)) st.opacity = Math.min(1, Math.max(0, n)); });
  hide(win, 'getOpacity', () => st.opacity);
  hide(win, 'setIgnoreMouseEvents', (v) => { st.ignore = !!v; });
  hide(win, 'setFocusable', (v) => { st.focusable = !!v; });
  hide(win, 'isFocusable', () => st.focusable);
  hide(win, 'setSkipTaskbar', (v) => { st.skip = !!v; });
  hide(win, 'show', () => P.showInactive.call(win));
  hide(win, 'focus', () => {});
  hide(win, 'flashFrame', () => {});
  hide(win, '__mantleQuiet', st);
}

/* The tray icon of a quiet run: the menu and the tooltip are kept (and read back), no icon is drawn. */
function makeQuietTray(EventEmitter) {
  return class QuietTray extends EventEmitter {
    constructor(image) { super(); this._image = image; this._menu = null; this._tip = ''; this._title = ''; this._gone = false; this.quiet = true; }
    setImage(i) { this._image = i; }
    setPressedImage() {}
    setToolTip(t) { this._tip = String(t); }
    setTitle(t) { this._title = String(t); }
    getTitle() { return this._title; }
    setContextMenu(m) { this._menu = m; }
    popUpContextMenu() {}
    closeContextMenu() {}
    displayBalloon() {}
    removeBalloon() {}
    focus() {}
    setIgnoreDoubleClickEvents() {}
    getIgnoreDoubleClickEvents() { return false; }
    getBounds() { return { x: 0, y: 0, width: 0, height: 0 }; }
    isDestroyed() { return this._gone; }
    destroy() { this._gone = true; this.removeAllListeners(); }
  };
}

/**
 * Wraps require('electron') for this process when wanted(argv, env). -> true when installed.
 * opts.electron (tests): the module to wrap instead of the real one. opts.log: (line) => void.
 */
function install(argv, env, opts) {
  if (installed) return true;
  if (!wanted(argv, env)) return false;
  const o = opts || {};
  const electron = o.electron || require('electron');
  if (!electron || typeof electron.BrowserWindow !== 'function') return false;   // not Electron's main process
  const log = typeof o.log === 'function' ? o.log : (line) => process.stdout.write(`mantle: ${line}\n`);
  const BW = electron.BrowserWindow;
  const P = BW.prototype;
  const QuietBW = new Proxy(BW, {
    construct(target, args, newTarget) {
      const asked = args[0] && typeof args[0] === 'object' ? args[0] : {};
      const win = Reflect.construct(target, [quietOptions(asked)].concat(args.slice(1)), newTarget === QuietBW ? target : newTarget);
      quiet(win, asked, P, log);
      if (asked.show !== false) P.showInactive.call(win);   // Electron's default is show:true; never activated
      return win;
    },
  });
  const QuietTray = makeQuietTray(require('events'));
  const view = {};
  for (const k of Object.getOwnPropertyNames(electron)) {
    if (k === 'BrowserWindow' || k === 'Tray') continue;
    const d = Object.getOwnPropertyDescriptor(electron, k);
    Object.defineProperty(view, k, { enumerable: !!(d && d.enumerable), configurable: true, get: () => electron[k] });
  }
  Object.defineProperty(view, 'BrowserWindow', { enumerable: true, configurable: true, value: QuietBW });
  Object.defineProperty(view, 'Tray', { enumerable: true, configurable: true, value: QuietTray });
  const load = Module._load;
  Module._load = function quietLoad(request) {
    if (request === 'electron' || request === 'electron/main') return view;
    return load.apply(this, arguments);
  };
  // Backstop: a window made another way (a page's window.open, a library) is quietened on its next tick.
  try {
    electron.app.on('browser-window-created', (_e, win) => setImmediate(() => quiet(win, {}, P, log)));
  } catch (_) { /* no app object (tests) */ }
  installed = true;
  log('test mode: every window is kept off the screen (invisible, click-through, never focused; MANTLE_TEST_VISIBLE=1 shows them)');
  return true;
}

module.exports = { install, wanted, quietOptions, quiet, makeQuietTray, argName, isInstalled: () => installed,
  WS: { WS_EX_TRANSPARENT, WS_EX_TOOLWINDOW, WS_EX_LAYERED, WS_EX_NOACTIVATE } };
