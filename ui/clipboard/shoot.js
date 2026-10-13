require('C:/Users/user/dev-tools/tools/lowcpu.js');
/* shoot.js — headless screenshots of the Win+V clipboard panel, plus what they must prove.
 *
 * Line 1 is the machine-wide CPU cap and browser lock (required). Nothing here runs Electron or
 * the sidecar, and Owen's clipboard is never touched: the page loads over file:// with
 * mock-mantle.js playing main, and every item is a fixture.
 *
 * CHECKED, not just photographed:
 *   1. THE TEXT'S CONTRAST, as rendered, off the screenshot itself (the switcher's method): the
 *      ink (the 1% end of each text box) against its ground (the median). WCAG asks 4.5:1.
 *   2. THE KEYS, driven with real key presses into the headless page: arrows move, P pins while
 *      the filter is empty, a typed p goes INTO a non-empty filter, Ctrl+P pins there, "/" arms
 *      the filter so it can start with p, Del deletes and keeps the index, Enter pastes, Esc closes.
 *   3. THE PANEL IS WHOLLY ON SCREEN wherever the caret is (model.place), in every shot.
 *
 *   node ui/clipboard/shoot.js       (MANTLE_SHOOT_OUT=<dir> to choose where the PNGs go)
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { chromium } = require('C:/Users/user/other-app/node_modules/playwright-core');

const PAGE = 'file:///' + path.join(__dirname, 'index.html').replace(/\\/g, '/');   // this checkout's page
const OUT = process.env.MANTLE_SHOOT_OUT ||
  'C:/Users/user/AppData/Local/Temp/claude/C--Users-owens/fe6c395c-2ffc-4958-a961-d5833371924e/scratchpad/clip/shots';

const SHOTS = [];
for (const dark of [0, 1]) {
  const d = dark ? '-dark' : '';
  SHOTS.push({ name: '1280x720-n6' + d, w: 1280, h: 720, q: `n=6&dark=${dark}` });
  SHOTS.push({ name: '1280x720-empty' + d, w: 1280, h: 720, q: `n=0&dark=${dark}` });
  SHOTS.push({ name: '1920x1080-n40-sel12' + d, w: 1920, h: 1080, q: `n=40&sel=12&dark=${dark}` });
  SHOTS.push({ name: '1280x720-filter' + d, w: 1280, h: 720, q: `n=6&q=meeting&dark=${dark}` });
  SHOTS.push({ name: '1280x720-nomatch' + d, w: 1280, h: 720, q: `n=6&q=zzzz&dark=${dark}` });
  SHOTS.push({ name: '1280x720-admin' + d, w: 1280, h: 720, q: `n=6&banner=admin&dark=${dark}` });
  SHOTS.push({ name: '1280x720-off' + d, w: 1280, h: 720, q: `n=6&banner=off&dark=${dark}` });
  SHOTS.push({ name: '1280x720-notice' + d, w: 1280, h: 720, q: `n=6&notice=1&dark=${dark}` });
  SHOTS.push({ name: '1280x720-skipped' + d, w: 1280, h: 720, q: `n=6&banner=skipped&dark=${dark}` });
  SHOTS.push({ name: '1280x720-private' + d, w: 1280, h: 720, q: `n=6&banner=private&dark=${dark}` });
}

const CONTRAST = async (b64) => {
  const img = new Image();
  img.src = 'data:image/png;base64,' + b64;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0);
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const out = [];
  const els = Array.from(document.querySelectorAll('.title, .count, .chip, .filter input, .banner, .txt, .file span, .more, .meta, .empty-t, .empty-x, .note-t, .note-x, .foot span'))
    .filter((e) => (e.value || e.textContent).trim() && e.getClientRects().length);
  for (const e of els) {
    const r = e.getBoundingClientRect();
    const x0 = Math.max(0, Math.floor(r.left)), y0 = Math.max(0, Math.floor(r.top));
    const x1 = Math.min(c.width, Math.ceil(r.right)), y1 = Math.min(c.height, Math.ceil(r.bottom));
    if (x1 - x0 < 4 || y1 - y0 < 4) continue;
    const hit = document.elementFromPoint((x0 + x1) / 2, (y0 + y1) / 2);
    if (!hit || !(hit === e || e.contains(hit) || hit.contains(e))) continue;
    // a row clipped by the list's scroll box is not on screen
    const list = document.getElementById('list').getBoundingClientRect();
    if (e.closest('.list') && (r.top < list.top - 1 || r.bottom > list.bottom + 1)) continue;
    const d = g.getImageData(x0, y0, x1 - x0, y1 - y0).data;
    const L = [];
    for (let i = 0; i < d.length; i += 4) L.push(0.2126 * lin(d[i]) + 0.7152 * lin(d[i + 1]) + 0.0722 * lin(d[i + 2]));
    L.sort((a, b) => a - b);
    const ground = L[Math.floor(L.length * 0.5)];
    const cr = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    const ratio = Math.round(Math.max(cr(L[Math.floor(L.length * 0.01)], ground), cr(L[Math.floor(L.length * 0.99)], ground)) * 10) / 10;
    out.push({ what: `${e.className.split(' ')[0] || e.tagName} "${(e.value || e.textContent).trim().slice(0, 22)}"`, ratio });
  }
  out.sort((a, b) => a.ratio - b.ratio);
  return { n: out.length, worst: out[0] || null, median: out.length ? out[Math.floor(out.length / 2)].ratio : null };
};

function gamesRunning() {
  const out = execFileSync('powershell', ['-NoProfile', '-Command',
    '@(Get-Process javaw,Minecraft*,RobloxPlayerBeta,*Riot*,VALORANT* -ErrorAction SilentlyContinue).Count'],
  { encoding: 'utf8' }).trim();
  return out === '0' ? 0 : (Number(out) || 1);
}

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) pass++;
  else { fail++; console.log('FAIL ' + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail) : '')); }
}

const state = (page) => page.evaluate(() => {
  const S = window.__clip, m = window.__mock;
  const sel = S.shown[S.sel] || null;
  return {
    sel: S.sel, selId: sel && sel.id, selPinned: sel && sel.pinned, n: S.shown.length, total: S.items.length,
    query: document.getElementById('q').value, armed: S.armed, pasted: m.pasted, closed: m.closed,
    focus: document.activeElement && document.activeElement.id,
    selVisible: (() => { const r = document.querySelector('.row.sel'); if (!r) return null; const a = r.getBoundingClientRect(), b = document.getElementById('list').getBoundingClientRect(); return a.top >= b.top - 1 && a.bottom <= b.bottom + 1; })(),
    foot: document.getElementById('foot').textContent,
  };
});

// Not page.fill(''): Playwright clears a box by selecting it and pressing Delete, which is a
// list key here. The page's own input event is what a real Backspace-to-empty produces.
const clearFilter = (page) => page.evaluate(() => {
  const q = document.getElementById('q');
  q.value = '';
  q.dispatchEvent(new Event('input'));
});

async function keys(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(e.message));
  await page.goto(`${PAGE}?n=6`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__mock && window.__mock.ready && window.__mock.painted);
  let s = await state(page);
  check('keys: opens with the first item selected and the filter focused', s.sel === 0 && s.focus === 'q', s);
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown');
  s = await state(page);
  check('keys: ArrowDown x2 selects the third item', s.sel === 2, s.sel);
  await page.keyboard.press('ArrowUp');
  s = await state(page);
  check('keys: ArrowUp goes back one', s.sel === 1, s.sel);
  const before = s.selPinned;
  await page.keyboard.press('p');
  s = await state(page);
  check('keys: P with an empty filter pins', s.selPinned === !before && s.query === '', s);
  await page.keyboard.press('p');
  s = await state(page);
  check('keys: P again unpins', s.selPinned === before, s);
  await page.keyboard.type('mee');
  s = await state(page);
  check('keys: typing filters', s.query === 'mee' && s.n === 1, s);
  check('keys: the foot says Ctrl+P while filtering', /Ctrl\+Ppin/.test(s.foot), s.foot);
  await page.keyboard.press('Backspace'); await page.keyboard.press('Backspace'); await page.keyboard.press('Backspace');
  await page.keyboard.type('fli');
  await page.keyboard.press('p');
  s = await state(page);
  check('keys: p goes INTO a non-empty filter', s.query === 'flip' && s.n === 1, s);
  const pinnedBefore = s.selPinned;
  await page.keyboard.press('Control+p');
  s = await state(page);
  check('keys: Ctrl+P pins while filtering', s.selPinned === !pinnedBefore && s.query === 'flip', s);
  // Del with the filter text selected edits the filter, not the list
  const totalSel = s.total;
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Delete');
  s = await state(page);
  check('keys: Del over a selected filter clears the filter, deletes nothing', s.query === '' && s.total === totalSel, s);
  await clearFilter(page);
  await page.keyboard.press('/');
  s = await state(page);
  check('keys: / arms the filter and types nothing', s.armed === true && s.query === '', s);
  await page.keyboard.press('p');
  s = await state(page);
  check('keys: after /, p filters instead of pinning', s.query === 'p', s.query);
  await clearFilter(page);
  await page.keyboard.press('End');
  s = await state(page);
  check('keys: End selects the last item', s.sel === s.n - 1, s);
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowDown');
  const total = (await state(page)).total;
  await page.keyboard.press('Delete');
  s = await state(page);
  check('keys: Del deletes and keeps the index', s.total === total - 1 && s.sel === 1, s);
  await page.keyboard.press('Enter');
  s = await state(page);
  check('keys: Enter pastes the selected item', s.pasted === s.selId, s);
  await page.keyboard.press('Escape');
  s = await state(page);
  check('keys: Esc closes', s.closed === 1, s.closed);
  // a long list: the selection stays scrolled into view
  await page.goto(`${PAGE}?n=40`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__mock && window.__mock.ready);
  for (let i = 0; i < 25; i++) await page.keyboard.press('ArrowDown');
  s = await state(page);
  check('keys: 25 x ArrowDown keeps the selection in view', s.sel === 25 && s.selVisible === true, s);
  await page.keyboard.press('PageUp');
  s = await state(page);
  check('keys: PageUp moves 4', s.sel === 21 && s.selVisible === true, s);
  check('keys: no page errors', problems.length === 0, problems);
  await ctx.close();
}

(async () => {
  const games = gamesRunning();
  if (games) { console.log(`NOT RUN: ${games} game process(es) are running; screenshots wait.`); process.exit(2); }
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await require('../settings/test-browser.js').launch(chromium, { headless: true });
  const lines = [];
  try {
    for (const s of SHOTS) {
      const ctx = await browser.newContext({ viewport: { width: s.w, height: s.h }, deviceScaleFactor: 1 });
      const page = await ctx.newPage();
      const problems = [];
      page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
      page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(`console ${m.type()}: ${m.text()}`); });
      await page.goto(`${PAGE}?${s.q}`, { waitUntil: 'load' });
      await page.waitForFunction(() => window.__mock && window.__mock.ready && window.__mock.painted);
      await page.waitForTimeout(150);
      const file = path.join(OUT, s.name + '.png');
      const png = await page.screenshot({ path: file });
      const contrast = await page.evaluate(CONTRAST, png.toString('base64'));
      const probe = await page.evaluate(() => {
        const p = document.getElementById('panel').getBoundingClientRect();
        return {
          panel: [Math.round(p.left), Math.round(p.top), Math.round(p.width), Math.round(p.height)],
          onScreen: p.left >= 0 && p.top >= 0 && p.right <= innerWidth && p.bottom <= innerHeight,
          rows: document.querySelectorAll('.row').length,
          banner: document.getElementById('banner').classList.contains('on'),
          body: document.body.className,
        };
      });
      check(s.name + ': panel wholly on screen', probe.onScreen, probe.panel);
      check(s.name + ': text at 4.5:1 or better', !contrast.worst || contrast.worst.ratio >= 4.5, contrast.worst);
      check(s.name + ': no page errors', problems.length === 0, problems);
      lines.push(`${s.name}: panel ${probe.panel.join(',')}, ${probe.rows} rows, banner ${probe.banner}, body "${probe.body}", contrast worst ${contrast.worst ? contrast.worst.ratio + ':1 (' + contrast.worst.what + ')' : '-'} median ${contrast.median}:1 over ${contrast.n}`);
      await ctx.close();
    }
    await keys(browser);
  } finally {
    await browser.close();
  }
  for (const l of lines) console.log(l);
  console.log(`clipboard shots: ${pass} passed, ${fail} failed (${SHOTS.length} shots in ${OUT})`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
