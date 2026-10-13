'use strict';
const fs = require('fs');
const path = require('path');
const { BrowserWindow, screen } = require('electron');
const { placeholderUrl } = require('./placeholder');

/*
 * The three windows Mantle puts on screen, and the two very different shapes
 * they take.
 *
 * LIVE: frameless, transparent, click-through-ish chrome that belongs to the
 * shell -- the bar pinned to a screen edge above everything, the launcher a
 * floating panel, the desktop reparented under the wallpaper by the sidecar.
 *
 * TEST (--test): three ordinary resizable windows with frames and a dark
 * backdrop, so they can be moved, screenshotted and closed like any app, and so
 * nothing about the real shell is touched. This is the ONLY shape that ever runs
 * while someone is at the machine, which is also why every show here is
 * showInactive(): a test run must never take focus from whoever is working.
 *
 * BAR_H is the single source of truth for the bar's height: the window, the strip
 * of screen Mantle's app bar reserves in live mode, and lane C's CSS all have to
 * agree, and the app bar is the one that leaves a visible gap if it drifts.
 *
 * ---------------------------------------------------------------------------
 * GLASS (2026-09-21) -- and the dead end that came first.
 * ---------------------------------------------------------------------------
 * First attempt: Electron's `backgroundMaterial: 'acrylic'`, which needs
 * `transparent: false`. It looked solid, and Owen's verdict was "it doesnt look
 * glass ui like at all". The reason: `backgroundMaterial` is DWM's SYSTEM
 * BACKDROP, and Windows renders a system backdrop only on the ACTIVE window. The
 * bar is `focusable: false` and is never active by design; the launcher is
 * inactive most of the time. Both therefore showed the solid fallback almost
 * always -- the material was working exactly as documented, on windows that can
 * never meet its condition.
 *
 * So these two windows are plain TRANSPARENT windows again, exactly as they were
 * before, and the glass comes from the sidecar's `glass` command
 * (SetWindowCompositionAttribute blur-behind), which does not care whether the
 * window is active. main.js applies it once the sidecar is up and again after a
 * reload, and records the outcome in State.glass with the reason.
 *
 * Nothing about glass lives in this file any more, on purpose: a window option
 * that silently does nothing is exactly what wasted the first attempt, and the
 * only honest place for "did it actually happen" is next to the call that asks.
 */

/*
 * BAR_H went 44 -> 48 on 2026-09-21 with the hover bar.
 *
 * The bar is no longer a strip of reserved screen: it is HIDDEN until the cursor
 * touches the bottom edge, and it then floats OVER whatever is there -- including
 * the Windows taskbar, which is on auto-hide and reacts to that same bottom edge.
 * Owen's taskbar is 60 PHYSICAL px tall at 125%, i.e. 48 DIP. A 44 DIP bar would
 * leave a 4 DIP sliver of Windows taskbar sticking out below Mantle's own bar
 * every time both came up together. 48 covers it exactly.
 */
const BAR_H = 48;

/** A window's page, or a placeholder that names the file and lane if it is missing. */
function loadPage(win, { file, title, owner, compact }) {
  if (fs.existsSync(file)) {
    win.loadFile(file);
    return { loaded: true };
  }
  win.loadURL(placeholderUrl({
    title,
    file: path.relative(path.dirname(path.dirname(file)), file).split(path.sep).join('/'),
    owner,
    compact,
  }));
  return { loaded: false, reason: `${file} does not exist (${owner})` };
}

/*
 * In test mode the windows have a frame, and Electron's width/height include it.
 * A 44px-tall framed window therefore has about 10px of PAGE in it, which is
 * exactly what the first screenshot run produced. useContentSize moves the
 * measurement to the web contents, so "44px tall" means 44px of bar -- the same
 * number the live window and lane C's CSS use.
 */
const TEST_SIZE = { useContentSize: true };

function baseWebPreferences(root) {
  return {
    preload: path.join(root, 'preload.js'),
    contextIsolation: true,      // renderers are plain browser scripts
    sandbox: true,               // ... with no require(), ever
    nodeIntegration: false,
    spellcheck: false,
    // Chromium throttles timers in windows it thinks are hidden. The desktop
    // lives UNDER the wallpaper and the bar can be fully occluded by a maximised
    // window, and both still have to keep a clock honest. These pages are idle
    // between ticks, so turning throttling off costs nothing measurable.
    backgroundThrottling: false,
  };
}

/* liveShape (TEST ONLY, --test-live-bar, 2026-09-24): a test bar made the live bar's way -
   frameless, transparent, placed by the sidecar - but never always-on-top, so it can be traced
   doing exactly what the live bar does without ever sitting over Owen's windows. */
function createBar({ root, test, barEdge, liveShape }) {
  const display = screen.getPrimaryDisplay();
  const b = display.bounds;
  const common = {
    width: test ? 1280 : b.width,
    height: BAR_H,
    webPreferences: baseWebPreferences(root),
    show: false,
    title: 'Mantle bar',
  };
  const win = new BrowserWindow(test && !liveShape ? Object.assign(common, TEST_SIZE, {
    resizable: true,
    backgroundColor: '#1a1c20',   // --ink-0, so lane C's glass has something to sit on
  }) : Object.assign(common, {
    x: b.x,
    y: barEdge === 'top' ? b.y : b.y + b.height - BAR_H,
    frame: false,
    transparent: true,
    // resizable:FALSE + noDragHandles(rawSized) below (2026-09-27, lane tbdrift). It was
    // resizable:true + thickFrame:false, on the belief that no WS_THICKFRAME meant no drag handles:
    // it does not (see noDragHandles), and the 5 DIP along the screen's bottom edge were a resize
    // handle. resizable:false alone pinned min = max (the island came out 1920 px wide, 2026-09-21);
    // noDragHandles lifts that pin, so the sidecar's raw SetWindowPos sizes it as before.
    resizable: false,
    thickFrame: false,
    movable: false,
    focusable: false,             // clicking the bar must not take focus off the app
    skipTaskbar: true,
    alwaysOnTop: !test,
    hasShadow: false,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
  }));

  if (!test) {
    /*
     * 'screen-saver', not 'floating' (2026-09-21, the hover bar).
     *
     * The bar has to come up OVER the Windows taskbar: both react to the same
     * bottom screen edge, Owen's taskbar is on auto-hide, so the two slide up
     * together and 'floating' loses that race -- Explorer's taskbar is topmost.
     * Mantle's bar underneath the thing it replaces is the one outcome that makes
     * the whole feature look broken.
     *
     * What used to justify 'floating' was "don't paint over a fullscreen game".
     * That job moved to the reveal poll in main.js, which asks the sidecar for the
     * foreground window and refuses to reveal over a fullscreen one -- a check
     * that can say WHY it decided, which a z-order band never could.
     */
    win.setAlwaysOnTop(true, 'screen-saver');
  }
  if (!(test && !liveShape)) noDragHandles(win, { rawSized: true });   // placed by the sidecar's SetWindowPos (main.js placeBar)

  const load = loadPage(win, {
    file: path.join(root, 'ui', 'bar', 'index.html'),
    title: 'The bar',
    owner: 'ui/bar/ is lane C',
    compact: true,
  });
  return { win, load };
}

function createLauncher({ root, test }) {
  const display = screen.getPrimaryDisplay();
  const b = display.bounds;
  const W = 680;
  const H = 460;
  const common = {
    width: W,
    height: H,
    webPreferences: baseWebPreferences(root),
    show: false,
    title: 'Mantle launcher',
  };
  const win = new BrowserWindow(test ? Object.assign(common, TEST_SIZE, {
    resizable: true,
    backgroundColor: '#1a1c20',
  }) : Object.assign(common, {
    x: Math.round(b.x + (b.width - W) / 2),
    y: Math.round(b.y + (b.height - H) / 2),
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
  }));

  if (!test) win.setAlwaysOnTop(true, 'floating');

  const load = loadPage(win, {
    file: path.join(root, 'ui', 'launcher', 'index.html'),
    title: 'The launcher',
    owner: 'ui/launcher/ is lane D',
    compact: false,
  });
  return { win, load };
}

/*
 * The desktop layer gets NO glass, deliberately. It is the thing everything else
 * is in front of -- it sits under the wallpaper, so there is nothing behind it to
 * blur, and a blur-behind there would turn the wallpaper into grey soup.
 */
function createDesktop({ root, test }) {
  const display = screen.getPrimaryDisplay();
  const b = display.bounds;
  const common = {
    webPreferences: baseWebPreferences(root),
    show: false,
    title: 'Mantle desktop',
  };
  const win = new BrowserWindow(test ? Object.assign(common, TEST_SIZE, {
    width: 960,
    height: 540,
    resizable: true,
    backgroundColor: '#1a1c20',   // stands in for the wallpaper
  }) : Object.assign(common, {
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    frame: false,
    transparent: true,            // the wallpaper shows through everywhere the page does not paint
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
  }));
  // Sized again by a raw SetWindowPos after a resolution or scale change (the sidecar's
  // `desktop {fit:true}`, lib/display-fit.js; lane mn-display): resizable:false pins min = max to the
  // size it was made with, which would clamp that move to the OLD display's size. Live shape only.
  if (!test) noDragHandles(win, { rawSized: true });

  const load = loadPage(win, {
    file: path.join(root, 'ui', 'desktop', 'index.html'),
    title: 'The desktop layer',
    owner: 'ui/desktop/ is this lane -- if you are seeing this, the file was deleted',
    compact: false,
  });
  return { win, load };
}

/**
 * The hwnd the sidecar needs, as the decimal string the protocol asks for.
 * getNativeWindowHandle gives a 4- or 8-byte little-endian buffer depending on
 * the build; reading the wrong width would hand Win32 a garbage handle.
 */
function hwndOf(win) {
  const buf = win.getNativeWindowHandle();
  if (buf.length >= 8) return buf.readBigUInt64LE(0).toString();
  return String(buf.readUInt32LE(0));
}

/*
 * NO DRAG HANDLES (lane tbdrift, 2026-09-27). A frameless Electron window that is RESIZABLE answers
 * WM_NCHITTEST itself with resize codes on the 5 DIP inside each edge (LEFT, RIGHT, TOP, BOTTOM and
 * the four 16 DIP corners), whatever thickFrame says: thickFrame:false only drops WS_THICKFRAME.
 * Probed 2026-09-27 on an 800x500 frameless window: resizable:true answered all eight, resizable:false
 * CLIENT everywhere; a 'will-resize' preventDefault leaves all eight (it only cancels the drag, and the
 * click is still eaten). Owen's top bar was dragged to 673 DIP wide through its corners.
 *
 * So Mantle's frameless windows are resizable:false. Electron then pins min = max to the window's size
 * at creation and on every setBounds / setSize / setContentBounds / setContentSize, which clamps a raw
 * SetWindowPos (the bar's sidecar placement, the switcher's and the screenshot overlay's koffi one).
 * rawSized: true lifts that pin now and after each of those calls (a 'resize' listener would miss a
 * same-size setBounds, which still pins), so a raw SetWindowPos sizes the window as it did before.
 * The user still cannot: with resizable:false there is no hit-test band to drag.
 */
function noDragHandles(win, { rawSized = false } = {}) {
  if (win.isResizable()) win.setResizable(false);
  if (!rawSized) return win;
  const unpin = () => { try { if (!win.isDestroyed()) { win.setMinimumSize(0, 0); win.setMaximumSize(0, 0); } } catch (_) { /* closing */ } };
  for (const m of ['setBounds', 'setSize', 'setContentBounds', 'setContentSize']) {
    const orig = win[m];
    if (typeof orig !== 'function') continue;
    win[m] = function sizedThenUnpinned(...args) { const r = orig.apply(win, args); unpin(); return r; };
  }
  unpin();
  return win;
}

/*
 * What WM_NCHITTEST answers 2 physical px inside the window's four edges, four corners and at its
 * centre, e.g. { L: 'CLIENT', TL: 'TOPLEFT', ... }. Read from the window's PHYSICAL rect
 * (GetWindowRect), so a window parked off every monitor is measured right too. A QUESTION sent to one
 * of Mantle's own windows (SendMessage, no input, nothing moves); for tests and --test log lines.
 * koffi is bound on first use.
 */
let U = null;
function hitZones(win) {
  if (!U) {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const RECT = koffi.struct('MANTLE_HIT_RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
    U = {
      send: user32.func('intptr_t __stdcall SendMessageW(intptr_t hwnd, uint32_t msg, uintptr_t w, intptr_t l)'),
      rect: user32.func('bool __stdcall GetWindowRect(intptr_t hwnd, _Out_ MANTLE_HIT_RECT *r)'),
      RECT,
    };
  }
  const HT = { 0: 'NOWHERE', 1: 'CLIENT', 2: 'CAPTION', 10: 'LEFT', 11: 'RIGHT', 12: 'TOP', 13: 'TOPLEFT', 14: 'TOPRIGHT', 15: 'BOTTOM', 16: 'BOTTOMLEFT', 17: 'BOTTOMRIGHT' };
  const hwnd = Number(hwndOf(win));
  const r = {};
  if (!U.rect(hwnd, r)) throw new Error('GetWindowRect failed');
  const L = r.left + 2, T = r.top + 2, R = r.right - 3, B = r.bottom - 3;
  const mx = (r.left + r.right) >> 1, my = (r.top + r.bottom) >> 1;
  const pts = { L: [L, my], R: [R, my], T: [mx, T], B: [mx, B], TL: [L, T], TR: [R, T], BL: [L, B], BR: [R, B], C: [mx, my] };
  const out = {};
  for (const [k, [x, y]] of Object.entries(pts)) {
    const v = Number(U.send(hwnd, 0x0084, 0, ((y & 0xffff) << 16) | (x & 0xffff)));
    out[k] = HT[v] || String(v);
  }
  return out;
}
/** The zones that are NOT plain client area, as "TL=TOPLEFT R=RIGHT" ('' = none: no drag handles). */
function dragHandles(zones) { return Object.entries(zones).filter(([, v]) => v !== 'CLIENT').map(([k, v]) => `${k}=${v}`).join(' '); }

module.exports = { createBar, createLauncher, createDesktop, hwndOf, noDragHandles, hitZones, dragHandles, BAR_H };
