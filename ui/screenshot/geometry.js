/* geometry.js - the screenshot overlay's arithmetic, PURE, shared by the page (a <script>) and main
 * (require), so the rect a drag draws and the rect main asks the sidecar to cut are computed by the
 * same lines. Tested in lib/features/screenshot.test.js.
 *
 * UNITS, the whole point of this file:
 *   phys  physical pixels in VIRTUAL-SCREEN coordinates: what the sidecar grabs and crops in
 *         (Screenshot.cs is per-monitor DPI aware), so a second monitor can start at x = -1920.
 *   css   one overlay page's own CSS pixels, 0,0 at its monitor's top-left. Each monitor has its
 *         own overlay window, so each page has ONE scale: its monitor's (1.25 on Owen's panel,
 *         measured 2026-09-24). A mixed-DPI desktop is therefore just several single-DPI pages.
 * A page never uses devicePixelRatio for the conversion: it uses monitor-physical-width over
 * viewport-CSS-width, which is the scale Windows actually applied to THIS window even when
 * Chromium's zoom or a rounding of the window size disagrees with the nominal factor.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ShotGeometry = api;
}(this, function () {
  'use strict';

  /** Two corner points (any order) -> {x,y,w,h}. */
  function normRect(ax, ay, bx, by) {
    var x = Math.min(ax, bx), y = Math.min(ay, by);
    return { x: x, y: y, w: Math.abs(bx - ax), h: Math.abs(by - ay) };
  }

  /** Intersection of two {x,y,w,h}; null when they do not overlap. */
  function intersect(a, b) {
    var l = Math.max(a.x, b.x), t = Math.max(a.y, b.y);
    var r = Math.min(a.x + a.w, b.x + b.w), btm = Math.min(a.y + a.h, b.y + b.h);
    return r > l && btm > t ? { x: l, y: t, w: r - l, h: btm - t } : null;
  }

  function scaleOf(mon, view) {
    return { sx: mon.w / view.w, sy: mon.h / view.h };
  }

  /**
   * A CSS rect on one monitor's page -> the physical rect the sidecar crops. EDGES are converted,
   * not origin + size, so two selections that share an edge on screen share it in the file too,
   * and the result is clamped to the monitor (a drag can end outside the window).
   */
  function cssToPhys(r, mon, view) {
    var s = scaleOf(mon, view);
    var x0 = mon.x + Math.round(r.x * s.sx), x1 = mon.x + Math.round((r.x + r.w) * s.sx);
    var y0 = mon.y + Math.round(r.y * s.sy), y1 = mon.y + Math.round((r.y + r.h) * s.sy);
    x0 = Math.max(mon.x, Math.min(mon.x + mon.w, x0)); x1 = Math.max(mon.x, Math.min(mon.x + mon.w, x1));
    y0 = Math.max(mon.y, Math.min(mon.y + mon.h, y0)); y1 = Math.max(mon.y, Math.min(mon.y + mon.h, y1));
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  /** The inverse, for drawing: a physical rect -> this page's CSS px (may hang off the page). */
  function physToCss(r, mon, view) {
    var s = scaleOf(mon, view);
    return { x: (r.x - mon.x) / s.sx, y: (r.y - mon.y) / s.sy, w: r.w / s.sx, h: r.h / s.sy };
  }

  /** A CSS point on the page -> physical (floor: the pixel the pointer is ON). */
  function pointToPhys(px, py, mon, view) {
    var s = scaleOf(mon, view);
    return { x: mon.x + Math.floor(px * s.sx), y: mon.y + Math.floor(py * s.sy) };
  }

  /**
   * The window under a physical point: the first in z-order (the sidecar lists topmost first)
   * whose rect holds it. The desktop (kind "desktop") answers as the whole monitor, which is what
   * Windows' own Window mode does over an empty desktop.
   */
  function windowAt(windows, pt, mon) {
    for (var i = 0; i < (windows || []).length; i++) {
      var w = windows[i];
      if (pt.x >= w.x && pt.x < w.x + w.w && pt.y >= w.y && pt.y < w.y + w.h) {
        if (w.kind === 'desktop') return { hwnd: w.hwnd, kind: 'desktop', x: mon.x, y: mon.y, w: mon.w, h: mon.h };
        return w;
      }
    }
    return mon ? { hwnd: null, kind: 'desktop', x: mon.x, y: mon.y, w: mon.w, h: mon.h } : null;
  }

  /**
   * Pairs the sidecar's monitors with Electron's displays (both in physical px) by the largest
   * overlap, so each overlay window goes on the monitor whose frame it shows. Returns one
   * {monitor, display} per sidecar monitor; display is null when none overlaps (then that
   * monitor gets no overlay, and main says so).
   */
  function matchDisplays(monitors, displays) {
    var used = {};
    return (monitors || []).map(function (m) {
      var best = null, area = 0;
      (displays || []).forEach(function (d, i) {
        if (used[i]) return;
        var o = intersect(m, d);
        var a = o ? o.w * o.h : 0;
        if (a > area) { area = a; best = i; }
      });
      if (best !== null) used[best] = true;
      return { monitor: m, display: best === null ? null : displays[best] };
    });
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /** Windows' own screenshot name, local time: "Screenshot 2026-09-24 143005" (no extension). */
  function screenshotName(d) {
    return 'Screenshot ' + d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' +
      pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
  }

  /** The live size readout, in the PHYSICAL pixels the file will have. */
  function sizeText(w, h) { return Math.round(w) + ' × ' + Math.round(h); }

  /**
   * Where the size readout goes: just below the selection's bottom-right corner, flipped inside
   * or above when that would leave the page. All CSS px.
   */
  function labelSpot(sel, view, lw, lh, gap) {
    gap = gap == null ? 8 : gap;
    var x = sel.x + sel.w - lw, y = sel.y + sel.h + gap;
    if (y + lh > view.h) y = sel.y - lh - gap;                 // no room below: above
    if (y < 0) y = Math.max(0, sel.y + sel.h - lh - gap);        // no room above either: inside
    x = Math.max(4, Math.min(view.w - lw - 4, x));
    return { x: x, y: y };
  }

  /** A selection this small (physical px) is a click, not a drag: nothing is captured. */
  var MIN_SIDE = 2;
  function isCapture(phys) { return !!phys && phys.w >= MIN_SIDE && phys.h >= MIN_SIDE; }

  return {
    normRect: normRect, intersect: intersect, cssToPhys: cssToPhys, physToCss: physToCss,
    pointToPhys: pointToPhys, windowAt: windowAt, matchDisplays: matchDisplays,
    screenshotName: screenshotName, sizeText: sizeText, labelSpot: labelSpot,
    isCapture: isCapture, MIN_SIDE: MIN_SIDE,
  };
}));
