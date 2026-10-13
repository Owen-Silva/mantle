require('C:/Users/user/dev-tools/tools/lowcpu.js');
/* applist.test.js — Mantle Settings > Apps (lane appsacct, 2026-09-29).
 *
 * PART 1 (node, always): the main half (lib/features/_settings-sections/applist.js) against
 * sidecar/SysApps.cs + SysAppsMore.cs: every command it asks is a real apps.* command, a test run sends
 * EVERY write as a dryRun, Uninstall / Modify need confirm:true and pass ONLY the key (never command
 * text), plan is always a dryRun, bad arguments stop before the sidecar. Plus the page file's shape,
 * search rows, claimed pages, and that Startup uses the built-in settings.startup / startupSet.
 *
 * PART 2 (headless chromium over file://, never Electron, never a real setting): the REAL page file on
 * the settings lane's mock, settings.applist.* played by FAKE() over MADE-UP fixtures (Startup uses the
 * mock's own made-up startup list). Every page must draw every search row it declares; shots go to
 * MANTLE_SHOOT_OUT (default scratchpad/lanes/appsacct-shots).
 *
 *   node ui/settings/sections/applist.test.js      (ONLY=app-03 for some shots)
 * Prints "APPS PAGE TEST: n passed, m failed". A game running = part 2 is skipped (and said).
 */
'use strict';
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PAGE = 'file:///' + path.resolve(__dirname, '..', 'index.html').replace(/\\/g, '/');
const OUT = process.env.MANTLE_SHOOT_OUT ||
  'C:/Users/user/AppData/Local/Temp/claude/C--Users-owens/fe6c395c-2ffc-4958-a961-d5833371924e/scratchpad/lanes/appsacct-shots';
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;

let passed = 0;
const failures = [];
const check = (name, ok, detail) => { if (ok) passed++; else failures.push(detail ? `${name} (${String(detail).slice(0, 300)})` : name); return ok; };

function gaming() {
  try {
    const n = execSync('powershell -NoProfile -Command "@(Get-Process javaw,Minecraft*,RobloxPlayerBeta,VALORANT* -ErrorAction SilentlyContinue).Count"', { encoding: 'utf8' });
    return parseInt(n.trim(), 10) || 0;
  } catch (_) { return -1; }
}

let DEF = null;
/* ================================================================ PART 1: node */
async function nodeTests() {
  const cs = ['SysApps.cs', 'SysAppsMore.cs'].map((f) => fs.readFileSync(path.join(ROOT, 'sidecar', f), 'utf8')).join('\n');
  const cmds = new Set([...cs.matchAll(/t\.Add\("(apps\.[A-Za-z]+)"/g)].map((m) => m[1]));
  const main = require(path.join(ROOT, 'lib', 'features', '_settings-sections', 'applist.js'));
  check('main: id is applist', main.id === 'applist');
  check('main: every command it asks is a real SysApps command', Object.values(main.SIDECAR).every((c) => cmds.has(c)), Object.values(main.SIDECAR).filter((c) => !cmds.has(c)).join(' '));
  check('main: every SysApps command can be reached', [...cmds].every((c) => Object.values(main.SIDECAR).includes(c)), [...cmds].join(' '));
  check('main: every page command is exported', Object.keys(main.SIDECAR).every((k) => typeof main.commands[k] === 'function'));
  check('sidecar: never runs a shell or passes request text as a command', !/Process\.Start\([^)]*(cmd|powershell)|"(cmd|powershell)(\.exe)?"/i.test(cs) && !/GetString\(req, "(command|program|args|path|cmd)"/.test(cs));

  const sent = [], logs = [];
  const mk = (test) => ({ id: 'applist', test, log: (x) => logs.push(x), push() {}, elevate: async () => ({ ok: false, kind: 'error', reason: 'no' }),
    sidecar: { on: () => () => {}, send: async (c, a) => {
      sent.push([c, a]);
      if (a.dryRun) return { ok: true, result: { ok: true, dryRun: true, would: 'start Made-up App\'s own uninstaller: C:\\x\\unins000.exe' } };
      if (c === 'apps.uninstall' || c === 'apps.modify') return { ok: true, result: { ok: true, started: true, kind: 'win32', note: 'The app\'s own uninstaller is open' } };
      return { ok: true, result: { ok: true, now: true } };
    } } });
  const T = mk(true), L = mk(false);
  for (const [cmd, args] of [['uninstall', { key: 'wabc123', confirm: true }], ['uninstall', { key: 'sabc123' }], ['modify', { key: 'wabc123', confirm: true }],
    ['videoSet', { name: 'hdr', on: true }], ['advancedSet', { name: 'share', value: 2 }]]) {
    sent.length = 0;
    const r = await main.commands[cmd](args, T);
    check(`test run: ${cmd} ${JSON.stringify(args)} is a dry run`, r.ok && r.dryRun === true && sent.length === 1 && sent[0][1].dryRun === true && /^Test run, nothing changed/.test(r.reason), JSON.stringify([r, sent]));
  }
  sent.length = 0;
  const nc = await main.commands.uninstall({ key: 'wabc123' }, L);
  check('live: uninstall WITHOUT confirm is refused before the sidecar', nc.ok === false && /confirmation/.test(nc.reason) && sent.length === 0, JSON.stringify(nc));
  const nm = await main.commands.modify({ key: 'wabc123', confirm: 'yes' }, L);
  check('live: modify needs confirm === true exactly', nm.ok === false && sent.length === 0, JSON.stringify(nm));
  const u = await main.commands.uninstall({ key: 'wabc123', confirm: true, command: 'calc.exe', program: 'x', args: '/y', id: 'z' }, L);
  check('live: a confirmed uninstall sends ONLY {key, dryRun:false}', u.ok && u.started && sent.length === 1 && JSON.stringify(sent[0][1]) === '{"key":"wabc123","dryRun":false}', JSON.stringify(sent));
  check('live: the log line names no app', logs.length === 1 && !/Made-up|unins000|wabc/.test(logs[0]), JSON.stringify(logs));
  sent.length = 0;
  const p = await main.commands.plan({ key: 'sabc123', action: 'uninstall' }, L);
  const pm = await main.commands.plan({ key: 'wabc123', action: 'modify' }, L);
  check('plan is always a dryRun (a read), even live', p.ok && pm.ok && sent.length === 2 && sent.every(([, a]) => a.dryRun === true) && sent[0][0] === 'apps.uninstall' && sent[1][0] === 'apps.modify', JSON.stringify(sent));
  sent.length = 0;
  const bads = await Promise.all([main.commands.uninstall({ key: 'C:\\x.exe', confirm: true }, L), main.commands.uninstall({ key: 'x', confirm: true }, L), main.commands.plan({ key: 'wabc', action: 'run' }, L),
    main.commands.videoSet({ name: 'EnableHDRForPlayback', on: true }, L), main.commands.videoSet({ name: 'hdr', on: 1 }, L), main.commands.advancedSet({ name: 'source', value: 1 }, L), main.commands.advancedSet({ name: 'share', value: 3 }, L)]);
  check('main: bad arguments are refused before the sidecar', bads.every((r) => r.ok === false) && sent.length === 0, JSON.stringify(bads));
  sent.length = 0;
  await main.commands.installed({ sizes: true, id: 'x' }, L);
  await main.commands.installed({ sizes: 'yes' }, L);
  check('main: installed passes sizes:true only, never an id', JSON.stringify(sent.map((s) => s[1])) === '[{"sizes":true},{}]', JSON.stringify(sent));

  const M = require(path.join(ROOT, 'ui', 'settings', 'model.js'));
  const src = fs.readFileSync(path.join(ROOT, 'ui', 'settings', 'sections', 'applist.js'), 'utf8');
  vm.runInNewContext(src, { MantleSettings: { section(x) { DEF = x; } }, window: {}, document: { currentScript: { dataset: { section: 'applist' } } }, console });
  check('page: checkSection is happy', DEF && M.checkSection(DEF, 'applist') === null, DEF && M.checkSection(DEF, 'applist'));
  check('page: order 50 in the Windows group, replaces the built-in apps', DEF && DEF.order === 50 && DEF.group === 'windows' && JSON.stringify(DEF.replaces) === '["apps"]');
  const ids = DEF ? DEF.pages.map((x) => x.id) : [];
  check('page: seven pages, Startup drawn on the built-in\'s id', ids.join() === 'installed,advanced,defaults,features,websites,video,apps' && DEF.pages.every((x) => typeof x.render === 'function'), ids.join(' '));
  const rows = DEF ? DEF.pages.flatMap((x) => x.search || []) : [];
  check('page: every row is apps.*, none twice', rows.every((r) => /^apps\./.test(r.row)) && new Set(rows.map((r) => r.row)).size === rows.length);
  check('page: keeps the built-in row ids (apps.startup, apps.installed, apps.defaults, apps.taskmgr)', ['apps.startup', 'apps.installed', 'apps.defaults', 'apps.taskmgr'].every((r) => rows.some((x) => x.row === r)));
  const uris = rows.filter((r) => r.uri).map((r) => r.uri).sort();
  // (lane wire, 2026-09-29: Startup apps claims ms-settings:startupapps too, so the launcher lands on this page, not the retired built-in)
  check('page: claims the Apps pages once each', uris.join() === ['ms-settings:advanced-apps', 'ms-settings:appexecutionalias', 'ms-settings:appsfeatures', 'ms-settings:appsforwebsites', 'ms-settings:defaultapps', 'ms-settings:optionalfeatures', 'ms-settings:startupapps', 'ms-settings:videoplayback'].join(), uris.join());
  check('page: never opens Windows Settings', !/openWindows/.test(src));
  check('page: Startup uses the built-in commands unchanged', /kit\.call\('settings\.startup', \{\}\)/.test(src) && /kit\.call\('settings\.startupSet', \{ item: it\.item, on: v \}\)/.test(src));
  check('page: the final Uninstall click sends confirm:true, the first only a plan', /C\(kit, 'plan', \{ key, action: act \}\)/.test(src) && /C\(kit, S\.confirm\.action, \{ key, confirm: true \}\)/.test(src));
  const mod = M.sectionModel([DEF]);
  const res = M.resolve(mod, { row: 'apps.startup' });
  check('model: the old deep link apps.startup lands on Apps > Startup', res.section === 'applist' && res.page === 'apps', JSON.stringify(res));
}

/* ================================================================ PART 2: the page on the mock */
function FAKE() {
  const q = new URLSearchParams(location.search);
  const TEST = q.get('test') === '1', SCN = q.get('ap') || 'normal';
  const later = (ms, v) => new Promise((res) => setTimeout(() => res(v), ms));
  const no = (reason) => ({ ok: false, reason });
  const day = 864e5, now = Date.now();
  const A = (key, kind, name, publisher, version, sizeB, ago, drive, extra) => Object.assign({ key, kind, name, publisher, version, size: sizeB, installed: ago == null ? null : now - ago * day, drive, scope: kind === 'store' ? 'user' : 'machine',
    canUninstall: true, uninstallWhy: null, canModify: kind === 'win32', modifyWhy: kind === 'win32' ? null : 'Store apps have no Modify; Windows\' Repair and Reset are its own' }, extra || {});
  let removing = 0;
  function installed() {
    if (SCN === 'fail') return no('apps.installed failed (the sidecar is not running)');
    const items = [A('wa1', 'win32', 'Made-up Code Editor', 'Example Corp', '1.94.2', 412e6, 3, 'C:'), A('wa2', 'win32', 'Made-up Game Launcher', 'Games Inc', '5.1', 1.8e9, 40, 'D:'),
      A('wa3', 'win32', 'Made-up Driver Tool', 'Chip Co', '2.0', null, null, 'C:', { canUninstall: false, uninstallWhy: 'Its installer marked it as not removable on its own (NoRemove), so Windows\' own list offers no Uninstall for it either', canModify: false, modifyWhy: 'Its installer turned Modify off (NoModify)' }),
      A('sb1', 'store', 'Made-up Photos', 'Example Corp', '2025.1.0.0', SCN === 'sizing' ? null : 96e6, 10, 'C:'), A('sb2', 'store', 'Made-up Notes', 'Notes Ltd', '1.2.3.0', SCN === 'sizing' ? null : 24e6, 1, 'C:')];
    const removal = removing > 0 ? { key: 'sb2', name: 'Made-up Notes', running: true, finished: null, error: null } : null;
    if (removing > 0) removing--;
    return { ok: true, items, win32: 3, store: 2, drives: ['C:', 'D:'], sizing: SCN === 'sizing', sized: null, removal, problems: [], storeSizeNote: 'x' };
  }
  function plan(a) {
    if (a.key === 'sb2' || a.key === 'sb1') return { ok: true, dryRun: true, kind: 'store', would: 'remove the Store app Made-up Notes for your account only (Windows\' package manager: RemovePackageAsync Made.Notes_1.2.3.0_x64__abc)' };
    if (a.action === 'modify') return { ok: true, dryRun: true, would: 'start Made-up Code Editor\'s own setup to modify or repair it: C:\\Program Files\\Made Editor\\setup.exe /modify', program: 'x', args: '', wouldRefuse: null };
    return { ok: true, dryRun: true, kind: 'win32', would: 'start Made-up Code Editor\'s own uninstaller: C:\\Program Files\\Made Editor\\unins000.exe (it may ask Windows for administrator permission itself, and it shows its own steps)', program: 'x', args: '', wouldRefuse: null };
  }
  function run(name, a) {
    if (TEST) return later(30, { ok: true, dryRun: true, reason: 'Test run, nothing changed: Mantle would ' + plan(a).would });
    if (a.key === 'sb2') { removing = 2; return later(40, { ok: true, started: true, kind: 'store', note: 'Removing it: the list updates when Windows finishes' }); }
    return later(40, { ok: true, started: true, kind: 'win32', note: 'The app\'s own uninstaller is open: follow its steps. The list updates when it finishes.' });
  }
  const UCPD = 'Read only: Windows\' User Choice Protection Driver (UCPD.sys) runs on this PC and blocks every program except Windows\' own Settings from changing default apps. That is Microsoft\'s lock, not a Mantle limit.';
  const D = (name, app, type, chosen, link) => ({ name, kind: link ? 'link' : 'file', app, progId: 'Made.' + name, type, chosen });
  function defaults() {
    if (SCN === 'fail') return no('apps.defaults failed (the sidecar is not running)');
    return { ok: true, files: [D('.htm', 'Made-up Browser', 'HTML Document', true), D('.jpg', 'Made-up Photos', 'JPG File', false), D('.pdf', 'Made-up Browser', 'PDF Document', true), D('.xyz', null, null, false)],
      links: [D('http', 'Made-up Browser', null, true, true), D('mailto', 'Made-up Mail', null, false, true)], browser: 'Made-up Browser', mail: 'Made-up Mail', pdf: 'Made-up Browser',
      ucpd: { present: true, running: true, state: 'Running', readOnly: UCPD } };
  }
  const FW = 'Read only: adding or removing a feature needs an administrator and Windows Update (DISM downloads it), and Windows only lets its own Settings or DISM do that. Mantle lists what is installed.';
  function features() {
    if (SCN === 'fail') return no('apps.features failed (the sidecar is not running)');
    return { ok: true, readOnly: FW, capabilitiesWhy: null, featuresWhy: null,
      capabilities: [{ name: 'OpenSSH.Client', label: 'OpenSSH Client', installed: true, pending: false }, { name: 'Media.WindowsMediaPlayer', label: 'Windows Media Player Legacy', installed: true, pending: false },
        { name: 'Made.Up.Feature', label: 'Made up feature', installed: false, pending: true }, { name: 'Windows.SmbDirect', label: 'Windows SmbDirect', installed: false, pending: false }],
      features: [{ name: 'Microsoft-Hyper-V-All', label: 'Hyper-V', state: 'disabled' }, { name: 'VirtualMachinePlatform', label: 'Virtual Machine Platform', state: 'enabled' }, { name: 'NetFx4-AdvSrvs', label: '.NET Framework 4.8 Advanced Services', state: 'enabled' }] };
  }
  function websites() {
    if (SCN === 'fail') return no('apps.websites failed (the sidecar is not running)');
    return { ok: true, readOnly: 'Read only: Windows keeps this switch in each app\'s own link-handler record and changes it only through its own Settings; there is no documented setting another program may write.',
      items: [{ key: 'u1', name: 'Made-up Maps', hosts: [{ host: 'maps.example.com', validated: true }], validated: 1 }, { key: 'u2', name: 'Made-up Mail', hosts: [{ host: 'mail.example.com', validated: false }, { host: 'www.mail.example.com', validated: false }], validated: 0 }] };
  }
  const V = { hdr: { on: true, set: true }, enhance: { on: false, set: false }, quality: { on: false, set: false }, lowres: { on: true, set: true } };
  function video() { return SCN === 'fail' ? no('apps.video failed (the sidecar is not running)') : { ok: true, values: JSON.parse(JSON.stringify(V)), note: 'Windows reads these when a video starts, so a change applies to the next video you play' }; }
  function advanced() {
    if (SCN === 'fail') return no('apps.advanced failed (the sidecar is not running)');
    return { ok: true, source: { value: 'Anywhere', words: 'Anywhere', set: false, policy: false, readOnly: 'Read only here: Windows keeps it for the whole PC (HKLM Explorer AicEnabled), which needs an administrator; Mantle has no administrator action for it' },
      archive: { on: true, set: false, policy: false, readOnly: 'Read only here: Windows keeps it with the Store install service for this account under HKLM, which needs an administrator' },
      share: { value: 1, set: false, locked: SCN === 'policy' ? 'Read only: a policy on this PC turns the Connected Devices Platform off (System EnableCdp = 0)' : null },
      aliases: ['madeup.exe', 'python.exe', 'winget.exe'], aliasWhy: null, aliasReadOnly: 'Read only: turning an alias off removes Windows\' own app-execution link for it, which only Windows\' Settings manages' };
  }
  function write(name, a) {
    if (TEST) return later(30, { ok: true, dryRun: true, reason: 'Test run, nothing changed: Mantle would change it' });
    if (name === 'settings.applist.videoSet') { V[a.name].on = a.on; V[a.name].set = true; return later(40, { ok: true, value: a.on }); }
    return later(40, { ok: true, value: String(a.value) });
  }
  let real;
  Object.defineProperty(window, 'mantle', {
    configurable: true,
    get() { return real; },
    set(m) {
      real = { on: m.on.bind(m), call(name, args) {
        const copy = args && typeof args === 'object' ? JSON.parse(JSON.stringify(args)) : {};
        if (name === 'settings.sections') return Promise.resolve({ ok: true, reason: null, sections: [{ id: 'applist', file: 'sections/applist.js', down: null, main: null }] });
        const n = name.replace(/^settings\.applist\./, '');
        const mine = name === n ? null : n === 'installed' ? later(30, installed()) : n === 'plan' ? later(20, plan(copy)) : n === 'uninstall' || n === 'modify' ? run(name, copy)
          : n === 'defaults' ? later(30, defaults()) : n === 'features' ? later(40, features()) : n === 'websites' ? later(20, websites()) : n === 'video' ? later(20, video())
            : n === 'advanced' ? later(20, advanced()) : /^(videoSet|advancedSet)$/.test(n) ? write(name, copy) : null;
        if (!mine) return m.call(name, args);
        (window.__mockCalls = window.__mockCalls || []).push({ name, args: copy });
        return mine;
      } };
    },
  });
}

const sel = (row) => `[data-row="${row}"]`;
const rowText = (p, row) => p.evaluate((s) => { const e = document.querySelector(s); return e ? e.textContent : null; }, sel(row));
const calls = (p, name) => p.evaluate((n) => (window.__mockCalls || []).filter((c) => c.name === n), name);
const PG = (page, more) => `?section=applist&page=${page}${more || ''}`;
const btn = (p, row, text) => p.locator(sel(row) + ' button', { hasText: text }).first().click();

const SHOTS = [
  ['app-01-overview', '?section=applist', async (p) => {
    const t = await p.textContent('#page');
    check('01: the overview lists the seven pages', ['Installed apps', 'Advanced app settings', 'Default apps', 'Optional features', 'Apps for websites', 'Video playback', 'Startup'].every((x) => t.includes(x)), t.slice(0, 200));
  }],
  ['app-02-installed', PG('installed'), async (p) => {
    check('02: five apps, three desktop and two Store', /5 apps/.test(await rowText(p, 'apps.installed.count') || '') && /3 desktop and 2 Store apps/.test(await rowText(p, 'apps.installed.count') || ''));
    const names = () => p.$$eval('[data-row="apps.installed"] .k-item', (l) => l.map((x) => x.querySelector('.row-t').textContent));
    check('02: sorted by name', (await names()).join('|') === 'Made-up Code Editor|Made-up Driver Tool|Made-up Game Launcher|Made-up Notes|Made-up Photos', (await names()).join('|'));
    check('02: size, publisher, version, date on the row', /412 MB/.test(await rowText(p, 'apps.installed.wa1') || '') && /Example Corp · Version 1\.94\.2 · Installed .+ · C: drive/.test(await rowText(p, 'apps.installed.wa1') || ''));
    check('02: a not-removable app says why ON the row', /not removable on its own \(NoRemove\)/.test(await rowText(p, 'apps.installed.wa3') || ''));
    await p.selectOption(sel('apps.installed.sort') + ' select', 'size');
    await p.waitForTimeout(150);
    check('02: sort by size puts the 1.8 GB launcher first', (await names())[0] === 'Made-up Game Launcher');
    await p.selectOption(sel('apps.installed.drive') + ' select', 'D:');
    await p.waitForTimeout(150);
    check('02: the D: filter leaves one app', (await names()).length === 1 && /1 of 5 apps/.test(await rowText(p, 'apps.installed.count') || ''));
    await p.selectOption(sel('apps.installed.drive') + ' select', 'all');
    await p.fill(sel('apps.installed.search') + ' input', 'notes');
    await p.waitForTimeout(150);
    check('02: typing "notes" finds Made-up Notes only', (await names()).join('|') === 'Made-up Notes');
    await p.fill(sel('apps.installed.search') + ' input', '');
    await p.selectOption(sel('apps.installed.sort') + ' select', 'name');
    await p.waitForTimeout(150);
  }],
  ['app-03-confirm', PG('installed'), async (p) => {
    await btn(p, 'apps.installed.wa1', 'Uninstall');
    await p.waitForTimeout(250);
    check('03: the first click only plans (no uninstall call yet)', (await calls(p, 'settings.applist.plan')).length === 1 && (await calls(p, 'settings.applist.uninstall')).length === 0);
    check('03: the row asks, naming exactly what will run', /Uninstall Made-up Code Editor\? Mantle will start Made-up Code Editor's own uninstaller: C:\\Program Files\\Made Editor\\unins000\.exe/.test(await rowText(p, 'apps.installed.wa1') || ''), await rowText(p, 'apps.installed.wa1'));
  }],
  ['app-04-started', PG('installed'), async (p) => {
    await btn(p, 'apps.installed.wa1', 'Uninstall');
    await p.waitForTimeout(250);
    await btn(p, 'apps.installed.wa1', 'Uninstall');
    await p.waitForTimeout(300);
    const c = await calls(p, 'settings.applist.uninstall');
    check('04: the confirming click sends {key, confirm:true} only', c.length === 1 && JSON.stringify(c[0].args) === '{"key":"wa1","confirm":true}', JSON.stringify(c));
    check('04: the row says the uninstaller is open', /own uninstaller is open/.test(await rowText(p, 'apps.installed.wa1') || ''));
  }],
  ['app-05-keep', PG('installed'), async (p) => {
    await btn(p, 'apps.installed.sb1', 'Uninstall');
    await p.waitForTimeout(250);
    check('05: a Store app asks to remove it and its data from your account', /Remove Made-up Photos and its data from your account\?/.test(await rowText(p, 'apps.installed.sb1') || ''));
    await btn(p, 'apps.installed.sb1', 'Keep');
    await p.waitForTimeout(200);
    check('05: Keep goes back, nothing uninstalled', (await calls(p, 'settings.applist.uninstall')).length === 0 && !/Remove Made-up Photos/.test(await rowText(p, 'apps.installed.sb1') || ''));
  }],
  ['app-06-removing', PG('installed'), async (p) => {
    await btn(p, 'apps.installed.sb2', 'Uninstall'); await p.waitForTimeout(250);
    await btn(p, 'apps.installed.sb2', 'Uninstall'); await p.waitForTimeout(2200);
    check('06: a Store removal shows Removing… while Windows works', /Removing it…/.test(await rowText(p, 'apps.installed.sb2') || ''), await rowText(p, 'apps.installed.sb2'));
  }],
  ['app-07-testrun', PG('installed', '&test=1'), async (p) => {
    await btn(p, 'apps.installed.wa1', 'Modify'); await p.waitForTimeout(250);
    await btn(p, 'apps.installed.wa1', 'Modify'); await p.waitForTimeout(300);
    check('07: a test-run Modify is a dry run with its note', /Test run, nothing changed/.test(await rowText(p, 'apps.installed.wa1') || ''));
  }],
  ['app-08-defaults', PG('defaults'), async (p) => {
    check('08: read only with the UCPD reason ON the row', /Read only/.test(await rowText(p, 'apps.defaults') || '') && /User Choice Protection Driver \(UCPD\.sys\)/.test(await rowText(p, 'apps.defaults') || ''));
    check('08: browser and mail', /Made-up Browser/.test(await rowText(p, 'apps.defaults.browser') || '') && /Made-up Mail/.test(await rowText(p, 'apps.defaults.mail') || ''));
    check('08: a type with no app says so', /No default app/.test(await rowText(p, 'apps.defaults.files._xyz') || ''));
    await p.fill(sel('apps.defaults.search') + ' input', 'photos');
    await p.waitForTimeout(150);
    check('08: searching "photos" leaves .jpg', await p.locator('[data-row^="apps.defaults.files."]').count() === 1);
  }],
  ['app-09-features', PG('features'), async (p) => {
    check('09: two installed, read-only with the reason', /2 installed/.test(await rowText(p, 'apps.features') || '') && /needs an administrator and Windows Update/.test(await rowText(p, 'apps.features') || ''));
    check('09: installed + installing listed', await p.locator('[data-row^="apps.features.installed."]').count() === 3 && /Installing…/.test(await p.textContent(sel('apps.features.installed'))));
    check('09: 2 of 3 Windows features on', /2 of 3 on/.test(await rowText(p, 'apps.features.windows-count') || '') && await p.locator('[data-row^="apps.features.windows."]').count() === 2);
  }],
  ['app-10-websites', PG('websites'), async (p) => {
    check('10: two apps, read-only with the reason', /2 apps/.test(await rowText(p, 'apps.websites') || '') && /Read only: Windows keeps this switch/.test(await rowText(p, 'apps.websites') || ''));
    check('10: sites and verification', /1 of 1 verified/.test(await rowText(p, 'apps.websites.list.u1') || '') && /Not verified/.test(await rowText(p, 'apps.websites.list.u2') || ''));
  }],
  ['app-11-video', PG('video'), async (p) => {
    check('11: HDR on, enhance off with the default note', /On/.test(await rowText(p, 'apps.video.hdr') || '') && /Not set yet/.test(await rowText(p, 'apps.video.enhance') || ''));
    await p.click(sel('apps.video.enhance') + ' button.sw');
    await p.waitForTimeout(250);
    const c = await calls(p, 'settings.applist.videoSet');
    check('11: switching enhance asks videoSet {enhance, true}', c.length === 1 && c[0].args.name === 'enhance' && c[0].args.on === true, JSON.stringify(c));
    await p.click(sel('apps.video.battery') + ' button:has-text("video quality")').catch(() => p.selectOption(sel('apps.video.battery') + ' select', 'quality'));
    await p.waitForTimeout(250);
    const c2 = await calls(p, 'settings.applist.videoSet');
    check('11: battery "video quality" asks videoSet {quality, true}', c2.length === 2 && c2[1].args.name === 'quality' && c2[1].args.on === true, JSON.stringify(c2));
  }],
  ['app-12-advanced', PG('advanced'), async (p) => {
    check('12: where to get apps, read-only with the reason', /Anywhere/.test(await rowText(p, 'apps.advanced.source') || '') && /Read only here: Windows keeps it for the whole PC/.test(await rowText(p, 'apps.advanced.source') || ''));
    check('12: archive apps read-only with the reason', /On/.test(await rowText(p, 'apps.advanced.archive') || '') && /Read only here/.test(await rowText(p, 'apps.advanced.archive') || ''));
    check('12: three aliases with the read-only reason', await p.locator('[data-row^="apps.advanced.aliases."]').count() === 3 && /Read only: turning an alias off/.test(await p.textContent('#page')));
    await p.selectOption(sel('apps.advanced.share') + ' select', '2');
    await p.waitForTimeout(250);
    const c = await calls(p, 'settings.applist.advancedSet');
    check('12: Everyone nearby asks advancedSet {share, 2}', c.length === 1 && c[0].args.name === 'share' && c[0].args.value === 2, JSON.stringify(c));
  }],
  ['app-13-startup', PG('apps'), async (p) => {
    check('13: the built-in startup list, through settings.startup', (await calls(p, 'settings.startup')).length >= 1 && /4 of 5 on/.test(await rowText(p, 'apps.startup.count') || ''), await rowText(p, 'apps.startup.count'));
    const t = p.locator('[data-row^="apps.startup.k"] button.sw').first();
    await t.click();
    await p.waitForTimeout(300);
    const c = await calls(p, 'settings.startupSet');
    check('13: a switch asks settings.startupSet {item, on}', c.length === 1 && c[0].args.item === 'run-user:CloudDrive' && c[0].args.on === false, JSON.stringify(c));
    check('13: says entries are never deleted', /never deletes one/.test(await rowText(p, 'apps.startup.count') || ''));
  }],
  ['app-14-failing', PG('installed', '&ap=fail'), async (p) => {
    check('14: the count row says why it could not be read', /The installed apps could not be read: (Mantle's connection to Windows is restarting|Windows took too long to answer|something went wrong inside Mantle|this needs a newer version of Mantle|Windows did not allow it)/.test(await rowText(p, 'apps.installed.count') || ''));
    check('14: nothing threw while drawing', !/could not be drawn/.test(await p.textContent('#page')));
  }],
  ['app-15-policy', PG('advanced', '&ap=policy'), async (p) => {
    check('15: share across devices locked by the policy, WITH it', /Read only: a policy on this PC turns the Connected Devices Platform off/.test(await rowText(p, 'apps.advanced.share') || '') && await p.$eval(sel('apps.advanced.share') + ' select', (s) => s.disabled));
  }],
  ['app-16-sizing', PG('installed', '&ap=sizing'), async (p) => {
    check('16: while Store sizes are added up, it says so', /Adding up the Store apps' folders/.test(await rowText(p, 'apps.installed.count') || ''));
  }],
];

async function browserTests() {
  const g = gaming();
  if (g !== 0) { console.log(g > 0 ? 'PART 2 SKIPPED: a game is running' : 'PART 2 SKIPPED: could not check for a running game'); failures.push('part 2 (the page on the mock) was not run'); return; }
  const { chromium } = require('C:/Users/user/other-app/node_modules/playwright-core');
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await require('../test-browser.js').launch(chromium);
  const open = async (ctx, query) => {
    const page = await ctx.newPage();
    const problems = [];
    page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push('console ' + m.type() + ': ' + m.text()); });
    await page.goto(PAGE + query, { waitUntil: 'load' });
    try { await page.waitForSelector('html[data-ready="1"]', { timeout: 6000 }); } catch (_) { problems.push('never reached data-ready'); }
    await page.waitForTimeout(350);
    return { page, problems };
  };
  try {
    const ctx = await browser.newContext({ viewport: { width: 1040, height: 760 }, deviceScaleFactor: 1.25, colorScheme: 'light' });
    await ctx.addInitScript(FAKE);
    if (!ONLY && DEF) {
      const missing = [], errs = [];
      for (const pg of DEF.pages) {
        const { page, problems } = await open(ctx, PG(pg.id));
        const gone = await page.evaluate((rows) => rows.filter((r) => !document.querySelector(`[data-row="${r}"]`)), (pg.search || []).map((s) => s.row));
        missing.push(...gone);
        if (/could not be drawn|did not load/.test(await page.textContent('#page'))) errs.push(pg.id + ': not drawn');
        errs.push(...problems.map((x) => pg.id + ': ' + x));
        await page.close();
      }
      check('every page draws every search row it declares', !missing.length, missing.join(' '));
      check('every page opens without an error', !errs.length, errs.join(' | '));
      let o = await open(ctx, '?q=uninstall');
      check('search: "uninstall" finds Installed apps', /Installed apps/.test(await o.page.evaluate(() => document.body.textContent)));
      await o.page.close();
      o = await open(ctx, '?section=apps');
      check('deep link: the built-in section "apps" opens Apps > Startup', /Startup apps/.test(await o.page.textContent('#page')) && !!(await o.page.$('[data-row="apps.startup.count"]')));
      await o.page.close();
    }
    for (const [name, query, prep] of SHOTS) {
      if (ONLY && !ONLY.some((x) => name.startsWith(x))) continue;
      const { page, problems } = await open(ctx, query);
      try { await prep(page); } catch (e) { problems.push('prep threw: ' + e.message.split('\n')[0]); }
      await page.waitForTimeout(150);
      const probe = await page.evaluate(() => {
        const out = [];
        document.querySelectorAll('.row-t, .row-h, .btn, h1, .why span, select, .val').forEach((el) => {
          const r = el.getBoundingClientRect();
          if (!r.width || getComputedStyle(el).webkitLineClamp !== 'none') return;
          if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflow !== 'visible') out.push('clipped: ' + el.className + ' "' + el.textContent.slice(0, 40) + '"');
          if (r.right > window.innerWidth + 1) out.push('off-screen right: ' + el.className + ' "' + el.textContent.slice(0, 40) + '"');
        });
        const pg = document.getElementById('page');
        return { out, rows: pg ? pg.querySelectorAll('.row').length : 0, text: pg ? pg.textContent : '' };
      });
      await page.screenshot({ path: path.join(OUT, name + '.png') });
      check(`${name}: drawn, not DOWN`, probe.rows >= 1 && !/could not be drawn|did not load/.test(probe.text), probe.text.slice(0, 200));
      check(`${name}: no page errors, nothing clipped`, problems.length + probe.out.length === 0, problems.concat(probe.out).join(' | '));
      console.log(`${name}: ${probe.rows} rows`);
      await page.close();
    }
  } finally { await browser.close(); }
  console.log(`shots in ${OUT}`);
}

(async () => {
  try { await nodeTests(); } catch (e) { failures.push('part 1 threw: ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' ') : e)); }
  try { await browserTests(); } catch (e) { failures.push('part 2 threw: ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' ') : e)); }
  for (const f of failures) console.log('FAIL ' + f);
  console.log(`APPS PAGE TEST: ${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();
