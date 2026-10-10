/* glass-adapt.test.js : node ui/shared/glass-adapt.test.js
 * The adaptive brightness under dark glass (glass-adapt.js): it must keep the ink readable over a
 * white page, leave a dark or mid-tone wallpaper at full strength, ignore a lone bright pixel, and
 * never answer more than the photograph's own brightness. Pure maths, no browser. */
'use strict';
const assert = require('assert');
const G = require('./glass-adapt.js');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('ok   ' + name); } catch (e) { fail++; console.log('FAIL ' + name + ': ' + e.message); }
}
const L = (hex) => { const c = G.parseColor(hex); return G.lum(c.r, c.g, c.b); };
const INK2 = L('#C4C7CE');                         // dark --lg-ink-2
const TINT = G.parseColor('rgba(30,31,34,.34)');   // dark --lg-fill
function flat(w, h, rgb) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { data[i * 4] = rgb[0]; data[i * 4 + 1] = rgb[1]; data[i * 4 + 2] = rgb[2]; data[i * 4 + 3] = 255; }
  return { data, width: w, height: h };
}

t('parseColor reads rgba(), rgb() with slash alpha and #hex', () => {
  assert.deepStrictEqual(G.parseColor('rgba(30, 31, 34, 0.34)'), { r: 30, g: 31, b: 34, a: 0.34 });
  assert.deepStrictEqual(G.parseColor('rgb(1 2 3 / 50%)'), { r: 1, g: 2, b: 3, a: 0.5 });
  assert.deepStrictEqual(G.parseColor('#C4C7CE'), { r: 196, g: 199, b: 206, a: 1 });
  assert.strictEqual(G.parseColor('transparent'), null);
});

t('tokenBrightness reads the number in --lg-blur, 1 without one', () => {
  assert.strictEqual(G.tokenBrightness('blur(12px) saturate(140%) brightness(.86)'), 0.86);
  assert.strictEqual(G.tokenBrightness('blur(12px) saturate(150%)'), 1);
});

t('a white page: the glass darkens until ink-2 clears 4.5:1, and no further', () => {
  const r = G.adaptFor(flat(40, 10, [255, 255, 255]), { tint: TINT, ink: INK2, target: 4.5, token: 0.86 });
  assert.ok(r.contrast >= 4.5, 'contrast ' + r.contrast);
  assert.ok(r.contrast < 4.9, 'over-darkened: ' + r.contrast);
  assert.ok(r.k > 0.35 && r.k < 0.5, 'k ' + r.k);
});

t('a dark or mid-tone wallpaper: full strength (k = 1), adapt = 1 / token', () => {
  for (const v of [20, 60, 90]) {
    const r = G.adaptFor(flat(40, 10, [v, v + 10, v + 12]), { tint: TINT, ink: INK2, target: 4.5, token: 0.86 });
    assert.strictEqual(r.k, 1, 'v=' + v + ' k=' + r.k);
    assert.ok(Math.abs(r.adapt * 0.86 - 1) < 0.02, 'adapt ' + r.adapt);
  }
});

t('hi caps the answer: never brighter than asked', () => {
  const r = G.adaptFor(flat(8, 8, [10, 10, 10]), { tint: TINT, ink: INK2, target: 4.5, token: 0.86, hi: 0.86 });
  assert.ok(r.adapt <= 1.0001, 'adapt ' + r.adapt);
});

t('a lone white pixel in a dark picture does not count; a white window-sized block does', () => {
  const img = flat(64, 16, [25, 28, 32]);
  const put = (x, y) => { const i = (y * 64 + x) * 4; img.data[i] = img.data[i + 1] = img.data[i + 2] = 255; };
  put(10, 5);
  const one = G.adaptFor(img, { tint: TINT, ink: INK2, target: 4.5, token: 0.86, cell: 6 });
  assert.strictEqual(one.k, 1, 'one pixel moved k to ' + one.k);
  for (let y = 0; y < 16; y++) for (let x = 30; x < 50; x++) put(x, y);
  const block = G.adaptFor(img, { tint: TINT, ink: INK2, target: 4.5, token: 0.86, cell: 6 });
  assert.ok(block.k < 0.6, 'a white block left k at ' + block.k);
  assert.ok(block.contrast >= 4.5, 'contrast ' + block.contrast);
});

t('rounding never costs the contrast that was solved for', () => {
  for (let v = 120; v <= 255; v += 5) {
    const r = G.adaptFor(flat(8, 8, [v, v, v]), { tint: TINT, ink: INK2, target: 4.5, token: 0.86 });
    assert.ok(r.contrast >= 4.5, 'v=' + v + ' contrast ' + r.contrast);
  }
});

t('rect: only the part of the picture under the surface counts', () => {
  const img = flat(64, 16, [20, 22, 25]);
  for (let y = 0; y < 16; y++) for (let x = 40; x < 64; x++) { const i = (y * 64 + x) * 4; img.data[i] = img.data[i + 1] = img.data[i + 2] = 255; }
  const left = G.adaptFor(img, { tint: TINT, ink: INK2, target: 4.5, token: 0.86, cell: 4, rect: { x: 0, y: 0, w: 32, h: 16 } });
  const all = G.adaptFor(img, { tint: TINT, ink: INK2, target: 4.5, token: 0.86, cell: 4 });
  assert.strictEqual(left.k, 1, 'the dark half alone should be full strength, got ' + left.k);
  assert.ok(all.k < 0.6, 'the whole picture includes the white half, got ' + all.k);
});

t('inks: every ink listed is kept, so the strictest one decides', () => {
  const INK3 = L('#8E94A0');
  const one = G.adaptFor(flat(8, 8, [200, 200, 200]), { tint: TINT, ink: INK2, target: 4.5, token: 0.86 });
  const two = G.adaptFor(flat(8, 8, [200, 200, 200]), { tint: TINT, inks: [{ ink: INK2, target: 4.5 }, { ink: INK3, target: 4.5 }], token: 0.86 });
  assert.ok(two.k < one.k, 'ink-3 at 4.5 must darken further: ' + two.k + ' vs ' + one.k);
  assert.ok(two.contrast >= 4.5, 'worst contrast ' + two.contrast);
});

t('unreadable input says so with null, never a guess', () => {
  assert.strictEqual(G.adaptFor(null, { tint: TINT, ink: INK2 }), null);
  assert.strictEqual(G.adaptFor(flat(4, 4, [0, 0, 0]), { tint: 'nonsense', ink: INK2 }), null);
});

/* THE ONE READABILITY GUARD (lane same-bars, 2026-10-09, FINAL RULES = Helm's values): the shared
   rule every surface uses. It thickens the TINT (never dims the picture), floors at the surface's own
   token, keeps --lg-ink-2 at 4.5:1 over the brightest blurred pixel, and is the top bar's code. */
const fakeCS = (vars) => ({ getPropertyValue: (n) => vars[n] || '' });
const DARK = fakeCS({ '--lg-fill': 'rgba(19,20,21,.83)', '--lg-fill-bar': 'rgba(12,13,14,.75)', '--lg-fill-pop': 'rgba(19,20,21,.83)',
  '--lg-ink-2': '#a9aaa7', '--lg-blur': 'blur(5px)' });
const BAR = G.guardTokens(DARK, { bar: true }), PANEL = G.guardTokens(DARK);
t('guardTokens: a bar floors at --lg-fill-bar, a panel at --lg-fill; the ceiling is --lg-fill-pop; the blur is the token', () => {
  assert.deepStrictEqual(BAR.fill, { r: 12, g: 13, b: 14, a: 0.75 });
  assert.deepStrictEqual(PANEL.fill, { r: 19, g: 20, b: 21, a: 0.83 });
  assert.strictEqual(BAR.ceil, 0.83);
  assert.deepStrictEqual(BAR.filter, { blur: 5, saturate: 1, brightness: 1 });
});
t('guard: over a dark picture it stays out, the tint is the token exactly', () => {
  const r = G.guard(flat(40, 10, [40, 70, 80]), { tokens: BAR, picPerCss: 0.3 });
  assert.strictEqual(r.engaged, false); assert.strictEqual(r.alpha, 0.75); assert.strictEqual(r.tint, 'rgba(12,13,14,0.75)');
  assert.ok(r.ratio >= 4.5, r.ratio);
});
t('guard: over white the BAR tint thickens (same colour) to the thinnest alpha that holds ink-2 at 4.5:1', () => {
  const r = G.guard(flat(40, 10, [255, 255, 255]), { tokens: BAR, picPerCss: 0.3 });
  assert.strictEqual(r.engaged, true); assert.ok(r.alpha > 0.75 && r.alpha <= 0.83, r.alpha); assert.ok(r.ratio >= 4.5, r.ratio);
  const thinner = G.guard(flat(40, 10, [255, 255, 255]), { tokens: Object.assign({}, BAR, { ceil: r.alpha - 0.02 }), picPerCss: 0.3 });
  assert.ok(thinner.ratio < 4.5, 'one step thinner would not hold: ' + thinner.ratio);
  assert.ok(/^rgba\(12,13,14,0\.\d+\)$/.test(r.tint), r.tint);
});
/* --lg-guard-bar (dark, 2026-10-10): the BARS accept Helm's own strip contrast (4.2) before thickening,
   so over Owen's snow-peak sky the top bar is Helm's .50 exactly; panels and light keep 4.7. */
const DARK_HELM = fakeCS({ '--lg-fill': 'rgba(19,20,21,.83)', '--lg-fill-bar': 'rgba(9,10,11,.50)', '--lg-fill-pop': 'rgba(19,20,21,.88)',
  '--lg-ink-2': '#a9aaa7', '--lg-blur': 'blur(5px)', '--lg-guard-bar': '4.2' });
t('--lg-guard-bar: a bar takes its need from the token; a panel, and a theme without it, keep GUARD.need', () => {
  assert.strictEqual(G.guardTokens(DARK_HELM, { bar: true }).need, 4.2);
  assert.strictEqual(G.guardTokens(DARK_HELM).need, G.GUARD.need);
  assert.strictEqual(BAR.need, G.GUARD.need);
  assert.strictEqual(G.guardTokens(fakeCS({ '--lg-guard-bar': 'nonsense', '--lg-fill-bar': 'rgba(9,10,11,.50)' }), { bar: true }).need, G.GUARD.need);
});
t('--lg-guard-bar: over the snow-peak sky (4.3:1 at .50) the bar stays at Helm\'s .50; at 4.7 it thickened to .56', () => {
  const sky = flat(40, 10, [82, 130, 138]);   // the brightest blurred sky under the top bar: 4.3:1 at .50
  const helm = G.guard(sky, { tokens: G.guardTokens(DARK_HELM, { bar: true }), picPerCss: 0.25 });
  assert.strictEqual(helm.engaged, false); assert.strictEqual(helm.alpha, 0.5); assert.ok(helm.ratio >= 4.2 && helm.ratio < 4.7, helm.ratio);
  const old = G.guard(sky, { tokens: Object.assign({}, G.guardTokens(DARK_HELM, { bar: true }), { need: 4.7 }), picPerCss: 0.25 });
  assert.strictEqual(old.alpha, 0.56);
});
t('--lg-guard-bar: over white a bar still thickens, to the thinnest alpha holding ink-2 at 4.2:1', () => {
  const T = G.guardTokens(DARK_HELM, { bar: true });
  const r = G.guard(flat(40, 10, [255, 255, 255]), { tokens: T, picPerCss: 0.25 });
  assert.strictEqual(r.engaged, true); assert.ok(r.ratio >= 4.2, r.ratio);
  const thinner = G.guard(flat(40, 10, [255, 255, 255]), { tokens: Object.assign({}, T, { ceil: r.alpha - 0.02 }), picPerCss: 0.25 });
  assert.ok(thinner.ratio < 4.2, 'one step thinner would not hold: ' + thinner.ratio);
});
t('guard: a panel at --lg-fill (.83) already holds ink-2 over white, so it never thickens', () => {
  const r = G.guard(flat(40, 10, [255, 255, 255]), { tokens: PANEL, picPerCss: 0.3 });
  assert.strictEqual(r.engaged, false); assert.strictEqual(r.alpha, 0.83); assert.ok(r.ratio >= 4.5, r.ratio);
});
t('guardRect judges only the part under the surface, after blurring the whole picture once', () => {
  const img = flat(40, 20, [30, 40, 45]);
  for (let y = 0; y < 20; y++) for (let x = 30; x < 40; x++) { const i = (y * 40 + x) * 4; img.data[i] = img.data[i + 1] = img.data[i + 2] = 255; }
  const pic = G.glassPicture(img, BAR, 0.3);
  assert.strictEqual(G.guardRect(pic, BAR, { x: 0, y: 0, w: 15, h: 20 }).engaged, false);
  assert.strictEqual(G.guardRect(pic, BAR, { x: 28, y: 0, w: 12, h: 20 }).engaged, true);
  assert.strictEqual(G.guardRect(pic, BAR, { x: 50, y: 0, w: 5, h: 5 }), null);
});
t('the top bar runs THIS code (ui/topbar/glass.js delegates, same functions)', () => {
  const M = require('../topbar/glass.js');
  assert.strictEqual(M.glassTint, G.glassTint); assert.strictEqual(M.glassPixels, G.glassPixels); assert.strictEqual(M.glassSettle, G.glassSettle);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
