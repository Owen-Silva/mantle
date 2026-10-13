'use strict';
/*
 * sidecar/test-speed-lanes.js - the game checks' own lane and the held-lane log line (lane mn-speed,
 * 2026-10-12), against a real PASSIVE sidecar exe (no Electron):
 *   (a) ping lists the "scan" lane;
 *   (b) gamemode.scan {procs:true} with the top bar's 3 s budget answers, fast, while the SLOW lane is
 *       held 4 s (before: it waited the whole hold and timed out, 6 of 6, speed.md scanStall);
 *   (c) it really ran on its own lane: the slow lane was still busy when it answered;
 *   (d) a lane held past 1.5 s says so in ONE log line: the lane, the command name, how many waited
 *       behind it; no arguments; a second hold inside 10 s writes no line; the next one after says how
 *       many it folded in.
 *   node sidecar/test-speed-lanes.js   -> "SPEED LANES TEST: n passed, m failed" (exit 1 on any failure)
 */
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const exe = path.join(__dirname, 'bin', 'Mantle.Sidecar.exe');
const p = spawn(exe, ['--parent-pid=' + process.pid, '--state-file=' + path.join(os.tmpdir(), `mantle-speedlanes-${process.pid}.json`), '--passive'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
let passed = 0;
const failures = [];
function check(name, ok, detail) { if (ok) passed++; else failures.push(name + (detail !== undefined ? ' -- ' + JSON.stringify(detail).slice(0, 300) : '')); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let buf = '', id = 0, ready;
const readyP = new Promise((r) => (ready = r));
const wait = new Map();
const logs = [];
p.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    let m; try { m = JSON.parse(line); } catch (_) { continue; }
    if (m.ev === 'ready') ready();
    if (m.ev === 'log') logs.push(String(m.message || ''));
    if (m.id && wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); }
  }
});
p.stderr.on('data', () => {});
function call(cmd, args, ttl = 15000) {
  const i = ++id; const t = Date.now();
  p.stdin.write(JSON.stringify(Object.assign({ id: i, cmd, ttl }, args || {})) + '\n');
  return new Promise((r) => {
    const timer = setTimeout(() => { wait.delete(i); r({ ms: Date.now() - t, timeout: true, m: {} }); }, ttl + 500);
    wait.set(i, (m) => { clearTimeout(timer); r({ ms: Date.now() - t, m }); });
  });
}
const lanesOf = (r) => ((r.m.result && r.m.result.load && r.m.result.load.lanes) || []);

(async () => {
  const up = await Promise.race([readyP.then(() => true), sleep(15000).then(() => false)]);
  if (!up) { console.log('SPEED LANES TEST: 0 passed, 1 failed\n  FAIL the sidecar printed no ready line in 15 s'); p.kill(); process.exit(1); }
  await sleep(800);

  const ping = await call('ping', {});
  check('a: ping lists the scan lane', lanesOf(ping).some((l) => l.name === 'scan'), lanesOf(ping).map((l) => l.name));

  // (b, c) the slow lane held 4 s; a game check with the top bar's 3 s budget
  const hold = call('sleep', { lane: 'slow', ms: 4000 });
  await sleep(150);
  const scan = await call('gamemode.scan', { procs: true }, 3000);
  check('b: gamemode.scan answers while the slow lane is held', scan.m.ok === true && !scan.timeout, scan.m.error || scan);
  check('b: ...in under 500 ms', scan.ms < 500, scan.ms);
  check('b: ...with a process list', Array.isArray(scan.m.result && scan.m.result.procs) && scan.m.result.procs.length > 10, scan.m.result && scan.m.result.procsReason);
  const during = await call('ping', {});
  const slow = lanesOf(during).find((l) => l.name === 'slow');
  check('c: the slow lane was still busy (the scan did not run there)', !!slow && slow.busy === 'sleep', slow);
  await hold;

  // (d) the held-lane line
  await sleep(200);
  const heldLines = () => logs.filter((l) => /lane was held/.test(l));
  const n0 = heldLines().length;
  check('d: one line for the 4 s hold', n0 === 1 && /^the slow lane was held \d+ ms by "sleep" \(\d+ request\(s\) waiting behind it\)$/.test(heldLines()[0]), heldLines());
  await call('sleep', { lane: 'capture', ms: 1700 });
  await sleep(150);
  check('d: a capture-lane hold gets its own line (per lane)', heldLines().length === 2 && /the capture lane was held/.test(heldLines()[1]), heldLines());
  await call('sleep', { lane: 'capture', ms: 1700 });
  await sleep(150);
  check('d: a second hold inside 10 s writes no line', heldLines().length === 2, heldLines());
  await call('sleep', { lane: 'capture', ms: 100 });
  check('d: a short command writes nothing', heldLines().length === 2, heldLines());
  await sleep(10000 - 1700 - 300);
  await call('sleep', { lane: 'capture', ms: 1700 });
  await sleep(150);
  const last = heldLines()[heldLines().length - 1];
  check('d: the next line says what it folded in', heldLines().length === 3 && /; 1 more like it in the last 10 s$/.test(last), heldLines());

  p.stdin.end();
  await sleep(500);
  console.log(`SPEED LANES TEST: ${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log('  FAIL ' + f);
  process.exit(failures.length ? 1 : 0);
})();
