require('../../tools/dev-env.js').lowcpu();
/* shoot.js - headless screenshots of the screenshot overlay and card, plus the checks that matter.
 *
 * Line 1 is the machine-wide CPU cap and browser lock. Required, not optional.
 *
 * PRIVACY: nothing here ever shows the user's screen. The overlay's "frozen frame" is mock-mantle.js's
 * fake desktop, and the one real sidecar frame decoded below is a SYNTHETIC grab (a generated
 * pattern, Screenshot.cs FillSynthetic), deleted at the end.
 *
 * WHAT IS CHECKED, not just photographed:
 *   1. DPI. At device scale 1, 1.25, 1.5 and 2 (and on a monitor whose origin is -1920), a scripted
 *      drag must commit EXACTLY geometry.cssToPhys of the points the page saw, and the drawn hole
 *      must be that rect back in CSS px (what you see is what you get), within half a device px.
 *   2. MODES. Window mode highlights the fake window under the pointer and a click commits its
 *      physical rect; Full screen commits the whole monitor; the keyboard alone (W, arrows, Enter;
 *      R, Enter, arrows, Enter) commits; Esc cancels; a click without a drag commits nothing.
 *   3. THE FRAME FORMAT. The sidecar's 32-bit BI_BITFIELDS BMP, with junk in every fourth byte,
 *      must decode in Chromium fully OPAQUE and pixel-exact (else a layered window's alpha would
 *      punch holes in the frozen frame), and how long that decode takes is printed.
 *
 *   node ui/screenshot/shoot.js     (MANTLE_SIDECAR_EXE=<exe> for check 3; MANTLE_SHOOT_OUT=<dir>)
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync, spawn } = require('child_process');
const { chromium } = require('../../tools/dev-env.js').playwright();
const G = require('./geometry.js');

const PAGE = 'file:///' + path.join(__dirname, 'index.html').replace(/\\/g, '/');   // this checkout's pages
const CARD = 'file:///' + path.join(__dirname, 'card.html').replace(/\\/g, '/');
const OUT = process.env.MANTLE_SHOOT_OUT ||
  path.join(require('os').tmpdir(), 'mantle-shots', 'screenshot');
const EXE = process.env.MANTLE_SIDECAR_EXE || '';

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { passed++; return; }
  failures.push(name);
  console.log('  FAIL ' + name + (detail ? ' - ' + detail : ''));
}

function gamesRunning() {
  const out = execFileSync('powershell', ['-NoProfile', '-Command',
    // The lanes' game list (BRIEF). NOT *Riot*: RiotClientServices / CrashHandler are the launcher,
    // up all day in the background, and matching them meant this test never ran on the user's machine.
    '@(Get-Process VALORANT*,javaw,Minecraft*,RobloxPlayerBeta -ErrorAction SilentlyContinue).Count'], { encoding: 'utf8' });
  return Number(out.trim()) || 0;
}

async function open(browser, url, w, h, dsf) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dsf });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(url);
  await page.waitForFunction(() => window.__mock && (window.__mock.ready || window.__mock.calls.some((c) => c.name === 'screenshot.cardShown')), null, { timeout: 8000 });
  return { ctx, page, errors };
}

const lastCall = (page, name) => page.evaluate((n) => { const c = window.__mock.calls.filter((x) => x.name === n); return c.length ? c[c.length - 1].args : null; }, name);
const holeRect = (page) => page.evaluate(() => { const h = document.getElementById('hole'); if (h.hidden) return null; const r = h.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });

/* 1. DPI: a drag at every scale, and on a monitor left of the primary. */
async function dpiCase(browser, dsf, monx, shoot) {
  const tag = `dpi ${dsf}${monx ? ' monx ' + monx : ''}`;
  const { ctx, page, errors } = await open(browser, `${PAGE}?mode=rect&monx=${monx}&cursor=300,200`, 1280, 720, dsf);
  const mon = await page.evaluate(() => window.__shot.mon);
  check(`${tag}: monitor is viewport x scale`, mon.w === Math.round(1280 * dsf) && mon.h === Math.round(720 * dsf), JSON.stringify(mon));
  const a = { x: 100.4, y: 80.6 }, b = { x: 740.3, y: 420.9 };
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2);
  await page.mouse.move(b.x, b.y);
  const seen = await page.evaluate(() => ({ anchor: window.__shot.anchor, ptr: window.__shot.ptr }));
  const want = G.cssToPhys(G.normRect(seen.anchor.x, seen.anchor.y, seen.ptr.x, seen.ptr.y), mon, { w: 1280, h: 720 });
  const hole = await holeRect(page);
  const back = G.physToCss(want, mon, { w: 1280, h: 720 });
  const half = 0.5 / dsf + 1e-6;
  check(`${tag}: the drawn hole is the physical rect back in CSS px`, hole && Math.abs(hole.x - back.x) <= half && Math.abs(hole.y - back.y) <= half &&
    Math.abs(hole.w - back.w) <= half && Math.abs(hole.h - back.h) <= half, JSON.stringify({ hole, back }));
  const label = await page.evaluate(() => document.getElementById('size').textContent);
  check(`${tag}: the size readout is the PHYSICAL size`, label === G.sizeText(want.w, want.h), `${label} vs ${want.w}x${want.h}`);
  if (shoot) await page.screenshot({ path: path.join(OUT, `overlay-rect-dragging-${dsf}x${monx ? '-monx' : ''}.png`) });
  await page.mouse.up();
  const c = await lastCall(page, 'screenshot.commit');
  check(`${tag}: mouse-up commits exactly cssToPhys of the points the page saw`, c && c.rect.x === want.x && c.rect.y === want.y &&
    c.rect.w === want.w && c.rect.h === want.h && c.grab === 7 && c.mode === 'rect', JSON.stringify({ got: c && c.rect, want }));
  check(`${tag}: the rect is inside the monitor`, c && c.rect.x >= mon.x && c.rect.x + c.rect.w <= mon.x + mon.w, JSON.stringify(c && c.rect));
  if (monx < 0) check(`${tag}: a monitor left of the primary commits negative x`, c && c.rect.x < 0);
  check(`${tag}: no page errors`, errors.length === 0, errors.join(' | '));
  await ctx.close();
}

async function modes(browser) {
  // Window mode: hover the fake "Browser" (second window, partly under "Notes"), click.
  let { ctx, page, errors } = await open(browser, `${PAGE}?mode=window`, 1280, 720, 1.25);
  const f = await page.evaluate(() => window.__mock.frame);
  const browserWin = f.windows[1];
  const p = G.physToCss({ x: browserWin.x + 40, y: browserWin.y + 60, w: 0, h: 0 }, f.monitor, { w: 1280, h: 720 });
  await page.mouse.move(p.x, p.y);
  const hole = await holeRect(page);
  const want = G.physToCss(browserWin, f.monitor, { w: 1280, h: 720 });
  check('window mode: the hovered window is the hole', hole && Math.abs(hole.x - want.x) < 0.5 && Math.abs(hole.w - want.w) < 0.5, JSON.stringify({ hole, want }));
  await page.screenshot({ path: path.join(OUT, 'overlay-window-hover-1.25x.png') });
  await page.mouse.down(); await page.mouse.up();
  let c = await lastCall(page, 'screenshot.commit');
  check('window mode: a click commits the window\'s physical rect', c && c.rect.x === browserWin.x && c.rect.w === browserWin.w && c.rect.h === browserWin.h && c.kind === 'window', JSON.stringify(c));
  check('window mode: no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();

  // Window mode over the empty desktop answers the whole monitor.
  ({ ctx, page } = await open(browser, `${PAGE}?mode=window`, 1280, 720, 1));
  await page.mouse.move(1270, 700); await page.mouse.down(); await page.mouse.up();
  c = await lastCall(page, 'screenshot.commit');
  check('window mode over the desktop commits the whole monitor', c && c.rect.w === 1280 && c.rect.h === 720 && c.kind === 'desktop', JSON.stringify(c));
  await ctx.close();

  // Full screen.
  ({ ctx, page } = await open(browser, `${PAGE}?mode=full&monx=-1920`, 1280, 720, 1.5));
  await page.mouse.move(640, 360);
  await page.screenshot({ path: path.join(OUT, 'overlay-full-1.5x.png') });
  await page.mouse.down(); await page.mouse.up();
  c = await lastCall(page, 'screenshot.commit');
  check('full screen: a click commits the whole monitor', c && c.rect.x === -1920 && c.rect.w === 1920 && c.rect.h === 1080 && c.kind === 'monitor', JSON.stringify(c));
  await ctx.close();

  // A click without a drag commits nothing and the overlay stays.
  ({ ctx, page } = await open(browser, `${PAGE}?mode=rect&cursor=500,300`, 1280, 720, 1));
  await page.screenshot({ path: path.join(OUT, 'overlay-rect-idle-1x.png') });
  await page.mouse.move(500, 300); await page.mouse.down(); await page.mouse.up();
  c = await lastCall(page, 'screenshot.commit');
  check('a click without a drag commits nothing', c === null);
  // Keyboard only: R, Enter (anchor), 25 x Shift+Right, 12 x Shift+Down, Enter.
  await page.keyboard.press('r');
  await page.keyboard.press('Enter');
  for (let i = 0; i < 25; i++) await page.keyboard.press('Shift+ArrowRight');
  for (let i = 0; i < 12; i++) await page.keyboard.press('Shift+ArrowDown');
  await page.screenshot({ path: path.join(OUT, 'overlay-rect-keyboard-1x.png') });
  await page.keyboard.press('Enter');
  c = await lastCall(page, 'screenshot.commit');
  check('keyboard: Enter, Shift+arrows, Enter commits a 250 x 120 rect', c && c.rect.w === 250 && c.rect.h === 120 && c.via === 'keyboard', JSON.stringify(c));
  await ctx.close();

  // Keyboard mode switch + Esc; the mode bar tells main.
  ({ ctx, page } = await open(browser, `${PAGE}?mode=rect`, 1280, 720, 1));
  await page.keyboard.press('w');
  const m = await lastCall(page, 'screenshot.mode');
  check('W switches to Window mode and tells main (the other monitors follow)', m && m.mode === 'window');
  await page.click('button[data-mode="full"]');
  const m2 = await lastCall(page, 'screenshot.mode');
  check('the mode bar button switches to Full screen', m2 && m2.mode === 'full' &&
    await page.evaluate(() => document.querySelector('button[data-mode="full"]').getAttribute('aria-pressed')) === 'true');
  await page.keyboard.press('Escape');
  const x = await lastCall(page, 'screenshot.cancel');
  check('Esc cancels', x && x.why === 'Esc');
  await ctx.close();

  // RIGHT-CLICK (lane capture-shot; it did nothing before). During a drag it drops the selection and
  // the overlay stays (the next drag captures); with no drag it cancels, like Esc.
  ({ ctx, page, errors } = await open(browser, `${PAGE}?mode=rect`, 1280, 720, 1));
  await page.mouse.move(100, 100); await page.mouse.down(); await page.mouse.move(300, 250, { steps: 3 });
  await page.mouse.down({ button: 'right' }); await page.mouse.up({ button: 'right' });
  await page.mouse.up();
  let st = await page.evaluate(() => ({ anchor: window.__shot.anchor, done: window.__shot.done, hole: document.getElementById('hole').hidden }));
  c = await lastCall(page, 'screenshot.commit');
  let xx = await lastCall(page, 'screenshot.cancel');
  check('right-click during a drag drops the selection: nothing captured, nothing cancelled, the overlay stays', !c && !xx && !st.anchor && !st.done && st.hole, JSON.stringify({ st, c, xx }));
  await page.mouse.move(400, 300); await page.mouse.down(); await page.mouse.move(600, 450, { steps: 3 }); await page.mouse.up();
  c = await lastCall(page, 'screenshot.commit');
  check('...and the next drag still captures', c && c.rect.w === 200 && c.rect.h === 150, JSON.stringify(c));
  check('right-click: no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
  ({ ctx, page } = await open(browser, `${PAGE}?mode=window`, 1280, 720, 1));
  await page.mouse.click(640, 400, { button: 'right' });
  xx = await lastCall(page, 'screenshot.cancel');
  c = await lastCall(page, 'screenshot.commit');
  check('right-click with no drag cancels, like Esc (and captures nothing)', xx && xx.why === 'right-click' && !c, JSON.stringify({ xx, c }));
  await ctx.close();

  // A press that starts on the mode bar, let go over the screen, captures nothing (it captured the
  // window under the pointer before); a plain click then still does; a double-click captures ONCE.
  ({ ctx, page } = await open(browser, `${PAGE}?mode=window`, 1280, 720, 1));
  const bb = await (await page.$('button[data-mode="window"]')).boundingBox();
  await page.mouse.move(bb.x + 6, bb.y + 6); await page.mouse.down(); await page.mouse.move(640, 500, { steps: 4 }); await page.mouse.up();
  c = await lastCall(page, 'screenshot.commit');
  check('a press on the mode bar let go over the screen captures nothing', c === null, JSON.stringify(c));
  await page.mouse.dblclick(640, 500);
  const commits = await page.evaluate(() => window.__mock.calls.filter((x) => x.name === 'screenshot.commit').length);
  check('then a double-click on a window captures it once', commits === 1, `${commits} commits`);
  await ctx.close();
  ({ ctx, page } = await open(browser, `${PAGE}?mode=rect`, 1280, 720, 1));
  await page.click('#close');
  xx = await lastCall(page, 'screenshot.cancel');
  check('the X on the mode bar cancels', xx && xx.why === 'the close button', JSON.stringify(xx));
  await ctx.close();
  const tabs = [];
  ({ ctx, page } = await open(browser, `${PAGE}?mode=rect`, 1280, 720, 1));
  for (let i = 0; i < 5; i++) { await page.keyboard.press('Tab'); tabs.push(await page.evaluate(() => document.activeElement && (document.activeElement.getAttribute('data-mode') || document.activeElement.id))); }
  check('Tab walks the mode bar in order, then the X', tabs.join(',') === 'rect,window,full,text,close', tabs.join(','));
  await page.keyboard.press('Enter');
  xx = await lastCall(page, 'screenshot.cancel');
  check('Enter on the focused X cancels (Enter on a button never captures)', xx && xx.why === 'the close button' && !(await lastCall(page, 'screenshot.commit')), JSON.stringify(xx));
  await ctx.close();

  // The problem panel (NO SILENT FAILURES) and a dark desktop.
  ({ ctx, page } = await open(browser, `${PAGE}?problem=1`, 1280, 720, 1));
  const shown = await page.evaluate(() => !document.getElementById('problem').hidden && document.getElementById('problem-text').textContent);
  check('a frame problem is shown in plain words (no codes, no jargon)', /picture of this screen/.test(shown || '') && !/sidecar|BitBlt|Win32|0x/i.test(shown || ''), shown);
  await page.screenshot({ path: path.join(OUT, 'overlay-problem.png') });
  await ctx.close();
  ({ ctx, page } = await open(browser, `${PAGE}?mode=window&dark=1&cursor=400,300`, 1920, 1080, 1));
  await page.screenshot({ path: path.join(OUT, 'overlay-window-dark-1920.png') });
  await ctx.close();
}

/* 2b. COPY TEXT (ocr lane, 2026-09-27): T and the bar button pick it, a drag commits mode 'text'
   with the same DPI-exact rect, and an unavailable OCR is disabled WITH its reason (no silent failure). */
async function copyText(browser) {
  let { ctx, page, errors } = await open(browser, `${PAGE}?mode=rect&cursor=300,200`, 1280, 720, 1.25);
  await page.keyboard.press('t');
  const m = await lastCall(page, 'screenshot.mode');
  const st = await page.evaluate(() => ({ pressed: document.querySelector('button[data-mode="text"]').getAttribute('aria-pressed'), hint: document.getElementById('hint').textContent, mode: window.__shot.mode }));
  check('copy text: T picks it, tells main, presses its button, says what a drag does', m && m.mode === 'text' && st.pressed === 'true' && st.mode === 'text' && /Drag over text to copy it/.test(st.hint), JSON.stringify({ m, st }));
  const mon = await page.evaluate(() => window.__shot.mon);
  const a = { x: 180.2, y: 150.7 }, b = { x: 620.6, y: 330.1 };
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y);
  const seen = await page.evaluate(() => ({ anchor: window.__shot.anchor, ptr: window.__shot.ptr }));
  const want = G.cssToPhys(G.normRect(seen.anchor.x, seen.anchor.y, seen.ptr.x, seen.ptr.y), mon, { w: 1280, h: 720 });
  await page.screenshot({ path: path.join(OUT, 'overlay-text-dragging-1.25x.png') });
  await page.mouse.up();
  const c = await lastCall(page, 'screenshot.commit');
  check('copy text: a drag commits mode "text" with the DPI-exact physical rect', c && c.mode === 'text' && c.rect.x === want.x && c.rect.y === want.y && c.rect.w === want.w && c.rect.h === want.h, JSON.stringify({ got: c, want }));
  check('copy text: no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();

  ({ ctx, page, errors } = await open(browser, `${PAGE}?mode=rect`, 1280, 720, 1));
  await page.click('button[data-mode="text"]');
  const m2 = await lastCall(page, 'screenshot.mode');
  check('copy text: the bar button picks it', m2 && m2.mode === 'text');
  await page.screenshot({ path: path.join(OUT, 'overlay-text-idle-1x.png') });
  await ctx.close();

  // Unavailable: the button is aria-disabled with the reason as its tooltip; T and a click say it.
  ({ ctx, page, errors } = await open(browser, `${PAGE}?mode=rect&ocr=off`, 1280, 720, 1.25));
  const btn = await page.evaluate(() => { const b2 = document.querySelector('button[data-mode="text"]'); return { dis: b2.getAttribute('aria-disabled'), off: b2.classList.contains('off'), title: b2.title }; });
  check('copy text unavailable: the button shows it, with the reason as its tooltip', btn.dis === 'true' && btn.off && /unavailable: Windows has no text recognition installed/.test(btn.title), JSON.stringify(btn));
  await page.keyboard.press('t');
  await page.click('button[data-mode="text"]', { force: true });   // aria-disabled: Playwright will not click it unforced; a real click still lands
  const after = await page.evaluate(() => ({ mode: window.__shot.mode, hint: document.getElementById('hint').textContent, warn: document.getElementById('hint').classList.contains('warn') }));
  const told = await page.evaluate(() => window.__mock.calls.filter((x) => x.name === 'screenshot.mode').length);
  check('copy text unavailable: T and a click say why in the hint, and the mode stays', after.mode === 'rect' && after.warn && /Copy text is unavailable: Windows has no text recognition/.test(after.hint) && told === 0, JSON.stringify({ after, told }));
  await page.screenshot({ path: path.join(OUT, 'overlay-text-unavailable-1.25x.png') });
  await page.keyboard.press('f');
  const back = await page.evaluate(() => ({ mode: window.__shot.mode, warn: document.getElementById('hint').classList.contains('warn') }));
  check('copy text unavailable: another mode clears the warning', back.mode === 'full' && !back.warn, JSON.stringify(back));
  check('copy text unavailable: no page errors', errors.length === 0, errors.join(' | '));
  // Main asked again during the capture and Windows' OCR answered (lane capture-shot): the button
  // comes on without a new capture, and T now picks Copy text.
  await page.keyboard.press('t');
  await page.evaluate(() => window.__mockEmit('screenshot.ocr', { available: true, why: null, lang: 'en-US' }));
  const on = await page.evaluate(() => { const b2 = document.querySelector('button[data-mode="text"]'); return { dis: b2.getAttribute('aria-disabled'), off: b2.classList.contains('off'), warn: document.getElementById('hint').classList.contains('warn') }; });
  await page.keyboard.press('t');
  const now = await page.evaluate(() => window.__shot.mode);
  check('copy text: an OCR answer during the capture turns the button on and clears the warning; T works', on.dis === 'false' && !on.off && !on.warn && now === 'text', JSON.stringify({ on, now }));
  await ctx.close();
}

async function cards(browser) {
  for (const st of ['text', 'notext', 'textfail']) {
    const { ctx, page, errors } = await open(browser, `${CARD}?state=${st}&life=0`, 420, 190, 1.25);
    await page.waitForTimeout(700);
    await page.screenshot({ path: path.join(OUT, `card-${st}.png`) });
    const t = await page.evaluate(() => ({ title: document.getElementById('title').textContent, name: document.getElementById('name').textContent,
      status: document.getElementById('status').textContent, warn: document.getElementById('warn').hidden ? '' : document.getElementById('warn').textContent,
      thumb: getComputedStyle(document.getElementById('open')).display, actions: getComputedStyle(document.querySelector('.actions')).display }));
    if (st === 'text') check('card text: "Copied 3 lines", the preview, plain text on the clipboard', t.title === 'Copied 3 lines' && /^“Question 7: .*…”$/.test(t.name) && /Plain text/.test(t.status) && !t.warn, JSON.stringify(t));
    if (st === 'notext') check('card notext: "No text found in that area", nothing copied', t.title === 'No text found in that area' && /Nothing was copied/.test(t.status) && !t.name, JSON.stringify(t));
    if (st === 'textfail') check('card textfail: says not copied and why', t.title === 'Text not copied' && /^Windows has no text recognition/.test(t.warn) && !/Not copied/.test(t.warn), JSON.stringify(t));
    check(`card ${st}: no thumbnail and no file actions (nothing was saved)`, t.thumb === 'none' && t.actions === 'none', JSON.stringify(t));
    check(`card ${st}: no page errors`, errors.length === 0, errors.join(' | '));
    await ctx.close();
  }
  const dismissals = (page) => page.evaluate(() => window.__mock.calls.filter((c) => c.name === 'screenshot.cardDismiss').map((c) => c.args));
  const state = (page) => page.evaluate(() => Object.assign(window.__cardState(), {
    thumb: getComputedStyle(document.getElementById('open')).display, actions: getComputedStyle(document.querySelector('.actions')).display,
    justSaved: document.getElementById('card').classList.contains('just-saved') }));
  const calls = (page, name) => page.evaluate((n) => window.__mock.calls.filter((c) => c.name === n).map((c) => c.args), name);
  // A picture card after a text card: the text-card class must not stick (one card window serves both).
  {
    const { ctx, page } = await open(browser, `${CARD}?state=text&life=0`, 420, 190, 1);
    await page.evaluate(() => window.__cardEmit('screenshot.card', { seq: 4, thumb: window.__mockPieces(), w: 800, h: 600, copied: true, canSave: true, lifeMs: 1e9 }));
    await page.waitForTimeout(300);
    const t = Object.assign(await state(page), { cls: await page.evaluate(() => document.getElementById('card').classList.contains('text-card')) });
    check('card: a picture card after a text card is a picture card again (picture, Save)', !t.cls && t.thumb !== 'none' && t.title === 'Screenshot copied' && t.save && t.save.label === 'Save' && t.pic >= 1, JSON.stringify(t));
    await ctx.close();
  }
  // THE STATES (lane shot-save): copied is the default; Save is offered whenever nothing was saved.
  for (const st of ['copied', 'auto', 'nosave', 'nocopy', 'neither']) {
    const { ctx, page, errors } = await open(browser, `${CARD}?state=${st}&life=0`, 420, 190, 1.25);
    await page.waitForTimeout(700);
    await page.screenshot({ path: path.join(OUT, `card-${st}.png`) });
    const t = await state(page);
    if (st === 'copied') check('card copied (the default): "Screenshot copied", its size, a Save button, no file actions, picture drawn from the frame, nothing to open',
      t.title === 'Screenshot copied' && t.status === '1280 × 720' && !t.warn && t.save && t.save.label === 'Save' && !t.save.disabled && !t.folder && !t.copyPath && !t.open && t.pic >= 1, JSON.stringify(t));
    if (st === 'auto') check('card auto (saving every screenshot): "Screenshot copied", "Saved to Screenshots · size", Show in folder + Copy path, no Save',
      t.title === 'Screenshot copied' && t.status === 'Saved to Screenshots · 1280 × 720' && !t.warn && !t.save && t.folder === 'Show in folder' && t.copyPath && t.open, JSON.stringify(t));
    if (st === 'nosave') check('card nosave: copied, says not saved and why, and offers Save again', t.title === 'Screenshot copied' && /^Not saved: Windows did not let Mantle save there/.test(t.warn) && t.save && !t.folder, JSON.stringify(t));
    if (st === 'nocopy') check('card nocopy: says not copied and why, and offers Save', t.title === 'Screenshot not copied' && /^Not copied: another app/.test(t.warn) && t.save && t.save.label === 'Save' && t.thumb !== 'none', JSON.stringify(t));
    if (st === 'neither') check('card neither: not copied, both reasons, Save offered', t.title === 'Screenshot not copied' && /Not saved/.test(t.warn) && /Not copied/.test(t.warn) && !!t.save, JSON.stringify(t));
    check(`card ${st}: no jargon on screen`, !/sidecar|\bshot\.\w|Exception|0x[0-9A-F]|HRESULT|undefined|null|NaN/.test(t.title + t.status + t.warn), t.title + ' | ' + t.status + ' | ' + t.warn);
    check(`card ${st}: no page errors`, errors.length === 0, errors.join(' | '));
    await ctx.close();
  }
  // SAVE, pressed: "Saving..." holds the card, then it says where it went; a double press saves once.
  {
    const { ctx, page, errors } = await open(browser, `${CARD}?state=copied&life=0&saveslow=900`, 420, 190, 1.25);
    await page.waitForTimeout(700);
    await page.click('#save');
    await page.click('#save', { force: true }).catch(() => {});
    await page.waitForTimeout(150);
    const busy = await state(page);
    await page.screenshot({ path: path.join(OUT, 'card-saving.png') });
    check('card Save: says "Saving…" (disabled) and the timer rests while it works', busy.save && busy.save.label === 'Saving…' && busy.save.disabled && busy.paused, JSON.stringify(busy));
    await page.waitForTimeout(1100);
    await page.mouse.move(2, 2);
    await page.waitForTimeout(250);
    const t = await state(page);
    await page.screenshot({ path: path.join(OUT, 'card-saved.png') });
    const saves = await calls(page, 'screenshot.cardSave');
    check('card Save: asks main ONCE for this card (a double press adds nothing)', saves.length === 1 && saves[0].seq === 3 && saves[0].via === 'button', JSON.stringify(saves));
    check('card Save: then says "Saved to Screenshots" (with its check), "1280 × 720 · also copied", Show in folder + Copy path, the picture opens it',
      t.title === 'Saved to Screenshots' && t.status === '1280 × 720 · also copied' && t.justSaved && !t.save && t.folder === 'Show in folder' && t.copyPath && t.open && !t.warn, JSON.stringify(t));
    const holds = (await calls(page, 'screenshot.cardHold')).map((c) => c.held);
    check('card Save: main hears the card held while saving and let go after (its backstop follows)', holds[0] === true && holds.includes(false), JSON.stringify(holds));
    const sizes = await calls(page, 'screenshot.cardSize');
    check('card Save: the window is told the card\'s new size', sizes.length >= 1 && sizes[0].w > 300, JSON.stringify(sizes));
    check('card Save: no page errors', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }
  // SAVE FAILS: the card stays, says why in plain words, and Save can be pressed again.
  {
    const { ctx, page } = await open(browser, `${CARD}?state=copied&life=0&savefail=1`, 420, 190, 1.25);
    await page.waitForTimeout(700);
    await page.click('#save');
    await page.waitForTimeout(400);
    await page.mouse.move(2, 2);
    await page.waitForTimeout(200);
    const t = await state(page);
    await page.screenshot({ path: path.join(OUT, 'card-savefail.png') });
    const ds = await dismissals(page);
    check('card Save fails: the card stays, says "Not saved: <why>", and the button says Try again', ds.length === 0 && !t.gone && /^Not saved: Windows did not let Mantle save there/.test(t.warn) &&
      t.save && t.save.label === 'Try again' && !t.save.disabled && t.title === 'Screenshot copied', JSON.stringify(t));
    await page.click('#save');
    await page.waitForTimeout(300);
    check('card Save fails: Try again asks main again', (await calls(page, 'screenshot.cardSave')).length === 2);
    await ctx.close();
  }
  // KEYBOARD: the arrows reach Save; Ctrl+S saves; Esc closes.
  {
    const { ctx, page } = await open(browser, `${CARD}?state=copied&life=0`, 420, 190, 1);
    await page.waitForTimeout(500);
    await page.keyboard.press('ArrowRight');
    const first = await page.evaluate(() => document.activeElement && document.activeElement.id);
    await page.keyboard.press('Control+s');
    await page.waitForTimeout(300);
    const saves = await calls(page, 'screenshot.cardSave');
    check('card keyboard: Right lands on Save first (the picture has nothing to open yet), Ctrl+S saves', first === 'save' && saves.length === 1 && saves[0].via === 'key', JSON.stringify({ first, saves }));
    await ctx.close();
  }
  // THE TIMER: ~7 s with a Save button, resting under the pointer, then it goes by itself.
  const dismissals2 = dismissals;
  {
    const { ctx, page } = await open(browser, `${CARD}?state=copied`, 420, 190, 1);
    const l00 = await page.evaluate(() => window.__card.life);
    await page.hover('#card');
    await page.waitForTimeout(200);
    const l0 = await page.evaluate(() => window.__cardState().left);
    await page.waitForTimeout(1500);
    const l1 = await page.evaluate(() => window.__cardState());
    check('card timer: a picture card lives 7 s; the pointer on it pauses the countdown and the bar rests', l00 === 7000 && Math.abs(l1.left - l0) < 60 && l1.paused && (await dismissals2(page)).length === 0, JSON.stringify({ l00, l0, l1 }));
    await page.mouse.move(5, 5);         // off the card, so the timer runs
    const t0 = Date.now();
    await page.waitForFunction(() => window.__mock.calls.some((c) => c.name === 'screenshot.cardDismiss'), null, { timeout: 12000 }).catch(() => {});
    const d = await lastCall(page, 'screenshot.cardDismiss');
    check('card timer: it goes by itself once the pointer leaves, after the time it had left', d && d.why === 'timeout' && d.seq === 3 && Date.now() - t0 > 4000, JSON.stringify({ d, ms: Date.now() - t0 }));
    await ctx.close();
  }
  // THE ACTIONS of a saved card (lane capture-shot): each asks main once, naming THIS card (its seq).
  const card5 = (seq) => ({ seq, name: 'Screenshot 2026-09-29 101500.png', folderName: 'Screenshots', path: 'C:\\x.png', w: 10, h: 10, copied: true, lifeMs: 1e9 });
  {
    const { ctx, page } = await open(browser, `${CARD}?state=auto`, 420, 190, 1);
    await page.click('#copy-path');
    await page.click('#copy-path');
    const n = await page.evaluate(() => window.__mock.calls.filter((c) => c.name === 'screenshot.cardCopyPath').length);
    const cp = await lastCall(page, 'screenshot.cardCopyPath');
    const lbl = await page.textContent('#copy-path');
    check('card: Copy path asks main once (a second click adds nothing), names this card, says "Path copied"', n === 1 && cp && cp.seq === 3 && lbl === 'Path copied', JSON.stringify({ n, cp, lbl }));
    await ctx.close();
  }
  {
    const { ctx, page } = await open(browser, `${CARD}?state=auto&life=0`, 420, 190, 1);
    await page.waitForTimeout(700);
    await page.hover('#open');
    await page.waitForTimeout(200);
    const aff = await page.evaluate(() => ({ glyph: getComputedStyle(document.querySelector('.open-glyph')).opacity, tip: document.getElementById('open').title, titleTag: document.getElementById('title').tagName }));
    await page.screenshot({ path: path.join(OUT, 'card-auto-hover.png') });
    check('card: a saved picture looks clickable on hover (open glyph) and names the file in its tooltip; the title is plain text', aff.glyph === '1' && /^Open Screenshot 2026-09-24 143005\.png$/.test(aff.tip) && aff.titleTag === 'DIV', JSON.stringify(aff));
    await page.dblclick('#open');
    await page.waitForTimeout(500);
    const opens = await page.evaluate(() => window.__mock.calls.filter((c) => c.name === 'screenshot.cardOpen').length);
    const ds = await dismissals(page);
    check('card: a double-click on the picture opens it ONCE and the card goes (after its slide-out)', opens === 1 && ds.length === 1 && ds[0].why === 'opened' && ds[0].seq === 3, JSON.stringify({ opens, ds }));
    await ctx.close();
  }
  {
    const { ctx, page } = await open(browser, `${CARD}?state=auto&life=0&openfail=1`, 420, 190, 1);
    await page.click('#open');
    await page.waitForTimeout(500);
    const w = await page.evaluate(() => document.getElementById('warn').hidden ? '' : document.getElementById('warn').textContent);
    const ds = await dismissals(page);
    await page.screenshot({ path: path.join(OUT, 'card-openfail.png') });
    check('card: an open that fails keeps the card up and says why in plain words', ds.length === 0 && /^Not opened: Windows has no app/.test(w), JSON.stringify({ w, ds }));
    await ctx.close();
  }
  {
    const { ctx, page } = await open(browser, `${CARD}?state=auto&life=0`, 420, 190, 1);
    await page.click('#folder');
    await page.waitForTimeout(450);
    const f = await lastCall(page, 'screenshot.cardFolder');
    let d = await lastCall(page, 'screenshot.cardDismiss');
    check('card: Show in folder asks main (this card) and the card goes', f && f.seq === 3 && d && d.why === 'folder' && d.seq === 3, JSON.stringify({ f, d }));
    await page.evaluate((c) => window.__cardEmit('screenshot.card', c), card5(4));
    await page.waitForTimeout(700);
    await page.click('#dismiss');
    await page.waitForTimeout(450);
    d = await lastCall(page, 'screenshot.cardDismiss');
    check('card: the X closes it, naming its own card', d && d.why === 'closed' && d.seq === 4, JSON.stringify(d));
    await page.evaluate((c) => window.__cardEmit('screenshot.card', c), card5(5));
    await page.waitForTimeout(700);
    const walk = [];
    for (let i = 0; i < 3; i++) { await page.keyboard.press('ArrowRight'); walk.push(await page.evaluate(() => document.activeElement && document.activeElement.id)); }
    const held = await page.evaluate(() => window.__card.focus);
    check('card: the arrows walk a saved card\'s controls from the first (picture, Show in folder, Copy path); keyboard focus holds the timer', walk.join(',') === 'open,folder,copy-path' && held, JSON.stringify({ walk, held }));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(450);
    d = await lastCall(page, 'screenshot.cardDismiss');
    check('card: Esc closes it', d && d.why === 'Esc' && d.seq === 5, JSON.stringify(d));
    await ctx.close();
  }
  {
    // A new capture's card arriving DURING the old card's slide-out stays up: the old dismiss is dropped.
    const { ctx, page } = await open(browser, `${CARD}?state=copied&life=0`, 420, 190, 1);
    await page.waitForTimeout(700);
    await page.click('#dismiss');
    await page.evaluate((c) => window.__cardEmit('screenshot.card', c), card5(9));
    await page.waitForTimeout(600);
    const ds = await dismissals(page);
    const up = await page.evaluate(() => !document.getElementById('card').hidden && !window.__card.gone && document.getElementById('card').classList.contains('in'));
    check('card: a card that arrives during the last one\'s slide-out stays up (no stale dismiss reaches main)', ds.length === 0 && up, JSON.stringify({ ds, up }));
    await ctx.close();
  }
}

/* 3. The sidecar's frame format, decoded by Chromium (synthetic pixels only). */
async function frameFormat(browser) {
  if (!EXE || !fs.existsSync(EXE)) { console.log('  frame-format check SKIPPED: no MANTLE_SIDECAR_EXE'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-shot-shoot-'));
  const p = spawn(EXE, ['--passive'], { stdio: ['pipe', 'pipe', 'ignore'] });
  const reply = await new Promise((resolve) => {
    let buf = '';
    p.stdout.on('data', (c) => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { const m = JSON.parse(l); if (m.id === 1) resolve(m); } catch (_) { /* skip */ } } });
    p.stdin.write(JSON.stringify({ id: 1, cmd: 'shot.grab', dir, synthetic: true, ttl: 15000 }) + '\n');
  });
  try {
    check('synthetic grab for the decode check', reply.ok, reply.error);
    if (!reply.ok) return;
    const m = reply.result.monitors[0];
    const ctx = await browser.newContext({ viewport: { width: 400, height: 300 } });
    const page = await ctx.newPage();
    await page.goto(CARD + '?life=0');
    const r = await page.evaluate(async (src) => {
      const img = new Image();
      const t0 = performance.now();
      img.src = src;
      await img.decode();
      const ms = performance.now() - t0;
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      const pts = [[0, 0], [c.width - 1, 0], [0, c.height - 1], [c.width - 1, c.height - 1], [301, 177], [1023, 511]];
      const px = pts.filter(([x, y]) => x < c.width && y < c.height).map(([x, y]) => [x, y, ...g.getImageData(x, y, 1, 1).data]);
      const all = g.getImageData(0, 0, c.width, c.height).data;
      let transparent = 0;
      for (let i = 3; i < all.length; i += 4) if (all[i] !== 255) transparent++;
      return { w: img.naturalWidth, h: img.naturalHeight, ms, px, transparent };
    }, 'file:///' + m.file.replace(/\\/g, '/'));
    check('Chromium decodes the frame BMP at the monitor size', r.w === m.frame.w && r.h === m.frame.h, JSON.stringify({ w: r.w, h: r.h }));
    check('the decoded frame is fully opaque (the junk fourth byte is ignored)', r.transparent === 0, `${r.transparent} pixels not opaque`);
    const exp = (vx, vy) => [((((vx >> 8) & 15) << 4) | ((vy >> 8) & 15)) & 255, vy & 255, vx & 255];
    const bad = r.px.filter(([x, y, R, Gr, B]) => { const e = exp(m.frame.x + x, m.frame.y + y); return e[0] !== R || e[1] !== Gr || e[2] !== B; });
    check('the decoded frame is pixel-exact', bad.length === 0, JSON.stringify(bad));
    console.log(`  frame decode in Chromium: ${r.w}x${r.h} BMP (${Math.round(m.bytes / 1048576 * 10) / 10} MB) in ${r.ms.toFixed(1)} ms`);
    await ctx.close();
  } finally {
    p.stdin.write(JSON.stringify({ id: 2, cmd: 'shot.release' }) + '\n');
    await new Promise((res) => setTimeout(res, 300));
    try { p.kill(); } catch (_) { /* gone */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}


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

(async () => {
  const games = gamesRunning();
  if (games) { console.log(`NOT RUN: ${games} game process(es) are running; screenshots wait.`); process.exit(2); }
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await require('../settings/test-browser.js').launch(chromium, { timeout: 0, headless: true, args: ['--allow-file-access-from-files'] });
  themeEvery(browser);   // MANTLE_THEME=dark|light: <html data-theme> + the mantle-theme event, as dm-core's plumbing does
  try {
    // MANTLE_SHOOT_ONLY=cards: just the card's states and actions (lane shot-save: one theme pass each).
    const only = process.env.MANTLE_SHOOT_ONLY === 'cards';
    if (!only) await dpiCase(browser, 1, 0, true);
    if (!only) await dpiCase(browser, 1.25, 0, true);
    if (!only) await dpiCase(browser, 1.5, -1920, true);
    if (!only) await dpiCase(browser, 2, 0, false);
    if (!only) await modes(browser);
    if (!only) await copyText(browser);
    await cards(browser);
    if (!only) await frameFormat(browser);
  } finally {
    await browser.close();
  }
  console.log(`screenshot shots: ${passed} passed, ${failures.length} failed (PNGs in ${OUT})`);
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.log('screenshot shots: crashed: ' + e.stack); process.exit(1); });
