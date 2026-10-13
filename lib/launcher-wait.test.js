'use strict';
/*
 * lib/launcher-wait.test.js - the Win key never waits long for the launcher's picture (lane mn-speed,
 * 2026-10-12). Runs main.js's <mainrel:launcherwait> region (launcherFirstPicture) on its own, with a
 * fake window, a fake launcherBackdrop.once and real timers:
 *   (a) a picture back in 30 ms: shown once, at the picture, protection never touched, no state line;
 *   (b) a picture 400 ms late: shown at ~150 ms, excluded from capture BEFORE it shows, State says why
 *       in plain words, protection off again when the late picture lands, shown exactly once;
 *   (c) the 4 fps loop holding its own protection when the late picture lands: protection stays on;
 *   (d) a picture that fails: shown at once with no wait;
 *   (e) the window destroyed during the wait: nothing throws, nothing shown on a dead window.
 *   node lib/launcher-wait.test.js   -> "LAUNCHER WAIT TEST: n passed, m failed" (exit 1 on any failure)
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const a = src.indexOf('// <mainrel:launcherwait>');
const b = src.indexOf('// </mainrel:launcherwait>');
if (a === -1 || b === -1) { console.log('LAUNCHER WAIT TEST: 0 passed, 1 failed\n  main.js has no <mainrel:launcherwait> region'); process.exit(1); }
const code = src.slice(a, b);

let passed = 0;
const failures = [];
function check(name, ok, detail) { if (ok) passed++; else failures.push(name + (detail !== undefined ? ' -- ' + JSON.stringify(detail) : '')); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function rig(o) {
  const log = [];
  const t0 = Date.now();
  const win = {
    destroyed: false,
    isDestroyed() { return this.destroyed; },
    setContentProtection(on) { log.push({ what: 'protect', on, t: Date.now() - t0 }); },
  };
  const COUNT = Symbol.for('mantle.protectedCaptures');
  if (o.loopHolds) win[COUNT] = 1;
  const states = [];
  const lines = [];
  const ctx = vm.createContext({
    setTimeout, clearTimeout, Symbol, Math, Promise,
    process: { stdout: { write: (s) => lines.push(String(s)) } },
    setBackdropPiece: (key, patch) => states.push({ key, patch }),
    launcherBackdrop: {
      once: () => new Promise((res, rej) => setTimeout(() => (o.fail ? rej(new Error('capture failed')) : res(true)), o.pictureMs)),
    },
  });
  vm.runInContext(`${code}\n;globalThis.__f = launcherFirstPicture;`, ctx);
  const shows = [];
  ctx.__f(win, () => { shows.push(Date.now() - t0); log.push({ what: 'show', t: Date.now() - t0 }); });
  return { win, log, shows, states, lines, COUNT };
}

(async () => {
  // (a) a picture back in 30 ms
  {
    const r = rig({ pictureMs: 30 });
    await sleep(300);
    check('a: shown once', r.shows.length === 1, r.shows);
    check('a: shown at the picture (< 120 ms)', r.shows[0] >= 25 && r.shows[0] < 120, r.shows);
    check('a: protection never touched', !r.log.some((x) => x.what === 'protect'), r.log);
    check('a: no state line, no log line', r.states.length === 0 && r.lines.length === 0, { s: r.states, l: r.lines });
  }
  // (b) a picture 400 ms late
  {
    const r = rig({ pictureMs: 400 });
    await sleep(250);
    check('b: shown by ~150 ms, not at the picture', r.shows.length === 1 && r.shows[0] >= 140 && r.shows[0] < 260, r.shows);
    const pOn = r.log.findIndex((x) => x.what === 'protect' && x.on === true);
    const sh = r.log.findIndex((x) => x.what === 'show');
    check('b: excluded from capture before it shows', pOn !== -1 && pOn < sh, r.log);
    check('b: State says why, in plain words', r.states.length === 1 && r.states[0].key === 'launcher' && /flat tint/.test(r.states[0].patch.reason) && /150 ms/.test(r.states[0].patch.reason), r.states);
    check('b: one log line, no names', r.lines.length === 1 && /opened without waiting for its picture/.test(r.lines[0]), r.lines);
    await sleep(300);
    const off = r.log.find((x) => x.what === 'protect' && x.on === false);
    check('b: protection off when the late picture lands', !!off && off.t >= 390, r.log);
    check('b: shown exactly once', r.shows.length === 1, r.shows);
    check('b: the count is back to 0', r.win[r.COUNT] === 0, r.win[r.COUNT]);
  }
  // (c) the loop's own protection is still on when the late picture lands
  {
    const r = rig({ pictureMs: 300, loopHolds: true });
    await sleep(450);
    check('c: protection left on for the loop', !r.log.some((x) => x.what === 'protect' && x.on === false), r.log);
    check('c: the loop keeps its count', r.win[r.COUNT] === 1, r.win[r.COUNT]);
  }
  // (d) a picture that fails at once
  {
    const r = rig({ pictureMs: 5, fail: true });
    await sleep(200);
    check('d: shown once, at once', r.shows.length === 1 && r.shows[0] < 100, r.shows);
    check('d: no protection, no late line', !r.log.some((x) => x.what === 'protect') && r.lines.length === 0, { log: r.log, lines: r.lines });
  }
  // (e) the window is destroyed during the wait
  {
    const r = rig({ pictureMs: 400 });
    r.win.destroyed = true;
    let threw = null;
    try { await sleep(550); } catch (err) { threw = err; }
    check('e: nothing throws', threw === null, String(threw));
    check('e: no protection asked of a dead window', !r.log.some((x) => x.what === 'protect'), r.log);
  }

  console.log(`LAUNCHER WAIT TEST: ${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log('  FAIL ' + f);
  process.exit(failures.length ? 1 : 0);
})();
