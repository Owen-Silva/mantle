/* toasts.page.test.js - Mantle's notification banners PAGE, driven for real (lane mantle-toasts, 2026-10-15).
 *
 * Headless Chromium over ui/toasts/index.html with a fake window.mantle (installed before the page's
 * scripts, so mock-mantle.js stands down). Every check pushes main's events through the page's own code,
 * moves the real mouse, clicks, and reads what the page asked main for. Nothing reaches Windows.
 * Light and dark (data-theme), with shots in MANTLE_SHOTS_DIR (default %TEMP%\mantle-toasts-shots).
 * Mantle's own banners (lib/own-banners.js) too: words, buttons, progress, detail + Copy, update in place,
 * a button disabled while it runs, the X and toasts.drop; their PNGs go to MANTLE_SHOT_DIR when it is set.
 *   node ui/toasts/toasts.page.test.js   -> "TOASTS PAGE TEST: n passed, m failed"
 * LINE 1 is not optional: lowcpu.js pins this process and its browser.
 */
require('../../tools/dev-env.js').lowcpu();
const fs = require('fs');
const os = require('os');
const path = require('path');
let chromium;
({ chromium } = require('../../tools/dev-env.js').playwright());

const PAGE = 'file:///' + path.join(__dirname, 'index.html').replace(/\\/g, '/');
const SHOTS = path.resolve(process.env.MANTLE_SHOTS_DIR || path.join(os.tmpdir(), 'mantle-toasts-shots'));
// Mantle's own banners (the updater's): PNGs of available / progress / error, light and dark, only when this is set
const OWN_SHOTS = process.env.MANTLE_SHOT_DIR ? path.resolve(process.env.MANTLE_SHOT_DIR) : null;
const LIFE = 700, RESUME = 400;

let passed = 0; const failures = [];
function check(name, ok, detail) { if (ok) passed++; else failures.push(`${name}${detail !== undefined ? ` (${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 300)})` : ''}`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const zlib = require('zlib');
/* A transparent screenshot (omitBackground) decoded, so a pixel OFF the card can be read: its alpha is
   what Windows composites over the desktop there (ui/shared/seethru.test.js's decoder). */
function decodePng(buf) {
  let p = 8, w = 0, h = 0, ct = 0; const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('ascii', p + 4, p + 8), d = buf.slice(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); ct = d[9]; } else if (type === 'IDAT') idat.push(d); else if (type === 'IEND') break;
    p += 12 + len;
  }
  const bpp = ct === 6 ? 4 : 3, raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * bpp, px = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = raw.slice(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[y * stride + x - bpp] : 0, b = y ? px[(y - 1) * stride + x] : 0, c = (x >= bpp && y) ? px[(y - 1) * stride + x - bpp] : 0;
      let v = src[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c); }
      px[y * stride + x] = v & 255;
    }
  }
  return { w, h, at: (x, y) => { const i = y * stride + x * bpp; return [px[i], px[i + 1], px[i + 2], bpp === 4 ? px[i + 3] : 255]; } };
}

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
  // answer[ch](args) -> what main answers (a value or a promise); none = { ok: true }
  window.__fake ={ calls, answer: {}, emit(ch, p) { (on[ch] || []).forEach((f) => f(p)); } };
  window.mantle = {
    on(ch, fn) { (on[ch] = on[ch] || []).push(fn); return () => {}; },
    call(ch, args) {
      calls.push({ ch, args: args === undefined ? null : JSON.parse(JSON.stringify(args)) });
      const a = window.__fake.answer[ch];
      return a ? Promise.resolve(a(args)) : Promise.resolve({ ok: true });
    },
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
      // the pointer on the stack HOLDS it while it is measured (its life here is only LIFE ms); let go below
      await page.mouse.move(200, 640);
      const text = await page.evaluate(() => { const t = document.querySelector('.toast'); return { app: t.querySelector('.app').textContent, title: t.querySelector('.title').textContent, body: t.querySelector('.body').textContent, attr: t.querySelector('.attr').textContent, pic: !t.querySelector('.pic').hidden, icon: !!t.querySelector('.app-icon img') }; });
      check(T + 'app, title, body, attribution, picture and icon shown', text.app === 'Helm' && text.title === 'Done in 1s' && /every test/.test(text.body) && text.attr === 'via Helm' && text.pic && text.icon, text);
      const lay = await calls('toasts.layout');
      const l1 = lay[lay.length - 1];
      check(T + 'layout asked for 1 banner and a real height', l1 && l1.count === 1 && l1.h > 60 && l1.h < 400, lay);
      // measured once the slide-in has finished (transform back to none)
      await until(() => page.evaluate(() => getComputedStyle(document.querySelector('.toast')).transform === 'none'), 2000);
      const box = await page.evaluate(() => { const r = document.querySelector('.toast').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right }; });
      // bottom right (lane mantle-toasts3): the card sits 16 px in from the window's right and bottom, and
      // the shape main is asked for is the card + 16 below + 8 above
      check(T + 'the card sits at the bottom right of its column, 16 px in', box.w === 360 && Math.round(700 - (box.y + box.h)) === 16 && Math.round(392 - box.right) === 16, box);
      check(T + 'the shape asked for is the card + 8 above + 16 below', l1 && Math.abs(l1.h - (700 - box.y + 8)) <= 1, { l1, box });
      // OFF THE CARD IS SEE-THROUGH: the window's whole edge of the shape (8 px above the card, the 16 px
      // margins each side and below) reads alpha 0, so no square of shadow or glass shows round the card
      await sleep(260);
      const png = decodePng(await page.screenshot({ omitBackground: true }));
      const top = Math.round(700 - l1.h), mid = Math.round(box.y + box.h / 2);
      const edge = [];
      for (let x = 0; x < 392; x += 7) { edge.push([x, top]); edge.push([x, 699]); }
      for (let y = top; y < 700; y += 5) { edge.push([0, y]); edge.push([391, y]); }
      let worst = 0, at = null;
      for (const [x, y] of edge) { const a = png.at(x, y)[3]; if (a > worst) { worst = a; at = [x, y]; } }
      const corner = png.at(Math.round(box.right) - 1, Math.round(box.y + box.h) - 1)[3];
      const faceA = png.at(Math.round(box.x + 40), mid)[3];
      if (theme === 'dark') check(T + 'NO dark square: every pixel on the shape edge is fully see-through (alpha 0)', worst === 0, { worst, at, n: edge.length });
      // light keeps the island's soft drop, cut at the shape like every other light pop-up (241c70e held light): only its faint tail, never glass or dark
      else check(T + 'light: off the card only the light drop faint tail (alpha <= 31 of 255, 12%), as every light pop-up', worst <= 31, { worst, at, n: edge.length });
      check(T + 'outside the rounded corner is see-through and the face is not', corner <= (theme === 'dark' ? 0 : 24) && faceA > 150, { corner, faceA });
      const looks = await page.evaluate(() => { const cs = getComputedStyle(document.querySelector('.toast')); return { bg: cs.backgroundImage + ' ' + cs.backgroundColor, radius: cs.borderTopLeftRadius, ink: getComputedStyle(document.querySelector('.title')).color }; });
      check(T + 'the island face, a rounded card', /gradient|rgba|rgb/.test(looks.bg) && parseFloat(looks.radius) >= 8, looks);
      await sleep(260);
      await page.screenshot({ path: path.join(SHOTS, `toasts-one-${theme}.png`) });
      inks[theme] = looks.ink;
      await page.mouse.move(2, 2);   // let go: it gets RESUME more, then leaves by itself

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
      await page.mouse.move(200, 640);
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
      await page.mouse.move(200, 640);
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
      await page.mouse.move(200, 640);   // hover holds it while the slide-in settles (see the X above)
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
      await sleep(260);
      const order = await page.evaluate(() => Array.from(document.querySelectorAll('.toast')).map((t) => ({ id: Number(t.dataset.id), top: t.getBoundingClientRect().top })).sort((a, b) => b.top - a.top).map((x) => x.id));
      check(T + 'newest nearest the corner, older ones stacked above it', order.join(',') === '14,13,12', order);
      const moreTop = await page.evaluate(() => { const m = document.querySelector('.more'), t = Array.from(document.querySelectorAll('.toast')).map((e) => e.getBoundingClientRect().top); return m.getBoundingClientRect().bottom <= Math.min.apply(null, t) + 1; });
      check(T + '"+N more" sits on top of the stack', moreTop === true);
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

      // ---- a long title ends in an ellipsis INSIDE the card (never cut by the window's edge)
      await emit('toasts.show', { banners: [B(50, { title: 'Preparing for fresh install of every Mantle feature on the second monitor, then checking all of it again twice, and once more on the laptop screen before anyone notices that it took this long', body: 'Done in 6s' })] });
      await until(async () => (await st()).items.some((i) => i.id === 50 && i.shown));
      await page.mouse.move(200, 640);   // held while it is read
      await until(() => page.evaluate(() => { const t = document.querySelector('.toast[data-id="50"]'); return !!t && getComputedStyle(t).transform === 'none'; }), 2000);
      const long = await page.evaluate(() => {
        const t = document.querySelector('.toast[data-id="50"]'), ti = t.querySelector('.title'), c = t.getBoundingClientRect(), r = ti.getBoundingClientRect();
        const cs = getComputedStyle(ti);
        return { clamped: (function () { var f = ti.cloneNode(true); f.style.cssText = 'display:block;-webkit-line-clamp:none;overflow:visible;position:absolute;visibility:hidden;width:' + ti.clientWidth + 'px'; ti.parentNode.appendChild(f); var n = Math.round(f.getBoundingClientRect().height / parseFloat(cs.lineHeight)); f.remove(); return n > 2; })(), lines: Math.round(r.height / parseFloat(cs.lineHeight)), clamp: cs.webkitLineClamp, inside: r.right <= c.right - 11 && r.left >= c.left, cardRight: c.right, winRight: window.innerWidth };
      });
      check(T + 'a long title: two lines then an ellipsis, inside the card, the card inside the window', long.clamped && long.lines === 2 && String(long.clamp) === '2' && long.inside && long.cardRight <= long.winRight - 16, long);
      if (theme === 'light') {
        // ---- IN THE CORNER, GLIDING WITH THE BAR (lane mantle-corner, 2026-10-16)
        const g = () => page.evaluate(() => {
          const s = document.getElementById('stack'), cs = getComputedStyle(s);
          const m = /matrix\(([^)]+)\)/.exec(cs.transform);
          return { y: m ? Number(m[1].split(',')[5]) : 0, tf: cs.transitionTimingFunction, dur: cs.transitionDuration, offTop: s.offsetTop, boxTop: s.getBoundingClientRect().top, lastH: window.__toasts.state().last.h, inner: window.innerHeight };
        });
        const g0 = await g();
        check(T + 'glide: in the corner to start (no lift)', g0.y === 0, g0);
        const nLay = (await calls('toasts.layout')).length;
        await emit('toasts.lift', { px: 62, kind: 'up', ms: 560 });
        const g1 = await g();
        check(T + 'glide up: on the bar\'s spring (linear(), the 41 points) over 560 ms', /^linear\(/.test(g1.tf) && g1.dur === '0.56s', g1);
        await page.waitForTimeout(110);
        const gMid = await g();
        check(T + 'glide up: really travels (mid-way at ~110 ms, not a jump)', gMid.y < -5 && gMid.y > -62, gMid);
        await page.waitForTimeout(650);
        const g2 = await g();
        check(T + 'glide up: lands 62 above the corner', Math.abs(g2.y + 62) < 0.5, g2);
        check(T + 'glide: the stack\'s reported height ignores the lift (offsetTop, not the moved box): no new layout, same h', g2.offTop === g0.offTop && g2.boxTop < g0.boxTop - 60 && (await calls('toasts.layout')).length === nLay && g2.lastH === Math.ceil(g2.inner - g2.offTop + 8), { g0, g2 });
        await emit('toasts.lift', { px: 0, kind: 'down', ms: 240 });
        const g3 = await g();
        check(T + 'glide down: on the bar\'s exit (cubic-bezier(.3,0,.8,.15)) over 240 ms', /cubic-bezier\(0\.3, 0, 0\.8, 0\.15\)/.test(g3.tf) && g3.dur === '0.24s', g3);
        await page.waitForTimeout(340);
        const g4 = await g();
        check(T + 'glide down: back in the corner', Math.abs(g4.y) < 0.5, g4);
        // a reversal half-way (the bar toggled back): goes back from where it is, ends where the LAST message said
        await emit('toasts.lift', { px: 62, kind: 'up', ms: 560 });
        await page.waitForTimeout(90);
        const g5 = await g();
        await emit('toasts.lift', { px: 0, kind: 'down', ms: 240 });
        const g6 = await g();
        check(T + 'rapid toggle: the way back starts from where it was (no jump)', g5.y < -3 && Math.abs(g6.y - g5.y) < 8, { g5, g6 });
        await page.waitForTimeout(340);
        const g7 = await g();
        check(T + 'rapid toggle: ends in the corner', Math.abs(g7.y) < 0.5, g7);
        await emit('toasts.lift', { px: 62, kind: 'up', ms: 0 });
        const g8 = await g();
        check(T + 'ms 0 (a page made mid-reveal): simply there, no travel', Math.abs(g8.y + 62) < 0.5, g8);
        await emit('toasts.lift', { px: 0, kind: 'down', ms: 0 });
      }
      await P.ctx.close();
    }
    check('light and dark draw different ink (the theme reaches the page)', inks.light && inks.dark && inks.light !== inks.dark, inks);
    {
      // reduced motion (lane mantle-corner): the stack jumps, no travel; only opacity moves
      const ctx = await browser.newContext({ viewport: { width: 392, height: 700 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
      const page = await ctx.newPage();
      await page.addInitScript(FAKE, [LIFE, RESUME, 'light']);
      await page.goto(PAGE);
      await page.waitForFunction(() => window.__toasts && window.__fake.calls.some((c) => c.ch === 'toasts.ready'));
      await page.evaluate(([c, x]) => window.__fake.emit(c, x), ['toasts.show', { banners: [B(60)] }]);
      await page.waitForFunction(() => window.__toasts.state().items.some((i) => i.id === 60 && i.shown));
      await page.evaluate(([c, x]) => window.__fake.emit(c, x), ['toasts.lift', { px: 62, kind: 'up', ms: 560 }]);
      const r = await page.evaluate(() => { const cs = getComputedStyle(document.getElementById('stack')); const m = /matrix\(([^)]+)\)/.exec(cs.transform); return { y: m ? Number(m[1].split(',')[5]) : 0, dur: cs.transitionDuration, fades: document.getElementById('stack').getAnimations().length }; });
      check('reduced motion: the stack is simply 62 up at once (no travel), with only an opacity settle', Math.abs(r.y + 62) < 0.5 && r.dur === '0s' && r.fades <= 1, r);
      // lane mantle-corner3: the bar's pill only FADES where it rests under reduced motion, so going down the
      // stack waits out that fade (the down ms main sends) and only then jumps to the corner
      const yNow = () => page.evaluate(() => { const m = /matrix\(([^)]+)\)/.exec(getComputedStyle(document.getElementById('stack')).transform); return m ? Number(m[1].split(',')[5]) : 0; });
      await page.evaluate(([c, x]) => window.__fake.emit(c, x), ['toasts.lift', { px: 0, kind: 'down', ms: 300 }]);
      const yHeld = await yNow();
      await page.waitForTimeout(150);
      const yMid = await yNow();
      await page.waitForTimeout(260);
      const yDown = await yNow();
      check('reduced motion, the bar going: the stack holds above the fading pill for the down\'s 300 ms, then is in the corner', Math.abs(yHeld + 62) < 0.5 && Math.abs(yMid + 62) < 0.5 && Math.abs(yDown) < 0.5, { yHeld, yMid, yDown });
      await page.evaluate(([c, x]) => window.__fake.emit(c, x), ['toasts.lift', { px: 0, kind: 'down', ms: 300 }]);
      await page.evaluate(([c, x]) => window.__fake.emit(c, x), ['toasts.lift', { px: 62, kind: 'up', ms: 336 }]);
      await page.waitForTimeout(360);
      check('reduced motion: an up during the held down cancels it (the stack stays up, no late jump down)', Math.abs((await yNow()) + 62) < 0.5, await yNow());
      await ctx.close();
    }
    // ---- MANTLE'S OWN BANNERS (lib/own-banners.js: the updater's), light and dark
    if (OWN_SHOTS) fs.mkdirSync(OWN_SHOTS, { recursive: true });
    const OWN = (extra) => Object.assign({ id: -1, own: true, app: 'Mantle', icon: null, title: 'Mantle v0.2.0 is out', body: 'You are on v0.1.0. Update downloads it, installs it and restarts Mantle.',
      detail: null, progress: null, tone: 'info', actions: [{ id: 'later', label: 'Later' }, { id: 'update', label: 'Update', primary: true }], sticky: true, opens: 'none' }, extra || {});
    const inksOwn = {};
    for (const theme of ['light', 'dark']) {
      const T = theme + ' own: ';
      const P = await open(browser, theme);
      const { page, st, emit, calls, until } = P;
      const settled = (sel) => until(() => page.evaluate((s) => { const t = document.querySelector(s); return !!t && t.classList.contains('in') && getComputedStyle(t).transform === 'none'; }, sel), 2000);
      const shot = async (name) => { if (!OWN_SHOTS) return; await sleep(300); await page.screenshot({ path: path.join(OWN_SHOTS, `own-${name}-${theme}.png`) }); };
      const card = () => page.evaluate(() => {
        const t = document.querySelector('.toast.own');
        if (!t) return null;
        const q = (s) => t.querySelector(s);
        const vis = (s) => { const e = q(s); return !!e && !e.closest('[hidden]') && getComputedStyle(e).display !== 'none'; };
        return {
          app: q('.app').textContent, title: q('.title').textContent, body: q('.body').textContent, letter: (q('.letter') || {}).textContent || null,
          buttons: Array.from(t.querySelectorAll('.own-btn')).map((b) => ({ label: b.textContent, primary: b.classList.contains('primary'), disabled: b.disabled, x: b.getBoundingClientRect().x })),
          detail: vis('.own-detail') ? q('.own-detail').textContent : null, progress: vis('.own-progress') ? q('.own-pwords').textContent : null,
          pct: q('.own-ppct').textContent, ind: q('.own-bar').classList.contains('ind'), fill: q('.own-bar i').style.transform,
          note: vis('.own-note') ? q('.own-note').textContent : null, say: q('.own-copy-say').textContent,
          when: getComputedStyle(q('.when')).display, x: Number(getComputedStyle(q('.x')).opacity), xDisabled: q('.x').disabled,
          error: t.classList.contains('tone-error'), titleInk: getComputedStyle(q('.title')).color, out: t.classList.contains('out'),
        };
      });

      // ---- available: words, the M letter, buttons right-aligned with the primary last; no age, the X showing
      await emit('toasts.show', { banners: [OWN()] });
      await until(async () => (await st()).items.some((i) => i.id === -1 && i.shown));
      await settled('.toast.own');
      let c = await card();
      check(T + 'renders app, title, body and the M letter; no detail, no progress', c && c.app === 'Mantle' && c.title === 'Mantle v0.2.0 is out' && /v0\.1\.0/.test(c.body) && c.letter === 'M' && c.detail === null && c.progress === null, c);
      check(T + 'buttons: Later then Update (the primary last, nearest the corner), right-aligned', c && c.buttons.length === 2 && c.buttons[0].label === 'Later' && c.buttons[1].label === 'Update' && c.buttons[1].primary && !c.buttons[0].primary && c.buttons[1].x > c.buttons[0].x, c && c.buttons);
      const rightGap = await page.evaluate(() => { const t = document.querySelector('.toast.own').getBoundingClientRect(), b = document.querySelector('.toast.own .own-btn.primary').getBoundingClientRect(); return Math.round(t.right - b.right); });
      check(T + 'the primary button ends at the card\'s right padding (right-aligned row)', rightGap >= 8 && rightGap <= 16, rightGap);
      check(T + 'sticky: the X shows, no "now" age', c && c.x > 0.5 && c.when === 'none', c);
      const s0 = await st();
      check(T + 'it is sticky (no timer) and own in the page state', s0.items[0].own === true && s0.items[0].sticky === true && s0.items[0].running === false, s0.items);
      await shot('available');
      // ---- a click on the body opens nothing
      await page.click('.toast.own .title');
      await sleep(250);
      check(T + 'a click on the card\'s body does not call toasts.click and the card stays', (await calls('toasts.click')).length === 0 && (await st()).items.some((i) => i.id === -1 && !i.leaving));

      // ---- a button disables itself while its action runs: a double click is ONE toasts.action
      await page.evaluate(() => { window.__fake.answer['toasts.action'] = () => new Promise((r) => { window.__release = r; }); });
      const pb = await page.evaluate(() => { const r = document.querySelector('.toast.own .own-btn.primary').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
      await page.mouse.dblclick(pb.x, pb.y);
      await sleep(150);
      c = await card();
      const acts1 = await calls('toasts.action');
      check(T + 'double click on Update: one toasts.action { id:-1, action:"update" }, the button disabled while it runs', acts1.length === 1 && acts1[0].id === -1 && acts1[0].action === 'update' && c.buttons[1].disabled === true && c.buttons[0].disabled === false, { acts1, b: c.buttons });
      check(T + 'the page state lists it as pending', (await st()).items[0].pending.includes('update'));
      await page.evaluate(() => window.__release({ ok: true, keep: true, reason: null }));
      await sleep(100);
      c = await card();
      check(T + 'answered (keep:true): the button works again, the card stays', c && c.buttons[1].disabled === false && !c.out, c && c.buttons);

      // ---- a failure answer shows its reason on the card
      await page.evaluate(() => { window.__fake.answer['toasts.action'] = () => ({ ok: false, keep: true, reason: 'git is not on PATH' }); });
      await page.click('.toast.own .own-btn.primary');
      await until(async () => (await card()).note);
      c = await card();
      check(T + 'ok:false: the reason shows on the card in words', c.note === 'git is not on PATH' && !c.out, c.note);
      await page.evaluate(() => { delete window.__fake.answer['toasts.action']; });

      // ---- update IN PLACE: the same element, no exit/enter, progress text, % and the bar
      await page.evaluate(() => { window.__ownEl = document.querySelector('.toast.own'); });
      const nLayBefore = (await calls('toasts.layout')).length;
      await emit('toasts.update', { banner: OWN({ title: 'Updating Mantle', body: '', actions: [], progress: { text: 'Downloading v0.2.0...', pct: 42 } }) });
      await sleep(80);
      c = await card();
      const same = await page.evaluate(() => ({ same: document.querySelector('.toast.own') === window.__ownEl, n: document.querySelectorAll('.toast.own').length, in: window.__ownEl.classList.contains('in'), anims: window.__ownEl.getAnimations().length }));
      check(T + 'update in place: the SAME card (one, still in, no exit, enter or slide of its own)', same.same && same.n === 1 && same.in && !c.out && same.anims === 0, same);
      check(T + 'progress: the words, 42% and the bar at 0.42; the note and buttons gone', c.progress === 'Downloading v0.2.0...' && c.pct === '42%' && !c.ind && /scaleX\(0\.42\)/.test(c.fill) && c.note === null && c.buttons.length === 0 && c.title === 'Updating Mantle', c);
      check(T + 'a height change in place re-asks the window\'s shape (toasts.layout)', !!(await until(async () => (await calls('toasts.layout')).length > nLayBefore, 1000)));
      await shot('progress');
      await emit('toasts.update', { banner: OWN({ title: 'Updating Mantle', body: '', actions: [], progress: { text: 'Installing...', pct: null } }) });
      await sleep(60);
      c = await card();
      check(T + 'pct null: indeterminate (a sliding bar, no %)', c.progress === 'Installing...' && c.ind && c.pct === '', c);
      const slide = await page.evaluate(() => document.querySelector('.toast.own .own-bar i').getAnimations().length);
      check(T + 'indeterminate: the bar slides (one animation; reduced motion has none)', slide === 1, slide);

      // ---- error: quiet danger ink, detail selectable in monospace, Copy goes through main
      const ERR = OWN({ title: 'Update failed: the download stopped', body: 'Still on v0.1.0. Nothing was changed.', tone: 'error', progress: null,
        detail: 'git merge --ff-only v0.1.1\nnpm install\nLog: C:/example/update.log', actions: [{ id: 'dismiss', label: 'Close' }] });
      await emit('toasts.update', { banner: ERR });
      await sleep(80);
      c = await card();
      check(T + 'error tone: still the same card, marked tone-error, with the detail', c.error && c.detail === ERR.detail && (await page.evaluate(() => document.querySelector('.toast.own') === window.__ownEl)), c);
      inksOwn[theme] = { err: c.titleInk };
      await shot('error');
      const looks = await page.evaluate(() => { const d = document.querySelector('.toast.own .own-detail'), cs = getComputedStyle(d); return { sel: cs.userSelect || cs.webkitUserSelect, font: cs.fontFamily, ws: cs.whiteSpace }; });
      check(T + 'detail: selectable (user-select text), monospace, wraps', looks.sel === 'text' && /Cascadia|Consolas|monospace/i.test(looks.font) && looks.ws === 'pre-wrap', looks);
      await page.evaluate(() => { window.__fake.answer['toasts.copy'] = () => ({ ok: true }); });
      await page.click('.toast.own .own-copy');
      await until(async () => (await card()).say);
      const cps = await calls('toasts.copy');
      check(T + 'Copy: toasts.copy { id:-1 } and "Copied"', cps.length === 1 && cps[0].id === -1 && (await card()).say === 'Copied', { cps, say: (await card()).say });
      await page.evaluate(() => { window.__fake.answer['toasts.copy'] = () => ({ ok: false, reason: 'the clipboard is held by another app' }); });
      await page.click('.toast.own .own-copy');
      await until(async () => /^Not copied/.test((await card()).say));
      check(T + 'Copy failing: "Not copied: <reason>" in words', (await card()).say === 'Not copied: the clipboard is held by another app', (await card()).say);

      // ---- the X: toasts.action close, then the card goes
      await page.click('.toast.own .x');
      const closeCall = await until(async () => (await calls('toasts.action')).filter((a) => a.action === 'close').pop() || null, 1500);
      check(T + 'the X calls toasts.action { id:-1, action:"close" } (not toasts.click)', closeCall && closeCall.id === -1 && (await calls('toasts.click')).length === 0, closeCall);
      check(T + 'and the card goes', !!(await until(async () => !(await st()).items.some((i) => i.id === -1), 1500)), await st());

      // ---- toasts.drop takes it away; a re-post of the same id comes back as a fresh card
      await emit('toasts.show', { banners: [OWN()] });
      await until(async () => (await st()).items.some((i) => i.id === -1 && i.shown));
      await emit('toasts.drop', { id: -1 });
      check(T + 'toasts.drop: the card leaves', !!(await until(async () => !(await st()).items.some((i) => i.id === -1), 1500)), await st());

      // ---- never under "+N more", and "+N more" never takes it away
      await emit('toasts.show', { banners: [OWN()] });
      await until(async () => (await st()).items.some((i) => i.id === -1 && i.shown));
      await emit('toasts.show', { banners: [B(70), B(71), B(72), B(73)] });
      const mix = await until(async () => { const s = await st(); return s.more ? s : null; });
      check(T + 'with four apps\' banners the own one stays on screen ("+N more" holds apps only)', mix && mix.items.find((i) => i.id === -1).onScreen && mix.more === '+2 more', mix);
      await page.click('.more');
      await sleep(400);
      const after = await st();
      check(T + '"+N more" takes the apps\' banners, not Mantle\'s own', after.items.length === 1 && after.items[0].id === -1, after.items);
      await P.ctx.close();
    }
    check('own: the error ink differs between light and dark (theme reaches it)', inksOwn.light && inksOwn.dark && inksOwn.light.err !== inksOwn.dark.err, inksOwn);
    {
      // reduced motion: the indeterminate bar does not slide
      const ctx = await browser.newContext({ viewport: { width: 392, height: 700 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
      const page = await ctx.newPage();
      await page.addInitScript(FAKE, [LIFE, RESUME, 'light']);
      await page.goto(PAGE);
      await page.waitForFunction(() => window.__toasts && window.__fake.calls.some((c) => c.ch === 'toasts.ready'));
      await page.evaluate(([c, x]) => window.__fake.emit(c, x), ['toasts.show', { banners: [OWN({ actions: [], progress: { text: 'Installing...', pct: null } })] }]);
      await page.waitForFunction(() => window.__toasts.state().items.some((i) => i.id === -1 && i.shown));
      const n = await page.evaluate(() => document.querySelector('.toast.own .own-bar i').getAnimations().length);
      check('own, reduced motion: the indeterminate bar does not move', n === 0, n);
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
  console.log(`TOASTS PAGE TEST: ${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log('  FAIL ' + f);
  console.log(`shots: ${SHOTS}`);
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.log('TOASTS PAGE TEST: crashed: ' + (e && e.stack)); process.exit(1); });
