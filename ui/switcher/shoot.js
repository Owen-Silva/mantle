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
 *   3. THE TEXT'S CONTRAST, as rendered: for every caption, chip, foot, empty and notice line on
 *      screen, the ink (the darkest or lightest 1% of its box, the glyph cores) against the ground
 *      (its median), read off the screenshot itself. WCAG asks 4.5:1 of text this small.
 *
 * Refuses to start while a game is running (the coordinator's rule, 2026-09-23). The games are the
 * lanes' own list (VALORANT, Minecraft, Roblox): the Riot CLIENT idles in the tray all day and is not
 * one, and counting it kept this harness from ever running (2026-09-29).
 *
 *   node ui/switcher/shoot.js            (MANTLE_SHOOT_OUT=<dir> to choose where the PNGs go)
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { chromium } = require('C:/Users/user/other-app/node_modules/playwright-core');

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
// the same over a DARK desktop: the case the glass alone could not carry text over (2026-09-23)
SHOTS.push({ name: '1920x1080-n14-dark', w: 1920, h: 1080, q: 'n=14&dark=1' });
SHOTS.push({ name: '1280x720-n3-dark', w: 1280, h: 720, q: 'n=3&dark=1' });
SHOTS.push({ name: '1280x720-n40-scrolled-dark', w: 1280, h: 720, q: 'n=40&sel=33&dark=1' });
SHOTS.push({ name: '1280x720-n0-empty-dark', w: 1280, h: 720, q: 'n=0&dark=1' });
SHOTS.push({ name: '1920x1080-notice-dark', w: 1920, h: 1080, q: 'notice=1&dark=1' });

/* Runs IN the page: decodes the screenshot and measures each visible line of text on it. */
const CONTRAST = async (b64) => {
  const img = new Image();
  img.src = 'data:image/png;base64,' + b64;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0);
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const out = [];
  const els = Array.from(document.querySelectorAll('.tile .ttl, .tile .chip, .foot, .empty, .note-t, .note-x, .pv-why'))
    .filter((e) => e.textContent.trim() && e.getClientRects().length);
  for (const e of els) {
    const r = e.getBoundingClientRect();
    const x0 = Math.max(0, Math.floor(r.left));
    const y0 = Math.max(0, Math.floor(r.top));
    const x1 = Math.min(c.width, Math.ceil(r.right));
    const y1 = Math.min(c.height, Math.ceil(r.bottom));
    if (x1 - x0 < 4 || y1 - y0 < 4) continue;
    // on screen, not clipped away with a scrolled-out row
    const hit = document.elementFromPoint((x0 + x1) / 2, (y0 + y1) / 2);
    if (!hit || !(hit === e || e.contains(hit))) continue;   // an ancestor here means it is clipped
    const d = g.getImageData(x0, y0, x1 - x0, y1 - y0).data;
    const L = [];
    for (let i = 0; i < d.length; i += 4) L.push(0.2126 * lin(d[i]) + 0.7152 * lin(d[i + 1]) + 0.0722 * lin(d[i + 2]));
    L.sort((a, b) => a - b);
    // The ground is the median (letters cover well under half the box); the ink is whichever end
    // stands off it more, so dark-on-light and light-on-dark (the warn chip) both read true.
    const ground = L[Math.floor(L.length * 0.5)];
    const cr = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    const ratio = Math.round(Math.max(cr(L[Math.floor(L.length * 0.01)], ground), cr(L[Math.floor(L.length * 0.99)], ground)) * 10) / 10;
    out.push({ what: `${e.className.split(' ')[0]} "${e.textContent.trim().slice(0, 22)}"`, ratio });
  }
  out.sort((a, b) => a.ratio - b.ratio);
  return { n: out.length, worst: out[0] || null, median: out.length ? out[Math.floor(out.length / 2)].ratio : null };
};

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
  const browser = await require('../settings/test-browser.js').launch(chromium, { timeout: 0, headless: true });
  themeEvery(browser);   // MANTLE_THEME=dark|light: <html data-theme> + the mantle-theme event, as dm-core's plumbing does
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
      const png = await page.screenshot({ path: file });
      const contrast = await page.evaluate(CONTRAST, png.toString('base64'));

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
      if (contrast.worst && contrast.worst.ratio < 4.5) problems.push(`text under 4.5:1: ${contrast.worst.what} at ${contrast.worst.ratio}:1`);
      if (probe.worstPx > 0.5 || problems.length) failures++;
      results.push({ name: s.name, file, probe, contrast, problems });
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
    const c = r.contrast;
    console.log(`   contrast: ${c.n ? `worst ${c.worst.ratio}:1 (${c.worst.what}), median ${c.median}:1 over ${c.n} lines of text` : 'no text on screen'}`);
    for (const q of r.problems) console.log(`   PROBLEM ${q}`);
  }
  const ms = results.map((r) => r.probe.pageMs).filter((v) => typeof v === 'number');
  if (ms.length) console.log(`page share (session -> drawn): min ${Math.min(...ms)} ms, max ${Math.max(...ms)} ms over ${ms.length} sessions`);
  for (const b of bench) console.log(b);
  console.log(`${results.length} shots in ${OUT}; ${failures} with a problem`);
})().catch((err) => { console.error(err); process.exit(1); });
