/* pages/apphistory.shots.js - the App history page's own shots for ui/taskmgr/shoot.js (on the MOCK; made-up apps).
 *   node ui/taskmgr/shoot.js apphistory
 * shoot.js already takes the four base shots (light + dark at 1280x800 and at 560x420).
 */
'use strict';
const NAMES = { 'google chrome': 'Google Chrome', discord: 'Discord', 'made-up-bgsvc': 'made-up-tool' };   // keys are lib's identities: find rows by name
const ROW = (id) => `#pg-apphistory .trow:has(.n:text-is("${NAMES[id] || id}"))`;
const pick = (p, label) => p.evaluate((l) => { const ms = document.querySelectorAll('#menus .menu'); const m = ms[ms.length - 1]; const b = m && Array.from(m.querySelectorAll('button')).find((x) => x.querySelector('span').textContent === l); if (b && !b.disabled) b.click(); }, label);

module.exports = [
  { name: 'apphistory-row-menu', q: 'view=apphistory&test=1', run: async (p) => { await p.waitForSelector(ROW('Microsoft Store')); await p.click(ROW('Microsoft Store') + ' .tr', { button: 'right' }); await p.waitForSelector('#menus .menu'); } },
  { name: 'apphistory-head-menu', q: 'view=apphistory&test=1', run: async (p) => { await p.click('#pg-apphistory .thead .h[data-col="net"]', { button: 'right' }); await p.waitForSelector('#menus .menu'); } },
  { name: 'apphistory-all-columns-all-processes', q: 'view=apphistory&test=1', run: async (p) => {
    await p.evaluate(() => { localStorage.setItem('taskmgr.tbl.apphistory', JSON.stringify({ vis: ['name', 'cpuTimeSec', 'net', 'metered', 'tiles', 'nonMetered', 'downloads', 'uploads'] })); window.__mock.S.settings.historyAllProcesses = true; });
    await p.reload(); await p.waitForFunction(() => document.documentElement.dataset.shot === '1');
    await p.evaluate(() => { window.__mock.S.settings.historyAllProcesses = true; window.__mock.push(); });
    await p.waitForSelector(ROW('made-up-bgsvc'));
    await p.evaluate(() => localStorage.removeItem('taskmgr.tbl.apphistory'));
  } },
  { name: 'apphistory-deleted', q: 'view=apphistory&test=1', run: async (p) => { await p.click('#cmdbar button[aria-label="Delete usage history"]'); await p.waitForFunction(() => /Test Mantle/.test(document.querySelector('#pg-apphistory .ahout').textContent)); } },
  { name: 'apphistory-delete-needs-admin', q: 'view=apphistory&test=1&admin=clearHistory', run: async (p) => { await p.click('#cmdbar button[aria-label="Delete usage history"]'); await p.waitForSelector('#pg-apphistory .ahout [data-tmact="elevated-setup"]'); } },
  { name: 'apphistory-switch-to-outcome', q: 'view=apphistory&test=1', run: async (p) => { await p.waitForSelector(ROW('Photos')); await p.click(ROW('Photos') + ' .tr', { button: 'right' }); await p.waitForSelector('#menus .menu'); await pick(p, 'Switch to'); await p.waitForSelector(ROW('Photos') + ' .tsub:has-text("Test Mantle")'); } },
  { name: 'apphistory-srum', q: 'view=apphistory&ah=srum', themes: ['light'] },
  { name: 'apphistory-nulls', q: 'view=apphistory&nulls=1' },
  { name: 'apphistory-empty', q: 'view=apphistory&ah=empty', themes: ['dark'] },
  { name: 'apphistory-min-menu', q: 'view=apphistory&test=1', w: 560, h: 420, run: async (p) => { await p.waitForSelector(ROW('Microsoft Store')); await p.click(ROW('Microsoft Store') + ' .tr', { button: 'right' }); await p.waitForSelector('#menus .menu'); } },
];
