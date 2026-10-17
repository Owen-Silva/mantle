'use strict';
/*
 * clips-follow.test.js - the Win+G Record panel GLIDES WITH THE BAR (lane corner-follow, 2026-10-17).
 * Pure node: the real lib/features/clips.js installed against a stub Electron and a stub host, with Owen's
 * numbers (work area {0,0,1536,864} DIP, the pill's resting shape {208,802,1120,62}):
 *   placement low with the bar hidden (no room reserved), the reach, the card above the pill with it up,
 *   the shape spanning the glide then narrowing, popwatch's "inside" = the card where it is NOW (the reach
 *   band is outside), lib/corner.js registration ({lift}) and its removal, the 'size' command, catchUp when
 *   the panel comes up while the bar is going, the flat fallback (shape refused / not read back), a dock or
 *   top-edge bar (reach 0), nothing on screen = no glide, and the --test hold.
 *   node lib/features/clips-follow.test.js   -> "CLIPS FOLLOW TEST: n passed, m failed"
 */
const Module = require('module');
const path = require('path');
const os = require('os');

let passed = 0; const failures = [];
function check(name, ok, detail) { if (ok) passed++; else failures.push(`${name}${detail !== undefined ? ` (${JSON.stringify(detail).slice(0, 400)})` : ''}`); return ok; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- a stub Electron: just enough BrowserWindow for the panel */
const wins = [];
class FakeWin {
  constructor(o) { this.b = { x: o.x, y: o.y, width: o.width, height: o.height }; this.shapes = []; this.visible = false; this.dead = false; this.ev = {}; this.wev = {}; wins.push(this);
    const self = this;
    this.webContents = { on(n, f) { (self.wev[n] = self.wev[n] || []).push(f); }, setWindowOpenHandler() {}, getOSProcessId: () => 1, getURL: () => 'file:///ui/clips/record.html' };
  }
  setAlwaysOnTop() {} setContentProtection() {}
  loadFile() { setImmediate(() => (this.wev['did-finish-load'] || []).forEach((f) => f())); }
  on(n, f) { (this.ev[n] = this.ev[n] || []).push(f); }
  setBounds(b) { this.b = Object.assign({}, b); }
  getBounds() { return Object.assign({}, this.b); }
  setShape(r) { this.shapes.push(r.length ? Object.assign({}, r[0]) : null); }
  showInactive() { this.visible = true; } hide() { this.visible = false; } isVisible() { return this.visible; }
  isDestroyed() { return this.dead; } destroy() { this.dead = true; (this.ev.closed || []).forEach((f) => f()); }
  getNativeWindowHandle() { return Buffer.alloc(8); }
}
const electron = { BrowserWindow: FakeWin, app: { getPath: () => os.tmpdir(), on() {}, removeListener() {}, getAppMetrics: () => [] }, shell: { openExternal: () => Promise.resolve(), openPath: () => Promise.resolve('') }, screen: {} };
const load0 = Module._load;
Module._load = function (req, parent, isMain) { return req === 'electron' ? electron : load0.call(this, req, parent, isMain); };

const barShape = require('../bar-shape');
let verifyOk = true, applyOk = true;
barShape.verify = (hwnd, rect) => (verifyOk ? { ok: true, reason: null, box: rect } : { ok: false, reason: 'the stub said no' });
const apply0 = barShape.apply;
barShape.apply = (w, r) => (applyOk || !r ? apply0(w, r) : { ok: false, reason: 'the stub refused the shape' });
const corner = require('../corner');
const popwatch = require('../popwatch');
const BF = require('../bar-follow');
const C = require('./_clips-core');
const clips = require('./clips');

const WORK = { x: 0, y: 0, width: 1536, height: 864 };
const PILL = { x: 208, y: 802, width: 1120, height: 62 };

function install(o) {
  o = o || {};
  wins.length = 0;
  const cmds = {}, pushes = [], logs = [], motion = [];
  const bar = { isUp: !!o.up, up() { return this.isUp; }, onMotion(fn) { motion.push(fn); return () => {}; } };
  const ctx = {
    flags: { test: true }, settings: { get: (k, d) => d }, preload: 'x', page: (p) => p,
    command: (n, f) => { cmds[n] = f; }, hasCommand: () => false, health() {}, log: (l) => logs.push(l), keysAway() {},
    onChord() {}, onRest() {}, onOption() {},
    push: (w, name, p) => { pushes.push({ w, name, p: JSON.parse(JSON.stringify(p)) }); return true; },
    sidecar: { onReady() {}, on() { return () => {}; }, send: (cmd) => Promise.resolve(cmd === 'record.target' ? { ok: true, result: { hwnd: 1, exe: 'C:/x/notepad.exe', title: 'Untitled - Notepad', quns: 5 } } : { ok: false, error: 'stub' }) },
    host: { display: () => ({ workArea: o.work || WORK, scaleFactor: 1.25 }), barRect: () => (o.bar === undefined ? PILL : o.bar), bar },
  };
  const inst = clips.install(ctx);
  const move = (up, ms) => { bar.isUp = up; motion.forEach((f) => f({ up, ms })); };
  const lifts = () => pushes.filter((x) => x.name === 'clips.lift').map((x) => x.p);
  const win = () => wins[wins.length - 1];
  return { ctx, cmds, pushes, logs, inst, move, lifts, win, state: () => cmds.debug().follow };
}
function inside(r, pt) { return pt.x >= r.x && pt.x < r.x + r.width && pt.y >= r.y && pt.y < r.y + r.height; }
function overlap(a, b) { return Math.min(a.x + a.width, b.x + b.width) > Math.max(a.x, b.x) && Math.min(a.y + a.height, b.y + b.height) > Math.max(a.y, b.y); }

(async () => {
  // ---- the arithmetic (C.panelSpot / panelCard) with Owen's numbers
  {
    const sp = C.panelSpot({ work: WORK, bar: PILL, w: 376, h: 260 });
    check('spot: low in the corner (6 DIP in), as if no bar', sp.low.x === 1154 && sp.low.y === 598 && sp.low.width === 376 && sp.low.height === 260, sp);
    check('spot: reach 56 (the window bottom 858 to the pill top 802)', sp.reach === 56 && sp.full === 316, sp);
    check('spot: reach does not depend on the card height', C.panelSpot({ work: WORK, bar: PILL, w: 376, h: 200 }).reach === 56);
    check('spot: a dock bar outside the work area / a top-edge bar / no bar: reach 0',
      C.panelSpot({ work: { x: 0, y: 0, width: 1536, height: 802 }, bar: PILL, w: 376, h: 260 }).reach === 0
      && C.panelSpot({ work: WORK, bar: { x: 208, y: 0, width: 1120, height: 62 }, w: 376, h: 260 }).reach === 0
      && C.panelSpot({ work: WORK, bar: null, w: 376, h: 260 }).reach === 0);
    check('spot: a wide screen where the pill does not reach the corner: reach 0', C.panelSpot({ work: { x: 0, y: 0, width: 2560, height: 1392 }, bar: { x: 720, y: 1330, width: 1120, height: 62 }, w: 376, h: 260 }).reach === 0);
    check('spot: never lifted past the work area\'s top', C.panelSpot({ work: { x: 0, y: 0, width: 1536, height: 300 }, bar: { x: 208, y: 238, width: 1120, height: 62 }, w: 376, h: 290 }).reach <= 4);
    const card = C.panelCard({ x: 1154, y: 542, width: 376, height: 316 }, 260, 56, 18);
    check('card: lifted 56 inside the 316-tall window', card.x === 1172 && card.y === 560 && card.width === 340 && card.height === 224, card);
  }

  // ---- live: bar hidden, open, the bar comes up, goes down
  {
    corner.reset();
    const T = install({ up: false });
    const r = await T.cmds.panel({ via: 'the test' });
    check('open: routed to the panel', r && r.to === 'panel', r);
    await sleep(5);   // the page loads (stub: next tick)
    let s = T.state();
    check('hidden bar: the window is the card + the reach, its bottom in the corner', s.bounds.x === 1154 && s.bounds.y === 542 && s.bounds.height === 316 && s.bounds.y + s.bounds.height === 858, s.bounds);
    check('hidden bar: the shape is the card at the bottom (the reach band is not in it)', JSON.stringify(s.shape) === JSON.stringify({ x: 0, y: 56, width: 376, height: 260 }), s.shape);
    check('hidden bar: the card in the corner, 24 DIP from the bottom (no bar room reserved)', s.card.y + s.card.height === 840 && s.card.x + s.card.width === 1512 && s.lift === 0, s.card);
    check('hidden bar: corner.js has the card low, { lift: 56 }', s.corner && s.corner.y === 616 && s.corner.height === 224 && s.corner.lift === 56, s.corner);
    check('page told where it stands (ms 0, px 0)', T.lifts().some((p) => p.px === 0 && p.ms === 0), T.lifts());
    // popwatch: inside / outside
    let closed = 0;
    check('popwatch: a click on the low card is inside', popwatch.outsideAt({ x: 1300, y: 830 }, 'test') === 0);
    T.move(true, 560);
    const up = T.lifts().pop();
    check('bar up: the page glides 56 up on the spring, in 336 ms (UP_RATE 0.6)', up.px === 56 && up.kind === 'up' && up.ms === 336, up);
    s = T.state();
    check('bar up: while it glides the shape spans low..high (the whole 316)', JSON.stringify(s.shape) === JSON.stringify({ x: 0, y: 0, width: 376, height: 316 }), s.shape);
    check('bar up: the window does not move', s.bounds.y === 542 && s.bounds.height === 316, s.bounds);
    check('bar up: the card (lifted) is clear of the pill, 18 DIP above it', !overlap(s.card, PILL) && PILL.y - (s.card.y + s.card.height) === 18, s.card);
    check('popwatch: a click on the LIFTED card is inside (never "outside")', popwatch.outsideAt({ x: 1300, y: 600 }, 'test') === 0 && T.state().shown);
    await sleep(336 + 60 + 40);
    s = T.state();
    check('bar up, settled: the shape narrows to the card at its lifted place', JSON.stringify(s.shape) === JSON.stringify({ x: 0, y: 0, width: 376, height: 260 }) && !s.glide, s);
    check('size: a taller card keeps the bottom and the reach', (T.cmds.size({ h: 260 }), T.state().bounds.height === 260 + 36 + 56 && T.state().bounds.y + T.state().bounds.height === 858 && T.state().card.height === 260), T.state());
    T.cmds.size({ h: 224 });
    T.move(false, 240);
    const down = T.lifts().pop();
    check('bar down: back to 0 on the exit, 300 ms (240 + DOWN_TRAIL_MS)', down.px === 0 && down.kind === 'down' && down.ms === 300, down);
    await sleep(300 + 60 + 40);
    s = T.state();
    check('bar down, settled: shape back at the bottom', JSON.stringify(s.shape) === JSON.stringify({ x: 0, y: 56, width: 376, height: 260 }), s.shape);
    // a click in the empty band above the low card (where the card was while the bar was up): outside
    const n = popwatch.outsideAt({ x: 1300, y: 600 }, 'test');
    closed = n;
    check('popwatch: a click in the empty reach band is outside: the panel hides', closed === 1 && !T.state().shown, { closed, s: T.state().shown });
    check('hidden: corner.js forgets it', !corner.list().some((c) => c.key === 'the record panel'), corner.list());
    // nothing on screen: the bar comes up, no glide (it stands there for the next show)
    const g0 = T.state().glides;
    T.move(true, 560);
    check('nothing on screen: no glide', T.state().glides === g0 && !T.state().glide, T.state());
    await T.cmds.panel({ via: 'again' });
    s = T.state();
    check('opened with the bar already up: stands lifted, no glide, card clear of the pill', s.lift === 56 && !s.glide && !overlap(s.card, PILL) && JSON.stringify(s.shape) === JSON.stringify({ x: 0, y: 0, width: 376, height: 260 }), s);
    // catchUp: hide, bar goes down, open while it is still going
    T.cmds.close({ why: 'test' });
    T.move(false, 240);
    await sleep(40);
    const before = T.lifts().length;
    await T.cmds.panel({ via: 'mid-exit' });
    const cu = T.lifts().slice(before);
    s = T.state();
    check('opened while the bar is going: starts at the bar\'s top (56, ms 0) and goes down over what is left', cu.length >= 2 && cu[0].px === 56 && cu[0].ms === 0 && cu[1].px === 0 && cu[1].ms > 100 && cu[1].ms < 300, cu);
    check('catchUp: the shape spans the way down', s.glide && s.glide.caughtUp && JSON.stringify(s.shape) === JSON.stringify({ x: 0, y: 0, width: 376, height: 316 }), s);
    await sleep(320);
    // the --test hold
    T.cmds.close({ why: 'test' });
    await T.cmds.panel({ via: 'hold', holdMs: 60 });
    check('test hold: up and holding', T.state().shown && T.state().holding);
    await sleep(90);
    check('test hold: hidden after holdMs', !T.state().shown && !T.state().holding);
    T.inst.stop();
    check('stop: corner.js forgets it', !corner.list().some((c) => c.key === 'the record panel'));
  }

  // ---- flat: the shape is not read back -> sized to the card, placed straight at the target
  {
    corner.reset(); verifyOk = false;
    const T = install({ up: true });
    await T.cmds.panel({ via: 'flat' });
    await sleep(5);
    const s = T.state();
    check('flat: shapeOk false, the region dropped (setShape [])', s.shapeOk === false && T.win().shapes[T.win().shapes.length - 1] === null, s);
    check('flat: the window is the card, placed 56 up (straight at the target)', s.bounds.height === 260 && s.bounds.y === 598 - 56 && !overlap(s.card, PILL) && s.lift === 0, s);
    check('flat: the page lift stays 0', T.lifts().every((p) => p.px === 0), T.lifts());
    T.move(false, 240);
    check('flat: bar down -> the window goes straight to the corner, no glide', T.state().bounds.y === 598 && !T.state().glide, T.state());
    check('flat: popwatch inside = the window minus margins', popwatch.outsideAt({ x: 1300, y: 830 }, 'test') === 0);
    T.inst.stop(); verifyOk = true;
  }
  {
    corner.reset(); applyOk = false;
    const T = install({ up: false });
    await T.cmds.panel({ via: 'refused' });
    const s = T.state();
    check('shape refused: flat, sized to the card in the corner', s.shapeOk === false && s.bounds.height === 260 && s.bounds.y === 598, s);
    T.inst.stop(); applyOk = true;
  }
  // ---- a dock bar (outside the work area): nothing moves
  {
    corner.reset();
    const T = install({ up: true, work: { x: 0, y: 0, width: 1536, height: 802 } });
    await T.cmds.panel({ via: 'dock' });
    await sleep(5);
    const s = T.state();
    check('dock: reach 0, the window is the card, nothing lifts', s.reach === 0 && s.bounds.height === 260 && s.bounds.y + s.bounds.height === 796 && T.lifts().every((p) => p.px === 0), s);
    T.inst.stop();
  }

  Module._load = load0;
  console.log(`CLIPS FOLLOW TEST: ${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log(`  FAIL ${f}`);
  process.exitCode = failures.length ? 1 : 0;
  setTimeout(() => process.exit(process.exitCode), 50);
})().catch((err) => { console.log(`CLIPS FOLLOW TEST: threw ${err.stack}`); process.exit(1); });
