// test-popwatch.js - the pop-up watch (Hotkey.cs, class PopWatch): while a bar pop-up is open the
// sidecar watches for a click anywhere and for Esc, so the pop-up closes like a macOS menu.
//
//   node sidecar/test-popwatch.js [--exe=<path>]
//
// Two halves:
//   1. the Esc verdict, `hotkey {op:'popesc'}`: the pure function the keyboard hook asks on every
//      Esc, driven through every rule (swallow, report once, autorepeat, keyup, modifiers, the bar in
//      front, passive);
//   2. the real hooks, in PASSIVE mode only: arm, status, renew, the lease running out, disarm, and
//      the argument errors. A passive sidecar only OBSERVES Esc, so nothing is ever swallowed.
//
// NEVER injects input (no SendInput clicks or keys): the window in front on this machine is Helm,
// where an Esc interrupts every running agent. The real click / Esc path is checked by hand in the
// visible slot.
//
// Prints one summary line: "popwatch: N passed, M failed". Plain node, no deps.
'use strict';
const T = require('./test-lib');

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { passed++; return true; }
  failures.push(detail ? `${name} (${detail})` : name);
  return false;
}

const ESC = 0x1B;
const NO_MODS = { ctrl: false, alt: false, shift: false, win: false };

/** Events of `name` that arrived at index >= from, matching pred, within ms. */
async function nextEvent(s, from, pred, ms) {
  const until = Date.now() + ms;
  for (;;) {
    for (let i = from; i < s.events.length; i++) if (pred(s.events[i])) return { ev: s.events[i], at: Date.now() };
    if (Date.now() >= until) return null;
    await T.sleep(20);
  }
}

async function verdicts(s) {
  async function v(name, args, want) {
    const req = Object.assign({ op: 'popesc', vk: ESC, down: true, mods: NO_MODS, fgIsBar: false, passive: false, held: false }, args);
    try {
      const r = await s.send('hotkey', req, 4000);
      const got = r.ok ? r.result : null;
      const ok = !!got && got.swallow === want.swallow && got.report === want.report && got.held === want.held;
      check('popesc: ' + name, ok, JSON.stringify(r).slice(0, 200) + ' want ' + JSON.stringify(want));
    } catch (e) { check('popesc: ' + name, false, e.message); }
  }
  const SWALLOW_REPORT = { swallow: true, report: true, held: true };
  const PASS = { swallow: false, report: false, held: false };

  await v('the first Esc down is swallowed and reported', {}, SWALLOW_REPORT);
  await v('an autorepeat Esc down is swallowed, not reported again', { held: true }, { swallow: true, report: false, held: true });
  await v('the up of a swallowed Esc is swallowed too', { down: false, held: true }, { swallow: true, report: false, held: false });
  await v('an Esc up with no swallowed down passes', { down: false, held: false }, PASS);
  for (const m of ['ctrl', 'alt', 'shift', 'win']) {
    const mods = Object.assign({}, NO_MODS, { [m]: true });
    await v(`Esc down with ${m} held passes, not reported`, { mods }, PASS);
    await v(`autorepeat Esc down with ${m} now held passes and lets the press go`, { mods, held: true }, PASS);
    await v(`the up of a swallowed Esc is still swallowed with ${m} held`, { mods, down: false, held: true },
      { swallow: true, report: false, held: false });
  }
  await v('Esc down with the bar in front passes (its page has Escape)', { fgIsBar: true }, PASS);
  await v('passive: the first Esc down is reported but never swallowed', { passive: true }, { swallow: false, report: true, held: true });
  await v('passive: an autorepeat down is not reported again', { passive: true, held: true }, { swallow: false, report: false, held: true });
  await v('passive: the up is never swallowed', { passive: true, down: false, held: true }, PASS);
  await v('a non-Esc key down passes, not reported', { vk: 0x41 }, PASS);
  await v('a non-Esc key up passes, not reported', { vk: 0x0D, down: false }, PASS);
  await v('a non-Esc key leaves a held Esc held', { vk: 0x41, held: true }, { swallow: false, report: false, held: true });
  await v('no mods given reads as none held', { mods: undefined }, SWALLOW_REPORT);

  async function bad(name, req, re) {
    try {
      const r = await s.send('hotkey', Object.assign({ op: 'popesc' }, req), 4000);
      check('popesc refuses ' + name, r.ok === false && re.test(r.error || ''), JSON.stringify(r).slice(0, 200));
    } catch (e) { check('popesc refuses ' + name, false, e.message); }
  }
  await bad('a missing vk', { down: true }, /needs vk/);
  await bad('a missing down', { vk: ESC }, /needs down/);
  await bad('mods that are not an object', { vk: ESC, down: true, mods: 'ctrl' }, /mods must be an object/);
}

// MENU KEYS (the desktop right-click menu): `hotkey {op:'popnav'}`, the verdict for Up/Down/Home/End/Enter.
async function navVerdicts(s) {
  const UP = 0x26, DOWN = 0x28, HOME = 0x24, END = 0x23, ENTER = 0x0D;
  async function v(name, args, want) {
    const req = Object.assign({ op: 'popnav', vk: DOWN, down: true, mods: NO_MODS, fgIsBar: false, passive: false, nav: true, held: false }, args);
    try {
      const r = await s.send('hotkey', req, 4000);
      const got = r.ok ? r.result : null;
      const ok = !!got && got.swallow === want.swallow && got.report === want.report && got.held === want.held &&
        (want.key === undefined || got.key === want.key);
      check('popnav: ' + name, ok, JSON.stringify(r).slice(0, 200) + ' want ' + JSON.stringify(want));
    } catch (e) { check('popnav: ' + name, false, e.message); }
  }
  const TAKE = { swallow: true, report: true, held: true };
  const PASS = { swallow: false, report: false, held: false };
  for (const [vk, key] of [[UP, 'up'], [DOWN, 'down'], [HOME, 'home'], [END, 'end'], [ENTER, 'enter']]) {
    await v(`a menu open: ${key} down is swallowed and reported as '${key}'`, { vk }, Object.assign({ key }, TAKE));
  }
  await v('an autorepeat Down is reported again (a held arrow walks the menu)', { held: true }, TAKE);
  await v('an autorepeat Enter is swallowed, not reported again (one pick)', { vk: ENTER, held: true }, { swallow: true, report: false, held: true });
  await v('the up of a swallowed key is swallowed too', { down: false, held: true }, { swallow: true, report: false, held: false });
  await v('an up with no swallowed down passes', { down: false }, PASS);
  await v('no menu open (nav off): Down passes, not reported', { nav: false }, PASS);
  await v('no menu open: Enter passes (a bar pop-up never takes it)', { vk: ENTER, nav: false }, PASS);
  await v('nav off, but the up of a key it swallowed is still taken', { nav: false, down: false, held: true }, { swallow: true, report: false, held: false });
  for (const m of ['ctrl', 'alt', 'shift', 'win']) {
    await v(`Down with ${m} held passes (the app's)`, { mods: Object.assign({}, NO_MODS, { [m]: true }) }, PASS);
  }
  await v('Down with the bar in front passes', { fgIsBar: true }, PASS);
  await v('passive: reported, never swallowed', { passive: true }, { swallow: false, report: true, held: true });
  await v('passive: the up is never swallowed', { passive: true, down: false, held: true }, PASS);
  await v('Esc is not a menu key (EscVerdict has it)', { vk: ESC }, Object.assign({ key: null }, PASS));
  await v('Left is not a menu key (no submenus)', { vk: 0x25 }, PASS);
  try {
    const r = await s.send('hotkey', { op: 'popnav', down: true }, 4000);
    check('popnav refuses a missing vk', r.ok === false && /needs vk/.test(r.error || ''), JSON.stringify(r).slice(0, 200));
  } catch (e) { check('popnav refuses a missing vk', false, e.message); }
}

async function hooks(s) {
  const pw = (extra) => s.send('hotkey', Object.assign({ op: 'popwatch' }, extra), 6000);
  let r;

  // MENU KEYS: nav rides the arm and every renewal; absent means a plain pop-up.
  r = await pw({ on: true, nav: true });
  check('arm with nav:true: armed, says nav', r.ok && r.result.armed === true && r.result.nav === true, JSON.stringify(r));
  r = await pw({});
  check('status while a menu is open: nav true, keys counted', r.ok && r.result.nav === true && r.result.keys === 0, JSON.stringify(r));
  r = await pw({ on: true });
  check('a renewal without nav turns menu keys off', r.ok && r.result.renewed === true && r.result.nav === false, JSON.stringify(r));
  r = await pw({});
  check('status: nav false after that renewal', r.ok && r.result.nav === false, JSON.stringify(r));
  r = await pw({ on: true, nav: 'yes' });
  check('popwatch refuses nav that is not a bool', r.ok === false && /nav must be true/.test(r.error || ''), JSON.stringify(r).slice(0, 200));
  r = await pw({ on: false });
  check('disarm after the nav checks', r.ok && r.result.was === true, JSON.stringify(r));
  await T.sleep(200);

  r = await pw({});
  check('status before arming: not armed, Esc observe-only (passive)',
    r.ok && r.result.armed === false && r.result.esc === 'observe' && r.result.leaseLeftMs === 0, JSON.stringify(r));

  r = await pw({ on: true });
  check('arm in passive: armed, Esc observed not swallowed, default 6 s lease, fresh',
    r.ok && r.result.armed === true && r.result.esc === 'observe' && r.result.leaseMs === 6000 && r.result.renewed === false,
    JSON.stringify(r));

  r = await pw({});
  check('status while armed: armed, lease counting down from 6 s, counts present',
    r.ok && r.result.armed === true && r.result.leaseLeftMs > 4000 && r.result.leaseLeftMs <= 6000 &&
    typeof r.result.clicks === 'number' && typeof r.result.escs === 'number', JSON.stringify(r));

  r = await s.send('hotkey', { op: 'status' }, 4000);
  check('the pop-up watch is not the keyboard-shortcut hook (that one stays off in passive)',
    r.ok && r.result.installed === false, JSON.stringify(r).slice(0, 200));

  r = await pw({ on: true, leaseMs: 10000, hwnd: '12345' });
  check('arm again while armed: renewed, new lease, hwnd as a decimal string',
    r.ok && r.result.armed === true && r.result.renewed === true && r.result.leaseMs === 10000, JSON.stringify(r));
  r = await pw({});
  check('the renewal moved the deadline out', r.ok && r.result.leaseLeftMs > 8000, JSON.stringify(r));

  let from = s.events.length;
  r = await pw({ on: false });
  check('disarm: {armed:false, was:true}', r.ok && r.result.armed === false && r.result.was === true, JSON.stringify(r));
  let off = await nextEvent(s, from, (e) => e.ev === 'popwatch' && e.op === 'off', 1500);
  check('disarm announces {op:off, why:asked}', off && off.ev.why === 'asked', JSON.stringify(off));
  r = await pw({});
  check('status after disarm: not armed', r.ok && r.result.armed === false && r.result.leaseLeftMs === 0, JSON.stringify(r));
  r = await pw({ on: false });
  check('disarm when not armed: was:false', r.ok && r.result.armed === false && r.result.was === false, JSON.stringify(r));

  from = s.events.length;
  let t0 = Date.now();
  r = await pw({ on: true, leaseMs: 600 });
  check('arm with a 600 ms lease: fresh (the old thread was gone)', r.ok && r.result.leaseMs === 600 && r.result.renewed === false,
    JSON.stringify(r));
  off = await nextEvent(s, from, (e) => e.ev === 'popwatch' && e.op === 'off', 1500);
  const took = off ? off.at - t0 : -1;
  check('the lease runs out on its own: {op:off, why:lease} within 1.5 s', off && off.ev.why === 'lease' && took >= 500,
    JSON.stringify(off) + ` after ${took} ms`);
  r = await pw({});
  check('status after the lease: not armed', r.ok && r.result.armed === false, JSON.stringify(r));

  from = s.events.length;
  t0 = Date.now();
  r = await pw({ on: true, leaseMs: 10 });
  check('a lease under 500 ms is raised to 500', r.ok && r.result.leaseMs === 500, JSON.stringify(r));
  off = await nextEvent(s, from, (e) => e.ev === 'popwatch' && e.op === 'off', 1500);
  check('the 500 ms lease runs out', off && off.ev.why === 'lease', JSON.stringify(off));

  r = await pw({ on: true, leaseMs: 1e9 });
  check('a lease over 60 s is cut to 60 s', r.ok && r.result.leaseMs === 60000, JSON.stringify(r));
  from = s.events.length;
  r = await pw({ on: false });
  off = await nextEvent(s, from, (e) => e.ev === 'popwatch' && e.op === 'off', 1500);
  check('and it disarms when asked', r.ok && r.result.was === true && off && off.ev.why === 'asked', JSON.stringify(off));

  // Many quick arm/disarm cycles: every one must answer, and the last must leave nothing armed.
  let cyc = 0;
  for (let i = 0; i < 10; i++) {
    const a = await pw({ on: true, leaseMs: 2000 });
    const b = await pw({ on: false });
    if (a.ok && a.result.armed === true && b.ok && b.result.was === true) cyc++;
  }
  check('ten quick arm / disarm cycles all answer', cyc === 10, `${cyc} of 10`);
  await T.sleep(300);
  r = await pw({});
  check('after the cycles nothing is armed', r.ok && r.result.armed === false, JSON.stringify(r));

  async function bad(name, req, re) {
    const x = await pw(req);
    check('popwatch refuses ' + name, x.ok === false && re.test(x.error || ''), JSON.stringify(x).slice(0, 200));
  }
  await bad('leaseMs as words', { on: true, leaseMs: 'soon' }, /leaseMs must be a number/);
  await bad('leaseMs as true', { on: true, leaseMs: true }, /leaseMs must be a number/);
  await bad('on as a string', { on: 'yes' }, /on must be true or false/);
  await bad('on as a number', { on: 1 }, /on must be true or false/);
  await bad('hwnd as an object', { on: true, hwnd: { a: 1 } }, /hwnd must be/);
  r = await pw({});
  check('a refused arm leaves nothing armed', r.ok && r.result.armed === false, JSON.stringify(r));

  r = await s.send('hotkey', { op: 'nope' }, 4000);
  check('an unknown op names popwatch and popesc', r.ok === false && /popwatch, popesc/.test(r.error || ''), JSON.stringify(r));

  const unparse = s.events.filter((e) => e.ev === '__unparseable');
  check('every line the sidecar wrote was JSON', unparse.length === 0, unparse.slice(0, 2).map((e) => e.line).join(' | '));

  // Armed at quit: the sidecar must still exit cleanly (Hotkey.Uninstall takes the watch's hooks too).
  r = await pw({ on: true, leaseMs: 30000 });
  check('arm once more before quitting', r.ok && r.result.armed === true, JSON.stringify(r));
}

(async () => {
  let s = null;
  try {
    s = await T.startPassive();
    await verdicts(s);
    await navVerdicts(s);
    await hooks(s);
  } catch (e) {
    check('the run', false, e.message);
  }
  if (s) {
    const t0 = Date.now();
    s.proc.stdin.write(JSON.stringify({ id: 999999, cmd: 'quit' }) + '\n');
    let ex = null;
    try { ex = await s.waitExit(3000); } catch (e) { try { s.proc.kill(); } catch (_) { /* gone */ } }
    check('quit with the watch armed: the sidecar exits 0 within 3 s', ex && ex.code === 0,
      ex ? `exit ${ex.code} after ${Date.now() - t0} ms` : 'still running, killed');
    await s.stop();
  }
  console.log(`popwatch: ${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log('  FAIL ' + f);
  process.exit(failures.length || !passed ? 1 : 0);
})();
