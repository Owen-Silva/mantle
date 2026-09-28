'use strict';
/*
 * timer.test.js - the top bar's timer and stopwatch (lane tbtimer): _timer-core.js (pure) and the
 * feature (timer.js) driven with a fake ctx, a fake clock, fake timers and a fake Electron. Plain
 * node, no Electron, no window, NO SOUND (the fake shell.beep only counts).
 *   node lib/features/timer.test.js     -> one summary line "TIMER: N passed, M failed"
 */
const path = require('path');
const { EventEmitter } = require('events');
const C = require('./_timer-core');
const hub = require('./_tools-hub');
const mod = require('./timer');
const { validate } = require('../features');

const ROOT = path.resolve(__dirname, '..', '..');
const MIN = 60000, SEC = 1000, HOUR = 3600000;
let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else { failures.push(name); console.log(`FAIL ${name}${detail !== undefined ? `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`); }
}
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), { got, want });

/* ---- pure: parsing ---- */
function parsing() {
  const ms = (t) => { const r = C.parseDuration(t); return r.ok ? r.ms : r.reason; };
  eq('parse "12" = 12 min', ms('12'), 12 * MIN);
  eq('parse "90" = 90 min', ms('90'), 90 * MIN);
  eq('parse "1:30" = 1 h 30 min', ms('1:30'), 90 * MIN);
  eq('parse "0:45" = 45 min', ms('0:45'), 45 * MIN);
  eq('parse "2.5" = 2 min 30 s', ms('2.5'), 150 * SEC);
  eq('parse "45s"', ms('45s'), 45 * SEC);
  eq('parse "10m"', ms('10m'), 10 * MIN);
  eq('parse "10 min"', ms('10 min'), 10 * MIN);
  eq('parse "1h"', ms('1h'), HOUR);
  eq('parse "1h30"', ms('1h30'), 90 * MIN);
  eq('parse "1h 30m"', ms('1h 30m'), 90 * MIN);
  eq('parse "1 h 30 min"', ms('1 h 30 min'), 90 * MIN);
  eq('parse " 25 " (spaces)', ms(' 25 '), 25 * MIN);
  eq('parse "24:00" = exactly 24 h (allowed)', ms('24:00'), 24 * HOUR);
  eq('parse "abc" is junk', ms('abc'), C.REASONS.junk);
  eq('parse "" is junk', ms(''), C.REASONS.junk);
  eq('parse null is junk', ms(null), C.REASONS.junk);
  eq('parse "0" needs at least 1 s', ms('0'), 'A timer needs at least 1 second');
  eq('parse "0:00" needs at least 1 s', ms('0:00'), 'A timer needs at least 1 second');
  eq('parse "25:00" is over 24 h', ms('25:00'), 'A timer can run up to 24 hours');
  eq('parse "1:75" is junk (minutes 0-59)', ms('1:75'), C.REASONS.junk);
  eq('parse "30m 1h" is junk (biggest unit first)', ms('30m 1h'), C.REASONS.junk);
  eq('parse "5 lightyears" is junk', ms('5 lightyears'), C.REASONS.junk);
  eq('parse "10 20" is junk', ms('10 20'), C.REASONS.junk);
  eq('parse "-5" is junk', ms('-5'), C.REASONS.junk);
  eq('parse "25" label', C.parseDuration('25').label, '25 min');
  eq('checkMs rounds to whole seconds', C.checkMs(61499).ms, 61 * SEC);
  eq('checkMs(0) needs at least 1 s', C.checkMs(0).reason, 'A timer needs at least 1 second');
}

/* ---- pure: labels and clocks ---- */
function formatting() {
  eq('labelFor 25 min', C.labelFor(25 * MIN), '25 min');
  eq('labelFor 1 h 30 min', C.labelFor(90 * MIN), '1 h 30 min');
  eq('labelFor 45 s', C.labelFor(45 * SEC), '45 s');
  eq('labelFor 2 min 30 s', C.labelFor(150 * SEC), '2 min 30 s');
  eq('labelFor 1 h', C.labelFor(HOUR), '1 h');
  eq('countdown 18:42', C.formatClock(18 * MIN + 42 * SEC), '18:42');
  eq('countdown ceil: 18:41.2 left shows 18:42', C.formatClock(18 * MIN + 41200), '18:42');
  eq('countdown 4:05', C.formatClock(4 * MIN + 5 * SEC), '4:05');
  eq('countdown 0:05', C.formatClock(5 * SEC), '0:05');
  eq('countdown 0 -> 0:00', C.formatClock(0), '0:00');
  eq('countdown 1 ms -> 0:01 (ceil)', C.formatClock(1), '0:01');
  eq('countdown never negative', C.formatClock(-5000), '0:00');
  eq('countdown 59.4 s -> 1:00 (ceil)', C.formatClock(59400), '1:00');
  eq('stopwatch 59.4 s -> 0:59 (floor)', C.formatClock(59400, true), '0:59');
  eq('countdown 1:05:03', C.formatClock(HOUR + 5 * MIN + 3 * SEC), '1:05:03');
  eq('countdown exactly 1 h -> 1:00:00', C.formatClock(HOUR), '1:00:00');
  eq('countdown 59:59.5 -> 1:00:00 (ceil crosses the hour)', C.formatClock(HOUR - 500), '1:00:00');
  eq('stopwatch 59:59.5 -> 59:59 (floor)', C.formatClock(HOUR - 500, true), '59:59');
  eq('stopwatch never negative', C.formatClock(-1, true), '0:00');
  const d = new Date(2026, 8, 27, 21, 14, 30).getTime();
  eq('timeOfDay 21:14 -> 9:14 PM (the bar clock\'s shape)', C.timeOfDay(d), '9:14 PM');
  eq('timeOfDay 00:05 -> 12:05 AM', C.timeOfDay(new Date(2026, 8, 27, 0, 5).getTime()), '12:05 AM');
}

/* ---- pure: state math ---- */
function stateMath() {
  const t0 = 1000000;
  let s = C.startTimer(t0, 25 * MIN);
  eq('startTimer', s, { kind: 'timer', endAt: t0 + 25 * MIN, totalMs: 25 * MIN, label: '25 min', startedAt: t0 });
  eq('leftMs running', C.leftMs(s, t0 + MIN), 24 * MIN);
  const p = C.pause(s, t0 + 10 * MIN);
  eq('pause keeps what is left', p, { kind: 'timer', paused: true, leftMs: 15 * MIN, totalMs: 25 * MIN, label: '25 min', startedAt: t0 });
  eq('leftMs paused does not move', C.leftMs(p, t0 + 99 * MIN), 15 * MIN);
  check('pause of a paused state is a no-op', C.pause(p, t0) === p);
  const r = C.resume(p, t0 + 60 * MIN);
  eq('resume sets a new end', r.endAt, t0 + 75 * MIN);
  check('resume of a running state is a no-op', C.resume(r, t0) === r);
  const a = C.addTime(r, t0 + 60 * MIN, 5 * MIN);
  eq('addTime +5 min on a running timer', [a.endAt, a.totalMs, a.label], [t0 + 80 * MIN, 30 * MIN, '30 min']);
  const ap = C.addTime(p, t0, MIN);
  eq('addTime on a paused timer', [ap.leftMs, ap.totalMs, ap.paused], [16 * MIN, 26 * MIN, true]);
  const custom = C.addTime(C.startTimer(t0, 10 * MIN, 'Tea'), t0, MIN);
  eq('addTime keeps a custom label', custom.label, 'Tea');
  eq('addTime caps what is left at 24 h', C.leftMs(C.addTime(s, t0, 48 * HOUR), t0), 24 * HOUR);
  eq('addTime never below 0', C.leftMs(C.addTime(s, t0, -99 * HOUR), t0), 0);
  const sw = C.startStopwatch(t0);
  eq('stopwatch elapsed', C.elapsedMs(sw, t0 + 3500), 3500);
  const swp = C.pause(sw, t0 + 3500);
  eq('stopwatch pause', swp, { kind: 'stopwatch', paused: true, elapsedMs: 3500 });
  eq('stopwatch resume keeps the elapsed time', C.elapsedMs(C.resume(swp, t0 + 10000), t0 + 10000), 3500);
  eq('stopwatch resume startAt = now - elapsed', C.resume(swp, t0 + 10000).startAt, t0 + 6500);
  // nextTickMs
  eq('nextTick: 5000 left -> 1000 (shows 0:05 until 4000 left)', C.nextTickMs(C.startTimer(0, 5000), 0), 1000);
  eq('nextTick: 4500 left -> 500', C.nextTickMs(C.startTimer(0, 5000), 500), 500);
  eq('nextTick: 1 ms left -> 1', C.nextTickMs(C.startTimer(0, 5000), 4999), 1);
  eq('nextTick: ended -> null', C.nextTickMs(C.startTimer(0, 5000), 5000), null);
  eq('nextTick: stopwatch at 3500 -> 500', C.nextTickMs(sw, t0 + 3500), 500);
  eq('nextTick: stopwatch at 0 -> 1000', C.nextTickMs(sw, t0), 1000);
  eq('nextTick: paused -> null', C.nextTickMs(p, t0), null);
  eq('nextTick: idle -> null', C.nextTickMs({ kind: 'idle' }, t0), null);
}

/* ---- pure: restore ---- */
function restoring() {
  const t = 5000000;
  const past = C.restore({ kind: 'timer', endAt: t - 1000, totalMs: 25 * MIN, label: '25 min', startedAt: t - 25 * MIN - 1000 }, t);
  eq('restore: ended in the past -> idle + fired whileOff', [past.st, past.fired], [{ kind: 'idle' }, { label: '25 min', totalMs: 25 * MIN, endAt: t - 1000, whileOff: true }]);
  const again = C.restore(past.st, t + 1000);
  eq('restore: the saved idle state never fires again', [again.st.kind, again.fired], ['idle', null]);
  const fut = C.restore({ kind: 'timer', endAt: t + MIN, totalMs: 25 * MIN, label: '25 min', startedAt: t - MIN }, t);
  eq('restore: future end -> running', [fut.st.kind, fut.st.endAt, fut.fired], ['timer', t + MIN, null]);
  const pz = C.restore({ kind: 'timer', paused: true, leftMs: 3 * MIN, totalMs: 25 * MIN, label: 'x', startedAt: 1 }, t);
  eq('restore: paused stays paused', [pz.st.paused, pz.st.leftMs], [true, 3 * MIN]);
  const sw = C.restore({ kind: 'stopwatch', startAt: t - 7000 }, t);
  eq('restore: a stopwatch carries on', C.elapsedMs(sw.st, t), 7000);
  const swp = C.restore({ kind: 'stopwatch', paused: true, elapsedMs: 42 }, t);
  eq('restore: a paused stopwatch', swp.st, { kind: 'stopwatch', paused: true, elapsedMs: 42 });
  for (const [what, junk] of [['a string', 'hello'], ['an unknown kind', { kind: 'egg' }], ['a timer with no end', { kind: 'timer', totalMs: 1000 }],
    ['a timer with no length', { kind: 'timer', endAt: t + 1 }], ['an array', [1, 2]], ['a stopwatch with no start', { kind: 'stopwatch' }]]) {
    const r = C.restore(junk, t);
    check(`restore: ${what} -> idle + a reason`, r.st.kind === 'idle' && !r.fired && /could not be read/.test(r.reason || ''), r);
  }
  eq('restore: nothing saved -> idle, no reason', C.restore(null, t), { st: { kind: 'idle' }, fired: null, reason: null });
}

/* ---- the feature, with fakes ---- */
function fakeTimers() {
  const T = { list: new Map(), seq: 0 };
  T.setTimeout = (fn, ms) => { const h = { id: ++T.seq, fn, ms, unref() {} }; T.list.set(h.id, h); return h; };
  T.clearTimeout = (h) => { if (h) T.list.delete(h.id); };
  T.pending = () => Array.from(T.list.values());
  T.run = (h) => { T.list.delete(h.id); h.fn(); };
  return T;
}
function fakeElectron() {
  const E = { wins: [], beeps: 0, powerMonitor: new EventEmitter() };
  E.BrowserWindow = class {
    constructor(o) {
      this.opts = o; this.destroyed = false; this.shown = 0; this.focused = 0; this.pushed = []; this.aot = [];
      const wc = new EventEmitter();
      wc.setWindowOpenHandler = (f) => { wc.openHandler = f; };
      wc.isDestroyed = () => this.destroyed;
      this.webContents = wc;
      E.wins.push(this);
    }
    setAlwaysOnTop(a, b) { this.aot.push([a, b]); }
    hide() { this.hidden = true; }
    showInactive() { this.shown++; }
    focus() { this.focused++; }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
    loadFile(f) { this.file = f; return Promise.resolve(); }
  };
  E.screen = { getPrimaryDisplay: () => ({ bounds: { x: 0, y: 0, width: 1536, height: 864 } }) };
  E.shell = { beep: () => { E.beeps++; } };
  return E;
}
function fakeCtx(o) {
  o = o || {};
  const store = o.store || {};
  const c = {
    name: 'timer', flags: Object.freeze({ test: o.test !== false, live: o.test === false }),
    lines: [], events: [], healths: [], commands: {}, replays: {}, enabledFns: [], on: o.on !== false, failSave: null, store,
    log: (t) => c.lines.push(String(t)),
    health: (ok, reason) => c.healths.push({ ok, reason }),
    command: (verb, fn) => { c.commands[verb] = fn; return `timer.${verb}`; },
    broadcast: (e, p) => c.events.push([e, JSON.parse(JSON.stringify(p))]),
    push: (win, e, p) => { if (!win || win.isDestroyed()) return false; win.pushed.push([e, p]); return true; },
    replay: (e, fn) => { c.replays[e] = fn; },
    enabled: () => c.on,
    onEnabled: (fn) => { c.enabledFns.push(fn); },
    page: (f) => path.join(ROOT, 'ui', 'timer', f || 'index.html'),
    preload: path.join(ROOT, 'preload.js'),
    settings: {
      get: (k, d) => (k in store ? JSON.parse(JSON.stringify(store[k])) : d),
      set: (k, v) => { if (c.failSave) throw new Error(c.failSave); store[k] = JSON.parse(JSON.stringify(v)); },
    },
  };
  c.call = (verb, a) => c.commands[verb](a || {});
  c.last = () => c.events.filter((e) => e[0] === 'timer.state').pop()[1];
  c.logged = (re) => c.lines.some((l) => re.test(l));
  return c;
}
function boot(o) {
  o = o || {};
  hub.known = o.known !== false; hub.resting = null; hub.since = null;
  const T = fakeTimers(), E = fakeElectron();
  const clock = { t: o.t || 1000000 };
  mod._inject = { electron: E, setTimeout: T.setTimeout, clearTimeout: T.clearTimeout, now: o.fakeClock ? () => clock.t : null };
  const ctx = fakeCtx(o);
  const handle = mod.install(ctx);
  const H = hub.test.timer;
  if (H) H.now(() => clock.t);
  return { ctx, T, E, clock, handle, H };
}
const armed = (T) => T.pending().filter((h) => h.ms !== 120000);
const tick = () => new Promise((r) => setImmediate(r));

async function feature() {
  check('contract: timer.js passes lib/features.js validate()', validate(mod, 'timer') === null, validate(mod, 'timer'));
  check('contract: no rest flag (it must run while Mantle rests)', mod.rest === undefined && mod.defaultOn === true && mod.chords.length === 0);

  /* start -> one timeout at the right delay -> fire -> done + pop-up */
  {
    const { ctx, T, E, clock, handle, H } = boot();
    check('hooks: hub.test.timer is set in --test', !!H && typeof H.fire === 'function');
    check('install: healthy', ctx.healths.length && ctx.healths[ctx.healths.length - 1].ok === true);
    check('install: timer.state replays', typeof ctx.replays['timer.state'] === 'function' && ctx.replays['timer.state']().kind === 'idle');
    eq('idle: no timeout at all', T.pending().length, 0);
    let r = await ctx.call('start', { text: '25' });
    check('start "25": ok + the view', r.ok && r.kind === 'timer' && r.endAt === clock.t + 25 * MIN && r.label === '25 min' && r.lastMs === 25 * MIN, r);
    eq('start: ONE timeout armed at 25 min', armed(T).map((h) => h.ms), [25 * MIN]);
    eq('start: saved', ctx.store.clock.kind, 'timer');
    check('start: timer.state broadcast', ctx.last().kind === 'timer' && ctx.last().leftMs === 25 * MIN);
    clock.t += 5 * MIN;
    r = await ctx.call('start', { text: '10', label: 'Tea' });
    eq('restart: still ONE timeout, at 10 min', armed(T).map((h) => h.ms), [10 * MIN]);
    check('restart: the log says it replaced the running one', ctx.logged(/a Tea timer replaces the 25 min timer \(20:00 left\)/), ctx.lines);
    r = await ctx.call('start', { text: 'abc' });
    eq('start junk: refused in plain words', r, { ok: false, reason: C.REASONS.junk });
    eq('start junk: the running timer is untouched', armed(T).length, 1);
    r = await ctx.call('pause');
    check('pause: no timeout while paused', r.ok && r.paused && armed(T).length === 0 && r.leftMs === 10 * MIN, r);
    clock.t += 30 * MIN;
    r = await ctx.call('resume');
    check('resume: one timeout for what was left', r.ok && armed(T).length === 1 && armed(T)[0].ms === 10 * MIN, r);
    r = await ctx.call('add', { ms: MIN });
    check('add 1 min: re-armed at 11 min', r.ok && armed(T).length === 1 && armed(T)[0].ms === 11 * MIN && r.totalMs === 11 * MIN, r);
    clock.t += 11 * MIN - 5;
    T.run(armed(T)[0]);
    check('an early timeout re-arms for the rest (5 ms)', armed(T).length === 1 && armed(T)[0].ms === 5, T.pending());
    clock.t += 5;
    T.run(armed(T)[0]);
    const v = ctx.last();
    check('at zero: done + idle', v.kind === 'idle' && v.done && v.done.label === 'Tea' && v.done.popup === 'shown' && !v.done.whileOff, v);
    check('at zero: logged "done (Tea)"', ctx.logged(/^done \(Tea\)$/), ctx.lines);
    eq('at zero: saved idle', ctx.store.clock, { kind: 'idle' });
    eq('at zero: one pop-up window', E.wins.length, 1);
    const w = E.wins[0];
    const op = w.opts;
    check('pop-up: frameless, transparent, skipTaskbar, never focusable, no shadow, fixed', op.frame === false && op.transparent === true && op.skipTaskbar === true
      && op.focusable === false && op.hasShadow === false && op.resizable === false && op.movable === false && op.show === false, op);
    check('pop-up: webPreferences (preload, isolation, sandbox, no node, autoplay)', op.webPreferences.preload === ctx.preload && op.webPreferences.contextIsolation === true
      && op.webPreferences.sandbox === true && op.webPreferences.nodeIntegration === false && op.webPreferences.autoplayPolicy === 'no-user-gesture-required', op.webPreferences);
    eq('pop-up: the card lands 8 DIP from the right, 6 DIP under the 28 DIP bar', [op.x + 12, op.y + 6, op.width - 24, op.height - 24], [1536 - 8 - 320, 34, 320, 84]);
    check('pop-up: loads ui/timer/index.html', w.file === path.join(ROOT, 'ui', 'timer', 'index.html'), w.file);
    check('pop-up: navigation refused, new windows denied', typeof w.webContents.openHandler === 'function' && w.webContents.openHandler().action === 'deny' && w.webContents.listenerCount('will-navigate') === 1);
    w.webContents.emit('did-finish-load');
    const pushed = w.pushed.find((p) => p[0] === 'timer.done');
    check('pop-up: timer.done pushed after load, muted in --test', pushed && pushed[1].label === 'Tea' && pushed[1].mute === true && pushed[1].closeInMs === 120000 && pushed[1].during === null, w.pushed);
    check('--test: the pop-up is NEVER shown, never focused, not on top', w.shown === 0 && w.focused === 0 && w.aot.length === 0 && op.alwaysOnTop === false);
    check('hook popup() returns the window', H.popup() === w);
    r = await ctx.call('chime', { ok: true, muted: true, reason: 'muted in --test' });
    eq('chime report: muted', [r.done.sound, r.done.soundReason], ['muted', 'muted in --test']);
    r = await ctx.call('again');
    check('again (from the pop-up): hidden at once, destroyed on the next turn (its reply goes out first)', w.hidden === true && !w.destroyed);
    await tick();
    check('again: a new Tea timer of 11 min, the pop-up destroyed', r.ok && r.kind === 'timer' && r.label === 'Tea' && r.totalMs === 11 * MIN && w.destroyed && r.done === null, r);
    r = await ctx.call('stopwatch');
    check('stopwatch replaces the timer: no timeout, logged', r.ok && r.kind === 'stopwatch' && armed(T).length === 0 && ctx.logged(/a stopwatch replaces the Tea timer/), ctx.lines.slice(-2));
    clock.t += 3500;
    r = await ctx.call('state');
    eq('stopwatch: elapsed from the fake clock', r.elapsedMs, 3500);
    r = await ctx.call('add', { ms: MIN });
    check('add on a stopwatch: refused', r.ok === false && /Only a running or paused timer/.test(r.reason), r);
    r = await ctx.call('cancel');
    check('cancel: idle', r.ok && r.kind === 'idle' && ctx.store.clock.kind === 'idle');
    r = await ctx.call('cancel');
    check('cancel when idle: refused in words', r.ok === false && /No timer or stopwatch/.test(r.reason));
    // dismiss + the 2 minute close
    await ctx.call('start', { ms: 3000 });
    clock.t += 3000; H.fire();
    const w2 = E.wins[E.wins.length - 1];
    r = await ctx.call('dismiss');
    await tick();
    check('dismiss: the pop-up destroyed, done cleared', r.ok && r.dismissed === true && w2.destroyed && r.done === null);
    await ctx.call('start', { ms: 3000 });
    clock.t += 3000; T.run(armed(T)[0]);
    const kill = T.pending().find((h) => h.ms === 120000);
    check('the pop-up closes itself after DONE_MS (2 min)', !!kill);
    T.run(kill);
    check('after 2 min: destroyed, done cleared, logged', E.wins[E.wins.length - 1].destroyed && ctx.last().done === null && ctx.logged(/closed itself after 2 min/));
    // a crashed page
    await ctx.call('start', { ms: 3000 });
    clock.t += 3000; H.fire();
    const w3 = E.wins[E.wins.length - 1];
    w3.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    const vf = ctx.last();
    check('a crashed pop-up: done.popup failed + reason, window gone, state sent', vf.done && vf.done.popup === 'failed' && /crashed \(crashed\)/.test(vf.done.reason) && w3.destroyed, vf.done);
    check('a failed pop-up beeps instead (counted, muted in --test)', H.beeps() === 1 && E.beeps === 0 && ctx.logged(/would beep \(muted in --test\)/));
    // powerMonitor 'resume' (a sleep made the timeout late)
    await ctx.call('start', { ms: 10 * MIN });
    clock.t += 20 * MIN;
    const before = E.wins.length;
    E.powerMonitor.emit('resume');
    check('wake from sleep past the end: fires at once', ctx.last().done && ctx.last().done.popup === 'shown' && E.wins.length === before + 1 && armed(T).length === 0,
      { done: ctx.last().done, wins: E.wins.length, before, armed: armed(T).map((h) => h.ms), lines: ctx.lines.slice(-3) });
    // switched off in the tray
    await ctx.call('start', { ms: 10 * MIN });
    ctx.on = false; ctx.enabledFns.forEach((f) => f(false));
    check('switched off: the timer is cancelled with a log line, pop-up gone', ctx.last().kind === 'idle' && armed(T).length === 0 && ctx.logged(/switched off in the tray: cancelled/));
    r = await ctx.call('start', { text: '5' });
    check('switched off: start refused in words', r.ok === false && /switched off/.test(r.reason));
    ctx.on = true;
    handle.stop('test over');
    check('stop: hooks removed, no timers left', hub.test.timer === undefined && T.pending().length === 0);
  }

  /* at zero during a game: held, one beep, no window; the game ends -> the pop-up with `during` */
  {
    const { ctx, T, E, clock, handle, H } = boot();
    H.setResting('VALORANT.exe runs');
    eq('view: resting words', ctx.last().resting, 'VALORANT.exe runs');
    await ctx.call('start', { text: '1' });
    clock.t += MIN; T.run(armed(T)[0]);
    const v = ctx.last();
    check('during a game: held, done.popup held, NO window', v.held === true && v.done.popup === 'held' && E.wins.length === 0, v);
    check('during a game: ONE beep (counted; muted in --test), logged', H.beeps() === 1 && E.beeps === 0
      && ctx.logged(/done during a game \(VALORANT\.exe runs\): beeped once; the pop-up waits for the game to end/), ctx.lines);
    H.setResting('resting while VALORANT.exe runs');
    check('still resting (other words): still held, no window', ctx.last().held === true && E.wins.length === 0);
    H.setResting(null);
    const v2 = ctx.last();
    check('the game ended: the pop-up shows, held cleared, during set', v2.held === false && v2.done.popup === 'shown' && v2.done.during === 'VALORANT.exe ran' && E.wins.length === 1, v2);
    E.wins[0].webContents.emit('did-finish-load');
    const p = E.wins[0].pushed.find((x) => x[0] === 'timer.done');
    check('the pop-up after the game says so (during)', p && p[1].during === 'VALORANT.exe ran', E.wins[0].pushed);
    handle.stop('x');
  }

  /* live (not --test): shown inactive, on top at screen-saver level, the beep is shell.beep */
  {
    const { ctx, T, E, clock, handle } = boot({ test: false, fakeClock: true });
    check('live: no test hooks', hub.test.timer === undefined);
    await ctx.call('start', { ms: 2000 });
    clock.t += 2000;
    T.run(armed(T)[0]);
    const w = E.wins[0];
    w.webContents.emit('did-finish-load');
    check('live: showInactive (never focus), alwaysOnTop screen-saver, not muted', w.shown === 1 && w.focused === 0 && w.opts.alwaysOnTop === true
      && w.aot.some((a) => a[0] === true && a[1] === 'screen-saver') && w.pushed[0][1].mute === false, { shown: w.shown, aot: w.aot });
    const r = await ctx.call('chime', { ok: false, reason: 'the audio stayed suspended' });
    check('live: a failed chime is kept with its reason and falls back to one shell.beep', r.done.sound === 'failed' && r.done.soundReason === 'the audio stayed suspended' && E.beeps === 1);
    hub.setResting('Fortnite runs');
    await ctx.call('start', { ms: 2000 });
    clock.t += 2000;
    T.run(armed(T)[0]);
    check('live, during a game: shell.beep once more, no new window', E.beeps === 2 && E.wins.length === 1 && ctx.last().held === true);
    hub.setResting(null);
    handle.stop('x');
  }

  /* the top bar never installed: resting cannot be told -> the pop-up at once + reason */
  {
    const { ctx, T, E, clock, handle } = boot({ known: false });
    const v0 = ctx.last();
    check('unknown resting: view says so with a reason', v0.resting === 'unknown' && /cannot tell whether a game runs/.test(v0.restingReason || ''), v0);
    await ctx.call('start', { ms: 5000 });
    clock.t += 5000; T.run(armed(T)[0]);
    check('unknown resting: the pop-up shows at once', E.wins.length === 1 && ctx.last().done.popup === 'shown' && ctx.last().held === false);
    handle.stop('x');
  }

  /* settings that cannot be written */
  {
    const { ctx, T, clock, handle } = boot();
    ctx.failSave = 'EPERM: the file is read-only';
    const r = await ctx.call('start', { text: '5' });
    const h = ctx.healths[ctx.healths.length - 1];
    check('save fails: the timer still runs', r.ok && r.kind === 'timer' && armed(T).length === 1);
    check('save fails: health(false, reason) in plain words', h.ok === false && h.reason === 'the timer cannot be kept across a restart: EPERM: the file is read-only', h);
    eq('save fails: persist in the view', r.persist, { ok: false, reason: 'EPERM: the file is read-only' });
    ctx.failSave = null;
    const r2 = await ctx.call('pause');
    check('save works again: healthy, persist ok', r2.persist.ok === true && ctx.healths[ctx.healths.length - 1].ok === true);
    handle.stop('x');
    void clock;
  }

  /* restore at install (real clock at install: the hooks are set after it) */
  {
    const store = { clock: { kind: 'timer', endAt: Date.now() - 90000, totalMs: 25 * MIN, label: '25 min', startedAt: Date.now() - 26 * MIN } };
    const a = boot({ store, t: Date.now() });
    const v = a.ctx.last();
    check('restore: a timer that ended while off fires ONCE at start (whileOff)', v.done && v.done.whileOff === true && v.done.popup === 'shown' && a.E.wins.length === 1, v);
    eq('restore: the saved state is idle at once', store.clock, { kind: 'idle' });
    a.E.wins[0].webContents.emit('did-finish-load');
    check('restore: the pop-up is told whileOff', a.E.wins[0].pushed[0][1].whileOff === true);
    a.handle.stop('restart');
    const b = boot({ store, t: Date.now() });
    check('restore: a second start does not fire again', b.ctx.last().done === null && b.E.wins.length === 0);
    b.handle.stop('x');
    const fut = { clock: { kind: 'timer', endAt: Date.now() + 10 * MIN, totalMs: 25 * MIN, label: '25 min', startedAt: Date.now() - 15 * MIN } };
    const c = boot({ store: fut, t: Date.now() });
    check('restore: a future end keeps running with one timeout', c.ctx.last().kind === 'timer' && armed(c.T).length === 1 && Math.abs(armed(c.T)[0].ms - 10 * MIN) < 5000 && c.ctx.logged(/picked up the 25 min timer/),
      { v: c.ctx.last(), armed: armed(c.T).map((h) => h.ms), lines: c.ctx.lines });
    c.H.now(() => c.clock.t - 40 * 24 * HOUR);   // the clock jumps back 40 days: the delay is past setTimeout's ceiling
    eq('the one timeout is capped at 2^31-1 ms and armed again', armed(c.T).map((h) => h.ms), [2147483647]);
    c.T.run(armed(c.T)[0]);
    check('an early (capped) timeout re-arms, it does not fire', armed(c.T).length === 1 && c.ctx.last().done === null && c.ctx.last().kind === 'timer');
    c.handle.stop('x');
    const junk = { clock: { kind: 'egg' } };
    const d = boot({ store: junk, t: Date.now() });
    const vd = d.ctx.last();
    check('restore: junk -> idle + restoreError in the view + a log line', vd.kind === 'idle' && /could not be read/.test(vd.restoreError || '') && d.ctx.logged(/could not be read/), vd);
    // the restore hook with the fake clock
    const past = d.H.restore({ kind: 'timer', endAt: d.clock.t - 1, totalMs: 60000, label: '1 min', startedAt: 0 });
    check('hook restore(): fires with whileOff', past.done && past.done.whileOff === true && junk.clock.kind === 'idle');
    d.handle.stop('x');
  }
}

(async () => {
  try {
    parsing(); formatting(); stateMath(); restoring();
    await feature();
  } catch (e) {
    failures.push('threw');
    console.log(`FAIL the test threw: ${e && e.stack}`);
  }
  mod._inject = null;
  console.log(`TIMER: ${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();
