'use strict';
/*
 * look-guard.test.js -- lib/look-guard.js, the SHARED top-band darkening, under plain node (lane
 * guard-mantle, 2026-10-10). Real photos and Electron's real decoder are in look-guard.e2e.test.js.
 *
 *   node lib/look-guard.test.js
 *
 * Prints "LOOK GUARD TEST: n passed, m failed"; exits 1 on any failure.
 */
const fs = require('fs');
const path = require('path');
const LG = require('./look-guard');
const GA = require('../ui/shared/glass-adapt.js');

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(name + (detail !== undefined ? ' -- ' + String(detail).slice(0, 300) : ''));
}
const J = (v) => JSON.stringify(v);

/* A synthetic "photo": a dark sky with a bright ridge whose top sits `ridgeY` px down, plus one bright
   blob just BELOW the band so the blur's bleed into the band matters. RGBA. */
function photo(w, h, o) {
  o = o || {};
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let v = 40 + Math.round(30 * Math.sin(x / 37) + 20 * Math.cos(y / 11));
      const ridge = (o.ridgeY || 120) + 25 * Math.sin(x / 90);
      if (y > ridge) v = o.bright || 225;
      if (o.blob && Math.hypot(x - o.blob[0], y - o.blob[1]) < 6) v = 255;
      d[i] = v; d[i + 1] = Math.min(255, v + 8); d[i + 2] = Math.min(255, v + 14); d[i + 3] = 255;
    }
  }
  return { data: d, width: w, height: h };
}
function toBgra(rgba) {
  const out = Buffer.alloc(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) { out[i] = rgba[i + 2]; out[i + 1] = rgba[i + 1]; out[i + 2] = rgba[i]; out[i + 3] = rgba[i + 3]; }
  return out;
}
/* A fake nativeImage over an RGBA picture: crop and resize (nearest, exact when the size is unchanged). */
function fakeNI(pic) {
  function wrap(p) {
    return {
      isEmpty: () => !p || !(p.width > 0),
      getSize: () => ({ width: p.width, height: p.height }),
      crop(r) {
        const out = new Uint8ClampedArray(r.width * r.height * 4);
        for (let y = 0; y < r.height; y++) for (let x = 0; x < r.width; x++) {
          const si = ((y + r.y) * p.width + (x + r.x)) * 4, di = (y * r.width + x) * 4;
          for (let c = 0; c < 4; c++) out[di + c] = p.data[si + c];
        }
        return wrap({ data: out, width: r.width, height: r.height });
      },
      resize(s) {
        if (s.width === p.width && s.height === p.height) return wrap(p);
        const out = new Uint8ClampedArray(s.width * s.height * 4);
        for (let y = 0; y < s.height; y++) for (let x = 0; x < s.width; x++) {
          const sx = Math.min(p.width - 1, Math.floor(x * p.width / s.width)), sy = Math.min(p.height - 1, Math.floor(y * p.height / s.height));
          for (let c = 0; c < 4; c++) out[(y * s.width + x) * 4 + c] = p.data[(sy * p.width + sx) * 4 + c];
        }
        return wrap({ data: out, width: s.width, height: s.height });
      },
      toBitmap: () => toBgra(p.data),
    };
  }
  return { createFromBuffer: () => wrap(pic), createFromPath: (f) => (fs.existsSync(f) ? wrap(pic) : wrap(null)) };
}

(async () => {
  /* ---- the constants ARE the dark tokens (glass-light.css) ---- */
  {
    const css = fs.readFileSync(path.join(__dirname, '..', 'ui', 'shared', 'glass-light.css'), 'utf8');
    const at = css.indexOf(':root[data-theme="dark"] {');
    const block = css.slice(at, css.indexOf('\n}', at));
    const tok = (n) => { const m = new RegExp(`${n}:\\s*([^;]+);`).exec(block); return m ? m[1].trim() : null; };
    const ink = GA.parseColor(tok('--lg-ink-2')), bar = GA.parseColor(tok('--lg-fill-bar'));
    check('rule: ink = dark --lg-ink-2', ink && ink.r === LG.RULE.ink.r && ink.g === LG.RULE.ink.g && ink.b === LG.RULE.ink.b, tok('--lg-ink-2'));
    check('rule: need = dark --lg-guard-bar', parseFloat(tok('--lg-guard-bar')) === LG.RULE.need, tok('--lg-guard-bar'));
    check('rule: tint = dark --lg-fill-bar colour', bar && bar.r === LG.RULE.tint.r && bar.g === LG.RULE.tint.g && bar.b === LG.RULE.tint.b, tok('--lg-fill-bar'));
    // dark --lg-fill-pop = var(--lg-fill) (.83, Helm's panel) since lane mantle-seethru-popups (2026-10-10; it was .88).
    // The top band's own ceiling stays .88 (main's rule) and never binds: a WHITE band holds 4.2:1 under .83.
    const popTok = tok('--lg-fill-pop'), popRef = /^var\(\s*(--[\w-]+)\s*\)$/.exec(popTok || ''), pop = GA.parseColor(popRef ? tok(popRef[1]) : popTok);
    check('rule: dark --lg-fill-pop = --lg-fill, Helm panel alpha (.83)', popTok === 'var(--lg-fill)' && pop && pop.a === 0.83, popTok);
    const whiteNeed = GA.glassTint({ px: [255, 255, 255], ink: LG.RULE.ink, tint: LG.RULE.tint, need: LG.RULE.need, floor: 0.5, ceil: LG.RULE.ceil, step: 0.02 });
    check('rule: the ceiling (.88) never binds: a white band holds 4.2:1 at or under --lg-fill-pop', LG.RULE.ceil === 0.88 && pop && !whiteNeed.short && whiteNeed.alpha <= pop.a, J(whiteNeed));
    check('rule: dim .50 seed = --lg-fill-bar alpha', bar && bar.a === 0.5, tok('--lg-fill-bar'));
    check('rule: .02 steps, 100 DIP band', LG.RULE.step === 0.02 && GA.GUARD.step === 0.02 && LG.BAND_DIP === 100);
  }

  /* ---- where the band sits (cover-fit, centred) ---- */
  {
    const g = LG.bandGeometry(1920, 1272, 1536, 864, 5, 144);
    check('geometry: Owen\'s snow-peak still on 1536x864: scale .8', Math.abs(g.scale - 0.8) < 1e-9, g.scale);
    check('geometry: cropped 76.8 DIP down (96 still px), band + 15 rows of blur reach', J(g.src) === J({ x: 0, y: 96, width: 1920, height: 199 }) || J(g.src) === J({ x: 0, y: 96, width: 1920, height: 200 }), J(g.src));
    check('geometry: one picture px per DIP', g.ws === 1 && J(g.out) === J({ w: 1536, h: 159 }) && g.bandRows === 144, J(g));
    const t = LG.bandGeometry(1000, 3000, 1536, 864, 5, 144);
    check('geometry: a tall picture covers the width, centred', Math.abs(t.scale - 1.536) < 1e-9 && t.src.x === 0 && t.src.y === Math.round(((3000 * 1.536 - 864) / 2) / 1.536), J(t));
    const z = LG.bandGeometry(1920, 1080, 1536, 864, 0, 144);
    check('geometry: no blur, no reach', z.out.h === 144 && z.bandRows === 144, J(z.out));
    const b = LG.bandGeometry(1920, 1080, 1536, 864, 40, 144);
    check('geometry: a big blur works on a smaller picture (sigma 8 px)', Math.abs(b.ws - 0.2) < 1e-9 && b.out.w === Math.round(1536 * 0.2) && b.bandRows === Math.round(144 * 0.2), J(b));
    check('geometry: nonsense -> null', LG.bandGeometry(0, 10, 1536, 864, 5) === null && LG.bandGeometry(10, 10, 0, 864, 5) === null);
  }

  /* ---- the SAME alpha as glass-adapt's own guard over the whole picture ---- */
  for (const [name, o] of [['dark sky, bright ridge low', { ridgeY: 150, blob: [700, 152] }], ['ridge in the band', { ridgeY: 120 }], ['bright snow high up', { ridgeY: 40, bright: 250 }], ['all dark', { ridgeY: 2000 }]]) {
    const W = 600, H = 340;
    const pic = photo(W, H, o);
    const T = LG.tokens(0.5, 5);
    const whole = GA.guard(pic, { tokens: T, picPerCss: 1, rect: { x: 0, y: 0, w: W, h: 144 } });
    // only the band + the blur's reach, the way the computer cuts it
    const reach = 144 + Math.ceil(3 * 5);
    const cut = { data: pic.data.slice(0, W * reach * 4), width: W, height: reach };
    const mine = LG.fromPixels(cut, { dim: 0.5, blurPx: 5, ws: 1, bandRows: 144 });
    check(`same as glass-adapt (${name}): alpha ${whole.alpha}`, mine.alpha === whole.alpha && mine.contrast === whole.ratio && mine.short === whole.short, `${J(mine)} vs ${J(whole)}`);
  }
  {
    const dark = LG.fromPixels(photo(400, 160, { ridgeY: 2000 }), { dim: 0.5, blurPx: 5, ws: 1, bandRows: 144 });
    check('a dark band stays at the floor (dim)', dark.alpha === 0.5 && dark.contrast >= 4.2, J(dark));
    const white = { data: new Uint8ClampedArray(400 * 160 * 4).fill(255), width: 400, height: 160 };
    const w = LG.fromPixels(white, { dim: 0.5, blurPx: 5, ws: 1, bandRows: 144 });
    // white: the thinnest step that holds 4.2:1, and the step below it would not
    const onWhite = (a) => GA.contrast(GA.lum(169, 170, 167), GA.lum(255 * (1 - a) + 9 * a, 255 * (1 - a) + 10 * a, 255 * (1 - a) + 11 * a));
    check('a white band darkens to the thinnest step that holds 4.2:1', w.alpha > 0.5 && w.alpha <= 0.88 && !w.short && onWhite(w.alpha) >= 4.2 && onWhite(w.alpha - 0.02) < 4.2, `${J(w)} below: ${onWhite(w.alpha - 0.02)}`);
    const short = LG.fromPixels(white, { dim: 0.5, blurPx: 5, ws: 1, bandRows: 144 });
    check('the ceiling is .88 (glassTint short past it)', GA.glassTint({ px: [255, 255, 255], ink: LG.RULE.ink, tint: LG.RULE.tint, need: 9, floor: 0.5, ceil: LG.RULE.ceil, step: 0.02 }).alpha === 0.88 && short.alpha === w.alpha);
    const hi = LG.fromPixels(photo(400, 160, { ridgeY: 30, bright: 235 }), { dim: 0.5, blurPx: 5, ws: 1, bandRows: 144 });
    check('a bright band darkens in .02 steps, just enough for 4.2:1', hi.alpha > 0.5 && hi.alpha < 0.88 && Math.abs(Math.round((hi.alpha - 0.5) / 0.02) * 0.02 - (hi.alpha - 0.5)) < 1e-9 && hi.contrast >= 4.2, J(hi));
    const lower = LG.fromPixels(photo(400, 160, { ridgeY: 30, bright: 235 }), { dim: 0.7, blurPx: 5, ws: 1, bandRows: 144 });
    check('a higher dim is a higher floor', lower.alpha >= 0.7, J(lower));
  }

  /* ---- the computer: worker thread = same thread = glass-adapt ---- */
  {
    const W = 960, H = 640;   // a 3:2 "still" on a 16:9 monitor, like Owen's
    const pic = photo(W, H, { ridgeY: 130, bright: 230 });
    const mon = [768, 432];
    const inline = LG.makeGuardComputer({ nativeImage: fakeNI(pic), inline: true });
    const worker = LG.makeGuardComputer({ nativeImage: fakeNI(pic) });
    const a = await inline.compute({ jpeg: Buffer.from('x'), monitor: mon, dim: 0.5, blurPx: 5 });
    const b = await worker.compute({ jpeg: Buffer.from('x'), monitor: mon, dim: 0.5, blurPx: 5 });
    check('computer: answers', a.ok && b.ok, J([a, b]));
    check('computer: the worker thread gives the same guard', J(a.guard) === J(b.guard), `${J(a.guard)} vs ${J(b.guard)}`);
    // the same displayed picture, whole, through glass-adapt's guard()
    const g = LG.bandGeometry(W, H, mon[0], mon[1], 5, mon[1]);
    const full = fakeNI(pic).createFromBuffer().crop(g.src).resize({ width: g.out.w, height: g.out.h });
    const fs2 = full.getSize();
    const whole = GA.guard({ data: LG.bgraToRgba(full.toBitmap()), width: fs2.width, height: fs2.height }, { tokens: LG.tokens(0.5, 5), picPerCss: 1, rect: { x: 0, y: 0, w: fs2.width, h: LG.BAND_DIP } });
    check('computer: = glass-adapt guard() over the whole displayed picture', b.guard.dark.alpha === whole.alpha && b.guard.dark.contrast === whole.ratio, `${J(b.guard.dark)} vs ${J(whole)}`);
    const d = b.guard.dark;
    check('computer: record shape', J(Object.keys(d)) === J(['alpha', 'contrast', 'dim', 'blurPx', 'region', 'monitor']) && J(d.region) === J({ topDip: 0, heightDip: 100 }) && J(d.monitor) === J(mon), J(d));
    const c = await worker.compute({ file: path.join(__dirname, 'look-guard.js'), monitor: mon, dim: 0.6, blurPx: 7 });
    check('computer: from a file, other glass', c.ok && c.guard.dark.dim === 0.6 && c.guard.dark.blurPx === 7 && c.guard.dark.alpha >= 0.6, J(c));
    // failures: each says why, none throws
    const f1 = await worker.compute({ jpeg: Buffer.from('x'), monitor: mon, dim: NaN, blurPx: 5 });
    const f2 = await worker.compute({ jpeg: Buffer.from('x'), monitor: null, dim: 0.5, blurPx: 5 });
    const f3 = await worker.compute({ monitor: mon, dim: 0.5, blurPx: 5 });
    const f4 = await worker.compute({ file: path.join(__dirname, 'nope.jpg'), monitor: mon, dim: 0.5, blurPx: 5 });
    const f5 = await LG.makeGuardComputer({ nativeImage: { createFromBuffer: () => { throw new Error('decoder gone'); } } }).compute({ jpeg: Buffer.from('x'), monitor: mon, dim: 0.5, blurPx: 5 });
    const f6 = await LG.makeGuardComputer({ nativeImage: fakeNI(pic), Worker: function () { throw new Error('no threads'); } }).compute({ jpeg: Buffer.from('x'), monitor: mon, dim: 0.5, blurPx: 5 });
    check('computer failure: bad dim', !f1.ok && /dim/.test(f1.reason), J(f1));
    check('computer failure: no monitor', !f2.ok && /monitor/.test(f2.reason), J(f2));
    check('computer failure: no still', !f3.ok && /no still/.test(f3.reason), J(f3));
    check('computer failure: still unreadable', !f4.ok && /read back/.test(f4.reason), J(f4));
    check('computer failure: decoder throws', !f5.ok && /decoder gone/.test(f5.reason), J(f5));
    check('computer failure: worker will not start', !f6.ok && /no threads/.test(f6.reason), J(f6));
  }

  /* ---- what the TOP BAR does: use() ---- */
  {
    const rec = { rev: 9, ok: true, guard: { dark: { alpha: 0.54, contrast: 4.32, dim: 0.5, blurPx: 5, region: { topDip: 0, heightDip: 100 }, monitor: [1536, 864] } } };
    const glass = { dim: 0.5, blurPx: 5 };
    const u = LG.use({ dark: true, syncOn: true, record: rec, glass });
    check('use: dark + sync on + fresh guard -> the shared alpha', u.use === true && u.alpha === 0.54 && u.rev === 9, J(u));
    const light = LG.use({ dark: false, syncOn: true, record: rec, glass });
    check('use: light -> untouched, not a failure', light.use === false && light.failure === false, J(light));
    const off = LG.use({ dark: true, syncOn: false, record: rec, glass });
    check('use: sync off -> own guard, not a failure', off.use === false && off.failure === false && /sync is off/.test(off.why), J(off));
    const none = LG.use({ dark: true, syncOn: true, record: null, glass });
    check('use: no record -> own guard, a failure with the reason', none.use === false && none.failure === true && /not shared/.test(none.why), J(none));
    const gr = LG.use({ dark: true, syncOn: true, record: { rev: 3, ok: true, guardReason: 'the still decoded empty' }, glass });
    check('use: guardReason -> own guard, says it', gr.use === false && gr.failure === true && /the still decoded empty/.test(gr.why), J(gr));
    const bad = LG.use({ dark: true, syncOn: true, record: { rev: 3, ok: true, guard: { dark: { alpha: 'x', dim: 0.5, blurPx: 5 } } }, glass });
    check('use: invalid guard -> own guard, says it', bad.use === false && bad.failure === true && /not usable/.test(bad.why), J(bad));
    const staleDim = LG.use({ dark: true, syncOn: true, record: rec, glass: { dim: 0.6, blurPx: 5 } });
    check('use: stale (dim differs) -> own guard, says it', staleDim.use === false && staleDim.failure === true && /out of date/.test(staleDim.why) && /60%/.test(staleDim.why), J(staleDim));
    const staleBlur = LG.use({ dark: true, syncOn: true, record: rec, glass: { dim: 0.5, blurPx: 8 } });
    check('use: stale (blur differs) -> own guard, says it', staleBlur.use === false && staleBlur.failure === true && /8 px/.test(staleBlur.why), J(staleBlur));
    const working = LG.use({ dark: true, syncOn: true, record: rec, glass: { dim: 0.6, blurPx: 5 }, working: true });
    check('use: stale while being re-worked -> own guard for a moment, NOT a failure', working.use === false && working.failure === false, J(working));
    const missingWorking = LG.use({ dark: true, syncOn: true, record: { rev: 1, ok: true }, glass, working: true });
    check('use: no guard yet while working -> not a failure', missingWorking.failure === false, J(missingWorking));
    check('use: soft = may only be early (no record, no guard yet, stale); a guardReason or bad guard is hard',
      none.soft === true && staleDim.soft === true && staleBlur.soft === true && gr.soft === false && !bad.soft
      && LG.use({ dark: true, syncOn: true, record: { rev: 1, ok: true }, glass }).soft === true, J([none.soft, staleDim.soft, gr.soft, bad.soft]));
    check('checkGuard / keys', LG.checkGuard(rec.guard) === null && LG.checkGuard({}) !== null && LG.keyOfGuard(rec.guard) === LG.guardKey(0.5, 5, [1536, 864]) && LG.guardKey(0.5, 5, null) === '');
    const old = JSON.parse(JSON.stringify(rec.guard)); old.dark.region.heightDip = 144;
    check('keys: a guard worked out over the old 144 DIP band is stale (worked out again, not adopted)', LG.keyOfGuard(old) !== LG.guardKey(0.5, 5, [1536, 864]) && LG.keyOfGuard(old) !== '', LG.keyOfGuard(old));
  }

  /* ---- guard.light (CONTRACT "Light look", 2026-10-14): the constants ARE the light tokens ---- */
  {
    const css = fs.readFileSync(path.join(__dirname, '..', 'ui', 'shared', 'glass-light.css'), 'utf8');
    const block = css.slice(css.indexOf(':root {'), css.indexOf(':root[data-theme="dark"]'));
    const tok = (n) => { const m = new RegExp(`\\s${n}:\\s*([^;]+);`).exec(block); return m ? m[1].trim() : null; };
    const R = LG.RULE_LIGHT;
    const hex = (h) => ({ r: parseInt(h.slice(1, 3), 16), g: parseInt(h.slice(3, 5), 16), b: parseInt(h.slice(5, 7), 16) });
    const ink = /^#[0-9a-f]{6}$/i.test(tok('--lg-ink-2') || '') ? hex(tok('--lg-ink-2')) : null;
    check('light rule: ink = light --lg-ink-2 #333A4E', ink && ink.r === R.ink.r && ink.g === R.ink.g && ink.b === R.ink.b, tok('--lg-ink-2'));
    check('light rule: need = glass-adapt GUARD.need (4.7)', R.need === GA.GUARD.need && R.need === 4.7, R.need);
    check('light rule: tint white, ceiling = light --lg-fill-pop (.88)', R.tint.r === 255 && R.tint.g === 255 && R.tint.b === 255 && tok('--lg-fill-pop') === 'rgba(255,255,255,.88)' && R.ceil === 0.88, tok('--lg-fill-pop'));
    check('light rule: saturate 150% = light --lg-blur', /saturate\(150%\)/.test(tok('--lg-blur') || '') && R.saturate === 1.5, tok('--lg-blur'));
    check('light rule: seed dim .45 = light --lg-fill alpha; .02 steps', tok('--lg-fill') === 'rgba(255,255,255,.45)' && R.step === 0.02, tok('--lg-fill'));
  }
  /* ---- guard.light from pixels: 48 DARKEST, white tint, just enough for 4.7:1 ---- */
  {
    const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    const L = (r, g, b) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    const cr = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    const ink = LG.RULE_LIGHT.ink, li = L(ink.r, ink.g, ink.b);
    const flat = (w, h, v) => { const d = new Uint8ClampedArray(w * h * 4); for (let i = 0; i < d.length; i += 4) { d[i] = v[0]; d[i + 1] = v[1]; d[i + 2] = v[2]; d[i + 3] = 255; } return { data: d, width: w, height: h }; };
    const o = (img, dim) => ({ dim: dim == null ? 0.45 : dim, blurPx: 0, ws: 1, bandRows: img.height, light: true });
    const white = LG.fromPixels(flat(64, 20, [250, 250, 250]), o(flat(64, 20, [250, 250, 250])));
    check('light: a white band stays at the floor (dim .45)', white && white.alpha === 0.45 && white.contrast >= 4.7 && !white.short, J(white));
    const black = flat(64, 20, [20, 22, 30]);
    const bk = LG.fromPixels(black, o(black));
    const onBlack = (a) => cr(li, L(20 * (1 - a) + 255 * a, 22 * (1 - a) + 255 * a, 30 * (1 - a) + 255 * a));
    check('light: a dark band whitens to the thinnest .02 step that holds 4.7:1', bk && bk.alpha > 0.45 && !bk.short && onBlack(bk.alpha) >= 4.7 && onBlack(Math.round((bk.alpha - 0.02) * 100) / 100) < 4.7
      && Math.abs(Math.round((bk.alpha - 0.45) / 0.02) - (bk.alpha - 0.45) / 0.02) < 1e-6, `${J(bk)} below ${onBlack(bk.alpha - 0.02)}`);
    // the WORST pixels are the darkest: a white band with a dark patch (> 48 px) raises it; the brightest 48 (dark's rule) would not
    const patch = flat(64, 20, [250, 250, 250]);
    for (let y = 2; y < 12; y++) for (let x = 5; x < 15; x++) { const i = (y * 64 + x) * 4; patch.data[i] = 20; patch.data[i + 1] = 22; patch.data[i + 2] = 30; }
    const pk = LG.fromPixels(patch, o(patch));
    check('light: a dark patch in a white band decides it (48 darkest), = the all-dark answer', pk && pk.alpha === bk.alpha, `${J(pk)} vs ${J(bk)}`);
    const brightest = LG.fromPixels(patch, Object.assign(o(patch), { light: false }));
    check('light: the dark rule on the same band answers differently (it reads the brightest)', brightest && brightest.alpha !== pk.alpha, J(brightest));
    const hiDim = LG.fromPixels(patch, o(patch, 0.8));
    check('light: a higher dim is a higher floor', hiDim && hiDim.alpha >= 0.8, J(hiDim));
    const ceil = LG.fromPixels(flat(8, 8, [0, 0, 0]), { dim: 0.45, blurPx: 0, ws: 1, bandRows: 8, light: true });
    check('light: black under white .88 holds 4.7:1 (the ceiling never binds on a black band)', ceil && !ceil.short && ceil.alpha <= 0.88, J(ceil));
    // the band = its top bandRows rows only: a dark strip BELOW the band changes nothing (with no blur)
    const below = flat(64, 30, [250, 250, 250]);
    for (let y = 22; y < 30; y++) for (let x = 0; x < 64; x++) { const i = (y * 64 + x) * 4; below.data[i] = 0; below.data[i + 1] = 0; below.data[i + 2] = 0; }
    const bl = LG.fromPixels(below, { dim: 0.45, blurPx: 0, ws: 1, bandRows: 20, light: true });
    check('light: only the band rows count', bl && bl.alpha === 0.45, J(bl));
    // saturate 150% is applied (a coloured band reads differently with and without it)
    const tk = LG.tokens(0.45, 12, true);
    check('light tokens: white fill at dim, ink-2, need 4.7, ceil .88, blur + saturate 1.5', J(tk) === J({ fill: { r: 255, g: 255, b: 255, a: 0.45 }, ceil: 0.88, ink: LG.RULE_LIGHT.ink, need: 4.7, filter: { blur: 12, saturate: 1.5, brightness: 1 } }), J(tk));
    check('dark tokens unchanged by the light rule', J(LG.tokens(0.5, 5)) === J({ fill: { r: 9, g: 10, b: 11, a: 0.5 }, ceil: 0.88, ink: LG.RULE.ink, need: 4.2, filter: { blur: 5, saturate: 1, brightness: 1 } }), J(LG.tokens(0.5, 5)));
  }
  /* ---- the computer with the light glass: guard.light next to guard.dark ---- */
  {
    const W = 960, H = 640;
    const pic = photo(W, H, { ridgeY: 130, bright: 230 });
    const mon = [768, 432];
    const inline = LG.makeGuardComputer({ nativeImage: fakeNI(pic), inline: true });
    const worker = LG.makeGuardComputer({ nativeImage: fakeNI(pic) });
    const ask = { jpeg: Buffer.from('x'), monitor: mon, dim: 0.5, blurPx: 5, light: { dim: 0.45, blurPx: 12 } };
    const a = await inline.compute(ask), b = await worker.compute(ask);
    check('computer light: answers both', a.ok && b.ok && a.guard.light && b.guard.light && !a.lightReason, J([a, b]));
    check('computer light: the worker gives the same light value', J(a.guard.light) === J(b.guard.light), `${J(a.guard.light)} vs ${J(b.guard.light)}`);
    const plain = await inline.compute({ jpeg: Buffer.from('x'), monitor: mon, dim: 0.5, blurPx: 5 });
    check('computer light: the dark value is the same with or without light', J(plain.guard.dark) === J(a.guard.dark) && !plain.guard.light && /no light glass/.test(plain.lightReason || ''), J(plain));
    const l = b.guard.light;
    check('computer light: record shape (= dark shape), its own dim and blur', J(Object.keys(l)) === J(['alpha', 'contrast', 'dim', 'blurPx', 'region', 'monitor']) && l.dim === 0.45 && l.blurPx === 12
      && J(l.region) === J({ topDip: 0, heightDip: 100 }) && J(l.monitor) === J(mon) && l.alpha >= 0.45 && l.alpha <= 0.88 && (l.contrast >= 4.7 || b.lightShort), J(l));
    // the same displayed band, worked out by hand: blur 12 (sigma 8 on a smaller picture), saturate 150%, 48 darkest
    const g = LG.bandGeometry(W, H, mon[0], mon[1], 12, LG.BAND_DIP);
    const band = fakeNI(pic).createFromBuffer().crop(g.src).resize({ width: g.out.w, height: g.out.h });
    const bs = band.getSize();
    const hand = LG.fromPixels({ data: LG.bgraToRgba(band.toBitmap()), width: bs.width, height: bs.height }, { dim: 0.45, blurPx: 12, ws: g.ws, bandRows: g.bandRows, light: true });
    check('computer light: = fromPixels over the displayed band at the light blur', hand && hand.alpha === l.alpha && hand.contrast === l.contrast, `${J(hand)} vs ${J(l)}`);
    const hi = await inline.compute(Object.assign({}, ask, { light: { dim: 0.7, blurPx: 20 } }));
    check('computer light: other light glass carried', hi.ok && hi.guard.light.dim === 0.7 && hi.guard.light.blurPx === 20 && hi.guard.light.alpha >= 0.7, J(hi.guard));
    const lf = await inline.compute(Object.assign({}, ask, { light: { dim: NaN, blurPx: 12 } }));
    check('computer light failure: dark still ships, no light field, the reason says light', lf.ok && lf.guard.dark && !lf.guard.light && /light glass has no usable dim/.test(lf.lightReason || ''), J(lf));
    const both = await inline.compute(Object.assign({}, ask, { dim: NaN }));
    check('computer light: a dark failure fails the whole answer, with a light reason', !both.ok && /dim/.test(both.reason) && typeof both.lightReason === 'string', J(both));
    // keys and the shape check
    const key = LG.guardKey(0.5, 5, mon, { dim: 0.45, blurPx: 12 });
    check('light keys: the light glass is part of the key', key !== LG.guardKey(0.5, 5, mon) && key !== LG.guardKey(0.5, 5, mon, { dim: 0.47, blurPx: 12 }) && key !== LG.guardKey(0.5, 5, mon, { dim: 0.45, blurPx: 14 }), key);
    check('light keys: a record with guard.light keys as its inputs; one without is stale for a light glass', LG.keyOfGuard(b.guard) === key && LG.keyOfGuard(plain.guard) !== key, `${LG.keyOfGuard(b.guard)} / ${LG.keyOfGuard(plain.guard)}`);
    check('checkGuardLight', LG.checkGuardLight(b.guard) === null && /no light value/.test(LG.checkGuardLight(plain.guard)) && /alpha/.test(LG.checkGuardLight({ light: { alpha: 2, dim: 0.45, blurPx: 12 } })) && /dim and blur/.test(LG.checkGuardLight({ light: { alpha: 0.5 } })));
    check('checkGuard (dark) ignores light', LG.checkGuard(b.guard) === null && LG.checkGuard(plain.guard) === null);
    check('use: light theme still keeps Mantle\'s own frost (guard.light is for Helm and Quartz)', LG.use({ dark: false, syncOn: true, record: { rev: 1, ok: true, guard: b.guard }, glass: { dim: 0.5, blurPx: 5 } }).use === false);
  }

  if (failures.length) { console.log('FAILURES:'); for (const f of failures) console.log('  FAIL ' + f); }
  console.log(`LOOK GUARD TEST: ${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.log(`LOOK GUARD TEST: crashed: ${e && e.stack ? e.stack : e}`); process.exit(1); });
