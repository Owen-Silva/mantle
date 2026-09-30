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
  hub.known = o.known !== false; hub.resting = o.resting || null; hub.since = null;
  const T = fakeTimers(), E = fakeElectron();
  const clock = { t: o.t || 1000000 };
  mod._inject = { electron: E, setTimeout: T.setTimeout, clearTimeout: T.clearTimeout, now: o.fakeClock ? () => clock.t : null,
    mono: () => (clock.m !== undefined ? clock.m : clock.t) };   // monotonic follows the fake clock unless a test splits them (clock.m)
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
    check('restart: the log says it replaced the running one (by its length, never the custom label)', ctx.logged(/a 10 min timer replaces the 25 min timer \(20:00 left\)/) && !ctx.logged(/Tea/), ctx.lines);
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
    check('at zero: logged "done (11 min)" (the length, not the custom label)', ctx.logged(/^done \(11 min\)$/) && !ctx.logged(/Tea/), ctx.lines);
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
    check('stopwatch replaces the timer: no timeout, logged', r.ok && r.kind === 'stopwatch' && armed(T).length === 0 && ctx.logged(/a stopwatch replaces the 11 min timer/) && !ctx.logged(/Tea/), ctx.lines.slice(-2));
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

/* ---- security review 2: hostile saved state, labels, input ---- */
/* ---- the quality pass (lane topbar-timer, 2026-09-29): every menu function, bad input, the holes
 * fixed (clock set back, a held pop-up across a restart, a stale or double click), snooze/restart ---- */
async function quality() {
  const pushedOf = (w) => { w.webContents.emit('did-finish-load'); const p = w.pushed.filter((x) => x[0] === 'timer.done').pop(); return p && p[1]; };

  // the menu's presets: 5 / 15 / 25 / 50 minutes, each one timer, one timeout, the length as its label
  for (const m of [5, 15, 25, 50]) {
    const { ctx, T, clock, handle } = boot({ fakeClock: true });
    const r = await ctx.call('start', { ms: m * MIN });
    check(`preset ${m} min: runs, ends ${m} min on, labelled "${m} min", one timeout`, r.ok && r.endAt === clock.t + m * MIN && r.label === `${m} min` && armed(T).length === 1 && armed(T)[0].ms === m * MIN && ctx.store.clock.totalMs === m * MIN, r);
    handle.stop();
  }

  // custom durations: every bad one refused in words, nothing started, nothing armed, nothing saved
  {
    const { ctx, T, handle } = boot({ fakeClock: true });
    const bad = [{ text: '0' }, { text: '-5' }, { text: '99999' }, { text: 'NaN' }, { text: 'abc' }, { text: '' }, { text: '   ' }, { text: '1:75' }, { text: '25:00:00' },
      { ms: 0 }, { ms: -1 }, { ms: NaN }, { ms: Infinity }, { ms: 1e308 }, { ms: 400 }, { ms: '25' }, { text: 25 }, {}, null];
    for (const a of bad) {
      const r = await ctx.call('start', a);
      check(`custom ${JSON.stringify(a)}: refused in words, idle, no timeout`, r.ok === false && typeof r.reason === 'string' && r.reason.length > 10 && !/NaN|undefined|null|Infinity/.test(r.reason)
        && ctx.last().kind === 'idle' && armed(T).length === 0 && (!ctx.store.clock || ctx.store.clock.kind === 'idle'), r);
    }
    const r0 = await ctx.call('start', { text: '0' });
    check('custom "0" says a timer needs at least 1 second', /at least 1 second/.test(r0.reason), r0);
    const rh = await ctx.call('start', { text: '99999' });
    check('custom huge says the 24 hour limit', /up to 24 hours/.test(rh.reason), rh);
    for (const [text, ms] of [['12', 12 * MIN], ['1:30', 90 * MIN], ['45s', 45 * SEC], ['1h 30m', 90 * MIN], ['24:00', 24 * HOUR], ['2.5', 150 * SEC]]) {
      const r = await ctx.call('start', { text });
      check(`custom "${text}" runs ${ms} ms`, r.ok && r.totalMs === ms && armed(T).length === 1 && armed(T)[0].ms === ms, r);
    }
    handle.stop();
  }

  // pause / resume / cancel, the second press of each refused in words; stopwatch start / pause / reset / stop
  {
    const { ctx, T, clock, handle } = boot({ fakeClock: true });
    check('pause with nothing running: refused in words', (await ctx.call('pause')).reason === 'No timer or stopwatch is running');
    await ctx.call('start', { ms: 10 * MIN });
    clock.t += 3 * MIN;
    let r = await ctx.call('pause');
    check('pause: 7:00 left kept, no timeout', r.ok && r.paused && r.leftMs === 7 * MIN && armed(T).length === 0 && ctx.store.clock.paused === true, r);
    check('pause twice: refused in words', (await ctx.call('pause')).reason === 'The timer is already paused');
    clock.t += HOUR;
    r = await ctx.call('resume');
    check('resume after an hour paused: still 7:00 left, one timeout', r.ok && !r.paused && r.leftMs === 7 * MIN && armed(T).length === 1 && armed(T)[0].ms === 7 * MIN, r);
    check('resume twice: refused in words', (await ctx.call('resume')).reason === 'The timer is not paused');
    r = await ctx.call('cancel');
    check('cancel: idle, no timeout, saved idle', r.ok && r.kind === 'idle' && armed(T).length === 0 && ctx.store.clock.kind === 'idle', r);
    r = await ctx.call('stopwatch');
    clock.t += 65 * SEC;
    check('stopwatch: counts up (1:05), no timeout at all', ctx.replays['timer.state']().elapsedMs === 65 * SEC && armed(T).length === 0, ctx.replays['timer.state']());
    r = await ctx.call('pause');
    clock.t += 10 * MIN;
    check('stopwatch pause: 1:05 kept while paused', r.ok && r.paused && ctx.replays['timer.state']().elapsedMs === 65 * SEC);
    r = await ctx.call('resume'); clock.t += 5 * SEC;
    check('stopwatch resume: 1:10', r.ok && ctx.replays['timer.state']().elapsedMs === 70 * SEC);
    r = await ctx.call('stopwatch');
    check('stopwatch "Reset to 0:00": back to 0, running, logged as a restart', r.ok && r.kind === 'stopwatch' && r.elapsedMs === 0 && ctx.logged(/a stopwatch restarts the stopwatch/), ctx.lines.slice(-1));
    r = await ctx.call('cancel');
    check('stopwatch stop: idle', r.ok && r.kind === 'idle');
    handle.stop();
  }

  // HOLE (fixed): the PC clock set back while a timer runs used to stretch it by that much
  {
    const { ctx, T, E, clock, handle } = boot({ fakeClock: true });
    clock.m = 5000000;
    await ctx.call('start', { ms: 10 * MIN });
    clock.t -= HOUR; clock.m += 10 * MIN;      // the wall clock went back an hour; 10 real minutes passed
    T.run(armed(T)[0]);
    const v = ctx.last();
    check('clock set back 1 h: the timer still ends after 10 real minutes (by the monotonic count)', v.kind === 'idle' && v.done && v.done.popup === 'shown' && E.wins.length === 1, v);
    check('clock set back: said in the log, the "ended at" is now (not an hour ahead)', ctx.logged(/clock was set back/) && v.done.endAt === clock.t, v.done);
    check('clock set back: saved idle (no second fire on restart)', ctx.store.clock.kind === 'idle');
    handle.stop();
    const b = boot({ fakeClock: true });
    b.clock.m = 0;
    await b.ctx.call('start', { ms: 10 * MIN });
    b.clock.t += 2 * MIN; b.clock.m += 2 * MIN; T.run;
    b.T.run(armed(b.T)[0]);   // an early timeout (both clocks agree: 8 min to go)
    check('clocks agree, early: re-armed for the 8 min left, not fired', armed(b.T).length === 1 && armed(b.T)[0].ms === 8 * MIN && b.ctx.last().done === null);
    b.clock.t += 30 * MIN;    // the wall clock jumped FORWARD past the end: it ends at the next check
    b.T.run(armed(b.T)[0]);
    check('clock set forward past the end: it ends at the next check', b.ctx.last().done && b.ctx.last().kind === 'idle');
    b.handle.stop();
  }

  // a sleep: the wake fires it once, the pop-up says the PC was asleep; the late timeout then does nothing
  {
    const { ctx, T, E, clock, handle } = boot({ fakeClock: true });
    await ctx.call('start', { ms: 5 * MIN });
    const late = armed(T)[0];
    clock.t += 2 * HOUR;
    E.powerMonitor.emit('resume');
    const v = ctx.last();
    check('asleep: fired on wake, done.asleep, logged "late: the PC was asleep"', v.done && v.done.asleep === true && ctx.logged(/late: the PC was asleep/) && E.wins.length === 1, v.done);
    check('asleep: the pop-up is told asleep', pushedOf(E.wins[0]).asleep === true);
    if (T.list.has(late.id)) T.run(late);
    E.powerMonitor.emit('resume');
    check('double-fire guard: the old timeout and a second wake make no second pop-up', E.wins.length === 1 && armed(T).length === 0);
    const r = await ctx.call('start', { ms: 5 * MIN });
    clock.t += 5 * MIN + 20 * SEC; T.run(armed(T)[0]);
    check('20 s late (not a sleep): not called asleep', r.ok && ctx.last().done && ctx.last().done.asleep === false);
    handle.stop();
    check('stop: the wake listener is removed (no leak)', E.powerMonitor.listenerCount('resume') === 0 && T.pending().length === 0);
  }

  // HOLE (fixed): a pop-up held for a game was lost if Mantle restarted before the game ended
  {
    const store = {};
    const a = boot({ fakeClock: true, store });
    await a.ctx.call('start', { ms: 5 * MIN });
    hub.setResting('VALORANT.exe runs');
    a.clock.t += 5 * MIN; a.T.run(armed(a.T)[0]);
    check('held: the held notice is saved', store.held && store.held.totalMs === 5 * MIN && store.clock.kind === 'idle' && a.H.beeps() === 1, store);
    a.handle.stop();
    // restart while the game still runs: held again, NO second beep, no window
    const b = boot({ fakeClock: true, store, resting: 'VALORANT.exe runs', t: a.clock.t + MIN });
    check('restart in the game: held again, no window, no second beep', b.ctx.last().held === true && b.E.wins.length === 0 && b.H.beeps() === 0 && store.held, b.ctx.last());
    hub.setResting(null);
    const v = b.ctx.last();
    check('the game ended after the restart: the pop-up shows, the held notice leaves the disk', v.done && v.done.popup === 'shown' && b.E.wins.length === 1 && store.held === null, v);
    check('... and it says it ended while a game ran', /while a game ran|VALORANT/.test(pushedOf(b.E.wins[0]).during || ''), pushedOf(b.E.wins[0]));
    b.handle.stop();
    const c = boot({ fakeClock: true, store, t: a.clock.t + 2 * MIN });
    check('a third start: nothing fires again', c.ctx.last().done === null && c.E.wins.length === 0);
    c.handle.stop();
    // restart after the game: shown at once
    const s2 = { held: { label: 'Tea', totalMs: 5 * MIN, endAt: 1000000 - MIN } };
    const d = boot({ fakeClock: true, store: s2 });
    check('restart after the game: the held pop-up shows at once, named, no beep', d.ctx.last().done && d.ctx.last().done.label === 'Tea' && d.E.wins.length === 1 && d.H.beeps() === 0 && s2.held === null, d.ctx.last().done);
    d.handle.stop();
    // dismissed while held (from the bar): off the disk
    const s3 = {};
    const e = boot({ fakeClock: true, store: s3, resting: 'VALORANT.exe runs' });
    await e.ctx.call('start', { ms: MIN }); e.clock.t += MIN; e.T.run(armed(e.T)[0]);
    check('held, then dismissed: the notice leaves the disk', s3.held && (await e.ctx.call('dismiss')).dismissed === true && s3.held === null);
    e.handle.stop();
    // junk or stale held notices: not shown, said in the log
    for (const [what, h] of [['8 days old', { label: 'x', totalMs: MIN, endAt: 1000000 - 8 * 24 * HOUR }], ['junk', 'nope'], ['no length', { endAt: 1000000 }], ['in the future', { totalMs: MIN, endAt: 1000000 + HOUR }]]) {
      const f = boot({ fakeClock: true, store: { held: h } });
      check(`held notice ${what}: not shown, logged`, f.E.wins.length === 0 && f.ctx.last().done === null && f.ctx.logged(/could not be read or is over 7 days old/), f.ctx.lines);
      f.handle.stop();
    }
  }

  // NEW: snooze (+1 min / +5 min) and Restart on the done pop-up
  {
    const { ctx, T, E, clock, H, handle } = boot({ fakeClock: true });
    check('snooze with no finished timer: refused in words', (await ctx.call('snooze', { ms: 5 * MIN })).reason === 'There is no finished timer to snooze');
    await ctx.call('start', { ms: 25 * MIN });
    clock.t += 25 * MIN; T.run(armed(T)[0]);
    const p = pushedOf(E.wins[0]);
    check('the pop-up is told the snoozes it may offer (1 and 5 min) and no snoozeOf', JSON.stringify(p.snoozes) === JSON.stringify([MIN, 5 * MIN]) && p.snoozeOf === null, p);
    const end1 = ctx.last().done.endAt;
    check('snooze 7 min: refused (only 1 or 5)', (await ctx.call('snooze', { ms: 7 * MIN, endAt: end1 })).reason === 'A snooze is 1 or 5 minutes');
    check('snooze "5": refused (a number is needed)', (await ctx.call('snooze', { ms: '300000', endAt: end1 })).ok === false);
    check('snooze naming another finish: refused', (await ctx.call('snooze', { ms: 5 * MIN, endAt: end1 - 1 })).reason === 'That timer was already dealt with');
    let r = await ctx.call('snooze', { ms: 5 * MIN, endAt: end1 });
    await tick();
    check('snooze +5 min: a 5 min timer, the same label, snoozeOf 25 min, pop-up destroyed', r.ok && r.kind === 'timer' && r.totalMs === 5 * MIN && r.label === '25 min' && r.snoozeOf === 25 * MIN && r.done === null && E.wins[0].destroyed && armed(T)[0].ms === 5 * MIN, r);
    check('snooze: saved with of (survives a restart)', ctx.store.clock.of === 25 * MIN && ctx.store.clock.totalMs === 5 * MIN);
    check('snooze: the log names lengths only', ctx.logged(/a 5 min snooze of the 25 min timer started/), ctx.lines.slice(-1));
    check('a second click on the same finish: refused, nothing replaced', (await ctx.call('snooze', { ms: MIN, endAt: end1 })).ok === false && ctx.last().totalMs === 5 * MIN);
    r = await ctx.call('pause'); r = await ctx.call('resume');
    check('a snooze pauses and resumes like any timer, keeping of', r.ok && r.snoozeOf === 25 * MIN && ctx.store.clock.of === 25 * MIN);
    clock.t += 5 * MIN; T.run(armed(T)[0]);
    const p2 = pushedOf(E.wins[1]);
    check('the snooze ends: the pop-up is told snoozeOf 25 min and its 5 min', p2.snoozeOf === 25 * MIN && p2.totalMs === 5 * MIN && p2.label === '25 min', p2);
    r = await ctx.call('snooze', { ms: MIN, endAt: ctx.last().done.endAt });
    check('a snooze of a snooze still remembers the 25 min', r.ok && r.totalMs === MIN && r.snoozeOf === 25 * MIN, r);
    clock.t += MIN; T.run(armed(T)[0]);
    const end3 = ctx.last().done.endAt;
    r = await ctx.call('again', { endAt: end3 });
    check('Restart after snoozes: the ORIGINAL 25 min again, no snoozeOf', r.ok && r.totalMs === 25 * MIN && r.snoozeOf === null && r.label === '25 min', r);
    check('Restart twice (a double click): the second is refused', (await ctx.call('again', { endAt: end3 })).reason === 'That timer was already dealt with');
    // restore keeps of; junk of is dropped
    const rs = H.restore({ kind: 'timer', endAt: clock.t + MIN, totalMs: MIN, label: '25 min', of: 25 * MIN, startedAt: clock.t });
    check('restore keeps a snooze\'s of', rs.snoozeOf === 25 * MIN, rs);
    const rj = H.restore({ kind: 'timer', endAt: clock.t + MIN, totalMs: MIN, label: 'x', of: 'lots', startedAt: clock.t });
    check('restore drops a junk of', rj.snoozeOf === null && !('of' in ctx.store.clock), ctx.store.clock);
    // switched off: snooze refused
    ctx.on = false;
    check('switched off: snooze refused', (await ctx.call('snooze', { ms: MIN })).ok === false);
    handle.stop();
  }

  // core: of rides pause/resume/addTime/restore; a plain timer has no of key at all (old saves unchanged)
  {
    const t = 1000000;
    const s = C.startTimer(t, 5 * MIN, '', 25 * MIN);
    check('core: startTimer keeps of', s.of === 25 * MIN);
    check('core: a plain timer has no of key', !('of' in C.startTimer(t, 5 * MIN, '')));
    check('core: pause/resume/addTime keep of', C.pause(s, t).of === 25 * MIN && C.resume(C.pause(s, t), t).of === 25 * MIN && C.addTime(s, t, MIN).of === 25 * MIN);
    check('core: of out of range is dropped', !('of' in C.startTimer(t, MIN, '', 0)) && !('of' in C.startTimer(t, MIN, '', 1e12)) && !('of' in C.startTimer(t, MIN, '', NaN)));
    check('core: restore of an ended snooze fires with of', C.restore(Object.assign({}, s, { endAt: t - 1 }), t).fired.of === 25 * MIN);
  }

  // a save that fails while firing: said (health + persist), and the pop-up still shows
  {
    const { ctx, T, E, clock, handle } = boot({ fakeClock: true });
    await ctx.call('start', { ms: MIN });
    ctx.failSave = 'EPERM: the file is read-only';
    clock.t += MIN; T.run(armed(T)[0]);
    const v = ctx.last();
    check('save fails at zero: the pop-up still shows, persist says why, health false', E.wins.length === 1 && v.persist.ok === false && /read-only/.test(v.persist.reason) && ctx.healths[ctx.healths.length - 1].ok === false, v.persist);
    handle.stop();
  }

  // the chime's report cannot flood the state
  {
    const { ctx, T, clock, handle } = boot({ fakeClock: true });
    await ctx.call('start', { ms: MIN }); clock.t += MIN; T.run(armed(T)[0]);
    const r = await ctx.call('chime', { muted: true, reason: 'x'.repeat(5000) });
    check('chime: a huge reason is cut to 200 characters', r.done.soundReason.length <= 200, r.done.soundReason.length);
    handle.stop();
  }
}

async function hostile() {
  const t = Date.UTC(2026, 8, 27, 12);
  const DAY = 24 * 60 * MIN;
  // the custom input: bounded, and never a timer outside 1 s..24 h
  for (const s of ['99999:99', '-5', '1e9', '0', 'Infinity', '0x10', '١٢', '１２', '1'.repeat(1 << 20), 'a'.repeat(1 << 20)]) {
    const r = C.parseDuration(s);
    check(`hostile parse ${JSON.stringify(s.slice(0, 12))}${s.length > 12 ? '...' : ''} -> refused`, r.ok === false && typeof r.reason === 'string');
  }
  // a saved end at 0 / negative / weeks back: no "done" pop-up about 1970
  for (const [what, endAt] of [['0', 0], ['negative', -5], ['8 days back', t - 8 * DAY]]) {
    const r = C.restore({ kind: 'timer', endAt, totalMs: MIN, label: '1 min' }, t);
    check(`hostile restore: an end at ${what} does not fire, and says why`, r.st.kind === 'idle' && r.fired === null && /more than 7 days ago/.test(r.reason || ''), r);
  }
  const yday = C.restore({ kind: 'timer', endAt: t - DAY, totalMs: MIN, label: '1 min' }, t);
  check('hostile restore: a timer that ended yesterday still fires once (whileOff)', yday.fired && yday.fired.whileOff === true, yday);
  // a stopwatch from -1e300 drew "2.7777777777777778e+293:41:36"
  for (const [what, saved] of [['started at -1e300', { kind: 'stopwatch', startAt: -1e300 }], ['paused at 1e300', { kind: 'stopwatch', paused: true, elapsedMs: 1e300 }]]) {
    const r = C.restore(saved, t);
    check(`hostile restore: a stopwatch ${what} -> idle + a reason`, r.st.kind === 'idle' && /could not be read/.test(r.reason || ''), [r, C.formatClock(C.elapsedMs(r.st, t), true)]);
  }
  // labels: one line, no bidi, 60 chars; markup is kept as text (drawn with textContent / esc())
  const evil = 'x\nmantle: FAKE LINE \u202e<img src=x onerror=alert(1)>' + 'L'.repeat(200);
  const rl = C.restore({ kind: 'timer', endAt: t + MIN, totalMs: MIN, label: evil }, t);
  check('hostile restore: a saved label loses its newline and bidi override, and is 60 chars at most',
    !/[\n\r\u202e]/.test(rl.st.label) && rl.st.label.length <= 60 && rl.st.label.startsWith('x mantle: FAKE LINE <img'), rl.st.label);
  check('hostile: startTimer cleans a label too', C.startTimer(t, MIN, 'a\r\nb\u2028c').label === 'a b c');
  // the feature: a custom label never reaches the log; a hostile saved "last" never becomes a timer
  {
    const d = boot({ store: { last: 1e308 } });
    const r0 = await d.ctx.call('again');
    check('hostile: a saved "last" of 1e308 is not run by Again (refused in words)', r0.ok === false && /no finished timer/.test(r0.reason || ''), r0);
    const r = await d.ctx.call('start', { text: '5', label: 'SECRET\nmantle: forged' });
    check('hostile: a custom label is kept cleaned', r.ok && r.label === 'SECRET mantle: forged', r.label);
    await d.ctx.call('pause'); await d.ctx.call('resume'); await d.ctx.call('add', { ms: MIN }); d.H.fire();
    await d.ctx.call('again'); await d.ctx.call('cancel');
    check('hostile: no log line carries a custom label (the length names the timer)', !d.ctx.lines.some((l) => /SECRET|forged/.test(l)) && d.ctx.logged(/a 5 min timer/), d.ctx.lines.filter((l) => /SECRET|forged/.test(l)).slice(0, 3));
    d.handle.stop('x');
  }
}

(async () => {
  try {
    parsing(); formatting(); stateMath(); restoring();
    await hostile();
    await feature();
    await quality();
  } catch (e) {
    failures.push('threw');
    console.log(`FAIL the test threw: ${e && e.stack}`);
  }
  mod._inject = null;
  console.log(`TIMER: ${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();
