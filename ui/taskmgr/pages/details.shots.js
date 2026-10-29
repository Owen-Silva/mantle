/* pages/details.shots.js - the Details page's own shots for ui/taskmgr/shoot.js (on the MOCK; made-up processes).
 *   node ui/taskmgr/shoot.js details
 */
'use strict';
const ROW = (pid) => `#pg-details .trow[data-key="p${pid}"]`;
const rmenu = async (p, pid) => { await p.waitForSelector(ROW(pid)); await p.click(ROW(pid) + ' .tr', { button: 'right' }); await p.waitForSelector('#menus .menu'); };
const pick = (p, label) => p.evaluate((l) => { const ms = document.querySelectorAll('#menus .menu'); const m = ms[ms.length - 1]; const b = m && Array.from(m.querySelectorAll('button')).find((x) => x.querySelector('span').textContent === l); if (b) b.click(); }, label);

module.exports = [
  { name: 'details-menu-priority', q: 'view=details&test=1', run: async (p) => { await rmenu(p, 1012); await pick(p, 'Set priority'); await p.waitForTimeout(150); } },
  { name: 'details-select-columns', q: 'view=details&test=1', run: async (p) => { await p.click('#pg-details .thead .h[data-col="name"]', { button: 'right' }); await pick(p, 'Select columns'); await p.waitForSelector('#dlg .selcols'); } },
  { name: 'details-head-menu', q: 'view=details&test=1', run: async (p) => { await p.click('#pg-details .thead .h[data-col="desc"]', { button: 'right' }); await p.waitForSelector('#menus .menu'); } },
  { name: 'details-affinity', q: 'view=details&test=1', run: async (p) => { await rmenu(p, 1012); await pick(p, 'Set affinity'); await p.waitForSelector('#dlg .daff [data-cpu]'); await p.click('#dlg [data-cpu="3"]'); } },
  { name: 'details-wait-chain', q: 'view=details&test=1', run: async (p) => { await rmenu(p, 1012); await pick(p, 'Analyze wait chain'); await p.waitForSelector('#dlg .wtree'); } },
  { name: 'details-confirm-end', q: 'view=details&test=1', run: async (p) => { await p.click(ROW(1012) + ' .tr'); await p.keyboard.press('Delete'); await p.waitForSelector('#dlg .dlg'); } },
  { name: 'details-confirm-critical', q: 'view=details&test=1', run: async (p) => { await p.waitForSelector(ROW(4)); await p.click(ROW(4) + ' .tr'); await p.keyboard.press('Delete'); await p.waitForSelector('#dlg .dlg'); } },
  { name: 'details-outcome-rows', q: 'view=details&test=1&admin=endPid&fail=priority', run: async (p) => {
    await p.waitForSelector(ROW(1012));
    await p.click(ROW(1012) + ' .tr'); await p.keyboard.press('Delete');
    await p.waitForSelector(ROW(1012) + ' [data-tmact="elevated-setup"]');
    await rmenu(p, 1100); await pick(p, 'Set priority'); await pick(p, 'High');
    await p.waitForFunction(() => /Made-up failure/.test((document.querySelector('#pg-details .trow[data-key="p1100"] .tsub') || {}).textContent || ''));
  } },
  { name: 'details-nulls', q: 'view=details&nulls=1', themes: ['light'] },
  { name: 'details-wide-columns', q: 'view=details', w: 900, h: 600, run: async (p) => {
    await p.evaluate(() => localStorage.setItem('taskmgr.tbl.details', JSON.stringify({ vis: ['name', 'pid', 'status', 'user', 'cpu', 'cpuTimeSec', 'mem', 'commit', 'handles', 'threads', 'path', 'arch', 'desc'] })));
    await p.reload(); await p.waitForFunction(() => document.documentElement.dataset.shot === '1'); await p.waitForSelector('#pg-details .trow');
    await p.evaluate(() => { const l = document.querySelector('#pg-details .tlist'); l.scrollLeft = 300; l.dispatchEvent(new Event('scroll')); });
    await p.evaluate(() => localStorage.removeItem('taskmgr.tbl.details'));
  } },
];
