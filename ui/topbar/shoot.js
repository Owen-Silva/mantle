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
  ['06-mantle-restart-armed', 'app=npp&open=0&sub=7&armed=1'],
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
  // the two small tools (lane tbtools, 2026-09-27)
  ['30-timer-menu', 'app=npp&timer=idle&tool=timer'],
  ['31-timer-running', 'app=npp&timer=run'],
  ['32-timer-running-menu', 'app=npp&timer=run&tool=timer'],
  ['33-timer-paused', 'app=npp&timer=pause'],
  ['34-stopwatch-menu', 'app=npp&timer=sw&tool=timer'],
  ['35-timer-custom', 'app=npp&timer=idle&tool=timer&custom=1:30'],
  ['36-timer-custom-typo', 'app=npp&tool=timer&custom=abc&enter=1'],
  ['37-notes-bad-timer-running', 'app=npp&notes=bad&timer=run'],
  ['38-timer-persist-bad', 'app=npp&timer=persistbad&tool=timer'],
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
        if (!m.paused && (m.cellCount !== 5 || !m.cellsOn)) errs.push(`stat cells ${m.cellCount}, all on screen ${m.cellsOn}`);
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

/* ---- 6. the two small tools (lane tbtools, 2026-09-27) --------------------------------------- */
async function toolChecks(browser, check) {
  const page = await browser.newPage({ viewport: { width: 1536, height: 420 }, deviceScaleFactor: 1.25 });
  const load = async (q) => { await page.goto(PAGE + '?' + q); await page.waitForFunction(() => document.documentElement.dataset.ready === '1', null, { timeout: 5000 }); };
  await load('app=npp');
  // the running time's cell never changes width as its digits do (tabular figures + a min width)
  const widths = await page.evaluate(() => {
    const out = [];
    for (const left of [59 * 60000 + 59000, 10 * 60000, 9 * 60000 + 59000, 5000]) {
      window.mantle.emit('timer.state', { kind: 'timer', endAt: Date.now() + left - 1, totalMs: 3600000, label: '1 h', now: Date.now() });
      const b = document.querySelector('.tool.tm');
      out.push([b && b.querySelector('.v').textContent, b ? Math.round(b.getBoundingClientRect().width * 10) / 10 : null]);
    }
    window.mantle.emit('timer.state', { kind: 'idle', now: Date.now() });
    return out;
  });
  check('tools: the running time keeps its width from 59:59 down to 0:05', widths.every((w) => w[1] != null && w[1] === widths[0][1]) &&
    JSON.stringify(widths.map((w) => w[0])) === '["59:59","10:00","9:59","0:05"]', JSON.stringify(widths));
  // the menu hangs from the button's right edge; arrows stay in it; a digit starts the custom length
  const m = await page.evaluate(async () => {
    const S = window.__topbar;
    const key = (k) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    document.querySelector('.tool[data-tool="timer"]').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    const out = { open: !!(S.open && S.open.tool === 'timer') };
    const dd = document.querySelector('.dd'), b = document.querySelector('.tool[data-tool="timer"]');
    out.rightGap = dd && b ? Math.round(dd.getBoundingClientRect().right - b.getBoundingClientRect().right) : null;
    out.rows = [...document.querySelectorAll('.dd .r .lb')].map((e) => e.textContent);
    key('ArrowDown'); out.first = S.open.stack[0].sel;
    key('ArrowLeft'); key('ArrowRight'); out.stayed = !!(S.open && S.open.tool === 'timer');
    // the first digit opens the box with it; a second one dispatched on the document (not the focused
    // box, as a real key would be) must ADD to it, never restart it
    key('1');
    const b1 = !!document.querySelector('input.lbi') && !!S.edit && S.edit.value === '1';
    key('2');
    const inp = document.querySelector('input.lbi');
    out.boxStarted = b1 && !!inp && !!S.edit && S.edit.value === '12';
    if (inp) { inp.value = '12'; inp.dispatchEvent(new Event('input', { bubbles: true })); inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); }
    await new Promise((r) => setTimeout(r, 60));
    const st = window.__mockCalls.filter((c) => c.name === 'timer.start').pop();
    out.started = st ? st.args : null;
    out.closed = !S.open;
    const ms = window.__mockCalls.filter((c) => c.name === 'topbar.menuState').pop();
    out.refocus = ms && ms.args.refocus;
    out.cell = (document.querySelector('.tool.tm .v') || {}).textContent || null;
    return out;
  });
  check('tools: the timer button opens its menu, hung from the button\'s right edge', m.open && m.rightGap != null && Math.abs(m.rightGap) <= 1, JSON.stringify(m));
  check('tools: the timer menu offers 5 / 15 / 25 / 50 minutes, Custom… and Stopwatch',
    JSON.stringify(m.rows) === '["5 minutes","15 minutes","25 minutes","50 minutes","Custom…","Stopwatch"]', JSON.stringify(m.rows));
  check('tools: ArrowDown selects 5 minutes; Left / Right do not walk into the app\'s menus', m.first === 0 && m.stayed, JSON.stringify(m));
  check('tools: typing a digit opens the Custom box with it; "12" Enter starts timer.start {text:"12"}, closes, gives the app its keyboard back',
    m.boxStarted && m.started && m.started.text === '12' && m.closed && m.refocus === true, JSON.stringify(m));
  check('tools: the started timer shows on the bar (12:00)', m.cell === '12:00' || m.cell === '11:59', m.cell);
  // a typo keeps the box open and says why; nothing is started
  await load('app=npp&tool=timer&custom=abc&enter=1');
  // (every amber line: with no timer.state yet the menu also says "The timer has not answered yet")
  const typo = await page.evaluate(() => ({ info: [...document.querySelectorAll('.dd .info.bad')].map((e) => e.textContent).join(' | '), box: !!document.querySelector('input.lbi'),
    started: window.__mockCalls.filter((c) => c.name === 'timer.start').length,
    rightGap: (() => { const dd = document.querySelector('.dd'), b = document.querySelector('.tool[data-tool="timer"]'); return dd && b ? Math.round(dd.getBoundingClientRect().right - b.getBoundingClientRect().right) : null; })() }));
  check('tools: a typo in the custom length keeps the box and says how to type it; nothing starts', /Type minutes \(12\)/.test(typo.info) && typo.box && typo.started === 0, JSON.stringify(typo));
  check('tools: a WIDE timer menu (two long amber lines) still hangs from its button\'s right edge', typo.rightGap != null && Math.abs(typo.rightGap) <= 1, JSON.stringify(typo));
  // one tick a second while it runs, none while paused or idle
  await load('app=npp&timer=run');
  const t0 = await page.evaluate(() => document.querySelector('.tool.tm .v').textContent);
  await page.waitForTimeout(1150);
  const t1 = await page.evaluate(() => ({ text: document.querySelector('.tool.tm .v').textContent, tick: !!window.__topbar.tickT }));
  const secs = (s) => s.split(':').reduce((a, x) => a * 60 + +x, 0);
  check('tools: while a timer runs the bar counts down one second at a time (and a tick is armed)', secs(t0) - secs(t1.text) === 1 && t1.tick, JSON.stringify([t0, t1]));
  await load('app=npp&timer=pause');
  const pz = await page.evaluate(() => ({ tick: window.__topbar.tickT, cls: document.querySelector('.tool.tm').className, text: document.querySelector('.tool.tm .v').textContent }));
  check('tools: a paused timer shows its time muted with the pause glyph, and nothing ticks', !pz.tick && /\bpz\b/.test(pz.cls) && pz.text === '7:05', JSON.stringify(pz));
  await load('app=npp&timer=idle');
  const idle = await page.evaluate(() => ({ tick: window.__topbar.tickT, cell: !!document.querySelector('.tool.tm'), icon: !!document.querySelector('.tool[data-tool="timer"] svg') }));
  check('tools: idle = the plain icon and no tick at all', !idle.tick && !idle.cell && idle.icon, JSON.stringify(idle));
  // notes: the button calls notes.toggle with its right edge in screen DIP and what it knew
  for (const [q, want] of [['app=npp', false], ['app=npp&notes=open', true]]) {
    await load(q);
    const n = await page.evaluate(() => {
      const b = document.querySelector('.tool[data-tool="notes"]');
      b.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      const c = window.__mockCalls.filter((x) => x.name === 'notes.toggle').pop();
      return { args: c ? c.args : null, right: Math.round((window.screenX || 0) + b.getBoundingClientRect().right), cls: b.className };
    });
    check(`tools: the notes button calls notes.toggle {x, app, wasOpen:${want}}`, n.args && n.args.x === n.right && n.args.app === '4242' && n.args.wasOpen === want &&
      (want ? /\bopen\b/.test(n.cls) : true), JSON.stringify(n));
  }
  await load('app=npp&notes=bad');
  const bad = await page.evaluate(() => { const b = document.querySelector('.tool[data-tool="notes"]'); return { cls: b.className, title: b.title }; });
  check('tools: a failed notes save turns the button amber and its tooltip says why', /\bbad\b/.test(bad.cls) && /NOT saved: EACCES/.test(bad.title), JSON.stringify(bad));
  // the tools never push the stats off the screen (the bar's own fit rule), at the narrowest width
  const fit = await browser.newPage({ viewport: { width: 1280, height: 420 }, deviceScaleFactor: 1.5 });
  await fit.goto(PAGE + '?app=word&timer=run&notes=bad');
  await fit.waitForFunction(() => document.documentElement.dataset.ready === '1');
  const f = await fit.evaluate(measureFit);
  const tr = await fit.evaluate(() => { const b = document.querySelector('.tool[data-tool="notes"]').getBoundingClientRect(); return Math.round(b.right); });
  check('tools: at 1280 x 1.5 the stats and both tools stay on screen, nothing scrolls or wraps', f.cellsOn && tr <= f.vis && f.scroll[0] === f.scroll[1] && f.wrapped === 0, JSON.stringify({ f, tr }));
  await fit.screenshot({ path: path.join(OUT, '1280-39-tools-fit-word.png') });
  await fit.close();
  await page.close();
}

/* ---- 7. the tools' own pages: the notes pad (ui/notes) and the timer's done pop-up (ui/timer) ---- */
const OTHER = [
  // [shot, page, query, viewport w, h]
  ['40-notes-pad', 'ui/notes/index.html', 'mock=3notes', 420, 380],
  ['41-notes-failed', 'ui/notes/index.html', 'mock=failed', 420, 380],
  ['42-notes-armed', 'ui/notes/index.html', 'mock=armed', 420, 380],
  ['43-timer-done', 'ui/timer/index.html', 'mock=done&label=25%20min', 340, 120],
  ['44-timer-done-off', 'ui/timer/index.html', 'mock=off', 340, 120],
  ['45-timer-done-game', 'ui/timer/index.html', 'mock=game', 340, 120],
];
async function otherPages(browser, check) {
  for (const [name, file, q, w, h] of OTHER) {
    const p = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1.25 });
    const errs = [];
    p.on('pageerror', (e) => errs.push(e.message));
    try {
      await p.goto('file:///C:/Users/user/mantle/' + file + '?' + q);
      await p.waitForTimeout(500);
      await p.screenshot({ path: path.join(OUT, `${name}.png`) });
      const scroll = await p.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
      check(`${name}: renders with no page error and nothing scrolls sideways`, errs.length === 0 && scroll[0] <= scroll[1], JSON.stringify({ errs, scroll }));
    } catch (e) { check(`${name}: loads`, false, e.message); }
    await p.close();
  }
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch(fs.existsSync(CHROME) ? { executablePath: CHROME, headless: true } : { headless: true });   // the 1234 build is gone (2026-10-05): playwright's own then
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
        { cpu: { pct: 5 }, mem: { used: 0.1 * 2 ** 30, total: 15.7 * 2 ** 30 }, gpu: { pct: 0 }, net: { down: 0, up: 0 }, ping: { state: 'ok', ms: 0 } },
        { cpu: { pct: 100 }, mem: { used: 15.6 * 2 ** 30, total: 15.7 * 2 ** 30 }, gpu: { pct: 100 }, net: { down: 999 * 2 ** 20, up: 99 * 2 ** 20 }, ping: { state: 'ok', ms: 999 } },
        { cpu: { pct: 47.5 }, mem: { used: 9.9 * 2 ** 30, total: 15.7 * 2 ** 30 }, gpu: { pct: 9 }, net: { down: 512 * 1024, up: 2 * 2 ** 20 }, ping: { state: 'timeout', ms: null, reason: 'no reply' } },
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
    await toolChecks(browser, check);
    await otherPages(browser, check);
  } finally {
    await browser.close();
  }
  console.log(`TOPBAR SHOTS: ${checks - fails} passed, ${fails} failed (PNGs in ${OUT})`);
  process.exit(fails ? 1 : 0);
})();
