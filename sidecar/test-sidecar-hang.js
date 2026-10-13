'use strict';
/*
 * test-sidecar-hang.js - the liveness check in lib/sidecar.js against the REAL sidecar exe.
 *
 *   node sidecar/test-sidecar-hang.js
 *
 * Audit #11 (2026-10-12): a sidecar that is alive but frozen never exits, so before the check it
 * was never restarted and the bar went dead while the status said ok. Here the Sidecar class runs
 * this worktree's sidecar\bin\Mantle.Sidecar.exe in --passive mode (it refuses every shell change)
 * with a temp state file and short health options, then SUSPENDS that one child by its own pid
 * (ntdll NtSuspendProcess through koffi) and checks it is ended, restarted with a new pid, back to
 * ok and answering. Only the pid this test spawned is ever touched; never the live Mantle sidecar or
 * another lane's. Prints one summary line: "SIDECAR HANG: n passed, m failed".
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const koffi = require('koffi');
const { Sidecar } = require('../lib/sidecar');

const ROOT = path.resolve(__dirname, '..');
const EXE = path.join(__dirname, 'bin', 'Mantle.Sidecar.exe');

const kernel32 = koffi.load('kernel32.dll');
const ntdll = koffi.load('ntdll.dll');
const OpenProcess = kernel32.func('void * __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)');
const CloseHandle = kernel32.func('int __stdcall CloseHandle(void *h)');
const NtSuspendProcess = ntdll.func('int32_t __stdcall NtSuspendProcess(void *h)');
const NtResumeProcess = ntdll.func('int32_t __stdcall NtResumeProcess(void *h)');
const PROCESS_SUSPEND_RESUME = 0x0800;

/** NtSuspendProcess / NtResumeProcess on exactly one pid; returns the NTSTATUS (0 = done). */
function suspendResume(pid, resume) {
  const h = OpenProcess(PROCESS_SUSPEND_RESUME, 0, pid);
  if (!h) return -1;
  try { return resume ? NtResumeProcess(h) : NtSuspendProcess(h); } finally { CloseHandle(h); }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (_) { return false; }
}

const tick = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (pred()) return true; await tick(25); }
  return pred();
}

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(name + (detail ? ' -- ' + detail : ''));
}

async function main() {
  if (!fs.existsSync(EXE)) {
    failures.push('no sidecar exe in this worktree (run npm run build:sidecar)');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-hang-'));
  const sc = new Sidecar({
    exePath: EXE, buildScript: null, passive: true, cwd: ROOT,
    stateFile: path.join(dir, 'shell-state.json'),
    restartDelayMs: 200, healthMs: 500, healthTimeoutMs: 300, healthMisses: 3,
  });
  const seen = [];
  const logs = [];
  sc.on('status', (st) => seen.push(st.status + ': ' + st.reason));
  sc.on('log', (l) => logs.push(String(l.message)));
  const ours = new Set();   // every pid this test spawned, and only those
  let suspended = 0;
  try {
    await sc.start();
    await waitFor(() => sc.status === 'ok', 20000);
    const pid1 = sc.proc && sc.proc.pid;
    if (pid1) ours.add(pid1);
    check('real sidecar: comes up ok in passive', sc.status === 'ok' && !!pid1 && sc.info && sc.info.passive === true, sc.status + ' ' + JSON.stringify(sc.info));
    if (sc.status !== 'ok' || !pid1) return;

    // Healthy for 3 s with a 300 ms limit: the real ping answers in time, nothing is ended.
    await tick(3000);
    check('real sidecar: a healthy helper is never ended (6 checks at 300 ms)', sc.healthKills === 0 && sc.proc && sc.proc.pid === pid1, `kills=${sc.healthKills}`);

    // Freeze it: alive, but not one thread runs.
    const st = sc.proc && sc.proc.pid === pid1 ? suspendResume(pid1, false) : -2;
    if (st === 0) suspended = pid1;
    check('suspend: NtSuspendProcess on our own child', st === 0, `status ${st}`);
    const t0 = Date.now();
    await waitFor(() => sc.healthKills === 1 && sc.status === 'ok' && sc.proc && sc.proc.pid !== pid1, 15000);
    const ms = Date.now() - t0;
    const pid2 = sc.proc && sc.proc.pid;
    if (pid2) ours.add(pid2);
    check('hang: noticed, ended and restarted with a NEW pid, back to ok', sc.healthKills === 1 && sc.status === 'ok' && pid2 && pid2 !== pid1, `kills=${sc.healthKills} status=${sc.status} pids ${pid1}->${pid2} after ${ms} ms`);
    check('hang: within ~3 intervals plus the restart (< 5 s)', ms < 5000, `${ms} ms`);
    await waitFor(() => !alive(pid1), 3000);
    check('hang: the frozen process is gone', !alive(pid1), `pid ${pid1}`);
    if (!alive(pid1)) suspended = 0;
    check('hang: the status said the helper is not answering', seen.some((s) => /^down: the helper is not answering/.test(s)) && seen.some((s) => /^down: sidecar was stopped because the helper is not answering .*restarting in/.test(s)), seen.slice(-6).join(' | '));
    check('hang: one log line, no paths', logs.filter((l) => /did not answer 3 pings in a row/.test(l)).length === 1 && !logs.some((l) => /did not answer/.test(l) && /[\\/]/.test(l)), logs.slice(-4).join(' | '));
    let ping = null;
    try { ping = await sc.call('ping', {}, 4000); } catch (err) { ping = { error: err.message }; }
    check('restarted: answers ping as the new process', ping && ping.pid === pid2, JSON.stringify(ping && { pid: ping.pid, error: ping.error }));
    await tick(2000);
    check('restarted: stays up (still the same pid, no more kills)', sc.healthKills === 1 && sc.proc && sc.proc.pid === pid2 && sc.status === 'ok', `kills=${sc.healthKills} pid=${sc.proc && sc.proc.pid}`);
  } finally {
    // Our own children only: a still-suspended one is resumed then ended; the rest stopped politely.
    if (suspended && alive(suspended)) { suspendResume(suspended, true); try { process.kill(suspended); } catch (_) {} }
    const proc = sc.proc;
    sc.stop();
    if (proc && proc.exitCode === null) await Promise.race([new Promise((r) => proc.once('exit', r)), tick(4000)]);
    for (const pid of ours) if (alive(pid)) { try { process.kill(pid); } catch (_) {} }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}

main().catch((err) => failures.push('the test itself threw: ' + (err && err.stack || err))).then(() => {
  for (const f of failures) console.log('FAIL ' + f);
  console.log('SIDECAR HANG: ' + passed + ' passed, ' + failures.length + ' failed');
  process.exit(failures.length ? 1 : 0);
});
