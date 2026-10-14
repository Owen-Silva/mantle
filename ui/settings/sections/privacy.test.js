require('C:/Users/user/dev-tools/tools/lowcpu.js');
/* privacy.test.js — Mantle Settings > Privacy & security (lane privacy, 2026-09-28).
 *
 * PART 1 (node, always): the main half (lib/features/_settings-sections/privacy.js) against
 * sidecar/SysPrivacy*.cs: every command it asks is a real privacy.* command, its administrator actions
 * are real [Elevated] ones, a test run sends EVERY write as a dryRun, and a live needsAdmin answer becomes
 * one env.elevate call (a declined prompt comes back as cancelled). Plus the page file's shape
 * (model.js checkSection) and its search rows.
 *
 * PART 2 (headless chromium over file://, never Electron, never a real setting): the REAL page file on
 * the settings lane's mock (mock-mantle.js), with settings.privacy.* played by FAKE() over MADE-UP
 * fixtures. Every page is opened and must draw every search row it declares; some are shot to
 * MANTLE_SHOOT_OUT (default scratchpad/lanes/privacy-shots). Line 1 is the CPU cap and browser lock.
 *
 *   node ui/settings/sections/privacy.test.js      (ONLY=priv-02 for some shots)
 * Prints "PRIVACY PAGE TEST: n passed, m failed". A game running = part 2 is skipped (and said).
 */
'use strict';
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PAGE = 'file:///' + path.resolve(__dirname, '..', 'index.html').replace(/\\/g, '/');
const OUT = process.env.MANTLE_SHOOT_OUT ||
  'C:/Users/user/AppData/Local/Temp/claude/C--Users-owens/fe6c395c-2ffc-4958-a961-d5833371924e/scratchpad/lanes/privacy-shots';
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
  const cs = ['SysPrivacy.cs', 'SysPrivacyGeneral.cs', 'SysPrivacySecurity.cs'].map((f) => fs.readFileSync(path.join(ROOT, 'sidecar', f), 'utf8')).join('\n');
  const cmds = new Set([...cs.matchAll(/t\.Add\("(privacy\.[A-Za-z]+)"/g)].map((m) => m[1]));
  const elevated = new Set([...cs.matchAll(/\[Elevated\("([^"]+)"/g)].map((m) => m[1]));
  const main = require(path.join(ROOT, 'lib', 'features', '_settings-sections', 'privacy.js'));
  check('main: id is privacy', main.id === 'privacy');
  check('main: every command it asks is a real SysPrivacy command', Object.values(main.SIDECAR).every((c) => cmds.has(c)), Object.values(main.SIDECAR).filter((c) => !cmds.has(c)).join(' '));
  check('main: every SysPrivacy command can be reached', [...cmds].every((c) => Object.values(main.SIDECAR).includes(c)), [...cmds].join(' '));
  check('main: every page command is exported', Object.keys(main.SIDECAR).every((k) => typeof main.commands[k] === 'function'));
  check('main: its administrator actions are real [Elevated] ones', main.ADMIN.every((a) => elevated.has(a)) && elevated.size === main.ADMIN.length, [...elevated].join(' '));
  check('sidecar: the admin words match the page', /DeviceDoes = "change a privacy permission for everyone who uses this PC"/.test(cs) && /DevDoes = "turn developer mode on or off for this PC"/.test(cs));

  const sent = [];
  const elev = [];
  const mk = (test) => ({ id: 'privacy', test, log() {}, push() {}, elevate: async (a, x) => { elev.push([a, x]); return { ok: false, kind: 'cancelled' }; },
    sidecar: { on: () => () => {}, send: async (c, a) => {
      sent.push([c, a]);
      if (a.dryRun) return { ok: true, result: { ok: true, dryRun: true, would: 'set "let apps use webcam" from Allow to Deny' } };
      if (c === 'privacy.capSet' && a.scope === 'device') return { ok: true, result: { ok: false, needsAdmin: true, elevate: { action: 'privacy.deviceAccess', args: { capability: a.capability, on: a.allow } }, reason: 'Windows will ask' } };
      if (c === 'privacy.set' && a.key === 'developerMode') return { ok: true, result: { ok: false, needsAdmin: true, elevate: { action: 'privacy.developerMode', args: { on: a.value } }, reason: 'Windows will ask' } };
      return { ok: true, result: { ok: true, now: false } };
    } } });
  const T = mk(true), L = mk(false);
  const W = [['capSet', { capability: 'webcam', scope: 'user', allow: false }], ['capSet', { capability: 'webcam', scope: 'device', allow: false }],
    ['capSet', { capability: 'webcam', scope: 'app', app: 'Made.Up_abcdefghijklm', allow: true }], ['set', { key: 'advertisingId', value: false }],
    ['set', { key: 'developerMode', value: true }], ['set', { key: 'feedback', value: 'never' }]];
  for (const [cmd, args] of W) {
    sent.length = 0; elev.length = 0;
    const r = await main.commands[cmd](args, T);
    check(`test run: ${cmd} ${args.scope || args.key} is a dry run`, r.ok && r.dryRun === true && sent.length === 1 && sent[0][1].dryRun === true && elev.length === 0 && /^Test run, nothing changed/.test(r.reason), JSON.stringify([r, sent]));
  }
  sent.length = 0; elev.length = 0;
  const u = await main.commands.capSet({ capability: 'webcam', scope: 'user', allow: false }, L);
  check('live: a user switch sends no dryRun and shows the read-back', u.ok && u.value === false && sent[0][1].dryRun === false && elev.length === 0, JSON.stringify([u, sent]));
  const d = await main.commands.capSet({ capability: 'webcam', scope: 'device', allow: false }, L);
  check('live: the switch for everyone becomes ONE administrator prompt for privacy.deviceAccess', elev.length === 1 && elev[0][0] === 'privacy.deviceAccess' && elev[0][1].capability === 'webcam' && elev[0][1].on === false, JSON.stringify(elev));
  check('live: a declined prompt comes back as cancelled', d.ok === false && d.cancelled === true, JSON.stringify(d));
  elev.length = 0;
  await main.commands.set({ key: 'developerMode', value: true }, L);
  check('live: developer mode becomes ONE prompt for privacy.developerMode', elev.length === 1 && elev[0][0] === 'privacy.developerMode' && elev[0][1].on === true, JSON.stringify(elev));
  const nb = await main.commands.capSet({ capability: 'webcam', scope: 'user', allow: 'yes' }, L);
  check('main: a bad allow is refused before the sidecar', nb.ok === false && /true or false/.test(nb.reason));

  // the page file
  const M = require(path.join(ROOT, 'ui', 'settings', 'model.js'));
  const src = fs.readFileSync(path.join(ROOT, 'ui', 'settings', 'sections', 'privacy.js'), 'utf8');
  vm.runInNewContext(src, { MantleSettings: { section(x) { DEF = x; } }, window: {}, document: { currentScript: { dataset: { section: 'privacy' } } }, console });
  check('page: checkSection is happy', DEF && M.checkSection(DEF, 'privacy') === null, DEF && M.checkSection(DEF, 'privacy'));
  check('page: order 100 in the Windows group, shield icon, replaces nothing', DEF && DEF.order === 100 && DEF.group === 'windows' && DEF.icon === 'shield' && DEF.replaces === undefined);
  const ids = DEF ? DEF.pages.map((p) => p.id) : [];
  check('page: 38 pages (11 of its own, 25 permissions, voice activation, automatic file downloads)', ids.length === 38, ids.join(' '));
  const rows = DEF ? DEF.pages.flatMap((p) => p.search || []) : [];
  check('page: every page has search rows, every row is privacy.*', DEF && DEF.pages.every((p) => (p.search || []).length) && rows.every((r) => /^privacy\./.test(r.row)));
  const uris = rows.filter((r) => r.uri).map((r) => r.uri);
  check('page: claims its ms-settings pages once each', uris.length >= 38 && new Set(uris).size === uris.length && ['ms-settings:privacy-webcam', 'ms-settings:windowsdefender', 'ms-settings:developers', 'ms-settings:search-permissions'].every((x) => uris.includes(x)), uris.length);
  check('page: never opens Windows Settings (no kit.openWindows)', !/openWindows/.test(src));
}

/* ================================================================ PART 2: the page on the mock */
function FAKE() {
  const q = new URLSearchParams(location.search);
  const TEST = q.get('test') === '1', SCN = q.get('priv') || 'normal';
  const later = (ms, v) => new Promise((res) => setTimeout(() => res(v), ms));
  const no = (reason) => ({ ok: false, reason });
  const now = Date.now();
  const APPS = [
    { app: 'Made.CameraApp_abcdefghijklm', kind: 'packaged', name: 'Camera', value: 'Allow', lastUsed: now - 3600e3, inUse: false },
    { app: 'Made.Meetings_abcdefghijklm', kind: 'packaged', name: 'Made-up Meetings', value: 'Allow', lastUsed: now - 60e3, inUse: true },
    { app: 'Made.PhotoBooth_abcdefghijklm', kind: 'packaged', name: 'Photo Booth', value: 'Deny', lastUsed: null, inUse: false },
    { app: 'Made.Scanner_abcdefghijklm', kind: 'packaged', name: 'Document Scanner', value: null, lastUsed: null, inUse: false },
  ];
  const DESK = [{ app: 'C:#Made#Up#chat.exe', kind: 'desktop', name: 'Made-up Chat', path: 'C:\\Made\\Up\\chat.exe', lastUsed: now - 86400e3, inUse: false },
    { app: 'C:#Made#Up#recorder.exe', kind: 'desktop', name: 'Recorder', path: 'C:\\Made\\Up\\recorder.exe', lastUsed: now - 5e3, inUse: true }];
  const DESKCAPS = ['location', 'webcam', 'microphone', 'graphicsCaptureProgrammatic', 'graphicsCaptureWithoutBorder'];
  function cap(a) {
    if (SCN === 'fail') return no('privacy.cap failed (the sidecar is not running)');
    const policy = SCN === 'policy' && a.capability === 'webcam' ? { value: 2, force: 'deny', words: 'a policy on this PC sets it (AppPrivacy LetAppsAccessCamera = 2, Force Deny)' } : null;
    const present = a.capability !== 'downloadsFolder';
    return { ok: true, capability: a.capability, present, hasDesktop: DESKCAPS.includes(a.capability), device: present ? 'Allow' : null, deviceWhy: present ? null : 'not set (the key does not exist)',
      user: present ? (SCN === 'useroff' ? 'Deny' : 'Allow') : null, userWhy: present ? null : 'not set (the key does not exist)', desktop: DESKCAPS.includes(a.capability) ? 'Allow' : null,
      policy, elevated: false, reason: present ? null : 'Windows on this PC keeps no permission store for this yet: no app has asked for it',
      apps: present ? APPS : [], desktopApps: DESKCAPS.includes(a.capability) ? DESK : [], hiddenApps: present ? 2 : 0, appsWhy: null };
  }
  const V = (on, extra) => Object.assign({ on, set: true, locked: null, why: null }, extra || {});
  function settings() {
    if (SCN === 'fail') return no('privacy.settings failed (the sidecar is not running)');
    return { ok: true, elevated: false, values: {
      advertisingId: V(true), languageList: V(true), appLaunchTracking: V(false), suggestedContent: V(true), settingsNotifications: V(true),
      onlineSpeech: V(false, { locked: SCN === 'policy' ? 'a policy on this PC keeps it off (AllowInputPersonalization = 0)' : null }), inkingDictionary: V(true), improveInking: V(false), tailored: V(true),
      cloudSearchMsa: V(true), cloudSearchWork: V(true), searchHistory: V(true), searchHighlights: V(false), voiceActivation: V(false), voiceLock: V(null, { set: false }), endTask: V(true),
      safeSearch: { value: 'moderate' }, feedback: { value: 'week', locked: null }, diagLevel: { value: 'optional', why: 'Windows keeps the diagnostic data level for the whole PC, and only its own Settings (through its telemetry service) or an administrator\'s policy sets it' },
      activity: { on: null, why: 'Windows keeps this switch inside its own Settings with no documented setting another program may change, so Mantle shows it read-only' },
      developerMode: { on: false, set: false, admin: true, does: 'turn developer mode on or off for this PC' } } };
  }
  function security() {
    if (SCN === 'fail') return no('privacy.security failed (the sidecar is not running)');
    return { ok: true, antivirus: [{ name: 'Microsoft Defender Antivirus', on: true, upToDate: true, defender: true }, { name: 'Made-up Antivirus', on: false, upToDate: false, defender: false }],
      defender: { ok: true, realTime: true, tamper: true, antivirus: true, signaturesUpdated: now - 7200e3 },
      firewall: { profiles: [{ profile: 'domain', on: true, policy: false }, { profile: 'private', on: true, policy: false }, { profile: 'public', on: false, policy: false }], products: [] },
      encryption: { kind: 'device', state: 1, words: 'on', on: true, prevented: false, reason: null }, findMyDevice: { on: true, locationOn: true, reason: null },
      indexer: { service: 'Stopped', startType: 'Manual', running: false, reason: 'the Windows Search service (WSearch) is Stopped (start type Manual), so there is no file index to ask. Start it in services.msc' } };
  }
  function write(name, a) {
    if (TEST) return later(30, { ok: true, dryRun: true, reason: 'Test run, nothing changed: Mantle would ' + (a.scope === 'device' || a.key === 'developerMode' ? 'ask for administrator permission, then ' : '') + 'set it' });
    if ((name === 'settings.privacy.capSet' && a.scope === 'device') || a.key === 'developerMode') return later(80, { ok: false, cancelled: true, reason: 'You said no to the administrator prompt; nothing changed.' });
    return later(40, { ok: true, value: name === 'settings.privacy.capSet' ? a.allow : a.value });
  }
  let real;
  Object.defineProperty(window, 'mantle', {
    configurable: true,
    get() { return real; },
    set(m) {
      real = { on: m.on.bind(m), call(name, args) {
        const copy = args && typeof args === 'object' ? JSON.parse(JSON.stringify(args)) : {};
        if (name === 'settings.sections') return Promise.resolve({ ok: true, reason: null, sections: [{ id: 'privacy', file: 'sections/privacy.js', down: null, main: null }] });
        const mine = name === 'settings.privacy.cap' ? later(40, cap(copy)) : name === 'settings.privacy.settings' ? later(30, settings()) : name === 'settings.privacy.security' ? later(60, security())
          : name === 'settings.privacy.capSet' || name === 'settings.privacy.set' ? write(name, copy) : null;
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
const sw = (row) => sel(row) + ' button[role="switch"]';
const PG = (page, more) => `?section=privacy&page=${page}${more || ''}`;

const SHOTS = [
  ['priv-01-overview', '?section=privacy', async (p) => {
    const t = await p.textContent('#page');
    check('01: the overview lists Windows Security, General and Camera', /Windows Security/.test(t) && /General/.test(t) && /Camera/.test(t) && /Text and image generation/.test(t), t.slice(0, 200));
  }],
  ['priv-02-camera', PG('camera'), async (p) => {
    check('02: the switch for everyone carries the shield and says so before the click', /Windows will ask for administrator permission to change a privacy permission for everyone who uses this PC/.test(await rowText(p, 'privacy.camera.device') || ''));
    check('02: four Store apps with their state', await p.locator('[data-row^="privacy.camera.apps."]').count() === 4);
    const a = await p.$$eval('[data-row^="privacy.camera.apps."]', (l) => l.map((x) => x.textContent));
    check('02: in use now, last accessed, not chosen', /In use now/.test(a[1]) && /Last accessed/.test(a[0]) && /Not chosen/.test(a[3]) && /Off/.test(a[2]), a.join(' | '));
    check('02: desktop apps listed without a switch, with the reason', await p.locator('[data-row^="privacy.camera.desktop-apps."]').count() === 2 &&
      await p.locator('[data-row^="privacy.camera.desktop-apps."] button').count() === 0 && /has no switch per desktop app/.test(await p.textContent('#page')));
    await p.click('[data-row^="privacy.camera.apps."] button');
    await p.waitForTimeout(300);
    const c = await calls(p, 'settings.privacy.capSet');
    check('02: an app button sends scope app with its family name', c.length === 1 && c[0].args.scope === 'app' && c[0].args.app === 'Made.CameraApp_abcdefghijklm' && c[0].args.allow === false, JSON.stringify(c));
  }],
  ['priv-03-declined', PG('camera'), async (p) => {
    await p.click(sw('privacy.camera.device'));
    await p.waitForTimeout(400);
    const t = await rowText(p, 'privacy.camera.device');
    check('03: a declined administrator prompt says so and springs back', /You said no to the administrator prompt; nothing changed/.test(t) && await p.$eval(sw('privacy.camera.device'), (b) => b.getAttribute('aria-checked')) === 'true', t);
    const c = await calls(p, 'settings.privacy.capSet');
    check('03: it asked for scope device', c.length === 1 && c[0].args.scope === 'device' && c[0].args.capability === 'webcam', JSON.stringify(c));
  }],
  ['priv-04-policy', PG('camera', '&priv=policy'), async (p) => {
    for (const r of ['privacy.camera.device', 'privacy.camera.user', 'privacy.camera.desktop']) {
      check(`04: ${r} is read-only WITH the policy`, /Read only here: a policy on this PC sets it \(AppPrivacy LetAppsAccessCamera = 2, Force Deny\)/.test(await rowText(p, r) || '') && await p.$eval(sw(r), (b) => b.disabled), await rowText(p, r));
    }
    check('04: a Force Deny policy shows every switch Off (what Windows does), not the stored On', await p.$$eval('[data-row^="privacy.camera."] button[role="switch"]', (l) => l.length === 3 && l.every((b) => b.getAttribute('aria-checked') === 'false')));
    check('04: no administrator line under a policy (no prompt can help)', !/Windows will ask for administrator permission/.test(await rowText(p, 'privacy.camera.device') || ''));
    const items = await p.$$eval('[data-row^="privacy.camera.apps."]', (l) => l.map((x) => x.textContent));
    check('04: apps read Off (policy)', items.length === 4 && items.every((t) => /Off \(policy\)/.test(t)), items.join(' | '));
    check('04: app buttons are disabled under the policy',await p.$$eval('[data-row^="privacy.camera.apps."] button', (l) => l.every((b) => b.disabled)));
  }],
  ['priv-05-testrun', PG('camera', '&test=1'), async (p) => {
    await p.click(sw('privacy.camera.user'));
    await p.waitForTimeout(300);
    const t = await rowText(p, 'privacy.camera.user');
    check('05: a test-run change is a dry run with its note, and springs back', /Test run, nothing changed/.test(t) && await p.$eval(sw('privacy.camera.user'), (b) => b.getAttribute('aria-checked')) === 'true', t);
  }],
  ['priv-06-general', PG('general'), async (p) => {
    check('06: advertising ID reads on', await p.$eval(sw('privacy.general.advertising-id'), (b) => b.getAttribute('aria-checked')) === 'true');
    await p.click(sw('privacy.general.app-launch'));
    await p.waitForTimeout(300);
    const c = await calls(p, 'settings.privacy.set');
    check('06: a switch sends its key', c.length === 1 && c[0].args.key === 'appLaunchTracking' && c[0].args.value === true, JSON.stringify(c));
  }],
  ['priv-07-diagnostics', PG('diagnostics'), async (p) => {
    check('07: the level is read-only WITH its reason', /Read only here: Windows keeps the diagnostic data level/.test(await rowText(p, 'privacy.diagnostics.level') || ''));
    check('07: feedback reads once a week', await p.$eval(sel('privacy.diagnostics.feedback') + ' select', (s) => s.value) === 'week');
  }],
  ['priv-08-security', PG('security'), async (p) => {
    check('08: two antivirus products', await p.locator('[data-row^="privacy.security.antivirus."]').count() === 2);
    check('08: a product off says it needs attention', /Needs attention/.test(await rowText(p, 'privacy.security.antivirus.a1') || ''));
    check('08: real-time protection on, read-only WITH the reason', /On/.test(await rowText(p, 'privacy.security.realtime') || '') && /only the Windows Security app changes this/.test(await rowText(p, 'privacy.security.realtime') || ''));
    check('08: the public firewall off says so', /The firewall is off for this network type/.test(await rowText(p, 'privacy.security.firewall.public') || ''));
  }],
  ['priv-09-developers', PG('developers'), async (p) => {
    check('09: developer mode carries the shield and its words', /Windows will ask for administrator permission to turn developer mode on or off for this PC/.test(await rowText(p, 'privacy.developers.mode') || ''));
    await p.click(sw('privacy.developers.mode'));
    await p.waitForTimeout(400);
    check('09: a declined prompt springs back', /You said no/.test(await rowText(p, 'privacy.developers.mode') || '') && await p.$eval(sw('privacy.developers.mode'), (b) => b.getAttribute('aria-checked')) === 'false');
  }],
  ['priv-10-failing', PG('camera', '&priv=fail'), async (p) => {
    check('10: the switches say why they could not be read', /This permission could not be read: (Mantle's connection to Windows is restarting|Windows took too long to answer|something went wrong inside Mantle|this needs a newer version of Mantle|Windows did not allow it)/.test(await rowText(p, 'privacy.camera.user') || ''));
    check('10: nothing threw while drawing', !/could not be drawn/.test(await p.textContent('#page')));
  }],
  ['priv-11-searching', PG('searching-windows'), async (p) => {
    const t = await rowText(p, 'privacy.searching.indexer');
    check('11: the indexer says it is stopped and why, read-only', /Stopped/.test(t) && /WSearch/.test(t) && /Read only here/.test(t), t);
  }],
  ['priv-12-downloads-folder', PG('downloads-folder'), async (p) => {
    check('12: a permission with no store says why on its switches', /no app has asked for it/.test(await rowText(p, 'privacy.downloads-folder.user') || '') && await p.$eval(sw('privacy.downloads-folder.user'), (b) => b.disabled));
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
    // every page draws every search row it declares, with no page error
    if (!ONLY && DEF) {
      const missing = [], errs = [];
      for (const pg of DEF.pages) {
        const { page, problems } = await open(ctx, PG(pg.id));
        const gone = await page.evaluate((rows) => rows.filter((r) => !document.querySelector(`[data-row="${r}"]`)), (pg.search || []).map((s) => s.row));
        missing.push(...gone);
        const txt = await page.textContent('#page');
        if (/could not be drawn|did not load/.test(txt)) errs.push(pg.id + ': not drawn');
        errs.push(...problems.map((x) => pg.id + ': ' + x));
        await page.close();
      }
      check('every page draws every search row it declares', !missing.length, missing.join(' '));
      check('every page opens without an error', !errs.length, errs.join(' | '));
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
  try { await browserTests(); } catch (e) { failures.push('part 2 threw: ' + (e && e.message ? e.message.split('\n')[0] : e)); }
  for (const f of failures) console.log('FAIL ' + f);
  console.log(`PRIVACY PAGE TEST: ${passed} passed, ${failures.length} failed`);
  process.exitCode = failures.length ? 1 : 0;
})();
