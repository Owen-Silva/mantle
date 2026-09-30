/* whole.test.js — Mantle Settings as ONE product: every REAL section file at once (lane settings,
 * 2026-09-29 quality pass). Node only: no browser, no Electron, no sidecar, nothing on screen.
 *
 * WHY: each category lane tests its own page; nothing checked that the eleven of them together make a
 * Settings app a person can find their way around. This loads every ui/settings/sections/<id>.js the
 * way the launcher's claims sandbox does (lib/launcher-index.js readSectionDef: an empty vm context
 * with only MantleSettings, render() never called) and runs the page's own rules (model.js) over
 * the lot:
 *   - every file is a valid section (none DOWN) and the sidebar is in Windows 11's order;
 *   - SEARCH: every row, page and section is findable by its own name (in the top 3), row ids are
 *     unique across sections, and the things people actually type land in the right category;
 *   - DEEP LINKS: every ms-settings: page a file claims resolves to a section/page that exists, and
 *     a claimed row is one its page lists; the launcher's catalog of Windows pages is covered (the
 *     pages still going out to Windows are printed, as counts + uris);
 *   - WORDS: labels in sentence case, no jargon (the polish bar: never "sidecar", "dryRun", a
 *     registry path, "0x...", "undefined"...) in any label, page title or help line.
 *
 *   node ui/settings/whole.test.js        (VERBOSE=1 prints every miss in full)
 * Prints "WHOLE SETTINGS TEST: n passed, m failed".
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const M = require('./model.js');

const DIR = path.join(__dirname, 'sections');
let passed = 0;
const failures = [];
const check = (name, ok, detail) => { if (ok) passed++; else failures.push(detail ? name + ' (' + String(detail).slice(0, 400) + ')' : name); return ok; };

/* ---- load every real section file (the same sandbox as lib/launcher-index.js readSectionDef) ---- */
const files = fs.readdirSync(DIR).filter((f) => /^[a-z][a-z0-9-]{0,39}\.js$/.test(f) && !f.endsWith('.test.js')).sort();
const defs = [];
for (const f of files) {
  const id = f.slice(0, -3);
  let def = null, err = null;
  try {
    const sandbox = { MantleSettings: { section(d) { if (def === null) def = d; } } };
    sandbox.window = sandbox; sandbox.self = sandbox;
    vm.runInNewContext(fs.readFileSync(path.join(DIR, f), 'utf8'), sandbox, { filename: 'sections/' + f, timeout: 500 });
  } catch (e) { err = e.message; }
  const why = err ? 'threw: ' + err : M.checkSection(def, id);
  check('section file ' + f + ' is a valid section', !why, why);
  if (!why) defs.push(def);
}
check('eleven Windows categories are built as section files', defs.length >= 11, defs.length);

const model = M.sectionModel(defs);
const nav = model.nav;
check('no section is DOWN', nav.every((e) => !e.down), nav.filter((e) => e.down).map((e) => e.id + ': ' + e.down).join('; '));

/* ---- the sidebar: Home, then Windows 11's category order, then Mantle's own ---- */
const WANT = ['home', 'system', 'devices', 'internet', 'personalization', 'applist', 'accounts', 'time', 'gaming',
  'accessibility', 'privacy', 'update', 'mantle', 'shortcuts', 'about'];
const got = nav.map((e) => e.id);
check('the sidebar is Home, the eleven Windows categories in Windows 11 order, then Mantle', JSON.stringify(got) === JSON.stringify(WANT), got.join(' '));
const labels = nav.map((e) => e.label);
check('sidebar names are unique', new Set(labels).size === labels.length, labels.join(' | '));
for (const e of nav) if (e.module) {
  check('sidebar item ' + e.id + ' has an icon', !!e.icon, e.icon);
  check('sidebar item ' + e.id + ' has a help line', typeof e.help === 'string' && e.help.trim().length > 0, e.help);
}

/* ---- every page: title, help line, icon; ids unique per section ---- */
const pageList = [];
for (const e of nav) {
  const pages = model.pages[e.id];
  if (!pages) continue;
  const ids = pages.map((p) => p.id);
  check(e.id + ': page ids are unique', new Set(ids).size === ids.length, ids.join(' '));
  const titles = pages.map((p) => p.title);
  check(e.id + ': page titles are unique', new Set(titles).size === titles.length, titles.join(' | '));
  for (const p of pages) {
    pageList.push({ section: e.id, sectionLabel: e.label, page: p });
    check(e.id + '/' + p.id + ' has a help line', typeof p.help === 'string' && p.help.trim().length > 0 || p.builtin, p.title);
    check(e.id + '/' + p.id + ' has an icon', !!p.icon, p.title);
  }
}

/* ---- row ids unique across the whole app ---- */
const rowOwners = new Map();
const allRows = [];
for (const d of defs) {
  const add = (list, page) => (Array.isArray(list) ? list : []).forEach((s) => {
    allRows.push({ section: d.id, page, s });
    const k = s.row;
    if (!rowOwners.has(k)) rowOwners.set(k, []);
    rowOwners.get(k).push(d.id + (page ? '/' + page : ''));
  });
  add(d.search, null);
  (Array.isArray(d.pages) ? d.pages : []).forEach((p) => add(p.search, p.id));
}
const dupRows = [...rowOwners].filter(([, w]) => w.length > 1);
check('every search row id is used once in the whole app', dupRows.length === 0, dupRows.map(([k, w]) => k + ' in ' + w.join(', ')).join('; '));
check('the app lists at least 400 searchable rows', allRows.length >= 400, allRows.length);

/* ---- search: everything findable by its own name ---- */
let catalog = [];
try { catalog = require('../../lib/launcher-index.js')._internals.SETTINGS.map((x) => (Array.isArray(x) ? { name: x[0], uri: x[1], keywords: x[2] } : x)); }
catch (e) { check('the launcher catalog of Windows pages loads', false, e.message); }
const index = M.buildIndex({ model, catalog });
const byName = new Map();
index.forEach((e) => { const k = e.nl; byName.set(k, (byName.get(k) || 0) + 1); });
const misses = [];
for (const e of index) {
  if (e.group !== 'mantle' || !e.label) continue;
  const hits = M.search(index, e.label, 40);
  const at = hits.findIndex((h) => h.entry === e);
  // a name shared by several entries only has to be in the first (copies + 2)
  const room = Math.max(3, (byName.get(e.nl) || 1) + 2);
  if (at < 0 || at >= room) misses.push(e.label + ' [' + e.id + '] at ' + (at < 0 ? 'none' : at + 1));
}
check('every section, page and row is in the top 3 for its own name', misses.length === 0, misses.length + ': ' + misses.slice(0, process.env.VERBOSE ? 999 : 12).join('; '));
const dupNames = [...byName].filter(([n, c]) => c > 1 && index.some((e) => e.nl === n && e.group === 'mantle'));
process.stdout.write('  (index: ' + index.length + ' entries, ' + allRows.length + ' rows in ' + defs.length + ' files, ' + dupNames.length + ' names used more than once)\n');
if (process.env.VERBOSE) dupNames.forEach(([n, c]) => process.stdout.write('    dup name x' + c + ': ' + n + '\n'));

/* ---- search: what people type lands in the right category (the first hit) ---- */
const TYPED = [
  ['wifi', 'internet'], ['wi-fi', 'internet'], ['bluetooth', 'devices'], ['vpn', 'internet'], ['proxy', 'internet'],
  ['airplane', 'internet'], ['hotspot', 'internet'], ['ethernet', 'internet'],
  ['brightness', 'system'], ['night light', 'system'], ['resolution', 'system'], ['scale', 'system'], ['volume', 'system'],
  ['microphone', null], ['speakers', 'system'], ['storage', 'system'], ['battery', 'system'], ['sleep', 'system'],
  ['do not disturb', 'system'], ['notifications', 'system'], ['rename pc', 'system'], ['clipboard', null],
  ['mouse', 'devices'], ['printer', 'devices'], ['camera', null], ['keyboard', null],
  ['dark mode', 'personalization'], ['wallpaper', 'personalization'], ['accent color', 'personalization'],
  ['lock screen', 'personalization'], ['fonts', 'personalization'], ['taskbar', 'personalization'],
  ['uninstall', 'applist'], ['startup apps', 'applist'], ['default browser', 'applist'], ['installed apps', 'applist'],
  ['sign-in options', 'accounts'], ['your info', 'accounts'],
  ['time zone', 'time'], ['date and time', 'time'], ['language', 'time'], ['region', 'time'],
  ['game mode', 'gaming'], ['game bar', 'gaming'],
  ['narrator', 'accessibility'], ['magnifier', 'accessibility'], ['text size', 'accessibility'], ['high contrast', 'accessibility'],
  ['location', 'privacy'], ['windows security', 'privacy'],
  ['windows update', 'update'], ['pause updates', 'update'], ['update history', 'update'],
  ['hot corners', 'mantle'], ['alt tab', ['mantle', 'system']], ['about', ['about', 'system']], ['shortcuts', 'shortcuts'], ['version', 'about'],
];
const typedBad = [];
for (const [q, want] of TYPED) {
  const hits = M.search(index, q, 12);
  const top = hits[0] && hits[0].entry;
  const sec = top ? (model.owner[top.section] ? model.owner[top.section].section : top.section) : null;
  if (!top) { typedBad.push('"' + q + '": nothing'); continue; }
  if (top.group !== 'mantle') { typedBad.push('"' + q + '": first hit goes out to Windows (' + top.label + ')'); continue; }
  if (want && ![].concat(want).includes(sec)) typedBad.push('"' + q + '": ' + top.label + ' in ' + sec + ', want ' + want);
}
// Mantle's own switcher is right there for "alt tab" (Windows' Multitasking row "Alt+Tab tabs" may come first)
check('"alt tab" shows the Mantle window switcher in the first 3', M.search(index, 'alt tab', 12).slice(0, 3).some((h) => h.entry.id === 'mantle.switcher'));
check('what people type lands in the right category, never out to Windows first', typedBad.length === 0, typedBad.join('; '));

/* ---- deep links: every claimed ms-settings: page lands on something that exists ---- */
const claims = Object.keys(model.claims);
const badClaims = [];
for (const u of claims) {
  const c = model.claims[u];
  const r = M.resolve(model, c);
  const pages = model.pages[r.section];
  if (r.down) { badClaims.push(u + ' -> DOWN'); continue; }
  if (r.section !== c.section) { badClaims.push(u + ' -> ' + r.section + ', claimed by ' + c.section); continue; }
  if (c.page && !(pages && pages.some((p) => p.id === r.page))) { badClaims.push(u + ' -> no page ' + c.page); continue; }
  if (c.row && !(model.rows[c.row])) badClaims.push(u + ' -> row ' + c.row + ' is not listed');
}
check('every claimed Windows page lands on a section/page/row that exists', badClaims.length === 0, badClaims.join('; '));
check('Mantle claims at least 100 Windows Settings pages', claims.length >= 100, claims.length);
const catUris = [...new Set(catalog.map((x) => String(x.uri).toLowerCase()))];
const outside = catUris.filter((u) => !model.claims[u]);
process.stdout.write('  (claims: ' + claims.length + ' Windows pages; the launcher catalog lists ' + catUris.length + ', ' + outside.length + ' of them still open Windows Settings)\n');
if (outside.length) process.stdout.write('    still Windows: ' + outside.join(' ') + '\n');

/* ---- words on screen: sentence case, no jargon ---- */
const JARGON = /\b(sidecar|dry ?run|hwnd|ipc|renderer|aumid|undefined|null|nan|hresult|hk(cu|lm|ey_[a-z_]+)\\|0x[0-9a-f]+|e_[a-z]+|enoent|eacces|\[object)/i;
const PROPER = new Set(['Windows', 'Mantle', 'Bluetooth', 'Wi-Fi', 'Microsoft', 'Store', 'Xbox', 'OneDrive', 'Edge', 'HDR', 'VPN',
  'DNS', 'IP', 'IPv4', 'IPv6', 'USB', 'PC', 'PIN', 'Hello', 'Game', 'Bar', 'Narrator', 'Magnifier', 'Defender', 'Update', 'Alt', 'Tab',
  'Win', 'Ctrl', 'Shift', 'Esc', 'Insider', 'Program', 'Mode', 'DirectX', 'Spotify', 'Task', 'View', 'Snap', 'Copilot', 'Teams',
  'Outlook', 'Dolby', 'Atmos', 'DTS', 'Sonic', 'MAC', 'ID', 'GPU', 'CPU', 'RAM', 'SSD', 'HDD', 'Ethernet', 'Explorer', 'File', 'Start',
  'Focus', 'Security', 'BitLocker', 'Kerberos', 'ClearType', 'Braille', 'Live', 'Captions', 'Voice', 'Access', 'Sticky', 'Keys',
  'Filter', 'Toggle', 'Mouse', 'Night', 'Light', 'Storage', 'Sense', 'Cloud', 'AutoPlay', 'Pen', 'Ink', 'Aero', 'Shake', 'Delivery',
  'Optimization', 'Find', 'My', 'Device', 'Family', 'Recall', 'Click', 'To', 'Do', 'SmartScreen', 'Nearby', 'Sharing', 'Phone', 'Link',
  'Print', 'Screen', 'Emoji', 'IME', 'UTC', 'GMT', 'AM', 'PM', 'Auto', 'HDMI', 'DisplayPort', 'Hz', 'DPI', 'Unicode', 'UTF-8', 'Beta',
  'Mantle\'s', 'Windows\'', 'OK', 'I', 'A', 'N', 'S', 'V', 'E', 'X', 'Z', 'Dev', 'Canary', 'Release', 'Preview', 'Channel', 'Dynamic', 'Lighting', 'RGB',
  'Recycle', 'Bin', 'Spaces', 'Remote', 'Desktop', 'Spacebar', 'Swift', 'Pair', 'Energy', 'Documents', 'Downloads', 'Music', 'Pictures', 'Videos', 'Cortana', 'Photos', 'Paint', 'Notepad', 'Chrome', 'Firefox', 'Discord', 'Steam', 'Valorant', 'Minecraft', 'Roblox', 'NVIDIA', 'AMD', 'Intel',
  'Settings', 'Control', 'Panel', 'Terminal', 'PowerShell', 'Command', 'Prompt', 'Web', 'Search', 'Enter', 'Space', 'Home', 'End',
  'Up', 'Down', 'Left', 'Right', 'PgUp', 'PgDn', 'F1', 'Caps', 'Lock', 'Num', 'Scroll', 'Fn', 'Mixed', 'Reality', 'Holographic',
  'IntelliMouse', 'Precision', 'Touchpad', 'Plug', 'Play', 'LAN', 'WLAN', 'SSID', 'WPA2', 'WPA3', 'WEP', 'DHCP', 'MB', 'GB', 'TB', 'KB']);
const words = [];
defs.forEach((d) => {
  words.push({ where: d.id, what: 'title', text: d.title }, { where: d.id, what: 'help', text: d.help || '' });
  (d.search || []).forEach((s) => words.push({ where: d.id, what: 'row', text: s.label }));
  (d.pages || []).forEach((p) => {
    if (p.title) words.push({ where: d.id + '/' + p.id, what: 'page', text: p.title });
    if (p.help) words.push({ where: d.id + '/' + p.id, what: 'help', text: p.help });
    (p.search || []).forEach((s) => words.push({ where: d.id + '/' + p.id, what: 'row', text: s.label }));
  });
});
const jargon = words.filter((w) => JARGON.test(w.text));
check('no jargon in any label, page title or help line', jargon.length === 0, jargon.map((w) => w.where + ' ' + w.what + ': "' + w.text + '"').join('; '));
const caseBad = words.filter((w) => w.what !== 'help' && w.text).filter((w) => {
  const ws = String(w.text).replace(/\([^)]*\)/g, ' ').split(/[\s/]+/).filter(Boolean);
  if (!/^[A-Z0-9"'(]/.test(ws[0] || '')) return true;                  // starts lower-case
  return ws.slice(1).some((x) => /^[A-Z][a-z]/.test(x) && !PROPER.has(x.replace(/[,.:;!?]+$/, '')));
});
check('labels and page titles are in sentence case', caseBad.length === 0, caseBad.length + ': ' + caseBad.slice(0, process.env.VERBOSE ? 999 : 15).map((w) => w.where + ' "' + w.text + '"').join('; '));
const emptyLabel = allRows.filter((r) => !r.s.label || !String(r.s.label).trim());
check('every search row has a label', emptyLabel.length === 0, emptyLabel.map((r) => r.s.row).join(' '));

process.stdout.write('WHOLE SETTINGS TEST: ' + passed + ' passed, ' + failures.length + ' failed\n');
failures.forEach((f) => process.stdout.write('  FAIL ' + f + '\n'));
process.exitCode = failures.length ? 1 : 0;
