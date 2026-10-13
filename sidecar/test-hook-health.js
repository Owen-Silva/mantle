'use strict';
// Functional test: the dead-hook check and re-arm (lane mn-hook, 2026-10-12; audit #15).
//
// Windows silently removes a low-level hook that answers too slowly. This drives the REAL sidecar
// (passive) through what that looks like and checks Mantle notices and puts the hook back:
//   1. the two verdicts (HookHealth.KeyVerdict / PopVerdict), pure;
//   2. a test-only pass-through keyboard hook (every feature off: it never swallows a key), dropped
//      the way Windows drops it (unhooked, handle kept), then raw key events with no hook call:
//      re-installed, one plain log line, backoff, a failed re-install shown as a state reason
//      (and main's lib/hook-health.js turning it into the Win key's state piece), and the wake rearm;
//   3. the pop-up watch's mouse hook dropped the same way: re-installed once per pop-up, plus rearm;
//   4. idle CPU with the hook and its raw-input check on: nothing runs while nobody types.
// It never injects a key and never touches a live Mantle. Prints "hook-health: N passed, M failed".

const { execFileSync } = require('child_process');
const T = require('./test-lib');
const { makeHookHealth } = require('../lib/hook-health');

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { passed++; return true; }
  failures.push(detail ? `${name} (${detail})` : name);
  return false;
}
const J = (x) => JSON.stringify(x).slice(0, 300);

async function nextEvent(s, from, pred, ms) {
  const until = Date.now() + ms;
  for (;;) {
    for (let i = from; i < s.events.length; i++) if (pred(s.events[i])) return s.events[i];
    if (Date.now() >= until) return null;
    await T.sleep(20);
  }
}
const logLike = (re) => (e) => e.ev === 'log' && re.test(e.message || '');

async function verdicts(s) {
  const kv = async (name, args, want) => {
    const r = await s.send('hotkey', Object.assign({ op: 'hookhealth' }, args), 4000);
    check(`key verdict: ${name}`, r.ok && r.result.verdict === want, J(r));
  };
  await kv('3 raw key events is not enough', { raw: 3, sinceHookMs: 60000 }, 'alive');
  await kv('4 events but a callback 1.4 s ago', { raw: 4, sinceHookMs: 1499 }, 'alive');
  await kv('4 events, no callback for 1.5 s: dead', { raw: 4, sinceHookMs: 1500 }, 'dead');
  await kv('dead, never re-installed', { raw: 40, sinceHookMs: 9000, sinceHealMs: -1 }, 'dead');
  await kv('dead, re-installed 5 s ago: wait', { raw: 40, sinceHookMs: 9000, sinceHealMs: 5000 }, 'wait');
  await kv('dead, re-installed 15 s ago: try again', { raw: 40, sinceHookMs: 9000, sinceHealMs: 15000 }, 'dead');
  const pv = async (name, aheadMs, agoMs, want) => {
    const r = await s.send('hotkey', { op: 'hookhealth', aheadMs, agoMs }, 4000);
    check(`pop-up verdict: ${name}`, r.ok && r.result.dead === want, J(r));
  };
  await pv('input 251 ms past the last call, 300 ms old: dead', 251, 300, true);
  await pv('input 250 ms past: within the slack', 250, 300, false);
  await pv('input not yet 300 ms old: the call may still come', 1000, 299, false);
  await pv('input before the last call: alive', -40, 2000, false);
  await pv('input 10 s old: too stale to judge', 1000, 10000, false);
}

async function keyboard(s) {
  const hk = (args, ms) => s.send('hotkey', args, ms || 6000);
  let r = await hk({ op: 'status' });
  check('passive: no keyboard hook to begin with', r.ok && r.result.installed === false && r.result.healthy === true, J(r));
  r = await hk({ op: 'rearm', why: 'the PC woke up' });
  check('rearm with no hook: nothing to re-install, said plainly', r.ok && r.result.keyboard === false && r.result.popwatch === false, J(r));
  r = await hk({ op: 'hookdrop' });
  check('hookdrop with no hook is refused with the way to get one', !r.ok && /hooktest/.test(r.error || ''), J(r));

  r = await hk({ op: 'hooktest', on: true });
  check('test hook installed, raw-input check on, healthy', r.ok && r.result.installed === true && r.result.rawCheck === true &&
    r.result.healthy === true && r.result.rehooks === 0 && r.result.winTap === false, J(r));
  if (!r.ok || !r.result.installed) return;

  // A live hook: raw events right after a callback (install counts as one) are not a dead hook.
  r = await hk({ op: 'rawkeys', n: 6, trust: true });
  await T.sleep(200);
  r = await hk({ op: 'status' });
  check('6 raw events within 1.5 s of the last call: no re-install', r.ok && r.result.heals === 0 && r.result.rehooks === 0, J(r));
  // A fresh test hook for the rest (those pretend events had no call behind them, unlike real keys).
  await hk({ op: 'hooktest', on: false });
  r = await hk({ op: 'hooktest', on: true });
  check('test hook re-made: the count starts at 0', r.ok && r.result.installed === true && r.result.rawSinceHook === 0, J(r));

  // Windows drops it.
  r = await hk({ op: 'hookdrop' });
  check('hookdrop: unhooked behind the sidecar\'s back', r.ok && r.result.dropped === true, J(r));
  await T.sleep(1700);
  r = await hk({ op: 'rawkeys', n: 3, trust: true });
  await T.sleep(150);
  r = await hk({ op: 'status' });
  check('3 events with no call (below the threshold): still waiting', r.ok && r.result.heals === 0, J(r));
  let from = s.events.length;
  r = await hk({ op: 'rawkeys', n: 3, trust: true });
  let line = await nextEvent(s, from, logLike(/^keyboard hook: Windows stopped calling it/), 2000);
  check('keys with no call: one plain log line saying it was re-installed',
    !!line && /re-installed \(1 time this run\)/.test(line.message) && line.level === 'warn' && !/\\|[A-Z]:\//.test(line.message), J(line));
  r = await hk({ op: 'status' });
  check('status after the heal: re-installed once, healthy, the count reset', r.ok && r.result.heals === 1 && r.result.rehooks === 1 &&
    r.result.healthy === true && r.result.rawSinceHook < 4 && r.result.lastCallbackAgoMs < 1500, J(r));

  // Dropped again at once: the backoff holds the next try for 15 s.
  await hk({ op: 'hookdrop' });
  await T.sleep(1700);
  from = s.events.length;
  await hk({ op: 'rawkeys', n: 8, trust: true });
  line = await nextEvent(s, from, logLike(/^keyboard hook:/), 600);
  r = await hk({ op: 'status' });
  check('dropped again within 15 s: no second re-install yet (backoff)', !line && r.ok && r.result.heals === 1 && r.result.rawSinceHook >= 8, J(r));

  // The wake rearm: unconditional, plain words, counts.
  from = s.events.length;
  r = await hk({ op: 'rearm', why: 'the PC woke up' });
  check('rearm: the keyboard hook is re-installed', r.ok && r.result.keyboard === true, J(r));
  line = await nextEvent(s, from, logLike(/^keyboard hook: the PC woke up, and Windows can drop the hook then without saying so; it was re-installed \(2 times this run\)/), 2000);
  check('rearm: one info line in plain words', !!line && line.level === 'info', J(line));
  r = await hk({ op: 'status' });
  check('status after rearm: 2 re-installs, the count reset', r.ok && r.result.rehooks === 2 && r.result.rawSinceHook === 0, J(r));

  // A re-install Windows refuses: the state says so, with the reason, until one works.
  const pieces = [];
  const hh = makeHookHealth({ state: { set: (k, v) => { pieces.push([k, v]); } }, call: () => Promise.resolve(null) });
  await T.sleep(15100 - 1700);   // past the backoff from the heal above
  await hk({ op: 'hookdrop' });
  await T.sleep(1700);
  from = s.events.length;
  await hk({ op: 'rawkeys', n: 6, trust: true, failRehook: true });
  const bad = await nextEvent(s, from, (e) => e.ev === 'switcher' && e.op === 'hook' && e.healthy === false, 2000);
  check('a refused re-install is announced: unhealthy, with a reason in plain words',
    !!bad && /refused to put it back \(Win32 error 5\)/.test(bad.health || '') && /Windows' Start/.test(bad.health || ''), J(bad));
  r = await hk({ op: 'status' });
  check('status shows it too', r.ok && r.result.healthy === false && /refused/.test(r.result.health || ''), J(r));
  if (bad) hh.onHook(bad);
  check("main's state piece: the Win key is Windows' own, with that reason",
    pieces.length === 1 && pieces[0][0] === 'hotkey' && pieces[0][1].winTap === false && pieces[0][1].reason === bad.health, J(pieces));
  from = s.events.length;
  await hk({ op: 'rearm', why: 'the screen was unlocked' });
  const good = await nextEvent(s, from, (e) => e.ev === 'switcher' && e.op === 'hook' && e.healthy === true, 2000);
  check('the next re-install that works clears it, announced', !!good && good.health == null, J(good));
  if (good) hh.onHook(good);
  check("main's state piece gets its normal words back", pieces.length === 2 && /keyboard hook is back|put back/.test(pieces[1][1].reason), J(pieces));
  hh.onHook({ op: 'hook', healthy: true, winTap: false });
  check('a healthy announce with nothing broken leaves the state alone', pieces.length === 2, J(pieces));

  // main's rearm (lib/hook-health.js), wired to the real sidecar, then to one that fails.
  const calls = [];
  const live = makeHookHealth({ state: { set() {} }, call: (cmd, args, ms) => { calls.push([cmd, args, ms]); return s.send(cmd, args, ms); } });
  r = await live.rearm('the PC woke up');
  check("main's rearm sends hotkey {op:'rearm', why} and gets the sidecar's answer",
    calls.length === 1 && calls[0][0] === 'hotkey' && calls[0][1].op === 'rearm' && calls[0][1].why === 'the PC woke up' &&
    r && r.ok && r.result.keyboard === true, J({ calls, r }));
  const logged = [];
  const dead = makeHookHealth({ state: { set() {} }, call: () => Promise.reject(new Error('the sidecar is down')), log: (l) => logged.push(l) });
  r = await dead.rearm('the screen was unlocked');
  check("main's rearm with the sidecar down: resolves, says why in the log", r === null && logged.length === 1 &&
    /could not ask the sidecar to re-install its hooks \(the screen was unlocked\): the sidecar is down/.test(logged[0]), J(logged));
}

async function popup(s) {
  const pw = (extra) => s.send('hotkey', Object.assign({ op: 'popwatch' }, extra), 6000);
  let r = await s.send('hotkey', { op: 'popdrop', input: true }, 4000);
  check('popdrop with no watch is refused', !r.ok && /not on/.test(r.error || ''), J(r));
  r = await pw({ on: true, leaseMs: 20000 });
  check('pop-up watch armed', r.ok && r.result.armed === true, J(r));
  r = await pw({});
  check('both of its hooks are in', r.ok && r.result.hooked === true && r.result.rehooks === 0, J(r));
  await T.sleep(600);
  let from = s.events.length;
  r = await s.send('hotkey', { op: 'popdrop', input: true }, 4000);
  check('popdrop: the mouse hook unhooked behind its back, input pretended', r.ok && r.result.dropped === true, J(r));
  let line = await nextEvent(s, from, logLike(/^pop-up watch: input reached Windows \d+ ms ago and neither of its hooks was called/), 2000);
  check('input no hook saw: one plain line, both hooks re-installed', !!line && /re-installed \(1 time this run\)/.test(line.message), J(line));
  r = await pw({});
  check('status: still armed, hooked, one heal', r.ok && r.result.armed === true && r.result.hooked === true && r.result.heals === 1 && r.result.rehooks === 1, J(r));
  await T.sleep(400);
  from = s.events.length;
  await s.send('hotkey', { op: 'popdrop', input: true }, 4000);
  line = await nextEvent(s, from, logLike(/^pop-up watch:/), 900);
  r = await pw({});
  check('one heal per pop-up: a second suspicion in the same pop-up does nothing', !line && r.ok && r.result.heals === 1, J(r));
  from = s.events.length;
  r = await s.send('hotkey', { op: 'rearm', why: 'the PC woke up' }, 4000);
  check('rearm reaches the pop-up watch', r.ok && r.result.popwatch === true, J(r));
  line = await nextEvent(s, from, logLike(/^pop-up watch: the PC woke up, and Windows can drop the hooks then without saying so; its hooks were re-installed \(2 times this run\)/), 2000);
  check('rearm: its hooks re-installed, said once', !!line && line.level === 'info', J(line));
  r = await pw({ on: false });
  await T.sleep(300);
  r = await s.send('hotkey', { op: 'rearm', why: 'the PC woke up' }, 4000);
  check('rearm with the watch off: nothing to re-install there', r.ok && r.result.popwatch === false, J(r));
}

function cpuMs(pid) {
  const out = execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).TotalProcessorTime.TotalMilliseconds`], { encoding: 'utf8' });
  return Number(out.trim());
}

async function idle(s) {
  const r = await s.send('hotkey', { op: 'status' }, 4000);
  if (!r.ok || !r.result.installed || !r.result.rawCheck) { check('idle CPU: hook and raw check on to measure', false, J(r)); return; }
  const tenSeconds = async () => { await T.sleep(1000); const a = cpuMs(s.proc.pid); await T.sleep(10000); return cpuMs(s.proc.pid) - a; };
  const seen0 = r.result.rawSeen;
  const from = s.events.length;
  const on = await tenSeconds();
  const st = (await s.send('hotkey', { op: 'status' }, 4000)).result || {};
  await s.send('hotkey', { op: 'hooktest', on: false }, 6000);
  const off = await tenSeconds();
  await s.send('hotkey', { op: 'hooktest', on: true }, 6000);
  // The hook thread itself (Alt+Tab's foreground tracking, which predates this) wakes on desktop
  // window changes, so the CPU numbers move with whatever else runs: printed, loosely bounded. What
  // the health check adds is one WM_INPUT per key and no timer, so with nobody typing it does nothing.
  console.log(`  idle CPU over 10 s: ${Math.round(on)} ms with the hook and its raw-input check, ${Math.round(off)} ms with no hook`);
  const hookLines = s.events.slice(from).filter(logLike(/^keyboard hook:|^pop-up watch:/));
  check('idle: no raw events, no health work, nothing logged', st.rawSeen === seen0 && st.heals === r.result.heals && hookLines.length === 0,
    J({ seen0, st: st.rawSeen, hookLines }));
  check('idle CPU with the hook on stays under 300 ms per 10 s', Number.isFinite(on) && on < 300, `${on} ms`);
}

(async () => {
  let s = null;
  try {
    s = await T.startPassive();
    await verdicts(s);
    await keyboard(s);
    await popup(s);
    await idle(s);
    const r = await s.send('hotkey', { op: 'nope' }, 4000);
    check('an unknown op lists rearm and hookhealth', !r.ok && /rearm, hookhealth/.test(r.error || ''), J(r));
    const unparse = s.events.filter((e) => e.ev === '__unparseable');
    check('every line the sidecar wrote was JSON', unparse.length === 0, unparse.slice(0, 2).map((e) => e.line).join(' | '));
  } catch (e) {
    check('the run', false, e.stack || e.message);
  }
  if (s) {
    s.proc.stdin.write(JSON.stringify({ id: 999999, cmd: 'quit' }) + '\n');
    let ex = null;
    try { ex = await s.waitExit(3000); } catch (e) { try { s.proc.kill(); } catch (_) { /* gone */ } }
    check('quit with the test hook in: exits 0 within 3 s', ex && ex.code === 0, ex ? `exit ${ex.code}` : 'killed');
    await s.stop();
  }
  console.log(`hook-health: ${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log('  FAIL ' + f);
  process.exit(failures.length || !passed ? 1 : 0);
})();
