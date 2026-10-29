require('../../tools/dev-env.js').lowcpu();
/* shoot.js - headless screenshots of the task manager on its MOCK (made-up apps and numbers), for eyeballing
 * it without Electron. LINE 1 is not optional: lowcpu.js pins this process (and its browser) to a few cores
 * at below-normal priority and holds the machine-wide one-browser lock.
 *
 *   node ui/taskmgr/shoot.js                 every shot
 *   node ui/taskmgr/shoot.js details dark    only shots whose name contains EVERY word given
 *   TASKMGR_SHOTS=<dir>                      where the PNGs go (default <worktree>/.shots)
 *
 * Every page gets four base shots: light + dark at 1280x800 and at the window's minimum (560x420).
 * A page adds its own (menus, dialogs, states) in pages/<id>.shots.js:
 *   module.exports = [{ name: 'details-affinity', q: 'view=details', w: 1280, h: 800, themes: ['light','dark'],
 *                       run: async (page) => { ...open the dialog... } }];
 * Under 3.3 GB free RAM it waits (60 s, twice), then stops without starting a browser.
 */
const fs = require('fs');
const path = require('path');
const { freeGB } = require('./testkit.js');

const OUT = process.env.TASKMGR_SHOTS || path.join(__dirname, '..', '..', '.shots');
const PAGE = 'file:///' + path.join(__dirname, 'index.html').replace(/\\/g, '/');
const PAGES = ['processes', 'performance', 'apphistory', 'startup', 'users', 'details', 'services', 'game', 'settings'];
const MIN = [560, 420];

function shots() {
  const out = [];
  for (const id of PAGES) {
    const q = id === 'game' ? 'mock=game&view=game' : `view=${id}`;
    for (const th of ['light', 'dark']) {
      out.push({ name: `${id}-1280-${th}`, q, w: 1280, h: 800, theme: th });
      out.push({ name: `${id}-min-${th}`, q, w: MIN[0], h: MIN[1], theme: th });
    }
    const f = path.join(__dirname, 'pages', `${id}.shots.js`);
    if (fs.existsSync(f)) {
      for (const s of require(f)) for (const th of s.themes || ['light', 'dark']) out.push(Object.assign({}, s, { name: `${s.name}-${th}`, theme: th, w: s.w || 1280, h: s.h || 800 }));
    }
  }
  // the shell's own: Run new task, a narrow window with the rail opened over the page, the glass fallbacks
  const shell = [
    { name: 'shell-run-new-task', q: 'view=processes', run: async (p) => { await p.click('#cmdbar [data-ci="0"]'); await p.waitForSelector('.dlg'); } },
    { name: 'shell-rail-overlay', q: 'view=processes', w: 760, h: 560, run: async (p) => { await p.click('#ham'); } },
    { name: 'shell-needs-admin', q: 'view=processes&admin=runTask', run: async (p) => { await p.click('#cmdbar [data-ci="0"]'); await p.fill('#rt-cmd', 'regedit'); await p.click('.dfoot [data-b="ok"]'); await p.waitForSelector('.rt-why:not([hidden])'); } },
    { name: 'shell-old-main', q: 'old=1', run: async (p) => { await p.click('.nav[data-view="details"]'); await p.waitForTimeout(200); } },
    { name: 'shell-glass-inactive', q: 'glass=inactive', themes: ['light'] },
    { name: 'shell-glass-dark-frame', q: 'glass=dark', themes: ['light'] },
  ];
  for (const s of shell) for (const th of s.themes || ['light', 'dark']) out.push(Object.assign({ w: 1280, h: 800 }, s, { name: `${s.name}-${th}`, theme: th }));
  return out;
}

(async () => {
  const want = process.argv.slice(2).map((s) => s.toLowerCase());
  const list = shots().filter((s) => want.every((w) => s.name.toLowerCase().includes(w)));
  let gb = freeGB();
  for (let i = 0; i < 2 && gb > 0 && gb < 3.3; i++) { console.log(`waiting: ${gb.toFixed(2)} GB free RAM, a browser needs 3.3`); await new Promise((r) => setTimeout(r, 60000)); gb = freeGB(); }
  if (gb > 0 && gb < 3.3) { console.log(`TASKMGR SHOTS: not taken (only ${gb.toFixed(2)} GB free RAM; a browser needs 3.3)`); process.exit(2); }
  fs.mkdirSync(OUT, { recursive: true });
  const { chromium } = require('../../tools/dev-env.js').playwright();
  const browser = await require('../settings/test-browser.js').launch(chromium, { timeout: 0, headless: true });
  let made = 0;
  const errors = [];
  try {
    for (const s of list) {
      const ctx = await browser.newContext({ viewport: { width: s.w, height: s.h }, deviceScaleFactor: 1 });
      await ctx.addInitScript((theme) => {
        const set = () => { if (!document.documentElement) return false; document.documentElement.dataset.theme = theme; window.dispatchEvent(new CustomEvent('mantle-theme', { detail: { theme } })); return true; };
        if (!set()) new MutationObserver((_, mo) => { if (set()) mo.disconnect(); }).observe(document, { childList: true });
      }, s.theme);
      const page = await ctx.newPage();
      page.on('pageerror', (e) => errors.push(`${s.name}: ${e.message}`));
      page.on('console', (m) => { if (m.type() === 'error') errors.push(`${s.name}: console: ${m.text()}`); });
      try {
        await page.goto(`${PAGE}?${s.q || ''}`);
        await page.waitForFunction(() => document.documentElement.dataset.shot === '1', null, { timeout: 8000 });
        await page.waitForTimeout(250);
        if (s.run) await s.run(page);
        await page.waitForTimeout(350);
        const file = path.join(OUT, `${s.name}.png`);
        await page.screenshot({ path: file });
        if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) errors.push(`${s.name}: the page scrolls sideways at ${s.w} px`);
        const tm = await page.evaluate(() => (window.__tmErrors || []).map((e) => String(e && e.message || e)));
        for (const e of tm) errors.push(`${s.name}: a page threw while drawing: ${e}`);
        console.log(`shot ${file}`);
        made++;
      } catch (e) { errors.push(`${s.name}: ${String(e.message).split(/\r?\n/)[0]}`); }
      await ctx.close();
    }
  } finally { await browser.close(); }
  for (const e of errors) console.log('PROBLEM ' + e);
  console.log(`TASKMGR SHOTS: ${made} taken, ${errors.length} problems`);
  process.exit(errors.length ? 1 : 0);
})();
