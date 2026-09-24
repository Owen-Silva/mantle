// screenshot.test.js - the screenshot feature's pure parts: selection math, DPI, naming, display
// matching (ui/screenshot/geometry.js) and main's own helpers (lib/features/screenshot.js).
//
//   node lib/features/screenshot.test.js
//
// No Electron, no sidecar, no screen: numbers in, numbers out.
'use strict';
const path = require('path');
const G = require(path.join(__dirname, '..', '..', 'ui', 'screenshot', 'geometry.js'));

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { passed++; return; }
  failures.push(name);
  console.log('  FAIL ' + name + (detail !== undefined ? ' - ' + JSON.stringify(detail) : ''));
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ---- normRect / intersect ---------------------------------------------------------------------- */
check('normRect: any drag direction gives the same rect', eq(G.normRect(10, 20, 5, 2), { x: 5, y: 2, w: 5, h: 18 }) &&
  eq(G.normRect(5, 2, 10, 20), { x: 5, y: 2, w: 5, h: 18 }));
check('intersect: overlap', eq(G.intersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 }), { x: 5, y: 5, w: 5, h: 5 }));
check('intersect: touching edges is no overlap', G.intersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 5, h: 5 }) === null);

/* ---- cssToPhys at every scale Windows offers ------------------------------------------------- */
const scales = [1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 3];
for (const s of scales) {
  const mon = { x: 0, y: 0, w: Math.round(1920 * s), h: Math.round(1080 * s) };
  const view = { w: 1920, h: 1080 };
  const r = G.cssToPhys({ x: 100, y: 50, w: 400, h: 300 }, mon, view);
  check(`scale ${s}: an integer CSS rect maps to round(edge x scale)`, eq(r, { x: Math.round(100 * s), y: Math.round(50 * s),
    w: Math.round(500 * s) - Math.round(100 * s), h: Math.round(350 * s) - Math.round(50 * s) }), r);
  const full = G.cssToPhys({ x: 0, y: 0, w: 1920, h: 1080 }, mon, view);
  check(`scale ${s}: the whole page is the whole monitor, exactly`, eq(full, mon), full);
  const back = G.physToCss(r, mon, view);
  const again = G.cssToPhys(back, mon, view);
  check(`scale ${s}: phys -> css -> phys is the identity`, eq(again, r), { r, again });
}

// Owen's panel, measured 2026-09-24: 1920x1080 physical at 125% = a 1536x864 CSS page.
{
  const mon = { x: 0, y: 0, w: 1920, h: 1080 };
  const view = { w: 1536, h: 864 };
  const r = G.cssToPhys({ x: 100.4, y: 80.6, w: 639.9, h: 340.3 }, mon, view);
  check('125%: fractional pointer coordinates round per EDGE', eq(r, { x: 126, y: 101, w: 925 - 126, h: 526 - 101 }), r);
  // Two selections sharing an edge on screen share it in the file (no 1 px gap or overlap).
  const a = G.cssToPhys({ x: 10.3, y: 0, w: 100.3, h: 10 }, mon, view);
  const b = G.cssToPhys({ x: 110.6, y: 0, w: 50, h: 10 }, mon, view);
  check('125%: adjacent selections share their edge exactly', a.x + a.w === b.x, { a, b });
  check('125%: a drag past the page edge is clamped to the monitor', eq(G.cssToPhys({ x: 1500, y: 800, w: 100, h: 100 }, mon, view),
    { x: 1875, y: 1000, w: 45, h: 80 }));
  check('125%: a drag starting off the page (negative) is clamped', eq(G.cssToPhys({ x: -20, y: -5, w: 60, h: 25 }, mon, view),
    { x: 0, y: 0, w: 50, h: 25 }));
  check('125%: pointToPhys floors to the pixel under the pointer', eq(G.pointToPhys(0.9, 863.99, mon, view), { x: 1, y: 1079 }));
}

/* ---- mixed DPI: two monitors, two pages, one virtual screen -------------------------------------- */
{
  // A 4K at 150% on the left (origin -3840) and a 1080p at 100% as primary.
  const left = { x: -3840, y: -200, w: 3840, h: 2160 };
  const leftView = { w: 2560, h: 1440 };
  const prim = { x: 0, y: 0, w: 1920, h: 1080 };
  const primView = { w: 1920, h: 1080 };
  const a = G.cssToPhys({ x: 2460, y: 1340, w: 100, h: 100 }, left, leftView);
  check('mixed DPI: the left 150% monitor gives negative physical x inside it', eq(a, { x: -150, y: 1810, w: 150, h: 150 }), a);
  const b = G.cssToPhys({ x: 0, y: 0, w: 100, h: 100 }, prim, primView);
  check('mixed DPI: the primary at 100% is 1:1 from 0,0', eq(b, { x: 0, y: 0, w: 100, h: 100 }), b);
  check('mixed DPI: the two pages meet at x = 0 with no gap', a.x + a.w === b.x);
  const win = { x: -500, y: 100, w: 1000, h: 600 };           // a window straddling both
  const onLeft = G.physToCss(win, left, leftView);
  const onPrim = G.physToCss(win, prim, primView);
  check('mixed DPI: a straddling window is drawn at each page\'s own scale', eq(onLeft, { x: 2226.6666666666665, y: 200, w: 666.6666666666666, h: 400 }) &&
    eq(onPrim, { x: -500, y: 100, w: 1000, h: 600 }), { onLeft, onPrim });
}

/* ---- windowAt ------------------------------------------------------------------------------------ */
{
  const mon = { x: 0, y: 0, w: 1920, h: 1080 };
  const wins = [
    { hwnd: '3', kind: 'window', x: 100, y: 100, w: 200, h: 200 },
    { hwnd: '2', kind: 'window', x: 150, y: 150, w: 400, h: 400 },
    { hwnd: '1', kind: 'desktop', x: 0, y: 0, w: 1920, h: 1080 },
  ];
  check('windowAt: the topmost window under the point wins', G.windowAt(wins, { x: 160, y: 160 }, mon).hwnd === '3');
  check('windowAt: the one beneath where the top one ends', G.windowAt(wins, { x: 320, y: 320 }, mon).hwnd === '2');
  check('windowAt: right/bottom edges are exclusive', G.windowAt(wins, { x: 300, y: 160 }, mon).hwnd === '2' && G.windowAt(wins, { x: 299, y: 160 }, mon).hwnd === '3');
  const d = G.windowAt(wins, { x: 1800, y: 1000 }, mon);
  check('windowAt: the desktop answers as the whole monitor', d.kind === 'desktop' && d.w === 1920 && d.h === 1080);
  const d2 = G.windowAt([], { x: 5, y: 5 }, { x: -1920, y: 0, w: 1920, h: 1080 });
  check('windowAt: no windows at all still answers the monitor', d2.kind === 'desktop' && d2.x === -1920);
}

/* ---- matchDisplays --------------------------------------------------------------------------------- */
{
  const mons = [{ index: 0, x: 0, y: 0, w: 1920, h: 1080 }, { index: 1, x: -3840, y: -200, w: 3840, h: 2160 }];
  const disp = [{ id: 'B', x: -3840, y: -200, w: 3840, h: 2160 }, { id: 'A', x: 0, y: 0, w: 1920, h: 1080 }];
  const m = G.matchDisplays(mons, disp);
  check('matchDisplays: pairs by overlap, not by order', m[0].display.id === 'A' && m[1].display.id === 'B');
  const off = G.matchDisplays([{ index: 0, x: 5000, y: 0, w: 100, h: 100 }], disp);
  check('matchDisplays: a monitor with no display gets null (main says so)', off[0].display === null);
  const dup = G.matchDisplays([{ x: 0, y: 0, w: 1920, h: 1080 }, { x: 0, y: 0, w: 1920, h: 1080 }], [{ id: 'A', x: 0, y: 0, w: 1920, h: 1080 }]);
  check('matchDisplays: a display is never used twice (mirrored monitors)', dup[0].display.id === 'A' && dup[1].display === null);
}

/* ---- naming ------------------------------------------------------------------------------------------ */
check('screenshotName: Windows\' own pattern, zero-padded, local time',
  G.screenshotName(new Date(2026, 8, 4, 7, 5, 9)) === 'Screenshot 2026-09-04 070509');
check('screenshotName: end of year, 24-hour clock', G.screenshotName(new Date(2026, 11, 31, 23, 59, 58)) === 'Screenshot 2026-12-31 235958');
check('sizeText: physical px with a real multiplication sign', G.sizeText(1920, 1080) === '1920 × 1080');

/* ---- labelSpot ------------------------------------------------------------------------------------------- */
{
  const view = { w: 1536, h: 864 };
  const below = G.labelSpot({ x: 100, y: 100, w: 300, h: 200 }, view, 90, 24, 8);
  check('labelSpot: below the bottom-right corner by default', eq(below, { x: 310, y: 308 }), below);
  const above = G.labelSpot({ x: 100, y: 600, w: 300, h: 250 }, view, 90, 24, 8);
  check('labelSpot: above when there is no room below', above.y === 600 - 24 - 8, above);
  const inside = G.labelSpot({ x: 0, y: 0, w: 1536, h: 864 }, view, 90, 24, 8);
  check('labelSpot: inside a full-page selection, never off the page', inside.y >= 0 && inside.y + 24 <= 864 && inside.x + 90 <= 1536, inside);
  const left = G.labelSpot({ x: 0, y: 100, w: 20, h: 20 }, view, 90, 24, 8);
  check('labelSpot: a tiny selection at the left edge keeps the label on the page', left.x >= 4, left);
}
check('isCapture: a click (under 2 physical px) is not a capture', !G.isCapture({ w: 1, h: 300 }) && G.isCapture({ w: 2, h: 2 }) && !G.isCapture(null));

/* ---- main's helpers (lib/features/screenshot.js), once it exists ------------------------------------------ */
let feature = null;
try { feature = require('./screenshot.js'); } catch (err) { if (!/Cannot find module/.test(err.message)) throw err; }
if (feature && feature._test) mainHelpers(feature._test);
else console.log('  (lib/features/screenshot.js helpers: not present yet, skipped)');

function mainHelpers(T) {
  const os = require('os');
  check('module: name is the file name, both chords, on by default', feature.name === 'screenshot' && feature.defaultOn === true &&
    eq(feature.chords, ['Win+Shift+S', 'PrintScreen']) && typeof feature.install === 'function');
  check('fileUrl: spaces, # and % are escaped; the drive stays', T.fileUrl('C:\\Users\\a b\\Temp\\x#1%.bmp') === 'file:///C:/Users/a%20b/Temp/x%231%25.bmp',
    T.fileUrl('C:\\Users\\a b\\Temp\\x#1%.bmp'));
  const disp = [{ x: 0, y: 0, w: 1920, h: 1080 }, { x: 0, y: -1080, w: 1920, h: 1080 }];
  const p1 = T.parkSpot(disp[0], 1920, 1080, [disp[0]]);
  check('parkSpot: above its monitor when nothing is there', eq(p1, { x: 0, y: -1080 - 64 }), p1);
  const p2 = T.parkSpot(disp[0], 1920, 1080, disp);
  check('parkSpot: below when a monitor sits above', eq(p2, { x: 0, y: 1080 + 64 }), p2);
  const work = { x: 0, y: 0, width: 1536, height: 864 };
  const c1 = T.cardSpot({ w: 372, h: 98 }, work, null);
  check('cardSpot: bottom-right of the work area, card + its 12 px margins', eq(c1, { x: 1536 - 396, y: 864 - 122, width: 396, height: 122 }), c1);
  const c2 = T.cardSpot({ w: 372, h: 98 }, work, { x: 400, y: 812, width: 736, height: 44 });
  check('cardSpot: a bar under the corner does not push it (it does not overlap the card\'s columns)', eq(c2, c1), c2);
  const c3 = T.cardSpot({ w: 372, h: 98 }, work, { x: 0, y: 812, width: 1536, height: 52 });
  check('cardSpot: above a full-width bar', c3.y === 812 - 122, c3);
  const tmp = os.tmpdir();
  check('saveDirFor: --test saves under %TEMP% only', T.saveDirFor(true, null, null, null, tmp).dir.toLowerCase().startsWith(tmp.toLowerCase()) &&
    T.saveDirFor(true, 'C:\\Users\\Public\\x', null, null, tmp).dir === null);
  check('saveDirFor: --test ignores the saveDir setting and the real folder', T.saveDirFor(true, null, 'D:\\shots', { path: 'C:\\P\\Screenshots' }, tmp).why === 'test mode');
  check('saveDirFor: live prefers the setting, then Windows\' folder', T.saveDirFor(false, null, 'D:\\shots', { path: 'C:\\P' }, tmp).dir === 'D:\\shots' &&
    T.saveDirFor(false, null, null, { path: 'C:\\P\\Screenshots', source: 'known folder' }, tmp).dir === 'C:\\P\\Screenshots');
  check('saveDirFor: no folder known says so (never a silent null)', /not known/.test(T.saveDirFor(false, null, null, null, tmp).why));
  check('missingCommand: an old sidecar vs a real failure', T.missingCommand('unknown command "shot.grab"') && !T.missingCommand('shot.grab: BitBlt failed'));
  const line = T.summary({ seq: 3, chord: 'PrintScreen', monitors: [{ w: 1920, h: 1080, scale: 1.25 }], windows: 6, grabMs: 32, bltMs: 26, writeMs: 6, decodeMs: 40, shownMs: 95, how: 'painted' });
  check('summary: sizes and timings in one line', /#3 PrintScreen: froze 1920x1080@1.25 \(6 windows\) - grab 32 ms/.test(line) && /on screen 95 ms/.test(line), line);
  check('FRAME_DIR is under %TEMP%', T.FRAME_DIR.toLowerCase().startsWith(tmp.toLowerCase()));
}

if (!process.argv.includes('--electron')) {
  console.log(`screenshot unit: ${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
} else {
  const unitPassed = passed;
  const unitFailed = failures.length;
  electronCheck().catch((e) => check('electron: the run did not crash', false, e.stack)).then(() => {
    console.log(`screenshot unit: ${unitPassed} passed, ${unitFailed} failed`);
    console.log(`screenshot electron: ${passed - unitPassed} passed, ${failures.length - unitFailed} failed`);
    process.exit(failures.length ? 1 : 0);
  });
}

/* ---- END TO END: one Electron --test instance (node lib/features/screenshot.test.js --electron) --------
 * Takes a test slot, launches `electron . --test --profile-name=screenshot` with this lane's sidecar,
 * fires the chords from a second instance (--test-chord), and lets the feature play MANTLE_SHOT_TEST
 * steps INSIDE the overlay page. Every step that looks at pixels uses a SYNTHETIC frame (Screenshot.cs
 * FillSynthetic); the one real grab is timed and cancelled (nothing saved, frames deleted). Saves go to
 * a fresh %TEMP% folder that is deleted at the end; the clipboard is the feature's test sink. */
async function electronCheck() {
  const fs = require('fs');
  const os = require('os');
  const zlib = require('zlib');
  const { spawn, spawnSync } = require('child_process');
  const ROOT = path.join(__dirname, '..', '..');
  const PROFILE = 'screenshot';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const exe = process.env.MANTLE_SIDECAR_EXE;
  if (!exe || !fs.existsSync(exe)) { check('electron: MANTLE_SIDECAR_EXE names a built exe', false, exe); return; }
  const games = Number(spawnSync('powershell', ['-NoProfile', '-Command',
    '@(Get-Process javaw,Minecraft*,RobloxPlayerBeta,*Riot*,VALORANT* -ErrorAction SilentlyContinue).Count'], { encoding: 'utf8' }).stdout.trim()) || 0;
  if (games) { check('electron: no game running (not launching an instance)', false, games); return; }
  let slot = null;
  for (let tries = 0; tries < 20 && !slot; tries++) {
    for (const n of [1, 2]) {
      const d = path.join(os.tmpdir(), `mantle-slot-${n}`);
      try { fs.mkdirSync(d); slot = d; break; } catch (_) { /* taken */ }
    }
    if (!slot) { console.log('  (both test slots taken; waiting 30 s)'); await sleep(30000); }
  }
  if (!slot) { check('electron: a test slot was free within 10 minutes', false); return; }

  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-shot-e2e-'));
  const K = (k, shift) => ({ key: k, shift });
  const steps = [
    { synthetic: true, mode: 'rect', drag: [100.4, 80.6, 740.3, 420.9] },               // 1 Win+Shift+S: a drag
    { synthetic: true, mode: 'window', click: [5, 5] },                                  // 2 PrintScreen: Window mode
    { synthetic: true, mode: 'full', key: 'Enter' },                                     // 3 Full screen by keyboard
    { synthetic: false, mode: 'rect', key: 'Escape' },                                   // 4 the REAL grab: timed, cancelled
    { synthetic: true, mode: 'rect', keys: ['r', 'Enter'].concat(Array(25).fill(K('ArrowRight', true)), Array(12).fill(K('ArrowDown', true)), ['Enter']) },
  ];
  const cli = require.resolve('electron/cli.js', { paths: [ROOT] });
  const env = Object.assign({}, process.env, { MANTLE_SIDECAR_EXE: exe, MANTLE_SHOT_TEST: JSON.stringify(steps), MANTLE_SHOT_TEST_DIR: outDir });
  let out = '';
  const proc = spawn(process.execPath, [cli, '.', '--test', `--profile-name=${PROFILE}`], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', (c) => { out += c.toString('utf8'); });
  proc.stderr.on('data', (c) => { out += c.toString('utf8'); });
  let exited = null;
  proc.on('exit', (code) => { exited = { code, at: Date.now() }; });
  const toback = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'tools', 'toback.ps1'), '-Match', PROFILE, '-WaitSec', '60'], { stdio: 'ignore' });
  const waitFor = async (re, ms) => { const t = Date.now() + ms; while (Date.now() < t) { const m = out.match(re); if (m) return m; if (exited) return null; await sleep(150); } return null; };
  const envMsg = Object.assign({}, env, { LOWCPU: '0' });
  const second = (args) => spawnSync(process.execPath, [cli, '.', '--test', `--profile-name=${PROFILE}`].concat(args), { cwd: ROOT, env: envMsg, encoding: 'utf8', timeout: 30000 });
  const json = (m) => { try { return JSON.parse(m[1]); } catch (_) { return null; } };
  const pixel = (vx, vy) => [((((vx >> 8) & 15) << 4) | ((vy >> 8) & 15)) & 255, vy & 255, vx & 255];

  try {
    check('electron: the screenshot feature installs and finds its folder', !!await waitFor(/screenshot: saves go to a %TEMP% test folder/, 60000), out.slice(-800));
    check('electron: its overlay windows are built', !!await waitFor(/screenshot: \d+ overlay windows? ready \(install\)/, 20000));
    const down = out.match(/screenshot.*NOT started.*|features\.screenshot.*ok":false.*/);
    check('electron: the feature is not down', !down, down && down[0]);

    // 1: Win+Shift+S, a drag.
    second(['--test-chord=Win+Shift+S']);
    const r1 = json(await waitFor(/TESTSHOT #1 ready (\{.*\})/, 15000) || []);
    check('#1 Win+Shift+S reached the feature and every overlay said ready', r1 && r1.monitors >= 1, out.slice(-600));
    const s1 = json(await waitFor(/TESTSHOT #1 saved (\{.*\})/, 15000) || []);
    const p1 = json(await waitFor(/TESTSHOT #1 played (\{.*\})/, 5000) || []);
    check('#1: a scripted drag saved a PNG in the test folder', s1 && s1.path && s1.path.startsWith(outDir) && fs.existsSync(s1.path), JSON.stringify(s1));
    check('#1: the overlay page said ready before the timeout', r1 && r1.ready.length >= 1 && /painted/.test(r1.how), JSON.stringify(r1 && { how: r1.how, n: r1.ready.length }));
    if (r1 && s1 && p1 && r1.ready[0]) {
      const rd = r1.ready[0];
      check('#1: the page is the monitor exact size in CSS px (physical / scale, no stray rows)', Math.abs(rd.view.w * rd.dpr - rd.natural.w) < 0.5 && Math.abs(rd.view.h * rd.dpr - rd.natural.h) < 0.5, JSON.stringify(rd));
      const want = G.cssToPhys(G.normRect(100.4, 80.6, 740.3, 420.9), { x: 0, y: 0, w: rd.natural.w, h: rd.natural.h }, rd.view);
      check('#1: the frame is decoded at the monitor\'s PHYSICAL size in a page of its CSS size', rd.natural.w > 0 && Math.abs(rd.natural.w / rd.view.w - rd.dpr) < 0.01, JSON.stringify(rd));
      check('#1: the saved rect is geometry.cssToPhys of the drag (DPI-correct)', s1.w === want.w && s1.h === want.h, JSON.stringify({ got: [s1.w, s1.h], want }));
      check('#1: the name is Windows\' pattern', /^Screenshot \d{4}-\d{2}-\d{2} \d{6}( \(\d+\))?\.png$/.test(s1.name), s1.name);
      check('#1: the clipboard (test sink) got the same size, and Owen\'s clipboard nothing', s1.copied && s1.clip && s1.clip.w === s1.w && s1.clip.h === s1.h, JSON.stringify(s1.clip));
      // pixels: the synthetic pattern at the saved rect's VIRTUAL position
      const png = decodePng(fs.readFileSync(s1.path), zlib);
      let bad = 0, n = 0;
      for (let y = 0; y < png.h; y += 17) for (let x = 0; x < png.w; x += 23) { n++; const px = png.px(x, y); const e = pixel(s1.x + x, s1.y + y); if (px[0] !== e[0] || px[1] !== e[1] || px[2] !== e[2] || px[3] !== 255) bad++; }
      check(`#1: every sampled pixel of the saved PNG is the frozen frame's at that position (${n} sampled)`, bad === 0, `${bad} wrong`);
    }
    check('#1: the card was shown (hidden in test) with saved + copied', !!await waitFor(/TESTSHOT card shown \{"w":\d+,"h":\d+,"saved":true,"copied":true\}/, 5000));

    // 2: PrintScreen, Window mode, a click at the top-left.
    second(['--test-chord=PrintScreen']);
    const s2 = json(await waitFor(/TESTSHOT #2 saved (\{.*\})/, 15000) || []);
    check('#2 PrintScreen: Window mode saved the window (or desktop) under the click', s2 && (s2.kind === 'window' || s2.kind === 'desktop') && s2.mode === 'window' && s2.w > 0 && s2.h > 0, JSON.stringify(s2 && { kind: s2.kind, w: s2.w, h: s2.h }));

    // 3: Full screen by keyboard.
    second(['--test-chord=Win+Shift+S']);
    const s3 = json(await waitFor(/TESTSHOT #3 saved (\{.*\})/, 15000) || []);
    check('#3: Full screen + Enter saved the whole monitor', s3 && s3.kind === 'monitor' && r1 && r1.ready[0] && s3.w === r1.ready[0].natural.w && s3.h === r1.ready[0].natural.h && s3.via === 'keyboard', JSON.stringify(s3 && { w: s3.w, h: s3.h, via: s3.via }));

    // 4: the real grab, timed, then Esc.
    second(['--test-chord=Win+Shift+S']);
    const r4 = json(await waitFor(/TESTSHOT #4 ready (\{.*\})/, 15000) || []);
    const c4 = json(await waitFor(/TESTSHOT #4 cancelled (\{.*\})/, 10000) || []);
    check('#4: a real grab reached the overlay and Esc cancelled it (nothing saved)', r4 && c4 && c4.why === 'Esc' && !/TESTSHOT #4 saved/.test(out), JSON.stringify(c4));
    if (r4) console.log(`  REAL chord -> overlay ready: grab ${r4.grabMs} ms, frame decode ${r4.ready.map((x) => x.decodeMs).join('/')} ms, ready ${r4.shownMs} ms after the chord (hidden test windows wait on a 250 ms timer, not a paint: ${r4.ready.map((x) => x.how).join(', ')})`);

    // 5: keyboard only.
    second(['--test-chord=Win+Shift+S']);
    const s5 = json(await waitFor(/TESTSHOT #5 saved (\{.*\})/, 15000) || []);
    if (s5 && r1 && r1.ready[0]) {
      const sc = r1.ready[0].natural.w / r1.ready[0].view.w;
      check('#5: keyboard only (R, Enter, Shift+arrows, Enter) saved 250 x 120 CSS px at the monitor scale', s5.via === 'keyboard' &&
        Math.abs(s5.w - 250 * sc) <= 1 && Math.abs(s5.h - 120 * sc) <= 1, JSON.stringify({ w: s5.w, h: s5.h, sc }));
    } else check('#5: keyboard-only capture saved', false, out.slice(-500));

    check('electron: no keyboard hook was asked for', !/features: keys .*taking/.test(out));
    const frameDir = path.join(os.tmpdir(), 'mantle-shot');
    second(['--quit']);
    const t = Date.now() + 30000;
    while (Date.now() < t && !exited) await sleep(150);
    check('electron: --quit ends the instance', !!exited, out.slice(-500));
    const left = fs.existsSync(frameDir) ? fs.readdirSync(frameDir).filter((f) => /^mantle-shot-.*\.bmp$|^clip-/.test(f)) : [];
    check('electron: no frozen frame outlives the instance', left.length === 0, left.join(','));
    check('electron: no uncaught exception', !/uncaught exception|RESTORE INCOMPLETE/.test(out));
    const err = out.match(/.*screenshot.*(failed|threw|crash).*/i);
    check('electron: no screenshot handler failed', !err, err && err[0]);
  } finally {
    if (!exited) spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'tools', 'kill-test.ps1'), '-Match', PROFILE], { encoding: 'utf8' });
    try { toback.kill(); } catch (_) { /* done */ }
    try { fs.rmdirSync(slot); } catch (_) { /* someone removed it */ }
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (_) { /* temp */ }
    check('electron: the test captures were deleted', !fs.existsSync(outDir));
    fs.writeFileSync(path.join(os.tmpdir(), 'mantle-shot-e2e.log'), out.split('\n').filter((l) => /screenshot|features|error/i.test(l)).join('\n'));
  }
}

/** A minimal PNG decoder (8-bit RGB/RGBA): [r,g,b,a] per pixel. */
function decodePng(b, zlib) {
  let p = 8, w = 0, h = 0, ctype = 0;
  const idat = [];
  while (p < b.length) {
    const len = b.readUInt32BE(p), type = b.toString('latin1', p + 4, p + 8), data = b.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ctype = data[9]; }
    if (type === 'IDAT') idat.push(data);
    p += 12 + len;
  }
  const bpp = ctype === 6 ? 4 : 3, stride = w * bpp, raw = zlib.inflateSync(Buffer.concat(idat)), img = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x], a = x >= bpp ? img[y * stride + x - bpp] : 0, up = y ? img[(y - 1) * stride + x] : 0, c = x >= bpp && y ? img[(y - 1) * stride + x - bpp] : 0;
      let o = v;
      if (f === 1) o += a; else if (f === 2) o += up; else if (f === 3) o += (a + up) >> 1;
      else if (f === 4) { const pp = a + up - c, pa = Math.abs(pp - a), pb = Math.abs(pp - up), pc = Math.abs(pp - c); o += pa <= pb && pa <= pc ? a : pb <= pc ? up : c; }
      img[y * stride + x] = o & 255;
    }
  }
  return { w, h, px(x, y) { const o = y * stride + x * bpp; return [img[o], img[o + 1], img[o + 2], bpp === 4 ? img[o + 3] : 255]; } };
}
