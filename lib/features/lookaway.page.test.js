'use strict';
/*
 * lookaway.page.test.js - the REAL look-away page (ui/lookaway/: MediaPipe's face detector on camera
 * frames) on Chromium's FAKE camera (lane lookaway, 2026-10-23).
 *
 *   node lib/features/lookaway.page.test.js     -> "LOOKAWAY PAGE TEST: n passed, m failed"
 *
 * NEVER THE REAL CAMERA: every Electron run here has --use-fake-device-for-media-stream, so Chromium
 * never even enumerates the real webcam (the camera light is personal). The runner refuses to start an
 * Electron without it, and the Electron side refuses to open a window without it. The clips are built in
 * os.tmpdir() from the licensed stills in _lookaway-fixtures/ (LICENCE.md there) and deleted after.
 *
 * HOW: this file is BOTH the runner (plain node) and, started as `electron <this file>`, a tiny Electron
 * main that hosts the page exactly as lib/features/lookaway.js does: hidden window, Mantle's real
 * preload.js, sandbox, its own in-memory session that cancels every web request and grants only the
 * camera, only to that page. Main's side of the IPC (mantle:call / mantle:event / mantle:replay /
 * mantle:theme-now) is answered here and every message is recorded. Nothing is ever shown.
 *
 * Runs (one Electron at a time, each with a hard timeout):
 *   poses   frontal, turned, profile, empty (4 s each, looping): what the page says for each; 4 looks a
 *           second at hz 4 (the old schedule gave 3.33), then 2 and 5 after a 'rate'; every camera
 *           frame closed (frames keep coming); stop releases every track and nothing is seen after;
 *           start again opens the camera again; a second 'start' while watching is ignored; the page
 *           cannot reach the network (CSP, and the session would cancel it); 'seen' carries numbers only.
 *   pattern Chromium's own fake pattern (no clip): almost never a face (it used to read as one in ~80%).
 *   two     big face alone, big + small face, small face alone: the size reported with two faces is the
 *           big one's (the largest face is his).
 *   denied  the session refuses the camera: 'failed' with Windows' plain words, nothing seen.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const FAKE = 'use-fake-device-for-media-stream';
const SEG_MS = 4000;
const POSES = ['frontal', 'turned', 'profile', 'empty'];
const TWO_SEG_MS = 3000, BIG = 0.6, SMALL = 0.35;   // the two-face clip: segment length, face scales

if (process.versions.electron) harness(); else runner().catch((e) => { console.log('LOOKAWAY PAGE TEST: 0 passed, 1 failed'); console.error(e && e.stack || e); process.exit(1); });

/* =============================== the Electron side =============================== */

function harness() {
  const { app, BrowserWindow, ipcMain, session } = require('electron');
  const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
  const plan = arg('plan', 'poses');
  const clip = arg('clip', 'none');
  app.commandLine.appendSwitch(FAKE);
  if (clip !== 'none') app.commandLine.appendSwitch('use-file-for-fake-video-capture', clip);
  app.setPath('userData', arg('profile', path.join(os.tmpdir(), 'mantle-lookaway-pagetest')));
  const t0 = Date.now();
  const out = (o) => process.stdout.write('PAGETEST ' + JSON.stringify(Object.assign({ at: Date.now() - t0 }, o)) + '\n');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const pages = []; const seen = []; const blocked = [];
  let win = null;
  const waitPage = async (state, after, ms) => {
    const end = Date.now() + ms;
    for (;;) { const p = pages.find((x) => x.at >= after && (x.state === state || x.state === 'failed')); if (p) return p; if (Date.now() > end) return null; await sleep(25); }
  };
  const ctl = (msg) => { out({ ctl: msg }); win.webContents.send('mantle:event', { name: 'lookaway.ctl', payload: msg }); };
  setTimeout(() => { out({ error: 'harness timeout' }); app.exit(3); }, Number(arg('timeout', '80000')));

  app.whenReady().then(async () => {
    if (!app.commandLine.hasSwitch(FAKE)) { out({ error: 'refusing: no fake camera switch' }); app.exit(4); return; }
    const ses = session.fromPartition('lookaway-pagetest');   // no "persist:": in memory
    ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (d, cb) => { blocked.push(d.url.slice(0, 60)); cb({ cancel: true }); });
    const mine = (wc) => !!(win && wc && wc.id === win.webContents.id);
    ses.setPermissionRequestHandler((wc, perm, cb, det) => cb(plan !== 'denied' && perm === 'media' && mine(wc) && ((det && det.mediaTypes) || []).length > 0 && det.mediaTypes.every((t) => t === 'video')));
    ses.setPermissionCheckHandler((wc, perm) => plan !== 'denied' && perm === 'media' && mine(wc));
    ipcMain.on('mantle:theme-now', (e) => { e.returnValue = { theme: 'light', look: {} }; });
    ipcMain.handle('mantle:replay', () => ({ has: false }));
    ipcMain.handle('mantle:call', async (_e, name, a) => {
      const at = Date.now() - t0;
      if (name === 'lookaway.seen') { seen.push(Object.assign({ at }, a)); return { ok: true, result: { ok: true } }; }
      if (name === 'lookaway.page') { pages.push(Object.assign({ at }, a)); out({ page: a }); return { ok: true, result: { ok: true } }; }
      out({ unexpectedCall: String(name).slice(0, 40) });
      return { ok: false, error: 'not here' };
    });
    win = new BrowserWindow({
      show: false, width: 64, height: 48, frame: false, skipTaskbar: true, focusable: false,
      webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false, partition: 'lookaway-pagetest', spellcheck: false },
    });
    win.webContents.on('console-message', (_e, lvl, msg) => { if (lvl >= 3) out({ console: String(msg).slice(0, 200) }); });
    await win.loadFile(path.join(ROOT, 'ui', 'lookaway', 'index.html'));
    const loaded = await waitPage('loaded', 0, 15000);
    out({ loaded: !!loaded, visible: win.isVisible() });
    const mark = (name, at0) => { const at = at0 === undefined ? Date.now() - t0 : at0; out({ mark: name, at }); return at; };
    // Chromium's fake camera now and then ends its track right after it starts (seen in about 2 of 12
    // launches, pattern and clip alike, never later in a run): one more start is allowed, and said out loud.
    const startWatching = async () => {
      for (let tries = 0; ; tries++) {
        const a = mark('start');
        ctl({ op: 'start', width: 320, height: 240, hz: 4 });
        const w = await waitPage('watching', a, 30000);
        if (!w || w.state !== 'watching') return w;
        await sleep(1500);
        const early = pages.find((p) => p.at >= w.at && p.state === 'failed');
        if (!early) { mark('watching', w.at); return w; }
        out({ flake: early.reason, tries });
        if (tries >= 1) return early;
        await sleep(500);
      }
    };

    if (plan === 'denied') {
      const a = mark('start');
      ctl({ op: 'start', width: 320, height: 240, hz: 4 });
      await waitPage('failed', a, 20000);
      await sleep(1500);
    } else if (plan === 'poses') {
      const csp = await win.webContents.executeJavaScript("fetch('https://example.invalid/x').then(() => 'fetched', (e) => 'blocked ' + e.name)");
      out({ csp });
      let a;
      const w = await startWatching();
      if (w && w.state === 'watching') {
        ctl({ op: 'start', width: 320, height: 240, hz: 4 });   // a second start while watching: ignored
        await sleep(2 * POSES.length * SEG_MS - 1500);          // two loops of the clip at hz 4 (1.5 s went in startWatching)
        mark('rate2'); ctl({ op: 'rate', hz: 2 }); await sleep(6000);
        mark('rate5'); ctl({ op: 'rate', hz: 5 }); await sleep(6000);
        a = mark('stats'); ctl({ op: 'stats' }); await waitPage('stats', a, 3000);
        a = mark('stop'); ctl({ op: 'stop', why: 'test stop' }); await waitPage('stopped', a, 5000);
        await sleep(2000);
        a = mark('restart'); ctl({ op: 'start', width: 320, height: 240, hz: 4 });
        await waitPage('watching', a, 15000); await sleep(3000);
        a = mark('stop2'); ctl({ op: 'stop', why: 'test done' }); await waitPage('stopped', a, 5000);
        await sleep(1500);
      }
    } else {
      const secs = Number(arg('seconds', '12'));
      const w = await startWatching();
      if (w && w.state === 'watching') await sleep(Math.max(0, secs * 1000 - 1500));
      const b = mark('stop'); ctl({ op: 'stop', why: 'test done' }); await waitPage('stopped', b, 5000);
    }
    out({ result: { plan, pages, seen, blocked, visible: win.isVisible() } });
    win.destroy();
    setTimeout(() => app.exit(0), 200);
  });
}

/* =============================== the runner =============================== */

async function runner() {
  try { os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL); } catch (_) { /* best effort */ }
  require('../../tools/dev-env.js').lowcpu();   // the machine-wide one-browser lock around each Electron
  const { spawn } = require('child_process');
  const Y = require('./_lookaway-y4m');
  let passed = 0; const failures = []; const flakes = [];
  const check = (name, ok, detail) => { if (ok) passed++; else failures.push(name + (detail !== undefined ? ' (' + String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 300) + ')' : '')); return ok; };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-lookaway-page-'));
  const electron = require(require.resolve('electron', { paths: [ROOT] }));
  const run = (plan, clip, extra) => new Promise((resolve) => {
    const args = [__filename, `--plan=${plan}`, `--clip=${clip || 'none'}`, `--profile=${path.join(dir, 'profile-' + plan)}`, '--' + FAKE].concat(extra || []);
    if (!args.includes('--' + FAKE)) throw new Error('refusing to start Electron without the fake camera');
    const env = Object.assign({}, process.env); delete env.MANTLE_TEST_VISIBLE; delete env.ELECTRON_RUN_AS_NODE;
    const p = spawn(electron, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let buf = ''; const lines = [];
    p.stdout.on('data', (c) => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l.startsWith('PAGETEST ')) { try { lines.push(JSON.parse(l.slice(9))); } catch (_) { /* partial */ } } } });
    p.stderr.on('data', () => {});
    const kill = setTimeout(() => { try { p.kill(); } catch (_) { /* gone */ } }, 120000);   // our own child, by its pid
    p.on('exit', (code) => { clearTimeout(kill); for (const l of lines) if (l.flake) flakes.push(plan + ': ' + l.flake); resolve({ code, lines, result: (lines.find((l) => l.result) || {}).result, marks: Object.fromEntries(lines.filter((l) => l.mark).map((l) => [l.mark, l.at])), csp: (lines.find((l) => l.csp) || {}).csp, loaded: lines.find((l) => 'loaded' in l), errors: lines.filter((l) => l.error || l.console || l.unexpectedCall) }); });
  });

  try {
    /* ---- clips ---- */
    const posesClip = path.join(dir, 'poses.y4m');
    Y.buildY4m({ frames: POSES.map((n) => ({ file: n + '.png', seconds: SEG_MS / 1000 })) }, posesClip);
    const twoClip = path.join(dir, 'two.y4m');
    buildTwo(Y, twoClip);

    /* ---- poses ---- */
    const P = await run('poses', posesClip);
    check('poses: the page loaded and stayed hidden', P.loaded && P.loaded.loaded && P.loaded.visible === false && P.result && P.result.visible === false, P.loaded);
    // expected in the console: the CSP probe's own refusal, and MediaPipe's runtime writing its INFO line
    // ("Created TensorFlow Lite XNNPACK delegate for CPU") through console.error. Anything else is a fault.
    const errs = P.errors.filter((l) => !(l.console && (/example\.invalid/.test(l.console) || /^INFO: /.test(l.console))));
    check('poses: no harness error or console error', errs.length === 0, errs.slice(0, 3));
    const R = P.result || { pages: [], seen: [], blocked: [] };
    const watch = R.pages.find((p) => p.state === 'watching');
    check('poses: the camera opened at 320x240 (the fake camera, never the real one)', watch && watch.width === 320 && watch.height === 240, watch);
    check('poses: the page cannot reach the network (CSP blocks fetch before any request is made)', /^blocked/.test(P.csp || '') && R.blocked.length === 0, { csp: P.csp, blocked: R.blocked });
    const M = P.marks;
    const inRun = R.seen.filter((o) => o.at >= M.watching && o.at < M.rate2);
    const KEYS = new Set(['at', 't', 'face', 'score', 'yaw', 'pitch', 'size', 'ms']);
    check('poses: every "seen" carries numbers only (no image, no text)', R.seen.length > 0 && R.seen.every((o) => Object.keys(o).every((k) => KEYS.has(k)) && Object.values(o).every((v) => v === null || typeof v === 'number' || typeof v === 'boolean')), R.seen.find((o) => Object.keys(o).some((k) => !KEYS.has(k))));
    // which still was in front of the camera: the clip starts at 'watching' and loops; frames near a
    // boundary (the start time is known to ~0.2 s) are not judged
    const loopMs = POSES.length * SEG_MS;
    const seg = (o) => { const pos = ((o.at - M.watching) % loopMs + loopMs) % loopMs; const off = pos % SEG_MS; return off < 700 || off > SEG_MS - 500 ? null : POSES[Math.floor(pos / SEG_MS)]; };
    const by = {}; for (const n of POSES) by[n] = inRun.filter((o) => seg(o) === n);
    const share = (xs) => xs.length ? xs.filter((o) => o.face).length / xs.length : 0;
    const med = (xs) => { const a = xs.filter((x) => typeof x === 'number').sort((p, q) => p - q); return a.length ? a[a.length >> 1] : null; };
    const yaw = (n) => med(by[n].filter((o) => o.face).map((o) => o.yaw));
    const summary = Object.fromEntries(POSES.map((n) => [n, { n: by[n].length, face: +share(by[n]).toFixed(2), yaw: yaw(n), size: med(by[n].filter((o) => o.face).map((o) => o.size)) }]));
    console.log('poses: ' + JSON.stringify(summary));
    check('poses: facing the camera is a face in nearly every frame', by.frontal.length >= 8 && share(by.frontal) >= 0.9, summary.frontal);
    check('poses: facing the camera reads as a near-zero head turn', Math.abs(yaw('frontal')) <= 10, summary.frontal);
    check('poses: a turned head (eyes still on the camera) is a face, turned clearly further than frontal', share(by.turned) >= 0.8 && Math.abs(yaw('turned') - yaw('frontal')) >= 10, summary.turned);
    check('poses: a full profile is no face, or a head turned past 45', by.profile.length >= 8 && by.profile.every((o) => !o.face || Math.abs(o.yaw - yaw('frontal')) > 45), summary.profile);
    check('poses: an empty room is never a face', by.empty.length >= 8 && share(by.empty) === 0, summary.empty);
    // the schedule: hz 4 is 4 a second (the old rule gave 3.33), then 2 and 5
    const rate = (from, to) => { const xs = R.seen.filter((o) => o.at >= from && o.at < to); return xs.length / ((to - from) / 1000); };
    const r4 = rate(M.watching + 1000, M.rate2), r2 = rate(M.rate2 + 1000, M.rate5), r5 = rate(M.rate5 + 1000, M.stats);
    console.log('rates: ' + JSON.stringify({ hz4: +r4.toFixed(2), hz2: +r2.toFixed(2), hz5: +r5.toFixed(2) }));
    check('poses: hz 4 looks at 4 frames a second (3.8-4.2)', r4 >= 3.8 && r4 <= 4.2, r4);
    check('poses: after rate 2, 2 a second (1.8-2.2)', r2 >= 1.8 && r2 <= 2.2, r2);
    check('poses: after rate 5, 5 a second on a 10 fps camera (4.7-5.2)', r5 >= 4.7 && r5 <= 5.2, r5);
    const st = R.pages.find((p) => p.state === 'stats' && p.at >= M.stats);
    const camSecs = (M.stats - M.watching) / 1000;
    check('poses: every frame is closed (the 10 fps camera kept sending: >= 8 a second)', st && st.stats && st.stats.frames / camSecs >= 8, st && { frames: st.stats.frames, secs: camSecs });
    check('poses: inference takes under 40 ms a frame on average', st && st.stats && st.stats.msMean > 0 && st.stats.msMean < 40, st && st.stats);
    const stopped = R.pages.find((p) => p.state === 'stopped' && p.at >= M.stop);
    check('poses: stop releases every camera track (the light goes off)', stopped && stopped.released === true && stopped.reason === 'test stop', stopped);
    const after = R.seen.filter((o) => o.at > (stopped ? stopped.at : M.stop) + 300 && o.at < M.restart);
    check('poses: nothing is looked at after stop', after.length === 0, after.length);
    const watchCount = R.pages.filter((p) => p.state === 'watching' && p.at >= M.watching && p.at < M.rate2).length;
    check('poses: a second start while watching is ignored (one camera open)', watchCount === 1, watchCount);
    const re = R.pages.find((p) => p.state === 'watching' && p.at >= M.restart);
    const reSeen = R.seen.filter((o) => o.at >= M.restart && o.at < M.stop2);
    check('poses: start after stop opens the camera again and looks again', !!re && reSeen.length >= 6, { re: !!re, n: reSeen.length });
    const stopped2 = R.pages.find((p) => p.state === 'stopped' && p.at >= M.stop2);
    check('poses: the second stop releases the camera too', stopped2 && stopped2.released === true, stopped2);
    check('poses: the run never failed after it started watching', !R.pages.some((p) => p.state === 'failed' && p.at >= M.watching), R.pages.find((p) => p.state === 'failed'));

    /* ---- Chromium's own pattern ---- */
    const F = await run('pattern', 'none', ['--seconds=12']);
    const fr = F.result || { seen: [], pages: [] };
    const fs_ = fr.seen.filter((o) => o.at >= (F.marks.watching || 0) + 500);
    const fshare = fs_.length ? fs_.filter((o) => o.face).length / fs_.length : 1;
    console.log('pattern: ' + JSON.stringify({ n: fs_.length, faceShare: +fshare.toFixed(3) }));
    check('pattern: the camera opened (Chromium\'s fake pattern)', fr.pages.some((p) => p.state === 'watching'), fr.pages.map((p) => p.state));
    check('pattern: the fake pattern is (almost) never a face (<= 5% of frames)', fs_.length >= 30 && fshare <= 0.05, { n: fs_.length, share: fshare });

    /* ---- two faces: the largest is his ---- */
    const T2 = await run('two', twoClip, ['--seconds=' + (3 * TWO_SEG_MS * 2 / 1000)]);
    const tr = T2.result || { seen: [], pages: [] };
    const tw = T2.marks.watching || 0;
    const tseg = (o) => { const L = 3 * TWO_SEG_MS; const pos = ((o.at - tw) % L + L) % L; const off = pos % TWO_SEG_MS; return off < 700 || off > TWO_SEG_MS - 500 ? null : ['big', 'both', 'small'][Math.floor(pos / TWO_SEG_MS)]; };
    const sz = (k) => med(tr.seen.filter((o) => o.face && tseg(o) === k).map((o) => o.size));
    const sizes = { big: sz('big'), both: sz('both'), small: sz('small') };
    console.log('two faces: ' + JSON.stringify(sizes));
    check('two: the big face alone and the small face alone are both seen', sizes.big > 0 && sizes.small > 0 && sizes.small < sizes.big * 0.8, sizes);
    check('two: with both in frame, the size is the big face\'s (within 10%)', sizes.both > 0 && Math.abs(sizes.both - sizes.big) <= sizes.big * 0.1, sizes);

    /* ---- the camera refused ---- */
    const D = await run('denied', 'none');
    const dr = D.result || { seen: [], pages: [] };
    const df = dr.pages.find((p) => p.state === 'failed');
    check('denied: a refused camera fails with plain words, released, nothing seen', df && /did not allow the camera/.test(df.reason) && df.released === true && dr.seen.length === 0, df || dr.pages.map((p) => p.state));
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  }
  for (const f of failures) console.log('FAIL ' + f);
  if (flakes.length) console.log('NOTE the fake camera ended its track right after start ' + flakes.length + ' time(s), and the next start worked: ' + flakes.join('; '));
  console.log(`LOOKAWAY PAGE TEST: ${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
}

/* A clip of the frontal still at two sizes on the empty wall: big alone, both, small alone. */
function buildTwo(Y, outPath) {
  const png = (n) => Y.decodePng(fs.readFileSync(path.join(Y.FIXTURES, n + '.png')));
  const wall = png('empty'); const front = png('frontal');
  const scaled = (img, f) => {
    const w = Math.round(img.w * f), h = Math.round(img.h * f); const o = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const s = (Math.min(img.h - 1, Math.floor(y / f)) * img.w + Math.min(img.w - 1, Math.floor(x / f))) * 4;
      img.rgba.copy(o, (y * w + x) * 4, s, s + 4);
    }
    return { w, h, rgba: o };
  };
  const frame = (parts) => {
    const c = { w: 320, h: 240, rgba: Buffer.from(wall.rgba) };
    for (const [img, ox, oy] of parts) for (let y = 0; y < img.h; y++) img.rgba.copy(c.rgba, ((oy + y) * c.w + ox) * 4, y * img.w * 4, (y + 1) * img.w * 4);
    return Y.rgbaToI420(c.rgba, 320, 240);
  };
  const big = scaled(front, BIG), small = scaled(front, SMALL);
  const bigAt = [big, 0, 240 - big.h], smallAt = [small, 320 - small.w, 240 - small.h];
  const n = Math.round(TWO_SEG_MS / 100);
  const parts = [Buffer.from('YUV4MPEG2 W320 H240 F10:1 Ip A1:1 C420jpeg\n', 'ascii')];
  for (const yuv of [frame([bigAt]), frame([bigAt, smallAt]), frame([smallAt])]) for (let i = 0; i < n; i++) parts.push(Buffer.from('FRAME\n', 'ascii'), yuv);
  fs.writeFileSync(outPath, Buffer.concat(parts));
}
