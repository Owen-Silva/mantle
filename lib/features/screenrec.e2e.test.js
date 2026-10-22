'use strict';
/*
 * screenrec.e2e.test.js - screen recording END TO END (lane screenrec2, 2026-10-15): a hidden --test Mantle
 * of this checkout records the test's OWN stand-in window through screenrec.start, exactly as the
 * Win+G panel would call it, and the file is read back.
 *
 *   node lib/features/screenrec.e2e.test.js     -> "SCREENREC E2E TEST: n passed, m failed"
 *
 * NEVER THE USER'S SCREEN. The stand-in is `Mantle.Sidecar.exe --rec-standin --at=under,1920,1080`: opaque, at
 * the BOTTOM of the z-order (behind the desktop), never activated; it closes itself if it would have been
 * visible. The test instance is told its hwnd and pid (MANTLE_REC_TEST_STANDIN), so every recording is of
 * that window or a crop inside it, and the recorder itself refuses anything else (test:true + allowPid).
 * Files go to a fresh %TEMP% folder that is deleted at the end, pass or fail; nothing is opened, nothing
 * touches the clipboard (the --test card's Open / Copy only log). Run it under the heavy-test mutex.
 *
 * Checks: screenrec.start -> recording (startMs); the pill window exists and is WDA_EXCLUDEFROMCAPTURE
 * (0x11, read back from Windows by the feature); the pill page shows the living timer; screenrec.stop ->
 * done, the file in the test folder, its size, frame rate and frame count (--rec-probe), the crop's size;
 * the pill became the card ("Recording saved"); Open / Copy in --test do not launch or copy; closing the
 * card DESTROYS the window (nothing left between recordings); a refusal is a "Not recording" card.
 */
require('../../tools/dev-env.js').lowcpu();
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const PROFILE = 'screenrece2e';
const USER_DATA = path.join(os.tmpdir(), `mantle-test-${PROFILE}`);
const PORT_FILE = path.join(USER_DATA, 'DevToolsActivePort');
const EXE = path.join(ROOT, 'sidecar', 'bin', 'Mantle.Sidecar.exe');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-rec-e2e-'));
const SECS = Number(process.env.SCREENREC_E2E_SECS) || 3;

let passed = 0; const failures = [];
function check(name, ok, detail) { if (ok) passed++; else failures.push(`${name}${detail !== undefined ? ` (${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 400)})` : ''}`); return ok; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, step) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(step || 250); } }
function gaming() {
  try {
    const n = spawnSync('powershell', ['-NoProfile', '-Command', '@(Get-Process VALORANT*,RiotClientServices,javaw,Minecraft*,RobloxPlayerBeta -ErrorAction SilentlyContinue).Count'], { encoding: 'utf8', windowsHide: true });
    return parseInt((n.stdout || '').trim(), 10) || 0;
  } catch (_) { return -1; }
}
function lines(proc, onEvent) {
  let buf = '';
  proc.stdout.on('data', (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) { try { onEvent(JSON.parse(l)); } catch (_) { /* not ours */ } } }
  });
}
function standIn() {
  const p = spawn(EXE, ['--rec-standin', '--at=under,1920,1080', '--secs=180'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('the stand-in did not say its window within 10 s')), 10000);
    lines(p, (e) => { if (e.ev === 'standin') { clearTimeout(t); if (e.hidden === true) resolve(Object.assign(e, { proc: p })); else reject(new Error('the stand-in would have been VISIBLE, so it closed itself')); } });
    p.on('exit', (c) => { clearTimeout(t); reject(new Error(`the stand-in exited (${c})`)); });
  });
}
function probe(file) {
  const r = spawnSync(EXE, [`--rec-probe=${file}`], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  try { return JSON.parse((r.stdout || '').trim().split('\n').pop()); } catch (_) { return { error: (r.stdout || '') + (r.stderr || '') }; }
}

const cli = require.resolve('electron/cli.js', { paths: [ROOT] });
function launch(env) {
  try { fs.unlinkSync(PORT_FILE); } catch (_) { /* none yet */ }
  const run = { out: '', exited: null };
  run.proc = spawn(process.execPath, [cli, '.', '--test', `--profile-name=${PROFILE}`, '--remote-debugging-port=0'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  run.proc.stdout.on('data', (c) => { run.out += c.toString('utf8'); });
  run.proc.stderr.on('data', (c) => { run.out += c.toString('utf8'); });
  run.proc.on('exit', (code) => { run.exited = { code }; });
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
const PAGE_LOOK = `(() => { const $ = (i) => document.getElementById(i); const s = $('shape');
  return { shown: !!s && !s.hidden, pill: !$('pill').hidden, card: !$('card').hidden, clock: $('clock').textContent, title: $('title').textContent, detail: $('detail').textContent }; })()`;

let skipped = null;
async function main() {
  if (process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true') { skipped = 'on CI: no desktop session to capture'; return; }
  if (process.platform !== 'win32') { skipped = 'Windows only'; return; }
  const g = gaming();
  if (g !== 0) { skipped = g > 0 ? 'a game is running' : 'could not check for a running game'; return; }
  if (!fs.existsSync(EXE)) { check('the sidecar is built', false, EXE); return; }

  const si = await standIn();
  check('the stand-in is hidden behind the desktop, 1920 x 1080', si.hidden === true && si.w === 1920 && si.h === 1080, { hidden: si.hidden, w: si.w, h: si.h });
  const env = Object.assign({}, process.env, { MANTLE_REC_TEST_STANDIN: `${si.hwnd}:${si.pid}:${si.w}:${si.h}`, MANTLE_REC_TEST_DIR: DIR });
  delete env.MANTLE_TEST_VISIBLE;   // a test copy never shows (lib/test-quiet.js)
  const run = launch(env);
  const open = [];
  try {
    const port = await until(() => { try { return parseInt(fs.readFileSync(PORT_FILE, 'utf8').split('\n')[0], 10) || null; } catch (_) { return null; } }, 45000, 250);
    if (!check('the --test instance opens its DevTools port', !!port, run.out.slice(-600))) return;
    const barT = await until(async () => { try { return (await targets(port)).find((t) => /\/ui\/bar\//.test(t.url)) || null; } catch (_) { return null; } }, 30000, 300);
    if (!check('the bar page is up (the commands are called from it)', !!barT, run.out.slice(-600))) return;
    const bar = await attach(barT); open.push(bar);
    await until(() => bar.ev('!!(window.mantle && window.mantle.call)'), 10000, 200);

    const st0 = await until(async () => { const s = await bar.ev(call('screenrec.state')); return s && s.enabled !== undefined ? s : null; }, 20000, 300);
    check('screenrec is on, idle, with NO window (nothing between recordings)', st0 && st0.enabled === true && st0.phase === 'idle' && st0.window === false, st0);

    // a refusal first: too small an area
    const no = await bar.ev(call('screenrec.start', { kind: 'region', rect: { x: 0, y: 0, w: 30, h: 30 } }));
    check('refused: too small, in plain words', no && no.ok === false && /too small to record/.test(no.reason), no);
    await bar.ev(call('screenrec.cardClose'));

    // the recording: an area, which a test turns into a crop INSIDE the stand-in
    const t0 = Date.now();
    const r = await bar.ev(call('screenrec.start', { kind: 'region', rect: { x: 0, y: 0, w: 1280, h: 720 }, via: 'e2e' }));
    const wallMs = Date.now() - t0;
    check('screenrec.start -> recording', r && r.ok === true && r.startMs > 0, r);
    const st1 = await bar.ev(call('screenrec.state'));
    check('state: recording, 1280 x 720, 30 fps', st1.phase === 'recording' && st1.w === 1280 && st1.h === 720 && st1.fps === 30, st1);
    check('the pill window exists and is WDA_EXCLUDEFROMCAPTURE (0x11) by Windows\' own word', st1.window === true && st1.affinity === 0x11, { window: st1.window, affinity: st1.affinity });
    const pageT = await until(async () => (await targets(port)).find((t) => /\/ui\/screenrec\//.test(t.url)) || null, 8000, 200);
    let pg = null;
    if (check('the pill page is loaded', !!pageT)) {
      pg = await attach(pageT); open.push(pg);
      const p1 = await until(async () => { const l = await pg.ev(PAGE_LOOK); return l.shown && /^0:0\d$/.test(l.clock) ? l : null; }, 4000, 150);
      check('the pill shows the living timer', !!p1, await pg.ev(PAGE_LOOK));
    }
    await sleep(SECS * 1000);
    const s = await bar.ev(call('screenrec.stop'));
    check('screenrec.stop -> stopped', s && s.ok && s.stopped === true, s);
    const done = await until(async () => { const x = await bar.ev(call('screenrec.state')); return x.phase === 'done' || x.phase === 'failed' ? x : null; }, 20000, 200);
    check('state: done', done && done.phase === 'done', done);
    const file = done && done.path;
    check('the file is in the test folder, named "Recording <date> <time>.mp4"', !!file && path.dirname(file).toLowerCase() === DIR.toLowerCase() && /^Recording \d{4}-\d\d-\d\d \d{6}\.mp4$/.test(path.basename(file)), file);
    const size = file && fs.existsSync(file) ? fs.statSync(file).size : 0;
    check('the file is there, not empty, no .part left', size > 10000 && !fs.readdirSync(DIR).some((n) => n.endsWith('.part')), { size, dir: fs.readdirSync(DIR) });
    if (size) {
      const p = probe(file);
      check('probe: 1280 x 720 at 30 fps', p.w === 1280 && p.h === 720 && Math.round(p.fps) === 30, p);
      check(`probe: about ${SECS} s of frames`, p.frames >= SECS * 30 - 15 && p.frames <= (SECS + 2) * 30, p);
    }
    if (pg) {
      const c = await until(async () => { const l = await pg.ev(PAGE_LOOK); return l.card ? l : null; }, 3000, 150);
      check('the pill became the card: "Recording saved"', c && c.title === 'Recording saved' && /0:0\d · 1280 × 720 · /.test(c.detail), c);
    }
    const o = await bar.ev(call('screenrec.cardOpen'));
    const cp = await bar.ev(call('screenrec.cardCopy'));
    const fo = await bar.ev(call('screenrec.cardFolder'));
    check('--test: Open, Copy and Show in folder only log', o.ok && o.test && cp.ok && cp.test && fo.ok && fo.test, { o, cp, fo });
    await bar.ev(call('screenrec.cardClose'));
    const gone = await until(async () => { const x = await bar.ev(call('screenrec.state')); return x.window === false ? x : null; }, 3000, 150);
    check('closing the card destroys the window (zero cost idle)', !!gone);
    console.log(`SCREENREC E2E: start ${r && r.startMs} ms (command round trip ${wallMs} ms), ${size} bytes for ${SECS} s at 1280 x 720 / 30 fps`);

    const q = await bar.ev(call('shell.quit')).catch((e) => ({ threw: e.message }));
    const exited = await until(() => run.exited, 30000, 250);
    check('shell.quit: the instance exits by itself', !!exited, { q, tail: run.out.slice(-400) });
  } finally {
    for (const p of open) p.close();
    if (!run.exited) {
      spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'tools', 'kill-test.ps1'), '-Match', PROFILE], { encoding: 'utf8', timeout: 30000 });
      await until(() => run.exited, 15000, 200);
    }
    try { si.proc.stdin.write('close\n'); si.proc.stdin.end(); } catch (_) { /* gone */ }
  }
}

main().catch((e) => check('the run itself', false, e && e.stack ? e.stack : String(e))).then(() => {
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (_) { /* below */ }
  check('cleanup: every test file is deleted', !fs.existsSync(DIR), DIR);
  if (skipped) console.log(`SCREENREC E2E: skipped: ${skipped}`);
  for (const f of failures) console.log('FAIL ' + f);
  console.log(`SCREENREC E2E TEST: ${passed} passed, ${failures.length} failed${skipped ? ' (skipped: ' + skipped + ')' : ''}`);
  process.exit(failures.length ? 1 : 0);
});
