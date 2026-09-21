/* shoot.js — headless screenshots of the bar, for eyeballing it without running Electron.
 *
 * LINE 1 below is not optional: lowcpu.js pins this process (and every browser it spawns) to a
 * few cores at below-normal priority and takes a machine-wide lock so only one headless browser
 * runs at a time. Owen's machine has been pegged by unguarded Chromium before; a run that skips
 * this file is a rule break, not a shortcut.
 *
 *   node ui/bar/shoot.js
 */
require('C:/Users/user/dev-tools/tools/lowcpu.js');

const fs = require('fs');
const path = require('path');
const os = require('os');

/* playwright-core is not a dependency of this repo (the bar ships no node code), so we borrow the
   one already installed on the machine, and say plainly which candidates were tried if none is
   there — a "cannot find module" stack would not tell anyone what to install. */
const PW_CANDIDATES = [
  'C:/Users/user/other-app/node_modules/playwright-core',
  'C:/Users/user/Downloads/other-app/node_modules/playwright-core',
  'playwright-core'
];
let chromium = null, pwFrom = '';
for (const c of PW_CANDIDATES) {
  try { chromium = require(c).chromium; pwFrom = c; break; } catch (e) { /* try the next one */ }
}
if (!chromium) {
  console.error('FAILED: playwright-core not found. Tried:\n  ' + PW_CANDIDATES.join('\n  '));
  process.exit(1);
}

/* The browser binary: the newest ms-playwright chromium already downloaded on this machine.
   Never a download, never the system Chrome. */
function findChrome() {
  const base = 'C:/Users/user/AppData/Local/ms-playwright';
  for (const d of fs.readdirSync(base).filter(n => n.startsWith('chromium-')).sort().reverse())
    for (const sub of ['chrome-win/chrome.exe', 'chrome-win64/chrome.exe']) {
      const p = path.join(base, d, sub);
      if (fs.existsSync(p)) return p;
    }
  return null;
}

const OUT = process.env.BAR_SHOTS ||
  'C:/Users/user/AppData/Local/Temp/claude/C--Users-owens/edd3247c-6214-4642-9069-bbf7e50b1555/scratchpad/lanes/bar';
const PAGE = 'file:///C:/Users/user/mantle/ui/bar/index.html';

/* Each shot is one state worth looking at, not one size for its own sake. */
const SHOTS = [
  { name: 'bar-1920', w: 1920, h: 44, q: '' },
  { name: 'bar-1920-bg', w: 1920, h: 44, q: '?bg=1' },   // loud wallpaper: is the glass actually letting it through?
  { name: 'bar-1280', w: 1280, h: 44, q: '' },
  { name: 'bar-1280-20win', w: 1280, h: 44, q: '?windows=20' },
  { name: 'bar-1920-down', w: 1920, h: 44, q: '?state=down' }
];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const exe = findChrome();
  if (!exe) { console.error('FAILED: no ms-playwright chromium found under AppData/Local/ms-playwright'); process.exit(1); }

  const browser = await chromium.launch({ headless: true, executablePath: exe });
  const ctx = await browser.newContext({ colorScheme: 'dark', deviceScaleFactor: 1.25, viewport: { width: 1920, height: 44 } });
  const problems = [];
  try {
    for (const s of SHOTS) {
      const page = await ctx.newPage();
      await page.setViewportSize({ width: s.w, height: s.h });
      page.on('pageerror', e => problems.push(s.name + ' pageerror: ' + e.message));
      page.on('console', m => { if (m.type() === 'error') problems.push(s.name + ' console: ' + m.text()); });
      await page.goto(PAGE + s.q, { waitUntil: 'load' });
      /* The page is deliberately transparent (the Electron window is), so a screenshot over
         nothing would composite onto white and misrepresent every contrast judgement. Paint a
         plausible dark desktop behind it — on <html>, never on the bar. The ?bg=1 shot brings
         its own (much louder) wallpaper from the mock, so leave that one alone. */
      if (!s.q.includes('bg=1'))
        await page.addStyleTag({ content: 'html{background:#141619 !important;}' });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(350);           // the mock bridge answers at 30ms; this is slack, not a race
      const file = path.join(OUT, s.name + '.png');
      await page.screenshot({ path: file });
      console.log(file);
      await page.close();
    }
  } finally {
    await browser.close();
  }
  console.log('playwright-core from ' + pwFrom + ' · chromium ' + exe);
  console.log(problems.length ? 'PAGE PROBLEMS:\n  ' + problems.join('\n  ') : 'no page errors, no console errors');
})().catch(e => { console.error('FAILED', e && e.stack || e); process.exit(1); });
