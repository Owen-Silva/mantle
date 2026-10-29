require('../../../tools/dev-env.js').lowcpu();
/* processes.bench.js - the Processes page's render cost per model update, headless, on the MOCK.
 *
 *   node ui/taskmgr/pages/processes.bench.js                          this page (view=processes)
 *   node ui/taskmgr/pages/processes.bench.js <index.html> <query>     another build of the page, e.g. the old one:
 *       git archive 7dab0a2 ui | tar -x -C <tmp>;  node ...bench.js <tmp>/ui/taskmgr/index.html mock=apps
 *
 * It takes the mock's model once, inflates it to ~200 rows (clones with unique keys and PIDs), then emits 40
 * models with jittered CPU and memory (a fixed seed, so every run sees the same numbers) after 5 warm-ups.
 * Reports: script ms per update (the shell's own window.__taskmgrPerf: ms / ticks, max) and script + layout
 * per update (emit -> a forced layout read). Under 3.3 GB free RAM it waits (60 s, twice), then says it did
 * not run. Prints "PROCESSES BENCH: ..." as its verdict line.
 */
'use strict';
const path = require('path');
const { freeGB } = require('../testkit.js');

const file = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..', 'index.html');
const query = process.argv[3] || 'view=processes';
const URL = 'file:///' + file.replace(/\\/g, '/') + '?' + query;

(async () => {
  let gb = freeGB();
  for (let i = 0; i < 2 && gb > 0 && gb < 3.3; i++) { console.log(`waiting: ${gb.toFixed(2)} GB free RAM, a browser needs 3.3`); await new Promise((r) => setTimeout(r, 60000)); gb = freeGB(); }
  if (gb > 0 && gb < 3.3) { console.log(`PROCESSES BENCH: not run (only ${gb.toFixed(2)} GB free RAM; a browser needs 3.3)`); process.exit(2); }
  const { chromium } = require('../../../tools/dev-env.js').playwright();
  const browser = await require('../../settings/test-browser.js').launch(chromium, { timeout: 0, headless: true });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.goto(URL);
    await page.waitForFunction(() => document.documentElement.dataset.shot === '1', null, { timeout: 8000 });
    await page.waitForTimeout(300);
    const r = await page.evaluate(async () => {
      const base = await window.mantle.call('taskmgr.state');
      let seed = 7;
      const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
      const strip = (g) => { const c = Object.assign({}, g); delete c.members; return c; };   // main sends processes only while open
      const grow = (rows, want, tag) => {
        const out = [];
        for (let i = 0; out.length < want; i++) {
          const g = rows[i % rows.length];
          const c = strip(g);
          if (i >= rows.length) { const n = Math.floor(i / rows.length); c.key = `${90000 + i}|${tag}`; c.pid = 90000 + i; c.name = `${g.name} ${n}`; c.identity = `${g.identity}#${n}`; c.state = null; }
          out.push(c);
        }
        return out;
      };
      const big = Object.assign({}, base, { apps: grow(base.apps || [], 90, 'a'), background: grow(base.background || [], 90, 'b'), windows: grow(base.windows || [], 20, 'w') });
      const rows = big.apps.length + big.background.length + big.windows.length + (big.mantleRow ? 1 : 0);
      const jitter = () => {
        const m = Object.assign({}, big, { at: Date.now() });
        for (const k of ['apps', 'background', 'windows']) m[k] = big[k].map((g) => Object.assign({}, g, { cpu: Math.round(rnd() * 120) / 10, mem: Math.round(g.mem * (0.9 + rnd() * 0.2)) }));
        return m;
      };
      const frame = () => new Promise((res) => requestAnimationFrame(() => setTimeout(res, 0)));
      const list = () => document.querySelector('#pg-processes .tlist') || document.getElementById('list') || document.body;
      for (let i = 0; i < 5; i++) { window.mantle.emit('taskmgr.model', jitter()); list().scrollHeight; await frame(); }
      const P = window.__taskmgrPerf;
      P.ticks = 0; P.ms = 0; P.max = 0;
      const lay = [];
      for (let i = 0; i < 40; i++) {
        const m = jitter();
        const t0 = performance.now();
        window.mantle.emit('taskmgr.model', m);
        void list().scrollHeight; void document.body.offsetHeight;   // forced style + layout
        lay.push(performance.now() - t0);
        await frame();
      }
      lay.sort((a, b) => a - b);
      return { rows, drawn: document.querySelectorAll('#pg-processes .trow, #list .row').length, ticks: P.ticks, script: P.ms / Math.max(1, P.ticks), scriptMax: P.max,
        layout: lay.reduce((s, x) => s + x, 0) / lay.length, layoutMed: lay[Math.floor(lay.length / 2)], layoutMax: lay[lay.length - 1] };
    });
    const f = (x) => x.toFixed(1);
    console.log(`page: ${URL}`);
    console.log(`model rows: ${r.rows}, rows drawn: ${r.drawn}, updates measured: ${r.ticks}`);
    if (errs.length) console.log('page errors: ' + errs.join(' | '));
    console.log(`PROCESSES BENCH: script ${f(r.script)} ms per update (max ${f(r.scriptMax)}); script+layout ${f(r.layout)} ms per update (median ${f(r.layoutMed)}, max ${f(r.layoutMax)})`);
    await ctx.close();
  } finally { await browser.close(); }
})();
