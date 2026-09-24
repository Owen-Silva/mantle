require('C:/Users/user/dev-tools/tools/lowcpu.js');
/* shoot.js — headless shots of the top bar page over file:// with mock-mantle.js playing main
 * (no Electron, no sidecar, nothing from Owen's machine). Also CHECKS, not just photographs:
 *   1. the tiny-numbers rule: every stat cell keeps its width when its number changes
 *      (5% -> 100%, 0.1 -> 15.7 GB, 0 KB/s -> 999 MB/s);
 *   2. keyboard: ArrowDown/Right/Left/Escape walk the menus the way a Mac menu does, and Enter on
 *      a native item sends topbar.invoke with that item's command id;
 *   3. a failed command shows its reason on the bar.
 *   node ui/topbar/shoot.js     (MANTLE_SHOOT_OUT=<dir> for the PNGs)
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { chromium } = require('C:/Users/user/other-app/node_modules/playwright-core');

const CHROME = 'C:/Users/user/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const PAGE = 'file:///C:/Users/user/mantle/ui/topbar/index.html';
const OUT = process.env.MANTLE_SHOOT_OUT ||
  'C:/Users/user/AppData/Local/Temp/claude/C--Users-owens/fe6c395c-2ffc-4958-a961-d5833371924e/scratchpad/topbar/shots';

const SHOTS = [
  ['01-npp-closed', 'app=npp'],
  ['02-npp-file', 'app=npp&open=2'],
  ['03-npp-file-recent', 'app=npp&open=2&sub=2'],
  ['04-npp-view-checks', 'app=npp&open=5'],
  ['05-app-menu', 'app=npp&open=1'],
  ['06-mantle-restart-armed', 'app=npp&open=0&sub=6&armed=1'],
  ['07-chrome-no-menus', 'app=chrome&open=1'],
  ['08-uwp-uia', 'app=uwp'],
  ['09-dialog-blocked', 'app=dialog&open=2'],
  ['10-stat-cpu', 'stat=cpu'],
  ['11-stat-mem', 'stat=mem'],
  ['12-stat-gpu', 'stat=gpu'],
  ['13-stat-net', 'stat=net'],
  ['14-nogpu', 'stats=nogpu'],
  ['15-paused', 'stats=paused'],
  ['16-dark-file', 'app=npp&open=2&dark=1'],
  ['17-desktop', 'app=desktop&open=1'],
];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  let fails = 0, checks = 0;
  const check = (name, ok, detail) => { checks++; if (!ok) { fails++; console.log('  FAIL ' + name + (detail ? ' (' + detail + ')' : '')); } };
  try {
    for (const [w, h] of [[1536, 420], [1280, 420]]) {
      const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1.25 });
      for (const [name, q] of SHOTS) {
        if (w === 1280 && !/^0[12]|^10/.test(name)) continue;
        await page.goto(PAGE + '?' + q);
        await page.waitForFunction(() => document.documentElement.dataset.ready === '1', null, { timeout: 5000 });
        await page.waitForTimeout(220);
        await page.screenshot({ path: path.join(OUT, `${w}-${name}.png`) });
      }
      // 1. widths hold still
      await page.goto(PAGE + '?app=npp');
      await page.waitForFunction(() => document.documentElement.dataset.ready === '1');
      const widths = [];
      for (const s of [
        { cpu: { pct: 5 }, mem: { used: 0.1 * 2 ** 30, total: 15.7 * 2 ** 30 }, gpu: { pct: 0 }, net: { down: 0, up: 0 } },
        { cpu: { pct: 100 }, mem: { used: 15.6 * 2 ** 30, total: 15.7 * 2 ** 30 }, gpu: { pct: 100 }, net: { down: 999 * 2 ** 20, up: 99 * 2 ** 20 } },
        { cpu: { pct: 47.5 }, mem: { used: 9.9 * 2 ** 30, total: 15.7 * 2 ** 30 }, gpu: { pct: 9 }, net: { down: 512 * 1024, up: 2 * 2 ** 20 } },
      ]) {
        widths.push(await page.evaluate((st) => { window.mantle.emit('topbar.stats', st);
          return [...document.querySelectorAll('.st')].map((b) => Math.round(b.getBoundingClientRect().width * 10) / 10); }, s));
      }
      check(`${w}: stat cells keep their width as numbers change`, widths.every((x) => JSON.stringify(x) === JSON.stringify(widths[0])), JSON.stringify(widths));
      // 2. keyboard
      const r = await page.evaluate(async () => {
        const S = window.__topbar;
        const key = (k) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
        document.querySelector('.t[data-i="2"]').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        const out = { opened: !!S.open && S.open.ti === 2 };
        key('ArrowDown'); out.first = S.open.stack[0].sel;
        key('ArrowDown'); key('ArrowDown'); out.third = S.open.stack[0].sel;             // Recent Files (a submenu)
        key('ArrowRight'); out.subOpen = S.open.stack.length === 2 && S.open.stack[1].sel === 0;
        key('ArrowLeft'); out.subClosed = S.open.stack.length === 1;
        key('ArrowRight'); key('ArrowLeft'); key('ArrowLeft'); out.prevTitle = S.open && S.open.ti === 1;
        key('ArrowRight'); out.backToFile = S.open && S.open.ti === 2;
        key('Enter');                                                                     // "New"
        const inv = window.__mockCalls.filter((c) => c.name === 'topbar.invoke').pop();
        out.invoked = inv ? inv.args : null;
        out.closed = !S.open;
        document.querySelector('.t[data-i="3"]').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        key('Escape'); out.escClosed = !S.open;
        const ms = window.__mockCalls.filter((c) => c.name === 'topbar.menuState').pop();
        out.refocus = ms && ms.args.refocus;
        return out;
      });
      check(`${w}: a title opens its menu`, r.opened);
      check(`${w}: ArrowDown selects the first item, skipping nothing it should not`, r.first === 0 && r.third === 2, JSON.stringify(r));
      check(`${w}: ArrowRight opens a submenu, ArrowLeft closes it`, r.subOpen && r.subClosed);
      check(`${w}: ArrowLeft/Right walk the titles`, r.prevTitle && r.backToFile);
      check(`${w}: Enter on "New" sends topbar.invoke with its command id`, r.invoked && r.invoked.hwnd === '4242' && typeof r.invoked.item === 'number' && r.closed, JSON.stringify(r.invoked));
      check(`${w}: Escape closes and gives the app its focus back`, r.escClosed && r.refocus === true);
      await page.close();
    }
    // 3. failure reasons reach the bar
    const page = await browser.newPage({ viewport: { width: 1536, height: 420 }, deviceScaleFactor: 1.25 });
    await page.goto(PAGE + '?app=npp&fail=1&open=2');
    await page.waitForFunction(() => document.documentElement.dataset.ready === '1');
    await page.evaluate(() => { const row = document.querySelector('.r[data-l="0"][data-r="0"]'); row.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); });
    await page.waitForTimeout(120);
    const warn = await page.evaluate(() => (document.querySelector('.warn') || {}).textContent || '');
    check('a failed command shows its reason on the bar', /New: the app did not accept/.test(warn), warn);
    await page.screenshot({ path: path.join(OUT, '1536-18-failed-command.png') });
  } finally {
    await browser.close();
  }
  console.log(`TOPBAR SHOTS: ${checks - fails} passed, ${fails} failed (PNGs in ${OUT})`);
  process.exit(fails ? 1 : 0);
})();
