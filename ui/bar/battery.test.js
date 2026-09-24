'use strict';
/*
 * battery.test.js - the battery's words and glyph (ui/bar/battery.js), in node, no Electron.
 *
 * Every state the readout, its tooltip and the quick-settings footer can be in, including the
 * ones that went wrong on 2026-09-23: "on AC" drawn as charging, the bolt lost on the fill, a
 * tooltip promising "battery settings" for a click that opens quick settings, and every "I do not
 * know the time left" value Windows or WMI hands out (-1 / 0xFFFFFFFF / 71582788 minutes).
 *
 *   node ui/bar/battery.test.js
 *
 * Prints one summary line; exits 1 if anything failed.
 */
const B = require('./battery.js');

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(name + (detail ? ' -- ' + detail : ''));
}
const show = (d) => JSON.stringify({ state: d.state, short: d.short, words: d.words, footer: d.footer, bolt: d.bolt, plug: d.plug });

/* Shapes exactly as the sidecar sends them (Battery.cs), measured on this laptop 2026-09-23. */
const reading = (o) => Object.assign({
  ok: true, present: true, percent: 80, ac: true, charging: true, secondsLeft: null, saver: false,
  low: false, critical: false, reason: null
}, o);

// ---- the three plugged-in states, worded apart
{
  const d = B.describe(reading({}));
  check('charging: says charging, with a bolt and no plug',
    d.state === 'charging' && d.words === '80% available (plugged in, charging)' && d.bolt && !d.plug &&
    d.short === '80%' && d.footer === '80% · charging', show(d));
}
{
  // Lenovo conservation mode: on AC, held at a limit, NOT charging. This was drawn with a bolt.
  const d = B.describe(reading({ percent: 60, charging: false }));
  check('plugged in, not charging: says so, with a plug and no bolt',
    d.state === 'plugged' && d.words === '60% available (plugged in, not charging)' && d.plug && !d.bolt &&
    d.footer === '60% · not charging', show(d));
}
{
  const d = B.describe(reading({ percent: 100, charging: false }));
  check('fully charged: Windows\' words, a plug, the full fill',
    d.state === 'full' && d.words === 'fully charged (100%)' && d.footer === 'Fully charged' &&
    d.plug && !d.bolt && d.level === 1, show(d));
}
{
  const d = B.describe(reading({ percent: 100, charging: true }));
  check('100% and still topping up is charging, not full', d.state === 'charging' && d.bolt, show(d));
}

// ---- on battery: the time only when Windows knows it
{
  const d = B.describe(reading({ ac: false, charging: false, percent: 72, secondsLeft: 11520 }));
  check('on battery, time known: "3 hr 12 min (72%) remaining"',
    d.state === 'battery' && d.words === '3 hr 12 min (72%) remaining' && d.timeLeft === '3 hr 12 min' &&
    d.footer === '72% · 3 hr 12 min left' && !d.bolt && !d.plug, show(d));
}
{
  const d = B.describe(reading({ ac: false, charging: false, percent: 72, secondsLeft: 2700 }));
  check('on battery, under an hour: "45 min (72%) remaining"', d.words === '45 min (72%) remaining', show(d));
}
for (const [label, extra] of [
  ['GetSystemPowerStatus -1 (read signed)', { secondsLeft: -1 }],
  ['GetSystemPowerStatus 0xFFFFFFFF', { secondsLeft: 4294967295 }],
  ['WMI EstimatedRunTime 71582788 minutes', { secondsLeft: undefined, minutesLeft: 71582788 }],
  ['WMI 71582788 minutes, as seconds', { secondsLeft: 71582788 * 60 }],
  ['no estimate yet (null)', { secondsLeft: null }],
  ['zero', { secondsLeft: 0 }],
  ['over 100 hours', { secondsLeft: 100 * 3600 }],
  ['not a number', { secondsLeft: 'soon' }]
]) {
  const d = B.describe(reading(Object.assign({ ac: false, charging: false, percent: 72 }, extra)));
  const all = d.words + '|' + d.tip + '|' + d.footer;
  check('unknown time (' + label + ') shows no time: "72% remaining"',
    d.state === 'battery' && d.words === '72% remaining' && d.timeLeft === null && d.footer === '72% · on battery' &&
    !/71582788|4294967295|1193046|-1|hr|min/.test(all), all);
}
{
  // Windows sends 0xFFFFFFFF on AC too: never a time while plugged in, whatever arrives.
  const d = B.describe(reading({ percent: 80, secondsLeft: 5400 }));
  check('plugged in never shows a time left', d.timeLeft === null && !/min|hr/.test(d.words + d.footer), show(d));
}

// ---- battery saver, the tooltip, the click
{
  const d = B.describe(reading({ ac: false, charging: false, percent: 41, secondsLeft: 6000, saver: true }));
  check('battery saver adds Windows\' own line to the tooltip',
    d.saver && d.tip === 'Battery status: 1 hr 40 min (41%) remaining\nBattery saver on\nClick: quick settings', JSON.stringify(d.tip));
}
{
  const tips = [reading({}), reading({ charging: false, percent: 55 }), reading({ ac: false, charging: false }), { ok: false, reason: 'x' }]
    .map((r) => B.describe(r).tip);
  check('every tooltip says what the click does (quick settings), never "battery settings"',
    tips.every((t) => /\nClick: quick settings$/.test(t) && !/battery settings/i.test(t)), JSON.stringify(tips));
  check('the tooltip leads with Windows\' "Battery status: "', tips.every((t) => t.indexOf('Battery status: ') === 0), JSON.stringify(tips));
}

// ---- unknowns and failures: shown, with the reason
{
  const d = B.describe(reading({ percent: null, charging: false, reason: 'Windows does not know the battery percentage yet' }));
  check('unknown percentage on AC: "plugged in", a dash, and the reason',
    d.state === 'unknown' && d.short === '—' && d.words === 'plugged in' && d.level === null &&
    d.tip.indexOf('Windows does not know the battery percentage yet') > 0 && d.show, show(d));
}
{
  const d = B.describe(reading({ percent: 255, ac: false, charging: false }));
  check('a raw 255 percent is unknown, never "255%"',
    d.state === 'unknown' && d.short === '—' && d.words === 'unknown remaining' && !/255/.test(d.tip + d.footer), show(d));
}
{
  const d = B.describe(reading({ ac: null, percent: 72 }));
  check('unknown charger state keeps the number and says why',
    d.state === 'unknown' && d.short === '72%' && /does not know whether the charger is plugged in/.test(d.tip), show(d));
}
{
  const d = B.describe({ ok: false, reason: 'Windows would not report the power status (GetSystemPowerStatus failed, Win32 error 5)' });
  check('a failed read stays on screen as a dash, with the reason in the tooltip and the footer',
    d.show && d.state === 'error' && d.short === '—' && d.level === null &&
    d.tip.indexOf('Win32 error 5') > 0 && d.footer.indexOf('Win32 error 5') > 0, show(d));
}
{
  const d = B.describe(null);
  check('no reading at all is a failure with a reason, not a hidden readout',
    d.show && d.state === 'error' && /no battery reading has arrived yet/.test(d.footer), show(d));
}
{
  const d = B.describe({ ok: false });
  check('a failure without a reason still says so', /gave no reason/.test(d.tip), d.tip);
}
{
  const d = B.describe(reading({ present: false, percent: null, ac: true, charging: false }));
  check('no battery (a desktop): the readout is hidden and the footer says why',
    !d.show && d.state === 'none' && d.footer === 'No battery is detected', show(d));
}

// ---- an older sidecar's `power` shape (no `charging`, no `ac`)
{
  const d = B.describe({ ok: true, onBattery: false, percent: 65, minutesLeft: null, saver: false, hasBattery: true, reason: null });
  check('older `power` shape on AC: exactly Windows\' words, no charging claim either way',
    d.state === 'plugged' && d.words === '65% available (plugged in)' && d.plug && !d.bolt && d.footer === '65% · plugged in', show(d));
}
{
  const d = B.describe({ ok: true, onBattery: true, percent: 72, minutesLeft: 184, saver: false, hasBattery: true, reason: null });
  check('older `power` shape on battery: minutesLeft becomes "3 hr 4 min"', d.words === '3 hr 4 min (72%) remaining', show(d));
}

// ---- the number and the glyph
{
  const d = B.describe(reading({ percent: 71.7 }));
  check('a fractional percentage rounds the way Windows does (71.7 -> 72)', d.short === '72%', show(d));
}
{
  const s = (o) => B.svg(B.describe(reading(o)));
  const charging = s({ percent: 65 }), plugged = s({ percent: 65, charging: false }), batt = s({ percent: 65, ac: false, charging: false });
  check('the bolt is cut out of the fill (mask) so it shows over it',
    /<mask id="mbat-ko"/.test(charging) && /mask="url\(#mbat-ko\)"/.test(charging) && charging.indexOf('M8.6 5.4') > 0, charging);
  check('plugged in, not charging draws the plug and no bolt',
    plugged.indexOf('M6.4 5.2') > 0 && plugged.indexOf('M8.6 5.4') < 0, plugged);
  check('on battery draws neither mark and no mask', batt.indexOf('M8.6 5.4') < 0 && batt.indexOf('M6.4 5.2') < 0 && batt.indexOf('mask') < 0, batt);
  check('the fill is proportional (65% of 8.4 = 5.46)', /width="5\.46"/.test(batt), batt);
  const empty = B.svg(B.describe({ ok: false, reason: 'x' }));
  check('a failed read draws an empty outline', !/height="3\.4"/.test(empty), empty);
}

for (const f of failures) console.log('FAIL ' + f);
console.log('BATTERY WORDS TEST: ' + passed + ' passed, ' + failures.length + ' failed');
process.exit(failures.length ? 1 : 0);
