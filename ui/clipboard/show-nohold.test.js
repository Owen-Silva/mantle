// show-nohold.test.js - the Win+V panel reports "drawn" WITHOUT waiting for the dark glass (lane
// clipwarm, 2026-10-16; PERF.md "Nothing waits on the open path": a warm hold is 0 ms).
//   node ui/clipboard/show-nohold.test.js
// Runs the real ui/clipboard/clipboard.js in a vm with a do-anything DOM stub and a fake bridge, then
// sends clipboard.show and checks what the page tells main, in dark (a picture that never comes, one
// that comes, one that fails) and in light. Also the log-line helpers in model.js. Plain node, no deps.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const CM = require('./model.js');

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) pass++;
  else { fail++; console.log('FAIL ' + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail) : '')); }
}

// a DOM node that accepts anything: every property is another stub, every call returns one
function stub() {
  const store = {};
  const fn = function () { return stub(); };
  return new Proxy(fn, {
    get(_t, k) {
      if (k in store) return store[k];
      if (k === Symbol.toPrimitive) return () => '';
      if (k === 'length' || k === 'scrollTop' || k === 'offsetHeight' || k === 'clientHeight' || k === 'scrollHeight') return 0;
      if (k === 'value' || k === 'textContent' || k === 'className' || k === 'innerHTML') return '';
      if (k === 'then') return undefined;   // never a thenable
      return stub();
    },
    set(_t, k, v) { store[k] = v; return true; },
  });
}

function run(theme, backdrop, vis) {
  const handlers = {};
  const calls = [];
  const timers = [];
  const rafs = [];
  const doc = stub();
  const docEl = { getAttribute: (n) => (n === 'data-theme' ? theme : null), setAttribute() {} };
  const document = new Proxy(doc, {
    get(t, k) {
      if (k === 'documentElement') return docEl;
      if (k === 'visibilityState') return vis || 'hidden';   // main shows the panel only after the report
      if (k === 'hasFocus') return () => false;
      return t[k];
    },
  });
  const window = {
    ClipModel: CM,
    innerWidth: 400, innerHeight: 500,
    MantleHudBackdrop: backdrop || undefined,
    mantle: {
      on: (name, f) => { handlers[name] = f; },
      call: (name, args) => { calls.push({ name, args }); return Promise.resolve({}); },
    },
    addEventListener() {},
  };
  const ctx = {
    window, document, console,
    performance: { now: () => Date.now() },
    setTimeout: (f) => { timers.push(f); return timers.length; },
    clearTimeout() {},
    requestAnimationFrame: (f) => { rafs.push(f); return rafs.length; },
    navigator: { clipboard: stub() },
  };
  ctx.window.document = document;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'clipboard.js'), 'utf8'), ctx, { filename: 'clipboard.js' });
  const flush = () => { while (timers.length) timers.shift()(); };
  return { handlers, calls, flush, rafs };
}

const LIST = { items: [{ id: 'a', kind: 'text', text: 'one' }, { id: 'b', kind: 'text', text: 'two' }] };
const tick = () => new Promise((r) => setImmediate(r));

(async () => {
  // ---- dark, a picture that NEVER comes: the panel still reports drawn
  {
    let asked = 0;
    const bd = { ms: null, bake: null, request: () => { asked++; return new Promise(() => {}); } };
    const p = run('dark', bd);
    check('dark: the page listens for clipboard.show', typeof p.handlers['clipboard.show'] === 'function');
    p.handlers['clipboard.show']({ list: LIST, arm: null });
    p.flush();
    const painted = p.calls.filter((c) => c.name === 'clipboard.painted');
    check('dark, picture never comes: painted is still reported', painted.length === 1, p.calls.map((c) => c.name));
    check('dark: painted carries the drawn count', painted[0] && painted[0].args.count === 2, painted[0] && painted[0].args);
    check('dark: painted no longer carries a backdrop hold', painted[0] && !('backdropMs' in painted[0].args), painted[0] && painted[0].args);
    check('dark: the picture is still asked for, once', asked === 1, asked);
    check('dark, picture never comes: no glass report', !p.calls.some((c) => c.name === 'clipboard.glass'));
  }
  // ---- dark, a picture that comes later: drawn first, then the glass report
  {
    let resolve;
    const bd = { ms: 21, bake: 9, request: () => new Promise((r) => { resolve = r; }) };
    const p = run('dark', bd);
    p.handlers['clipboard.show']({ list: LIST, arm: null });
    p.flush();
    check('dark, later picture: painted before any glass', p.calls.length >= 1 && p.calls[0].name === 'clipboard.painted', p.calls.map((c) => c.name));
    resolve({ ok: true, ms: 21 });
    await tick(); await tick();
    const g = p.calls.find((c) => c.name === 'clipboard.glass');
    check('dark, later picture: glass reported after', !!g && p.calls.indexOf(g) > 0, p.calls.map((c) => c.name));
    check('dark: glass report has ok, capture and bake', g && g.args.ok === true && g.args.capture === 21 && g.args.bake === 9 && g.args.reason === null, g && g.args);
  }
  // ---- dark, a picture that fails: the reason goes to main
  {
    const bd = { ms: null, bake: null, request: () => Promise.resolve({ ok: false, reason: 'the clipboard window is not open' }) };
    const p = run('dark', bd);
    p.handlers['clipboard.show']({ list: LIST, arm: null });
    p.flush();
    await tick(); await tick();
    const g = p.calls.find((c) => c.name === 'clipboard.glass');
    check('dark, failed picture: painted anyway', p.calls.some((c) => c.name === 'clipboard.painted'));
    check('dark, failed picture: glass says why', g && g.args.ok === false && /not open/.test(g.args.reason), g && g.args);
  }
  // ---- light: no picture asked, painted at once (unchanged)
  {
    let asked = 0;
    const bd = { request: () => { asked++; return new Promise(() => {}); } };
    const p = run('light', bd);
    p.handlers['clipboard.show']({ list: LIST, arm: null });
    p.flush();
    check('light: painted reported', p.calls.filter((c) => c.name === 'clipboard.painted').length === 1, p.calls.map((c) => c.name));
    check('light: no picture asked for', asked === 0, asked);
  }

  // ---- a window never shown yet: the page reads 'visible' but gets no frames; main says hidden
  {
    const p = run('light', null, 'visible');
    p.handlers['clipboard.show']({ list: LIST, arm: null, visible: false });
    p.flush();
    check('never-shown window (main: hidden): painted without waiting for frames', p.calls.filter((c) => c.name === 'clipboard.painted').length === 1 && p.rafs.length === 0, { calls: p.calls.map((c) => c.name), rafs: p.rafs.length });
  }
  // ---- a panel already on screen (main: visible): two frames, then painted
  {
    const p = run('light', null, 'visible');
    p.handlers['clipboard.show']({ list: LIST, arm: null, visible: true });
    p.flush();
    check('on screen: painted waits for the frame', !p.calls.some((c) => c.name === 'clipboard.painted') && p.rafs.length === 1, p.calls.map((c) => c.name));
    p.rafs.shift()(); p.rafs.shift()();
    check('on screen: painted after two frames', p.calls.filter((c) => c.name === 'clipboard.painted').length === 1, p.calls.map((c) => c.name));
  }

  // ---- model.js glassOf / glassLine
  const g1 = CM.glassOf({ ok: true, ms: 40.4, capture: 25, bake: 8 }, 52);
  check('glassOf: rounds and keeps numbers', g1.ok && g1.ms === 40 && g1.capture === 25 && g1.bake === 8 && g1.sinceOpen === 52 && g1.reason === null, g1);
  const gBad = CM.glassOf({ ok: 'yes', ms: -3, capture: NaN, reason: 'x'.repeat(500) });
  check('glassOf: only ok:true is ok, junk numbers are null, reason capped', gBad.ok === false && gBad.ms === null && gBad.capture === null && gBad.reason.length === 200, gBad);
  check('glassOf: no args', CM.glassOf(undefined).ok === false && /no reason/.test(CM.glassOf(undefined).reason));
  check('glassLine: a quick one after the first is quiet', CM.glassLine(g1, false) === null);
  const first = CM.glassLine(g1, true);
  check('glassLine: the first is said, and that the open never waited', /first this run/.test(first) && /never waited/.test(first) && /capture 25 ms/.test(first), first);
  const slow = CM.glassLine(CM.glassOf({ ok: true, ms: CM.GLASS_SLOW_MS + 1, capture: 140, bake: 9 }), false);
  check('glassLine: a slow one is said', /slow/.test(slow), slow);
  const none = CM.glassLine(CM.glassOf({ ok: false, reason: 'game rest' }), false);
  check('glassLine: a missing one is always said, with why', /none this open/.test(none) && /game rest/.test(none), none);
  check('glassLine: null in, null out', CM.glassLine(null, true) === null);

  console.log(`show-nohold: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAIL threw: ' + (e && e.stack)); process.exit(1); });
