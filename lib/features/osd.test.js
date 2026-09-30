'use strict';
/* osd.test.js - lib/features/osd.js's BRIGHTNESS rules on a hand-made ctx and a fake sidecar (osd3,
 * 2026-09-24): Mantle's pop-up shows only for a VERIFIED hidden Windows pop-up, never for 'none',
 * never while quick settings is open, and a failed hide takes Mantle's down without ever calling
 * health(false) (that would hand the volume keys back to Windows too). Plus: the watch follows the
 * tray switch and stop(), and a volume key still takes the unchanged volume road.
 *   node lib/features/osd.test.js
 */
const Module = require('module');

const EventEmitter = require('events');
const fakeScreen = new EventEmitter();
class FakeWin {
  constructor() { FakeWin.last = this; this.destroyed = false; this.visible = false; this.bounds = []; this.skew = 0; this.webContents = { on() {}, setWindowOpenHandler() {} }; }
  setAlwaysOnTop() {} loadFile() {} isDestroyed() { return this.destroyed; }
  setBounds(b) { this.bounds.push(b); const k = this.skew > 0 ? 1.25 : 1; if (this.skew > 0) this.skew--; this.cur = { x: b.x, y: b.y, width: Math.round(b.width * k), height: Math.round(b.height * k) }; }
  getBounds() { return this.cur || { x: 0, y: 0, width: 0, height: 0 }; }
  destroy() { this.destroyed = true; } showInactive() { this.visible = true; } hide() { this.visible = false; }
}
const load = Module._load;
Module._load = function (req) { return req === 'electron' ? { BrowserWindow: FakeWin, screen: fakeScreen } : load.apply(this, arguments); };
const feature = require('./osd.js');
// (left in place: install() requires electron when it runs)

let passed = 0; const failures = [];
function check(name, ok, detail) { if (ok) passed++; else failures.push(`${name}${detail ? ` (${String(detail).slice(0, 300)})` : ''}`); }
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 15));

function makeCtx() {
  const t = { sent: [], pushes: [], logs: [], health: [], on: {}, cmds: {}, ready: [], chords: {}, enabledFns: [], enabled: true, qsOpen: false };
  t.ctx = {
    name: 'osd', flags: { test: false, live: true }, preload: '',
    log: (s) => t.logs.push(s),
    sidecar: {
      async send(cmd, args) {
        t.sent.push({ cmd, args });
        if (cmd === 'osd.bright') return { ok: true, result: { watching: args.on !== false, reason: args.on === false ? 'switched off' : null, restored: args.on === false ? 1 : 0 } };
        if (cmd === 'osd.qs') return { ok: true, result: { qsOpen: t.qsOpen } };
        if (cmd === 'volume') return { ok: true, result: { level: 30, muted: false } };
        if (cmd === 'osd.volume') { if (t.volDelay) await tick(t.volDelay); t.volLevel = (t.volLevel || 30) + 2; return { ok: true, result: { ms: 1, level: t.volLevel, muted: false, from: { level: t.volLevel - 2, muted: false } } }; }
        return { ok: false, error: `unknown command ${cmd}` };
      },
      on(ev, fn) { (t.on[ev] = t.on[ev] || []).push(fn); return () => {}; },
      onReady(fn) { t.ready.push(fn); fn(); return () => {}; },
    },
    command(n, fn) { t.cmds[n] = fn; }, replay() {},
    onChord(k, fn) { t.chords[k] = fn; return () => {}; },
    health(ok, reason) { t.health.push({ ok, reason }); },
    enabled: () => t.enabled,
    onEnabled(fn) { t.enabledFns.push(fn); },
    page: (f) => f || 'index.html',
    push(win, event, payload) { t.pushes.push({ event, payload }); return true; },
    broadcast() {},
    host: { display: () => t.display, barRect: () => t.bar },
  };
  t.display = { workArea: { x: 0, y: 0, width: 1536, height: 864 }, bounds: { x: 0, y: 0, width: 1536, height: 864 } };
  t.bar = null;
  t.fire = async (ev) => { for (const fn of t.on.osd || []) await fn(Object.assign({ ev: 'osd', kind: 'brightness', phase: 'change' }, ev)); await tick(); };
  t.shows = (kind) => t.pushes.filter((p) => p.event === 'osd.show' && (!kind || p.payload.kind === kind));
  return t;
}

(async () => {
  const t = makeCtx();
  const inst = feature.install(t.ctx);
  await tick(40);
  const watchOn = t.sent.find((s) => s.cmd === 'osd.bright' && s.args.on === true);
  check('the brightness watch starts once the sidecar is ready', !!watchOn, JSON.stringify(t.sent));
  const last = t.health[t.health.length - 1];
  check('the note says Windows’ brightness pop-up is replaced', last && last.ok === true && /moved off screen/.test(last.reason), JSON.stringify(last));

  await t.fire({ flyout: 'none', level: 40 });
  check('"none" (no Windows pop-up came with the change): Mantle shows nothing', t.shows().length === 0, JSON.stringify(t.pushes));

  await t.fire({ flyout: 'hidden', level: 60, how: 'parked' });
  const s1 = t.shows('brightness');
  check('"hidden" (verified off screen): Mantle’s pop-up shows the level in brightness mode', s1.length === 1 && s1[0].payload.state.level === 60, JSON.stringify(s1));
  await t.fire({ flyout: 'hidden', level: 70 });
  check('the next step in the same burst moves Mantle’s pop-up to the new level', t.shows('brightness').length === 2 && t.shows('brightness')[1].payload.state.level === 70);

  t.qsOpen = true;
  await t.fire({ flyout: 'hidden', level: 80 });
  check('quick settings open: no pop-up (the panel shows the level)', t.shows('brightness').length === 2 && t.logs.some((l) => /quick-settings panel is open/.test(l)), JSON.stringify(t.logs.slice(-2)));
  t.qsOpen = false;

  const nHealth = t.health.length;
  await t.fire({ flyout: 'failed', level: 80, reason: 'it stayed on screen' });
  check('"failed": Mantle’s brightness pop-up is taken down at once (never two)', t.pushes.some((p) => p.event === 'osd.hide'), JSON.stringify(t.pushes.slice(-2)));
  const h = t.health.slice(nHealth);
  check('"failed" never calls health(false) (the volume keys stay Mantle’s) and the note says why',
    h.length >= 1 && h.every((x) => x.ok === true) && /it stayed on screen/.test(h[h.length - 1].reason), JSON.stringify(h));
  await t.fire({ flyout: 'hidden', level: 50 });
  check('a later verified hide clears the failure from the note', /moved off screen/.test(t.health[t.health.length - 1].reason));

  await t.fire({ phase: 'end', flyout: 'hidden', summary: 'hidden (parked), off screen 3 ms after Windows showed it' });
  check('a session end is one log line with the measurement', t.logs.some((l) => /brightness pop-up: hidden \(parked\), off screen 3 ms/.test(l)), JSON.stringify(t.logs.slice(-2)));
  const nPush = t.pushes.length;
  await t.fire({ phase: 'end', flyout: 'failed', moves: 7, reshows: 0, answers: 8, worstOnScreenMs: 31.2,
    summary: 'failed (parked), off screen 6.8 ms after Windows showed it, 16 change(s), explorer moved it back 7x, re-showed 0x, Mantle answered 8x (worst 31.2 ms on screen, 44 ms in all); gave up: Windows’ brightness pop-up was on screen 31.2 ms before moving it off took effect (the limit is 30 ms); ended: Windows hid it' });
  check('a failed burst is one log line: moves, re-shows, answers, the worst on-screen span and why it gave up',
    t.logs.some((l) => /^brightness pop-up: failed .*moved it back 7x, re-showed 0x, Mantle answered 8x \(worst 31\.2 ms on screen.*gave up: .*limit is 30 ms/.test(l)), JSON.stringify(t.logs.slice(-1)));
  check('a burst END is a log line only: it never shows or hides Mantle’s pop-up', t.pushes.length === nPush, JSON.stringify(t.pushes.slice(nPush)));

  const nShow = t.shows().length;
  await t.fire({ flyout: 'dry', level: 30, simulated: true });
  check('"dry" (--test / passive) logs the dry run and still draws the page', t.shows().length === nShow + 1 && t.logs.some((l) => /dry run \(--test\)/.test(l)));

  // the volume road is untouched: a key steps through osd.volume and shows kind 'volume'
  await t.chords.VolumeUp('VolumeUp');
  await tick(30);
  check('a volume key still steps osd.volume and shows the volume pop-up', t.sent.some((s) => s.cmd === 'osd.volume' && s.args.op === 'up') && t.shows('volume').length >= 1);

  t.enabled = false;
  for (const fn of t.enabledFns) await fn(false);
  check('tray switch off: the watch stops (the sidecar puts the parked window back)', t.sent.some((s) => s.cmd === 'osd.bright' && s.args.on === false));
  const nb = t.shows('brightness').length;
  await t.fire({ flyout: 'hidden', level: 20 });
  check('switched off: no pop-up', t.shows('brightness').length === nb);
  t.enabled = true;
  for (const fn of t.enabledFns) await fn(true);

  const nOff = t.sent.filter((s) => s.cmd === 'osd.bright' && s.args.on === false).length;
  const p = inst.stop('test');
  check('stop() returns a promise (the seam waits up to 2.5 s)', p && typeof p.then === 'function');
  await p;
  check('stop(): the watch stops and puts the window back', t.sent.filter((s) => s.cmd === 'osd.bright' && s.args.on === false).length === nOff + 1 && t.logs.some((l) => /stop: brightness watch off, 1 window/.test(l)), JSON.stringify(t.logs.slice(-1)));

  // ======== capture-osd quality pass (2026-09-29): holes, each failed before its fix ========
  {
    const u = makeCtx();
    const inst2 = feature.install(u.ctx);
    const win = FakeWin.last;
    await tick(40);
    const lastShow = () => u.shows().slice(-1)[0];

    // 1. THE FADE RACE. The page fades and sends osd.faded while main is already pushing the next
    //    key's osd.show: a stale "faded" landing after that show hid the window under a pop-up the
    //    page had just drawn, so that key showed nothing.
    await u.chords.VolumeUp('VolumeUp'); await tick(20);
    const seq1 = lastShow().payload.seq;
    check('osd.show carries a sequence number the page echoes back', typeof seq1 === 'number', JSON.stringify(lastShow().payload));
    await u.chords.VolumeUp('VolumeUp'); await tick(20);
    const seq2 = lastShow().payload.seq;
    check('each show gets a newer sequence number', seq2 > seq1, `${seq1} -> ${seq2}`);
    await u.cmds.faded({ seq: seq1 });
    check('a "faded" for an OLDER show is ignored: the window stays up for the newer one', win.visible === true && (await u.cmds.state()).shown === true);
    await u.cmds.faded({ seq: seq2 });
    check('a "faded" for the newest show hides the window', win.visible === false && (await u.cmds.state()).shown === false);
    await u.chords.VolumeUp('VolumeUp'); await tick(20);
    await u.cmds.faded({});
    check('a "faded" with no sequence (an older page) still hides it', win.visible === false);

    // 2. A LATE WATCH EVENT during a held key. The sidecar's volume watch reports levels a beat
    //    behind the steps: an older level pushed mid-burst made the number jump back, then forward.
    u.volDelay = 30;
    const p1 = u.chords.VolumeUp('VolumeUp');
    await tick(5);
    const before = u.pushes.length;
    for (const fn of u.on.volume || []) fn({ ev: 'volume', ok: true, level: 10, muted: false });
    const stale = u.pushes.slice(before).filter((x) => x.event === 'osd.level' && x.payload.state.level === 10);
    check('a watch reading that lands while a key step is in flight is not drawn (no jump back)', stale.length === 0, JSON.stringify(u.pushes.slice(before)));
    await p1; u.volDelay = 0;
    const after = u.pushes.slice(before).filter((x) => x.event === 'osd.level');
    check('...the step\'s own result is drawn when it lands', after.length >= 1 && after[after.length - 1].payload.state.level === u.volLevel, JSON.stringify(after));
    await tick(380);
    check('...and once the burst settles the watch\'s newest reading has the last word (another app, a device)',
      u.pushes.slice(before).filter((x) => x.event === 'osd.level').slice(-1)[0].payload.state.level === 10, JSON.stringify(u.pushes.slice(-1)));
    const n0 = u.pushes.length;
    for (const fn of u.on.volume || []) fn({ ev: 'volume', ok: true, level: 44, muted: false });
    check('with no step in flight a watch reading (another app, a device) is drawn at once',
      u.pushes.slice(n0).some((x) => x.event === 'osd.level' && x.payload.state.level === 44));

    // 3. WHICH DISPLAY. The pop-up goes to the display under the cursor; the bar is on one display.
    u.display = { workArea: { x: 1536, y: 0, width: 1920, height: 1040 }, bounds: { x: 1536, y: 0, width: 1920, height: 1080 } };
    u.bar = { x: 400, y: 812, width: 736, height: 44 };
    await u.cmds.show({}); await tick(5);
    const b3 = win.bounds[win.bounds.length - 1];
    check('second display: centred on it, near its bottom (not at the other display\'s bar height)',
      b3.x > 1536 && b3.y > 1040 - b3.height - 60 && b3.y + b3.height <= 1040, JSON.stringify(b3));
    u.display = { workArea: { x: 0, y: 28, width: 1536, height: 836 }, bounds: { x: 0, y: 0, width: 1536, height: 864 } };

    // 4. MIXED DPI. Electron can scale a window's size when setBounds moves it onto a display
    //    with another scale factor; the pop-up then drew clipped or with a band of margin.
    win.skew = 1;
    await u.cmds.show({}); await tick(5);
    const got = win.getBounds(), want = win.bounds[win.bounds.length - 1];
    check('a size Windows rescaled on the way to another display is set again', got.width === want.width && got.height === want.height && win.bounds.length >= 2, JSON.stringify({ got, want }));

    // 5. A DISPLAY CHANGE while it is up (resolution, scale, a monitor unplugged): re-placed.
    const nb = win.bounds.length;
    u.display = { workArea: { x: 0, y: 0, width: 1280, height: 720 }, bounds: { x: 0, y: 0, width: 1280, height: 720 } };
    fakeScreen.emit('display-metrics-changed');
    fakeScreen.emit('display-removed');
    await tick(5);
    const b5 = win.bounds[win.bounds.length - 1];
    check('a display change while it is up re-places it inside the new display', win.bounds.length > nb && b5.x + b5.width <= 1280 && b5.y + b5.height <= 720, JSON.stringify(b5));

    // 6. A RENDERER'S "show" is checked before it reaches the page.
    const nS = u.shows().length;
    await u.cmds.show({ state: { ok: true, level: 'x<script>', muted: 'yes', reason: { a: 1 } }, via: { evil: 1 } });
    const sp = u.shows().slice(nS)[0];
    check('show: a malformed level from a page falls back to the real reading',
      sp && (sp.payload.state.level === null || typeof sp.payload.state.level === 'number') && typeof sp.payload.via === 'string', JSON.stringify(sp && sp.payload));
    await u.cmds.show({ state: { ok: true, level: 250, muted: 1 } });
    const sp2 = u.shows().slice(-1)[0];
    check('show: a level is clamped to 0-100 and muted is a boolean', sp2.payload.state.level === 100 && sp2.payload.state.muted === true, JSON.stringify(sp2.payload));

    // 6b. NO BRIGHTNESS CONTROL (a desktop, an external monitor only): WMI refuses the watch; the
    //     note says so in words, not "ManagementException: Not supported".
    {
      const d = makeCtx();
      const send0 = d.ctx.sidecar.send;
      d.ctx.sidecar.send = async (cmd, args) => cmd === 'osd.bright' && args.on
        ? { ok: true, result: { watching: false, reason: 'brightness changes cannot be watched (WMI: ManagementException: Not supported)' } }
        : send0(cmd, args);
      const i3 = feature.install(d.ctx);
      await tick(40);
      const h3 = d.health[d.health.length - 1];
      check('no brightness control: the note says the screen has none, in plain words (no WMI jargon)',
        h3 && h3.ok === true && /no brightness control/.test(h3.reason) && !/WMI|Exception/.test(h3.reason), JSON.stringify(h3));
      await i3.stop('test');
    }

    // 7. stop() frees what it took: the display listeners, the timers, the window.
    await inst2.stop('test');
    check('stop(): the display listeners are removed', fakeScreen.listenerCount('display-metrics-changed') === 0 && fakeScreen.listenerCount('display-removed') === 0 && fakeScreen.listenerCount('display-added') === 0,
      `${fakeScreen.listenerCount('display-metrics-changed')}/${fakeScreen.listenerCount('display-removed')}`);
    check('stop(): the window is destroyed', win.destroyed === true);
    const nq = u.pushes.length;
    await u.chords.VolumeUp('VolumeUp');
    for (const fn of u.on.volume || []) fn({ ev: 'volume', ok: true, level: 12, muted: false });
    fakeScreen.emit('display-metrics-changed');
    check('after stop(): a late key, reading or display change does nothing', u.pushes.length === nq, JSON.stringify(u.pushes.slice(nq)));
  }

  console.log(`osd feature: ${passed} passed, ${failures.length} failed`);
  failures.forEach((f) => console.log(`  FAIL ${f}`));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.log(`osd feature: CRASHED ${e.stack}`); process.exit(1); });
