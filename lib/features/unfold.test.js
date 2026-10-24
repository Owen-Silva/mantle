'use strict';
/*
 * unfold.test.js - the Unfold feature (lib/features/unfold.js + _unfold-core.js + _unfold-windows.js) driven
 * through the REAL lib/features.js (createFeatures) with a fake Electron (windows, screen, powerMonitor), a
 * fake sidecar and fake overlay pages that answer like ui/unfold/unfold-page.js (lane unfold-unlock, 2026-10-23).
 *
 *   node lib/features/unfold.test.js   -> "UNFOLD UNIT TEST: n passed, m failed"
 *
 * Pure node: no Electron, no window, nothing on screen. The timings are shrunk (TIMING is the core's own
 * table), so every wait is tens of milliseconds.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { createFeatures } = require('../features');
const { ShellState } = require('../state');
const { TIMING } = require('./_unfold-core.js');
const bus = require('./_unfold-bus.js');

const ROOT = path.resolve(__dirname, '..', '..');
let passed = 0;
const failures = [];
function check(name, ok, detail) { if (ok) passed++; else failures.push(detail !== undefined ? `${name} (${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 300)})` : name); return ok; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms) { const end = Date.now() + (ms || 1500); for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) return null; await sleep(5); } }

Object.assign(TIMING, { CAPTURE_MAX_MS: 120, FULL_MS: 40, PLAY_PAD_MS: 150, GRACE_MS: 30, ARMED_ON_MS: 80, LOCKED_RELOOK_MS: 30,
  COVER_MAX_MS: 400, FOLD_MS: 30, REVEAL_MS: 20, DEBOUNCE_MS: 200, REMAKE_MS: 40 });

/* ---- fakes ---- */
function fakeElectron() {
  const E = { wins: [], idle: 'active', reduced: false, pageMode: 'normal', delay: {}, answer: null, crashOn: null,
    displays: [{ id: 1, bounds: { x: 0, y: 0, width: 1536, height: 864 }, scaleFactor: 1.25 }] };
  E.powerMonitor = new EventEmitter();
  E.powerMonitor.getSystemIdleState = () => E.idle;
  E.screen = new EventEmitter();
  E.screen.getAllDisplays = () => E.displays;
  E.screen.dipToScreenRect = (_w, r) => {
    const d = E.displays.find((x) => x.bounds.x === r.x && x.bounds.y === r.y) || E.displays[0];
    const s = d.scaleFactor;
    return { x: Math.round(r.x * s), y: Math.round(r.y * s), width: Math.round(r.width * s), height: Math.round(r.height * s) };
  };
  E.systemPreferences = { getAnimationSettings: () => ({ prefersReducedMotion: E.reduced }) };
  class FakeWC extends EventEmitter {
    constructor(win) { super(); this.win = win; }
    send(ch, m) { if (ch === 'mantle:event' && m.name === 'unfold.cmd') this.win.onCmd(m.payload); }
    isDestroyed() { return this.win.destroyed; }
    setWindowOpenHandler() {}
  }
  class FakeWin extends EventEmitter {
    constructor(o) {
      super();
      this.opts = o; this.visible = false; this.destroyed = false; this.cmds = []; this.shows = 0;
      this.bounds = { x: o.x, y: o.y, width: o.width, height: o.height };
      this.webContents = new FakeWC(this);
      E.wins.push(this);
    }
    loadFile(file, o) { this.file = file; this.display = o.query.display; setTimeout(() => E.answer && E.answer({ seq: 0, display: this.display, event: 'ready' }), 1); return Promise.resolve(); }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    showInactive() { this.visible = true; this.shows++; }
    show() { throw new Error('the overlay must never be shown with show() (it would take focus)'); }
    focus() { throw new Error('the overlay must never be focused'); }
    hide() { this.visible = false; }
    destroy() { this.destroyed = true; this.visible = false; this.emit('closed'); }
    setBounds(b) { this.bounds = Object.assign({}, b); }
    setIgnoreMouseEvents(on) { this.ignore = on; }
    setContentProtection(on) { this.protect = on; }
    setSkipTaskbar() {}
    onCmd(c) {
      this.cmds.push(Object.assign({}, c, { still: c.still ? (c.still.startsWith('data:image/') ? 'PICTURE' : 'BAD') : c.still }));
      if (E.crashOn === c.op) { setTimeout(() => this.webContents.emit('render-process-gone', {}, { reason: 'crashed' }), 2); return; }
      if (E.pageMode === 'silent') return;
      const ev = { arm: 'armed', play: 'played', cover: 'covered', reveal: 'revealed', finish: 'finished', park: 'parked', skip: 'skipped' }[c.op];
      const extra = c.op === 'play' ? (c.still ? { technique: 'layers', stats: { frames: 42, p95: 17, max: 19, dropped: 0 }, prepMs: 30 } : { technique: 'fade' })
        : (c.op === 'cover' ? { ok: true } : {});
      setTimeout(() => E.answer && E.answer(Object.assign({ seq: c.seq, display: this.display, event: ev }, extra)), E.delay[c.op] !== undefined ? E.delay[c.op] : 3);
    }
    ops() { return this.cmds.map((c) => c.op); }
  }
  E.BrowserWindow = FakeWin;
  E.live = () => E.wins.filter((w) => !w.destroyed);
  return E;
}

function fakeSidecar() {
  const s = new EventEmitter();
  s.calls = [];
  s.down = null;
  s.backdrop = 'ok';         // ok | fail | slow | empty
  s.watchFail = null;
  s.blockedReason = () => s.down;
  s.call = async (cmd, args, ms) => {
    s.calls.push({ cmd, args: JSON.parse(JSON.stringify(args || {})), ms });
    if (cmd === 'backdrop') {
      if (s.backdrop === 'fail') throw new Error('backdrop: BitBlt failed (Win32 error 5)');
      if (s.backdrop === 'slow') { await sleep(ms + 20); throw new Error(`sidecar request "backdrop" timed out after ${ms} ms`); }
      if (s.backdrop === 'empty') return { w: 1, h: 1 };
      return { png: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg' + 'A'.repeat(64), w: args.w, h: args.h, ms: 20 };
    }
    if (cmd === 'unfold.watch') { if (s.watchFail) throw new Error(s.watchFail); return { watching: !!args.on, display: 'on', lid: 'open', registered: ['display', 'lid', 'power'], reason: null }; }
    if (cmd === 'unfold.input') return { watching: !!args.on, token: args.token || null };
    if (cmd === 'unfold.simulate') { setTimeout(() => s.emit('unfold', { ev: 'unfold', what: args.what, token: args.token, simulated: true }), 1); return { simulated: args.what }; }
    return { echoed: cmd };
  };
  s.n = (cmd) => s.calls.filter((c) => c.cmd === cmd).length;
  s.last = (cmd) => s.calls.filter((c) => c.cmd === cmd).slice(-1)[0];
  return s;
}

/** a features dir holding only unfold.js, which hands the fakes to the real module's install */
const SHIM_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-unfold-unit-'));
fs.writeFileSync(path.join(SHIM_DIR, 'unfold.js'), `'use strict';
const real = require(${JSON.stringify(path.join(__dirname, 'unfold.js'))});
module.exports = Object.assign({}, real, { install(ctx) { return real.install(ctx, global.__unfoldFakes); } });
`);

function harness(opts) {
  const o = opts || {};
  const E = fakeElectron();
  const sidecar = fakeSidecar();
  global.__unfoldFakes = Object.assign({ electron: E, realInput: o.realInput !== undefined ? o.realInput : true, raise: null }, o.fakes || {});
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-unfold-unit-ud-'));
  const state = new ShellState('test', 'bottom');
  const commands = { 'state.get': async () => state.get() };
  const lines = [];
  const f = createFeatures({ dir: SHIM_DIR, test: o.test !== undefined ? o.test : true, root: ROOT, userData, state, sidecar, commands,
    broadcast: () => {}, log: (l) => lines.push(l),
    host: { openLauncher: () => null, barRect: () => null, display: () => ({ id: 1 }) } });
  E.answer = (msg) => commands['unfold.page'] && commands['unfold.page'](msg).catch(() => {});
  return { f, E, sidecar, commands, lines, state, piece: () => (state.get().features || {}).unfold || {} };
}
const T = (h, op, extra) => h.commands['unfold.test'](Object.assign({ op }, extra || {}));
const st = (h) => T(h, 'state');
const opsOf = (h) => h.E.live().map((w) => w.ops().join(',')).join(' | ');

async function boot(opts) {
  const h = harness(opts);
  h.f.load(); await sleep(5);
  await until(() => h.E.live().length && h.sidecar.n('unfold.watch'));
  await sleep(10);
  return h;
}
async function quit(h) { await h.f.stopAll('test over'); await sleep(5); }

/* ---- the checks ---- */
async function moduleChecks() {
  const h = await boot();
  const rec = h.f.list().find((x) => x.name === 'unfold');
  check('the module loads, on by default, healthy', rec && rec.enabled === true && rec.ok !== false, rec);
  const mod = require('./unfold.js');
  check('it rests while a game runs (rest: true) and takes no keys', mod.rest === true && mod.chords.length === 0 && mod.observe.length === 0);
  check('one option: when to play it, unlock (default) or wake only', mod.options.length === 1 && mod.options[0].key === 'when' && mod.options[0].default === 'unlock' &&
    mod.options[0].choices.map((c) => c.value).join() === 'unlock,wake', mod.options);
  check('commands: page, status, and test (in --test)', ['unfold.page', 'unfold.status', 'unfold.test'].every((c) => typeof h.commands[c] === 'function'));
  const w = h.E.live()[0];
  check('one overlay window per display, pre-created and PARKED (hidden)', h.E.live().length === 1 && w.visible === false, h.E.live().length);
  check('the window: full screen on its display, frameless, transparent, not focusable, no taskbar, no shadow',
    w.opts.width === 1536 && w.opts.height === 864 && w.opts.frame === false && w.opts.transparent === true && w.opts.focusable === false && w.opts.skipTaskbar === true && w.opts.hasShadow === false, w.opts);
  check('click-through and excluded from capture from the start', w.ignore === true && w.protect === true, { ignore: w.ignore, protect: w.protect });
  check('the page is ui/unfold/index.html with its display id', /ui[\\/]unfold[\\/]index\.html$/.test(w.file) && w.display === '1', w.file);
  check('the sidecar watch (display / lid / sleep) is asked for at start', h.sidecar.last('unfold.watch').args.on === true);
  check('the screen cover is provided (bus available)', bus.available() === true);
  const s0 = await h.commands['unfold.status']();
  check('status: idle, on, every unlock, display on, lid open', s0.phase === 'idle' && s0.on === true && s0.when === 'unlock' && s0.display === 'on' && s0.lid === 'open', s0);
  await quit(h);
  check('stop(): the bus is let go and the windows destroyed', bus.available() === false && h.E.wins.every((x) => x.destroyed));
  check('stop(): the sidecar watch is switched off', h.sidecar.last('unfold.watch').args.on === false);
  check('stop(): powerMonitor and screen listeners are removed', h.E.powerMonitor.listenerCount('unlock-screen') === 0 && h.E.powerMonitor.listenerCount('lock-screen') === 0 && h.E.screen.listenerCount('display-added') === 0);
  const noTest = harness({ test: false });
  noTest.f.load(); await sleep(5);
  check('live: no unfold.test command', typeof noTest.commands['unfold.test'] !== 'function' && typeof noTest.commands['unfold.page'] === 'function');
  await quit(noTest);
}

async function unlockChecks() {
  const h = await boot();
  const w = h.E.live()[0];
  await T(h, 'fire', { what: 'lock' });
  let s = await st(h);
  check('lock: ARMED, the overlay is up (showInactive) as the unlit display', s.phase === 'armed' && w.visible && w.shows === 1 && w.ops().includes('arm'), { s: s.phase, ops: w.ops() });
  check('armed: nothing captured yet (the screen is locked)', h.sidecar.n('backdrop') === 0);
  check('armed: the input watch is on, slow (100 ms)', h.sidecar.last('unfold.input').args.on === true && h.sidecar.last('unfold.input').args.pollMs === 100, h.sidecar.last('unfold.input'));
  await T(h, 'fire', { what: 'unlock' });
  const played = await until(() => w.ops().includes('play') && w.ops().includes('park'));
  check('unlock: picture taken WITH the overlay up, then play with the picture, then hidden and parked', !!played && !w.visible, opsOf(h));
  const bd = h.sidecar.last('backdrop');
  check('the picture is the display at its PHYSICAL pixels, scale 1 (sharp at the end)', bd && bd.args.x === 0 && bd.args.w === 1920 && bd.args.h === 1080 && bd.args.scale === 1, bd && bd.args);
  check('the capture has a deadline (CAPTURE_MAX_MS, 900 ms live)', bd && bd.ms === TIMING.CAPTURE_MAX_MS, bd && bd.ms);
  const play = w.cmds.find((c) => c.op === 'play');
  check('the play carries the picture and the full size', play && play.still === 'PICTURE' && play.size === 'full', play);
  s = await st(h);
  check('after: idle, 1 play, the last play recorded', s.phase === 'idle' && s.plays === 1 && s.last && s.last.played === 1 && !s.last.skipped, s);
  check('the log says it unfolded, with the time and frames, and NO picture data', h.lines.some((l) => /unfold: unfolded after "the screen was unlocked": picture \d+ ms, 1 display\(s\), 42 frames/.test(l)) &&
    !h.lines.some((l) => /data:image|base64|iVBOR/.test(l)), h.lines.slice(-3));
  // one play per wake: the duplicates of the same wake find nothing armed
  await T(h, 'fire', { what: 'display-on' }); await T(h, 'fire', { what: 'resume' }); await T(h, 'fire', { what: 'unlock' });
  await sleep(30);
  s = await st(h);
  check('one play per unlock: display on / resume / a second unlock after it play nothing', s.plays === 1 && w.ops().filter((x) => x === 'play').length === 1, s.plays);
  // unlock with nothing armed
  check('an unlock with no lock seen does nothing (never shows a black screen it did not arm)', s.phase === 'idle' && !w.visible);
  await quit(h);
}

async function wakeChecks() {
  let h = await boot();
  await T(h, 'fire', { what: 'display-off' });
  check('display off: armed', (await st(h)).phase === 'armed');
  await T(h, 'fire', { what: 'display-on' });
  await until(() => h.E.live()[0].ops().includes('park'));
  check('display on (unlocked): plays', (await st(h)).plays === 1);
  await sleep(TIMING.DEBOUNCE_MS + 10);
  await T(h, 'fire', { what: 'display-off' });
  await T(h, 'fire', { what: 'lid-open' });
  await until(() => h.E.live()[0].ops().filter((x) => x === 'park').length >= 2);
  check('lid open (unlocked) after a dark spell: plays', (await st(h)).plays === 2);
  await T(h, 'fire', { what: 'display-on' });
  await sleep(TIMING.DEBOUNCE_MS + 10);
  await T(h, 'fire', { what: 'suspend' });
  check('sleep while the display is ON and unlocked does NOT arm (this PC sends its sleep notice late, at wake)', (await st(h)).phase === 'idle');
  await T(h, 'fire', { what: 'display-off' }); await T(h, 'fire', { what: 'suspend' });
  await T(h, 'fire', { what: 'resume' });
  await until(() => h.E.live()[0].ops().filter((x) => x === 'park').length >= 3);
  check('dark, sleep, resume (unlocked): plays', (await st(h)).plays === 3);
  await quit(h);

  // wake only
  h = await boot();
  await T(h, 'option', { when: 'wake' });
  await T(h, 'fire', { what: 'lock' });
  check('wake only: a lock alone does not arm', (await st(h)).phase === 'idle');
  await T(h, 'fire', { what: 'display-off' });
  check('wake only: the screen going dark arms', (await st(h)).phase === 'armed');
  await T(h, 'fire', { what: 'display-on' });
  check('wake only: the screen coming on while LOCKED does not play (the lock screen is up)', (await st(h)).phase === 'armed' && h.sidecar.n('backdrop') === 0);
  await T(h, 'fire', { what: 'unlock' });
  await until(() => h.E.live()[0].ops().includes('park'));
  check('wake only: the unlock after the dark spell plays', (await st(h)).plays === 1);
  await sleep(TIMING.DEBOUNCE_MS + 10);
  await T(h, 'fire', { what: 'lock' }); await T(h, 'fire', { what: 'unlock' });
  await sleep(30);
  check('wake only: a plain lock and unlock plays nothing', (await st(h)).plays === 1);
  await quit(h);
}

async function safetyChecks() {
  // input while armed, unlocked = GO; locked = keep waiting and watch again. A LIVE run (Windows is asked
  // whether the session is locked), driven through the fake powerMonitor and the fake sidecar.
  let h = await boot({ test: false });
  const status = () => h.commands['unfold.status']();
  const tokNow = () => { const c = h.sidecar.last('unfold.input'); return c && c.args.on ? c.args.token : null; };
  h.E.idle = 'locked';
  h.E.powerMonitor.emit('lock-screen');
  check('live lock: armed', (await status()).phase === 'armed');
  const tok = tokNow();
  h.sidecar.emit('unfold', { ev: 'unfold', what: 'input', token: tok });
  await sleep(TIMING.LOCKED_RELOOK_MS + 30);
  let s = await status();
  check('input while armed and LOCKED (typing the PIN): stays armed and watches again', s.phase === 'armed' && tokNow() && tokNow() !== tok, { s: s.phase, tok, now: tokNow() });
  h.E.idle = 'active';   // the unlock event is lost, but Windows says the session is unlocked
  h.sidecar.emit('unfold', { ev: 'unfold', what: 'input', token: tokNow() });
  await until(() => h.E.live()[0].ops().includes('park'));
  s = await status();
  check('a MISSED unlock: input while armed and Windows says unlocked = it plays (never a black screen)', s.plays === 1 && s.phase === 'idle', s);
  await quit(h);
  await quit(h);

  // armed, unlocked, display on: GO by itself (live run: Windows is asked)
  h = await boot({ test: false });
  const core = () => h.f._installed ? null : null; void core;
  h.E.powerMonitor.emit('lock-screen');
  h.E.idle = 'active';   // ... but Windows says the session is NOT locked (the lock was missed or undone)
  await until(() => h.E.live()[0].ops().includes('park'), 1500);
  check('armed while the screen is on and unlocked: it plays after 1.2 s by itself (live)', h.E.live()[0].ops().includes('play'), opsOf(h));
  await quit(h);

  // input in the grace window does not cut; after it does
  h = await boot();
  h.E.delay.play = 200;
  await T(h, 'fire', { what: 'lock' }); await T(h, 'fire', { what: 'unlock' });
  await until(() => h.E.live()[0].ops().includes('play'));
  s = await st(h);
  check('the first 0.28 s of a play: no input watch yet (the Enter of the PIN does not cut it)', !s.inputToken || s.inputFor !== 'play', s.inputFor);
  await sleep(TIMING.GRACE_MS + 20);
  s = await st(h);
  check('after the grace: the input watch is on, fast (16 ms)', s.inputFor === 'play' && h.sidecar.last('unfold.input').args.pollMs === 16, h.sidecar.last('unfold.input'));
  h.sidecar.emit('unfold', { ev: 'unfold', what: 'input', token: s.inputToken });
  await until(() => h.E.live()[0].ops().includes('finish'));
  await until(() => !h.E.live()[0].visible);
  s = await st(h);
  check('input during the unfold: finish (a 90 ms fade), then hidden', h.E.live()[0].ops().includes('finish') && !h.E.live()[0].visible && s.phase === 'idle' && s.finishes === 1, opsOf(h));
  await quit(h);

  // capture fails / slow / empty -> the black fades (play with no picture), reason logged; 3 in a row = health
  h = await boot();
  for (const [i, mode, re] of [[1, 'fail', /BitBlt failed/], [2, 'slow', /longer than 120 ms/], [3, 'empty', /came back empty/]]) {
    h.sidecar.backdrop = mode;
    await sleep(TIMING.DEBOUNCE_MS + 10);
    await T(h, 'fire', { what: 'lock' }); await T(h, 'fire', { what: 'unlock' });
    await until(() => h.E.live()[0].ops().filter((x) => x === 'park').length >= i, 2000);
    const play = h.E.live()[0].cmds.filter((c) => c.op === 'play')[i - 1];
    check(`capture ${mode}: the page gets NO picture (it fades the black out) and the window is hidden`, play && play.still === null && !h.E.live()[0].visible, play);
    check(`capture ${mode}: the reason is logged`, h.lines.some((l) => /the unfold was skipped: /.test(l) && re.test(l)), h.lines.slice(-2));
  }
  check('3 skips in a row: the feature health says why (strip/tray)', h.piece().ok === false && /skipped 3 times in a row/.test(h.piece().reason), h.piece());
  h.sidecar.backdrop = 'ok';
  await sleep(TIMING.DEBOUNCE_MS + 10);
  await T(h, 'fire', { what: 'lock' }); await T(h, 'fire', { what: 'unlock' });
  await until(() => h.E.live()[0].ops().filter((x) => x === 'park').length >= 4);
  check('the next good play makes it healthy again', h.piece().ok !== false, h.piece());
  await quit(h);

  // the page never answers: the play is hidden by hand
  h = await boot();
  h.E.pageMode = 'silent';
  await T(h, 'fire', { what: 'lock' }); await T(h, 'fire', { what: 'unlock' });
  await sleep(TIMING.FULL_MS + TIMING.PLAY_PAD_MS + 80);
  s = await st(h);
  check('a page that never answers: hidden by its deadline, phase idle, logged', !h.E.live()[0].visible && s.phase === 'idle' && h.lines.some((l) => /hidden by hand|did not play/.test(l)), { s: s.phase, l: h.lines.slice(-2) });
  await quit(h);

  // the page dies while armed: hidden at once, health false, made again, healthy on ready
  h = await boot();
  h.E.crashOn = 'arm';
  await T(h, 'fire', { what: 'lock' });
  await until(() => h.piece().ok === false);
  s = await st(h);
  check('the page dying while armed: hidden at once, not armed, health says why', s.phase === 'idle' && !h.E.wins[0].visible && /page died/.test(h.piece().reason), { s: s.phase, p: h.piece() });
  h.E.crashOn = null;
  await until(() => h.E.live().length === 1 && h.E.wins.length === 2, 1000);
  await until(() => h.piece().ok !== false, 1000);
  check('the overlay is made again and the feature is healthy again', h.E.wins.length === 2 && h.piece().ok !== false, { n: h.E.wins.length, p: h.piece() });
  await quit(h);

  // reduced motion: no capture, a fade
  h = await boot();
  h.E.reduced = true;
  await T(h, 'fire', { what: 'lock' }); await T(h, 'fire', { what: 'unlock' });
  await until(() => h.E.live()[0].ops().includes('park'));
  const play = h.E.live()[0].cmds.find((c) => c.op === 'play');
  check('Windows animation effects off: no picture is taken, the page gets a fade', h.sidecar.n('backdrop') === 0 && play && play.still === null, play);
  check('...and it is not counted as a skip', (await st(h)).skips === 0 && h.lines.some((l) => /a short fade/.test(l)), h.lines.slice(-1));
  await quit(h);

  // the switch off: no arming; off while armed: hidden
  h = await boot();
  await T(h, 'fire', { what: 'lock' });
  h.f.setEnabled('unfold', false, 'unit');
  await sleep(5);
  check('switched off while armed: hidden at once', (await st(h)).phase === 'idle' && !h.E.live()[0].visible);
  await T(h, 'fire', { what: 'lock' });
  check('switched off: a lock arms nothing', (await st(h)).phase === 'idle' && !h.E.live()[0].visible);
  check('switched off: the screen cover is STILL provided', bus.available() === true);
  await quit(h);

  // sidecar watch refused: logged, unlock still plays
  h = harness();
  h.sidecar.watchFail = 'unknown command unfold.watch';
  h.f.load(); await sleep(5);
  await sleep(20);
  check('the display/lid/sleep watch refused: logged in plain words', h.lines.some((l) => /only unlocks play it/.test(l)), h.lines.slice(-2));
  await T(h, 'fire', { what: 'lock' }); await T(h, 'fire', { what: 'unlock' });
  await until(() => h.E.live()[0] && h.E.live()[0].ops().includes('park'));
  check('...and an unlock still plays', (await st(h)).plays === 1);
  await quit(h);
}

async function displayChecks() {
  const h = await boot();
  h.E.displays.push({ id: 2, bounds: { x: 1536, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 });
  h.E.screen.emit('display-added');
  await until(() => h.E.live().length === 2);
  check('a second display gets its own window at its bounds', h.E.live().length === 2 && h.E.live()[1].bounds.x === 1536 && h.E.live()[1].bounds.width === 1920);
  await T(h, 'fire', { what: 'lock' });
  check('armed: both displays covered', h.E.live().every((w) => w.visible));
  await T(h, 'fire', { what: 'unlock' });
  await until(() => h.E.live().every((w) => w.ops().includes('park')));
  const shots = h.sidecar.calls.filter((c) => c.cmd === 'backdrop').map((c) => c.args);
  check('two pictures, each its own display at its own pixels', shots.length === 2 && shots.some((a) => a.x === 0 && a.w === 1920) && shots.some((a) => a.x === 1536 && a.w === 1920 && a.h === 1080), shots);
  check('both pages play', h.E.live().every((w) => w.ops().includes('play')));
  h.E.displays.pop();
  h.E.screen.emit('display-removed');
  await until(() => h.E.live().length === 1);
  check('a display removed: its window is destroyed', h.E.live().length === 1 && h.E.wins[1].destroyed);
  await quit(h);
}

async function busChecks() {
  let h = await boot();
  const seen = [];
  const off = bus.onChange((s) => seen.push(s));
  let r = await bus.cover({ from: 'lookaway' });
  const w = h.E.live()[0];
  check('cover: resolves ok when it sits blurred', r && r.ok === true, r);
  check('cover: the picture was taken and the page folded it (cover op with the picture)', h.sidecar.n('backdrop') === 1 && w.cmds.some((c) => c.op === 'cover' && c.still === 'PICTURE') && w.visible, opsOf(h));
  check('cover: state covered by lookaway; onChange said so', bus.state().covered === true && bus.state().by === 'lookaway' && seen.some((s) => s.covered && s.by === 'lookaway'), bus.state());
  check('cover: the fast input watch is on', h.sidecar.last('unfold.input').args.on === true && h.sidecar.last('unfold.input').args.pollMs === 16);
  r = await bus.cover({ from: 'lookaway' });
  check('a second cover while covered: ok, nothing new', r.ok === true && r.already === true && h.sidecar.n('backdrop') === 1);
  r = await bus.reveal({ from: 'lookaway' });
  check('reveal: ok, the page unfolded back, then hidden and parked', r.ok === true && w.ops().includes('reveal') && w.ops().slice(-1)[0] === 'park' && !w.visible, opsOf(h));
  check('reveal: state uncovered; onChange said so', bus.state().covered === false && seen.slice(-1)[0].covered === false);
  r = await bus.reveal({ from: 'lookaway' });
  check('reveal when not covered: ok, already', r.ok === true && r.already === true);

  // input while covered reveals at once and tells the bus
  await bus.cover({ from: 'lookaway' });
  const n = seen.length;
  const tok = (await st(h)).inputToken;
  h.sidecar.emit('unfold', { ev: 'unfold', what: 'input', token: tok });
  await until(() => !w.visible);
  check('input while covered: revealed at once, onChange told (covered:false)', bus.state().covered === false && seen.length > n && seen.slice(-1)[0].covered === false && w.ops().includes('reveal'), opsOf(h));

  // the hard limit
  await bus.cover({ from: 'lookaway' });
  await sleep(TIMING.COVER_MAX_MS + 80);
  check('a cover can never outlive its limit: revealed and logged', bus.state().covered === false && !w.visible && h.lines.some((l) => /cover was up for 15 minutes/.test(l)), bus.state());

  // the switch off: the cover still works
  h.f.setEnabled('unfold', false, 'unit');
  r = await bus.cover({ from: 'lookaway' });
  check('the tray switch OFF: the cover still works (the switch is only the unlock effect)', r.ok === true && bus.state().covered === true, r);
  await bus.reveal({ from: 'lookaway' });
  h.f.setEnabled('unfold', true, 'unit');

  // cover while armed: refused in words
  await T(h, 'fire', { what: 'lock' });
  r = await bus.cover({ from: 'lookaway' });
  check('cover while the screen is locked/dark: ok false, in words', r.ok === false && /off or locked/.test(r.reason), r);
  await T(h, 'fire', { what: 'unlock' });
  await until(() => w.ops().filter((x) => x === 'play').length === 1 && !w.visible);
  await sleep(10);

  // capture fails: ok false, nothing shown
  h.sidecar.backdrop = 'fail';
  r = await bus.cover({ from: 'lookaway' });
  check('cover with no picture: ok false with the reason, nothing shown, not covered', r.ok === false && /could not be covered: the picture of the screen failed/.test(r.reason) && !w.visible && bus.state().covered === false, r);
  h.sidecar.backdrop = 'ok';

  // a lock while covered: the cover is dropped (and told) and the overlay arms
  await bus.cover({ from: 'lookaway' });
  const n2 = seen.length;
  await T(h, 'fire', { what: 'lock' });
  check('a lock while covered: the cover is dropped and told, the overlay arms', bus.state().covered === false && seen.length > n2 && (await st(h)).phase === 'armed');
  await T(h, 'fire', { what: 'unlock' });
  await until(() => !w.visible);
  await sleep(TIMING.DEBOUNCE_MS);

  // the page dies while covered
  await bus.cover({ from: 'lookaway' });
  h.E.crashOn = 'reveal';
  const n3 = seen.length;
  w.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  await until(() => bus.state().covered === false);
  check('the page dying while covered: hidden, uncovered, told, health false with the reason',
    !w.visible && bus.state().covered === false && seen.length > n3 && h.piece().ok === false && /page died/.test(h.piece().reason), { st: bus.state(), p: h.piece() });
  h.E.crashOn = null;
  await until(() => h.piece().ok !== false, 1000);

  // stop while covered
  await until(() => h.E.live().length === 1);
  await sleep(20);
  r = await bus.cover({ from: 'lookaway' });
  check('covered again with the new window', r.ok === true, r);
  const n4 = seen.length;
  await quit(h);
  check('stop() while covered: the bus is let go and told (available false)', bus.available() === false && seen.length > n4 && seen.slice(-1)[0].available === false);
  r = await bus.cover({ from: 'lookaway' });
  check('after stop: cover says in words that nobody provides it', r.ok === false && /not running/.test(r.reason), r);
  off();

  // rest: stopped with { rest: true } and back
  h = await boot();
  await h.f.restAll('VALORANT runs');
  check('a game rest: the bus is let go, the windows destroyed', bus.available() === false && h.E.wins.every((x) => x.destroyed));
  await h.f.wakeAll('the game exited');
  await until(() => bus.available());
  check('after the game: provided again with new windows', bus.available() === true && h.E.live().length === 1);
  await quit(h);
}

(async () => {
  const t0 = Date.now();
  for (const [name, fn] of [['module', moduleChecks], ['unlock', unlockChecks], ['wake', wakeChecks], ['safety', safetyChecks], ['displays', displayChecks], ['bus', busChecks]]) {
    try { await fn(); } catch (e) { check(`${name}: threw`, false, e && e.stack); }
  }
  try { fs.rmSync(SHIM_DIR, { recursive: true, force: true }); } catch (_) { /* temp */ }
  for (const f of failures) console.log('FAIL ' + f);
  console.log(`UNFOLD UNIT TEST: ${passed} passed, ${failures.length} failed (${Date.now() - t0} ms)`);
  process.exit(failures.length ? 1 : 0);
})();
