require('C:/Users/user/dev-tools/tools/lowcpu.js');
/* shoot.js — headless shots of the top bar page over file:// with mock-mantle.js playing main
 * (no Electron, no sidecar, nothing from Owen's machine). Also CHECKS, not just photographs:
 *   1. the tiny-numbers rule: every stat cell keeps its width when its number changes
 *      (5% -> 100%, 0.1 -> 15.7 GB, 0 KB/s -> 999 MB/s);
 *   2. keyboard: ArrowDown/Right/Left/Escape walk the menus the way a Mac menu does, and Enter on
 *      a native item sends topbar.invoke with that item's command id;
 *   3. a failed command shows its reason on the bar.
 *   4. FIT (2026-09-25, Owen's stats cut at "CPU 82%"): at 1280 / 1366 / 1536 / 1920 CSS px x DPR
 *      1 / 1.25 / 1.5, short and very long menus, a warning note, stats paused / GPU missing, AND a
 *      window wider than its screen (the live symptom): the stats end exactly one left-inset from
 *      the screen's right edge, the page never scrolls (scrollWidth == clientWidth), nothing wraps,
 *      nothing on the left is cut mid-word, and hidden menus are reachable from » by mouse and keys.
 *   node ui/topbar/shoot.js     (MANTLE_SHOOT_OUT=<dir> for the PNGs)
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { chromium } = require('C:/Users/user/other-app/node_modules/playwright-core');

const CHROME = 'C:/Users/user/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const PAGE = 'file:///C:/Users/user/mantle/ui/topbar/index.html';
const OUT = process.env.MANTLE_SHOOT_OUT ||
  'C:/Users/user/AppData/Local/Temp/claude/C--Users-owens/fe6c395c-2ffc-4958-a961-d5833371924e/scratchpad/topbar/shots';

const SHOTS = [
  ['01-npp-closed', 'app=npp'],
  ['02-npp-file', 'app=npp&open=2'],
  ['03-npp-file-recent', 'app=npp&open=2&sub=2'],
  ['04-npp-view-checks', 'app=npp&open=5'],
  ['05-app-menu', 'app=npp&open=1'],
  ['06-mantle-restart-armed', 'app=npp&open=0&sub=6&armed=1'],
  ['07-chrome-no-menus', 'app=chrome&open=1'],
  ['08-uwp-uia', 'app=uwp'],
  ['09-dialog-blocked', 'app=dialog&open=2'],
  ['10-stat-cpu', 'stat=cpu'],
  ['11-stat-mem', 'stat=mem'],
  ['12-stat-gpu', 'stat=gpu'],
  ['13-stat-net', 'stat=net'],
  ['14-nogpu', 'stats=nogpu'],
  ['15-paused', 'stats=paused'],
  ['16-dark-file', 'app=npp&open=2&dark=1'],
  ['17-desktop', 'app=desktop&open=1'],
];

/* ---- 4. fit ---------------------------------------------------------------------------------- */
// One page state, measured: where the stats end against the SCREEN's right edge, scrolling, wrapping.
function measureFit() {
  const S = window.__topbar, bar = document.getElementById('bar'), left = document.getElementById('left'), right = document.getElementById('right');
  const vis = Math.min(innerWidth, screen.width - screenX);
  const r = right.getBoundingClientRect(), l = left.getBoundingClientRect();
  const glyph = left.firstElementChild.getBoundingClientRect();
  const kids = [...left.children].map((b) => b.getBoundingClientRect());
  const wrapped = [...bar.querySelectorAll('.t, .warn, .paused, .lbl')].filter((e) => e.scrollHeight > e.clientHeight + 1 || e.getBoundingClientRect().height > 24.5).length;
  const cells = [...right.querySelectorAll('.st')].map((c) => c.getBoundingClientRect());
  return {
    vis, leftInset: glyph.left, rightInset: vis - r.right, rightEnd: r.right,
    cellsOn: cells.every((c) => c.left >= 0 && c.right <= vis + 0.5), cellCount: cells.length, paused: !!right.querySelector('.paused'),
    scroll: [document.documentElement.scrollWidth, document.documentElement.clientWidth, document.body.scrollWidth, document.body.clientWidth, scrollX],
    barH: bar.scrollHeight, wrapped,
    leftCut: kids.length ? kids[kids.length - 1].right - l.right : 0,
    total: S.titles.length, shown: S.fit ? S.fit.shown : S.titles.length, more: !!left.querySelector('.t.more'),
    appW: (left.querySelector('.t.bold') || { getBoundingClientRect: () => ({ width: 0 }) }).getBoundingClientRect().width,
  };
}

async function fitChecks(browser, check) {
  const M = require('./model.js');
  // pure: the order things give way in
  const w = [30, 300, 50, 50, 50, 50];
  let f = M.fitTitles(w, 24, 1000, 96);
  check('fit: everything fits -> all shown, natural app name', f.shown === 6 && f.appW === null, JSON.stringify(f));
  f = M.fitTitles(w, 24, 400, 96);
  check('fit: the app name gives way first (ellipsis), no menu hidden', f.shown === 6 && f.appW === 169, JSON.stringify(f));
  f = M.fitTitles(w, 24, 260, 96);
  check('fit: then menus go into », from the right, and the left-over room returns to the app name', f.shown === 4 && f.appW === 105, JSON.stringify(f));
  f = M.fitTitles([30, 60, 50, 50], 24, 150, 96);
  check('fit: a short app name is never widened past its natural width', f.shown === 2 && f.appW === null, JSON.stringify(f));

  const CASES = [['app=word&note=1', 'long menus + warning'], ['app=word', 'long menus'], ['app=npp', 'Notepad++ menus'], ['app=term', 'Windows Terminal'],
    ['app=explorer&stats=paused', 'File Explorer, stats paused'], ['app=chrome&stats=nogpu', 'Chromium window, GPU missing'], ['app=desktop', 'desktop']];
  let n = 0, bad = [];
  for (const dpr of [1, 1.25, 1.5]) {
    for (const [sw, vw] of [[1280, 1280], [1366, 1366], [1536, 1536], [1920, 1920], [1536, 1920], [1280, 1600]]) {   // [screen, window]: the last two are a window WIDER than its screen
      const page = await browser.newPage({ viewport: { width: vw, height: 38 }, screen: { width: sw, height: 864 }, deviceScaleFactor: dpr });
      for (const [q, what] of CASES) {
        await page.goto(PAGE + '?' + q);
        await page.waitForFunction(() => document.documentElement.dataset.ready === '1', null, { timeout: 5000 });
        const m = await page.evaluate(measureFit);
        const tag = `${sw}${vw !== sw ? '(window ' + vw + ')' : ''}@${dpr} ${what}`;
        n++;
        const errs = [];
        if (!(Math.abs(m.rightInset - m.leftInset) <= 1 && m.rightEnd <= m.vis - m.leftInset + 0.5)) errs.push(`stats end ${m.rightInset.toFixed(1)} px from the screen edge, left inset ${m.leftInset.toFixed(1)}`);
        if (!m.paused && (m.cellCount !== 4 || !m.cellsOn)) errs.push(`stat cells ${m.cellCount}, all on screen ${m.cellsOn}`);
        if (m.scroll[0] !== m.scroll[1] || m.scroll[2] !== m.scroll[3] || m.scroll[4] !== 0) errs.push('scrolls: ' + JSON.stringify(m.scroll));
        if (m.wrapped || m.barH > 28) errs.push(`wrapped ${m.wrapped}, bar content height ${m.barH}`);
        if (m.leftCut > 0.5) errs.push(`the last title on the left is cut by ${m.leftCut.toFixed(1)} px`);
        if (m.shown < m.total && !m.more) errs.push(`${m.total - m.shown} titles hidden with no » button`);
        if (errs.length) bad.push(tag + ': ' + errs.join('; '));
        if (dpr === 1.25 && q === 'app=word&note=1') await page.screenshot({ path: path.join(OUT, `fit-${sw}${vw !== sw ? 'w' + vw : ''}-word-note.png`), clip: { x: 0, y: 0, width: sw, height: 38 } });
      }
      await page.close();
    }
  }
  check(`fit: ${n} cases (4 widths + 2 too-wide windows x 3 DPRs x 7 states): stats one inset from the screen edge, no scroll, no wrap, no cut title`, bad.length === 0, bad.slice(0, 6).join(' | '));

  // a window that GROWS past its screen after the page loaded (the Electron probe's case C), and one
  // that bounces 1536 -> 1920 -> 1536 at once (case B, which fooled an outerWidth-based zoom guess)
  {
    const g = await browser.newPage({ viewport: { width: 1536, height: 38 }, screen: { width: 1536, height: 864 }, deviceScaleFactor: 1.25 });
    await g.goto(PAGE + '?app=word');
    await g.waitForFunction(() => document.documentElement.dataset.ready === '1');
    await g.setViewportSize({ width: 1920, height: 38 });
    await g.waitForTimeout(150);
    const grown = await g.evaluate(measureFit);
    check('fit: a window that grows past its screen keeps the stats one inset from the screen edge', Math.abs(grown.rightInset - grown.leftInset) <= 1 && grown.cellsOn, JSON.stringify([grown.rightEnd, grown.vis]));
    await g.setViewportSize({ width: 1536, height: 38 });
    await g.setViewportSize({ width: 1920, height: 38 });
    await g.setViewportSize({ width: 1536, height: 38 });
    await g.waitForTimeout(150);
    const back = await g.evaluate(measureFit);
    check('fit: after a 1536 -> 1920 -> 1536 bounce the strip is the full screen again', Math.abs(back.rightInset - back.leftInset) <= 1 && back.vis === 1536, JSON.stringify([back.rightEnd, back.vis]));
    await g.close();
  }

  // » by mouse and keyboard, on the tightest real case (1280 @ 1.25, 17 menus, a warning)
  const page = await browser.newPage({ viewport: { width: 1280, height: 420 }, screen: { width: 1280, height: 720 }, deviceScaleFactor: 1.25 });
  await page.goto(PAGE + '?app=word&note=1');
  await page.waitForFunction(() => document.documentElement.dataset.ready === '1');
  const k = await page.evaluate(() => {
    const S = window.__topbar;
    const key = (x) => document.dispatchEvent(new KeyboardEvent('keydown', { key: x, bubbles: true }));
    const out = { shown: S.fit.shown, total: S.titles.length };
    document.querySelector('.t.more').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    out.moreOpen = !!(S.open && S.open.more);
    out.rows = S.open ? S.open.stack[0].items.map((i) => i.label) : [];
    out.want = S.titles.slice(S.fit.shown).map((t) => t.label);
    const dd = document.querySelector('.dd').getBoundingClientRect();
    out.ddOn = dd.left >= 0 && dd.right <= innerWidth;
    key('ArrowDown'); out.sel = S.open.stack[0].sel;
    key('ArrowRight'); out.sub = S.open.stack.length === 2 && S.open.stack[1].sel === 0 && S.open.stack[1].items.length > 0;
    key('Enter');
    const inv = window.__mockCalls.filter((c) => c.name === 'topbar.invoke').pop();
    out.invoked = inv ? inv.args : null; out.closed = !S.open;
    // walk the bar with the keys: from the last title on the bar, ArrowRight reaches », ArrowLeft comes back
    document.querySelector(`.t[data-i="${S.fit.shown - 1}"]`).dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    key('ArrowRight'); out.stepToMore = !!(S.open && S.open.more && S.open.ti === S.fit.shown);
    key('ArrowRight'); out.moreSub = !!(S.open && S.open.more && S.open.stack.length === 2);   // the selected hidden menu opens, as on a Mac
    key('ArrowRight'); out.wrapToMantle = !!(S.open && S.open.ti === 0);                        // its first item has no submenu: next title, wrapping
    key('ArrowLeft'); out.backToMore = !!(S.open && S.open.more);
    key('ArrowLeft'); out.backToLast = !!(S.open && S.open.ti === S.fit.shown - 1);
    key('Escape'); out.esc = !S.open;
    return out;
  });
  check('fit: 1280@1.25 with 17 menus hides some behind »', k.shown < k.total, JSON.stringify([k.shown, k.total]));
  check('fit: » opens a menu listing exactly the hidden titles, on screen', k.moreOpen && JSON.stringify(k.rows) === JSON.stringify(k.want) && k.ddOn, JSON.stringify(k.rows));
  check('fit: in », ArrowDown selects, ArrowRight opens that menu, Enter runs its item', k.sel === 0 && k.sub && k.invoked && typeof k.invoked.item === 'number' && k.closed, JSON.stringify(k.invoked));
  check('fit: ArrowRight/Left walk the bar through » and wrap', k.stepToMore && k.moreSub && k.wrapToMantle && k.backToMore && k.backToLast && k.esc, JSON.stringify(k));
  await page.goto(PAGE + '?app=word&note=1');
  await page.waitForFunction(() => document.documentElement.dataset.ready === '1');
  await page.evaluate(() => { document.querySelector('.t.more').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
  await page.waitForTimeout(200);
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
  await page.waitForTimeout(200);
  const sc = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  check('fit: an open » and its submenu never make the page scrollable', sc[0] === sc[1], JSON.stringify(sc));
  await page.screenshot({ path: path.join(OUT, '1280-19-more-open.png') });
  // the stat menu at the far right, in a window wider than its screen, stays on the screen
  await page.close();
  const wide = await browser.newPage({ viewport: { width: 1920, height: 420 }, screen: { width: 1536, height: 864 }, deviceScaleFactor: 1.25 });
  await wide.goto(PAGE + '?app=npp&stat=net');
  await wide.waitForFunction(() => document.documentElement.dataset.ready === '1');
  await wide.waitForTimeout(200);
  const dr = await wide.evaluate(() => { const d = document.querySelector('.dd').getBoundingClientRect(); return [Math.round(d.left), Math.round(d.right), screen.width]; });
  check('fit: the NET menu in a too-wide window ends on the screen', dr[1] <= dr[2] - 4, JSON.stringify(dr));
  await wide.screenshot({ path: path.join(OUT, '1536w1920-20-net-open.png'), clip: { x: 0, y: 0, width: 1536, height: 420 } });
  await wide.close();
}

/* ---- 5. dropdowns open whole ----------------------------------------------------------------- */
/* Owen, 2026-09-25 00:02 and 08:54: pressing CPU / RAM / GPU / NET showed only "a thin grey strip"
 * under the bar, "its like that for all of them". The shots above ran in a 420 px viewport, which
 * hid it: the REAL window starts at Windows' 38 DIP floor and grows only to what the page asks for
 * (lib/features/topbar.js menuState -> place). So these rows start at 38 px and play main: each
 * time the page asks for a height, the viewport becomes that height (capped at the screen, as main
 * caps it), then they check what is on screen. */
function measureDrop() {
  const ms = window.__mockCalls.filter((c) => c.name === 'topbar.menuState').pop();
  const se = document.scrollingElement, menus = document.getElementById('menus');
  return {
    asked: ms && ms.args.open ? ms.args.height : null, closedAsked: !!(ms && ms.args.open === false), ih: innerHeight,
    sb: (screen.availTop || 0) + screen.availHeight - screenY,        // the screen's bottom in page px (headless puts screenY at 10)
    dds: [...menus.children].map((d) => {
      // layout box (offset*): the 140 ms fade-in moves the painted rect by up to 3 px
      return { top: d.offsetTop, bottom: d.offsetTop + d.offsetHeight, h: d.offsetHeight, inner: d.scrollHeight, client: d.clientHeight,
        hidden: getComputedStyle(d).visibility === 'hidden' };
    }),
    scroll: [se.scrollTop, se.scrollHeight - se.clientHeight, menus.scrollTop],
    cores: [...document.querySelectorAll('.core i')].map((i) => Math.round(i.getBoundingClientRect().height * 10) / 10),
    note: (document.querySelector('.warn') || {}).textContent || '',
  };
}
// Resizes the WINDOW (viewport) and leaves the emulated SCREEN alone, as main's setBounds does:
// page.setViewportSize would shrink the emulated screen with it (screen.availHeight 38).
async function windowSizer(page, screenH) {
  const cdp = await page.context().newCDPSession(page);
  const set = (h) => cdp.send('Emulation.setDeviceMetricsOverride', { width: 1536, height: h, deviceScaleFactor: 1.25, mobile: false, screenWidth: 1536, screenHeight: screenH });
  // page.screenshot re-applies Playwright's own viewport (38 px): capture through the same session
  set.shot = async (file, h) => fs.writeFileSync(file, Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 1536, height: h, scale: 1 } })).data, 'base64'));
  return set;
}
async function dropChecks(browser, check) {
  const CASES = [['cpu', 'stat=cpu'], ['mem', 'stat=mem'], ['gpu', 'stat=gpu'], ['net', 'stat=net'], ['nogpu', 'stat=gpu&stats=nogpu'],
    ['file', 'app=npp&open=2'], ['file-recent', 'app=npp&open=2&sub=2'], ['mantle', 'app=npp&open=0'], ['app', 'app=npp&open=1']];
  for (const screenH of [864, 240]) {
    const page = await browser.newPage({ viewport: { width: 1536, height: 38 }, screen: { width: 1536, height: screenH }, deviceScaleFactor: 1.25 });
    const setWin = await windowSizer(page, screenH);
    for (const [name, q] of CASES) {
      const tag = `drop ${name} (screen ${screenH})`;
      await setWin(38);                                                   // the closed bar's window
      await page.goto(PAGE + '?' + q);
      await page.waitForFunction(() => document.documentElement.dataset.ready === '1');
      if (/sub=/.test(q)) await page.waitForFunction(() => window.__topbar.open && window.__topbar.open.stack.length === 2, null, { timeout: 2000 });
      const first = await page.evaluate(measureDrop);
      check(`${tag}: at the 38 px window, a dropdown too tall for it waits hidden (no clipped slice is painted)`,
        first.dds.length > 0 && first.dds.every((d) => d.bottom <= first.ih || d.hidden), JSON.stringify(first.dds));
      check(`${tag}: the height asked for covers the dropdown's full height`,
        first.asked >= Math.max(...first.dds.map((d) => d.bottom)), JSON.stringify([first.asked, first.dds]));
      // play main: grow to what was asked (a submenu can ask again), capped at the screen
      let m = first;
      for (let round = 0; round < 3 && m.asked && m.ih < Math.min(m.asked, screenH); round++) {
        await setWin(Math.min(m.asked, screenH));
        await page.waitForTimeout(40);
        m = await page.evaluate(measureDrop);
      }
      check(`${tag}: once the window has grown, every dropdown is shown and wholly inside it`,
        m.dds.every((d) => !d.hidden && d.top >= 28 && d.bottom <= m.ih) && m.asked <= screenH, JSON.stringify([m.ih, m.asked, m.dds]));
      if (screenH >= 400) check(`${tag}: on a tall screen nothing scrolls inside (the whole menu is shown)`, m.dds.every((d) => d.inner <= d.client + 1), JSON.stringify(m.dds));
      else check(`${tag}: on a short screen the dropdown ends above the screen's bottom, and scrolls inside exactly when it was cut there`,
        m.dds.every((d) => d.bottom <= m.sb - 8 && (d.inner > d.client + 1) === (d.bottom >= m.sb - 9)), JSON.stringify([m.sb, m.dds]));
      check(`${tag}: the page itself never scrolls`, m.scroll.every((v) => v === 0), JSON.stringify(m.scroll));
      check(`${tag}: no "cut off" note`, !/cut off|cannot be shown/.test(m.note), m.note);
      if (name === 'cpu') {
        const want = [22, 61, 9, 14, 37, 5, 71, 18].map((p) => Math.round(26 * p / 10) / 10);
        check(`${tag}: the per-core bars are drawn at their percentages (no inline style: the CSP drops those)`,
          JSON.stringify(m.cores) === JSON.stringify(want), JSON.stringify([m.cores, want]));
      }
      if (screenH >= 400 && name !== 'nogpu') await setWin.shot(path.join(OUT, `drop-${name}.png`), m.ih);
      // the 1 s sample re-renders the stat menu in place: the same element, no fade replayed, height unchanged
      if (/^stat=/.test(q)) {
        await page.waitForTimeout(200);                                   // the first fade-in is over
        const re = await page.evaluate(() => { const a = document.querySelector('.dd'); const n = window.__mockCalls.length;
          window.mantle.emit('topbar.stats', window.__topbar.stats);
          const b = document.querySelector('.dd');
          return { same: a === b, anim: b.getAnimations().length, calls: window.__mockCalls.slice(n).filter((c) => c.name === 'topbar.menuState').length }; });
        check(`${tag}: a new sample updates the open dropdown in place (no re-fade, no new resize)`, re.same && re.anim === 0 && re.calls === 0, JSON.stringify(re));
      }
      // Escape closes; main is told, so the window shrinks back to the bar
      const shut = await page.evaluate(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        if (window.__topbar.open) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return { open: !!window.__topbar.open, dds: document.querySelectorAll('#menus .dd').length }; });
      const after = await page.evaluate(measureDrop);
      check(`${tag}: Escape closes it and main is told (the window shrinks back)`, !shut.open && shut.dds === 0 && after.closedAsked, JSON.stringify(shut));
    }
    await page.close();
  }
  // a long menu on a short screen: arrow keys past the fold keep the selected row in view
  const p2 = await browser.newPage({ viewport: { width: 1536, height: 38 }, screen: { width: 1536, height: 240 }, deviceScaleFactor: 1.25 });
  const setWin2 = await windowSizer(p2, 240);
  await p2.goto(PAGE + '?app=npp&open=2');
  await p2.waitForFunction(() => document.documentElement.dataset.ready === '1');
  const ask = await p2.evaluate(measureDrop);
  await setWin2(Math.min(ask.asked, 240));
  await p2.waitForTimeout(40);
  const kv = await p2.evaluate(() => {
    const key = (k) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    key('ArrowUp');                                                    // from nothing selected: the LAST row
    const dd = document.querySelector('.dd'), row = dd.querySelector('.r.sel');
    const r = row.getBoundingClientRect(), d = dd.getBoundingClientRect();
    return { inView: r.top >= d.top && r.bottom <= d.bottom + 0.5, scrolled: dd.scrollTop, pageScroll: document.getElementById('menus').scrollTop + document.scrollingElement.scrollTop };
  });
  check('drop: in a dropdown that scrolls, the selected row stays in view and only the dropdown scrolls', kv.inView && kv.scrolled > 0 && kv.pageScroll === 0, JSON.stringify(kv));
  await p2.close();
  // main never grows the window: after 1.5 s the menu shows as it is, and the bar says why (no silent failure)
  const p3 = await browser.newPage({ viewport: { width: 1536, height: 38 }, screen: { width: 1536, height: 864 }, deviceScaleFactor: 1.25 });
  await p3.goto(PAGE + '?app=npp&stat=cpu');
  await p3.waitForFunction(() => document.documentElement.dataset.ready === '1');
  const w0 = await p3.evaluate(measureDrop);
  await p3.waitForTimeout(1700);
  const gu = await p3.evaluate(measureDrop);
  check('drop: a window that never grows: hidden at first, then shown after 1.5 s with a "cut off" note on the bar',
    w0.dds.every((d) => d.hidden) && gu.dds.every((d) => !d.hidden) && /cut off: it needs \d+ px/.test(gu.note), JSON.stringify([w0.dds, gu.dds, gu.note]));
  await p3.close();
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  let fails = 0, checks = 0;
  const check = (name, ok, detail) => { checks++; if (!ok) { fails++; console.log('  FAIL ' + name + (detail ? ' (' + detail + ')' : '')); } };
  try {
    for (const [w, h] of [[1536, 420], [1280, 420]]) {
      const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1.25 });
      for (const [name, q] of SHOTS) {
        if (w === 1280 && !/^0[12]|^10/.test(name)) continue;
        await page.goto(PAGE + '?' + q);
        await page.waitForFunction(() => document.documentElement.dataset.ready === '1', null, { timeout: 5000 });
        await page.waitForTimeout(220);
        await page.screenshot({ path: path.join(OUT, `${w}-${name}.png`) });
      }
      // 1. widths hold still
      await page.goto(PAGE + '?app=npp');
      await page.waitForFunction(() => document.documentElement.dataset.ready === '1');
      const widths = [];
      for (const s of [
        { cpu: { pct: 5 }, mem: { used: 0.1 * 2 ** 30, total: 15.7 * 2 ** 30 }, gpu: { pct: 0 }, net: { down: 0, up: 0 } },
        { cpu: { pct: 100 }, mem: { used: 15.6 * 2 ** 30, total: 15.7 * 2 ** 30 }, gpu: { pct: 100 }, net: { down: 999 * 2 ** 20, up: 99 * 2 ** 20 } },
        { cpu: { pct: 47.5 }, mem: { used: 9.9 * 2 ** 30, total: 15.7 * 2 ** 30 }, gpu: { pct: 9 }, net: { down: 512 * 1024, up: 2 * 2 ** 20 } },
      ]) {
        widths.push(await page.evaluate((st) => { window.mantle.emit('topbar.stats', st);
          return [...document.querySelectorAll('.st')].map((b) => Math.round(b.getBoundingClientRect().width * 10) / 10); }, s));
      }
      check(`${w}: stat cells keep their width as numbers change`, widths.every((x) => JSON.stringify(x) === JSON.stringify(widths[0])), JSON.stringify(widths));
      // 2. keyboard
      const r = await page.evaluate(async () => {
        const S = window.__topbar;
        const key = (k) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
        document.querySelector('.t[data-i="2"]').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        const out = { opened: !!S.open && S.open.ti === 2 };
        key('ArrowDown'); out.first = S.open.stack[0].sel;
        key('ArrowDown'); key('ArrowDown'); out.third = S.open.stack[0].sel;             // Recent Files (a submenu)
        key('ArrowRight'); out.subOpen = S.open.stack.length === 2 && S.open.stack[1].sel === 0;
        key('ArrowLeft'); out.subClosed = S.open.stack.length === 1;
        key('ArrowRight'); key('ArrowLeft'); key('ArrowLeft'); out.prevTitle = S.open && S.open.ti === 1;
        key('ArrowRight'); out.backToFile = S.open && S.open.ti === 2;
        key('Enter');                                                                     // "New"
        const inv = window.__mockCalls.filter((c) => c.name === 'topbar.invoke').pop();
        out.invoked = inv ? inv.args : null;
        out.closed = !S.open;
        document.querySelector('.t[data-i="3"]').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        key('Escape'); out.escClosed = !S.open;
        const ms = window.__mockCalls.filter((c) => c.name === 'topbar.menuState').pop();
        out.refocus = ms && ms.args.refocus;
        return out;
      });
      check(`${w}: a title opens its menu`, r.opened);
      check(`${w}: ArrowDown selects the first item, skipping nothing it should not`, r.first === 0 && r.third === 2, JSON.stringify(r));
      check(`${w}: ArrowRight opens a submenu, ArrowLeft closes it`, r.subOpen && r.subClosed);
      check(`${w}: ArrowLeft/Right walk the titles`, r.prevTitle && r.backToFile);
      check(`${w}: Enter on "New" sends topbar.invoke with its command id`, r.invoked && r.invoked.hwnd === '4242' && typeof r.invoked.item === 'number' && r.closed, JSON.stringify(r.invoked));
      check(`${w}: Escape closes and gives the app its focus back`, r.escClosed && r.refocus === true);
      await page.close();
    }
    // 3. failure reasons reach the bar
    const page = await browser.newPage({ viewport: { width: 1536, height: 420 }, deviceScaleFactor: 1.25 });
    await page.goto(PAGE + '?app=npp&fail=1&open=2');
    await page.waitForFunction(() => document.documentElement.dataset.ready === '1');
    await page.evaluate(() => { const row = document.querySelector('.r[data-l="0"][data-r="0"]'); row.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); });
    await page.waitForTimeout(120);
    const warn = await page.evaluate(() => (document.querySelector('.warn') || {}).textContent || '');
    check('a failed command shows its reason on the bar', /New: the app did not accept/.test(warn), warn);
    await page.screenshot({ path: path.join(OUT, '1536-18-failed-command.png') });
    await page.close();
    await fitChecks(browser, check);
    await dropChecks(browser, check);
  } finally {
    await browser.close();
  }
  console.log(`TOPBAR SHOTS: ${checks - fails} passed, ${fails} failed (PNGs in ${OUT})`);
  process.exit(fails ? 1 : 0);
})();
