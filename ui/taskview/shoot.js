require('C:/Users/user/dev-tools/tools/lowcpu.js');
/* shoot.js - headless screenshots of Task View on the mock bridge, plus what can be measured there.
 *
 *   node ui/taskview/shoot.js            (ONLY=1536x864-n7,... for a subset; MANTLE_SHOOT_OUT=dir)
 *
 * No Electron, no sidecar, no DWM: mock-mantle.js plays main and paints fake window pictures into
 * the boxes the page reports. Per shot it checks: no page errors; every visible tile inside the
 * grid area (never under the strip or the filter row, never off screen); the boxes the page
 * reported are exactly its .pv elements. Then it times the page's own share of an open (render +
 * layout) for 7, 20 and 60 windows.
 */
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { chromium } = require('C:/Users/user/other-app/node_modules/playwright-core');

const CHROME = 'C:/Users/user/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const PAGE = 'file:///C:/Users/user/mantle/ui/taskview/index.html';
const OUT = process.env.MANTLE_SHOOT_OUT ||
  'C:/Users/user/AppData/Local/Temp/claude/C--Users-owens/fe6c395c-2ffc-4958-a961-d5833371924e/scratchpad/taskview/shots';
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;

// 1536x864 is Owen's 1920x1080 screen at 125%, in DIP: the size Task View really is.
const SHOTS = [
  ['1536x864-n7', 1536, 864, 'n=7'],
  ['1536x864-n3-d1', 1536, 864, 'n=3&d=1'],
  ['1536x864-n1', 1536, 864, 'n=1'],
  ['1920x1080-n12-d3', 1920, 1080, 'n=12&d=3'],
  ['1280x720-n40-scroll', 1280, 720, 'n=40&sel=30'],
  ['1536x864-n0-empty', 1536, 864, 'n=0'],
  ['1536x864-filter', 1536, 864, 'n=9&q=code'],
  ['1536x864-filter-nomatch', 1536, 864, 'n=7&q=zzz'],
  ['1536x864-strip-focus', 1536, 864, 'n=7&d=3&zone=strip'],
  ['1536x864-rename', 1536, 864, 'n=7&d=3&rename=1'],
  ['1536x864-drag', 1536, 864, 'n=7&d=3&drag=1'],
  ['1536x864-registry', 1536, 864, 'n=7&d=2&vd=registry'],
  ['1536x864-vdfail', 1536, 864, 'n=7&vd=fail'],
  ['1536x864-nothumbs-noglass', 1536, 864, 'n=7&thumbs=fail&glass=0'],
  ['1536x864-progressive', 1536, 864, 'n=7&thumbs=none'],
  ['1536x864-notice', 1536, 864, 'n=7&notice=1'],
  ['1536x864-dark', 1536, 864, 'n=7&d=3&dark=1'],
  ['1536x864-long', 1536, 864, 'n=5&d=2&long=1'],
];

function gamesRunning() {
  const out = execFileSync('powershell', ['-NoProfile', '-Command',
    '@(Get-Process VALORANT*,javaw,Minecraft*,RobloxPlayerBeta -ErrorAction SilentlyContinue).Count'],
  { encoding: 'utf8' }).trim();
  return out === '0' ? 0 : (Number(out) || 1);
}


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
  const games = gamesRunning();
  if (games) { console.log(`NOT RUN: ${games} game process(es) are running; screenshots wait.`); process.exit(2); }
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ timeout: 0, executablePath: fs.existsSync(CHROME) ? CHROME : undefined, headless: true });
  themeEvery(browser);   // MANTLE_THEME=dark|light: <html data-theme> + the mantle-theme event, as dm-core's plumbing does
  let pass = 0, fail = 0;
  const lines = [];
  try {
    for (const [name, w, h, q] of SHOTS) {
      if (ONLY && !ONLY.some((p) => name.startsWith(p))) continue;
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
      const page = await ctx.newPage();
      const problems = [];
      page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
      page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(`console ${m.type()}: ${m.text()}`); });
      await page.goto(`${PAGE}?${q}`, { waitUntil: 'load' });
      await page.waitForTimeout(q.includes('drag') ? 420 : 260);
      await page.screenshot({ path: path.join(OUT, name + '.png') });
      const probe = await page.evaluate(() => {
        const L = window.TaskViewLayout.L;
        const top = L.stripH + L.searchH;
        const tiles = Array.from(document.querySelectorAll('.tile'));
        const bad = [];
        for (const t of tiles) {
          const r = t.getBoundingClientRect();
          if (r.top < top || r.bottom > innerHeight || r.left < 0 || r.right > innerWidth) bad.push(t.dataset.i);
        }
        const pvs = tiles.map((t) => t.querySelector('.pv').getBoundingClientRect());
        const boxes = (window.__mock && window.__mock.boxes) || [];
        const same = boxes.length === pvs.length && boxes.every((b, i) => Math.abs(b.x - pvs[i].left) < 0.5 && Math.abs(b.y - pvs[i].top) < 0.5 &&
                                                                          Math.abs(b.w - pvs[i].width) < 0.5 && Math.abs(b.h - pvs[i].height) < 0.5);
        return { tiles: tiles.length, bad, same, painted: window.__mock && window.__mock.paintedAt ? Math.round(window.__mock.paintedAt - window.__mock.openAt) : null,
                 why: document.getElementById('stripWhy').textContent, foot: document.getElementById('foot').textContent };
      });
      const ok = !problems.length && !probe.bad.length && (probe.tiles === 0 || probe.same);
      if (ok) pass++; else fail++;
      lines.push(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${probe.tiles} tiles, open->painted ${probe.painted} ms${probe.bad.length ? ', OUTSIDE: ' + probe.bad.join(',') : ''}${probe.same ? '' : ', boxes != .pv'}${problems.length ? ', ' + problems.join(' | ') : ''}`);
      await ctx.close();
    }
    if (!ONLY) {
      for (const n of [7, 20, 60]) {
        const ctx = await browser.newContext({ viewport: { width: 1536, height: 864 }, deviceScaleFactor: 1 });
        const page = await ctx.newPage();
        await page.goto(`${PAGE}?bench=15&n=${n}`, { waitUntil: 'load' });
        await page.waitForTimeout(100);
        const b = await page.evaluate(() => window.__mock.bench);
        lines.push(`bench n=${n}: page render+layout median ${b.median.toFixed(2)} ms, max ${b.max.toFixed(2)} ms`);
        await ctx.close();
      }
    }
  } finally {
    await browser.close();
  }
  for (const l of lines) console.log(l);
  console.log(`shots in ${OUT}`);
  console.log(`TASKVIEW SHOTS: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
