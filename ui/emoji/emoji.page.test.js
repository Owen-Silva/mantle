/* emoji.page.test.js - Mantle's emoji picker PAGE, driven for real (lane mantle-emoji2, 2026-10-15).
 *
 * Headless Chromium over ui/emoji/index.html (file://) with mock-mantle.js injected before the page's
 * scripts: every check pushes main's events (emoji.show / emoji.key / emoji.hide / emoji.notice) through
 * the page's own code, presses real keys and clicks, and reads what the page asked main for
 * (window.__mock.calls). Nothing reaches Windows. Light and dark (data-theme).
 *   node ui/emoji/emoji.page.test.js   -> "EMOJI PAGE TEST: n passed, m failed"
 * Shots: MANTLE_SHOTS_DIR (default %TEMP%\mantle-emoji-shots); with --morning also emoji-1.png (the
 * default view) and emoji-2.png (a search in progress), cropped to the panel, + emoji.txt captions, in
 * C:\Users\user\notes\morning-shots.
 * LINE 1 is not optional: lowcpu.js pins this process and its browser.
 */
try { require('C:/Users/user/dev-tools/tools/lowcpu.js'); } catch (e) { if (process.env.CI !== 'true') throw e; }
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
let chromium;
try { ({ chromium } = require('playwright-core')); } catch (_) { ({ chromium } = require('C:/Users/user/other-app/node_modules/playwright-core')); }

const PAGE = 'file:///' + path.join(__dirname, 'index.html').replace(/\\/g, '/');
const MOCK = path.join(__dirname, 'mock-mantle.js');
const SHOTS = path.resolve(process.env.MANTLE_SHOTS_DIR || path.join(os.tmpdir(), 'mantle-emoji-shots'));
const MORNING = process.argv.includes('--morning') ? 'C:/Users/user/notes/morning-shots' : null;
const W = 360 + 36, H = 424 + 36, M = 18;

let passed = 0; const failures = [];
function check(name, ok, detail) { if (ok) passed++; else failures.push(`${name}${detail !== undefined ? ` (${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 300)})` : ''}`); return ok; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* A transparent screenshot (omitBackground) decoded, so a pixel OFF the panel can be read: its alpha is
   what Windows composites over the desktop there (as ui/toasts/toasts.page.test.js). */
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

async function open(browser, theme, dpr) {
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: dpr || 1, reducedMotion: 'no-preference' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript({ path: MOCK });
  // the theme goes on as soon as <html> exists (an init script can run before it does)
  await page.addInitScript((t) => {
    const set = () => { document.documentElement.setAttribute('data-theme', t); };
    if (document.documentElement) set(); else new MutationObserver((_m, o) => { if (document.documentElement) { set(); o.disconnect(); } }).observe(document, { childList: true });
  }, theme);
  await page.goto(PAGE);
  await page.waitForFunction(() => window.__emoji && window.__mock);
  const S = () => page.evaluate(() => { const s = window.__emoji.S; return { open: s.open, q: s.q, tab: s.tab, sel: s.sel, n: s.items.length, tone: s.tone, recents: s.recents.slice() }; });
  const emit = (ch, p) => page.evaluate(([c, x]) => window.__mock.emit(c, x), [ch, p]);
  const calls = (name) => page.evaluate((n) => window.__mock.calls.filter((c) => c.name === n).map((c) => c.args), name);
  const clear = () => page.evaluate(() => { window.__mock.calls.length = 0; });
  const until = async (fn, ms) => { const end = Date.now() + (ms || 3000); for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(30); } };
  const key = (k, shift) => emit('emoji.key', { key: k, text: k.length === 1 ? k : null, shift: !!shift });
  const show = async (p) => { await clear(); await emit('emoji.show', Object.assign({ recents: [], tone: 0, closeAfter: false }, p || {})); await until(async () => (await calls('emoji.painted')).length > 0, 2000); };
  return { ctx, page, S, emit, calls, clear, until, key, show, errors };
}
const settled = (page) => page.waitForFunction(() => getComputedStyle(document.getElementById('panel')).transform === 'none' && getComputedStyle(document.getElementById('panel')).opacity === '1', null, { timeout: 3000 }).then(() => true, () => false);

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await require('../settings/test-browser.js').launch(chromium, { headless: true });
  try {
    const looks = {};
    for (const theme of ['light', 'dark']) {
      const T = theme + ': ';
      const P = await open(browser, theme);
      const { page, S, emit, calls, clear, until, key, show } = P;
      check(T + 'no grid at load: the first open draws it (once, with the recents it brings)', (await S()).n === 0, await S());

      // ---- open: the spring in, and the paint report
      const t0 = Date.now();
      await show({ recents: ['😂', '❤️', '👍'], tone: 0 });
      const painted = await calls('emoji.painted');
      check(T + 'emoji.show: one paint report with readyAt, after two frames', painted.length === 1 && Number.isFinite(painted[0].readyAt) && painted[0].readyAt >= t0, painted);
      check(T + 'the panel springs in and comes to rest', await settled(page));
      const full = await until(() => page.evaluate(() => !window.__emoji.S.pending && window.__emoji.S.items.length > 1200 && document.querySelectorAll('#sections .sec').length >= 9 ? window.__emoji.S.items.length : 0), 2000);
      const perf = (await calls('emoji.painted'))[0].perf || {};
      check(T + 'after the first frame the rest of the grid follows (every group, numbered on)', !!full && (await page.evaluate(() => { const c = document.querySelectorAll('#sections .c'); return Array.from(c).every((e, i) => +e.getAttribute('data-i') === i); })), { full, perf });
      check(T + 'the paint report carries its timings (script, show, draw)', Number.isFinite(perf.scriptAt) && Number.isFinite(perf.drawMs) && perf.opens === 1, perf);
      const head = await page.evaluate(() => ({ ph: document.getElementById('ph').textContent, rec: (document.querySelector('.sec[data-sec="recent"] .cells') || {}).textContent, cats: !document.getElementById('cats').hidden, tabOn: document.querySelector('.tabs button.on').getAttribute('data-tab') }));
      check(T + 'default view: placeholder, recents first, categories, the Emoji tab', head.ph === 'Search emoji' && head.rec === '😂❤️👍' && head.cats && head.tabOn === 'emoji', head);
      const s1 = await S();
      check(T + 'the first cell is selected and named in the footer', s1.sel === 0 && (await page.textContent('#name')).length > 0 && (await page.textContent('#big')) === '😂', { s1, name: await page.textContent('#name'), big: await page.textContent('#big') });

      // ---- the panel against the window: see-through off it, solid on it
      const box = await page.evaluate(() => { const r = document.getElementById('panel').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
      check(T + 'the panel is 360 x 424 at the 18 px margin', box.x === M && box.y === M && box.w === 360 && box.h === 424, box);
      const png = decodePng(await page.screenshot({ omitBackground: true }));
      let worst = 0, at = null;
      for (let x = 0; x < W; x += 3) for (const y of [0, H - 1]) { const a = png.at(x, y)[3]; if (a > worst) { worst = a; at = [x, y]; } }
      for (let y = 0; y < H; y += 3) for (const x of [0, W - 1]) { const a = png.at(x, y)[3]; if (a > worst) { worst = a; at = [x, y]; } }
      // the four corners just inside the panel's box but outside its 20 px radius
      const corners = [[M + 1, M + 1], [M + 360 - 2, M + 1], [M + 1, M + 424 - 2], [M + 360 - 2, M + 424 - 2]].map(([x, y]) => png.at(x, y)[3]);
      const faceA = Math.min(png.at(M + 180, M + 212)[3], png.at(M + 40, M + 400)[3]);
      if (theme === 'dark') check(T + 'NO dark square: every pixel on the window\'s edge is fully see-through (alpha 0)', worst === 0, { worst, at });
      else check(T + 'light: off the panel only the drop\'s faint tail at the window edge (alpha <= 31)', worst <= 31, { worst, at });
      check(T + 'outside the rounded corners is see-through (dark 0, light only the drop <= 40), the face solid', corners.every((a) => a <= (theme === 'dark' ? 0 : 40)) && faceA > 200, { corners, faceA });
      looks[theme] = await page.evaluate(() => getComputedStyle(document.getElementById('panel')).backgroundColor + '|' + getComputedStyle(document.getElementById('name')).color);
      await page.screenshot({ path: path.join(SHOTS, `emoji-${theme}-default.png`), omitBackground: true });

      // ---- keys from the SIDECAR's watch (emoji.key)
      await clear();
      for (const ch of 'hear') await key(ch);
      const q1 = await until(async () => { const s = await S(); return s.q === 'hear' ? s : null; });
      const shown = await page.evaluate(() => ({ q: document.getElementById('q').textContent, ph: document.getElementById('ph').textContent, results: !document.getElementById('results').hidden, sections: document.getElementById('sections').hidden, cats: document.getElementById('cats').hidden, typing: document.getElementById('search').classList.contains('typing') }));
      check(T + 'watch keys type into the drawn search: results, no categories', !!q1 && q1.n > 0 && q1.n <= 160 && shown.q === 'hear' && shown.ph === '' && shown.results && shown.sections && shown.cats && shown.typing, { q1, shown });
      check(T + 'each watch key tells main the picker was touched (emoji.touched)', (await calls('emoji.touched')).length === 4);
      await key('Backspace');
      check(T + 'Backspace takes one letter', (await S()).q === 'hea');
      await key('r'); await key('t');
      const firstName = await page.evaluate(() => window.__emoji.S.items[0].name);
      check(T + 'a search for "heart" finds a heart first', /heart/i.test(firstName), firstName);
      if (theme === 'light') await page.screenshot({ path: path.join(SHOTS, 'emoji-light-search.png'), omitBackground: true });
      await key('ArrowRight');
      await sleep(450);   // the results' entrance animation is over: the drawn cell is where it rests
      check(T + 'ArrowRight moves the selection', (await S()).sel === 1);
      const ring = await page.evaluate(() => { const r = document.getElementById('ring'); const c = document.querySelector('#results .c[data-i="1"]').getBoundingClientRect(); const g = document.getElementById('grid').getBoundingClientRect(); const m = /translate\(([-\d.]+)px, *([-\d.]+)px\)/.exec(r.style.transform) || []; return { off: r.classList.contains('off'), at: [+m[1], +m[2]], want: [c.left - g.left, c.top - g.top + document.getElementById('grid').scrollTop] }; });
      check(T + 'the selection ring is on the selected cell (within 1 px)', !ring.off && Math.abs(ring.at[0] - ring.want[0]) <= 1 && Math.abs(ring.at[1] - ring.want[1]) <= 1, ring);
      await key('Enter');
      let ins = await until(async () => { const c = await calls('emoji.insert'); return c.length === 1 ? c : null; });
      check(T + 'watch Enter: types the selected one and STAYS open (close:false)', !!ins && ins[0].close === false && ins[0].via === 'key' && (await S()).open, ins);
      await key('Enter', true);
      ins = await until(async () => { const c = await calls('emoji.insert'); return c.length === 2 ? c : null; });
      check(T + 'watch Shift+Enter: types and closes (close:true)', !!ins && ins[1].close === true, ins);
      check(T + 'the picks went into the recents (the same one twice is one entry)', (await S()).recents.length === 1 && (await S()).recents[0] === ins[1].ch && ins[0].ch === ins[1].ch, { s: await S(), ins });
      await key('Escape');
      const esc = await until(async () => { const c = await calls('emoji.close'); return c.length ? c : null; });
      check(T + 'watch Esc: asks main to close (why: esc)', !!esc && esc[0].why === 'esc', esc);
      await key('Delete');
      check(T + 'Delete clears the search', (await S()).q === '');

      // ---- nothing found
      for (const ch of 'zzqxv') await key(ch);
      const empty = await page.evaluate(() => ({ hidden: document.getElementById('empty').hidden, text: document.getElementById('empty').textContent, ring: document.getElementById('ring').classList.contains('off') }));
      check(T + 'nothing found: says so, and no selection ring', !empty.hidden && /zzqxv/.test(empty.text) && empty.ring, empty);
      await key('Delete');

      // ---- tabs
      await key('Tab');
      let tabs = await page.evaluate(() => ({ on: document.querySelector('.tabs button.on').getAttribute('data-tab'), ph: document.getElementById('ph').textContent, cats: document.getElementById('cats').hidden }));
      check(T + 'Tab: Symbols, its placeholder, no categories', tabs.on === 'symbols' && tabs.ph === 'Search symbols' && tabs.cats && (await S()).tab === 'symbols', tabs);
      await key('Tab', true);
      check(T + 'Shift+Tab: back to Emoji', (await S()).tab === 'emoji');
      await page.click('.tabs button[data-tab="kaomoji"]');
      await sleep(500);
      tabs = await page.evaluate(() => { const on = document.querySelector('.tabs button.on'), pill = document.getElementById('pill'); return { on: on.getAttribute('data-tab'), pillW: pill.style.width, w: on.offsetWidth + 'px', kao: !!document.querySelector('.sec.kao .c'), ph: document.getElementById('ph').textContent }; });
      check(T + 'a click on Kaomoji: its grid, the pill slides under it', tabs.on === 'kaomoji' && tabs.pillW === tabs.w && tabs.kao && tabs.ph === 'Search kaomoji', tabs);
      await clear();
      await key('Enter');
      ins = await until(async () => { const c = await calls('emoji.insert'); return c.length ? c : null; });
      check(T + 'a kaomoji is typed as its text', !!ins && ins[0].ch.length > 1 && !/[\u{1F300}-\u{1FAFF}]/u.test(ins[0].ch), ins);
      await page.click('.tabs button[data-tab="emoji"]');

      // ---- skin tone
      await clear();
      await page.click('#toneBtn');
      const tones = await page.evaluate(() => ({ hidden: document.getElementById('tones').hidden, n: document.querySelectorAll('#tones button').length }));
      check(T + 'the tone button opens six tones', !tones.hidden && tones.n === 6, tones);
      await page.click('#tones button[data-tone="3"]');
      const tc = await calls('emoji.tone');
      const toned = await page.evaluate(() => {
        const S = window.__emoji.S, i = S.items.findIndex((it) => it.plan && !it.fixed);
        const c = document.querySelector('#sections .c[data-i="' + i + '"]');
        return { i, text: c && c.textContent, btn: document.getElementById('toneGlyph').textContent, hidden: document.getElementById('tones').hidden };
      });
      check(T + 'tone 3: saved (emoji.tone), the cells and the button wear it, the row closes', tc.length === 1 && tc[0].tone === 3 && (await S()).tone === 3 && toned.text && toned.text.includes('\u{1F3FD}') && toned.btn.includes('\u{1F3FD}') && toned.hidden, { tc, toned });
      await page.click('#toneBtn'); await page.click('#tones button[data-tone="0"]');
      check(T + 'back to no tone', (await S()).tone === 0);

      // ---- the mouse: a click types and stays, Shift+click closes
      await clear();
      const cell = await page.$('#sections .sec[data-sec="smileys"] .c[data-i]') || await page.$('#sections .sec:nth-child(3) .c');
      if (check(T + 'a smiley cell to click', !!cell)) {
        await cell.click();
        await cell.click({ modifiers: ['Shift'] });
        const c = await until(async () => { const x = await calls('emoji.insert'); return x.length === 2 ? x : null; });
        check(T + 'click: types and stays (close:false), Shift+click closes', !!c && c[0].close === false && c[0].via === 'click' && c[1].close === true, c);
      }

      // ---- close, then a reopen starts fresh; the PAGE's own keys (the fallback when it has the keyboard)
      await clear();
      await emit('emoji.hide', { why: 'test' });
      const hidden = await until(async () => (await calls('emoji.hidden')).length === 1);
      check(T + 'emoji.hide: the panel plays out and says emoji.hidden', !!hidden && !(await page.evaluate(() => document.getElementById('panel').classList.contains('on'))));
      await key('x');
      check(T + 'keys while closed do nothing', (await S()).q === '');
      const ready = await until(() => page.evaluate(() => { const s = window.__emoji.S; return s.tab === 'emoji' && s.q === '' && !!s.drawnKey; }), 1500);
      check(T + 'after the close the default view is drawn again out of sight (Emoji tab, no search)', !!ready, await S());
      await page.evaluate(() => { document.querySelector('#sections .sec').__kept = 1; });
      await show({ recents: (await S()).recents, tone: 0, kbSelf: true });
      check(T + 'a warm reopen with the same recents draws nothing new (the grid is kept)', await page.evaluate(() => document.querySelector('#sections .sec').__kept === 1));
      check(T + 'a reopen: Emoji tab, empty search, recents updated', (await S()).tab === 'emoji' && (await S()).q === '' && (await page.textContent('.sec[data-sec="recent"] .cells')).length > 0);
      await clear();
      await page.keyboard.type('smile');
      check(T + 'page keys type into the search', (await S()).q === 'smile', await S());
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      await page.keyboard.press('Shift+Enter');
      ins = await until(async () => { const c = await calls('emoji.insert'); return c.length === 2 ? c : null; });
      check(T + 'page Enter stays open (close:false), page Shift+Enter closes (close:true)', !!ins && ins[0].close === false && ins[1].close === true, ins);
      check(T + 'kbSelf: the hint says Enter closes (main closes after a pick when the panel has the keyboard)', /closes/.test(await page.textContent('#hint')));
      await page.keyboard.press('Escape');
      const pesc = await until(async () => { const c = await calls('emoji.close'); return c.length ? c : null; });
      check(T + 'page Esc closes', !!pesc && pesc[0].why === 'esc', pesc);
      await page.keyboard.press('Control+a');
      check(T + 'Ctrl+ chords are left alone', (await S()).q === 'smile');

      // ---- the admin-window notice
      await emit('emoji.notice', { text: 'Task Manager runs as administrator, so Mantle can\'t type into it.' });
      const note = await page.evaluate(() => ({ only: document.getElementById('panel').classList.contains('note-only'), text: document.getElementById('notice').textContent, hidden: document.getElementById('notice').hidden }));
      check(T + 'emoji.notice: the panel shows just the reason', note.only && !note.hidden && /administrator/.test(note.text), note);
      await show({});
      check(T + 'the next open is the picker again', !(await page.evaluate(() => document.getElementById('panel').classList.contains('note-only'))));

      // ---- placed above the caret
      await emit('emoji.moved', { above: true });
      check(T + 'emoji.moved above: the panel grows from its bottom edge', await page.evaluate(() => document.getElementById('panel').classList.contains('above')));
      check(T + 'no page errors', P.errors.length === 0, P.errors);
      await P.ctx.close();
    }
    check('light and dark draw different panels (the theme reaches the page)', looks.light && looks.dark && looks.light !== looks.dark, looks);

    // ---- the morning shots: light, 2x, cropped to the panel
    if (MORNING) {
      fs.mkdirSync(MORNING, { recursive: true });
      const P = await open(browser, 'light', 2);
      await P.show({ recents: ['😂', '❤️', '👍', '🙏', '😭', '🔥', '✨', '🥺', '😊', '🎉'], tone: 0, app: 'Discord', appPicks: [] });
      await settled(P.page);
      await sleep(300);
      const clip = { x: M, y: M, width: 360, height: 424 };
      await P.page.screenshot({ path: path.join(MORNING, 'emoji-1.png'), clip, omitBackground: true });
      for (const ch of 'party') await P.key(ch);
      await sleep(700);   // the results' short reflow stagger finishes
      await P.page.screenshot({ path: path.join(MORNING, 'emoji-2.png'), clip, omitBackground: true });
      fs.writeFileSync(path.join(MORNING, 'emoji.txt'),
        'emoji-1.png: Win+. opens Mantle\'s own emoji picker by the text cursor: recents first, then the categories, Emoji / Symbols / Kaomoji tabs and a skin-tone button; the app you are typing in keeps the keyboard.\n' +
        'emoji-2.png: typing straight away searches ("party"): Enter types the highlighted one and keeps the picker open, Shift+Enter types it and closes.\n');
      console.log(`morning shots: ${MORNING}`);
      await P.ctx.close();
    }
  } finally {
    await browser.close();
  }
  console.log(`EMOJI PAGE TEST: ${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log('  FAIL ' + f);
  console.log(`shots: ${SHOTS}`);
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.log('EMOJI PAGE TEST: crashed: ' + (e && e.stack)); process.exit(1); });
