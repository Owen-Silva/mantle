/* processes.page.test.js - the Processes page clicked and typed through, on the MOCK (made-up apps; every
 * command lands in window.__mockCalls, never on Windows). node ui/taskmgr/pages/processes.page.test.js
 * Verdict line: "TASKMGR PROCESSES PAGE TEST: n passed, m failed".
 * Mock keys (mock-mantle.js order): Chrome 1040|1 (21 processes), Discord 1080|1, Code 1120|1, Steam 1160|1,
 * Notepad 1200|1, Spotify 1240|1, Lively 1280|1, OneDrive 1320|1 (efficiency), G HUB 1360|1, vgtray 1400|1
 * (suspended), dwm 1440|1, Windows Explorer 1480|1, Audio 1520|1, Network 1560|1, Diagnostic 1600|1, Mantle 1640|1.
 */
'use strict';
const kit = require('../testkit.js');

const R = (k) => `#pg-processes .trow[data-key="${k}"]`;
const CHROME = '1040|1', DISCORD = '1080|1', NOTEPAD = '1200|1', ONEDRIVE = '1320|1', VG = '1400|1', EXPLORER = '1480|1', AUDIO = '1520|1', STEAM = '1160|1';

kit.run('TASKMGR PROCESSES PAGE TEST', async (t) => {
  const settle = (p, ms) => p.waitForTimeout(ms || 220);
  const heads = (p) => p.$$eval('#pg-processes .thead .h .hl > span', (els) => els.map((e) => e.textContent));
  const groupNames = (p, g) => p.evaluate((g) => {
    const out = []; let on = false;
    for (const el of document.querySelectorAll('#pg-processes .tlist .tin > *')) {
      if (el.classList.contains('tgroup')) { on = el.textContent.startsWith(g); continue; }
      if (on && !el.classList.contains('child')) out.push(el.querySelector('.c.name .n').textContent);
    }
    return out;
  }, g);
  const cell = (p, key, col) => p.evaluate(([key, col]) => {
    const row = document.querySelector(`#pg-processes .trow[data-key="${key}"]`);
    const hs = Array.from(document.querySelectorAll('#pg-processes .thead .h')).map((h) => h.dataset.col);
    const c = row && row.querySelector('.tr').children[hs.indexOf(col)];
    return c ? { text: c.textContent, title: c.getAttribute('title') || '', html: c.innerHTML } : null;
  }, [key, col]);
  const menuLabels = (p, depth) => p.evaluate((d) => { const m = document.querySelectorAll('#menus .menu')[d || 0]; return m ? Array.from(m.children).map((b) => (b.classList.contains('msep') ? '|' : b.querySelector('span').textContent)) : null; }, depth);
  const menuItem = (p, depth, label) => p.evaluate(([d, l]) => { const m = document.querySelectorAll('#menus .menu')[d]; const b = m && Array.from(m.querySelectorAll('button[data-i]')).find((x) => x.querySelector('span').textContent === l); return b ? { disabled: b.disabled, checked: b.getAttribute('aria-checked'), title: b.title } : null; }, [depth, label]);
  /* click through a menu path: pick(p, 'Resource values', 'Memory', 'Percents') */
  const pick = async (p, ...path) => {
    const r = await p.evaluate(async (path) => {
      for (let d = 0; d < path.length; d++) {
        const m = document.querySelectorAll('#menus .menu')[d];
        const b = m && Array.from(m.querySelectorAll('button[data-i]')).find((x) => x.querySelector('span').textContent === path[d]);
        if (!b) return `no "${path[d]}" at depth ${d}`;
        if (b.disabled) return `"${path[d]}" is disabled`;
        b.click();
        await new Promise((res) => setTimeout(res, 40));
      }
      return 'ok';
    }, path);
    await settle(p);
    return r;
  };
  const rowMenu = async (p, key) => { await p.click(`${R(key)} .c.name .n`, { button: 'right' }); await p.waitForSelector('#menus .menu'); };
  const view = async (p, ...path) => { await p.click('#cmdbar button[aria-label="View"]'); await p.waitForSelector('#menus .menu'); return pick(p, ...path); };
  const calls = async (p, name) => (await t.calls(p, 'taskmgr.' + name)).map((c) => c.args);
  const subText = (p, key) => p.evaluate((k) => { const s = document.querySelector(`#pg-processes .trow[data-key="${k}"] > .tsub`); return s && !s.hidden ? s.textContent : ''; }, key);
  const selKey = (p) => p.evaluate(() => (document.querySelector('#pg-processes .trow.sel') || {}).dataset?.key || null);
  const press = async (p, k) => { await p.keyboard.press(k); await settle(p, 120); };
  const noShellErrors = async (p, what) => { const e = await t.shellErrors(p); t.check(`${what}: the page drew without throwing`, !e.length, e.join(' | ')); };

  /* ================================================================ layout, groups, columns, totals, sort */
  let p = await t.open('view=processes', { theme: 'light' });
  t.check('three groups with Windows\' names and counts', (await p.$$eval('#pg-processes .tgroup .gt', (e) => e.map((x) => x.textContent))).join('|') === 'Apps (6)|Background processes (5)|Windows processes (5)',
    (await p.$$eval('#pg-processes .tgroup .gt', (e) => e.map((x) => x.textContent))).join('|'));
  t.check('default columns: Name, Status, CPU, Memory, Disk, Network', (await heads(p)).join(',') === 'Name,Status,CPU,Memory,Disk,Network', (await heads(p)).join(','));
  const tots = await p.$$eval('#pg-processes .thead .tv', (e) => e.map((x) => x.textContent));
  t.check('totals over the numeric headers (model.totals)', tots.join(',') === '23%,66%,3%,1%', tots.join(','));
  t.check('default sort: Name A to Z inside each group', (await groupNames(p, 'Apps')).join(',') === 'Discord,Google Chrome,Mantle,Notepad,Steam,Visual Studio Code', (await groupNames(p, 'Apps')).join(','));
  t.check('numbers: CPU, Memory, Disk, Network in Windows\' units', ['6.2%', '1,843.0 MB', '1.6 MB/s', '3.3 Mbps'].join() === [(await cell(p, CHROME, 'cpu')).text, (await cell(p, CHROME, 'mem')).text, (await cell(p, CHROME, 'disk')).text, (await cell(p, CHROME, 'net')).text].join(),
    [(await cell(p, CHROME, 'cpu')).text, (await cell(p, CHROME, 'mem')).text, (await cell(p, CHROME, 'disk')).text, (await cell(p, CHROME, 'net')).text].join());
  t.check('numbers are right-aligned and tabular', await p.evaluate(() => { const c = document.querySelector('#pg-processes .trow .c.num'); const s = getComputedStyle(c); return s.justifyContent === 'flex-end' && /tabular-nums/.test(s.fontVariantNumeric); }));
  t.check('rows are 32 px (Windows density)', (await p.evaluate(() => document.querySelector('#pg-processes .trow .tr').getBoundingClientRect().height)) === 32);
  t.check('heat: the busiest cells are shaded', await p.evaluate((k) => /\bh[1-5]\b/.test(document.querySelector(`#pg-processes .trow[data-key="${k}"] .tr`).children[2].className), CHROME));
  await p.click('#pg-processes .thead .h[data-col="cpu"]'); await settle(p);
  let apps = await groupNames(p, 'Apps');
  t.check('sort: CPU, busiest first', apps[0] === 'Google Chrome' && apps[1] === 'Visual Studio Code' && (await p.getAttribute('#pg-processes .h[data-col="cpu"]', 'aria-sort')) === 'descending', apps.join(','));
  await p.click('#pg-processes .thead .h[data-col="cpu"]'); await settle(p);
  apps = await groupNames(p, 'Apps');
  t.check('sort: CPU again, quietest first', apps[apps.length - 1] === 'Google Chrome' && (await p.getAttribute('#pg-processes .h[data-col="cpu"]', 'aria-sort')) === 'ascending', apps.join(','));
  await p.click('#pg-processes .thead .h[data-col="name"]'); await settle(p);

  /* status icons + Status values */
  t.check('Efficiency mode: a leaf in Status (words in the tooltip)', !!(await p.$(`${R(ONEDRIVE)} .pst.eff svg`)) && /Efficiency mode/.test(await p.getAttribute(`${R(ONEDRIVE)} .pst.eff`, 'title')));
  t.check('Suspended: a pause icon in Status', !!(await p.$(`${R(VG)} .pst.sus svg`)));
  t.check('View > Status values: Windows\' three items', (await view(p, 'Status values')) === 'ok' && (await menuLabels(p, 1)).join(',') === 'Show suspended status,Show efficiency mode status,Hide status', String(await menuLabels(p, 1)));
  await p.keyboard.press('Escape');
  await view(p, 'Status values', 'Hide status');
  t.check('Hide status: no suspended or efficiency icons', !(await p.$(`${R(ONEDRIVE)} .pst`)) && !(await p.$(`${R(VG)} .pst`)));
  await view(p, 'Status values', 'Show suspended status');
  t.check('Show suspended status: the pause icon only', !!(await p.$(`${R(VG)} .pst.sus`)) && !(await p.$(`${R(ONEDRIVE)} .pst`)));
  await view(p, 'Status values', 'Show efficiency mode status');
  t.check('Show efficiency mode status: both again', !!(await p.$(`${R(VG)} .pst.sus`)) && !!(await p.$(`${R(ONEDRIVE)} .pst.eff`)));

  /* Resource values */
  await view(p, 'Resource values', 'Memory', 'Percents');
  t.check('Resource values > Memory > Percents: % of RAM', (await cell(p, CHROME, 'mem')).text === '11%', (await cell(p, CHROME, 'mem')).text);
  await view(p, 'Resource values', 'Disk', 'Percents');
  const dp = await cell(p, CHROME, 'disk');
  t.check('Disk > Percents: an em dash with the reason (not computable honestly)', dp.text === '—' && /percent/i.test(dp.title), JSON.stringify(dp));
  await view(p, 'Resource values', 'Network', 'Percents');
  t.check('Network > Percents: an em dash with the reason', (await cell(p, CHROME, 'net')).text === '—' && /link speed/i.test((await cell(p, CHROME, 'net')).title));
  await view(p, 'Resource values', 'Memory');
  t.check('the Percents radio shows as chosen', ((await menuItem(p, 2, 'Percents')) || {}).checked === 'true');
  await p.keyboard.press('Escape'); await p.keyboard.press('Escape');
  for (const k of ['Memory', 'Disk', 'Network']) await view(p, 'Resource values', k, 'Values');
  t.check('Values again: MB', (await cell(p, CHROME, 'mem')).text === '1,843.0 MB');

  /* Group by type */
  await view(p, 'Group by type');
  t.check('Group by type off: one list, no group headers', !(await p.$('#pg-processes .tgroup')) && (await p.$$('#pg-processes .trow')).length === 16);
  await view(p, 'Group by type');
  t.check('Group by type on again', (await p.$$('#pg-processes .tgroup')).length === 3);

  /* expand / collapse (the expand command), Expand all, Collapse all */
  await t.clearCalls(p);
  await p.click(`${R(CHROME)} .chev`); await settle(p, 300);
  let ex = await calls(p, 'expand');
  t.check('expand: the chevron asks main for its processes', ex.length === 1 && ex[0].key === CHROME && ex[0].open === true, JSON.stringify(ex));
  t.check('expand: its 21 processes under it', (await p.$$(`#pg-processes .trow.child[data-key^="${CHROME}>p"]`)).length >= 21);
  t.check('a process that owns a window expands to it', !!(await p.$(`${R(CHROME + '>p1040')}.exp`)));
  await p.click(`${R(CHROME + '>p1040')} .chev`); await settle(p);
  t.check('the window row: its title under the process', ((await p.textContent(`${R(CHROME + '>p1040>w1040')} .n`)) || '') === 'Made-up tab - Google Chrome');
  await p.click(`${R(CHROME)} .chev`); await settle(p, 300);
  ex = await calls(p, 'expand');
  t.check('collapse: main is told (open:false)', ex.length === 2 && ex[1].open === false, JSON.stringify(ex));
  await t.clearCalls(p);
  await view(p, 'Expand all');
  ex = await calls(p, 'expand');
  t.check('Expand all: every app of several processes asked open', ex.length >= 8 && ex.every((x) => x.open === true), JSON.stringify(ex.map((x) => x.key)));
  await view(p, 'Collapse all');
  ex = await calls(p, 'expand');
  t.check('Collapse all: each told closed', ex.filter((x) => x.open === false).length === ex.filter((x) => x.open === true).length && !(await p.$('#pg-processes .trow.child')), JSON.stringify(ex.length));

  /* ================================================================ the row menu, every item (dry run) */
  await rowMenu(p, DISCORD);
  const want = 'Expand,Switch to,End task,|,Resource values,|,Efficiency mode,Create memory dump file,|,Go to details,Open file location,Search online,Properties,|,Trim memory';
  t.check('row menu: Windows\' items in Windows\' order, then Trim memory', (await menuLabels(p)).join(',') === want, (await menuLabels(p)).join(','));
  await t.clearCalls(p);
  await pick(p, 'End task');
  let a = await calls(p, 'act');
  t.check('End task: act close on its key', a.length === 1 && a[0].action === 'close' && a[0].key === DISCORD, JSON.stringify(a));
  await settle(p, 300);
  t.check('End task: the outcome on the row', /Test Mantle|nothing was done/i.test(await subText(p, DISCORD)), await subText(p, DISCORD));
  await rowMenu(p, DISCORD); await pick(p, 'Switch to');
  t.check('Switch to: switchTo {key}', (await calls(p, 'switchTo')).some((x) => x.key === DISCORD));
  await rowMenu(p, DISCORD); await pick(p, 'Expand');
  t.check('Expand from the menu', (await calls(p, 'expand')).some((x) => x.key === DISCORD && x.open));
  await rowMenu(p, DISCORD);
  t.check('…and the menu now says Collapse', (await menuLabels(p))[0] === 'Collapse');
  await pick(p, 'Collapse');
  await rowMenu(p, DISCORD); await pick(p, 'Resource values', 'Memory', 'Percents');
  t.check('Resource values from the row menu', (await cell(p, DISCORD, 'mem')).text === '2.5%', (await cell(p, DISCORD, 'mem')).text);
  await rowMenu(p, DISCORD); await pick(p, 'Resource values', 'Memory', 'Values');
  await rowMenu(p, DISCORD); await pick(p, 'Efficiency mode');
  await p.waitForSelector('.dlg');
  t.check('Efficiency mode: Windows\' question first', /Turn on Efficiency mode/.test(await p.textContent('.dlg')));
  await p.click('.dlg .dfoot [data-b="ok"]'); await settle(p, 300);
  let e1 = await calls(p, 'efficiency');
  t.check('Efficiency mode: efficiency {key, pid, on:true}', e1.length === 1 && e1[0].key === DISCORD && e1[0].pid === 1080 && e1[0].on === true, JSON.stringify(e1));
  await rowMenu(p, DISCORD); await pick(p, 'Create memory dump file');
  await p.waitForSelector('.dlg.dump .dpath', { timeout: 3000 }).catch(() => {});
  t.check('Create memory dump file: dump {pid}, then where the file went', (await calls(p, 'dump')).some((x) => x.pid === 1080) && /made-up-1080\.DMP/.test(await p.textContent('.dlg')), await p.textContent('.dlg').catch(() => 'no dialog'));
  await p.click('.dlg .dfoot [data-b="ok"]'); await settle(p);
  await rowMenu(p, DISCORD); await pick(p, 'Open file location');
  t.check('Open file location: reveal {key}', (await calls(p, 'reveal')).some((x) => x.key === DISCORD));
  await rowMenu(p, DISCORD); await pick(p, 'Search online');
  t.check('Search online: searchOnline {name}', (await calls(p, 'searchOnline')).some((x) => x.name === 'Discord.exe'), JSON.stringify(await calls(p, 'searchOnline')));
  await rowMenu(p, DISCORD); await pick(p, 'Properties');
  t.check('Properties: properties {path}', (await calls(p, 'properties')).some((x) => /Discord\.exe$/.test(x.path)));
  await rowMenu(p, DISCORD); await pick(p, 'Trim memory');
  t.check('Trim memory: act trim', (await calls(p, 'act')).some((x) => x.action === 'trim' && x.key === DISCORD));
  await rowMenu(p, DISCORD); await pick(p, 'Go to details');
  t.check('Go to details: the Details page, asked with its PID', (await p.evaluate(() => TM.view)) === 'details' && (await calls(p, 'view')).some((x) => x.view === 'details'));
  await p.click('.nav[data-view="processes"]'); await settle(p, 300);

  /* a child process and Windows Explorer */
  await p.click(`${R(CHROME)} .chev`); await settle(p, 300);
  await rowMenu(p, CHROME + '>p1041');
  t.check('a child process: no Trim memory, no Switch to', !(await menuLabels(p)).includes('Trim memory') && !(await menuLabels(p)).includes('Switch to'), (await menuLabels(p)).join(','));
  await t.clearCalls(p);
  await pick(p, 'End task');
  t.check('End task on one process: endPid {pid}', (await calls(p, 'endPid')).some((x) => x.pid === 1041));
  await p.click(`${R(CHROME)} .chev`); await settle(p, 300);
  await rowMenu(p, EXPLORER);
  const exm = await menuLabels(p);
  t.check('Windows Explorer: Restart and End task in its menu', exm.includes('Restart') && exm.includes('End task') && exm.indexOf('Restart') < exm.indexOf('End task'), exm.join(','));
  await pick(p, 'Restart');
  t.check('Restart: restartExplorer', (await calls(p, 'restartExplorer')).length === 1);
  await p.click(`${R(EXPLORER)} .c.name .n`); await settle(p);
  t.check('command bar: Restart replaces End task for Windows Explorer', !!(await p.$('#cmdbar button[aria-label="Restart"]')) && !(await p.$('#cmdbar button[aria-label="End task"]')));
  await p.click('#cmdbar button[aria-label="Restart"]'); await settle(p, 300);
  t.check('command bar Restart: restartExplorer again', (await calls(p, 'restartExplorer')).length === 2);
  t.check('Efficiency mode greyed for a Windows process, with the reason', await p.evaluate(() => { const b = document.querySelector('#cmdbar button[aria-label="Efficiency mode"]'); return b.disabled && /Windows/.test(b.title); }));

  /* ================================================================ command bar */
  await p.click(`${R(STEAM)} .c.name .n`); await settle(p);
  await t.clearCalls(p);
  await p.click('#cmdbar button[aria-label="End task"]'); await settle(p, 300);
  t.check('command bar End task: act close on the chosen row', (await calls(p, 'act')).some((x) => x.action === 'close' && x.key === STEAM));
  await p.click('#cmdbar button[aria-label="Efficiency mode"]'); await p.waitForSelector('.dlg');
  await p.click('.dlg .dfoot [data-b="ok"]'); await settle(p, 300);
  t.check('command bar Efficiency mode: efficiency on', (await calls(p, 'efficiency')).some((x) => x.key === STEAM && x.on === true));
  t.check('command bar: no Force close', !(await p.$('#cmdbar button[aria-label="Force close"]')));
  t.check('View menu: Windows\' items', (await view(p)) === 'ok' && (await menuLabels(p)).join(',') === 'Group by type,Expand all,Collapse all,|,Status values,Resource values', String(await menuLabels(p)));
  await p.keyboard.press('Escape');

  /* ================================================================ header column chooser + persistence */
  await p.click('#pg-processes .thead .h[data-col="cpu"]', { button: 'right' }); await p.waitForSelector('#menus .menu');
  const hm = await menuLabels(p);
  t.check('header menu: Windows\' list (no Name), then Resource values', hm.join(',') === 'Type,Status,Publisher,PID,Process name,Command line,CPU,Memory,Disk,Network,GPU,GPU engine,Power usage,Power usage trend,|,Resource values', hm.join(','));
  await pick(p, 'Publisher');
  await p.click('#pg-processes .thead .h[data-col="cpu"]', { button: 'right' }); await pick(p, 'PID');
  await p.click('#pg-processes .thead .h[data-col="cpu"]', { button: 'right' }); await pick(p, 'Status');
  t.check('chooser adds Publisher + PID, removes Status', (await heads(p)).join(',') === 'Name,Publisher,PID,CPU,Memory,Disk,Network', (await heads(p)).join(','));
  t.check('PID of one process; an app of several has none', (await cell(p, NOTEPAD, 'pid')).text === '1200' && (await cell(p, CHROME, 'pid')).text === '');
  await p.reload(); await p.waitForFunction(() => document.documentElement.dataset.shot === '1'); await settle(p);
  t.check('column choice persisted across a reload', (await heads(p)).join(',') === 'Name,Publisher,PID,CPU,Memory,Disk,Network', (await heads(p)).join(','));
  await p.click('#pg-processes .thead .h[data-col="cpu"]', { button: 'right' }); await pick(p, 'Resource values', 'Memory', 'Percents');
  t.check('header menu > Resource values works', /%$/.test((await cell(p, CHROME, 'mem')).text));
  await p.evaluate(() => { localStorage.clear(); }); await p.reload(); await p.waitForFunction(() => document.documentElement.dataset.shot === '1'); await settle(p);

  /* ================================================================ keyboard */
  await p.focus('#pg-processes .tlist');
  await press(p, 'ArrowDown');
  t.check('Down: the first row', (await selKey(p)) === DISCORD, await selKey(p));
  await press(p, 'ArrowDown');
  t.check('Down again: the next row', (await selKey(p)) === CHROME, await selKey(p));
  await press(p, 'ArrowUp');
  t.check('Up', (await selKey(p)) === DISCORD);
  await press(p, 'End');
  t.check('End: the last row', (await selKey(p)) === (await p.evaluate(() => { const r = document.querySelectorAll('#pg-processes .trow'); return r[r.length - 1].dataset.key; })));
  await press(p, 'Home');
  t.check('Home: the first row', (await selKey(p)) === DISCORD);
  await press(p, 'PageDown');
  t.check('PageDown moves a page', (await p.evaluate(() => window.__procPage.t.order.indexOf(window.__procPage.t.sel))) > 3);
  await press(p, 'PageUp');
  t.check('PageUp back', (await selKey(p)) === DISCORD);
  await press(p, 'ArrowDown');
  await t.clearCalls(p);
  await press(p, 'Enter');
  t.check('Enter expands (expand open)', (await calls(p, 'expand')).some((x) => x.key === CHROME && x.open));
  await press(p, 'ArrowLeft');
  t.check('Left collapses', (await calls(p, 'expand')).some((x) => x.key === CHROME && !x.open) && !(await p.$(`${R(CHROME)}.open`)));
  await press(p, 'ArrowRight');
  t.check('Right expands', !!(await p.$(`${R(CHROME)}.open`)));
  await press(p, 'ArrowLeft');
  await press(p, 'ArrowUp');
  await t.clearCalls(p);
  await press(p, 'Delete');
  t.check('Delete = End task', (await calls(p, 'act')).some((x) => x.action === 'close' && x.key === DISCORD));
  await t.clearCalls(p);
  await press(p, 'Alt+e');
  t.check('Alt+E = End task', (await calls(p, 'act')).some((x) => x.action === 'close' && x.key === DISCORD));
  await press(p, 'Shift+F10');
  t.check('Shift+F10 opens the row menu', (await menuLabels(p) || [])[0] === 'Expand' || (await menuLabels(p) || []).includes('End task'));
  await p.keyboard.press('Escape'); await settle(p);
  await p.focus('#pg-processes .tlist');
  await press(p, 'ContextMenu');
  t.check('the menu key opens the row menu', !!(await menuLabels(p)));
  await p.keyboard.press('Escape'); await settle(p);
  await p.focus('#pg-processes .tlist');
  await press(p, 'v');
  t.check('type-ahead: "v" chooses Visual Studio Code', (await p.evaluate(() => window.__procPage.t.selected().name)) === 'Visual Studio Code');
  await press(p, 'Control+f');
  t.check('Ctrl+F: the search box', (await p.evaluate(() => document.activeElement.id)) === 'q');

  /* ================================================================ search: name, publisher, PID */
  const visibleNames = () => p.$$eval('#pg-processes .trow:not(.child) .c.name .n', (e) => e.map((x) => x.textContent));
  await p.fill('#q', 'notepad'); await settle(p);
  t.check('search by name', (await visibleNames()).join(',') === 'Notepad', (await visibleNames()).join(','));
  await p.fill('#q', 'valve'); await settle(p);
  t.check('search by publisher', (await visibleNames()).join(',') === 'Steam', (await visibleNames()).join(','));
  await p.fill('#q', '1480'); await settle(p);
  t.check('search by PID', (await visibleNames()).join(',') === 'Windows Explorer', (await visibleNames()).join(','));
  await p.fill('#q', 'zzzz'); await settle(p);
  t.check('no results: said, with Clear search', /No results/.test(await p.textContent('#pg-processes .tstate')));
  await p.keyboard.press('Escape'); await settle(p);
  t.check('Esc clears the search', (await p.$$('#pg-processes .tgroup')).length === 3);

  /* ================================================================ needsConfirm: End task on a Windows process */
  await t.clearCalls(p);
  await rowMenu(p, AUDIO); await pick(p, 'End task');
  await p.waitForSelector('.dlg.confirm', { timeout: 3000 }).catch(() => {});
  t.check('needsConfirm: Windows\' warning dialog', /Do you want to end Service Host: Windows Audio\?/.test(await p.textContent('.dlg').catch(() => '')) && (await p.textContent('.dlg .dfoot [data-b="ok"]').catch(() => '')) === 'End process');
  t.check('needsConfirm: Cancel holds the focus', (await p.evaluate(() => document.activeElement && document.activeElement.dataset.b)) === 'cancel');
  await p.click('.dlg .dfoot [data-b="ok"]'); await settle(p, 400);
  a = await calls(p, 'act');
  t.check('needsConfirm: sent again with confirmed:true', a.length === 2 && !a[0].confirmed && a[1].confirmed === true && a[1].key === AUDIO, JSON.stringify(a));
  // the hover freeze: rows keep their places while the pointer is over the list
  await p.click('#pg-processes .thead .h[data-col="cpu"]'); await settle(p);
  const before = await groupNames(p, 'Apps');
  await p.hover(`${R(NOTEPAD)} .c.name`);
  await p.evaluate(() => { window.__mock.S.apps[4].cpu = 90; window.__mock.push(); }); await settle(p, 300);
  t.check('hover freeze: rows do not slide under the pointer', (await groupNames(p, 'Apps')).join() === before.join(), (await groupNames(p, 'Apps')).join());
  await p.mouse.move(5, 5); await settle(p, 300);
  t.check('…and re-sort once it leaves', (await groupNames(p, 'Apps'))[0] === 'Notepad', (await groupNames(p, 'Apps')).join());
  // a single-process app with a window: expands to its window; the window row's menu
  await p.evaluate(() => { window.__mock.S.apps[4].title = 'Untitled - Notepad'; window.__mock.push(); }); await settle(p, 300);
  await p.click(`${R(NOTEPAD)} .chev`); await settle(p);
  t.check('a one-process app expands to its window', ((await p.textContent(`${R(NOTEPAD + '>w1200')} .n`).catch(() => '')) === 'Untitled - Notepad'));
  await rowMenu(p, NOTEPAD + '>w1200');
  t.check('a window row: Switch to, Bring to front, Minimize, Maximize, End task', (await menuLabels(p)).join(',') === 'Switch to,Bring to front,Minimize,Maximize,|,End task', (await menuLabels(p)).join(','));
  await pick(p, 'Minimize');
  t.check('Minimize: switchTo {key, op}', (await calls(p, 'switchTo')).some((x) => x.key === NOTEPAD && x.op === 'minimize'));
  await noShellErrors(p, 'light 1280');
  await t.close(p);

  /* ================================================================ Switch to with no such command; needsAdmin */
  p = await t.open('view=processes&missing=switchTo&admin=act');
  await rowMenu(p, DISCORD); await pick(p, 'Switch to'); await settle(p, 300);
  t.check('Switch to, no command: the plain reason on the row', /can't do that yet \(no "switchTo" command\)/.test(await subText(p, DISCORD)), await subText(p, DISCORD));
  await rowMenu(p, DISCORD); await pick(p, 'End task'); await settle(p, 300);
  t.check('needsAdmin: the reason and "Set up administrator access" on the row', /administrator/i.test(await subText(p, DISCORD)) && !!(await p.$(`${R(DISCORD)} .tsub [data-tmact="elevated-setup"]`)), await subText(p, DISCORD));
  await p.click(`${R(DISCORD)} .tsub [data-tmact="elevated-setup"]`); await settle(p, 300);
  t.check('…the button asks for the one-time setup', (await t.calls(p, 'taskmgr.elevatedSetup')).length === 1);
  await t.close(p);

  /* ================================================================ still running -> Force close on the row; Not responding */
  p = await t.open('view=processes&mock=failed');
  t.check('still running: the reason and Force close on the row', /kept running/.test(await subText(p, DISCORD)) && !!(await p.$(`${R(DISCORD)} .tsub [data-act="force"]`)));
  t.check('failed: the reason on the row', /access denied/.test(await subText(p, STEAM)));
  t.check('trimmed: before → after on the row', /655 MB → 214 MB/.test(await subText(p, '1120|1')), await subText(p, '1120|1'));
  t.check('recent: the strip over the list', /Notepad: Closed/.test(await p.textContent('#pg-processes .recent')));
  await p.click(`${R(DISCORD)} .tsub [data-act="force"]`); await settle(p);
  t.check('Force close asks on the row, Cancel focused', /Force close Discord\?/.test(await subText(p, DISCORD)) && (await p.evaluate(() => document.activeElement.dataset.act)) === 'force-no');
  await p.keyboard.press('Escape'); await settle(p);
  t.check('Esc cancels the question', !/Force close Discord\?/.test(await subText(p, DISCORD)));
  await t.clearCalls(p);
  await p.click(`${R(DISCORD)} .tsub [data-act="force"]`); await settle(p);
  await p.click(`${R(DISCORD)} .tsub [data-act="force-yes"]`); await settle(p, 300);
  a = await calls(p, 'act');
  t.check('Force close: act force, confirmed', a.length === 1 && a[0].action === 'force' && a[0].confirmed === true && a[0].key === DISCORD, JSON.stringify(a));
  await t.close(p);
  p = await t.open('view=processes&mock=hung');
  t.check('Not responding in Status, in words', (await cell(p, NOTEPAD, 'status')).text === 'Not responding');
  await p.click(`${R(NOTEPAD)} .c.name .n`); await t.clearCalls(p);
  await p.click('#cmdbar button[aria-label="End task"]'); await settle(p, 300);
  t.check('End task on a frozen app ends it at once (act force)', (await calls(p, 'act')).some((x) => x.action === 'force' && x.key === NOTEPAD));
  await t.close(p);

  /* ================================================================ nulls: em dashes with reasons */
  p = await t.open('view=processes&nulls=1');
  const nd = await cell(p, CHROME, 'disk'), nn = await cell(p, CHROME, 'net');
  t.check('nulls: Disk is an em dash with a reason', nd.text === '—' && nd.title.length > 10, JSON.stringify(nd));
  t.check('nulls: Network is an em dash with a reason', nn.text === '—' && /administrator|measure/i.test(nn.title), JSON.stringify(nn));
  const nt = await p.$$eval('#pg-processes .thead .tv', (e) => e.map((x) => x.textContent + '~' + x.title));
  t.check('nulls: Disk and Network totals are em dashes with a reason', /^—~Disk: /.test(nt[2]) && /^—~Network: /.test(nt[3]), nt.join(' | '));
  await p.evaluate(() => { window.__mock.S.apps[0].why = { net: 'Made-up reason from main' }; window.__mock.push(); }); await settle(p, 300);
  t.check('the row\'s own why.net wins', (await cell(p, CHROME, 'net')).title === 'Made-up reason from main');
  await p.click('#pg-processes .thead .h[data-col="cpu"]', { button: 'right' }); await pick(p, 'Publisher');
  await p.click('#pg-processes .thead .h[data-col="cpu"]', { button: 'right' }); await pick(p, 'Power usage');
  t.check('nulls: Publisher and Power usage say why', (await cell(p, CHROME, 'publisher')).text === '—' && (await cell(p, CHROME, 'publisher')).title.length > 10 && (await cell(p, CHROME, 'power')).text === '—' && /administrator/.test((await cell(p, CHROME, 'power')).title));
  await noShellErrors(p, 'nulls');
  await t.close(p);

  /* ================================================================ dark, and the minimum window */
  const look = async (theme) => {
    const q = await t.open('view=processes', { theme });
    const v = await q.evaluate(() => ({ ink: getComputedStyle(document.querySelector('#pg-processes .trow .c.name .n')).color, card: getComputedStyle(document.querySelector('.content') || document.body).backgroundColor }));
    await t.close(q);
    return v;
  };
  const L = await look('light'), D = await look('dark');
  t.check('dark: other ink and surface than light', L.ink !== D.ink && L.card !== D.card, JSON.stringify([L, D]));
  p = await t.open('view=processes', { theme: 'dark', w: 560, h: 420 });
  const sw = await p.evaluate(() => ({ doc: document.documentElement.scrollWidth, w: innerWidth, rows: document.querySelectorAll('#pg-processes .trow').length }));
  t.check('560x420: the window never scrolls sideways', sw.doc <= sw.w, JSON.stringify(sw));
  t.check('560x420: the list is drawn', sw.rows >= 16);
  const ls = await p.evaluate(() => { const l = document.querySelector('#pg-processes .tlist'); return { sw: l.scrollWidth, cw: l.clientWidth }; });
  t.check('560x420: the default columns fit (the list does not scroll sideways)', ls.sw <= ls.cw, JSON.stringify(ls));
  await rowMenu(p, CHROME);
  t.check('560x420: the row menu fits inside the window', await p.evaluate(() => { const r = document.querySelector('#menus .menu').getBoundingClientRect(); return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; }));
  await noShellErrors(p, 'dark 560');
  await t.close(p);
});
