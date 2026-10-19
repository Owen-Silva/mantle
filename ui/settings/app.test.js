require('../../tools/dev-env.js').lowcpu();
/* app.test.js — Mantle Settings as a person drives it: the whole app with every REAL category file, on
 * the mock (lane settings, 2026-09-29 quality pass). Headless chromium over file://, never Electron,
 * never a real setting: mock-mantle.js ?real=1 lists the eleven real section files and answers each
 * category's own reads with a made-up failure, so every page is ALSO proven to show a designed error
 * state (never blank, never jargon). Each category's data is played by its own page test.
 *
 * Clicks and keys through the real page code:
 *   - the sidebar: Home, the eleven categories in Windows 11's order, then Mantle; each opens;
 *   - every page of every category opens without a page error, draws something, and a failed read
 *     says why in plain words (no "sidecar", "dryRun", "0x...", "undefined" on screen);
 *   - back / forward: the arrow at the top left, Alt+Left / Alt+Right, the mouse's back/forward
 *     buttons, the scroll position coming back, the arrow disabled with nowhere to go;
 *   - search: Ctrl+F, typing anywhere starts a search, arrows + Enter open a hit and highlight its row,
 *     Esc clears, a hit can be gone back from;
 *   - deep links: main's settings.nav { row } lands on the row's page (and Back returns);
 *   - the failing and no-bridge mocks: words a person understands, with what to do next.
 *
 *   node ui/settings/app.test.js          Prints "SETTINGS APP TEST: n passed, m failed".
 * A game running = skipped (and said). Shots of failures go to MANTLE_SHOOT_OUT.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const PAGE = 'file:///' + path.resolve(__dirname, 'index.html').replace(/\\/g, '/');
const OUT = process.env.MANTLE_SHOOT_OUT || path.join(require('os').tmpdir(), 'mantle-settings-app-shots');
const SECS = ['system', 'devices', 'internet', 'personalization', 'applist', 'accounts', 'time', 'gaming', 'accessibility', 'privacy', 'update'];
const JARGON = /\b(sidecar|dry ?run|dryRun|hwnd|renderer|aumid|undefined|NaN|hresult|enoent|eacces)\b|\[object|window\.mantle|0x[0-9a-f]{6,8}\b|HK(CU|LM)\\|"[a-z]+\.[a-zA-Z]+"/i;

let passed = 0;
const failures = [];
const check = (name, ok, detail) => { if (ok) passed++; else failures.push(detail ? `${name} (${String(detail).slice(0, 300)})` : name); return ok; };

function gaming() {
  try {
    const n = execSync('powershell -NoProfile -Command "@(Get-Process javaw,Minecraft*,RobloxPlayerBeta,VALORANT* -ErrorAction SilentlyContinue).Count"', { encoding: 'utf8' });
    return parseInt(n.trim(), 10) || 0;
  } catch (_) { return -1; }
}

async function open(ctx, query) {
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') page.errors.push('console: ' + m.text()); });
  await page.goto(PAGE + query, { waitUntil: 'load' });
  await page.waitForSelector('html[data-ready="1"]', { timeout: 8000 });
  return page;
}
const where = (p) => p.evaluate(() => {
  const cur = document.querySelector('.nav-i[aria-current="page"]');
  const h1 = document.querySelector('#page h1');
  return { nav: cur ? cur.dataset.section : null, title: h1 ? h1.textContent.trim() : null, back: document.getElementById('backbtn').disabled, scroll: document.getElementById('scroller').scrollTop };
});
const settle = (p, ms) => p.waitForTimeout(ms || 250);

(async () => {
  const g = gaming();
  if (g !== 0) { process.stdout.write((g > 0 ? 'a game is running' : 'could not check for a running game') + ': page test skipped\nSETTINGS APP TEST: 0 passed, 0 failed (skipped)\n'); return; }
  const { chromium } = require('../../tools/dev-env.js').playwright();
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await require('./test-browser.js').launch(chromium);
  const ctx = await browser.newContext({ viewport: { width: 1040, height: 700 }, deviceScaleFactor: 1, colorScheme: 'light' });
  try {
    /* ---- the sidebar ---- */
    let p = await open(ctx, '?real=1&section=home');
    const navIds = await p.$$eval('.nav-i', (els) => els.map((e) => e.dataset.section));
    check('sidebar: Home, the eleven categories in order, then Mantle', JSON.stringify(navIds) === JSON.stringify(['home'].concat(SECS, ['mantle', 'shortcuts', 'about'])), navIds.join(' '));
    check('sidebar: no Windows category has a warning dot (Mantle may: the mock has a made-up key clash)', (await p.$$('.nav-i:not([data-section="mantle"]) .ndot')).length === 0);
    check('back: disabled on the first page', (await where(p)).back === true);

    /* ---- every category and every page opens, draws, and says why in words ---- */
    const pages = await p.evaluate(() => {
      const out = [];
      // the model the page itself built (settings.js keeps it private): rebuilt from the loaded files
      const S = window.SettingsSections, M = window.SettingsModel;
      return out.concat(Array.from(document.querySelectorAll('.nav-i')).map((b) => b.dataset.section));
    });
    check('the page lists sections', pages.length > 11);
    const blank = [], jar = [], errs = [], counts = [];
    for (const sec of SECS) {
      await p.click(`.nav-i[data-section="${sec}"]`);
      await settle(p, 200);
      const cards = await p.$$eval('#page [data-act="nav"][data-page]', (els) => els.map((e) => e.dataset.page));
      counts.push(sec + ':' + cards.length);
      if (!cards.length) { blank.push(sec + ' overview lists no pages'); continue; }
      for (const pg of cards) {
        p.errors.length = 0;
        await p.click(`.nav-i[data-section="${sec}"]`);
        await settle(p, 120);
        await p.click(`#page [data-act="nav"][data-page="${pg}"]`);
        await settle(p, 450);
        const st = await p.evaluate((src) => {
          const el = document.getElementById('page');
          const txt = el.innerText.trim();
          const m = txt.match(new RegExp(src, 'i'));
          return { len: txt.length, rows: el.querySelectorAll('.row, .why').length, jargon: m ? txt.slice(Math.max(0, m.index - 50), m.index + 50).replace(/\s+/g, ' ') : null };
        }, JARGON.source);
        if (st.len < 20 || st.rows === 0) blank.push(sec + '/' + pg);
        if (st.jargon) jar.push(sec + '/' + pg + ': "' + st.jargon + '"');
        if (p.errors.length) errs.push(sec + '/' + pg + ': ' + p.errors[0].slice(0, 120));
      }
    }
    process.stdout.write('  (pages per category: ' + counts.join(' ') + ')\n');
    check('every page of every category draws something when its reads fail', blank.length === 0, blank.join('; '));
    check('no page shows jargon when its reads fail', jar.length === 0, jar.join(' | '));
    check('no page throws', errs.length === 0, errs.join(' | '));
    await p.close();

    /* ---- back / forward ---- */
    p = await open(ctx, '?real=1&section=home');
    await p.click('.nav-i[data-section="system"]'); await settle(p);
    await p.click('.nav-i[data-section="time"]'); await settle(p);
    await p.click('#page [data-act="nav"][data-page]'); await settle(p, 400);
    const deep = await where(p);
    check('back: enabled after moving', deep.back === false);
    await p.click('#backbtn'); await settle(p, 300);
    let w = await where(p);
    check('back (arrow): Time overview again', w.nav === 'time' && !(await p.$('#page [data-crumb]')) && (await p.$$('#page [data-act="nav"][data-page]')).length > 0, JSON.stringify(w));
    await p.keyboard.press('Alt+ArrowLeft'); await settle(p);
    w = await where(p);
    check('back (Alt+Left): System', w.nav === 'system', JSON.stringify(w));
    await p.keyboard.press('Alt+ArrowRight'); await settle(p);
    check('forward (Alt+Right): Time', (await where(p)).nav === 'time');
    await p.mouse.move(600, 300);
    await p.mouse.down({ button: 'back' }).catch(() => {}); await p.mouse.up({ button: 'back' }).catch(() => {});
    await p.evaluate(() => document.dispatchEvent(new MouseEvent('mouseup', { button: 3, bubbles: true })));
    await settle(p);
    check('back (mouse back button): System', (await where(p)).nav === 'system', JSON.stringify(await where(p)));
    await p.evaluate(() => document.dispatchEvent(new MouseEvent('mouseup', { button: 4, bubbles: true })));
    await settle(p);
    check('forward (mouse forward button): Time', (await where(p)).nav === 'time');
    // going somewhere new drops the forward entries
    await p.click('.nav-i[data-section="gaming"]'); await settle(p);
    await p.keyboard.press('Alt+ArrowRight'); await settle(p);
    check('forward: nothing after a new place', (await where(p)).nav === 'gaming');
    // back all the way: Home, then the arrow is disabled and Back does nothing
    for (let i = 0; i < 6; i++) { await p.keyboard.press('Alt+ArrowLeft'); await settle(p, 120); }
    w = await where(p);
    check('back: all the way to Home, then disabled', w.nav === 'home' && w.back === true, JSON.stringify(w));
    // the scroll position comes back
    await p.click('.nav-i[data-section="mantle"]'); await settle(p, 300);
    await p.evaluate(() => { document.getElementById('scroller').scrollTop = 300; });
    const y = await p.evaluate(() => document.getElementById('scroller').scrollTop);
    await p.click('.nav-i[data-section="about"]'); await settle(p);
    await p.click('#backbtn'); await settle(p, 400);
    w = await where(p);
    check('back: the scroll position comes back', w.nav === 'mantle' && y > 50 && Math.abs(w.scroll - y) < 4, 'was ' + y + ', now ' + w.scroll);

    /* ---- search ---- */
    await p.keyboard.press('Control+f');
    check('search: Ctrl+F focuses the box', await p.evaluate(() => document.activeElement && document.activeElement.id === 'find'));
    await p.evaluate(() => document.activeElement.blur());
    await p.keyboard.type('night light', { delay: 15 }); await settle(p, 300);
    check('search: typing anywhere searches', await p.evaluate(() => document.getElementById('find').value === 'night light'));
    const first = await p.$eval('#page [data-act="result"], #page .res', (e) => e.textContent).catch(() => '');
    check('search: Night light is the first hit', /night light/i.test(first), first);
    await p.keyboard.press('Enter'); await settle(p, 600);
    w = await where(p);
    const flashed = await p.evaluate(() => !!document.querySelector('#page [data-row].flash, #page [data-row="display.nightlight"]'));
    check('search: Enter opens the hit on its page', w.nav === 'system' && flashed, JSON.stringify(w));
    await p.click('#backbtn'); await settle(p, 300);
    check('search: Back from a hit returns', (await where(p)).nav === 'mantle');
    // Back while results show closes the search (the arrow is live even with nowhere else to go)
    await p.evaluate(() => document.activeElement && document.activeElement.blur());
    await p.keyboard.type('mouse', { delay: 10 }); await settle(p, 250);
    const sb = await p.evaluate(() => document.getElementById('backbtn').disabled);
    await p.click('#backbtn'); await settle(p, 250);
    w = await where(p);
    check('search: Back over results closes the search and keeps the page', sb === false && w.nav === 'mantle' &&
      await p.evaluate(() => document.getElementById('find').value === ''), JSON.stringify(w) + ' arrow disabled=' + sb);
    await p.click('#find'); await p.keyboard.type('zzqqxx', { delay: 10 }); await settle(p);
    const none = await p.$eval('#page', (e) => e.innerText);
    check('search: no hits says so in words', /no setting|nothing|no results|not found/i.test(none), none.slice(0, 120));
    await p.keyboard.press('Escape'); await settle(p);
    check('search: Esc clears', await p.evaluate(() => document.getElementById('find').value === ''));

    /* ---- deep link from main ---- */
    await p.evaluate(() => window.__mockEmit('settings.nav', { row: 'display.brightness' })); await settle(p, 600);
    w = await where(p);
    check('deep link: a row from main lands in its category', w.nav === 'system', JSON.stringify(w));
    await p.keyboard.press('Alt+ArrowLeft'); await settle(p);
    check('deep link: Back returns to where you were', (await where(p)).nav === 'mantle', JSON.stringify(await where(p)));
    check('no page errors while driving', p.errors.length === 0, p.errors.join(' | '));
    await p.close();

    /* ---- the failing and no-bridge mocks ---- */
    for (const [q, name] of [['?real=1&section=home&mock=failing', 'failing'], ['?real=1&section=home&mock=nobridge', 'no bridge']]) {
      p = await open(ctx, q);
      const txt = await p.evaluate(() => document.body.innerText);
      const m = txt.match(JARGON);
      check(name + ': no jargon on screen', !m, m ? txt.slice(Math.max(0, m.index - 60), m.index + 60).replace(/\s+/g, ' ') : '');
      check(name + ': it says what is wrong', /could not|not connected|can't|cannot|try again|restart/i.test(txt), txt.slice(0, 200));
      if (!m) await p.screenshot({ path: path.join(OUT, 'app-' + name.replace(' ', '') + '.png') });
      await p.close();
    }
  } catch (e) {
    check('the run finished', false, e.stack || e.message);
  } finally {
    await browser.close();
  }
  process.stdout.write(`SETTINGS APP TEST: ${passed} passed, ${failures.length} failed\n`);
  failures.forEach((f) => process.stdout.write('  FAIL ' + f + '\n'));
  process.exitCode = failures.length ? 1 : 0;
})();
