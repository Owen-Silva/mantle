require('../../../tools/dev-env.js').lowcpu();
/* accounts.test.js — Mantle Settings > Accounts (lane appsacct, 2026-09-29).
 *
 * PART 1 (node, always): the main half (lib/features/_settings-sections/accounts.js) against
 * sidecar/SysAccounts.cs: every command it asks is real, the ONLY write (signinSet: two HKCU switches)
 * is a dryRun in a test run and passes only {name, on}, nothing changes an account, password, PIN or
 * user. Plus the page file's shape, search rows and claimed pages.
 *
 * PART 2 (headless chromium over file://, never Electron, never a real setting): the REAL page file on
 * the settings lane's mock, settings.accounts.* played by FAKE() over MADE-UP fixtures. Every page must
 * draw every search row it declares; shots go to MANTLE_SHOOT_OUT (default %TEMP%/mantle-shots/appsacct).
 *
 *   node ui/settings/sections/accounts.test.js      (ONLY=acc-03 for some shots)
 * Prints "ACCOUNTS PAGE TEST: n passed, m failed". A game running = part 2 is skipped (and said).
 */
'use strict';
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PAGE = 'file:///' + path.resolve(__dirname, '..', 'index.html').replace(/\\/g, '/');
const OUT = process.env.MANTLE_SHOOT_OUT ||
  path.join(require('os').tmpdir(), 'mantle-shots', 'appsacct');
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
  const cs = fs.readFileSync(path.join(ROOT, 'sidecar', 'SysAccounts.cs'), 'utf8');
  const cmds = new Set([...cs.matchAll(/t\.Add\("(accounts\.[A-Za-z]+)"/g)].map((m) => m[1]));
  const main = require(path.join(ROOT, 'lib', 'features', '_settings-sections', 'accounts.js'));
  check('main: id is accounts', main.id === 'accounts');
  check('main: every command it asks is a real SysAccounts command', Object.values(main.SIDECAR).every((c) => cmds.has(c)), Object.values(main.SIDECAR).filter((c) => !cmds.has(c)).join(' '));
  check('main: every SysAccounts command can be reached', [...cmds].every((c) => Object.values(main.SIDECAR).includes(c)), [...cmds].join(' '));
  check('main: every page command is exported', Object.keys(main.SIDECAR).every((k) => typeof main.commands[k] === 'function'));
  check('sidecar: no command changes an account, password, PIN or user', !/NetUserAdd|NetUserDel|NetUserSetInfo|NetUserChangePassword|NetLocalGroupAddMembers|NetLocalGroupDelMembers/.test(cs) && [...cmds].filter((c) => /Set$/.test(c)).join() === 'accounts.signinSet');
  const sent = [];
  const mk = (test) => ({ id: 'accounts', test, log() {}, push() {}, elevate: async () => ({ ok: false }),
    sidecar: { on: () => () => {}, send: async (c, a) => { sent.push([c, a]); return a.dryRun ? { ok: true, result: { ok: true, dryRun: true, would: 'turn "Dynamic lock" on (HKCU Winlogon EnableGoodbye = 1)' } } : { ok: true, result: { ok: true, now: a.on } }; } } });
  const r = await main.commands.signinSet({ name: 'dynamicLock', on: true }, mk(true));
  check('test run: signinSet is a dry run', r.ok && r.dryRun && sent.length === 1 && sent[0][1].dryRun === true && /^Test run, nothing changed/.test(r.reason), JSON.stringify([r, sent]));
  sent.length = 0;
  const l = await main.commands.signinSet({ name: 'restartApps', on: false, id: 'x', extra: 1 }, mk(false));
  check('live: signinSet sends {name, on, dryRun:false} only and reads back', l.ok && l.value === false && JSON.stringify(sent[0][1]) === '{"name":"restartApps","on":false,"dryRun":false}', JSON.stringify(sent));
  sent.length = 0;
  const bads = await Promise.all([main.commands.signinSet({ name: 'EnableGoodbye', on: true }, mk(false)), main.commands.signinSet({ name: 'dynamicLock', on: 1 }, mk(false))]);
  check('main: bad arguments are refused before the sidecar', bads.every((x) => x.ok === false) && sent.length === 0, JSON.stringify(bads));

  const M = require(path.join(ROOT, 'ui', 'settings', 'model.js'));
  const src = fs.readFileSync(path.join(ROOT, 'ui', 'settings', 'sections', 'accounts.js'), 'utf8');
  vm.runInNewContext(src, { MantleSettings: { section(x) { DEF = x; } }, window: {}, document: { currentScript: { dataset: { section: 'accounts' } } }, console });
  check('page: checkSection is happy', DEF && M.checkSection(DEF, 'accounts') === null, DEF && M.checkSection(DEF, 'accounts'));
  check('page: order 60 in the Windows group, replaces nothing', DEF && DEF.order === 60 && DEF.group === 'windows' && DEF.replaces === undefined);
  const ids = DEF ? DEF.pages.map((x) => x.id) : [];
  check('page: seven pages', ids.join() === 'info,signin,email,family,backup,users,work', ids.join(' '));
  const rows = DEF ? DEF.pages.flatMap((x) => x.search || []) : [];
  check('page: every row is accounts.*, none twice', rows.every((x) => /^accounts\./.test(x.row)) && new Set(rows.map((x) => x.row)).size === rows.length);
  const uris = rows.filter((x) => x.uri).map((x) => x.uri).sort();
  check('page: claims the Accounts pages once each', uris.join() === ['ms-settings:backup', 'ms-settings:emailandaccounts', 'ms-settings:family-group', 'ms-settings:otherusers', 'ms-settings:signinoptions', 'ms-settings:signinoptions-dynamiclock', 'ms-settings:workplace', 'ms-settings:yourinfo'].join(), uris.join());
  check('page: never opens Windows Settings', !/openWindows/.test(src));
}

/* ================================================================ PART 2: the page on the mock */
function FAKE() {
  const q = new URLSearchParams(location.search);
  const TEST = q.get('test') === '1', FAIL = q.get('ac') === 'fail';
  const later = (ms, v) => new Promise((res) => setTimeout(() => res(v), ms));
  const no = (reason) => ({ ok: false, reason });
  const PIC = 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" fill="#8aa"/></svg>');
  const RO = 'Read only: Mantle never changes your account, name, picture, password or type. Changing them goes through Windows\' own sign-in checks.';
  const SW = { dynamicLock: { on: false, set: false, label: 'Dynamic lock' }, restartApps: { on: true, set: true, label: 'x' } };
  const R = {
    info: () => ({ ok: true, name: 'Made-up Person', user: 'made', email: 'made.up@example.com', kind: 'microsoft', domain: null, admin: true, elevated: false, picture: PIC, pictureWhy: null, passwordSet: null, why: null, readOnly: RO }),
    signin: () => ({ ok: true, hello: { sensors: 0, policyOff: false, readOnly: 'Read only: a PIN, face or fingerprint is set up and removed only through Windows Hello\'s own secure flow, which checks it is you first. Windows keeps them under the system account, so no other program can even read which ones you have.' },
      switches: JSON.parse(JSON.stringify(SW)), signinInfo: { on: true, policy: false, readOnly: 'Read only: Windows keeps it for your account in the machine-wide Winlogon key (HKLM), which needs an administrator' },
      password: 'Read only: Mantle never changes your password or PIN. Change them from the Ctrl+Alt+Delete screen, which Windows protects.' }),
    users: () => ({ ok: true, items: [{ name: 'made', fullName: 'Made-up Person', admin: true, enabled: true, you: true }, { name: 'guestish', fullName: null, admin: false, enabled: false, you: false }],
      readOnly: 'Read only: adding, removing or changing an account needs an administrator, and Mantle never changes accounts.' }),
    linked: () => ({ ok: true, microsoftAccounts: ['made.up@example.com'], work: [],
      backup: { oneDrive: true, signedIn: false, account: null, folders: ['Desktop', 'Documents', 'Pictures', 'Music', 'Videos'].map((n, i) => ({ name: n, backedUp: i < 2 })), readOnly: 'Read only: OneDrive\'s folder backup is switched in OneDrive itself, and Windows\' app and preference backup is kept by your Microsoft account online' },
      emailReadOnly: 'Read only: adding or removing an account goes through Microsoft\'s sign-in (Web Account Manager), which only Windows\' own Settings opens',
      workReadOnly: 'Read only: connecting or disconnecting goes through your organization\'s sign-in, which only Windows\' own Settings opens, and Mantle never changes accounts',
      familyReadOnly: 'Read only: Microsoft Family Safety lives in your Microsoft account online; Windows\' own Settings only links to it' }),
  };
  let real;
  Object.defineProperty(window, 'mantle', {
    configurable: true,
    get() { return real; },
    set(m) {
      real = { on: m.on.bind(m), call(name, args) {
        const copy = args && typeof args === 'object' ? JSON.parse(JSON.stringify(args)) : {};
        if (name === 'settings.sections') return Promise.resolve({ ok: true, reason: null, sections: [{ id: 'accounts', file: 'sections/accounts.js', down: null, main: null }] });
        const n = name.replace(/^settings\.accounts\./, '');
        let mine = null;
        if (n !== name && R[n]) mine = later(30, FAIL ? no('accounts.' + n + ' failed (the sidecar is not running)') : R[n]());
        else if (n === 'signinSet') mine = later(40, TEST ? { ok: true, dryRun: true, reason: 'Test run, nothing changed: Mantle would turn it ' + (copy.on ? 'on' : 'off') } : (SW[copy.name].on = copy.on, SW[copy.name].set = true, { ok: true, value: copy.on }));
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
const PG = (page, more) => `?section=accounts&page=${page}${more || ''}`;

const SHOTS = [
  ['acc-01-overview', '?section=accounts', async (p) => {
    const t = await p.textContent('#page');
    check('01: the overview lists the seven pages', ['Your info', 'Sign-in options', 'Email & accounts', 'Family', 'Windows backup', 'Other users', 'Access work or school'].every((x) => t.includes(x)), t.slice(0, 200));
  }],
  ['acc-02-info', PG('info'), async (p) => {
    check('02: name, Microsoft account with email, administrator', /Made-up Person/.test(await rowText(p, 'accounts.info.name') || '') && /Microsoft account/.test(await rowText(p, 'accounts.info.kind') || '') &&
      /made\.up@example\.com/.test(await rowText(p, 'accounts.info.kind') || '') && /Administrator/.test(await rowText(p, 'accounts.info.role') || ''));
    check('02: read-only with the reason on the row', /Mantle never changes your account/.test(await rowText(p, 'accounts.info.name') || ''));
    check('02: the picture is shown', await p.$eval('#page img', (i) => !i.hidden && i.naturalWidth > 0));
  }],
  ['acc-03-signin', PG('signin'), async (p) => {
    check('03: Hello read-only with the reason', /No face or fingerprint sensor/.test(await rowText(p, 'accounts.signin.hello') || '') && /Windows Hello's own secure flow/.test(await rowText(p, 'accounts.signin.hello') || ''));
    check('03: password read-only with the reason', /never changes your password or PIN/.test(await rowText(p, 'accounts.signin.password') || ''));
    check('03: sign-in info read-only with the reason', /HKLM/.test(await rowText(p, 'accounts.signin.finish-setup') || ''));
    await p.click(sel('accounts.signin.dynamic-lock') + ' button.sw');
    await p.waitForTimeout(250);
    const c = await calls(p, 'settings.accounts.signinSet');
    check('03: dynamic lock asks signinSet {dynamicLock, true}', c.length === 1 && c[0].args.name === 'dynamicLock' && c[0].args.on === true, JSON.stringify(c));
  }],
  ['acc-04-testrun', PG('signin', '&test=1'), async (p) => {
    await p.click(sel('accounts.signin.restart-apps') + ' button.sw');
    await p.waitForTimeout(250);
    check('04: a test-run switch is a dry run with its note', /Test run, nothing changed/.test(await rowText(p, 'accounts.signin.restart-apps') || ''));
  }],
  ['acc-05-users', PG('users'), async (p) => {
    check('05: one other account, read-only with the reason', /1 other account/.test(await rowText(p, 'accounts.users') || '') && /Mantle never changes accounts/.test(await rowText(p, 'accounts.users') || ''));
    check('05: you and a disabled standard user', /\(you\)/.test(await rowText(p, 'accounts.users.list.made') || '') && /Disabled/.test(await rowText(p, 'accounts.users.list.guestish') || ''));
  }],
  ['acc-06-backup', PG('backup'), async (p) => {
    check('06: OneDrive installed, 2 folders backed up, read-only with the reason', /Installed, not signed in/.test(await rowText(p, 'accounts.backup.onedrive') || '') &&
      await p.locator('[data-row^="accounts.backup.folders."]', { hasText: 'Not backed up' }).count() === 3 && /Read only: OneDrive/.test(await rowText(p, 'accounts.backup.onedrive') || ''));
  }],
  ['acc-07-work', PG('work'), async (p) => {
    check('07: not connected, read-only with the reason', /Not connected/.test(await rowText(p, 'accounts.work') || '') && /organization's sign-in/.test(await rowText(p, 'accounts.work') || ''));
  }],
  ['acc-08-email', PG('email'), async (p) => {
    check('08: one Microsoft account, read-only with the reason', /1 account/.test(await rowText(p, 'accounts.email') || '') && /Web Account Manager/.test(await rowText(p, 'accounts.email') || ''));
  }],
  ['acc-09-family', PG('family'), async (p) => {
    check('09: family read-only with the reason', /Family Safety lives in your Microsoft account online/.test(await rowText(p, 'accounts.family') || ''));
  }],
  ['acc-10-failing', PG('info', '&ac=fail'), async (p) => {
    check('10: the rows say why they could not be read', /Your account could not be read: (Mantle's connection to Windows is restarting|Windows took too long to answer|something went wrong inside Mantle|this needs a newer version of Mantle|Windows did not allow it)/.test(await rowText(p, 'accounts.info.name') || ''));
    check('10: nothing threw while drawing', !/could not be drawn/.test(await p.textContent('#page')));
  }],
];

async function browserTests() {
  const g = gaming();
  if (g !== 0) { console.log(g > 0 ? 'PART 2 SKIPPED: a game is running' : 'PART 2 SKIPPED: could not check for a running game'); failures.push('part 2 (the page on the mock) was not run'); return; }
  const { chromium } = require('../../../tools/dev-env.js').playwright();
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
      const o = await open(ctx, '?q=dynamic%20lock');
      check('search: "dynamic lock" finds Dynamic lock', /Dynamic lock/.test(await o.page.evaluate(() => document.body.textContent)));
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
  console.log(`ACCOUNTS PAGE TEST: ${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();
