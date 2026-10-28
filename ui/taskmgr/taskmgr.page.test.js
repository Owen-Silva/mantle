/* taskmgr.page.test.js - the task manager's SHELL and Mantle's own pages (Get ready to game, Settings), clicked
 * and typed through on the mock (ui/taskmgr/testkit.js: headless Chromium over file://, never Electron, never
 * a real process). Each Windows page has its own test: ui/taskmgr/pages/<id>.page.test.js.
 *   node ui/taskmgr/taskmgr.page.test.js     ->  "TASKMGR PAGE TEST: n passed, m failed"
 */
'use strict';
const kit = require('./testkit.js');

kit.run('TASKMGR PAGE TEST', async (t) => {
  const { check, calls } = t;
  const PAGES = ['processes', 'performance', 'apphistory', 'startup', 'users', 'details', 'services', 'game', 'settings'];
  for (const theme of ['light', 'dark']) {
    const p = await t.open('view=processes', { theme });
    const T = `[${theme}] `;
    /* ---- the frame: title bar, nav, command bar ---- */
    check(T + 'title bar: icon, name, the search in the middle, window buttons', await p.isVisible('.title .appic') && (await p.textContent('.appname')) === 'Task Manager' &&
      (await p.getAttribute('#q', 'placeholder')) === 'Type a name, publisher, or PID to search' && (await p.$$('.wc [data-op]')).length === 3);
    const mid = await p.$eval('.search', (e) => { const r = e.getBoundingClientRect(); return Math.abs(r.left + r.width / 2 - innerWidth / 2); });
    check(T + 'the search box is centred on the window', mid <= 2, mid);
    const navs = await p.$$eval('.nav', (bs) => bs.map((b) => b.dataset.view + ':' + b.textContent.trim()));
    check(T + 'nav: every Windows page, Get ready to game, Settings last', navs.join('|') === 'processes:Processes|performance:Performance|apphistory:App history|startup:Startup apps|users:Users|details:Details|services:Services|game:Get ready to game|settings:Settings', navs.join('|'));
    check(T + 'nav: Settings sits at the bottom of the rail', await p.$eval('#navfoot .nav', (e) => e.dataset.view === 'settings'));
    check(T + 'the open page is marked', await p.$eval('.nav[data-view="processes"]', (e) => e.classList.contains('on') && e.getAttribute('aria-selected') === 'true'));
    check(T + 'command bar starts with Run new task', (await p.$eval('#cmdbar [data-ci="0"]', (e) => e.textContent.trim())) === 'Run new task');
    for (const id of PAGES) {
      await p.click(`.nav[data-view="${id}"]`);
      await p.waitForTimeout(80);
      const ok = await p.evaluate((x) => !document.getElementById('pg-' + x).hidden && document.querySelectorAll('.page:not([hidden])').length === 1 && document.getElementById('app').dataset.view === x, id);
      check(`${T}nav: ${id} shows its page and only it`, ok);
      check(`${T}${id}: Run new task is first in its command bar`, (await p.$eval('#cmdbar [data-ci="0"]', (e) => e.getAttribute('aria-label'))) === 'Run new task');
    }
    const views = (await calls(p, 'taskmgr.view')).map((c) => c.args.view);
    check(T + 'nav: main is told each page (view command)', PAGES.every((id) => views.includes(id)), views.join(','));
    check(T + 'page titles', (await p.textContent('#ptitle')) === 'Settings');
    /* ---- keys ---- */
    await p.click('.nav[data-view="processes"]');
    await p.keyboard.press('Control+Tab');
    check(T + 'Ctrl+Tab: the next page', await p.evaluate(() => document.getElementById('app').dataset.view === 'performance'));
    await p.keyboard.press('Control+Shift+Tab');
    await p.keyboard.press('Control+Shift+Tab');
    check(T + 'Ctrl+Shift+Tab: back, and round from the first to the last', await p.evaluate(() => document.getElementById('app').dataset.view === 'settings'));
    check(T + 'search is off on pages without a list (Settings)', await p.$eval('#q', (e) => e.disabled));
    await p.click('.nav[data-view="performance"]');
    check(T + 'search is off on Performance', await p.$eval('#q', (e) => e.disabled));
    await p.click('.nav[data-view="processes"]');
    await p.keyboard.press('Control+f');
    check(T + 'Ctrl+F: the search box', await p.evaluate(() => document.activeElement.id === 'q'));
    await p.keyboard.type('disc');
    const shown = await p.$$eval('#pg-processes .trow:not(.child) .n', (es) => es.map((e) => e.textContent));
    check(T + 'search filters the page', shown.join(',') === 'Discord', shown.join(','));
    await p.keyboard.press('Escape');
    check(T + 'Esc clears the search', (await p.inputValue('#q')) === '' && (await p.$$('#pg-processes .trow')).length > 8);
    await t.clearCalls(p);
    await p.keyboard.press('F5');
    await p.waitForTimeout(50);
    check(T + 'F5: refresh now (sample)', (await calls(p, 'taskmgr.sample')).length === 1);
    for (const op of ['min', 'max', 'close']) await p.click(`.wc [data-op="${op}"]`);
    check(T + 'window buttons ask main (win)', (await calls(p, 'taskmgr.win')).map((c) => c.args.op).join(',') === 'min,max,close');
    /* ---- Run new task ---- */
    await p.click('#cmdbar [data-ci="0"]');
    await p.waitForSelector('.dlg.runtask');
    check(T + 'Run new task: Windows\' dialog (Open, Browse..., admin box, OK, Cancel)', (await p.textContent('#dlgt')) === 'Create new task' && await p.isVisible('#rt-cmd') && await p.isVisible('#rt-admin') &&
      (await p.$$eval('.dfoot button', (bs) => bs.map((b) => b.textContent).sort().join('|'))) === 'Browse...|Cancel|OK');
    check(T + 'Run new task: the box has focus', await p.evaluate(() => document.activeElement.id === 'rt-cmd'));
    check(T + 'Run new task: OK waits for something to run', await p.$eval('.dfoot [data-b="ok"]', (b) => b.disabled));
    await p.click('.dfoot [data-b="browse"]');
    await p.waitForTimeout(150);
    check(T + 'Browse...: the picked file goes in the box (quoted: it has spaces)', (await p.inputValue('#rt-cmd')) === '"C:\\Program Files\\Made Up\\tool.exe"', await p.inputValue('#rt-cmd'));
    await p.fill('#rt-cmd', 'notepad');
    await p.check('#rt-admin');
    await p.keyboard.press('Enter');
    await p.waitForSelector('.dlg', { state: 'detached' });
    const rt = await calls(p, 'taskmgr.runTask');
    check(T + 'Run new task: sent with the admin choice; Enter = OK', rt.length === 1 && rt[0].args.cmd === 'notepad' && rt[0].args.admin === true, JSON.stringify(rt));
    check(T + 'Run new task: the dry run is said on the window', /was not run/.test(await p.textContent('#note')));
    await p.click('#cmdbar [data-ci="0"]');
    await p.waitForSelector('.dlg.runtask');
    check(T + 'Run new task: remembers what was run (history)', (await p.inputValue('#rt-cmd')) === 'notepad' && !(await p.$eval('#rt-hist', (b) => b.disabled)));
    await p.keyboard.press('Escape');
    check(T + 'Run new task: Esc cancels, nothing sent', !(await p.$('.dlg')) && (await calls(p, 'taskmgr.runTask')).length === 1);
    await t.close(p);
  }

  /* ---- failures are never silent ---- */
  let p = await t.open('view=processes&admin=runTask');
  await p.click('#cmdbar [data-ci="0"]');
  await p.fill('#rt-cmd', 'regedit');
  await p.click('.dfoot [data-b="ok"]');
  await p.waitForSelector('.rt-why:not([hidden])');
  check('needsAdmin: the reason and "Set up administrator access" in the dialog', /administrator rights/.test(await p.textContent('.rt-why')) && await p.isVisible('.rt-why [data-tmact="elevated-setup"]'));
  await p.click('.rt-why [data-tmact="elevated-setup"]');
  await p.waitForTimeout(150);
  check('Set up administrator access: asks main once (elevatedSetup)', (await calls(p, 'taskmgr.elevatedSetup')).length === 1);
  await p.keyboard.press('Escape');
  await t.close(p);
  p = await t.open('view=processes&admin=runTask&elev=ok');
  await p.click('#cmdbar [data-ci="0"]');
  await p.fill('#rt-cmd', 'regedit');
  await p.click('.dfoot [data-b="ok"]');
  await p.waitForSelector('.rt-why:not([hidden])');
  check('needsAdmin with the helper set up: the reason, no setup button', !(await p.$('.rt-why [data-tmact="elevated-setup"]')));
  await t.close(p);
  p = await t.open('view=processes&missing=runTask');
  await p.click('#cmdbar [data-ci="0"]');
  await p.fill('#rt-cmd', 'x');
  await p.click('.dfoot [data-b="ok"]');
  await p.waitForSelector('.rt-why:not([hidden])');
  check('a command main does not have yet: said in plain words', /can't do that yet/.test(await p.textContent('.rt-why')), await p.textContent('.rt-why'));
  await t.close(p);
  p = await t.open('view=details&old=1');
  await p.waitForTimeout(200);
  check('an old main (no Details data): the page says so, with a way out', /doesn't read this page yet/.test(await p.textContent('#pg-details')) && await p.isVisible('#pg-details [data-tmact="wintm"]'), await p.textContent('#pg-details'));
  await p.click('#pg-details [data-tmact="wintm"]');
  check('...Open Windows Task Manager asks main', (await calls(p, 'taskmgr.windowsTaskManager')).length === 1);
  await t.close(p);
  /* a write on a Windows / critical process: main's needsConfirm carries Windows' words; the page asks, then resends confirmed */
  p = await t.open('view=processes');
  const dwm = await p.$eval('#pg-processes .trow:has(.n:text-is("Desktop Window Manager"))', (e) => e.dataset.key);
  await p.click(`#pg-processes .trow[data-key="${dwm}"] .c.num >> nth=0`);
  await p.keyboard.press('Delete');
  await p.waitForSelector('.dlg.confirm');
  check('needsConfirm: Windows\' question in Windows\' words', (await p.textContent('#dlgt')) === 'Do you want to end Desktop Window Manager?' && /system instability/.test(await p.textContent('.dlg .dbody')) && (await p.textContent('.dfoot [data-b="ok"]')) === 'End process');
  check('needsConfirm: Cancel has the focus (Enter cannot end it by accident)', await p.evaluate(() => document.activeElement.dataset.b === 'cancel'));
  let acts = await calls(p, 'taskmgr.act');
  check('needsConfirm: the first ask was not confirmed', acts.length === 1 && !acts[0].args.confirmed, JSON.stringify(acts));
  await p.click('.dfoot [data-b="ok"]');
  await p.waitForTimeout(250);
  acts = await calls(p, 'taskmgr.act');
  check('needsConfirm: after the answer the same command goes again, confirmed', acts.length === 2 && acts[1].args.confirmed === true && acts[1].args.key === dwm && acts[1].args.action === 'close', JSON.stringify(acts));
  await p.keyboard.press('Delete');
  await p.waitForSelector('.dlg.confirm');
  await p.keyboard.press('Escape');
  await p.waitForTimeout(100);
  check('needsConfirm: Esc = cancel, nothing resent, nothing said', (await calls(p, 'taskmgr.act')).length === 3 && !(await p.isVisible('#note')));
  await t.close(p);
  p = await t.open('view=processes&test=1&paused=1');
  const nt = await p.textContent('#note');
  check('test Mantle and paused updates are said on the window', /Test Mantle/.test(nt) && /Updates are paused/.test(nt), nt);
  await t.close(p);

  /* ---- the rail: narrow windows ---- */
  p = await t.open('view=processes', { w: 760, h: 560 });
  check('narrow: the rail is icons only', (await p.getAttribute('#app', 'data-rail')) === 'closed' && await p.$eval('.rail', (e) => e.getBoundingClientRect().width <= 52));
  await p.click('#ham');
  check('narrow: the hamburger opens it over the page', (await p.getAttribute('#app', 'data-rail')) === 'overlay' && await p.isVisible('.nav[data-view="details"] span'));
  await p.click('.nav[data-view="details"]');
  check('narrow: choosing a page closes it again', (await p.getAttribute('#app', 'data-rail')) === 'closed');
  await t.close(p);
  p = await t.open('view=processes');
  await p.click('#ham');
  check('wide: the hamburger folds the rail to icons and remembers it', (await p.getAttribute('#app', 'data-rail')) === 'closed' && (await p.evaluate(() => localStorage.getItem('taskmgr.rail'))) === '"closed"');
  await p.click('#ham');
  await t.close(p);
  for (const id of PAGES) {
    p = await t.open(`view=${id}${id === 'game' ? '&mock=game' : ''}`, { w: 560, h: 420 });
    check(`smallest window (${id}): no sideways scroll, no page error while drawing`, await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth && !(window.__tmErrors || []).length));
    await t.close(p);
  }

  /* ---- Get ready to game ---- */
  p = await t.open('mock=game&view=game');
  check('game: its page is on', await p.isVisible('#pg-game') && (await p.textContent('#ptitle')) === 'Get ready to game');
  check('game: Free up RAM is the page\'s command, with the ticked total beside the title', /Free up RAM/.test(await p.textContent('#cmdbar')) && /ticked/.test(await p.textContent('#pextra')));
  await p.click('#prep [data-key$="steam.exe"] [data-act="tick"], #prep .prow:has(.n:text-is("Steam")) [data-act="tick"]');
  await p.waitForTimeout(80);
  check('tick an app: saved by its identity', (await calls(p, 'taskmgr.tick')).some((c) => c.args.on === true && /steam/.test(c.args.identity)));
  await p.click('#prep .prow:has(.n:text-is("Discord")) [data-act="reopen"]');
  await p.waitForTimeout(80);
  check('Reopen it: saved', (await calls(p, 'taskmgr.tick')).some((c) => c.args.reopen === false && /Discord/.test(c.args.identity)));
  await p.click('#auto');
  await p.waitForTimeout(80);
  check('the game-start option: saved', (await calls(p, 'taskmgr.auto')).some((c) => c.args.on === true));
  check('what the last game start did: said, failures with their reason', /When VALORANT started/.test(await p.textContent('#lastfree')) && /Discord: Its window closed/.test(await p.textContent('#lastfree')));
  check('a locked app says why', /never closes it/.test(await p.textContent('#prep')));
  check('an absent ticked app still shows (so the tick can come off)', /Not running now/.test(await p.textContent('#prep')));
  await p.click('#cmdbar button:has-text("Free up RAM")');
  await p.waitForTimeout(150);
  check('Free up RAM: asked of Mantle once', (await calls(p, 'taskmgr.free')).length === 1);
  await t.close(p);
  p = await t.open('mock=game&view=game&fail=free');
  await p.click('#cmdbar button:has-text("Free up RAM")');
  await p.waitForTimeout(150);
  check('Free up RAM refused: the reason on the window', /Made-up failure for free/.test(await p.textContent('#note')));
  await t.close(p);

  /* ---- Settings ---- */
  p = await t.open('view=settings');
  const rows = await p.$$eval('#pg-settings .setrow .sett', (es) => es.map((e) => e.textContent));
  check('settings: every Windows setting', rows.join('|') === 'App theme|Default start page|Real time update speed|Always on top|Minimize on use|Hide when minimized|Show full account name|Show history for all processes|Ask me before applying Efficiency mode', rows.join('|'));
  await p.selectOption('#set-updateSpeed', 'low');
  await p.click('#set-alwaysOnTop');
  await p.selectOption('#set-startPage', 'details');
  await p.waitForTimeout(150);
  const st = (await calls(p, 'taskmgr.setting')).map((c) => `${c.args.key}=${c.args.value}`);
  check('settings: each change is sent (setting {key, value})', st.join(',') === 'updateSpeed=low,alwaysOnTop=true,startPage=details', st.join(','));
  check('settings: the model echo is shown', (await p.inputValue('#set-updateSpeed')) === 'low' && await p.isChecked('#set-alwaysOnTop'));
  await t.close(p);
  p = await t.open('view=settings&fail=setting');
  await p.click('#set-hideWhenMinimized');
  await p.waitForTimeout(150);
  check('settings: a refused change says why on its row and the switch goes back', /Made-up failure/.test(await p.textContent('[data-row="hideWhenMinimized"]')) && !(await p.isChecked('#set-hideWhenMinimized')));
  await t.close(p);
  p = await t.open('view=settings&old=1');
  check('settings: an old main says it keeps none yet (controls off)', /doesn't keep Task Manager settings yet/.test(await p.textContent('#pg-settings')) && await p.$eval('#set-theme', (e) => e.disabled));
  await t.close(p);

  /* ---- motion ---- */
  p = await t.open('view=processes', { reducedMotion: true });
  await p.click('#cmdbar [data-ci="0"]');
  check('reduced motion: the dialog does not slide', (await p.$eval('.dlg', (e) => getComputedStyle(e).animationName)) !== 'menuin');
  await t.close(p);
});
