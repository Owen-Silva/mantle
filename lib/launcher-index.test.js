'use strict';
/* launcher-index.test.js — plain node, no Electron, no browser, nothing opened.
 *
 * WHY it builds the REAL index instead of fixtures: the interesting failures
 * here are all environmental — a Start Menu folder that moved, a PowerShell
 * profile redirected into OneDrive, a name regex that eats every app. A
 * fixture would pass happily through all three. The icon resolver is stubbed
 * (returns null) because icons come from the sidecar, which this test must not
 * need; and every launch is a DRY RUN, so the test can never actually open an
 * app on Owen's screen.
 *
 *   node lib/launcher-index.test.js
 */

const { build, search, launch } = require('./launcher-index');

let passed = 0, failed = 0;
const failures = [];
function ok(cond, label) {
  if (cond) passed++;
  else { failed++; failures.push(label); }
}

(async () => {
  const t0 = Date.now();
  const { items, sources } = await build({ icon: async () => null });

  // Per-source report first: this is the same line the launcher footer shows,
  // so reading the test output tells you what a real open would look like.
  for (const s of sources) {
    console.log('  ' + s.name.padEnd(9) + String(s.count).padStart(4) + '  ' + s.status +
      (s.reason ? '  — ' + s.reason : ''));
  }
  console.log('  built in ' + (Date.now() - t0) + ' ms, ' + items.length + ' items total');

  const apps = items.filter(i => i.kind === 'app');
  const cmds = items.filter(i => i.kind === 'command');
  const sets = items.filter(i => i.kind === 'setting');

  ok(apps.length > 0, 'apps indexed (got ' + apps.length + ')');
  ok(cmds.length > 0, 'commands indexed (got ' + cmds.length + ')');
  ok(sets.length >= 25, 'settings indexed (got ' + sets.length + ')');
  ok(sources.length === 3, 'three sources reported');
  ok(sources.every(s => typeof s.reason === 'string' && (s.status === 'ok' || s.reason.length > 0)),
    'every failing source carries a reason');
  ok(items.every(i => i.id && i.kind && i.name && typeof i.subtitle === 'string' && 'icon' in i),
    'every item has the full shape');
  ok(new Set(items.map(i => i.id)).size === items.length, 'ids are unique');

  // --- search ---
  const dash = search('dash', items).slice(0, 3);
  ok(dash.some(i => i.kind === 'command' && i.name.toLowerCase() === 'dash'),
    "search('dash') puts the command in the top 3 (got " + dash.map(i => i.name).join(', ') + ')');

  const sett = search('sett', items);
  ok(sett.some(i => i.kind === 'setting'), "search('sett') finds settings");

  ok(search('zzzzzqqqq', items).length === 0, 'a nonsense query returns nothing');
  ok(search('', items).length === Math.min(12, items.length), 'empty query returns 12 rows');
  ok(search('', items)[0].kind === 'command', 'empty query leads with a command');
  ok(search('a', items).length <= 12, 'results are capped at 12');

  const a1 = search('ch', items).map(i => i.id).join('|');
  const a2 = search('ch', items).map(i => i.id).join('|');
  ok(a1 === a2, 'results are stable across identical calls');

  const urlRows = search('github.com/Owen-Silva', items);
  ok(urlRows[0] && urlRows[0].kind === 'url', 'a domain query prepends the URL row');
  ok(!search('hello world', items).some(i => i.kind === 'url'), 'a phrase is not treated as a URL');

  // --- launch, dry run only: nothing on this machine is opened ---
  const samples = [apps[0], cmds[0], sets[0], urlRows[0]];
  for (const item of samples) {
    const res = await launch(item, { dryRun: true });
    ok(res && res.ok === true && typeof res.reason === 'string' && res.reason.startsWith('dry run'),
      'dry-run launch of a ' + item.kind + ' (' + JSON.stringify(res) + ')');
  }
  const bad = await launch({ kind: 'nonsense', name: 'x', path: 'x' }, { dryRun: true });
  ok(bad.ok === false && /does not know how/.test(bad.reason), 'an unknown kind fails with a reason');

  if (failures.length) for (const f of failures) console.log('  FAIL: ' + f);
  console.log('LAUNCHER INDEX TEST: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch(err => {
  console.log('  FAIL: the test itself threw — ' + (err && err.stack || err));
  console.log('LAUNCHER INDEX TEST: ' + passed + ' passed, ' + (failed + 1) + ' failed');
  process.exit(1);
});
