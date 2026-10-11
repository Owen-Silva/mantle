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

  // --- Quartz's exe (lib/quartz-exe.js): Quartz.exe when it exists, else its bare electron.exe ---
  {
    const LIm = require('./launcher-index');
    const QZ = require('./quartz-exe');
    const [QX, EX] = QZ.candidates();
    const url = { kind: 'url', name: 'x', path: 'https://example.com/' };
    const was = LIm._setBrowserExistsForTest((p) => p === QX || p === EX);
    try {
      const both = await launch(url, { dryRun: true });
      ok(both.ok && both.reason.includes('"' + QX + '"') && !both.reason.includes('electron.exe'), 'url launch: Quartz.exe present -> starts Quartz.exe (' + both.reason + ')');
      LIm._setBrowserExistsForTest((p) => p === EX);
      const old = await launch(url, { dryRun: true });
      ok(old.ok && old.reason.includes('"' + EX + '"') && !old.reason.includes('Quartz.exe'), 'url launch: Quartz.exe absent -> falls back to electron.exe (' + old.reason + ')');
      LIm._setBrowserExistsForTest(() => false);
      const none = await launch(url, { dryRun: true });
      ok(none.ok && /browser is missing/.test(none.reason) && none.reason.includes(QX), 'url launch: neither exe -> says the browser is missing, naming Quartz.exe (' + none.reason + ')');
      LIm._setBrowserExistsForTest((p) => p === QX);
      const web = await LIm.openWeb({ q: 'quartz test' }, { dryRun: true });
      ok(web.ok && web.reason.includes('"' + QX + '"'), 'web search: Quartz.exe present -> runs through Quartz.exe (' + web.reason + ')');
      LIm._setBrowserExistsForTest((p) => p === EX);
      const web2 = await LIm.openWeb({ q: 'quartz test' }, { dryRun: true });
      ok(web2.ok && web2.reason.includes('"' + EX + '"'), 'web search: only electron.exe -> runs through electron.exe (' + web2.reason + ')');
      LIm._setBrowserExistsForTest(() => false);
      const web3 = await LIm.openWeb({ q: 'quartz test' }, { dryRun: true });
      ok(web3.ok && /Windows default browser/.test(web3.reason) && web3.reason.includes(QX), 'web search: no Quartz at all -> the Windows default browser, saying why (' + web3.reason + ')');
    } finally {
      LIm._setBrowserExistsForTest(was);
    }
  }

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
  // (the Sound page is the built-in's, or the System module's page that replaced it: "at sound" or "at system/sound")
  const snd = await launch({ kind: 'setting', path: 'ms-settings:sound', name: 'Sound' }, { dryRun: true });
  ok(snd.ok === true && /^dry run/.test(snd.reason) && /Mantle Settings at (system\/)?sound /.test(snd.reason) && /Windows' ms-settings:sound/.test(snd.reason),
    'ms-settings:sound dry run names Mantle Settings at sound and Windows\' ms-settings:sound (' + JSON.stringify(snd) + ')');
  const sdev = await launch({ kind: 'setting', path: 'ms-settings:sound-devices', name: 'Sound devices' }, { dryRun: true });
  ok(sdev.ok === true && /Mantle Settings at (system\/)?sound /.test(sdev.reason) && /ms-settings:sound-devices/.test(sdev.reason),
    'ms-settings:sound-devices dry run goes to Mantle Settings at sound (' + JSON.stringify(sdev) + ')');
  // a page no section covers is still Windows' own, in the old words (whichever one is left uncovered)
  const bare = LI.SETTINGS.map(r => r[1]).find(u => !LI.coverOf(u));
  const wu = bare ? await launch({ kind: 'setting', path: bare, name: 'x' }, { dryRun: true }) : null;
  ok(!bare || (wu.ok === true && /^dry run: would run /.test(wu.reason) && new RegExp('(shell\\.openExternal|cmd /c start "") "' + bare + '"').test(wu.reason) && !/Mantle Settings/.test(wu.reason)),
    'a page no section covers (' + bare + ') dry run is still Windows\' own page, the old words (' + JSON.stringify(wu) + ')');

  // --- section modules' claims (lane wire, 2026-09-29): every ms-settings page a module in
  // ui/settings/sections claims is in the launcher and opens Mantle's page (section/page/row) ---
  const SC = LI.sectionClaims();
  const claimed = Object.values(SC.claims);
  ok(SC.reason === '' && Object.keys(SC.down).length === 0, 'every section page file loads for the claims (down: ' + JSON.stringify(SC.down) + ')');
  ok(claimed.length >= 60, 'the section modules claim their pages (' + claimed.length + ' claimed)');
  const setRows = items.filter(i => i.kind === 'setting');
  const lost = claimed.filter(c => !setRows.some(i => i.path.toLowerCase() === c.uri && i.subtitle === 'Mantle Settings'));
  ok(lost.length === 0, 'every claimed page is a launcher row saying Mantle Settings (missing: ' + lost.map(c => c.uri).join(' ') + ')');
  ok(new Set(setRows.map(i => i.id)).size === setRows.length, 'no Settings row is listed twice (a claimed page the catalog lacks is added once)');
  let badRuns = [];
  for (const c of claimed) {
    const r = await launch({ kind: 'setting', path: c.uri, name: c.name }, { dryRun: true });
    const want = 'Mantle Settings at ' + c.section + (c.page ? '/' + c.page : '') + ' (Windows\' ' + c.uri + ' if';
    if (!(r.ok === true && r.reason.includes(want))) badRuns.push(c.uri + ' -> ' + r.reason);
  }
  ok(badRuns.length === 0, 'every claimed page\'s dry run opens Mantle at its section/page, Windows\' page only as the fallback (' + badRuns.slice(0, 3).join(' | ') + ')');
  const priv = await launch({ kind: 'setting', path: 'ms-settings:privacy', name: 'Privacy & security' }, { dryRun: true });
  ok(/Mantle Settings at privacy \(/.test(priv.reason), 'ms-settings:privacy (a category root, claimed with the section-level uri) opens the Privacy overview (' + priv.reason + ')');
  const pc = LI.coverOf('MS-SETTINGS:PRIVACY-WEBCAM');
  ok(pc && pc.section === 'privacy' && pc.page && pc.row, 'coverOf is case-blind and gives section, page and row (' + JSON.stringify(pc) + ')');
  ok(search('contacts access', items)[0] && search('contacts access', items)[0].path === 'ms-settings:privacy-contacts', "search('contacts access') finds the Contacts permission page");
  ok(search('mouse keys', items).slice(0, 3).some(i => i.path === 'ms-settings:easeofaccess-mouse'), "search('mouse keys') finds Accessibility's Mouse keys");
  // a made-up sections folder: a throwing file, one registering nothing, one claiming its root + a page
  const tmp = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'wire-claims-'));
  const W = (f, s) => require('fs').writeFileSync(require('path').join(tmp, f), s);
  W('aaa.js', "MantleSettings.section({ id: 'aaa', title: 'A', uri: 'ms-settings:aroot', search: [{ row: 'aaa.x', label: 'X', uri: 'ms-settings:shared' }], pages: [{ id: 'p1', title: 'P1', uri: ['ms-settings:apage', 'bogus'], search: [{ row: 'aaa.p1.y', label: 'Y', uri: 'ms-settings:ay' }] }] });");
  W('bbb.js', "MantleSettings.section({ id: 'bbb', title: 'B', search: [{ row: 'bbb.z', label: 'Z', uri: 'ms-settings:shared' }] });");
  W('ccc.js', 'document.body.appendChild(1);');
  W('ddd.js', '/* registers nothing */');
  W('eee.js', 'while (true) {}');
  W('fff.test.js', 'throw new Error("never loaded")');
  W('_ggg.js', 'throw new Error("never loaded")');
  const F = LI.sectionClaims(tmp);
  ok(F.claims['ms-settings:aroot'] && F.claims['ms-settings:aroot'].page === null && F.claims['ms-settings:aroot'].row === null, 'fixture: a section-level uri claims the category root (no page, no row)');
  ok(F.claims['ms-settings:apage'] && F.claims['ms-settings:apage'].page === 'p1' && !F.claims.bogus, 'fixture: a page-level uri claims that page; a non ms-settings value is ignored');
  ok(F.claims['ms-settings:ay'] && F.claims['ms-settings:ay'].row === 'aaa.p1.y', 'fixture: a row uri claims that row');
  ok(F.claims['ms-settings:shared'].section === 'aaa', 'fixture: two files claiming one page: the first by file name keeps it');
  ok(/threw while loading/.test(F.down.ccc) && /registered no section/.test(F.down.ddd) && /threw while loading/.test(F.down.eee),
    'fixture: a throwing file, an empty one and a runaway loop are DOWN with their reasons (' + JSON.stringify(F.down) + ')');
  ok(!('fff' in F.down) && !F.down['fff.test'] && !F.down._ggg, 'fixture: *.test.js and _*.js are never run');
  ok(LI.sectionClaims(require('path').join(tmp, 'nope')).reason === '', 'fixture: no sections folder = no claims, no error');
  require('fs').rmSync(tmp, { recursive: true, force: true });
  const own = await launch({ kind: 'setting', path: 'mantle:settings', name: 'Mantle Settings' }, { dryRun: true });
  ok(own.ok === true && /^dry run: would open Mantle Settings \(Windows' ms-settings: if/.test(own.reason),
    'mantle:settings dry run opens Mantle Settings, falling back to Windows\' ms-settings: (' + JSON.stringify(own) + ')');
  const wp = await launch({ kind: 'setting', path: 'mantle:wallpapers', name: 'Wallpapers' }, { dryRun: true });
  ok(wp.ok === true && wp.reason === "dry run: would open Mantle's wallpapers window", 'mantle:wallpapers dry run is unchanged (' + JSON.stringify(wp) + ')');
  const msRow = sets.find(i => i.path === 'mantle:settings');
  ok(msRow && msRow.name === 'Mantle Settings' && msRow.subtitle === 'Mantle' && /^data:image\/png;base64,/.test(msRow.icon) && msRow.id,
    'the mantle:settings row is built, subtitle Mantle, with Mantle Settings\' own icon (' + JSON.stringify(Object.assign({}, msRow, { icon: msRow && msRow.icon ? msRow.icon.slice(0, 30) + '...' : msRow && msRow.icon })) + ')');
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
  // (icons lane: where Windows' Task Manager shortcut exists, this row is IN ITS PLACE in Apps)
  const tmRow = items.find(i => i.path === 'mantle:taskmgr');
  const tmGame = sets.find(i => i.path === 'mantle:taskmgr:game');
  ok(tmRow && tmRow.name === 'Mantle Task Manager' && /^Mantle/.test(tmRow.subtitle), 'the mantle:taskmgr row is built (' + JSON.stringify(Object.assign({}, tmRow, { icon: '...' })) + ')');
  ok(items.filter(i => i.path === 'mantle:taskmgr').length === 1, 'Mantle Task Manager is listed once (Apps when it took the shortcut\'s place, else Settings)');
  ok(tmGame && tmGame.name === 'Get ready to game (free RAM)', 'the mantle:taskmgr:game row is built (' + JSON.stringify(tmGame) + ')');
  ok(search('task manager', items).slice(0, 3).some(i => i.path === 'mantle:taskmgr'), "search('task manager') has the row in the top 3");
  const EventEmitter = require('events');
  const fakeApp = new EventEmitter();
  fakeApp.on('mantle-open', () => {});            // the wallpaper library: always there
  // a FAKE shell: the off/resting road opens Windows' Task Manager, and a test must never really open it
  const opened = [];
  const fakeShell = { openPath: async (p) => { opened.push(p); return ''; }, openExternal: async (u) => { opened.push(u); } };
  const was = require('./launcher-index')._setElectronForTest({ app: fakeApp, shell: fakeShell });
  try {
    const off = await launch(tmRow || { kind: 'setting', path: 'mantle:taskmgr' });
    ok(off.ok === true && off.reason === "opened Windows Task Manager: Mantle's task manager is off or resting while a game runs" &&
      opened.length === 1 && /(Task Manager\.lnk|Taskmgr\.exe)$/i.test(opened[0]),
      'no task manager listening (off or resting): Windows\' Task Manager opens, and the row says why (' + JSON.stringify([off, opened]) + ')');
    const offGame = await launch(tmGame || { kind: 'setting', path: 'mantle:taskmgr:game' });
    ok(offGame.ok === false && offGame.reason === "Mantle's task manager is off or resting while a game runs" && opened.length === 1,
      '"Get ready to game" has no Windows version: refused with the reason, nothing opened (' + JSON.stringify(offGame) + ')');
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

  // --- Mantle Files (2026-09-29, Owen: Files "takes super long to actually open"): a row of its own,
  // and File Explorer's shortcut stands in for it; opened on the feature's OWN 'mantle-open:files'
  // event with a reply; no listener = off or resting: Windows' File Explorer, and the row says why. ---
  const fRow = items.find(i => i.path === 'mantle:files');
  ok(fRow && fRow.name === 'Mantle Files' && items.filter(i => i.path === 'mantle:files').length === 1,
    'the mantle:files row is built and listed once (' + JSON.stringify(Object.assign({}, fRow, { icon: '...' })) + ')');
  ok(search('file explorer', items).slice(0, 2).some(i => i.path === 'mantle:files'), "search('file explorer') has Mantle Files in the top 2");
  ok(search('files', items)[0].path === 'mantle:files', "search('files') is Mantle Files first");
  {
    const fApp = new EventEmitter();
    fApp.on('mantle-open', () => {});            // the wallpaper library: always there
    const fOpened = [];
    const fShell = { openPath: async (p) => { fOpened.push(p); return ''; }, openExternal: async (u) => { fOpened.push(u); } };
    const was2 = require('./launcher-index')._setElectronForTest({ app: fApp, shell: fShell });
    try {
      const row = fRow || { kind: 'setting', path: 'mantle:files' };
      const off = await launch(row);
      ok(off.ok === true && off.reason === 'opened File Explorer: Mantle Files is off or resting while a game runs' &&
        fOpened.length === 1 && /(File Explorer\.lnk|explorer\.exe)$/i.test(fOpened[0]),
        'Files off or resting: Windows\' File Explorer opens, and the row says why (' + JSON.stringify([off, fOpened]) + ')');
      const fGot = [];
      fApp.on('mantle-open:files', (o) => { fGot.push(o.path || null); o.reply.handled = true; o.reply.ok = fGot.length === 1; o.reply.reason = fGot.length === 1 ? null : 'a test refusal'; });
      let fShared = 0;
      fApp.on('mantle-open', (t) => { if (/^files/.test(t)) fShared++; });
      const on1 = await launch(row);
      const on2 = await launch(row);
      ok(on1.ok === true && JSON.stringify(fGot) === '[null,null]' && fShared === 0 && fOpened.length === 1,
        'Files on: opened on its own event only, no Explorer, no shared mantle-open (' + JSON.stringify([on1, fGot, fShared]) + ')');
      ok(on2.ok === false && on2.reason === 'a test refusal', 'a Files refusal comes back to the row as its reason, never silent (' + JSON.stringify(on2) + ')');
      const dry = await launch(row, { dryRun: true });
      ok(dry.ok === true && dry.reason === "dry run: would open Mantle's files window", 'mantle:files dry run (' + JSON.stringify(dry) + ')');
    } finally {
      require('./launcher-index')._setElectronForTest(was2);
    }
  }

  // --- icons lane (2026-09-28): Mantle's versions come up IN PLACE of Windows' Settings and Task
  // Manager, with their own icons; Windows' own is one row below, named for what it is. ---
  const TM_LNK = 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\System Tools\\Task Manager.lnk';
  const isPng = (u) => /^data:image\/png;base64,/.test(String(u || ''));
  if (require('fs').existsSync(TM_LNK)) {
    ok(tmRow && tmRow.kind === 'app' && tmRow.mantleApp === 'taskmgr' && tmRow.windowsPath === TM_LNK && isPng(tmRow.icon),
      'Windows\' Task Manager shortcut became Mantle Task Manager in Apps, with Mantle\'s icon (' + JSON.stringify(Object.assign({}, tmRow, { icon: isPng(tmRow && tmRow.icon) })) + ')');
    const winTm = items.find(i => i.name === 'Windows Task Manager');
    ok(winTm && winTm.kind === 'app' && winTm.path === TM_LNK && winTm.secondary === true && !winTm.mantleApp,
      'Windows\' own stays as "Windows Task Manager", the shortcut itself (' + JSON.stringify(winTm) + ')');
    const tmHits = search('task manager', items);
    const iM = tmHits.findIndex(i => i.path === 'mantle:taskmgr'), iW = tmHits.findIndex(i => i.name === 'Windows Task Manager');
    ok(iM === 0 && iW > iM, "search('task manager'): Mantle's first, Windows' below it (" + tmHits.map(i => i.name).join(' | ') + ')');
    ok(search('taskmgr', items)[0].path === 'mantle:taskmgr', "search('taskmgr') is Mantle's task manager first");
  } else {
    console.log('  (no ' + TM_LNK + ' on this machine: the Task Manager shortcut checks are skipped)');
  }
  const setHits = search('settings', items);
  const iMS = setHits.findIndex(i => i.path === 'mantle:settings'), iWS = setHits.findIndex(i => i.name === 'Windows Settings');
  ok(iMS === 0 && iWS > iMS, "search('settings'): Mantle Settings first, Windows Settings below it (" + setHits.map(i => i.name).join(' | ') + ')');
  const wsRow = items.find(i => i.name === 'Windows Settings');
  ok(wsRow && wsRow.path === 'ms-settings:' && wsRow.secondary === true, 'a "Windows Settings" row opens Windows\' own Settings app (' + JSON.stringify(wsRow) + ')');
  const wsRun = await launch(wsRow || { kind: 'setting', path: 'ms-settings:' }, { dryRun: true });
  ok(wsRun.ok === true && /"ms-settings:"/.test(wsRun.reason) && !/Mantle/.test(wsRun.reason), 'Windows Settings dry run is Windows\' own, never Mantle\'s (' + JSON.stringify(wsRun) + ')');
  const sound = items.find(i => i.path === 'ms-settings:sound');
  const bareUri = LI.SETTINGS.map(r => r[1]).find(u => !LI.coverOf(u));
  const update = bareUri ? items.find(i => i.path === bareUri) : null;
  ok(sound && sound.subtitle === 'Mantle Settings' && isPng(sound.icon), 'a page Mantle Settings covers says so and carries its icon');
  ok(!bareUri || (update && update.subtitle === 'Windows Settings' && update.icon === null), 'a page only Windows has says "Windows Settings" and keeps the glyph (' + bareUri + ')');
  const tmIconRow = items.find(i => i.path === 'mantle:taskmgr:game');
  ok(tmIconRow && isPng(tmIconRow.icon) && tmIconRow.icon !== (msRow && msRow.icon), 'the task manager rows carry the task manager icon, not Settings\'');

  if (failures.length) for (const f of failures) console.log('  FAIL: ' + f);
  console.log('LAUNCHER INDEX TEST: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch(err => {
  console.log('  FAIL: the test itself threw — ' + (err && err.stack || err));
  console.log('LAUNCHER INDEX TEST: ' + passed + ' passed, ' + (failed + 1) + ' failed');
  process.exit(1);
});
