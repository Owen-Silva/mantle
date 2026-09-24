/* launcher-search.test.js — the Win+S additions to the launcher, without Electron:
 *   the calculator (ui/launcher/calc.js), the Settings table and its keyword ranking
 *   (lib/launcher-index.js), the grouped layout (ui/launcher/groups.js), and the web / copy
 *   actions as DRY RUNS. Nothing here opens a URL, launches anything or touches the clipboard:
 *   the one non-dry copy is into a stub object.
 *
 *   node lib/launcher-search.test.js
 */
'use strict';
const path = require('path');
const calc = require(path.join(__dirname, '..', 'ui', 'launcher', 'calc.js'));
const groups = require(path.join(__dirname, '..', 'ui', 'launcher', 'groups.js'));
const idx = require('./launcher-index.js');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, what) { if (cond) pass++; else { fail++; failures.push(what); } }

/* ---- calculator -------------------------------------------------------------- */
const V = (q) => { const r = calc.evaluate(q); return r && r.ok ? r.value : (r ? 'ERR' : null); };
const cases = [
  ['2+2', 4], ['2*(3+4)', 14], ['10/4', 2.5], ['2^10', 1024], ['2**3', 8], ['2^3^2', 512],
  ['-2^2', -4], ['(-2)^2', 4], ['7 mod 3', 1], ['10 % 3', 1], ['50%', 0.5], ['15% of 80', 12],
  ['50% * 20', 10], ['3 x 4', 12], ['3×4', 12], ['8÷2', 4], ['5−3', 2], ['0.1+0.2', 0.3],
  ['sqrt(16)', 4], ['sqrt(2)*sqrt(2)', 2], ['abs(-3)+1', 4], ['max(1, 9, 4)', 9], ['min(3,2)', 2],
  ['pow(2, 8)', 256], ['log(1000)', 3], ['ln(e)', 1], ['log2(8)', 3], ['2pi', 2 * Math.PI],
  ['2(3+4)', 14], ['(1+2)(3+4)', 21], ['5!', 120], ['sin(90°)', 1], ['cos(0)', 1], ['1e3+1', 1001],
  ['=6*7', 42], ['.5+.5', 1], ['1.5e-3*1000', 1.5], ['round(2.6)+floor(2.6)+ceil(2.1)', 8],
];
for (const [q, want] of cases) {
  const got = V(q);
  ok(typeof got === 'number' && Math.abs(got - want) < 1e-9, 'calc "' + q + '" = ' + want + ' (got ' + got + ')');
}
// not a calculation: null, so no row appears
for (const q of ['', '42', '-3', '(5)', 'pi', 'e', '2+', '(2+3', 'sqrt', 'sqrt(', '3e', '2 3', 'notes',
                 'notes-2', 'report 2024', '2026-09-24', '2026-09', 'x', 'alert(1)', 'process.exit()',
                 'constructor', '__proto__', 'this', 'a+b', '1,5', 'mantle', 'hello world', '1.2.3',
                 'Function("x")()', '`1`+1', '1+1;', 'window.x']) {
  ok(calc.evaluate(q) === null, 'calc "' + q + '" is not a calculation (got ' + JSON.stringify(calc.evaluate(q)) + ')');
}
// a calculation with no answer says why, in words
for (const [q, re] of [['1/0', /divide by zero/], ['5 mod 0', /remainder by zero/], ['sqrt(-1)', /no real-number/],
                       ['171!', /too large/], ['2.5!', /whole number/], ['10^400', /too large/], ['pow(2)', /takes 2 numbers/]]) {
  const r = calc.evaluate(q);
  ok(r && r.ok === false && re.test(r.reason), 'calc "' + q + '" explains itself (got ' + JSON.stringify(r) + ')');
}
// formatting: grouped digits on screen, plain digits for the clipboard, no binary noise, no "-0"
const big = calc.evaluate('1234567*10');
ok(big.display === '12,345,670' && big.copy === '12345670', 'display groups digits, copy does not (' + big.display + ' / ' + big.copy + ')');
ok(calc.evaluate('0.1+0.2').copy === '0.3', '0.1+0.2 copies as 0.3');
ok(calc.evaluate('-1*0').copy === '0', 'no negative zero');
ok(/× 10\^20$/.test(calc.evaluate('10^20*1').display), 'huge numbers go to exponent form (' + calc.evaluate('10^20*1').display + ')');
ok(calc.evaluate('-5*3').display === '−15', 'a negative answer shows a real minus sign');
ok(calc.evaluate('sin(1)+0').radians === true && !calc.evaluate('1+1').radians, 'trig answers say they are in radians');
// speed: the row is computed on every keystroke in the renderer
{
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 2000; i++) calc.evaluate('(12.5*4 + sqrt(81)) / 3 - 2^5 % 7');
  const us = Number(process.hrtime.bigint() - t0) / 1000 / 2000;
  ok(us < 200, 'one evaluate() under 0.2 ms (got ' + us.toFixed(1) + ' us)');
  console.log('  calc: ' + us.toFixed(1) + ' us per evaluate');
}

/* ---- copy: dry run, and only ever a computed number ------------------------------------- */
{
  const dry = idx.copyCalc({ expr: '6*7' }, { dryRun: true });
  ok(dry.ok && dry.dryRun && dry.copied === '42' && /dry run: would copy 42/.test(dry.reason), 'copyCalc dry run copies nothing and says what it would');
  const stub = { text: null, writeText(t) { this.text = t; } };
  const real = idx.copyCalc({ expr: '6*7' }, { dryRun: false, clipboard: stub });
  ok(real.ok && stub.text === '42', 'copyCalc writes exactly the answer into the clipboard it is given (a stub here)');
  const stub2 = { text: null, writeText(t) { this.text = t; } };
  const not = idx.copyCalc({ expr: 'my secret text' }, { clipboard: stub2 });
  ok(!not.ok && stub2.text === null && /not a calculation/.test(not.reason), 'copyCalc refuses anything that is not a calculation');
  const bad = idx.copyCalc({ expr: '1/0' }, { clipboard: stub2 });
  ok(!bad.ok && stub2.text === null && /divide by zero/.test(bad.reason), 'copyCalc passes the calculator\'s reason through');
  ok(!idx.copyCalc({ expr: '1+1' }, {}).ok, 'copyCalc without a clipboard says so');
}

/* ---- web ------------------------------------------------------------------------------ */
ok(idx.webSearchUrl('a b&c=d') === 'https://www.google.com/search?q=a+b%26c%3Dd', 'web URL is encoded (' + idx.webSearchUrl('a b&c=d') + ')');
ok(idx.webSearchUrl('   ') === null, 'no web URL for nothing');

/* ---- the Settings table ----------------------------------------------------------------- */
const SETTINGS = idx._internals.SETTINGS;
ok(SETTINGS.length >= 95, 'about a hundred Settings pages (got ' + SETTINGS.length + ')');
ok(new Set(SETTINGS.map(s => s[1])).size === SETTINGS.length, 'no Settings URI twice');
ok(new Set(SETTINGS.map(s => s[0].toLowerCase())).size === SETTINGS.length, 'no Settings name twice');
ok(SETTINGS.every(s => /^ms-settings:[a-z0-9-]+$/.test(s[1])), 'every URI is a plain ms-settings: page');
ok(SETTINGS.every(s => typeof s[2] === 'string' && s[2].trim().length > 0), 'every page has keywords');
const ORIGINAL = ['display', 'sound', 'bluetooth', 'network-wifi', 'network', 'appsfeatures', 'personalization',
  'windowsupdate', 'storagesense', 'batterysaver', 'privacy', 'yourinfo', 'dateandtime', 'notifications',
  'quiethours', 'printers', 'mousetouchpad', 'keyboard', 'typing', 'defaultapps', 'startupapps', 'about',
  'optionalfeatures', 'developers', 'windowsdefender', 'multitasking'].map(u => 'ms-settings:' + u);
ok(ORIGINAL.every(u => SETTINGS.some(s => s[1] === u)), 'the 26 pre-Win+S pages are all still there (their row ids did not move)');

/* everything below needs the real index, which build()s asynchronously (icons off) */
(async () => {
const built = await idx.build({ icon: async () => null });
const items = built.items;
ok(built.sources.find(s => s.name === 'settings').count >= 96, 'build() indexes the whole table plus Mantle\'s own');
const topSetting = (q) => (idx.search(q, items).find(i => i.kind === 'setting') || {}).name;
const settingCases = [
  ['dark mode', 'Colors'], ['desktop background', 'Background'], ['uninstall', 'Installed apps'], ['bt', 'Bluetooth & devices'],
  ['wifi', 'Wi-Fi'], ['night', 'Night light'], ['startup', 'Startup apps'], ['default browser', 'Default apps'],
  ['update', 'Windows Update'], ['hdr', 'HDR'], ['vpn', 'VPN'], ['screen timeout', 'Screen and sleep'],
  ['bluetooth', 'Bluetooth & devices'], ['resolution', 'Display'], ['speakers', 'Sound'], ['indexing', 'Searching Windows'],
  ['hotspot', 'Mobile hotspot'], ['do not disturb', 'Focus'], ['antivirus', 'Windows Security'], ['pin', 'Sign-in options'],
  ['time zone', 'Date & time'], ['volume mixer', 'Volume mixer'], ['power mode', 'Power & battery'], ['snap', 'Multitasking'],
  ['disk cleanup', 'Cleanup recommendations'], ['taskbar', 'Taskbar'], ['rename pc', 'About this PC'],
];
for (const [q, want] of settingCases) ok(topSetting(q) === want, 'Settings for "' + q + '" -> ' + want + ' (got ' + topSetting(q) + ')');
// Mantle's own Wallpapers window is what "wallpaper" means here; Windows' Background is right behind it
ok(idx.search('wallpaper', items).filter(i => i.kind === 'setting').map(i => i.name).slice(0, 2).join('|') === 'Wallpapers|Background', '"wallpaper": Mantle’s Wallpapers, then Background');
ok(idx.search('mic', items).some(i => i.name === 'Sound'), '"mic" lists Sound');
// keywords never outrank an exact name or a power row's own words
ok(idx.search('sleep', items)[0].name === 'Sleep', '"sleep" is still the Sleep action first');
ok(idx.search('lock', items)[0].name === 'Lock', '"lock" is still Lock first');
ok(idx.search('restart', items)[0].name === 'Restart', '"restart" is still Restart first');
ok(!idx.search('s', items).some(i => i.kind === 'power'), '"s" still shows no power row');
// shared out by group, still twelve at most
for (const q of ['s', 'a', 'se', 'co', 'win']) {
  const r = idx.search(q, items);
  const per = r.reduce((m, i) => { m[i.kind] = (m[i.kind] || 0) + 1; return m; }, {});
  ok(r.length <= 12 && (per.app || 0) <= 6 && (per.setting || 0) <= 4 && (per.command || 0) <= 4,
     '"' + q + '": at most 12 rows, 6 apps, 4 settings, 4 commands (' + JSON.stringify(per) + ')');
}
ok(idx.search('win', items).some(i => i.kind === 'setting'), '"win" leaves room for Settings pages among the apps');
// speed: apps + settings for a keystroke, on the real index
{
  const qs = ['s', 'se', 'set', 'blu', 'dark mode', 'code', 'wifi', 'update', 'chrome', 'xyz'];
  const t0 = process.hrtime.bigint();
  for (let k = 0; k < 20; k++) for (const q of qs) idx.search(q, items);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / (20 * qs.length);
  ok(ms < 10, 'search() over ' + items.length + ' items under 10 ms a keystroke (got ' + ms.toFixed(2) + ' ms)');
  console.log('  search(): ' + ms.toFixed(2) + ' ms per keystroke over ' + items.length + ' items');
}

/* ---- groups --------------------------------------------------------------------------- */
const mk = (kind, name, score, extra) => Object.assign({ id: kind + ':' + name, kind, name, subtitle: '', score }, extra || {});
{
  const appRows = [mk('app', 'Blender', 900), mk('setting', 'Bluetooth & devices', 884), mk('command', 'blob', 400)];
  const g = groups.build({ q: 'bl', appRows, fileRows: [], fileState: { status: 'idle' }, filePending: true, calc: null });
  const keys = g.groups.map(x => x.key);
  ok(keys.join(',') === 'apps,settings,commands,files,web', 'groups by best score, files pending before web (' + keys + ')');
  const files = g.groups.find(x => x.key === 'files');
  ok(files.status && files.status.kind === 'pending' && files.rows.length === 0, 'a pending Files group says it is searching');
  ok(g.flat[g.flat.length - 1].kind === 'web', 'Search the web is the last row');
  ok(g.flat.length === 4, 'status lines are not selectable rows (' + g.flat.length + ')');
  ok(/Search the web for “bl”/.test(g.flat[3].name), 'the web row names what is typed');
}
{
  const g = groups.build({ q: '2*21', appRows: [mk('app', 'Calculator', 300)], fileRows: [],
                           fileState: { status: 'idle' }, filePending: false, calc: calc.evaluate('2*21') });
  ok(g.groups[0].key === 'calc' && g.flat[0].kind === 'calc' && g.flat[0].name === '= 42', 'an arithmetic query leads with the answer');
  ok(g.flat[0].copy === '42', 'the calc row carries what Enter copies');
}
{
  const bad = groups.build({ q: '1/0', appRows: [], fileRows: [], fileState: { status: 'idle' }, calc: calc.evaluate('1/0') });
  ok(bad.flat[0].kind === 'calc' && bad.flat[0].bad && /divide by zero/.test(bad.flat[0].name), 'a calculation with no answer shows why');
}
{
  const fileRows = [mk('file', 'report.docx', 700), mk('file', 'rep.txt', 690)];
  const g = groups.build({ q: 'rep', appRows: [mk('app', 'Remote Desktop', 260)], fileRows,
                           fileState: { status: 'ok', n: 2 }, filePending: false });
  ok(g.groups[0].key === 'files', 'a file that fits better than a loose app match leads');
  const down = groups.build({ q: 'rep', appRows: [], fileRows: [], fileState: { status: 'error', reason: 'the Windows Search service (WSearch) is Stopped' } });
  const fg = down.groups.find(x => x.key === 'files');
  ok(fg && fg.status.kind === 'error' && /WSearch/.test(fg.status.text), 'an unavailable index shows its reason in the Files group');
  const none = groups.build({ q: 'zzqx', appRows: [], fileRows: [], fileState: { status: 'ok', n: 0 }, filePending: false });
  ok(none.groups.find(x => x.key === 'files').status.kind === 'empty', 'an index that looked and found nothing says so');
  const one = groups.build({ q: 'r', appRows: [], fileRows: [mk('file', 'r.txt', 700)], fileState: { status: 'ok' } });
  ok(!one.groups.some(x => x.key === 'files'), 'one letter: no Files group at all');
  const note = groups.build({ q: 'rep', appRows: [], fileRows: fileRows, fileState: { status: 'ok', reason: 'your profile is not an indexed location' } });
  ok(note.groups.find(x => x.key === 'files').status.kind === 'note', 'an unindexed-scope note rides along with the rows');
}
{
  const appRows = [mk('command', 'dash', 0), mk('command', 'bot', 0), mk('app', 'Chrome', 0)];
  const g = groups.build({ q: '', appRows, fileRows: [], fileState: { status: 'idle' } });
  ok(g.groups.map(x => x.key).join(',') === 'commands,apps', 'the empty launcher is commands then apps, no web row');
  const many = [];
  for (let i = 0; i < 12; i++) many.push(mk('app', 'App' + i, 0));
  ok(groups.build({ q: '', appRows: many }).flat.length === 12, 'the empty launcher keeps all twelve (no group cap)');
}
{
  const G = [{ rows: [1, 2] }, { rows: [3] }, { rows: [] }, { rows: [4, 5, 6] }];
  ok(groups.jumpGroup(G, 0, 1) === 2 && groups.jumpGroup(G, 2, 1) === 3 && groups.jumpGroup(G, 4, 1) === 0, 'Tab jumps to the next group, wrapping');
  ok(groups.jumpGroup(G, 0, -1) === 3 && groups.jumpGroup(G, 3, -1) === 2, 'Shift+Tab jumps back a group');
}
{
  // the whole renderer-side keystroke: calc + grouping over a real apps.search answer
  const appRows = idx.search('se', items);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 500; i++) groups.build({ q: 'se', appRows, fileRows: [], fileState: { status: 'idle' }, filePending: true, calc: calc.evaluate('se') });
  const us = Number(process.hrtime.bigint() - t0) / 1000 / 500;
  ok(us < 1000, 'grouping a keystroke under 1 ms (got ' + us.toFixed(1) + ' us)');
}

/* ---- web open: dry run only ------------------------------------------------------------- */
  const w = await idx.openWeb({ q: 'mantle shell' }, { dryRun: true });
  ok(w.ok && w.dryRun && /dry run/.test(w.reason) && w.url === 'https://www.google.com/search?q=mantle+shell', 'openWeb dry run opens nothing and names the URL');
  const e = await idx.openWeb({ q: '  ' }, { dryRun: true });
  ok(!e.ok && /nothing typed/.test(e.reason), 'openWeb refuses an empty query');
  const long = await idx.openWeb({ q: 'x'.repeat(501) }, { dryRun: true });
  ok(!long.ok && /too long/.test(long.reason), 'openWeb refuses a 501-character query');

  for (const f of failures) console.log('  FAIL: ' + f);
  console.log('LAUNCHER SEARCH TEST: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
