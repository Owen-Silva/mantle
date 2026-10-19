require('../../tools/dev-env.js').lowcpu();
/* apppower-bench.js — does App power make the CPU dropdown slower to open? (lane mantle-power-ui, 2026-10-14)
 *
 * The SAME harness on two trees of the top bar page: BASE = topbar.js / topbar.css / index.html as they
 * are at BENCH_BASE_REV (default HEAD~1: in a cloudtest snapshot that is the branch tip before this lane's
 * uncommitted work; locally pass the master sha), and NEW = this working tree. Both get the same decorated
 * sample (5 app rows with every App power field: the base page ignores them). Per cycle: mousedown on the
 * CPU reading -> (a) the handler's own time, (b) the time to the frame after it (requestAnimationFrame,
 * then a task: the paint has happened), then mousedown again to close. Loads alternate BASE / NEW; the
 * first cycle of each load (cold) is dropped. Prints the medians:
 *   OPEN BENCH base: handler median x ms, to paint median y ms (n) | new: ...
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const REV = process.env.BENCH_BASE_REV || 'HEAD~1';
const LOADS = +(process.env.BENCH_LOADS || 6), CYCLES = +(process.env.BENCH_CYCLES || 25);

function baseTree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-bench-'));
  const cp = (rel) => { const to = path.join(dir, rel); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.cpSync(path.join(ROOT, rel), to, { recursive: true }); };
  cp('ui/topbar'); cp('ui/shared'); cp('lib/features/_timer-core.js');
  for (const rel of ['ui/topbar/topbar.js', 'ui/topbar/topbar.css', 'ui/topbar/index.html']) {
    fs.writeFileSync(path.join(dir, rel), execFileSync('git', ['show', `${REV}:${rel}`], { cwd: ROOT, maxBuffer: 64 << 20 }));
  }
  const js = fs.readFileSync(path.join(dir, 'ui/topbar/topbar.js'), 'utf8');
  if (js.includes('AppPower')) throw new Error(`${REV} already has App power in topbar.js: not a "before" tree`);
  return dir;
}

function FAKE() {
  const GB = 1073741824;
  const DEF = { eco: false, priority: null, cpuCap: 0, memLow: false, memCap: 0, gpuLow: false, gpuPref: 'default' };
  const ent = (key, label, exe, n, pct, ctl, why) => ({ name: exe + (n > 1 ? ` (${n})` : ''), pct, bytes: pct * 0.2 * GB, exe, n, path: 'C:\\Made up\\' + exe + '.exe', access: ctl ? 'ok' : 'protected',
    key, label, ctl, why: why || null, deny: null, set: Object.assign({}, DEF, key === 'k1' ? { eco: true, cpuCap: 25 } : {}), remembered: key === 'k1', shared: key === 'k1' ? true : null, test: false });
  const top = [ent('k1', 'Quartz', 'quartz', 13, 5.1, true), ent('k2', 'Service Host', 'svchost', 43, 4.6, false, 'Windows protects this process'),
    ent('k3', 'PowerShell', 'powershell', 3, 3.9, true), ent('k4', 'MsMpEng', 'MsMpEng', 1, 3.6, false, 'Windows protects this process'), ent('k5', 'Mantle', 'electron', 6, 2.8, false, 'This is Mantle')];
  const stats = { t: 1, cpu: { pct: 23.4, cores: [22, 61, 9, 14, 37, 5, 71, 18], top }, mem: { used: 9.7 * GB, total: 15.7 * GB, top },
    gpu: { pct: 7.8, top }, net: { down: 1, up: 1, adapters: [] }, apppower: { gpus: 1, gpuLow: false, gpuLowWhy: null, gpuPref: false } };
  const handlers = {};
  window.mantle = {
    on(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); return () => {}; },
    call(name) { return Promise.resolve(name === 'topbar.hello' ? { focus: null, stats } : name === 'glass.topbarMenu' ? { ok: false, reason: 'bench' } : { ok: true }); },
  };
}

async function measure(page, cycles) {
  return page.evaluate(async (n) => {
    const frame = () => new Promise((res) => requestAnimationFrame(() => setTimeout(res, 0)));
    // the bar redraws its readings when a dropdown opens or closes: the button is looked up every time
    const down = () => document.querySelector('.st[data-k="cpu"]').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    const isOpen = () => !!(window.__topbar.open && window.__topbar.open.stat === 'cpu' && document.querySelector('.dd.stat'));
    const out = [];
    await frame();
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      down();
      const t1 = performance.now();
      await frame();
      const t2 = performance.now();
      if (!isOpen()) throw new Error('the CPU dropdown did not open');
      out.push([t1 - t0, t2 - t0, !!document.querySelector('.dd.stat .ap-list')]);
      down();
      await frame();
      if (isOpen()) throw new Error('the CPU dropdown did not close');
    }
    // (c) the open's script + style + layout at a usable resolution (performance.now() is coarsened to
    // 0.1 ms here): 50 opens back to back, each laid out (its rect read), each closed again; per open
    const N = 50, t = performance.now();
    let opened = 0;
    for (let i = 0; i < N; i++) { down(); if (isOpen()) opened++; document.querySelector('.dd.stat').getBoundingClientRect(); down(); if (isOpen()) throw new Error('a burst open did not close'); }
    if (opened !== N) throw new Error('only ' + opened + ' of ' + N + ' burst opens opened');
    return { cycles: out, burst: (performance.now() - t) / N };
  }, cycles);
}

const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN; };

(async () => {
  const base = baseTree();
  const pages = { base: 'file:///' + path.join(base, 'ui/topbar/index.html').replace(/\\/g, '/'), new: 'file:///' + path.join(ROOT, 'ui/topbar/index.html').replace(/\\/g, '/') };
  const { chromium } = require('../../tools/dev-env.js').playwright();
  const browser = await require('../settings/test-browser.js').launch(chromium);
  const R = { base: { h: [], p: [], b: [], ap: 0 }, new: { h: [], p: [], b: [], ap: 0 } };
  try {
    for (let l = 0; l < LOADS; l++) {
      for (const v of (l % 2 ? ['new', 'base'] : ['base', 'new'])) {
        const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1.25 });
        await ctx.addInitScript(FAKE);
        const page = await ctx.newPage();
        await page.goto(pages[v], { waitUntil: 'load' });
        await page.waitForFunction(() => !!document.querySelector('.st[data-k="cpu"]'), null, { timeout: 8000 });
        const m = await measure(page, CYCLES + 1);
        m.cycles.slice(1).forEach(([h, p, ap]) => { R[v].h.push(h); R[v].p.push(p); if (ap) R[v].ap++; });
        R[v].b.push(m.burst);
        await ctx.close();
      }
    }
  } finally { await browser.close(); fs.rmSync(base, { recursive: true, force: true }); }
  const f = (x) => x.toFixed(2);
  const line = (v) => `${v}: open + layout median ${f(median(R[v].b))} ms (${R[v].b.length} loads x 50), handler median ${f(median(R[v].h))} ms, to paint median ${f(median(R[v].p))} ms (n ${R[v].h.length}, app rows drawn ${R[v].ap})`;
  console.log(`base tree: ${REV}`);
  console.log(`OPEN BENCH ${line('base')} | ${line('new')}`);
  if (R.base.ap !== 0 || R.new.ap !== R.new.h.length) { console.log('BENCH INVALID: the base drew app rows or the new tree did not'); process.exitCode = 1; }
})().catch((e) => { console.log('BENCH FAILED: ' + e.message); process.exitCode = 1; });
