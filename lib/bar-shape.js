'use strict';
/*
 * lib/bar-shape.js - the bar window's SHAPE (2026-09-24).
 *
 * Owen: "when i press any of these buttons the taskbar glitches down and then back up rq". Every
 * popover used to make its room by resizing the bar WINDOW (main.js barTall has the whole story
 * and the measurements). Now, in hover mode, the window is always POPOVER_MAX taller than the
 * bar and never changes size while it is on screen; what changes is its SHAPE -- a window region,
 * set through Electron's BrowserWindow.setShape, that is the bar's resting rectangle plus the
 * room the open popover asked for. Outside the shape nothing is drawn and clicks go straight
 * through to whatever is behind, exactly as they did when the window was only that big.
 *
 * WHY setShape AND NOT A SIDECAR REGION: Chromium keeps a shape set this way as ITS region
 * (custom_window_region_) and puts it back itself after every resize, so parking the window
 * below the screen and bringing it back cannot lose it. A region set from outside would be one
 * WM_SIZE away from being replaced.
 *
 * This file is the arithmetic, the one Electron call and a read-back, kept apart from main.js so
 * the arithmetic can be tested without Electron: node lib/bar-shape.test.js.
 */

/**
 * The shape for a bar with `extra` DIP of popover room open, in WINDOW-RELATIVE DIP.
 * `win` and `rest` are the window's and the bar's resting rectangles in screen DIP
 * (barGeometry's win and rest); `edge` is the screen edge the bar lives on.
 *
 * At the bottom edge the bar is the bottom of the window and the room grows up from it; at the
 * top edge, the reverse. ONE DIP OF SLACK on the side away from the edge: Chromium rounds a
 * shape OUT to whole pixels, but the page lays the pill out in fractional ones (62 DIP at 1.25x
 * is 77.5 px), and without the slack the pill's anti-aliased top row could be cut in half.
 */
function shapeRect({ edge, win, rest, extra }) {
  const room = Math.max(0, Math.round(Number(extra) || 0));
  const width = Math.ceil(win.width);
  const winH = Math.ceil(win.height);
  if (edge === 'top') {
    const top = Math.max(0, Math.round(rest.y - win.y));
    return { x: 0, y: top, width, height: Math.min(winH - top, Math.round(rest.height) + room + 1) };
  }
  const y = Math.max(0, Math.round(rest.y - win.y) - room - 1);
  return { x: 0, y, width, height: winH - y };
}

/**
 * What Chromium turns a DIP shape into, in window-relative PHYSICAL pixels. A mirror of
 * DesktopWindowTreeHostWin::SetShape: above 1x each rect is scaled and rounded OUT (floor the
 * top-left, ceil the bottom-right); at 1x it is used as it is. For the tests and the read-back.
 */
function shapeToPhys(rect, sf) {
  const s = Number(sf) > 1 ? Number(sf) : 1;
  return {
    left: Math.floor(rect.x * s),
    top: Math.floor(rect.y * s),
    right: Math.ceil((rect.x + rect.width) * s),
    bottom: Math.ceil((rect.y + rect.height) * s),
  };
}

/** Set it; null clears it (the plain rectangle again). Never throws: {ok, reason}. */
function apply(win, rect) {
  if (!win || win.isDestroyed()) return { ok: false, reason: 'the bar window is gone' };
  if (typeof win.setShape !== 'function') return { ok: false, reason: 'this Electron has no BrowserWindow.setShape' };
  try {
    win.setShape(rect ? [rect] : []);
    return { ok: true, reason: null };
  } catch (err) {
    return { ok: false, reason: `BrowserWindow.setShape refused ${JSON.stringify(rect)}: ${err.message}` };
  }
}

/*
 * Read the region back from Windows: GetWindowRgnBox through koffi (already a dependency, see
 * lib/thumbs.js). Only used to PROVE the first shape took -- a window this tall without its
 * shape would be 480 DIP of invisible glass eating clicks above the bar, so main does not use
 * the tall window until this says the region is there.
 */
let rgnBoxFn = null;
let rgnBoxWhy = null;
function readBack(hwnd) {
  if (!rgnBoxFn && !rgnBoxWhy) {
    try {
      const koffi = require('koffi');
      // Named MANTLE_SHAPE_*, never colliding with thumbs.js's MANTLE_RECT; defined once per process.
      try { koffi.struct('MANTLE_SHAPE_RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' }); } catch (_) { /* already defined */ }
      rgnBoxFn = koffi.load('user32.dll').func('int __stdcall GetWindowRgnBox(intptr_t hwnd, _Out_ MANTLE_SHAPE_RECT *rect)');
    } catch (err) {
      rgnBoxWhy = `the region could not be read back (koffi: ${String(err.message).split('\n')[0]})`;
    }
  }
  if (!rgnBoxFn) return { ok: false, reason: rgnBoxWhy };
  const box = {};
  let kind;
  try {
    kind = rgnBoxFn(Number(hwnd), box);
  } catch (err) {
    return { ok: false, reason: `GetWindowRgnBox threw: ${err.message}` };
  }
  // 2 SIMPLEREGION, 3 COMPLEXREGION; 1 is an empty region and 0 means none (or an error)
  if (kind !== 2 && kind !== 3) return { ok: false, kind, reason: `Windows reports no region on the bar window (GetWindowRgnBox answered ${kind})` };
  return { ok: true, kind, box: { left: box.left, top: box.top, right: box.right, bottom: box.bottom }, reason: null };
}

/**
 * Did `rect` (DIP) arrive as the region Windows now holds? Compared with what Chromium makes
 * of it at `sf`, to a pixel either way. {ok, reason, box}.
 */
function verify(hwnd, rect, sf) {
  const got = readBack(hwnd);
  if (!got.ok) return got;
  const want = shapeToPhys(rect, sf);
  const near = ['left', 'top', 'right', 'bottom'].every((k) => Math.abs(got.box[k] - want[k]) <= 1);
  return near
    ? { ok: true, box: got.box, reason: null }
    : { ok: false, box: got.box, reason: `the bar window's region is ${JSON.stringify(got.box)}, not the ${JSON.stringify(want)} it was given` };
}

module.exports = { shapeRect, shapeToPhys, apply, readBack, verify };
