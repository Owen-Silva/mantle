'use strict';
/*
 * tray-batch.test.js -- the tray menu's batched rebuilds (lib/tray-batch.js, lane mn-state 2026-10-12).
 *
 * With a fake clock and fake timers, and then with the REAL ShellState feeding a key built the way
 * main.js's trayInputKey builds it:
 *   - a State change never rebuilds inside the set() that caused it; the first ask after a quiet
 *     spell runs on the next tick;
 *   - a burst of asks is at most one rebuild per 250 ms, and the tray is never more than 250 ms
 *     behind the last ask (the brief: right state within ~0.3 s);
 *   - an unchanged key skips the rebuild; a changed one rebuilds;
 *   - force() rebuilds at once whatever the key says, and folds a pending batch into itself;
 *   - a rebuild that throws is reported and tried again on the next ask; a key that throws rebuilds;
 *   - main.js wires it: the State listener asks (requestTray), it does not rebuild (updateTray).
 *
 *   node lib/tray-batch.test.js
 */
const fs = require('fs');
const path = require('path');
const { createTrayBatch, sameKey } = require('./tray-batch');
const { ShellState } = require('./state');

let passed = 0;
const failures = [];
function check(name, ok, detail) { if (ok) passed++; else failures.push(name + (detail !== undefined ? ' -- ' + JSON.stringify(detail) : '')); }

/** A fake clock with timers: advance(ms) fires whatever falls due, in order. */
function fakeTime() {
  let t = 1000, id = 0;
  const timers = new Map();
  return {
    now: () => t,
    setTimeout: (fn, ms) => { const k = ++id; timers.set(k, { at: t + Math.max(0, ms), fn }); return k; },
    clearTimeout: (k) => { timers.delete(k); },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        let next = null;
        for (const [k, v] of timers) if (v.at <= end && (!next || v.at < next[1].at)) next = [k, v];
        if (!next) break;
        timers.delete(next[0]);
        t = next[1].at;
        next[1].fn();
      }
      t = end;
    },
    pending: () => timers.size,
  };
}

function rig(keyFn, runFn) {
  const T = fakeTime();
  const runs = [];
  const errors = [];
  const b = createTrayBatch({ ms: 250, now: T.now, setTimeout: T.setTimeout, clearTimeout: T.clearTimeout,
    key: keyFn || (() => [Math.random()]), run: () => { runs.push(T.now()); if (runFn) runFn(); }, onError: (err, where) => errors.push(`${where}: ${err.message}`) });
  return { T, b, runs, errors };
}

/* ---- timing ---------------------------------------------------------------------------------- */
{
  const r = rig();
  r.b.request();
  check('an ask never rebuilds inside the call that asked', r.runs.length === 0);
  r.T.advance(0);
  check('the first ask after a quiet spell runs on the next tick', r.runs.length === 1 && r.runs[0] === 1000, r.runs);
}
{
  // A start-like burst: 60 State changes over 1.2 s, one every 20 ms.
  const r = rig();
  const asks = [];
  for (let i = 0; i < 60; i++) { asks.push(r.T.now()); r.b.request(); r.T.advance(20); }
  r.T.advance(600);
  const gaps = r.runs.slice(1).map((x, i) => x - r.runs[i]);
  check('a 60-change burst is a handful of rebuilds, not 60', r.runs.length >= 2 && r.runs.length <= 6, r.runs.length);
  check('never two rebuilds within 250 ms', gaps.every((g) => g >= 250), gaps);
  const lastAsk = asks[asks.length - 1];
  const after = r.runs.find((x) => x >= lastAsk);
  check('the last change is on the tray within 250 ms', after !== undefined && after - lastAsk <= 250, { lastAsk, after });
  // Every ask is covered by a rebuild that started at or after it, within 250 ms.
  const worst = Math.max(...asks.map((a) => (r.runs.find((x) => x >= a) || Infinity) - a));
  check('every change shows within 250 ms (worst case)', worst <= 250, worst);
  check('no timer left behind once quiet', r.T.pending() === 0 && !r.b.pending());
  check('stats count the asks', r.b.stats.requests === 60 && r.b.stats.runs === r.runs.length, r.b.stats);
}
{
  // Asks spaced wider than the window each run at once (next tick): no added delay when calm.
  const r = rig();
  for (let i = 0; i < 4; i++) { r.b.request(); r.T.advance(0); const at = r.T.now(); check(`calm ask ${i + 1} runs with no wait`, r.runs[r.runs.length - 1] === at, r.runs); r.T.advance(400); }
}

/* ---- the key --------------------------------------------------------------------------------- */
{
  let k = ['a', 1];
  const r = rig(() => k);
  r.b.request(); r.T.advance(0);
  r.T.advance(300); r.b.request(); r.T.advance(0);
  check('same key: the second rebuild is skipped', r.runs.length === 1 && r.b.stats.skipped === 1, r.b.stats);
  k = ['a', 2];
  r.T.advance(300); r.b.request(); r.T.advance(0);
  check('changed key: rebuilt', r.runs.length === 2, r.runs);
  check('sameKey compares element by element, by identity', sameKey([1, 'x', k], [1, 'x', k]) && !sameKey([{}], [{}]) && !sameKey([1], [1, 2]) && !sameKey(null, null));
}

/* ---- force ----------------------------------------------------------------------------------- */
{
  const r = rig(() => ['same']);
  r.b.request(); r.T.advance(0);
  r.b.force();
  check('force rebuilds at once even with the same key', r.runs.length === 2);
  r.T.advance(100); r.b.request();
  check('an ask inside the window after force waits', r.runs.length === 2 && r.b.pending());
  r.b.force();
  check('force folds the pending batch into itself', !r.b.pending() && r.runs.length === 3);
  r.T.advance(1000);
  check('...and nothing runs again later', r.runs.length === 3, r.runs);
}

/* ---- failures -------------------------------------------------------------------------------- */
{
  let fail = true;
  const r = rig(() => ['k'], () => { if (fail) throw new Error('menu went away'); });
  r.b.request(); r.T.advance(0);
  check('a rebuild that throws is reported, never thrown out of a timer', r.errors.length === 1 && /run: menu went away/.test(r.errors[0]), r.errors);
  fail = false;
  r.T.advance(300); r.b.request(); r.T.advance(0);
  check('...and is tried again on the next ask, same key or not', r.runs.length === 2 && r.b.stats.runs === 1, { runs: r.runs.length, stats: r.b.stats });
}
{
  const r = rig(() => { throw new Error('no inputs'); });
  r.b.request(); r.T.advance(0);
  r.T.advance(300); r.b.request(); r.T.advance(0);
  check('a key that throws: reported, and the menu is rebuilt every time', r.runs.length === 2 && r.errors.every((e) => /^key: no inputs/.test(e)), { runs: r.runs.length, errors: r.errors });
}

/* ---- with the real ShellState and a main.js-shaped key --------------------------------------- */
{
  const state = new ShellState('test', 'bottom');
  const key = () => { const st = state.get(); return [st.features, st.switcher, st.shortcuts, JSON.stringify(state.problems()), null, null, 'ok', false, true, 3]; };
  const r = rig(key);
  state.on('change', () => r.b.request());
  r.b.force();
  const base = r.runs.length;
  // Things the tray does not show: a backdrop frame rate, the wallpaper's playback, the bar revealing.
  for (let i = 0; i < 20; i++) {
    state.set('backdrop', { bar: { on: true, ok: true, fps: 4, ms: 10 + i, reason: 'running' } });
    state.set('wallpaper', { playing: i % 2 === 0, reason: 'test' });
    state.set('bar', { revealed: i % 2 === 0 });
    r.T.advance(30);
  }
  r.T.advance(600);
  check('real State: 60 changes the tray does not show rebuild nothing', r.runs.length === base && r.b.stats.skipped >= 1, { runs: r.runs.length - base, stats: r.b.stats });
  // A feature's health, which the menu shows, rebuilds once, within 250 ms.
  const at = r.T.now();
  state.set('features', { vol: { label: 'Volume', on: true, ok: false, reason: 'the volume keys did not answer' } });
  r.T.advance(300);
  check('real State: a feature going unhealthy rebuilds, within 250 ms', r.runs.length === base + 1 && r.runs[r.runs.length - 1] - at <= 250, r.runs);
  // A new problem (the sidecar going down) changes the problem words: rebuilt.
  state.set('sidecar', { status: 'down', reason: 'it stopped answering' });
  r.T.advance(300);
  check('real State: a new problem rebuilds', r.runs.length === base + 2, r.runs.length - base);
}

/* ---- main.js wiring (read from the source: main.js needs Electron to run) -------------------- */
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const at = src.indexOf("state.on('change', (snapshot) => {");
  const body = at === -1 ? '' : src.slice(at, src.indexOf('\n});', at));
  check('main.js: the State listener asks for a batched rebuild', /\brequestTray\(\)/.test(body), body.slice(0, 200));
  check('main.js: the State listener does not rebuild the tray itself', !/\bupdateTray(Now)?\(\)/.test(body));
  check('main.js: updateTray() is the immediate one (force)', /function updateTray\(\) \{ trayBatcher\(\)\.force\(\); \}/.test(src));
  check('main.js: the batch rebuilds through the real menu builder', /run: updateTrayNow/.test(src) && /function updateTrayNow\(\) \{/.test(src));
  check('main.js: the batch window is 250 ms', /createTrayBatch\(\{ ms: 250,/.test(src));
}

console.log(`TRAY BATCH TEST: ${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log('  FAIL ' + f);
process.exit(failures.length ? 1 : 0);
