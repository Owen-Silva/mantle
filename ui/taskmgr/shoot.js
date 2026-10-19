require('../../tools/dev-env.js').lowcpu();
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
require('../../tools/dev-env.js').lowcpu();

const fs = require('fs');
const path = require('path');

const PW_CANDIDATES = require('../../tools/dev-env.js').playwrightCandidates();
let chromium = null;
for (const c of PW_CANDIDATES) { try { chromium = require(c).chromium; break; } catch (e) { /* next */ } }
if (!chromium) { console.error('FAILED: playwright-core not found. Tried:\n  ' + PW_CANDIDATES.join('\n  ')); process.exit(1); }

function findChrome() {
  const base = require('../../tools/dev-env.js').msPlaywrightDir();
  for (const d of fs.readdirSync(base).filter((n) => n.startsWith('chromium-')).sort().reverse())
    for (const sub of ['chrome-win/chrome.exe', 'chrome-win64/chrome.exe']) { const p = path.join(base, d, sub); if (fs.existsSync(p)) return p; }
  return null;
}

const OUT = process.env.TASKMGR_SHOTS || path.join(require('os').tmpdir(), 'mantle-shots', 'taskmgrfx');
const PAGE = 'file:///' + path.join(__dirname, 'index.html').replace(/\\/g, '/');
const SHOTS = [
  ['1-apps', 'apps', 780, 640],
  ['2-expanded-group', 'expanded', 780, 640],
  ['3-get-ready-to-game', 'game', 780, 640],
  ['4-protected-rows', 'protected', 780, 640],
  ['5-failed-close', 'failed', 780, 640],
  ['6-force-confirm', 'confirm', 780, 640],
  ['7-row-menu', 'menu', 780, 640],
  ['7b-not-responding', 'hung', 780, 640],
  ['7c-search-no-match', 'search', 780, 480],
  ['7d-loading', 'loading', 780, 480],
  ['7e-could-not-read', 'error', 780, 480],
  ['8-min-size', 'failed', 560, 420],
  // the glass (lane taskmgrfx): the mock's stand-in for Windows' acrylic, active / inactive / dark-frame fallback
  ['9-glass-inactive', 'apps&glass=inactive', 780, 640],
  ['10-glass-dark-frame-fallback', 'apps&glass=dark', 780, 640],
];


/* MANTLE_THEME=dark|light: every context this browser opens gets <html data-theme> set before first
   paint and the 'mantle-theme' event fired, the way the app's theme plumbing does it. Unset = light. */
function themeEvery(browser) {
  const t = process.env.MANTLE_THEME;
  if (!t) return;
  const nc = browser.newContext.bind(browser);
  browser.newContext = async (o) => {
    const c = await nc(o);
    await c.addInitScript((theme) => {
      let done = false;
      const set = () => {
        if (done || !document.documentElement) return;
        done = true;
        document.documentElement.dataset.theme = theme;
        window.dispatchEvent(new CustomEvent('mantle-theme', { detail: { theme } }));
      };
      set();
      if (!done) new MutationObserver((_, mo) => { set(); if (done) mo.disconnect(); }).observe(document, { childList: true });
    }, t);
    return c;
  };
  browser.newPage = async (o) => (await browser.newContext(o)).newPage();
}

(async () => {
  const want = process.argv.slice(2);
  const exe = findChrome();
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ timeout: 0, headless: true, executablePath: exe || undefined });
  themeEvery(browser);   // MANTLE_THEME=dark|light: <html data-theme> + the mantle-theme event, as dm-core's plumbing does
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
