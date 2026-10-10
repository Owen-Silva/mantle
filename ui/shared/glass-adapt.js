/* glass-adapt.js : how bright the blurred picture under a DARK glass surface may be (lane see-glass,
 * 2026-10-09).
 *
 * Owen, over his mountain wallpaper in dark: "mantle needs to be more see through everything", then
 * "can you change it to 50% since that is the same as i set helm to". So the dark tint is ONE layer of
 * --lg-fill (.50 of #1E1F22) over the blurred picture, and --lg-blur no longer dims it. Half a tint of
 * near-black cannot keep light ink readable over a white page or a bright photo on its own: over pure
 * white the ground under the text is ~sRGB 143, --lg-ink on that is 2.9:1 and --lg-ink-2 1.9:1.
 * Thickening the tint for everyone would put the slab back over his wallpaper, which never needed it.
 *
 * So the glass darkens only as much as the picture under it forces. Every surface that blurs a
 * captured picture (the bar, its popovers, the launcher, the switcher, the desktop panes) already
 * holds that picture as a small PNG. This file finds the brightest neighbourhood of it (block
 * means about one blur-width wide, so a single white pixel does not count but a white window does),
 * and solves for the largest brightness k in [0, 1] at which the surface's ink, laid on
 *     ground = k * (1 - a) * picture + a * tint        (sRGB, the way Chromium composites)
 * still clears the target contrast. Over a dark or mid-tone wallpaper k comes out at 1: the picture
 * shows at full strength under the breath of tint. Over a white page it comes out low and the glass
 * reads as smoked grey with readable ink. One CSS variable carries it:
 *     filter: var(--lg-blur) brightness(var(--bd-adapt, 1));
 * where --bd-adapt = k / (the token's own brightness), so the token stays the single source of the
 * blur and the saturation. DARK ONLY: light ink-on-white glass has the opposite problem and its own
 * round; every rule that reads --bd-adapt is scoped under :root[data-theme="dark"].
 *
 * Nothing runs at rest: it is called once per picture that arrives (the bar's 4 fps loop at most,
 * a 360x12 PNG, read back on one reused canvas), never on a timer.
 * Plain script, no modules: window.MantleGlassAdapt in a page, module.exports under node (tests).
 */
(function (root) {
  'use strict';

  function lin(c) { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  function lum(r, g, b) { return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b); }
  function contrast(l1, l2) { var hi = Math.max(l1, l2), lo = Math.min(l1, l2); return (hi + 0.05) / (lo + 0.05); }

  /* 'rgba(30, 31, 34, 0.34)', 'rgb(1 2 3 / .5)', '#rrggbb', '#rgb' -> {r, g, b, a}, or null */
  function parseColor(s) {
    s = String(s || '').trim();
    var m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
    if (m) {
      var hx = m[1].length === 3 ? m[1].replace(/./g, function (c) { return c + c; }) : m[1];
      return { r: parseInt(hx.slice(0, 2), 16), g: parseInt(hx.slice(2, 4), 16), b: parseInt(hx.slice(4, 6), 16), a: 1 };
    }
    m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i.exec(s);
    if (!m) return null;
    var a = m[4] === undefined ? 1 : (m[4].slice(-1) === '%' ? parseFloat(m[4]) / 100 : parseFloat(m[4]));
    return { r: +m[1], g: +m[2], b: +m[3], a: a };
  }

  /* The brightest neighbourhood: block means over cell x cell pixels, the block with the highest
     luminance wins. data is RGBA (ImageData.data). rect {x, y, w, h} (picture pixels) limits it to
     the part of the picture a surface actually sits on. Returns [r, g, b] or null when empty. */
  function peak(data, w, h, cell, rect) {
    cell = Math.max(1, Math.round(cell || 1));
    var x0 = 0, y0 = 0, x1 = w, y1 = h;
    if (rect) {
      x0 = Math.max(0, Math.floor(rect.x)); y0 = Math.max(0, Math.floor(rect.y));
      x1 = Math.min(w, Math.ceil(rect.x + rect.w)); y1 = Math.min(h, Math.ceil(rect.y + rect.h));
    }
    var best = null, bestL = -1;
    for (var by = y0; by < y1; by += cell) {
      for (var bx = x0; bx < x1; bx += cell) {
        var r = 0, g = 0, b = 0, n = 0;
        var ey = Math.min(y1, by + cell), ex = Math.min(x1, bx + cell);
        for (var y = by; y < ey; y++) {
          for (var x = bx; x < ex; x++) {
            var i = (y * w + x) * 4;
            r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
          }
        }
        if (!n) continue;
        r /= n; g /= n; b /= n;
        var L = lum(r, g, b);
        if (L > bestL) { bestL = L; best = [r, g, b]; }
      }
    }
    return best;
  }

  /* The ground the ink sits on, for brightness k. */
  function ground(pk, tint, k) {
    var a = tint.a;
    return [k * (1 - a) * pk[0] + a * tint.r, k * (1 - a) * pk[1] + a * tint.g, k * (1 - a) * pk[2] + a * tint.b];
  }

  /* The largest k in [0, hi] at which ink (relative luminance inkL, LIGHT ink) clears `target` on
     the ground over the picture's peak. Ground luminance grows with k, so bisect. */
  function solve(pk, tint, inkL, target, hi) {
    hi = hi === undefined ? 1 : hi;
    var at = function (k) { var gr = ground(pk, tint, k); return contrast(inkL, lum(gr[0], gr[1], gr[2])); };
    if (at(hi) >= target) return hi;
    if (at(0) < target) return 0;
    var lo = 0, top = hi;
    for (var i = 0; i < 18; i++) {
      var mid = (lo + top) / 2;
      if (at(mid) >= target) lo = mid; else top = mid;
    }
    return lo;
  }

  /* The token's own brightness: the number inside brightness() in --lg-blur, 1 when there is none. */
  function tokenBrightness(blur) {
    var m = /brightness\(\s*([\d.]+)\s*\)/.exec(String(blur || ''));
    return m ? parseFloat(m[1]) : 1;
  }

  /*
   * One call for a page: imageData (or {data, width, height}) + what the surface paints.
   *   opts.tint    {r,g,b,a} or a CSS colour string: the surface's tint (what ::after paints)
   *   opts.ink     relative luminance of the ink to protect, or a CSS colour string
   *   opts.target  contrast to keep (4.5 = body text)
   *   opts.inks    instead of ink/target: [{ink, target}, ...], every one of them is kept
   *   opts.rect    {x, y, w, h} in picture pixels: only this part of the picture is under the surface
   *   opts.cell    block size in PICTURE pixels (about one blur-width of the displayed picture)
   *   opts.token   the token's brightness (tokenBrightness(--lg-blur)); the answer is k / token
   *   opts.hi      the brightest k allowed (default 1: never brighter than the photograph)
   * Returns { adapt, k, peak, contrast } where adapt goes into --bd-adapt (rounded to .02 so a
   * picture that barely changed does not restyle the surface), or null when it cannot tell.
   */
  function adaptFor(img, opts) {
    if (!img || !img.data || !(img.width > 0) || !(img.height > 0)) return null;
    var tint = typeof opts.tint === 'string' ? parseColor(opts.tint) : opts.tint;
    var inkLum = function (v) { if (typeof v === 'number') return v; var c = parseColor(v); return c ? lum(c.r, c.g, c.b) : null; };
    var inks = (opts.inks || [{ ink: opts.ink, target: opts.target }]).map(function (p) { return { L: inkLum(p.ink), target: p.target || 4.5 }; });
    if (!tint || !inks.length || inks.some(function (p) { return p.L === null; })) return null;
    var pk = peak(img.data, img.width, img.height, opts.cell, opts.rect);
    if (!pk) return null;
    var token = opts.token > 0 ? opts.token : 1;
    var hi = opts.hi === undefined ? 1 : opts.hi;
    var k = hi;
    inks.forEach(function (p) { k = Math.min(k, solve(pk, tint, p.L, p.target, hi)); });
    var adapt = Math.round((k / token) / 0.02) * 0.02;
    // rounding up could cost the contrast it was solved for: step down instead
    if (adapt * token > k + 1e-9) adapt = Math.max(0, adapt - 0.02);
    var gr = ground(pk, tint, adapt * token), gl = lum(gr[0], gr[1], gr[2]);
    var worst = Math.min.apply(null, inks.map(function (p) { return contrast(p.L, gl); }));
    return { adapt: +adapt.toFixed(2), k: k, peak: pk.map(Math.round), contrast: +worst.toFixed(2) };
  }

  /* Page glue: the pixels of a loaded <img> (or canvas), drawn once on a reused canvas at its own
     natural size (the captures are tiny: 360x12 for the bar). Null when it cannot be read. */
  var scratch = null;
  function pixelsOf(src) {
    try {
      if (src && typeof src.getContext === 'function' && src.width > 0) {
        return src.getContext('2d').getImageData(0, 0, src.width, src.height);
      }
      var w = src.naturalWidth || src.width, h = src.naturalHeight || src.height;
      if (!(w > 0) || !(h > 0) || typeof document === 'undefined') return null;
      if (!scratch) scratch = document.createElement('canvas');
      if (scratch.width !== w) scratch.width = w;
      if (scratch.height !== h) scratch.height = h;
      var g = scratch.getContext('2d', { willReadFrequently: true });
      g.clearRect(0, 0, w, h);
      g.drawImage(src, 0, 0, w, h);
      return g.getImageData(0, 0, w, h);
    } catch (_) {
      return null;
    }
  }

  /* ==== THE ONE READABILITY GUARD (lane same-bars, 2026-10-09) ====================================
     Owen: "the reason i want everything at 50% is cause it will all match way better if its the
     same". So in dark every surface is ONE layer of --lg-fill (.50) over a picture blurred with
     --lg-blur and nothing else, and the ONLY allowed deviation is this rule, shared by every surface
     that has one (the top bar first, ui/topbar/glass.js; the bottom bar and its pop-ups, ui/bar/bar.js;
     the top bar's dropdowns): the tint THICKENS (never the picture dimming) to the thinnest alpha, never
     under --lg-fill's own, at which --lg-ink-2 (the quietest word) reads >= 4.5:1 against the brightest
     pixel of the picture AS THE COMPOSITOR DRAWS IT (blurred, saturated). Over Owen's wallpaper that
     is --lg-fill exactly; over a white page it is what the words need, capped at --lg-fill-pop.
     These functions are the top bar's (lane see-topbar), moved here unchanged so there is one copy. */
  /* need 4.7, not 4.5: the model blurs the 4x-downscaled picture, and what Chromium draws (that picture
     upscaled, then blurred) peaks a little brighter. Measured on the top bar over Owen's snow-peak
     wallpaper: model 4.58, drawn pixels 4.41 (lane same-bars-top, 2026-10-09). The .2 margin keeps the
     DRAWN text >= 4.5:1. */
  var GUARD = { need: 4.7, step: 0.02, hold: 4 };   // ink --lg-ink-2; floor --lg-fill's alpha; ceil --lg-fill-pop's

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
  function clamp255(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }
  /* The blurred picture, as the compositor will draw it: a gaussian of `sigma` IMAGE px with mirrored
     edges, then saturate and brightness. rgba: unpremultiplied (getImageData); a pixel left
     transparent counts as white (the worst case). Returns a flat [r,g,b, ...] array, w*h pixels. */
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
     tint {r,g,b}, need, floor, ceil, step} -> {alpha, ratio (at that alpha, worst pixel), short (even
     ceil does not get there)}. Only the brightest few pixels can be the worst, so only they are tried. */
  function glassTint(o) {
    var px = o.px || [], ink = o.ink, t = o.tint, need = o.need || GUARD.need;
    var floor = o.floor == null ? 0 : o.floor, ceil = o.ceil == null ? 0.9 : o.ceil, step = o.step || GUARD.step;
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
        var rr = contrast(li, l);
        if (rr < w) w = rr;
      }
      return cand.length ? w : contrast(li, lum(t.r, t.g, t.b));
    }
    for (var a = floor; a <= ceil + 1e-9; a = Math.round((a + step) * 1000) / 1000) {
      var r = worst(a);
      if (r >= need) return { alpha: Math.round(a * 1000) / 1000, ratio: Math.round(r * 100) / 100, short: false };
    }
    return { alpha: ceil, ratio: Math.round(worst(ceil) * 100) / 100, short: true };
  }
  /* Hysteresis for a moving picture: thicker at once (the words come first); thinner only by a real
     step (>= .10 at once, or >= .04 held for `hold` pictures), so the tint does not flicker.
     g = {cur, lower} -> {cur, lower} */
  function glassSettle(g, next, hold) {
    var cur = g && g.cur != null ? g.cur : null, lower = (g && g.lower) || 0;
    if (cur == null || next >= cur) return { cur: next, lower: 0 };
    var d = cur - next;
    if (d >= 0.1) return { cur: next, lower: 0 };
    if (d < 0.04) return { cur: cur, lower: 0 };
    lower++;
    return lower >= (hold || GUARD.hold) ? { cur: next, lower: 0 } : { cur: cur, lower: lower };
  }
  /* The guard's inputs, read from a computed style (getComputedStyle(document.documentElement)).
     FINAL RULES (Owen: "Match Helm's real look"): a BAR (o.bar: the bottom island, the top bar) is
     --lg-fill-bar (Helm's rail, .75) and its guard floors there; every other surface is --lg-fill
     (Helm's panel, .83). The ceiling is --lg-fill-pop either way (= --lg-fill in dark, so a pop-up's
     guard can only say whether .83 already holds the ink, never thicken it). */
  function guardTokens(cs, o) {
    var v = function (n) { return cs && cs.getPropertyValue ? cs.getPropertyValue(n).trim() : ''; };
    var bar = o && o.bar ? parseColor(v('--lg-fill-bar')) : null;
    /* a bar's own need when the theme sets one (dark: --lg-guard-bar, Helm's strip contrast); else GUARD's */
    var barNeed = bar ? parseFloat(v('--lg-guard-bar')) : NaN;
    return {
      need: barNeed > 1 ? barNeed : GUARD.need,
      fill: bar || parseColor(v('--lg-fill')) || { r: 19, g: 20, b: 21, a: 0.83 },
      ceil: (parseColor(v('--lg-fill-pop')) || { a: 0.82 }).a,
      ink: parseColor(v('--lg-ink-2')) || { r: 196, g: 199, b: 206, a: 1 },
      filter: parseFilter(v('--lg-blur'))
    };
  }
  /*
   * THE call: img = {data, width, height} (getImageData of the picture under the surface), o =
   *   o.tokens    guardTokens(...)
   *   o.picPerCss picture px per CSS px (the picture is a 4x downscale: about .25 x the device ratio)
   *   o.rect      {x, y, w, h} in picture px: only this part is under the surface (default: all)
   * -> {alpha, ratio, short, engaged (alpha above --lg-fill's), tint 'rgba(...)'} or null.
   * The blur runs over the WHOLE picture before the rect is cut, so a bright window just outside the
   * surface bleeds in exactly as it does on screen.
   */
  function guard(img, o) {
    var pic = glassPicture(img, o && o.tokens, o && o.picPerCss);
    return pic ? guardRect(pic, o.tokens, o.rect) : null;
  }
  /* The two halves of guard(), for a page that asks about many rectangles of one picture (a menu
     that re-renders on every hover): blur ONCE per picture, then judge each rectangle. */
  function glassPicture(img, T, picPerCss) {
    if (!img || !img.data || !(img.width > 0) || !(img.height > 0) || !T) return null;
    var f = T.filter || { blur: 0, saturate: 1, brightness: 1 };
    var px = glassPixels(img.data, img.width, img.height, { sigma: f.blur * (picPerCss > 0 ? picPerCss : 1), saturate: f.saturate, brightness: f.brightness });
    return { px: px, w: img.width, h: img.height };
  }
  function guardRect(pic, T, rect) {
    if (!pic || !T) return null;
    var px = pic.px, w = pic.w, h = pic.h;
    if (rect) {
      var x0 = Math.max(0, Math.floor(rect.x)), y0 = Math.max(0, Math.floor(rect.y));
      var x1 = Math.min(w, Math.ceil(rect.x + rect.w)), y1 = Math.min(h, Math.ceil(rect.y + rect.h));
      if (x1 <= x0 || y1 <= y0) return null;
      var cut = [];
      for (var y = y0; y < y1; y++) for (var x = x0; x < x1; x++) { var i = (y * w + x) * 3; cut.push(px[i], px[i + 1], px[i + 2]); }
      px = cut;
    }
    var r = glassTint({ px: px, ink: T.ink, tint: T.fill, need: T.need || GUARD.need, floor: T.fill.a, ceil: Math.max(T.fill.a, T.ceil), step: GUARD.step });
    r.engaged = r.alpha > T.fill.a + 1e-9;
    r.tint = tintCss(T.fill, r.alpha);
    return r;
  }
  function tintCss(fill, alpha) { return 'rgba(' + fill.r + ',' + fill.g + ',' + fill.b + ',' + alpha + ')'; }

  var api = { lin: lin, lum: lum, contrast: contrast, parseColor: parseColor, peak: peak, ground: ground, solve: solve, tokenBrightness: tokenBrightness, adaptFor: adaptFor, pixelsOf: pixelsOf,
    GUARD: GUARD, parseFilter: parseFilter, glassPixels: glassPixels, glassTint: glassTint, glassSettle: glassSettle, guardTokens: guardTokens, guard: guard, glassPicture: glassPicture, guardRect: guardRect, tintCss: tintCss };
  root.MantleGlassAdapt = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
