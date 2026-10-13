'use strict';
/*
 * main-recover.test.js -- main.js's <mainrel:rearm> region (lane mn-recover, 2026-10-12; audit #10):
 * makeWatchArmer (a watch whose arm failed is tried again at 2/5/15/60 s, then stops and says so; a
 * new start drops an older ladder) and makeGapRereader (wakes, unlocks and restarts are one re-read
 * schedule). Runs the region's real source in a vm with a fake clock, the way lib/main-rel.test.js does.
 *   node lib/main-recover.test.js   -> "MAIN RECOVER TEST: n passed, m failed"
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { passed++; return; }
  failures.push(detail === undefined ? name : `${name} (${JSON.stringify(detail)})`);
}
function region(name) {
  const a = SRC.indexOf(`// <mainrel:${name}>`);
  const b = SRC.indexOf(`// </mainrel:${name}>`);
  if (a === -1 || b === -1) throw new Error(`main.js has no <mainrel:${name}> region`);
  return SRC.slice(a, b);
}
const ctx = vm.createContext({ Promise, Map, Set, Math, String, Number, Object, Array, JSON, Error });
vm.runInContext(`${region('rearm')}\n;globalThis.__out = { makeWatchArmer, makeGapRereader };`, ctx);
const { makeWatchArmer, makeGapRereader } = ctx.__out;

/* A fake clock: later() queues, run(ms) moves time and fires what is due, in order. */
function clock() {
  let now = 0, seq = 0;
  const q = [];
  return {
    later(fn, ms) { const t = { at: now + ms, fn, id: ++seq }; q.push(t); return t; },
    cancel(t) { const i = q.indexOf(t); if (i >= 0) q.splice(i, 1); },
    async run(ms) {
      const end = now + ms;
      for (;;) {
        q.sort((x, y) => x.at - y.at || x.id - y.id);
        if (!q.length || q[0].at > end) break;
        const t = q.shift();
        now = t.at;
        t.fn();
        await flush();
      }
      now = end;
    },
    size: () => q.length,
  };
}
const flush = () => new Promise((r) => setImmediate(r));

async function armer() {
  /* 1. armed at once: no retry, no line */
  {
    const c = clock(); const said = [];
    const A = makeWatchArmer({ delays: [2000, 5000, 15000, 60000], later: c.later, cancel: c.cancel, say: (l) => said.push(l), blocked: () => null });
    const r = await A.arm('volume', async () => null);
    check('armed at once: "armed"', r === 'armed', r);
    check('armed at once: nothing waits', c.size() === 0 && A.pending().length === 0);
    check('armed at once: no log line', said.length === 0, said);
  }
  /* 2. fails twice, then arms: retried at 2 s and 5 s, one line each, then "armed (3 tries)" */
  {
    const c = clock(); const said = []; let calls = 0;
    const A = makeWatchArmer({ delays: [2000, 5000, 15000, 60000], later: c.later, cancel: c.cancel, say: (l) => said.push(l), blocked: () => null });
    const arm = async () => { calls++; if (calls <= 2) throw new Error('did not answer volwatch within 4s'); return null; };
    const r = await A.arm('volume', arm);
    check('a failed arm is retried', r === 'retry' && A.pending().length === 1, { r, p: A.pending() });
    await c.run(1999);
    check('not before 2 s', calls === 1, calls);
    await c.run(1);
    check('second try at 2 s', calls === 2, calls);
    await c.run(4999);
    check('third try not before 5 s more', calls === 2, calls);
    await c.run(1);
    check('third try at +5 s', calls === 3, calls);
    check('armed: nothing waits any more', A.pending().length === 0 && c.size() === 0);
    check('each retry is said with its reason and delay', said.length === 3 && /did not arm \(did not answer volwatch within 4s\); trying again in 2 s \(retry 1 of 4\)/.test(said[0]) && /in 5 s \(retry 2 of 4\)/.test(said[1]), said);
    check('the recovery is said', /the volume watch is armed \(it took 3 tries\)/.test(said[2]), said[2]);
  }
  /* 3. never arms: 2/5/15/60 s, then stops and says so */
  {
    const c = clock(); const said = []; let calls = 0;
    const A = makeWatchArmer({ delays: [2000, 5000, 15000, 60000], later: c.later, cancel: c.cancel, say: (l) => said.push(l), blocked: () => null });
    await A.arm('network', async () => { calls++; return 'refused'; });
    await c.run(2000 + 5000 + 15000 + 60000);
    check('the ladder is 4 retries (5 tries)', calls === 5, calls);
    check('then it stops: nothing waits', c.size() === 0 && A.pending().length === 0);
    check('the stop is said with the reason', /network watch could not be armed after 5 tries \(refused\); it is tried again when the sidecar restarts or the PC wakes/.test(said[said.length - 1]), said[said.length - 1]);
    await c.run(10 * 60000);
    check('and it stays stopped', calls === 5, calls);
  }
  /* 4. final: an old exe is never retried */
  {
    const c = clock(); let calls = 0;
    const A = makeWatchArmer({ delays: [2000], later: c.later, cancel: c.cancel, say: () => {}, blocked: () => null });
    const r = await A.arm('media', async () => { calls++; return { final: true }; });
    await c.run(60000);
    check('final: no retry', r === 'final' && calls === 1 && c.size() === 0, { r, calls });
  }
  /* 5. blocked (the sidecar is down or Mantle quits): no retry, the next ready arms again */
  {
    const c = clock(); let calls = 0; let down = 'the sidecar is down';
    const A = makeWatchArmer({ delays: [2000], later: c.later, cancel: c.cancel, say: () => {}, blocked: () => down });
    const r = await A.arm('battery', async () => { calls++; return 'sidecar exited before answering'; });
    await c.run(60000);
    check('blocked: no retry while down', r === 'blocked' && calls === 1 && c.size() === 0, { r, calls });
    down = null;
    const r2 = await A.arm('battery', async () => { calls++; return null; });
    check('the next start arms it', r2 === 'armed' && calls === 2, { r2, calls });
  }
  /* 6. a new start drops the older ladder (a restart while a retry waits) */
  {
    const c = clock(); const seen = [];
    const A = makeWatchArmer({ delays: [2000, 5000], later: c.later, cancel: c.cancel, say: () => {}, blocked: () => null });
    await A.arm('volume', async () => { seen.push('old'); return 'timeout'; });
    check('a retry waits', c.size() === 1);
    const r = await A.arm('volume', async () => { seen.push('new'); return null; });
    await c.run(60000);
    check('the new start cancels the old retry', r === 'armed' && seen.join(',') === 'old,new' && c.size() === 0, seen);
  }
  /* 7. a slow old attempt that lands after a new start does not schedule anything */
  {
    const c = clock(); let release;
    const A = makeWatchArmer({ delays: [2000], later: c.later, cancel: c.cancel, say: () => {}, blocked: () => null });
    const slow = A.arm('net', () => new Promise((r) => { release = r; }));
    await A.arm('net', async () => null);
    release('timeout');
    const r = await slow;
    check('a stale answer is dropped', r === 'stale' && c.size() === 0, r);
  }
  /* 8. a throwing arm is a reason, not a crash; rearmAll runs every watch again */
  {
    const c = clock(); const ran = [];
    const A = makeWatchArmer({ delays: [2000], later: c.later, cancel: c.cancel, say: () => {}, blocked: () => null });
    const r = await A.arm('volume', () => { throw new Error('boom'); });
    check('a throw is retried like a failure', r === 'retry', r);
    await A.arm('volume', async () => { ran.push('volume'); return null; });
    await A.arm('battery', async () => { ran.push('battery'); return null; });
    ran.length = 0;
    const all = await A.rearmAll();
    check('rearmAll runs each watch once', ran.sort().join(',') === 'battery,volume' && all.every((x) => x === 'armed'), { ran, all });
    check('rearmAll dropped the old retry', c.size() === 0);
  }
}

async function rereader() {
  /* a wake + an unlock in the same second: one schedule, run at 3 s and 20 s after the LAST trigger */
  const c = clock(); const runs = [];
  const G = makeGapRereader({ delays: [3000, 20000], later: c.later, cancel: c.cancel, reread: (why, i) => runs.push({ why, i }) });
  G.gap('the PC woke up');
  await c.run(500);
  G.gap('the screen was unlocked');
  check('two triggers wait as one schedule (2 timers)', G.waiting() === 2, G.waiting());
  await c.run(2999);
  check('nothing before 3 s after the last trigger', runs.length === 0, runs);
  await c.run(1);
  check('the first pass at 3 s names both triggers', runs.length === 1 && runs[0].i === 0 && runs[0].why === 'the PC woke up and the screen was unlocked', runs);
  await c.run(17000);
  check('the second pass at 20 s', runs.length === 2 && runs[1].i === 1 && /, 20 s on$/.test(runs[1].why), runs);
  check('then nothing waits', G.waiting() === 0 && c.size() === 0);
  G.gap('the screen was unlocked');
  await c.run(3000);
  check('a later trigger is said on its own', runs.length === 3 && runs[2].why === 'the screen was unlocked', runs[2]);
}

(async () => {
  try {
    await armer();
    await rereader();
  } catch (err) {
    failures.push(`threw: ${err && err.stack ? err.stack : err}`);
  }
  for (const f of failures) console.log(`FAIL ${f}`);
  console.log(`MAIN RECOVER TEST: ${passed} passed, ${failures.length} failed`);
  process.exitCode = failures.length ? 1 : 0;
})();
