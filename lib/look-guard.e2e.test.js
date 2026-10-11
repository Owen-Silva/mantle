'use strict';
/*
 * look-guard.e2e.test.js -- the SHARED top-band darkening with REAL photos and Electron's real JPEG
 * decoder (lane guard-mantle, 2026-10-10). No window is made (lib/test-quiet.js is installed anyway).
 *
 *   node lib/look-guard.e2e.test.js        (re-launches itself under Electron)
 *
 *   1. Each built-in photo is made into a still the publisher's way (cover 1920x1080, JPEG 90) and the
 *      guard is worked out on the worker thread for a 1536x864 DIP monitor, dim .50, blur 5; it must equal
 *      glass-adapt's own guard() over the WHOLE displayed picture (the same pixels).
 *   2. The real publisher (lib/look-desktop.js) on a TEMP look-sync folder with the real computer:
 *      snow-peak publishes guard.dark; a dim change and a blur change each republish; a bright photo
 *      (cloud-peaks) publishes a higher alpha.
 *   3. Owen's real %APPDATA%\look-sync is untouched (snapshot before and after).
 * Prints "LOOK GUARD E2E TEST: n passed, m failed" and an alpha table.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

if (!process.versions.electron) {
  const { spawnSync } = require('child_process');
  const electron = require(path.join(__dirname, '..', 'node_modules', 'electron'));
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;   // a shell started from an Electron app (Helm) carries it
  const r = spawnSync(electron, [__filename, '--test'], { stdio: 'inherit', env, timeout: 300000 });
  process.exit(r.status === null ? 1 : r.status);
}

require('./test-quiet').install(['--test'], process.env);
const { app, nativeImage } = require('electron');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'look-guard-e2e-'));
process.env.LOOK_SYNC_DIR = path.join(ROOT, 'env-dir');
const REAL = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'look-sync');
const LG = require('./look-guard');
const LS = require('./look-sync');
const GA = require('../ui/shared/glass-adapt.js');
const { makeDesktopPublisher, coverSize } = require('./look-desktop');

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(name + (detail !== undefined ? ' -- ' + String(detail).slice(0, 300) : ''));
}
const J = (v) => JSON.stringify(v);
function snapshot(dir) {
  const out = {};
  (function walk(d) {
    let names; try { names = fs.readdirSync(d); } catch (_) { return; }
    for (const n of names) { const f = path.join(d, n); let s; try { s = fs.statSync(f); } catch (_) { continue; } if (s.isDirectory()) walk(f); else out[f] = s.mtimeMs + ':' + s.size; }
  })(dir);
  return out;
}

const BG = path.join(__dirname, '..', 'assets', 'backgrounds');
const PHOTOS = ['snow-peak', 'cloud-peaks', 'sand-ripples', 'misty-woods', 'foggy-cliffs', 'stone'];
const MON = [1536, 864];
const SCREEN = { w: 1920, h: 1080 };

function stillOf(file) {
  const img = nativeImage.createFromPath(file);
  const sz = img.getSize();
  const c = coverSize(sz.width, sz.height, SCREEN.w, SCREEN.h);
  return (c.w !== sz.width || c.h !== sz.height ? img.resize({ width: c.w, height: c.h, quality: 'best' }) : img).toJPEG(90);
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const before = snapshot(REAL);
  const C = LG.makeGuardComputer({ nativeImage });
  const table = [];
  /* ---- 1. real photos: the worker's answer = glass-adapt over the whole displayed picture ---- */
  for (const name of PHOTOS) {
    const jpeg = stillOf(path.join(BG, `${name}.jpg`));
    const r = await C.compute({ jpeg, monitor: MON, dim: 0.5, blurPx: 5 });
    if (!r.ok) { check(`${name}: worked out`, false, r.reason); continue; }
    const img = nativeImage.createFromBuffer(jpeg);
    const sz = img.getSize();
    const g = LG.bandGeometry(sz.width, sz.height, MON[0], MON[1], 5, MON[1]);
    const full = img.crop(g.src).resize({ width: g.out.w, height: g.out.h, quality: 'best' });
    const fz = full.getSize();
    const whole = GA.guard({ data: LG.bgraToRgba(full.toBitmap()), width: fz.width, height: fz.height }, { tokens: LG.tokens(0.5, 5), picPerCss: 1, rect: { x: 0, y: 0, w: fz.width, h: LG.BAND_DIP } });
    const d = r.guard.dark;
    check(`${name}: = glass-adapt's guard() over the whole picture (${d.alpha})`, d.alpha === whole.alpha, `${J(d)} vs ${J(whole)}`);
    check(`${name}: contrast holds 4.2:1 (or the ceiling)`, d.contrast >= 4.2 || d.alpha === 0.88, J(d));
    table.push({ name, alpha: d.alpha, contrast: d.contrast, ms: r.ms });
  }
  const snow = table.find((t) => t.name === 'snow-peak'), cloud = table.find((t) => t.name === 'cloud-peaks');
  check('snow-peak stays at .50 (the 100 DIP band; Owen was promised his mountain photo does not change)', snow && snow.alpha === 0.5, J(snow));
  check('cloud-peaks (bright) is raised above snow-peak', snow && cloud && cloud.alpha > snow.alpha, J([snow, cloud]));

  /* ---- 2. the real publisher, real computer, temp folder ---- */
  const dir = path.join(ROOT, 'share');
  const sync = LS.create({ app: 'mantle', dir, enabled: true, retryDelays: [1, 1] });
  const item = (n) => ({ id: `builtin:${n}`, title: n, type: 'builtin', file: path.join(BG, `${n}.jpg`), thumb: null, state: null, ok: true, reason: null });
  const R = { cur: { ready: true, rest: false, item: item('snow-peak'), reason: null }, glass: { dim: 0.5, blurPx: 5 }, states: [] };
  const pub = makeDesktopPublisher({
    sync, LS, current: () => R.cur, screen: () => SCREEN, nativeImage, gifFrame: () => ({ ok: false }),
    frame: async () => ({ ok: false, reason: 'no frame in this test' }), capture: () => Promise.reject(new Error('no capture')),
    windows: null, test: true, onChange: (st) => R.states.push(st), log: () => {},
    guard: C, glass: () => R.glass, monitor: () => MON,
  });
  const go = async (why) => { pub.check(why); await pub.settle(); };
  const rec = () => { const r = LS.read(dir); return r.state === 'ok' ? r.doc.desktop : null; };
  await go('snow-peak');
  let r1 = rec();
  check('publisher: snow-peak record carries guard.dark = the direct answer', r1 && r1.guard && r1.guard.dark.alpha === snow.alpha && J(r1.guard.dark.monitor) === J(MON) && r1.guard.dark.dim === 0.5 && r1.guard.dark.blurPx === 5, J(r1 && r1.guard));
  check('publisher: state says it', pub.state().guard.ok === true && pub.state().guard.alpha === snow.alpha, J(pub.state().guard));
  const rev1 = r1.rev;
  R.glass = { dim: 0.6, blurPx: 5 };
  await go('the dark glass changed');
  const r2 = rec();
  check('publisher: a dim change republishes (rev up, dim .6, alpha >= .6, same still)', r2.rev > rev1 && r2.guard.dark.dim === 0.6 && r2.guard.dark.alpha >= 0.6 && r2.still === r1.still, J(r2));
  R.glass = { dim: 0.6, blurPx: 12 };
  await go('the dark glass changed');
  const r3 = rec();
  check('publisher: a blur change republishes (blur 12)', r3.rev > r2.rev && r3.guard.dark.blurPx === 12, J(r3.guard));
  R.glass = { dim: 0.5, blurPx: 5 };
  R.cur = { ready: true, rest: false, item: item('cloud-peaks'), reason: null };
  await go('cloud-peaks');
  const r4 = rec();
  check('publisher: bright cloud-peaks publishes its raised alpha', r4.id === 'builtin:cloud-peaks' && r4.guard.dark.alpha === cloud.alpha && r4.guard.dark.alpha > snow.alpha, J(r4.guard));
  sync.close();

  /* ---- 3. the real store untouched ---- */
  check('Owen\'s real look-sync folder untouched', J(snapshot(REAL)) === J(before));

  console.log(`alpha table (1536x864 DIP, dim .50, blur 5, band 0-${LG.BAND_DIP} DIP):`);
  for (const t of table) console.log(`  ${t.name.padEnd(13)} ${t.alpha.toFixed(2)}  contrast ${t.contrast}:1  ${t.ms} ms`);
  if (failures.length) { console.log('FAILURES:'); for (const f of failures) console.log('  FAIL ' + f); }
  console.log(`LOOK GUARD E2E TEST: ${passed} passed, ${failures.length} failed`);
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) { /* temp */ }
  app.exit(failures.length ? 1 : 0);
}).catch((e) => { console.log(`LOOK GUARD E2E TEST: crashed: ${e && e.stack ? e.stack : e}`); app.exit(1); });
