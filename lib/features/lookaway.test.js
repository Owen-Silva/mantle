// lookaway.test.js - the look-away blur: when it blurs, when it clears, and every pause that turns
// the camera off (lane lookaway, 2026-10-23).
//
//   node lib/features/lookaway.test.js
//
// Pure node, a few seconds: no Electron, no browser, no camera, no registry read.
//   Part 1  _lookaway-core.js driven with synthetic `now` (it is pure).
//   Part 2  lookaway.js with a FAKE `electron` in require.cache, a fake ctx, a fake screen-cover
//           provider on _unfold-bus.js, a stubbed _lookaway-camera.check and a FAKE CLOCK (Date.now,
//           setTimeout/setInterval and their clears are patched for part 2 and put back after).
// One summary line: LOOKAWAY TEST: <n> passed, <m> failed (exit 1 on any failure).
'use strict';
const path = require('path');
const Module = require('module');
const EventEmitter = require('events');

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { passed++; return; }
  failures.push(name);
  console.log('  FAIL ' + name + (detail !== undefined ? ' - ' + safe(detail) : ''));
}
function safe(x) { try { return JSON.stringify(x); } catch (_) { return String(x); } }
process.on('unhandledRejection', (e) => check('no unhandled rejection', false, String(e && e.stack || e)));

/* =============================== PART 1: the pure core =============================== */

const C = require('./_lookaway-core');
const { createLookaway, angleDiff, median, DEFAULTS } = C;

const NOFACE = { face: false };
const face = (yaw = 0, pitch = 0, size = 0.3) => ({ face: true, yaw, pitch, size });

/** see + tick every `step` ms over [t0, t1]; returns { first: t of the first want===want, wants } */
function run(c, t0, t1, obs, want = 'cover', step = 250, inputAt) {
  let first = null;
  const wants = [];
  for (let t = t0; t <= t1; t += step) {
    if (typeof inputAt === 'function') { const a = inputAt(t); if (a !== undefined) c.input(a); }
    c.see(typeof obs === 'function' ? obs(t) : obs, t);
    const d = c.tick(t);
    wants.push(d);
    if (d.want === want && first === null) first = t;
  }
  return { first, wants };
}
/** a calibrated core at t (frames looking at `yaw`/`pitch`), started at 0. */
function calibrated(opts, yaw = 0, pitch = 0, size = 0.3, n = 6) {
  const c = createLookaway(opts);
  c.start(0);
  for (let i = 0; i < n; i++) c.see(face(yaw, pitch, size), 1300 + i * 100);
  return c;
}

try {
  // ---- helpers ----
  check('angleDiff wraps: 179 vs -179 is 2 degrees apart', Math.abs(angleDiff(179, -179)) === 2 && angleDiff(-179, 179) === 2, [angleDiff(179, -179), angleDiff(-179, 179)]);
  check('angleDiff: 0 vs 180 is 180 (never -180)', angleDiff(0, 180) === 180 && angleDiff(180, 0) === 180, [angleDiff(0, 180), angleDiff(180, 0)]);
  check('angleDiff: 10 vs -350 is 0', angleDiff(10, -350) === 0);
  check('median odd / even / empty', median([3, 1, 2]) === 2 && median([4, 1, 2, 3]) === 2.5 && median([]) === null);
  check('defaults: delay 1.5 s, quiet 3 s, warm-up 1.2 s, stale 1.6 s', DEFAULTS.delayMs === 1500 && DEFAULTS.quietMs === 3000 && DEFAULTS.warmupMs === 1200 && DEFAULTS.staleMs === 1600);

  // ---- a glance shorter than the delay never covers; away held for the delay covers ----
  {
    const c = createLookaway(); c.start(0);
    const g = run(c, 2000, 3000, NOFACE);                 // away 1.0 s
    run(c, 3250, 3250, face());                           // looks back
    const after = run(c, 3500, 3600, face());
    check('a 1 s glance never covers', g.first === null && after.first === null, g.wants.map((d) => d.want));
    const a = run(c, 4000, 6000, NOFACE);
    check('away held for 1.5 s covers, not before', a.first === 5500, a.first);
    check('the cover says why (away for N ms, no face)', /away for 1500 ms \(no face\)/.test(a.wants[6].why), a.wants[6]);
  }

  // ---- keyboard/mouse input ----
  {
    const c = createLookaway(); c.start(0);
    c.input(3000);
    const r = run(c, 2500, 7000, NOFACE);
    check('no cover within 3 s of keyboard/mouse input', r.first === 6000, r.first);
    check('the reason while blocked by input says so', r.wants.some((d) => d.why === 'keyboard or mouse in use'), r.wants.map((d) => d.why));
  }
  {
    const c = createLookaway({ quietMs: 500 }); c.start(0);
    const r = run(c, 2000, 6000, NOFACE, 'cover', 250, (t) => (t === 3000 ? 3000 : undefined));
    check('input restarts the away clock (away from 2.0 s, input at 3.0 s: cover at 4.5 s)', r.first === 4500, r.first);
  }

  // ---- reveal ----
  {
    const c = createLookaway(); c.start(0);
    const a = run(c, 2000, 4000, NOFACE);
    c.coverChanged(true, true);
    const still = run(c, 4250, 5000, NOFACE, 'reveal');
    check('while covered, more away frames do not reveal', still.first === null);
    check('rate while covered is 5 a second', c.rate(5000) === 5, c.rate(5000));
    c.see(face(), 5100);
    const d = c.tick(5100);
    check('the first looking frame while covered says reveal at once', a.first !== null && d.want === 'reveal' && d.why === 'he looked back', d);
    c.coverChanged(false, true);
    check('our own reveal does not ask for a fresh look away', c.status().needFresh === false && c.status().covered === false);
  }

  // ---- warm-up and stale frames ----
  {
    const c = createLookaway(); c.start(1000);
    const v = c.see(NOFACE, 1500);
    check('a frame in the warm-up is ignored', v.verdict === 'ignored' && v.why === 'camera warming up' && c.status().last === null, v);
    check('tick in the warm-up says warming up', c.tick(1500).why === 'camera warming up', c.tick(1500));
    const r = run(c, 1500, 4500, NOFACE);
    check('warm-up frames do not start the away clock (first trusted 2.25 s, cover 3.75 s)', r.first === 3750, r.first);
  }
  {
    const c = createLookaway(); c.start(0);
    run(c, 2000, 3000, NOFACE);                           // last frame at 3.0 s, streak from 2.0 s
    check('a fresh frame after the delay covers', c.tick(4500).want === 'cover', c.tick(4500));
    const d = c.tick(4700);
    check('a stale frame (older than 1.6 s) decides nothing', d.want === null && d.why === 'no fresh frame', d);
    c.coverChanged(true, true);
    c.see(face(), 5000);
    check('a stale looking frame while covered does not reveal (only a fresh one)', c.tick(6700).want === null && c.tick(6500).want === 'reveal');
  }
  {
    const c = createLookaway();
    check('see before start is ignored', c.see(NOFACE, 5000).verdict === 'ignored');
    check('rate before start is 0', c.rate(5000) === 0);
  }

  // ---- the provider revealed on input: a fresh look away is needed ----
  {
    const c = createLookaway(); c.start(0);
    run(c, 2000, 4000, NOFACE);
    c.coverChanged(true, true);
    c.coverChanged(false, false);
    check('after an input reveal, needFresh is set', c.status().needFresh === true && c.status().covered === false);
    const r = run(c, 4250, 9000, NOFACE);
    check('no new cover while he stays away after an input reveal', r.first === null, r.wants.slice(-1));
    check('its reason says it waits for a look', /waiting for a look/.test(r.wants[r.wants.length - 1].why));
    run(c, 9250, 9250, face());
    check('a look clears needFresh', c.status().needFresh === false);
    const r2 = run(c, 9500, 12000, NOFACE);
    check('then a fresh away streak covers after the delay', r2.first === 11000, r2.first);
  }

  // ---- recalibration after an input reveal ----
  {
    const c = calibrated(); // usual yaw 0
    run(c, 2000, 4000, () => face(40));                   // turned: away
    check('a turned head is away once calibrated', c.status().last.why === 'head turned', c.status().last);
    c.coverChanged(true, true);
    c.coverChanged(false, false);                         // he pressed a key: the provider revealed
    const js = [];
    for (let i = 0; i < 5; i++) { const t = 4250 + i * 250; c.input(t); js.push(c.see(face(40), t)); }
    check('working in the new pose: frames 1-4 stay away', js.slice(0, 4).every((j) => j.verdict === 'away'), js.map((j) => j.verdict));
    check('the 5th steady frame while working relearns his usual pose', js[4].verdict === 'looking' && /learned again/.test(js[4].why), js[4]);
    check('the usual pose is now the new one', c.status().usual.yaw === 40 && c.status().needFresh === false, c.status().usual);
  }
  {
    const c = calibrated();
    c.coverChanged(true, true); c.coverChanged(false, false);
    for (let i = 0; i < 8; i++) c.see(face(40), 4250 + i * 250);   // no input: he is not working
    check('without input there is no relearning', c.status().usual.yaw === 0 && c.status().needFresh === true, c.status());
  }
  {
    const c = calibrated();
    for (let i = 0; i < 8; i++) { const t = 2000 + i * 250; c.input(t); c.see(face(40), t); }
    check('typing while turned (no input reveal) never relearns the pose', c.status().usual.yaw === 0, c.status().usual);
  }

  // ---- a face too small ----
  {
    const c = calibrated({}, 0, 0, 0.3);
    check('a face under half his usual size is away', c.see(face(0, 0, 0.1), 2000).why === 'a face too small to be him');
    check('a face of 2/3 his usual size is him', c.see(face(0, 0, 0.2), 2100).verdict === 'looking');
  }

  // ---- turn thresholds, relative to his usual pose ----
  {
    const c = createLookaway(); c.start(0);
    [8, 10, 12, 10, 10].forEach((y, i) => c.see(face(y), 1300 + i * 100));
    check('his usual pose is the median of looking frames (yaw 10)', c.status().usual.yaw === 10 && c.status().calibrated, c.status().usual);
    const v = (y, p = 0) => c.see(face(y, p), 3000).verdict;
    check('normal: 26 degrees from his pose is away', v(36) === 'away' && v(-16) === 'away', [v(36), v(-16)]);
    check('normal: 20 degrees is the between band', v(30) === 'between', v(30));
    check('normal: 18 degrees is looking', v(28) === 'looking', v(28));
    check('normal: pitch 21 is away (head tilted), 16 between, 15 looking', c.see(face(10, 21), 3000).why === 'head tilted' && v(10, 16) === 'between' && v(10, 15) === 'looking');
    c.set({ turn: 'small' });
    check('small: 19 degrees is away', v(29) === 'away', v(29));
    check('small: 14 is between, 13 looking', v(24) === 'between' && v(23) === 'looking', [v(24), v(23)]);
    c.set({ turn: 'never' });
    check('never: a 90 degree turn is looking', v(100) === 'looking' && v(10, 60) === 'looking');
    check('never: no face is still away', c.see(NOFACE, 3000).verdict === 'away');
    c.set({ turn: 'bogus' });
    { const c2 = calibrated({ turn: 'bogus' }); check('an unknown turn setting acts as normal', c2.see(face(26), 3000).verdict === 'away' && c2.see(face(18), 3000).verdict === 'looking'); }
  }
  {
    const c = calibrated({}, 30);   // he sits turned 30 degrees from the camera
    check('his own turned pose is looking (relative, not to the camera axis)', c.see(face(30), 2000).verdict === 'looking');
    check('facing the camera is then away (30 from his pose)', c.see(face(0), 2100).verdict === 'away');
  }
  {
    const c = calibrated({}, 179, 0, 0.3, 6);
    check('a pose near +-180 wraps: -179 is looking', c.see(face(-179), 2000).verdict === 'looking');
  }
  {
    const c = createLookaway(); c.start(0);
    [0, 0, 0].forEach((y, i) => c.see(face(y), 1300 + i * 100));
    const j = c.see(face(80), 1700);
    check('before minKeep (4) looking frames a turn does not count', j.verdict === 'looking' && /not calibrated/.test(j.why), j);
    check('before calibration no face is still away', c.see(NOFACE, 1800).verdict === 'away');
    c.see(face(0), 1900);
    check('after minKeep a turn counts', c.see(face(80), 2000).verdict === 'away');
  }

  // ---- the between band (hysteresis) ----
  {
    const c = calibrated();
    run(c, 2000, 2000, face(40));                         // away streak starts at 2.0 s
    const b = run(c, 2250, 3000, face(20));               // between (20 > 18.75)
    check('between frames neither start nor end a streak (awaySince kept)', c.status().awaySince === 2000 && b.first === null, c.status().awaySince);
    check('between frames do not cover', b.wants.every((d) => d.want === null));
    c.see(face(40), 3500);
    check('an away frame after the band covers on the original clock', c.tick(3500).want === 'cover', c.tick(3500));
    c.coverChanged(true, true);
    c.see(face(20), 3750);
    check('between while covered does not reveal', c.tick(3750).want === null);
    c.see(face(5), 4000);
    check('looking while covered reveals', c.tick(4000).want === 'reveal');
    c.coverChanged(false, true);
    run(c, 4250, 6000, face(20));
    check('between alone never starts a streak', c.status().awaySince === null);
  }

  // ---- pause and rate ----
  {
    const c = createLookaway(); c.start(0);
    check('rate watching, idle: 3', c.rate(2000) === 3);
    c.see(NOFACE, 2000);
    check('rate during an away streak: 4', c.rate(2000) === 4);
    c.input(2100);
    check('rate while he types: 1', c.rate(2200) === 1);
    run(c, 5200, 7000, NOFACE);
    c.coverChanged(true, true);
    check('rate while covered: 5 (even right after input)', (c.input(7100), c.rate(7100)) === 5);
    c.pause('screen locked', 7200);
    const d = c.tick(7200);
    check('pause() while covered says reveal with the reason', d.want === 'reveal' && d.why === 'paused: screen locked', d);
    check('rate while paused: 0', c.rate(7200) === 0);
    check('a frame while paused is ignored', c.see(face(), 7300).verdict === 'ignored');
    c.coverChanged(false, true);
    check('paused and not covered: nothing to do, with the reason', c.tick(7400).want === null && c.tick(7400).why === 'paused: screen locked');
    c.start(8000);
    check('start after a pause warms up again', c.see(NOFACE, 8500).verdict === 'ignored' && c.status().paused === '');
  }
} catch (e) {
  check('part 1: no unexpected exception', false, e && e.stack);
}

/* =============================== PART 2: lookaway.js =============================== */

const bus = require('./_unfold-bus');
const camera = require('./_lookaway-camera');
const SECRET_TITLE = 'Bank statement 2026 - Private.pdf';
const SECRET_EXE = 'D:\\Tools\\SecretVault\\SecretVault.exe';
const NONE = bus.state().reason;

// ---- the fake clock ----
const REAL = { now: Date.now, setTimeout: global.setTimeout, clearTimeout: global.clearTimeout, setInterval: global.setInterval, clearInterval: global.clearInterval, setImmediate: global.setImmediate };
const clock = { t: 1800000000000, seq: 0, timers: new Map() };
function clockOn() {
  Date.now = () => clock.t;
  global.setTimeout = (fn, ms, ...a) => { const id = ++clock.seq; clock.timers.set(id, { at: clock.t + Math.max(0, Number(ms) || 0), fn, a, every: 0 }); return id; };
  global.setInterval = (fn, ms, ...a) => { const id = ++clock.seq; const every = Math.max(1, Number(ms) || 0); clock.timers.set(id, { at: clock.t + every, fn, a, every }); return id; };
  global.clearTimeout = global.clearInterval = (id) => { if (id !== null && id !== undefined) clock.timers.delete(id); };
}
function clockOff() { Object.assign(global, { setTimeout: REAL.setTimeout, clearTimeout: REAL.clearTimeout, setInterval: REAL.setInterval, clearInterval: REAL.clearInterval }); Date.now = REAL.now; }
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => REAL.setImmediate(r)); };
async function advance(ms) {
  const end = clock.t + ms;
  for (;;) {
    let next = null, nid = 0;
    for (const [id, tm] of clock.timers) if (tm.at <= end && (!next || tm.at < next.at || (tm.at === next.at && id < nid))) { next = tm; nid = id; }
    if (!next) break;
    clock.t = next.at;
    if (next.every) next.at += next.every; else clock.timers.delete(nid);
    next.fn(...next.a);
    await flush();
  }
  clock.t = end;
  await flush();
}
const intervals = () => [...clock.timers.values()].filter((t) => t.every).length;

// ---- the fake electron ----
const E = {};   // filled per harness; lookaway.js destructures it at install()
let ELECTRON_ID;
try { ELECTRON_ID = require.resolve('electron'); } catch (_) { ELECTRON_ID = path.join(__dirname, '__fake_electron__.js'); }
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...a) { return req === 'electron' ? ELECTRON_ID : origResolve.call(this, req, ...a); };
const fakeMod = new Module(ELECTRON_ID); fakeMod.filename = ELECTRON_ID; fakeMod.loaded = true; fakeMod.exports = E;
require.cache[ELECTRON_ID] = fakeMod;

// ---- the camera read: stubbed (never the real registry) ----
const camAnswer = { v: { ok: true, others: 0, self: false } };
camera.check = () => Object.assign({}, camAnswer.v);

const lookaway = require('./lookaway');
const ALL = { logs: [], health: [] };   // every harness's lines, for the privacy check

function harness(o = {}) {
  const opt = Object.assign({ on: true, provider: true, fakeSwitch: true, settings: {}, test: true }, o);
  const h = { logs: [], health: [], pushes: [], cmds: {}, wins: [], ses: {}, sidecarCalls: [], enabledFns: [], optionFns: [], on: opt.on, prov: null, unprovide: null };
  let wcSeq = 100;
  class Emitter extends EventEmitter {}
  E.BrowserWindow = class {
    constructor(opts) {
      this.opts = opts; this.destroyed = false; this.ev = new Emitter();
      const wc = new Emitter(); wc.id = ++wcSeq; wc.getOSProcessId = () => 5000 + wc.id;
      wc.setWindowOpenHandler = (fn) => { wc.openHandler = fn; };
      this.webContents = wc;
      h.wins.push(this);
    }
    on(ev, fn) { this.ev.on(ev, fn); return this; }
    loadFile(p) { this.loaded = p; return Promise.resolve(); }
    isDestroyed() { return this.destroyed; }
    destroy() { if (this.destroyed) return; this.destroyed = true; this.destroyedAt = clock.t; this.ev.emit('closed'); }
  };
  E.session = {
    fromPartition(name) {
      h.partition = name;
      return {
        webRequest: { onBeforeRequest: (filter, fn) => { h.ses.filter = filter; h.ses.onBeforeRequest = fn; } },
        setPermissionRequestHandler: (fn) => { h.ses.request = fn; },
        setPermissionCheckHandler: (fn) => { h.ses.check = fn; },
      };
    },
  };
  const pm = new EventEmitter(); pm.getSystemIdleTime = () => 600; h.pm = pm; E.powerMonitor = pm;
  h.switches = new Set(opt.fakeSwitch ? ['use-fake-device-for-media-stream'] : []);
  E.app = { commandLine: { hasSwitch: (s) => h.switches.has(s) }, getAppMetrics: () => [{ pid: 5101, type: 'Renderer', cpu: { cumulativeCPUUsage: 1 }, memory: { workingSetSize: 20480 } }] };

  h.ctx = {
    name: 'lookaway', flags: Object.freeze({ test: opt.test, live: !opt.test }),
    settings: { get: (k, d) => (k in opt.settings ? opt.settings[k] : d), set() {} },
    enabled: () => h.on,
    health: (ok, reason) => { const r = { ok, reason, t: clock.t }; h.health.push(r); ALL.health.push(r); },
    log: (text) => { h.logs.push(String(text)); ALL.logs.push(String(text)); },
    command: (verb, fn) => { if (h.cmds[verb]) throw new Error('duplicate ' + verb); h.cmds[verb] = fn; return 'lookaway.' + verb; },
    push: (win, event, payload) => { if (!win || win.isDestroyed()) return false; h.pushes.push({ win, event, payload, t: clock.t }); return true; },
    page: (f = 'index.html') => path.join(__dirname, '..', '..', 'ui', 'lookaway', f),
    preload: path.join(__dirname, '..', '..', 'preload.js'),
    sidecar: {
      ready: true,
      send: async (cmd, args) => {
        h.sidecarCalls.push(cmd);
        if (cmd === 'foreground') return { ok: true, result: { hwnd: 1234, title: SECRET_TITLE, exe: SECRET_EXE, pid: 4242, fullscreen: false } };
        return { ok: false, error: 'unknown command ' + cmd };
      },
      on: () => () => {}, onReady: () => () => {},
    },
    onEnabled: (fn) => { h.enabledFns.push(fn); return () => {}; },
    onOption: (key, fn) => { h.optionFns.push({ key, fn }); return () => {}; },
  };
  h.provide = () => {
    const p = {
      covered: false, by: null, calls: [],
      async cover(a) { p.calls.push(['cover', a && a.from]); p.covered = true; p.by = a && a.from; bus.changed(); return { ok: true }; },
      async reveal(a) { p.calls.push(['reveal', a && a.from]); p.covered = false; p.by = null; bus.changed(); return { ok: true }; },
      state() { return { covered: p.covered, by: p.by }; },
      selfReveal() { p.covered = false; p.by = null; bus.changed(); },   // any key or mouse input
    };
    h.prov = p; h.unprovide = bus.provide(p);
    return p;
  };
  if (opt.provider) h.provide();
  h.install = () => { h.feature = lookaway.install(h.ctx); return h; };
  h.call = async (verb, args) => { const r = await h.cmds[verb](args); await flush(); return r; };
  h.page = (state, extra) => h.call('page', Object.assign({ state }, extra || {}));
  h.seen = (obs) => h.call('seen', obs);
  h.setOn = async (on) => { h.on = on; for (const fn of h.enabledFns) fn(on); await flush(); };
  h.win = () => h.wins[h.wins.length - 1];
  h.ctl = (op) => h.pushes.filter((p) => p.event === 'lookaway.ctl' && (!op || p.payload.op === op)).map((p) => p.payload);
  h.lastHealth = () => h.health[h.health.length - 1];
  h.covers = () => (h.prov ? h.prov.calls.filter((c) => c[0] === 'cover').length : 0);
  h.reveals = () => (h.prov ? h.prov.calls.filter((c) => c[0] === 'reveal').length : 0);
  h.status = () => h.call('status');
  h.done = async () => { try { if (h.feature && !h.stopped) { h.stopped = true; h.feature.stop('test done'); } } catch (_) { /* reported by the caller */ } if (h.unprovide) h.unprovide(); await flush(); clock.timers.clear(); };
  return h;
}

/** install, page loaded + watching, past the warm-up. */
async function watching(o) {
  const h = harness(o).install();
  await h.page('loaded');
  await h.page('watching', { width: 320, height: 240, fps: 30 });
  await advance(1300);
  return h;
}
/** no-face frames every 250 ms until the bus is asked to cover (max 4 s). */
async function untilCovered(h) {
  for (let i = 0; i < 16 && h.covers() === 0; i++) { await h.seen({ face: false }); if (h.covers()) break; await advance(250); }
  return h.covers() > 0;
}

async function part2() {
  // ---- switch off at install ----
  {
    const h = harness({ on: false }).install();
    check('switch off: no window', h.wins.length === 0);
    check('switch off: health untouched or ok', h.health.every((r) => r.ok === true), h.health);
    check('switch off: nothing ticks (no interval)', intervals() === 0, intervals());
    check('switch off: no camera command sent', h.ctl().length === 0);
    await h.setOn(true);
    check('switching on creates the hidden window', h.wins.length === 1);
    await h.done();
  }

  // ---- on: the window, its session, the start message, watching ----
  {
    const h = harness().install();
    const w = h.win();
    check('on: one hidden window is created', h.wins.length === 1 && w.opts.show === false && w.opts.focusable === false && w.opts.skipTaskbar === true, w && w.opts);
    const wp = w.opts.webPreferences;
    check('the window is sandboxed, isolated, no node, in the lookaway partition', wp.sandbox === true && wp.contextIsolation === true && wp.nodeIntegration === false && wp.partition === 'lookaway');
    check('the partition is in memory (no persist:)', h.partition === 'lookaway' && !/^persist:/.test(wp.partition));
    check('it loads ui/lookaway/index.html', /ui[\\/]lookaway[\\/]index\.html$/.test(w.loaded || ''), w.loaded);
    check('new windows are denied', w.webContents.openHandler && w.webContents.openHandler({ url: 'https://x.example' }).action === 'deny');
    let prevented = false;
    w.webContents.emit('will-navigate', { preventDefault: () => { prevented = true; } }, 'https://x.example');
    check('navigation is prevented', prevented);
    check('health while starting: ok, "Starting the camera"', h.lastHealth().ok === true && /^Starting the camera/.test(h.lastHealth().reason), h.lastHealth());
    check('the 1 s governor runs while on', intervals() === 1, intervals());

    // the session's handlers
    const wc = w.webContents, other = { id: 999 };
    const req = (wcx, perm, details) => { let got = null; h.ses.request(wcx, perm, (v) => { got = v; }, details); return got; };
    check('permission: video for this window is granted', req(wc, 'media', { mediaTypes: ['video'] }) === true);
    check('permission: audio is refused', req(wc, 'media', { mediaTypes: ['audio'] }) === false && req(wc, 'media', { mediaTypes: ['video', 'audio'] }) === false);
    check('permission: no media type is refused', req(wc, 'media', { mediaTypes: [] }) === false && req(wc, 'media', {}) === false);
    check('permission: another webContents is refused', req(other, 'media', { mediaTypes: ['video'] }) === false);
    check('permission: anything but media is refused', req(wc, 'geolocation', {}) === false && req(wc, 'notifications', {}) === false);
    check('permission check: video for this window only', h.ses.check(wc, 'media', 'file://', { mediaType: 'video' }) === true
      && h.ses.check(wc, 'media', 'file://', { mediaType: 'audio' }) === false
      && h.ses.check(other, 'media', 'file://', { mediaType: 'video' }) === false
      && h.ses.check(wc, 'clipboard-read', 'file://', {}) === false);
    const urls = (h.ses.filter && h.ses.filter.urls) || [];
    check('every http/https/ws/wss request is filtered', ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'].every((u) => urls.includes(u)), urls);
    const cancels = ['http://a.example/x', 'https://cdn.example/m.wasm', 'ws://b.example', 'wss://c.example'].map((url) => { let r = null; h.ses.onBeforeRequest({ url }, (v) => { r = v; }); return r && r.cancel === true; });
    check('every web request is cancelled', cancels.every(Boolean), cancels);

    await h.page('loaded');
    const st = h.ctl('start');
    check("'loaded' sends op start with width/height/hz", st.length === 1 && st[0].width === 320 && st[0].height === 240 && st[0].hz > 0, st);
    await h.page('ready');
    await h.page('watching', { width: 320, height: 240, fps: 30 });
    check("'watching': health ok with the watching words", h.lastHealth().ok === true && /^Watching\. The camera light is on/.test(h.lastHealth().reason), h.lastHealth());
    const s = await h.status();
    check('status: watching, page watching, not covered', s.watching === true && s.page === 'watching' && s.core.covered === false, s);
    await h.done();
  }

  // ---- frames: away -> cover, face -> reveal; rates ----
  {
    const h = await watching();
    const t0 = clock.t;
    let coveredAt = null;
    for (let i = 0; i < 16; i++) { await h.seen({ face: false }); if (h.covers() && coveredAt === null) { coveredAt = clock.t; break; } await advance(250); }
    check('no face for the delay -> the bus is asked to cover (1.5 s, not before)', coveredAt !== null && coveredAt - t0 >= 1500 && coveredAt - t0 <= 1750, coveredAt && coveredAt - t0);
    check('the cover is asked from lookaway', h.prov.calls[0] && h.prov.calls[0][1] === 'lookaway', h.prov.calls);
    check('the cover is logged with its reason', h.logs.some((l) => /^cover: away for \d+ ms \(no face\)$/.test(l)), h.logs.filter((l) => /cover/.test(l)));
    const rates = h.ctl('rate').map((r) => r.hz);
    check('frame rate rises during a streak (4) and while covered (5)', rates.includes(4) && rates.includes(5), rates);
    await advance(250);
    await h.seen({ face: true, yaw: 0, pitch: 0, size: 0.3 });
    check('a face -> the bus is asked to reveal', h.reveals() === 1, h.prov.calls);
    check('after the reveal, not covered', (await h.status()).core.covered === false && h.prov.covered === false);
    check('frames with bad numbers are tolerated', (await h.seen({ face: true, yaw: 'x', pitch: NaN, size: null })).ok === true);
    await h.done();
  }

  // ---- the provider reveals on its own (input) ----
  {
    const h = await watching();
    await untilCovered(h);
    h.prov.selfReveal();
    await flush();
    check('a reveal by input is logged (no names)', h.logs.some((l) => /taken down by input/.test(l)));
    for (let i = 0; i < 16; i++) { await advance(250); await h.seen({ face: false }); }
    check('after an input reveal, no new cover while still away', h.covers() === 1, h.prov.calls);
    check('and lookaway did not ask a reveal of its own', h.reveals() === 0);
    await advance(250); await h.seen({ face: true, yaw: 0, pitch: 0, size: 0.3 });
    const before = clock.t;
    let again = null;
    for (let i = 0; i < 12; i++) { await advance(250); await h.seen({ face: false }); if (h.covers() === 2) { again = clock.t; break; } }
    check('a look, then a fresh away streak covers again', again !== null && again - before >= 1500, again && again - before);
    await h.done();
  }

  // ---- the delay option ----
  {
    const h = await watching();
    for (const o of h.optionFns) if (o.key === '*') o.fn(5, 'delay');
    for (let i = 0; i < 12; i++) { await h.seen({ face: false }); await advance(250); }
    check('delay option 5 s: no cover after 3 s away', h.covers() === 0);
    for (let i = 0; i < 10 && !h.covers(); i++) { await h.seen({ face: false }); await advance(250); }
    check('delay option 5 s: covers by 5.5 s', h.covers() === 1);
    await h.done();
  }

  // ---- every pause: stop with its reason, core paused, reveal if covered ----
  const W = {
    locked: 'Paused while the screen is locked. The camera is off',
    asleep: 'Paused while the PC sleeps. The camera is off',
    otherCam: 'Paused while another app uses the camera. The camera is off',
    fullscreen: 'Paused while a full-screen app is in front. The camera is off',
  };
  const PAUSES = [
    { name: 'lock (testLock)', words: W.locked, enter: (h) => h.call('testLock', { on: true }), leave: (h) => h.call('testLock', { on: false }), governorStops: true },
    { name: "lock ('lock-screen' event)", words: W.locked, enter: async (h) => { h.pm.emit('lock-screen'); await flush(); }, leave: async (h) => { h.pm.emit('unlock-screen'); await flush(); }, governorStops: true },
    { name: "sleep ('suspend')", words: W.asleep, enter: async (h) => { h.pm.emit('suspend'); await flush(); }, leave: async (h) => { h.pm.emit('resume'); await flush(); }, governorStops: true },
    { name: 'another app uses the camera (testOtherApp)', words: W.otherCam, enter: (h) => h.call('testOtherApp', { on: true }), leave: (h) => h.call('testOtherApp', { on: false }) },
    { name: 'a full-screen app (testFullscreen)', words: W.fullscreen, enter: (h) => h.call('testFullscreen', { on: true }), leave: (h) => h.call('testFullscreen', { on: false }) },
  ];
  for (const P of PAUSES) {
    const h = await watching();
    const ok = await untilCovered(h);
    const stops0 = h.ctl('stop').length;
    await P.enter(h);
    const stops = h.ctl('stop');
    check(`${P.name}: covered first`, ok);
    check(`${P.name}: op stop sent with its reason`, stops.length === stops0 + 1 && stops[stops.length - 1].why === P.words, stops);
    const s = await h.status();
    check(`${P.name}: the core is paused with the reason`, s.core.paused === P.words && s.watching === false, s.core);
    check(`${P.name}: the cover is revealed`, h.reveals() === 1 && h.prov.covered === false, h.prov.calls);
    check(`${P.name}: health ok with the words`, h.lastHealth().ok === true && h.lastHealth().reason === P.words, h.lastHealth());
    if (P.governorStops) check(`${P.name}: the 1 s governor stops`, intervals() === 0, intervals());
    await h.page('stopped', { released: true });
    check(`${P.name}: a stopped page is not restarted while paused`, h.ctl('start').length === 1);
    const w = h.win();
    await advance(19000);
    check(`${P.name}: the parked page stays for 19 s`, !w.destroyed);
    await advance(1500);
    check(`${P.name}: a paused page is destroyed after PARK_MS (20 s)`, w.destroyed === true);
    await P.leave(h);
    check(`${P.name}: after the pause a new window starts`, h.wins.length === 2 && !h.win().destroyed, h.wins.length);
    check(`${P.name}: health back to starting`, h.lastHealth().ok === true && /^Starting the camera/.test(h.lastHealth().reason), h.lastHealth());
    await h.page('loaded');
    check(`${P.name}: the new page gets op start`, h.ctl('start').length === 2);
    await h.done();
  }
  {   // a pause that ends inside PARK_MS restarts the same page (no new window)
    const h = await watching();
    await h.call('testLock', { on: true });
    await h.page('stopped', { released: true });
    await advance(5000);
    await h.call('testLock', { on: false });
    check('a short lock restarts the same page (no new window)', h.wins.length === 1 && h.ctl('start').length === 2, [h.wins.length, h.ctl('start').length]);
    await advance(30000);
    check('and the park timer was cleared', !h.win().destroyed);
    await h.done();
  }
  {   // a pause while starting (before watching)
    const h = harness().install();
    await h.page('loaded');
    await h.call('testLock', { on: true });
    check("a lock while starting stops the camera", h.ctl('stop').length === 1 && h.ctl('stop')[0].why === W.locked);
    const r = await h.page('watching', { width: 320, height: 240, fps: 30 });
    check("'watching' arriving while paused is stopped again", r.ok === true && h.ctl('stop').length === 2 && (await h.status()).watching === false, h.ctl('stop'));
    await h.done();
  }

  // ---- a failed page: retry 10 s / 30 s / 120 s ----
  {
    const h = await watching();
    await untilCovered(h);
    await h.page('failed', { reason: 'the camera would not start (test)' });
    const hl = h.lastHealth();
    check('failed: op stop sent', h.ctl('stop').length === 1, h.ctl('stop'));
    check('failed: the core is paused with the reason', (await h.status()).core.paused.startsWith('the camera would not start (test)'));
    check('failed: the cover is revealed', h.reveals() === 1 && h.prov.covered === false);
    check('failed: health false, "Trying again in 10 s"', hl.ok === false && hl.reason === 'the camera would not start (test). Trying again in 10 s', hl);
    check('failed: logged with the wait', h.logs.some((l) => l === 'camera stopped: the camera would not start (test); trying again in 10 s'));
    await h.page('stopped', { released: true });
    check('failed: no restart before the wait', h.ctl('start').length === 1);
    await advance(8500);
    check('failed: still waiting at 8.5 s', h.ctl('start').length === 1);
    await advance(2000);
    check('failed: tries again after 10 s', h.ctl('start').length === 2 && h.lastHealth().ok === true, h.lastHealth());
    await h.page('failed', { reason: 'again' });
    check('second failure in a row: "Trying again in 30 s"', h.lastHealth().reason === 'again. Trying again in 30 s', h.lastHealth());
    await h.page('stopped', { released: true });
    await advance(21000);
    check('a 30 s wait parks (destroys) the page at 20 s', h.wins[0].destroyed === true);
    await advance(10000);
    check('after 30 s a new window is created', h.wins.length === 2 && !h.win().destroyed, h.wins.length);
    await h.page('loaded');
    await h.page('failed', { reason: 'third' });
    check('third failure: "Trying again in 120 s"', h.lastHealth().reason === 'third. Trying again in 120 s', h.lastHealth());
    await h.page('stopped');
    await advance(121000);
    await h.page('loaded');
    await h.page('failed', { reason: 'fourth' });
    check('fourth failure stays at 120 s', h.lastHealth().reason === 'fourth. Trying again in 120 s', h.lastHealth());
    await h.page('stopped');
    await advance(121000);
    await h.page('loaded');
    await h.page('watching', { width: 320, height: 240, fps: 30 });
    check('watching again: health ok', h.lastHealth().ok === true && /^Watching/.test(h.lastHealth().reason));
    await h.page('failed', { reason: 'fifth' });
    check('after watching, the backoff starts again at 10 s', h.lastHealth().reason === 'fifth. Trying again in 10 s', h.lastHealth());
    await h.done();
  }
  {   // the renderer died: destroyed at once, retried
    const h = await watching();
    const w = h.win();
    w.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    await flush();
    check('page gone: the window is destroyed at once', w.destroyed === true);
    check('page gone: health false with the reason and the wait', h.lastHealth().ok === false && h.lastHealth().reason === 'the look-away page stopped (crashed). Trying again in 10 s', h.lastHealth());
    await advance(11000);
    check('page gone: a new window after 10 s', h.wins.length === 2, { wins: h.wins.length, timers: clock.timers.size, iv: intervals(), health: h.health.slice(-2), logs: h.logs.slice(-4) });
    await h.done();
  }

  // ---- the switch off: window destroyed at once ----
  {
    const h = await watching();
    await untilCovered(h);
    const w = h.win();
    await h.setOn(false);
    const stops = h.ctl('stop');
    check('switch off: op stop sent with why off', stops.length === 1 && stops[0].why === 'off', stops);
    check('switch off: the cover is revealed', h.reveals() === 1 && h.prov.covered === false);
    check('switch off: the window is destroyed at once', w.destroyed === true);
    check('switch off: the core is paused', (await h.status()).core.paused === 'off');
    check('switch off: health ok (no reason)', h.lastHealth().ok === true && !h.lastHealth().reason, h.lastHealth());
    check('switch off: nothing ticks', intervals() === 0 && clock.timers.size === 0, [...clock.timers.values()].map((t) => t.every));
    await h.done();
  }

  // ---- stop() ----
  {
    const h = await watching();
    await untilCovered(h);
    const w = h.win();
    const nHealth = h.health.length;
    h.stopped = true;
    h.feature.stop('quit');
    await flush();
    check('stop(): reveals if covered', h.reveals() === 1 && h.prov.covered === false, h.prov.calls);
    check('stop(): op stop sent with its reason', h.ctl('stop').some((m) => m.why === 'quit'), h.ctl('stop'));
    check('stop(): the window is destroyed', w.destroyed === true);
    check('stop(): no timer is left', clock.timers.size === 0, clock.timers.size);
    check('stop(): powerMonitor listeners removed', ['lock-screen', 'unlock-screen', 'suspend', 'resume'].every((e) => h.pm.listenerCount(e) === 0));
    const nLogs = h.logs.length, nPush = h.pushes.length, nCalls = h.prov.calls.length;
    const p = await h.page('loaded');
    const sn = await h.seen({ face: false });
    h.pm.emit('lock-screen'); h.pm.emit('unlock-screen');
    h.prov.cover({ from: 'someone' }); await flush(); h.prov.selfReveal();
    // (onEnabled is not called here: Mantle drops a stopped feature's handlers, README "stop()")
    await advance(5000);
    check('after stop(): page and seen answer nothing', p.ok === false && sn.ok === false, [p, sn]);
    check('after stop(): no window, push, cover or health', h.wins.length === 1 && h.pushes.length === nPush && h.prov.calls.length === nCalls + 1 && h.health.length === nHealth, [h.wins.length, h.pushes.length - nPush, h.prov.calls.length - nCalls, h.health.length - nHealth]);
    check('after stop(): the bus listener is gone (no log on a cover change)', h.logs.slice(nLogs).every((l) => !/taken down/.test(l)), h.logs.slice(nLogs));
    await h.done();
  }

  // ---- the screen cover is not running ----
  {
    const h = harness({ provider: false }).install();
    check('no cover provider at install: health false with the bus reason', h.lastHealth().ok === false && h.lastHealth().reason === NONE, h.lastHealth());
    check('no cover provider at install: no window, nothing ticks', h.wins.length === 0 && intervals() === 0);
    h.provide();
    await flush();
    check('the provider arrives: the window is created, health ok', h.wins.length === 1 && h.lastHealth().ok === true, h.lastHealth());
    await h.page('loaded'); await h.page('watching', { width: 320, height: 240, fps: 30 }); await advance(1300);
    await untilCovered(h);
    const prov = h.prov;
    h.unprovide(); h.unprovide = null;
    await flush();
    check('the provider leaves: health false with the bus reason', h.lastHealth().ok === false && h.lastHealth().reason === NONE, h.lastHealth());
    check('the provider leaves: op stop sent with the reason', h.ctl('stop').some((m) => m.why === NONE), h.ctl('stop'));
    check('the provider leaves: the core is paused', (await h.status()).core.paused === NONE);
    check('the provider leaves: a reveal was asked (it answers no provider)', h.logs.some((l) => l === 'reveal: ' + NONE), h.logs.filter((l) => /^reveal/.test(l)));
    check('the provider leaves: nothing ticks', intervals() === 0);
    await h.page('stopped');
    await advance(20500);
    check('the provider leaves: the page is parked then destroyed', h.wins[0].destroyed === true);
    void prov;
    await h.done();
  }

  // ---- --test without the fake device ----
  {
    const h = harness({ fakeSwitch: false }).install();
    check('--test without the fake device: health false with the reason', h.lastHealth().ok === false && /fake device/.test(h.lastHealth().reason), h.lastHealth());
    check('--test without the fake device: no window, nothing ticks', h.wins.length === 0 && intervals() === 0);
    await h.done();
  }

  // ---- privacy: the foreground answer names a window and an exe ----
  {
    const h = await watching();
    for (let i = 0; i < 8; i++) { await h.seen({ face: false }); await advance(500); }
    await h.call('testFullscreen', { on: true });
    await h.call('testFullscreen', { on: false });
    camAnswer.v = { ok: false, others: 0, self: false, reason: 'the registry said no' };
    await advance(4000);
    camAnswer.v = { ok: true, others: 0, self: false };
    const s = await h.status();
    check('privacy: the sidecar foreground read actually ran', h.sidecarCalls.filter((c) => c === 'foreground').length >= 3, h.sidecarCalls);
    check('privacy: a camera read failure is said on the state line', h.health.some((r) => /cannot tell when another app uses the camera: the registry said no/.test(r.reason || '')), h.health.slice(-3));
    const hits = (txt) => [SECRET_TITLE, SECRET_EXE, 'SecretVault', 'Bank statement'].some((x) => String(txt).includes(x));
    check('privacy: the status answer has no title or exe', !hits(safe(s)));
    await h.done();
  }
  const leaks = ALL.logs.filter((l) => /Bank statement|SecretVault/.test(l)).concat(ALL.health.filter((r) => /Bank statement|SecretVault/.test(r.reason || '')).map(safe));
  check(`privacy: no log line (${ALL.logs.length}) and no health text (${ALL.health.length}) ever has the window title or exe`, leaks.length === 0 && ALL.logs.length > 50, leaks);
}

(async () => {
  clockOn();
  try { await part2(); } catch (e) { check('part 2: no unexpected exception', false, e && e.stack); }
  finally { clockOff(); Module._resolveFilename = origResolve; delete require.cache[ELECTRON_ID]; }
  check('the clock is put back', Date.now === REAL.now && global.setTimeout === REAL.setTimeout && global.setInterval === REAL.setInterval);
  console.log(`LOOKAWAY TEST: ${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();
