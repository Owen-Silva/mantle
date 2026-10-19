/* tips-shoot.js - headless shots AND behaviour checks of the Mantle tooltips (ui/shared/tips.js)
 * on the bar page with the mock bridge. No Electron.
 *
 * LINE 1 below is not optional (same rule as ui/bar/shoot.js): lowcpu.js pins this process and
 * its browser to a few cores at below-normal priority and allows one headless browser at a time.
 *
 *   node ui/shared/tips-shoot.js      shots into TIPS_SHOTS (default: the lane scratchpad), then
 *                                     one line per check and "TIPS HEADLESS: N passed, M failed"
 *
 * The viewport is the live pill window's width and taller than the pill, so there is room above it
 * the way the live window (480 DIP taller, barTall) has. window.mantle.call is wrapped to log every
 * bar.popover call, who made it (from the stack: tips.js or the bar's own scripts) and to keep
 * main's ONE-owner rule (the latest open wins, any close shuts it), so the checks can prove the
 * tip never closes a popover's room.
 */
require('../../tools/dev-env.js').lowcpu();

const fs = require('fs');
const path = require('path');

const PW_CANDIDATES = [
  ...require('../../tools/dev-env.js').playwrightPaths(),
  'playwright-core'
];
let chromium = null;
for (const c of PW_CANDIDATES) { try { chromium = require(c).chromium; break; } catch (e) { /* next */ } }
if (!chromium) { console.error('FAILED: playwright-core not found. Tried:\n  ' + PW_CANDIDATES.join('\n  ')); process.exit(1); }
function findChrome() {
  const base = require('../../tools/dev-env.js').msPlaywrightDir();
  for (const d of fs.readdirSync(base).filter(n => n.startsWith('chromium-')).sort().reverse())
    for (const sub of ['chrome-win/chrome.exe', 'chrome-win64/chrome.exe']) {
      const p = path.join(base, d, sub);
      if (fs.existsSync(p)) return p;
    }
  return null;
}

const OUT = process.env.TIPS_SHOTS ||
  'C:/Users/user/AppData/Local/Temp/claude/C--Users-owens/fe6c395c-2ffc-4958-a961-d5833371924e/scratchpad/tips-shots';
const PAGE = 'file:///C:/Users/user/mantle/ui/bar/index.html';
const WALL = {
  dark: 'html{background:#141619 !important;}',
  light: 'html{background:linear-gradient(160deg,#eef2f7 0%,#d9e2ee 55%,#c9d6e6 100%) !important;}'
};

let passed = 0, failed = 0;
const lines = [];
function ok(cond, what) { if (cond) passed++; else failed++; lines.push((cond ? 'ok   ' : 'FAIL ') + what); }
const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function open(ctx, q, wall, h) {
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1120, height: h || 300 });
  const problems = [];
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') problems.push('console: ' + m.text()); });
  await page.goto(PAGE + q, { waitUntil: 'load' });
  await page.addStyleTag({ content: WALL[wall] });
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => {
    window.__roomLog = [];
    window.__owner = null;
    const m = window.mantle;
    const orig = m.call;
    m.call = function (ch, p) {
      if (ch === 'bar.popover') {
        const st = String(new Error().stack || '');
        const who = /shared\/tips\.js/.test(st) ? 'tips' : 'page';
        window.__roomLog.push({ who, open: !!(p && p.open), key: (p && p.key) || null, h: (p && p.height) || 0, bd: !!(p && p.backdrop) });
        window.__owner = p && p.open ? { key: p.key || 'unnamed', h: p.height } : null;
      }
      return orig.apply(this, arguments);
    };
  });
  await page.waitForTimeout(900);          // the pill's entrance
  page.problems = problems;
  return page;
}
const st = (page) => page.evaluate(() => window.MantleTips.state());
const log = (page) => page.evaluate(() => ({ log: window.__roomLog.slice(), owner: window.__owner }));
async function center(page, sel) {
  const b = await page.$eval(sel, el => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  return b;
}
async function hover(page, sel) { const c = await center(page, sel); await page.mouse.move(c.x, c.y, { steps: 3 }); }
async function away(page) { await page.mouse.move(560, 20, { steps: 2 }); }
async function shot(page, name) {
  const file = path.join(OUT, name + '.png');
  await page.screenshot({ path: file });
  shots.push(file);
}
const shots = [];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const exe = findChrome();
  if (!exe) { console.error('FAILED: no ms-playwright chromium'); process.exit(1); }
  const browser = await chromium.launch({ headless: true, executablePath: exe });
  const ctx = await browser.newContext({ deviceScaleFactor: 1.25, viewport: { width: 1120, height: 300 } });
  const problems = [];
  try {
    /* ---------------- shots: each tip over the pill, light and dark ---------------- */
    for (const wall of ['dark', 'light']) {
      let page = await open(ctx, '?mode=pill&tray=1&battery=battery', wall);
      for (const [name, sel] of [['speaker', '#volume'], ['wifi', '#network'], ['battery', '#battery'], ['clock', '#clock'], ['tray', '.ti']]) {
        await away(page); await page.waitForTimeout(700);   // past the hand-off window: each shot is a first tip
        await hover(page, sel);
        await page.waitForTimeout(700);
        await shot(page, `tip-${name}-${wall}`);
      }
      problems.push(...page.problems.map(p => wall + ' pill: ' + p));
      await page.close();

      // inside the open quick-settings panel: the Bluetooth tile's '>' and the settings gear
      page = await open(ctx, '?mode=pill', wall, 560);
      await page.click('#network');
      await page.waitForTimeout(700);
      await hover(page, '#pop .qsx-chev');
      await page.waitForTimeout(700);
      await shot(page, `tip-qs-chevron-${wall}`);
      const gear = await page.evaluate(() => {
        const g = Array.from(document.querySelectorAll('#pop [title],#pop [data-mtip]')).find(e => /Windows Settings/.test(e.getAttribute('title') || e.getAttribute('data-mtip') || ''));
        if (!g) return null; g.setAttribute('data-shoot', 'gear'); return true;
      });
      if (gear) { await away(page); await page.waitForTimeout(700); await hover(page, '[data-shoot="gear"]'); await page.waitForTimeout(700); await shot(page, `tip-qs-gear-${wall}`); }
      problems.push(...page.problems.map(p => wall + ' qs: ' + p));
      await page.close();
    }
    /* ---------------- inside the panel, over a warning (2026-09-25) ----------------
       Owen's screenshot: the quick-settings footer link's tip drawn OVER the power tile's red "Power
       mode did not change: ..." line, both texts mixed through the frost, the tip's end off the
       panel. Same scene here: ?pm=refuse makes the mock refuse a mode change, so a click on
       Efficiency leaves a warning up; then the pointer rests on the footer link.
         owen      the warning carries the words of Owen's screenshot (two lines, as on his screen):
                   light and dark desktop, 1x and 1.25x. The tip must stay INSIDE the panel.
         refused   the mock's own refusal (three lines, so the footer is boxed in on every side):
                   the tip may leave the panel for the room beside it, but never covers the warning. */
    const OWEN_WARN = 'Power mode did not change: Windows accepted the change but still reports Efficiency.';
    const powerScenes = [[1, 'light', 'owen'], [1, 'dark', 'owen'], [1.25, 'light', 'owen'], [1.25, 'dark', 'owen'], [1.25, 'light', 'refused']];
    for (const [scale, wall, words] of powerScenes) {
      const tag = `${wall} ${scale}x ${words}`;
      const sctx = await browser.newContext({ deviceScaleFactor: scale, viewport: { width: 1120, height: 660 } });
      const page = await open(sctx, '?mode=pill&pm=refuse&battery=battery', wall, 660);
      await page.click('#network');
      await page.waitForTimeout(700);
      await page.click('#pop .pmbtn[data-mode="efficiency"]');
      await page.waitForTimeout(500);
      if (words === 'owen') {
        await page.evaluate((t) => { const n = Array.from(document.querySelectorAll('#pop .pmnote')).find(e => !e.hidden); if (n) n.textContent = t; }, OWEN_WARN);
      }
      await hover(page, '#pop .qslink');
      await page.waitForTimeout(800);
      const g = await page.evaluate(() => {
        const R = (r) => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
        const pop = document.getElementById('pop');
        const link = pop.querySelector('.qslink');
        const warn = Array.from(pop.querySelectorAll('.pmnote')).find(n => !n.hidden && /did not change/.test(n.textContent));
        const tip = document.getElementById('mantle-tip');
        const rg = document.createRange();
        const lines = (root, skip) => {
          const out = [];
          const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
          for (let n = tw.nextNode(); n; n = tw.nextNode()) {
            if (!/\S/.test(n.nodeValue) || (skip && skip.contains(n))) continue;
            rg.selectNodeContents(n);
            for (const r of rg.getClientRects()) if (r.width > 0 && r.height > 0) out.push(Object.assign({ t: n.nodeValue.trim().slice(0, 24) }, R(r)));
          }
          return out;
        };
        const c = getComputedStyle(tip);
        const pill = document.getElementById('bar').getBoundingClientRect();
        return {
          pop: R(pop.getBoundingClientRect()), link: R(link.getBoundingClientRect()), pill: R(pill),
          warnLines: warn ? lines(warn) : [], warnText: warn ? warn.textContent.slice(0, 40) : '',
          tip: R(tip.getBoundingClientRect()), words: lines(pop, link), title: link.getAttribute('data-mtip') || link.getAttribute('title') || '', tipText: tip.textContent,
          bg: c.backgroundColor, img: c.backgroundImage, ov: c.textOverflow, ws: c.whiteSpace,
          sw: tip.scrollWidth, cw: tip.clientWidth, sh: tip.scrollHeight, ch: tip.clientHeight, vw: innerWidth, vh: innerHeight
        };
      });
      const s = await st(page);
      const hit = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;
      const t = g.tip, l = g.link, P = g.pop;
      const covered = g.words.filter(w => hit(t, w));
      const gap = Math.max(l.top - t.bottom, t.top - l.bottom, l.left - t.right, t.left - l.right);
      const inPanel = t.left >= P.left - 0.5 && t.right <= P.right + 0.5 && t.top >= P.top - 0.5 && t.bottom <= P.bottom + 0.5;
      const box = `tip ${Math.round(t.left)},${Math.round(t.top)}..${Math.round(t.right)},${Math.round(t.bottom)}; panel ${Math.round(P.left)},${Math.round(P.top)}..${Math.round(P.right)},${Math.round(P.bottom)}`;
      ok(g.warnLines.length >= 2, `${tag}: the power tile's warning is up, ${g.warnLines.length} lines ("${g.warnText}...")`);
      ok(s.shown && s.anchor === 'button.qslink' && s.text === g.title && g.tipText === g.title, `${tag}: the footer link's tip is up with its whole title ("${s.text}")`);
      ok(!g.warnLines.some(w => hit(t, w)) && s.box && s.box.covers && s.box.covers.warn === 0,
        `${tag}: the tip covers no line of the warning (covers ${covered.length ? covered.map(w => '"' + w.t + '"').join(', ') : 'no text'}; side ${s.box && s.box.side})`);
      if (words === 'owen') ok(inPanel, `${tag}: the tip stays inside the panel (${box})`);
      else ok(t.left >= 0 && t.right <= g.vw && t.top >= 0 && t.bottom <= g.pill.top - 0.5, `${tag}: boxed in, the tip uses the room beside the panel: in the window, never over the pill (${box}; pill top ${Math.round(g.pill.top)})`);
      ok(gap >= 0 && gap <= 7.5, `${tag}: the tip sits next to the link (gap ${gap.toFixed(1)} px, side ${s.box && s.box.side})`);
      ok(g.ov !== 'ellipsis' && g.ws !== 'nowrap' && g.sw <= g.cw + 0.5 && g.sh <= g.ch + 0.5, `${tag}: wrapped in whole lines, nothing cut (overflow ${g.ov}, ${g.ws}, ${g.sw}/${g.cw} wide, ${g.sh}/${g.ch} tall)`);
      // light: an opaque surface under the frost. dark (lane same-huds, Helm's look): a tip in the pop-up
      // is the pop-up's glass, ONE --lg-fill layer over its blurred picture on no ground
      const darkNow = await page.evaluate(() => document.documentElement.dataset.theme === 'dark');
      if (darkNow) ok(g.bg === 'rgba(0, 0, 0, 0)' && (g.img.match(/linear-gradient/g) || []).length === 1 && /url\("data:image\/png/.test(g.img), `${tag}: dark: one --lg-fill layer over the pop-up's picture (${g.bg} under ${g.img.slice(0, 60)})`);
      else ok(/^rgb\(/.test(g.bg) && g.img !== 'none', `${tag}: an opaque surface under the frost (${g.bg} under ${g.img.slice(0, 48)})`);
      const pad = 12;
      const x0 = Math.max(0, Math.min(P.left, t.left) - pad), x1 = Math.min(g.vw, Math.max(P.right, t.right) + pad);
      const file = path.join(OUT, `tip-qs-powerwarn-${words}-${wall}-${scale}x.png`);
      await page.screenshot({ path: file, clip: { x: x0, y: Math.max(0, P.top - pad), width: x1 - x0, height: Math.min(g.vh, g.pill.bottom + 4) - Math.max(0, P.top - pad) } });
      shots.push(file);
      problems.push(...page.problems.map(p => tag + ' powerwarn: ' + p));
      await page.close();
      await sctx.close();
    }
    // a top bar: the tip goes below the pill
    {
      const page = await open(ctx, '?mode=pill&edge=top', 'dark');
      await hover(page, '#clock');
      await page.waitForTimeout(700);
      await shot(page, 'tip-clock-top-dark');
      const s = await st(page);
      const pill = await page.$eval('#bar', el => el.getBoundingClientRect().toJSON());
      ok(s.shown && s.box && s.box.y >= pill.bottom + 5.9, `top bar: the tip is below the pill (tip y ${s.box && s.box.y}, pill bottom ${pill.bottom})`);
      problems.push(...page.problems.map(p => 'top: ' + p));
      await page.close();
    }

    /* ---------------- behaviour ---------------- */
    // 700 tall: quick settings has grown past 560 (Top bar + Hot corners rows), and at 560 its top
    // (the chevron the "inside the panel" check hovers) sat off the page at y -55
    const page = await open(ctx, '?mode=pill&tray=1&battery=battery', 'dark', 700);
    const pill = await page.$eval('#bar', el => el.getBoundingClientRect().toJSON());
    const volTitle0 = await page.$eval('#volume', el => el.getAttribute('title'));
    ok(!!volTitle0, `before any hover #volume still has its title attribute ("${(volTitle0 || '').split('\n')[0]}")`);

    await hover(page, '#volume');
    await page.waitForTimeout(250);
    let s = await st(page);
    ok(!s.shown, 'no tip at 250 ms (the first delay is 450)');
    const a11y = await page.$eval('#volume', el => ({ attr: el.getAttribute('title'), data: el.getAttribute('data-mtip'), prop: el.title, al: el.getAttribute('aria-label') }));
    ok(a11y.attr === null && a11y.data === volTitle0 && a11y.prop === volTitle0, 'hovered: the title moved to data-mtip (no native tooltip) and el.title still reads it');
    ok(a11y.al === volTitle0, 'the icon-only speaker keeps its accessible name as an aria-label');
    await page.waitForTimeout(450);
    s = await st(page);
    ok(s.shown && s.anchor === '#volume' && /^Volume/.test(s.text), `tip up by 700 ms over the speaker ("${s.text.split('\n')[0]}")`);
    const desc = await page.$eval('#volume', el => el.getAttribute('aria-describedby'));
    ok(/mantle-tip/.test(desc || ''), 'aria-describedby points at the tip while it is up');
    let L = await log(page);
    const lastTip = L.log.filter(e => e.who === 'tips').pop();
    ok(lastTip && lastTip.open && lastTip.key === 'tip' && lastTip.h === s.box.need, `asked bar.popover for its room (${lastTip && lastTip.h} = need ${s.box.need})`);
    ok(s.box.y >= pill.top - s.box.need - 1 && s.box.y + s.box.h <= pill.top - 5.9, `the tip is inside the room it asked for and clear of the pill (y ${s.box.y}..${s.box.y + s.box.h}, pill top ${pill.top}, room ${s.box.need})`);
    const multi = await page.evaluate(() => { const t = document.getElementById('mantle-tip'); return { lines: Math.round(t.getBoundingClientRect().height / 16), txt: t.textContent }; });
    ok(multi.txt.includes('\n') && multi.lines >= 2, 'the multi-line title keeps its line break');
    const look = await page.evaluate(() => {
      const c = getComputedStyle(document.getElementById('mantle-tip'));
      const d = document.createElement('i'); d.style.color = getComputedStyle(document.documentElement).getPropertyValue('--lg-fill').trim(); document.body.appendChild(d);
      const fill = getComputedStyle(d).color; d.remove();
      return { pe: c.pointerEvents, ws: c.whiteSpace, bg: c.backgroundColor, img: c.backgroundImage, fam: c.fontFamily, dark: document.documentElement.dataset.theme === 'dark', fill, glass: window.MantleTips.state().glass };
    });
    ok(look.pe === 'none' && look.ws === 'pre-line', 'pointer-events none, pre-line');
    // light: the pinned values (opaque: the frost on --lg-ground). dark (lanes see-huds then same-huds,
    // 2026-10-09, "everything the same", Helm's look): the tip above the pill is the bar pop-ups' glass,
    // ONE --lg-fill layer over the blurred picture main took when the tip asked for its room
    // (bar.popover {backdrop: true} -> bar.popbackdrop {key:'tip'}; the mock answers it), on no ground.
    const layers = look.img.split(/,\s*(?=linear-gradient|url)/);
    const face = look.dark ? (/^rgba\(0, 0, 0, 0\)$/.test(look.bg) && layers.length === 2 && layers[0] === `linear-gradient(${look.fill}, ${look.fill})` && /^url\("data:image\/png/.test(layers[1]) && look.glass.on && look.glass.key === 'tip')
                           : (/^rgb\(244, 246, 250\)$/.test(look.bg) && /255, 255, 255, 0\.72/.test(look.img));
    if (look.dark) ok(L.log.some((e) => e.who === 'tips' && e.open && e.bd), `dark: the tip's room ask carried backdrop: true and its picture came back (${JSON.stringify(look.glass)})`);
    else ok(!L.log.some((e) => e.who === 'tips' && e.bd) && !look.glass.on, 'light: the tip never asks for a picture and keeps its own frost');
    ok(face && /Segoe UI/.test(look.fam), `the popover frost on an opaque ground, and the bar's face (${look.img.slice(0, 44)} over ${look.bg}; ${look.fam.split(',')[0]})`);

    // live update in place: the volume keys while the tip is up
    await page.evaluate(() => window.__mockMain.volume(73));
    await page.waitForTimeout(120);
    s = await st(page);
    ok(s.shown && /Volume 73%/.test(s.text), `the level changed under the tip: updated in place ("${s.text.split('\n')[0]}")`);
    await shot(page, 'tip-speaker-live-73-dark');

    // hand-off: straight onto the Wi-Fi glyph
    await hover(page, '#network');
    await page.waitForTimeout(60);
    s = await st(page);
    ok(s.shown && s.anchor === '#network', `hand-off: the next icon's tip at once (${s.anchor} at 60 ms)`);

    // leave: hidden, and the room given back after the fade
    await away(page);
    await page.waitForTimeout(500);
    s = await st(page);
    L = await log(page);
    ok(!s.shown && s.held === 0, 'left the bar: hidden and no room held');
    ok(L.owner === null && L.log[L.log.length - 1].who === 'tips' && !L.log[L.log.length - 1].open, 'the tip gave its room back (main\'s one owner is none)');

    // the race: a tip holding room, then a click that opens quick settings
    await page.waitForTimeout(600);
    await hover(page, '#volume');
    await page.waitForTimeout(700);
    s = await st(page);
    ok(s.shown && s.held > 0, 'tip up again, holding room');
    const nBefore = (await log(page)).log.length;
    await page.mouse.down(); await page.mouse.up();
    await page.waitForTimeout(800);
    L = await log(page);
    const after = L.log.slice(nBefore);
    const popOpen = await page.$eval('#pop', el => !el.hidden);
    ok(popOpen && L.owner && L.owner.key !== 'tip', `clicked: the panel owns the room (${JSON.stringify(L.owner)}; calls since: ${after.map(e => e.who + (e.open ? ':open:' + e.key : ':close')).join(', ')})`);
    const pageOpenAt = after.findIndex(e => e.who === 'page' && e.open);
    ok(pageOpenAt >= 0 && !after.slice(pageOpenAt).some(e => e.who === 'tips'), 'the tip never called bar.popover after the panel opened');
    s = await st(page);
    ok(!s.shown, 'no tip over the speaker after the click (until the pointer leaves it)');

    // inside the panel: a tip that fits in the panel's own room, and asks for none
    const nIn = (await log(page)).log.filter(e => e.who === 'tips').length;
    await hover(page, '#pop .qsx-chev');
    await page.waitForTimeout(700);
    s = await st(page);
    const popR = await page.$eval('#pop', el => el.getBoundingClientRect().toJSON());
    L = await log(page);
    ok(s.shown && s.box && s.box.need === 0 && L.log.filter(e => e.who === 'tips').length === nIn, `inside the panel: tip up (${s.text.split('\n')[0]}), no room asked`);
    ok(!!s.box && s.box.y >= popR.top - 0.5, `inside the panel: within what the panel's room shows (tip y ${s.box && s.box.y}, panel top ${popR.top})`);
    // Esc: the panel's keyboard handling may close it; the tip goes regardless
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    s = await st(page);
    ok(!s.shown, 'Esc hides the tip');
    // close the panel with a click on the Wi-Fi glyph (bar.js's toggle), then check the owner
    if (await page.$eval('#pop', el => !el.hidden)) { await page.click('#network'); await page.waitForTimeout(400); }
    L = await log(page);
    ok(L.owner === null, `panel closed: nothing holds room (${JSON.stringify(L.owner)})`);

    // keyboard focus shows it too
    await away(page); await page.waitForTimeout(700);
    await page.focus('#clock');
    await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab');
    await page.waitForTimeout(700);
    s = await st(page);
    ok(s.shown && s.mode === 'focus', `keyboard focus: tip up (${s.anchor}, ${s.mode})`);
    await page.keyboard.press('Shift');
    await page.waitForTimeout(250);
    s = await st(page);
    ok(!s.shown, 'a key press hides it');

    // mousedown and wheel hide it
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await hover(page, '#clock'); await page.waitForTimeout(700);
    await page.mouse.wheel(0, 40); await page.waitForTimeout(150);
    s = await st(page);
    ok(!s.shown, 'the wheel hides it');

    // the flyout: a running app's own hover popover replaces any tip
    await away(page); await page.waitForTimeout(700);
    const running = await page.evaluate(() => { const c = Array.from(document.querySelectorAll('.cell')).find(x => x.classList.contains('run')); if (!c) return false; c.setAttribute('data-shoot', 'run'); return true; });
    if (running) {
      await hover(page, '[data-shoot="run"]');
      await page.waitForTimeout(1000);
      s = await st(page);
      const flyOpen = await page.$eval('#pop', el => !el.hidden && el.classList.contains('fly'));
      L = await log(page);
      ok(!flyOpen || (!s.shown && L.owner && L.owner.key !== 'tip'), `a running app's flyout: no tip over it, the flyout owns the room (fly ${flyOpen}, tip ${s.shown}, owner ${JSON.stringify(L.owner)})`);
      await away(page); await page.waitForTimeout(900);
    } else {
      lines.push('skip no running app cell in the mock to check the flyout against');
    }

    // uninstall puts every title back
    await hover(page, '#battery'); await page.waitForTimeout(700);
    const un = await page.evaluate(() => {
      window.MantleTips.uninstall();
      const v = document.getElementById('volume');
      return {
        title: v.getAttribute('title'), data: v.getAttribute('data-mtip'), own: Object.prototype.hasOwnProperty.call(v, 'title'),
        al: v.getAttribute('aria-label'), tip: !!document.getElementById('mantle-tip'), left: document.querySelectorAll('[data-mtip]').length
      };
    });
    L = await log(page);
    ok(un.title && /Volume/.test(un.title) && un.data === null && !un.own && un.al === null && !un.tip && un.left === 0, `uninstall: titles back as attributes, our aria-label gone, no tip element (${JSON.stringify(un)})`);
    ok(L.owner === null, 'uninstall: no room left held');
    problems.push(...page.problems.map(p => 'behaviour: ' + p));
    await page.close();
  } finally {
    await browser.close();
  }
  for (const f of shots) console.log(f);
  for (const l of lines) console.log(l);
  console.log(problems.length ? 'PAGE PROBLEMS:\n  ' + problems.join('\n  ') : 'no page errors, no console errors');
  console.log(`TIPS HEADLESS: ${passed} passed, ${failed} failed`);
  process.exit(failed || problems.length ? 1 : 0);
})().catch(e => { console.error('FAILED', e && e.stack || e); process.exit(1); });
