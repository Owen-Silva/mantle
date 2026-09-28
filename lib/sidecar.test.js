'use strict';
/*
 * sidecar.test.js - lib/sidecar.js: a call made while the sidecar is starting waits for its ready line.
 *
 *   node lib/sidecar.test.js
 *
 * The case it was written for (2026-09-27): in 57 of 57 reviewed starts, calls made before the
 * sidecar printed {"ev":"ready"} were refused at once ("cannot run X: sidecar started, waiting for
 * its ready line") -- the pinned list came up short, the wallpaper could not pause for full screen,
 * the first battery read failed. And 35 runs warned MaxListenersExceeded for the fixed set of
 * 'ready' subscribers.
 *
 * No real sidecar is started: this file doubles as the FAKE child. Run with --fake-child <mode>
 * it speaks the JSON-lines protocol (modes: ready:<ms>, never, exit:<ms>), and the Sidecar is
 * pointed at it through the constructor's spawnImpl test seam. Prints one summary line; exits 1
 * if anything failed.
 */
const { spawn } = require('child_process');

// ---------------------------------------------------------------- the fake sidecar
function fakeChild(mode) {
  const [kind, msText] = mode.split(':');
  const ms = Number(msText) || 0;
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  if (kind === 'ready') setTimeout(() => out({ ev: 'ready', pid: process.pid, version: 'fake-1', passive: true }), ms);
  if (kind === 'exit') {
    setTimeout(() => {
      process.stderr.write('fake sidecar: could not install the shell hook\n');
      process.exit(3);
    }, ms);
  }
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const m = JSON.parse(line);
      if (m.cmd === 'quit') process.exit(0);
      // secreview 2026-09-27: a reply / event line bigger than the client's 4 MB line cap, full
      // of a marker standing in for window titles or file names that must never reach the log.
      if (m.cmd === 'huge') { out({ id: m.id, ok: true, result: { text: 'SECRET-TITLE '.repeat(Math.ceil(m.bytes / 13)) } }); continue; }
      if (m.cmd === 'hugeev') { out({ ev: 'windows', list: [{ title: 'SECRET-TITLE '.repeat(Math.ceil(m.bytes / 13)) }] }); out({ id: m.id, ok: true, result: { cmd: m.cmd } }); continue; }
      if (m.cmd === 'apps') out({ id: m.id, ok: true, result: { apps: ['explorer', 'code'], ttl: m.ttl } });
      else out({ id: m.id, ok: true, result: { cmd: m.cmd, ttl: m.ttl } });
    }
  });
  process.stdin.on('end', () => process.exit(0));   // the real sidecar's kill switch
  setInterval(() => {}, 1 << 30);                     // stay up until stdin ends
}

// ---------------------------------------------------------------- the harness
const { Sidecar } = require('./sidecar');

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(name + (detail ? ' -- ' + detail : ''));
}

const warnings = [];
process.on('warning', (w) => warnings.push(w));
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** A Sidecar whose "exe" is this file run as a fake child in `mode`. */
function fake(mode, extra = {}) {
  return new Sidecar(Object.assign({
    exePath: process.execPath,      // exists, so start() does not try to build
    buildScript: null,
    passive: true,
    cwd: __dirname,
    spawnImpl: (exe, args, opts) => spawn(process.execPath, [__filename, '--fake-child', mode, ...args], opts),
  }, extra));
}

/** Settle a promise into {ok, value|error, ms} measured from t0. */
function settle(p, t0) {
  return p.then(
    (value) => ({ ok: true, value, ms: Date.now() - t0 }),
    (err) => ({ ok: false, error: err && err.message, ms: Date.now() - t0 }));
}

/** When status next becomes `status`, as ms from t0. */
function whenStatus(sc, status, t0) {
  return new Promise((r) => {
    const on = (s) => { if (s.status === status) { sc.removeListener('status', on); r(Date.now() - t0); } };
    sc.on('status', on);
  });
}

async function shutdown(sc) {
  const proc = sc.proc;
  sc.stop();
  if (proc && proc.exitCode === null && proc.signalCode === null) {
    await Promise.race([new Promise((r) => proc.once('exit', r)), tick(3000)]);
  }
}

async function main() {
  // ---- 6a. no process at all: refused at once, as before
  {
    const sc = fake('ready:0');
    const t0 = Date.now();
    const r = await settle(sc.call('apps'), t0);
    check('no proc: refused at once', !r.ok && r.ms < 50, JSON.stringify(r));
    check('no proc: the words name the command and why', /^cannot run "apps": sidecar has not been started yet/.test(r.error || ''), r.error);
  }

  // ---- 1. a call at 0 ms waits for a ready line ~300 ms later and gets the child's answer
  {
    const sc = fake('ready:300');
    const t0 = Date.now();
    const readyAt = whenStatus(sc, 'ok', t0);
    await sc.start();
    check('starting: status is starting with a proc', sc.status === 'starting' && !!sc.proc, sc.status);
    const r = await settle(sc.call('apps', {}, 8000), t0);
    const ready = await readyAt;
    check('starting call: resolved, not refused', r.ok, JSON.stringify(r));
    check('starting call: the answer is the child\'s', r.ok && Array.isArray(r.value.apps) && r.value.apps.join() === 'explorer,code', JSON.stringify(r.value));
    check('starting call: resolved after the ready line, not before', r.ms >= ready, `ready at ${ready} ms, answered at ${r.ms} ms`);
    check('starting call: answered promptly once ready', r.ms - ready < 300, `${r.ms - ready} ms after ready`);
    check('starting call: waited for ready (>= ~300 ms)', ready >= 250, `ready at ${ready} ms`);
    const ttl = r.ok ? r.value.ttl : -1;
    check('ttl is the time LEFT, not the full 8 s', ttl > 0 && ttl <= 8000 - 250 && ttl >= 8000 - r.ms - 50, `ttl ${ttl}, waited ${r.ms} ms`);
    // ---- 6b. after ready: unaffected (full timeout as ttl, explicit ttl still wins)
    const t1 = Date.now();
    const after = await settle(sc.call('ping', {}, 4000), t1);
    check('after ready: answered straight away', after.ok && after.ms < 300, JSON.stringify(after));
    check('after ready: ttl is the full timeout', after.ok && after.value.ttl === 4000, JSON.stringify(after.value));
    const forced = await settle(sc.call('ping', { ttl: 5 }, 4000), t1);
    check('after ready: an explicit args.ttl still wins', forced.ok && forced.value.ttl === 5, JSON.stringify(forced.value));
    const reserved = await settle(sc.call('tray.click', { id: 7 }), t1);
    check('after ready: reserved key still refused', !reserved.ok && /reserved key "id"/.test(reserved.error || ''), reserved.error);
    check('nothing left waiting or pending', sc.readyWaiters.size === 0 && sc.pending.size === 0, `${sc.readyWaiters.size} waiting, ${sc.pending.size} pending`);
    await shutdown(sc);
  }

  // ---- 2. a 100 ms call made before ready rejects at ~100 ms with the timeout words
  {
    const sc = fake('ready:600');
    await sc.start();
    const t0 = Date.now();
    const r = await settle(sc.call('apps', {}, 100), t0);
    check('100 ms call: rejected at ~100 ms', !r.ok && r.ms >= 90 && r.ms < 400, JSON.stringify(r));
    check('100 ms call: timeout-style words naming the command',
      /^the sidecar did not answer "apps" within 100 ms: it had not finished starting/.test(r.error || ''), r.error);
    const reserved = await settle(sc.call('tray.click', { cmd: 'x' }), Date.now());
    check('starting: a reserved key is refused at once, not after the wait', !reserved.ok && reserved.ms < 50 && /reserved key "cmd"/.test(reserved.error || ''), JSON.stringify(reserved));
    const circ = {}; circ.self = circ;
    const notJson = await settle(sc.call('apps', circ), Date.now());
    check('starting: non-JSON args are refused at once', !notJson.ok && notJson.ms < 50 && /not JSON/.test(notJson.error || ''), JSON.stringify(notJson));
    await shutdown(sc);
  }

  // ---- 3. a child that never prints ready: refused after the bound, loudly
  {
    const sc = fake('never', { readyWaitMs: 500 });
    await sc.start();
    const t0 = Date.now();
    const [long, short] = await Promise.all([
      settle(sc.call('apps'), t0),            // default 8 s timeout: the 500 ms ready bound wins
      settle(sc.call('battery', {}, 300), t0), // its own 300 ms is shorter
    ]);
    check('never ready: refused at the ready bound (~500 ms)', !long.ok && long.ms >= 480 && long.ms < 1200, JSON.stringify(long));
    check('never ready: plain words, naming the command and the missing ready line',
      /^cannot run "apps": the sidecar was started \d+ ms ago and has still not printed its ready line/.test(long.error || ''), long.error);
    check('never ready: a shorter caller timeout wins', !short.ok && short.ms >= 280 && short.ms < 800 && /did not answer "battery" within 300 ms/.test(short.error || ''), JSON.stringify(short));
    check('never ready: waiters are not left behind', sc.readyWaiters.size === 0, String(sc.readyWaiters.size));
    // stop() while a call waits: refused promptly with the shutdown reason
    const t1 = Date.now();
    const waiting = settle(sc.call('apps'), t1);
    await shutdown(sc);
    const r = await waiting;
    check('stop while waiting: refused promptly', !r.ok && r.ms < 2000, JSON.stringify(r));
    check('stop while waiting: says Mantle is shutting down', /^cannot run "apps": sidecar stopped because Mantle is shutting down/.test(r.error || ''), r.error);
  }

  // ---- 4. a child that exits before ready: waiting calls rejected promptly with the reason
  {
    const sc = fake('exit:200', { readyWaitMs: 5000 });
    await sc.start();
    const t0 = Date.now();
    const [a, b] = await Promise.all([settle(sc.call('apps'), t0), settle(sc.call('pinned.list'), t0)]);
    check('exit before ready: rejected promptly, not after the 5 s bound', !a.ok && !b.ok && a.ms < 1500 && b.ms < 1500, JSON.stringify([a, b]));
    check('exit before ready: the reason says it exited, naming the command',
      /^cannot run "apps": sidecar exited with code 3/.test(a.error || '') && /^cannot run "pinned\.list": sidecar exited with code 3/.test(b.error || ''), `${a.error} | ${b.error}`);
    const t1 = Date.now();
    const down = await settle(sc.call('apps'), t1);
    check('down: a later call is refused at once', !down.ok && down.ms < 50 && /^cannot run "apps": sidecar exited with code 3/.test(down.error || ''), JSON.stringify(down));
    await shutdown(sc);   // cancels the restart timer
  }

  // ---- 5. 20 calls before ready, plus the fixed 'ready' subscribers: no MaxListeners warning
  {
    const sc = fake('ready:300');
    for (let i = 0; i < 17; i++) sc.on('ready', () => {});   // 12 features + 4 main.js + 1 notifications
    for (let i = 0; i < 4; i++) sc.on('status', () => {});
    await sc.start();
    const before = sc.listenerCount('ready');
    const t0 = Date.now();
    const calls = [];
    for (let i = 0; i < 20; i++) calls.push(settle(sc.call('apps', { n: i }), t0));
    check('20 waiting calls add no ready listeners', sc.listenerCount('ready') === before && sc.readyWaiters.size === 20, `${sc.listenerCount('ready')} vs ${before}, ${sc.readyWaiters.size} waiting`);
    const rs = await Promise.all(calls);
    await tick(20);   // process warnings are emitted on a later tick
    check('20 waiting calls: all resolved', rs.every((r) => r.ok), JSON.stringify(rs.filter((r) => !r.ok)[0]));
    const maxWarn = warnings.filter((w) => w && w.name === 'MaxListenersExceededWarning');
    check('no MaxListenersExceededWarning', maxWarn.length === 0, maxWarn.map((w) => w.message).join(' | '));
    await shutdown(sc);
  }

  // ---- 9. (secreview 2026-09-27) a line over the 4 MB cap: the caller is told at once, the
  // sidecar keeps working, and NOT ONE character of the dropped line reaches a log line. Before
  // the fix the head was dropped, the tail parsed as "a line that is not JSON" and its first 200
  // characters (window titles, file names) went to mantle.log, and the caller waited out 8 s.
  {
    const sc = fake('ready:0');
    const logs = [];
    sc.on('log', (m) => logs.push(String(m && m.message)));
    await sc.start();
    for (let i = 0; i < 100 && sc.status !== 'ok'; i++) await tick(20);
    const t0 = Date.now();
    const r = await settle(sc.call('huge', { bytes: 5 * 1024 * 1024 }, 8000), t0);
    check('oversized reply: the call fails, not hangs', !r.ok && r.ms < 4000, JSON.stringify({ ok: r.ok, ms: r.ms, error: r.error && r.error.slice(0, 200) }));
    check('oversized reply: the reason names the size cap', /over the 4 MB/.test(r.error || ''), r.error && r.error.slice(0, 200));
    const r2 = await settle(sc.call('apps', {}, 3000), Date.now());
    check('oversized reply: the next call still works', r2.ok && r2.value && Array.isArray(r2.value.apps), JSON.stringify(r2).slice(0, 200));
    const r3 = await settle(sc.call('hugeev', { bytes: 5 * 1024 * 1024 }, 8000), Date.now());
    check('oversized event: the call after it on the wire is answered', r3.ok, JSON.stringify(r3).slice(0, 200));
    check('oversized event: the drop is logged (nothing fails silently)', logs.some((l) => /over the 4 MB/.test(l) && /windows/.test(l)), logs.map((l) => l.slice(0, 120)).join(' | '));
    const leaked = logs.filter((l) => l.includes('SECRET'));
    check('oversized lines: no log line carries their content', leaked.length === 0, leaked.map((l) => l.slice(0, 120)).join(' | '));
    await shutdown(sc);
  }

  check('no process warnings of any kind', warnings.length === 0, warnings.map((w) => `${w.name}: ${w.message}`).join(' | '));

  for (const f of failures) console.log('FAIL ' + f);
  console.log('SIDECAR TEST: ' + passed + ' passed, ' + failures.length + ' failed');
  process.exit(failures.length ? 1 : 0);
}

// Last, so every const above is initialised before main() runs.
if (process.argv[2] === '--fake-child') {
  fakeChild(process.argv[3] || 'never');
} else {
  main().catch((err) => {
    console.log('FAIL the test itself threw: ' + (err && err.stack || err));
    console.log('SIDECAR TEST: 0 passed, 1 failed');
    process.exit(1);
  });
}
