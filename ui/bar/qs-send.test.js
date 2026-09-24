'use strict';
/*
 * qs-send.test.js - a dragged slider's sender (ui/bar/qs-send.js), in node, no Electron.
 *
 * One set in flight, the newest value waiting, the last value always landing, nothing replayed
 * and nothing sent twice. Written 2026-09-23 when the panel's 100 ms throttle queued stale
 * brightness levels behind a slow WMI call.
 *
 *   node ui/bar/qs-send.test.js
 *
 * Prints one summary line; exits 1 if anything failed.
 */
const { sender } = require('./qs-send.js');

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(name + (detail ? ' -- ' + detail : ''));
}
const tick = () => new Promise((r) => setImmediate(r));

function rig(opts) {
  const sent = [];
  const answers = [];
  const s = sender((v) => {
    sent.push(v);
    return new Promise((resolve, reject) => answers.push({ resolve, reject, v }));
  }, opts);
  return { s, sent, answers };
}

(async () => {
  // ---- one in flight, newest waiting
  {
    const { s, sent, answers } = rig();
    s.push(40);
    check('the first value goes at once', sent.join() === '40', sent.join());
    s.push(39); s.push(35); s.push(30);
    check('nothing else goes while it is in flight', sent.join() === '40', sent.join());
    check('busy while in flight', s.busy() === true);
    answers[0].resolve({ ok: true, value: 40 });
    await tick();
    check('when it answers, only the NEWEST waiting value goes', sent.join() === '40,30', sent.join());
    answers[1].resolve({ ok: true, value: 30 });
    await tick();
    check('and then nothing more', sent.join() === '40,30' && !s.busy(), sent.join());
    check('the drag\'s closing value, already set, is not sent twice', s.push(30) === false && sent.join() === '40,30', sent.join());
    s.push(31);
    check('a new value after that goes at once', sent.join() === '40,30,31', sent.join());
    answers[2].resolve({ ok: true, value: 31 });
    await tick();
  }

  // ---- the value in flight, pushed again (the drag's `change`), is not sent twice
  {
    const { s, sent, answers } = rig();
    s.push(25);
    s.push(24);
    check('a value pushed again while it is in flight is not queued behind itself', s.push(25) === false, sent.join());
    answers[0].resolve({ ok: true, value: 25 });
    await tick();
    check('and the value that waited between them is dropped: the in-flight one is the newest', sent.join() === '25' && !s.busy(), sent.join());
  }

  // ---- onIdle: once, when the last answer is in and nothing waits
  {
    let idle = 0;
    const { s, answers } = rig({ onIdle: () => { idle++; } });
    s.push(1); s.push(2);
    answers[0].resolve({ ok: true });
    await tick();
    check('not idle while the newest value is still being sent', idle === 0 && s.busy(), String(idle));
    answers[1].resolve({ ok: true });
    await tick();
    check('idle once the last answer is in', idle === 1 && !s.busy(), String(idle));
  }

  // ---- the last value always lands, even when the one in flight fails
  {
    const { s, sent, answers } = rig();
    s.push(10);
    s.push(12);
    answers[0].reject(new Error('the sidecar is restarting'));
    await tick();
    check('a failed set still lets the waiting value go', sent.join() === '10,12', sent.join());
    answers[1].resolve({ ok: false, reason: 'refused' });
    await tick();
    check('a value whose set was refused is sent again when asked', s.push(12) === true && sent.join() === '10,12,12', sent.join());
    answers[2].resolve({ ok: true, value: 12 });
    await tick();
  }

  // ---- a send that throws synchronously is a failure, not a jam
  {
    let n = 0;
    const s = sender(() => { n++; if (n === 1) throw new Error('boom'); return { ok: true }; });
    s.push(1);
    await tick();
    s.push(2);
    await tick();
    check('a throwing send does not jam the sender', n === 2 && !s.busy(), String(n));
  }

  // ---- the gap floor
  {
    let clock = 0;
    const timers = [];
    const { s, sent, answers } = rig({ minGapMs: 30, now: () => clock, setTimeout: (fn, ms) => { timers.push({ fn, at: clock + ms }); return timers.length; } });
    s.push(1);
    answers[0].resolve({ ok: true });
    await tick();
    clock = 5;
    s.push(2);
    check('within the gap, the next value waits', sent.join() === '1' && timers.length === 1 && timers[0].at === 30, JSON.stringify(timers));
    s.push(3);
    check('and only one timer is armed', timers.length === 1);
    clock = 30;
    timers[0].fn();
    check('at the gap, the newest goes', sent.join() === '1,3', sent.join());
    answers[1].resolve({ ok: true });
    await tick();
    clock = 200;
    s.push(4);
    check('a send after a long pause goes at once', sent.join() === '1,3,4', sent.join());
  }

  for (const f of failures) console.log('FAIL ' + f);
  console.log('QS SEND TEST: ' + passed + ' passed, ' + failures.length + ' failed');
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error('qs-send.test.js crashed: ' + (e && e.stack || e)); process.exit(1); });
