'use strict';
/*
 * qstiles.test.js - lane qstiles (2026-10-15): the pure tile model (_qstiles-core.js), the display-mode
 * logic (_project-core.js), and both features (qstiles.js, project.js) on a fake ctx and a fake
 * sidecar. NOTHING REAL: no Electron (project.js runs its no-window path), no display change, no Do not
 * disturb, no airplane mode; every sidecar answer below is invented here.
 *   node lib/features/qstiles.test.js
 */
const C = require('./_qstiles-core');
const P = require('./_project-core');
const QX = require('./qstiles');
const PJ = require('./project');
const hub = require('./_tools-hub');
const TC = require('./_toasts-core');

let passed = 0;
const failures = [];
function check(name, ok, detail) { if (ok) passed++; else failures.push(name + (detail !== undefined ? ' -- ' + JSON.stringify(detail) : '')); }
const JARGON = (s) => /sidecar|undefined|\bnull\b|NaN|\[object|dryRun|0x[0-9a-f]{4}/i.test(String(s));
const tick = () => new Promise((r) => setTimeout(r, 0));

function world(mod, o) {
  const w = { cmds: {}, chords: {}, ons: {}, store: {}, sent: [], ready: [], health: null, casts: [], logs: [], replay: {} };
  const ctx = {
    name: mod.name, flags: { test: !!o.test, live: !o.test }, log: (t) => w.logs.push(t), enabled: () => o.enabled !== false,
    settings: { get: (k, d) => (k in w.store ? JSON.parse(JSON.stringify(w.store[k])) : d), set: (k, v) => { w.store[k] = JSON.parse(JSON.stringify(v)); } },
    sidecar: { get ready() { return o.ready !== false; }, pid: 4242,
      send: async (c, a) => { w.sent.push({ c, a }); return o.send(c, a, w); },
      on: (ev, fn) => { w.ons[ev] = fn; }, onReady: (fn) => { w.ready.push(fn); } },
    command: (v, fn) => { w.cmds[v] = fn; }, onChord: (c, fn) => { w.chords[c] = fn; }, onEnabled: () => {},
    health: (ok, why) => { w.health = { ok, why }; }, broadcast: (ev, p) => w.casts.push({ ev, p }), push: () => true,
    replay: (ev, fn) => { w.replay[ev] = fn; }, page: () => 'x', preload: 'x',
    host: { display: () => null, barRect: () => null },
  };
  w.api = mod.install(ctx);
  return w;
}

async function main() {
  /* ================= _project-core: the four choices ================= */
  const two = { current: 'extend', available: ['internal', 'clone', 'extend', 'external'], unavailable: {}, connected: 2 };
  const one = { current: 'internal', available: ['internal'], unavailable: { clone: 'there is no second display' }, connected: 1 };
  check('core: Windows\' four, in Windows\' order', P.MODES.map((m) => m.label).join('|') === 'PC screen only|Duplicate|Extend|Second screen only');
  check('core: starts on the current layout', P.startSel(two) === 'extend');
  check('core: Win+P again wraps to the next', P.next(two, 'extend', 1) === 'external' && P.next(two, 'external', 1) === 'internal');
  check('core: arrows go back', P.next(two, 'internal', -1) === 'external');
  check('core: one display -> single', P.single(one) && !P.single(two));
  check('core: one display: only PC screen only can be picked', P.whyNot(one, 'clone') === 'Only one display is connected' && !P.whyNot(one, 'internal'));
  check('core: one display: cycling stays put', P.next(one, 'internal', 1) === 'internal');
  check('core: no count -> said from what Windows would take', P.single({ current: 'internal', available: ['internal'] }));
  const v1 = P.view({ read: one, phase: 'choose' });
  check('core: one display says so plainly', v1.note === P.ONE_DISPLAY && v1.rows.filter((r) => r.disabled).length === 3, v1.note);
  check('core: the current row is marked', P.view({ read: two }).rows.find((r) => r.current).id === 'extend');
  const unav = { current: 'extend', available: ['internal', 'extend'], unavailable: { clone: 'the displays cannot show the same picture' }, connected: 2 };
  check('core: Windows\' refusal is the row\'s reason', P.whyNot(unav, 'clone') === 'The displays cannot show the same picture');
  check('core: a refused row is skipped when cycling', P.next(unav, 'internal', 1) === 'extend');
  check('core: custom layout said', /custom layout/.test(P.view({ read: Object.assign({}, two, { current: 'custom' }) }).note));
  const vc = P.view({ read: two, phase: 'confirm', confirm: { to: 'clone', from: 'extend', endsAt: 10000 + 15000 } }, 10000);
  check('core: the 15 s question, with the count', vc.title === 'Keep these display settings?' && vc.left === 15 && /Extend in 15 s/.test(vc.confirm.text), vc);
  check('core: the count runs down', P.view({ read: two, phase: 'confirm', confirm: { to: 'clone', from: 'extend', endsAt: 25000 } }, 21500).left === 4);
  check('core: not read yet says so', P.view({}).note === 'Reading your displays…');
  check('core: a failed read says why', /could not read your displays/.test(P.view({ readError: 'it did not answer' }).note));
  const t2 = P.tile({ on: true, read: two }), t1 = P.tile({ on: true, read: one });
  check('core: Project tile shows the current layout, never lit', t2.sub === 'Extend' && t2.on === false && /Win\+P/.test(t2.tip));
  check('core: Project tile with one display', t1.sub === 'PC screen only' && t1.tip.indexOf(P.ONE_DISPLAY) === 0);
  check('core: every word plain', ![v1.note, vc.confirm.text, t1.tip, t2.tip].some(JARGON));

  /* ================= _qstiles-core: the tiles ================= */
  const S = { on: true, dnd: { ok: true, on: false, writable: true }, airplane: { ok: true, on: false, canSet: true }, focus: null, timer: { ok: true } };
  check('tile: dnd off', C.dnd(S).sub === 'Off' && !C.dnd(S).on);
  check('tile: dnd on', C.dnd(Object.assign({}, S, { dnd: { ok: true, on: true, writable: true } })).sub === 'On');
  check('tile: dnd held by Focus', C.dnd(Object.assign({}, S, { dnd: { ok: true, on: true }, focus: { on: true, endAt: 1, dndByFocus: true } })).sub === 'On · Focus');
  check('tile: dnd rule said', C.dnd(Object.assign({}, S, { dnd: { ok: true, on: false, rule: 'priority only' } })).sub === 'Off · a rule is on');
  const dd = C.dnd(Object.assign({}, S, { dnd: { ok: false, writable: false, reason: 'windows’ quiet-hours object is not available' } }));
  check('tile: dnd dead says why', dd.dead && /^Do not disturb: Windows/.test(dd.tip), dd);
  check('tile: not read yet = reading (never a fake Off)', C.dnd({ on: true }).reading && C.airplane({ on: true }).sub === 'Reading…');
  check('tile: airplane on', C.airplane(Object.assign({}, S, { airplane: { ok: true, on: true, canSet: true } })).on);
  const ad = C.airplane(Object.assign({}, S, { airplane: { ok: true, on: false, canSet: false, reason: 'no radio management' } }));
  check('tile: airplane that cannot switch is dead with its reason', ad.dead && ad.sub === 'Off' && /No radio management/.test(ad.tip));
  const fo = C.focus(Object.assign({}, S, { focus: { on: true, endAt: 1000 + 25 * 60000, dndByFocus: true } }), 1000);
  check('tile: focus running shows minutes left', fo.on && fo.sub === '25 min left' && /Do not disturb goes back off/.test(fo.tip), fo);
  check('tile: focus idle = 30 min', C.focus(S).sub === '30 min' && /timer and Do not disturb/.test(C.focus(S).tip));
  check('tile: focus without the timer is dead with why', C.focus(Object.assign({}, S, { timer: { ok: false, reason: 'the timer is off' } })).dead);
  check('tile: cast hands to Windows and says so', /Win\+K/.test(C.cast().tip) && C.cast().sub === 'Windows’ panel');
  check('tile: switched off in the tray', C.dnd({ on: false }).dead && /tray/.test(C.focus({ on: false }).tip));
  const g = C.guess(S, 'focus', true);
  check('tile: the guess for Focus turns Do not disturb on, owned by Focus', g.focus.on && g.dnd.on && g.focus.dndByFocus && S.dnd.on === false);
  check('tile: no jargon', ![dd.tip, ad.tip, fo.tip, C.cast().tip, C.focus(S).tip].some(JARGON));

  /* ================= Mantle's banners honour Do not disturb ================= */
  check('toasts: priority-only DND silences banners', TC.quietWhy({ ok: true, dnd: 1, quns: 5 }) === 'Do not disturb is on');
  check('toasts: alarms-only DND silences banners', /alarms only/.test(TC.quietWhy({ ok: true, dnd: 2, quns: 5 })));
  check('toasts: DND off lets them through', TC.quietWhy({ ok: true, dnd: 0, quns: 5 }) === null);

  /* ================= qstiles.js on a fake sidecar ================= */
  const sys = { dnd: false, air: false };
  const sc = (c, a) => {
    if (c === 'sysnotify.dndGet') return { ok: true, result: { ok: true, on: sys.dnd, writable: true, reason: null } };
    if (c === 'netair.get') return { ok: true, result: { ok: true, airplane: sys.air, canSet: true, reason: null } };
    if (c === 'toasts.quiet') return { ok: true, result: { ok: true, dnd: sys.dnd ? 1 : 0, quns: 5 } };
    if (c === 'sysnotify.dnd') { if (a.dryRun) return { ok: true, result: { ok: true, dryRun: true } }; sys.dnd = a.on; return { ok: true, result: { ok: true, on: a.on } }; }
    if (c === 'netair.set') { if (a.dryRun) return { ok: true, result: { ok: true, dryRun: true, would: 'turn airplane mode on' } }; sys.air = a.on; return { ok: true, result: { ok: true, now: a.on } }; }
    return { ok: false, error: 'unknown command: ' + c };
  };
  // --test: every switch a dry run, the state never changed
  let w = world(QX, { test: true, send: sc });
  check('qstiles: replays its state (the bar paints from it)', typeof w.replay['qstiles.state'] === 'function' && w.replay['qstiles.state']().dnd === null);
  await w.cmds.refresh();
  check('qstiles: refresh reads all three', ['sysnotify.dndGet', 'netair.get', 'toasts.quiet'].every((c) => w.sent.some((s) => s.c === c)));
  let r = await w.cmds.set({ tile: 'dnd', on: true });
  check('qstiles --test: dnd is a dry run', r.ok && r.dryRun && sys.dnd === false && w.sent.find((s) => s.c === 'sysnotify.dnd').a.dryRun === true, r);
  r = await w.cmds.set({ tile: 'airplane', on: true });
  check('qstiles --test: airplane is a dry run', r.ok && r.dryRun && sys.air === false && /would turn airplane mode on/.test(r.reason), r);
  hub.timer = null;
  r = await w.cmds.set({ tile: 'focus', on: true });
  check('qstiles: Focus without the timer refuses with why', !r.ok && /timer is not running/.test(r.reason), r);
  w.api.stop('test');

  // live-shaped (fake sidecar, fake timer): Focus = timer + DND, and DND goes back when the timer ends
  let tv = { kind: 'idle' };
  hub.timer = { start: async (ms, label) => { tv = { kind: 'timer', label, endAt: Date.now() + ms }; hub.timerChanged(tv); return { ok: true }; },
                cancel: async () => { tv = { kind: 'idle' }; hub.timerChanged(tv); return { ok: true }; }, view: () => tv };
  w = world(QX, { test: false, send: sc });
  await w.cmds.refresh();
  r = await w.cmds.set({ tile: 'focus', on: true });
  check('focus: starts the timer and turns DND on', r.ok && tv.label === 'Focus' && sys.dnd === true && r.state.focus.dndByFocus, r);
  check('focus: the record is on disk before/with the change (R10)', w.store.focus && w.store.focus.dndByFocus === true);
  tv = { kind: 'idle' }; hub.timerChanged(tv);       // the timer ended
  await tick(); await tick();
  check('focus: timer ended -> DND back off, record gone', sys.dnd === false && w.store.focus === null, { dnd: sys.dnd, rec: w.store.focus });
  sys.dnd = true; await w.cmds.refresh();
  r = await w.cmds.set({ tile: 'focus', on: true });
  check('focus: DND already on is not owned by Focus', r.ok && r.state.focus.dndByFocus === false);
  r = await w.cmds.set({ tile: 'focus', on: false });
  check('focus: ended by its tile cancels the timer, leaves DND as it was', r.ok && tv.kind === 'idle' && sys.dnd === true, r);
  r = await w.cmds.set({ tile: 'airplane', on: true });
  check('airplane: switched and read back', r.ok && sys.air === true && r.state.airplane.on === true, r);
  r = await w.cmds.set({ tile: 'nope', on: true });
  check('qstiles: an unknown tile is refused in words', !r.ok && /no "nope" tile/.test(r.reason));
  sys.dnd = false; await w.cmds.refresh();
  await w.cmds.set({ tile: 'focus', on: true });
  w.api.stop('quit'); await tick();
  check('focus: quit puts Focus\'s DND back (R10)', sys.dnd === false);
  hub.timer = null;

  /* ================= project.js (no Electron here: the state and change logic) ================= */
  let topo = null, kept = null;
  const psc = (c, a) => {
    if (c === 'sysdisplay.project') return { ok: true, result: Object.assign({ ok: true, pending: null }, two) };
    if (c === 'sysdisplay.topology') { topo = a; return a.dryRun ? { ok: true, result: { ok: true, dryRun: true, changed: true, wouldRefuse: null, before: 'extend' } } : { ok: true, result: { ok: true, changed: true, pending: true, token: 'tok1', keepWithinMs: a.keepWithinMs, before: 'extend', after: a.mode } }; }
    if (c === 'sysdisplay.keep' || c === 'sysdisplay.revert') { kept = { c, a }; return { ok: true, result: { ok: true } }; }
    if (c === 'keys') return { ok: true, result: { ok: true } };
    return { ok: false, error: 'unknown command: ' + c };
  };
  let p = world(PJ, { test: true, send: psc });
  check('project: takes exactly Win+P, rests for games', JSON.stringify(PJ.chords) === '["Win+P"]' && PJ.rest === true && typeof p.chords['Win+P'] === 'function');
  check('project: healthy at install', p.health && p.health.ok);
  await p.api._test.read('test');
  check('project: the read is cached for the tile', p.replay['project.state']().read.current === 'extend');
  const op = p.api._test.open('Win+P');
  check('project: with no Electron it refuses in words (never throws)', op.ok === false && /no Electron/.test(op.reason));
  // the change path, as if the pop-up were open
  const st0 = p.api._test.state();
  check('project: not open = closed', st0.phase === 'closed');
  r = await p.cmds.pick({ mode: 'clone' });
  check('project: a pick while closed is refused', !r.ok);
  p.api.stop('test');

  // the change logic after open() (which needs Electron): the test door puts the phase at 'choose'
  p = world(PJ, { test: true, send: psc });
  await p.api._test.read('test');
  p.api._test.choose();
  r = await p.cmds.pick({ mode: 'clone' });
  check('project --test: pick = sysdisplay.topology dry run with the 15 s keep', r.ok && r.dryRun && topo.dryRun === true && topo.keepWithinMs === 15000 && topo.mode === 'clone', { r, topo });
  check('project --test: the question shows, marked as a test', p.api._test.state().phase === 'confirm' && p.api._test.state().confirm.dry === true);
  r = await p.cmds.keep();
  check('project --test: keep never reaches Windows', r.ok && r.dryRun && kept === null);
  p.api._test.choose();
  r = await p.cmds.pick({ mode: 'extend' });
  check('project: picking the current layout just closes', r.ok && r.changed === false);
  p.api._test.choose();
  r = await p.cmds.pick({ mode: 'sideways' });
  check('project: an unknown mode is refused', !r.ok);
  p.api.stop('test');

  const one1 = (c, a) => (c === 'sysdisplay.project' ? { ok: true, result: Object.assign({ ok: true }, one) } : psc(c, a));
  p = world(PJ, { test: false, send: one1 });
  await p.api._test.read('test'); p.api._test.choose();
  topo = null;
  r = await p.cmds.pick({ mode: 'extend' });
  check('project: one display: Extend refused in plain words, nothing sent', !r.ok && r.reason === 'Only one display is connected' && topo === null, r);
  p.api.stop('test');

  // live-shaped: the real change arms the keep-or-revert; Esc/close = revert; stop with one waiting = revert
  p = world(PJ, { test: false, send: psc });
  await p.api._test.read('test'); p.api._test.choose();
  r = await p.cmds.pick({ mode: 'clone' });
  check('project: a real pick waits to be kept (token)', r.ok && r.token === 'tok1' && topo.dryRun === false && p.api._test.state().phase === 'confirm', r);
  r = await p.cmds.close();
  check('project: closing the question switches back (revert with the token)', kept && kept.c === 'sysdisplay.revert' && kept.a.token === 'tok1', kept);
  kept = null; p.api._test.choose();
  await p.cmds.pick({ mode: 'external' });
  p.ons.sysdisplay({ what: 'reverted', token: 'tok1', ok: true, why: 'timeout' });
  check('project: the helper timeout is said in words', /put back/.test(p.api._test.state().note || ''), p.api._test.state().note);
  p.api._test.choose();
  await p.cmds.pick({ mode: 'external' });
  kept = null; p.api.stop('quit');
  check('project: stop with a change waiting reverts it now', kept && kept.c === 'sysdisplay.revert');
  const failing = (c, a) => (c === 'sysdisplay.topology' ? { ok: false, error: 'Windows refused the layout (error 31)' } : psc(c, a));
  p = world(PJ, { test: false, send: failing });
  await p.api._test.read('t'); p.api._test.choose();
  r = await p.cmds.pick({ mode: 'clone' });
  check('project: a refusal is said and nothing waits', !r.ok && /did not change: Windows refused/.test(r.reason) && p.api._test.state().phase !== 'confirm', r);
  p.api.stop('test');

  r = world(PJ, { test: false, send: psc });
  check('project: cast hands to Win+K (keys win+k), live', (await r.cmds.cast()).ok && r.sent.some((s) => s.c === 'keys' && s.a.combo === 'win+k'));
  const pt = await world(PJ, { test: true, send: psc }).cmds.cast();
  check('project --test: cast is a dry run (no key pressed)', pt.ok && pt.dryRun);
  r.api.stop('test');

  console.log(`QSTILES: ${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log('  FAIL ' + f);
  process.exit(failures.length ? 1 : 0);
}
main().catch((e) => { console.log('QSTILES: crashed: ' + (e && e.stack || e)); process.exit(1); });
