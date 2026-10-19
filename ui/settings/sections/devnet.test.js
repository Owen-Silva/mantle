require('../../../tools/dev-env.js').lowcpu();
/* devnet.test.js — the Bluetooth & devices and Network & internet PAGES on the mock (lane devnet,
 * 2026-09-28). Headless chromium over file://, never Electron, never a real setting: the settings
 * lane's mock (mock-mantle.js) plays main, and _devnet-fake.js plays these sections' main half with
 * made-up data. Line 1 is the machine-wide CPU cap and browser lock.
 *
 *   node ui/settings/sections/devnet.test.js           checks + screenshots
 *   ONLY=dev-mouse,net node ...                        just those (prefix match)
 *   MANTLE_SHOOT_OUT=<dir>                             where the PNGs go
 * Prints "DEVNET UI TEST: n passed, m failed". A game running = nothing is run.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const { chromium } = require('../../../tools/dev-env.js').playwright();

const PAGE = 'file:///' + path.resolve(__dirname, '..', 'index.html').replace(/\\/g, '/');
const FAKE = path.join(__dirname, '_devnet-fake.js');
const OUT = process.env.MANTLE_SHOOT_OUT ||
  path.join(require('os').tmpdir(), 'mantle-shots', 'devnet');
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;
const SECS = process.env.DEVNET_SECS || 'devices,network';

let passed = 0;
const failures = [];
const check = (name, ok, detail) => { if (ok) passed++; else failures.push(detail ? `${name} (${detail})` : name); return ok; };

function gaming() {
  try {
    const n = execSync('powershell -NoProfile -Command "@(Get-Process javaw,Minecraft*,RobloxPlayerBeta,VALORANT* -ErrorAction SilentlyContinue).Count"', { encoding: 'utf8' });
    return parseInt(n.trim(), 10) || 0;
  } catch (_) { return -1; }
}

const calls = (p, name) => p.evaluate((n) => (window.__mockCalls || []).filter((c) => c.name === n), name);
const clickBtn = async (p, rowSel, text) => {
  const b = p.locator(`[data-row="${rowSel}"] button`, { hasText: text }).first();
  await b.click();
};

/* [name, query, prep(page) -> checks] */
const SHOTS = [
  ['dev-overview', '?section=devices', async (p) => {
    const t = await p.textContent('#page');
    check('overview lists the pages', ['Devices', 'Printers & scanners', 'Mouse', 'Touchpad', 'Keyboard', 'Cameras', 'AutoPlay', 'USB'].every((w) => t.includes(w)));
  }],
  ['dev-bluetooth', '?section=devices&page=bluetooth', async (p) => {
    await p.waitForTimeout(300);
    check('the radio row is drawn', await p.locator('[data-row="bluetooth.radio"]').count() === 1);
    check('paired devices are listed', await p.locator('[data-row^="bluetooth.devices."]').count() >= 3);
    check('a non-audio device explains why it cannot be connected', await p.locator('[data-row^="bluetooth.devices."] button[disabled][title*="audio"]').count() >= 1);
    await clickBtn(p, 'devices.bluetooth.add', 'Search');
    await p.waitForTimeout(700);
    check('search finds the fake devices', await p.locator('[data-row^="devices.bluetooth.found."]').count() === 2);
  }],
  ['dev-pair', '?section=devices&page=bluetooth', async (p) => {
    await clickBtn(p, 'devices.bluetooth.add', 'Search');
    await p.waitForTimeout(700);
    await p.locator('[data-row^="devices.bluetooth.found."] button', { hasText: 'Pair' }).first().click();
    await p.waitForTimeout(500);
    const pin = await p.textContent('[data-row="devices.bluetooth.pin"]').catch(() => '');
    await p.locator('[data-row="devices.bluetooth.pin"]').scrollIntoViewIfNeeded().catch(() => {});
    check('the PIN confirm shows the PIN in Mantle', /482913/.test(pin), pin);
    return async () => {   // after the shot: say yes
      await clickBtn(p, 'devices.bluetooth.pin.yes', 'Yes, pair');
      await p.waitForTimeout(500);
      const r = await calls(p, 'settings.devices.respond');
      check('Yes sends respond {accept:true}', r.length === 1 && r[0].args.accept === true, JSON.stringify(r));
      check('the ceremony closes after the answer', await p.locator('[data-row="devices.bluetooth.pin"]').count() === 0);
    };
  }],
  ['dev-remove-confirm', '?section=devices&page=bluetooth', async (p) => {
    await p.waitForTimeout(300);
    await p.locator('[data-row^="bluetooth.devices."] button', { hasText: 'Remove device' }).first().click();
    await p.waitForTimeout(150);
    check('remove asks first', await p.locator('[data-row^="bluetooth.devices."] button', { hasText: 'Keep' }).count() === 1);
    check('nothing was removed on the first click', (await calls(p, 'settings.devices.unpair')).length === 0);
  }],
  ['dev-printers', '?section=devices&page=printers', async (p) => {
    await p.waitForTimeout(300);
    check('printers are listed', await p.locator('[data-row^="devices.printers.list."]').count() === 3);
    await p.locator('[data-row^="devices.printers.list."] button', { hasText: 'Open queue' }).first().click();
    await p.waitForTimeout(300);
    check('the queue shows the jobs', await p.locator('[data-row^="devices.printers.queue."]').count() === 2);
  }],
  ['dev-mouse', '?section=devices&page=mouse', async (p) => {
    await p.waitForTimeout(300);
    check('mouse rows are drawn', await p.locator('[data-row^="devices.mouse."]').count() >= 10);
    check('no mouse row is disabled with a reason', await p.locator('[data-row^="devices.mouse."] .why:not(.info)').count() === 0);
  }],
  ['dev-touchpad', '?section=devices&page=touchpad', async (p) => {
    await p.waitForTimeout(300);
    check('touchpad rows are drawn', await p.locator('[data-row^="devices.touchpad."]').count() >= 10);
  }],
  ['dev-keyboard', '?section=devices&page=keyboard'],
  ['dev-pen', '?section=devices&page=pen', async (p) => {
    const t = await p.textContent('#page');
    check('no pen: says so with the reason', /no pen digitizer/i.test(t));
  }],
  ['dev-cameras', '?section=devices&page=cameras', async (p) => {
    await p.waitForTimeout(300);
    const t = await p.textContent('#page');
    check('the default camera row says why there is none', /no system-wide default camera/.test(t));
    await p.locator('[data-row^="devices.cameras.list."] button', { hasText: 'Disable' }).first().click();
    await p.waitForTimeout(700);
    const t2 = await p.textContent('[data-row^="devices.cameras.list."]');
    check('a declined admin prompt says so', /said no to the administrator prompt/.test(t2), t2.slice(0, 120));
  }],
  ['dev-autoplay', '?section=devices&page=autoplay', async (p) => {
    await p.waitForTimeout(300);
    check('removable drive + memory card dropdowns', await p.locator('#page select').count() >= 4);
  }],
  ['dev-usb', '?section=devices&page=usb', async (p) => {
    await p.waitForTimeout(300);
    const t = await p.textContent('#page');
    check('battery saver carries the admin words before the click', /Windows will ask for administrator permission to change USB battery saver/.test(t));
  }],
  ['dev-testrun', '?section=devices&page=mouse&test=1', async (p) => {
    await p.waitForTimeout(300);
    await p.locator('[data-row="devices.mouse.vanish"] [role="switch"], [data-row="devices.mouse.vanish"] button, [data-row="devices.mouse.vanish"] input').first().click();
    await p.waitForTimeout(300);
    const t = await p.textContent('[data-row="devices.mouse.vanish"]');
    check('a test-run change shows the dry-run note', /Test run, nothing changed/.test(t), t.slice(0, 160));
    const c = await calls(p, 'settings.devices.inputSet');
    check('the change went to settings.devices.inputSet', c.length === 1 && c[0].args.key === 'mouse.vanish');
  }],
  ['dev-failing', '?section=devices&page=mouse&mock=failing', async (p) => {
    await p.waitForTimeout(300);
    const t = await p.textContent('#page');
    check('a failing backend says why on the page', /(Mantle's connection to Windows is restarting|Windows took too long to answer|something went wrong inside Mantle|this needs a newer version of Mantle|Windows did not allow it)/.test(t));
  }],
];

(async () => {
  const g = gaming();
  if (g !== 0) { process.stdout.write(g > 0 ? 'a game is running: nothing run\n' : 'could not check for a running game: nothing run\n'); return; }
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await require('../test-browser.js').launch(chromium);
  const ctx = await browser.newContext({ viewport: { width: 1040, height: 760 }, deviceScaleFactor: 1.25, colorScheme: 'light' });
  await ctx.addInitScript({ path: FAKE });
  await ctx.addInitScript(`window.__DEVNET_SECS = ${JSON.stringify(SECS)};`);
  for (const [name, query, prep] of SHOTS) {
    if (ONLY && !ONLY.some((x) => name.startsWith(x))) continue;
    if (!SECS.split(',').includes(name.startsWith('net') ? 'network' : 'devices')) continue;
    const page = await ctx.newPage();
    const problems = [];
    page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push('console ' + m.type() + ': ' + m.text()); });
    await page.goto(PAGE + query, { waitUntil: 'load' });
    try { await page.waitForSelector('html[data-ready="1"]', { timeout: 6000 }); } catch (_) { problems.push('never reached data-ready'); }
    await page.waitForTimeout(250);
    let after = null;
    try { if (prep) after = await prep(page); } catch (e) { problems.push('prep threw: ' + e.message.split('\n')[0]); }
    await page.waitForTimeout(250);
    const probe = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll('.row-t, .row-h, .btn, h1, .why span, select, .val').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (!r.width || getComputedStyle(el).webkitLineClamp !== 'none') return;
        if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflow !== 'visible') out.push('clipped: ' + el.className + ' "' + el.textContent.slice(0, 40) + '"');
        if (r.right > window.innerWidth + 1) out.push('off-screen right: ' + el.className + ' "' + el.textContent.slice(0, 40) + '"');
      });
      const pg = document.getElementById('page');
      const down = [...document.querySelectorAll('.nav-i .warn, .nav-i [class*="warn"]')].length;
      return { out, rows: pg ? pg.querySelectorAll('.row').length : 0, ready: document.documentElement.dataset.ready, text: pg ? pg.textContent : '', down };
    });
    await page.screenshot({ path: path.join(OUT, name + '.png'), fullPage: true });
    if (typeof after === 'function') { try { await after(); } catch (e) { problems.push('after threw: ' + e.message.split('\n')[0]); } }
    check(`${name}: drawn`, probe.rows > 0 && probe.ready === '1', `rows ${probe.rows}, ready ${probe.ready}`);
    check(`${name}: not DOWN`, !/could not be drawn|did not load/.test(probe.text), probe.text.slice(0, 160));
    check(`${name}: no page errors, nothing clipped`, problems.length + probe.out.length === 0, problems.concat(probe.out).join(' | '));
    process.stdout.write(`${name}: ${probe.rows} rows\n`);
    await page.close();
  }
  await browser.close();
  console.log(`DEVNET UI TEST: ${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log('  FAIL ' + f);
  console.log(`shots in ${OUT}`);
  process.exitCode = failures.length || !passed ? 1 : 0;
})().catch((e) => { console.log('devnet ui test failed to run: ' + e.message); process.exitCode = 1; });
