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
require('../../tools/dev-env.js').lowcpu();
const path = require('path');
let chromium;
({ chromium } = require('../../tools/dev-env.js').playwright());

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

/* ---- IN THE CORNER, GLIDING WITH THE BAR (lane corner-follow-card, 2026-10-17). Owen, of the banners: "this
   and anything else that comes up here needs to go in the corner not up like this ... just have them smoothly
   move up if the taskbar comes up". The window is the card plus the bar's reach (62 DIP on his screen) ABOVE it;
   main sends screenshot.lift { px, kind, ms } (lib/bar-follow.js) and ui/shared/bar-follow.js lifts #lift:
     - the card sits at the window's BOTTOM (its 12 px margin), the reach above it, lift 0;
     - up: the bar's spring (linear(), the 41 points) over main's ms, really travelling, landing 62 up;
     - down: the bar's exit (cubic-bezier(.3,0,.8,.15)), back at the bottom; ms 0: simply there;
     - the lift is a transform: the card's own size (what main sizes the window from) never changes, main is
       not told a new size;
     - its pointer and keys work WHERE IT IS (hover pauses the timer, Save, Esc) at the lifted place;
     - dark: once a glide lands, ONE new picture is asked for (hud.backdrop); light: none;
     - reduced motion: up jumps at once; down holds above the fading pill for main's ms, then jumps. */
const REACH = 62;
const FOLLOW = () => {
  const f = window.__cardFollow(), cs = getComputedStyle(document.getElementById('lift'));
  return Object.assign(f, { tf: cs.transitionTimingFunction, dur: cs.transitionDuration, paused: document.getElementById('card').classList.contains('paused'),
    sizes: window.__mock.calls.filter((x) => /card(Shown|Size)$/.test(x.name)).length,
    asks: window.__mock.calls.filter((x) => x.name === 'hud.backdrop' && x.args && x.args.why === 'the card glided with the bar').length,
    dismissed: window.__mock.calls.filter((x) => /cardDismiss$/.test(x.name)).length });
};
async function openGlide(browser, theme, motion) {
  const ctx = await browser.newContext({ viewport: { width: 420, height: 220 + REACH }, deviceScaleFactor: 1, reducedMotion: motion });
  const page = await ctx.newPage();
  await page.addInitScript((t) => {
    const set = () => { document.documentElement.dataset.theme = t; };
    if (document.documentElement) set(); else new MutationObserver((_m, o) => { if (document.documentElement) { set(); o.disconnect(); } }).observe(document, { childList: true });
  }, theme);
  await page.goto(PAGE + '?life=0&state=copied');
  await page.waitForFunction(() => { const c = document.getElementById('card'); return c && !c.hidden && window.__mock.calls.some((x) => /cardShown$/.test(x.name)); }, null, { timeout: 5000 });
  await sleep(450);                        // the card's own slide-in is over
  // dark: the mock answers the show's hud.backdrop the way main does with no picture ({ ok: false }, card-mock.js),
  // so that request is over at once (one in flight serves every request); the wait is kept as a margin
  if (theme === 'dark') await sleep(1300);
  const emit = (p) => page.evaluate((x) => window.__cardEmit('screenshot.lift', x), p);
  return { ctx, page, emit, f: () => page.evaluate(FOLLOW) };
}
async function glideChecks(browser) {
  for (const theme of ['light', 'dark']) {
    const T = theme + ' glide: ';
    const P = await openGlide(browser, theme, 'no-preference');
    const g0 = await P.f();
    check(T + 'the card sits at the window\'s bottom (12 px margin), the reach above it, no lift', g0.offBottom === 12 && g0.y === 0 && Math.abs(g0.boxBottom - (g0.inner - 12)) < 0.5 && g0.boxTop > REACH, g0);
    await P.emit({ px: REACH, kind: 'up', ms: 336 });
    const g1 = await P.f();
    check(T + 'up: on the bar\'s spring (linear(), the 41 points) over main\'s 336 ms', /^linear\(/.test(g1.tf) && g1.dur === '0.336s' && g1.glideUp, g1);
    await sleep(90);
    const gMid = await P.f();
    check(T + 'up: really travels (mid-way at ~90 ms, not a jump)', gMid.y < -5 && gMid.y > -REACH, gMid);
    await sleep(400);
    const g2 = await P.f();
    check(T + 'up: lands 62 above the corner (the card\'s bottom 12 + 62 from the window\'s)', Math.abs(g2.y + REACH) < 0.5 && Math.abs(g2.boxBottom - (g2.inner - 12 - REACH)) < 0.5, g2);
    check(T + 'the lift is a transform: the card\'s own size and place in the layout are the same, main is not told a new size',
      g2.w === g0.w && g2.h === g0.h && g2.offBottom === 12 && g2.sizes === g0.sizes, { g0, g2 });
    if (theme === 'dark') {
      await sleep(120);
      const a1 = (await P.f()).asks;
      check(T + 'dark: once the glide landed, ONE new picture of what is behind the card there is asked for', a1 === g0.asks + 1, { before: g0.asks, after: a1 });
      await P.emit({ px: REACH, kind: 'up', ms: 0 });
      await sleep(200);
      check(T + 'dark: a stand where it already is asks for nothing more', (await P.f()).asks === a1);
    } else {
      await sleep(120);
      check(T + 'light: no picture is ever asked for (nothing is baked in light)', (await P.f()).asks === 0);
    }
    // its pointer works WHERE IT IS: hover (the timer rests), then Save at the lifted place
    await P.page.hover('#card');
    await sleep(60);
    const gh = await P.f();
    check(T + 'lifted: the pointer on the card pauses its timer (hover reaches it where it is)', gh.paused, gh);
    await P.page.mouse.move(2, 2);
    await sleep(60);
    check(T + 'lifted: the pointer gone, the timer runs again', !(await P.f()).paused);
    await P.page.click('#save');
    await P.page.waitForFunction(() => !document.getElementById('folder').hidden, null, { timeout: 3000 }).catch(() => {});
    const gs = await P.f();
    const folderUp = await P.page.evaluate(() => !document.getElementById('folder').hidden);
    check(T + 'lifted: Save clicked where the card is, saved (Show in folder is up), and the card still 62 up', folderUp && Math.abs(gs.y + REACH) < 0.5, { folderUp, gs });
    await P.emit({ px: 0, kind: 'down', ms: 300 });
    const g3 = await P.f();
    check(T + 'down: on the bar\'s exit (cubic-bezier(.3,0,.8,.15)) over main\'s 300 ms', /cubic-bezier\(0\.3, 0, 0\.8, 0\.15\)/.test(g3.tf) && g3.dur === '0.3s' && !g3.glideUp, g3);
    await sleep(420);
    const g4 = await P.f();
    check(T + 'down: back in the corner, at the window\'s bottom', Math.abs(g4.y) < 0.5 && g4.offBottom === 12 && Math.abs(g4.boxBottom - (g4.inner - 12)) < 0.5, g4);
    await P.emit({ px: REACH, kind: 'up', ms: 0 });
    const g5 = await P.f();
    check(T + 'ms 0 (the page told where it rests before a show): simply there, no travel', Math.abs(g5.y + REACH) < 0.5, g5);
    await P.page.keyboard.press('Escape');
    await sleep(420);
    check(T + 'lifted: Esc puts the card away (the keyboard reaches it where it is)', (await P.f()).dismissed === 1);
    await P.ctx.close();
  }
  {
    const P = await openGlide(browser, 'light', 'reduce');
    await P.emit({ px: REACH, kind: 'up', ms: 336 });
    const r1 = await P.f();
    check('reduced motion: up is a jump, 62 up at once (no travel)', Math.abs(r1.y + REACH) < 0.5 && r1.dur === '0s', r1);
    await P.emit({ px: 0, kind: 'down', ms: 300 });
    await sleep(120);
    const held = await P.f();
    await sleep(320);
    const down = await P.f();
    check('reduced motion: down holds above the fading pill for main\'s 300 ms, then is in the corner', Math.abs(held.y + REACH) < 0.5 && Math.abs(down.y) < 0.5 && down.offBottom === 12, { held, down });
    await P.ctx.close();
  }
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
    await glideChecks(browser);
  } catch (e) {
    check('the run itself', false, e && e.stack ? e.stack : String(e));
  } finally {
    await browser.close().catch(() => {});
  }
  console.log(`SCREENSHOT CARD PAGE TEST: ${passed} passed, ${failures.length} failed`);
  failures.forEach((f) => console.log(`  FAIL ${f}`));
  process.exit(failures.length ? 1 : 0);
})();
