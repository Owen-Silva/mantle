require('../../tools/dev-env.js').lowcpu();
/* shoot.js - headless screenshots of the snap window (picker, Snap Assist, notice), plus checks.
 *
 * Line 1 is the machine-wide CPU cap and browser lock. Required, not optional.
 *
 * Nothing here runs Electron, the sidecar or a keyboard hook, and no window is ever moved: the page
 * loads over file:// with mock-mantle.js playing main.
 *
 * CHECKED, not just photographed:
 *   1. THE BOXES main would register DWM pictures at: inside the window, inside the pane, never
 *      overlapping, all the same size, 16:10, whole rows only (none cut by the pane's edge).
 *   2. THE KEYBOARD: arrows, digits, Enter and Esc in the picker; arrows, paging and Enter in
 *      Snap Assist; Esc and Enter on the notice. What the page sends main is read back.
 *   3. THE PAGE'S SHARE of the reveal: snap.show -> the frame drawn (two rAFs), as it reports it.
 *
 *   node ui/snap/shoot.js            (MANTLE_SHOOT_OUT=<dir> to choose where the PNGs go)
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { chromium } = require('../../tools/dev-env.js').playwright();

const PAGE = require('url').pathToFileURL(path.join(__dirname, 'index.html')).href;
const OUT = process.env.MANTLE_SHOOT_OUT ||
  path.join(require('os').tmpdir(), 'mantle-shots', 'snap');

// Window sizes in DIP, as main makes them on the user's 1920x1080 @ 125 % screen (1536 x 864 DIP).
const PICKER = { w: 400, h: 268 };
const NOTICE = { w: 440, h: 132 };
const HALF = { w: 768, h: 864 };
const QUARTER = { w: 768, h: 432 };
const THIRD = { w: 512, h: 864 };

const SHOTS = [
  { name: 'picker', vp: PICKER, q: 'mode=picker' },
  { name: 'picker-dark', vp: PICKER, q: 'mode=picker&dark=1' },
  { name: 'notice', vp: NOTICE, q: 'mode=notice' },
  { name: 'notice-dark', vp: NOTICE, q: 'mode=notice&dark=1' },
  { name: 'assist-half-n4', vp: HALF, q: 'mode=assist&n=4' },
  { name: 'assist-half-n1', vp: HALF, q: 'mode=assist&n=1' },
  { name: 'assist-half-n0', vp: HALF, q: 'mode=assist&n=0' },
  { name: 'assist-half-n14', vp: HALF, q: 'mode=assist&n=14' },
  { name: 'assist-half-n30', vp: HALF, q: 'mode=assist&n=30' },
  { name: 'assist-quarter-n5', vp: QUARTER, q: 'mode=assist&n=5&zone=bottom-left quarter' },
  { name: 'assist-third-n6', vp: THIRD, q: 'mode=assist&n=6&zone=right third' },
  { name: 'assist-half-nopics', vp: HALF, q: 'mode=assist&n=4&thumbs=fail' },
  { name: 'assist-half-n4-dark', vp: HALF, q: 'mode=assist&n=4&dark=1' },
];

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) pass++; else { fail++; console.log('FAIL ' + name + (detail ? '  -- ' + detail : '')); }
}

function gamesRunning() {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      '@(Get-Process VALORANT*,javaw,Minecraft*,RobloxPlayerBeta -ErrorAction SilentlyContinue).Count'], { encoding: 'utf8' });   // not *Riot*: the launcher idles in the tray (as screenshot/switcher)
    return Number(out.trim()) > 0;
  } catch (_) { return false; }
}

async function open(browser, s) {
  const ctx = await browser.newContext({ viewport: { width: s.vp.w, height: s.vp.h }, deviceScaleFactor: 1.25 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(PAGE + '?' + s.q);
  await page.waitForFunction(() => window.__mock && window.__mock.painted.length > 0, null, { timeout: 5000 });
  await page.waitForTimeout(60);
  return { ctx, page, errors };
}

async function boxesCheck(page, s) {
  const r = await page.evaluate(() => {
    const p = window.__mock.painted[window.__mock.painted.length - 1];
    const pane = document.getElementById('panel').getBoundingClientRect();
    return { boxes: p.boxes, ms: p.ms, pane: { x: pane.left, y: pane.top, r: pane.right, b: pane.bottom }, vw: innerWidth, vh: innerHeight,
             n: window.__snap.cands.length };
  });
  const b = r.boxes;
  const n = Number((/n=(\d+)/.exec(s.q) || [])[1] || 0);
  if (n === 0) { check(`${s.name}: no boxes with no windows`, b.length === 0); return r; }
  check(`${s.name}: a box per visible window (${b.length} of ${n})`, b.length > 0 && b.length <= n);
  check(`${s.name}: every box inside the pane`, b.every((x) => x.x >= r.pane.x && x.y >= r.pane.y && x.x + x.w <= r.pane.r + 0.5 && x.y + x.h <= r.pane.b + 0.5),
    JSON.stringify(b[b.length - 1]) + ' pane ' + JSON.stringify(r.pane));
  check(`${s.name}: all boxes one size, 16:10`, b.every((x) => Math.abs(x.w - b[0].w) < 0.5 && Math.abs(x.h - b[0].h) < 0.5) &&
    Math.abs(b[0].w / b[0].h - 1.6) < 0.03, JSON.stringify(b[0]));
  let overlap = false;
  for (let i = 0; i < b.length; i++) for (let j = i + 1; j < b.length; j++) {
    const A = b[i], B = b[j];
    if (A.x < B.x + B.w && B.x < A.x + A.w && A.y < B.y + B.h && B.y < A.y + A.h) overlap = true;
  }
  check(`${s.name}: no two boxes overlap`, !overlap);
  return r;
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
  if (gamesRunning()) { console.log('a game is running: no headless browser now'); process.exit(3); }
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await require('../settings/test-browser.js').launch(chromium, { timeout: 0, headless: true });
  themeEvery(browser);   // MANTLE_THEME=dark|light: <html data-theme> + the mantle-theme event, as dm-core's plumbing does
  const ms = [];
  try {
    for (const s of SHOTS) {
      const { ctx, page, errors } = await open(browser, s);
      if (/assist/.test(s.name)) {
        const r = await boxesCheck(page, s);
        if (typeof r.ms === 'number') ms.push(r.ms);
      }
      await page.screenshot({ path: path.join(OUT, s.name + '.png') });
      check(`${s.name}: no console errors`, errors.length === 0, errors.join(' | '));
      await ctx.close();
    }

    // ---- keyboard: the picker
    {
      const { ctx, page } = await open(browser, SHOTS[0]);
      const sel = () => page.evaluate(() => { const p = window.__snap.pick; return p.li + ':' + p.zi; });
      check('picker: starts on the first zone of the first layout', await sel() === '0:0');
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('ArrowRight');
      check('picker: Right walks off the end of Halves into Thirds', await sel() === '1:0', await sel());
      await page.keyboard.press('ArrowLeft');
      check('picker: Left walks back', await sel() === '0:1', await sel());
      await page.keyboard.press('ArrowDown');
      check('picker: Down jumps a row of layouts (Halves -> Quarters), keeping the zone', await sel() === '3:1', await sel());
      await page.keyboard.press('ArrowUp');
      check('picker: Up jumps back', await sel() === '0:1', await sel());
      await page.keyboard.press('5');
      check('picker: 5 picks Four columns', await sel() === '4:0', await sel());
      await page.keyboard.press('Shift+Tab');
      check('picker: Shift+Tab steps back into Quarters\' last zone', await sel() === '3:3', await sel());
      await page.keyboard.press('Enter');
      let picks = await page.evaluate(() => window.__mock.picks);
      check('picker: Enter sends snap.pick {layout, zone}', picks.length === 1 && picks[0].layout === 'quarters' && picks[0].zone === 3, JSON.stringify(picks));
      await page.click('.layout:nth-child(3) .zone:nth-child(2)');
      picks = await page.evaluate(() => window.__mock.picks);
      check('picker: a click sends that zone', picks.length === 2 && picks[1].layout === 'wide' && picks[1].zone === 1, JSON.stringify(picks[1]));
      await page.keyboard.press('Escape');
      const dis = await page.evaluate(() => window.__mock.dismissed);
      check('picker: Esc sends snap.dismiss', dis.length === 1 && dis[0].why === 'esc');
      await page.mouse.click(4, 4);
      const dis2 = await page.evaluate(() => window.__mock.dismissed);
      check('picker: a click on the margin outside the pane is a click-away', dis2.length === 2 && dis2[1].why === 'click-away');
      await ctx.close();
    }

    // ---- keyboard: Snap Assist, with paging
    {
      const { ctx, page } = await open(browser, SHOTS.find((s) => s.name === 'assist-half-n30'));
      const st = () => page.evaluate(() => ({ sel: window.__snap.sel, first: window.__snap.first, cols: window.__snap.lay.cols,
        vis: window.__snap.lay.vis, rows: window.__snap.lay.rows, painted: window.__mock.painted.length }));
      let s0 = await st();
      check('assist: 30 windows in a half do not all fit, so rows page', s0.rows > s0.vis, JSON.stringify(s0));
      await page.keyboard.press('ArrowRight');
      let s1 = await st();
      check('assist: Right moves the selection', s1.sel === 1);
      for (let i = 0; i < s0.vis; i++) await page.keyboard.press('ArrowDown');
      await page.waitForTimeout(80);
      let s2 = await st();
      check('assist: Down past the last visible row scrolls a whole row and re-reports the boxes', s2.first >= 1 && s2.painted > s0.painted, JSON.stringify(s2));
      await page.keyboard.press('Home');
      await page.waitForTimeout(80);
      const s3 = await st();
      check('assist: Home goes back to the first window and the first row', s3.sel === 0 && s3.first === 0);
      await page.keyboard.press('End');
      await page.keyboard.press('Enter');
      const picks = await page.evaluate(() => window.__mock.picks);
      check('assist: End + Enter picks the last window by hwnd', picks.length === 1 && picks[0].hwnd === '1029', JSON.stringify(picks));
      await page.keyboard.press('Escape');
      check('assist: Esc dismisses', (await page.evaluate(() => window.__mock.dismissed.length)) === 1);
      await ctx.close();
    }

    // ---- the notice
    {
      const { ctx, page } = await open(browser, SHOTS.find((s) => s.name === 'notice'));
      const txt = await page.evaluate(() => document.getElementById('noticeText').textContent);
      check('notice: says why, in words', /administrator/.test(txt));
      await page.keyboard.press('Enter');
      check('notice: Enter or Esc dismisses', (await page.evaluate(() => window.__mock.dismissed.length)) === 1);
      await ctx.close();
    }

    // ---- no pictures: the reason is in each box
    {
      const { ctx, page } = await open(browser, SHOTS.find((s) => s.name === 'assist-half-nopics'));
      await page.waitForTimeout(50);
      const why = await page.evaluate(() => Array.from(document.querySelectorAll('.pv-why')).map((e) => e.textContent));
      check('no pictures: every box says why', why.length === 4 && why.every((w) => /no picture/.test(w)), JSON.stringify(why));
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
  ms.sort((a, b) => a - b);
  console.log(`  note: page share of the reveal (snap.show -> frame drawn) median ${ms[ms.length >> 1]} ms, max ${ms[ms.length - 1]} ms`);
  console.log(`  note: shots in ${OUT}`);
  console.log(`snap shots: ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})();
