require('C:/Users/user/dev-tools/tools/lowcpu.js');
/* update.test.js — Mantle Settings > Windows Update (lane gameupd, 2026-09-29).
 *
 * PART 1 (node, always): the main half (lib/features/_settings-sections/update.js) against
 * sidecar/SysUpdate.cs: every command it asks is a real update.* command, its administrator actions are
 * real [Elevated] ones, a test run sends EVERY write (check, pause, active hours) as a dryRun, a live
 * needsAdmin answer becomes ONE env.elevate call (a declined prompt comes back as cancelled), bad
 * arguments stop before the sidecar. Plus the page file's shape, search rows and claimed pages.
 *
 * PART 2 (headless chromium over file://, never Electron, never a real setting): the REAL page file on
 * the settings lane's mock, settings.update.* played by FAKE() over MADE-UP fixtures. Every page must
 * draw every search row it declares; shots go to MANTLE_SHOOT_OUT (default scratchpad/lanes/gameupd-shots).
 *
 *   node ui/settings/sections/update.test.js      (ONLY=upd-03 for some shots)
 * Prints "UPDATE PAGE TEST: n passed, m failed". A game running = part 2 is skipped (and said).
 */
'use strict';
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PAGE = 'file:///' + path.resolve(__dirname, '..', 'index.html').replace(/\\/g, '/');
const OUT = process.env.MANTLE_SHOOT_OUT ||
  'C:/Users/user/AppData/Local/Temp/claude/C--Users-owens/fe6c395c-2ffc-4958-a961-d5833371924e/scratchpad/lanes/gameupd-shots';
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
  const cs = fs.readFileSync(path.join(ROOT, 'sidecar', 'SysUpdate.cs'), 'utf8');
  const cmds = new Set([...cs.matchAll(/t\.Add\("(update\.[A-Za-z]+)"/g)].map((m) => m[1]));
  const elevated = new Set([...cs.matchAll(/\[Elevated\("([^"]+)"/g)].map((m) => m[1]));
  const main = require(path.join(ROOT, 'lib', 'features', '_settings-sections', 'update.js'));
  check('main: id is update', main.id === 'update');
  check('main: every command it asks is a real SysUpdate command', Object.values(main.SIDECAR).every((c) => cmds.has(c)), Object.values(main.SIDECAR).filter((c) => !cmds.has(c)).join(' '));
  check('main: every SysUpdate command can be reached', [...cmds].every((c) => Object.values(main.SIDECAR).includes(c)), [...cmds].join(' '));
  check('main: every page command is exported', Object.keys(main.SIDECAR).every((k) => typeof main.commands[k] === 'function'));
  check('main: its administrator actions are real [Elevated] ones', main.ADMIN.every((a) => elevated.has(a)) && elevated.size === main.ADMIN.length, [...elevated].join(' '));
  check('sidecar: the admin words match the page', /PauseDoes = "pause or resume Windows Update for this PC"/.test(cs) && /HoursDoes = "change the active hours Windows Update keeps for this PC"/.test(cs));
  check('sidecar: never installs, uninstalls, downloads or restarts', !/CreateUpdateDownloader|\.Install\(|Uninstall\(|ExitWindowsEx|InitiateSystemShutdown|shutdown\.exe|UsoClient/i.test(cs) &&
    !/\bM\([^;]*"(Begin)?(Install|Uninstall|Download|Commit|RunWizard)"/.test(cs));
  check('sidecar: the one installer object is only asked IsBusy (a read)', (cs.match(/CreateUpdateInstaller/g) || []).length === 1 && /P\(M\(Session\(\), "CreateUpdateInstaller"\), "IsBusy"\)/.test(cs));
  check('sidecar: an extension keeps the pause start (only the 3 end values are written)', /string\[\] ends = \{ "PauseUpdatesExpiryTime", "PauseFeatureUpdatesEndTime", "PauseQualityUpdatesEndTime" \}/.test(cs) && /from = start\.Value; until = start\.Value\.AddDays\(7 \* weeks\)/.test(cs));
  check('sidecar: the check code is kept apart from its words', /"code", _code/.test(cs) && !/err = "Windows Update did not answer/.test(cs));

  const sent = [], elev = [];
  const mk = (test) => ({ id: 'update', test, log() {}, push() {}, elevate: async (a, x) => { elev.push([a, x]); return { ok: false, kind: 'cancelled' }; },
    sidecar: { on: () => () => {}, send: async (c, a) => {
      sent.push([c, a]);
      if (a.dryRun) return { ok: true, result: { ok: true, dryRun: true, would: 'ask for administrator permission to pause or resume Windows Update for this PC, then pause updates for 1 week' } };
      if (c === 'update.pause') return { ok: true, result: { ok: false, needsAdmin: true, elevate: { action: 'update.pause', args: { weeks: a.weeks } }, reason: 'Windows will ask' } };
      if (c === 'update.activeHours') return { ok: true, result: { ok: false, needsAdmin: true, elevate: { action: 'update.activeHours', args: { start: a.start, end: a.end } }, reason: 'Windows will ask' } };
      if (c === 'update.smartHours') return { ok: true, result: { ok: false, needsAdmin: true, elevate: { action: 'update.smartHours', args: { on: a.on } }, reason: 'Windows will ask' } };
      if (c === 'update.status') return { ok: true, result: { ok: true, check: STATUS_CHECK } };
      return { ok: true, result: { ok: true, started: true, check: { running: true } } };
    } } });
  let STATUS_CHECK = null;
  const T = mk(true), L = mk(false);
  for (const [cmd, args] of [['check', {}], ['pause', { weeks: 2 }], ['pause', { weeks: 0 }], ['pause', { weeks: 3, extend: true }], ['activeHours', { start: 8, end: 17 }], ['smartHours', { on: true }], ['smartHours', { on: false }]]) {
    sent.length = 0; elev.length = 0;
    const r = await main.commands[cmd](args, T);
    check(`test run: ${cmd} ${JSON.stringify(args)} is a dry run`, r.ok && r.dryRun === true && sent.length === 1 && sent[0][1].dryRun === true && elev.length === 0 && /^Test run, nothing changed/.test(r.reason), JSON.stringify([r, sent]));
  }
  sent.length = 0; elev.length = 0;
  const c = await main.commands.check({}, L);
  check('live: check starts the online check (no dryRun, no prompt)', c.ok && c.started === true && sent[0][1].dryRun === false && elev.length === 0, JSON.stringify([c, sent]));
  const p = await main.commands.pause({ weeks: 3 }, L);
  check('live: pause becomes ONE administrator prompt for update.pause', elev.length === 1 && elev[0][0] === 'update.pause' && elev[0][1].weeks === 3, JSON.stringify(elev));
  check('live: a declined prompt comes back as cancelled', p.ok === false && p.cancelled === true, JSON.stringify(p));
  elev.length = 0;
  await main.commands.activeHours({ start: 9, end: 2 }, L);
  check('live: active hours becomes ONE prompt for update.activeHours', elev.length === 1 && elev[0][0] === 'update.activeHours' && elev[0][1].start === 9 && elev[0][1].end === 2, JSON.stringify(elev));
  elev.length = 0; sent.length = 0;
  await main.commands.smartHours({ on: true }, L);
  check('live: Automatically becomes ONE prompt for update.smartHours {on:true}', elev.length === 1 && elev[0][0] === 'update.smartHours' && elev[0][1].on === true, JSON.stringify(elev));
  sent.length = 0;
  await main.commands.pause({ weeks: 4, extend: true }, L);
  check('live: an extension reaches the sidecar as {weeks, extend:true}', sent.length === 1 && sent[0][1].weeks === 4 && sent[0][1].extend === true, JSON.stringify(sent));
  sent.length = 0;
  for (const bad of [{ on: 'yes' }, {}]) check('smartHours refuses ' + JSON.stringify(bad) + ' before the sidecar', (await main.commands.smartHours(bad, L)).ok === false && sent.length === 0);
  for (const bad of [{ weeks: 0, extend: true }, { weeks: 2, extend: 'yes' }]) check('pause refuses ' + JSON.stringify(bad) + ' before the sidecar', (await main.commands.pause(bad, L)).ok === false && sent.length === 0);
  // busy: a check the update agent refused is words + busy:true; the code never reaches the page
  for (const [code, busy] of [['0x80240009', true], ['0x8001010a', true], ['0x8024001E', true], ['0x8024402C', false], ['0x8024FFFF', false]]) {
    STATUS_CHECK = { running: false, finished: 1, error: 'Windows Update stopped the check without saying why', code };
    const s = await main.commands.status({}, L);
    const c = s.check || {};
    check(`status: check code ${code} -> busy=${busy}, words, no code`, c.busy === busy && !('code' in c) && !/0x[0-9a-f]{8}/i.test(JSON.stringify(s)) && typeof c.error === 'string' && c.error.length > 20, JSON.stringify(c));
  }
  STATUS_CHECK = { running: true, error: null, code: null };
  check('status: a running check is not busy', (await main.commands.status({}, L)).check.busy === false);
  check('BUSY: every busy line says to try again', Object.values(main.BUSY).every((w) => /Try again/.test(w)));
  // history: a code becomes words in main (the page shows `why`, never 0x...); an unknown code gets null
  const HI = { id: 'update', test: false, log() {}, push() {}, sidecar: { on: () => () => {}, send: async () => ({ ok: true, result: { total: 4, items: [
    { title: 'A', ok: false, result: 'Failed', code: '0x800F0922' }, { title: 'B', ok: false, result: 'Failed', code: '0x8024402c' },
    { title: 'C', ok: false, result: 'Failed', code: '0x81234567' }, { title: 'D', ok: true, result: 'Succeeded', code: null }] } }) } };
  const hx = await main.commands.history({}, HI);
  const hw = (hx.items || []).map((x) => x.why);
  check('main: history codes become words (known, lower-case too), unknown and succeeded = null, the code never in words',
    hx.ok && /system reserved partition/.test(hw[0]) && /could not reach the update service/.test(hw[1]) && hw[2] === null && hw[3] === null && !hw.some((w) => w && /0x/i.test(w)), JSON.stringify(hw));
  check('main: every mapped reason is a sentence without a code', Object.values(main.WHY).every((w) => /^[A-Z]/.test(w) && !/0x|HRESULT/i.test(w)), '');
  sent.length = 0;
  const bads = await Promise.all([main.commands.pause({ weeks: 6 }, L), main.commands.pause({ weeks: '1' }, L), main.commands.activeHours({ start: 8 }, L), main.commands.activeHours({ start: 8, end: 24 }, L)]);
  check('main: bad arguments are refused before the sidecar', bads.every((r) => r.ok === false) && sent.length === 0, JSON.stringify(bads));
  sent.length = 0;
  await main.commands.history({ count: 60, id: 'x' }, L);
  await main.commands.history({ count: 9999 }, L);
  check('main: history passes a sane count only, never an id', sent.length === 2 && JSON.stringify(sent[0][1]) === '{"count":60}' && JSON.stringify(sent[1][1]) === '{}', JSON.stringify(sent));

  const M = require(path.join(ROOT, 'ui', 'settings', 'model.js'));
  const src = fs.readFileSync(path.join(ROOT, 'ui', 'settings', 'sections', 'update.js'), 'utf8');
  vm.runInNewContext(src, { MantleSettings: { section(x) { DEF = x; } }, window: {}, document: { currentScript: { dataset: { section: 'update' } } }, console });
  check('page: checkSection is happy', DEF && M.checkSection(DEF, 'update') === null, DEF && M.checkSection(DEF, 'update'));
  check('page: order 110 in the Windows group, replaces nothing', DEF && DEF.order === 110 && DEF.group === 'windows' && DEF.replaces === undefined);
  const ids = DEF ? DEF.pages.map((x) => x.id) : [];
  check('page: four pages', ids.join() === 'windows-update,history,advanced,insider', ids.join(' '));
  const rows = DEF ? DEF.pages.flatMap((x) => x.search || []) : [];
  check('page: every row is update.*, none twice', rows.every((r) => /^update\./.test(r.row)) && new Set(rows.map((r) => r.row)).size === rows.length);
  const uris = rows.filter((r) => r.uri).map((r) => r.uri).sort();
  check('page: claims the five Windows Update pages once each', uris.join() === 'ms-settings:delivery-optimization,ms-settings:windowsinsider,ms-settings:windowsupdate,ms-settings:windowsupdate-history,ms-settings:windowsupdate-options', uris.join());
  check('page: never opens Windows Settings', !/openWindows/.test(src));
}

/* ================================================================ PART 2: the page on the mock */
function FAKE() {
  const q = new URLSearchParams(location.search);
  const TEST = q.get('test') === '1', SCN = q.get('wu') || 'normal';
  const later = (ms, v) => new Promise((res) => setTimeout(() => res(v), ms));
  const no = (reason) => ({ ok: false, reason });
  const now = Date.now();
  let checking = 0, ran = false;
  function status() {
    if (SCN === 'fail') return no('update.status failed (the sidecar is not running)');
    const running = checking > 0;
    if (checking > 0) checking--;
    return { ok: true, build: { name: 'Windows 11 Home', version: '25H2', build: '26200.9550' }, lastCheck: now - 3 * 3600e3, lastInstall: now - 2 * 86400e3, wuaWhy: null,
      rebootRequired: SCN === 'restart', noAutoUpdate: null,
      installing: SCN === 'installing',
      pause: SCN === 'paused' ? { paused: true, until: now + 10 * 86400e3, since: now - 4 * 86400e3, maxDays: 35, locked: null, admin: true, does: 'x' }
        : SCN === 'paused-max' ? { paused: true, until: now + 5 * 86400e3, since: now - 30 * 86400e3, maxDays: 35, locked: null, admin: true, does: 'x' }
        : { paused: false, until: null, since: null, maxDays: 35, locked: SCN === 'policy' ? 'a policy on this PC removes Pause updates (WindowsUpdate SetDisablePauseUXAccess = 1)' : null, admin: true, does: 'x' },
      hours: { start: 9, end: 2, set: true, auto: SCN === 'auto', locked: SCN === 'policy' ? 'a policy on this PC sets the active hours (WindowsUpdate SetActiveHours = 1)' : null, admin: true },
      flags: { latest: { on: true, set: true }, otherProducts: { on: false, set: false }, expedite: { on: true, set: true }, metered: { on: false, set: false }, restartNotify: { on: false, set: false },
        why: 'Mantle changes only pause and active hours so far (each through the administrator prompt)' },
      delivery: { mode: null, words: null, policy: false, why: 'Windows keeps it in the Delivery Optimization service\'s own profile (NETWORK SERVICE), which this account may not read (access denied (5))', readOnly: 'Windows keeps this in the Delivery Optimization service\'s own profile (NETWORK SERVICE), which only an administrator\'s tools change' },
      insider: { joined: false, channel: null, why: 'Joining or leaving the Windows Insider Program needs your Microsoft account and Microsoft\'s Insider service, which only Windows\' own Settings talks to' },
      check: running ? { running: true, started: now - 20e3, finished: null, found: null, optional: null, error: null } : SCN === 'busy' && !ran ? { running: false, started: now - 60e3, finished: now - 50e3, found: null, optional: null, busy: true,
          error: 'Windows Update is busy with another check or an install, so it did not check now. Try again in a few minutes' }   // as main hands it over (BUSY)
        : { running: false, started: null, finished: ran ? Date.now() : null, found: ran ? 4 : null, optional: null, error: null, busy: false } };
  }
  const U = (title, kb, kind, sizeB, down, optional) => ({ title, kb: kb ? [kb] : [], kind, size: sizeB, downloaded: down, optional, uid: 'uid-' + title.length + kb });
  function list() {
    if (SCN === 'fail') return no('update.list failed (the sidecar is not running)');
    return { ok: true, offline: true, pending: SCN === 'uptodate' ? [] : [U('Made-up Cumulative Update for Windows 11 (KB0000001)', 'KB0000001', 'security', 812e6, true, false),
      U('Made-up Security Intelligence Update (KB0000002)', 'KB0000002', 'definition', 45e6, false, false)],
    optional: [U('Made-up Audio Driver 1.2.3', null, 'driver', 12e6, false, true)] };
  }
  function history() {
    if (SCN === 'fail') return no('update.history failed (the sidecar is not running)');
    return { ok: true, total: 923, items: [
      { title: 'Made-up Security Intelligence Update (KB0000002)', date: now - 3600e3, op: 'install', result: 'Succeeded', ok: true, code: null },
      { title: 'Made-up Cumulative Update (KB0000003)', date: now - 86400e3, op: 'install', result: 'Failed', ok: false, code: '0x800F0922',
        why: 'Windows could not finish it (often too little space in the system reserved partition, or the network dropped)' },
      { title: 'KB0000004', date: now - 5 * 86400e3, op: 'install', result: 'Succeeded', ok: true, code: null, why: null }] };
  }
  function write(name, a) {
    if (TEST) return later(30, { ok: true, dryRun: true, reason: 'Test run, nothing changed: Mantle would ' + (name === 'settings.update.check' ? 'search Windows Update online' : 'ask for administrator permission, then change it') });
    if (name === 'settings.update.check') { checking = 2; ran = true; return later(30, { ok: true, started: true, note: 'Checking Windows Update: this can take a few minutes' }); }
    return later(80, { ok: false, cancelled: true, reason: 'You said no to the administrator prompt; nothing changed.' });
  }
  let real;
  Object.defineProperty(window, 'mantle', {
    configurable: true,
    get() { return real; },
    set(m) {
      real = { on: m.on.bind(m), call(name, args) {
        const copy = args && typeof args === 'object' ? JSON.parse(JSON.stringify(args)) : {};
        if (name === 'settings.sections') return Promise.resolve({ ok: true, reason: null, sections: [{ id: 'update', file: 'sections/update.js', down: null, main: null }] });
        const mine = name === 'settings.update.status' ? later(30, status()) : name === 'settings.update.list' ? later(60, list()) : name === 'settings.update.history' ? later(40, history())
          : /^settings\.update\.(check|pause|activeHours|smartHours)$/.test(name) ? write(name, copy) : null;
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
const PG = (page, more) => `?section=update&page=${page}${more || ''}`;

const SHOTS = [
  ['upd-01-overview', '?section=update', async (p) => {
    const t = await p.textContent('#page');
    check('01: the overview lists the four pages', ['Windows Update', 'Update history', 'Advanced options', 'Windows Insider Program'].every((x) => t.includes(x)), t.slice(0, 200));
  }],
  ['upd-02-main', PG('windows-update'), async (p) => {
    await p.waitForTimeout(250);
    check('02: two updates waiting', /2 updates waiting/.test(await rowText(p, 'update.main.status') || ''));
    check('02: the build and version', /Windows 11 Home 25H2/.test(await rowText(p, 'update.main.build') || '') && /26200\.9550/.test(await rowText(p, 'update.main.build') || ''));
    check('02: two pending updates with KB and size, and why Mantle does not install them', await p.locator('[data-row^="update.main.pending."]').count() === 2 &&
      /KB0000001 · 812 MB · Downloaded/.test(await p.textContent('[data-row^="update.main.pending."]')) && /never installs or removes an update/.test(await p.textContent('#page')));
    check('02: restart says Mantle never restarts, read-only', /Not needed/.test(await rowText(p, 'update.main.restart') || '') && /Mantle never restarts your PC/.test(await rowText(p, 'update.main.restart') || ''));
    check('02: pause carries the shield and says so before the click', /Windows will ask for administrator permission to pause or resume Windows Update for this PC/.test(await rowText(p, 'update.main.pause') || ''));
    await p.selectOption(sel('update.main.pause') + ' select', '2');
    await p.waitForTimeout(350);
    const c = await calls(p, 'settings.update.pause');
    check('02: choosing 2 weeks asks pause {weeks: 2}', c.length === 1 && c[0].args.weeks === 2, JSON.stringify(c));
    check('02: a declined prompt springs back', /You said no/.test(await rowText(p, 'update.main.pause') || '') && await p.$eval(sel('update.main.pause') + ' select', (s) => s.value) === '0');
  }],
  ['upd-03-checking', PG('windows-update'), async (p) => {
    await p.click(sel('update.main.check') + ' button');
    await p.waitForTimeout(400);
    check('03: Check for updates starts the check and says it is checking', (await calls(p, 'settings.update.check')).length === 1 && /Checking for updates…/.test(await rowText(p, 'update.main.status') || ''), await rowText(p, 'update.main.status'));
    await p.waitForTimeout(4500);
    check('03: when it finishes, it says what it found', /Checked just now: 4 found/.test(await rowText(p, 'update.main.status') || ''), await rowText(p, 'update.main.status'));
  }],
  ['upd-04-testrun', PG('windows-update', '&test=1'), async (p) => {
    await p.click(sel('update.main.check') + ' button');
    await p.waitForTimeout(300);
    check('04: a test-run check is a dry run with its note', /Test run, nothing changed/.test(await rowText(p, 'update.main.check') || ''));
  }],
  ['upd-05-paused', PG('windows-update', '&wu=paused'), async (p) => {
    check('05: paused shows until when, with Resume as a choice', /Paused until/.test(await rowText(p, 'update.main.pause') || '') && await p.$eval(sel('update.main.pause') + ' select', (s) => [...s.options].some((o) => o.textContent === 'Resume updates')));
    check('05: the status line says paused', /Updates are paused until/.test(await rowText(p, 'update.main.status') || ''));
    // paused 4 days ago until 10 days from now = 2 weeks from the start: only 3, 4 and 5 weeks FROM THE START extend it
    const opts = await p.$eval(sel('update.main.pause') + ' select', (s) => [...s.options].map((o) => [o.value, o.textContent]));
    const startDay = (w) => new Date(Date.now() - 4 * 864e5 + w * 7 * 864e5).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'long' });
    check('05: extensions count from the day the pause began, never from now', JSON.stringify(opts.map((o) => o[0])) === '["paused","0","x3","x4","x5"]' && opts[2][1] === 'Extend to ' + startDay(3) && !opts.some((o) => /Pause until|Pause for/.test(o[1])), JSON.stringify(opts));
    check('05: the row says the limit is counted from the start', /Windows allows 5 weeks in all, counted from that day/.test(await rowText(p, 'update.main.pause') || ''), await rowText(p, 'update.main.pause'));
    await p.selectOption(sel('update.main.pause') + ' select', 'x3');
    await p.waitForTimeout(400);
    const c = await calls(p, 'settings.update.pause');
    check('05: choosing one asks {weeks: 3, extend: true}', c.length === 1 && c[0].args.weeks === 3 && c[0].args.extend === true, JSON.stringify(c));
    check('05: a declined prompt springs back to the current pause and says so', /You said no to the administrator prompt/.test(await rowText(p, 'update.main.pause') || '') && await p.$eval(sel('update.main.pause') + ' select', (s) => s.value) === 'paused');
  }],
  ['upd-05b-paused-max', PG('windows-update', '&wu=paused-max'), async (p) => {
    const opts = await p.$eval(sel('update.main.pause') + ' select', (s) => [...s.options].map((o) => o.value));
    check('05b: at the 5-week limit there is nothing to extend, and it says why', JSON.stringify(opts) === '["paused","0"]' && /already as long as Windows allows/.test(await rowText(p, 'update.main.pause') || ''), JSON.stringify(opts) + ' ' + await rowText(p, 'update.main.pause'));
  }],
  ['upd-05c-extend-testrun', PG('windows-update', '&wu=paused&test=1'), async (p) => {
    await p.selectOption(sel('update.main.pause') + ' select', 'x4');
    await p.waitForTimeout(300);
    check('05c: a test-run extension is a dry run with its note, and springs back', /Test run, nothing changed/.test(await rowText(p, 'update.main.pause') || '') && await p.$eval(sel('update.main.pause') + ' select', (s) => s.value) === 'paused');
  }],
  ['upd-06-policy', PG('advanced', '&wu=policy'), async (p) => {
    check('06: active hours locked by the policy, WITH it', /Read only here: a policy on this PC sets the active hours/.test(await rowText(p, 'update.advanced.active-start') || '') && await p.$eval(sel('update.advanced.active-start') + ' select', (s) => s.disabled));
    check('06: Automatically / Manually is locked by the same policy, WITH it', /Read only here: a policy on this PC sets the active hours/.test(await rowText(p, 'update.advanced.active-auto') || '') && await p.$eval(sel('update.advanced.active-auto') + ' [data-v="auto"]', (b) => b.disabled));
  }],
  ['upd-07-advanced', PG('advanced'), async (p) => {
    await p.waitForTimeout(250);
    check('07: active hours read 09:00 – 02:00', /09:00 – 02:00/.test(await rowText(p, 'update.advanced.active-hours') || ''));
    check('07: the switches say Off/On; the read-only reason is said ONCE for the card, not on every row',
      !/Read only here/.test(await rowText(p, 'update.advanced.latest') || '') && /Off/.test(await rowText(p, 'update.advanced.metered') || '') &&
      (await p.textContent('#page')).split('Read only here: Mantle changes only pause and active hours so far').length === 2);
    check('07: one optional driver', await p.locator('[data-row^="update.advanced.optional."]').count() === 1);
    check('07: delivery optimization says why it could not be read', /NETWORK SERVICE/.test(await rowText(p, 'update.advanced.delivery') || ''));
    await p.selectOption(sel('update.advanced.active-end') + ' select', '5');
    await p.waitForTimeout(350);
    const c = await calls(p, 'settings.update.activeHours');
    check('07: changing the end asks {start: 9, end: 5}', c.length === 1 && c[0].args.start === 9 && c[0].args.end === 5, JSON.stringify(c));
    check('07: Adjust active hours reads Manually, with the administrator words', await p.$eval(sel('update.advanced.active-auto') + ' [data-v="manual"]', (b) => b.getAttribute('aria-checked')) === 'true' && /Windows will ask for administrator permission to change how Windows Update sets the active hours/.test(await rowText(p, 'update.advanced.active-auto') || ''));
    await p.click(sel('update.advanced.active-auto') + ' [data-v="auto"]');
    await p.waitForTimeout(400);
    const s = await calls(p, 'settings.update.smartHours');
    check('07: Automatically asks {on: true}', s.length === 1 && s[0].args.on === true, JSON.stringify(s));
    check('07: a declined prompt springs back to Manually and says so', /You said no to the administrator prompt/.test(await rowText(p, 'update.advanced.active-auto') || '') && await p.$eval(sel('update.advanced.active-auto') + ' [data-v="manual"]', (b) => b.getAttribute('aria-checked')) === 'true');
  }],
  ['upd-07b-auto', PG('advanced', '&wu=auto'), async (p) => {
    await p.waitForTimeout(250);
    check('07b: Automatically: the hours say Windows sets them, and what Windows last stored', /Set by Windows/.test(await rowText(p, 'update.advanced.active-hours') || '') && /Windows last stored 09:00 – 02:00/.test(await rowText(p, 'update.advanced.active-hours') || ''), await rowText(p, 'update.advanced.active-hours'));
    check('07b: ... the start and end are not editable then, and say why', await p.$eval(sel('update.advanced.active-start') + ' select', (s) => s.disabled) && /Windows sets this while Adjust active hours is Automatically/.test(await rowText(p, 'update.advanced.active-end') || ''));
    await p.click(sel('update.advanced.active-auto') + ' [data-v="manual"]');
    await p.waitForTimeout(400);
    const s = await calls(p, 'settings.update.smartHours');
    check('07b: Manually asks {on: false}', s.length === 1 && s[0].args.on === false, JSON.stringify(s));
  }],
  ['upd-07c-auto-testrun', PG('advanced', '&test=1'), async (p) => {
    await p.click(sel('update.advanced.active-auto') + ' [data-v="auto"]');
    await p.waitForTimeout(300);
    check('07c: a test-run Automatically is a dry run with its note, and springs back', /Test run, nothing changed/.test(await rowText(p, 'update.advanced.active-auto') || '') && await p.$eval(sel('update.advanced.active-auto') + ' [data-v="manual"]', (b) => b.getAttribute('aria-checked')) === 'true');
  }],
  ['upd-12-busy', PG('windows-update', '&wu=busy'), async (p) => {
    await p.waitForTimeout(250);
    const st = await rowText(p, 'update.main.status') || '';
    check('12: a refused check says Windows Update is busy, in words, with no code', /Windows Update is busy/.test(st) && /Try again in a few minutes/.test(st) && !/0x[0-9a-f]{4}/i.test(await p.textContent('#page')), st);
    check('12: the button offers Try again', /Try again/.test(await p.textContent(sel('update.main.check') + ' button')));
    await p.click(sel('update.main.check') + ' button');
    await p.waitForTimeout(400);
    check('12: Try again asks for the check again and says it is checking', (await calls(p, 'settings.update.check')).length === 1 && /Checking for updates…/.test(await rowText(p, 'update.main.status') || ''), await rowText(p, 'update.main.status'));
    await p.waitForTimeout(4500);
    check('12: when that check finishes the busy line is gone', /Checked just now: 4 found/.test(await rowText(p, 'update.main.status') || '') && !/busy/.test(await rowText(p, 'update.main.status') || ''), await rowText(p, 'update.main.status'));
  }],
  ['upd-13-installing', PG('windows-update', '&wu=installing'), async (p) => {
    await p.waitForTimeout(250);
    check('13: while Windows Update installs, the status says so (and that Mantle never installs)', /Installing updates…/.test(await rowText(p, 'update.main.status') || '') && /Mantle never installs or restarts/.test(await rowText(p, 'update.main.status') || ''), await rowText(p, 'update.main.status'));
  }],
  ['upd-08-history', PG('history'), async (p) => {
    check('08: 923 in the history', /923/.test(await rowText(p, 'update.history.count') || ''));
    const t = await p.$$eval('[data-row^="update.history.list."]', (l) => l.map((x) => x.textContent));
    check('08: three entries, the failed one says why in words, never its code', t.length === 3 && /Failed/.test(t[1]) && /Windows could not finish it/.test(t[1]) && !/Failed: /.test(t[1]) && !/0x/i.test(t.join(' ')), t.join(' | '));
    check('08: a title that is only a KB number reads as a Windows update', /Windows update KB0000004/.test(t[2]), t[2]);
  }],
  ['upd-09-insider', PG('insider'), async (p) => {
    check('09: not joined, read-only with the reason', /Not joined/.test(await rowText(p, 'update.insider.state') || '') && /Read only here: Joining or leaving/.test(await rowText(p, 'update.insider.state') || ''));
  }],
  ['upd-10-failing', PG('windows-update', '&wu=fail'), async (p) => {
    check('10: the rows say why they could not be read', /Windows Update could not be read: Mantle's connection to Windows is restarting/.test(await rowText(p, 'update.main.status') || '') &&
      /The updates could not be read: Mantle's connection to Windows is restarting/.test(await p.textContent('#page')) && !/update\.(status|list) failed|sidecar/.test(await p.textContent('#page')), (await p.textContent('#page')).slice(0, 300));
    check('10: nothing threw while drawing', !/could not be drawn/.test(await p.textContent('#page')));
  }],
  ['upd-11-restart', PG('windows-update', '&wu=restart'), async (p) => {
    check('11: restart required leads the status', /Restart required/.test(await rowText(p, 'update.main.status') || '') && /Needed to finish installing/.test(await rowText(p, 'update.main.restart') || ''));
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
      const { page } = await open(ctx, '?q=pause%20updates');
      check('search: "pause updates" finds Pause updates', /Pause updates/.test(await page.evaluate(() => document.body.textContent)));
      await page.close();
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
  console.log(`UPDATE PAGE TEST: ${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();
