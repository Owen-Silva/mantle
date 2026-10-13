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
  // mn-recover 2026-10-12 liveness check: ready at once, then never answer ping (deafping) or
  // answer it ms late (lateping); every other command is answered as usual.
  if (kind === 'deafping' || kind === 'lateping') out({ ev: 'ready', pid: process.pid, version: 'fake-1', passive: true });
  // core-lib 2026-09-29: ready at once, then crash after ms (a crash loop that gets to "ready" each time).
  if (kind === 'readycrash') {
    out({ ev: 'ready', pid: process.pid, version: 'fake-1', passive: true });
    setTimeout(() => process.exit(4), ms);
  }
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
      // The real sidecar's quit path: it restores, SAYS so, then exits.
      if (m.cmd === 'quit') { out({ ev: 'restore', done: true, detail: 'fake restore' }); process.exit(0); }
      // core-lib 2026-09-29 protocol cases.
      if (m.cmd === 'die') process.exit(5);
      if (m.cmd === 'ping' && kind === 'deafping') continue;
      if (m.cmd === 'ping' && kind === 'lateping') { const id = m.id; setTimeout(() => out({ id, ok: true, result: { pid: process.pid } }), ms); continue; }
      if (m.cmd === 'noid') { out({ secret: 'SECRET-TITLE of a window' }); out({ id: m.id, ok: true, result: { cmd: m.cmd } }); continue; }
      if (m.cmd === 'split') {
        // A reply split across writes in the MIDDLE of a two-byte UTF-8 character, then its tail and
        // an event in ONE write.
        const reply = Buffer.from(JSON.stringify({ id: m.id, ok: true, result: { name: 'caf\u00e9 \u00e9t\u00e9' } }) + '\n', 'utf8');
        const cut = reply.indexOf(0xc3) + 1;
        process.stdout.write(reply.subarray(0, cut));
        setTimeout(() => process.stdout.write(Buffer.concat([reply.subarray(cut), Buffer.from(JSON.stringify({ ev: 'windows', n: 1 }) + '\n')])), 40);
        continue;
      }
      if (m.cmd === 'stderrflood') {
        for (let i = 0; i < 2000; i++) process.stderr.write('SECRET-TITLE complaint ' + i + ' ' + 'x'.repeat(i === 0 ? 5000 : 10) + '\n');
        out({ id: m.id, ok: true, result: { cmd: m.cmd } });
        continue;
      }
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

  await hardening();
  await liveness();

  check('no process warnings of any kind', warnings.length === 0, warnings.map((w) => `${w.name}: ${w.message}`).join(' | '));

  for (const f of failures) console.log('FAIL ' + f);
  console.log('SIDECAR TEST: ' + passed + ' passed, ' + failures.length + ' failed');
  process.exit(failures.length ? 1 : 0);
}

/* ---- core-lib quality pass (2026-09-29): the protocol's rough edges, each with a fake child ----
 * Failed first on the pre-pass client: a line with neither id nor ev logged its first 200 characters
 * (window titles); a stderr flood became 2000 log lines of any length; a sidecar that crashed after
 * each ready line restarted forever (the counter reset on every ready), and after giving up there was
 * no way back but restarting Mantle; start() twice spawned two sidecars; a NaN or huge timeout
 * rejected at once. */
async function hardening() {
  // ---- partial / split lines, UTF-8 split mid-character, a reply and an event in one chunk
  {
    const sc = fake('ready:0');
    const evs = [];
    sc.on('windows', (m) => evs.push(m));
    await sc.start();
    await whenStatus(sc, 'ok', Date.now());
    const r = await settle(sc.call('split', {}, 3000), Date.now());
    await tick(30);
    check('split line: the reply is put back together', r.ok && r.value.name === 'café été', JSON.stringify(r));
    check('split line: the event in the same chunk is delivered', evs.length === 1 && evs[0].n === 1, JSON.stringify(evs));
    // ---- a line with neither id nor ev: said, but its content never logged
    const logs = [];
    sc.on('log', (l) => logs.push(l.message));
    const r2 = await settle(sc.call('noid', {}, 3000), Date.now());
    check('neither id nor ev: the next reply still arrives', r2.ok, JSON.stringify(r2));
    check('neither id nor ev: it is logged (never silent)', logs.some((l) => /neither id nor ev/.test(l)), logs.join(' | '));
    check('neither id nor ev: its content is not logged', !logs.some((l) => l.includes('SECRET')), logs.join(' | ').slice(0, 300));
    // ---- stderr flood: bounded log lines, bounded length, a count of what was held back
    logs.length = 0;
    const r3 = await settle(sc.call('stderrflood', {}, 5000), Date.now());
    await tick(200);
    check('stderr flood: the call still works', r3.ok, JSON.stringify(r3));
    check('stderr flood: at most 20 log lines, not 2000', logs.length > 0 && logs.length <= 21, String(logs.length));
    check('stderr flood: every line is short (300 chars max)', logs.every((l) => l.length <= 320), String(Math.max(...logs.map((l) => l.length))));
    check('stderr flood: lastLog (shown in reasons) is short too', String(sc.lastLog || '').length <= 320, String((sc.lastLog || '').length));
    // ---- timeouts that are not usable numbers fall back to the default, never fire at once
    const nan = await settle(sc.call('apps', {}, NaN), Date.now());
    check('NaN timeout: the default applies (answered, not refused at 1 ms)', nan.ok, JSON.stringify(nan));
    const huge = await settle(sc.call('apps', {}, 2 ** 32), Date.now());
    check('a timeout past 24.8 days: clamped (answered, no overflow)', huge.ok, JSON.stringify(huge));
    // ---- id wraparound: past MAX_SAFE_INTEGER the ids start again at 1
    sc.nextId = Number.MAX_SAFE_INTEGER;
    const w1 = await settle(sc.call('apps', {}, 3000), Date.now());
    const w2 = await settle(sc.call('apps', {}, 3000), Date.now());
    check('id wraparound: both calls answered', w1.ok && w2.ok, JSON.stringify([w1, w2]));
    check('id wraparound: ids start again from 1', sc.nextId >= 1 && sc.nextId < 10, String(sc.nextId));
    // ---- start() on a running sidecar does not spawn a second one
    const spawnsBefore = sc._spawnCount;
    const again = await sc.start();
    check('start() while running: no second process', again === true && sc._spawnCount === spawnsBefore, `${spawnsBefore} -> ${sc._spawnCount}`);
    // ---- events after stop: the quit path's restore line still reaches main (it matters most)
    const restores = [];
    sc.on('restore', (m) => restores.push(m));
    await shutdown(sc);
    await tick(50);
    check('stop: the restore event on the way out is still delivered', restores.length === 1 && restores[0].done === true, JSON.stringify(restores));
    check('stop: nothing left pending', sc.pending.size === 0 && sc.readyWaiters.size === 0, `${sc.pending.size}/${sc.readyWaiters.size}`);
  }

  // ---- death with calls pending: every waiter rejected at once, no leak
  {
    const sc = fake('ready:0', { restartDelayMs: 60000 });
    await sc.start();
    await whenStatus(sc, 'ok', Date.now());
    const t0 = Date.now();
    const calls = [sc.call('apps', {}, 8000), sc.call('battery', {}, 8000), sc.call('die', {}, 8000)];
    const rs = await Promise.all(calls.map((c) => settle(c, t0)));
    const dead = rs.filter((r) => !r.ok);
    check('death: the call that killed it is rejected at once', !rs[2].ok && rs[2].ms < 2000, JSON.stringify(rs[2]));
    check('death: rejections name the command in plain words', dead.every((r) => /sidecar exited with code 5 before answering \(command "/.test(r.error || '')), dead.map((r) => r.error).join(' | '));
    check('death: nothing pending afterwards', sc.pending.size === 0, String(sc.pending.size));
    // ---- a write to a dead stdin: refused in words, never an uncaught error
    const after = await settle(sc.call('apps', {}, 1000), Date.now());
    check('after death: a call is refused at once in words', !after.ok && after.ms < 100 && /^cannot run "apps": sidecar exited with code 5/.test(after.error || ''), JSON.stringify(after));
    sc.stop();
  }

  // ---- a crash loop that reaches "ready" every time: bounded, gives up, and has a way back
  {
    const sc = fake('readycrash:80', { restartDelayMs: 30, stableMs: 5000 });
    const downs = [];
    sc.on('status', (st) => { if (st.status === 'down') downs.push(st.reason); });
    await sc.start();
    const t0 = Date.now();
    while (Date.now() - t0 < 4000 && !downs.some((d) => /gave up/.test(d))) await tick(50);
    const spawns = sc._spawnCount;
    await tick(400);
    check('crash loop after ready: gives up (not forever)', downs.some((d) => /gave up/.test(d)) && sc._spawnCount === spawns && spawns <= 5, `${spawns} spawns, ${downs.length} downs`);
    const last = downs[downs.length - 1] || '';
    check('crash loop: the give-up says how to get it back', /retry|try again|restart Mantle/i.test(last), last);
    check('crash loop: the reason carries what it said last', /restarts/.test(last), last);
    // the way back: retry() starts it again with a fresh budget
    const okBack = whenStatus(sc, 'ok', Date.now());
    const r = typeof sc.retry === 'function' ? await sc.retry() : false;
    const back = await Promise.race([okBack, tick(2000).then(() => -1)]);
    check('retry(): brings a sidecar that gave up back', r === true && back >= 0 && sc._spawnCount === spawns + 1, `r=${r} back=${back} spawns=${sc._spawnCount}`);
    sc.stop();
    await tick(200);
  }
}

/* ---- mn-recover 2026-10-12 (audit #11): the liveness check ----
 * Before it, the only ping was one at start, and restarts happened only on exit: a sidecar alive
 * but frozen was never noticed. Short health options here; production is 15 s / 3 s / 3 misses. */
function countPings(sc) {
  const c = { n: 0 };
  const orig = sc.call.bind(sc);
  sc.call = (cmd, ...rest) => { if (cmd === 'ping') c.n += 1; return orig(cmd, ...rest); };
  return c;
}

async function waitFor(pred, ms, step = 10) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (pred()) return true; await tick(step); }
  return pred();
}

async function liveness() {
  // ---- a helper that stops answering ping: ended, restarted through the exit path, then stays up
  {
    let spawns = 0;
    const sc = new Sidecar({
      exePath: process.execPath, buildScript: null, passive: true, cwd: __dirname,
      restartDelayMs: 30, healthMs: 150, healthTimeoutMs: 60, healthMisses: 3,
      spawnImpl: (exe, args, opts) => {
        spawns += 1;
        return spawn(process.execPath, [__filename, '--fake-child', spawns === 1 ? 'deafping' : 'ready:0', ...args], opts);
      },
    });
    const pings = countPings(sc);
    const seen = [];
    const logs = [];
    sc.on('status', (st) => seen.push(st.status + ': ' + st.reason));
    sc.on('log', (l) => logs.push(l.message));
    await sc.start();
    await waitFor(() => sc.status === 'ok', 3000);
    const pid1 = sc.info && sc.info.pid;
    const t0 = Date.now();
    await waitFor(() => sc.healthKills === 1 && sc.status === 'ok' && sc.info && sc.info.pid !== pid1, 4000);
    const ms = Date.now() - t0;
    const pid2 = sc.info && sc.info.pid;
    check('hang: the silent helper is ended and restarted, back to ok with a new pid', sc.healthKills === 1 && sc.status === 'ok' && pid2 && pid2 !== pid1 && spawns === 2, `kills=${sc.healthKills} status=${sc.status} pids ${pid1}->${pid2} spawns=${spawns}`);
    check('hang: noticed after ~3 intervals, not at once and not forever', ms >= 300 && ms < 1500, `${ms} ms`);
    check('hang: the down status says the helper is not answering', seen.some((s) => /^down: the helper is not answering/.test(s)), seen.join(' | '));
    check('hang: the restart reason (exit path, backoff) carries it', seen.some((s) => /^down: sidecar was stopped because the helper is not answering .*restarting in .*attempt 1 of/.test(s)), seen.join(' | '));
    check('hang: the starting status after it says why it restarted', seen.some((s) => /^starting: .*restarted because the helper was not answering/.test(s)), seen.join(' | '));
    check('hang: one log line says why, with no paths', logs.filter((l) => /did not answer 3 pings in a row/.test(l)).length === 1 && !logs.some((l) => /[\\/]/.test(l) && /did not answer/.test(l)), logs.join(' | '));
    const r = await settle(sc.call('apps', {}, 2000), Date.now());
    check('hang: the restarted helper answers', r.ok, JSON.stringify(r));
    const before = pings.n;
    await tick(1500);
    check('hang: the restarted helper that answers stays up (pinged, never ended)', sc.healthKills === 1 && sc.info && sc.info.pid === pid2 && spawns === 2 && pings.n - before >= 6, `kills=${sc.healthKills} pings=${pings.n - before} spawns=${spawns}`);
    await shutdown(sc);
  }

  // ---- a healthy helper over many ticks: pinged, never ended, never two pings in flight
  {
    const sc = fake('ready:0', { healthMs: 40, healthTimeoutMs: 30, healthMisses: 2 });
    const pings = countPings(sc);
    let maxPending = 0;
    await sc.start();
    await waitFor(() => sc.status === 'ok', 3000);
    const t0 = Date.now();
    while (Date.now() - t0 < 2000) { maxPending = Math.max(maxPending, sc.pending.size); await tick(5); }
    check('healthy: pinged every interval for 2 s, never ended', pings.n >= 25 && sc.healthKills === 0 && sc._spawnCount === 1 && sc.status === 'ok', `pings=${pings.n} kills=${sc.healthKills} spawns=${sc._spawnCount}`);
    check('healthy: never more than one ping in flight', maxPending <= 1, `max pending ${maxPending}`);
    await shutdown(sc);
  }

  // ---- a late reply (past the limit, before the next tick) resets the count
  {
    const sc = fake('lateping:90', { healthMs: 150, healthTimeoutMs: 40, healthMisses: 2 });
    await sc.start();
    await waitFor(() => sc.status === 'ok', 3000);
    let maxMisses = 0;
    const t0 = Date.now();
    while (Date.now() - t0 < 2000) { if (sc._health) maxMisses = Math.max(maxMisses, sc._health.misses); await tick(5); }
    check('late reply: each ping was a miss at first (the test is real)', maxMisses === 1, `max misses ${maxMisses}`);
    check('late reply: the late answer resets the count, never ended', sc.healthKills === 0 && sc._spawnCount === 1 && sc.status === 'ok', `kills=${sc.healthKills} spawns=${sc._spawnCount}`);
    await shutdown(sc);
  }

  // ---- stop() clears the timer: no ping after it
  {
    const sc = fake('ready:0', { healthMs: 30, healthTimeoutMs: 20 });
    const pings = countPings(sc);
    await sc.start();
    await waitFor(() => sc.status === 'ok', 3000);
    await waitFor(() => pings.n >= 2, 1000);
    const proc = sc.proc;
    sc.stop();
    const at = pings.n;
    await tick(400);
    check('stop(): no ping after it, the check is gone', pings.n === at && sc._health === null && sc.healthKills === 0, `pings ${at} -> ${pings.n}`);
    if (proc && proc.exitCode === null) await Promise.race([new Promise((r) => proc.once('exit', r)), tick(3000)]);
  }

  // ---- a gap far past the interval (sleep/resume; here the event loop held) resets, is not counted
  {
    const sc = fake('deafping', { healthMs: 100, healthTimeoutMs: 40, healthMisses: 3 });
    await sc.start();
    await waitFor(() => sc.status === 'ok', 3000);
    await waitFor(() => sc._health && sc._health.misses === 2, 2000, 2);
    const h = sc._health;
    const had = h && h.misses;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);   // the timers jump, as after sleep
    await tick(20);
    check('sleep gap: the count restarts, that tick is not a miss, nothing ended', had === 2 && sc._health === h && h.misses === 0 && h.gaps === 1 && sc.healthKills === 0, `had=${had} misses=${h && h.misses} gaps=${h && h.gaps} kills=${sc.healthKills}`);
    // Still silent after it: counted again from zero and ended in the usual ~3 intervals.
    await waitFor(() => sc.healthKills === 1, 2000);
    check('sleep gap: a helper still silent after it is ended from a fresh count', sc.healthKills === 1, `kills=${sc.healthKills}`);
    await shutdown(sc);
  }

  // ---- healthMs 0 = off
  {
    const sc = fake('deafping', { healthMs: 0 });
    const pings = countPings(sc);
    await sc.start();
    await waitFor(() => sc.status === 'ok', 3000);
    await tick(300);
    check('healthMs 0: no check at all', pings.n === 0 && sc._health === null && sc.healthKills === 0, `pings=${pings.n}`);
    await shutdown(sc);
  }
  // ---- the production defaults
  {
    const sc = fake('ready:0');
    check('defaults: 15 s interval, 3 s limit, 3 misses', sc.healthMs === 15000 && sc.healthTimeoutMs === 3000 && sc.healthMisses === 3, `${sc.healthMs}/${sc.healthTimeoutMs}/${sc.healthMisses}`);
  }
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
