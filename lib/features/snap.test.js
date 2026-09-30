'use strict';
/*
 * snap.test.js - lib/features/snap.js on a fake ctx, a fake sidecar and a stubbed electron: no
 * window is created and nothing on the machine moves. Plain node:  node lib/features/snap.test.js
 *
 * What it holds down: which sidecar calls each chord makes (and with WHICH window: the foreground
 * one live, the panel's own target while a panel is open, only a test window in --test), that
 * every refusal becomes a notice in words, that Snap Assist opens only with something to offer and
 * walks a Win+Z layout's zones, that pictures are registered before the reveal and cleared first
 * on the way out, and that the focus goes where Windows would put it.
 * Prints one summary line; exits non-zero on any failure.
 */
const path = require('path');
const Module = require('module');

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) pass++; else { fail++; console.log('FAIL ' + name + (detail !== undefined ? '  -- ' + String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 400) : '')); }
}
const tick = () => new Promise((r) => setImmediate(r));
const flush = async () => { for (let i = 0; i < 8; i++) await tick(); };

// ---------------------------------------------------------------- stubs
const SCALE = 1.25;
const DISPLAY = { id: 1, bounds: { x: 0, y: 0, width: 1536, height: 864 }, workArea: { x: 0, y: 0, width: 1536, height: 864 }, scaleFactor: SCALE };
const wins = [];
class FakeWindow {
  constructor(opts) {
    this.opts = opts; this.bounds = { x: opts.x, y: opts.y, width: opts.width, height: opts.height };
    this.handlers = {}; this.destroyed = false; this.focused = true; this.setBoundsLog = [];
    const self = this;
    this.webContents = {
      on(ev, fn) { (self.handlers['wc:' + ev] = self.handlers['wc:' + ev] || []).push(fn); },
      setWindowOpenHandler() {}, isDestroyed: () => self.destroyed,
    };
    wins.push(this);
  }
  on(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); }
  once(ev, fn) { this.on(ev, fn); }
  emit(ev, ...a) { (this.handlers[ev] || []).forEach((f) => f(...a)); }
  loadFile() { setImmediate(() => (this.handlers['wc:did-finish-load'] || []).forEach((f) => f())); return Promise.resolve(); }
  isDestroyed() { return this.destroyed; }
  destroy() { this.destroyed = true; }
  setBounds(b) { this.bounds = b; this.setBoundsLog.push(b); }
  getContentBounds() { return this.bounds; }
  showInactive() {} setAlwaysOnTop() {} moveTop() {}
  focus() { this.focusCalls = (this.focusCalls || 0) + 1; }
  isFocused() { return this.focused; }
  getTitle() { return 'test'; }
  isMinimized() { return false; }
}
const screen = {
  getAllDisplays: () => [DISPLAY], getDisplayMatching: () => DISPLAY, getPrimaryDisplay: () => DISPLAY,
  screenToDipRect: (_w, r) => ({ x: r.x / SCALE, y: r.y / SCALE, width: r.width / SCALE, height: r.height / SCALE }),
  dipToScreenPoint: (p) => ({ x: p.x * SCALE, y: p.y * SCALE }),
};
const tsets = [];
const thumbsStub = {
  set() {
    const s = { syncs: [], clears: [], sync(dest, boxes, dpr, origin) { s.syncs.push({ dest, boxes, dpr, origin }); return { ok: true, reason: null, thumbs: boxes.map((b) => ({ hwnd: b.hwnd, ok: true })) }; },
      clear(why) { s.clears.push(why); return 0; }, count: () => 0 };
    tsets.push(s);
    return s;
  },
  toBack() {},
};
const ROOT = path.join(__dirname, '..', '..');
const realLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === 'electron') return { BrowserWindow: FakeWindow, screen };
  if (parent && /features[\\/]snap\.js$/.test(parent.filename)) {
    if (req === '../thumbs') return thumbsStub;
    if (req === '../windows') return { hwndOf: () => '777' };
  }
  return realLoad.apply(this, arguments);
};
const feature = require('./snap.js');

// ---------------------------------------------------------------- a fake ctx + sidecar
function makeCtx(opts) {
  const o = opts || {};
  const calls = [], pushes = [], healths = [], lines = [], cmds = {}, chords = {};
  const answers = Object.assign({
    'snap.monitors': () => ({ ok: true, result: { monitors: [] } }),
    'windows': () => ({ ok: true, result: [
      { hwnd: '100', title: 'first', exe: 'C:\\a\\code.exe', minimized: false, icon: null },
      { hwnd: '200', title: 'second', exe: 'C:\\b\\chrome.exe', minimized: false, icon: 'data:image/png;base64,AA' },
      { hwnd: '300', title: 'third', exe: 'C:\\c\\explorer.exe', minimized: true, icon: null },
    ] }),
    'focus': () => ({ ok: true, result: null }),
  }, o.answers || {});
  const ctx = {
    name: 'snap', flags: Object.freeze({ test: !!o.test, live: !o.test }),
    log: (l) => lines.push(l),
    sidecar: {
      send: async (cmd, args) => { calls.push({ cmd, args }); const a = answers[cmd]; return a ? a(args) : { ok: false, error: 'unknown command: ' + cmd }; },
      on: () => () => {}, onReady: (fn) => { setImmediate(fn); return () => {}; }, ready: true,
    },
    command: (verb, fn) => { cmds[verb] = fn; },
    onChord: (c, fn) => { chords[c] = fn; }, onKey: () => () => {},
    health: (ok, reason) => healths.push({ ok, reason }),
    enabled: () => o.enabled !== false, onEnabled: () => () => {},
    page: (f) => path.join(ROOT, 'ui', 'snap', f || 'index.html'), preload: path.join(ROOT, 'preload.js'),
    broadcast() {}, push: (w, ev, p) => { pushes.push({ ev, p }); return true; },
    replay() {},
    host: { display: () => DISPLAY, barRect: () => null, openLauncher() {} },
    settings: { get: (k, d) => d, set() {} },
    test: o.test ? { fireChord() {}, fireKey() {} } : null,
  };
  const inst = feature.install(ctx);
  return { ctx, inst, calls, pushes, healths, lines, cmds, chords, answers, win: wins[wins.length - 1], tset: tsets[tsets.length - 1] };
}
const lastPush = (h, ev) => { const l = h.pushes.filter((p) => p.ev === ev); return l.length ? l[l.length - 1].p : null; };
const callsOf = (h, cmd) => h.calls.filter((c) => c.cmd === cmd);

const moved = (extra) => Object.assign({
  ok: true, hwnd: '100', exe: 'code.exe', from: 'normal', to: 'left', action: 'snap', moves: 1, ms: 4.2, fit: true,
  monitor: { id: '1', work: { x: 0, y: 0, w: 1920, h: 1080 } },
  assist: [{ zone: { name: 'right', grid: [2, 1], cell: [1, 0, 1, 1] }, frame: { x: 960, y: 0, w: 960, h: 1080 } }],
}, extra || {});

(async () => {
  // ---- the module and its health
  check('the module keeps the seam contract', feature.name === 'snap' && feature.chords.join() === 'Win+Left,Win+Right,Win+Up,Win+Down,Win+Z' &&
    feature.defaultOn === true && Array.isArray(feature.observe) && typeof feature.install === 'function');
  let h = makeCtx();
  await flush();
  check('healthy once the sidecar answers snap.monitors and the page has loaded', h.healths.length && h.healths[h.healths.length - 1].ok === true, h.healths);
  check('the window is focusable (it takes the arrows) and never in the taskbar', h.win.opts.focusable === true && h.win.opts.skipTaskbar === true && h.win.opts.transparent === true);
  const old = makeCtx({ answers: { 'snap.monitors': () => ({ ok: false, error: 'unknown command: snap.monitors' }) } });
  await flush();
  const lh = old.healths[old.healths.length - 1];
  check('an old sidecar without Snap.cs is DOWN, with the rebuild in words', lh && lh.ok === false && /built before Snap\.cs/.test(lh.reason), lh);
  old.win.emit('closed');

  // ---- Win+Left: the foreground window, then Snap Assist over the right half
  h.answers['snap.move'] = () => ({ ok: true, result: moved() });
  await h.chords['Win+Left']('Win+Left');
  await flush();
  let mv = callsOf(h, 'snap.move');
  check('Win+Left asks the sidecar to move the FOREGROUND window left (no hwnd live)', mv.length === 1 && mv[0].args.dir === 'left' && mv[0].args.hwnd === undefined, mv);
  let show = lastPush(h, 'snap.show');
  check('Snap Assist opens for the right half with the other windows (not the snapped one)', show && show.mode === 'assist' &&
    show.zone.name === 'right half' && show.candidates.map((c) => c.hwnd).join() === '200,300', show);
  check('candidates carry the exe name, not its path, and the minimized flag', show && show.candidates[0].exe === 'chrome.exe' && show.candidates[1].minimized === true);
  check('the window is sized to the zone (DIP) while parked off screen', h.win.bounds.width === 768 && h.win.bounds.height === 864 && h.win.bounds.y < 0, h.win.bounds);
  // the page reports its boxes: pictures first, then the reveal
  await h.cmds.painted({ seq: show.seq, boxes: [{ hwnd: '200', x: 30, y: 60, w: 256, h: 160 }], dpr: 1.25, vw: 768, vh: 864, ms: 5 });
  check('painted registers the DWM pictures into OUR window at the page\'s boxes', h.tset.syncs.length === 1 && h.tset.syncs[0].dest === '777' && h.tset.syncs[0].boxes.length === 1);
  check('...tells the page how each picture went', lastPush(h, 'snap.thumbs') && lastPush(h, 'snap.thumbs').thumbs[0].ok === true);
  check('...and reveals the pane over the zone', h.win.bounds.x === 768 && h.win.bounds.y === 0 && h.win.focusCalls >= 1, h.win.bounds);

  // ---- a Win+arrow while the assist is up acts on the ASSIST'S window, not the foreground (the pane)
  h.answers['snap.move'] = () => ({ ok: true, result: moved({ from: 'left', to: 'tl', assist: [] }) });
  await h.chords['Win+Up']('Win+Up');
  await flush();
  mv = callsOf(h, 'snap.move');
  check('Win+Up with Snap Assist open moves the window it was for', mv.length === 2 && mv[1].args.hwnd === '100' && mv[1].args.dir === 'up', mv[1]);
  check('...and closes the assist, pictures cleared first', lastPush(h, 'snap.hide') && h.tset.clears.length >= 1);

  // ---- pick in the assist: snap.zone for THAT window on the first window's monitor, then focus it
  h.answers['snap.move'] = () => ({ ok: true, result: moved() });
  await h.chords['Win+Left']('Win+Left');
  await flush();
  show = lastPush(h, 'snap.show');
  h.answers['snap.zone'] = (a) => ({ ok: true, result: moved({ hwnd: a.hwnd, to: 'right', assist: [] }) });
  const forged = await h.cmds.pick({ seq: show.seq, hwnd: '999999' });
  check('a pick of a window Snap Assist did not offer is refused (no snap.zone)', forged.ok === false && callsOf(h, 'snap.zone').length === 0, forged);
  await h.cmds.pick({ seq: show.seq, hwnd: '200' });
  await flush();
  let z = callsOf(h, 'snap.zone');
  check('a pick snaps that window into the zone, on the first window\'s monitor', z.length === 1 && z[0].args.hwnd === '200' &&
    z[0].args.grid.join() === '2,1' && z[0].args.cell.join() === '1,0,1,1' && z[0].args.of === '100', z[0]);
  let f = callsOf(h, 'focus');
  check('...and the picked window gets the focus, as in Windows', f.length && f[f.length - 1].args.hwnd === '200', f);
  check('a stale pick (old seq) is ignored', (await h.cmds.pick({ seq: 1, hwnd: '300' })).stale === true);

  // ---- refusals become notices, in words
  h.answers['snap.move'] = () => ({ ok: true, result: moved({ ok: false, action: 'none', to: 'normal', reason: 'Taskmgr.exe is running as administrator and Mantle is not', assist: [] }) });
  await h.chords['Win+Left']('Win+Left');
  await flush();
  show = lastPush(h, 'snap.show');
  check('a refused window puts the reason on the notice', show.mode === 'notice' && /administrator/.test(show.text) && /Could not snap code\.exe/.test(show.title), show);
  check('the notice never takes the keyboard', (() => { const n = h.win.focusCalls; return n === h.win.focusCalls; })());
  h.answers['snap.move'] = () => ({ ok: false, error: 'the sidecar is restarting' });
  await h.chords['Win+Right']('Win+Right');
  await flush();
  show = lastPush(h, 'snap.show');
  check('a sidecar error is a notice too', show.mode === 'notice' && /restarting/.test(show.text));
  h.answers['snap.move'] = () => ({ ok: true, result: moved({ action: 'none', to: 'max', from: 'max', reason: 'nothing to do: code.exe it is already maximized', assist: [] }) });
  const before = h.pushes.length;
  await h.chords['Win+Up']('Win+Up');
  await flush();
  check('"nothing to do" (Win+Up on a maximized window) shows nothing, like Windows', h.pushes.filter((p, i) => i >= before && p.ev === 'snap.show').length === 0);
  h.answers['snap.move'] = () => ({ ok: true, result: moved({ fit: false, fitReason: 'Spotify.exe will not go smaller than 800 x 600 px', assist: [] }) });
  await h.chords['Win+Left']('Win+Left');
  await flush();
  show = lastPush(h, 'snap.show');
  check('an app that will not fit its zone says so', show.mode === 'notice' && /will not go smaller/.test(show.text), show);
  // Snap.cs answers fit "rounded" when an app Windows scales (DPI-unaware) cannot take every pixel
  // of its zone and was put on the nearest frame it can take: in its zone, so no notice.
  h.answers['snap.move'] = () => ({ ok: true, result: moved({ fit: 'rounded',
    fitReason: 'notepad.exe is DPI-unaware, so Windows scales it to 125 % ...; the nearest it can take puts its top edge 1 px inside the zone' }) });
  await h.chords['Win+Left']('Win+Left');
  await flush();
  show = lastPush(h, 'snap.show');
  check('fit "rounded" (a DPI-unaware app 1 px off its zone) is not a "does not fit" notice: Snap Assist opens as usual', show && show.mode === 'assist', show);

  // ---- Win+Z: the picker next to the window, a thirds pick, then Snap Assist walks the rest
  h.answers['snap.info'] = () => ({ ok: true, result: { hwnd: '100', exe: 'code.exe', resizable: true, elevatedAboveMantle: false,
    frame: { x: 200, y: 100, w: 1200, h: 800 }, monitor: { work: { x: 0, y: 0, w: 1920, h: 1080 } } } });
  await h.chords['Win+Z']('Win+Z');
  await flush();
  show = lastPush(h, 'snap.show');
  check('Win+Z opens the picker for the foreground window', show.mode === 'picker' && show.app.exe === 'code.exe' && callsOf(h, 'snap.info').length === 1);
  check('the picker is drawn parked (off screen) before it is revealed', h.win.bounds.y < 0, h.win.bounds);
  await h.cmds.painted({ seq: show.seq, boxes: [], dpr: 1.25, vw: 400, vh: 268, ms: 3 });
  const pb = h.win.bounds;
  check('the picker sits inside the window\'s top-right, on the work area', pb.width === 400 && pb.height === 268 && pb.x + pb.width <= (200 + 1200) / 1.25 && pb.y >= 100 / 1.25, pb);
  h.answers['snap.zone'] = (a) => ({ ok: true, result: moved({ hwnd: a.hwnd, to: 'grid:3x1:0,0,1,1', assist: [
    { zone: { name: 'grid:3x1:1,0,1,1', grid: [3, 1], cell: [1, 0, 1, 1] }, frame: { x: 640, y: 0, w: 640, h: 1080 } },
    { zone: { name: 'grid:3x1:2,0,1,1', grid: [3, 1], cell: [2, 0, 1, 1] }, frame: { x: 1280, y: 0, w: 640, h: 1080 } }] }) });
  await h.cmds.pick({ seq: show.seq, layout: 'thirds', zone: 0 });
  await flush();
  z = callsOf(h, 'snap.zone');
  const zc = z[z.length - 1].args;
  check('a picker zone is snap.zone with the layout\'s grid, cell and the other zones', zc.hwnd === '100' && zc.grid.join() === '3,1' &&
    zc.cell.join() === '0,0,1,1' && zc.rest.length === 2 && zc.rest[1].cell.join() === '2,0,1,1', zc);
  show = lastPush(h, 'snap.show');
  check('Snap Assist follows for the middle third, with one more to come', show.mode === 'assist' && show.zone.name === 'middle third' && show.left === 1, show);
  h.answers['snap.zone'] = (a) => ({ ok: true, result: moved({ hwnd: a.hwnd, to: 'grid:3x1:1,0,1,1', assist: [] }) });
  await h.cmds.pick({ seq: show.seq, hwnd: '200' });
  await flush();
  show = lastPush(h, 'snap.show');
  check('...then the right third, without the window just placed', show.mode === 'assist' && show.zone.name === 'right third' &&
    show.candidates.map((c) => c.hwnd).join() === '300', show);
  await h.cmds.dismiss({ seq: show.seq, why: 'esc' });
  await flush();
  f = callsOf(h, 'focus');
  check('Esc gives the keyboard back to the window the panel was for', f[f.length - 1].args.hwnd === '100', f[f.length - 1]);
  // a fixed-size window: refused before any picker
  h.answers['snap.info'] = () => ({ ok: true, result: { hwnd: '400', exe: 'calc.exe', resizable: false, frame: { x: 0, y: 0, w: 300, h: 400 }, monitor: null } });
  await h.chords['Win+Z']('Win+Z');
  await flush();
  show = lastPush(h, 'snap.show');
  check('Win+Z on a fixed-size window is a notice, not a picker', show.mode === 'notice' && /fixed size/.test(show.text));

  // ---- stop
  h.inst.stop('test');
  check('stop() clears the pictures and destroys its window', h.win.destroyed && h.tset.clears.includes('snap stopped'));

  // ---- --test: never Owen's windows
  const t = makeCtx({ test: true });
  await flush();
  t.answers['snap.move'] = () => ({ ok: true, result: moved() });
  await t.chords['Win+Left']('Win+Left');
  await flush();
  check('--test with no test window: no snap.move at all, and a notice says why', callsOf(t, 'snap.move').length === 0 &&
    /only moves its own test windows/.test((lastPush(t, 'snap.show') || {}).text || ''));
  await t.chords['Win+Z']('Win+Z');
  await flush();
  check('--test Win+Z with no test window: no snap.info either', callsOf(t, 'snap.info').length === 0);
  check('--test never focuses and never parks on screen', !t.win.focusCalls && callsOf(t, 'focus').length === 0);
  t.inst.stop('test');

  // ---- off: the chords do nothing
  const off = makeCtx({ enabled: false });
  await flush();
  await off.chords['Win+Left']('Win+Left');
  check('switched off: a chord that still arrives moves nothing', callsOf(off, 'snap.move').length === 0);
  off.inst.stop('test');

  console.log(`snap feature: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAIL exception ' + e.stack); process.exit(1); });
