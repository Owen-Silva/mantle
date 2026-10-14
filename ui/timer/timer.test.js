require('C:/Users/user/dev-tools/tools/lowcpu.js');
/* timer.test.js - the "Timer done" pop-up's PAGE (lane topbar-timer, 2026-09-29). Headless Chromium
 * over file:// (never Electron, never a sound: the mock sends mute, or has no working audio), the REAL
 * ui/timer/index.html + timer.js + _timer-core.js on ui/timer/mock-mantle.js. It CLICKS and TYPES
 * through the pop-up: every button, a double click, Esc, Tab order + Enter, a refused action and a
 * second try, a click outside the card, every wording of the sub line, a failed chime, the no-link
 * state, and that nothing overflows the window main makes (lib/features/timer.js WIN 344 x 132).
 * Line 1 is the machine-wide CPU cap. Run it through the lane's uislot:
 *   node ui/timer/timer.test.js      -> "TIMER PAGE TEST: n passed, m failed"
 * Shots go to MANTLE_SHOOT_OUT (default the lane's shots dir). A game running = skipped (and said).
 */
'use strict';
const path = require('path');
const { execSync } = require('child_process');

const PAGE = 'file:///' + path.resolve(__dirname, 'index.html').replace(/\\/g, '/');
const OUT = process.env.MANTLE_SHOOT_OUT ||
  'C:/Users/user/AppData/Local/Temp/claude/C--Users-owens/7e5085b9-5bec-43fe-aecd-5fe5701b290a/scratchpad/lanes/topbar/timer/shots';
const WIN = { w: 344, h: 132 };   // lib/features/timer.js: CARD 320 x 108 + PAD 12/12/6/18
const CARD_MAX = 108;

let passed = 0;
const failures = [];
const check = (name, ok, detail) => {
  if (ok) passed++;
  else { failures.push(name); console.log(`FAIL ${name}${detail !== undefined ? ': ' + String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 300) : ''}`); }
  return ok;
};

function gaming() {
  try {
    return parseInt(execSync('powershell -NoProfile -Command "@(Get-Process javaw,Minecraft*,RobloxPlayerBeta,VALORANT* -ErrorAction SilentlyContinue).Count"', { encoding: 'utf8' }).trim(), 10) || 0;
  } catch (_) { return -1; }
}

(async () => {
  if (gaming() > 0) { console.log('TIMER PAGE TEST: skipped (a game is running)'); return; }
  const { chromium } = require('C:/Users/user/other-app/node_modules/playwright-core');
  const fs = require('fs');
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await require('../settings/test-browser.js').launch(chromium, { headless: true });
  const bctx = await browser.newContext({ viewport: { width: WIN.w, height: WIN.h }, deviceScaleFactor: 2 });
  const page = await bctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  async function open(q, shot) {
    await page.goto(PAGE + (q ? '?' + q : ''), { waitUntil: 'load' });
    await page.waitForFunction(() => window.__timer && (window.__timer.shown || document.getElementById('title').textContent), null, { timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(250);   // the 160 ms entrance
    if (shot) await page.screenshot({ path: path.join(OUT, shot + '.png') });
    return page.evaluate(() => {
      const card = document.getElementById('card').getBoundingClientRect();
      const t = document.getElementById('title'), s = document.getElementById('sub');
      const btns = Array.from(document.querySelectorAll('.acts .b')).map((b) => ({ text: b.textContent, hidden: b.hidden || getComputedStyle(b).display === 'none', disabled: b.disabled, pri: b.classList.contains('pri'), tip: b.title,
        r: b.getBoundingClientRect().toJSON() }));
      return { title: t.textContent, titleTip: t.title, titleCut: t.scrollWidth > t.clientWidth, sub: s.textContent, subTip: s.title, subCut: (s.querySelector('.base') || s).scrollHeight > (s.querySelector('.base') || s).clientHeight + 1,
        card: card.toJSON(), btns, bad: Array.from(s.querySelectorAll('.bad')).map((b) => b.textContent),
        badOnCard: Array.from(s.querySelectorAll('.bad')).every((b) => { const r = b.getBoundingClientRect(); return r.height >= 12 && r.bottom <= card.bottom - 30 && r.top >= card.top; }), calls: window.__mockCalls || null,
        text: document.body.innerText, T: window.__timer };
    });
  }
  const calls = () => page.evaluate(() => (window.__mockCalls || []).filter((c) => c[0] !== 'timer.chime'));
  const inWindow = (v) => v.card.x >= 0 && v.card.y >= 0 && v.card.right <= WIN.w && v.card.bottom <= WIN.h && v.card.height <= CARD_MAX;
  const clean = (v) => !/undefined|null|NaN|\[object|sidecar|IPC|ENOENT|0x8/.test(v.text);

  try {
    // 1. the plain finish: title, sub, one primary action, the order, fits the window
    let v = await open('', 'done');
    check('done: title "Timer done: 25 min"', v.title === 'Timer done: 25 min', v.title);
    check('done: sub "Ended at 9:14 PM"', v.sub === 'Ended at 9:14 PM', v.sub);
    check('done: buttons +1 min, +5 min, Restart, Dismiss, left to right', JSON.stringify(v.btns.map((b) => b.text)) === '["+1 min","+5 min","Restart","Dismiss"]'
      && v.btns.every((b, i) => i === 0 || b.r.x > v.btns[i - 1].r.x), v.btns.map((b) => [b.text, b.r.x]));
    check('done: ONE primary action (Dismiss), at the right edge', v.btns.filter((b) => b.pri).length === 1 && v.btns[3].pri && Math.abs(v.btns[3].r.right - (v.card.right - 12)) <= 1, v.btns[3]);
    check('done: every button has a tooltip; Restart names the length', v.btns.every((b) => b.tip.length > 5) && v.btns[2].tip === 'Run the 25 min timer again', v.btns.map((b) => b.tip));
    check('done: all buttons one height (24), on one baseline', v.btns.every((b) => b.r.height === 24 && b.r.y === v.btns[0].r.y), v.btns.map((b) => [b.r.y, b.r.height]));
    check('done: the card fits the window main makes (<= 108 tall)', inWindow(v), v.card);
    check('done: no jargon or empty words on screen', clean(v), v.text);
    check('done: the chime reported muted (no sound in a test)', v.calls.some((c) => c[0] === 'timer.chime' && c[1].muted === true));

    // 2. clicks: +1 min / +5 min / Restart / Dismiss each name the finish (endAt); a double click runs once
    for (const [i, cmd, extra] of [[0, 'timer.snooze', { ms: 60000 }], [1, 'timer.snooze', { ms: 300000 }], [2, 'timer.again', {}], [3, 'timer.dismiss', {}]]) {
      v = await open('');
      await page.locator('.acts .b').nth(i).dblclick();
      const c = await calls();
      const disabled = await page.evaluate(() => Array.from(document.querySelectorAll('.acts .b')).every((b) => b.disabled));
      check(`click ${v.btns[i].text}: ONE ${cmd} ${JSON.stringify(extra)} with endAt, buttons pressed (disabled) at once`,
        c.length === 1 && c[0][0] === cmd && Object.keys(extra).every((k) => c[0][1][k] === extra[k]) && typeof c[0][1].endAt === 'number' && disabled, c);
    }

    // 3. keyboard (should the window ever hold focus): Tab order, focus ring, Enter, Esc
    v = await open('');
    const order = [];
    for (let k = 0; k < 4; k++) { await page.keyboard.press('Tab'); order.push(await page.evaluate(() => document.activeElement.textContent)); }
    check('keyboard: Tab walks +1 min, +5 min, Restart, Dismiss', JSON.stringify(order) === '["+1 min","+5 min","Restart","Dismiss"]', order);
    /* the focus ring contract: light draws a 2px solid outline; dark draws Helm's ring, box-shadow
       var(--lg-focus) with NO outline (HELM-SPEC row 19). Both themes are checked on the focused Dismiss. */
    const ringOf = () => page.evaluate(() => { const cs = getComputedStyle(document.activeElement); return { o: cs.outlineStyle, sh: cs.boxShadow }; });
    const ring = await ringOf();
    await page.screenshot({ path: path.join(OUT, 'focus-dismiss.png') });
    check('keyboard (light): the focused button shows a solid outline ring', ring.o === 'solid', ring);
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await page.waitForTimeout(200);   // the 120 ms box-shadow transition
    const dRing = await ringOf();
    await page.screenshot({ path: path.join(OUT, 'focus-dismiss-dark.png') });
    check('keyboard (dark): the focused button shows the --lg-focus box-shadow ring, no outline',
      dRing.o === 'none' && /rgba\(159, 180, 204, 0\.55\) 0px 0px 0px 3px/.test(dRing.sh), dRing);
    await page.evaluate(() => { delete document.documentElement.dataset.theme; });
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Enter');
    let c = await calls();
    check('keyboard: Enter on Restart runs timer.again', c.length === 1 && c[0][0] === 'timer.again', c);
    v = await open('');
    await page.keyboard.press('Escape');
    c = await calls();
    check('keyboard: Esc dismisses', c.length === 1 && c[0][0] === 'timer.dismiss', c);

    // 4. a click outside the card does nothing (a notice, not a menu: it waits for a choice or its 2 min)
    v = await open('');
    await page.mouse.click(4, WIN.h - 4);
    c = await calls();
    check('click outside the card: nothing is called, the card stays', c.length === 0 && await page.isVisible('#card'), c);

    // 5. hover and pressed states differ from rest
    v = await open('');
    const bg = (sel) => page.evaluate((s) => { const b = document.querySelector(s); const cs = getComputedStyle(b); return cs.backgroundColor + '|' + cs.boxShadow; }, sel);
    const rest = await bg('#restart');
    await page.hover('#restart');
    const hov = await bg('#restart');
    await page.hover('#dismiss');
    const priHov = await bg('#dismiss');
    await page.screenshot({ path: path.join(OUT, 'hover-dismiss.png') });
    check('hover: a quiet button and the primary both change on hover', rest !== hov && priHov !== rest && /inset/.test(priHov), [rest, hov, priHov]);
    /* dark: Helm's buttons (HELM-SPEC rows 8/9): quiet hover = --lg-press + the strong hairline; the
       primary's hover = --lg-acc-strong (#b7c8db) with no shadow. Colours ease over --lg-dur-ui (120 ms),
       so each is read after 200 ms, not mid-transition. */
    v = await open('');
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await page.mouse.move(2, 2);
    await page.waitForTimeout(200);
    const dRest = await bg('#restart');
    const dPriRest = await bg('#dismiss');
    await page.hover('#restart');
    await page.waitForTimeout(200);
    const dHov = await bg('#restart');
    await page.hover('#dismiss');
    await page.waitForTimeout(200);
    const dPriHov = await bg('#dismiss');
    await page.screenshot({ path: path.join(OUT, 'hover-dismiss-dark.png') });
    check('hover (dark): the quiet button changes, the primary turns --lg-acc-strong (rgb(183, 200, 219)) with no shadow',
      dRest !== dHov && dPriRest !== dPriHov && dPriHov.split('|')[0] === 'rgb(183, 200, 219)' && dPriHov.split('|')[1] === 'none', [dRest, dHov, dPriRest, dPriHov]);
    await page.evaluate(() => { delete document.documentElement.dataset.theme; });

    // 6. a refused action is said on the card (plain words), buttons come back, a second try goes out
    v = await open('fail=1');
    await page.click('#restart');
    await page.waitForTimeout(100);
    v = await page.evaluate(() => ({ bad: Array.from(document.querySelectorAll('#sub .bad')).map((b) => b.textContent), dis: document.getElementById('restart').disabled }));
    await page.screenshot({ path: path.join(OUT, 'refused.png') });
    check('refused: "Couldn\u2019t restart: the mock said no" as a warn line, buttons back', v.bad.length === 1 && v.bad[0] === 'Couldn\u2019t restart: the mock said no' && v.dis === false, v);
    await page.click('#dismiss');
    await page.waitForTimeout(50);
    c = await calls();
    check('refused: a second try goes out', c.length === 2 && c[1][0] === 'timer.dismiss', c);
  } catch (e) { check('the page test threw', false, e && e.stack); }

  try {
    // 7. every wording of the sub line, each fitting the window
    const cases = [
      ['off', 'mock=off', 'Timer done: 25 min', 'Ended at 9:14 PM, while Mantle was off'],
      ['game', 'mock=game', 'Timer done: 25 min', 'Ended at 9:14 PM, while VALORANT.exe ran'],
      ['asleep', 'mock=asleep', 'Timer done: 25 min', 'Ended at 9:14 PM, while the PC was asleep'],
      ['snooze', 'mock=snooze', 'Timer done: 25 min', 'Snoozed 5 min \u00b7 ended at 9:14 PM'],
      ['named', 'label=Tea', 'Timer done: Tea', '25 min timer \u00b7 ended at 9:14 PM'],
      ['named-off', 'label=Tea&mock=off', 'Timer done: Tea', '25 min timer \u00b7 ended at 9:14 PM, while Mantle was off'],
    ];
    for (const [shot, q, title, sub] of cases) {
      const v = await open(q, shot);
      check(`${shot}: "${title}" / "${sub}", fits, no cut line`, v.title === title && v.sub === sub && inWindow(v) && !v.subCut && clean(v), [v.title, v.sub, v.card, v.subCut]);
    }
    let v = await open('mock=snooze');
    check('snooze: Restart says it runs the 25 min timer (the original, not the snooze)', v.btns[2].tip === 'Run the 25 min timer again', v.btns[2].tip);
    // the longest: a named timer, off, a failed chime, on a dark desktop
    v = await open('label=' + encodeURIComponent('Take the laundry out of the machine downstairs before bed') + '&mock=game&sound=fail&dark=1', 'longest-dark');
    check('longest: the title ellipsizes with the full name on hover', v.titleCut && v.titleTip === 'Timer done: Take the laundry out of the machine downstairs before bed', [v.titleCut, v.titleTip]);
    check('longest: still inside the window, the full words in the tooltip', inWindow(v) && /No sound: no audio output device was found/.test(v.subTip), [v.card, v.subTip]);
    check('longest: the failed chime is still said ON the card (its own line above the buttons, not clipped away)', v.bad.length === 1 && /^No sound: /.test(v.bad[0]) && v.badOnCard, [v.bad, v.badOnCard]);
    // a failed chime: said on the card, reported to main
    v = await open('mock=nosound', 'nosound');
    check('nosound: the warn line "No sound: no audio output device was found"', v.bad.length === 1 && v.bad[0] === 'No sound: no audio output device was found', v.bad);
    check('nosound: main is told the chime failed, with the reason', v.calls.some((x) => x[0] === 'timer.chime' && x[1].ok === false && /no audio output/.test(x[1].reason)), v.calls);
    check('nosound: fits the window', inWindow(v) && clean(v), v.card);
    // main offers only one snooze: the other button is hidden
    v = await open('snoozes=60000');
    check('snoozes=[1 min]: "+5 min" is hidden', v.btns[0].hidden === false && v.btns[1].hidden === true, v.btns.map((b) => [b.text, b.hidden]));
    // no link to Mantle: plain words, buttons off
    v = await open('mock=none', 'nolink');
    check('no link to Mantle: plain words, every button disabled, no jargon', v.title === 'Timer done' && /lost its link to Mantle/.test(v.sub) && v.btns.every((b) => b.disabled) && !/window\.mantle|bridge/.test(v.text) && clean(v), [v.title, v.sub]);
    check('no page errors on any load', errors.length === 0, errors);
  } catch (e) { check('the page test threw (wordings)', false, e && e.stack); }

  await browser.close();
  console.log(`TIMER PAGE TEST: ${passed} passed, ${failures.length} failed`);
  process.exitCode = failures.length ? 1 : 0;
})();
