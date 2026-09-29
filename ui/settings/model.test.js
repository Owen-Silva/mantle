/* model.test.js — Mantle Settings' pure logic (ui/settings/model.js), no DOM, no Electron.
 *
 * WHY: the search order is what a person feels ("night" must land on Night light, not on a page
 * whose keywords mention night), and the row ids are a contract with main's settings.nav. Both
 * break silently, so both are pinned here.
 *
 *   node ui/settings/model.test.js      -> prints "N passed, M failed", exits 1 on a failure
 */
'use strict';
const M = require('./model.js');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; } catch (e) { failed++; process.stdout.write(`FAIL ${name}: ${e.message}\n`); }
}
function eq(a, b, what) { if (a !== b) throw new Error(`${what || 'value'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
function ok(v, what) { if (!v) throw new Error(what || 'expected true'); }

/* made-up fixtures in the contract's shapes */
const CATALOG = { ok: true, items: [
  { name: 'Display', uri: 'ms-settings:display', keywords: 'screen monitor resolution scale scaling brightness orientation refresh rate', section: 'display', row: null },
  { name: 'Sound', uri: 'ms-settings:sound', keywords: 'audio volume speakers headphones microphone mic output input', section: 'sound', row: null },
  { name: 'Bluetooth & devices', uri: 'ms-settings:bluetooth', keywords: 'bt pair pairing wireless headphones earbuds controller', section: 'bluetooth', row: 'bluetooth.radio' },
  { name: 'Background', uri: 'ms-settings:personalization-background', keywords: 'wallpaper desktop background picture slideshow', section: null, row: null },
  { name: 'Colors', uri: 'ms-settings:colors', keywords: 'dark mode light mode accent color theme transparency', section: null, row: null },
  { name: 'Night light', uri: 'ms-settings:nightlight', keywords: 'blue light warm color evening night mode', section: 'display', row: 'display.nightlight' },
  { name: 'Startup apps', uri: 'ms-settings:startupapps', keywords: 'startup autostart launch at login run at startup boot', section: 'apps', row: 'apps.startup' },
  { name: 'Multitasking', uri: 'ms-settings:multitasking', keywords: 'snap windows snap layouts alt tab virtual desktops', section: null, row: null },
  { name: 'Focus', uri: 'ms-settings:quiethours', keywords: 'do not disturb dnd focus assist quiet hours', section: null, row: null },
  { name: 'Windows Update', uri: 'ms-settings:windowsupdate', keywords: 'updates update check for updates patch upgrade pause updates', section: null, row: null },
] };
const MANTLE = { ok: true, features: [
  { name: 'gamemode', label: 'Game mode (quick settings)', enabled: true, ok: true, reason: null, resting: null, running: true, chords: [],
    options: [{ key: 'auto', label: 'Turn on by itself when a game starts', type: 'bool', value: true, default: true, isDefault: true }] },
  { name: 'screenshot', label: 'Screenshots (Win+Shift+S, PrintScreen)', enabled: true, ok: true, running: true, chords: ['Win+Shift+S', 'PrintScreen'],
    options: [{ key: 'folder', label: 'Save screenshots to', type: 'folder', value: null, default: null, isDefault: true, defaultLabel: "Windows' Screenshots folder" }] },
  { name: 'clipboard', label: 'Clipboard history (Win+V)', enabled: false, ok: true, running: false, chords: ['Win+V'], options: [] },
], switcher: { ok: true, altTab: true, winKeys: true }, shortcuts: [
  { keys: 'Win+V', what: 'Clipboard history', owner: 'clipboard', ownerLabel: 'Clipboard history', on: false, live: false, why: 'switched off', toggle: { kind: 'feature', feature: 'clipboard' } },
  { keys: 'Alt+Tab', what: 'Window switcher', owner: 'switcher', ownerLabel: 'Window switcher', on: true, live: true, why: null, toggle: { kind: 'switcher', key: 'altTab' } },
] };
const IDX = M.buildIndex({ mantle: MANTLE, catalog: CATALOG });
const top = (q) => { const r = M.search(IDX, q); return r.length ? r[0].entry : null; };

/* ---- the orderings the brief names ---- */
t('"night" finds Night light first', () => eq(top('night').id, 'display.nightlight', 'top id'));
t('"startup" finds Startup apps first', () => eq(top('startup').id, 'apps.startup', 'top id'));
t('"alt tab" finds the window switcher first', () => eq(top('alt tab').id, 'mantle.switcher', 'top id'));
t('"alt+tab" (with the plus) finds the switcher too', () => eq(top('alt+tab').id, 'mantle.switcher', 'top id'));
t('"bt" finds Bluetooth first', () => ok(/^bluetooth/.test(top('bt').id), 'top was ' + top('bt').id));
t('"dark mode" finds the Windows Colors page first', () => { const e = top('dark mode'); eq(e.kind, 'catalog'); eq(e.uri, 'ms-settings:colors'); });
t('"Win+V" finds the clipboard shortcut or feature', () => ok(/clipboard|shortcuts\.Win\+V/.test(top('win+v').id), 'top was ' + top('win+v').id));
t('"screenshots folder" finds the screenshot folder option', () => eq(top('save screenshots').id, 'mantle.option.screenshot.folder'));
t('"brightness" is a Mantle row before the Display catalog page', () => eq(top('brightness').id, 'display.brightness'));
t('"sound" finds the Sound section (exact label)', () => { const e = top('sound'); eq(e.kind, 'section'); eq(e.id, 'sound'); });
t('"update" finds Windows Update (a catalog page with no section)', () => { const e = top('update'); eq(e.uri, 'ms-settings:windowsupdate'); eq(e.section, null); });
t('fuzzy "nghtlt" still finds Night light', () => eq(top('nghtlt').id, 'display.nightlight'));

/* ---- the scoring ladder itself ---- */
t('exact > prefix > word prefix > keyword > fuzzy', () => {
  const e = (label, kw) => ({ nl: M.norm(label), nk: M.norm(kw || '') });
  const exact = M.score(e('Night light'), 'night light');
  const prefix = M.score(e('Night light'), 'night');
  const word = M.score(e('Turn on night light'), 'nig lig');
  const kw = M.score(e('Colors', 'dark mode'), 'dark mode');
  const fz = M.score(e('Night light'), 'nghtlt');
  ok(exact > prefix && prefix > word && word > kw && kw > fz && fz > 0, [exact, prefix, word, kw, fz].join(' '));
});
t('nothing matches -> empty', () => eq(M.search(IDX, 'zzqxw').length, 0));
t('an empty query -> empty', () => eq(M.search(IDX, '   ').length, 0));
t('a covered catalog page merges into its row (no duplicate Night light)', () => {
  const hits = M.search(IDX, 'night light').filter((h) => h.entry.label === 'Night light');
  eq(hits.length, 1, 'Night light entries');
});
t('a merged catalog keyword still finds its row ("pairing" -> Bluetooth)', () => eq(top('pairing').id, 'bluetooth.radio'));
t('grouped: mantle entries before windows ones in the flat list', () => {
  const g = M.grouped(M.search(IDX, 'mode'));
  const firstWin = g.flat.findIndex((h) => h.entry.group === 'windows');
  ok(firstWin === -1 || g.flat.slice(firstWin).every((h) => h.entry.group === 'windows'), 'groups interleaved');
});
t('per-group cap', () => ok(M.search(IDX, 'e', 3).filter((h) => h.entry.group === 'mantle').length <= 3));

/* ---- row ids ---- */
t('row ids', () => {
  eq(M.featureRow('gamemode'), 'mantle.feature.gamemode');
  eq(M.optionRow('gamemode', 'auto'), 'mantle.option.gamemode.auto');
  eq(M.shortcutRow('Win+V'), 'shortcuts.Win+V');
  eq(M.sectionOf('mantle.option.gamemode.auto'), 'mantle');
  eq(M.sectionOf('shortcuts.Win+V'), 'shortcuts');
  eq(M.sectionOf('apps.startup'), 'apps');
  eq(M.sectionOf('nope.x'), null);
});
t('every static row lives in a real section and ids are unique', () => {
  const seen = new Set();
  M.ROWS.forEach((r) => { ok(M.isSection(r.section), r.id); ok(!seen.has(r.id), 'dup ' + r.id); seen.add(r.id); });
});
t('every section has More links, all ms-settings:', () => {
  M.sectionIds().forEach((s) => { const l = M.more(s); ok(l.length >= 2, s); l.forEach((x) => ok(/^ms-settings:/.test(x.uri), x.uri)); });
});

/* ---- words ---- */
t('dur', () => { eq(M.dur(12000), '12 s'); eq(M.dur(4 * 60000), '4 min'); eq(M.dur(184 * 60000), '3 hr 4 min'); eq(M.dur(51 * 3600000), '2 d 3 hr'); eq(M.dur(null), '\u2014'); });
t('pct', () => { eq(M.pct(63.6), '64%'); eq(M.pct(null), '\u2014'); });
t('battery words', () => {
  eq(M.batteryWords({ ok: true, present: true, percent: 72, ac: false, secondsLeft: 184 * 60 }).text, '72% \u00b7 on battery \u00b7 3 hr 4 min left');
  eq(M.batteryWords({ ok: true, present: true, percent: 72, ac: true, charging: true }).text, '72% \u00b7 charging');
  eq(M.batteryWords({ ok: true, present: true, percent: 60, ac: true }).text, '60% \u00b7 plugged in, not charging');
  ok(M.batteryWords({ ok: true, present: false, percent: null, ac: true }).none);
  const bad = M.batteryWords({ ok: false, reason: 'GetSystemPowerStatus failed' });
  ok(bad.warn); eq(bad.text, 'GetSystemPowerStatus failed');
});
t('net words', () => {
  eq(M.netWords({ ok: true, kind: 'wifi', internet: true, wifi: { connected: true, ssid: 'Home-5G', band: '5 GHz' } }).text, 'Connected to Home-5G \u00b7 5 GHz');
  eq(M.netWords({ ok: true, kind: 'ethernet', internet: true }).text, 'Ethernet');
  ok(M.netWords({ ok: false, reason: 'x' }).warn);
});
t('shortCommand', () => {
  eq(M.shortCommand('"C:\\Program Files\\Cloud Drive\\clouddrive.exe" /background'), 'clouddrive.exe /background');
  eq(M.shortCommand('C:\\Apps\\chat\\chat.exe --minimized'), 'chat.exe --minimized');
  eq(M.shortCommand('C:\\Program Files\\Audio Helper\\helper.exe -s'), 'helper.exe -s');
  ok(M.shortCommand('"C:\\x\\a.exe" ' + 'y'.repeat(100), 30).length <= 30);
  eq(M.shortCommand(''), '');
});
t('keyCaps', () => {
  eq(M.keyCaps('Win+Shift+S').join('|'), 'Win|Shift|S');
  eq(M.keyCaps('PrintScreen').join('|'), 'PrintScreen');
  eq(M.keyCaps('Ctrl++').join('|'), 'Ctrl|+');
});
t('letter', () => { eq(M.letter('cloud drive'), 'C'); eq(M.letter('  (x)'), 'X'); eq(M.letter(''), '?'); });
t('featureState tones', () => {
  eq(M.featureState({ enabled: false }).tone, 'off');
  eq(M.featureState({ enabled: true, ok: false, reason: 'the sidecar is restarting' }).text, 'the sidecar is restarting');
  eq(M.featureState({ enabled: true, ok: true, resting: 'VALORANT runs' }).text, 'Resting while VALORANT runs');
  eq(M.featureState({ enabled: true, ok: true, running: true, chords: ['Win+V'] }).text, 'On \u00b7 Win+V');
  eq(M.featureState({ enabled: true, ok: true, running: true, keys: false, keysReason: 'another app holds it' }).tone, 'warn');
});
t('health', () => {
  const h = M.health([{ name: 'a', enabled: true, ok: true }, { name: 'b', enabled: true, ok: false, reason: 'r' }, { name: 'c', enabled: false }, { name: 'd', enabled: true, ok: true, resting: 'a game runs' }]);
  eq(h.on, 3); eq(h.off, 1); eq(h.bad.length, 1); eq(h.bad[0].reason, 'r'); eq(h.resting.length, 1);
});
t('health counts a feature whose keys went back to Windows', () => {
  const h = M.health([{ name: 'ontop', label: 'On top', enabled: true, ok: true, keys: false, keysReason: 'another app has Win+Ctrl+T' }]);
  eq(h.bad.length, 1); ok(/another app has Win\+Ctrl\+T/.test(h.bad[0].reason), h.bad[0].reason);
});
t('fuzzy ignores loose subsequences ("night" is not in "Snap right")', () => {
  eq(M.fuzzy('night', M.norm('Snap right')), 0);
  eq(M.fuzzy('night', M.norm('Volume and brightness pop-up')), 0);
  ok(M.fuzzy('nghtlt', M.norm('Night light')) > 0, 'nghtlt');
  ok(!M.search(IDX, 'night').some((h) => /snap right|brightness pop/i.test(h.entry.label)), 'noise in "night"');
});
t('taskmgr row', () => {
  eq(M.taskmgr([]).why, 'Mantle\'s task manager is not installed');
  eq(M.taskmgr([{ name: 'taskmgr', commands: ['taskmgr.open'], enabled: false }]).can, false);
  ok(/switched off/.test(M.taskmgr([{ name: 'taskmgr', commands: ['taskmgr.open'], enabled: false }]).why));
  ok(/resting while VALORANT runs/.test(M.taskmgr([{ name: 'taskmgr', commands: ['taskmgr.open'], enabled: true, ok: true, running: true, resting: 'VALORANT runs' }]).why));
  eq(M.taskmgr([{ name: 'taskmgr', commands: ['taskmgr.open'], enabled: true, ok: true, running: true }]).can, true);
  eq(M.taskmgr([{ name: 'taskmgr', commands: ['taskmgr.state'], enabled: true, ok: true, running: true }]).can, false);
});
t('optionValue', () => {
  eq(M.optionValue({ type: 'folder', value: null, defaultLabel: "Windows' Screenshots folder" }), "Windows' Screenshots folder");
  eq(M.optionValue({ type: 'choice', value: 'b', choices: [{ value: 'a', label: 'A' }, { value: 'b', label: 'Bee' }] }), 'Bee');
  eq(M.optionValue({ type: 'number', value: 5, unit: 's' }), '5 s');
});
t('displayFacts', () => {
  const f = M.displayFacts({ width: 2560, height: 1600, scalePercent: 150, hz: 120, rotation: 0 });
  eq(f[0][1], '2560 \u00d7 1600'); eq(f[1][1], '150%'); eq(f[2][1], '120 Hz'); eq(f[3][1], 'Landscape');
});

process.stdout.write(`${passed} passed, ${failed} failed\n`);
process.exitCode = failed ? 1 : 0;
