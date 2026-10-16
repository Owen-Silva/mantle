/* card.page.test.js - the screenshot card is as wide as what is on it (lane mantle-toasts3, 2026-10-15).
 *
 * Owen: "the screenshot pop up thing in the bottom right can be not as long now since there only one
 * button now". Headless Chromium over the REAL ui/screenshot/card.html with its own card-mock.js (never
 * Electron, never a window of Owen's), light and dark:
 *   - a copied capture (Save only) is narrower than the old fixed 372 px, and everything on it fits
 *     (no word cut, Save inside the face);
 *   - the size main sizes the WINDOW from (cardShown { w, h }) is the card's own, so the window shrinks
 *     with it (main adds the 12 px margin each side, lib/features/screenshot.js cardSpot);
 *   - after Save the card grows to fit Show in folder + Copy path, and main is told (cardSize);
 *   - "Copy path" -> "Path copied" (no explicit resize in card.js): if the card changes size, main is told
 *     (the ResizeObserver), so the window never cuts it;
 *   - a long reason (Not saved: ...) still wraps inside the old 372 px at most.
 *   node ui/screenshot/card.page.test.js   -> "SCREENSHOT CARD PAGE TEST: n passed, m failed"
 * LINE 1 is not optional: lowcpu.js pins this process and its browser.
 */
try { require('C:/Users/user/dev-tools/tools/lowcpu.js'); } catch (e) { if (process.env.CI !== 'true') throw e; }
const path = require('path');
let chromium;
try { ({ chromium } = require('playwright-core')); } catch (_) { ({ chromium } = require('C:/Users/user/other-app/node_modules/playwright-core')); }

const PAGE = 'file:///' + path.join(__dirname, 'card.html').replace(/\\/g, '/');
let passed = 0; const failures = [];
function check(name, ok, detail) { if (ok) passed++; else failures.push(`${name}${detail !== undefined ? ` (${JSON.stringify(detail).slice(0, 400)})` : ''}`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* the card's box, each visible piece's box, and whether any text is cut */
const MEASURE = () => {
  const c = document.getElementById('card'), r = c.getBoundingClientRect();
  const vis = (e) => e && !e.hidden && getComputedStyle(e).display !== 'none' && e.offsetWidth > 0;
  const parts = ['open', 'title', 'status', 'warn', 'save', 'folder', 'copy-path'].map((id) => document.getElementById(id)).filter(vis);
  const out = parts.filter((e) => { const b = e.getBoundingClientRect(); return b.right > r.right - 11 || b.left < r.left + 11; }).map((e) => e.id);
  const cut = ['title', 'status'].map((id) => document.getElementById(id)).filter((e) => vis(e) && e.scrollWidth > e.clientWidth + 1).map((e) => e.id);
  const calls = window.__mock.calls.filter((x) => /card(Shown|Size)$/.test(x.name)).map((x) => ({ n: x.name.replace('screenshot.', ''), w: x.args.w, h: x.args.h }));
  return { w: c.offsetWidth, h: c.offsetHeight, out, cut, calls, buttons: parts.filter((e) => e.tagName === 'BUTTON' && e.id !== 'open').map((e) => e.id) };
};

async function open(browser, theme, q) {
  const ctx = await browser.newContext({ viewport: { width: 420, height: 220 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  await page.addInitScript((t) => {
    const set = () => { document.documentElement.dataset.theme = t; };
    if (document.documentElement) set(); else new MutationObserver((_m, o) => { if (document.documentElement) { set(); o.disconnect(); } }).observe(document, { childList: true });
  }, theme);
  await page.goto(PAGE + '?life=0&' + q);
  await page.waitForFunction(() => { const c = document.getElementById('card'); return c && !c.hidden && window.__mock.calls.some((x) => /cardShown$/.test(x.name)); }, null, { timeout: 5000 });
  await sleep(150);
  return { ctx, page, m: () => page.evaluate(MEASURE) };
}

(async () => {
  const browser = await require('../settings/test-browser.js').launch(chromium, { headless: true });
  try {
    for (const theme of ['light', 'dark']) {
      const T = theme + ': ';
      // ---- copied, Save offered: the common card
      let P = await open(browser, theme, 'state=copied');
      let a = await P.m();
      check(T + 'copied: one button on it (Save)', a.buttons.join() === 'save', a);
      check(T + 'copied: narrower than the old fixed 372 px (no empty face right of Save)', a.w < 372 - 40 && a.w >= 240, a);
      check(T + 'copied: everything fits inside its face, no word cut', a.out.length === 0 && a.cut.length === 0, a);
      const shown = a.calls.find((c) => c.n === 'cardShown');
      check(T + 'main sizes the window from the card\'s own size (cardShown = offsetWidth x offsetHeight)', shown && shown.w === a.w && shown.h === a.h, a.calls);
      // ---- Save: the card grows for its two buttons, and main hears the new size
      await P.page.click('#save');
      await P.page.waitForFunction(() => !document.getElementById('folder').hidden, null, { timeout: 3000 });
      await sleep(150);
      const b = await P.m();
      check(T + 'saved: Show in folder + Copy path, both inside the face', b.buttons.join() === 'folder,copy-path' && b.out.length === 0 && b.cut.length === 0, b);
      check(T + 'saved: the card is wider than the copied one, at most the old 372', b.w > a.w && b.w <= 372, { a: a.w, b: b.w });
      const last = b.calls[b.calls.length - 1];
      check(T + 'saved: main was told the new size (cardSize)', last && last.n === 'cardSize' && last.w === b.w && last.h === b.h, b.calls);
      // ---- Copy path -> "Path copied": whatever it does to the size, main knows
      await P.page.click('#copy-path');
      await P.page.waitForFunction(() => /copied/i.test(document.getElementById('copy-path').textContent), null, { timeout: 3000 });
      await sleep(150);
      const c = await P.m();
      const lc = c.calls[c.calls.length - 1];
      check(T + '"Path copied": the size main last heard is the card\'s size now (the window never cuts it)', lc && lc.w === c.w && lc.h === c.h && c.out.length === 0, c);
      await P.ctx.close();
      // ---- a long reason wraps inside the old width at most
      P = await open(browser, theme, 'state=nosave');
      const d = await P.m();
      check(T + 'a long "Not saved" reason: the card stops at 372 and the reason wraps inside it', d.w === 372 && d.out.length === 0 && d.h > a.h, d);
      await P.ctx.close();
      // ---- the Copy text card: no picture, no buttons, still fits its words
      P = await open(browser, theme, 'state=text');
      const e = await P.m();
      check(T + 'Copy text card: fits its words, no wider than 372', e.w >= 240 && e.w <= 372 && e.cut.length === 0, e);
      await P.ctx.close();
    }
  } catch (e) {
    check('the run itself', false, e && e.stack ? e.stack : String(e));
  } finally {
    await browser.close().catch(() => {});
  }
  console.log(`SCREENSHOT CARD PAGE TEST: ${passed} passed, ${failures.length} failed`);
  failures.forEach((f) => console.log(`  FAIL ${f}`));
  process.exit(failures.length ? 1 : 0);
})();
