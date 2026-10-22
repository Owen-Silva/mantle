require('../../tools/dev-env.js').lowcpu();
/* tips-panel.test.js - a tooltip inside an open panel never lies over the panel's words (2026-10-17).
 *
 * The user's rule: no overlapping UI anywhere. The overlap audit (tools/overlap-audit.js, qs-sound/dark)
 * caught the quick-settings sound view's default-device tip ("Speakers (Realtek(R) Audio) is the
 * output (calls still go to ...)") lying over the next device's name and the "Volume mixer" header:
 * every device row is as wide as the panel, so every spot above or below a row is on another row,
 * and the placement (ui/shared/tips.js placeIn) ranked "inside the panel" over "covers no text".
 * The fix is in that shared placement: a spot wholly BESIDE the panel is not cut off, so there a
 * tip that covers nothing beats one inside that covers words; a full-width row also gets spots flush
 * against the panel's edge (its own side spot would straddle the edge).
 *
 * WHAT: headless Chromium over the REAL bar page (file://, never Electron), the mock's four audio
 * devices (?mode=pill&audio=4), the sound view opened the way a user does (#volume, then .qsx-more),
 * in light and dark. Each device row is hovered with the real pointer; once its tip is up:
 *   - the tip is the row's own words, and is shown;
 *   - the tip's box covers no line of text on the page (other than the row it is for);
 *   - the tip stays inside the window and off the pill.
 *
 *   node ui/shared/tips-panel.test.js        -> "TIPS PANEL TEST: n passed, m failed"
 *   TIPS_ROOT=<a mantle checkout> node ...   runs the same checks on that checkout's ui/ (for the A/B)
 */
'use strict';
const path = require('path');
const H = require('../bar/page-harness.js');
const t = H.suite('TIPS PANEL TEST');
const ROOT = process.env.TIPS_ROOT ? path.resolve(process.env.TIPS_ROOT) : path.resolve(__dirname, '..', '..');
const PAGE = 'file:///' + path.join(ROOT, 'ui', 'bar', 'index.html').replace(/\\/g, '/') + '?mode=pill&audio=4';

async function until(p, cond, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await p.evaluate(cond).catch(() => false)) return true;
    await p.waitForTimeout(80);
  }
  return false;
}

/* Every line box of text on the page that is not the tip's and not inside `skip`, as rects. */
function readScene(idx) {
  const rows = Array.from(document.querySelectorAll('.qsx-devs .qsx-dev'));
  const row = rows[idx];
  const tip = document.getElementById('mantle-tip');
  const R = (r) => ({ l: r.left, t: r.top, r: r.right, b: r.bottom });
  const out = { rows: rows.length, tip: null, text: [], bar: null, vw: innerWidth, vh: innerHeight };
  if (!tip || !row) return out;
  const cs = getComputedStyle(tip);
  const tr = tip.getBoundingClientRect();
  out.tip = { box: R(tr), words: (tip.textContent || '').trim(), shown: cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.5 && tr.width > 0 };
  out.rowWords = row.title || row.getAttribute('data-mtip') || '';
  const bar = document.getElementById('bar');
  const pop = document.getElementById('pop') || document.querySelector('.pop');
  if (bar) {
    // the pill: #bar's own box minus any open popover inside it
    const kids = Array.from(bar.children).filter((k) => k !== pop && !(pop && k.contains(pop)));
    const rs = kids.map((k) => k.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0);
    if (rs.length) out.bar = { l: Math.min(...rs.map((r) => r.left)), t: Math.min(...rs.map((r) => r.top)), r: Math.max(...rs.map((r) => r.right)), b: Math.max(...rs.map((r) => r.bottom)) };
  }
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = w.nextNode())) {
    if (!n.nodeValue.trim()) continue;
    const el = n.parentElement;
    if (!el || tip.contains(el) || row.contains(el)) continue;
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) === 0) continue;
    const rg = document.createRange();
    rg.selectNodeContents(n);
    for (const r of rg.getClientRects()) if (r.width > 0.5 && r.height > 0.5) out.text.push(Object.assign(R(r), { s: n.nodeValue.trim().slice(0, 40) }));
  }
  return out;
}

function hits(a, b) {
  const w = Math.min(a.r, b.r) - Math.max(a.l, b.l), h = Math.min(a.b, b.b) - Math.max(a.t, b.t);
  return w > 0.5 && h > 0.5 ? Math.round(w) + ' x ' + Math.round(h) : null;
}

async function run() {
  if (H.gaming()) { console.log('a game is running: skipped'); t.check('not skipped (a game was running)', false); return; }
  console.log('root ' + ROOT);
  await H.withBrowser(async (open) => {
    const pg0 = await open('?mode=pill', { w: 300, h: 100, settle: 20 });
    const browser = pg0.page.context().browser();
    for (const theme of ['light', 'dark']) {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1.25, colorScheme: theme, bypassCSP: true, reducedMotion: 'reduce' });
      await ctx.addInitScript((th) => {
        const put = () => { const el = document.documentElement; if (el && el.dataset.theme !== th) el.dataset.theme = th; };
        put(); document.addEventListener('readystatechange', put);
      }, theme);
      const p = await ctx.newPage();
      try {
        await p.goto(PAGE, { waitUntil: 'load' });
        await p.waitForTimeout(900);
        await p.click('#volume', { timeout: 3000 });
        await p.waitForTimeout(400);
        await p.click('.qsx-more', { timeout: 3000 });
        const ok = await until(p, () => document.querySelectorAll('.qsx-devs .qsx-dev').length >= 2, 4000);
        if (!t.check(`[${theme}] the sound view lists the mock's devices`, ok)) continue;
        await p.waitForTimeout(600);
        const n = await p.evaluate(() => document.querySelectorAll('.qsx-devs .qsx-dev').length);
        for (let i = 0; i < n; i++) {
          // off everything first, so each row's tip is a fresh hover
          await p.mouse.move(2, 2);
          await p.waitForTimeout(700);
          const box = await p.evaluate((k) => { const r = document.querySelectorAll('.qsx-devs .qsx-dev')[k].getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, i);
          await p.mouse.move(box.x, box.y, { steps: 4 });
          const up = await until(p, () => { const e = document.getElementById('mantle-tip'); if (!e) return false; const s = getComputedStyle(e); return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0.5 && e.getBoundingClientRect().width > 0; }, 3000);
          await p.waitForTimeout(250);
          const sc = await p.evaluate(readScene, i);
          const tag = `[${theme}] device row ${i + 1}`;
          if (!t.check(`${tag}: its tip comes up`, up && sc.tip && sc.tip.shown, sc.tip)) continue;
          const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
          t.check(`${tag}: the tip says the row's words`, !!norm(sc.rowWords) && norm(sc.tip.words).indexOf(norm(sc.rowWords)) === 0, { tip: sc.tip.words, row: sc.rowWords });
          const over = sc.text.map((r) => { const h = hits(sc.tip.box, r); return h ? '"' + r.s + '" by ' + h + ' px' : null; }).filter(Boolean);
          t.check(`${tag}: the tip covers no text`, over.length === 0, { tip: sc.tip.box, over: over.slice(0, 4) });
          const b = sc.tip.box;
          t.check(`${tag}: the tip stays inside the window`, b.l >= -0.5 && b.t >= -0.5 && b.r <= sc.vw + 0.5 && b.b <= sc.vh + 0.5, b);
          if (sc.bar) t.check(`${tag}: the tip is off the pill`, !hits(b, sc.bar), { tip: b, pill: sc.bar });
        }
      } catch (e) {
        t.check(`[${theme}] the run finished`, false, e && e.stack || String(e));
      } finally {
        await ctx.close();
      }
    }
  });
}

run().catch((e) => { t.check('the run finished', false, e && e.stack || String(e)); }).then(() => t.done());
