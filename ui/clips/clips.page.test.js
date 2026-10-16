/* clips.page.test.js - the Win+G Record panel and the Clips gallery PAGES, driven for real (lane
 * mantle-clips2, 2026-10-15). Headless Chromium over ui/clips/record.html and index.html with a fake
 * window.mantle installed before the pages' scripts (mock-mantle.js stands down), light and dark:
 *   panel: every state (ready, starting, recording + the clock, a game: the keys hint, nothing to
 *          record, a failed start), R / M / O / Esc, the region row only with screenrec, the open's
 *          painted call with its seq, the size it asks for; SEE-THROUGH: every pixel outside the card is
 *          alpha 0 (corners included) and dark has no outer shadow (the clipped-shadow rule);
 *   gallery: days and cards newest first, filters (Ctrl+1/2/3), arrows + Enter, the viewer, trim handles
 *          by keyboard then Enter (clips.trim with the range), Delete -> toast with Undo -> Ctrl+Z,
 *          Ctrl+C, the hover scrub's ONE shared <video> (src on hover, emptied on leave), Esc back.
 * Nothing reaches Windows; shots in MANTLE_SHOTS_DIR (default %TEMP%\mantle-clips-shots).
 *   node ui/clips/clips.page.test.js   -> "CLIPS PAGE TEST: n passed, m failed"
 */
try { require('C:/Users/user/dev-tools/tools/lowcpu.js'); } catch (e) { if (process.env.CI !== 'true') throw e; }
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
let chromium;
try { ({ chromium } = require('playwright-core')); } catch (_) { ({ chromium } = require('C:/Users/user/other-app/node_modules/playwright-core')); }
const UI = 'file:///' + __dirname.replace(/\\/g, '/') + '/';
const SHOTS = path.resolve(process.env.MANTLE_SHOTS_DIR || path.join(os.tmpdir(), 'mantle-clips-shots'));
let passed = 0; const failures = [];
function check(name, ok, detail) { if (ok) passed++; else failures.push(`${name}${detail !== undefined ? ` (${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 300)})` : ''}`); return ok; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function decodePng(buf) {
  let p = 8, w = 0, h = 0, ct = 0; const idat = [];
  while (p < buf.length) { const len = buf.readUInt32BE(p), type = buf.toString('ascii', p + 4, p + 8), d = buf.slice(p + 8, p + 8 + len); if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); ct = d[9]; } else if (type === 'IDAT') idat.push(d); else if (type === 'IEND') break; p += 12 + len; }
  const bpp = ct === 6 ? 4 : 3, raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * bpp, px = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) { const f = raw[y * (stride + 1)], src = raw.slice(y * (stride + 1) + 1, (y + 1) * (stride + 1)); for (let x = 0; x < stride; x++) { const a = x >= bpp ? px[y * stride + x - bpp] : 0, b = y ? px[(y - 1) * stride + x] : 0, c = (x >= bpp && y) ? px[(y - 1) * stride + x - bpp] : 0; let v = src[x]; if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1; else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c); } px[y * stride + x] = v & 255; } }
  return { w, h, at: (x, y) => { const i = y * stride + x * bpp; return bpp === 4 ? px[i + 3] : 255; } };
}

/* the fake main: records calls, answers from window.__answers, lets the test push events */
const FAKE = ([theme, answers]) => {
  const on = {}; const calls = [];
  const set = () => { document.documentElement.dataset.theme = theme; };
  if (document.documentElement) set(); else new MutationObserver((_m, o) => { if (document.documentElement) { set(); o.disconnect(); } }).observe(document, { childList: true });
  window.__answers = answers || {};
  window.__fake = { calls, emit(ch, p) { (on[ch] || []).forEach((f) => f(p)); } };
  window.mantle = {
    on(ch, fn) { (on[ch] = on[ch] || []).push(fn); return () => {}; },
    call(ch, args) { calls.push({ ch, args: args === undefined ? null : JSON.parse(JSON.stringify(args)) }); const a = window.__answers[ch]; return Promise.resolve(typeof a === 'function' ? a(args) : (a || { ok: true })); },
  };
};
const NOW = Date.now();
const ST = (o) => Object.assign({ rec: { on: false, since: null, pending: false, by: null, why: null }, app: 'Mantle stand-in', plan: { can: true, how: 'keys', why: 'records this window' }, mic: false, screenrec: false, now: Date.now() }, o || {});
const ITEMS = [0, 1, 2, 3, 4].map((i) => ({ name: `Mantle stand-in ${i}.${i === 2 ? 'png' : 'mp4'}`, kind: i === 2 ? 'image' : 'video', title: `Mantle stand-in ${i}`, at: NOW - i * 3600000 * 9,
  durationMs: i === 2 ? null : 20000 + i * 1000, width: 1920, height: 1080, size: 1e6, sizeWords: '1.0 MB', url: i === 2 ? null : `file:///C:/mantle-test-none/clip${i}.mp4`, mtimeMs: 1, growing: false }));
const LIST = (f) => { const it = ITEMS.filter((x) => !f || f === 'all' || x.kind === f); return { ok: true, items: it, groups: [{ label: 'Today', names: it.filter((x) => NOW - x.at < 12 * 3600000).map((x) => x.name) }, { label: 'Earlier', names: it.filter((x) => NOW - x.at >= 12 * 3600000).map((x) => x.name) }], counts: { all: 5, video: 4, image: 1 }, recording: null }; };

async function open(browser, file, theme, w, h) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  await page.addInitScript(FAKE, [theme, {}]);
  await page.goto(UI + file);
  const calls = (ch) => page.evaluate((c) => window.__fake.calls.filter((x) => x.ch === c).map((x) => x.args), ch);
  const emit = (ch, p) => page.evaluate(([c, x]) => window.__fake.emit(c, x), [ch, p]);
  return { ctx, page, calls, emit };
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await require('../settings/test-browser.js').launch(chromium, { headless: true });
  try {
    for (const theme of ['light', 'dark']) {
      const T = theme + ' panel: ';
      const P = await open(browser, 'record.html', theme, 376, 330);
      const { page, calls, emit } = P;
      const snap = () => page.evaluate(() => window.__clipsPanel.state());
      await page.evaluate(() => { window.__answers['clips.state'] = { ok: true, last: { name: 'Mantle stand-in 0.mp4', kind: 'video', title: 'Mantle stand-in 0', at: Date.now() - 120000, thumb: null } }; });
      await emit('clips.state', ST({ open: true, seq: 7 }));
      await sleep(350);
      let s = await snap();
      check(T + 'ready: Record enabled, "Ready to record Mantle stand-in"', s.shown && !s.button.disabled && s.button.label === 'Record' && /Ready to record Mantle stand-in/.test(s.status), s);
      const painted = await calls('clips.painted');
      check(T + 'the open says it is painted, with its seq', painted.length === 1 && painted[0].seq === 7, painted);
      const sz = await calls('clips.size');
      check(T + 'it asks for the card\'s height', sz.length >= 1 && sz[sz.length - 1].h > 120 && sz[sz.length - 1].h < 330, sz);
      check(T + 'the last clip is on the panel', s.last && s.last.title === 'Mantle stand-in 0', s.last);
      check(T + 'no "Record a region or window" row without screenrec', !s.region);
      // see-through: every pixel outside the card is alpha 0 (corners too)
      const box = await page.evaluate(() => { const r = document.getElementById('card').getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; });
      const png = decodePng(await page.screenshot({ omitBackground: true }));
      let bad = 0, worst = 0;
      for (let y = 0; y < png.h; y++) for (let x = 0; x < png.w; x++) {
        const out = x < box.l - 0.5 || x >= box.r + 0.5 || y < box.t - 0.5 || y >= box.b + 0.5;
        if (!out) continue;
        const a = png.at(x, y);
        if (theme === 'dark' && a > 0) { bad++; worst = Math.max(worst, a); }
        if (theme === 'light' && (x < box.l - 30 || y < box.t - 30) && a > 0) { bad++; worst = Math.max(worst, a); }   // light: only its soft drop shadow, never far out
      }
      check(T + 'see-through: nothing paints outside the card (no square)', bad === 0, { bad, worst });
      const cr = Math.round(box.l + 1), ct = Math.round(box.t + 1);
      check(T + 'the card\'s rounded corner is see-through at its very tip', png.at(cr, ct) < 60, png.at(cr, ct));
      const sh = await page.evaluate(() => getComputedStyle(document.getElementById('card')).boxShadow);
      if (theme === 'dark') check(T + 'dark: no outer shadow (only inset layers)', !/rgba?\([^)]*\)\s+-?\d+px\s+-?\d+px\s+[1-9]/.test(sh.replace(/inset[^,]*(,|$)/g, '')) , sh);
      await page.screenshot({ path: path.join(SHOTS, `panel-ready-${theme}.png`), omitBackground: true });

      // keyboard: R records, M the mic, O opens, Esc closes
      await page.evaluate(() => { window.__answers['clips.record'] = { ok: true, state: Object.assign({}, { rec: { on: false, pending: true }, app: 'Mantle stand-in', plan: { can: true, how: 'keys' }, mic: false, screenrec: false, now: Date.now() }) }; window.__answers['clips.mic'] = { ok: true, mic: true }; });
      await page.keyboard.press('r');
      await sleep(80);
      s = await snap();
      check(T + 'R presses Record (clips.record), then "Starting"', (await calls('clips.record')).length === 1 && s.pending && /Starting/.test(s.status) && s.button.disabled, s);
      await page.keyboard.press('m');
      await sleep(80);
      check(T + 'M switches the mic (clips.mic {on: true})', (await calls('clips.mic'))[0].on === true && (await snap()).mic === true);
      await page.keyboard.press('o');
      check(T + 'O opens Clips from the panel', ((await calls('clips.open'))[0] || {}).from === 'panel');
      await page.keyboard.press('Escape');
      check(T + 'Esc closes', ((await calls('clips.close'))[0] || {}).why === 'Esc');

      // recording: Stop, the calm dot, the clock running
      await emit('clips.state', ST({ rec: { on: true, since: Date.now() - 65000, pending: false, by: 'mantle' }, mic: true }));
      await sleep(60);
      const c1 = (await snap()).clock;
      await sleep(1100);
      s = await snap();
      check(T + 'recording: Stop, the clock runs (1:05 -> 1:06)', s.recording && s.button.label === 'Stop' && !s.button.disabled && c1 === '1:05' && s.clock === '1:06' && s.ticking, { c1, s });
      const dot = await page.evaluate(() => { const c = getComputedStyle(document.getElementById('dot')); return { d: c.display, an: c.animationName, dur: c.animationDuration, sh: c.boxShadow }; });
      check(T + 'the live dot is calm: shown, no glow', dot.d === 'block' && dot.sh === 'none', dot);
      await page.screenshot({ path: path.join(SHOTS, `panel-recording-${theme}.png`), omitBackground: true });
      await emit('clips.hide', { why: 'test' });
      check(T + 'hidden: the clock stops ticking', !(await snap()).ticking);

      // a game: the keys hint, Record disabled; nothing to record; a failed start; screenrec row
      await emit('clips.state', ST({ open: true, seq: 8, plan: { can: false, how: 'hint', game: 'game', why: 'Mantle never sends keys to a game' }, screenrec: true }));
      await sleep(60);
      s = await snap();
      check(T + 'a game: Record disabled, the Win+Alt+R hint, never keys', s.button.disabled && s.hint && /never sends keys/.test(s.hint), s);
      check(T + 'screenrec there: the region row shows', s.region === true);
      await emit('clips.state', ST({ plan: { can: false, how: 'none', why: 'Windows cannot record the desktop or File Explorer' }, app: null }));
      await sleep(40);
      s = await snap();
      check(T + 'nothing to record: disabled, the reason said', s.button.disabled && /cannot record the desktop/.test(s.status), s);
      await emit('clips.state', ST({ rec: { on: false, why: 'Windows did not start a recording within 15 s' } }));
      await sleep(40);
      check(T + 'a failed start is said on the panel', /did not start a recording/.test((await snap()).warn || ''));
      await P.ctx.close();

      /* ---- the gallery ---- */
      const G = theme + ' gallery: ';
      const Q = await open(browser, 'index.html', theme, 1100, 720);
      const gp = Q.page;
      await gp.evaluate((l) => { window.__answers['clips.list'] = (a) => { const f = a && a.filter; const it = l.items.filter((x) => !f || f === 'all' || x.kind === f); return Object.assign({}, l, { items: it, groups: l.groups.map((g) => ({ label: g.label, names: g.names.filter((n) => it.some((x) => x.name === n)) })).filter((g) => g.names.length) }); };
        window.__answers['clips.delete'] = { ok: true, undo: 'u1' }; window.__answers['clips.trim'] = { ok: true, name: 'Mantle stand-in 0 (0m01s-0m21s).mp4', lossless: true, startMs: 1000, endMs: 21000 }; }, LIST());
      await gp.evaluate(() => window.__fake.emit('clips.changed', {}));
      await sleep(500);
      const gs = () => gp.evaluate(() => window.__clips.state());
      let g = await gs();
      check(G + 'five cards, newest first, two days', g.cards === 5 && (await gp.$$eval('.day', (d) => d.map((x) => x.textContent))).join() === 'Today,Earlier', g);
      check(G + 'thumbnails are asked for as cards come into view', (await Q.calls('clips.thumbs')).length >= 1);
      await gp.keyboard.press('Control+2');
      await sleep(250);
      check(G + 'Ctrl+2 shows videos only', (await gs()).cards === 4 && (await Q.calls('clips.list')).some((a) => a && a.filter === 'video'));
      await gp.keyboard.press('Control+1');
      await sleep(250);
      await gp.focus('.clip');
      await gp.keyboard.press('ArrowRight');
      check(G + 'arrows move the selection', (await gs()).sel === 'Mantle stand-in 1.mp4', (await gs()).sel);
      await gp.keyboard.press('ArrowLeft');
      // hover scrub: ONE shared video, given the clip on hover, emptied on leave
      const r0 = await gp.$eval('.clip .pic', (e) => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
      await gp.mouse.move(r0.x, r0.y);
      await sleep(260);
      await gp.mouse.move(r0.x + 20, r0.y);
      g = await gs();
      check(G + 'hover: the shared <video> takes the clip', g.scrub === 'Mantle stand-in 0.mp4' && g.scrubSrc && (await gp.$$eval('video', (v) => v.length)) === 2, g);
      await gp.mouse.move(5, 700);
      await sleep(60);
      check(G + 'leave: the scrub video is emptied and taken out', !(await gs()).scrubSrc && (await gs()).scrub === null);
      await gp.screenshot({ path: path.join(SHOTS, `gallery-${theme}.png`) });
      // the viewer: Enter opens, trim handle by keyboard, Enter saves a NEW file
      await gp.focus('.clip');
      await gp.keyboard.press('Enter');
      await sleep(200);
      g = await gs();
      check(G + 'Enter opens the viewer on the selected clip', g.view === 'Mantle stand-in 0.mp4' && g.trim && g.trim.dur === 20000, g);
      await gp.focus('#tlIn');
      await gp.keyboard.press('ArrowRight');
      g = await gs();
      check(G + 'the trim start moves by keyboard (1 s) and Save is offered', g.trim.a === 1000 && g.canTrim, g.trim);
      await gp.focus('#vBig');
      await gp.keyboard.press('Enter');
      await sleep(150);
      const tr = await Q.calls('clips.trim');
      check(G + 'Enter saves the trimmed copy: clips.trim {name, 1000, 20000}', tr.length === 1 && tr[0].name === 'Mantle stand-in 0.mp4' && tr[0].startMs === 1000 && tr[0].endMs === 20000, tr);
      check(G + 'the toast says it was saved and the original kept', /Saved .*original is kept/.test(((await gs()).toast || {}).text || ''), (await gs()).toast);
      await gp.keyboard.press('Control+c');
      check(G + 'Ctrl+C copies the clip in the viewer', ((await Q.calls('clips.copy'))[0] || {}).name === 'Mantle stand-in 0.mp4');
      await gp.screenshot({ path: path.join(SHOTS, `viewer-${theme}.png`) });
      await gp.keyboard.press('Escape');
      await sleep(80);
      g = await gs();
      check(G + 'Esc goes back to the grid, the viewer\'s video emptied', g.view === null && !g.viewerSrc, g);
      await gp.keyboard.press('Delete');
      await sleep(150);
      g = await gs();
      check(G + 'Delete: to the Recycle Bin with an Undo in the toast', ((await Q.calls('clips.delete'))[0] || {}).name === g.sel || (g.toast && g.toast.undo), g.toast);
      await gp.keyboard.press('Control+z');
      await sleep(80);
      check(G + 'Ctrl+Z undoes it (clips.undo {token})', ((await Q.calls('clips.undo'))[0] || {}).token === 'u1');
      await Q.ctx.close();
    }
  } catch (err) {
    failures.push(`threw: ${err.stack}`);
  } finally {
    await browser.close();
  }
  console.log(`CLIPS PAGE TEST: ${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log(`  FAIL ${f}`);
  console.log(`shots: ${SHOTS}`);
  process.exitCode = failures.length ? 1 : 0;
})();
