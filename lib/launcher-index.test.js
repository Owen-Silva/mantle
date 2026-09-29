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
  /* Four sources since the power rows (2026-09-22). File search is NOT one of them: Windows keeps
     that index and the launcher asks it per query through launcher.files, so its checks live in
     lib/launcher-extras.test.js with the power actions' dry runs. */
  ok(sources.map(s => s.name).join(',') === 'apps,commands,settings,power',
    'four sources reported: apps, commands, settings, power (got ' + sources.map(s => s.name).join(',') + ')');
  const pows = items.filter(i => i.kind === 'power');
  ok(['Lock', 'Sleep', 'Restart', 'Shut down', 'Sign out'].every(n => pows.some(p => p.name === n)),
    'power rows indexed (got ' + pows.map(p => p.name).join(', ') + ')');
  ok(pows.every(p => p.id && p.glyph && Array.isArray(p.keywords)), 'every power row has an id, a glyph and keywords');
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

  // --- power rows: found by their words, never by a stray letter, never through launch() ---
  ok(search('reboot', items)[0].name === 'Restart', "search('reboot') puts Restart first");
  ok(search('log out', items)[0].name === 'Sign out', "search('log out') puts Sign out first");
  ok(!search('s', items).some(i => i.kind === 'power'), "search('s') shows no power row (Enter there must not sleep)");
  // refused before anything could run: power rows only go through power(), which asks first
  const viaLaunch = await launch(pows.find(p => p.path === 'shutdown'), {});
  ok(viaLaunch.ok === false && /launcher\.power/.test(viaLaunch.reason), 'launch() refuses a power row: ' + viaLaunch.reason);

  // --- Mantle Settings (lane settings-tests, 2026-09-28): the pages it covers open IT at their
  // section (Windows' own page only when it is off); every other page is Windows' as before. Dry
  // runs only; in plain node there is no Electron app, so the real 'mantle-open' reply path is
  // proven in lib/features/settings.test.js instead. ---
  const LI = require('./launcher-index')._internals;
  const SECTIONS = require('./features/settings')._test.SECTIONS;
  const snd = await launch({ kind: 'setting', path: 'ms-settings:sound', name: 'Sound' }, { dryRun: true });
  ok(snd.ok === true && /^dry run/.test(snd.reason) && /Mantle Settings at sound/.test(snd.reason) && /Windows' ms-settings:sound/.test(snd.reason),
    'ms-settings:sound dry run names Mantle Settings at sound and Windows\' ms-settings:sound (' + JSON.stringify(snd) + ')');
  const sdev = await launch({ kind: 'setting', path: 'ms-settings:sound-devices', name: 'Sound devices' }, { dryRun: true });
  ok(sdev.ok === true && /Mantle Settings at sound /.test(sdev.reason) && /ms-settings:sound-devices/.test(sdev.reason),
    'ms-settings:sound-devices dry run goes to Mantle Settings at sound (' + JSON.stringify(sdev) + ')');
  const wu = await launch({ kind: 'setting', path: 'ms-settings:windowsupdate', name: 'Windows Update' }, { dryRun: true });
  ok(wu.ok === true && /^dry run: would run /.test(wu.reason) && /(shell\.openExternal|cmd \/c start "") "ms-settings:windowsupdate"/.test(wu.reason) && !/Mantle Settings/.test(wu.reason),
    'ms-settings:windowsupdate dry run is still Windows\' own page, the old words (' + JSON.stringify(wu) + ')');
  const own = await launch({ kind: 'setting', path: 'mantle:settings', name: 'Mantle Settings' }, { dryRun: true });
  ok(own.ok === true && /^dry run: would open Mantle Settings \(Windows' ms-settings: if/.test(own.reason),
    'mantle:settings dry run opens Mantle Settings, falling back to Windows\' ms-settings: (' + JSON.stringify(own) + ')');
  const wp = await launch({ kind: 'setting', path: 'mantle:wallpapers', name: 'Wallpapers' }, { dryRun: true });
  ok(wp.ok === true && wp.reason === "dry run: would open Mantle's wallpapers window", 'mantle:wallpapers dry run is unchanged (' + JSON.stringify(wp) + ')');
  const msRow = sets.find(i => i.path === 'mantle:settings');
  ok(msRow && msRow.name === 'Mantle Settings' && msRow.subtitle === 'Mantle' && msRow.icon === null && msRow.id,
    'the mantle:settings row is built, subtitle Mantle (' + JSON.stringify(msRow) + ')');
  ok(msRow && ['settings', 'preferences', 'options', 'mantle', 'features', 'shortcuts', 'win+i'].every(k => String(msRow.keywords).split(' ').includes(k)),
    'the mantle:settings row carries its keywords (' + (msRow && msRow.keywords) + ')');
  ok(search('mantle settings', items).slice(0, 3).some(i => i.path === 'mantle:settings'), "search('mantle settings') has the row in the top 3");
  const setUris = new Set(LI.SETTINGS.map(r => r[1]));
  const orphans = Object.keys(LI.MANTLE_SETTINGS).filter(u => !setUris.has(u));
  ok(orphans.length === 0, 'every MANTLE_SETTINGS key is a SETTINGS uri (orphans: ' + orphans.join(', ') + ')');
  const unknownSec = Object.entries(LI.MANTLE_SETTINGS).filter(([, m]) => !SECTIONS.includes(m.section) || !(m.row === null || /^[A-Za-z0-9_.+-]{1,80}$/.test(m.row)));
  ok(unknownSec.length === 0, 'every MANTLE_SETTINGS section/row is one settings.js navFrom keeps (bad: ' + unknownSec.map(e => e[0]).join(', ') + ')');

  // --- Mantle's task manager (lane integrate, 2026-09-28): two rows, opened on the feature's OWN
  // event 'mantle-open:taskmgr' (the shared 'mantle-open' always has the wallpaper library
  // listening, so its emit() proves nothing); no listener = off or resting, said in words. ---
  const tmRow = sets.find(i => i.path === 'mantle:taskmgr');
  const tmGame = sets.find(i => i.path === 'mantle:taskmgr:game');
  ok(tmRow && tmRow.name === 'Mantle Task Manager' && tmRow.subtitle === 'Mantle', 'the mantle:taskmgr row is built (' + JSON.stringify(tmRow) + ')');
  ok(tmGame && tmGame.name === 'Get ready to game (free RAM)', 'the mantle:taskmgr:game row is built (' + JSON.stringify(tmGame) + ')');
  ok(search('task manager', items).slice(0, 3).some(i => i.path === 'mantle:taskmgr'), "search('task manager') has the row in the top 3");
  const EventEmitter = require('events');
  const fakeApp = new EventEmitter();
  fakeApp.on('mantle-open', () => {});            // the wallpaper library: always there
  const was = require('./launcher-index')._setElectronForTest({ app: fakeApp });
  try {
    const off = await launch(tmRow || { kind: 'setting', path: 'mantle:taskmgr' });
    ok(off.ok === false && off.reason === "Mantle's task manager is off or resting while a game runs",
      'no task manager listening (off or resting): refused with the reason, not a silent "opened" (' + JSON.stringify(off) + ')');
    const got = [];
    fakeApp.on('mantle-open:taskmgr', (view) => got.push(view));
    const on1 = await launch(tmRow || { kind: 'setting', path: 'mantle:taskmgr' });
    const on2 = await launch(tmGame || { kind: 'setting', path: 'mantle:taskmgr:game' });
    ok(on1.ok === true && on2.ok === true && JSON.stringify(got) === '["apps","game"]',
      'listening: the two rows open views apps and game on its own event (' + JSON.stringify([on1, on2, got]) + ')');
    let shared = 0;
    fakeApp.on('mantle-open', (t) => { if (/^taskmgr/.test(t)) shared++; });
    await launch(tmRow || { kind: 'setting', path: 'mantle:taskmgr' });
    ok(shared === 0, 'the task manager rows do not also fire the shared mantle-open (it would open twice)');
    const dry = await launch(tmRow || { kind: 'setting', path: 'mantle:taskmgr' }, { dryRun: true });
    ok(dry.ok === true && dry.reason === "dry run: would open Mantle's taskmgr window", 'mantle:taskmgr dry run (' + JSON.stringify(dry) + ')');
  } finally {
    require('./launcher-index')._setElectronForTest(was);
  }

  if (failures.length) for (const f of failures) console.log('  FAIL: ' + f);
  console.log('LAUNCHER INDEX TEST: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch(err => {
  console.log('  FAIL: the test itself threw — ' + (err && err.stack || err));
  console.log('LAUNCHER INDEX TEST: ' + passed + ' passed, ' + (failed + 1) + ' failed');
  process.exit(1);
});
