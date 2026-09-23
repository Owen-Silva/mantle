require('C:/Users/user/dev-tools/tools/lowcpu.js');
/* shoot.js — headless screenshots of the Alt+Tab overlay, plus the two measurements that matter.
 *
 * Line 1 is the machine-wide CPU cap and browser lock (one headless browser at a time, a few cores,
 * below-normal priority). Required, not optional.
 *
 * Nothing here runs Electron, the sidecar or a keyboard hook, and nothing is ever switched: the
 * page loads over file:// with mock-mantle.js playing main (see its header).
 *
 * WHAT IS CHECKED, not just photographed:
 *   1. THE RECTANGLES. main registers each DWM picture at the box the page reports, and it sized
 *      the window from layout.js. So every reported box must be exactly where layout.js says tile
 *      i's preview is (margin + pad + col * (tile + gap) + inset, ...), at exactly previewW x
 *      previewH. A pixel of disagreement here is a picture drawn off its box on the real screen.
 *   2. THE PAGE'S SHARE OF THE ~100 ms: session received -> the frame with it drawn produced (two
 *      rAFs), as the page itself reports it in switcher.painted.
 *
 * Refuses to start while a game is running (the coordinator's rule, 2026-09-23).
 *
 *   node ui/switcher/shoot.js            (MANTLE_SHOOT_OUT=<dir> to choose where the PNGs go)
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { chromium } = require('C:/Users/user/other-app/node_modules/playwright-core');

const CHROME = 'C:/Users/user/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const PAGE = 'file:///C:/Users/user/mantle/ui/switcher/index.html';
const OUT = process.env.MANTLE_SHOOT_OUT ||
  'C:/Users/user/AppData/Local/Temp/claude/C--Users-owens/fe6c395c-2ffc-4958-a961-d5833371924e/scratchpad/alttab/shots';
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;

const SHOTS = [];
for (const [w, h] of [[1280, 720], [1920, 1080]]) {
  for (const n of [1, 3, 14]) SHOTS.push({ name: `${w}x${h}-n${n}`, w, h, q: `n=${n}` });
}
SHOTS.push({ name: '1280x720-n40-scrolled', w: 1280, h: 720, q: 'n=40&sel=33' });
SHOTS.push({ name: '1280x720-n0-empty', w: 1280, h: 720, q: 'n=0' });
SHOTS.push({ name: '1280x720-n3-noblur-nopics', w: 1280, h: 720, q: 'n=3&blur=0&thumbs=fail' });
SHOTS.push({ name: '1920x1080-notice', w: 1920, h: 1080, q: 'notice=1' });
SHOTS.push({ name: '1920x1080-n14-sel13', w: 1920, h: 1080, q: 'n=14&sel=13' });

function gamesRunning() {
  const out = execFileSync('powershell', ['-NoProfile', '-Command',
    '@(Get-Process javaw,Minecraft*,RobloxPlayerBeta,*Riot*,VALORANT* -ErrorAction SilentlyContinue).Count'],
  { encoding: 'utf8' }).trim();
  return out === '0' ? 0 : (Number(out) || 1);
}

(async () => {
  const games = gamesRunning();
  if (games) { console.log(`NOT RUN: ${games} game process(es) are running; screenshots wait.`); process.exit(2); }
  if (!fs.existsSync(CHROME)) throw new Error('no chromium at ' + CHROME);
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const results = [];
  const bench = [];
  let failures = 0;
  try {
    for (const s of SHOTS) {
      if (ONLY && !ONLY.some((p) => s.name.startsWith(p))) continue;
      const ctx = await browser.newContext({ viewport: { width: s.w, height: s.h }, deviceScaleFactor: 1 });
      const page = await ctx.newPage();
      const problems = [];
      page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
      page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(`console ${m.type()}: ${m.text()}`); });
      await page.goto(`${PAGE}?${s.q}`, { waitUntil: 'load' });
      await page.waitForTimeout(450);        // session, two rAFs, the backdrop's 150 ms fade
      const file = path.join(OUT, s.name + '.png');
      await page.screenshot({ path: file });

      const probe = await page.evaluate(() => {
        const m = window.__mock;
        const lay = m.lay;
        const tiles = Array.from(document.querySelectorAll('.tile'));
        const sel = tiles.findIndex((t) => t.classList.contains('is-sel'));
        const cut = tiles.filter((t) => { const e = t.querySelector('.ttl'); return e && e.scrollWidth > e.clientWidth + 1; }).length;
        const last = m.painted.filter((p) => !p.notice).slice(-1)[0] || null;
        let worst = 0;
        let checked = 0;
        if (last && lay && lay.cols) {
          const first = Number(getComputedStyle(document.documentElement).getPropertyValue('--first')) || 0;
          for (const b of last.boxes) {
            const i = Number(b.hwnd) / 16 - 100000 / 16;
            const col = i % lay.cols;
            const row = Math.floor(i / lay.cols) - first;
            const ex = m.rect.x + lay.margin + lay.pad + col * (lay.tileW + lay.gap) + lay.inset;
            const ey = m.rect.y + lay.margin + lay.pad + row * (lay.tileH + lay.gap) + lay.inset;
            worst = Math.max(worst, Math.abs(b.x - ex), Math.abs(b.y - ey), Math.abs(b.w - lay.previewW), Math.abs(b.h - lay.previewH));
            checked++;
          }
        }
        return {
          tiles: tiles.length,
          sel,
          cutTitles: cut,
          painted: m.painted.length,
          pageMs: last ? last.ms : null,
          boxes: last ? last.boxes.length : 0,
          checked,
          worstPx: Math.round(worst * 100) / 100,
          body: document.body.className,
          foot: document.getElementById('foot').textContent,
          win: lay ? `${lay.w}x${lay.h}` : null,
          grid: lay && lay.cols ? `${lay.cols}x${lay.rows}${lay.scroll ? ` (${lay.visibleRows} visible)` : ''} of ${lay.tileW}px` : null,
          whys: Array.from(document.querySelectorAll('.pv-why')).filter((e) => e.textContent).length,
        };
      });
      if (probe.worstPx > 0.5 || problems.length) failures++;
      results.push({ name: s.name, file, probe, problems });
      await ctx.close();
    }
    // THE PAGE'S SHARE, measured the way main runs it: viewport = the window (layout.js), no fake
    // desktop, 15 sessions back to back; the first two are the cold start and are reported apart.
    if (!ONLY || ONLY.includes('bench')) {
      const Layout = require('./layout.js');
      for (const [sw, sh] of [[1280, 720], [1920, 1080]]) {
        for (const n of [3, 14]) {
          const lay = Layout.layout(n, sw, sh);
          const ctx = await browser.newContext({ viewport: { width: lay.w, height: lay.h }, deviceScaleFactor: 1 });
          const page = await ctx.newPage();
          await page.goto(`${PAGE}?bench=15&n=${n}&bg=0&sw=${sw}&sh=${sh}`, { waitUntil: 'load' });
          await page.waitForFunction(() => window.__mock && window.__mock.benchDone, null, { timeout: 30000 });
          const ms = await page.evaluate(() => window.__mock.bench);
          const warm = ms.slice(2).sort((a, b) => a - b);
          const med = warm[Math.floor(warm.length / 2)];
          const p90 = warm[Math.floor(warm.length * 0.9)];
          bench.push(`bench ${sw}x${sh} n=${n} (window ${lay.w}x${lay.h}): cold ${ms[0]} / ${ms[1]} ms, warm median ${med} ms, p90 ${p90} ms, max ${warm[warm.length - 1]} ms`);
          await ctx.close();
        }
      }
    }
  } finally {
    await browser.close();
  }
  for (const r of results) {
    const p = r.probe;
    console.log(`${r.name}: win ${p.win}, grid ${p.grid || '-'}, ${p.tiles} tiles, sel ${p.sel}, ${p.boxes} boxes (${p.checked} checked, worst ${p.worstPx}px), page ${p.pageMs} ms (cold, under a full-screen fake desktop), cut titles ${p.cutTitles}, reasons ${p.whys}, body "${p.body}"${p.foot ? `, foot "${p.foot}"` : ''}`);
    for (const q of r.problems) console.log(`   PROBLEM ${q}`);
  }
  const ms = results.map((r) => r.probe.pageMs).filter((v) => typeof v === 'number');
  if (ms.length) console.log(`page share (session -> drawn): min ${Math.min(...ms)} ms, max ${Math.max(...ms)} ms over ${ms.length} sessions`);
  for (const b of bench) console.log(b);
  console.log(`${results.length} shots in ${OUT}; ${failures} with a problem`);
})().catch((err) => { console.error(err); process.exit(1); });
