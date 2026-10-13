/*
 * popwatch.test.js -- lib/popwatch.js, the list of open pop-ups and the watch that closes them on a
 * click outside or on Esc (lane mn-pop, 2026-10-12), run with a fake sidecar, fake key states and a
 * fake clock. No Electron, no hooks, no input on the desktop.
 *
 *   node lib/popwatch.test.js
 * One summary line: "POPWATCH TEST: n passed, m failed".
 */
'use strict';
const P = require('./popwatch');

let passed = 0;
const failures = [];
function ok(cond, what, detail) {
  if (cond) passed++;
  else failures.push(what + (detail !== undefined ? ' -- ' + JSON.stringify(detail).slice(0, 300) : ''));
}
const tick = () => new Promise((r) => setImmediate(r));

/** A watch with a fake sidecar (`answer(args)` -> result or throws), fake intervals and fake keys. */
function rig(o) {
  const opts = Object.assign({ answer: () => ({ armed: true, esc: 'swallow' }), keys: null, test: false, testArm: false }, o || {});
  const calls = [];
  const logs = [];
  const intervals = [];
  let keyState = opts.keys;
  let cursor = { x: 500, y: 500 };
  const w = P.create();
  w.configure({
    call: async (args) => { calls.push(args); return opts.answer(args); },
    log: (l) => logs.push(l),
    toDip: (pt) => ({ x: pt.x / 1.25, y: pt.y / 1.25 }),     // a 125 % screen
    cursor: () => cursor,
    keys: () => keyState,
    hwnd: () => '4242',
    test: opts.test,
    testArm: opts.testArm,
    timers: {
      setInterval: (fn, ms) => { const h = { fn, ms, live: true }; intervals.push(h); return h; },
      clearInterval: (h) => { if (h) h.live = false; },
    },
  });
  return {
    w, calls, logs, intervals,
    live: () => intervals.filter((h) => h.live),
    fire: (ms) => { for (const h of intervals.slice()) if (h.live && (!ms || h.ms === ms)) h.fn(); },
    setKeys: (k) => { keyState = k; },
    setCursor: (p) => { cursor = p; },
  };
}

/** A pop-up whose box is `rect` (DIP), recording what closed it. */
function popup(rect) {
  const got = [];
  return {
    got,
    h: {
      contains: (pt) => pt.x >= rect.x && pt.x < rect.x + rect.w && pt.y >= rect.y && pt.y < rect.y + rect.h,
      outside: (how) => got.push(['outside', how]),
      esc: (how) => got.push(['esc', how]),
    },
  };
}

async function main() {
  // ---- detect(): the fallback's press detector
  {
    const none = { left: 0, right: 0, middle: 0, esc: 0 };
    let r = P.detect(null, none);
    ok(r.pressed.length === 0, 'detect: nothing pressed reads as nothing', r);
    r = P.detect(r.down, Object.assign({}, none, { left: 0x8000 }));
    ok(r.pressed.join() === 'left' && r.down.left, 'detect: a button going down is one press', r);
    r = P.detect(r.down, Object.assign({}, none, { left: 0x8000 }));
    ok(r.pressed.length === 0, 'detect: a button held down is not pressed again', r);
    r = P.detect(r.down, none);
    ok(r.pressed.length === 0 && !r.down.left, 'detect: letting go is not a press', r);
    r = P.detect(r.down, Object.assign({}, none, { right: 1 }));
    ok(r.pressed.join() === 'right', 'detect: a tap shorter than the poll (only the "pressed since" bit) still counts', r);
    r = P.detect({ esc: false }, Object.assign({}, none, { esc: 0x8001 }));
    ok(r.pressed.join() === 'esc', 'detect: Esc going down counts once', r);
    r = P.detect(null, { left: 0x8000 });
    ok(r.pressed.join() === 'left', 'detect: no previous read = whatever is down now is new (the caller seeds it)', r);
  }

  // ---- opening arms the sidecar's watch, closing disarms it; a second pop-up does not re-arm
  {
    const R = rig();
    const a = popup({ x: 0, y: 600, w: 800, h: 100 });
    R.w.open('bar', a.h);
    await tick(); await tick();
    ok(R.calls.length === 1 && R.calls[0].on === true && R.calls[0].leaseMs === P.LEASE_MS && R.calls[0].hwnd === 4242,
      'open: the sidecar is asked to watch, with a lease and the bar\'s hwnd', R.calls);
    ok(R.w.state().mode === 'hook' && R.w.state().esc === 'swallow', 'open: the watch is the sidecar\'s hook, Esc kept from the app', R.w.state());
    ok(R.logs.some((l) => /watched by the sidecar/.test(l) && /kept from the app in front/.test(l)), 'open: the log says how pop-ups are watched', R.logs);
    ok(R.live().length === 1 && R.live()[0].ms === P.RENEW_MS, 'open: a renewal runs every RENEW_MS', R.intervals);
    R.fire(P.RENEW_MS); await tick();
    ok(R.calls.length === 2 && R.calls[1].on === true, 'renew: the lease is renewed while a pop-up is open', R.calls);
    R.w.refresh();
    await tick();
    ok(R.calls.length === 3 && R.calls[2].on === true && R.calls[2].hwnd === 4242, 'refresh (another Mantle window took the keyboard): the sidecar is told at once', R.calls);
    R.calls.pop();
    const b = popup({ x: 0, y: 0, w: 10, h: 10 });
    R.w.open('timer', b.h);
    await tick();
    ok(R.calls.length === 2, 'a second pop-up rides the same watch (no second arm)', R.calls);
    R.w.close('bar');
    await tick();
    ok(R.calls.length === 2 && R.w.state().mode === 'hook', 'closing one of two keeps the watch', R.w.state());
    R.w.close('timer');
    await tick(); await tick();
    ok(R.calls.length === 3 && R.calls[2].on === false, 'closing the last disarms the sidecar\'s watch', R.calls);
    ok(R.live().length === 0 && R.w.state().mode === null, 'closing the last stops the renewals', R.intervals);
    ok(R.w.close('timer') === false, 'closing what is not open is a no-op');
  }

  // ---- a click: outside closes, inside does not; DIP conversion of the hook's physical point
  {
    const R = rig();
    const a = popup({ x: 400, y: 600, w: 400, h: 100 });   // DIP
    R.w.open('bar', a.h);
    await tick(); await tick();
    R.w.onEvent({ ev: 'popwatch', op: 'click', button: 'left', x: 600 * 1.25, y: 650 * 1.25 });
    ok(a.got.length === 0, 'a click INSIDE the pop-up (physical point converted to DIP) closes nothing', a.got);
    R.w.onEvent({ ev: 'popwatch', op: 'click', button: 'left', x: 100 * 1.25, y: 650 * 1.25 });
    ok(a.got.length === 1 && a.got[0][0] === 'outside' && /left click outside/.test(a.got[0][1]), 'a click OUTSIDE closes it, and says how', a.got);
    R.w.onEvent({ ev: 'popwatch', op: 'click', button: 'right', x: 'x', y: null });
    ok(a.got.length === 2 && /right click/.test(a.got[1][1]), 'a click with no readable point falls back to the cursor (outside here)', a.got);
    R.setCursor(null);
    R.w.onEvent({ ev: 'popwatch', op: 'click', button: 'left' });
    ok(a.got.length === 2, 'a click whose point cannot be read at all closes nothing (a wrong close is worse)', a.got);
    // contains() that throws counts as inside
    const c = popup({ x: 0, y: 0, w: 1, h: 1 });
    c.h.contains = () => { throw new Error('gone'); };
    R.w.open('odd', c.h);
    R.setCursor({ x: 5000, y: 5000 });
    R.w.onEvent({ op: 'click', x: 1, y: 1 });
    ok(c.got.length === 0, 'a pop-up whose box cannot be read is not closed by a click', c.got);
  }

  // ---- Esc: the newest pop-up that takes Esc gets it, only it
  {
    const R = rig();
    const a = popup({ x: 0, y: 0, w: 1, h: 1 });
    const b = popup({ x: 0, y: 0, w: 1, h: 1 });
    R.w.open('bar', a.h);
    R.w.open('timer', { esc: b.h.esc });
    ok(R.w.onEvent({ op: 'esc', swallowed: true }) === 'timer' && b.got.length === 1 && a.got.length === 0, 'Esc goes to the newest pop-up only', [a.got, b.got]);
    R.w.close('timer');
    ok(R.w.onEvent({ op: 'esc' }) === 'bar' && a.got.length === 1 && a.got[0][0] === 'esc', 'then to the one under it', a.got);
    R.w.open('bar', a.h);   // re-opened: moves to the top, not doubled
    ok(R.w.state().open.join() === 'bar', 'opening a name again does not list it twice', R.w.state());
    R.w.open('quiet', { outside: () => {} });
    ok(R.w.onEvent({ op: 'esc' }) === 'bar', 'a pop-up with no Esc handler passes Esc to the next one', R.w.state());
    const thrower = { esc: () => { throw new Error('boom'); } };
    R.w.open('bad', thrower);
    R.w.onEvent({ op: 'esc' });
    ok(R.logs.some((l) => /closing the bad pop-up threw: boom/.test(l)), 'a handler that throws is logged, never thrown into the sidecar\'s event loop', R.logs);
  }

  // ---- the watch ending on its own while a pop-up is open is re-armed; an asked-for end is not
  {
    const R = rig();
    R.w.open('bar', popup({ x: 0, y: 0, w: 1, h: 1 }).h);
    await tick(); await tick();
    R.w.onEvent({ op: 'off', why: 'lease' });
    await tick(); await tick();
    ok(R.calls.length === 2 && R.calls[1].on === true && R.w.state().mode === 'hook', 'a lapsed lease with a pop-up open arms again', R.calls);
    ok(R.logs.some((l) => /watch ended \(lease\).*watching again/.test(l)), 'and says so', R.logs);
    ok(R.live().length === 1, 'with exactly one renewal running', R.intervals);
    R.w.onEvent({ op: 'off', why: 'asked' });
    await tick();
    ok(R.calls.length === 2, 'an "asked" end is not re-armed', R.calls);
  }

  // ---- a sidecar that cannot watch: the buttons are polled instead, and the log says what is lost
  {
    const none = { left: 0, right: 0, middle: 0, esc: 0 };
    const R = rig({ answer: () => { throw new Error("hotkey: unknown op 'popwatch'"); }, keys: none });
    const a = popup({ x: 400, y: 600, w: 400, h: 100 });
    R.w.open('bar', a.h);
    await tick(); await tick();
    ok(R.w.state().mode === 'poll' && /unknown op/.test(R.w.state().reason), 'an old sidecar: the fallback poll, with the reason', R.w.state());
    ok(R.logs.some((l) => /polled every 25 ms/.test(l) && /short tap can be missed/.test(l) && /Esc also reaches the app/.test(l)), 'the log says what the fallback cannot do', R.logs);
    const poll = R.live().find((h) => h.ms === P.POLL_MS);
    ok(!!poll, 'a poll runs every POLL_MS', R.intervals);
    R.setCursor({ x: 100, y: 100 });
    R.setKeys(Object.assign({}, none, { left: 0x8000 }));
    poll.fn();
    ok(a.got.length === 1 && a.got[0][0] === 'outside', 'polled: a button down outside closes the pop-up', a.got);
    poll.fn();
    ok(a.got.length === 1, 'polled: the same held button does not close it again', a.got);
    R.setKeys(none); poll.fn();
    R.setCursor({ x: 500, y: 650 });
    R.setKeys(Object.assign({}, none, { left: 1 })); poll.fn();
    ok(a.got.length === 1, 'polled: a tap inside the pop-up closes nothing', a.got);
    R.setKeys(Object.assign({}, none, { esc: 0x8000 })); poll.fn();
    ok(a.got.length === 2 && a.got[1][0] === 'esc', 'polled: Esc closes it', a.got);
    R.w.close('bar');
    ok(R.live().length === 0, 'closing stops the poll', R.intervals);
  }
  {
    const R = rig({ answer: () => { throw new Error('the sidecar is not running'); }, keys: null });
    R.w.open('bar', popup({ x: 0, y: 0, w: 1, h: 1 }).h);
    await tick(); await tick();
    ok(R.w.state().mode === 'none' && R.logs.some((l) => /NOT watched/.test(l) && /sidecar is not running/.test(l)),
      'no sidecar and no key reader: the log says pop-ups close only from inside, and why', R.logs);
  }

  // ---- --test: nothing real is watched unless --test-popwatch, but made-up events still route
  {
    const R = rig({ test: true });
    const a = popup({ x: 0, y: 0, w: 10, h: 10 });
    R.w.open('bar', a.h);
    await tick();
    ok(R.calls.length === 0 && R.w.state().mode === 'none' && /--test-popwatch/.test(R.w.state().reason), '--test: the sidecar is never asked to watch', R.w.state());
    R.w.onEvent({ op: 'click', x: 9999, y: 9999 });
    ok(a.got.length === 1, '--test: a made-up click (the test hook) still closes it', a.got);
    const R2 = rig({ test: true, testArm: true, answer: () => ({ armed: true, esc: 'observe' }) });
    R2.w.open('bar', popup({ x: 0, y: 0, w: 1, h: 1 }).h);
    await tick(); await tick();
    ok(R2.calls.length === 1 && R2.w.state().esc === 'observe' && R2.logs.some((l) => /also reaches the app/.test(l)), '--test --test-popwatch: armed, and a passive sidecar only observes Esc', R2.logs);
  }

  // ---- an arm answer that lands after everything closed disarms at once
  {
    let release;
    const R = rig({ answer: (args) => (args.on ? new Promise((r) => { release = () => r({ armed: true, esc: 'swallow' }); }) : { armed: false }) });
    R.w.open('bar', popup({ x: 0, y: 0, w: 1, h: 1 }).h);
    await tick();
    R.w.close('bar');
    await tick();
    if (release) release();
    await tick(); await tick(); await tick();
    ok(R.calls.some((c) => c.on === false) && R.w.state().mode === null && R.live().length === 0, 'a late arm answer after the close leaves nothing armed', [R.calls, R.w.state()]);
  }

  // ---- unconfigured (the features' unit tests): open/close keep the list and never throw
  {
    const w = P.create();
    let threw = null;
    try { w.open('timer', { esc: () => {} }); w.close('timer'); w.onEvent({ op: 'esc' }); } catch (e) { threw = e; }
    ok(!threw && w.state().open.length === 0 && w.state().mode === null, 'unconfigured: inert, never throws', threw && threw.message);
    ok(typeof P.open === 'function' && typeof P.configure === 'function', 'the module itself is the shared watch');
  }

  for (const f of failures) console.log('  FAIL ' + f);
  console.log(`POPWATCH TEST: ${passed} passed, ${failures.length} failed`);
  process.exitCode = failures.length ? 1 : 0;
}

main().catch((e) => { console.log('  FAIL the run itself: ' + (e && e.stack || e)); console.log(`POPWATCH TEST: ${passed} passed, ${failures.length + 1} failed`); process.exitCode = 1; });
