/* pages/startup.shots.js - the Startup apps page's own shots for ui/taskmgr/shoot.js (on the MOCK; made-up apps).
 * shoot.js already takes light + dark at 1280x800 and 560x420.
 *   node ui/taskmgr/shoot.js startup
 */
'use strict';
const ROW = (item) => `#pg-startup .trow[data-key="s${item}"]`;
const rmenu = async (p, item) => { await p.waitForSelector(ROW(item)); await p.click(ROW(item) + ' .tr', { button: 'right' }); await p.waitForSelector('#menus .menu'); };
const pick = (p, label) => p.evaluate((l) => { const ms = document.querySelectorAll('#menus .menu'); const m = ms[ms.length - 1]; const b = m && Array.from(m.querySelectorAll('button')).find((x) => x.querySelector('span').textContent === l); if (b) b.click(); }, label);

module.exports = [
  { name: 'startup-row-menu', q: 'view=startup&test=1', run: async (p) => { await rmenu(p, 'discord'); } },
  { name: 'startup-head-menu', q: 'view=startup&test=1', run: async (p) => { await p.click('#pg-startup .thead .h[data-col="publisher"]', { button: 'right' }); await p.waitForSelector('#menus .menu'); } },
  { name: 'startup-selected-disable', q: 'view=startup&test=1', run: async (p) => { await p.waitForSelector(ROW('steam')); await p.click(ROW('steam') + ' .tr'); } },
  { name: 'startup-outcome-rows', q: 'view=startup&test=1&admin=startupSet', run: async (p) => {
    await rmenu(p, 'discord'); await pick(p, 'Disable');
    await p.waitForSelector(ROW('discord') + ' [data-tmact="elevated-setup"]');
  } },
  { name: 'startup-dry-run-row', q: 'view=startup&test=1', run: async (p) => {
    await rmenu(p, 'teams'); await pick(p, 'Enable');
    await p.waitForFunction(() => /Test Mantle/.test((document.querySelector('#pg-startup .trow[data-key="steams"] .tsub') || {}).textContent || ''));
  } },
  { name: 'startup-all-columns', q: 'view=startup', w: 1280, h: 800, run: async (p) => {
    await p.evaluate(() => localStorage.setItem('taskmgr.tbl.startup', JSON.stringify({ vis: ['name', 'publisher', 'status', 'impact', 'type', 'diskIO', 'cpuMs', 'running', 'disabledAt', 'cmdline'] })));
    await p.reload(); await p.waitForFunction(() => document.documentElement.dataset.shot === '1'); await p.waitForSelector('#pg-startup .trow');
    await p.evaluate(() => localStorage.removeItem('taskmgr.tbl.startup'));
  } },
  { name: 'startup-nulls', q: 'view=startup&nulls=1', themes: ['light', 'dark'] },
];
