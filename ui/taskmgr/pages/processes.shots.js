/* processes.shots.js - the Processes page's own shots for shoot.js (node ui/taskmgr/shoot.js processes).
 * Every one on the mock (made-up apps). Names start "processes-" so the page's filter word picks them up. */
'use strict';
const K = (pid) => `${pid}|${String(133730000000000000 + pid * 1000)}`;   // lib's pid|created, made up the way mock-mantle.js makes it
const R = (k) => `#pg-processes .trow[data-key="${k}"]`;
const menuPath = async (p, path) => {
  for (let d = 0; d < path.length; d++) {
    await p.evaluate(([d, l]) => {
      const m = document.querySelectorAll('#menus .menu')[d];
      const b = m && Array.from(m.querySelectorAll('button[data-i]')).find((x) => x.querySelector('span').textContent === l);
      if (b) b.click();
    }, [d, path[d]]);
    await p.waitForTimeout(60);
  }
};
const view = async (p, ...path) => { await p.click('#cmdbar button[aria-label="View"]'); await p.waitForSelector('#menus .menu'); await menuPath(p, path); };

module.exports = [
  { name: 'processes-rowmenu', q: 'view=processes', run: async (p) => { await p.click(`${R(K(1080))} .c.name .n`, { button: 'right' }); } },
  { name: 'processes-view-status', q: 'view=processes', run: (p) => view(p, 'Status values') },
  { name: 'processes-view-resource', q: 'view=processes', run: (p) => view(p, 'Resource values', 'Memory') },
  { name: 'processes-headmenu', q: 'view=processes', run: async (p) => { await p.click('#pg-processes .thead .h[data-col="cpu"]', { button: 'right' }); } },
  { name: 'processes-expanded', q: 'view=processes', run: async (p) => {
    await p.click(`${R(K(1040))} .chev`); await p.waitForTimeout(150);
    await p.click(`${R(K(1040) + '>p1040')} .chev`); await p.waitForTimeout(100);
    await p.click(`${R(K(1040) + '>p1040>w1040:71040')} .c.name .n`);
  } },
  { name: 'processes-allcols', q: 'view=processes&nulls=1', run: async (p) => {
    for (const c of ['Type', 'Publisher', 'PID', 'GPU', 'Power usage']) {
      await p.click('#pg-processes .thead .h[data-col="cpu"]', { button: 'right' }); await p.waitForSelector('#menus .menu'); await menuPath(p, [c]);
    }
  } },
  { name: 'processes-dump', q: 'view=processes', run: async (p) => {
    await p.click(`${R(K(1080))} .c.name .n`, { button: 'right' }); await p.waitForSelector('#menus .menu'); await menuPath(p, ['Create memory dump file']);
    await p.waitForSelector('.dlg .dpath', { timeout: 3000 });
  } },
  { name: 'processes-confirm', q: 'view=processes', run: async (p) => {
    await p.click(`${R(K(1520))} .c.name .n`, { button: 'right' }); await p.waitForSelector('#menus .menu'); await menuPath(p, ['End task']);
    await p.waitForSelector('.dlg.confirm', { timeout: 3000 });
  } },
  { name: 'processes-outcome', q: 'view=processes&mock=failed', run: async (p) => { await p.click(`${R(K(1080))} .tsub [data-act="force"]`); } },
  { name: 'processes-admin', q: 'view=processes&admin=act', run: async (p) => {
    await p.click(`${R(K(1080))} .c.name .n`); await p.click('#cmdbar button[aria-label="End task"]'); await p.waitForTimeout(250);
  } },
  { name: 'processes-outcome-min', q: 'view=processes&mock=failed', w: 560, h: 420, run: async (p) => { await p.click(`${R(K(1080))} .tsub [data-act="force"]`); } },
  { name: 'processes-rowmenu-min', q: 'view=processes', w: 560, h: 420, run: async (p) => { await p.click(`${R(K(1040))} .c.name .n`, { button: 'right' }); } },
];
