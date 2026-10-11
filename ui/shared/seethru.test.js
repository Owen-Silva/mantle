require('C:/Users/user/dev-tools/tools/lowcpu.js');
/* seethru.test.js - every dark pop-up shows the WALLPAPER lined up under Helm's panel tint (lane
 * mantle-seethru-popups, 2026-10-10).
 *
 * Owen: "this needs to be see through the same as everything else", then "Match Helm's panels". Helm's
 * panel on screen is its photo blurred 5px under ~.83 of dark; Mantle's dark glass is the same when each
 * surface shows the wallpaper still (lib/wall-still.js) cut at ITS OWN screen rectangle, blurred with
 * --lg-blur (5px), under ONE --lg-fill layer (rgba(19,20,21,.83)).
 *
 * WHAT: headless Chromium over the REAL pages at 1.25x (file://, never Electron, never a window of
 * Owen's). A known still (bright and dark blocks over gradients: a picture off by a pixel shows) is cut
 * with the REAL lib/wall-still.js resample + encoder exactly as main cuts it for that surface (the HUDs'
 * window rectangle as `<key>.backdrop` {png, at, win}, the launcher's window rectangle, the switcher's
 * panel + 14 overscan, task view's whole still + its origin, the top bar's menu picture), handed to the
 * page as main would, and the pane's pixels are compared with the prediction
 *     out = .83 * (19,20,21) + .17 * G5(still at that screen pixel)
 * away from the hairline and lip (4 CSS px in) with the content hidden. Also: the dark fill tokens are
 * Helm's panel (--lg-fill-pop / --lg-fill-fb = --lg-fill), the no-picture faces are that alpha, and
 * light keeps its own tokens and the launcher's <img> path.
 *
 *   node ui/shared/seethru.test.js     -> "SEE-THROUGH TEST: n passed, m failed"
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const H = require('../bar/page-harness.js');
const WS = require('../../lib/wall-still.js');
const t = H.suite('SEE-THROUGH TEST');
const UI = 'file:///' + path.resolve(__dirname, '..').replace(/\\/g, '/') + '/';

const SF = 1.25, PW = 1920, PH = 1080, SW = 768, SH = 432;   // a 1536x864 DIP display; the still = DIP / 2
const FILL = [19, 20, 21], A = 0.83;
const MAX_ERR = 4, MEAN_ERR = 1.5;                            // levels of 255 (8-bit rounding + resampling)

/* ---- the still, main's cut of it, and the prediction ---------------------------------------- */
function makeStill() {
  const b = Buffer.alloc(SW * SH * 4);
  for (let y = 0; y < SH; y++) for (let x = 0; x < SW; x++) {
    let r = 30 + 190 * x / SW, g = 40 + 160 * y / SH, bl = 120 + 70 * Math.sin(x / 37) * Math.cos(y / 29);
    const cx = Math.floor(x / 24), cy = Math.floor(y / 24);
    if ((cx + cy) % 3 === 0) { r = 245; g = 240; bl = 230; } else if ((cx * 7 + cy * 3) % 5 === 0) { r = 10; g = 12; bl = 20; }
    const o = (y * SW + x) * 4;
    b[o] = Math.round(bl); b[o + 1] = Math.round(g); b[o + 2] = Math.round(r); b[o + 3] = 255;   // BGRA
  }
  return b;
}
const BMP = makeStill();
const STILL_PNG = WS.encodePng(BMP, SW, SH);
function cut(phys) {    // lib/wall-still.js rect(): the still's own pitch, bilinear at the exact rectangle
  const got = WS.clip(phys, { x: 0, y: 0, w: PW, h: PH });
  const fx = SW / PW, fy = SH / PH, ow = Math.max(1, Math.round(got.w * fx)), oh = Math.max(1, Math.round(got.h * fy));
  return { png: WS.encodePng(WS.resample(BMP, SW, SH, got.x * fx, got.y * fy, got.w * fx, got.h * fy, ow, oh), ow, oh), w: ow, h: oh, rect: got };
}
/* G5: the continuous still (bilinear, edge clamped) on the device-px grid, gaussian sigma 5 DIP */
function blurred() {
  const sig = 5 * SF, R = Math.ceil(sig * 3.5), k = new Float64Array(2 * R + 1);
  let s = 0;
  for (let i = -R; i <= R; i++) { k[i + R] = Math.exp(-(i * i) / (2 * sig * sig)); s += k[i + R]; }
  for (let i = 0; i < k.length; i++) k[i] /= s;
  const Ag = new Float32Array(PW * PH * 3), T = new Float32Array(PW * PH * 3), B = new Float32Array(PW * PH * 3);
  for (let j = 0; j < PH; j++) {
    let fy = (j + 0.5) * SH / PH - 0.5; fy = Math.max(0, Math.min(SH - 1, fy));
    const y0 = Math.floor(fy), y1 = Math.min(SH - 1, y0 + 1), ty = fy - y0;
    for (let i = 0; i < PW; i++) {
      let fx = (i + 0.5) * SW / PW - 0.5; fx = Math.max(0, Math.min(SW - 1, fx));
      const x0 = Math.floor(fx), x1 = Math.min(SW - 1, x0 + 1), tx = fx - x0;
      for (let c = 0; c < 3; c++) {
        const ch = 2 - c, a = BMP[(y0 * SW + x0) * 4 + ch], b = BMP[(y0 * SW + x1) * 4 + ch], cc = BMP[(y1 * SW + x0) * 4 + ch], d = BMP[(y1 * SW + x1) * 4 + ch];
        const top = a + (b - a) * tx, bot = cc + (d - cc) * tx;
        Ag[(j * PW + i) * 3 + c] = top + (bot - top) * ty;
      }
    }
  }
  for (let j = 0; j < PH; j++) for (let i = 0; i < PW; i++) for (let c = 0; c < 3; c++) {
    let v = 0; for (let q = -R; q <= R; q++) v += k[q + R] * Ag[(j * PW + Math.max(0, Math.min(PW - 1, i + q))) * 3 + c];
    T[(j * PW + i) * 3 + c] = v;
  }
  for (let j = 0; j < PH; j++) for (let i = 0; i < PW; i++) for (let c = 0; c < 3; c++) {
    let v = 0; for (let q = -R; q <= R; q++) v += k[q + R] * T[(Math.max(0, Math.min(PH - 1, j + q)) * PW + i) * 3 + c];
    B[(j * PW + i) * 3 + c] = v;
  }
  return (x, y, c) => B[(Math.max(0, Math.min(PH - 1, y)) * PW + Math.max(0, Math.min(PW - 1, x))) * 3 + c];
}

function decodePng(buf) {
  let p = 8, w = 0, h = 0, ct = 0; const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('ascii', p + 4, p + 8), d = buf.slice(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); ct = d[9]; } else if (type === 'IDAT') idat.push(d); else if (type === 'IEND') break;
    p += 12 + len;
  }
  const bpp = ct === 6 ? 4 : 3, raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * bpp, px = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = raw.slice(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[y * stride + x - bpp] : 0, b = y ? px[(y - 1) * stride + x] : 0, c = (x >= bpp && y) ? px[(y - 1) * stride + x - bpp] : 0;
      let v = src[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c); }
      px[y * stride + x] = v & 255;
    }
  }
  return { w, h, at: (x, y) => { const i = y * stride + x * bpp; return [px[i], px[i + 1], px[i + 2], bpp === 4 ? px[i + 3] : 255]; } };
}

/* ---- the page side: a bridge that records listeners (the page's own mock still answers the rest) */
const INIT = `(function () {
  var L = {}, real = null;
  window.__over = {};
  window.__emit = function (n, p) { (L[n] || []).slice().forEach(function (f) { f(p); }); };
  function wrap(m) {
    if (!m || m.__wrapped) return m;
    var on0 = m.on, call0 = m.call;
    m.on = function (n, f) { (L[n] = L[n] || []).push(f); return on0 ? on0.apply(this, arguments) : function () {}; };
    m.call = function (ch) {
      if (Object.prototype.hasOwnProperty.call(window.__over, ch)) return Promise.resolve(window.__over[ch]);
      if (ch === 'hud.backdrop') return Promise.resolve({ ok: true });   // the picture comes as <key>.backdrop below
      return call0 ? call0.apply(this, arguments) : Promise.resolve(undefined);
    };
    m.__wrapped = true; return m;
  }
  Object.defineProperty(window, 'mantle', { configurable: true, get: function () { return real; }, set: function (v) { real = wrap(v); } });
  if (/\\/(layouts|ontop)\\/index\\.html/.test(location.pathname)) real = wrap({ on: function () { return function () {}; }, call: function () { return Promise.resolve(undefined); } });
})();`;
/* show the pane, hide everything that is not the pane or its picture, stop the pages' hide timers */
function isolate(sel) {
  for (let ti = 1; ti < 20000; ti++) clearTimeout(ti);
  const e = document.querySelector(sel);
  if (!e) return null;
  for (let u = e; u && u !== document.documentElement; u = u.parentElement) { if (u.hidden) u.hidden = false; u.classList.remove('fading', 'hud-hold'); }
  for (const d of ['opacity:1', 'transition:none', 'animation:none']) { const kv = d.split(':'); e.style.setProperty(kv[0], kv[1], 'important'); }
  if (document.querySelector('#q')) e.style.setProperty('transform', 'none', 'important');   // the launcher's open scale, settled
  for (const el of document.body.querySelectorAll('*')) if (el !== e && !el.closest('.bdrop') && !el.closest('#wall-bdrop') && !el.contains(e)) el.style.setProperty('visibility', 'hidden', 'important');
  const b = e.getBoundingClientRect(), cs = getComputedStyle(e);
  const hb = window.__hudBackdrop, wb = window.MantleWallBdrop, lw = window.__launcherWall, sw = document.querySelector('#bdrop.on canvas, .bdrop.on canvas');
  return { rect: { x: b.left, y: b.top, w: b.width, h: b.height }, radius: parseFloat(cs.borderTopLeftRadius) || 0,
    picture: hb ? hb.state === 'on' : wb ? wb.state === 'on' : lw ? lw.bakes > 0 : sel === '.dd' ? /\bglass\b/.test(e.className) : !!(sw && sw.width) };
}

const HUD = (name, page, key, sel, win, show, setup) => ({ name, page, kind: 'hud', key, sel, win, show, setup });
const SURF = [
  HUD('volume/brightness OSD', 'osd/index.html', 'osd', '#osd', [600, 680, 336, 100], ['osd.show', { kind: 'volume', state: { level: 40, muted: false } }]),
  HUD('clipboard (Win+V)', 'clipboard/index.html?n=0', 'clipboard', '#panel', [1100, 300, 396, 496]),
  HUD('layouts toast', 'layouts/index.html', 'layouts', '#t', [556, 120, 460, 92], ['layouts.toast', { text: 'Layout applied: Coding', undo: true }]),
  HUD('on-top toast', 'ontop/index.html', 'ontop', '#t', [616, 200, 336, 84], ['ontop.toast', { text: 'Always on top' }]),
  HUD('timer card', 'timer/index.html', 'timer', '#card', [1180, 28, 344, 132], ['timer.done', { label: 'Tea', id: 1 }]),
  HUD('notes pad', 'notes/index.html', 'notes', '#pad', [400, 28, 412, 394]),
  HUD('snap picker', 'snap/index.html?bg=0', 'snap', '#panel', [584, 300, 400, 268], null, "document.body.classList.add('mode-picker')"),
  HUD('screenshot card', 'screenshot/card.html', 'screenshot.card', '#card', [1100, 700, 396, 121], ['screenshot.card', { path: 'C:/x.png', w: 100, h: 60 }]),
  { name: 'launcher', page: 'launcher/index.html', kind: 'launcher', sel: '.panel', win: [428, 160, 680, 460] },
  { name: 'switcher', page: 'switcher/index.html?n=3&blur=0&bg=0', kind: 'switcher', sel: '.panel', win: [300, 300, 900, 300] },
  { name: 'task view', page: 'taskview/index.html', kind: 'taskview', sel: 'body', win: [0, 0, 1536, 864] },
  { name: 'top bar dropdown', page: 'topbar/index.html', kind: 'topbar', sel: '.dd', win: [0, 0, 1536, 400] },
];

async function surface(browser, G, s) {
  const [wx, wy, ww, wh] = s.win;
  const phys = { x: Math.round(wx * SF), y: Math.round(wy * SF), w: Math.round(ww * SF), h: Math.round(wh * SF) };
  const ctx = await browser.newContext({ colorScheme: 'dark', deviceScaleFactor: SF, viewport: { width: ww, height: wh } });
  try {
    const page = await ctx.newPage();
    await page.addInitScript(INIT);
    if (s.kind === 'topbar') {
      const c = cut({ x: 0, y: 0, w: phys.w, h: Math.round(816 * SF) });
      await page.addInitScript(`window.__over['glass.topbarMenu'] = ${JSON.stringify({ ok: true, png: c.png, w: c.w, h: c.h, at: { x: 0, y: 0, w: 1536, h: 816 }, ms: 1, source: 'mantle' })};`);
    }
    await page.goto(UI + s.page, { waitUntil: 'load' });
    await page.waitForTimeout(500);
    await page.evaluate((setup) => {
      document.documentElement.setAttribute('data-theme', 'dark');
      window.dispatchEvent(new CustomEvent('mantle-theme', { detail: { theme: 'dark' } }));
      if (setup) (0, eval)(setup);
    }, s.setup || '');
    await page.waitForTimeout(250);
    if (s.show) await page.evaluate(([n, p]) => window.__emit(n, p), s.show);
    if (s.kind === 'topbar') await page.evaluate(() => { const ti = document.querySelector('[data-i="0"]'); if (ti) ti.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })); });
    await page.evaluate((sel) => { const e = document.querySelector(sel); for (let u = e; u && u !== document.documentElement; u = u.parentElement) if (u.hidden) u.hidden = false; document.body.classList.add('up'); }, s.sel);
    await page.waitForTimeout(350);
    // main's payload for this surface
    if (s.kind === 'hud') {
      const c = cut(phys);
      const at = { x: (c.rect.x - phys.x) / phys.w, y: (c.rect.y - phys.y) / phys.h, w: c.rect.w / phys.w, h: c.rect.h / phys.h };
      await page.evaluate(([k, p]) => window.__emit(k + '.backdrop', p), [s.key, { png: c.png, w: c.w, h: c.h, at, win: { w: ww, h: wh }, ms: 1, source: 'mantle' }]);
    } else if (s.kind === 'launcher') {
      const c = cut(phys);
      await page.evaluate((p) => window.__emit('launcher.backdrop', p), { png: c.png, w: c.w, h: c.h, rect: c.rect, ms: 1, source: 'mantle' });
    } else if (s.kind === 'taskview') {
      await page.evaluate((p) => window.__emit('taskview.wall', p), { ok: true, png: STILL_PNG, w: SW, h: SH, display: { x: 0, y: 0, width: 1536, height: 864 }, key: 'k1', source: 'mantle' });
      await page.waitForTimeout(250);
      await page.evaluate(([x, y]) => window.MantleWallBdrop && window.MantleWallBdrop.at(x, y), [wx, wy]);
    } else if (s.kind === 'switcher') {
      const r = await page.$eval(s.sel, (e) => { const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; }).catch(() => null);
      if (r) {   // lib/switcher.js captureBackdrop: the panel + OVERSCAN (14 DIP) a side
        const c = cut({ x: Math.round((wx + r.x - 14) * SF), y: Math.round((wy + r.y - 14) * SF), w: Math.round((r.w + 28) * SF), h: Math.round((r.h + 28) * SF) });
        await page.evaluate((p) => window.__emit('switcher.backdrop', p), { seq: 1, png: c.png, w: c.w, h: c.h, ms: 1, shown: true, source: 'mantle' });
      }
    }
    await page.waitForTimeout(800);
    const info = await page.evaluate(isolate, s.sel);
    if (!t.check(`${s.name}: the surface is on the page (${s.sel})`, info && info.rect.w > 20 && info.rect.h > 20, info)) return;
    t.check(`${s.name}: shows the wallpaper picture in dark`, info.picture, info);
    const shot = decodePng(await page.screenshot({ omitBackground: true }));
    const r = info.rect, rr = Math.min(info.radius, r.w / 2, r.h / 2);
    let n = 0, sum = 0, max = 0, minA = 255, fn = 0, fd = 0, worst = null;
    for (let j = Math.ceil(r.y * SF); j < Math.floor((r.y + r.h) * SF); j++) for (let i = Math.ceil(r.x * SF); i < Math.floor((r.x + r.w) * SF); i++) {
      const cx = (i + 0.5) / SF, cy = (j + 0.5) / SF;
      const qx = Math.abs(cx - (r.x + r.w / 2)) - (r.w / 2 - rr), qy = Math.abs(cy - (r.y + r.h / 2)) - (r.h / 2 - rr);
      if (-(Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - rr) < 4) continue;   // 4 px in from the rounded edge
      const px = shot.at(i, j);
      let m = 0;
      for (let c = 0; c < 3; c++) {
        const B = G(phys.x + i, phys.y + j, c), e = Math.abs(px[c] - (A * FILL[c] + (1 - A) * B));
        if (e > m) m = e;
        fn += (B - px[c]) * (B - FILL[c]); fd += (B - FILL[c]) * (B - FILL[c]);
      }
      n++; sum += m; if (m > max) { max = m; worst = { x: cx, y: cy, got: px.slice(0, 3) }; }
      if (px[3] < minA) minA = px[3];
    }
    const mean = n ? sum / n : Infinity, alpha = fd ? fn / fd : NaN;
    const d = { n, mean: +mean.toFixed(2), max: +max.toFixed(2), alpha: +alpha.toFixed(3), worst };
    t.check(`${s.name}: the picture is the still cut at its own screen rectangle, blurred 5px (max error <= ${MAX_ERR}, mean <= ${MEAN_ERR} of 255)`, n > 500 && max <= MAX_ERR && mean <= MEAN_ERR, d);
    t.check(`${s.name}: the tint over it is Helm's panel, .83 (fitted ${d.alpha})`, Math.abs(alpha - A) <= 0.01, d);
    t.check(`${s.name}: opaque inside its edge (nothing of the screen behind leaks through)`, minA === 255, { minA });
  } finally { await ctx.close(); }
}

/* the dark tokens and the no-picture faces; light untouched */
async function tokens(browser) {
  const ctx = await browser.newContext({ deviceScaleFactor: SF, viewport: { width: 700, height: 480 } });
  try {
    const page = await ctx.newPage();
    await page.goto(UI + 'launcher/index.html', { waitUntil: 'load' });
    await page.waitForTimeout(400);
    const read = (th) => page.evaluate((theme) => {
      if (theme) document.documentElement.setAttribute('data-theme', theme); else document.documentElement.removeAttribute('data-theme');
      const v = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim().replace(/\s+/g, '');
      return { fill: v('--lg-fill'), pop: v('--lg-fill-pop'), fb: v('--lg-fill-fb') };
    }, th);
    const light = await read(null), dark = await read('dark');
    t.check('dark: --lg-fill is Helm\'s panel, rgba(19,20,21,.83)', dark.fill === 'rgba(19,20,21,.83)', dark);
    t.check('dark: --lg-fill-pop (the no-picture face, the guards\' ceiling) = --lg-fill (was .88)', dark.pop === dark.fill, dark);
    t.check('dark: --lg-fill-fb (a failed picture) = --lg-fill (was .86)', dark.fb === dark.fill, dark);
    t.check('light: --lg-fill / -pop / -fb untouched (.45 / .88 / .62 white)', light.fill === 'rgba(255,255,255,.45)' && light.pop === 'rgba(255,255,255,.88)' && light.fb === 'rgba(255,255,255,.62)', light);
  } finally { await ctx.close(); }
}

async function faces(browser) {
  // the faces a surface shows with NO picture: one layer at Helm's panel alpha
  const FACES = [
    ['launcher', 'launcher/index.html', "document.body.classList.add('no-backdrop')", '.panel', '::after', 'backgroundColor'],
    ['switcher', 'switcher/index.html?blur=0', "document.body.classList.add('no-backdrop')", '.panel', '::after', 'backgroundColor'],
    ['OSD', 'osd/index.html', "document.getElementById('osd').hidden = false", '#osd', null, 'backgroundColor'],
    ['top bar dropdown', 'topbar/index.html', "var d = document.createElement('div'); d.className = 'dd'; (document.getElementById('menus') || document.body).appendChild(d)", '.dd', null, 'backgroundColor'],
  ];
  for (const [name, pg, setup, sel, pseudo, prop] of FACES) {
    const ctx = await browser.newContext({ deviceScaleFactor: SF, viewport: { width: 900, height: 500 } });
    try {
      const page = await ctx.newPage();
      await page.goto(UI + pg, { waitUntil: 'load' });
      await page.waitForTimeout(400);
      await page.evaluate(([setup2, sel2]) => {
        document.documentElement.setAttribute('data-theme', 'dark');
        try { (0, eval)(setup2); } catch (_) { /* best effort */ }
        const e = document.querySelector(sel2);
        if (e) e.classList.remove('hud-bd');
      }, [setup, sel]);
      await page.waitForTimeout(800);   // past the faces' own colour transitions (the launcher's ::after eases its fill)
      const got = await page.evaluate(([sel2, ps, pr]) => { const e = document.querySelector(sel2); return e ? getComputedStyle(e, ps)[pr] : null; }, [sel, pseudo, prop]);
      t.check(`${name}: the no-picture face is ONE layer at .83 (Helm's panel)`, /^rgba\(19, 20, 21, 0\.83\)$/.test(String(got)), got);
    } finally { await ctx.close(); }
  }
}

async function launcherLight(browser) {
  // light never builds the canvas and keeps its <img> with the light blur
  const ctx = await browser.newContext({ deviceScaleFactor: SF, viewport: { width: 680, height: 460 } });
  try {
    const page = await ctx.newPage();
    await page.addInitScript(INIT);
    await page.goto(UI + 'launcher/index.html', { waitUntil: 'load' });
    await page.waitForTimeout(400);
    const c = cut({ x: 535, y: 200, w: 850, h: 575 });
    await page.evaluate((p) => { document.documentElement.removeAttribute('data-theme'); window.__emit('launcher.backdrop', p); }, { png: c.png, w: c.w, h: c.h, rect: c.rect, ms: 1 });
    await page.waitForTimeout(500);
    const r = await page.evaluate(() => { const img = document.getElementById('backdrop'), cs = getComputedStyle(img); return { canvas: !!document.querySelector('.bdrop-pic'), display: cs.display, filter: cs.filter, view: window.__launcherWall || null }; });
    t.check('launcher, light: no canvas, the <img> shows with its own light blur', !r.canvas && r.display === 'block' && /blur\(12px\)/.test(r.filter) && !r.view, r);
    // dark then light again: the canvas is emptied, the <img> is back
    const back = await page.evaluate(() => new Promise((res) => {
      document.documentElement.setAttribute('data-theme', 'dark'); window.dispatchEvent(new CustomEvent('mantle-theme'));
      setTimeout(() => {
        const dark = { canvas: (document.querySelector('.bdrop-pic') || {}).width || 0, img: getComputedStyle(document.getElementById('backdrop')).display };
        document.documentElement.removeAttribute('data-theme'); window.dispatchEvent(new CustomEvent('mantle-theme'));
        setTimeout(() => res({ dark, light: { canvas: (document.querySelector('.bdrop-pic') || {}).width || 0, img: getComputedStyle(document.getElementById('backdrop')).display } }), 100);
      }, 200);
    }));
    t.check('launcher: a flip to dark bakes the canvas and hides the <img>; back to light empties it', back.dark.canvas > 0 && back.dark.img === 'none' && back.light.canvas === 0 && back.light.img === 'block', back);
  } finally { await ctx.close(); }
}

async function run() {
  if (H.gaming()) { t.check('SKIPPED: a game is running (the lane rule), nothing was rendered', true); return; }
  const G = blurred();
  await H.withBrowser(async (open) => {
    const pg0 = await open('?mode=pill', { w: 300, h: 100, settle: 50 });
    const browser = pg0.page.context().browser();
    await tokens(browser);
    await faces(browser);
    await launcherLight(browser);
    for (const s of SURF) if (t.want(s.name)) await surface(browser, G, s);
  });
}

run().catch((e) => { t.check('the run finished', false, e && e.stack || String(e)); }).then(() => t.done());
