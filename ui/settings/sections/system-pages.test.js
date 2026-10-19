require('../../../tools/dev-env.js').lowcpu();
/* system-pages.test.js - the smaller System pages: About's "Rename this PC" and Power & battery
 * (lane settings-system, 2026-09-29). Power: on a PC with no battery the on-battery rows (which can never
 * apply) and a lid it does not have are hidden, the plugged-in rows lose "(plugged in)", timeouts are words.
 *
 * PART 1 (node): the main half's test-run answer for an administrator action carries the EXACT request
 * the broker would get ({ action, args }); sidecar/test-sysset.js proves each such shape passes the
 * broker's own validator (Elevate.cs CheckRename) on a real passive sidecar.
 * PART 2 (headless chromium over file://, never Electron, never a real rename): the REAL page file
 * sections/system.js on the settings mock, settings.system.* played by FAKE() over MADE-UP names:
 * a rename waiting for a restart is shown, the same name asks for nothing, an empty name says so, a
 * new name goes to settings.system.admin as system.renamePc {name}, a declined prompt springs back.
 *
 *   node ui/settings/sections/system-pages.test.js
 * Prints "SYSPAGES TEST: n passed, m failed". A game running = part 2 is skipped (and said).
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PAGE = 'file:///' + path.resolve(__dirname, '..', 'index.html').replace(/\\/g, '/');
const OUT = process.env.MANTLE_SHOOT_OUT || path.join(require('os').tmpdir(), 'mantle-sysabout-shots');

let passed = 0;
const failures = [];
const check = (name, ok, detail) => { if (ok) passed++; else failures.push(detail ? `${name} (${String(detail).slice(0, 300)})` : name); return ok; };
function gaming() {
  try {
    const n = execSync('powershell -NoProfile -Command "@(Get-Process javaw,Minecraft*,RobloxPlayerBeta,VALORANT* -ErrorAction SilentlyContinue).Count"', { encoding: 'utf8' });
    return parseInt(n.trim(), 10) || 0;
  } catch (_) { return -1; }
}

/* ================================================================ PART 1: node */
async function nodeTests() {
  const main = require(path.join(ROOT, 'lib', 'features', '_settings-sections', 'system.js'));
  const env = { test: true, log() {}, elevate: async () => { throw new Error('a test run must never reach the broker'); } };
  const r = await main.commands.admin({ action: 'system.renamePc', args: { name: 'NEW-PC' } }, env);
  check('main: a test-run rename is a dry run naming the exact request', r.ok && r.dryRun && r.would && r.would.action === 'system.renamePc' && JSON.stringify(r.would.args) === '{"name":"NEW-PC"}', JSON.stringify(r));
  check('main: ... in words', /rename this PC; nothing was changed/.test(r.reason || ''), r.reason);
  const bad = await main.commands.admin({ action: 'system.formatDisk', args: {} }, env);
  check('main: an action System does not offer is refused', bad.ok === false && /not one System offers/.test(bad.reason || ''));
  let asked = null;
  const live = { test: false, log() {}, elevate: async (a, args) => { asked = { a, args }; return { ok: false, kind: 'cancelled' }; } };
  const c = await main.commands.admin({ action: 'system.renamePc', args: { name: 'NEW-PC' } }, live);
  check('main: live, the request reaches the broker as system.renamePc {name}', asked && asked.a === 'system.renamePc' && asked.args.name === 'NEW-PC', JSON.stringify(asked));
  check('main: a declined prompt comes back as cancelled, in words', c.ok === false && c.cancelled === true && /You said no/.test(c.reason));
}

/* ================================================================ PART 2: the page on the mock */
function FAKE() {
  const q = new URLSearchParams(location.search);
  const TEST = q.get('test') === '1', NOBAT = q.get('nobat') === '1', PENDING = q.get('pending');
  const CH = [{ value: 0, label: 'Do nothing' }, { value: 1, label: 'Sleep' }, { value: 2, label: 'Hibernate' }, { value: 3, label: 'Shut down' }];
  const two = (ac, dc, extra) => Object.assign({ applies: true, why: null, ac: { value: ac, writable: true }, dc: { value: dc, writable: true } }, extra || {});
  const POWER = { ok: true, caps: { battery: !NOBAT }, hibernation: { on: false }, fastStartup: { on: true, available: true },
    settings: { saverAt: two(0, 30), saverBrightness: two(100, 70), screenOff: two(300, 180), sleep: two(1800, 900), hibernate: two(0, 2147483647),
      lid: two(1, 1, { applies: !NOBAT, why: NOBAT ? 'this PC has no lid' : null, choices: CH }), powerButton: two(1, 3, { choices: CH }),
      sleepButton: two(1, 1, { applies: false, why: 'this PC has no sleep button', choices: CH }) } };
  const BAT = NOBAT ? { ok: true, present: false } : { ok: true, present: true, percent: 80, charging: false, plugged: false };
  const later = (ms, v) => new Promise((res) => setTimeout(() => res(v), ms));
  const ABOUT = { ok: true, device: { name: 'MADEUP-PC', processor: 'Made-up CPU 8000', cores: 16,
    ramInstalledBytes: 17179869184, ramUsableBytes: 16500000000, storageBytes: 256060514304, manufacturer: 'Made Up', model: 'Box 1',
    deviceId: '00000000-0000-0000-0000-000000000000', productId: '00000-00000-00000-AAAAA', systemType: '64-bit operating system, x64-based processor', penTouch: 'No pen and no touch input' },
    windows: { edition: 'Windows 11 Home', version: '25H2', installed: '2026-01-01', build: '26200.1', experience: 'Windows Feature Experience Pack 1000' } };
  let real;
  Object.defineProperty(window, 'mantle', {
    configurable: true,
    get() { return real; },
    set(m) {
      real = { on: m.on.bind(m), call(name, args) {
        const copy = args && typeof args === 'object' ? JSON.parse(JSON.stringify(args)) : {};
        if (name === 'settings.sections') return Promise.resolve({ ok: true, reason: null, sections: [{ id: 'system', file: 'sections/system.js', down: null, main: null }] });
        let mine = null;
        if (name === 'settings.system.read') mine = copy.what === 'about' ? later(30, Object.assign(JSON.parse(JSON.stringify(ABOUT)), PENDING ? { device: Object.assign({}, ABOUT.device, { pendingName: PENDING }) } : {})) : copy.what === 'power' ? later(30, JSON.parse(JSON.stringify(POWER))) : later(10, { ok: false, reason: 'fake: not this page' });
        if (name === 'settings.system.write') mine = later(30, TEST ? { ok: true, dryRun: true, reason: `test run: nothing was changed (would write: PowerWriteACValueIndex ${copy.setting} = ${copy.value})` } : { ok: false, reason: 'fake: no real writes' });
        if (name === 'battery.get') mine = later(20, BAT);
        if (name === 'powermode.get') mine = later(20, { ok: true, mode: 'balanced', inForce: 'balanced', saver: false, available: true, settable: true });
        if (name === 'settings.system.admin') mine = TEST ? later(30, { ok: true, dryRun: true, would: copy, reason: 'test run: Windows would ask for administrator permission to rename this PC; nothing was changed' })
          : later(80, { ok: false, cancelled: true, reason: 'You said no to the administrator prompt; nothing changed.' });
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
const val = (p) => p.$eval(sel('system.about.name') + ' input', (i) => i.value);
async function type(p, text) {
  await p.fill(sel('system.about.name') + ' input', text);
  await p.press(sel('system.about.name') + ' input', 'Enter');
  await p.waitForTimeout(350);
}
const PG = '?section=system&page=aboutpc';
const shownRow = (p, row) => p.evaluate((s) => { const e = document.querySelector(s); return !!e && !!e.offsetParent; }, sel(row));
const label = (p, row) => p.evaluate((s) => { const e = document.querySelector(s + ' .row-t'); return e ? e.textContent : ''; }, sel(row));
const SRC = fs.readFileSync(path.join(ROOT, 'ui', 'settings', 'sections', 'system.js'), 'utf8');

const SHOTS = [
  ['about-01-name', PG, async (p) => {
    check('01: the device name is read', await val(p) === 'MADEUP-PC', await val(p));
    check('01: the row says, before any click, that Windows will ask for administrator permission', /Windows will ask for administrator permission to rename this PC/.test(await rowText(p, 'system.about.name') || ''), await rowText(p, 'system.about.name'));
    await type(p, 'madeup-pc');
    check('01: the same name (any case) asks for nothing', (await calls(p, 'settings.system.admin')).length === 0);
    await type(p, '   ');
    check('01: an empty name says what to do and springs back, no prompt', /Type a name for this PC/.test(await rowText(p, 'system.about.name') || '') && await val(p) === 'MADEUP-PC' && (await calls(p, 'settings.system.admin')).length === 0, await rowText(p, 'system.about.name'));
    await type(p, ' NEW-PC ');
    const a = await calls(p, 'settings.system.admin');
    check('01: a new name goes to the broker as system.renamePc {name}, trimmed', a.length === 1 && a[0].args.action === 'system.renamePc' && JSON.stringify(a[0].args.args) === '{"name":"NEW-PC"}', JSON.stringify(a));
    check('01: a declined prompt springs back and says so', /You said no to the administrator prompt; nothing changed/.test(await rowText(p, 'system.about.name') || '') && await val(p) === 'MADEUP-PC', `${await val(p)} | ${await rowText(p, 'system.about.name')}`);
  }],
  ['about-03-testrun', PG + '&test=1', async (p) => {
    await type(p, 'NEW-PC');
    check('03: a test-run rename is a dry run with its note, and springs back', /test run/i.test(await rowText(p, 'system.about.name') || '') && await val(p) === 'MADEUP-PC', await rowText(p, 'system.about.name'));
    check('03: the device specifications are filled', /Made-up CPU 8000 \(16 logical processors\)/.test(await rowText(p, 'system.about.processor') || '') && /16(\.0)? GB/.test(await rowText(p, 'system.about.ram') || ''));
  }],
  ['about-04-pending', PG + '&pending=Next-PC', async (p) => {
    check('04: a rename waiting for a restart shows the NEW name in the box', await val(p) === 'Next-PC', await val(p));
    check('04: ... and says in words that it applies after a restart, naming the name in use now', /takes effect after a restart\. Until then this PC is still called MADEUP-PC/.test(await rowText(p, 'system.about.name') || ''), await rowText(p, 'system.about.name'));
    await type(p, 'next-pc');
    check('04: the waiting name (any case) asks for nothing', (await calls(p, 'settings.system.admin')).length === 0 && await val(p) === 'Next-PC', await val(p));
    await type(p, 'MADEUP-PC');
    const a = await calls(p, 'settings.system.admin');
    check('04: typing the name in use now is a rename back, through the broker', a.length === 1 && JSON.stringify(a[0].args.args) === '{"name":"MADEUP-PC"}', JSON.stringify(a));
  }],
  ['power-01-desktop', '?section=system&page=power&nobat=1', async (p) => {
    const hid = ['system.power.screenOff.dc', 'system.power.sleep.dc', 'system.power.hibernate.dc', 'system.power.lid.dc', 'system.power.lid.ac', 'system.power.powerButton.dc', 'system.power.sleepButton.dc', 'system.power.sleepButton.ac', 'system.power.saverAt'];
    const gone = []; for (const r of hid) if (await shownRow(p, r)) gone.push(r);
    check('p01: no battery: the on-battery rows, the lid and the sleep button are not shown', gone.length === 0, gone.join(' '));
    check('p01: the plugged-in rows are shown without "(plugged in)"', /^Turn my screen off after/.test(await label(p, 'system.power.screenOff.ac')) && !/plugged in/.test(await rowText(p, 'system.power.screenOff.ac') || ''), await label(p, 'system.power.screenOff.ac'));
    check('p01: the power button stays (this PC has one)', await shownRow(p, 'system.power.powerButton.ac'));
    check('p01: timeouts are words, not seconds', await p.$eval(sel('system.power.screenOff.ac') + ' select', (e) => e.selectedOptions[0].textContent) === '5 minutes' && await p.$eval(sel('system.power.sleep.ac') + ' select', (e) => e.selectedOptions[0].textContent) === '30 minutes');
    check('p01: the search rows for timeouts land on rows every PC shows', /row: 'system\.power\.screenOff\.ac'/.test(SRC) && !/row: 'system\.power\.screenOff\.dc'/.test(SRC));
  }],
  ['power-02-laptop', '?section=system&page=power', async (p) => {
    check('p02: with a battery both halves show, each named', /\(on battery\)/.test(await label(p, 'system.power.screenOff.dc')) && /\(plugged in\)/.test(await label(p, 'system.power.screenOff.ac')) && await shownRow(p, 'system.power.lid.dc') && await shownRow(p, 'system.power.saverAt'));
    check('p02: a sleep button the PC does not have is still hidden', !(await shownRow(p, 'system.power.sleepButton.dc')));
    check('p02: the on-battery screen timeout reads 3 minutes', await p.$eval(sel('system.power.screenOff.dc') + ' select', (e) => e.selectedOptions[0].textContent) === '3 minutes');
  }],
  ['power-03-testrun', '?section=system&page=power&nobat=1&test=1', async (p) => {
    await p.selectOption(sel('system.power.screenOff.ac') + ' select', '600');
    await p.waitForTimeout(350);
    const w = (await calls(p, 'settings.system.write')).find((c) => c.args.what === 'powerSet');
    check('p03: a timeout change asks for exactly that setting, source and seconds', w && w.args.setting === 'screenOff' && w.args.source === 'ac' && w.args.value === 600, JSON.stringify(w));
    check('p03: in a test run it is a dry run with its note, and springs back', /test run/i.test(await rowText(p, 'system.power.screenOff.ac') || '') && await p.$eval(sel('system.power.screenOff.ac') + ' select', (e) => e.value) === '300');
  }],
];

async function browserTests() {
  const g = gaming();
  if (g !== 0) { console.log(g > 0 ? 'PART 2 SKIPPED: a game is running' : 'PART 2 SKIPPED: could not check for a running game'); failures.push('part 2 (the page on the mock) was not run'); return; }
  const { chromium } = require('../../../tools/dev-env.js').playwright();
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await require('../test-browser.js').launch(chromium);
  try {
    const ctx = await browser.newContext({ viewport: { width: 1040, height: 760 }, deviceScaleFactor: 1.25, colorScheme: 'light' });
    await ctx.addInitScript(FAKE);
    for (const [name, query, prep] of SHOTS) {
      const page = await ctx.newPage();
      const problems = [];
      page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
      page.on('console', (m) => { if (m.type() === 'error') problems.push('console error: ' + m.text()); });
      await page.goto(PAGE + query, { waitUntil: 'load' });
      try { await page.waitForSelector('html[data-ready="1"]', { timeout: 6000 }); } catch (_) { problems.push('never reached data-ready'); }
      await page.waitForTimeout(400);
      try { await prep(page); } catch (e) { problems.push('prep threw: ' + e.message.split('\n')[0]); }
      await page.screenshot({ path: path.join(OUT, name + '.png') });
      check(`${name}: no page errors`, problems.length === 0, problems.join(' | '));
      await page.close();
    }
  } finally { await browser.close(); }
  console.log(`shots in ${OUT}`);
}

(async () => {
  try { await nodeTests(); } catch (e) { failures.push('part 1 threw: ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' ') : e)); }
  try { await browserTests(); } catch (e) { failures.push('part 2 threw: ' + (e && e.message ? e.message.split('\n')[0] : e)); }
  for (const f of failures) console.log('FAIL ' + f);
  console.log(`SYSPAGES TEST: ${passed} passed, ${failures.length} failed`);
  process.exitCode = failures.length ? 1 : 0;
})();
