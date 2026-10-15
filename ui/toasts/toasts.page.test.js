/* toasts.page.test.js - Mantle's notification banners PAGE, driven for real (lane mantle-toasts, 2026-10-15).
 *
 * Headless Chromium over ui/toasts/index.html with a fake window.mantle (installed before the page's
 * scripts, so mock-mantle.js stands down). Every check pushes main's events through the page's own code,
 * moves the real mouse, clicks, and reads what the page asked main for. Nothing reaches Windows.
 * Light and dark (data-theme), with shots in MANTLE_SHOTS_DIR (default %TEMP%\mantle-toasts-shots).
 *   node ui/toasts/toasts.page.test.js   -> "TOASTS PAGE TEST: n passed, m failed"
 * LINE 1 is not optional: lowcpu.js pins this process and its browser.
 */
try { require('C:/Users/user/dev-tools/tools/lowcpu.js'); } catch (e) { if (process.env.CI !== 'true') throw e; }
const fs = require('fs');
const os = require('os');
const path = require('path');
let chromium;
try { ({ chromium } = require('playwright-core')); } catch (_) { ({ chromium } = require('C:/Users/user/other-app/node_modules/playwright-core')); }

const PAGE = 'file:///' + path.join(__dirname, 'index.html').replace(/\\/g, '/');
const SHOTS = path.resolve(process.env.MANTLE_SHOTS_DIR || path.join(os.tmpdir(), 'mantle-toasts-shots'));
const LIFE = 700, RESUME = 400;

let passed = 0; const failures = [];
function check(name, ok, detail) { if (ok) passed++; else failures.push(`${name}${detail !== undefined ? ` (${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 300)})` : ''}`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* The fake main: records every call and lets the test push events. */
const FAKE = ([life, resume, theme]) => {
  const on = {};
  const calls = [];
  window.__toastLifeMs = life;
  window.__toastResumeMs = resume;
  // an init script runs before <html> exists: the theme goes on as soon as it does
  if (theme) {
    const set = () => { document.documentElement.dataset.theme = theme; };
    if (document.documentElement) set(); else new MutationObserver((_m, o) => { if (document.documentElement) { set(); o.disconnect(); } }).observe(document, { childList: true });
  }
  window.__fake ={ calls, emit(ch, p) { (on[ch] || []).forEach((f) => f(p)); } };
  window.mantle = {
    on(ch, fn) { (on[ch] = on[ch] || []).push(fn); return () => {}; },
    call(ch, args) { calls.push({ ch, args: args === undefined ? null : JSON.parse(JSON.stringify(args)) }); return Promise.resolve({ ok: true }); },
  };
};
// a 2x1 png, so an image banner has a real picture to load
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR42mNk+M/wn4GBgYEBAAEeAQGuPakeAAAAAElFTkSuQmCC';
const ICON = PNG;
const B = (id, extra) => Object.assign({ id, aumid: 'com.owensilva.helm', app: 'Helm', icon: ICON, title: `Done in ${id}s`, body: 'The build finished and every test passed.', opens: 'app' }, extra || {});

async function open(browser, theme) {
  const ctx = await browser.newContext({ viewport: { width: 392, height: 700 }, deviceScaleFactor: 1, reducedMotion: 'no-preference' });
  const page = await ctx.newPage();
  await page.addInitScript(FAKE, [LIFE, RESUME, theme]);
  await page.goto(PAGE);
  await page.waitForFunction(() => window.__toasts && window.__fake.calls.some((c) => c.ch === 'toasts.ready'));
  const st = () => page.evaluate(() => window.__toasts.state());
  const emit = (ch, p) => page.evaluate(([c, x]) => window.__fake.emit(c, x), [ch, p]);
  const calls = (ch) => page.evaluate((c) => window.__fake.calls.filter((x) => x.ch === c).map((x) => x.args), ch);
  const until = async (fn, ms) => { const end = Date.now() + (ms || 3000); for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(40); } };
  return { ctx, page, st, emit, calls, until };
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await require('../settings/test-browser.js').launch(chromium, { headless: true });
  try {
    const inks = {};
    for (const theme of ['light', 'dark']) {
      const T = theme + ': ';
      const P = await open(browser, theme);
      const { page, st, emit, calls, until } = P;
      check(T + 'the page says it listens (toasts.ready)', (await calls('toasts.ready')).length === 1);

      // ---- one banner: what it shows, and the window size it asks for
      await emit('toasts.show', { banners: [B(1, { image: PNG, attribution: 'via Helm' })] });
      const one = await until(async () => { const s = await st(); return s.items.length === 1 && s.items[0].running ? s : null; });
      check(T + 'one banner on screen with its timer running', !!one, await st());
      const text = await page.evaluate(() => { const t = document.querySelector('.toast'); return { app: t.querySelector('.app').textContent, title: t.querySelector('.title').textContent, body: t.querySelector('.body').textContent, attr: t.querySelector('.attr').textContent, pic: !t.querySelector('.pic').hidden, icon: !!t.querySelector('.app-icon img') }; });
      check(T + 'app, title, body, attribution, picture and icon shown', text.app === 'Helm' && text.title === 'Done in 1s' && /every test/.test(text.body) && text.attr === 'via Helm' && text.pic && text.icon, text);
      const lay = await calls('toasts.layout');
      const l1 = lay[lay.length - 1];
      check(T + 'layout asked for 1 banner and a real height', l1 && l1.count === 1 && l1.h > 60 && l1.h < 400, lay);
      // measured once the slide-in has finished (transform back to none)
      await until(() => page.evaluate(() => getComputedStyle(document.querySelector('.toast')).transform === 'none'), 2000);
      const box = await page.evaluate(() => { const r = document.querySelector('.toast').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right }; });
      check(T + 'the card sits top right with room for its shadow', box.w === 360 && box.y === 8 && Math.round(392 - box.right) === 16, box);
      const looks = await page.evaluate(() => { const cs = getComputedStyle(document.querySelector('.toast')); return { bg: cs.backgroundImage + ' ' + cs.backgroundColor, radius: cs.borderTopLeftRadius, ink: getComputedStyle(document.querySelector('.title')).color }; });
      check(T + 'the island face, a rounded card', /gradient|rgba|rgb/.test(looks.bg) && parseFloat(looks.radius) >= 8, looks);
      await sleep(260);
      await page.screenshot({ path: path.join(SHOTS, `toasts-one-${theme}.png`) });
      inks[theme] = looks.ink;

      // ---- it goes by itself, and the window is told there is nothing left
      const gone = await until(async () => (await st()).items.length === 0, LIFE + 1500);
      check(T + 'it leaves by itself after its life', !!gone, await st());
      const lay2 = await calls('toasts.layout');
      check(T + 'then layout says count 0', lay2[lay2.length - 1].count === 0, lay2.slice(-2));

      // ---- hover holds it; leaving gives it RESUME more, then it goes
      await emit('toasts.show', { banners: [B(2)] });
      await until(async () => (await st()).items[0] && (await st()).items[0].running);
      // one banner with no picture: the height three of them are measured against below
      const lPlain = await until(async () => (await calls('toasts.layout')).filter((x) => x.count === 1).pop() || null);
      await page.mouse.move(200, 40);
      await sleep(LIFE + 400);
      const held = await st();
      check(T + 'hovering holds the banner past its life', held.items.length === 1 && held.hover && !held.items[0].running, held);
      await page.mouse.move(5, 650);
      const after = await until(async () => (await st()).items.length === 0, RESUME + 1500);
      check(T + 'leaving lets it go after the resume time', !!after && !(await st()).hover, await st());

      // ---- the X closes it and opens nothing
      await emit('toasts.show', { banners: [B(3)] });
      await until(async () => (await st()).items.length === 1 && (await st()).items[0].shown);
      // the mouse goes straight onto the card (page.hover waits for the slide-in to settle, and a
      // 700 ms test life can run out first); hovering holds it, then the X is there to click
      await page.mouse.move(200, 40);
      await sleep(400);
      const xOpacity = await page.evaluate(() => getComputedStyle(document.querySelector('.toast .x')).opacity);
      await page.click('.toast .x');
      const closed = await until(async () => (await st()).items.length === 0, 1500);
      check(T + 'the X shows on hover and closes the banner', !!closed && Number(xOpacity) > 0.5, xOpacity);
      check(T + 'the X opens nothing', (await calls('toasts.click')).length === 0);
      await page.mouse.move(5, 650);

      // ---- a click on the banner goes to main with what it needs, and the banner goes
      await emit('toasts.show', { banners: [B(4, { opens: 'protocol' })] });
      await until(async () => (await st()).items.length === 1 && (await st()).items[0].shown);
      await page.mouse.move(200, 40);   // hover holds it while the slide-in settles (see the X above)
      await sleep(400);
      await page.click('.toast .title');
      const clicks = await until(async () => { const c = await calls('toasts.click'); return c.length ? c : null; }, 1500);
      check(T + 'a click asks main to open it (id + opens)', clicks && clicks[0].id === 4 && clicks[0].banner.opens === 'protocol' && clicks[0].banner.aumid === 'com.owensilva.helm', clicks);
      check(T + 'the clicked banner goes', !!(await until(async () => (await st()).items.length === 0, 1500)));
      await page.mouse.move(5, 650);

      // ---- five at once: three on screen, "+2 more"; the newest on top; a click on more opens the list
      await emit('toasts.show', { banners: [B(10), B(11), B(12), B(13), B(14)] });
      const five = await until(async () => { const s = await st(); return s.items.filter((i) => i.onScreen).length === 3 && s.more ? s : null; });
      check(T + 'at most three on screen, the rest are "+2 more"', five && five.more === '+2 more', await st());
      const order = await page.evaluate(() => Array.from(document.querySelectorAll('.toast')).map((t) => Number(t.dataset.id)));
      check(T + 'newest on top', order.join(',') === '14,13,12', order);
      const lay5 = await calls('toasts.layout');
      check(T + 'the window grows for three', lay5[lay5.length - 1].count === 5 && !!lPlain && lay5[lay5.length - 1].h > lPlain.h * 2, { last: lay5.slice(-1), one: lPlain });
      await sleep(260);
      await page.screenshot({ path: path.join(SHOTS, `toasts-stack-${theme}.png`) });
      await page.click('.more');
      check(T + '"+N more" opens the list', (await until(async () => (await calls('toasts.more')).length === 1, 1500)) === true);
      check(T + 'and every banner goes', !!(await until(async () => (await st()).items.length === 0, 1500)), await st());
      await page.mouse.move(5, 650);

      // ---- a banner leaves when its toast left the notification list
      await emit('toasts.show', { banners: [B(20), B(21)] });
      await until(async () => (await st()).items.filter((i) => i.shown).length === 2);
      await emit('toasts.ids', { ids: [21, 99] });
      const kept = await until(async () => { const s = await st(); return s.items.length === 1 && s.items[0].id === 21 ? s : null; }, 1500);
      check(T + 'a toast gone from the list takes its banner with it', !!kept, await st());

      // ---- a sticky one (reminder) waits, with its X showing
      await emit('toasts.show', { banners: [B(30, { sticky: true, title: 'Standup in 5 minutes' })] });
      await sleep(LIFE + 500);
      const stick = await st();
      const sticky = stick.items.find((i) => i.id === 30);
      const sx = await page.evaluate(() => getComputedStyle(document.querySelector('.toast.sticky .x')).opacity);
      check(T + 'a sticky banner stays past its life, X showing', sticky && sticky.onScreen && !sticky.running && Number(sx) > 0.5, { stick, sx });
      check(T + 'the plain one beside it went', !stick.items.some((i) => i.id === 21));
      await page.click('.toast.sticky .x');
      await until(async () => (await st()).items.length === 0, 1500);

      // ---- words are text, never markup; no icon = the app's letter
      await emit('toasts.show', { banners: [B(40, { icon: null, app: 'discord', title: '<img src=x onerror="window.__pwned=1">', body: '<b>bold</b>' })] });
      await until(async () => (await st()).items.length === 1);
      const safe = await page.evaluate(() => ({ pwned: !!window.__pwned, title: document.querySelector('.toast .title').textContent, imgs: document.querySelectorAll('.toast .title img').length, letter: (document.querySelector('.toast .letter') || {}).textContent }));
      check(T + 'title/body are plain text', !safe.pwned && safe.imgs === 0 && /^<img/.test(safe.title), safe);
      check(T + 'no icon: the app\'s letter', safe.letter === 'D', safe);
      await P.ctx.close();
    }
    check('light and dark draw different ink (the theme reaches the page)', inks.light && inks.dark && inks.light !== inks.dark, inks);
  } finally {
    await browser.close();
  }
  console.log(`TOASTS PAGE TEST: ${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log('  FAIL ' + f);
  console.log(`shots: ${SHOTS}`);
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.log('TOASTS PAGE TEST: crashed: ' + (e && e.stack)); process.exit(1); });
