require('C:/Users/user/dev-tools/tools/lowcpu.js');
'use strict';
/* popups.test.js - the window layouts pop-up (ui/layouts), the keep-on-top pop-up (ui/ontop) and the
 * bar's on-top badge (ui/bar/ontop.js), FUNCTIONALLY (lane windows-layouts, 2026-09-29): the REAL page
 * files in headless Chromium over file://, with a FAKE window.mantle that records every call and lets
 * the test push events. It hovers and CLICKS the real Undo button, waits for the real fade, and reads
 * what is on screen. Never Electron, never a real window. Shots go to --shots=<dir> when given.
 *
 *   node ui/layouts/popups.test.js [--shots=<dir>]   -> "POPUPS PAGE TEST: n passed, m failed"
 */
const path = require('path');
const fs = require('fs');

// the newest installed Playwright Chromium (the pinned chromium-1234 build was removed 2026-10-05;
// lane same-finish, 2026-10-09, same recipe as ui/desktop/wall-player.test.js)
const CHROME = (() => {
  const fsx = require('fs');
  const base = 'C:/Users/user/AppData/Local/ms-playwright';
  try {
    for (const d of fsx.readdirSync(base).filter((n) => /^chromium-[0-9]+$/.test(n)).sort((x, y) => +y.slice(9) - +x.slice(9))) {
      const p = base + '/' + d + '/chrome-win64/chrome.exe';
      if (fsx.existsSync(p)) return p;
    }
  } catch (_) { /* reported below as "no chromium at" */ }
  return base + '/chromium-*/chrome-win64/chrome.exe';
})();
const ROOT = path.resolve(__dirname, '..', '..');
const url = (rel) => 'file:///' + path.join(ROOT, rel).replace(/\\/g, '/');
const SHOTS = (process.argv.find((a) => a.startsWith('--shots=')) || '').slice(8) || null;

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(detail !== undefined ? `${name} (${typeof detail === 'string' ? detail : JSON.stringify(detail)})` : name);
}
// what must never be on screen (BRIEF: no jargon)
const JARGON = /sidecar|hwnd|IPC|renderer|dryRun|AUMID|UIPI|window\.mantle|undefined|null|NaN|\[object|0x[0-9a-f]{4}|ENOENT|SetWindow/i;

/* Runs IN THE PAGE before its scripts: a recording window.mantle. __answers[name] is what call() resolves. */
const FAKE = `
  window.__calls = [];
  window.__handlers = {};
  window.__answers = {};
  window.__emit = function (ev, p) { (window.__handlers[ev] || []).forEach(function (fn) { fn(p); }); };
  window.mantle = {
    on: function (ev, fn) { (window.__handlers[ev] = window.__handlers[ev] || []).push(fn); return function () {}; },
    call: function (name, args) {
      window.__calls.push({ name: name, args: args });
      var a = window.__answers[name];
      return new Promise(function (r) { setTimeout(function () { r(a === undefined ? { ok: true } : a); }, 30); });
    },
  };`;

async function main() {
  const { chromium } = require('C:/Users/user/other-app/node_modules/playwright-core');
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    const ctx = await browser.newContext({ viewport: { width: 496, height: 190 }, deviceScaleFactor: 1 });
    const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name) }); } };
    const calls = (page, n) => page.evaluate((x) => window.__calls.filter((c) => !x || c.name === x), n);
    const onScreen = (page) => page.evaluate(() => document.body.innerText);

    /* ================= ui/layouts ================= */
    {
      const page = await ctx.newPage();
      await page.addInitScript(FAKE);
      await page.goto(url('ui/layouts/index.html'));
      await page.evaluate(() => window.__emit('layouts.toast', { text: 'Work: 2 placed, 1 not found, 3 couldn’t be moved', tone: 'warn',
        lines: ['Notion isn’t installed any more', 'Task Manager runs as administrator, so Windows doesn’t let Mantle move it', 'C', 'D', 'E', 'F'] }));
      check('layouts: the summary shows at once', await page.isVisible('#t') && (await page.textContent('#text')).startsWith('Work: 2 placed'));
      const lines = await page.$$eval('.line', (els) => els.map((e) => e.textContent));
      check('layouts: 4 reasons, then "and 2 more" (no mention of a log)', lines.length === 5 && lines[4] === 'and 2 more', lines);
      const cols = await page.evaluate(() => ({ line: getComputedStyle(document.querySelector('.line')).color, glyph: getComputedStyle(document.querySelector('.glyph')).color,
        text: getComputedStyle(document.querySelector('#text')).color }));
      check('layouts: a warn result draws each reason in the warn colour (the glyph\'s), not the headline\'s', cols.line === cols.glyph && cols.line !== cols.text, cols);
      check('layouts: no Undo on a result without one', await page.isHidden('#undo'));
      check('layouts: no jargon on screen', !JARGON.test(await onScreen(page)), await onScreen(page));
      await shot(page, 'layouts-warn.png');

      // a restore that moved windows: Undo
      await page.evaluate(() => window.__emit('layouts.toast', { text: 'Work: 3 placed', lines: [], tone: '', undo: true }));
      check('undo: the button shows, says "Undo", is enabled', await page.isVisible('#undo') && (await page.textContent('#undo')) === 'Undo' && await page.isEnabled('#undo'));
      check('undo: the old reasons are gone', (await page.$$('.line')).length === 0);
      await page.hover('#text');
      await page.waitForTimeout(80);
      let pc = await calls(page, 'layouts.pointer');
      check('undo: pointer over the pill asks main to take clicks', pc.length === 1 && pc[0].args.over === true, pc);
      await shot(page, 'layouts-undo.png');
      await page.hover('#undo');
      await shot(page, 'layouts-undo-hover.png');
      await page.evaluate(() => { window.__answers['layouts.undo'] = new Promise(() => {}); });   // main is slow: stay "Undoing…"
      await page.click('#undo');
      await page.click('#undo', { force: true }).catch(() => {});
      await page.waitForTimeout(60);
      const uc = await calls(page, 'layouts.undo');
      check('undo: a click calls layouts.undo exactly once (a second click does nothing)', uc.length === 1, uc.length);
      check('undo: pressed state within 100 ms: disabled + "Undoing…"', await page.isDisabled('#undo') && (await page.textContent('#undo')) === 'Undoing…');
      await shot(page, 'layouts-undoing.png');
      await page.mouse.move(2, 2);
      await page.waitForTimeout(80);
      pc = await calls(page, 'layouts.pointer');
      check('undo: pointer leaves -> clicks go through again', pc.length === 2 && pc[1].args.over === false, pc);

      // an undo main refuses: said on the pop-up, in words
      await page.evaluate(() => { window.__answers['layouts.undo'] = { ok: false, reason: 'there is nothing to undo' }; window.__emit('layouts.toast', { text: 'Code: 2 placed', undo: true }); });
      await page.click('#undo');
      await page.waitForTimeout(120);
      check('undo: a refusal is said on the pop-up', (await page.textContent('#text')) === 'Not undone' && /nothing to undo/.test(await page.textContent('#lines')) && await page.isHidden('#undo'),
        await onScreen(page));
      await shot(page, 'layouts-not-undone.png');

      // main never answers (the call throws): said in words, and Undo stays so a second press can retry
      await page.evaluate(() => { window.__answers['layouts.undo'] = Promise.reject(new Error('gone')); window.__answers['layouts.undo'].catch(() => {}); window.__emit('layouts.toast', { text: 'Code: 2 placed', undo: true }); });
      await page.click('#undo');
      await page.waitForTimeout(120);
      const na = await onScreen(page);
      check('undo: no answer is said in words, Undo stays to try again', (await page.textContent('#text')) === 'Not undone' && /did not answer\. Press Undo/.test(await page.textContent('#lines'))
        && await page.isVisible('#undo') && await page.isEnabled('#undo') && !JARGON.test(na) && !/Mantle menu/.test(na), na);
      await page.evaluate(() => { window.__answers['layouts.undo'] = { ok: true }; });
      await page.click('#undo');
      await page.waitForTimeout(60);
      check('undo: the second press calls layouts.undo again', (await calls(page, 'layouts.undo')).length === 4);

      // the fade: a plain result goes after ~2.6 s and tells main
      await page.evaluate(() => { window.__calls.length = 0; window.__emit('layouts.toast', { text: 'Saved Work: 3 windows (Code, Quartz)' }); });
      await page.mouse.move(2, 2);
      await page.waitForTimeout(3200);
      check('layouts: fades by itself and tells main (layouts.faded)', await page.isHidden('#t') && (await calls(page, 'layouts.faded')).length === 1);
      await page.close();

      const bare = await ctx.newPage();
      await bare.goto(url('ui/layouts/index.html'));
      const bt = await onScreen(bare);
      check('layouts: without Mantle the pop-up says so, in plain words', /could not connect to Mantle: restart Mantle/.test(bt) && !JARGON.test(bt), bt);
      await bare.close();
    }

    /* ================= ui/ontop ================= */
    {
      const page = await ctx.newPage();
      await page.addInitScript(FAKE);
      await page.goto(url('ui/ontop/index.html'));
      await page.evaluate(() => window.__emit('ontop.toast', { text: 'Kept on top: Calculator', reason: null, hint: 'Win+Ctrl+T again to stop', tone: '', did: 'pinned' }));
      check('ontop: "Kept on top: X" with the way to stop', (await page.textContent('#text')) === 'Kept on top: Calculator' && (await page.textContent('#why')) === 'Win+Ctrl+T again to stop' &&
        await page.$eval('#why', (e) => e.classList.contains('hint')));
      check('ontop: the pin glyph has no strike while pinned', await page.$eval('.strike', (e) => getComputedStyle(e).display === 'none'));
      await shot(page, 'ontop-pinned.png');
      await page.evaluate(() => window.__emit('ontop.toast', { text: 'Can’t keep Task Manager on top', reason: 'Task Manager runs as administrator, so Windows doesn’t let Mantle keep it on top', tone: 'warn', did: 'refused' }));
      check('ontop: a refusal shows its reason as a warn line (not the quiet hint)', /runs as administrator/.test(await page.textContent('#why')) &&
        !(await page.$eval('#why', (e) => e.classList.contains('hint'))) && (await page.getAttribute('#t', 'data-tone')) === 'warn');
      check('ontop: no jargon on screen', !JARGON.test(await onScreen(page)), await onScreen(page));
      await shot(page, 'ontop-refused.png');
      await page.evaluate(() => window.__emit('ontop.toast', { text: 'No longer on top: Calculator', tone: '', did: 'unpinned' }));
      check('ontop: un-pinned: struck glyph, no second line', await page.$eval('.strike', (e) => getComputedStyle(e).display !== 'none') && (await page.textContent('#why')) === '');
      await shot(page, 'ontop-unpinned.png');
      await page.evaluate(() => { window.__calls.length = 0; });
      await page.waitForTimeout(2400);
      check('ontop: fades by itself and tells main (ontop.faded)', await page.isHidden('#t') && (await calls(page, 'ontop.faded')).length === 1);
      await page.close();
      const bare = await ctx.newPage();
      await bare.goto(url('ui/ontop/index.html'));
      const bt = await onScreen(bare);
      check('ontop: without Mantle the pop-up says so, in plain words', /could not connect to Mantle/.test(bt) && !JARGON.test(bt), bt);
      await bare.close();
    }

    /* ================= ui/bar/ontop.js ================= */
    {
      const page = await ctx.newPage();
      await page.addInitScript(FAKE);
      await page.goto('about:blank');
      await page.setContent('<div class="cell" id="a"></div><div class="cell" id="b"></div>');
      await page.addScriptTag({ path: path.join(ROOT, 'ui', 'bar', 'ontop.js') });
      await page.evaluate(() => {
        const a = document.getElementById('a'), b = document.getElementById('b');
        a._tip = 'Calculator'; b._tip = 'Notepad';
        window.MantleOnTop.paint(a, [{ hwnd: 5 }]); window.MantleOnTop.paint(b, [{ hwnd: 6 }, { hwnd: 7 }]);
        window.__emit('ontop.state', { pinned: [{ hwnd: '7', name: 'Notepad' }] });
      });
      const st = await page.evaluate(() => ({ aBadge: !!document.querySelector('#a .ontop-badge'), bBadge: !!document.querySelector('#b .ontop-badge'),
        aTitle: document.getElementById('a').title, bTitle: document.getElementById('b').title, p7: window.MantleOnTop.isPinned(7), p5: window.MantleOnTop.isPinned('5') }));
      check('bar: the app owning a pinned window gets the badge, the other not', st.bBadge && !st.aBadge && st.p7 && !st.p5, st);
      check('bar: its tooltip says so, with the way to stop (shortcut shown)', st.bTitle === 'Notepad\nKept on top · right-click or Win+Ctrl+T to stop' && st.aTitle === 'Calculator', st);
      await page.evaluate(() => { window.__emit('ontop.state', { pinned: [] }); window.__emit('ontop.state', { pinned: [] }); });
      const st2 = await page.evaluate(() => ({ badges: document.querySelectorAll('.ontop-badge').length, bTitle: document.getElementById('b').title }));
      check('bar: un-pinned -> badge gone, tooltip back (twice in a row is fine)', st2.badges === 0 && st2.bTitle === 'Notepad', st2);
      await page.close();
      const bare = await ctx.newPage();
      await bare.goto('about:blank');
      await bare.setContent('<div class="cell" id="a"></div>');
      await bare.addScriptTag({ path: path.join(ROOT, 'ui', 'bar', 'ontop.js') });
      const e = await bare.evaluate(() => { const a = document.getElementById('a'); a._tip = 'Calculator'; window.MantleOnTop.paint(a, [{ hwnd: 1 }]); return { err: window.MantleOnTop.error(), title: a.title }; });
      check('bar: without Mantle the tooltip says so in plain words', /can’t show which windows are kept on top/.test(e.title) && !JARGON.test(e.title) && !JARGON.test(e.err || ''), e);
      await bare.close();
    }
  } finally {
    await browser.close();
  }
}

main().then(() => {
  console.log(`POPUPS PAGE TEST: ${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log('  FAIL ' + f);
  process.exit(failures.length ? 1 : 0);
}, (err) => {
  console.log(`POPUPS PAGE TEST: crashed: ${err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : err}`);
  process.exit(1);
});
