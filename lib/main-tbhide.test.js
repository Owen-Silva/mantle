/*
 * main-tbhide.test.js -- main.js's taskbar-hiding start-up (lane r7-start, 2026-10-01), run as the
 * REAL code: the `// <mainrel:tbhide>` region is lifted out of main.js and run in a vm with a fake
 * sidecar and a fake clock (main.js itself needs Electron).
 *
 * WHY: the go-lives of 2026-09-30 17:56 and 2026-10-01 13:28 missed the taskbar guard's arming
 * window, and main's first retry came 15 s later, so the Windows taskbar showed for those 15 s.
 * Here the guard arms LATE (the fake sidecar refuses until then) and the hiding must be in force
 * within ~1 s of it arming; a sidecar that never arms is asked a bounded number of times; a new
 * sidecar ('ready' again) starts the quick retries over; quitting stops them; a --test run never
 * retries unless --test-tbhide.
 *
 * Pinned to the old code: 752d63d's version (the last before this fix) is run as a baseline and must show the old fault (the
 * hiding comes ~15 s after the guard arms).
 *
 *   node lib/main-tbhide.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
let HEAD = '';
try { HEAD = execFileSync('git', ['show', '752d63d:main.js'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }); } catch (_) { HEAD = ''; }

let passed = 0;
const failures = [];
function ok(cond, what, detail) {
  if (cond) passed++;
  else failures.push(what + (detail ? ' -- ' + detail : ''));
}

/** The tbhide piece: the region when there is one, else (older code) applyTaskbarHide up to the traywatch retry. */
function piece(src) {
  const a = src.indexOf('// <mainrel:tbhide>');
  const b = src.indexOf('// </mainrel:tbhide>');
  if (a !== -1 && b !== -1) return src.slice(a, b);
  const s = src.indexOf('async function applyTaskbarHide');
  const e = src.indexOf('// A "traywatch" that times out is retried');
  if (s === -1 || e === -1) throw new Error('main.js has no applyTaskbarHide piece');
  // Older code starts at the doc comment above the function; take from the function on.
  return src.slice(s, e);
}

/**
 * Run the piece with a fake clock. `armAt` (ms after ready, Infinity = never) is when the fake
 * sidecar's guard arms; before it, tbhide answers applied:false the way TaskbarHide.cs does.
 */
function harness(code, opts) {
  const o = Object.assign({ armAt: 0, test: false, testTbhide: false }, opts || {});
  const T0 = 1000;   // the ready line; times below are reported relative to it
  let now = T0;
  const timers = [];
  let seq = 0;
  const calls = [];
  const logs = [];
  const states = [];
  const sidecar = {
    readyAt: T0,
    blockedReason: () => null,
    call: (cmd, args) => {
      calls.push({ at: now - T0, cmd, on: args && args.on });
      if (args && args.on === false) return Promise.resolve({ applied: false, released: true, reason: 'released' });
      const armed = now - T0 >= o.armAt;
      return Promise.resolve(armed
        ? { ok: true, applied: true, reason: 'the Windows taskbar is invisible', guard: 'armed (pid 4242)' }
        : { ok: true, applied: false, reason: 'the Windows taskbar was NOT made invisible: the taskbar guard is still starting', guard: 'starting' });
    },
  };
  const ctx = {
    flags: { tbhide: true, test: o.test, testTbhide: o.testTbhide },
    state: { set: (k, v) => states.push({ at: now - T0, k, v }) },
    sidecar,
    Sidecar: { isOldExeError: () => false },
    process: { stdout: { write: (s) => logs.push({ at: now - T0, s }) }, pid: 1 },
    Date: { now: () => now },
    setTimeout: (fn, ms) => { const t = { id: ++seq, at: now + ms, fn, unref() {} }; timers.push(t); return t; },
    clearTimeout: (t) => { const i = timers.indexOf(t); if (i !== -1) timers.splice(i, 1); },
    Promise,
  };
  vm.createContext(ctx);
  vm.runInContext(code + '\nthis.apply = applyTaskbarHide; this.release = releaseTaskbarHide;', ctx);
  const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
  return {
    calls, logs, states,
    get now() { return now - T0; },
    async apply(a) { await ctx.apply(a); await flush(); },
    async release(why) { await ctx.release(why); await flush(); },
    /** Run the clock forward to `until`, firing timers in order. */
    async run(until) {
      for (;;) {
        timers.sort((x, y) => x.at - y.at || x.id - y.id);
        const t = timers[0];
        if (!t || t.at > until + T0) { now = until + T0; return; }
        timers.shift();
        now = t.at;
        t.fn();
        await flush();
      }
    },
    inForceAt() { const l = logs.find((x) => /taskbar hiding in force/.test(x.s)); return l ? l.at : null; },
    pending() { return timers.length; },
  };
}

async function suite(code, label) {
  const r = {};
  // 1. The 2026-10-01 shape: the guard arms 3 s after the sidecar's ready line.
  {
    const h = harness(code, { armAt: 3000 });
    await h.apply({ fresh: true });
    await h.run(30000);
    r.slow3 = h.inForceAt();
    r.slow3Line = (h.logs.find((x) => /taskbar hiding in force/.test(x.s)) || {}).s || '';
  }
  // 2. Later still: 8 s.
  {
    const h = harness(code, { armAt: 8000 });
    await h.apply({ fresh: true });
    await h.run(60000);
    r.slow8 = h.inForceAt();
  }
  // 3. Never arms: how often is the sidecar asked in the first minute, and does it keep trying?
  {
    const h = harness(code, { armAt: Infinity });
    await h.apply({ fresh: true });
    await h.run(60000);
    r.never60 = h.calls.filter((c) => c.on === true).length;
    await h.run(20 * 60000);
    r.neverStill = h.pending() > 0;
    // A new sidecar ('ready' again) after many misses: its first retry must be quick again.
    const before = h.calls.length;
    await h.apply({ fresh: true });
    const t0 = h.now;
    await h.run(t0 + 1500);
    r.freshRetryQuick = h.calls.length - before >= 2;
    r.freshNoDup = h.pending() === 1;
  }
  // 4. Quitting stops the retries and turns it off.
  {
    const h = harness(code, { armAt: Infinity });
    await h.apply({ fresh: true });
    await h.run(2500);
    await h.release('Mantle is quitting');
    const n = h.calls.length;
    await h.run(10 * 60000);
    r.quitStops = h.calls.length === n && h.pending() === 0;
    r.quitOff = h.calls.some((c) => c.on === false);
  }
  // 5. A plain --test run never retries; --test-tbhide does.
  {
    const h = harness(code, { armAt: Infinity, test: true });
    await h.apply({ fresh: true });
    r.testNoRetry = h.pending() === 0;
    const h2 = harness(code, { armAt: 2000, test: true, testTbhide: true });
    await h2.apply({ fresh: true });
    await h2.run(10000);
    r.testTbhideRetries = h2.inForceAt();
  }
  console.log(`${label}: in force at ${r.slow3} ms (guard armed at 3000), ${r.slow8} ms (armed at 8000); ` +
    `never-arming: ${r.never60} asks in the first minute`);
  return r;
}

(async () => {
  const cur = await suite(piece(SRC), 'working tree');
  ok(cur.slow3 !== null && cur.slow3 >= 3000 && cur.slow3 <= 4100, 'guard armed 3 s after ready: in force within ~1 s of arming', `in force at ${cur.slow3} ms`);
  ok(/\(\d+\.\d s after the sidecar was ready\)/.test(cur.slow3Line), 'the in-force line says how long after the ready line', cur.slow3Line.trim().slice(0, 160));
  ok(cur.slow8 !== null && cur.slow8 >= 8000 && cur.slow8 <= 9100, 'guard armed 8 s after ready: in force within ~1 s of arming', `in force at ${cur.slow8} ms`);
  ok(cur.never60 >= 10 && cur.never60 <= 20, 'a guard that never arms: the sidecar is asked a bounded number of times in the first minute (10-20)', `${cur.never60} asks`);
  ok(cur.neverStill, 'a guard that never arms: Mantle keeps trying (every 5 min), it never gives up for the run');
  ok(cur.freshRetryQuick, 'a new sidecar (ready again) starts the quick 1 s retries over');
  ok(cur.freshNoDup, 'a new sidecar replaces the pending retry, never adds a second one');
  ok(cur.quitStops, 'quitting cancels the pending retry and no ask follows');
  ok(cur.quitOff, 'quitting turns the hiding off (tbhide on:false)');
  ok(cur.testNoRetry, 'a plain --test run schedules no retry');
  ok(cur.testTbhideRetries !== null && cur.testTbhideRetries <= 3100, '--test-tbhide retries like a live start (in force within ~1 s of arming)', `in force at ${cur.testTbhideRetries} ms`);

  if (HEAD) {
    const old = await suite(piece(HEAD), '752d63d (baseline)');
    ok(old.slow3 === null || old.slow3 > 10000, 'baseline: 752d63d puts the hiding in force only ~15 s after the guard arms, the fault this pins', `752d63d in force at ${old.slow3} ms`);
  } else failures.push('baseline: could not read 752d63d:main.js');

  for (const f of failures) console.log('FAIL ' + f);
  console.log('MAIN TBHIDE TEST: ' + passed + ' passed, ' + failures.length + ' failed');
  process.exit(failures.length ? 1 : 0);
})().catch((err) => { console.log('FAIL the test itself threw: ' + (err && err.stack)); console.log('MAIN TBHIDE TEST: ' + passed + ' passed, ' + (failures.length + 1) + ' failed'); process.exit(1); });
