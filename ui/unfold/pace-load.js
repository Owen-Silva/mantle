'use strict';
/*
 * pace-load.js - frame pacing of the unlock unfold UNDER LOAD, the way an unlock or a wake loads this
 * laptop (lane unfold-perf, 2026-10-24). The plain pace numbers come from a quiet machine and show no
 * drops, while the live log showed 19-26 dropped of ~44 on unlock and wake: right then Windows repaints
 * everything, Mantle's own video wallpaper starts playing again in the SAME GPU process, and the
 * sidecar takes a fresh full-screen picture that crosses two processes as a multi-MB PNG.
 *
 *   node ui/unfold/pace-load.js [--runs=4] [--loads=quiet,cpu,gpu,sustained,burst] [--arms=none,raise] [--cpu=4] [--gpu=256]
 *   -> "UNFOLD PACE LOAD <load> <arm>: n plays, dropped [..], p95 [..], max [..], early [..] ..."
 *      per arm (none; raise = the priority step a play takes, unfold.test {op:"raise"}), the arms
 *      interleaved run by run, each taking each slot in turn, so drift hits them alike.
 *
 * ONE hidden --test Mantle of this checkout (lib/test-quiet.js: nothing drawn on screen, no key taken),
 * driven like lib/features/unfold.e2e.test.js: test-only lock / unlock fires (the session is NEVER
 * locked), the real sidecar picture, the real overlay window, the real IPC.
 * THE LOAD (only while a play is measured, then off again):
 *   cpu  N node processes spinning (they inherit the run's Below Normal class, like the test itself);
 *   gpu  a full-screen canvas in another page of the SAME instance (Mantle's desktop page when there is
 *        one) that redraws a 2D frame, uploads it and runs a fragment shader of K steps every frame:
 *        the shape of a full-screen video wallpaper playing behind the overlay.
 *   cpu, gpu: one of the two; sustained: both, on from 300 ms before the unlock until the play is over;
 *   burst: on from 300 ms before the unlock, off --burst ms after it (800: in the play's first frames:
 *   an unlock's own burst easing off).
 * Run it under the machine's test gate and the heavy-test queue (one Electron instance machine-wide).
 */
require('../../tools/dev-env.js').lowcpu();
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const PROFILE = 'unfoldperf';
const USER_DATA = path.join(os.tmpdir(), `mantle-test-${PROFILE}`);
const PORT_FILE = path.join(USER_DATA, 'DevToolsActivePort');
const SIDECAR = process.env.MANTLE_SIDECAR_EXE || path.join(ROOT, 'sidecar', 'bin-next', 'Mantle.Sidecar.exe');
const MLOCK = path.join(os.tmpdir(), 'mantle-electron-lock');
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const RUNS = Math.max(1, parseInt(arg('runs', '4'), 10) || 4);
const LOADS = arg('loads', 'quiet,cpu,gpu,sustained,burst').split(',').filter(Boolean);
const CPU = Math.max(0, parseInt(arg('cpu', '4'), 10));
const GPU = Math.max(0, parseInt(arg('gpu', '256'), 10));
const ARMS = arg('arms', 'none,raise').split(',');
const BURST_MS = Math.max(100, parseInt(arg('burst', '800'), 10) || 800);   // the burst load ends this long after the unlock
const GAP_MS = 3300;      // > the core's 3 s debounce between two plays
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, step) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(step || 250); } }

const cli = require.resolve('electron/cli.js', { paths: [ROOT] });
const env = Object.assign({}, process.env, { MANTLE_SIDECAR_EXE: SIDECAR });
delete env.MANTLE_TEST_VISIBLE;
function launch() {
  try { fs.unlinkSync(PORT_FILE); } catch (_) { /* none yet */ }
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
const call = (cmd, a) => `window.mantle.call(${JSON.stringify(cmd)}, ${JSON.stringify(a === undefined ? {} : a)}).then((r) => r, (e) => ({ ok: false, threw: e && e.message ? e.message : String(e) }))`;

/* ---- the load ----------------------------------------------------------------------------------- */

// the GPU competitor, injected into a page: a full-screen canvas, a 2D frame redrawn and uploaded and a
// K-step fragment shader run over it every frame; window.__load.on(bool) starts and stops it
const GPU_SRC = (K) => `(() => {
  if (window.__load) return true;
  const c = document.createElement('canvas');
  const dpr = window.devicePixelRatio || 1;
  c.width = Math.round(screen.width * dpr); c.height = Math.round(screen.height * dpr);
  c.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483646;opacity:0.01';
  document.documentElement.appendChild(c);
  const gl = c.getContext('webgl', { alpha: false, antialias: false });
  const src = document.createElement('canvas'); src.width = 960; src.height = 540;
  const g = src.getContext('2d');
  const sh = (t, s) => { const x = gl.createShader(t); gl.shaderSource(x, s); gl.compileShader(x); return x; };
  const p = gl.createProgram();
  gl.attachShader(p, sh(gl.VERTEX_SHADER, 'attribute vec2 a; varying vec2 v; void main(){ v = a*0.5+0.5; gl_Position = vec4(a,0.,1.); }'));
  gl.attachShader(p, sh(gl.FRAGMENT_SHADER, 'precision highp float; varying vec2 v; uniform sampler2D s; uniform float t; void main(){ vec3 c = texture2D(s, v).rgb; float a = 0.0; for (int i = 0; i < ${K}; i++) { a += sin(v.x * float(i) + t) * cos(v.y * float(i) - t); } gl_FragColor = vec4(c * 0.5 + 0.5 * fract(a), 1.0); }'));
  gl.bindAttribLocation(p, 0, 'a'); gl.linkProgram(p); gl.useProgram(p);
  const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,1,1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const ut = gl.getUniformLocation(p, 't');
  let on = false, n = 0;
  const tick = (ts) => {
    if (!on) return;
    n++;
    const gr = g.createLinearGradient(0, 0, 960, 540); gr.addColorStop(0, 'hsl(' + (n * 3 % 360) + ',60%,50%)'); gr.addColorStop(1, '#223');
    g.fillStyle = gr; g.fillRect(0, 0, 960, 540);
    for (let i = 0; i < 30; i++) { g.fillStyle = 'rgba(255,255,255,0.1)'; g.beginPath(); g.arc((i * 97 + n * 7) % 960, (i * 53 + n * 3) % 540, 30 + i, 0, 7); g.fill(); }
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.viewport(0, 0, c.width, c.height); gl.uniform1f(ut, ts / 1000); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    requestAnimationFrame(tick);
  };
  window.__load = { on: (x) => { if (x && !on) { on = true; c.style.display = ''; requestAnimationFrame(tick); } else if (!x) { on = false; c.style.display = 'none'; } return n; }, frames: () => n };
  c.style.display = 'none';
  return true;
})()`;

function cpuOn(n) {
  const kids = [];
  for (let i = 0; i < n; i++) kids.push(spawn(process.execPath, ['-e', 'const end = Date.now() + 20000; while (Date.now() < end) {}'], { stdio: 'ignore', windowsHide: true }));
  return () => { for (const k of kids) { try { k.kill(); } catch (_) { /* gone */ } } };
}

/* ---- main --------------------------------------------------------------------------------------- */

const rows = {};   // `${load} ${arm}` -> [{...}]
let mlock = false;
async function main() {
  if (process.platform !== 'win32') { console.log('UNFOLD PACE LOAD: SKIPPED (Windows only)'); return; }
  if (!fs.existsSync(SIDECAR)) { console.log(`UNFOLD PACE LOAD: NOT RUN, no sidecar exe at ${SIDECAR}`); return; }
  const run = launch();
  const open = [];
  let stopCpu = null, gpu = null;
  try {
    const port = await until(() => { try { return parseInt(fs.readFileSync(PORT_FILE, 'utf8').split('\n')[0], 10) || null; } catch (_) { return null; } }, 9 * 60000, 250);
    if (!port) { console.log('UNFOLD PACE LOAD: FAILED, no DevTools port\n' + run.out.slice(-600)); return; }
    const barT = await until(async () => { try { return (await targets(port)).find((t) => /\/ui\/bar\//.test(t.url)) || null; } catch (_) { return null; } }, 30000, 300);
    const bar = await attach(barT); open.push(bar);
    await until(() => bar.ev('!!(window.mantle && window.mantle.call)'), 10000, 200);
    const T = (op, extra) => bar.ev(call('unfold.test', Object.assign({ op }, extra || {})));
    const status = () => bar.ev(call('unfold.status'));
    const fire = (what) => T('fire', { what });
    const s0 = await until(async () => { const s = await status(); return s && s.phase === 'idle' && s.windows >= 1 ? s : null; }, 20000, 400);
    if (!s0) { console.log('UNFOLD PACE LOAD: FAILED, the feature never came up'); return; }
    const all = await until(async () => { try { const l = await targets(port); return l.some((t) => /\/ui\/unfold\//.test(t.url)) ? l : null; } catch (_) { return null; } }, 15000, 300);
    const ov = await attach(all.find((t) => /\/ui\/unfold\//.test(t.url))); open.push(ov);
    // the GPU competitor: the desktop page when the instance has one (the wallpaper's own page), else the biggest other page
    const host = all.find((t) => /\/ui\/desktop\//.test(t.url)) || all.find((t) => !/\/ui\/(unfold|bar)\//.test(t.url));
    if (GPU > 0 && host) { gpu = await attach(host); open.push(gpu); await gpu.ev(GPU_SRC(GPU)); }
    console.log(`info: display ${JSON.stringify((await T('state')).list[0] || null)}; gpu load in ${host ? host.url.replace(/^.*\/ui\//, 'ui/').replace(/\?.*$/, '') : 'none'} (${GPU} steps), cpu load ${CPU} spinners; ${RUNS} runs per arm, loads ${LOADS.join(',')}, arms ${ARMS.join(',')}`);
    await T('option', { when: 'unlock' });
    await T('tech', { tech: 'gl' });
    await T('realInput', { on: false });
    await sleep(5000);   // the instance's own start-up settles first (the e2e's lesson)
    for (let i = 0; i < 60 && !mlock; i++) { try { fs.mkdirSync(MLOCK); mlock = true; } catch (_) { await sleep(2000); } }
    if (!mlock) console.log('info: the measurement lock (mantle-electron-lock) was held elsewhere for 2 min: measured WITHOUT it');

    let lastGo = 0;
    async function playOnce(load, arm) {
      const w = lastGo + GAP_MS - Date.now(); if (w > 0) await sleep(w);
      await T('raise', { on: arm === 'raise' });
      const before = (await status()).plays;
      await fire('lock');
      const armed = await until(async () => { const x = await T('state'); return x.phase === 'armed' ? x : null; }, 2000, 30);
      if (!armed) return { err: 'not armed' };
      await until(async () => { const p = await ov.ev('window.__unfold.state()'); return p && p.pose === 'armed'; }, 1500, 30);
      await sleep(250);
      let off = null, gpuN = null, gpu0 = 0;
      if (load !== 'quiet') {
        const useG = gpu && load !== 'cpu';
        const stopC = CPU && load !== 'gpu' ? cpuOn(CPU) : null;
        if (useG) { gpu0 = await gpu.ev('window.__load.frames()'); await gpu.ev('window.__load.on(true)'); }
        off = async () => { if (stopC) stopC(); if (useG) gpuN = (await gpu.ev('window.__load.on(false)')) - gpu0; };
        await sleep(300);
      }
      let offTimer = null;
      if (off && load === 'burst') offTimer = setTimeout(() => { off(); off = null; }, BURST_MS);
      lastGo = Date.now();
      await fire('unlock');
      const s = await until(async () => { const x = await status(); return x.phase === 'idle' && x.plays === before + 1 ? x : null; }, 6000, 40);
      if (offTimer) clearTimeout(offTimer);
      if (off) await off();
      if (!s) return { err: 'no play counted' };
      const l = s.last || {}, st = l.stats || {}, p = l.prep || {};
      return { dropped: st.dropped, p95: st.p95, max: st.max, frames: st.frames, early: st.early, worstAt: st.worstAt, lagged: st.lagged, lagMax: st.lagMax,
        drawMax: st.drawMax, longTasks: st.longTasks, longMs: st.longMs, captureMs: l.captureMs, decode: p.decode, build: p.build, first: p.first,
        mainLag: l.mainLag, stillMB: l.stillMB, gpuN, raised: l.raised, skipped: l.skipped || null };
    }

    for (let i = 0; i < RUNS; i++) {
      for (const load of LOADS) {
        const k = i % ARMS.length, order = ARMS.slice(k).concat(ARMS.slice(0, k));   // each arm takes each slot in turn
        for (const arm of order) {
          const r = await playOnce(load, arm);
          (rows[`${load} ${arm}`] = rows[`${load} ${arm}`] || []).push(r);
          console.log(`run ${i + 1} ${load} ${arm}: ${r.err ? `ERROR ${r.err}` : `dropped ${r.dropped} (early ${r.early}), p95 ${r.p95}, max ${r.max} at ${r.worstAt} ms, frames ${r.frames}, lagged ${r.lagged} (max ${r.lagMax}), draw max ${r.drawMax}, long ${r.longTasks}/${r.longMs} ms | picture ${r.captureMs} ms ${r.stillMB} MB, decode ${r.decode}, build ${r.build}, first ${r.first}, main lag ${r.mainLag}, gpu load frames ${r.gpuN}, raised ${r.raised}${r.skipped ? ' SKIPPED ' + r.skipped : ''}`}`);
        }
      }
    }
    const med = (xs) => { const s = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
    const sum = (xs) => xs.filter((x) => typeof x === 'number').reduce((a, b) => a + b, 0);
    for (const load of LOADS) {
      for (const arm of ARMS) {
        const r = (rows[`${load} ${arm}`] || []).filter((x) => !x.err && !x.skipped);
        console.log(`UNFOLD PACE LOAD ${load} ${arm}: ${r.length} plays, dropped [${r.map((x) => x.dropped)}] total ${sum(r.map((x) => x.dropped))} (early ${sum(r.map((x) => x.early))}), ` +
          `p95 [${r.map((x) => x.p95)}] median ${med(r.map((x) => x.p95))} ms, max [${r.map((x) => x.max)}] ms, lagged ${sum(r.map((x) => x.lagged))}, long tasks ${sum(r.map((x) => x.longTasks))}, ` +
          `first frame median ${med(r.map((x) => x.first))} ms, picture median ${med(r.map((x) => x.captureMs))} ms`);
      }
    }
    const lines = run.out.split(/\r?\n/).filter((l) => /unfolded after/.test(l));
    console.log(`info: the instance's own log, last unfold lines (${lines.length} in all):`);
    for (const l of lines.slice(-3)) console.log(`  log| ${l.slice(0, 700)}`);
    console.log(`info: log holds picture data: ${/data:image|;base64,|[A-Za-z0-9+/]{300,}/.test(run.out) ? 'YES (a bug)' : 'no'}`);
  } finally {
    if (stopCpu) stopCpu();
    if (mlock) { try { fs.rmdirSync(MLOCK); } catch (_) { /* gone */ } }
    for (const p of open) p.close();
    if (!run.exited) {
      const envMsg = Object.assign({}, env, { LOWCPU: '0' });
      spawnSync(process.execPath, [cli, '.', '--quit', '--test', `--profile-name=${PROFILE}`], { cwd: ROOT, env: envMsg, encoding: 'utf8', timeout: 30000, windowsHide: true });
      await until(() => run.exited, 8000, 200);
    }
    if (!run.exited) {
      spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'tools', 'kill-test.ps1'), '-Match', PROFILE], { encoding: 'utf8', timeout: 30000 });
      await until(() => run.exited, 15000, 200);
    }
  }
}
main().catch((e) => { console.log(`UNFOLD PACE LOAD: FAILED ${String((e && e.stack) || e).slice(0, 600)}`); }).then(() => process.exit(0));
