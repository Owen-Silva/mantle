'use strict';
/* osd.test.js - lib/features/osd.js's BRIGHTNESS rules on a hand-made ctx and a fake sidecar (osd3,
 * 2026-09-24): Mantle's pop-up shows only for a VERIFIED hidden Windows pop-up, never for 'none',
 * never while quick settings is open, and a failed hide takes Mantle's down without ever calling
 * health(false) (that would hand the volume keys back to Windows too). Plus: the watch follows the
 * tray switch and stop(), and a volume key still takes the unchanged volume road.
 *   node lib/features/osd.test.js
 */
const Module = require('module');

class FakeWin {
  constructor() { this.destroyed = false; this.visible = false; this.webContents = { on() {}, setWindowOpenHandler() {} }; }
  setAlwaysOnTop() {} loadFile() {} setBounds() {} isDestroyed() { return this.destroyed; }
  destroy() { this.destroyed = true; } showInactive() { this.visible = true; } hide() { this.visible = false; }
}
const load = Module._load;
Module._load = function (req) { return req === 'electron' ? { BrowserWindow: FakeWin } : load.apply(this, arguments); };
const feature = require('./osd.js');
// (left in place: install() requires electron when it runs)

let passed = 0; const failures = [];
function check(name, ok, detail) { if (ok) passed++; else failures.push(`${name}${detail ? ` (${String(detail).slice(0, 300)})` : ''}`); }
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 15));

function makeCtx() {
  const t = { sent: [], pushes: [], logs: [], health: [], on: {}, ready: [], chords: {}, enabledFns: [], enabled: true, qsOpen: false };
  t.ctx = {
    name: 'osd', flags: { test: false, live: true }, preload: '',
    log: (s) => t.logs.push(s),
    sidecar: {
      async send(cmd, args) {
        t.sent.push({ cmd, args });
        if (cmd === 'osd.bright') return { ok: true, result: { watching: args.on !== false, reason: args.on === false ? 'switched off' : null, restored: args.on === false ? 1 : 0 } };
        if (cmd === 'osd.qs') return { ok: true, result: { qsOpen: t.qsOpen } };
        if (cmd === 'volume') return { ok: true, result: { level: 30, muted: false } };
        if (cmd === 'osd.volume') return { ok: true, result: { ms: 1, level: 32, muted: false, from: { level: 30, muted: false } } };
        return { ok: false, error: `unknown command ${cmd}` };
      },
      on(ev, fn) { (t.on[ev] = t.on[ev] || []).push(fn); return () => {}; },
      onReady(fn) { t.ready.push(fn); fn(); return () => {}; },
    },
    command() {}, replay() {},
    onChord(k, fn) { t.chords[k] = fn; return () => {}; },
    health(ok, reason) { t.health.push({ ok, reason }); },
    enabled: () => t.enabled,
    onEnabled(fn) { t.enabledFns.push(fn); },
    page: (f) => f || 'index.html',
    push(win, event, payload) { t.pushes.push({ event, payload }); return true; },
    broadcast() {},
    host: { display: () => ({ workArea: { x: 0, y: 0, width: 1536, height: 864 }, bounds: { x: 0, y: 0, width: 1536, height: 864 } }), barRect: () => null },
  };
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

  console.log(`osd feature: ${passed} passed, ${failures.length} failed`);
  failures.forEach((f) => console.log(`  FAIL ${f}`));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.log(`osd feature: CRASHED ${e.stack}`); process.exit(1); });
