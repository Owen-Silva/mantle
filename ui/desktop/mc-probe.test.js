'use strict';
/*
 * mc-probe.test.js - the desktop page's Mission Control probe backs off while the
 * dashboard is down, and says so on screen.
 *
 *   node ui/desktop/mc-probe.test.js               checks ui/desktop/desktop.js (must pass)
 *   node ui/desktop/mc-probe.test.js --against-head runs the same checks against the
 *                                                  committed HEAD copy (the old flat
 *                                                  30 s setInterval: expected to FAIL)
 *
 * desktop.js is a plain browser script (no require), so it is run whole in a node
 * vm with a stubbed window/document, a window.mantle whose 'net.probe' answers
 * from a script, and a fake clock (setTimeout/setInterval/Date) advanced by hand.
 * No Electron, no network: nothing here opens a port.
 *
 * The case it was written for (lane mainrel-mc, 2026-09-27): 127.0.0.1:7373 is
 * usually not running, and the flat 30 s probe was ~120 refused connections an hour.
 * Prints one summary line; exits 1 if anything failed.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const AGAINST_HEAD = process.argv.includes('--against-head');

function headSource() {
  return execFileSync('git', ['show', 'HEAD:ui/desktop/desktop.js'], { cwd: REPO, encoding: 'utf8' });
}
const NEW_SRC = fs.readFileSync(path.join(__dirname, 'desktop.js'), 'utf8');
const OLD_SRC = headSource();
const SRC = AGAINST_HEAD ? OLD_SRC : NEW_SRC;

const MIN = 60 * 1000;
const REFUSED = { ok: false, reason: 'connect ECONNREFUSED 127.0.0.1:7373' };

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(name + (detail !== undefined ? ' -- ' + detail : ''));
}

// ---- a stub DOM that swallows anything: every unknown property is another stub,
// every call returns one. Assigned properties read back (textContent, hidden, ...).
function stub(preset) {
  const store = Object.assign(Object.create(null), preset || {});
  const target = function () {};
  return new Proxy(target, {
    get(t, k) {
      if (k in store) return store[k];
      if (typeof k === 'symbol') return k === Symbol.toPrimitive ? () => '' : undefined;
      if (k === 'then') return undefined;   // never look like a promise
      const v = stub();
      store[k] = v;
      return v;
    },
    set(t, k, v) { store[k] = v; return true; },
    apply() { return stub(); },
    construct() { return stub(); },
  });
}

// ---- one page load under a fake clock. probe(t) answers each net.probe asked at
// virtual time t; latencyMs delays the answer (on the fake clock).
function loadPage(src, { probe, latencyMs = 0 }) {
  const clock = { now: 0, seq: 0, timers: new Map() };
  const BASE = new Date(2026, 8, 27, 16, 15, 0, 0).getTime();
  function addTimer(fn, ms, repeat, args) {
    const id = ++clock.seq;
    const wait = Math.max(0, Number(ms) || 0);
    clock.timers.set(id, { fn, args, at: clock.now + wait, every: Math.max(1, wait), repeat });
    return id;
  }
  const setTimeoutF = (fn, ms, ...args) => addTimer(fn, ms, false, args);
  const setIntervalF = (fn, ms, ...args) => addTimer(fn, ms, true, args);
  const clearF = (id) => { clock.timers.delete(id); };
  class FakeDate extends Date {
    constructor(...a) { if (a.length) super(...a); else super(BASE + clock.now); }
    static now() { return BASE + clock.now; }
  }

  const elements = new Map();
  const document = stub({
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, stub({ id, textContent: '', hidden: false }));
      return elements.get(id);
    },
    visibilityState: 'visible',
  });

  const probes = [];     // virtual times net.probe was asked
  const handlers = Object.create(null);
  const mantle = {
    call(name, args) {
      if (name === 'net.probe') {
        probes.push(clock.now);
        const answer = probe(clock.now);
        if (!latencyMs) return Promise.resolve(answer);
        return new Promise((res) => setTimeoutF(() => res(answer), latencyMs));
      }
      if (name === 'sys.stats') {
        return Promise.resolve({ cpu: 3, memUsed: 1, memTotal: 2, battery: null, batteryReason: 'this machine reports no battery' });
      }
      return Promise.resolve({ ok: true });
    },
    on(name, cb) { handlers[name] = cb; },
  };
  const window = stub({ mantle });
  const ctx = vm.createContext({
    window, document, console,
    setTimeout: setTimeoutF, setInterval: setIntervalF, clearTimeout: clearF, clearInterval: clearF,
    Date: FakeDate,
  });
  vm.runInContext(src, ctx, { filename: 'desktop.js' });

  const flush = () => new Promise((r) => setImmediate(r));
  async function advanceTo(target) {
    await flush();
    for (;;) {
      let best = null;
      for (const [id, t] of clock.timers) {
        if (t.at <= target && (!best || t.at < best.t.at)) best = { id, t };
      }
      if (!best) break;
      clock.now = best.t.at;
      if (best.t.repeat) best.t.at += best.t.every; else clock.timers.delete(best.id);
      best.t.fn(...best.t.args);
      await flush();
      await flush();
    }
    clock.now = target;
  }
  const el = (id) => elements.get(id) || stub({ textContent: '', hidden: false });
  return {
    clock, probes, handlers, advanceTo,
    note: () => String(el('mc-note').textContent),
    noteHidden: () => el('mc-note').hidden === true,
    frameShown: () => el('mc-frame').hidden === false,
    // how many probe timers are pending: one chain is exactly one
    probeTimers: () => [...clock.timers.values()].filter((t) => t.fn && t.fn.name === 'probeMissionControl').length,
    rest: async (on) => { handlers['mantle.rest']({ on, why: 'a game is running' }); await flush(); await flush(); },
  };
}

const gaps = (ts) => ts.slice(1).map((t, i) => t - ts[i]);
const s = (ms) => ms / 1000 + 's';

async function main() {
  // ---- 1. the port stays closed for 10 minutes
  const baseline = loadPage(OLD_SRC, { probe: () => REFUSED });
  await baseline.advanceTo(10 * MIN - 1);
  const page = loadPage(SRC, { probe: () => REFUSED });
  await page.advanceTo(10 * MIN - 1);
  check('baseline: HEAD probes 20 times in 10 min with the port closed (1 + 10min/30s)',
    baseline.probes.length === 20, baseline.probes.length);
  // PINNED: fails on the old code (20 probes).
  check('port closed 10 min: at most 5 probes', page.probes.length <= 5,
    page.probes.length + ' probes at ' + page.probes.map(s).join(','));
  check('port closed 10 min: probes at 0, 30, 90, 210, 450 s',
    page.probes.join(',') === [0, 30, 90, 210, 450].map((x) => x * 1000).join(','), page.probes.map(s).join(','));
  check('port closed: exactly one probe timer pending', page.probeTimers() === 1, page.probeTimers());

  // ---- 2. the offline text, with the reason and the next check
  check('offline: the note is shown and the frame is not', !page.noteHidden() && !page.frameShown());
  check('offline: the note names the state and the reason',
    /^Mission Control offline: connect ECONNREFUSED 127\.0\.0\.1:7373\./.test(page.note()), page.note());
  check('offline: the note says when the next check is (8 min after the 5th failure)',
    /Next check in 8 min, at \d{1,2}:\d{2} (AM|PM)\./.test(page.note()), page.note());
  {
    const p = loadPage(SRC, { probe: () => REFUSED });
    await p.advanceTo(1);
    check('offline after the first probe: next check in 30 s', /Next check in 30 s\./.test(p.note()), p.note());
    await p.advanceTo(3.5 * MIN);   // failures at 0, 30, 90, 210 s: next wait 4 min
    check('offline after 4 failures: next check in 4 min, at 4:22 PM (4:15:00 + 210 s + 240 s = 4:22:30)',
      /Next check in 4 min, at 4:22 PM\./.test(p.note()), p.note());
  }

  // ---- 3. an hour closed: the wait is capped at 10 min
  {
    const p = loadPage(SRC, { probe: () => REFUSED });
    await p.advanceTo(60 * MIN - 1);
    const g = gaps(p.probes);
    check('an hour closed: the gap never exceeds 10 min', Math.max(...g) === 10 * MIN, g.map(s).join(','));
    check('an hour closed: 10 probes (vs 120 at a flat 30 s)', p.probes.length === 10, p.probes.length);
  }

  // ---- 4. recovery: back to 30 s the moment it answers, and a fresh 30 s first retry after
  {
    const p = loadPage(SRC, { probe: (t) => (t >= 5 * MIN && t < 10 * MIN ? { ok: true } : REFUSED) });
    await p.advanceTo(10 * MIN - 1);
    // fails at 0, 30, 90, 210; answers at 450, 480, ... 570
    const up = p.probes.filter((t) => t >= 450 * 1000);
    check('recovery: the first answer is the 450 s probe', up[0] === 450 * 1000, p.probes.map(s).join(','));
    check('recovery: every gap after an answer is 30 s', gaps(up).every((x) => x === 30 * 1000), gaps(up).map(s).join(','));
    check('recovery: the frame is mounted and the note hidden', p.frameShown() && p.noteHidden());
    await p.advanceTo(12 * MIN - 1);   // down again from 600 s: 600, 630, 690
    const down = p.probes.filter((t) => t >= 600 * 1000);
    check('down again: first retry after 30 s, then 60 s', down.join(',') === [600, 630, 690].map((x) => x * 1000).join(','),
      down.map(s).join(','));
  }

  // ---- 5. the rest path: no probes while resting, one chain after it, however it is poked
  {
    const p = loadPage(SRC, { probe: () => REFUSED });
    await p.advanceTo(100 * 1000);   // probes at 0, 30, 90
    await p.rest(true);
    check('rest: no probe timer pending', p.probeTimers() === 0, p.probeTimers());
    check('rest: the note says it is closed while Mantle rests', /closed while Mantle rests/.test(p.note()), p.note());
    const before = p.probes.length;
    await p.advanceTo(20 * MIN);
    check('rest: no probes for 20 min of resting', p.probes.length === before, p.probes.length - before);
    await p.rest(false);
    await p.rest(false);   // a duplicate "rest off"
    await p.rest(true);
    await p.rest(false);   // and a quick on/off flap
    check('after rest: exactly one probe timer pending', p.probeTimers() === 1, p.probeTimers());
    const start = p.clock.now;
    await p.advanceTo(start + 10 * MIN - 1);
    const after = p.probes.filter((t) => t >= start);
    // the flap probes twice at +0 (one per "off" that restarted), then ONE chain: +30, +90, +210, +450
    const tail = after.filter((t) => t > start).map((t) => t - start);
    check('after rest: one chain, backing off from 30 s again', tail.join(',') === [30, 90, 210, 450].map((x) => x * 1000).join(','),
      after.map((t) => s(t - start)).join(','));
  }

  // ---- 6. a probe still in flight when the rest begins must not undo the rest
  {
    // 20 s answers: the new chain probes at 0 and 50 s (30 s after each answer), HEAD's
    // interval at 0, 30, 60 s -- so at 65 s both have a probe out.
    const p = loadPage(SRC, { probe: () => ({ ok: true }), latencyMs: 20 * 1000 });
    await p.advanceTo(65 * 1000);
    await p.rest(true);               // rest begins with a probe still out
    await p.advanceTo(5 * MIN);
    check('in-flight probe landing during rest: the frame stays down', !p.frameShown());
    check('in-flight probe landing during rest: the rest note stays', /closed while Mantle rests/.test(p.note()), p.note());
    check('in-flight probe landing during rest: nothing scheduled', p.probeTimers() === 0, p.probeTimers());
  }

  // ---- 7. the pure backoff, lifted straight out of the file
  if (!AGAINST_HEAD) {
    const m = /\/\/ mc-backoff:begin[^\n]*\n([\s\S]*?)\/\/ mc-backoff:end/.exec(NEW_SRC);
    check('desktop.js has the mc-backoff region', !!m);
    if (m) {
      const ctx = vm.createContext({});
      vm.runInContext(m[1] + '\nthis.mcNextDelay = mcNextDelay;', ctx);
      const got = [0, 1, 2, 3, 4, 5, 6, 7, 1000].map((f) => ctx.mcNextDelay(f) / 1000);
      check('mcNextDelay(0..7, 1000) = 30,30,60,120,240,480,600,600,600 s',
        got.join(',') === '30,30,60,120,240,480,600,600,600', got.join(','));
    }
  }

  for (const f of failures) console.log('FAIL ' + f);
  console.log('MC PROBE TEST' + (AGAINST_HEAD ? ' (against HEAD)' : '') + ': ' + passed + ' passed, ' + failures.length + ' failed');
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
  console.log('FAIL the test itself threw: ' + (err && err.stack || err));
  console.log('MC PROBE TEST: ' + passed + ' passed, ' + (failures.length + 1) + ' failed');
  process.exit(1);
});
