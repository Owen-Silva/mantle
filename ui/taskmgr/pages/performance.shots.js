/* performance.shots.js - the Performance page's own shots for ui/taskmgr/shoot.js (on the mock: MADE-UP numbers).
 * Each device pane, logical processors, kernel times, the graph's right-click menu, the GPU engine picker, graph
 * summary view, summary view, nulls (em dashes) and an old main; plus the GPU and logical panes at the minimum size.
 *   node ui/taskmgr/shoot.js performance
 */
'use strict';
const card = (title) => (p) => p.evaluate((tt) => { const c = Array.from(document.querySelectorAll('#pg-performance .pc')).find((x) => x.querySelector('.pc-t').textContent === tt); if (c) c.click(); }, title);
async function choose(p, ...labels) {
  for (const l of labels) {
    await p.evaluate((x) => { const ms = document.querySelectorAll('#menus .menu'); const b = Array.from(ms[ms.length - 1].querySelectorAll('button')).find((y) => y.querySelector('span').textContent === x); b.click(); }, l);
    await p.waitForTimeout(80);
  }
}
const graphMenu = async (p) => { await p.click('#pg-performance .pp-graphs .pg-box', { button: 'right' }); await p.waitForTimeout(80); };
const logical = async (p) => { await graphMenu(p); await choose(p, 'Change graph to', 'Logical processors'); };
const kernel = async (p) => { await graphMenu(p); await choose(p, 'Show kernel times'); };

module.exports = [
  { name: 'performance-memory', q: 'view=performance', run: card('Memory') },
  { name: 'performance-disk', q: 'view=performance', run: card('Disk 0 (C:)') },
  { name: 'performance-wifi', q: 'view=performance', run: card('Wi-Fi') },
  { name: 'performance-ethernet', q: 'view=performance', themes: ['light'], run: card('Ethernet') },
  { name: 'performance-gpu', q: 'view=performance', run: card('GPU 0') },
  { name: 'performance-logical', q: 'view=performance', run: logical },
  { name: 'performance-kernel', q: 'view=performance', run: kernel },
  { name: 'performance-logical-kernel', q: 'view=performance', themes: ['dark'], run: async (p) => { await logical(p); await kernel(p); } },
  { name: 'performance-menu', q: 'view=performance', run: async (p) => { await graphMenu(p); await choose(p, 'Change graph to'); } },
  { name: 'performance-menu-view', q: 'view=performance', themes: ['dark'], run: async (p) => { await graphMenu(p); await choose(p, 'View'); } },
  { name: 'performance-more', q: 'view=performance', themes: ['light'], run: async (p) => { await p.click('#cmdbar .cbtn.more'); } },
  { name: 'performance-engine-pick', q: 'view=performance', run: async (p) => { await card('GPU 0')(p); await p.click('#pg-performance .pg-pick[data-slot="0"]'); } },
  { name: 'performance-gsv', q: 'view=performance', run: async (p) => { await p.dblclick('#pg-performance .pp-graphs .pg-box'); } },
  { name: 'performance-summary', q: 'view=performance', themes: ['light'], run: async (p) => { await p.dblclick('#pg-performance .pc >> nth=0'); } },
  { name: 'performance-nulls-cpu', q: 'view=performance&nulls=1' },
  { name: 'performance-nulls-memory', q: 'view=performance&nulls=1', run: card('Memory') },
  { name: 'performance-nulls-gpu', q: 'view=performance&nulls=1', themes: ['light'], run: card('GPU 0') },
  { name: 'performance-old', q: 'view=performance&old=1', run: async (p) => { await p.click('.nav[data-view="performance"]'); } },
  { name: 'performance-min-gpu', q: 'view=performance', w: 560, h: 420, run: card('GPU 0') },
  { name: 'performance-min-logical', q: 'view=performance', w: 560, h: 420, themes: ['light'], run: logical },
  { name: 'performance-min-memory', q: 'view=performance', w: 560, h: 420, themes: ['dark'], run: card('Memory') },
];
