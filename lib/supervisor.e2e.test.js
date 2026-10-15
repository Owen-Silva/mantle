'use strict';
// The CPU cap and the one-browser lock on Owen's PC; a CI runner (cloudtest) has neither file nor need.
try { require('C:/Users/user/dev-tools/tools/lowcpu.js'); } catch (e) { if (process.env.CI !== 'true') throw e; }
/*
 * supervisor.e2e.test.js -- a crash brings Mantle back; a deliberate quit stays quit; a crash loop stops
 * (lane mantle-supervisor, 2026-10-15; design at the top of lib/supervisor.js).
 *
 * One invisible --test instance (lib/test-quiet.js), profile 'mnsupervise', started with --supervise (crash
 * recovery is opt-in for test runs) and --log=<file> (the relaunched main is the SUPERVISOR's child, not
 * ours, so its words are read from that file). Every kill is by pid, of this profile's own processes only:
 *   1. CRASH -> BACK: main killed by its pid; the supervisor starts it again within seconds, the new main
 *      adopts the same supervisor, and says once, in words, that it restarted after a crash (log + pop-up page);
 *   2. QUIT STAYS QUIT: `electron . --quit` (what golive.ps1 does): main and the supervisor both end, and
 *      nothing comes back;
 *   3. RESTORE WINDOWS TASKBAR: after shell.restore (Mantle stays up, paused), a kill is NOT a crash to retry;
 *   4. LOOP GUARD: 3 kills inside 2 minutes -> no 4th start, the restore recorded (dry run in a test),
 *      the supervisor gone; the next start says Mantle had stopped after repeated crashes.
 *   node lib/supervisor.e2e.test.js   -> "SUPERVISOR E2E: n passed, m failed"
 * Refuses while a game runs. Stopped with tools/kill-test.ps1 -Match mnsupervise whatever happens (it stops
 * the supervisor first); never touches the live Mantle or another lane's instance.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PROFILE = 'mnsupervise';
const USER_DATA = path.join(os.tmpdir(), `mantle-test-${PROFILE}`);
const PORT_FILE = path.join(USER_DATA, 'DevToolsActivePort');
const LOG = path.join(os.tmpdir(), `mantle-${PROFILE}-e2e.log`);
const STATE = path.join(USER_DATA, 'supervisor-state.json');
const MAINREC = path.join(USER_DATA, 'supervisor-main.json');
const SUPLOG = path.join(USER_DATA, 'supervisor.log');

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(name + (detail !== undefined ? ' -- ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 700) : ''));
  return ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, every) {
  const end = Date.now() + ms;
  for (;;) {
    let v; try { v = await fn(); } catch (_) { v = null; }
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(every || 250);
  }
}
function ps(cmd) {
  const r = spawnSync('powershell', ['-NoProfile', '-Command', cmd], { encoding: 'utf8', timeout: 30000 });
  return (r.stdout || '').trim();
}
function gaming() { return (parseInt(ps('@(Get-Process VALORANT*,RiotClientServices,javaw,Minecraft*,RobloxPlayerBeta -ErrorAction SilentlyContinue).Count'), 10) || 0) > 0; }
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } };
const readText = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch (_) { return ''; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
/** This profile's MAIN electron pids (no --type= children) and its supervisor pids. */
function procs() {
  const out = ps(`@(Get-CimInstance Win32_Process -Filter "Name='electron.exe' OR Name='Mantle.Sidecar.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('--profile-name=${PROFILE}') } | ForEach-Object { $_.Name + ' ' + $_.ProcessId + ' ' + ($_.CommandLine -match '--type=') + ' ' + ($_.CommandLine -match '--supervise=') })`);
  const r = { mains: [], sups: [] };
  for (const line of out.split(/\r?\n/)) {
    const [name, pid, child, sup] = line.trim().split(' ');
    if (!pid) continue;
    if (/^electron\.exe$/i.test(name) && child === 'False') r.mains.push(Number(pid));
    if (/^Mantle\.Sidecar\.exe$/i.test(name) && sup === 'True') r.sups.push(Number(pid));
  }
  return r;
}

const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist',
  fs.readFileSync(path.join(ROOT, 'node_modules', 'electron', 'path.txt'), 'utf8').trim());
const env = Object.assign({}, process.env);
delete env.MANTLE_TEST_VISIBLE;   // a test copy never shows (lib/test-quiet.js)
delete env.ELECTRON_RUN_AS_NODE;
delete env.MANTLE_SUPERVISOR_PID;
const ARGS = ['.', '--test', `--profile-name=${PROFILE}`, '--supervise', '--remote-debugging-port=0', `--log=${LOG}`];

function launch() {
  try { fs.unlinkSync(PORT_FILE); } catch (_) { /* none */ }
  const run = { out: '', exited: null };
  run.proc = spawn(ELECTRON, ARGS, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  run.proc.stdout.on('data', (c) => { run.out += c.toString('utf8'); });
  run.proc.stderr.on('data', (c) => { run.out += c.toString('utf8'); });
  run.proc.on('exit', (code) => { run.exited = { code }; });
  return run;
}
const portUp = () => { const s = readText(PORT_FILE).split(/\r?\n/)[0]; return /^\d+$/.test(s) ? s : null; };
/** Evaluate in one of the instance's pages (DevTools), e.g. the bar's window.mantle. */
async function inPage(port, urlRe, expr) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const t = list.find((x) => x.type === 'page' && urlRe.test(x.url));
  if (!t) return { error: `no page matching ${urlRe}: ${list.map((x) => x.url.split('/ui/')[1]).join(', ')}` };
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  try {
    const r = await new Promise((res, rej) => {
      ws.addEventListener('message', (m) => { const j = JSON.parse(m.data); if (j.id === 1) (j.error ? rej(new Error(j.error.message)) : res(j.result)); });
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
    });
    if (r.exceptionDetails) return { error: (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text };
    return r.result ? r.result.value : r;
  } finally { try { ws.close(); } catch (_) { /* gone */ } }
}
function killTest() {
  spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'tools', 'kill-test.ps1'), '-Match', PROFILE], { encoding: 'utf8', timeout: 30000 });
}
function fresh() {
  killTest();
  for (const f of [STATE, MAINREC, SUPLOG, LOG, PORT_FILE]) { try { fs.unlinkSync(f); } catch (_) { /* none */ } }
}
const supLog = () => readText(SUPLOG);
/*
 * lowcpu's one-browser lock is let go when OUR child exits, but the instance the supervisor starts again is
 * not our child: keep the lock (same file, same shape) while it runs, so no other lane starts a browser beside it.
 */
const LOCK = path.join(os.tmpdir(), 'claude-headless-browser.lock');
function holdLock() {
  try { fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, time: Date.now(), label: 'supervisor.e2e (an instance the supervisor started)' }), { flag: 'wx' }); } catch (_) { /* held: ours or another's */ }
}
function dropLock() { const cur = readJson(LOCK); if (cur && cur.pid === process.pid) { try { fs.unlinkSync(LOCK); } catch (_) { /* gone */ } } }
const kill = (pid) => { process.kill(pid); setTimeout(holdLock, 300); };

(async () => {
  if (gaming()) { check('not run: a game is running', false); return finish(); }
  fresh();
  try {
    // ---------------------------------------------------------------- 1. CRASH -> BACK
    let run = launch();
    const port1 = await until(() => !run.exited && portUp(), 120000, 300);
    if (!check('the --test --supervise instance started', !!port1, run.out.slice(-800))) return;
    const supPid = Number((/crash recovery on: supervisor pid (\d+) watches this main process \(pid (\d+)\)/.exec(readText(LOG)) || [])[1]);
    check('it says crash recovery is on, with the supervisor\'s pid', supPid > 0, readText(LOG).split('\n').filter((l) => /crash recovery/.test(l)).join(' | '));
    check('the supervisor is a separate, running process', supPid > 0 && alive(supPid) && procs().sups.includes(supPid), procs());
    check('the record names this main', (readJson(MAINREC) || {}).pid === run.proc.pid, readJson(MAINREC));
    const old = run.proc.pid;
    try { fs.unlinkSync(PORT_FILE); } catch (_) { /* gone */ }
    const killedAt = Date.now();
    kill(old);   // TerminateProcess: no quit road, no stand-down = a crash
    const back = await until(() => { const s = readJson(STATE); return s && s.last && s.last.oldPid === old && s.last.restarted && s.last.newPid ? s.last : null; }, 20000);
    if (!check('CRASH: the supervisor started main again', !!back, { state: readJson(STATE), log: supLog().slice(-600) })) return;
    check('CRASH: within a few seconds of the kill', back.startedInMs < 8000 && Date.now() - killedAt < 20000, back.startedInMs);
    check('CRASH: a new main pid, running, with the same profile', back.newPid !== old && alive(back.newPid) && procs().mains.includes(back.newPid), { back, p: procs() });
    check('CRASH: the old main is gone', !alive(old));
    check('CRASH: the supervisor said why, in words, with the code', /stopped unexpectedly: it was ended by another program[^\n]*exit code 0x00000001\); crash 1 of 3/.test(supLog()), supLog().slice(-500));
    const port2 = await until(() => portUp(), 120000, 300);
    check('CRASH: the new instance came all the way up (DevTools answers)', !!port2);
    const told = await until(() => /tells Owen once: Mantle restarted after a crash: it was ended by another program[^\n]* at \d\d:\d\d; it was started again \d+ s later/.test(readText(LOG)), 30000);
    check('CRASH: the new main tells Owen once, in plain words', !!told, readText(LOG).split('\n').filter((l) => /crash recovery|tells Owen/.test(l)).slice(-4).join(' | '));
    check('CRASH: the log line keeps the code and the old pid', new RegExp(`crash recovery: Mantle restarted after a crash: the previous main process \\(pid ${old}\\)[^\\n]*exit 0x00000001`).test(readText(LOG)));
    check('CRASH: the new main ADOPTED the same supervisor (no second one)', new RegExp(`supervisor pid ${supPid} started this main process \\(pid ${back.newPid}\\)`).test(readText(LOG)) && procs().sups.length === 1, procs());
    check('CRASH: marked told, so it is said once', (readJson(MAINREC) || {}).told === back.at, readJson(MAINREC));
    const popup = await until(async () => {
      const v = await inPage(port2, /\/ui\/ontop\/index\.html/, 'document.body.textContent');   // textContent: the box hides itself after ~3.4 s
      return typeof v === 'string' && /Mantle restarted after a crash/.test(v) ? v : null;
    }, 15000, 500);
    check('CRASH: the pop-up page carries the words (drawn, never shown in a test run)', !!popup && /ended by another program/.test(popup), popup);

    // ---------------------------------------------------------------- 2. QUIT STAYS QUIT
    const q = spawnSync(ELECTRON, ['.', '--test', `--profile-name=${PROFILE}`, '--quit'], { cwd: ROOT, env, encoding: 'utf8', timeout: 60000 });
    check('QUIT: --quit was delivered', /asked the running Mantle/.test((q.stdout || '') + (q.stderr || '')), (q.stdout || '') + (q.stderr || ''));
    const mainGone = await until(() => !alive(back.newPid), 30000);
    check('QUIT: main ended', !!mainGone);
    const supGone = await until(() => !alive(supPid), 10000);
    check('QUIT: the supervisor ended with it (golive.ps1 waits for both)', !!supGone);
    check('QUIT: the supervisor read it as a deliberate quit', /quit on purpose \(a second instance asked Mantle to quit\)[^\n]*it is not started again/.test(supLog()), supLog().slice(-400));
    await sleep(6000);
    check('QUIT: nothing came back', procs().mains.length === 0, procs());

    // ---------------------------------------------------------------- 3. RESTORE WINDOWS TASKBAR
    run = launch();
    const port3 = await until(() => !run.exited && portUp(), 120000, 300);
    if (!check('RESTORE: a fresh instance started', !!port3, run.out.slice(-600))) return;
    const sup3 = Number((/crash recovery on: supervisor pid (\d+) watches this main process \(pid (\d+)\)/.exec(run.out) || [])[1]);
    // The DevTools port is written before the bar page has its window.mantle (run 2, 13:04: the first ask
    // threw), so ask until the page answers.
    let last3 = null;
    const r3 = await until(async () => {
      last3 = await inPage(port3, /\/ui\/bar\/index\.html/, "window.mantle.call('shell.restore').then((s) => ({ ok: true, paused: !!s }), (e) => ({ ok: false, e: String(e) }))").catch((e) => ({ error: e.message }));
      return last3 && last3.ok === true ? last3 : null;
    }, 30000, 1000);
    check('RESTORE: "Restore Windows taskbar" answered', !!r3, last3);
    check('RESTORE: it stood the supervisor down', /crash recovery stands down: Windows was put back/.test(run.out) && /Windows was put back/.test(((readJson(MAINREC) || {}).standDown || {}).why || ''), readJson(MAINREC));
    kill(run.proc.pid);
    await until(() => !alive(sup3), 10000);
    check('RESTORE: a kill after it is NOT retried; the supervisor ends', sup3 > 0 && !alive(sup3), sup3);
    check('RESTORE: and says why', /quit on purpose \(Windows was put back \("Restore Windows taskbar"\)\)/.test(supLog()), supLog().slice(-300));
    await sleep(4000);
    check('RESTORE: nothing came back', procs().mains.length === 0, procs());

    // ---------------------------------------------------------------- 4. LOOP GUARD
    fresh();
    run = launch();
    const port4 = await until(() => !run.exited && portUp(), 120000, 300);
    if (!check('LOOP: a fresh instance started', !!port4, run.out.slice(-600))) return;
    const sup4 = Number((/crash recovery on: supervisor pid (\d+) watches this main process/.exec(run.out) || [])[1]);
    let pid = run.proc.pid;
    const t0 = Date.now();
    for (let i = 1; i <= 3; i++) {
      kill(pid);
      if (i === 3) break;
      const l = await until(() => { const s = readJson(STATE); return s && s.last && s.last.oldPid === pid && s.last.newPid ? s.last : null; }, 20000);
      if (!check(`LOOP: crash ${i} was retried`, !!l, readJson(STATE))) return;
      pid = l.newPid;
      await sleep(2500);   // killed while it is still starting: a crash at start counts too
    }
    const gave = await until(() => { const s = readJson(STATE); return s && s.gaveUp ? s : null; }, 20000);
    check('LOOP: the 3rd crash inside 2 minutes stops the retries', !!gave && gave.gaveUp.count === 3 && Date.now() - t0 < 120000, gave);
    check('LOOP: the Windows taskbar restore is the real script with -NoKill (dry run in a test)', !!gave && gave.gaveUp.restore && gave.gaveUp.restore.dryRun === true &&
      /restore-windows\.ps1" -NoKill -StateFile "[^"]*mantle-test-mnsupervise\\shell-state\.json"/.test(gave.gaveUp.restore.command), gave && gave.gaveUp.restore);
    check('LOOP: the supervisor says so, in words', /stopped unexpectedly 3 times inside 2 minutes, so it was NOT started again/.test(supLog()), supLog().slice(-400));
    await until(() => !alive(sup4), 10000);
    check('LOOP: the supervisor is gone', sup4 > 0 && !alive(sup4));
    await sleep(5000);
    check('LOOP: no 4th start', procs().mains.length === 0, procs());
    check('LOOP: the crash count was cleared for next time', gave && Array.isArray(gave.crashes) && gave.crashes.length === 0);

    // the next start (Owen's, by hand or at logon) says it
    run = launch();
    const port5 = await until(() => !run.exited && portUp(), 120000, 300);
    check('LOOP: the next start came up', !!port5);
    const said = await until(() => /tells Owen once: Mantle had stopped after repeated crashes: it stopped 3 times in 2 minutes, so it was not started again until now/.test(run.out), 20000);
    check('LOOP: the next start tells Owen it had stopped, and why', !!said, run.out.split('\n').filter((l) => /crash recovery|tells Owen/.test(l)).join(' | '));
    spawnSync(ELECTRON, ['.', '--test', `--profile-name=${PROFILE}`, '--quit'], { cwd: ROOT, env, encoding: 'utf8', timeout: 60000 });
    await until(() => procs().mains.length === 0 && procs().sups.length === 0, 30000);
  } catch (e) {
    check('no exception in the test itself', false, e.stack);
  } finally {
    killTest();
    dropLock();
    finish();
  }
})();

function finish() {
  for (const f of failures) console.log('FAIL ' + f);
  console.log(`SUPERVISOR E2E: ${passed} passed, ${failures.length} failed`);
  process.exitCode = failures.length ? 1 : 0;
}
