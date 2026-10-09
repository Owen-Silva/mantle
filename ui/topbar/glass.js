/* glass.js — the top bar's glass in DARK, the pure parts (lane see-topbar, 2026-10-09). No DOM, no
 * IPC: the page (browser global TopbarGlass) and lib/features/topbar-glass.test.js (require) share it.
 * Kept out of model.js, which the ping lane owns. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TopbarGlass = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  /* ---- THE GLASS, dark only (lane see-topbar, 2026-10-09) ------------------------------------
     The page gets a small picture of the desktop's strip (what is really under the bar) and blurs it
     with --lg-blur under its tint. These are the pure parts: read the CSS tokens, model the blur the
     compositor will draw, and solve the THINNEST tint at which the quietest word on the strip (ink-2)
     still reads >= 4.5:1 against the brightest pixel of that blurred picture. Composited the way
     Chromium blends (sRGB, per channel). */
  function parseColor(s) {
    s = String(s || '').trim();
    var m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
    if (m) {
      var h = m[1].length === 3 ? m[1].replace(/./g, function (c) { return c + c; }) : m[1];
      return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 };
    }
    m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+%?)\s*)?\)$/i.exec(s);
    if (!m) return null;
    var a = m[4] == null ? 1 : (/%$/.test(m[4]) ? parseFloat(m[4]) / 100 : parseFloat(m[4]));
    return { r: +m[1], g: +m[2], b: +m[3], a: a };
  }
  /* "blur(12px) saturate(140%) brightness(.86)" -> {blur: 12, saturate: 1.4, brightness: .86} */
  function parseFilter(s) {
    var out = { blur: 0, saturate: 1, brightness: 1 };
    String(s || '').replace(/(blur|saturate|brightness)\(\s*([\d.]+)(px|%)?\s*\)/gi, function (_, fn, v, unit) {
      var n = parseFloat(v);
      if (unit === '%') n /= 100;
      out[fn.toLowerCase()] = n;
      return '';
    });
    return out;
  }
  function lin(c) { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  function lum(r, g, b) { return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b); }
  function ratio(l1, l2) { var hi = Math.max(l1, l2), lo = Math.min(l1, l2); return (hi + 0.05) / (lo + 0.05); }
  function clamp255(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }
  /* The blurred picture, as the compositor will draw it: a gaussian of `sigma` IMAGE px with mirrored
     edges (backdrop-filter mirrors), then saturate and brightness. rgba: unpremultiplied (canvas
     getImageData); a pixel the page left transparent is counted as white (the worst case). Returns a
     flat [r,g,b, r,g,b, ...] array, w*h pixels. */
  function glassPixels(rgba, w, h, f) {
    var n = w * h, src = new Float32Array(n * 3), i, k, x, y, c;
    for (i = 0; i < n; i++) {
      var al = rgba[i * 4 + 3] / 255;
      for (c = 0; c < 3; c++) src[i * 3 + c] = rgba[i * 4 + c] * al + 255 * (1 - al);
    }
    var sigma = Math.max(0, (f && f.sigma) || 0);
    if (sigma > 0.3) {
      var rad = Math.ceil(sigma * 3), ker = [], sum = 0;
      for (k = -rad; k <= rad; k++) { var v = Math.exp(-(k * k) / (2 * sigma * sigma)); ker.push(v); sum += v; }
      for (k = 0; k < ker.length; k++) ker[k] /= sum;
      var mir = function (p, len) { if (len === 1) return 0; var per = 2 * (len - 1); p = ((p % per) + per) % per; return p < len ? p : per - p; };
      var tmp = new Float32Array(n * 3);
      for (y = 0; y < h; y++) for (x = 0; x < w; x++) for (c = 0; c < 3; c++) {
        var acc = 0;
        for (k = -rad; k <= rad; k++) acc += ker[k + rad] * src[(y * w + mir(x + k, w)) * 3 + c];
        tmp[(y * w + x) * 3 + c] = acc;
      }
      for (y = 0; y < h; y++) for (x = 0; x < w; x++) for (c = 0; c < 3; c++) {
        var acc2 = 0;
        for (k = -rad; k <= rad; k++) acc2 += ker[k + rad] * tmp[(mir(y + k, h) * w + x) * 3 + c];
        src[(y * w + x) * 3 + c] = acc2;
      }
    }
    var s = f && f.saturate != null ? f.saturate : 1, br = f && f.brightness != null ? f.brightness : 1;
    var out = new Array(n * 3);
    for (i = 0; i < n; i++) {
      var R = src[i * 3], G = src[i * 3 + 1], B = src[i * 3 + 2];
      // the Filter Effects saturate matrix, then brightness
      var r2 = (0.213 + 0.787 * s) * R + (0.715 - 0.715 * s) * G + (0.072 - 0.072 * s) * B;
      var g2 = (0.213 - 0.213 * s) * R + (0.715 + 0.285 * s) * G + (0.072 - 0.072 * s) * B;
      var b2 = (0.213 - 0.213 * s) * R + (0.715 - 0.715 * s) * G + (0.072 + 0.928 * s) * B;
      out[i * 3] = clamp255(clamp255(r2) * br); out[i * 3 + 1] = clamp255(clamp255(g2) * br); out[i * 3 + 2] = clamp255(clamp255(b2) * br);
    }
    return out;
  }
  /* The thinnest tint that keeps `ink` >= need:1 over every pixel. o = {px (glassPixels), ink {r,g,b},
     tint {r,g,b}, need, floor, ceil, step}. -> {alpha, ratio (at that alpha, worst pixel), short (even
     ceil does not get there)}. Only the brightest few pixels can be the worst, so only they are tried. */
  function glassTint(o) {
    var px = o.px || [], ink = o.ink, t = o.tint, need = o.need || 4.5;
    var floor = o.floor == null ? 0 : o.floor, ceil = o.ceil == null ? 0.9 : o.ceil, step = o.step || 0.02;
    var cand = [], i;
    for (i = 0; i + 2 < px.length; i += 3) cand.push([lum(px[i], px[i + 1], px[i + 2]), px[i], px[i + 1], px[i + 2]]);
    cand.sort(function (a, b) { return b[0] - a[0]; });
    cand = cand.slice(0, 48);
    var li = lum(ink.r, ink.g, ink.b);
    function worst(a) {
      var w = Infinity;
      for (var j = 0; j < cand.length; j++) {
        var c = cand[j];
        var l = lum(c[1] * (1 - a) + t.r * a, c[2] * (1 - a) + t.g * a, c[3] * (1 - a) + t.b * a);
        var rr = ratio(li, l);
        if (rr < w) w = rr;
      }
      return cand.length ? w : ratio(li, lum(t.r, t.g, t.b));
    }
    for (var a = floor; a <= ceil + 1e-9; a = Math.round((a + step) * 1000) / 1000) {
      var r = worst(a);
      if (r >= need) return { alpha: Math.round(a * 1000) / 1000, ratio: Math.round(r * 100) / 100, short: false };
    }
    return { alpha: ceil, ratio: Math.round(worst(ceil) * 100) / 100, short: true };
  }
  /* Hysteresis for a moving wallpaper: thicker at once (the words come first); thinner only by a
     real step (>= .10 at once, or >= .04 held for `hold` pictures), so the tint does not flicker.
     g = {cur, lower} -> {cur, lower} */
  function glassSettle(g, next, hold) {
    var cur = g && g.cur != null ? g.cur : null, lower = (g && g.lower) || 0;
    if (cur == null || next >= cur) return { cur: next, lower: 0 };
    var d = cur - next;
    if (d >= 0.1) return { cur: next, lower: 0 };
    if (d < 0.04) return { cur: cur, lower: 0 };
    lower++;
    return lower >= (hold || 4) ? { cur: next, lower: 0 } : { cur: cur, lower: lower };
  }
  /* The Mantle menu's first row says why the glass is flat (a failure only; light, a peek or a
     full-screen window under the bar are the design, not a fault). Mutates in place, like peekMenu. */
  function glassMenu(menu, why) {
    if (!menu) return null;
    var at = -1;
    for (var i = 0; i < menu.length; i++) if (menu[i].glass) { at = i; break; }
    if (!why) { if (at >= 0) menu.splice(at, 1); return null; }
    var row = { t: 'info', bad: true, enabled: false, glass: true, text: 'The top bar is not frosted: ' + why };
    if (at >= 0) menu[at] = row; else menu.unshift(row);
    return row;
  }

  return { parseColor: parseColor, parseFilter: parseFilter, lum: lum, ratio: ratio, glassPixels: glassPixels, glassTint: glassTint, glassSettle: glassSettle, glassMenu: glassMenu };
}));
