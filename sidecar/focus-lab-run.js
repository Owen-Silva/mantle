// focus-lab-run.js - the on-screen half of the focus ladder test (see focus-lab.js), shared by
// test-focus-ladder.js and runnable alone for the measurements:
//
//   node sidecar/focus-lab-run.js [--techniques] [--exe=<sidecar>] [--trials=3]
//
// ONLY inside the visible slot (BRIEF.md): it refuses unless the machine has been idle >= 3 min and
// it can take visible.lock in the tools/dev-env.js scratch folder (released at the end, held < 2 min). It stops
// at the first real (not injected) key or mouse event and reports the run as NOT RUN.
'use strict';

const fs = require('fs');
const path = require('path');
const Lab = require('./focus-lab');
const T = require('./test-lib');

const LOCK = path.join(require('../tools/dev-env.js').scratch() || require('os').tmpdir(), 'visible.lock');
const TECHNIQUES = ['direct', 'attach', 'alt', 'altdummy', 'althold', 'switch'];

/**
 * Run it. opts: {techniques, exe, trials, lane}. Resolves {ran, why, techniques:{how:[RES...]},
 * ladder:{granted:[...], ungranted:[...]}}; never throws for "could not run".
 */
async function run(opts) {
  const o = opts || {};
  const trials = o.trials || 3;
  const out = { ran: false, why: null, techniques: {}, ladder: { ungranted: [], granted: [] }, notes: [] };
  let lab = null, s = null, locked = false;
  try {
    const idle0 = await Lab.idleNow();
    if (!(idle0 >= 180000)) { out.why = `the machine was idle only ${Math.round(idle0 / 1000)} s (needs 180 s)`; return out; }
    try { fs.mkdirSync(LOCK); locked = true; fs.writeFileSync(path.join(LOCK, 'owner.txt'), (o.lane || 'mn-focus') + ' ' + new Date().toISOString()); }
    catch (_) { out.why = 'the visible slot is taken (visible.lock exists)'; return out; }
    lab = await Lab.start();
    await T.sleep(300);
    const guard = () => { const r = lab.real(); if (r) throw Object.assign(new Error('real input arrived: ' + r), { real: true }); };

    if (o.techniques) {
      for (const how of TECHNIQUES) {
        out.techniques[how] = [];
        for (let i = 0; i < trials; i++) {
          guard();
          const scene = await lab.setScene(0);
          if (scene) { out.techniques[how].push('scene: ' + scene); continue; }
          const res = await lab.tryHow(how);
          out.techniques[how].push(res ? res.replace(/^RES \d+ \S+ /, '') : 'no answer');
          await T.sleep(150);
        }
      }
    }

    if (o.exe) {
      s = await T.startPassive({ exe: o.exe });
      const pid = s.ready && s.ready.pid;
      for (const mode of ['ungranted', 'granted']) {
        for (let i = 0; i < trials; i++) {
          guard();
          const scene = await lab.setScene(mode === 'granted' ? pid : 0);
          if (scene) { out.ladder[mode].push({ scene }); continue; }
          let r;
          try { r = await s.call('focus.fixture', { hwnd: lab.info.B.hwnd, onScreen: true }, 5000); }
          catch (e) { r = { error: e.message }; }
          await T.sleep(250);
          r.fgAfter = (await lab.fg()) === lab.info.B.hwnd;
          if (mode === 'granted') r.grant = (lab.bar.lines().filter((l) => /^GRANT /.test(l)).pop() || '').replace(/^GRANT \d+ /, '');
          out.ladder[mode].push(r);
          await T.sleep(150);
        }
      }
    }
    guard();
    out.ran = true;
  } catch (e) {
    out.ran = false;
    out.why = e.real ? 'NOT RUN: ' + e.message : 'the lab failed: ' + e.message;
  } finally {
    if (s) { try { await s.stop(); } catch (_) { /* gone */ } }
    if (lab) lab.stop();
    if (locked) { try { fs.rmSync(LOCK, { recursive: true, force: true }); } catch (_) { /* left for the next one to see */ } }
  }
  return out;
}

module.exports = { run, TECHNIQUES, LOCK };

if (require.main === module) {
  const arg = (k) => (process.argv.find((x) => x.startsWith(`--${k}=`)) || '').split('=').slice(1).join('=');
  run({ techniques: process.argv.includes('--techniques'), exe: arg('exe') || null, trials: Number(arg('trials')) || 3 })
    .then((r) => { console.log(JSON.stringify(r, null, 1)); });
}
