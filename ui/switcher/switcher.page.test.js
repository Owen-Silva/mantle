require('C:/Users/user/dev-tools/tools/lowcpu.js');
/* switcher.page.test.js — the Alt+Tab overlay's page, driven through its REAL code (quality pass,
 * switcher lane, 2026-09-29).
 *
 * WHAT IT IS: headless chromium over file:// (never Electron, never the sidecar, never a keyboard
 * hook, nothing switched or focused on this machine). An init script puts a FAKE window.mantle in
 * place before the page's scripts run (so mock-mantle.js stands aside, as it does for the real
 * preload), records every call the page makes, and lets this file play main: it hands the page
 * sessions, moves, ends, icons, thumbnail answers, backdrops and notices exactly as lib/switcher.js
 * sends them, laid out with the same ui/switcher/layout.js main uses. The mouse is REAL (Playwright
 * clicks on the tiles and the notice), so a click is tested end to end up to switcher.pick.
 *
 * Also checked in every state: no jargon on screen (BRIEF: never "sidecar", "hwnd", "DWM", error
 * codes, "undefined", "null", "NaN", "[object Object]"), in the text AND in the hover titles.
 *
 *   node ui/switcher/switcher.page.test.js       (MANTLE_SHOOT_OUT=<dir> for the PNGs)
 * Prints "switcher page tests: n passed, m failed"; exits 1 if anything failed. A running game = not run.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const Lay = require('./layout.js');

const PAGE = 'file:///' + path.resolve(__dirname, 'index.html').replace(/\\/g, '/');
const OUT = process.env.MANTLE_SHOOT_OUT || path.join(require('os').tmpdir(), 'mantle-switcher-page-shots');

let passed = 0;
const failures = [];
const check = (name, ok, detail) => { if (ok) passed++; else failures.push(detail ? `${name} (${String(detail).slice(0, 300)})` : name); return ok; };

function gaming() {
  try {
    return Number(execSync('powershell -NoProfile -Command "@(Get-Process VALORANT*,javaw,Minecraft*,RobloxPlayerBeta -ErrorAction SilentlyContinue).Count"', { encoding: 'utf8' }).trim()) || 0;
  } catch (_) { return -1; }
}

/* Runs IN THE PAGE before its scripts: the fake bridge. */
const FAKE = `
  (function () {
    var L = {};
    window.__calls = [];
    window.__answers = {};
    window.mantle = {
      on: function (name, cb) { (L[name] = L[name] || []).push(cb); return function () {}; },
      call: function (name, args) {
        window.__calls.push({ name: name, args: args === undefined ? null : JSON.parse(JSON.stringify(args)) });
        var a = window.__answers[name];
        if (a === 'reject') return Promise.reject(new Error('the sidecar did not answer (hwnd 0x1234)'));
        return Promise.resolve(a || { ok: true });
      },
    };
    window.__emit = function (name, p) { (L[name] || []).forEach(function (cb) { cb(p); }); };
  })();
`;

const JARGON = /sidecar|hwnd|\bDWM\b|HRESULT|0x[0-9a-f]{3,}|\bE_[A-Z]+|undefined|\bnull\b|\bNaN\b|\[object|\bIPC\b|renderer|preload|window\.mantle|dryRun|ENOENT|Exception|stack/i;

function win(i, extra) {
  return Object.assign({ hwnd: String(4000 + i), title: `Window ${i + 1}`, pid: 100 + i, minimized: false, hung: false }, extra || {});
}

async function screenText(p) {
  return p.evaluate(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden'; };
    const parts = [];
    for (const el of document.querySelectorAll('body *')) {
      if (!vis(el)) continue;
      if (el.title) parts.push(el.title);
      for (const n of el.childNodes) if (n.nodeType === 3 && n.textContent.trim()) parts.push(n.textContent.trim());
    }
    return parts.join(' | ');
  });
}

async function noJargon(p, where) {
  const t = await screenText(p);
  const m = t.match(JARGON);
  check(`${where}: no jargon on screen`, !m, m ? `"${m[0]}" in: ${t}` : '');
}

async function calls(p, name) { return p.evaluate((n) => window.__calls.filter((c) => c.name === n).map((c) => c.args), name); }
async function clearCalls(p) { await p.evaluate(() => { window.__calls = []; }); }

async function session(p, list, opts) {
  const o = opts || {};
  const lay = Lay.layout(list.length, o.workW || 1920, o.workH || 1040);
  await p.setViewportSize({ width: Math.max(1, Math.round(lay.w)), height: Math.max(1, Math.round(lay.h)) });
  // main sizes the window BEFORE it sends the session; let that resize land first, or the page's
  // resize report races the session's own and the test counts two
  await p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await clearCalls(p);
  await p.evaluate((a) => window.__emit('switcher.session', a), { seq: o.seq || 1, sel: o.sel === undefined ? (list.length > 1 ? 1 : 0) : o.sel, current: 0, backwards: false, tracking: o.tracking !== false, list, lay });
  await p.waitForTimeout(120);
  return lay;
}

async function selIndex(p) {
  return p.evaluate(() => [...document.querySelectorAll('.tile')].map((t) => (t.classList.contains('is-sel') && t.getAttribute('aria-selected') === 'true' ? 1 : 0)).indexOf(1));
}

async function run(p) {
  /* -- load: the page says it is ready -------------------------------------------------------- */
  check('load: switcher.ready is called once the page is up', (await calls(p, 'switcher.ready')).length === 1);

  /* -- a normal Alt+Tab: 3 windows, one hung, one minimized, one with a very long title ------- */
  const long = 'A very long document title that goes on and on - Quarterly report final FINAL v7 (edited) - Word';
  const list = [win(0), win(1, { title: long, minimized: true }), win(2, { hung: true })];
  const lay = await session(p, list);
  check('session: one tile per window', await p.$$eval('.tile', (t) => t.length) === 3);
  check('session: the second tile is selected (a quick tap goes back to the previous window)', await selIndex(p) === 1);
  check('session: the listbox has an accessible name', (await p.getAttribute('#grid', 'aria-label')) === 'Open windows');
  const painted = await calls(p, 'switcher.painted');
  check('session: the page reports its preview boxes once drawn', painted.length === 1 && painted[0].seq === 1 && painted[0].boxes.length === 3, JSON.stringify(painted));
  if (painted[0]) {
    const b = painted[0].boxes;
    check('session: each box is its own window, in list order', b.map((x) => x.hwnd).join() === list.map((x) => x.hwnd).join());
    check('session: each box is exactly the layout\'s preview size', b.every((x) => Math.abs(x.w - lay.previewW) < 0.6 && Math.abs(x.h - lay.previewH) < 0.6), JSON.stringify(b[0]));
    check('session: the page answers for the window size main set', Math.abs(painted[0].vw - lay.w) <= 1 && Math.abs(painted[0].vh - lay.h) <= 1);
  }
  const ell = await p.$eval('.tile[data-i="1"] .ttl', (e) => ({ over: e.scrollWidth > e.clientWidth, tip: e.closest('.tile').title }));
  check('long title: it ellipsizes and the full title is on hover', ell.over && ell.tip === long, JSON.stringify(ell));
  const chips = await p.$$eval('.chip', (c) => c.map((x) => ({ t: x.textContent, warn: x.classList.contains('warn') })));
  check('hung window: says it is not responding, as a warning', chips.some((c) => /not responding/i.test(c.t) && c.warn), JSON.stringify(chips));
  check('minimized window: says so, quietly', chips.some((c) => /minimized/i.test(c.t) && !c.warn), JSON.stringify(chips));
  await noJargon(p, 'session');
  await p.screenshot({ path: path.join(OUT, 'page-01-session.png') });

  /* -- moving the selection ------------------------------------------------------------------ */
  await p.evaluate(() => window.__emit('switcher.move', { seq: 1, sel: 2, key: 'next' }));
  check('move: Tab moves the ring to the next tile, and only one tile is selected', await selIndex(p) === 2 && await p.$$eval('.tile.is-sel', (t) => t.length) === 1);
  await p.evaluate(() => window.__emit('switcher.move', { seq: 99, sel: 0, key: 'next' }));
  check('move: a move from another Alt+Tab is ignored', await selIndex(p) === 2);

  /* -- icons arrive late: the letter stand-in is replaced, a broken image falls back ---------- */
  await p.evaluate(() => window.__emit('switcher.icons', { seq: 1, icons: { 4000: { icon: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=' }, 4001: { icon: 'data:image/png;base64,broken' } } }));
  await p.waitForTimeout(150);
  const icos = await p.$$eval('.tile .ico', (e) => e.map((x) => x.tagName));
  check('icons: a real icon replaces the stand-in, a broken one falls back instead of a blank', icos[0] === 'IMG' && icos[1] === 'SPAN', icos.join());

  /* -- a click on a tile switches to it (the REAL mouse) ------------------------------------- */
  await clearCalls(p);
  await p.click('.tile[data-i="0"]');
  await p.waitForTimeout(80);
  const picks = await calls(p, 'switcher.pick');
  check('click: a click on tile 1 asks main to switch to it', picks.length === 1 && picks[0].seq === 1 && picks[0].index === 0, JSON.stringify(picks));
  await p.evaluate(() => { window.__answers['switcher.pick'] = { ok: false, reason: 'the click could not reach the sidecar: timed out' }; });
  await p.click('.tile[data-i="2"]');
  await p.waitForTimeout(80);
  check('click: a click that did not switch says so, and what to do instead', /didn't switch\. Let go of Alt/.test(await p.textContent('#foot')), await p.textContent('#foot'));
  await noJargon(p, 'click refused');
  await p.evaluate(() => { window.__answers['switcher.pick'] = 'reject'; });
  await p.click('.tile[data-i="1"]');
  await p.waitForTimeout(80);
  await noJargon(p, 'click rejected');
  await p.evaluate(() => { delete window.__answers['switcher.pick']; });

  /* -- previews that failed: plain reasons in the boxes, and one line in the foot ------------ */
  await p.evaluate(() => window.__emit('switcher.thumbs', { seq: 1, ok: true, reason: null, thumbs: [
    { hwnd: '4000', ok: false, reason: 'no picture: DWM refused access (E_ACCESSDENIED): the window belongs to a process Mantle is not allowed to preview' },
    { hwnd: '4001', ok: false, reason: 'no picture: Windows is hiding it: it is on another virtual desktop, or it is a suspended Store app' },
    { hwnd: '4002', ok: false, gone: true, reason: 'this window has closed' },
  ] }));
  const whys = await p.$$eval('.pv-why', (e) => e.map((x) => x.textContent));
  check('previews failed: each box says why, in plain words', /doesn't let Mantle preview/.test(whys[0]) && /out of sight/.test(whys[1]) && /has closed/.test(whys[2]), JSON.stringify(whys));
  check('previews failed: the foot says previews are not available', /Previews aren't available/.test(await p.textContent('#foot')));
  await noJargon(p, 'previews failed');
  await p.screenshot({ path: path.join(OUT, 'page-02-previews-failed.png') });
  await p.evaluate(() => window.__emit('switcher.thumbs', { seq: 1, ok: true, reason: null, thumbs: [{ hwnd: '4000', ok: true }, { hwnd: '4001', ok: true }, { hwnd: '4002', ok: true }] }));
  check('previews back: the reasons clear', (await p.$$eval('.pv-why', (e) => e.map((x) => x.textContent).join(''))) === '');

  /* -- the backdrop: a failed capture is said, plainly --------------------------------------- */
  await p.evaluate(() => window.__emit('switcher.backdrop', { seq: 1, png: null, reason: 'the sidecar answered "backdrop" without a png' }));
  check('backdrop failed: one plain line, no machinery', /No background blur/.test(await p.textContent('#foot')), await p.textContent('#foot'));
  check('backdrop failed: the pane carries its own tint (no-backdrop)', await p.evaluate(() => document.body.classList.contains('no-backdrop')));
  await noJargon(p, 'backdrop failed');

  /* -- the end of the Alt+Tab empties the page ----------------------------------------------- */
  await p.evaluate(() => window.__emit('switcher.end', { seq: 1, why: 'switching' }));
  check('end: the tiles and the foot are gone', await p.$$eval('.tile', (t) => t.length) === 0 && (await p.textContent('#foot')) === '');
  await clearCalls(p);
  await p.click('#panel', { position: { x: 10, y: 10 }, force: true }).catch(() => {});
  check('end: a click after the end asks for nothing', (await calls(p, 'switcher.pick')).length === 0);

  /* -- stacking order instead of recent use -------------------------------------------------- */
  await session(p, [win(0), win(1)], { seq: 2, tracking: false });
  check('order: when recent use is unknown, it says the order is the screen order', /screen order/.test(await p.textContent('#foot')), await p.textContent('#foot'));
  await noJargon(p, 'stacking order');
  await p.evaluate(() => window.__emit('switcher.end', { seq: 2, why: 'x' }));

  /* -- nothing open -------------------------------------------------------------------------- */
  await session(p, [], { seq: 3, sel: -1 });
  const empty = await p.evaluate(() => ({ on: document.body.classList.contains('is-empty'), text: document.getElementById('empty').innerText, shown: getComputedStyle(document.getElementById('empty')).display !== 'none', tiles: document.querySelectorAll('.tile').length }));
  check('empty: says "No open windows", no tiles', empty.on && empty.shown && empty.text === 'No open windows' && empty.tiles === 0, JSON.stringify(empty));
  await p.screenshot({ path: path.join(OUT, 'page-03-empty.png') });
  await p.evaluate(() => window.__emit('switcher.end', { seq: 3, why: 'x' }));

  /* -- dozens of windows on a small screen: whole rows scroll, and it says how many are hidden -- */
  const many = Array.from({ length: 40 }, (_, i) => win(i));
  const lay2 = await session(p, many, { seq: 4, workW: 1280, workH: 680 });
  check('many: the layout scrolls on a small screen', lay2.scroll === true, JSON.stringify({ rows: lay2.rows, vis: lay2.visibleRows }));
  check('many: the foot says how many are below', new RegExp(`${40 - lay2.visibleRows * lay2.cols} more below`).test(await p.textContent('#foot')), await p.textContent('#foot'));
  const firstPaint = (await calls(p, 'switcher.painted'))[0];
  check('many: only the visible rows get preview boxes', firstPaint && firstPaint.boxes.length === lay2.visibleRows * lay2.cols, firstPaint && firstPaint.boxes.length);
  await clearCalls(p);
  await p.evaluate(() => window.__emit('switcher.move', { seq: 4, sel: 39, key: 'prev' }));
  await p.waitForTimeout(120);
  const scrolled = await calls(p, 'switcher.painted');
  check('many: moving to the last window scrolls and re-reports the boxes', scrolled.length === 1 && scrolled[0].why === 'scroll' && scrolled[0].boxes.some((b) => b.hwnd === '4039'), JSON.stringify(scrolled.map((s) => s.why)));
  check('many: ...and the foot now says how many are above', /more above/.test(await p.textContent('#foot')));
  await p.screenshot({ path: path.join(OUT, 'page-04-many.png') });
  await p.evaluate(() => window.__emit('switcher.end', { seq: 4, why: 'x' }));

  /* -- the "could not switch" notice, and clicking it away -------------------------------- */
  await clearCalls(p);
  const n = Lay.notice();
  await p.setViewportSize({ width: n.w, height: n.h });
  await p.evaluate((lay) => window.__emit('switcher.notice', { id: 5, title: "Task Manager isn't responding, so Windows wouldn't bring it to the front.", text: 'Give it a moment and try again, or end it in Task Manager (Ctrl+Shift+Esc).', lay }), n);
  await p.waitForTimeout(120);
  const note = await p.evaluate(() => ({ on: document.body.classList.contains('noting'), t: document.getElementById('noteTitle').textContent, role: document.getElementById('note').getAttribute('role') }));
  check('notice: shown, with its sentence, as an alert', note.on && /isn't responding/.test(note.t) && note.role === 'alert', JSON.stringify(note));
  check('notice: the page reports it drawn so main can put it on screen', (await calls(p, 'switcher.painted')).some((c) => c.notice === 5));
  await noJargon(p, 'notice');
  await p.screenshot({ path: path.join(OUT, 'page-05-notice.png') });
  await p.click('#note');
  await p.waitForTimeout(60);
  check('notice: a click on it dismisses it', (await calls(p, 'switcher.dismiss')).length === 1);
  await p.evaluate(() => window.__emit('switcher.notice.end', { id: 5, why: 'clicked' }));
  check('notice: gone at its end', !(await p.evaluate(() => document.body.classList.contains('noting'))));

  await liveList(p);
}

/* -- THE LIVE LIST (lane mn-alttab, 2026-10-12): windows open and close while the switcher is up ---
   main sends 'switcher.windows' exactly as lib/switcher.js onReflow does: the sidecar's merged list,
   Layout.reflow's geometry, the window's own size (never smaller than at open). */
async function liveList(p) {
  const W = 1920;
  const H = 1040;
  const L = Lay.L;
  // Windows' own "Animation effects" setting reaches Chromium as prefers-reduced-motion; the motion
  // is checked with it off here, and with it on at the end (no animation at all then).
  await p.emulateMedia({ reducedMotion: 'no-preference' });
  let list = Array.from({ length: 9 }, (_, i) => win(10 + i));
  const lay0 = await session(p, list, { seq: 7, sel: 1 });
  let lay = lay0;
  let winSz = { w: lay0.w, h: lay0.h };
  // a real backdrop, so pinning and fading it can be seen (a 4x4 grey PNG made on the page)
  await p.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 4; c.height = 4;
    const g = c.getContext('2d'); g.fillStyle = '#777'; g.fillRect(0, 0, 4, 4);
    window.__emit('switcher.backdrop', { seq: 7, png: c.toDataURL('image/png'), w: 4, h: 4, shown: false });
  });
  await p.waitForTimeout(150);
  check('live: the backdrop is on before anything changes', await p.evaluate(() => document.getElementById('bdrop').classList.contains('on')));
  await p.evaluate(() => { [...document.querySelectorAll('.tile')].forEach((t, i) => { t.__born = 'open-' + i; }); });
  const panelBox = () => p.evaluate(() => { const r = document.getElementById('panel').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
  const tilesNow = () => p.evaluate(() => [...document.querySelectorAll('.tile')].map((t) => ({ hwnd: t.dataset.hwnd, born: t.__born || null, i: Number(t.dataset.i), sel: t.classList.contains('is-sel'), aria: t.getAttribute('aria-selected'), isNew: t.classList.contains('is-new'), anim: getComputedStyle(t).animationName, dur: getComputedStyle(t).animationDuration, ttl: t.querySelector('.ttl').textContent, chip: (t.querySelector('.chip') || {}).textContent || null })));
  const reflow = async (next, sel, o) => {
    const opt = o || {};
    lay = Lay.reflow(next.length, W, H, lay);
    let grew = false;
    if (lay.w > winSz.w + 0.5 || lay.h > winSz.h + 0.5) {
      grew = true;
      winSz = { w: Math.max(winSz.w, lay.w), h: Math.max(winSz.h, lay.h) };
      await p.setViewportSize({ width: Math.round(winSz.w), height: Math.round(winSz.h) });
      await p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    }
    await clearCalls(p);
    list = next;
    await p.evaluate((a) => window.__emit('switcher.windows', a), { seq: opt.seq || 7, sel, current: 0, list: next, lay, win: winSz, grew, added: 0, removed: 0 });
    await p.waitForTimeout(opt.wait || 120);
    return grew;
  };
  const w0 = await panelBox();
  check('live: 9 windows open in 5 + 4 (the layout this test builds on)', lay0.cols === 5 && lay0.rows === 2, JSON.stringify({ cols: lay0.cols, rows: lay0.rows }));

  // 1. a window opens: in place, the others are the SAME elements, the selection stays on its window
  const fresh = win(40, { title: 'Just opened' });
  await reflow([...list.slice(0, 3), fresh, ...list.slice(3)], 1);
  let t = await tilesNow();
  check('live open: one more tile, in the merged order', t.length === 10 && t.map((x) => x.hwnd).join() === list.map((x) => x.hwnd).join(), t.map((x) => x.hwnd).join());
  check('live open: every tile that was there is the same element (re-rendered in place, no rebuild)', t.filter((x) => x.hwnd !== fresh.hwnd).every((x) => x.born && x.born.startsWith('open-')), JSON.stringify(t.map((x) => x.born)));
  check('live open: the new tile fades in on the shared motion token (tile-in, --m-dur-xs, lane mantle-motion)', t[3].isNew && t[3].anim === 'tile-in' && t[3].dur === '0.24s' && !t[3].born, JSON.stringify(t[3]));
  check('live open: no other tile animates', t.filter((x, i) => i !== 3).every((x) => x.anim === 'none' || !x.isNew));
  check('live open: the selection stays on the same window', t[1].sel && t[1].aria === 'true' && t.filter((x) => x.sel).length === 1);
  check('live open: indexes follow the new order (a click is the right tile)', t.every((x, i) => x.i === i));
  let w1 = await panelBox();
  check('live open: no width jump (5 columns kept, the 10th fills the empty slot)', Math.abs(w1.w - w0.w) < 0.5 && Math.abs(w1.x - w0.x) < 0.5 && Math.abs(w1.h - w0.h) < 0.5, JSON.stringify({ w0, w1 }));
  let rep = await calls(p, 'switcher.painted');
  check('live open: the page reports the new boxes once (previews follow)', rep.length === 1 && rep[0].why === 'reflow' && rep[0].boxes.length === 10 && rep[0].boxes[3].hwnd === fresh.hwnd, JSON.stringify(rep.map((r) => [r.why, r.boxes && r.boxes.length])));
  check('live open: ...for the window size main has', rep[0] && Math.abs(rep[0].vw - winSz.w) <= 1 && Math.abs(rep[0].vh - winSz.h) <= 1);
  await p.screenshot({ path: path.join(OUT, 'page-06-live-open.png') });

  // 2. the SELECTED window closes: the sidecar moved the selection to the neighbour (same index)
  const goneHwnd = list[1].hwnd;
  const nb = list[2].hwnd;
  await reflow(list.filter((x) => x.hwnd !== goneHwnd), 1);
  t = await tilesNow();
  check('live close: the closed window\'s tile is gone', t.length === 9 && !t.some((x) => x.hwnd === goneHwnd));
  check('live close: the selection is on the neighbour that slid into its place', t[1].hwnd === nb && t[1].sel);
  check('live close: the rest are still the same elements', t.filter((x) => x.hwnd !== fresh.hwnd).every((x) => x.born));
  w1 = await panelBox();
  check('live close: no width jump', Math.abs(w1.w - w0.w) < 0.5 && Math.abs(w1.x - w0.x) < 0.5);

  // 3. a minimise and a rename: in place, the chip and the caption follow
  const renamed = list.map((x, i) => (i === 4 ? Object.assign({}, x, { title: 'Renamed window', minimized: true }) : x));
  await reflow(renamed, 1);
  t = await tilesNow();
  check('live update: the caption follows a rename, on the same element', t[4].ttl === 'Renamed window' && !!t[4].born, JSON.stringify(t[4]));
  check('live update: a minimised window gets its chip', t[4].chip === 'Minimized');
  await reflow(list.map((x, i) => (i === 4 ? Object.assign({}, x, { minimized: false }) : x)), 1);
  t = await tilesNow();
  check('live update: ...and loses it when restored', t[4].chip === null);

  // 4. down to one row: the panel loses a row and glides; its width and centre stay
  await reflow(list.slice(0, 5), 1);
  t = await tilesNow();
  w1 = await panelBox();
  const glide = await p.evaluate(() => ({ live: document.body.classList.contains('is-live'), tp: getComputedStyle(document.getElementById('panel')).transitionProperty, td: getComputedStyle(document.getElementById('panel')).transitionDuration }));
  check('live shrink: 5 tiles, one row', t.length === 5 && lay.rows === 1);
  // lane mantle-motion: only transform and opacity ever animate (motion-unison.md), so the row goes at once, not by a height glide
  check('live shrink: the panel takes its new height at once (no height transition: no layout per frame)', glide.live && !/height/.test(glide.tp), JSON.stringify(glide));
  await p.waitForTimeout(260);
  w1 = await panelBox();
  check('live shrink: same width, same centre, same top; only the height changed', Math.abs(w1.w - w0.w) < 0.5 && Math.abs(w1.x - w0.x) < 0.5 && Math.abs(w1.y - w0.y) < 0.5 && w1.h < w0.h - 50, JSON.stringify({ w0, w1 }));
  const vw = await p.evaluate(() => window.innerWidth);
  check('live shrink: the window did not shrink (main never shrinks it mid-session)', Math.abs(vw - winSz.w) <= 1);

  // 5. a single row gets shorter: narrower, still centred; the backdrop stays where it was taken
  await reflow(list.slice(0, 3), 0);
  w1 = await panelBox();
  check('live narrow: the single row is narrower and stays centred in the window', w1.w < w0.w - 100 && Math.abs((w1.x + w1.w / 2) - vw / 2) < 0.6, JSON.stringify({ w1, vw }));
  const bc = await p.evaluate(() => { const c = document.getElementById('backdrop').getBoundingClientRect(); return { x: c.left, y: c.top, w: c.width, h: c.height, on: document.getElementById('bdrop').classList.contains('on') }; });
  check('live narrow: the backdrop picture is pinned where it was taken, not stretched', bc.on && Math.abs(bc.x - (L.margin - 14)) < 0.6 && Math.abs(bc.y - (L.margin - 14)) < 0.6 && Math.abs(bc.w - (lay0.panelW + 28)) < 0.6, JSON.stringify(bc));
  check('live narrow: the selection is where main says', (await selIndex(p)) === 0);

  // 6. a stale update (another Alt+Tab's) changes nothing
  const before = (await tilesNow()).map((x) => x.hwnd).join();
  await p.evaluate((a) => window.__emit('switcher.windows', a), { seq: 6, sel: 0, current: 0, list: [win(90)], lay: Lay.layout(1, W, H), win: winSz, grew: false });
  await p.waitForTimeout(60);
  check('live: an update for another Alt+Tab is ignored', (await tilesNow()).map((x) => x.hwnd).join() === before);

  // 7. a click after the list changed carries its window, so main can route it right
  await clearCalls(p);
  await p.click('.tile[data-i="2"]');
  await p.waitForTimeout(60);
  const pk = await calls(p, 'switcher.pick');
  check('live click: switcher.pick carries the tile\'s window as well as its index', pk.length === 1 && pk[0].index === 2 && pk[0].hwnd === list[2].hwnd, JSON.stringify(pk));

  // 8. the window must grow (3 columns kept, 9 windows = 3 rows): the backdrop fades out, and says so
  const more = [...list, ...Array.from({ length: 6 }, (_, i) => win(60 + i))];
  const grew = await reflow(more, 0, { wait: 260 });
  const g = await p.evaluate(() => ({ on: document.getElementById('bdrop').classList.contains('on'), bare: document.body.classList.contains('no-backdrop'), foot: document.getElementById('foot').textContent, n: document.querySelectorAll('.tile').length }));
  check('live grow: the window had to grow for 3 rows', grew && lay.rows === 3 && lay.cols === 3, JSON.stringify({ grew, rows: lay.rows, cols: lay.cols }));
  check('live grow: the backdrop it no longer covers fades out to the plain pane, and the foot says so', !g.on && g.bare && /No background blur/.test(g.foot) && g.n === 9, JSON.stringify(g));
  rep = await calls(p, 'switcher.painted');
  check('live grow: the report is for the grown window', rep.length >= 1 && rep.every((r) => Math.abs(r.vw - winSz.w) <= 1 && Math.abs(r.vh - winSz.h) <= 1), JSON.stringify(rep.map((r) => [r.vw, r.vh])));
  await noJargon(p, 'live list');
  await p.screenshot({ path: path.join(OUT, 'page-07-live-grown.png') });

  // 9. everything closes, then one opens: the empty panel, then a selected tile
  await reflow([], -1);
  const empty = await p.evaluate(() => ({ e: document.body.classList.contains('is-empty'), n: document.querySelectorAll('.tile').length }));
  check('live empty: every window closed shows the empty panel', empty.e && empty.n === 0, JSON.stringify(empty));
  await reflow([win(70)], 0);
  t = await tilesNow();
  check('live empty: a window opening then is a selected tile', t.length === 1 && t[0].sel && !(await p.evaluate(() => document.body.classList.contains('is-empty'))));
  await p.emulateMedia({ reducedMotion: 'reduce' });
  await reflow([win(70), win(71)], 0);
  t = await tilesNow();
  check('live, reduced motion: a new tile just appears (no animation)', t.length === 2 && t[1].isNew && t[1].anim === 'none', JSON.stringify(t[1] && { anim: t[1].anim }));
  await p.emulateMedia({ reducedMotion: null });
  await p.evaluate(() => window.__emit('switcher.end', { seq: 7, why: 'x' }));
}

(async () => {
  const g = gaming();
  if (g !== 0) { console.log(g > 0 ? 'NOT RUN: a game is running' : 'NOT RUN: could not check for a running game'); console.log('switcher page tests: 0 passed, 1 failed'); process.exitCode = 1; return; }
  fs.mkdirSync(OUT, { recursive: true });
  const { chromium } = require('C:/Users/user/other-app/node_modules/playwright-core');
  const browser = await require('../settings/test-browser.js').launch(chromium, { timeout: 0, headless: true });
  themeEvery(browser);   // MANTLE_THEME=dark|light: <html data-theme> + the mantle-theme event, as dm-core's plumbing does
  try {
    const ctx = await browser.newContext({ viewport: { width: 600, height: 300 }, deviceScaleFactor: 1 });
    await ctx.addInitScript(FAKE);
    const p = await ctx.newPage();
    const errors = [];
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await p.goto(PAGE, { waitUntil: 'load' });
    await p.waitForTimeout(100);
    await run(p);
    check('no page errors while all of that ran', errors.length === 0, errors.join(' / '));
  } catch (err) {
    check('the page tests ran to the end', false, err && err.stack ? err.stack : err);
  } finally {
    await browser.close();
  }
  for (const f of failures) console.log(`FAIL ${f}`);
  console.log(`shots: ${OUT}`);
  console.log(`switcher page tests: ${passed} passed, ${failures.length} failed`);
  process.exitCode = failures.length ? 1 : 0;
})();

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
