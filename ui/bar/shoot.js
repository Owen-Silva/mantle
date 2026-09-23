/* shoot.js — headless screenshots of the bar, for eyeballing it without running Electron.
 *
 * LINE 1 below is not optional: lowcpu.js pins this process (and every browser it spawns) to a
 * few cores at below-normal priority and takes a machine-wide lock so only one headless browser
 * runs at a time. Owen's machine has been pegged by unguarded Chromium before; a run that skips
 * this file is a rule break, not a shortcut.
 *
 *   node ui/bar/shoot.js              every shot below
 *   node ui/bar/shoot.js media tray   only the shots whose name contains one of the words
 *
 * BAR_TRAY_JSON=<file> hands the mock a REAL tray listing (a JSON array in the sidecar's `tray`
 * shape, or a probe dump whose [1].result is one) through window.__MOCK_TRAY__, so real icons can
 * be eyeballed without committing anybody's tray to the repo. BAR_EXTRA_CSS=<css> adds a style to
 * every shot, for an A/B of a treatment that is not in bar.css (BAR_SUFFIX=-b names the files).
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
  { name: 'bar-1920-down', w: 1920, h: 44, q: '?state=down' },
  /* now playing (2026-09-22): the chip, then the card open over a taller page (the popover floats
     above the bar, so a 44px viewport would crop it), in each state the card has to get right */
  { name: 'media-chip', w: 1280, h: 60, q: '?mode=pill&media=playing' },
  { name: 'media-compact', w: 1000, h: 60, q: '?mode=pill&media=playing' },   // too narrow: the title gives way
  { name: 'media-card', w: 1280, h: 330, q: '?mode=pill&media=playing', click: '#mchip' },
  { name: 'media-noctl', w: 1280, h: 330, q: '?mode=pill&media=noctl', click: '#mchip' },
  /* LessonPlayer alone: NO chip (Owen's call, 2026-09-22), so nothing is clicked: the shot proves absence */
  { name: 'media-lessonplayer', w: 1280, h: 60, q: '?mode=pill&media=lessonplayer' },
  { name: 'media-both', w: 1280, h: 400, q: '?mode=pill&media=both', click: '#mchip' },
  /* LessonPlayer picked in the switcher while a player also plays: the controls-off card */
  { name: 'media-lessonplayer-picked', w: 1280, h: 480, q: '?mode=pill&media=both&pick=lessonplayer', click: '#mchip' },
  { name: 'media-off', w: 1280, h: 330, q: '?mode=pill&media=off', click: '#more' },   // the chip's reason, in words
  /* the tray: the white-icon plate on the strip, and the hidden icons in the overflow */
  { name: 'tray', w: 1280, h: 60, q: '?mode=pill&tray=1&media=playing' },
  { name: 'tray-more', w: 1280, h: 330, q: '?mode=pill&tray=1', click: '#more' }
];
const ONLY = process.argv.slice(2);
const RUN = ONLY.length ? SHOTS.filter(s => ONLY.some(w => s.name.includes(w))) : SHOTS;
let REAL_TRAY = null;
if (process.env.BAR_TRAY_JSON) {
  const raw = JSON.parse(fs.readFileSync(process.env.BAR_TRAY_JSON, 'utf8'));
  REAL_TRAY = Array.isArray(raw) ? raw : (raw && raw[1] && raw[1].result) || null;
  if (!Array.isArray(REAL_TRAY)) { console.error('FAILED: BAR_TRAY_JSON holds no tray array'); process.exit(1); }
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const exe = findChrome();
  if (!exe) { console.error('FAILED: no ms-playwright chromium found under AppData/Local/ms-playwright'); process.exit(1); }

  const browser = await chromium.launch({ headless: true, executablePath: exe });
  const ctx = await browser.newContext({ colorScheme: 'dark', deviceScaleFactor: 1.25, viewport: { width: 1920, height: 44 } });
  const problems = [];
  try {
    for (const s of RUN) {
      const page = await ctx.newPage();
      if (REAL_TRAY && /tray/.test(s.q)) await page.addInitScript((t) => { window.__MOCK_TRAY__ = t; }, REAL_TRAY);
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
      if (process.env.BAR_EXTRA_CSS) await page.addStyleTag({ content: process.env.BAR_EXTRA_CSS });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(350);           // the mock bridge answers at 30ms; this is slack, not a race
      if (s.click) { await page.click(s.click); await page.waitForTimeout(400); }
      await page.mouse.move(0, 0);              // no hover state left on whatever was clicked
      const file = path.join(OUT, s.name + (process.env.BAR_SUFFIX || '') + '.png');
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
