/* powermode.test.js - node ui/bar/powermode.test.js (the pure half of the power-mode switch) */
'use strict';
const P = require('./powermode.js');
let passed = 0;
const failures = [];
function check(name, ok, detail) { if (ok) passed++; else failures.push(detail !== undefined ? name + ' (' + JSON.stringify(detail) + ')' : name); }
const on = (v) => v.segs.filter((s) => s.on).map((s) => s.mode).join();

const bal = { ok: true, mode: 'balanced', available: true, plan: { name: 'Balanced', balanced: true }, source: 'ac', saver: false, reason: null };
const hone = { ok: true, mode: 'balanced', available: false, plan: { name: 'Hone Ultimate Power Plan V5', balanced: false }, source: 'ac',
  reason: 'Power mode works only on the Balanced power plan, and this PC is on "Hone Ultimate Power Plan V5". Switch to Balanced in Control Panel > Power Options to use it' };

let v = P.view(null, null, null);
check('before the first read: reading, all segments off and disabled', v.sub === 'Reading…' && on(v) === '' && v.segs.every((s) => s.disabled), v);

v = P.view(bal, null, null);
check('balanced on AC: live, Balanced selected, says Plugged in', !v.dead && on(v) === 'balanced' && v.sub === 'When plugged in' && !v.note, v);
check('three segments in Windows’ order', v.segs.map((s) => s.mode).join() === 'efficiency,balanced,performance');
check('the current one says so in its tooltip', /\(current/.test(v.segs[1].title));

v = P.view(Object.assign({}, bal, { source: 'battery', saver: true, mode: 'efficiency' }), null, null);
check('on battery with energy saver (not locking): both said', v.sub === 'When on battery · Energy saver on' && on(v) === 'efficiency', v.sub);

// 2026-09-25, the user's machine on battery: Best performance chosen for battery, Energy saver on (it
// turns on at 100%), so Windows runs efficiency and the mode cannot be set.
const saverOn = Object.assign({}, bal, { source: 'battery', mode: 'performance', inForce: 'efficiency', saver: true, settable: false,
  configured: { ac: 'balanced', battery: 'performance' },
  reason: 'Energy saver is on, so Windows runs Best power efficiency and the power mode can\'t be set; Best performance (your choice on battery) comes back when it is off. To turn it off: Settings > System > Power & battery > Energy saver' });
v = P.view(saverOn, null, null);
check('Energy saver on: the battery CHOICE stays lit (not the pinned efficiency), muted', on(v) === 'performance' && v.dead, v);
check('...ONE short line says it is locked by Energy saver; the full how-to is its tooltip',
  v.sub === 'When on battery' && v.reason === 'Locked while Energy saver is on' && /Settings > System > Power & battery > Energy saver/.test(v.detail), v);
check('...Energy saver at 100% on battery says it is on whenever unplugged', P.view(Object.assign({}, saverOn, { saverAt: 100 })).reason === 'Locked: Energy saver is on whenever this PC is unplugged');
check('...every segment disabled, each tooltip carries the reason', v.segs.every((s) => s.disabled && /Energy saver is on/.test(s.title)), v.segs);
check('...no "did not change" note, no plan picker', !v.note && !v.pickPlan && !v.plansOpen, v);
check('...aria names the choice and the lock', /^Power mode: Best performance, locked: Locked while Energy saver/.test(v.aria), v.aria);
v = P.view(Object.assign({}, saverOn, { reason: null }), null, null);
check('locked with no reason from the sidecar: still says why', v.reason === 'Locked while Energy saver is on', v.reason);
v = P.view(Object.assign({}, saverOn, { saver: false, reason: null }), null, null);
check('locked for no known reason: a plain sentence', v.reason === 'Windows will not take a power mode change right now', v.reason);
v = P.view(Object.assign({}, bal, { inForce: 'efficiency' }), null, null);
check('in force differs with nothing locking it: live, and the current segment says what Windows runs',
  !v.dead && /\(current when plugged in; Windows reports Best power efficiency in effect right now\)/.test(v.segs[1].title), v.segs[1].title);
v = P.view(Object.assign({}, bal, { inForce: 'balanced', settable: true }), null, null);
check('in force = choice: plain (current)', v.segs[1].title === 'Balanced (current when plugged in)', v.segs[1].title);
const saverP = Object.assign({}, saverOn, { plans: [{ guid: '381b4222-f694-41f0-9685-ff5bb260df2e', name: 'Balanced', active: true, balanced: true },
  { guid: '44444444-4444-4444-4444-444444444452', name: 'Hone Ultimate Power Plan V5', active: false, balanced: false }] });
v = P.view(saverP, null, null);
check('locked by Energy saver on Balanced: the plan toggle still works (switching plan is not blocked)', v.planToggle === 'Plan: Balanced' && !v.pickPlan, v);

v = P.view(bal, 'performance', null);
check('a click in flight: the new mode shows at once, pending', on(v) === 'performance' && v.segs[2].pending && !v.segs[1].on, v.segs);

v = P.view(bal, null, 'refused: sidecar is passive (test mode): it would have changed the power mode from balanced to performance');
check('a refusal: sprung back to the read-back mode, reason in a note', on(v) === 'balanced' && /^Power mode did not change: this is a test run, so Windows was not changed\.$/.test(v.note) && /\.$/.test(v.note), v.note);

v = P.view(hone, null, null);
check('not on Balanced: muted, the plan named in the reason', v.dead && v.reason === 'Power modes work only on the Balanced power plan' && /Hone Ultimate/.test(v.detail) && v.sub === 'Needs the Balanced plan', v);
check('...every segment disabled, and each says why', v.segs.every((s) => s.disabled && /Balanced/.test(s.title)));
check('...the mode Windows reports is still shown', on(v) === 'balanced');

v = P.view({ ok: false, reason: 'Windows would not say which power plan is active (error 5)' }, null, null);
check('unreadable: dead with the reason', v.dead && v.sub === 'Unavailable' && v.reason === 'Windows would not say which power plan is active' && !/error/.test(JSON.stringify(v)) && on(v) === '', v);

v = P.view(Object.assign({}, bal, { mode: 'better' }), null, null);
check('a Windows 10 overlay: no segment lit, and a note says what Windows reports', on(v) === '' && /Better performance/.test(v.note), v.note);

// THE PLANS (2026-09-24): off Balanced, the installed plans are the control; on Balanced, a toggle.
const HONE = '44444444-4444-4444-4444-444444444452', BAL = '381b4222-f694-41f0-9685-ff5bb260df2e';
const plansOn = (active) => [{ guid: BAL, name: 'Balanced', active: active === BAL, balanced: true },
  { guid: HONE, name: 'Hone Ultimate Power Plan V5', active: active === HONE, balanced: false }];
const honeP = Object.assign({}, hone, { plans: plansOn(HONE) });
v = P.view(honeP, null, null);
check('plans, off Balanced: the plan list IS the control (not dead, modes hidden, list open)', !v.dead && v.pickPlan && v.plansOpen && v.head === 'Power plan', v);
check('...the current plan is lit and named as the sub', v.plans.filter((p) => p.on).map((p) => p.name).join() === 'Hone Ultimate Power Plan V5' && v.sub === 'Hone Ultimate Power Plan V5', v.plans);
check('...a plain hint says the modes need Balanced, no warning note', /^Choose Balanced to use the power modes/.test(v.hint) && !v.planNote && !v.planToggle, v);
check('...Balanced says in its tooltip that the modes work there', /Power modes work on this plan/.test(v.plans[0].title), v.plans[0].title);
v = P.view(honeP, null, null, { plan: BAL });
check('a plan click in flight: Balanced lit at once, pending', v.plans[0].on && v.plans[0].pending && !v.plans[1].on, v.plans);
v = P.view(honeP, null, null, { planErr: 'refused: sidecar is passive (test mode): it would have switched the power plan' });
check('a refused plan switch: sprung back, the reason in a plan note', v.plans[1].on && /^Power plan did not change: this is a test run/.test(v.planNote), v.planNote);
const balP = Object.assign({}, bal, { plans: plansOn(BAL) });
v = P.view(balP, null, null);
check('plans, on Balanced: the modes are the control, the list closed behind "Plan: Balanced"', !v.dead && !v.pickPlan && !v.plansOpen && v.planToggle === 'Plan: Balanced' && on(v) === 'balanced', v);
v = P.view(balP, null, null, { plansOpen: true });
check('...the toggle opens the list (the way back to Hone is one click)', v.plansOpen && v.planToggle === 'Hide power plans' && v.plans[0].on, v);
v = P.view(Object.assign({}, bal, { plans: [plansOn(BAL)[0]] }), null, null);
check('only one plan installed: no toggle', !v.planToggle && !v.plansOpen, v);

// the spoken name says which power source the choice is for, and never "power source unknown:" or a "·"
check('aria: plugged in', P.view(bal).aria === 'Power mode when plugged in: Balanced', P.view(bal).aria);
check('aria: unknown source says no source', P.view(Object.assign({}, bal, { source: null })).aria === 'Power mode: Balanced', P.view(Object.assign({}, bal, { source: null })).aria);
check('aria: Energy saver on (not locked) has no "·"', !/·/.test(P.view(Object.assign({}, bal, { saver: true })).aria), P.view(Object.assign({}, bal, { saver: true })).aria);

check('fullName', P.fullName('efficiency') === 'Best power efficiency' && P.fullName('performance') === 'Best performance' && P.fullName(null) === 'unknown');

console.log(`powermode: ${passed} passed, ${failures.length} failed`);
failures.forEach((f) => console.log('  FAIL ' + f));
process.exit(failures.length ? 1 : 0);
