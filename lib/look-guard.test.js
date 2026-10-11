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
    const ink = GA.parseColor(tok('--lg-ink-2')), bar = GA.parseColor(tok('--lg-fill-bar')), pop = GA.parseColor(tok('--lg-fill-pop'));
    check('rule: ink = dark --lg-ink-2', ink && ink.r === LG.RULE.ink.r && ink.g === LG.RULE.ink.g && ink.b === LG.RULE.ink.b, tok('--lg-ink-2'));
    check('rule: need = dark --lg-guard-bar', parseFloat(tok('--lg-guard-bar')) === LG.RULE.need, tok('--lg-guard-bar'));
    check('rule: tint = dark --lg-fill-bar colour', bar && bar.r === LG.RULE.tint.r && bar.g === LG.RULE.tint.g && bar.b === LG.RULE.tint.b, tok('--lg-fill-bar'));
    check('rule: ceiling = dark --lg-fill-pop alpha (.88)', pop && pop.a === LG.RULE.ceil && LG.RULE.ceil === 0.88, tok('--lg-fill-pop'));
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
  }

  if (failures.length) { console.log('FAILURES:'); for (const f of failures) console.log('  FAIL ' + f); }
  console.log(`LOOK GUARD TEST: ${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.log(`LOOK GUARD TEST: crashed: ${e && e.stack ? e.stack : e}`); process.exit(1); });
