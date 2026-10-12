'use strict';
/*
 * under-native.test.js -- the page half of NATIVE (lane zero-page, 2026-10-11), pure node, no Electron.
 * While main says the sidecar's own layer is up behind the bar painting the exact colours, the page's
 * canvas carries only the text band's scrim (under.js paintOverlay) and the glass is masked by 1 - cover
 * (under.js glassMask). Checked here:
 *   OVERLAY: over the native base the composite IS paint()'s for cover 1, every row and column, within 1
 *            level (straight alpha; and the 8-bit premultiplied store Chromium keeps, within 2); every byte 0
 *            where there is no pull, on the bottom row, and where the cover is 0; a fractional-cover column
 *            stays within its bound, pull * (1 - t) * cover * (1 - cover) * |base - glass| (+ rounding);
 *            plan() gives scrim / pull with top = mix(base, scrim, pull), and paint() is unchanged.
 *   MASK:    runs of equal cover give a stop at the first and last column centre of each run, so the mask
 *            is 1 - the canvas's bilinear alpha at every x (evaluated from the CSS string itself, with and
 *            without the 4 px overhang); blocked columns (cover 0) keep the glass; a full cover and no
 *            cover; the same cover gives back the same object (no style write).
 *   node ui/topbar/under-native.test.js   -> "TOPBAR UNDER NATIVE: n passed, m failed"
 */
const fs = require('fs');
const path = require('path');
const P = require(path.join(__dirname, 'under.js'));
const GA = require(path.join(__dirname, '..', 'shared', 'glass-adapt.js'));

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(name + (detail !== undefined ? ' -- ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 600) : ''));
  return ok;
}

/* the token values the page reads, from the dark block of the stylesheet it uses */
const css = fs.readFileSync(path.join(__dirname, '..', 'shared', 'glass-light.css'), 'utf8');
const darkBlock = css.slice(css.indexOf(':root[data-theme="dark"]'));
const tok = (name) => { const m = new RegExp(`${name}:\\s*([^;]+);`).exec(darkBlock); const c = m && GA.parseColor(m[1].trim()); return c ? [c.r, c.g, c.b] : null; };
const T = { light: [tok('--lg-ink'), tok('--lg-ink-2')], dark: [tok('--lg-ink-on-light'), tok('--lg-ink-2-on-light')], scrimL: tok('--lg-fill-bar'), scrimD: tok('--lg-lift') };
check('tokens: the inks and both scrims are in the dark block', [...T.light, ...T.dark, T.scrimL, T.scrimD].every(Boolean), T);

const n = 240, W = 1920, H = P.ROWS;
const item = (key, x0, x1) => ({ key, x0, x1, light: T.light, dark: T.dark });
const ITEMS = [item('glyph', 8, 38), item('app', 38, 120), item('m1', 120, 170), item('m2', 170, 220), item('cpu', 1400, 1470), item('mem', 1470, 1600), item('timer', 1860, 1910)];
const plan = (cols, cover) => P.plan({ cols, cover, n, width: W, items: ITEMS, gap: { light: T.light, dark: T.dark }, scrim: { light: T.scrimL, dark: T.scrimD }, prev: null });
const flatCols = (fn) => { const o = []; for (let c = 0; c < n; c++) o.push(...fn(c)); return o; };
const fill = (v) => new Array(n).fill(v);
let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const rowT = (y) => { const from = Math.min(P.BLEND_FROM, H - 1); return y < from ? 0 : (y - from + 1) / (H - from); };

/* ---- OVERLAY ---- */
const SCENES = [
  ['Quartz top (25,38,41)', flatCols(() => [25, 38, 41])],
  ['white', flatCols(() => [255, 255, 255])],
  ['mid grey 128', flatCols(() => [128, 128, 128])],
  ['mid violet (120,90,200)', flatCols(() => [120, 90, 200])],
  ['a grey ramp 0..255', flatCols((c) => { const v = Math.round(c / (n - 1) * 255); return [v, v, v]; })],
  ['random colours', flatCols(() => [Math.floor(rnd() * 256), Math.floor(rnd() * 256), Math.floor(rnd() * 256)])],
  ['white | mid grey | dark halves', flatCols((c) => (c < 80 ? [255, 255, 255] : c < 160 ? [128, 128, 128] : [25, 38, 41]))],
];
let worstStraight = 0, worstPremul = 0, anyPull = false;
for (const [name, cols] of SCENES) {
  const pl = plan(cols, fill(1));
  const today = P.paint(pl, H);
  const ov = P.paintOverlay(pl, H);
  let maxS = 0, maxP = 0, zeroWhereNoPull = true, bottomZero = true, top = true;
  for (let c = 0; c < n; c++) {
    if (pl.pull[c] > 0) anyPull = true;
    // plan's new fields: top IS base pulled toward scrim by pull
    const m = P.mix(pl.base[c], pl.scrim[c], pl.pull[c]);
    if (pl.pull[c] > 0 && m.some((v, k) => Math.abs(v - pl.top[c][k]) > 1e-9)) top = false;
    for (let y = 0; y < H; y++) {
      const i = (y * n + c) * 4, a = ov[i + 3] / 255;
      if (!(pl.pull[c] > 0) && (ov[i] || ov[i + 1] || ov[i + 2] || ov[i + 3])) zeroWhereNoPull = false;
      if (y === H - 1 && ov[i + 3] !== 0) bottomZero = false;
      for (let k = 0; k < 3; k++) {
        const b = pl.base[c][k];
        const straight = Math.round(ov[i + k] * a + b * (1 - a));
        const premul = Math.round(Math.round(ov[i + k] * a) + b * (1 - a));   // Chromium keeps the canvas premultiplied, 8 bit
        maxS = Math.max(maxS, Math.abs(straight - today[i + k]));
        maxP = Math.max(maxP, Math.abs(premul - today[i + k]));
      }
    }
  }
  worstStraight = Math.max(worstStraight, maxS); worstPremul = Math.max(worstPremul, maxP);
  check(`overlay (${name}): scrim over the native base = paint() within 1 level, every row and column (straight alpha)`, maxS <= 1, maxS);
  check(`overlay (${name}): ...and within 2 through an 8-bit premultiplied store`, maxP <= 2, maxP);
  check(`overlay (${name}): every byte 0 in a column with no pull`, zeroWhereNoPull);
  check(`overlay (${name}): the bottom row is clear (the seam is the native colour itself)`, bottomZero);
  check(`plan (${name}): top = mix(base, scrim, pull) per column`, top);
}
check('overlay: the scenes include pulled columns (the band is really tested)', anyPull);
console.log(`info: overlay vs paint(), worst over every scene/row/column: ${worstStraight} level(s) straight, ${worstPremul} premultiplied`);
{
  const q = P.paintOverlay(plan(SCENES[0][1], fill(1)), H);
  check('overlay: a dark window under light ink is all zero bytes (the page puts nothing)', q.every((v) => v === 0));
  const out = new Uint8ClampedArray(n * H * 4).fill(9);
  check('overlay: writes into the buffer it is given (no allocation per frame)', P.paintOverlay(plan(SCENES[2][1], fill(1)), H, out) === out);
  // paint() is what it was: the old formula, inline
  const pl = plan(SCENES[6][1], fill(1).map((v, c) => (c % 3 === 0 ? 0.5 : 1)));
  const d = P.paint(pl, H);
  let same = true;
  for (let y = 0; y < H && same; y++) for (let c = 0; c < n; c++) {
    const t = rowT(y), a = pl.top[c], b = pl.base[c], i = (y * n + c) * 4;
    if (d[i] !== Math.round(a[0] + (b[0] - a[0]) * t) || d[i + 1] !== Math.round(a[1] + (b[1] - a[1]) * t) || d[i + 2] !== Math.round(a[2] + (b[2] - a[2]) * t) || d[i + 3] !== Math.round(pl.alpha[c] * 255)) { same = false; break; }
  }
  check('paint(): unchanged (the old formula, byte for byte)', same);
}
{
  // cover 0 columns: nothing; a fractional cover: the overlay is scaled by it, and stays within its bound
  const cols = SCENES[2][1];
  const cover = fill(1).map((v, c) => (c < 40 ? 0 : c < 60 ? 0.25 : c < 80 ? 0.5 : c < 100 ? 0.75 : 1));
  const pl = plan(cols, cover);
  const today = P.paint(pl, H), ov = P.paintOverlay(pl, H);
  let zeroAt0 = true, within = true, worst = 0, worstBound = 0, worstAt = null;
  for (let c = 0; c < n; c++) {
    for (let y = 0; y < H; y++) {
      const i = (y * n + c) * 4;
      if (cover[c] === 0 && ov[i + 3] !== 0) zeroAt0 = false;
      if (cover[c] === 0 || cover[c] === 1) continue;
      const A = ov[i + 3] / 255, alpha = today[i + 3] / 255, m = 1 - alpha;   // the glass's mask = 1 - the canvas's alpha
      for (let g = 0; g < 4; g++) {
        const G = [Math.floor(rnd() * 256), Math.floor(rnd() * 256), Math.floor(rnd() * 256)];   // what the glass shows there
        for (let k = 0; k < 3; k++) {
          const b = pl.base[c][k];
          const was = G[k] * (1 - alpha) + today[i + k] * alpha;                           // today: the canvas over the glass
          const now = ov[i + k] * A + (1 - A) * (G[k] * m + b * (1 - m));                  // native: scrim over (masked glass over the base)
          const bound = pl.pull[c] * (1 - rowT(y)) * cover[c] * (1 - cover[c]) * Math.abs(b - G[k]) + 1.5;
          const e = Math.abs(now - was);
          if (e > bound) { within = false; worstAt = { c, y, k, e, bound }; }
          if (e > worst) { worst = e; worstBound = bound; }
        }
      }
    }
  }
  check('overlay: a column with cover 0 is clear', zeroAt0);
  check('overlay: a fractional-cover column stays within pull * (1 - t) * cover * (1 - cover) * |base - glass| + 1.5 levels', within, worstAt);
  console.log(`info: fractional cover (0.25 / 0.5 / 0.75, mid grey, random glass): worst ${worst.toFixed(1)} levels (its bound there ${worstBound.toFixed(1)})`);
}

/* ---- MASK ---- */
// evaluate the CSS gradient string at bar x (CSS px), the way the compositor does: linear between stops,
// held outside the first / last; a stop is X% or calc(X% +/- Ypx) of a box W + 2 pad wide, `pad` left of the bar
function maskAt(mask, x, Wbar, pad) {
  if (mask === 'none') return 1;
  const body = mask.slice(mask.indexOf('(') + 1, mask.lastIndexOf(')'));
  const re = /rgba\(0,0,0,([\d.]+)\)(?:\s+(calc\(([\d.]+)% ([+-]) ([\d.]+)px\)|([\d.]+)%))?/g;
  const L = Wbar + 2 * pad, stops = [];
  let m;
  while ((m = re.exec(body))) {
    const a = +m[1];
    let pos = null;
    if (m[3] != null) pos = (+m[3]) / 100 * L + (m[4] === '-' ? -1 : 1) * (+m[5]);
    else if (m[6] != null) pos = (+m[6]) / 100 * L;
    stops.push({ a, x: pos == null ? null : pos - pad });
  }
  if (stops.every((s) => s.x == null)) return stops[0].a;   // a flat gradient
  if (x <= stops[0].x) return stops[0].a;
  for (let i = 1; i < stops.length; i++) if (x <= stops[i].x) { const s0 = stops[i - 1], s1 = stops[i]; const f = s1.x > s0.x ? (x - s0.x) / (s1.x - s0.x) : 1; return s0.a + (s1.a - s0.a) * f; }
  return stops[stops.length - 1].a;
}
// the canvas's alpha at bar x: n columns scaled to W, bilinear between column centres, the edges clamped
function canvasAlphaAt(q, x, Wbar) {
  const N = q.length, u = x / Wbar * N - 0.5, c0 = Math.floor(u), f = u - c0;
  const at = (c) => q[Math.max(0, Math.min(N - 1, c))] / 255;
  return at(c0) * (1 - f) + at(c0 + 1) * f;
}
function maskMatches(cover, pad, Wbar) {
  const r = P.glassMask(cover, cover.length, null, pad);
  let worst = 0;
  for (let x = 0; x <= Wbar; x += 0.5) worst = Math.max(worst, Math.abs(maskAt(r.mask, x, Wbar, pad) - (1 - canvasAlphaAt(r.q, x, Wbar))));
  return { r, worst };
}
{
  const cover = [0, 0, 0, 1, 1, 1, 1, 0, 0];
  const r = P.glassMask(cover, cover.length, null, 0);
  check('mask: runs: a stop at the first and last centre of each run (6 for 3 runs)', r.stops === 6 && (r.mask.match(/rgba/g) || []).length === 6, r.mask);
  check('mask: the glass where no window is (1), clear where one is (0)', /^linear-gradient\(to right, rgba\(0,0,0,1\) 5.5556%, rgba\(0,0,0,1\) 27.7778%, rgba\(0,0,0,0\) 38.8889%, rgba\(0,0,0,0\) 72.2222%, rgba\(0,0,0,1\) 83.3333%, rgba\(0,0,0,1\) 94.4444%\)$/.test(r.mask), r.mask);
  const e = [1, 1, 1, 0.4, 0, 0, 0];
  const r2 = P.glassMask(e, e.length, null, 0);
  check('mask: change points: a window edge with one fractional column is 5 stops', r2.stops === 5 && /rgba\(0,0,0,0\.6\)/.test(r2.mask), r2.mask);
}
for (const [name, cover] of [
  ['two windows and the desktop between', fill(0).map((v, c) => (c < 100 ? 1 : c === 100 ? 0.4 : c < 160 ? 0 : c === 160 ? 0.7 : 1))],
  ['a window in the middle', fill(0).map((v, c) => (c >= 60 && c < 180 ? 1 : 0))],
  ['random covers', fill(0).map(() => (rnd() < 0.3 ? 0 : rnd() < 0.5 ? 1 : Math.round(rnd() * 100) / 100))],
  ['a capture-blocking window (main set its cover to 0) inside a covered row', fill(1).map((v, c) => (c >= 90 && c < 130 ? 0 : 1))],
]) {
  for (const pad of [0, P.MASK_PAD]) {
    const { r, worst } = maskMatches(cover, pad, W);
    check(`mask (${name}, pad ${pad}): 1 - the canvas's bilinear alpha at every half px (from the CSS string itself)`, worst < 1e-3, worst);
    if (name === 'random covers' && pad === 0) console.log(`info: random covers: ${r.stops} stops for ${n} columns, ${r.mask.length} chars`);
  }
}
{
  const blocked = fill(1).map((v, c) => (c >= 90 && c < 130 ? 0 : 1));
  const r = P.glassMask(blocked, n, null, P.MASK_PAD);
  check('mask: blocked columns keep the glass (mask 1 across them), the rest clear', [92, 100, 110, 127].every((c) => maskAt(r.mask, (c + 0.5) * W / n, W, P.MASK_PAD) === 1) && [10, 80, 140, 230].every((c) => maskAt(r.mask, (c + 0.5) * W / n, W, P.MASK_PAD) === 0), r.mask);
  const full = P.glassMask(fill(1), n, null, P.MASK_PAD);
  check('mask: a full cover: no glass anywhere (one clear gradient), full: true', full.full === true && full.none === false && full.mask === 'linear-gradient(rgba(0,0,0,0), rgba(0,0,0,0))' && [0, 500, 1919].every((x) => maskAt(full.mask, x, W, 4) === 0), full);
  const none = P.glassMask(fill(0), n, null, P.MASK_PAD);
  check('mask: no window anywhere: mask none (the glass whole), none: true', none.none === true && none.full === false && none.mask === 'none');
  const a = P.glassMask(blocked, n, null, P.MASK_PAD);
  check('mask: the same cover (a new array) gives back the SAME object: no style write', P.glassMask(blocked.slice(), n, a, P.MASK_PAD) === a);
  const nudged = blocked.slice(); nudged[5] = 0.9999;
  check('mask: a change below one 8-bit step is the same cover (same object)', P.glassMask(nudged, n, a, P.MASK_PAD) === a);
  const moved = blocked.slice(); moved[130] = 0;
  const b = P.glassMask(moved, n, a, P.MASK_PAD);
  check('mask: a real change gives a new object and a new mask', b !== a && b.mask !== a.mask);
  check('mask: a different pad is a new mask', P.glassMask(blocked, n, a, 0) !== a);
  check('mask: the overhang changes the string, not where the stops land on the bar', maskMatches(moved, 4, W).worst < 1e-3 && maskMatches(moved, 4, 1366).worst < 1e-3);
  const t0 = process.hrtime.bigint();
  let r2 = a;
  for (let i = 0; i < 2000; i++) r2 = P.glassMask(blocked, n, r2, P.MASK_PAD);
  const us = Number(process.hrtime.bigint() - t0) / 1000 / 2000;
  const t1 = process.hrtime.bigint();
  for (let i = 0; i < 2000; i++) P.glassMask(i % 2 ? blocked : moved, n, null, P.MASK_PAD);
  const us2 = Number(process.hrtime.bigint() - t1) / 1000 / 2000;
  console.log(`info: glassMask per push: ${us.toFixed(1)} us unchanged (a compare), ${us2.toFixed(1)} us when the cover changed (the string built), n = ${n}`);
  check('mask: an unchanged cover costs a compare (< 50 us)', us < 50, us);
}

for (const f of failures) console.log('FAIL ' + f);
console.log(`TOPBAR UNDER NATIVE: ${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
