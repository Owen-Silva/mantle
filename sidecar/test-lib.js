// test-lib.js - the plumbing every sidecar test needs, so a feature lane's
// `sidecar/test-<name>.js` is its checks and nothing else (wave 3, 2026-09-24).
//
//   const T = require('./test-lib');
//   (async () => {
//     const t = T.checker('CLIPBOARD');                  // prints "CLIPBOARD TEST: n passed, m failed"
//     const s = await T.startPassive();                   // your exe: --exe=... or MANTLE_SIDECAR_EXE
//     const r = await s.send('clip.list', {}, 4000);      // {id, ok, result} or {id, ok:false, error}
//     t.check('clip.list answers', r.ok === true, JSON.stringify(r).slice(0, 200));
//     const ev = await s.waitEvent('clip', 3000);         // a Features.Event push, or throws on timeout
//     await s.stop();                                     // quit, wait, kill if it will not go
//     process.exit(t.summary());
//   })();
//
// ALWAYS passive (--passive): a test sidecar never hooks the keyboard, never moves a window and
// refuses every write to the user's machine; a feature's write must answer FeatureTable.PassiveRefusal
// here, and a test should assert that it does. Plain node, no deps.
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const HERE = __dirname;

/** The exe under test: --exe=<path>, else MANTLE_SIDECAR_EXE, else sidecar/bin (never auto-built). */
function exePath(argv) {
  const a = ((argv || process.argv).find((x) => x.startsWith('--exe=')) || '').slice('--exe='.length) ||
            process.env.MANTLE_SIDECAR_EXE || '';
  return a ? path.resolve(a) : path.join(HERE, 'bin', 'Mantle.Sidecar.exe');
}

/** The words a passive sidecar refuses a write with (Program and FeatureTable.PassiveRefusal). */
const PASSIVE_REFUSAL = 'refused: sidecar is passive (test mode)';

/**
 * A running sidecar with request/reply correlation over its stdout lines. `args` are the exe's
 * own flags. Returns { proc, send, waitEvent, waitExit, events, stderr }:
 *   send(cmd, extra, timeoutMs=8000) -> Promise<reply>   (rejects only on timeout)
 *   waitEvent(name, timeoutMs, pred?) -> Promise<event>  (an already-seen match resolves at once)
 *   waitExit(timeoutMs) -> Promise<{code, signal, at}>
 *   events: every {ev} line so far, in order (unparseable lines arrive as ev '__unparseable')
 */
function spawnSidecar(exe, args) {
  const proc = spawn(exe, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  const events = [];
  const eventWaiters = [];
  let nextId = 1;
  let buf = '';
  let stderr = '';
  let exited = null;

  proc.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
  proc.on('exit', (code, signal) => { exited = { code, signal, at: Date.now() }; });
  // A sidecar that died must not leave a write to its stdin throwing out of a test.
  proc.stdin.on('error', () => {});

  proc.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (e) {
        events.push({ ev: '__unparseable', line });
        continue;
      }
      if (msg.ev !== undefined) {
        events.push(msg);
        for (let k = eventWaiters.length - 1; k >= 0; k--) {
          const w = eventWaiters[k];
          if (w.name === msg.ev && (!w.pred || w.pred(msg))) { w.resolve(msg); eventWaiters.splice(k, 1); }
        }
      } else if (pending.has(msg.id)) {
        const done = pending.get(msg.id);
        pending.delete(msg.id);
        done(msg);
      } else {
        events.push({ ev: '__unmatched', msg });
      }
    }
  });

  function send(cmd, extra, timeoutMs) {
    const id = nextId++;
    const req = Object.assign({ id, cmd }, extra || {});
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`no reply to "${cmd}" within ${timeoutMs || 8000}ms`));
      }, timeoutMs || 8000);
      pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      proc.stdin.write(JSON.stringify(req) + '\n');
    });
  }

  function waitEvent(name, timeoutMs, pred) {
    const already = events.find((e) => e.ev === name && (!pred || pred(e)));
    if (already) return Promise.resolve(already);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no "${name}" event within ${timeoutMs}ms`)), timeoutMs);
      eventWaiters.push({ name, pred, resolve: (m) => { clearTimeout(timer); resolve(m); } });
    });
  }

  function waitExit(timeoutMs) {
    if (exited) return Promise.resolve(exited);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`still running after ${timeoutMs}ms`)), timeoutMs);
      proc.on('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, at: Date.now() }); });
    });
  }

  return { proc, send, waitEvent, waitExit, events, get stderr() { return stderr; } };
}

/**
 * A passive sidecar, ready to be asked: spawned with its own scratch state file, the `ready`
 * event awaited. Adds:
 *   call(cmd, extra, timeoutMs) -> result, or throws Error(the sidecar's plain-words error)
 *   collect(name) -> every event of that name so far
 *   stop() -> `quit`, wait up to 3 s, kill if it will not go; deletes the state file
 * Throws (with the exe path in the message) if the exe is missing or never says ready.
 */
async function startPassive(opts) {
  const o = opts || {};
  const exe = o.exe || exePath();
  if (!fs.existsSync(exe)) {
    throw new Error(`no sidecar exe at ${exe}: build yours with sidecar/build.ps1 -Out <path> and pass --exe=<path> or MANTLE_SIDECAR_EXE`);
  }
  const stateFile = o.stateFile || path.join(os.tmpdir(), `mantle-sidecar-lib-${process.pid}-${Date.now()}.state.json`);
  const s = spawnSidecar(exe, ['--passive', '--parent-pid=' + process.pid, '--state-file=' + stateFile].concat(o.args || []));
  try {
    s.ready = await s.waitEvent('ready', o.readyMs || 8000);
  } catch (e) {
    try { s.proc.kill(); } catch (_) { /* already gone */ }
    throw new Error(`${exe} never said ready (${e.message})${s.stderr ? `; stderr: ${s.stderr.slice(0, 300)}` : ''}`);
  }
  s.exe = exe;
  s.stateFile = stateFile;
  s.call = async (cmd, extra, timeoutMs) => {
    const r = await s.send(cmd, extra, timeoutMs);
    if (!r.ok) throw new Error(r.error || `"${cmd}" failed and gave no reason`);
    return r.result;
  };
  s.collect = (name) => s.events.filter((e) => e.ev === name);
  s.stop = async () => {
    try { s.proc.stdin.write(JSON.stringify({ id: 999999, cmd: 'quit' }) + '\n'); } catch (_) { /* gone */ }
    try { await s.waitExit(3000); } catch (_) { try { s.proc.kill(); } catch (__) { /* gone */ } }
    try { fs.unlinkSync(stateFile); } catch (_) { /* never written, or already gone */ }
  };
  return s;
}

/**
 * Pass/fail bookkeeping with ONE summary line, the house format: "<LABEL> TEST: n passed, m failed",
 * then one indented line per failure. summary() returns the exit code (0 only with no failures
 * and at least one pass: a suite that checked nothing did not pass).
 */
function checker(label) {
  let passed = 0;
  const failures = [];
  return {
    check(name, ok, detail) {
      if (ok) { passed++; return true; }
      failures.push(detail ? `${name} (${detail})` : name);
      return false;
    },
    fail(name, detail) { failures.push(detail ? `${name} (${detail})` : name); return false; },
    get passed() { return passed; },
    get failures() { return failures.slice(); },
    summary() {
      console.log(`${label} TEST: ${passed} passed, ${failures.length} failed`);
      for (const f of failures) console.log('  FAIL ' + f);
      return failures.length || !passed ? 1 : 0;
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { exePath, spawnSidecar, startPassive, checker, sleep, PASSIVE_REFUSAL };
