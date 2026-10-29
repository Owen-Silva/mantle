/* pages/users.shots.js - the Users page's own shots for ui/taskmgr/shoot.js (on the MOCK; made-up users).
 *   node ui/taskmgr/shoot.js users
 * shoot.js already takes the four base shots (light + dark at 1280x800 and at 560x420). Every action is a dry run.
 */
'use strict';
const UROW = (s) => `#pg-users .trow[data-key="u${s}"]`;
const pick = (p, label) => p.evaluate((l) => { const ms = document.querySelectorAll('#menus .menu'); const m = ms[ms.length - 1]; const b = m && Array.from(m.querySelectorAll('button')).find((x) => x.querySelector('span').textContent === l); if (b && !b.disabled) b.click(); }, label);
const rmenu = async (p, sel) => { await p.waitForSelector(sel); await p.click(sel + ' > .tr', { button: 'right' }); await p.waitForSelector('#menus .menu'); };
const expand = async (p, s) => { await p.waitForSelector(UROW(s)); await p.click(UROW(s) + ' [data-act="expand"]'); await p.waitForSelector('#pg-users .trow.child'); };

module.exports = [
  { name: 'users-expanded', q: 'view=users&test=1', run: async (p) => { await expand(p, 1); } },
  { name: 'users-user-menu', q: 'view=users&test=1', run: async (p) => { await rmenu(p, UROW(1)); } },
  { name: 'users-disconnected-menu', q: 'view=users&test=1', run: async (p) => { await rmenu(p, UROW(2)); } },
  { name: 'users-process-menu', q: 'view=users&test=1', run: async (p) => { await expand(p, 1); const k = await p.$eval('#pg-users .trow.child', (e) => e.dataset.key); await rmenu(p, `#pg-users .trow[data-key="${k}"]`); } },
  { name: 'users-confirm-sign-off', q: 'view=users&test=1', run: async (p) => { await rmenu(p, UROW(1)); await pick(p, 'Sign off'); await p.waitForSelector('#dlg .dlg'); } },
  { name: 'users-confirm-disconnect', q: 'view=users&test=1', run: async (p) => { await p.waitForSelector(UROW(1)); await p.click(UROW(1) + ' > .tr'); await p.click('#cmdbar button[aria-label="Disconnect"]'); await p.waitForSelector('#dlg .dlg'); } },
  { name: 'users-outcome-rows', q: 'view=users&test=1&admin=userSignOff&fail=userConnect', run: async (p) => {
    await rmenu(p, UROW(1)); await pick(p, 'Sign off'); await p.waitForSelector(UROW(1) + ' [data-tmact="elevated-setup"]');
    await rmenu(p, UROW(2)); await pick(p, 'Connect');
    await p.waitForFunction(() => /Made-up failure/.test((document.querySelector('#pg-users .trow[data-key="u2"] .tsub') || {}).textContent || ''));
  } },
  { name: 'users-full-name-gpu', q: 'view=users&test=1', run: async (p) => {
    await p.evaluate(() => localStorage.setItem('taskmgr.tbl.users', JSON.stringify({ vis: ['name', 'session', 'sessionName', 'status', 'cpu', 'mem', 'disk', 'net', 'gpu'] })));
    await p.reload(); await p.waitForFunction(() => document.documentElement.dataset.shot === '1');
    await p.evaluate(() => { window.__mock.S.settings.fullAccountName = true; window.__mock.push(); });
    await p.waitForFunction(() => /Alex Made-Up/.test((document.querySelector('#pg-users .trow[data-key="u1"]') || {}).textContent || ''));
    await p.evaluate(() => localStorage.removeItem('taskmgr.tbl.users'));
  } },
  { name: 'users-nulls', q: 'view=users&nulls=1', run: async (p) => { await expand(p, 1); } },
  { name: 'users-min-expanded', q: 'view=users&test=1', w: 560, h: 420, run: async (p) => { await expand(p, 1); } },
];
