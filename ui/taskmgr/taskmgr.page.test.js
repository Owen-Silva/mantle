require('C:/Users/user/dev-tools/tools/lowcpu.js');
/* taskmgr.page.test.js — the task manager's PAGE, clicked and typed through (lane sysmon, 2026-09-29).
 *
 * Headless chromium over file:// (never Electron, never a real process): the REAL page files
 * (index.html + taskmgr.js + taskmgr.css) on ui/taskmgr/mock-mantle.js, whose apps and numbers are MADE
 * UP. Every check drives the page the way Owen would (click, right-click, double-click, keys) and
 * reads what the page asked Mantle to do (window.__mockCalls) and what it shows.
 *
 *   node ui/taskmgr/taskmgr.page.test.js         (run it through the lane's uislot.sh)
 * Prints "TASKMGR PAGE TEST: n passed, m failed". A game running = skipped (and said).
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const CHROME_BASE = 'C:/Users/user/AppData/Local/ms-playwright';
const PAGE = 'file:///' + path.join(__dirname, 'index.html').replace(/\\/g, '/');
let passed = 0;
const failures = [];
const check = (name, ok, detail) => { if (ok) passed++; else failures.push(detail !== undefined ? `${name} (${String(detail).slice(0, 300)})` : name); return ok; };

function findChrome() {
  for (const d of fs.readdirSync(CHROME_BASE).filter((n) => n.startsWith('chromium-')).sort().reverse())
    for (const sub of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe']) { const p = path.join(CHROME_BASE, d, sub); if (fs.existsSync(p)) return p; }
  return null;
}
function gaming() {
  try { return parseInt(execSync('powershell -NoProfile -Command "@(Get-Process VALORANT*,javaw,Minecraft*,RobloxPlayerBeta -ErrorAction SilentlyContinue).Count"', { encoding: 'utf8' }).trim(), 10) || 0; } catch (_) { return -1; }
}

(async () => {
  if (gaming() > 0) { console.log('TASKMGR PAGE TEST: skipped (a game is running)'); process.exit(0); }
  const { chromium } = require('C:/Users/user/other-app/node_modules/playwright-core');
  const browser = await chromium.launch({ executablePath: findChrome(), headless: true });
  const errors = [];
  async function open(mock, w, h) {
    const page = await browser.newPage({ viewport: { width: w || 780, height: h || 640 } });
    page.on('pageerror', (e) => errors.push(`${mock}: ${e.message}`));
    await page.goto(`${PAGE}?mock=${mock}`);
    await page.waitForFunction(() => document.documentElement.dataset.shot === '1', null, { timeout: 6000 });
    return page;
  }
  const calls = (page, name) => page.evaluate((n) => window.__mockCalls.filter((c) => c.name === n), name);
  const names = (page, sel) => page.$$eval(sel || '#list .sbox:not([hidden]) .row .n', (els) => els.map((e) => e.textContent));
  try {
    /* ---------------------------------------------------------------- the list, the stats, sort */
    let p = await open('apps');
    check('stats: machine CPU shown', (await p.textContent('#cpuv')) === '23%', await p.textContent('#cpuv'));
    check('stats: memory as a percentage and in GB', (await p.textContent('#memv')) === '66%' && (await p.textContent('#ramtext')) === '5.4 GB available of 16.0 GB' && /10\.6 GB of 16\.0 GB in use · 5\.4 GB available/.test(await p.getAttribute('#s-mem', 'title')), await p.textContent('#ramtext'));
    check('stats: both lines are drawn', (await p.getAttribute('#cpuspark .line', 'd')).length > 50 && (await p.getAttribute('#memspark .line', 'd')).length > 50);
    check('Mantle\'s own use is said once, quietly', /^Mantle uses 273 MB$/.test(await p.textContent('#mantleuse')));
    let n0 = await names(p);
    check('sort: memory, biggest first, by default', n0[0] === 'Google Chrome' && n0.indexOf('Visual Studio Code') < n0.indexOf('Discord'), n0.slice(0, 5).join(','));
    check('sort: the Memory header says it is the sort', (await p.getAttribute('[data-sort="mem"]', 'aria-sort')) === 'descending');
    await p.click('[data-sort="name"]');
    n0 = await names(p, '#list .sbox[data-s="apps"] .row .n');
    check('sort: Name sorts A to Z', n0.join(',') === ['Discord', 'Google Chrome', 'Mantle', 'Notepad', 'Steam', 'Visual Studio Code'].join(','), n0.join(','));
    await p.click('[data-sort="name"]');
    n0 = await names(p, '#list .sbox[data-s="apps"] .row .n');
    check('sort: Name again sorts Z to A', n0[0] === 'Visual Studio Code' && (await p.getAttribute('[data-sort="name"]', 'aria-sort')) === 'descending', n0.join(','));
    await p.click('[data-sort="cpu"]');
    n0 = await names(p, '#list .sbox[data-s="apps"] .row .n');
    check('sort: CPU, busiest first', n0[0] === 'Google Chrome' && n0[1] === 'Visual Studio Code', n0.join(','));
    await p.click('[data-sort="mem"]');

    /* ---------------------------------------------------------------- one action per row */
    const op = (sel) => p.$eval(sel, (e) => getComputedStyle(e).opacity);
    const chrome = '#list .row:has(.n:text-is("Google Chrome"))';
    const chromeKey = await p.$eval('#list .row .n', (e) => e.closest('.row').dataset.key);
    const rowSel = `#list [data-key="${chromeKey}"]`;
    check('rows: ONE visible action (Close) and a More button, no Trim/Force buttons on the row', (await p.$$eval(`${rowSel} .acts button`, (bs) => bs.map((b) => b.dataset.act).join(','))) === 'close,menu');
    await p.mouse.move(5, 5);
    await p.waitForTimeout(200);
    check('rows: the action hides when the row is neither hovered nor chosen', (await op(`${rowSel} .acts`)) === '0');
    await p.hover(rowSel + ' .nm');
    await p.waitForTimeout(250);
    check('rows: ...and shows on hover', (await op(`${rowSel} .acts`)) === '1');
    void chrome;

    /* ---------------------------------------------------------------- choose + keys */
    await p.click(rowSel + ' .mem');
    check('click a row: it is chosen (wash + tick) and the list has focus', await p.$eval(rowSel, (e) => e.classList.contains('sel')) && await p.evaluate(() => document.activeElement.id === 'list'));
    await p.keyboard.press('ArrowDown');
    const second = await p.$eval('#list .row.sel .n', (e) => e.textContent);
    check('ArrowDown: the next row is chosen', second === 'Visual Studio Code', second);
    await p.keyboard.press('Home');
    check('Home: the first row', (await p.$eval('#list .row.sel .n', (e) => e.textContent)) === 'Google Chrome');
    await p.keyboard.press('Delete');
    await p.keyboard.press('Delete');     // a second press while the first is on its way
    await p.waitForTimeout(250);
    let acts = await calls(p, 'taskmgr.act');
    check('Delete: Close for the chosen row, and ONE request for two quick presses', acts.length === 1 && acts[0].args.action === 'close' && acts[0].args.key === chromeKey, JSON.stringify(acts));
    await p.keyboard.press('Shift+Delete');
    check('Shift+Delete: asks before Force close, with Cancel focused (Enter cannot force by accident)', await p.isVisible(`${rowSel} .st.ask`) && await p.evaluate(() => document.activeElement.dataset.act === 'force-no'));
    await p.keyboard.press('Escape');
    check('Esc: the question goes away, nothing forced', !(await p.$(`${rowSel} .st.ask`)) && (await calls(p, 'taskmgr.act')).length === 1);
    await p.focus('#list');
    await p.keyboard.press('Shift+Delete');
    await p.click(`${rowSel} [data-act="force-yes"]`);
    await p.waitForTimeout(250);
    acts = await calls(p, 'taskmgr.act');
    check('Force close after the question: sent once, confirmed', acts.length === 2 && acts[1].args.action === 'force' && acts[1].args.confirmed === true, JSON.stringify(acts[1]));
    await p.focus('#list');
    await p.keyboard.press('Enter');
    await p.waitForTimeout(80);
    let ex = await calls(p, 'taskmgr.expand');
    check('Enter: shows its processes (asks main for them)', ex.length === 1 && ex[0].args.open === true && ex[0].args.key === chromeKey && await p.isVisible(`${rowSel} .members .mrow`));
    await p.keyboard.press('ArrowLeft');
    ex = await calls(p, 'taskmgr.expand');
    check('Left: hides them again', ex.length === 2 && ex[1].args.open === false && !(await p.$(`${rowSel} .members`)));
    await p.dblclick(rowSel + ' .mem');
    check('double-click a row: shows its processes', (await calls(p, 'taskmgr.expand')).length === 3 && await p.isVisible(`${rowSel} .members`));
    await p.dblclick(rowSel + ' .mem');

    /* ---------------------------------------------------------------- the row menu */
    await p.hover(rowSel + ' .nm');
    await p.click(`${rowSel} [data-act="menu"]`);
    let items = await p.$$eval('#menu [role="menuitem"]', (bs) => bs.map((b) => b.textContent));
    check('row menu: every action with its key', items.join('|') === 'CloseDelete|Force close…Shift+Delete|Trim memory|Show its 21 processesEnter|Open file location', items.join('|'));
    check('row menu: the first item has focus, the button says it is open', await p.evaluate(() => document.activeElement.closest('#menu') !== null) && (await p.getAttribute(`${rowSel} [data-act="menu"]`, 'aria-expanded')) === 'true');
    await p.keyboard.press('ArrowDown');
    check('row menu: arrows move through it', (await p.evaluate(() => document.activeElement.textContent)) === 'Force close…Shift+Delete');
    await p.keyboard.press('Escape');
    check('row menu: Esc closes it and gives focus back to its button', await p.isHidden('#menu') && await p.evaluate(() => document.activeElement.dataset.act === 'menu'));
    await p.click(`${rowSel} [data-act="menu"]`);
    await p.mouse.click(400, 20);
    check('row menu: a click outside closes it', await p.isHidden('#menu'));
    await p.click(`${rowSel} [data-act="menu"]`);
    await p.click('#menu [role="menuitem"]:has-text("Open file location")');
    await p.waitForTimeout(60);
    const rv = await calls(p, 'taskmgr.reveal');
    check('Open file location: asked by row key only', rv.length === 1 && rv[0].args.key === chromeKey && Object.keys(rv[0].args).join() === 'key', JSON.stringify(rv));
    check('Open file location: its answer is on the window', /File Explorer was not opened/.test(await p.textContent('#note')));
    await p.click(`${rowSel} [data-act="menu"]`);
    await p.click('#menu [role="menuitem"]:has-text("Trim memory")');
    await p.waitForTimeout(250);
    acts = await calls(p, 'taskmgr.act');
    check('Trim memory from the menu', acts[acts.length - 1].args.action === 'trim' && acts[acts.length - 1].args.key === chromeKey);
    const dk = await p.$eval('#list .row .n:text-is("Discord")', (e) => e.closest('.row').dataset.key).catch(() => null);
    const discord = `#list [data-key="${dk}"]`;
    await p.click(discord + ' .mem', { button: 'right' });
    items = await p.$$eval('#menu [role="menuitem"]', (bs) => bs.map((b) => b.textContent));
    check('right-click a row: the same menu, for THAT row (chosen too)', /Show its 6 processes/.test(items.join('|')) && await p.$eval(discord, (e) => e.classList.contains('sel')), items.join('|'));
    const box = await p.$eval('#menu', (e) => { const r = e.getBoundingClientRect(); return { r: r.right, b: r.bottom }; });
    check('right-click menu: fully inside the window', box.r <= 780 && box.b <= 640, JSON.stringify(box));
    await p.keyboard.press('Escape');

    /* ---------------------------------------------------------------- protected rows */
    await p.click('.sect[data-s="windows"] [data-act="section"]');
    const lk = await p.$eval('#list .row .n:text-is("Lively Wallpaper")', (e) => e.closest('.row').dataset.key);
    const lively = `#list [data-key="${lk}"]`;
    check('a protected row offers no Close and says why', (await p.$$(`${lively} [data-act="close"]`)).length === 0 && /never closes it/.test(await p.textContent(lively)));
    await p.click(lively + ' .mem');
    await p.keyboard.press('Delete');
    await p.waitForTimeout(80);
    check('Delete on a protected row: nothing sent, the reason on the window', (await calls(p, 'taskmgr.act')).length === acts.length && /Lively Wallpaper can't be closed/.test(await p.textContent('#note')), await p.textContent('#note'));
    check('sections: Windows processes opened from its header', await p.isVisible('.sbox[data-s="windows"] .row'));

    /* ---------------------------------------------------------------- search */
    await p.keyboard.press('Control+f');
    check('Ctrl+F: the search box', await p.evaluate(() => document.activeElement.id === 'q'));
    await p.keyboard.type('disc');
    let shown = await names(p);
    check('search: only what matches, across sections', shown.join(',') === 'Discord', shown.join(','));
    check('search: sections with no match are hidden', await p.isHidden('.sect[data-s="windows"]') && await p.isVisible('.sect[data-s="apps"]'));
    await p.keyboard.press('Escape');
    shown = await names(p);
    check('search: Esc clears it, every row back', shown.length > 8 && (await p.inputValue('#q')) === '', shown.length);
    await p.fill('#q', 'svchost');
    shown = await names(p);
    check('search: by file name too (every svchost), even in a closed section', shown.length === 3 && shown.every((s) => /Service Host/.test(s)), shown.join(','));
    await p.fill('#q', 'made-up tab');
    check('search: by window title', (await names(p)).join() === 'Google Chrome');
    await p.fill('#q', 'zzz');
    check('search: nothing matches -> says so, with a way out', /No running app matches “zzz”/.test(await p.textContent('#liststate')) && await p.isVisible('#liststate [data-act="clearq"]'));
    await p.click('#liststate [data-act="clearq"]');
    check('search: Clear search brings the list back', (await names(p)).length > 8 && await p.isHidden('#liststate'), JSON.stringify({ n: (await names(p)).length, q: await p.inputValue('#q'), ls: await p.isHidden('#liststate') }));
    await p.focus('#list');
    await p.evaluate(() => { document.querySelectorAll('#list .row.sel').forEach(() => {}); });
    await p.keyboard.press('Home');
    await p.keyboard.type('st');
    check('typing on the list searches it', (await p.inputValue('#q')) === 'st' && (await names(p)).includes('Steam'), await p.inputValue('#q'));
    await p.keyboard.press('ArrowDown');
    check('ArrowDown from the search: into the list, first match chosen', await p.evaluate(() => document.activeElement.id === 'list') && (await p.$$('#list .row.sel')).length === 1);
    await p.fill('#q', '');

    /* ---------------------------------------------------------------- More */
    await p.click('#more');
    items = await p.$$eval('#menu [role="menuitem"]', (bs) => bs.map((b) => b.textContent));
    check('More: Startup apps and Windows Task Manager', items.join('|') === 'Startup apps|Windows Task Manager', items.join('|'));
    await p.click('#menu [role="menuitem"]:has-text("Startup apps")');
    await p.waitForTimeout(60);
    check('Startup apps: opens Mantle Settings at Startup apps', (await calls(p, 'settings.open')).some((c) => c.args.section === 'apps' && c.args.row === 'apps.startup'));
    check('Startup apps: a failure is said on the window, in plain words', /Mantle Settings did not open/.test(await p.textContent('#note')));
    await p.click('#more');
    await p.click('#more');
    check('More: a second click closes it', await p.isHidden('#menu'));
    await p.click('#more');
    await p.click('#menu [role="menuitem"]:has-text("Windows Task Manager")');
    await p.waitForTimeout(60);
    check('Windows Task Manager: asked of Mantle', (await calls(p, 'taskmgr.windowsTaskManager')).length === 1);

    /* ---------------------------------------------------------------- words */
    const text = await p.evaluate(() => document.body.innerText + ' ' + Array.from(document.querySelectorAll('[title],[aria-label]')).map((e) => (e.title || '') + ' ' + (e.getAttribute('aria-label') || '')).join(' '));
    const bad = text.match(/sidecar|hwnd|undefined|NaN|\[object|\bnull\b|EmptyWorkingSet|dryRun|IPC/gi);
    check('words: no jargon or broken values anywhere on the Apps view (tooltips included)', !bad, bad && bad.join(','));
    await p.close();

    /* ---------------------------------------------------------------- not responding */
    p = await open('hung');
    const hk = await p.$eval('#list .row .n:text-is("Notepad")', (e) => e.closest('.row').dataset.key);
    const np = `#list [data-key="${hk}"]`;
    check('not responding: said on the row', /Not responding/.test(await p.textContent(np)));
    check('not responding: Force close offered straight away (Close cannot reach it), visible without hover', (await p.$$eval(`${np} .acts button`, (bs) => bs.map((b) => b.dataset.act).join(','))) === 'force,menu' && (await p.$eval(`${np} .acts`, (e) => getComputedStyle(e).opacity)) === '1');
    await p.click(np + ' .mem');
    await p.keyboard.press('Delete');
    check('not responding: Delete asks to Force close', await p.isVisible(`${np} .st.ask`));
    await p.close();

    /* ---------------------------------------------------------------- game view */
    p = await open('game');
    check('game view: its tab is on', await p.$eval('.tab[data-view="game"]', (e) => e.classList.contains('on')));
    await p.click('#prep .prow:has-text("Steam") input[data-act="tick"]');
    await p.waitForTimeout(60);
    check('tick an app: saved by its identity', (await calls(p, 'taskmgr.tick')).some((c) => c.args.on === true && /steam/.test(c.args.identity)));
    await p.click('#auto');
    check('the game-start option: saved', (await calls(p, 'taskmgr.auto')).some((c) => c.args.on === true));
    await p.click('#free');
    await p.waitForTimeout(60);
    check('Free up RAM: asked of Mantle once', (await calls(p, 'taskmgr.free')).length === 1);
    await p.click('.tab[data-view="apps"]');
    check('tabs: back to Apps', await p.isVisible('#v-apps') && await p.isHidden('#v-game'));
    await p.close();

    /* ---------------------------------------------------------------- states */
    p = await open('loading');
    check('loading: the list says it is reading, no empty sections', /Reading running apps/.test(await p.textContent('#liststate')) && (await p.$$('#list .sect')).length === 0);
    await p.close();
    p = await open('error');
    check('could not read: the reason is in the list, in plain words, once', /could not read the list of running apps/.test(await p.textContent('#liststate')) && await p.isHidden('#note'));
    await p.close();
    p = await open('apps', 560, 420);
    check('smallest window: no sideways scroll', await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    const cut = await p.$eval('#list .row .n', (e) => e.scrollWidth <= e.clientWidth + 1 || getComputedStyle(e).textOverflow === 'ellipsis');
    check('smallest window: long names ellipsize', cut);
    await p.close();
    p = await open('apps');
    await p.emulateMedia({ reducedMotion: 'reduce' });
    check('reduced motion: no transitions', (await p.$eval('#list .row .acts', (e) => getComputedStyle(e).transitionDuration)) === '0s');
    await p.close();
  } catch (e) {
    check('no exception', false, e.stack);
  } finally { await browser.close(); }
  for (const e of errors) check('no page error', false, e);
  for (const f of failures) console.log('  FAIL ' + f);
  console.log(`TASKMGR PAGE TEST: ${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();
