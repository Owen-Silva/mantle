'use strict';
/*
 * look-guard.js -- ONE top-band darkening value for Helm, Quartz and Mantle (lane guard-mantle,
 * 2026-10-10; spec ~/look-sync/CONTRACT.md, last section, "Shared top-band darkening (desktop.guard)").
 *
 * Why: every app ran Mantle's bar contrast rule over its OWN patch of the lined-up photo. Snow-peak sits
 * right at the 4.2:1 edge, so Mantle's top bar picked .50 and Quartz's strip just below it .52: a seam
 * the user could see. They chose one shared value. Mantle works it out once per wallpaper / dark dim / dark
 * blur / monitor and publishes it in the desktop record (lib/look-desktop.js); every top surface uses it.
 *
 * THE RULE is the bars' own (ui/shared/glass-adapt.js glassPicture + guardRect, unchanged): the published
 * still as displayed (cover-fit, centred, to the primary monitor in DIP, one picture pixel per DIP),
 * blurred at glass.dark.blurPx with glass-adapt's gaussian, cut to the full-width band from the top of
 * the monitor down BAND_DIP; then the thinnest tint of --lg-fill-bar's colour, from glass.dark.dim up in
 * .02 steps to CEIL, at which --lg-ink-2 keeps NEED:1 over the 48 brightest blurred pixels of the band.
 * The blur only needs ceil(3 sigma) rows below the band (the kernel's reach), so only those are decoded:
 * the band's pixels come out identical to blurring the whole picture (look-guard.test.js proves it).
 * The constants are the dark tokens of ui/shared/glass-light.css; look-guard.test.js reads the
 * stylesheet and fails if they drift.
 *
 * makeGuardComputer({nativeImage, inline?}) -> { compute({jpeg | file, monitor: [w, h], dim, blurPx, light: {dim, blurPx}}), prepare }
 *   compute -> Promise<{ok: true, guard: {dark: {...}, light?: {...}}, short, lightReason?, ms} | {ok: false, reason}>. Never rejects.
 *   guard.light (2026-10-14, CONTRACT "Light look"): RULE_LIGHT below, over the same band. Mantle's own light top
 *   bar does not use it (it keeps its frost); Helm and Quartz do.
 * use(c) -> what a top surface does with it (pure; the top bar's decision, see below).
 */
const GA = require('../ui/shared/glass-adapt.js');

const RULE = Object.freeze({
  ink: Object.freeze({ r: 169, g: 170, b: 167 }),   // --lg-ink-2 (dark) #a9aaa7
  need: 4.2,                                        // --lg-guard-bar (dark)
  tint: Object.freeze({ r: 9, g: 10, b: 11 }),      // --lg-fill-bar's colour (dark)
  ceil: 0.88,                                       // --lg-fill-pop's alpha (dark)
  step: 0.02,
});
/* THE LIGHT RULE (CONTRACT.md "Light look", 2026-10-14: desktop.guard.light): Mantle's light surface rule
   (ui/shared/glass-adapt.js GUARD): --lg-ink-2 (light) #333A4E keeps 4.7:1 against the 48 DARKEST pixels of
   the same band, blurred at glass.light.blurPx with saturate 150% (light --lg-blur), under WHITE at alpha A,
   from glass.light.dim up in .02 steps to .88 (light --lg-fill-pop). Dark ink: the darkest pixels are the
   worst, so they (not the brightest, as in dark) are the ones tried. */
const RULE_LIGHT = Object.freeze({
  ink: Object.freeze({ r: 51, g: 58, b: 78 }),      // --lg-ink-2 (light) #333A4E
  need: 4.7,                                        // glass-adapt GUARD.need
  tint: Object.freeze({ r: 255, g: 255, b: 255 }),  // --lg-fill's colour (light)
  ceil: 0.88,                                       // --lg-fill-pop's alpha (light)
  step: 0.02,
  saturate: 1.5,                                    // --lg-blur (light): blur(12px) saturate(150%)
});
const WORST_N = 48;
const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const relLum = (r, g, b) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
/* 100, not 144 (2026-10-10): the band's height moves the answer on the user's snow-peak (28-100 DIP -> .50,
   120 -> .52, 144 -> .54) and they were promised "nothing changes on your mountain photo" (.50, "perfect").
   100 DIP still covers both bars and Helm's strip; a bright top still raises it (cloud-peaks). */
const BAND_DIP = 100;
const MAX_SIGMA_PX = 8;   // a bigger blur is worked out on a picture scaled so sigma stays 8 px (cost)

const words = (e) => (e && e.message ? e.message : String(e));
const r2 = (n) => Math.round(n * 100) / 100;

/** Pure: where the band sits in the still. iw x ih still px, mw x mh monitor DIP. -> geometry or null. */
function bandGeometry(iw, ih, mw, mh, blurPx, bandDip) {
  if (!(iw > 0 && ih > 0 && mw > 0 && mh > 0)) return null;
  const band = Math.min(mh, bandDip > 0 ? bandDip : BAND_DIP);
  const blur = blurPx > 0 ? blurPx : 0;
  const ws = blur > MAX_SIGMA_PX ? MAX_SIGMA_PX / blur : 1;          // work px per DIP
  const s = Math.max(mw / iw, mh / ih);                              // cover: still px -> DIP
  const ox = (iw * s - mw) / 2, oy = (ih * s - mh) / 2;              // centred (object-position 50% 50%)
  const marginDip = Math.min(mh - band, Math.ceil(3 * blur * ws) / ws);
  const rowsDip = band + marginDip;
  const sx = Math.max(0, Math.round(ox / s)), sy = Math.max(0, Math.round(oy / s));
  const sw = Math.max(1, Math.min(iw - sx, Math.round(mw / s))), sh = Math.max(1, Math.min(ih - sy, Math.round(rowsDip / s)));
  return {
    scale: s, ws, src: { x: sx, y: sy, width: sw, height: sh },
    out: { w: Math.max(1, Math.round(mw * ws)), h: Math.max(1, Math.round(rowsDip * ws)) },
    bandRows: Math.max(1, Math.round(band * ws)), band,
  };
}

/** The tokens glass-adapt's guardRect reads, for a dim and a blur. */
function tokens(dim, blurPx, light) {
  const R = light ? RULE_LIGHT : RULE;
  return { fill: { r: R.tint.r, g: R.tint.g, b: R.tint.b, a: dim }, ceil: R.ceil, ink: R.ink, need: R.need,
    filter: { blur: blurPx, saturate: light ? RULE_LIGHT.saturate : 1, brightness: 1 } };
}

/** Pure: BGRA (nativeImage.toBitmap on Windows) -> RGBA, opaque. */
function bgraToRgba(buf) {
  const out = new Uint8ClampedArray(buf.length);
  for (let i = 0; i < buf.length; i += 4) { out[i] = buf[i + 2]; out[i + 1] = buf[i + 1]; out[i + 2] = buf[i]; out[i + 3] = 255; }
  return out;
}

/**
 * Pure: the guard from the band's pixels. img {data RGBA, width, height} at `ws` work px per DIP, the band
 * its top bandRows rows. -> {alpha, contrast, short} | null
 */
function fromPixels(img, o) {
  const T = tokens(o.dim, o.blurPx, !!o.light);
  const pic = GA.glassPicture(img, T, o.ws > 0 ? o.ws : 1);
  if (!pic) return null;
  if (o.light) {
    // light: the 48 DARKEST blurred pixels of the band (glassTint itself keeps the brightest 48 of what it
    // is given, so it is handed exactly the darkest 48 and tries them all)
    const rows = Math.max(1, Math.min(pic.h, o.bandRows));
    const n = pic.w * rows, lum = new Float64Array(n), idx = new Uint32Array(n);
    for (let i = 0; i < n; i++) { const p = pic.px; lum[i] = relLum(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]); idx[i] = i; }
    const order = Array.from(idx).sort((a, b) => lum[a] - lum[b]).slice(0, WORST_N);
    const px = [];
    for (const i of order) px.push(pic.px[i * 3], pic.px[i * 3 + 1], pic.px[i * 3 + 2]);
    const t = GA.glassTint({ px, ink: T.ink, tint: T.fill, need: T.need, floor: T.fill.a, ceil: Math.max(T.fill.a, T.ceil), step: RULE_LIGHT.step });
    return t ? { alpha: t.alpha, contrast: t.ratio, short: !!t.short } : null;
  }
  const r = GA.guardRect(pic, T, { x: 0, y: 0, w: img.width, h: o.bandRows });
  return r ? { alpha: r.alpha, contrast: r.ratio, short: !!r.short } : null;
}

function validGlass(dim, blurPx, look) {
  if (!(typeof dim === 'number' && dim >= 0 && dim <= 1)) return `the ${look || 'dark'} glass has no usable dim`;
  if (!(typeof blurPx === 'number' && blurPx >= 0 && blurPx <= 200)) return `the ${look || 'dark'} glass has no usable blur`;
  return null;
}

/*
 * The blur is the cost (~300-600 ms for the 1536 x 160 band on the user's i3), so it runs on a worker thread:
 * Mantle's main process (which drives both bars) never stalls on it. Decoding and cutting the band
 * (nativeImage, main only) is a few ms. One short-lived worker per answer: it is asked once per
 * wallpaper / glass / monitor change, never on a timer.
 */
const WORKER_SRC = `
const { parentPort, workerData } = require('worker_threads');
const LG = require(workerData.lib);
let r = null, err = null;
try { r = LG.fromPixels({ data: new Uint8ClampedArray(workerData.buf), width: workerData.w, height: workerData.h }, workerData.o); }
catch (e) { err = e && e.message ? e.message : String(e); }
parentPort.postMessage({ r, err });
`;
const WORKER_MS = 20000;

function solveOnWorker(img, o, Worker) {
  return new Promise((resolve) => {
    let w, done = false;
    const finish = (v) => { if (done) return; done = true; clearTimeout(t); try { w.terminate(); } catch (_) { /* gone */ } resolve(v); };
    const t = setTimeout(() => finish({ err: `the worker gave no answer in ${WORKER_MS / 1000} s` }), WORKER_MS);
    if (t.unref) t.unref();
    try {
      const buf = img.data.buffer.slice(img.data.byteOffset, img.data.byteOffset + img.data.byteLength);
      w = new Worker(WORKER_SRC, { eval: true, workerData: { lib: __filename, buf, w: img.width, h: img.height, o }, transferList: [buf] });
    } catch (e) { finish({ err: `the worker would not start: ${words(e)}` }); return; }
    w.on('message', (m) => finish(m || { err: 'the worker answered nothing' }));
    w.on('error', (e) => finish({ err: `the worker failed: ${words(e)}` }));
    w.on('exit', (code) => finish({ err: `the worker stopped (code ${code}) without an answer` }));
  });
}

/*
 * o.nativeImage  electron's nativeImage (decode, crop, resize, toBitmap)
 * o.inline       true: solve on this thread (tests); default: a worker thread
 */
function makeGuardComputer(o) {
  const NI = o.nativeImage;
  const Worker = o.inline ? null : (o.Worker || require('worker_threads').Worker);
  /** Main-thread half: the still's top band as RGBA at one picture px per DIP. -> {ok, img, g, mon} | {ok:false, reason} */
  function prepare(a) {
    const bad = validGlass(a.dim, a.blurPx, a.look);
    if (bad) return { ok: false, reason: bad };
    const mon = a.monitor;
    if (!Array.isArray(mon) || !(mon[0] > 0) || !(mon[1] > 0)) return { ok: false, reason: 'the primary monitor\'s size could not be read' };
    let img;
    if (a.jpeg) img = NI.createFromBuffer(a.jpeg);
    else if (a.file) img = NI.createFromPath(a.file);
    else return { ok: false, reason: 'there is no still to work it out from' };
    if (!img || img.isEmpty()) return { ok: false, reason: a.file ? 'the still could not be read back' : 'the still decoded empty' };
    const sz = img.getSize();
    const g = bandGeometry(sz.width, sz.height, mon[0], mon[1], a.blurPx, BAND_DIP);
    if (!g) return { ok: false, reason: 'the still has no size' };
    const band = img.crop(g.src).resize({ width: g.out.w, height: g.out.h, quality: 'best' });
    const bs = band.getSize();
    const bmp = band.toBitmap();
    if (!bmp || bmp.length < bs.width * bs.height * 4) return { ok: false, reason: 'the still\'s top band could not be read as pixels' };
    return { ok: true, img: { data: bgraToRgba(bmp), width: bs.width, height: bs.height }, g, mon };
  }
  /** One look's answer. a = {jpeg | file, monitor, dim, blurPx}, look 'dark' | 'light' -> {ok, value, short} | {ok: false, reason} */
  async function solve(a, look) {
    const light = look === 'light';
    const p = prepare(Object.assign({}, a, { look }));
    if (!p.ok) return p;
    const opts = { dim: a.dim, blurPx: a.blurPx, ws: p.g.ws, bandRows: Math.min(p.img.height, p.g.bandRows), light };
    let r;
    if (Worker) {
      const m = await solveOnWorker(p.img, opts, Worker);
      if (m.err) return { ok: false, reason: `working it out failed: ${m.err}` };
      r = m.r;
    } else r = fromPixels(p.img, opts);
    if (!r) return { ok: false, reason: 'the contrast rule gave no answer for the still\'s top band' };
    return { ok: true, short: r.short, value: { alpha: r.alpha, contrast: r.contrast, dim: a.dim, blurPx: a.blurPx,
      region: { topDip: 0, heightDip: p.g.band }, monitor: [p.mon[0], p.mon[1]] } };
  }
  /*
   * a = {jpeg | file, monitor, dim, blurPx (the dark glass), light?: {dim, blurPx} (the light glass)}
   * -> {ok: true, guard: {dark, light?}, short, lightShort?, lightReason?, ms} | {ok: false, reason, lightReason}
   * The light value (CONTRACT "Light look", desktop.guard.light) is worked out beside the dark one; when only
   * it fails, the dark value still ships and lightReason says why light has none.
   */
  async function compute(a) {
    const t0 = Date.now();
    try {
      a = a || {};
      const L = a.light && typeof a.light === 'object' ? a.light : null;
      const fail = (e) => ({ ok: false, reason: `working it out failed: ${words(e)}` });
      const [d, l] = await Promise.all([
        solve(a, 'dark').catch(fail),
        L ? solve(Object.assign({}, a, { dim: L.dim, blurPx: L.blurPx }), 'light').catch(fail)
          : Promise.resolve({ ok: false, reason: 'no light glass was given to work it out for' }),
      ]);
      if (!d.ok) return { ok: false, reason: d.reason, lightReason: l.ok ? 'the dark value could not be worked out, so neither is shared' : l.reason };
      const out = { ok: true, ms: Date.now() - t0, short: d.short, guard: { dark: d.value } };
      if (l.ok) { out.guard.light = l.value; out.lightShort = l.short; } else out.lightReason = l.reason;
      return out;
    } catch (e) {
      return { ok: false, reason: `working it out failed: ${words(e)}` };
    }
  }
  return { compute, prepare };
}

/** Pure: a guard record's shape is usable. -> null | reason */
function checkGuard(g) {
  const d = g && g.dark;
  if (!d || typeof d !== 'object') return 'the record has no dark value';
  if (!(typeof d.alpha === 'number' && d.alpha >= 0 && d.alpha <= 1)) return 'its alpha is not a number from 0 to 1';
  if (typeof d.dim !== 'number' || typeof d.blurPx !== 'number') return 'it does not say which dim and blur it was worked out for';
  return null;
}

/** The inputs a guard was worked out for, as one key ('' when there is none). The band height is part of
    it: a record worked out over another band (144 before 2026-10-10) is stale and is worked out again
    at the next start, instead of being adopted (it had kept snow-peak at .54 after the change). */
function keyOf(dim, blurPx, monitor, band) {
  if (typeof dim !== 'number' || typeof blurPx !== 'number' || !Array.isArray(monitor)) return '';
  return `${r2(dim)}|${r2(blurPx)}|${monitor[0]}x${monitor[1]}|${band}`;
}
/* The light glass is part of the key (2026-10-14): a record without guard.light (from before the light look,
   or whose light value failed) is worked out again at the next start / glass change. */
const lightKey = (l) => (l && typeof l.dim === 'number' && typeof l.blurPx === 'number' ? `|L${r2(l.dim)}|${r2(l.blurPx)}` : '|L-');
function guardKey(dim, blurPx, monitor, light) {
  const k = keyOf(dim, blurPx, monitor, BAND_DIP);
  return k ? k + lightKey(light) : '';
}
function keyOfGuard(g) {
  const d = g && g.dark;
  const k = d ? keyOf(d.dim, d.blurPx, d.monitor, d.region && d.region.heightDip) : '';
  return k ? k + lightKey(g.light) : '';
}
/** Pure: a guard.light value's shape is usable. -> null | reason */
function checkGuardLight(g) {
  const l = g && g.light;
  if (!l || typeof l !== 'object') return 'the record has no light value';
  if (!(typeof l.alpha === 'number' && l.alpha >= 0 && l.alpha <= 1)) return 'its light alpha is not a number from 0 to 1';
  if (typeof l.dim !== 'number' || typeof l.blurPx !== 'number') return 'its light value does not say which dim and blur it was worked out for';
  return null;
}

/**
 * Pure: what the TOP BAR does (dark + look sync on: the shared alpha replaces its own guard).
 * c = {dark, syncOn, record (look.json desktop or null), glass {dim, blurPx} (the synced dark glass),
 *      working (the publisher is re-working it right now)}
 * -> {use: true, alpha, contrast, rev} | {use: false, why, failure}
 * failure = a real fault the bar shows (Mantle menu row + one note); false = by design or a moment's wait.
 * soft = a failure that may only be a moment early (no record yet, no guard yet, stale before the publisher
 *        has reacted): lib/look-host.js holds it as 'being worked out' for a grace period before saying it.
 */
function use(c) {
  c = c || {};
  if (!c.dark) return { use: false, why: 'light: the top bar keeps its light frost', failure: false };
  if (!c.syncOn) return { use: false, why: 'look sync is off, so the top bar works out its own darkening', failure: false };
  const rec = c.record;
  if (!rec) return { use: false, why: 'Mantle has not shared the desktop wallpaper yet, so the top bar works out its own darkening', failure: !c.working, soft: true };
  const g = rec.guard;
  if (!g) {
    if (c.working) return { use: false, why: 'the shared darkening is being worked out', failure: false };
    const why = rec.guardReason || (rec.ok === false ? rec.reason : null) || 'the desktop record carries no shared darkening';
    return { use: false, why: `the shared darkening is missing (${why}), so the top bar works out its own`, failure: true, soft: !rec.guardReason && rec.ok !== false };
  }
  const bad = checkGuard(g);
  if (bad) return { use: false, why: `the shared darkening is not usable (${bad}), so the top bar works out its own`, failure: true };
  const gl = c.glass || {};
  const d = g.dark;
  if (typeof gl.dim === 'number' && typeof gl.blurPx === 'number' && (r2(gl.dim) !== r2(d.dim) || r2(gl.blurPx) !== r2(d.blurPx))) {
    if (c.working) return { use: false, why: 'the shared darkening is being worked out for the new glass', failure: false };
    return { use: false, why: `the shared darkening is out of date (worked out for tint ${Math.round(d.dim * 100)}% and blur ${d.blurPx} px, the glass is now ${Math.round(gl.dim * 100)}% and ${gl.blurPx} px), so the top bar works out its own`, failure: true, soft: true };
  }
  return { use: true, alpha: d.alpha, contrast: typeof d.contrast === 'number' ? d.contrast : null, rev: Number.isInteger(rec.rev) ? rec.rev : null };
}

module.exports = { RULE, RULE_LIGHT, checkGuardLight, BAND_DIP, MAX_SIGMA_PX, bandGeometry, tokens, bgraToRgba, fromPixels, makeGuardComputer, checkGuard, guardKey, keyOfGuard, use };
