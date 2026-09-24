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
check('balanced on AC: live, Balanced selected, says Plugged in', !v.dead && on(v) === 'balanced' && v.sub === 'Plugged in' && !v.note, v);
check('three segments in Windows’ order', v.segs.map((s) => s.mode).join() === 'efficiency,balanced,performance');
check('the current one says so in its tooltip', /\(current\)/.test(v.segs[1].title));

v = P.view(Object.assign({}, bal, { source: 'battery', saver: true, mode: 'efficiency' }), null, null);
check('on battery with energy saver: both said', v.sub === 'On battery · Energy saver on' && on(v) === 'efficiency', v.sub);

v = P.view(bal, 'performance', null);
check('a click in flight: the new mode shows at once, pending', on(v) === 'performance' && v.segs[2].pending && !v.segs[1].on, v.segs);

v = P.view(bal, null, 'refused: sidecar is passive (test mode): it would have changed the power mode from balanced to performance');
check('a refusal: sprung back to the read-back mode, reason in a note', on(v) === 'balanced' && /^Power mode did not change: refused/.test(v.note) && /\.$/.test(v.note), v.note);

v = P.view(hone, null, null);
check('not on Balanced: muted, the plan named in the reason', v.dead && /Hone Ultimate/.test(v.reason) && v.sub === 'Needs the Balanced plan', v);
check('...every segment disabled, and each says why', v.segs.every((s) => s.disabled && /Balanced/.test(s.title)));
check('...the mode Windows reports is still shown', on(v) === 'balanced');

v = P.view({ ok: false, reason: 'Windows would not say which power plan is active (error 5)' }, null, null);
check('unreadable: dead with the reason', v.dead && v.sub === 'Unavailable' && /error 5/.test(v.reason) && on(v) === '', v);

v = P.view(Object.assign({}, bal, { mode: 'better' }), null, null);
check('a Windows 10 overlay: no segment lit, and a note says what Windows reports', on(v) === '' && /Better performance/.test(v.note), v.note);

check('fullName', P.fullName('efficiency') === 'Best power efficiency' && P.fullName('performance') === 'Best performance' && P.fullName(null) === 'unknown');

console.log(`powermode: ${passed} passed, ${failures.length} failed`);
failures.forEach((f) => console.log('  FAIL ' + f));
process.exit(failures.length ? 1 : 0);
