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
 *   FILES_BD=dark,light                 each shot over a made-up DARK and/or LIGHT window behind a mock
 *                                       of DWM's acrylic (<name>-dark.png, <name>-light.png), with the
 *                                       grey each surface reads printed (lane lookfiles, 2026-09-29)
 *   FILES_THEME=dark|light              force <html data-theme> before first paint and fire 'mantle-theme'
 *                                       (the harness stand-in for --theme=; lane dm-files, 2026-10-08)
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
const THEME = ['dark', 'light'].includes(process.env.FILES_THEME) ? process.env.FILES_THEME : null;
function THEME_INIT(t) {
  /* an init script can run before <html> exists: set it the moment the parser makes it (before paint) */
  const set = () => !!document.documentElement && !!(document.documentElement.dataset.theme = t);
  if (!set()) new MutationObserver((_, mo) => { if (set()) mo.disconnect(); }).observe(document, { childList: true });
  const fire = () => window.dispatchEvent(new CustomEvent('mantle-theme', { detail: { theme: t } }));
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fire, { once: true }); else fire();
}
const BDS = process.env.FILES_BD ? process.env.FILES_BD.split(',').filter((x) => x === 'dark' || x === 'light') : [null];
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
  // lane files2 (2026-09-29): filters, search inside files, rename many, checksum, check boxes, OneDrive status
  ['30-search-contents', HOME + '\\Documents', W, H, async (page) => {
    await page.evaluate(() => MF.app.setContents(true));
    await page.waitForTimeout(100);
    await page.evaluate(() => MF.app.startSearch('garden'));
    await page.waitForFunction(() => MF.app.cur().search && MF.app.cur().search.done, null, { timeout: 5000 });
    await page.waitForTimeout(300);
  }],
  ['31-filter-menu', HOME + '\\Documents', W, H, async (page) => {
    await page.evaluate(() => MF.app.setFilter({ kind: ['document', 'picture'], date: 'month', size: null }));
    await page.waitForTimeout(150);
    const r = await page.evaluate(() => { const b = [...document.querySelectorAll('#cmdbar .cmd')].find((x) => /Filter/.test(x.textContent)); const q = b.getBoundingClientRect(); return { x: q.left + 10, y: q.top + 10 }; });
    await page.mouse.click(r.x, r.y);
    await page.waitForTimeout(150);
    const k = await page.evaluate(() => { const b = [...document.querySelectorAll('.menu .mi')].find((x) => x.textContent.startsWith('Kind')); const q = b.getBoundingClientRect(); return { x: q.left + 40, y: q.top + 10 }; });
    await page.mouse.move(k.x, k.y);
    await page.waitForTimeout(600);
  }],
  ['32-rename-many', HOME + '\\Documents', W, H, async (page) => {
    await page.evaluate(() => { MF.app.list.selectKeys(['Reading list.txt', 'Notes 2.txt', 'Notes 10.txt', 'Plan.docx']); MF.app.runCmd('rename'); });
    await page.waitForSelector('.dlg .rn-base', { timeout: 3000 });
    await page.fill('.dlg .rn-base', 'Autumn');
    await page.waitForTimeout(150);
  }],
  ['33-rename-many-replace-clash', HOME + '\\Documents', W, H, async (page) => {
    await page.evaluate(() => { MF.app.list.selectKeys(['Notes 2.txt', 'Notes 10.txt', 'Reading list.txt']); MF.app.runCmd('rename'); });
    await page.waitForSelector('.dlg .rn-base', { timeout: 3000 });
    await page.click('.dlg .segb[data-mode="replace"]');
    await page.fill('.dlg .rn-find', 'Notes 10');
    await page.fill('.dlg .rn-repl', 'Notes 2');
    await page.waitForTimeout(150);
  }],
  ['34-checksum', HOME + '\\Documents', W, H, async (page) => {
    await page.evaluate(() => { MF.app.list.selectKeys(['Plan.docx']); MF.app.runCmd('props'); });
    await page.waitForSelector('.hash-go', { timeout: 3000 });
    await page.click('.hash-go');
    await page.waitForFunction(() => !/Reading|Not computed/.test((document.querySelector('.hash-out') || {}).textContent || 'x'), null, { timeout: 3000 });
    await page.waitForTimeout(150);
  }],
  ['35-checkboxes-compact', HOME + '\\Documents', W, H, async (page) => {
    await page.evaluate(() => MF.app.runCmd('checkboxes'));
    await page.waitForTimeout(100);
    await page.evaluate(() => MF.app.runCmd('compact'));
    await page.waitForTimeout(150);
    await page.evaluate(() => MF.app.list.selectKeys(['Plan.docx', 'Invoice 0042.pdf', 'Budget 2026']));
    await page.waitForTimeout(150);
  }],
  ['36-onedrive-status', HOME + '\\OneDrive', W, H, null],
  ['37-background-menu-terminal', HOME + '\\Documents', W, H, async (page) => {
    await page.evaluate(() => { const r = MF.app.list.sc.getBoundingClientRect(); MF.app.backgroundMenu(r.left + 500, r.top + 420); });
    await page.waitForTimeout(300);
  }],
  // lane lookfiles (2026-09-29): the selection's look on tiles, and on This PC's cards
  ['38-grid-selected', HOME + '\\Pictures', W, H, async (page) => {
    await page.evaluate(() => MF.app.setView({ view: 'grid', size: 'medium' }));
    await page.waitForTimeout(600);
    await page.evaluate(() => { MF.app.list.selectKeys(['Canyon at night.png', 'Dunes at dusk.jpg']); MF.app.list.sc.focus(); });
    await page.waitForTimeout(200);
  }],
  ['39-thispc-selected', 'mantle:thispc', W, H, async (page) => {
    const r = await page.evaluate(() => { const b = document.querySelectorAll('.ptile')[7]; const q = b.getBoundingClientRect(); return { x: q.left + 30, y: q.top + 20 }; });
    await page.mouse.click(r.x, r.y);
    await page.mouse.move(5, 740);
    await page.waitForTimeout(150);
  }],
];

/* made-up acrylic (the setlook lane's mock, calibrated to Owen's 2026-09-29 shot where a clear page read
   139,139,139 over a dark terminal): the backdrop blurred, then the light tint, as fixed layers BEHIND the
   page. The root's and body's own backgrounds paint under negative z-index layers, but in the real window
   they are ON the acrylic: so they are lifted onto layers above it, kept in step with html's class
   (.inactive). Everything shown is made up. */
function ACRYLIC(bd, theme) {
  const BG = bd === 'dark'
    ? 'repeating-linear-gradient(180deg, transparent 0 10px, rgba(204,204,204,.55) 10px 13px, transparent 13px 19px), repeating-linear-gradient(90deg, #0c0c0c 0 40px, #141414 40px 90px, #0c0c0c 90px 130px)'
    : 'linear-gradient(90deg, #ffffff 0 30%, #f3f3f3 30% 32%, #ffffff 32% 100%), #fff';
  const put = () => {
    const mk = (id, z, st) => { const d = document.createElement('div'); d.id = id; Object.assign(d.style, { position: 'fixed', inset: '0', zIndex: String(z), pointerEvents: 'none' }, st || {}); return d; };
    const d = mk('__bd', -4, { inset: '-80px', filter: 'blur(40px)', background: BG });
    const t = mk('__tint', -3, { background: theme === 'dark' ? 'rgba(32,32,32,.50)' : 'rgba(243,243,243,.50)' }); // DWM's dark frame tint when the window asks for a dark frame
    const r = mk('__root', -2), rb = mk('__body', -1);
    document.body.prepend(d, t, r, rb);
    const html = document.documentElement, body = document.body;
    const lift = (el, layer) => { const cs = getComputedStyle(el); layer.style.backgroundColor = cs.backgroundColor; layer.style.backgroundImage = cs.backgroundImage; };
    const sync = () => {
      html.style.background = ''; body.style.background = '';
      lift(html, r); lift(body, rb);
      html.style.background = 'transparent'; body.style.background = 'transparent';
    };
    sync();
    new MutationObserver(sync).observe(html, { attributes: true, attributeFilter: ['class'] });
  };
  if (document.body) put(); else document.addEventListener('DOMContentLoaded', put);
}
/* the grey (0-255) each surface reads in a shot: a point inside each region, away from its content */
async function greys(browser, png, page) {
  const pts = await page.evaluate(() => {
    const out = [];
    const at = (name, sel, fx, fy) => { const e = document.querySelector(sel); if (!e || e.hidden) return; const r = e.getBoundingClientRect(); if (!r.width) return; out.push([name, Math.round(fx(r)), Math.round(fy(r))]); };
    at('tabstrip', '#titlebar', (r) => r.left + r.width * 0.62, (r) => r.top + 5);
    at('cmdbar', '#cmdbar', (r) => r.right - 12, (r) => r.top + r.height / 2);
    at('navpane', '#navpane', (r) => r.left + r.width - 14, (r) => r.bottom - 6);
    at('list', '#main', (r) => r.right - 24, (r) => r.bottom - 8);
    at('side', '#side', (r) => r.right - 8, (r) => r.bottom - 8);
    at('status', '#status', (r) => r.left + r.width * 0.55, (r) => r.top + r.height / 2);
    const sel = document.querySelector('.cell.sel');
    if (sel) { const r = sel.getBoundingClientRect(); out.push(['selected', Math.round(r.right - 6), Math.round(r.top + r.height / 2)]); }
    return out;
  });
  const p = await browser.newPage();
  const vals = await p.evaluate(async ([b64, list]) => {
    const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const g = c.getContext('2d'); g.drawImage(img, 0, 0);
    return list.map(([n, x, y]) => { const d = g.getImageData(Math.min(x, c.width - 1), Math.min(y, c.height - 1), 1, 1).data; return `${n} ${d[0]},${d[1]},${d[2]}`; });
  }, [png.toString('base64'), pts]);
  await p.close();
  return vals.join('  ');
}

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
    // FILES_BD shots are about the look: they keep the page's own scrollbars (Playwright hides them by default)
    browser = await chromium.launch({ headless: true, executablePath: exe, ignoreDefaultArgs: BDS[0] ? ['--hide-scrollbars'] : [] });
    for (const [name0, start, w, h, setup] of SHOTS) {
      if (want.length && !want.some((x) => name0.includes(x))) continue;
      for (const bd of BDS) {
      const name = bd ? `${name0}-${bd}` : name0;
      const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
      if (THEME) await page.addInitScript(`(${THEME_INIT.toString()})(${JSON.stringify(THEME)});`);
      if (bd) await page.addInitScript(`(${ACRYLIC.toString()})(${JSON.stringify(bd)}, ${JSON.stringify(THEME)});`);
      page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
      page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: console: ${m.text()}`); });
      await page.goto(`${PAGE}?path=${encodeURIComponent(start)}`);
      try {
        await page.waitForFunction(() => document.documentElement.dataset.ready === '1' && window.MF && MF.app && !MF.app.cur().loading, null, { timeout: 8000 });
        await page.waitForTimeout(150);
        if (setup) await setup(page);
        await page.waitForTimeout(250);
      } catch (e) { errors.push(`${name}: did not settle (${String(e.message).split(/\r?\n/)[0]})`); }
      const png = await page.screenshot({ path: path.join(OUT, `${name}.png`) });
      if (bd) console.log(`GREY ${name}: ${await greys(browser, png, page)}`);
      const over = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      if (over) errors.push(`${name}: the page scrolls sideways at ${w} px`);
      const toastErr = await page.evaluate(() => [...document.querySelectorAll('.toast.err .tt')].map((x) => x.textContent));
      if (toastErr.length && !name.includes('failure')) errors.push(`${name}: unexpected error toast: ${toastErr.join(' | ')}`);
      made++;
      await page.close();
      }
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
