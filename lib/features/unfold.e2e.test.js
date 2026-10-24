'use strict';
/*
 * unfold.e2e.test.js - the Unfold on unlock / wake and the screen cover END TO END in ONE hidden --test
 * Mantle of this checkout (lane unfold-unlock, 2026-10-23). Modelled on emoji.e2e.test.js: the instance is
 * spawned with a DevTools port, the bar page calls the feature's TEST-ONLY command (unfold.test {op},
 * lib/features/unfold.js) and unfold.status, and the overlay page (ui/unfold/) is read over CDP.
 *
 *   node lib/features/unfold.e2e.test.js     -> "UNFOLD E2E TEST: n passed, m failed"
 *
 * NOTHING REACHES THE USER: a --test instance draws nothing and takes no key (lib/test-quiet.js; the
 * overlay windows are alpha 0 and click-through), the real session is NEVER locked, slept or turned off:
 * every lock / unlock / display / input is the test-only unfold.test {op:'fire'}. The only real signal is
 * step 6 (unfold.simulate through the real passive sidecar ends the input watch like real input); Owen's
 * own mouse may also reveal the cover in that step, and both count as a pass.
 *
 * THE STEPS: up and parked; lock arms (black, shown, nothing captured); unlock plays and parks (pictures
 * dropped); in-situ frame pacing of 5 plays with the shipped technique (layers) and 5 with the contract's
 * clip-path + filter: blur (css), at the display's real size; input finishes a play; the real sidecar
 * input path reveals a cover; the bus cover / reveal timed; the 'wake' option; the tray switch off (no
 * arm, the cover still works); --quit through a second instance (windows gone, the log says unfold: and
 * holds no picture data).
 *
 * SKIPS, with the reason printed, and counts as no failure: on CI and when a game is running.
 */
require('../../tools/dev-env.js').lowcpu();
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const PROFILE = 'unfolde2e';
const USER_DATA = path.join(os.tmpdir(), `mantle-test-${PROFILE}`);
const PORT_FILE = path.join(USER_DATA, 'DevToolsActivePort');
const SIDECAR = path.join(ROOT, 'sidecar', 'bin-next', 'Mantle.Sidecar.exe');
const MLOCK = path.join(os.tmpdir(), 'mantle-electron-lock');
const PACE_RUNS = 5;
const GAP_MS = 3300;      // > the core's 3 s debounce between two plays

let passed = 0; const failures = [];
function check(name, ok, detail) { if (ok) passed++; else failures.push(`${name}${detail !== undefined ? ` (${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 500)})` : ''}`); return ok; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, step) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(step || 250); } }
function gaming() {
  try {
    const n = spawnSync('powershell', ['-NoProfile', '-Command', '@(Get-Process VALORANT*,RiotClientServices,javaw,Minecraft*,RobloxPlayerBeta -ErrorAction SilentlyContinue).Count'], { encoding: 'utf8', windowsHide: true });
    return parseInt((n.stdout || '').trim(), 10) || 0;
  } catch (_) { return -1; }
}

/** the sidecar exe of THIS tree: rebuilt when sidecar/*.cs is newer than it */
function sidecarFresh() {
  let exeAt = 0;
  try { exeAt = fs.statSync(SIDECAR).mtimeMs; } catch (_) { /* not built */ }
  const dir = path.join(ROOT, 'sidecar');
  const newer = fs.readdirSync(dir).filter((f) => f.endsWith('.cs')).some((f) => fs.statSync(path.join(dir, f)).mtimeMs > exeAt);
  if (!newer) return { ok: true, built: false };
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(dir, 'build.ps1'), '-Out', SIDECAR], { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 240000 });
  return { ok: r.status === 0 && fs.existsSync(SIDECAR), built: true, out: ((r.stdout || '') + (r.stderr || '')).slice(-600) };
}

const cli = require.resolve('electron/cli.js', { paths: [ROOT] });
const env = Object.assign({}, process.env, { MANTLE_SIDECAR_EXE: SIDECAR });
delete env.MANTLE_TEST_VISIBLE;   // a test copy never shows (lib/test-quiet.js)
const envMsg = Object.assign({}, env, { LOWCPU: '0' });   // the --quit MESSENGER only (README Testing)
function launch() {
  try { fs.unlinkSync(PORT_FILE); } catch (_) { /* none yet */ }
  // a fresh switch and option state: the feature on (its default), Play it = every unlock
  for (const f of [path.join(USER_DATA, 'features.json'), path.join(USER_DATA, 'features', 'unfold.json')]) { try { fs.rmSync(f, { force: true }); } catch (_) { /* none */ } }
  const run = { out: '', exited: null };
  run.proc = spawn(process.execPath, [cli, '.', '--test', `--profile-name=${PROFILE}`, '--remote-debugging-port=0'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  run.proc.stdout.on('data', (c) => { run.out += c.toString('utf8'); });
  run.proc.stderr.on('data', (c) => { run.out += c.toString('utf8'); });
  run.proc.on('exit', (code) => { run.exited = { code, at: Date.now() }; });
  return run;
}
async function targets(port) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  return list.filter((t) => t.type === 'page' && t.url.startsWith('file:') && /\/ui\//.test(t.url));
}
async function attach(t) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  let n = 0;
  const pend = new Map();
  ws.addEventListener('message', (m) => {
    const j = JSON.parse(m.data);
    if (j.id && pend.has(j.id)) { const p = pend.get(j.id); pend.delete(j.id); if (j.error) p.rej(new Error(j.error.message)); else p.res(j.result); }
  });
  ws.addEventListener('close', () => { for (const p of pend.values()) p.rej(new Error('the page closed')); pend.clear(); });
  const send = (method, params) => new Promise((res, rej) => { const i = ++n; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('page threw: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
    return r.result.value;
  };
  return { url: t.url, ev, close: () => { try { ws.close(); } catch (_) { /* gone */ } } };
}
const call = (cmd, arg) => `window.mantle.call(${JSON.stringify(cmd)}, ${JSON.stringify(arg === undefined ? {} : arg)}).then((r) => r, (e) => ({ ok: false, threw: e && e.message ? e.message : String(e) }))`;
/** the call timed in the page itself: {r, ms} */
const timedCall = (cmd, arg) => `(async () => { const t = performance.now(); const r = await (${call(cmd, arg)}); return { r, ms: +(performance.now() - t).toFixed(1) }; })()`;

let skipped = null;
const result = { pace: { layers: [], css: [] } };
async function main() {
  if (process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true') { skipped = 'on CI: no desktop session'; return; }
  if (process.platform !== 'win32') { skipped = 'Windows only'; return; }
  const g = gaming();
  if (g !== 0) { skipped = g > 0 ? 'a game is running' : 'could not check for a running game'; return; }
  const sc = sidecarFresh();
  if (!check('the sidecar exe of this tree is built and current', sc.ok, sc)) return;
  if (sc.built) console.log('info: rebuilt the sidecar (a .cs file was newer than the exe)');

  const run = launch();
  const open = [];
  let mlock = false;
  try {
    const port = await until(() => { try { return parseInt(fs.readFileSync(PORT_FILE, 'utf8').split('\n')[0], 10) || null; } catch (_) { return null; } }, 9 * 60000, 250);
    if (!check('the --test instance opens its DevTools port', !!port, run.out.slice(-600))) return;
    const barT = await until(async () => { try { return (await targets(port)).find((t) => /\/ui\/bar\//.test(t.url)) || null; } catch (_) { return null; } }, 30000, 300);
    if (!check('the bar page is up (the feature commands are called from it)', !!barT, run.out.slice(-600))) return;
    const bar = await attach(barT); open.push(bar);
    await until(() => bar.ev('!!(window.mantle && window.mantle.call)'), 10000, 200);
    const T = (op, extra) => bar.ev(call('unfold.test', Object.assign({ op }, extra || {})));
    const st = () => T('state');
    const status = () => bar.ev(call('unfold.status'));
    const fire = (what, extra) => T('fire', Object.assign({ what }, extra || {}));

    // ---- 1. up: one parked overlay window per display
    const s0 = await until(async () => { const s = await status(); return s && s.phase === 'idle' && s.windows >= 1 ? s : null; }, 20000, 400);
    if (!check('1. unfold.status answers: phase idle, at least one overlay window', !!s0, await status())) return;
    const ovTs = await until(async () => { try { const l = (await targets(port)).filter((t) => /\/ui\/unfold\//.test(t.url)); return l.length >= s0.windows ? l : null; } catch (_) { return null; } }, 15000, 300);
    if (!check('1. one overlay page per display (url has /ui/unfold/)', !!ovTs && ovTs.length === s0.windows, { pages: ovTs && ovTs.length, windows: s0.windows })) return;
    const ov = await attach(ovTs[0]); open.push(ov);
    const ps = () => ov.ev('window.__unfold ? window.__unfold.state() : null');
    const p0 = await until(async () => { const p = await ps(); return p && p.pose === 'parked' ? p : null; }, 10000, 200);
    check('1. the overlay page is parked', !!p0, await ps());
    const st0 = await st();
    result.display = st0.list && st0.list[0];
    console.log(`info: ${s0.windows} display(s); first: ${JSON.stringify(result.display)}; watch: display ${s0.display}, lid ${s0.lid}${s0.watchReason ? `, ${s0.watchReason}` : ''}`);
    // the known start: on, every unlock, the shipped technique, no real input watch
    await T('option', { when: 'unlock' });
    await T('tech', { tech: 'layers' });
    await T('realInput', { on: false });
    // the instance's own start-up settles first: the bar's first backdrops share the sidecar's capture
    // lane, and a first unlock seconds after Mantle starts is not the case being tested (run 1, 10-23:
    // 1.5 s after start the first picture took over 1 s and the play was skipped)
    await sleep(5000);

    let lastGo = 0;
    async function gap() { const w = lastGo + GAP_MS - Date.now(); if (w > 0) await sleep(w); }
    async function lockArmed() {
      const r = await fire('lock');
      const s = await until(async () => { const x = await st(); return x.phase === 'armed' ? x : null; }, 2000, 30);
      return { r, s };
    }
    /** one full unlock play: lock (armed), unlock, wait for the play to be counted */
    async function playOnce() {
      await gap();
      const before = (await status()).plays;
      const a = await lockArmed();
      if (!a.s) return { err: { why: 'not armed', a, st: await st() } };
      await until(async () => { const p = await ps(); return p && p.pose === 'armed'; }, 1500, 30);
      await sleep(250);
      lastGo = Date.now();
      await fire('unlock');
      const s = await until(async () => { const x = await status(); return x.phase === 'idle' && x.plays === before + 1 ? x : null; }, 5000, 40);
      if (!s) return { err: { why: 'no play counted', st: await st() } };
      return { s, last: s.last };
    }

    // ---- 2. lock arms: the unlit display, shown, nothing captured
    await gap();
    const a2 = await lockArmed();
    check('2. fire lock -> phase armed', !!a2.s, { r: a2.r, st: await st() });
    const p2 = await until(async () => { const p = await ps(); return p && p.pose === 'armed' && p.stage === 1 ? p : null; }, 2000, 30);
    check('2. the page\'s pose is armed with the stage at opacity 1', !!p2, await ps());
    const s2 = await st();
    check('2. the overlay window is shown', s2.visible === true, s2.visible);
    check('2. nothing captured yet (no play, no picture on the page)', s2.plays === 0 && !s2.last && p2 && p2.still === false, { plays: s2.plays, last: s2.last, still: p2 && p2.still });

    // ---- 3. unlock plays it, then the window hides and the page parks without its pictures
    lastGo = Date.now();
    await fire('unlock');
    const s3 = await until(async () => { const x = await status(); return x.phase === 'idle' && x.plays === 1 ? x : null; }, 5000, 40);
    check('3. fire unlock -> phase back to idle, plays 1', !!s3, await st());
    const l3 = s3 && s3.last;
    check('3. status.last: played >= 1, not skipped', !!l3 && l3.played >= 1 && !l3.skipped, l3);
    check('3. status.last.captureMs is a number below 900', !!l3 && typeof l3.captureMs === 'number' && l3.captureMs < 900, l3 && l3.captureMs);
    check('3. status.last.stats.frames > 20', !!l3 && l3.stats && l3.stats.frames > 20, l3 && l3.stats);
    if (l3) { result.first = l3; console.log(`info: first play: picture ${l3.captureMs} ms, prep ${l3.prepMs} ms, total ${l3.totalMs} ms, stats ${JSON.stringify(l3.stats)}`); }
    const h3 = await until(async () => { const x = await st(); return x.visible === false ? x : null; }, 1500, 30);
    check('3. the overlay window is hidden after the play', !!h3, (await st()).visible);
    const pk3 = await until(async () => { const p = await ps(); return p && p.pose === 'parked' && p.still === false ? p : null; }, 1500, 30);
    check('3. the page is parked with its pictures dropped (still false)', !!pk3, await ps());

    // ---- 4. in-situ frame pacing: the real overlay window at the display's real size
    for (let i = 0; i < 60 && !mlock; i++) { try { fs.mkdirSync(MLOCK); mlock = true; } catch (_) { await sleep(2000); } }
    if (!mlock) console.log('info: the machine-wide measurement lock (mantle-electron-lock) was held by another lane for 2 min: pacing measured WITHOUT it');
    for (const tech of ['layers', 'css']) {
      const t = await T('tech', { tech });
      check(`4. tech set to ${tech}`, t && t.tech === tech, t);
      let firstErr = null;
      for (let i = 0; i < PACE_RUNS; i++) {
        const o = await playOnce();
        if (o.err) { firstErr = firstErr || o.err; continue; }
        const x = o.last.stats || {};
        result.pace[tech].push({ frames: x.frames, p50: x.p50, p95: x.p95, max: x.max, dropped: x.dropped, long: x.long, vsync: x.vsync, ms: x.ms, captureMs: o.last.captureMs, prepMs: o.last.prepMs, skipped: o.last.skipped || null });
      }
      check(`4. all ${PACE_RUNS} ${tech} plays played (not skipped)`, result.pace[tech].length === PACE_RUNS && result.pace[tech].every((r) => !r.skipped && r.frames > 0), { n: result.pace[tech].length, firstErr, runs: result.pace[tech] });
      for (const [k, r] of result.pace[tech].entries()) console.log(`UNFOLD PACE ${tech} #${k + 1}: frames ${r.frames}, p50 ${r.p50} ms, p95 ${r.p95} ms, max ${r.max} ms, dropped ${r.dropped} (long ${r.long}, vsync ${r.vsync} ms, ${r.ms} ms long), picture ${r.captureMs} ms, prep ${r.prepMs} ms`);
    }
    if (mlock) { try { fs.rmdirSync(MLOCK); } catch (_) { /* gone */ } mlock = false; }
    const back = await T('tech', { tech: 'layers' });
    check('4. tech back to layers', back && back.tech === 'layers', back);

    // ---- 5. input after the grace period finishes a play at once
    await gap();
    const f0 = (await status()).finishes;
    const a5 = await lockArmed();
    if (check('5. armed for the input check', !!a5.s, await st())) {
      await until(async () => { const p = await ps(); return p && p.pose === 'armed'; }, 1500, 30);
      await sleep(250);
      lastGo = Date.now();
      const tU = Date.now();
      await fire('unlock');
      await sleep(400);
      // the watch starts 0.28 s after the picture came (the grace); fire input once it is on
      const w5 = await until(async () => { const x = await st(); return x.inputFor === 'play' ? x : null; }, 1500, 15);
      check('5. the play\'s input watch is on (after the grace)', !!w5, await st());
      const tIn = Date.now();
      await fire('input');
      const s5 = await until(async () => { const x = await status(); return x.phase === 'idle' ? x : null; }, 500, 15);
      const took = Date.now() - tIn;
      check('5. input -> phase idle within 500 ms', !!s5, { took, st: await st() });
      const s5b = await status();
      check('5. finishes +1', s5b.finishes === f0 + 1, { before: f0, after: s5b.finishes, last: s5b.last });
      check('5. status.last says input ended it (finishedBy input)', s5b.last && s5b.last.finishedBy === 'input', s5b.last);
      console.log(`info: input fired ${tIn - tU} ms after the unlock; idle ${took} ms after the input; last ${JSON.stringify(s5b.last && { finishedBy: s5b.last.finishedBy, skipped: s5b.last.skipped })}`);
      await until(async () => { const x = await st(); return x.visible === false; }, 1500, 30);
    }

    // ---- 5b. the picture in strips (a busy screen over the sidecar's 4 MB line), stitched by the REAL
    // nativeImage: forced here, as the screen's own content decides it in a live run
    const fs5 = await T('strips', { n: 4 });
    check('5b. strips forced to 4 (test only)', fs5 && fs5.strips === 4, fs5);
    const o5 = await playOnce();
    check('5b. in 4 strips: it played, not skipped', !o5.err && o5.last && o5.last.played >= 1 && !o5.last.skipped, o5.err || o5.last);
    const disp = result.display && result.display.bounds;
    const wantW = disp ? Math.round(disp.width * result.display.scale) : null, wantH = disp ? Math.round(disp.height * result.display.scale) : null;
    const seenSz = o5.last && o5.last.stillPx;
    check('5b. ...over ONE stitched picture at the display\'s full pixels', !!seenSz && seenSz[0] === wantW && seenSz[1] === wantH, { seenSz, wantW, wantH });
    if (!o5.err) console.log(`info: 4 strips: picture ${o5.last.captureMs} ms (stitched in main), prep ${o5.last.prepMs} ms, stats ${JSON.stringify(o5.last.stats)}; the page saw ${JSON.stringify(seenSz)}`);
    const fs5b = await T('strips', { n: 0 });
    check('5b. strips back to automatic', fs5b && fs5b.strips === 0, fs5b);

    // ---- 6. the REAL sidecar input path ends a cover
    const ri = await T('realInput', { on: true });
    check('6. realInput on', ri && ri.realInput === true, ri);
    const c6 = await T('cover', { from: 'e2e' });
    const byOwen = !!c6 && c6.ok === false && /revealed before/.test(String(c6.reason));
    check('6. cover -> ok true (or already revealed by real input)', !!c6 && (c6.ok === true || byOwen), c6);
    let realBy = byOwen ? 'real input (during the cover)' : null;
    if (!byOwen) {
      const w6 = await st();
      const tok = w6.inputToken;
      const f6 = await fire('sidecar-input', tok ? { token: tok } : {});
      const t6 = Date.now();
      const r6 = await until(async () => { const x = await status(); return x.bus && x.bus.covered === false ? x : null; }, 1000, 15);
      check('6. fire sidecar-input (unfold.simulate through the real sidecar) -> revealed within 1 s', !!r6, { f6, inputFor: w6.inputFor, tok, st: await st() });
      const hist = (await st()).history || [];
      realBy = hist.some((h) => /reveal by input/.test(h.what)) ? `the input event (${Date.now() - t6} ms; simulate answered ${JSON.stringify(f6 && (f6.ok !== undefined ? { ok: f6.ok, error: f6.error } : f6)).slice(0, 120)})` : 'another road';
      check('6. ...and it was the input event that revealed it', hist.some((h) => /reveal by input/.test(h.what)), hist.slice(-6));
    }
    console.log(`info: step 6 revealed by ${realBy}`);
    await until(async () => { const x = await status(); return x.phase === 'idle' ? x : null; }, 1500, 30);
    const ri2 = await T('realInput', { on: false });
    check('6. realInput off again', ri2 && ri2.realInput === false, ri2);

    // ---- 7. the bus: cover, then reveal timed from the call to the answer
    const c7 = await T('cover', { from: 'e2e' });
    check('7. cover -> ok', !!c7 && c7.ok === true, c7);
    const s7 = await status();
    check('7. status.bus: covered by e2e', s7.bus && s7.bus.covered === true && s7.bus.by === 'e2e', s7.bus);
    check('7. the overlay window is shown while covered', (await st()).visible === true);
    const pc7 = await ps();
    check('7. the page wears the cover (pose covered, a picture)', pc7 && pc7.pose === 'covered' && pc7.still === true, pc7);
    const rv = await bar.ev(timedCall('unfold.test', { op: 'reveal', from: 'e2e' }));
    check('7. reveal -> ok', rv && rv.r && rv.r.ok === true, rv);
    check('7. reveal answered in < 600 ms', rv && rv.ms < 600, rv && rv.ms);
    result.revealMs = rv && rv.ms;
    const h7 = await until(async () => { const x = await st(); return x.visible === false && x.phase === 'idle' ? x : null; }, 1000, 20);
    check('7. the overlay is hidden after the reveal', !!h7, await st());
    check('7. status.bus: not covered', (await status()).bus.covered === false);
    console.log(`info: reveal call -> answer ${rv && rv.ms} ms`);

    // ---- 8. the 'wake' option: a lock and unlock plays nothing; a dark display and back plays one
    const o8 = await T('option', { when: 'wake' });
    check('8. option when=wake', o8 && o8.when === 'wake', o8);
    await gap();
    const b8 = (await status()).plays;
    await fire('lock');
    await sleep(400);
    const s8a = await st();
    check('8. wake mode: a lock does not arm', s8a.phase === 'idle' && s8a.visible === false, { phase: s8a.phase, visible: s8a.visible });
    await fire('unlock');
    await sleep(1200);
    check('8. wake mode: lock + unlock plays nothing new', (await status()).plays === b8, await status());
    await fire('display-off');
    const s8b = await until(async () => { const x = await st(); return x.phase === 'armed' ? x : null; }, 1500, 30);
    check('8. display-off arms', !!s8b, await st());
    await until(async () => { const p = await ps(); return p && p.pose === 'armed'; }, 1500, 30);
    await sleep(250);
    lastGo = Date.now();
    await fire('display-on');
    const s8c = await until(async () => { const x = await status(); return x.phase === 'idle' && x.plays === b8 + 1 ? x : null; }, 5000, 40);
    check('8. display-on plays one', !!s8c, await st());
    check('8. ...because the screen turned on', !!s8c && s8c.last && /turned on/.test(s8c.last.why), s8c && s8c.last);
    const o8b = await T('option', { when: 'unlock' });
    check('8. option back to unlock', o8b && o8b.when === 'unlock', o8b);
    await until(async () => { const x = await st(); return x.visible === false; }, 1500, 30);

    // ---- 9. the tray switch off (Mantle Settings' switch: settings.enable = the tray's setEnabled)
    await gap();
    const off = await bar.ev(call('settings.enable', { feature: 'unfold', on: false }));
    check('9. the switch goes off (settings.enable)', off && off.ok === true, off);
    const s9 = await until(async () => { const x = await status(); return x && x.on === false ? x : null; }, 3000, 50);
    check('9. unfold.status says off', !!s9, await status());
    await fire('lock');
    await sleep(500);
    const s9a = await st();
    check('9. switched off: a lock arms nothing', s9a.phase === 'idle' && s9a.visible === false, { phase: s9a.phase, visible: s9a.visible, history: (s9a.history || []).slice(-3) });
    await fire('unlock');
    const c9 = await T('cover', { from: 'e2e' });
    check('9. switched off: the screen cover still works (ok true)', !!c9 && c9.ok === true, c9);
    const r9 = await T('reveal', { from: 'e2e' });
    check('9. switched off: ...and reveals', !!r9 && r9.ok === true && (await until(async () => { const x = await st(); return x.phase === 'idle' && x.visible === false; }, 1000, 20)), { r9, st: await st() });
    const on9 = await bar.ev(call('settings.enable', { feature: 'unfold', on: true }));
    check('9. the switch back on', on9 && on9.ok === true, on9);
    const s9b = await until(async () => { const x = await status(); return x && x.on === true ? x : null; }, 3000, 50);
    check('9. unfold.status says on again', !!s9b, await status());

    // ---- 10. --quit through a second instance: the overlay windows are gone, the log is clean
    for (const p of open.splice(0)) p.close();
    const tq = Date.now();
    const q = spawnSync(process.execPath, [cli, '.', '--quit', '--test', `--profile-name=${PROFILE}`], { cwd: ROOT, env: envMsg, encoding: 'utf8', timeout: 30000, windowsHide: true });
    const gone = await until(async () => {
      if (run.exited) return 'exited';
      try { const l = (await targets(port)).filter((t) => /\/ui\/unfold\//.test(t.url)); return l.length === 0 ? 'no overlay page' : null; } catch (_) { return 'instance gone'; }
    }, 15000, 100);
    check('10. --quit: the overlay windows are gone', !!gone, { q: (q.stdout || '').slice(-200), tail: run.out.slice(-400) });
    const exited = await until(() => run.exited, 30000, 250);
    check('10. --quit: the instance exits', !!exited, run.out.slice(-400));
    if (exited) console.log(`info: --quit -> exit in ${exited.at - tq} ms`);
    const lines = run.out.split(/\r?\n/).filter((l) => /\bunfold: /.test(l));
    check('10. the log has unfold: lines', lines.length > 0, run.out.slice(-400));
    check('10. the log holds NO picture data (data:image / base64)', !/data:image|;base64,|[A-Za-z0-9+/]{300,}/.test(run.out), (run.out.match(/.{0,60}(data:image|;base64,|[A-Za-z0-9+/]{300,}).{0,20}/) || [''])[0].slice(0, 120));
    check('10. no uncaught exception', !/uncaught exception|RESTORE INCOMPLETE/i.test(run.out), (run.out.match(/.*(uncaught exception|RESTORE INCOMPLETE).*/i) || [''])[0]);
    console.log(`info: ${lines.length} unfold: log lines:`);
    for (const l of lines) console.log(`  log| ${l.slice(0, 260)}`);
  } finally {
    if (mlock) { try { fs.rmdirSync(MLOCK); } catch (_) { /* gone */ } }
    for (const p of open) p.close();
    if (!run.exited) {
      spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'tools', 'kill-test.ps1'), '-Match', PROFILE], { encoding: 'utf8', timeout: 30000 });
      await until(() => run.exited, 15000, 200);
    }
  }
}

main().catch((e) => check('the run itself', false, e && e.stack ? e.stack : String(e))).then(() => {
  if (skipped) console.log(`UNFOLD E2E: skipped: ${skipped}`);
  const sum = (xs, k) => xs.map((r) => r[k]);
  for (const tech of ['layers', 'css']) {
    const r = result.pace[tech];
    if (r.length) console.log(`UNFOLD PACE ${tech}: frames [${sum(r, 'frames')}], p95 [${sum(r, 'p95')}] ms, max [${sum(r, 'max')}] ms, dropped [${sum(r, 'dropped')}]`);
  }
  for (const f of failures) console.log('FAIL ' + f);
  console.log(`UNFOLD E2E TEST: ${passed} passed, ${failures.length} failed${skipped ? ' (skipped: ' + skipped + ')' : ''}`);
  process.exit(failures.length ? 1 : 0);
});
