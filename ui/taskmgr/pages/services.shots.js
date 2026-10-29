/* pages/services.shots.js - the Services page's own shots for ui/taskmgr/shoot.js (on the MOCK; made-up services).
 * shoot.js already takes light + dark at 1280x800 and 560x420.
 *   node ui/taskmgr/shoot.js services
 */
'use strict';
const ROW = (name) => `#pg-services .trow[data-key="v${name}"]`;
const rmenu = async (p, name) => { await p.waitForSelector(ROW(name)); await p.click(ROW(name) + ' .tr', { button: 'right' }); await p.waitForSelector('#menus .menu'); };
const pick = (p, label) => p.evaluate((l) => { const ms = document.querySelectorAll('#menus .menu'); const m = ms[ms.length - 1]; const b = m && Array.from(m.querySelectorAll('button')).find((x) => x.querySelector('span').textContent === l); if (b) b.click(); }, label);

module.exports = [
  { name: 'services-row-menu-running', q: 'view=services&test=1', run: async (p) => { await rmenu(p, 'AudioSrv'); } },
  { name: 'services-row-menu-stopped', q: 'view=services&test=1', run: async (p) => { await rmenu(p, 'BITS'); } },
  { name: 'services-from-details', q: 'view=services&test=1', run: async (p) => {
    await p.waitForSelector(ROW('Dhcp'));
    await p.evaluate(() => TM.goTo('services', { names: ['Dhcp', 'Dnscache', 'Themes'] }));
    await p.waitForSelector(ROW('Dhcp') + '.sel');
  } },
  { name: 'services-confirm-critical', q: 'view=services&test=1', run: async (p) => {
    await p.waitForSelector(ROW('EventLog'));
    await p.evaluate(() => {
      const call = window.mantle.call.bind(window.mantle);
      window.mantle.call = (name, args) => (name === 'taskmgr.service' && args.name === 'EventLog' && !args.confirmed
        ? Promise.resolve({ ok: false, needsConfirm: true, title: 'Do you want to stop Windows Event Log?', text: 'Stopping this service might make Windows unstable (made-up words).', button: 'Stop service' })
        : call(name, args));
    });
    await rmenu(p, 'EventLog'); await pick(p, 'Stop');
    await p.waitForSelector('#dlg .dlg');
  } },
  { name: 'services-outcome-rows', q: 'view=services&test=1&admin=service', run: async (p) => {
    await rmenu(p, 'Spooler'); await pick(p, 'Stop');
    await p.waitForSelector(ROW('Spooler') + ' [data-tmact="elevated-setup"]');
    await p.evaluate(() => {
      const S = window.__mock.S, base = S.services;
      S.services = () => { const d = base(); d.rows.find((r) => r.name === 'wuauserv').lastOp = { op: 'start', ok: false, reason: 'The service did not respond in time (made up).', at: Date.now() - 60000 }; d.rows.find((r) => r.name === 'SysMain').lastOp = { op: 'restart', ok: true, reason: null, at: Date.now() }; return d; };
      window.__mock.push();
    });
    await p.waitForFunction(() => /respond/.test((document.querySelector('#pg-services .trow[data-key="vwuauserv"] .tsub') || {}).textContent || ''));
  } },
  { name: 'services-nulls', q: 'view=services&nulls=1', themes: ['light', 'dark'] },
];
