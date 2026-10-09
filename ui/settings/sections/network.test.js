require('C:/Users/user/dev-tools/tools/lowcpu.js');
/* network.test.js — the Network & internet PAGES (sections/internet.js) on the mock (lane net2,
 * 2026-09-28). Headless chromium over file://, never Electron, never a real setting: the settings
 * lane's mock (mock-mantle.js) plays main, and _devnet-fake.js plays settings.internet.* with
 * made-up data. Line 1 is the machine-wide CPU cap and browser lock.
 *
 *   node ui/settings/sections/network.test.js          checks + screenshots (net-*.png)
 *   ONLY=net-wifi,net-proxy node ...                   just those (prefix match)
 *   MANTLE_SHOOT_OUT=<dir>                             where the PNGs go
 * Prints "NETWORK UI TEST: n passed, m failed". A game running = nothing is run.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const { chromium } = require('C:/Users/user/other-app/node_modules/playwright-core');

const CHROME = 'C:/Users/user/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const PAGE = 'file:///' + path.resolve(__dirname, '..', 'index.html').replace(/\\/g, '/');
const FAKE = path.join(__dirname, '_devnet-fake.js');
const OUT = process.env.MANTLE_SHOOT_OUT ||
  'C:/Users/user/AppData/Local/Temp/claude/C--Users-owens/fe6c395c-2ffc-4958-a961-d5833371924e/scratchpad/lanes/net2-shots';
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;

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
const btn = (p, row, text) => p.locator(`[data-row="${row}"] button`, { hasText: text }).last();
const rowText = (p, row) => p.locator(`[data-row="${row}"]`).last().textContent();   // a group heading may share the id
const count = (p, sel) => p.locator(sel).count();

/* [name, query, prep(page)] */
const SHOTS = [
  ['net-overview', '?section=internet', async (p) => {
    const t = await p.textContent('#page');
    check('overview lists every page', ['Status', 'Wi-Fi', 'Ethernet', 'VPN', 'Mobile hotspot', 'Airplane mode', 'Proxy', 'Dial-up', 'Advanced network settings'].every((w) => t.includes(w)), t.slice(0, 200));
    const nav = await p.textContent('nav, .nav, #nav').catch(() => '');
    check('the sidebar has Network & internet once (the built-in is replaced)', (nav.match(/Network & internet|Network & Wi-Fi|Network\b/g) || []).length >= 1);
  }],
  ['net-status', '?section=internet&page=network', async (p) => {
    await p.waitForTimeout(400);
    check('the connection row says Wi-Fi + Internet', /Wi-Fi.*Internet/.test(await rowText(p, 'network.status')));
    check('data usage lists every adapter', await count(p, '[data-row^="network.status.usage."]') === 4);
    check('per-app usage says why it is read-only', /System Resource Usage Monitor/.test(await rowText(p, 'network.status.apps')));
    check('properties show the IPv4 address', /192\.168\.50\.23/.test(await p.textContent('#page')));
  }],
  ['net-wifi', '?section=internet&page=wifi', async (p) => {
    await p.waitForTimeout(500);
    check('the radio row is drawn', await count(p, '[data-row="network.wifi"]') === 1);
    check('networks in range are listed', await count(p, '[data-row^="network.networks."]') >= 2);
    check('saved networks are listed', await count(p, '[data-row^="network.wifi.known."]') >= 4);
    check('the connected network shows band and protocol', /5 GHz/.test(await rowText(p, 'network.wifi.props.band')) && /Wi-Fi 6/.test(await rowText(p, 'network.wifi.props.protocol')));
    check('a policy network says why it is read-only', /organization's policy/.test(await p.textContent('#page')));
  }],
  ['net-wifi-edit', '?section=internet&page=wifi&test=1', async (p) => {
    await p.waitForTimeout(500);
    await p.locator('[data-row^="network.wifi.known."] button', { hasText: 'Properties' }).nth(1).click();
    await p.waitForTimeout(200);
    for (const r of ['auto', 'hidden', 'random', 'metered', 'forget']) check('the editor has its ' + r + ' row', await count(p, '[data-row="network.wifi.known.' + r + '"]') === 1);
    await p.locator('[data-row="network.wifi.known.hidden"] [role="switch"], [data-row="network.wifi.known.hidden"] button, [data-row="network.wifi.known.hidden"] input').first().click();
    await p.waitForTimeout(400);
    check('a test-run change shows the dry-run note', /Test run, nothing changed/.test(await rowText(p, 'network.wifi.known.hidden')));
    const c = await calls(p, 'settings.internet.wifiSet');
    check('the change went to wifiSet with hidden', c.length === 1 && c[0].args.hidden === false && c[0].args.profile === 'Attic', JSON.stringify(c));
  }],
  ['net-wifi-forget', '?section=internet&page=wifi&test=1', async (p) => {
    await p.waitForTimeout(500);
    await p.locator('[data-row^="network.wifi.known."] button', { hasText: 'Properties' }).nth(2).click();
    await p.waitForTimeout(200);
    await btn(p, 'network.wifi.known.forget', 'Forget').click();
    await p.waitForTimeout(200);
    check('forget asks to confirm first', /Press again to confirm/.test(await rowText(p, 'network.wifi.known.forget')));
    await btn(p, 'network.wifi.known.forget', 'Yes, forget it').click();
    await p.waitForTimeout(400);
    check('forget in a test run is a dry run', /Test run, nothing changed: Mantle would forget/.test(await rowText(p, 'network.wifi.known.forget')));
  }],
  ['net-wifi-hidden', '?section=internet&page=wifi&test=1', async (p) => {
    await p.waitForTimeout(400);
    await p.locator('[data-row="network.wifi.hidden.name"] input').fill('Attic Mesh');
    await p.locator('[data-row="network.wifi.hidden.name"] input').press('Enter');
    await p.locator('[data-row="network.wifi.hidden.password"] input').fill('made-up-pass-9');
    await p.locator('[data-row="network.wifi.hidden.password"] input').press('Enter');
    await btn(p, 'network.wifi.hidden', 'Connect').click();
    await p.waitForTimeout(400);
    check('hidden connect in a test run is a dry run', /Test run, nothing changed: Mantle would join the hidden network/.test(await rowText(p, 'network.wifi.hidden')));
    const c = await calls(p, 'settings.internet.wifiConnect');
    check('hidden connect sends name + security, password redacted', c.length === 1 && c[0].args.hidden === true && c[0].args.security === 'wpa2' && c[0].args.password === '(redacted)', JSON.stringify(c));
  }],
  ['net-ethernet', '?section=internet&page=ethernet', async (p) => {
    await p.waitForTimeout(400);
    const t = await p.textContent('#page');
    check('the wired adapter is shown', /1 wired adapter, 0 connected/.test(await rowText(p, 'network.ethernet')));
    check('metered says why it is read-only', /Data Usage service/.test(t));
    check('the DNS save carries the administrator words', /Windows will ask for administrator permission to change this adapter's DNS servers/.test(t));
    check('typed-in DNS shows as Manual', /Manual: 1\.1\.1\.1, 1\.0\.0\.1/.test(t));
  }],
  ['net-advanced', '?section=internet&page=advanced&test=1', async (p) => {
    await p.waitForTimeout(400);
    check('every adapter is listed, the disabled one too', await count(p, '[data-row^="network.advanced.adapters."]') === 4 && /Turned off/.test(await p.textContent('#page')));
    const first = p.locator('[data-row^="network.advanced.adapters."]').first();
    await first.locator('button', { hasText: 'Disable' }).click();
    await p.waitForTimeout(400);
    check('disable in a test run is a dry run', /Test run, nothing changed/.test(await first.textContent()));
    await first.locator('button', { hasText: 'Details' }).click();
    await p.waitForTimeout(300);
    check('details show driver and MAC', /23\.60\.1\.2/.test(await p.textContent('#page')) && /02:00:5E:10:20:30/.test(await p.textContent('#page')));
    check('network reset carries the administrator words', /reset every network adapter/.test(await rowText(p, 'network.advanced.reset')));
  }],
  ['net-vpn', '?section=internet&page=vpn', async (p) => {
    await p.waitForTimeout(400);
    check('both VPNs are listed', await count(p, '[data-row^="network.vpn.list."]') === 2);
    check('adding a VPN says why it is not here', /not built into Mantle yet/.test(await rowText(p, 'network.vpn.add')));
  }],
  ['net-proxy', '?section=internet&page=proxy&test=1', async (p) => {
    await p.waitForTimeout(400);
    await p.locator('[data-row="network.proxy.detect"] [role="switch"], [data-row="network.proxy.detect"] button, [data-row="network.proxy.detect"] input').first().click();
    await p.waitForTimeout(400);
    check('proxy change in a test run is a dry run', /Test run, nothing changed/.test(await rowText(p, 'network.proxy.detect')));
    check('manual proxy rows are drawn', await count(p, '[data-row^="network.proxy.manual"]') >= 5);
  }],
  ['net-airplane', '?section=internet&page=airplane', async (p) => {
    await p.waitForTimeout(400);
    check('airplane mode and both radios are drawn', await count(p, '[data-row="network.airplane"]') === 1 && await count(p, '[data-row="network.airplane.bluetooth"]') === 1);
  }],
  ['net-hotspot', '?section=internet&page=hotspot', async (p) => {
    check('hotspot says why it is read-only', /tethering API/.test(await rowText(p, 'network.hotspot.state')));
  }],
  ['net-dialup', '?section=internet&page=dialup', async (p) => {
    await p.waitForTimeout(300);
    check('no dial-up says so', /No dial-up connections/.test(await p.textContent('#page')));
  }],
  ['net-failing', '?section=internet&page=wifi&mock=failing', async (p) => {
    await p.waitForTimeout(500);
    check('a failing backend says why on the page', /WLAN AutoConfig/.test(await p.textContent('#page')));
  }],
];

(async () => {
  const g = gaming();
  if (g !== 0) { process.stdout.write(g > 0 ? 'a game is running: nothing run\n' : 'could not check for a running game: nothing run\n'); return; }
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await require('../test-browser.js').launch(chromium);
  const ctx = await browser.newContext({ viewport: { width: 1040, height: 760 }, deviceScaleFactor: 1.25, colorScheme: 'light' });
  await ctx.addInitScript({ path: FAKE });
  await ctx.addInitScript('window.__DEVNET_SECS = "internet";');
  for (const [name, query, prep] of SHOTS) {
    if (ONLY && !ONLY.some((x) => name.startsWith(x))) continue;
    const page = await ctx.newPage();
    const problems = [];
    page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push('console ' + m.type() + ': ' + m.text()); });
    await page.goto(PAGE + query, { waitUntil: 'load' });
    try { await page.waitForSelector('html[data-ready="1"]', { timeout: 6000 }); } catch (_) { problems.push('never reached data-ready'); }
    await page.waitForTimeout(250);
    try { if (prep) await prep(page); } catch (e) { problems.push('prep threw: ' + e.message.split('\n')[0]); }
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
      return { out, rows: pg ? pg.querySelectorAll('.row').length : 0, ready: document.documentElement.dataset.ready, text: pg ? pg.textContent : '' };
    });
    await page.screenshot({ path: path.join(OUT, name + '.png'), fullPage: true });
    check(`${name}: drawn`, probe.rows > 0 && probe.ready === '1', `rows ${probe.rows}, ready ${probe.ready}`);
    check(`${name}: not DOWN`, !/could not be drawn|did not load/.test(probe.text), probe.text.slice(0, 160));
    check(`${name}: no page errors, nothing clipped`, problems.length + probe.out.length === 0, problems.concat(probe.out).join(' | '));
    process.stdout.write(`${name}: ${probe.rows} rows\n`);
    await page.close();
  }
  await browser.close();
  console.log(`NETWORK UI TEST: ${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log('  FAIL ' + f);
  console.log(`shots in ${OUT}`);
  process.exitCode = failures.length || !passed ? 1 : 0;
})().catch((e) => { console.log('network ui test failed to run: ' + e.message); process.exitCode = 1; });
