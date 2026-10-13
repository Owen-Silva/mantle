/*
 * surface-gate.test.js -- lib/surface-gate.js with hand-driven promises, timers and key state
 * (lane mn-launch, 2026-10-12; audit #5, #7, #14). No Electron, nothing on screen.
 *   node lib/surface-gate.test.js
 * Prints "SURFACE GATE TEST: n passed, m failed".
 */
'use strict';
const G = require('./surface-gate');

let passed = 0;
const failures = [];
function ok(cond, what) { if (cond) passed++; else failures.push(what); }
const tick = () => new Promise((r) => setImmediate(r));

/** A pop-up whose prepare() waits until the test lets it go. */
function rig(extra) {
  const t = { shown: false, reveals: [], conceals: [], waiting: [], clock: 1000 };
  t.release = () => { const w = t.waiting.splice(0); w.forEach((r) => r()); };
  t.gate = G.createGate(Object.assign({
    now: () => t.clock,
    isShown: () => t.shown,
    prepare: () => new Promise((r) => { t.waiting.push(r); }),
    reveal: (o) => { t.shown = true; t.reveals.push(o); },
    conceal: (why) => { t.shown = false; t.conceals.push(why); },
  }, extra || {}));
  return t;
}

(async () => {
  // ---- #14: last intent wins ------------------------------------------------------------------
  {
    const t = rig();
    const p = t.gate.open('win');
    ok(t.gate.state === 'opening', 'open: opening while prepare waits');
    const c = t.gate.close('esc');
    ok(c.was === 'opening' && t.gate.state === 'hidden', `close during opening: hidden (${c.was}, ${t.gate.state})`);
    t.release();
    const r = await p;
    ok(!r.opened && /closed before/.test(r.reason), `the pending open did not show (${JSON.stringify(r)})`);
    ok(t.reveals.length === 0 && !t.shown, 'close during opening: never shown (the old code showed it anyway)');
    ok(t.conceals.length === 0, 'nothing was visible, so nothing was hidden');
  }
  {
    const t = rig();
    const a = t.gate.toggle('win');
    const b = t.gate.toggle('win');          // the second press while it is still opening
    t.release();
    const ra = await a; const rb = await b;
    ok(!ra.opened && rb.closed && rb.was === 'opening', `two taps while opening: closed (${JSON.stringify(ra)} ${JSON.stringify(rb)})`);
    ok(!t.shown && t.reveals.length === 0, 'two taps while opening: it never appears');
  }
  {
    const t = rig();
    const a = t.gate.toggle('win'); t.gate.toggle('win'); const c = t.gate.toggle('win');   // three: open
    ok(a !== c, 'a third tap starts a fresh open');
    t.release();
    ok((await c).opened && t.shown && t.reveals.length === 1, 'three taps while opening: open, shown once');
    ok(!(await a).opened, 'the first of three was superseded');
  }
  {
    const t = rig();
    const a = t.gate.open('win'); const b = t.gate.open('win+s');
    ok(a === b, 'open while opening joins the same open (no second capture)');
    t.release(); await a;
    ok(t.reveals.length === 1 && t.reveals[0].again === false, 'joined opens show once');
    const again = await t.gate.open('win+s');
    ok(again.opened && again.again && t.reveals.length === 2 && t.reveals[1].again === true, 'open over an open one: brought forward, marked again');
    const tg = await t.gate.toggle('start');
    ok(tg.closed && !t.shown && t.conceals[0] === 'toggle', '#5: toggle over an open one closes it');
    const tg2 = t.gate.toggle('start'); t.release();
    ok((await tg2).opened && t.shown, '#5: toggle again opens it');
  }
  {
    // the window went away behind the gate's back (reload, rest): the next toggle opens, not closes
    const t = rig({ prepare: null });
    await t.gate.open('win');
    t.shown = false;
    const r = await t.gate.toggle('win');
    ok(r.opened && t.shown, 'hidden behind its back: toggle opens');
  }
  {
    // prepare throws: still shows (it lost only its nicety), and says so
    const said = [];
    const t = rig({ prepare: async () => { throw new Error('no frame'); }, log: (x) => said.push(x) });
    const r = await t.gate.open('win');
    ok(r.opened && t.shown && said.some((x) => /no frame/.test(x)), 'prepare failure: shown anyway, and logged');
  }
  {
    // reveal throws: not left "shown"
    const t = rig({ prepare: null, reveal: () => { throw new Error('gone'); } });
    const r = await t.gate.open('win');
    ok(!r.opened && /gone/.test(r.reason) && t.gate.state === 'hidden', 'reveal failure: a reason, and hidden');
  }
  {
    // the Start button's own click, already seen as "outside" by the no-keyboard watch, is not a reopen
    const t = rig({ prepare: null });
    await t.gate.open('start');
    t.gate.close('outside');
    t.clock += 120;
    const r = await t.gate.toggle('start');
    ok(r.closed && !t.shown && /same click/.test(r.reason), `outside then Start within ${G.SAME_CLICK_MS} ms: one click, stays closed`);
    t.clock += 50;
    const r2 = await t.gate.toggle('start');
    ok(r2.opened && t.shown, 'the NEXT click opens again');
    t.gate.close('outside');
    t.clock += G.SAME_CLICK_MS + 1;
    ok((await t.gate.toggle('start')).opened, 'a click long after an outside close opens');
  }

  // ---- #7: the keyboard ------------------------------------------------------------------------
  const now0 = (fn) => fn();                          // timers fire at once
  {
    const res = [];
    const r = await G.ensureKeyboard({ setTimeout: now0, alive: () => true, isFocused: () => true, retry: async () => { throw new Error('must not run'); }, onResult: (x) => res.push(x) });
    ok(r.ok && r.how === 'direct' && res.length === 1, 'focused at once: direct, no retry');
  }
  {
    let focused = false; let retried = 0;
    const r = await G.ensureKeyboard({ setTimeout: now0, alive: () => true, isFocused: () => focused, retry: async () => { retried++; focused = true; }, onResult: () => {} });
    ok(r.ok && r.how === 'retry' && retried === 1, 'refused, then the sidecar retry took it');
  }
  {
    const r = await G.ensureKeyboard({ setTimeout: now0, alive: () => true, isFocused: () => false, retry: async () => { throw new Error('Windows refused the foreground change'); }, onResult: () => {} });
    ok(!r.ok && r.reason === 'Windows refused the foreground change', `retry failed: its reason (${r.reason})`);
  }
  {
    const r = await G.ensureKeyboard({ setTimeout: now0, alive: () => true, isFocused: () => false, retry: async () => {}, onResult: () => {} });
    ok(!r.ok && /kept the keyboard/.test(r.reason), 'retry ran but nothing changed: a plain reason');
  }
  {
    let n = 0;
    const r = await G.ensureKeyboard({ setTimeout: now0, alive: () => false, isFocused: () => false, retry: async () => { n++; }, onResult: () => { n++; } });
    ok(r === null && n === 0, 'closed before the check: silent, no retry');
  }
  {
    const w = G.noKeyboardWords('Windows refused the foreground change.', true);
    ok(/^No keyboard: Windows refused the foreground change\. Click here to type; click outside or press Esc to close\.$/.test(w), `the sentence (${w})`);
    ok(/click here and press Esc/.test(G.noKeyboardWords(null, false)) && !/undefined|null/.test(G.noKeyboardWords(undefined, false)), 'no watch: says how to close it; no "undefined"');
  }

  // ---- #7: click outside / Esc while it has no keyboard ----------------------------------------
  function watchRig(initial) {
    const down = new Map(Object.entries(initial || {}).map(([k, v]) => [Number(k), v]));
    const w = { down, closed: [], fn: null, cleared: 0, cursor: { x: 5, y: 5 } };
    w.h = G.watchOutside({
      keys: { down: (vk) => !!down.get(vk) },
      setInterval: (fn) => { w.fn = fn; return 1; }, clearInterval: () => { w.cleared++; },
      bounds: () => ({ x: 100, y: 100, width: 200, height: 100 }),
      cursor: () => w.cursor,
      onOutside: (why) => w.closed.push(why),
    });
    return w;
  }
  {
    const w = watchRig();
    ok(w.h.ok && w.h.reason === null, 'watch armed');
    w.fn();
    ok(w.closed.length === 0, 'nothing pressed: nothing closes');
    w.cursor = { x: 150, y: 150 }; w.down.set(G.VK.LBUTTON, true); w.fn();
    ok(w.closed.length === 0, 'a click INSIDE does not close (it gives the pop-up the keyboard)');
    w.down.set(G.VK.LBUTTON, false); w.fn();
    w.cursor = { x: 20, y: 20 }; w.down.set(G.VK.LBUTTON, true); w.fn();
    ok(w.closed.join() === 'outside' && w.cleared === 1, 'a click outside closes, once, and the poll stops');
  }
  {
    const w = watchRig({ [G.VK.LBUTTON]: true });      // the Start click still held when it opened
    w.cursor = { x: 1, y: 1 }; w.fn();
    ok(w.closed.length === 0, 'a button already down when the watch began is not a new click');
    w.down.set(G.VK.LBUTTON, false); w.fn(); w.down.set(G.VK.RBUTTON, true); w.fn();
    ok(w.closed.join() === 'outside', 'a right-click outside closes too');
  }
  {
    const w = watchRig();
    w.down.set(G.VK.ESCAPE, true); w.fn();
    ok(w.closed.join() === 'esc', 'Esc closes');
  }
  {
    const h = G.watchOutside({ keys: null, bounds: () => null, cursor: () => null, onOutside: () => {} });
    ok(typeof h.stop === 'function', 'stop() always exists');
  }

  {
    // this machine: the real GetAsyncKeyState binding (koffi) loads, so the live watch can run
    const h = G.watchOutside({ bounds: () => null, cursor: () => null, onOutside: () => {} });
    h.stop();
    ok(h.ok || process.platform !== 'win32', `the real key-state binding loads (${h.reason})`);
  }

  if (failures.length) for (const f of failures) console.log(`  FAIL ${f}`);
  console.log(`SURFACE GATE TEST: ${passed} passed, ${failures.length} failed`);
  process.exitCode = failures.length ? 1 : 0;
})().catch((err) => { console.log(`SURFACE GATE TEST: crashed (${err.stack})`); process.exitCode = 1; });
