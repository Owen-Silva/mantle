'use strict';
/* lib/notifications-incoming.test.js - TOAST INCOMING in lib/notifications.js (lane mantle-toastfast,
 * 2026-10-16), in node with a FAKE sidecar and a temp userData: no toast of Owen's is read or touched.
 *
 *   node lib/notifications-incoming.test.js   -> "NOTIFICATIONS INCOMING TEST: n passed, m failed"
 *
 * Pins: the sidecar's {ev:"notifications.coming"} reaches every onIncoming listener at once (aumid or
 * null), a throwing listener neither stops the others nor goes unlogged, and unsubscribe works. The
 * FALLBACKS, none silent: Windows' change event refused -> the watch is still armed and the 100 ms poll
 * carries it, the reason is logged and in the 'notifications' state's `signal`; an OLD sidecar exe (no
 * `coming` in its watch reply) or one without the database -> banners wait for the list, said the same
 * way; a watch that will not arm -> main's own POLL_MS poll resumes, said; a new toast that reaches the
 * list with no "coming" before it -> counted and logged; a sidecar that comes back with the signal ->
 * logged again. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-ntf-incoming-'));
const origLoad = Module._load;
Module._load = function (req) {
  if (req === 'electron') return { app: { getPath: () => TMP } };
  return origLoad.apply(this, arguments);
};

let passed = 0; const fails = [];
const check = (name, ok, detail) => { if (ok) passed++; else fails.push(name + (detail !== undefined ? ' (' + JSON.stringify(detail).slice(0, 300) + ')' : '')); };
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 20));

const logs = [];
const origWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (s) => { if (String(s).startsWith('mantle: notifications:')) { logs.push(String(s)); return true; } return origWrite(s); };
const logged = (re) => logs.some((l) => re.test(l));

function fakeSidecar() {
  const on = {};
  const sc = {
    status: 'idle', calls: [], answer: {},
    on: (ev, fn) => { (on[ev] = on[ev] || []).push(fn); },
    emit: (ev, p) => (on[ev] || []).forEach((fn) => fn(p)),
    call: async (cmd, args) => {
      sc.calls.push({ cmd, args });
      const a = sc.answer[args.op];
      if (typeof a === 'function') return a(args);
      return a;
    },
  };
  return sc;
}

const POLL_WHY = 'Windows would not send Mantle notification changes (HRESULT 0x80070490: Element not found.), so Mantle checks for new ones every 100 ms';

(async () => {
  const N = require('./notifications.js');
  const T = N._test;
  const sc = fakeSidecar();
  const states = {};
  const ctx = { test: true, sidecar: sc, commands: {}, broadcast: () => {}, state: { set: (k, v) => { states[k] = v; } } };
  let toasts = [{ id: 1, aumid: 'App.A', app: 'A', title: 'old' }];
  let rev = 1;
  sc.answer.list = () => ({ ok: true, available: true, access: 'Allowed', via: 'listener+database', rev, toasts: toasts.slice() });
  // what the new exe answers today: the DB signal is on, Windows' change event is refused
  sc.answer.watch = { ok: true, watching: true, via: 'listener+database', pollMs: 100, coming: true, changes: 'poll', changesWhy: POLL_WHY };
  N.start(ctx);
  check('onIncoming is exported and refuses a non-function', typeof N.onIncoming === 'function' && (() => { try { N.onIncoming(5); return false; } catch (_) { return true; } })());

  sc.emit('ready');
  await tick();
  check('armed: the early signal is on, carried by the 100 ms check, and that is logged with Windows\' reason',
    T.S.signal.coming === true && T.S.signal.changes === 'poll' && logged(/early signal: banners start early: Mantle checks for new notifications every 100 ms \(Windows would not send/),
    { signal: T.S.signal, logs });
  check('... and the state Settings\' status reads says the same', /banners start early/.test(states.notifications && states.notifications.signal), states.notifications);
  check('... the sidecar watch itself stays armed (no fallback poll in main)', T.S.watching === true && T.S.pollTimer === null);

  // ---- the event reaches every listener, before any list read
  const got = [];
  const off1 = N.onIncoming((ev) => got.push(['a', ev]));
  N.onIncoming(() => { throw new Error('listener boom'); });
  const off3 = N.onIncoming((ev) => got.push(['c', ev]));
  const listsBefore = sc.calls.filter((c) => c.args.op === 'list').length;
  sc.emit('notifications.coming', { ev: 'notifications.coming', rev: 1, aumid: 'App.B' });
  check('coming: every listener gets { aumid, rev, at } synchronously, a throwing one in between does not stop the next',
    got.length === 2 && got[0][1].aumid === 'App.B' && got[0][1].rev === 1 && typeof got[0][1].at === 'number' && got[1][0] === 'c', got);
  check('... the throwing listener is logged, not swallowed', logged(/an incoming listener failed: listener boom/), logs);
  check('... and "coming" itself reads nothing (the list follows the sidecar\'s own change event)',
    sc.calls.filter((c) => c.args.op === 'list').length === listsBefore);
  sc.emit('notifications.coming', { ev: 'notifications.coming', rev: 1, aumid: '' });
  sc.emit('notifications.coming', { ev: 'notifications.coming', rev: 1 });
  check('an empty or missing aumid reaches listeners as null (the app is not known)', got.length === 6 && got[2][1].aumid === null && got[4][1].aumid === null, got.map((g) => g[1].aumid));
  off1(); off3();
  sc.emit('notifications.coming', { rev: 1, aumid: 'App.B' });
  check('unsubscribe: a listener that left gets nothing', got.length === 6, got.length);
  T.INCOMING.clear();

  // ---- a new toast WITH "coming" first: not a miss
  sc.emit('notifications.coming', { rev: 1, aumid: 'App.C' });
  toasts.push({ id: 2, aumid: 'App.C', app: 'C', title: 'new' }); rev = 2;
  sc.emit('notifications', { rev: 2 });
  await tick();
  check('a new toast announced by "coming" is not a miss', T.S.signal.missed === 0 && !logged(/early signal missed/), T.S.signal);

  // ---- a new toast with NO "coming" (beyond COMING_FRESH_MS): counted and logged
  T.S.signal.lastAt = Date.now() - T.COMING_FRESH_MS - 1000;
  toasts.push({ id: 3, aumid: 'App.D', app: 'D', title: 'unannounced' }); rev = 3;
  sc.emit('notifications', { rev: 3 });
  await tick();
  check('a new toast with no early signal before it is counted and logged (never silent)',
    T.S.signal.missed === 1 && logged(/early signal missed: 1 new notification reached the list with no early signal \(1 so far\)/), { signal: T.S.signal, logs: logs.slice(-3) });
  check('... and the state\'s signal carries the miss', /1 arrived without it/.test(states.notifications.signal), states.notifications.signal);
  // a removal is not a miss
  toasts = toasts.filter((t) => t.id !== 1); rev = 4;
  sc.emit('notifications', { rev: 4 });
  await tick();
  check('a toast going away is not a miss', T.S.signal.missed === 1, T.S.signal.missed);

  // ---- FALLBACK: an old sidecar exe (its watch reply has no `coming`)
  sc.answer.watch = { ok: true, watching: true, via: 'listener+database', pollMs: 400 };
  sc.emit('ready');
  await tick();
  check('old exe: the early signal is off, banners wait for the list, logged with the fix',
    T.S.signal.coming === false && logged(/early signal: banners wait for the full list: this sidecar exe is older than the early signal \(npm run build:sidecar\)/), logs.slice(-3));
  check('... said in the state too, and the watch itself is still armed', /banners wait for the full list/.test(states.notifications.signal) && T.S.watching === true, states.notifications);
  check('... a new toast then is NOT a miss (there is no signal to miss)', (() => {
    const was = T.S.signal.missed; T.checkSignal({ ok: true, toasts: [{ id: 99 }] }); T.S.listEvAt = Date.now(); T.checkSignal({ ok: true, toasts: [{ id: 99 }, { id: 100 }] }); return T.S.signal.missed === was;
  })());

  // ---- FALLBACK: no database (coming:false with the reason)
  sc.answer.watch = { ok: true, watching: true, via: 'listener', pollMs: 5000, coming: false, detail: 'Windows\' notification database could not be opened (sqlite 14)' };
  sc.emit('ready');
  await tick();
  check('no database: banners wait for the list, the database reason is logged',
    T.S.signal.coming === false && logged(/banners wait for the full list: the notification database is not in use \(Windows' notification database could not be opened \(sqlite 14\)\)/), logs.slice(-3));

  // ---- FALLBACK: the watch will not arm -> main's own poll resumes, said
  sc.answer.watch = () => { throw new Error('the sidecar is restarting'); };
  sc.emit('ready');
  await tick();
  check('watch fails: main\'s fallback poll is armed and logged; the signal says the watch is not armed',
    T.S.watching === false && T.S.pollTimer !== null && logged(/not watching: the sidecar's watch could not start \(the sidecar is restarting\); polling every 10 s/) &&
    /not known yet|not armed/.test(T.signalWords()), { watching: T.S.watching, words: T.signalWords() });

  // ---- the sidecar comes back with the signal: said again, main's poll stops
  sc.answer.watch = { ok: true, watching: true, via: 'listener+database', pollMs: 100, coming: true, changes: 'event' };
  const n = logs.length;
  sc.emit('ready');
  await tick();
  check('back: the signal is on again (Windows\' event this time), logged, and main\'s fallback poll is gone',
    T.S.signal.coming === true && T.S.pollTimer === null && logs.slice(n).some((l) => /early signal: banners start early: Windows tells Mantle about new notifications/.test(l)), logs.slice(n));
  const before = logs.length;
  sc.emit('ready');
  await tick();
  check('re-arming with the same answer logs nothing new about the signal', !logs.slice(before).some((l) => /early signal/.test(l)), logs.slice(before));

  if (T.S.pollTimer) clearInterval(T.S.pollTimer);
  process.stdout.write = origWrite;
  fs.rmSync(TMP, { recursive: true, force: true });
  for (const f of fails) console.log('  FAIL ' + f);
  console.log(`NOTIFICATIONS INCOMING TEST: ${passed} passed, ${fails.length} failed`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { process.stdout.write = origWrite; console.log('NOTIFICATIONS INCOMING TEST: 0 passed, 1 failed'); console.log('  FAIL the test threw: ' + (e.stack || e.message)); process.exit(1); });
