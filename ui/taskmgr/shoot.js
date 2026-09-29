/* shoot.js — headless screenshots of the task manager page on its MOCK (made-up apps and numbers),
 * for eyeballing it without running Electron. Pattern: ui/bar/shoot.js.
 *
 * LINE 1 below is not optional: lowcpu.js pins this process (and every browser it spawns) to a
 * few cores at below-normal priority and takes a machine-wide lock so only one headless browser
 * runs at a time.
 *
 *   node ui/taskmgr/shoot.js            every shot
 *   node ui/taskmgr/shoot.js game       only the shots whose name contains one of the words
 *   TASKMGR_SHOTS=<dir>                 where the PNGs go
 */
require('C:/Users/user/dev-tools/tools/lowcpu.js');

const fs = require('fs');
const path = require('path');

const PW_CANDIDATES = ['C:/Users/user/other-app/node_modules/playwright-core', 'C:/Users/user/Downloads/other-app/node_modules/playwright-core', 'playwright-core'];
let chromium = null;
for (const c of PW_CANDIDATES) { try { chromium = require(c).chromium; break; } catch (e) { /* next */ } }
if (!chromium) { console.error('FAILED: playwright-core not found. Tried:\n  ' + PW_CANDIDATES.join('\n  ')); process.exit(1); }

function findChrome() {
  const base = 'C:/Users/user/AppData/Local/ms-playwright';
  for (const d of fs.readdirSync(base).filter((n) => n.startsWith('chromium-')).sort().reverse())
    for (const sub of ['chrome-win/chrome.exe', 'chrome-win64/chrome.exe']) { const p = path.join(base, d, sub); if (fs.existsSync(p)) return p; }
  return null;
}

const OUT = process.env.TASKMGR_SHOTS || 'C:/Users/user/AppData/Local/Temp/claude/C--Users-owens/fe6c395c-2ffc-4958-a961-d5833371924e/scratchpad/lanes/taskmgr-shots';
const PAGE = 'file:///' + path.join(__dirname, 'index.html').replace(/\\/g, '/');
const SHOTS = [
  ['1-apps', 'apps', 780, 640],
  ['2-expanded-group', 'expanded', 780, 640],
  ['3-get-ready-to-game', 'game', 780, 640],
  ['4-protected-rows', 'protected', 780, 640],
  ['5-failed-close', 'failed', 780, 640],
  ['6-force-confirm', 'confirm', 780, 640],
  ['7-startup-tab', 'startup', 780, 480],
  ['8-min-size', 'failed', 560, 420],
];

(async () => {
  const want = process.argv.slice(2);
  const exe = findChrome();
  if (!exe) { console.error('FAILED: no ms-playwright chromium on this machine'); process.exit(1); }
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath: exe });
  let made = 0;
  const errors = [];
  try {
    for (const [name, mock, w, h] of SHOTS) {
      if (want.length && !want.some((x) => name.includes(x))) continue;
      const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
      page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
      page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: console: ${m.text()}`); });
      await page.goto(`${PAGE}?mock=${mock}`);
      try { await page.waitForFunction(() => document.documentElement.dataset.shot === '1', null, { timeout: 5000 }); } catch (e) { errors.push(`${name}: the page never settled (${String(e.message).split(/\r?\n/)[0]})`); await page.close(); continue; }
      await page.waitForTimeout(450);
      const file = path.join(OUT, `${name}.png`);
      await page.screenshot({ path: file });
      const over = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      if (over) errors.push(`${name}: the page scrolls sideways at ${w} px`);
      console.log(`shot ${file}`);
      made++;
      await page.close();
    }
  } finally { await browser.close(); }
  for (const e of errors) console.log('PROBLEM ' + e);
  console.log(`TASKMGR SHOTS: ${made} taken, ${errors.length} problems`);
  process.exit(errors.length ? 1 : 0);
})();
