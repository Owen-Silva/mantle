'use strict';
/*
 * thumbs.js - the LIVE window previews in the bar's hover flyout, drawn by DWM.
 *
 * WHAT: hover a running app's icon and the flyout above it holds one card per
 * window of that app, each with a small moving picture of the window. The
 * pictures are DWM thumbnails (DwmRegisterThumbnail + DwmUpdateThumbnailProperties),
 * the same mechanism the Windows taskbar and Alt+Tab use: the compositor draws the
 * source window, scaled, straight into a rectangle of OUR window, every frame, for
 * free. Nothing is copied through JavaScript, so a 60 fps video in the source is a
 * 60 fps video in the card.
 *
 * WHY THIS IS IN MAIN, THROUGH koffi, AND NOT IN THE SIDECAR (2026-09-22):
 * DwmRegisterThumbnail's DESTINATION must be a top-level window owned by the
 * CALLING process. The sidecar is its own process, so it can list, focus and close
 * windows for the bar but it can never draw a thumbnail INTO the bar. Electron main
 * owns the bar's HWND, so main has to make the call. There is no C++ compiler on
 * this machine, so no node-gyp addon either: koffi is an N-API FFI that ships
 * prebuilt Windows binaries (@koromix/koffi-win32-x64) and can call dwmapi.dll
 * directly. The alternatives were a native preview window owned by the sidecar (a
 * second always-on-top window to keep glued to the bar through every reveal, park
 * and morph) or PrintWindow snapshots a few times a second (not live at all).
 *
 * THE COORDINATES: rcDestination is in PHYSICAL pixels, relative to the
 * destination's CLIENT area (measured, see contentOffset). The page measures its
 * preview boxes in CSS px (= DIP), so this multiplies by the page's devicePixelRatio
 * (1.25 on the user's screen) and adds where the page sits inside the client area (0 for
 * the frameless live bar; the menu bar for the framed --test window). See toPhysical().
 *
 * THE LEAK THIS FILE IS PARANOID ABOUT: a registered thumbnail keeps drawing until
 * it is unregistered or our process dies. The destination rectangle is relative to
 * the window's TOP-LEFT, and the bar grows and shrinks from the top (it keeps its
 * bottom on the screen edge), so a thumbnail left behind when the popover shrinks
 * slides DOWN onto the bar and sits over the icons forever. So every road out of
 * the flyout calls clear(): the page closing it, the popover shrinking, the bar
 * leaving, the page reloading, the window dying, Mantle quitting. A source window
 * that closes is pruned from the sidecar's windows push.
 *
 * NOTHING FAILS SILENTLY: every entry comes back {ok, reason}. The page puts the
 * reason IN THE CARD (where the picture would have been), because a blank grey box
 * with no words is exactly the silent failure this shell refuses.
 */

// DWM_THUMBNAIL_PROPERTIES.dwFlags
const DWM_TNP_RECTDESTINATION = 0x1;
const DWM_TNP_OPACITY = 0x4;
const DWM_TNP_VISIBLE = 0x8;
const DWM_TNP_SOURCECLIENTAREAONLY = 0x10;
const DWMWA_CLOAKED = 14;
// DWMWA_CLOAKED's value is a bit set: who hid the window.
const CLOAK_WHO = {
  1: 'the app itself has hidden it (it is cloaked)',
  2: 'Windows is hiding it: it is on another virtual desktop, or it is a suspended Store app',
  4: 'Windows is hiding it along with the window that owns it',
};

let api = null;          // the bound functions, once load() has succeeded
let loadReason = null;   // why load() failed, remembered so it is tried once and said every time

function hresult(hr) {
  return '0x' + ((Number(hr) >>> 0).toString(16).toUpperCase().padStart(8, '0'));
}

// The HRESULTs DWM actually answers here, in words. Anything else is printed as its number.
function hrWords(hr) {
  switch (Number(hr) >>> 0) {
    case 0x80070057: return 'DWM said the arguments are invalid (E_INVALIDARG): the window may have closed, or it is not a top-level window';
    case 0x80070006: return 'DWM said the window handle is invalid (E_HANDLE): the window has closed';
    case 0x80263001: return 'desktop composition is off (DWM_E_COMPOSITIONDISABLED), so Windows draws no previews at all';
    case 0x80070005: return 'DWM refused access (E_ACCESSDENIED): the window belongs to a process Mantle is not allowed to preview';
    default: return `DWM refused (HRESULT ${hresult(hr)})`;
  }
}

/**
 * Bind dwmapi + user32 through koffi, once. Never throws: {ok, reason}.
 */
function load() {
  if (api) return { ok: true, reason: null };
  if (loadReason) return { ok: false, reason: loadReason };
  if (process.platform !== 'win32') {
    loadReason = 'live previews are drawn by the Windows compositor (DWM), and this is not Windows';
    return { ok: false, reason: loadReason };
  }
  let koffi;
  try {
    koffi = require('koffi');
  } catch (err) {
    loadReason = `the koffi module would not load (${err.message.split('\n')[0]}), so Mantle cannot ask DWM for previews: run npm install in the Mantle folder`;
    return { ok: false, reason: loadReason };
  }
  try {
    const dwm = koffi.load('dwmapi.dll');
    const user32 = koffi.load('user32.dll');
    // Named MANTLE_* so they can never collide with a type another module registers in koffi.
    koffi.struct('MANTLE_RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
    koffi.struct('MANTLE_SIZE', { cx: 'int32', cy: 'int32' });
    koffi.struct('MANTLE_POINT', { x: 'int32', y: 'int32' });
    // dwmapi.h wraps its structs in <pshpack1.h>: this one is 45 bytes, PACKED. koffi.struct would
    // put 3 bytes of padding after `opacity` and DWM would read fVisible from the wrong offset.
    koffi.pack('MANTLE_DWM_THUMBNAIL_PROPERTIES', {
      dwFlags: 'uint32',
      rcDestination: 'MANTLE_RECT',
      rcSource: 'MANTLE_RECT',
      opacity: 'uint8',
      fVisible: 'int32',
      fSourceClientAreaOnly: 'int32',
    });
    // HWND and HTHUMBNAIL as intptr_t, not koffi pointers: the sidecar and hwndOf() hand
    // Mantle handles as decimal strings, and an integer type takes a Number (or BigInt) as is.
    api = {
      register: dwm.func('long __stdcall DwmRegisterThumbnail(intptr_t dest, intptr_t src, _Out_ intptr_t *thumb)'),
      unregister: dwm.func('long __stdcall DwmUnregisterThumbnail(intptr_t thumb)'),
      update: dwm.func('long __stdcall DwmUpdateThumbnailProperties(intptr_t thumb, const MANTLE_DWM_THUMBNAIL_PROPERTIES *props)'),
      sourceSize: dwm.func('long __stdcall DwmQueryThumbnailSourceSize(intptr_t thumb, _Out_ MANTLE_SIZE *size)'),
      cloaked: dwm.func('long __stdcall DwmGetWindowAttribute(intptr_t hwnd, uint32 attr, _Out_ uint32 *value, uint32 size)'),
      isWindow: user32.func('int __stdcall IsWindow(intptr_t hwnd)'),
      isIconic: user32.func('int __stdcall IsIconic(intptr_t hwnd)'),
      clientToScreen: user32.func('int __stdcall ClientToScreen(intptr_t hwnd, _Inout_ MANTLE_POINT *pt)'),
    };
    return { ok: true, reason: null };
  } catch (err) {
    api = null;
    loadReason = `koffi loaded but could not bind dwmapi.dll / user32.dll: ${err.message}`;
    return { ok: false, reason: loadReason };
  }
}

function toHandle(h) {
  const n = Number(h);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/**
 * Where the PAGE's top-left sits inside the window's Win32 client area, in physical px.
 *
 * rcDestination is relative to the destination's CLIENT area, not its window rect.
 * Measured 2026-09-22 (test mode, the probe that proved this route): a thumbnail sent
 * to the framed test window at "client offset + 0,0" landed at exactly TWICE the
 * offset, i.e. DWM had added the client origin itself. The frameless live bar has
 * no frame and no menu, so there the page, the client area and the window all start
 * at the same pixel and this is 0,0. The framed --test bar is the case it exists
 * for: Electron's default menu bar sits INSIDE the Win32 client area, above the page.
 *
 *   contentOrigin: the page's top-left on screen in physical px (main has it from
 *                  getContentBounds() + screen.dipToScreenPoint()).
 */
function contentOffset(dest, contentOrigin) {
  const pt = { x: 0, y: 0 };
  if (!contentOrigin || !api.clientToScreen(dest, pt)) return { x: 0, y: 0, ok: false };
  // A DIP rect converted back to pixels can land a pixel either side of where the window really
  // is (1003 px / 1.25 = 802.4 DIP), so a pixel or two above the client origin is 0, not an error.
  const snap = (v) => (v < 0 && v >= -2 ? 0 : v);
  const x = snap(Math.round(contentOrigin.x - pt.x));
  const y = snap(Math.round(contentOrigin.y - pt.y));
  // Anything negative, or bigger than a menu bar, is a unit mix-up rather than a layout;
  // drawing the pictures at 0,0 is less wrong than drawing them a screen away.
  if (x < 0 || y < 0 || x > 64 || y > 128) return { x: 0, y: 0, ok: false };
  return { x, y, ok: true };
}

/**
 * The page's CSS-px box -> the largest rectangle with the SOURCE's aspect ratio that
 * fits inside it, centred, in physical px relative to the destination window.
 * Letterboxed like the Windows taskbar's own previews: a tall window in a wide card
 * is drawn tall and narrow, never squashed.
 */
function toPhysical(box, dpr, offset, source) {
  const bx = offset.x + box.x * dpr;
  const by = offset.y + box.y * dpr;
  const bw = box.w * dpr;
  const bh = box.h * dpr;
  let w = bw;
  let h = bh;
  if (source && source.w > 0 && source.h > 0) {
    const s = Math.min(bw / source.w, bh / source.h);
    w = source.w * s;
    h = source.h * s;
  }
  const left = Math.round(bx + (bw - w) / 2);
  const top = Math.round(by + (bh - h) / 2);
  return { left, top, right: left + Math.round(w), bottom: top + Math.round(h) };
}

/*
 * A SET of live thumbnails: everything one window draws. Keyed by SOURCE hwnd: a window
 * has at most one card per set, so at most one thumbnail. `dest` is remembered so a
 * recreated window (a page crash that took the window with it) can never be handed an
 * old window's thumbnails.
 *
 * SETS, PLURAL (2026-09-23): the Alt+Tab switcher (lib/switcher.js) draws the same kind
 * of picture into its own window. sync() makes its set EXACTLY the list it is given, so
 * with one shared set the switcher opening would have unregistered the bar's flyout
 * previews and the flyout would have unregistered the switcher's. Each window now owns a
 * set of its own (set('switcher')); the module-level sync/clear/prune/count below are the
 * bar's set, unchanged, so the bar's call sites did not move.
 */
function makeSet(where, whatFor) {
  const live = new Map();   // src hwnd (string) -> { thumb, dest }

  function drop(src, why) {
    const t = live.get(src);
    if (!t) return;
    live.delete(src);
    try { api.unregister(t.thumb); } catch (_) { /* the handle is dead either way; nothing else to do */ }
    if (why && process.env.MANTLE_THUMBS_DEBUG === '1') process.stdout.write(`mantle: preview of ${src} unregistered (${why})\n`);
  }

  /** Unregister everything. Safe to call any number of times, from any exit road. */
  function clear(why) {
    if (!live.size || !api) return 0;
    const n = live.size;
    for (const key of Array.from(live.keys())) drop(key, why);
    return n;
  }

  /** Drop the previews whose source window is no longer in the sidecar's list. Returns their hwnds. */
  function prune(aliveHwnds) {
    if (!live.size || !api) return [];
    const gone = [];
    for (const key of Array.from(live.keys())) {
      if (!aliveHwnds.has(key)) { drop(key, 'its window left the window list'); gone.push(key); }
    }
    return gone;
  }

  function count() { return live.size; }

  function sync(destHwnd, entries, dpr, contentOrigin) {
    return syncSet(live, drop, clear, where, whatFor, destHwnd, entries, dpr, contentOrigin);
  }

  return { sync, clear, prune, count };
}

/**
 * Make one set EXACTLY `entries` inside `destHwnd`: register the new ones, move
 * the old ones, unregister everything not listed. Never throws.
 *
 *   entries: [{hwnd, x, y, w, h}]   the preview box of each card, CSS px, viewport-relative
 *   dpr:     the page's devicePixelRatio
 *   contentOrigin: the page's top-left on screen, physical px (see contentOffset)
 *
 * Returns {ok, reason, thumbs: [{hwnd, ok, reason, minimized, source:{w,h}, drawn}]},
 * `drawn` being the rectangle DWM was given (physical px, client-area relative).
 */
function syncSet(live, drop, clear, where, whatFor, destHwnd, entries, dpr, contentOrigin) {
  const l = load();
  if (!l.ok) {
    return { ok: false, reason: l.reason, thumbs: (entries || []).map((e) => ({ hwnd: String(e && e.hwnd), ok: false, reason: l.reason })) };
  }
  const dest = toHandle(destHwnd);
  if (!dest) {
    clear(`${where} has no handle`);
    return { ok: false, reason: `${where} has no handle to draw previews into`, thumbs: [] };
  }
  const scale = Number(dpr) > 0 ? Number(dpr) : 1;
  const offset = contentOffset(dest, contentOrigin);
  const wanted = new Set();
  const out = [];

  for (const e of Array.isArray(entries) ? entries : []) {
    const key = String(e && e.hwnd);
    const src = toHandle(key);
    const box = { x: Number(e && e.x), y: Number(e && e.y), w: Number(e && e.w), h: Number(e && e.h) };
    if (!src) { out.push({ hwnd: key, ok: false, reason: 'the card has no window handle' }); continue; }
    if (![box.x, box.y, box.w, box.h].every(Number.isFinite) || box.w < 2 || box.h < 2) {
      out.push({ hwnd: key, ok: false, reason: 'the card measured no room for a picture' });
      continue;
    }
    if (!api.isWindow(src)) { drop(key, 'its window closed'); out.push({ hwnd: key, ok: false, gone: true, reason: 'this window has closed' }); continue; }

    // Cloaked (another virtual desktop, a suspended Store app): DWM registers a thumbnail
    // happily and then draws nothing into it. An empty card that says nothing is the lie
    // this whole file exists to avoid, so ask first and say who hid it.
    const cloak = [0];
    if (api.cloaked(src, DWMWA_CLOAKED, cloak, 4) === 0 && cloak[0]) {
      drop(key, 'cloaked');
      out.push({ hwnd: key, ok: false, reason: `no picture: ${CLOAK_WHO[cloak[0]] || `Windows reports it cloaked (${cloak[0]})`}` });
      continue;
    }

    let t = live.get(key);
    if (t && t.dest !== dest) { drop(key, `${where} changed`); t = null; }
    if (!t) {
      const h = [0];
      const hr = api.register(dest, src, h);
      if (hr !== 0 || !h[0]) {
        out.push({ hwnd: key, ok: false, reason: `no picture: ${hrWords(hr)}` });
        continue;
      }
      t = { thumb: h[0], dest };
      live.set(key, t);
    }
    wanted.add(key);

    const size = {};
    const shr = api.sourceSize(t.thumb, size);
    const source = shr === 0 ? { w: size.cx | 0, h: size.cy | 0 } : null;
    if (!source || source.w <= 0 || source.h <= 0) {
      drop(key, 'no source size');
      wanted.delete(key);
      out.push({ hwnd: key, ok: false, reason: shr === 0 ? 'no picture: DWM reports the window as 0 x 0, so there is nothing to draw' : `no picture: ${hrWords(shr)}` });
      continue;
    }

    const drawn = toPhysical(box, scale, offset, source);
    const props = {
      dwFlags: DWM_TNP_RECTDESTINATION | DWM_TNP_VISIBLE | DWM_TNP_OPACITY | DWM_TNP_SOURCECLIENTAREAONLY,
      rcDestination: drawn,
      rcSource: { left: 0, top: 0, right: 0, bottom: 0 },
      opacity: 255,
      fVisible: 1,
      // The whole window, frame included, the way the Windows taskbar shows it: for most apps
      // the title bar IS the recognisable part.
      fSourceClientAreaOnly: 0,
    };
    const uhr = api.update(t.thumb, props);
    if (uhr !== 0) {
      drop(key, 'update refused');
      wanted.delete(key);
      out.push({ hwnd: key, ok: false, reason: `no picture: ${hrWords(uhr)}` });
      continue;
    }
    out.push({ hwnd: key, ok: true, reason: null, minimized: !!api.isIconic(src), source, drawn });
  }

  for (const key of Array.from(live.keys())) if (!wanted.has(key)) drop(key, `not in ${whatFor} any more`);
  return { ok: true, reason: offset.ok ? null : `the page could not be located inside ${where}, so the previews may sit a few pixels off their boxes`, offset: { x: offset.x, y: offset.y }, thumbs: out };
}

// The bar's set: what the module-level functions below have always meant.
const barSet = makeSet('the bar window', 'the flyout');
const sets = new Map([['bar', barSet]]);

/** The set of window `name` ('switcher', ...), made on first use. Same {sync, clear, prune, count}. */
function set(name, where, whatFor) {
  let s = sets.get(name);
  if (!s) {
    s = makeSet(where || `the ${name} window`, whatFor || `the ${name}`);
    sets.set(name, s);
  }
  return s;
}

function sync(destHwnd, entries, dpr, contentOrigin) { return barSet.sync(destHwnd, entries, dpr, contentOrigin); }
function clear(why) { return barSet.clear(why); }
function prune(aliveHwnds) { return barSet.prune(aliveHwnds); }
function count() { return barSet.count(); }

/*
 * ---- TEST MODE ONLY (main.js runFlyoutTest, behind --test --flyout) ----------------------
 *
 * WHY a capture of our own: webContents.capturePage() photographs the PAGE, and the previews
 * are not in the page -- DWM draws them over it -- so a normal screenshot run shows every box
 * empty. PrintWindow(PW_RENDERFULLCONTENT) asks DWM to render the window as it composes it,
 * and that DOES include the thumbnails (measured 2026-09-22: the live Terminal and a minimised
 * window both came out in it, in the right place). It does NOT include Chromium's own page
 * content (that comes out as a flat fill), so main pastes the preview rectangles from this
 * capture over the capturePage() one. A screen grab would include both, but only with the test
 * bar on top of the user's windows, and a test run may never put a window over their work.
 */
let gdi = null;
function bindGdi() {
  if (gdi) return gdi;
  const koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  const g32 = koffi.load('gdi32.dll');
  koffi.struct('MANTLE_BITMAPINFOHEADER', {
    biSize: 'uint32', biWidth: 'int32', biHeight: 'int32', biPlanes: 'uint16', biBitCount: 'uint16',
    biCompression: 'uint32', biSizeImage: 'uint32', biXPelsPerMeter: 'int32', biYPelsPerMeter: 'int32',
    biClrUsed: 'uint32', biClrImportant: 'uint32',
  });
  gdi = {
    getDC: user32.func('intptr_t __stdcall GetDC(intptr_t hwnd)'),
    releaseDC: user32.func('int __stdcall ReleaseDC(intptr_t hwnd, intptr_t dc)'),
    printWindow: user32.func('int __stdcall PrintWindow(intptr_t hwnd, intptr_t dc, uint32 flags)'),
    windowRect: user32.func('int __stdcall GetWindowRect(intptr_t hwnd, _Out_ MANTLE_RECT *rect)'),
    setWindowPos: user32.func('int __stdcall SetWindowPos(intptr_t hwnd, intptr_t after, int x, int y, int cx, int cy, uint32 flags)'),
    createDC: g32.func('intptr_t __stdcall CreateCompatibleDC(intptr_t dc)'),
    createBitmap: g32.func('intptr_t __stdcall CreateCompatibleBitmap(intptr_t dc, int w, int h)'),
    select: g32.func('intptr_t __stdcall SelectObject(intptr_t dc, intptr_t obj)'),
    getBits: g32.func('int __stdcall GetDIBits(intptr_t dc, intptr_t bmp, uint32 start, uint32 lines, void *bits, _Inout_ MANTLE_BITMAPINFOHEADER *bi, uint32 usage)'),
    deleteObject: g32.func('int __stdcall DeleteObject(intptr_t obj)'),
    deleteDC: g32.func('int __stdcall DeleteDC(intptr_t dc)'),
  };
  return gdi;
}

/**
 * The window as DWM composes it, previews included: {ok, reason, width, height, bgra, client}
 * where `client` is the client area's top-left inside the image (physical px).
 */
function capture(hwnd) {
  const l = load();
  if (!l.ok) return { ok: false, reason: l.reason };
  const h = toHandle(hwnd);
  if (!h) return { ok: false, reason: 'no window handle to capture' };
  try {
    const g = bindGdi();
    const r = {};
    if (!g.windowRect(h, r)) return { ok: false, reason: 'GetWindowRect failed' };
    const w = r.right - r.left;
    const ht = r.bottom - r.top;
    const pt = { x: 0, y: 0 };
    api.clientToScreen(h, pt);
    const screenDC = g.getDC(0);
    const memDC = g.createDC(screenDC);
    const bmp = g.createBitmap(screenDC, w, ht);
    const old = g.select(memDC, bmp);
    const printed = g.printWindow(h, memDC, 2 /* PW_RENDERFULLCONTENT */);
    const bgra = Buffer.alloc(w * ht * 4);
    const bi = { biSize: 40, biWidth: w, biHeight: -ht, biPlanes: 1, biBitCount: 32, biCompression: 0, biSizeImage: 0, biXPelsPerMeter: 0, biYPelsPerMeter: 0, biClrUsed: 0, biClrImportant: 0 };
    const lines = g.getBits(memDC, bmp, 0, ht, bgra, bi, 0 /* DIB_RGB_COLORS */);
    g.select(memDC, old);
    g.deleteObject(bmp);
    g.deleteDC(memDC);
    g.releaseDC(0, screenDC);
    if (!printed || lines !== ht) return { ok: false, reason: `PrintWindow answered ${printed}, GetDIBits copied ${lines} of ${ht} lines` };
    for (let i = 3; i < bgra.length; i += 4) bgra[i] = 255;   // GDI leaves alpha at 0
    return { ok: true, reason: null, width: w, height: ht, bgra, client: { x: pt.x - r.left, y: pt.y - r.top } };
  } catch (err) {
    return { ok: false, reason: `the capture threw: ${err.message}` };
  }
}

/** Put a window at the bottom of the z-order without activating it (SWP_NOACTIVATE). */
function toBack(hwnd) {
  const l = load();
  const h = toHandle(hwnd);
  if (!l.ok || !h) return false;
  try {
    // HWND_BOTTOM = 1; SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE
    return !!bindGdi().setWindowPos(h, 1, 0, 0, 0, 0, 0x1 | 0x2 | 0x10);
  } catch (_) { return false; }
}

module.exports = { load, sync, clear, prune, count, set, toPhysical, hresult, capture, toBack };
