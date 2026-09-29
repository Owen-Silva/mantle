/* shoot.js — headless screenshots and perf numbers of the Mantle Files page on its MOCK (made-up
 * folders, names and sizes; nothing reads a real disk). Pattern: ui/taskmgr/shoot.js.
 *
 * LINE 1 below is not optional: lowcpu.js pins this process (and every browser it spawns) to a
 * few cores at below-normal priority and takes a machine-wide lock so only one headless browser
 * runs at a time. On top of it this script holds %TEMP%\mantle-electron-lock (the Mantle lanes'
 * one-browser rule) for as long as its browser is open.
 *
 *   node ui/files/shoot.js              every shot + the perf run
 *   node ui/files/shoot.js grid perf    only the shots whose name contains one of the words
 *   FILES_SHOTS=<dir>                   where the PNGs go
 */
require('C:/Users/user/dev-tools/tools/lowcpu.js');

const fs = require('fs');
const os = require('os');
const path = require('path');

const PW_CANDIDATES = ['C:/Users/user/other-app/node_modules/playwright-core', 'C:/Users/user/Downloads/other-app/node_modules/playwright-core', 'playwright-core'];
let chromium = null;
for (const c of PW_CANDIDATES) { try { chromium = require(c).chromium; break; } catch (e) { /* next */ } }
if (!chromium) { console.error('FAILED: playwright-core not found'); process.exit(1); }

function findChrome() {
  const base = 'C:/Users/user/AppData/Local/ms-playwright';
  for (const d of fs.readdirSync(base).filter((n) => n.startsWith('chromium-')).sort().reverse())
    for (const sub of ['chrome-win/chrome.exe', 'chrome-win64/chrome.exe']) { const p = path.join(base, d, sub); if (fs.existsSync(p)) return p; }
  return null;
}

const OUT = process.env.FILES_SHOTS || 'C:/Users/user/AppData/Local/Temp/claude/C--Users-owens/fe6c395c-2ffc-4958-a961-d5833371924e/scratchpad/lanes/files-shots';
const PAGE = 'file:///' + path.join(__dirname, 'index.html').replace(/\\/g, '/');
const HOME = 'C:\\Users\\Robin';
const LOCK = path.join(os.tmpdir(), 'mantle-electron-lock');
const W = 1280;                                                  // the everyday window: 1280 wide
const H = 760;

/* each shot: [name, start path, width, height, setup(page) run after the first listing settles] */
const inPage = (fn, arg) => (page) => page.evaluate(fn, arg);
const SHOTS = [
  ['01-details', HOME + '\\Documents', W, H, inPage(() => { MF.app.list.selectKeys(['Plan.docx']); })],
  ['02-grid-thumbnails', HOME + '\\Pictures', W, H, async (page) => { await page.evaluate(() => MF.app.setView({ view: 'grid', size: 'medium' })); await page.waitForTimeout(900); }],
  ['03-list', HOME + '\\Downloads', W, H, inPage(() => { MF.app.setView({ view: 'list' }); MF.app.list.selectKeys(['Manual v3.pdf']); })],
  ['04-group-by-date', HOME + '\\Documents', W, H, inPage(() => MF.app.setView({ group: 'date', sort: 'date', dir: 'desc' }))],
  ['05-search-results', HOME + '\\Documents', W, H, async (page) => { await page.evaluate(() => MF.app.startSearch('notes')); await page.waitForFunction(() => MF.app.cur().search && MF.app.cur().search.done, null, { timeout: 5000 }); }],
  ['06-context-menu-more', HOME + '\\Documents', W, H, async (page) => {
    const r = await page.evaluate(() => { const t = MF.app.cur(); const i = t.index.get('Plan.docx'); MF.app.list.reveal(i); MF.app.list.render(); const c = [...document.querySelectorAll('.cell')].find((x) => x._i === i); const b = c.getBoundingClientRect(); return { x: b.left + 60, y: b.top + 14 }; });
    await page.mouse.click(r.x, r.y, { button: 'right' });
    await page.waitForTimeout(120);
    const more = await page.evaluate(() => { const b = [...document.querySelectorAll('.menu .mi')].find((x) => x.textContent.startsWith('More')); const q = b.getBoundingClientRect(); return { x: q.left + 40, y: q.top + 12 }; });
    await page.mouse.move(more.x, more.y);
    await page.waitForTimeout(600);
  }],
  ['07-conflict-dialog', HOME + '\\Downloads', W, H, async (page) => {
    await page.evaluate(() => { MF.app.list.selectKeys(['Plan.docx', 'Reading list.txt']); MF.app.runCmd('copy'); });
    await page.waitForTimeout(50);
    await page.evaluate(() => MF.app.go(MF.app.cur(), 'C:\\Users\\Robin\\Documents'));
    await page.waitForFunction(() => !MF.app.cur().loading, null, { timeout: 5000 });
    await page.evaluate(() => MF.app.runCmd('paste'));
    await page.waitForSelector('.dlg', { timeout: 3000 });
  }],
  ['08-progress-card', HOME + '\\Big folder', W, H, async (page) => {
    await page.evaluate(() => { window.__mockSlow = true; const t = MF.app.cur(); MF.app.list.selectKeys(t.shown.slice(3, 40).map((x) => x.n)); MF.app.runCmd('copy'); });
    await page.waitForTimeout(50);
    await page.evaluate(() => MF.app.go(MF.app.cur(), 'C:\\Users\\Robin\\Documents'));
    await page.waitForFunction(() => !MF.app.cur().loading, null, { timeout: 5000 });
    await page.evaluate(() => MF.app.runCmd('paste'));
    await page.waitForSelector('.pcard', { timeout: 3000 });
    await page.waitForTimeout(1500);
  }],
  ['09-failure-toast', HOME + '\\Documents', W, H, async (page) => {
    await page.evaluate(() => { MF.app.list.selectKeys(['Locked report.docx', 'Notes 2.txt']); MF.app.runCmd('del'); });
    await page.waitForSelector('.toast.err', { timeout: 3000 });
    await page.waitForTimeout(400);
  }],
  ['10-preview-image', HOME + '\\Pictures', W, H, async (page) => { await page.evaluate(() => { MF.app.list.selectKeys(['Harbor at dusk.jpg']); MF.app.runCmd('preview'); }); await page.waitForTimeout(500); }],
  ['11-preview-text', HOME + '\\Documents', W, H, async (page) => { await page.evaluate(() => { MF.app.list.selectKeys(['Reading list.txt']); MF.app.runCmd('preview'); }); await page.waitForTimeout(400); }],
  ['12-properties-folder', HOME + '\\Documents', W, H, async (page) => { await page.evaluate(() => { MF.app.list.selectKeys(['Budget 2026']); MF.app.runCmd('props'); }); await page.waitForTimeout(1200); }],
  ['13-recycle-bin', 'mantle:recycle', W, H, inPage(() => MF.app.list.selectKeys(['bin|$RG7H8I9.png']))],
  ['14-this-pc', 'mantle:thispc', W, H, null],
  ['15-home', 'mantle:home', W, H, null],
  ['16-inactive-window', HOME + '\\Documents', W, H, inPage(() => { MF.app.list.selectKeys(['Plan.docx']); window.dispatchEvent(new Event('blur')); })],
  ['17-min-size', HOME + '\\Documents', 560, 380, inPage(() => MF.app.list.selectKeys(['Plan.docx']))],
  ['18-grid-large-10k', HOME + '\\Big folder', W, H, async (page) => { await page.evaluate(() => { MF.app.setView({ view: 'grid', size: 'large' }); MF.app.list.sc.scrollTop = 40000; }); await page.waitForTimeout(900); }],
  ['19-rename-inline', HOME + '\\Documents', W, H, async (page) => { await page.evaluate(() => { MF.app.list.selectKeys(['Quarterly numbers.xlsx']); MF.app.runCmd('rename'); }); await page.waitForTimeout(150); }],
  ['20-empty-folder', HOME + '\\Desktop\\Sort later', W, H, null],
  ['21-list-denied', HOME + '\\Documents\\Private', W, H, null],
  ['22-narrow-details', HOME + '\\Documents', 760, 620, inPage(() => MF.app.list.selectKeys(['Plan.docx']))],
  ['23-narrow-grid', HOME + '\\Pictures', 760, 620, async (page) => { await page.evaluate(() => MF.app.setView({ view: 'grid', size: 'medium' })); await page.waitForTimeout(900); }],
  // real events can overtake their call's reply: the delete must finish (no stuck card) and the folder refresh by itself
  ['25-early-events', HOME + '\\Documents', W, H, async (page) => {
    await page.evaluate(() => { window.__mockEarly = true; MF.app.list.selectKeys(['Notes 2.txt']); MF.app.runCmd('del'); });
    await page.waitForTimeout(1200);
    const r = await page.evaluate(() => ({ cards: document.querySelectorAll('.pcard').length, still: MF.app.cur().items.some((x) => x.n === 'Notes 2.txt'), refreshing: !!MF.app.cur().refresh }));
    if (r.cards || r.still || r.refreshing) throw new Error('events that came before the reply were lost: ' + JSON.stringify(r));
  }],
  ['24-narrow-preview', HOME + '\\Pictures', 760, 620, async (page) => { await page.evaluate(() => { MF.app.list.selectKeys(['Harbor at dusk.jpg']); MF.app.runCmd('preview'); }); await page.waitForTimeout(500); }],
];

async function perf(browser, errors) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 700 }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => errors.push(`perf: ${e.message}`));
  await page.goto(`${PAGE}?path=${encodeURIComponent(HOME + '\\Big folder')}`);
  await page.waitForFunction(() => MF.perf.runs.some((r) => r.count >= 10000 && r.all != null), null, { timeout: 15000 });
  const load = await page.evaluate(() => { const r = MF.perf.runs.find((x) => x.count >= 10000); return { first: r.first, all: r.all, count: r.count }; });
  const sorts = await page.evaluate(async () => {
    const out = {};
    for (const key of ['name', 'date', 'type', 'size', 'name']) {
      const t0 = performance.now();
      MF.app.setView({ sort: key, dir: 'asc' });
      const sync = performance.now() - t0;
      out[key] = { arrange: Math.round(MF.app.cur().arrangeMs * 10) / 10, total: Math.round(sync * 10) / 10 };
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    }
    return out;
  });
  const scroll = async (label) => page.evaluate(async (lab) => {
    const sc = MF.app.list.sc;
    sc.scrollTop = 0;
    await new Promise((r) => requestAnimationFrame(r));
    const deltas = [];
    let last = performance.now();
    const t0 = last;
    let nodesMid = 0;
    await new Promise((resolve) => {
      const step = (now) => {
        deltas.push(now - last);
        last = now;
        sc.scrollTop += 90;                                     // ~5,400 px/s: a fast drag of the scrollbar
        if (!nodesMid && now - t0 > 1500) nodesMid = document.getElementsByTagName('*').length;
        if (now - t0 < 3000) requestAnimationFrame(step); else resolve();
      };
      requestAnimationFrame(step);
    });
    deltas.shift();
    const s = deltas.slice().sort((a, b) => a - b);
    const pct = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
    return { view: lab, frames: s.length, median: +pct(0.5).toFixed(1), p95: +pct(0.95).toFixed(1), max: +s[s.length - 1].toFixed(1), over16: s.filter((x) => x > 16.7).length, nodesMid, cells: MF.app.list.cells.size };
  }, label);
  await page.evaluate(() => MF.app.setView({ sort: 'name', dir: 'asc' }));
  const details = await scroll('details');
  await page.evaluate(() => { MF.app.list.sc.scrollTop = Math.round(MF.app.list.sc.scrollHeight * 0.47); });
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(OUT, '04b-10k-mid-scroll.png') });
  await page.evaluate(() => MF.app.setView({ view: 'grid', size: 'medium' }));
  await page.waitForTimeout(300);
  const grid = await scroll('grid');
  const nodesIdle = await page.evaluate(() => document.getElementsByTagName('*').length);
  await page.close();
  return { load, sorts, details, grid, nodesIdle };
}

(async () => {
  const want = process.argv.slice(2);
  const exe = findChrome();
  if (!exe) { console.error('FAILED: no ms-playwright chromium on this machine'); process.exit(1); }
  fs.mkdirSync(OUT, { recursive: true });
  try { fs.mkdirSync(LOCK); } catch (e) { console.error('FAILED: another lane holds ' + LOCK + ' (one browser at a time); try later'); process.exit(2); }
  let browser = null;
  let made = 0;
  const errors = [];
  let perfOut = null;
  try {
    browser = await chromium.launch({ headless: true, executablePath: exe });
    for (const [name, start, w, h, setup] of SHOTS) {
      if (want.length && !want.some((x) => name.includes(x))) continue;
      const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
      page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
      page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: console: ${m.text()}`); });
      await page.goto(`${PAGE}?path=${encodeURIComponent(start)}`);
      try {
        await page.waitForFunction(() => document.documentElement.dataset.ready === '1' && window.MF && MF.app && !MF.app.cur().loading, null, { timeout: 8000 });
        await page.waitForTimeout(150);
        if (setup) await setup(page);
        await page.waitForTimeout(250);
      } catch (e) { errors.push(`${name}: did not settle (${String(e.message).split(/\r?\n/)[0]})`); }
      await page.screenshot({ path: path.join(OUT, `${name}.png`) });
      const over = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      if (over) errors.push(`${name}: the page scrolls sideways at ${w} px`);
      const toastErr = await page.evaluate(() => [...document.querySelectorAll('.toast.err .tt')].map((x) => x.textContent));
      if (toastErr.length && !name.includes('failure')) errors.push(`${name}: unexpected error toast: ${toastErr.join(' | ')}`);
      made++;
      await page.close();
    }
    if (!want.length || want.includes('perf')) perfOut = await perf(browser, errors);
  } finally {
    if (browser) await browser.close().catch(() => {});
    try { fs.rmdirSync(LOCK); } catch (_) { /* already gone */ }
  }
  if (perfOut) {
    const p = perfOut;
    console.log(`PERF 10k folder: first rows painted ${p.load.first.toFixed(0)} ms after files.list, all ${p.load.count} in ${p.load.all.toFixed(0)} ms`);
    console.log(`PERF sort 10k (arrange ms / with repaint ms): ${Object.entries(p.sorts).map(([k, v]) => `${k} ${v.arrange}/${v.total}`).join(', ')}`);
    for (const s of [p.details, p.grid]) console.log(`PERF scroll ${s.view}: ${s.frames} frames, median ${s.median} ms, p95 ${s.p95} ms, max ${s.max} ms, ${s.over16} over 16.7 ms; DOM ${s.nodesMid} nodes mid-scroll (${s.cells} cells)`);
    console.log(`PERF DOM after grid scroll: ${p.nodesIdle} nodes`);
  }
  for (const e of errors) console.log('PROBLEM ' + e);
  console.log(`FILES SHOTS: ${made} taken, ${errors.length} problems -> ${OUT}`);
  process.exit(errors.length ? 1 : 0);
})();
