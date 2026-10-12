/* under.js -- the top bar takes the colour of the window under it, the pure parts (lane
 * mantle-topbar-under, 2026-10-11). DARK ONLY. No DOM, no IPC: the page (browser global TopbarUnder)
 * and lib/topbar-under.test.js (require) share it. Main's half is lib/topbar-under.js.
 *
 * Main sends the row of the screen right under the bar as n columns of [r, g, b] (each the average of
 * ~8 physical px) and how much of each column a window covers (0..1; 0 = the desktop is there).
 *
 * THE FILL (plan + paint). Where a window is under the bar the bar is painted that window's colour,
 * opaque; where none is (cover 0) the paint is clear and today's glass shows. The canvas is n columns
 * wide and scaled to the bar by the compositor's bilinear filter, so between column centres the colour
 * runs linearly: that, and the 8 px averaging, is the horizontal smoothing. No extra blur: a blur would
 * move the bottom row off the window's own colours, and the bottom row is the seam.
 *   - BOTTOM ROW (the seam): exactly the column's colour, so the bar meets the window with no step.
 *   - THE TEXT BAND (rows above BLEND_FROM): the same colour, or, only where the ink could not read
 *     4.5:1 on it (a mid-tone window), that colour pulled toward the ink's scrim just enough: darker
 *     under light ink (--lg-fill-bar's colour, Helm's wash), lighter under dark ink (--lg-lift). It runs
 *     back to the exact colour over the last rows, like Helm's and Quartz's own darker tops.
 *
 * THE INK (per item). Each item on the strip (a menu title, a stat, a tool) reads the columns under its
 * own x-range and takes the light ink (the dark theme's) or the dark ink (the light theme's, copied into
 * --lg-*-on-light), whichever needs the smaller pull; it only changes side when the other one is better
 * by HYST (alpha units), so a colour sitting near the middle cannot make it flicker. A white page on one
 * side of the bar and a dark editor on the other give dark ink on one side and light on the other.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TopbarUnder = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var GA = (typeof module === 'object' && module.exports) ? require('../shared/glass-adapt.js')
    : (typeof self !== 'undefined' ? self.MantleGlassAdapt : null);
  if (!GA) throw new Error('ui/topbar/under.js needs ../shared/glass-adapt.js loaded before it');

  var NEED = 4.5;        // every item's text against its own fill
  var HYST = 0.10;       // the other ink must need this much less pull before an item changes side
  var STEP = 0.01;       // the pull is solved in these steps
  var DILATE = 3;        // a column's pull reaches this many columns each way (same ink only)...
  var SMOOTH = 2;        // ...then is averaged over this many each way (<= DILATE, so never under the need)
  var ROWS = 28;         // canvas rows: one per CSS px of the bar
  var BLEND_FROM = 21;   // the text band is rows 0..20; rows 21..27 run to the exact colour; row 27 IS it

  function L(c) { return GA.lum(c[0], c[1], c[2]); }
  function mix(c, s, a) { return [c[0] + (s[0] - c[0]) * a, c[1] + (s[1] - c[1]) * a, c[2] + (s[2] - c[2]) * a]; }
  /* MEMO (lane mantle-topbar-instant): the same colour asks the same question every frame (a window's
     top row is mostly a few colours), so each answer is kept per (inks, scrim) list, keyed by the colour.
     The page builds its ink lists once per strip render, so the lists are the same objects frame to frame. */
  var MEMO_MAX = 4096;
  var memoOf = typeof WeakMap === 'function' ? new WeakMap() : null;
  function needAlpha(c, inks, s, need) {
    if (!memoOf || !inks || !s || typeof inks !== 'object' || typeof s !== 'object') return needAlphaRaw(c, inks, s, need);
    var byS = memoOf.get(inks);
    if (!byS) { byS = new WeakMap(); memoOf.set(inks, byS); }
    var m = byS.get(s);
    if (!m) { m = new Map(); byS.set(s, m); }
    var key = (need || NEED) + ':' + c[0] + ',' + c[1] + ',' + c[2];
    var v = m.get(key);
    if (v === undefined) {
      if (m.size >= MEMO_MAX) m.clear();
      v = needAlphaRaw(c, inks, s, need);
      m.set(key, v);
    }
    return v;
  }
  /* the smallest pull a (0..1) toward scrim s at which every ink reads `need` on c; 1 when none does */
  function needAlphaRaw(c, inks, s, need) {
    var nd = need || NEED, il = [];
    for (var k = 0; k < inks.length; k++) il.push(L(inks[k]));
    function ok(step) {
      var lm = L(step ? mix(c, s, step * STEP) : c);
      for (var j = 0; j < il.length; j++) if (GA.contrast(il[j], lm) < nd) return false;
      return true;
    }
    var top = Math.round(1 / STEP);
    if (ok(0)) return 0;
    if (!ok(top)) return 1;
    // bisect: lo always fails, hi always reads (so the answer is never short, even off a monotone run)
    var lo = 0, hi = top;
    while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (ok(mid)) hi = mid; else lo = mid; }
    return Math.round(hi * STEP * 100) / 100;
  }
  /* which side, with hysteresis. prev 'light' | 'dark' | undefined; nl / nd = the pull each one needs */
  function side(prev, nl, nd) {
    if (prev === 'dark') return nl + HYST < nd ? 'light' : 'dark';
    if (prev === 'light') return nd + HYST < nl ? 'dark' : 'light';
    return nd < nl ? 'dark' : 'light';
  }
  function minRatio(c, inks) {
    var lc = L(c), m = Infinity;
    for (var k = 0; k < inks.length; k++) m = Math.min(m, GA.contrast(L(inks[k]), lc));
    return m;
  }
  function colAt(cols, c) { return [cols[c * 3], cols[c * 3 + 1], cols[c * 3 + 2]]; }

  /**
   * p = {cols: [r,g,b,...] (n*3), cover: [0..1] (n), n, width (CSS px of the bar),
   *      items: [{key, x0, x1, light: [inks], dark: [inks]}], gap: {light: [inks], dark: [inks]},
   *      scrim: {light: rgb (pull for light ink), dark: rgb (pull for dark ink)}, prev: {items, cols}, need}
   * -> {n, base: [rgb] (the exact colours), top: [rgb] (the text band), alpha: [0..1], colInk: [...],
   *     items: [{key, ink, c0, c1, covered, nl, nd, ratio}], prev (for the next call)}
   */
  function plan(p) {
    var n = p.n | 0, cols = p.cols, cover = p.cover, W = p.width > 0 ? p.width : n, need = p.need || NEED;
    var prevItems = (p.prev && p.prev.items) || {}, prevCols = (p.prev && p.prev.cols) || [];
    var base = [], alpha = [], colInk = new Array(n), colNeed = new Array(n), owner = new Array(n);
    for (var c = 0; c < n; c++) { base.push(colAt(cols, c)); alpha.push(Math.max(0, Math.min(1, +cover[c] || 0))); colNeed[c] = 0; owner[c] = -1; }
    var items = [];
    var its = p.items || [];
    for (var i = 0; i < its.length; i++) {
      var it = its[i];
      var c0 = Math.max(0, Math.floor(it.x0 / W * n)), c1 = Math.min(n - 1, Math.ceil(it.x1 / W * n) - 1);
      var nl = 0, nd = 0, covered = 0;
      for (c = c0; c <= c1; c++) {
        if (alpha[c] < 0.5) continue;
        covered++;
        nl = Math.max(nl, needAlpha(base[c], it.light, p.scrim.light, need));
        nd = Math.max(nd, needAlpha(base[c], it.dark, p.scrim.dark, need));
      }
      var ink = covered ? side(prevItems[it.key], nl, nd) : 'light';
      items.push({ key: it.key, ink: ink, c0: c0, c1: c1, covered: covered, nl: nl, nd: nd, ratio: null });
      if (!covered) continue;
      for (c = c0; c <= c1; c++) {
        owner[c] = i; colInk[c] = ink;
        if (alpha[c] >= 0.5) colNeed[c] = Math.max(colNeed[c], needAlpha(base[c], ink === 'dark' ? it.dark : it.light, ink === 'dark' ? p.scrim.dark : p.scrim.light, need));
      }
    }
    // the columns between items: their own side (with the same hysteresis), so a flat mid-tone window gets
    // ONE even band, not a patch behind each item
    for (c = 0; c < n; c++) {
      if (owner[c] >= 0) continue;
      if (alpha[c] < 0.5) { colInk[c] = prevCols[c] || 'light'; continue; }
      var gl = needAlpha(base[c], p.gap.light, p.scrim.light, need), gd = needAlpha(base[c], p.gap.dark, p.scrim.dark, need);
      colInk[c] = side(prevCols[c], gl, gd);
      colNeed[c] = colInk[c] === 'dark' ? gd : gl;
    }
    // dilate then average, each side on its own runs only (never a dark pull bleeding under light ink)
    var dil = new Array(n), pull = new Array(n);
    for (c = 0; c < n; c++) {
      var m = 0;
      for (var k = Math.max(0, c - DILATE); k <= Math.min(n - 1, c + DILATE); k++) if (colInk[k] === colInk[c]) m = Math.max(m, colNeed[k]);
      dil[c] = m;
    }
    for (c = 0; c < n; c++) {
      var sum = 0, cnt = 0;
      for (k = Math.max(0, c - SMOOTH); k <= Math.min(n - 1, c + SMOOTH); k++) if (colInk[k] === colInk[c]) { sum += dil[k]; cnt++; }
      pull[c] = Math.max(colNeed[c], cnt ? sum / cnt : 0);
    }
    var top = [];
    for (c = 0; c < n; c++) top.push(pull[c] > 0 ? mix(base[c], colInk[c] === 'dark' ? p.scrim.dark : p.scrim.light, pull[c]) : base[c].slice());
    // what each item's words read at, worst column (the proof the page test checks)
    for (i = 0; i < items.length; i++) {
      var o = items[i];
      if (!o.covered) continue;
      var inks = o.ink === 'dark' ? its[i].dark : its[i].light, r = Infinity;
      for (c = o.c0; c <= o.c1; c++) if (alpha[c] >= 0.5) r = Math.min(r, minRatio(top[c], inks));
      o.ratio = Math.round(r * 100) / 100;
    }
    var nextItems = {};
    for (i = 0; i < items.length; i++) nextItems[items[i].key] = items[i].ink;
    return { n: n, base: base, top: top, alpha: alpha, pull: pull, colInk: colInk, items: items, prev: { items: nextItems, cols: colInk.slice() } };
  }

  /* the canvas pixels for a plan: n x ROWS RGBA (Uint8ClampedArray). Rows 0..BLEND_FROM-1 the text band,
     then a straight run to the exact colour, the last row exactly it. Alpha = the cover. */
  function paint(pl, rows, out) {
    var H = rows || ROWS, n = pl.n, from = Math.min(BLEND_FROM, H - 1);
    var data = out && out.length === n * H * 4 ? out : new Uint8ClampedArray(n * H * 4);
    for (var y = 0; y < H; y++) {
      var t = y < from ? 0 : (y - from + 1) / (H - from);
      for (var c = 0; c < n; c++) {
        var a = pl.top[c], b = pl.base[c], i = (y * n + c) * 4;
        data[i] = Math.round(a[0] + (b[0] - a[0]) * t);
        data[i + 1] = Math.round(a[1] + (b[1] - a[1]) * t);
        data[i + 2] = Math.round(a[2] + (b[2] - a[2]) * t);
        data[i + 3] = Math.round(pl.alpha[c] * 255);
      }
    }
    return data;
  }

  /* main's payload checked: -> {ok, cols, cover, n} | {ok: false, why} */
  function check(p) {
    if (!p || typeof p !== 'object') return { ok: false, why: 'Mantle sent the top bar no colours' };
    var n = p.n | 0;
    if (!(n > 0) || n > 4096 || !Array.isArray(p.cols) || p.cols.length !== n * 3 || !Array.isArray(p.cover) || p.cover.length !== n) {
      return { ok: false, why: 'Mantle sent the top bar colours it cannot use' };
    }
    for (var i = 0; i < p.cols.length; i++) { var v = p.cols[i]; if (typeof v !== 'number' || !(v >= 0 && v <= 255)) return { ok: false, why: 'Mantle sent the top bar colours it cannot use' }; }
    for (i = 0; i < n; i++) { var w = p.cover[i]; if (typeof w !== 'number' || !(w >= 0 && w <= 1)) return { ok: false, why: 'Mantle sent the top bar colours it cannot use' }; }
    return { ok: true, cols: p.cols, cover: p.cover, n: n };
  }

  /* The Mantle menu row that says why the bar is not matching what is under it (a failure, or a window that
     blocks capture). Mutates in place, like TopbarGlass.glassMenu. */
  function underMenu(menu, why, bad) {
    if (!menu) return null;
    var at = -1;
    for (var i = 0; i < menu.length; i++) if (menu[i].under) { at = i; break; }
    if (!why) { if (at >= 0) menu.splice(at, 1); return null; }
    var row = { t: 'info', bad: !!bad, enabled: false, under: true, text: 'Top bar colour: ' + why };
    if (at >= 0) menu[at] = row; else menu.unshift(row);
    return row;
  }

  return { NEED: NEED, HYST: HYST, ROWS: ROWS, BLEND_FROM: BLEND_FROM, DILATE: DILATE, SMOOTH: SMOOTH,
    needAlpha: needAlpha, needAlphaRaw: needAlphaRaw, side: side, minRatio: minRatio, mix: mix, plan: plan, paint: paint, check: check, underMenu: underMenu };
}));
