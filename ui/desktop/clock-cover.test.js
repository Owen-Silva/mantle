'use strict';
/*
 * clock-cover.test.js - the desktop clock (and the 5 s System numbers) stop while a window sits
 * over their pane, and come back with the right time the moment the pane shows again.
 *
 *   node ui/desktop/clock-cover.test.js            checks ui/desktop/desktop.js (must pass)
 *   node ui/desktop/clock-cover.test.js --against 50014df
 *                                                  the same checks against that commit's copy
 *                                                  (the clock that ticked all day under a
 *                                                  maximised window: expected to FAIL)
 *
 * Why (lane idlefix, 2026-10-17): main.js turns off Chromium's covered-window detection
 * (disable-features=CalculateNativeWinOcclusion), so the page's visibilitychange pause never
 * fired under a maximised window and the full-screen desktop layer committed a frame every
 * second all day. The page already knows when its panes are covered (widgethide.cover), so the
 * clock keys off that.
 *
 * desktop.js is a plain browser script, so it is run whole in a node vm with a stubbed
 * window/document, a fake clock (setTimeout/setInterval/Date) advanced by hand, panes that wear
 * .covered, and a getComputedStyle that reports visibility 'hidden' only once the exit fade
 * (FADE_MS) has finished, the way desktop.css does it. No Electron, no Chromium, no sidecar.
 * Prints one summary line; exits 1 if anything failed.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const ai = process.argv.indexOf('--against');
const AGAINST = ai > 0 ? process.argv[ai + 1] : null;
const SRC = AGAINST
  ? execFileSync('git', ['show', AGAINST + ':ui/desktop/desktop.js'], { cwd: REPO, encoding: 'utf8' })
  : fs.readFileSync(path.join(__dirname, 'desktop.js'), 'utf8');

const FADE_MS = 280;   // the exit fade the fake getComputedStyle plays (desktop.css --lg-dur-out)

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(name + (detail !== undefined ? ' -- ' + detail : ''));
}

// a stub that swallows anything: every unknown property is another stub, every call returns one
function stub(preset) {
  const store = Object.assign(Object.create(null), preset || {});
  const target = function () {};
  return new Proxy(target, {
    get(t, k) {
      if (k in store) return store[k];
      if (typeof k === 'symbol') return k === Symbol.toPrimitive ? () => '' : undefined;
      if (k === 'then') return undefined;
      const v = stub();
      store[k] = v;
      return v;
    },
    set(t, k, v) { store[k] = v; return true; },
    apply() { return stub(); },
    construct() { return stub(); },
  });
}

const pad2 = (n) => (n < 10 ? '0' + n : String(n));

function loadPage(src) {
  const clock = { now: 0, seq: 0, timers: new Map() };
  const BASE = new Date(2026, 9, 17, 16, 14, 50, 300).getTime();   // 4:14:50.300 PM
  function addTimer(fn, ms, repeat, args) {
    const id = ++clock.seq;
    const wait = Math.max(0, Number(ms) || 0);
    clock.timers.set(id, { fn, args, at: clock.now + wait, every: Math.max(1, wait), repeat });
    return id;
  }
  class FakeDate extends Date {
    constructor(...a) { if (a.length) super(...a); else super(BASE + clock.now); }
    static now() { return BASE + clock.now; }
  }

  // writes to the clock's seconds, with the virtual time they happened at
  const ssWrites = [];
  const elements = new Map();
  function element(id) {
    if (elements.has(id)) return elements.get(id);
    let text = '';
    const inner = stub({ id, hidden: false });
    const el = new Proxy(inner, {
      get(t, k) { return k === 'textContent' ? text : inner[k]; },
      set(t, k, v) {
        if (k === 'textContent') { text = String(v); if (id === 'clock-ss') ssWrites.push(clock.now); }
        else inner[k] = v;
        return true;
      },
    });
    elements.set(id, el);
    return el;
  }

  // the four covered-aware panes, each with a class list and a fade timeline
  function pane(key) {
    const cls = new Set(['pane']);
    const p = {
      dataset: { cover: key },
      coveredAt: null,   // virtual time .covered went on (null = not covered)
      classList: {
        toggle(c, on) {
          const want = on === undefined ? !cls.has(c) : !!on;
          if (c === 'covered') {
            if (want && !cls.has(c)) p.coveredAt = clock.now;
            if (!want) p.coveredAt = null;
          }
          if (want) cls.add(c); else cls.delete(c);
          return want;
        },
        contains: (c) => cls.has(c),
        add: (c) => p.classList.toggle(c, true),
        remove: (c) => p.classList.toggle(c, false),
      },
      style: stub(),
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 50 }),
    };
    return p;
  }
  const panes = ['clock', 'stats', 'mc', 'strip'].map(pane);
  const byKey = (k) => panes.find((p) => p.dataset.cover === k);

  const docListeners = Object.create(null);
  const docState = { visibilityState: 'visible' };
  const docInner = stub({
    getElementById: element,
    querySelectorAll(sel) {
      if (sel === '.pane[data-cover]' || sel === '.pane') return panes.slice();
      return [];
    },
    querySelector(sel) {
      const m = /\.pane\[data-cover="([a-z]+)"\]/.exec(sel);
      return m ? byKey(m[1]) || null : null;
    },
    addEventListener(name, cb) { (docListeners[name] = docListeners[name] || []).push(cb); },
  });
  const document = new Proxy(docInner, {
    get(t, k) { return k === 'visibilityState' ? docState.visibilityState : docInner[k]; },
    set(t, k, v) { docInner[k] = v; return true; },
  });

  const calls = [];
  const handlers = Object.create(null);
  const mantle = {
    call(name, args) {
      calls.push({ name, at: clock.now });
      if (name === 'sys.stats') return Promise.resolve({ cpu: 3, memUsed: 1, memTotal: 2, battery: null, batteryReason: 'this machine reports no battery' });
      if (name === 'net.probe') return Promise.resolve({ ok: false, reason: 'connect ECONNREFUSED 127.0.0.1:7373' });
      return Promise.resolve({ ok: true });
    },
    on(name, cb) { handlers[name] = cb; },
  };
  const getComputedStyle = (el) => {
    const faded = el && el.coveredAt !== null && el.coveredAt !== undefined && clock.now >= el.coveredAt + FADE_MS;
    return { visibility: faded ? 'hidden' : 'visible', opacity: el && el.coveredAt !== null ? '0' : '1' };
  };
  const window = stub({ mantle, getComputedStyle, addEventListener() {} });
  const ctx = vm.createContext({
    window, document, console, getComputedStyle,
    setTimeout: (fn, ms, ...a) => addTimer(fn, ms, false, a),
    setInterval: (fn, ms, ...a) => addTimer(fn, ms, true, a),
    clearTimeout: (id) => { clock.timers.delete(id); },
    clearInterval: (id) => { clock.timers.delete(id); },
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
  const advance = (ms) => advanceTo(clock.now + ms);
  const cover = (map, on) => { handlers['widgethide.cover']({ on: on !== false, covered: map, by: 'a test window', reason: 'test' }); };
  const nowText = () => {
    const d = new FakeDate();
    const h = (d.getHours() % 12) || 12;
    return { hm: h + ':' + pad2(d.getMinutes()), ss: pad2(d.getSeconds()), mer: d.getHours() < 12 ? 'AM' : 'PM' };
  };
  return {
    clock, calls, handlers, ssWrites, advance, advanceTo, cover, nowText, byKey,
    text: (id) => (elements.get(id) ? elements.get(id).textContent : ''),
    writesBetween: (a, b) => ssWrites.filter((t) => t > a && t <= b).length,
    statsCalls: (a, b) => calls.filter((c) => c.name === 'sys.stats' && c.at > a && c.at <= (b === undefined ? Infinity : b)).length,
    setHidden: (hidden) => {
      docState.visibilityState = hidden ? 'hidden' : 'visible';
      (docListeners.visibilitychange || []).forEach((cb) => cb());
    },
    rest: (on) => handlers['mantle.rest']({ on, why: 'a game is running' }),
    flush,
  };
}

async function main() {
  // ---- 1. at rest and uncovered: one write a second, aimed at the boundary
  {
    const p = loadPage(SRC);
    p.cover({}, true);   // the feature's first answer: nothing covered
    await p.advance(60000);
    const n = p.writesBetween(0, 60000);
    check('uncovered: the seconds tick once a second (59-61 writes in 60 s)', n >= 59 && n <= 61, n);
    const t = p.nowText();
    check('uncovered: the clock shows the current second', p.text('clock-ss') === t.ss && p.text('clock-hm') === t.hm, p.text('clock-hm') + ':' + p.text('clock-ss') + ' vs ' + t.hm + ':' + t.ss);
  }

  // ---- 2. a maximised window covers the clock: it stops after the fade, and stays stopped
  {
    const p = loadPage(SRC);
    p.cover({}, true);
    await p.advance(10000);
    const coverAt = p.clock.now;
    p.cover({ clock: true, stats: true, mc: true, strip: true }, true);
    await p.advance(3000);
    const settled = p.clock.now;
    await p.advance(10 * 60 * 1000);
    const n = p.writesBetween(settled, p.clock.now);
    // PINNED: fails on 50014df (about 600 writes in 10 min under the window).
    check('covered 10 min: the clock writes nothing once the pane has faded out', n === 0, n + ' writes');
    check('covered: at most 2 ticks between the cover and the park', p.writesBetween(coverAt, settled) <= 2, p.writesBetween(coverAt, settled));
    const sys = p.statsCalls(settled);
    // PINNED: fails on 50014df (120 reads in 10 min under the window).
    check('covered 10 min: the System numbers are not read', sys === 0, sys + ' sys.stats calls');

    // ---- 3. the desktop shows again (Win+D): the right time at once, before any timer runs
    await p.advance(37421);   // an odd offset, so the uncover is mid-second and past a minute boundary
    p.cover({}, true);
    const t = p.nowText();
    check('uncovered: the seconds are this second the moment .covered comes off',
      p.text('clock-ss') === t.ss, p.text('clock-ss') + ' vs ' + t.ss);
    check('uncovered: the hour and minute are current too', p.text('clock-hm') === t.hm && p.text('clock-mer') === t.mer,
      p.text('clock-hm') + ' ' + p.text('clock-mer') + ' vs ' + t.hm + ' ' + t.mer);
    check('uncovered: .covered is off the clock pane', !p.byKey('clock').classList.contains('covered'));
    check('uncovered: the System numbers are read at once', p.statsCalls(p.clock.now - 1) >= 1, p.statsCalls(p.clock.now - 1));
    const back = p.clock.now;
    await p.advance(30000);
    const n2 = p.writesBetween(back, p.clock.now);
    check('uncovered again: ticking once a second (29-31 writes in 30 s)', n2 >= 29 && n2 <= 31, n2);
    const t2 = p.nowText();
    check('uncovered again: still the current second 30 s later', p.text('clock-ss') === t2.ss, p.text('clock-ss') + ' vs ' + t2.ss);
    const s2 = p.statsCalls(back, p.clock.now);
    check('uncovered again: the System numbers are read every 5 s (6-8 in 30 s)', s2 >= 6 && s2 <= 8, s2);
  }

  // ---- 4. no frozen digits while still visible: a slow fade keeps the clock ticking
  {
    const p = loadPage(SRC);
    p.cover({}, true);
    await p.advance(5000);
    // 5 s after a load at .300, the clock is at .300 of a second: wait to .900, so the next
    // tick (the boundary, 100 ms on) lands inside the fade
    await p.advance(600);
    const before = p.ssWrites.length;
    p.cover({ clock: true }, true);
    await p.advance(FADE_MS - 1);   // still fading: the digits are on screen
    const tf = p.nowText();
    check('fading out: the shown second is still current while the pane is visible',
      p.text('clock-ss') === tf.ss, p.text('clock-ss') + ' vs ' + tf.ss);
    await p.advance(3000);
    check('fading out: it parks within 2 ticks once faded', p.ssWrites.length - before <= 2, p.ssWrites.length - before);
  }

  // ---- 5. cover answers that are off or unknown fail open: the clock runs
  {
    const p = loadPage(SRC);
    p.cover({ clock: true }, false);   // the feature is off: nothing is covered
    await p.advance(20000);
    const n = p.writesBetween(0, 20000);
    check('cover feature off: the clock keeps ticking', n >= 19, n);
    p.handlers['widgethide.cover'](null);
    await p.advance(10000);
    check('no cover answer: the clock keeps ticking', p.writesBetween(20000, 30000) >= 9, p.writesBetween(20000, 30000));
    p.cover({ stats: true }, true);   // only the System tile covered
    await p.advance(10000);
    check('only the System tile covered: the clock keeps ticking', p.writesBetween(30000, 40000) >= 9, p.writesBetween(30000, 40000));
    check('only the System tile covered: its numbers park', p.statsCalls(36000, 40000) === 0, p.statsCalls(36000, 40000));
  }

  // ---- 6. resting for a game and the page's own visibility still rule as before
  {
    const p = loadPage(SRC);
    p.cover({}, true);
    p.rest(false);   // the first answer: not resting
    await p.advance(5000);
    p.rest(true);
    await p.advance(60000);
    check('resting: the clock is stopped', p.writesBetween(5000, 65000) === 0, p.writesBetween(5000, 65000));
    check('resting: the System numbers are not read', p.statsCalls(5000, 65000) === 0, p.statsCalls(5000, 65000));
    p.cover({ clock: true, stats: true }, true);   // a window comes over it while resting
    await p.advance(1000);
    p.rest(false);   // the game exits, the window is still there
    const t = p.nowText();
    check('rest ends under a window: the clock paints the current time', p.text('clock-ss') === t.ss, p.text('clock-ss') + ' vs ' + t.ss);
    const at = p.clock.now;
    await p.advance(60000);
    check('rest ends under a window: then it parks (<= 1 write in 60 s)', p.writesBetween(at, p.clock.now) <= 1, p.writesBetween(at, p.clock.now));
    check('rest ends under a window: <= 1 System read in 60 s', p.statsCalls(at + 1, p.clock.now) <= 1, p.statsCalls(at + 1, p.clock.now));
    p.cover({}, true);
    const t2 = p.nowText();
    check('then uncovered: the current second at once', p.text('clock-ss') === t2.ss, p.text('clock-ss') + ' vs ' + t2.ss);
    const at2 = p.clock.now;
    await p.advance(10000);
    check('then uncovered: ticking again', p.writesBetween(at2, p.clock.now) >= 9, p.writesBetween(at2, p.clock.now));
    // a rest that starts while uncovered and ends while uncovered: ticking again
    p.rest(true);
    await p.advance(5000);
    p.rest(false);
    const at3 = p.clock.now;
    await p.advance(10000);
    check('rest ends uncovered: ticking again', p.writesBetween(at3, p.clock.now) >= 9, p.writesBetween(at3, p.clock.now));
    check('rest ends uncovered: the System numbers are read again', p.statsCalls(at3 - 1, p.clock.now) >= 2, p.statsCalls(at3 - 1, p.clock.now));
  }
  {
    const p = loadPage(SRC);
    p.cover({}, true);
    await p.advance(3000);
    p.setHidden(true);
    await p.advance(20000);
    check('page hidden: the clock is stopped', p.writesBetween(3000, 23000) === 0, p.writesBetween(3000, 23000));
    p.cover({ clock: true }, true);
    p.setHidden(false);   // shown again, but a window is over the clock
    const at = p.clock.now;
    await p.advance(20000);
    check('page shown under a window: at most two paints (the fade), then parked', p.writesBetween(at - 1, p.clock.now) <= 2, p.writesBetween(at - 1, p.clock.now));
    p.cover({}, true);
    const t = p.nowText();
    check('page shown, then uncovered: the current second at once', p.text('clock-ss') === t.ss, p.text('clock-ss') + ' vs ' + t.ss);
    p.setHidden(true);
    p.cover({}, true);   // an uncover answer while the page is hidden must not start it
    const at2 = p.clock.now;
    await p.advance(10000);
    check('uncover while the page is hidden: still stopped', p.writesBetween(at2, p.clock.now) === 0, p.writesBetween(at2, p.clock.now));
  }

  // ---- 7. exactly one clock chain, whatever the order of events
  {
    const p = loadPage(SRC);
    p.cover({}, true);
    for (let i = 0; i < 20; i++) {
      p.cover(i % 2 ? {} : { clock: true }, true);
      if (i % 3 === 0) p.rest(i % 2 === 0);
      if (i % 5 === 0) { p.setHidden(true); p.setHidden(false); }
      await p.advance(137 + i * 53);
    }
    p.rest(false);
    p.cover({}, true);
    const at = p.clock.now;
    await p.advance(60000);
    const n = p.writesBetween(at, p.clock.now);
    check('after a storm of cover/rest/visibility changes: one chain (59-61 writes a minute, not double)', n >= 59 && n <= 61, n);
  }

  const total = passed + failures.length;
  if (failures.length) failures.forEach((f) => console.log('FAIL ' + f));
  console.log('CLOCK-COVER ' + passed + '/' + total + ' passed' + (AGAINST ? ' (against ' + AGAINST + ')' : '') + ', ' + failures.length + ' failed');
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.log('CLOCK-COVER threw: ' + (e && e.stack || e)); process.exit(1); });
