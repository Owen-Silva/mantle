'use strict';
/* toasts-safety.test.js - Windows' own banners come back when Mantle's notification helper is dead, and
 * Settings' notification status says whose banners Owen gets and why (lane mantle-notif-safety, 2026-10-17).
 *
 * PART 1 (pure, fakes): lib/features/_toasts-safety.js - the grace, a give-up, idle(), leave(), the
 *   script's output read back.
 * PART 2 (pure): lib/features/_toasts-status.js - every mode's words, including the two lines the lane
 *   brief gave as examples.
 * PART 3 (lib/features/toasts.js with a fake ctx, --test): the helper dies after Mantle took three test
 *   apps; after the grace the REAL tools/restore-banners.ps1 puts them back. The registry is a SCRATCH key
 *     HKCU\Software\MantleTest\notif-safety-<random>\Settings\Mantle.ToastTest.ns<random>-<x>
 *   (MANTLE_TEST_BANNERS_KEY), the record is in a temp folder; Windows' real notification settings and
 *   Owen's real notif-banners.json are never read or written. The fake helper's own take / put-back writes
 *   the same scratch key. Then: the helper back = Mantle takes them again (not "released"); stop() with
 *   the helper down = the script puts them back before stop() returns; main's 'exit' with it down = the same.
 *
 *   node lib/features/toasts-safety.test.js     -> "TOASTS SAFETY TEST: n passed, m failed"
 *   TOASTS_JS=<path> runs part 3 against another toasts.js (the pre-fix file, to show it fails).
 */
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(`${name}${detail !== undefined ? ` (${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 400)})` : ''}`);
  return ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms) { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(100); } return !!fn(); }

// ------------------------------------------------------------------ PART 1: the safety, with fakes
const { createSafety, readOut, scriptRunner } = require('./_toasts-safety');

function fakeClock() {
  let t = 1760000000000;
  const timers = [];
  return {
    now: () => t,
    setTimeout: (fn, ms) => { const x = { fn, at: t + ms, done: false }; timers.push(x); return x; },
    clearTimeout: (x) => { if (x) x.done = true; },
    advance(ms) { t += ms; for (const x of timers) if (!x.done && x.at <= t) { x.done = true; x.fn(); } },
    pending: () => timers.filter((x) => !x.done).length,
  };
}
function makeSafety(o) {
  const c = fakeClock();
  const r = { runs: 0, syncs: 0, owned: o && o.owned !== undefined ? o.owned : 3, out: { code: 0, out: 'mantle restore-banners\n  2 put back to Windows\' own pop-up, 1 left as they were\nverified\n' }, logs: [], changes: 0 };
  r.release = null;
  r.s = createSafety({
    owned: () => r.owned, now: c.now, setTimeout: c.setTimeout, clearTimeout: c.clearTimeout, graceMs: 8000,
    log: (l) => r.logs.push(l), onChange: () => { r.changes++; },
    run: () => { r.runs++; if (o && o.hold) return new Promise((res) => { r.release = () => res(r.out); }); return Promise.resolve(r.out); },
    sync: () => { r.syncs++; if (o && o.syncThrows) throw new Error('no powershell'); return r.out; },
  });
  r.c = c;
  return r;
}

async function part1() {
  {
    const r = makeSafety();
    r.s.down('sidecar exited with code 1; restarting in 3 s');
    r.c.advance(7000);
    check('1a no put-back inside the grace (a normal restart is ~3 s)', r.runs === 0, r.runs);
    r.c.advance(1500);
    await sleep(0);
    check('1b the grace passed with the helper still down: the script runs once', r.runs === 1, r.runs);
    await sleep(5);
    const st = r.s.state();
    check('1c the run is remembered: ok, 2 back, 1 left, when', st.last && st.last.ok && st.last.back === 2 && st.last.left === 1 && st.last.at === r.c.now(), st.last);
    r.s.down('sidecar exited with code 1; restarting in 6 s');
    r.c.advance(20000);
    check('1d another "down" while still down after a good put-back: no second run', r.runs === 1, r.runs);
    r.s.up();
    check('1e up(): down cleared', r.s.state().down === null);
    check('1f every step is logged in words', r.logs.some((l) => /being put back/.test(l)) && r.logs.some((l) => /are back .*2 put back, 1 left/.test(l)), r.logs);
  }
  {
    const r = makeSafety();
    r.s.down('restarting');
    r.c.advance(3000);
    r.s.up();
    r.c.advance(30000);
    check('1g back within the grace: nothing runs, no timer left', r.runs === 0 && r.c.pending() === 0, { runs: r.runs, pending: r.c.pending() });
  }
  {
    const r = makeSafety();
    r.s.down('restarting');
    await r.s.gaveUp('sidecar exited with code 1 and gave up after 3 restarts in a row');
    check('1h gave up: the script runs at once, no grace, the timer cleared', r.runs === 1 && r.c.pending() === 0, { runs: r.runs, pending: r.c.pending() });
  }
  {
    const r = makeSafety({ owned: 0 });
    await r.s.gaveUp('gave up');
    const st = r.s.state();
    check('1i Mantle owns nothing: no script, the state says nothing was needed', r.runs === 0 && st.last && st.last.ok && st.last.nothing === true, st);
  }
  {
    const r = makeSafety({ hold: true });
    const p = r.s.gaveUp('gave up');
    let idled = false;
    r.s.idle().then(() => { idled = true; });
    await sleep(5);
    check('1j idle() waits for a run in flight (a take never races the script)', idled === false && r.s.state().running === true);
    r.release();
    await p; await sleep(5);
    check('1k ...and resolves when it ends', idled === true && r.s.state().running === false);
  }
  {
    const r = makeSafety();
    r.out = { code: 1, out: 'mantle restore-banners\n  PROBLEM  Mantle.X could not be put back (access denied)\n  0 put back to Windows\' own pop-up, 0 left as they were\nNOT VERIFIED - 1 app(s) could not be put back; run this again\n' };
    await r.s.gaveUp('gave up');
    const st = r.s.state();
    check('1l a failed put-back is remembered with the script\'s own reason', st.last && st.last.ok === false && /could not be put back \(access denied\)/.test(st.last.why), st.last);
    r.out = { code: 0, out: 'verified\n' };
    await r.s.gaveUp('gave up again');
    check('1m a failed one is tried again on the next give-up', r.runs === 2 && r.s.state().last.ok === true, r.runs);
  }
  {
    const r = makeSafety();
    r.s.down('restarting');
    check('1n leave() while down and nothing put back yet: the script runs to its end, its result kept', r.s.leave('Mantle exited') === true && r.syncs === 1 && r.s.state().last.sync === true && r.s.state().last.back === 2, r.s.state().last);
    const r2 = makeSafety();
    r2.s.down('restarting'); await r2.s.gaveUp('gave up');
    check('1o leave() after a good put-back: no second script', r2.s.leave('Mantle exited') === false && r2.syncs === 0);
    const r3 = makeSafety({ owned: 0 });
    r3.s.down('x');
    check('1p leave() with nothing owned: no script', r3.s.leave('Mantle exited') === false && r3.syncs === 0);
    const r4 = makeSafety({ syncThrows: true });
    r4.s.down('x');
    check('1q leave() whose script will not start: false, and said', r4.s.leave('Mantle exited') === false && r4.logs.some((l) => /could NOT all be put back .*would not run/.test(l)), r4.logs);
  }
  {
    check('1r readOut: verified', readOut(0, '  3 put back to Windows\' own pop-up, 0 left as they were\nverified\n').ok === true);
    check('1s readOut: no record = nothing to do, ok', readOut(0, '  no record: Mantle never turned off a Windows pop-up here; nothing to put back\n').ok === true);
    const bad = readOut(1, '  PROBLEM  the record could not be read (bad json); Windows\' pop-ups were left as they are\n');
    check('1t readOut: a PROBLEM line is the reason', bad.ok === false && /record could not be read/.test(bad.why), bad);
    const a = scriptRunner({ spawn: () => null, script: 'X.ps1', recordFile: 'R.json', test: true, settingsKey: 'Software\\K' }).args();
    check('1u the runner: hidden, the record, a test copy passes -TestOnly, the key', a.includes('-File') && a[a.indexOf('-RecordFile') + 1] === 'R.json' && a.includes('-TestOnly') && a[a.indexOf('-SettingsKey') + 1] === 'Software\\K' && a.includes('Hidden'), a);
    const live = scriptRunner({ spawn: () => null, script: 'X.ps1', recordFile: 'R.json', test: false }).args();
    check('1v a live Mantle: no -TestOnly and Windows\' own key', !live.includes('-TestOnly') && !live.includes('-SettingsKey'), live);
  }
}

// ------------------------------------------------------------------ PART 2: the status words
const { statusOf } = require('./_toasts-status');
function part2() {
  const at = new Date(2026, 9, 17, 1, 12, 30).getTime();
  const poll = { watching: true, watchReason: null, fallbackPollMs: 10000, coming: true, changes: 'poll', why: null, pollMs: 100, looks: 'wal-index header', looksWhy: null, missed: 0 };
  let s = statusOf({ on: true, helperReady: true, safety: {}, watch: poll });
  check('2a the brief\'s first example, exactly', s.mode === 'mantle' && `${s.line} (${s.why})` === 'Banners: Mantle (checking every 0.1 s, because Windows won\'t send change events to this app)' && s.tone === 'ok', s);
  s = statusOf({ on: true, helperReady: false, safety: { down: { why: 'x', at: at - 9000 }, last: { at, ok: true, back: 3 } }, watch: poll, now: at });
  check('2b the brief\'s second example, exactly', s.mode === 'windows' && `${s.line} (${s.why})` === 'Banners: Windows\' own (Mantle\'s notification helper stopped; restored at 01:12)' && s.tone === 'warn' && s.at === at, s);
  s = statusOf({ on: true, helperReady: false, safety: { down: { why: 'x', at }, pending: true, graceMs: 8000 }, watch: poll, now: at });
  check('2c down, inside the grace: neither, with when they come back', s.mode === 'none' && s.line === 'Banners: none' && /stopped at 01:12; Windows' own pop-ups come back within 8 s unless it starts/.test(s.why), s);
  s = statusOf({ on: true, helperReady: false, safety: { down: { why: 'x', at, starting: true }, pending: true, graceMs: 8000 }, now: at });
  check('2d at Mantle\'s own start it says "not started yet", not "stopped"', /has not started yet \(since 01:12\)/.test(s.why) && !/stopped/.test(s.why), s);
  s = statusOf({ on: true, helperReady: false, safety: { down: { why: 'x', at: at - 1 }, last: { at, ok: false, why: 'Mantle.X could not be put back (access denied)' } }, now: at });
  check('2e a failed put-back: neither, with the reason', s.mode === 'none' && /could not be put back: Mantle\.X could not be put back \(access denied\)/.test(s.why) && s.tone === 'warn', s);
  s = statusOf({ on: true, helperReady: false, safety: { down: { why: 'x', at: at - 1 }, last: { at, ok: true, nothing: true } }, now: at });
  check('2f nothing was owned: Windows\' own, said so', s.mode === 'windows' && /Windows shows its own pop-ups/.test(s.why), s);
  s = statusOf({ on: false, helperReady: true, watch: poll });
  check('2g the switch off', s.mode === 'windows' && s.why === 'Mantle\'s style is off' && s.tone === 'info', s);
  s = statusOf({ on: true, helperReady: true, accessWhy: 'Windows is not letting Mantle read notifications, so Windows keeps showing its own pop-ups.', watch: poll });
  check('2h no access: Windows\' own, its reason, no trailing period', s.mode === 'windows' && s.why === 'Windows is not letting Mantle read notifications, so Windows keeps showing its own pop-ups', s);
  s = statusOf({ on: true, helperReady: true, watch: Object.assign({}, poll, { watching: false, watchReason: 'the sidecar\'s watch could not start (timed out)' }) });
  check('2i the watch would not arm: main\'s 10 s poll, said', s.mode === 'mantle' && s.why === 'checking every 10 s, because the sidecar\'s watch could not start (timed out)' && s.tone === 'warn', s);
  s = statusOf({ on: true, helperReady: true, watch: Object.assign({}, poll, { coming: false, why: 'this sidecar exe is older than the early signal (npm run build:sidecar)' }) });
  check('2j an old helper: they wait for the full list, plainly', s.why === 'checking every 0.1 s; banners wait for the full list, because Mantle\'s notification helper is an older build that sends no early signal' && s.tone === 'info', s);
  s = statusOf({ on: true, helperReady: true, watch: Object.assign({}, poll, { coming: false, pollMs: 2000, why: 'the notification database is not in use (no file)' }) });
  check('2k no database: the slower check and why', s.why === 'checking every 2 s; banners wait for the full list, because the notification database is not in use (no file)', s);
  s = statusOf({ on: true, helperReady: true, watch: Object.assign({}, poll, { looks: 'data_version', looksWhy: 'the notification database changed while its WAL-index header did not, so every look now asks SQLite' }) });
  check('2l a shortcut switched off: said after the poll', s.why === 'checking every 0.1 s, because Windows won\'t send change events to this app; each check asks the notification database, because the quick check missed a change' && s.tone === 'info', s);
  s = statusOf({ on: true, helperReady: true, watch: Object.assign({}, poll, { looks: 'full signature', looksWhy: 'the notification database changed without its data_version moving, so every look now reads the full signature' }) });
  check('2m the second shortcut off too', /each check reads the whole list, because the quick check missed a change$/.test(s.why), s);
  s = statusOf({ on: true, helperReady: true, watch: Object.assign({}, poll, { missed: 2 }) });
  check('2n early-signal misses are counted', /; 2 new notifications came without the early signal and showed late$/.test(s.why) && s.tone === 'info', s);
  s = statusOf({ on: true, helperReady: true, watch: Object.assign({}, poll, { changes: 'event' }) });
  check('2o Windows\' change event on', s.why === 'Windows tells Mantle about each new notification', s);
  s = statusOf({ on: true, helperReady: true, watch: null });
  check('2p an older host with no watch state: just the mode, no invented reason', s.mode === 'mantle' && s.why === null, s);
  s = statusOf({ on: true, helperReady: true, watch: poll, applyWhy: 'Windows did not take the change for 1 app(s)' });
  check('2q a failed take: both pop-ups for some apps, warn', s.mode === 'mantle' && /some apps still get Windows' own pop-up too: Windows did not take the change for 1 app\(s\)$/.test(s.why) && s.tone === 'warn', s);
  for (const x of [statusOf({ on: true, helperReady: true, watch: poll }), statusOf({ on: false })]) {
    check('2r never "(null)", "undefined" or a period inside', !/null|undefined|\.$/.test(String(x.why)), x);
  }
}

// ------------------------------------------------------------------ PART 3: toasts.js, the real script, a scratch key
const TAG = 'ns' + Math.random().toString(36).slice(2, 8);
const SCRATCH = `Software\\MantleTest\\notif-safety-${TAG}\\Settings`;
const BASE = `HKCU\\${SCRATCH}`;
const APP = (x) => `Mantle.ToastTest.${TAG}-${x}`;
const reg = (args) => spawnSync('reg', args, { encoding: 'utf8', windowsHide: true });
function setVal(app, v) { reg(['add', `${BASE}\\${app}`, '/v', 'ShowBanner', '/t', 'REG_DWORD', '/d', String(v), '/f']); }
function makeKey(app) { reg(['add', `${BASE}\\${app}`, '/f']); }
function delVal(app) { reg(['delete', `${BASE}\\${app}`, '/v', 'ShowBanner', '/f']); }
/** -> number | null (no value) | 'nokey' */
function read(app) {
  if (reg(['query', `${BASE}\\${app}`]).status !== 0) return 'nokey';
  const r = reg(['query', `${BASE}\\${app}`, '/v', 'ShowBanner']);
  if (r.status !== 0) return null;
  const m = /REG_DWORD\s+0x([0-9a-f]+)/i.exec(r.stdout);
  return m ? parseInt(m[1], 16) : 'odd';
}

async function part3() {
  if (!SCRATCH.startsWith('Software\\MantleTest\\')) throw new Error('refusing: the scratch key is not under Software\\MantleTest');
  const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-toasts-safety-'));
  const RECORD = path.join(USER_DATA, 'notif-banners.json');
  const apps = [APP('a'), APP('b'), APP('c')];
  setVal(apps[0], 1); makeKey(apps[1]); setVal(apps[2], 1);   // a: 1, b: no value (Windows' default), c: 1
  process.env.MANTLE_TEST_BANNERS_KEY = SCRATCH;
  process.env.MANTLE_TEST_BANNERS_GRACE_MS = '400';

  class FakeWin { constructor() { this.webContents = { on() {}, setWindowOpenHandler() {}, getOSProcessId() { return 1; } }; } on() {} loadFile() {} isDestroyed() { return false; } destroy() {} setAlwaysOnTop() {} setBounds() {} getBounds() { return { x: 0, y: 0, width: 0, height: 0 }; } isVisible() { return false; } showInactive() {} getNativeWindowHandle() { return Buffer.alloc(8); } }
  const DISPLAY = { workArea: { x: 0, y: 0, width: 1536, height: 800 }, scaleFactor: 1 };
  const fakeElectron = { BrowserWindow: FakeWin, screen: { getPrimaryDisplay: () => DISPLAY, getDisplayMatching: () => DISPLAY, on() {}, removeListener() {} }, app: { getPath: () => USER_DATA, getAppMetrics: () => [] } };
  const load = Module._load;
  Module._load = function (req) {
    if (req === 'electron') return fakeElectron;
    if (req === '../bar-shape') return { apply: () => ({ ok: true }), verify: () => ({ ok: true }), readBack: () => ({ ok: true }) };
    if (req === '../raise') return { up() {} };
    return load.apply(this, arguments);
  };
  const file = process.env.TOASTS_JS ? path.resolve(process.env.TOASTS_JS) : path.join(__dirname, 'toasts.js');
  const feature = require(file);

  const t = { logs: [], health: [], cmds: {}, ready: [], status: [], listFns: [], enabledFns: [], exitBefore: process.listeners('exit').length };
  t.ctx = {
    name: 'toasts', flags: { test: true }, preload: 'preload.js',
    log: (s) => t.logs.push(s),
    sidecar: {
      ready: true,
      async send(cmd, args) {
        // the fake helper's own read / write go to the SAME scratch key as the script
        if (cmd === 'toasts.banners' && args.op === 'read') {
          if (!t.ctx.sidecar.ready) return { ok: false, error: 'the sidecar is not running' };
          return { ok: true, result: { ok: true, reason: null, apps: apps.map((a) => { const v = read(a); return { aumid: a, banner: v === 'nokey' ? null : v, enabled: null, odd: false }; }) } };
        }
        if (cmd === 'toasts.banners' && args.op === 'write') {
          if (!t.ctx.sidecar.ready) return { ok: false, error: 'the sidecar is not running' };
          return { ok: true, result: { ok: true, reason: null, results: args.set.map((s) => { if (s.value === null) delVal(s.aumid); else setVal(s.aumid, s.value); const now = read(s.aumid); return { aumid: s.aumid, ok: true, now, reason: null }; }) } };
        }
        if (cmd === 'toasts.quiet') return { ok: true, result: { ok: true, dnd: 0, quns: 5 } };
        return { ok: false, error: `unknown command ${cmd}` };
      },
      on(ev, fn) { if (ev === 'status') t.status.push(fn); return () => {}; },
      onReady(fn) { t.ready.push(fn); if (t.ctx.sidecar.ready) fn(); return () => {}; },
    },
    command(n, fn) { t.cmds[n] = fn; },
    health(ok, reason) { t.health.push({ ok, reason }); },
    enabled: () => true,
    onEnabled(fn) { t.enabledFns.push(fn); },
    page: (f) => `ui/toasts/${f}`,
    push() { return true; },
    host: { barRect: () => null, toasts: {
      onList: (fn) => { t.listFns.push(fn); return () => {}; }, last: () => null, targetFor: () => null, openList: () => ({ ok: true }),
      watch: () => ({ watching: true, watchReason: null, fallbackPollMs: 10000, coming: true, changes: 'poll', why: null, pollMs: 100, looks: 'wal-index header', looksWhy: null, missed: 0 }),
    } },
  };
  const helperDown = (reason) => { t.ctx.sidecar.ready = false; for (const fn of t.status) fn({ status: 'down', reason }); };
  const helperUp = () => { t.ctx.sidecar.ready = true; for (const fn of t.status) fn({ status: 'ok', reason: null }); for (const fn of t.ready) fn(); };
  const list = () => { for (const fn of t.listFns) fn({ ok: true, access: 'Allowed', available: true, toasts: [] }); };

  let inst = null;
  try {
    inst = feature.install(t.ctx);
    list();
    check('3a the record is written with the owning main\'s pid', await until(() => { try { return JSON.parse(fs.readFileSync(RECORD, 'utf8')).pid === process.pid; } catch (_) { return false; } }, 5000));
    check('3b Mantle took the three test apps (their Windows banner is 0)', await until(() => apps.every((a) => read(a) === 0), 5000), apps.map(read));

    // the helper is killed hard: no exit put-back of its own, and it does not come back
    helperDown('sidecar exited with code 1; restarting in 3 s (attempt 1 of 3).');
    await sleep(100);
    const st0 = await t.cmds.state();
    check('3c straight after: "none", the helper stopped, coming back within the grace', st0.status && st0.status.mode === 'none' && /notification helper stopped at \d\d:\d\d; Windows' own pop-ups come back within 0\.4 s/.test(st0.status.why), st0.status);
    check('3d health says it, not silent', t.health.length && t.health[t.health.length - 1].ok === false && /Banners: none/.test(t.health[t.health.length - 1].reason), t.health.slice(-1));
    setVal(apps[2], 1);   // meanwhile Owen turns c's Windows banner back on himself
    const back = await until(() => read(apps[0]) === 1 && read(apps[1]) === null, 15000);
    check('3e after the grace the REAL restore-banners.ps1 put the originals back (a: 1, b: no value)', back, apps.map(read));
    check('3f Owen\'s own value is left as he set it', read(apps[2]) === 1, read(apps[2]));
    // lane mantle-notif-owner2 (finding 3): the script lists what it put back, with the record's stamps
    const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')); } catch (_) { return null; } };
    const recAtBack = readJson(RECORD);
    const marker = readJson(path.join(USER_DATA, 'notif-banners-back.script.json'));
    const tookOf = (a) => (marker && marker.back && marker.back[a] ? marker.back[a].took : undefined);
    check('3e2 the script wrote notif-banners-back.script.json next to the record', !!(marker && marker.v === 1 && marker.back && typeof marker.back === 'object'), marker);
    check('3e2 ...listing a and b with the record\'s stamps, and not c (Owen\'s value, left alone)',
      !!(recAtBack && recAtBack.taken && typeof recAtBack.taken[apps[0]] === 'number' && tookOf(apps[0]) === recAtBack.taken[apps[0]] && tookOf(apps[1]) === recAtBack.taken[apps[1]]
        && marker && marker.back && !(apps[2] in marker.back) && typeof marker.back[apps[0]].at === 'number'), { taken: recAtBack && recAtBack.taken, marker });
    await until(() => t.logs.some((l) => /are back/.test(l)), 5000);
    const st1 = await t.cmds.state();
    check('3g Settings\' status: Windows\' own, restored at HH:MM', st1.status && st1.status.mode === 'windows' && /^Mantle's notification helper stopped; restored at \d\d:\d\d$/.test(st1.status.why), st1.status);
    check('3h the bannersNow reason carries it too', /Banners: Windows' own \(Mantle's notification helper stopped; restored at/.test(st1.reason || ''), st1.reason);

    // the helper comes back: Mantle takes them again (back to the original = take again, not "released")
    helperUp();
    check('3i helper back: Mantle takes the apps again', await until(() => read(apps[0]) === 0 && read(apps[1]) === 0, 8000), apps.map(read));
    const st2 = await t.cmds.state();
    check('3j ...none of them "released" (Owen\'s choice) by the put-back', st2.released === 0 && st2.status.mode === 'mantle', st2);
    check('3k ...and the status is Mantle again, with its poll reason', st2.status.why === 'checking every 0.1 s, because Windows won\'t send change events to this app', st2.status);
    const recRetake = readJson(RECORD);
    check('3k2 the retake stamped NEW values, so the script\'s marker can no longer match them',
      !!(marker && recRetake && recRetake.taken && typeof recRetake.taken[apps[0]] === 'number' && recRetake.taken[apps[0]] !== tookOf(apps[0]) && recRetake.taken[apps[1]] !== tookOf(apps[1])), { taken: recRetake && recRetake.taken, marker });

    // main exits with the helper dead (no grace yet): the script runs to its end before main is gone
    helperDown('sidecar exited with code 3221225477; restarting in 3 s (attempt 1 of 3).');
    const mine = process.listeners('exit').slice(t.exitBefore);
    check('3l toasts.js listens for main\'s exit', mine.length === 1, mine.length);
    if (mine.length) mine[0](0);
    check('3m main exiting with the helper down: the script has put them back when the exit hook returns', read(apps[0]) === 1 && read(apps[1]) === null, apps.map(read));

    // the helper back, then stop() while it is down: restore() through it cannot work; the script does
    helperUp();
    await until(() => read(apps[0]) === 0, 8000);
    helperDown('sidecar exited with code 1; restarting in 3 s (attempt 1 of 3).');
    const r = inst.stop('Mantle quit');
    if (r && r.then) await r;
    check('3n stop() with the helper down: Windows\' own are back when stop() returns', read(apps[0]) === 1 && read(apps[1]) === null, apps.map(read));
    check('3o stop() removed its exit listener', process.listeners('exit').length === t.exitBefore, process.listeners('exit').length - t.exitBefore);
    inst = null;
  } finally {
    if (inst) { try { inst.stop('test cleanup'); } catch (_) { /* best effort */ } }
    Module._load = load;
    reg(['delete', `HKCU\\Software\\MantleTest\\notif-safety-${TAG}`, '/f']);
    check('3p the scratch key is gone afterwards', reg(['query', `HKCU\\Software\\MantleTest\\notif-safety-${TAG}`]).status !== 0);
    try { fs.rmSync(USER_DATA, { recursive: true, force: true }); } catch (_) { /* temp */ }
  }
}

// ------------------------------------------------------------------ PART 4: lib/notifications.js's watch state
async function part4() {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-notif-watch-'));
  const load = Module._load;
  Module._load = function (req) { if (req === 'electron') return { app: { getPath: () => TMP } }; return load.apply(this, arguments); };
  try {
    const EventEmitter = require('events');
    const N = require('../notifications');
    check('4a watchState is exported', typeof N.watchState === 'function');
    if (typeof N.watchState !== 'function') return;
    const side = new EventEmitter();
    side.status = 'down';
    side.call = async () => { throw new Error('not running'); };
    N.start({ commands: {}, sidecar: side, broadcast() {}, state: { set() {} } });
    let w = N.watchState();
    check('4b before the watch is armed: not watching, nothing invented', w.watching === false && w.coming === null && w.looks === null && w.fallbackPollMs === 10000, w);
    N._test.learnSignal({ ok: true, watching: true, coming: true, changes: 'poll', changesWhy: 'Windows would not send ...', pollMs: 100, looks: 'wal-index header', looksWhy: null });
    N._test.S.watching = true;
    w = N.watchState();
    check('4c the watch reply\'s poll, change source and looks are kept', w.watching === true && w.coming === true && w.changes === 'poll' && w.pollMs === 100 && w.looks === 'wal-index header' && w.looksWhy === null, w);
    side.emit('notifications.looks', { ev: 'notifications.looks', looks: 'data_version', looksWhy: 'the notification database changed while its WAL-index header did not, so every look now asks SQLite' });
    w = N.watchState();
    check('4d a shortcut switched off mid-run (the helper\'s notifications.looks event) reaches the state', w.looks === 'data_version' && /WAL-index header did not/.test(w.looksWhy), w);
    w.looks = 'tampered';
    check('4e watchState() is a copy', N.watchState().looks === 'data_version');
    check('4f the words for it', statusOf({ on: true, helperReady: true, watch: N.watchState() }).why === 'checking every 0.1 s, because Windows won\'t send change events to this app; each check asks the notification database, because the quick check missed a change');
  } finally {
    Module._load = load;
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* temp */ }
  }
}

// ------------------------------------------------------------------ PART 5: restore-banners.ps1 -TestOnly -SettingsKey
function part5() {
  const key = `Software\\MantleTest\\notif-safety-${TAG}-p5\\Settings`;
  const base = `HKCU\\${key}`;
  const other = `Other.App.${TAG}`;
  const mine = `Mantle.ToastTest.${TAG}-d`;
  const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-rb-testonly-'));
  const rec = path.join(DIR, 'notif-banners.json');
  try {
    for (const a of [other, mine]) reg(['add', `${base}\\${a}`, '/v', 'ShowBanner', '/t', 'REG_DWORD', '/d', '0', '/f']);
    fs.writeFileSync(rec, JSON.stringify({ v: 1, owned: { [other]: 1, [mine]: 1 }, released: [] }));
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, '..', '..', 'tools', 'restore-banners.ps1'),
      '-RecordFile', rec, '-SettingsKey', key, '-TestOnly'], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    const val = (a) => { const q = reg(['query', `${base}\\${a}`, '/v', 'ShowBanner']); const m = /0x([0-9a-f]+)/i.exec(q.stdout || ''); return m ? parseInt(m[1], 16) : null; };
    check('5a -TestOnly -SettingsKey: the test id is put back in the scratch key', r.status === 0 && val(mine) === 1, r.stdout);
    check('5b -TestOnly: any other id is left exactly as it is, and said', val(other) === 0 && /left\s+Other\.App\..*-TestOnly/.test(r.stdout), r.stdout);

    // ---- lane mantle-notif-owner2 (finding 3): the script's put-back marker, notif-banners-back.script.json
    const mine2 = `Mantle.ToastTest.${TAG}-e`;   // original: no value, no stamp in the record
    const mine3 = `Mantle.ToastTest.${TAG}-f`;   // not 0 (already back): left, so never listed
    const MARK = path.join(DIR, 'notif-banners-back.script.json');
    const readMark = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')); } catch (_) { return null; } };
    const runScript = (recFile) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, '..', '..', 'tools', 'restore-banners.ps1'),
      '-RecordFile', recFile, '-SettingsKey', key, '-TestOnly'], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    const STAMP = 1760000000123;
    reg(['add', `${base}\\${mine}`, '/v', 'ShowBanner', '/t', 'REG_DWORD', '/d', '0', '/f']);
    reg(['add', `${base}\\${mine2}`, '/v', 'ShowBanner', '/t', 'REG_DWORD', '/d', '0', '/f']);
    reg(['add', `${base}\\${mine3}`, '/v', 'ShowBanner', '/t', 'REG_DWORD', '/d', '1', '/f']);
    fs.writeFileSync(rec, JSON.stringify({ v: 1, owned: { [other]: 1, [mine]: 1, [mine2]: null, [mine3]: 1 }, taken: { [other]: 77, [mine]: STAMP, [mine3]: 5 }, released: [] }));
    // the script's file from earlier runs: 305 old entries and an old one for `mine`, so a merge and the 300 cap show
    const old = {};
    for (let i = 1; i <= 305; i++) old[`Old.App.${i}`] = { at: i, took: i };
    old[mine] = { at: 0, took: 1 };
    fs.writeFileSync(MARK, JSON.stringify({ v: 1, back: old }));
    const t0 = Date.now();
    const r2 = runScript(rec);
    const m = readMark(MARK);
    const b = (m && m.back) || {};
    check('5c the put-back still reports as before (exit 0, verified, both test apps back)', r2.status === 0 && /^verified$/m.test(r2.stdout) && /2 put back to Windows' own pop-up/.test(r2.stdout) && val(mine) === 1 && val(mine2) === null, r2.stdout);
    check('5c the marker lists `mine` with the record\'s stamp and a fresh time, `mine2` with took null',
      !!(m && m.v === 1 && b[mine] && b[mine].took === STAMP && typeof b[mine].at === 'number' && b[mine].at >= t0 - 5000 && b[mine2] && b[mine2].took === null), { mine: b[mine], mine2: b[mine2], v: m && m.v });
    check('5d only apps it put back: not the -TestOnly one, not the one that was not 0', !!m && !(other in b) && !(mine3 in b), Object.keys(b).filter((k) => !/^Old\.App\./.test(k)));
    check('5e merged with its own earlier entries, at most 300, the oldest dropped', Object.keys(b).length === 300 && !!b['Old.App.305'] && !!b['Old.App.8'] && !b['Old.App.7'] && !b['Old.App.1'], { n: Object.keys(b).length, has1: !!b['Old.App.1'], has7: !!b['Old.App.7'], has8: !!b['Old.App.8'] });
    check('5f atomic: no temp file left, and the output says the marker was written', !fs.readdirSync(DIR).some((f) => /\.tmp$/i.test(f)) && /marker/i.test(r2.stdout) && /notif-banners-back\.script\.json/.test(r2.stdout), { files: fs.readdirSync(DIR), out: r2.stdout });

    // a torn marker of its own: the put-back is not failed, the marker is written afresh
    reg(['add', `${base}\\${mine}`, '/v', 'ShowBanner', '/t', 'REG_DWORD', '/d', '0', '/f']);
    fs.writeFileSync(MARK, '{"v":1,"back":{"x":');
    const r3 = runScript(rec);
    const m3 = readMark(MARK);
    check('5g a torn marker file: the put-back still succeeds (exit 0, verified)', r3.status === 0 && /^verified$/m.test(r3.stdout) && val(mine) === 1, r3.stdout);
    check('5g ...and the marker is written afresh with what it put back', !!(m3 && m3.v === 1 && m3.back && m3.back[mine] && m3.back[mine].took === STAMP && Object.keys(m3.back).length === 1), m3);

    // a marker that cannot be written (a folder in its place): the put-back is still done and verified, and said
    const DIR2 = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-rb-mark-'));
    try {
      const rec2 = path.join(DIR2, 'notif-banners.json');
      fs.writeFileSync(rec2, JSON.stringify({ v: 1, owned: { [mine]: 1 }, taken: { [mine]: STAMP }, released: [] }));
      fs.mkdirSync(path.join(DIR2, 'notif-banners-back.script.json'));
      reg(['add', `${base}\\${mine}`, '/v', 'ShowBanner', '/t', 'REG_DWORD', '/d', '0', '/f']);
      const r4 = runScript(rec2);
      check('5h a marker that cannot be written never fails the put-back (exit 0, verified, value back)', r4.status === 0 && /^verified$/m.test(r4.stdout) && val(mine) === 1, r4.stdout);
      check('5h ...the output says the marker was NOT written, and no temp file is left', /marker NOT written/.test(r4.stdout) && !fs.readdirSync(DIR2).some((f) => /\.tmp$/i.test(f)), { out: r4.stdout, files: fs.readdirSync(DIR2) });
    } finally { try { fs.rmSync(DIR2, { recursive: true, force: true }); } catch (_) { /* temp */ } }
  } finally {
    reg(['delete', `HKCU\\Software\\MantleTest\\notif-safety-${TAG}-p5`, '/f']);
    check('5p the scratch key is gone afterwards', reg(['query', `HKCU\\Software\\MantleTest\\notif-safety-${TAG}-p5`]).status !== 0);
    try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (_) { /* temp */ }
  }
}

// ------------------------------------------------------------------ PART 6: main's way out with a crash supervisor
/*
 * FINDING 4 (lane mantle-notif-owner2): at sign-out the helper can be gone before main; the blocking
 * put-back (spawnSync, up to 15 s) can then raise "Mantle is preventing shutdown". With a crash
 * supervisor watching main (host.toasts.supervised()), it puts the banners back the moment main is gone,
 * so main's 'exit' and a stop() during main's shutdown (host.toasts.quitting()) skip the blocking run.
 * Never skipped while main keeps running, nor for a host without the hooks. child_process is faked: no
 * PowerShell runs and no registry is touched here.
 */
async function part6() {
  const realCP = require('child_process');
  const isScript = (args) => Array.isArray(args) && args.some((a) => /restore-banners\.ps1$/i.test(String(a)));
  const calls = [];
  const OUT = 'mantle restore-banners\n  1 put back to Windows\' own pop-up, 0 left as they were\nverified\n';
  const fakeCP = Object.assign({}, realCP, {
    spawnSync(exe, args) {
      if (!isScript(args)) return realCP.spawnSync.apply(realCP, arguments);
      calls.push('sync');
      return { status: 0, stdout: OUT, stderr: '', error: null };
    },
    spawn(exe, args) {
      if (!isScript(args)) return realCP.spawn.apply(realCP, arguments);
      calls.push('async');
      const EventEmitter = require('events');
      const c = new EventEmitter();
      c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.kill = () => {};
      setImmediate(() => { c.stdout.emit('data', OUT); c.emit('close', 0); });
      return c;
    },
  });
  class FakeWin { constructor() { this.webContents = { on() {}, setWindowOpenHandler() {}, getOSProcessId() { return 1; } }; } on() {} loadFile() {} isDestroyed() { return false; } destroy() {} setAlwaysOnTop() {} setBounds() {} getBounds() { return { x: 0, y: 0, width: 0, height: 0 }; } isVisible() { return false; } showInactive() {} getNativeWindowHandle() { return Buffer.alloc(8); } }
  const DISPLAY = { workArea: { x: 0, y: 0, width: 1536, height: 800 }, scaleFactor: 1 };
  let USER_DATA = null;
  const fakeElectron = { BrowserWindow: FakeWin, screen: { getPrimaryDisplay: () => DISPLAY, getDisplayMatching: () => DISPLAY, on() {}, removeListener() {} }, app: { getPath: () => USER_DATA, getAppMetrics: () => [] } };
  const load = Module._load;
  Module._load = function (req) {
    if (req === 'child_process') return fakeCP;
    if (req === 'electron') return fakeElectron;
    if (req === '../bar-shape') return { apply: () => ({ ok: true }), verify: () => ({ ok: true }), readBack: () => ({ ok: true }) };
    if (req === '../raise') return { up() {} };
    return load.apply(this, arguments);
  };
  const envBefore = { key: process.env.MANTLE_TEST_BANNERS_KEY, grace: process.env.MANTLE_TEST_BANNERS_GRACE_MS };
  // never reached (the fake answers), but a scratch key all the same, and no grace run during the test
  process.env.MANTLE_TEST_BANNERS_KEY = `Software\\MantleTest\\notif-safety-${TAG}-p6\\Settings`;
  process.env.MANTLE_TEST_BANNERS_GRACE_MS = '600000';
  const dirs = [];
  const file = process.env.TOASTS_JS ? path.resolve(process.env.TOASTS_JS) : path.join(__dirname, 'toasts.js');
  // part 3's copy bound part 3's fake electron (its userData is gone): load toasts.js afresh against ours
  delete require.cache[require.resolve(file)];

  /** One install with an in-memory helper that owns one test app; hooks = the host's extra functions. */
  async function rig(hooks) {
    USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-toasts-exit-'));
    dirs.push(USER_DATA);
    const feature = require(file);
    const id = `Mantle.ToastTest.${TAG}-p6`;
    const regv = { [id]: null };
    const t = { logs: [], status: [], ready: [], listFns: [], exitBefore: process.listeners('exit').slice() };
    t.ctx = {
      name: 'toasts', flags: { test: true }, preload: 'preload.js',
      log: (s) => t.logs.push(s),
      sidecar: {
        ready: true,
        async send(cmd, args) {
          if (!t.ctx.sidecar.ready) return { ok: false, error: 'the sidecar is not running' };
          if (cmd === 'toasts.banners' && args.op === 'read') return { ok: true, result: { ok: true, reason: null, apps: Object.keys(regv).map((a) => ({ aumid: a, banner: regv[a], enabled: null, odd: false })) } };
          if (cmd === 'toasts.banners' && args.op === 'write') return { ok: true, result: { ok: true, reason: null, results: args.set.map((s) => { regv[s.aumid] = s.value; return { aumid: s.aumid, ok: true, now: s.value, reason: null }; }) } };
          if (cmd === 'toasts.quiet') return { ok: true, result: { ok: true, dnd: 0, quns: 5 } };
          return { ok: false, error: `unknown command ${cmd}` };
        },
        on(ev, fn) { if (ev === 'status') t.status.push(fn); return () => {}; },
        onReady(fn) { t.ready.push(fn); if (t.ctx.sidecar.ready) fn(); return () => {}; },
      },
      command() {}, health() {}, enabled: () => true, onEnabled() {}, page: (f) => `ui/toasts/${f}`, push() { return true; },
      host: { barRect: () => null, toasts: Object.assign({
        onList: (fn) => { t.listFns.push(fn); return () => {}; }, last: () => null, targetFor: () => null, openList: () => ({ ok: true }),
        watch: () => ({ watching: true, watchReason: null, fallbackPollMs: 10000, coming: true, changes: 'events', why: null, pollMs: null, looks: null, looksWhy: null, missed: 0 }),
      }, hooks || {}) },
    };
    t.inst = feature.install(t.ctx);
    for (const fn of t.listFns) fn({ ok: true, access: 'Allowed', available: true, toasts: [] });
    t.took = await until(() => regv[id] === 0, 5000);
    t.down = () => { t.ctx.sidecar.ready = false; for (const fn of t.status) fn({ status: 'down', reason: 'sidecar exited with code 1; restarting in 3 s (attempt 1 of 3).' }); };
    t.exitHook = () => process.listeners('exit').filter((f) => !t.exitBefore.includes(f));
    t.stop = (why) => { const r = t.inst.stop(why); t.inst = null; return r; };
    return t;
  }
  const said = (t) => t.logs.some((l) => /supervisor/i.test(l) && /puts? .*back/i.test(l));
  const rigs = [];
  try {
    // ---- the 'exit' handler
    let t = await rig({ supervised: () => true, quitting: () => true });
    rigs.push(t);
    check('6 the rig: Mantle took its test app', t.took);
    t.down();
    let n = calls.length;
    const hook = t.exitHook();
    check('6a main exits with the helper down and a supervisor: one exit listener', hook.length === 1, hook.length);
    if (hook.length) hook[0](0);
    check('6a ...the blocking put-back is SKIPPED (the supervisor does it)', calls.length === n, calls.slice(n));
    check('6a ...and one log line says the supervisor puts them back', said(t), t.logs.slice(-3));
    t.ctx.sidecar.ready = true; t.stop('cleanup');

    t = await rig({ supervised: () => false, quitting: () => true });
    rigs.push(t);
    t.down();
    n = calls.length;
    for (const f of t.exitHook()) f(0);
    check('6b main exits with the helper down and NO supervisor: the blocking put-back runs', calls.slice(n).join() === 'sync', calls.slice(n));
    t.ctx.sidecar.ready = true; t.stop('cleanup');

    t = await rig(null);
    rigs.push(t);
    t.down();
    n = calls.length;
    for (const f of t.exitHook()) f(0);
    check('6c an older host (no supervised/quitting hooks): the exit put-back runs as before', calls.slice(n).join() === 'sync', calls.slice(n));
    t.ctx.sidecar.ready = true; t.stop('cleanup');

    t = await rig({ supervised: () => { throw new Error('the supervisor state is not there'); }, quitting: () => true });
    rigs.push(t);
    t.down();
    n = calls.length;
    for (const f of t.exitHook()) f(0);
    check('6d a supervised() hook that throws counts as "no supervisor": the put-back runs', calls.slice(n).join() === 'sync', calls.slice(n));
    t.ctx.sidecar.ready = true; t.stop('cleanup');

    // ---- stop()
    t = await rig({ supervised: () => true, quitting: () => true });
    rigs.push(t);
    t.down();
    n = calls.length;
    const r1 = t.stop('Mantle quit');
    if (r1 && r1.then) await r1;
    check('6e stop() during main\'s shutdown with a supervisor: no blocking put-back', calls.length === n, calls.slice(n));
    check('6e ...said', said(t), t.logs.slice(-3));
    check('6e ...and the exit listener is gone', t.exitHook().length === 0, t.exitHook().length);

    t = await rig({ supervised: () => true, quitting: () => false });
    rigs.push(t);
    t.down();
    n = calls.length;
    const r2 = t.stop('the feature restarted');
    if (r2 && r2.then) await r2;
    check('6f stop() while main KEEPS RUNNING (supervised, not quitting): the put-back still runs', calls.slice(n).join() === 'sync', calls.slice(n));

    t = await rig({ supervised: () => false, quitting: () => true });
    rigs.push(t);
    t.down();
    n = calls.length;
    const r3 = t.stop('Mantle quit');
    if (r3 && r3.then) await r3;
    check('6g stop() during shutdown with NO supervisor: the put-back runs', calls.slice(n).join() === 'sync', calls.slice(n));

    t = await rig(null);
    rigs.push(t);
    t.down();
    n = calls.length;
    const r4 = t.stop('Mantle quit');
    if (r4 && r4.then) await r4;
    check('6h stop() on an older host: the put-back runs as before', calls.slice(n).join() === 'sync', calls.slice(n));
  } finally {
    for (const t of rigs) { if (t.inst) { try { t.ctx.sidecar.ready = true; t.inst.stop('test cleanup'); } catch (_) { /* best effort */ } } }
    Module._load = load;
    if (envBefore.key === undefined) delete process.env.MANTLE_TEST_BANNERS_KEY; else process.env.MANTLE_TEST_BANNERS_KEY = envBefore.key;
    if (envBefore.grace === undefined) delete process.env.MANTLE_TEST_BANNERS_GRACE_MS; else process.env.MANTLE_TEST_BANNERS_GRACE_MS = envBefore.grace;
    for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* temp */ } }
  }
}

(async () => {
  try {
    if (!process.env.TOASTS_JS) { await part1(); part2(); await part4(); part5(); }
    await part3();
    await part6();
  } catch (err) {
    failures.push(`CRASHED ${err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : err}`);
  }
  for (const f of failures) console.log(`FAIL ${f}`);
  console.log(`TOASTS SAFETY TEST: ${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();
