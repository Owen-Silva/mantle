'use strict';
/*
 * stats-view.test.js -- the top bar's 1 s stats made cheap (lane mantle-idlefix-stats, 2026-10-17). Pure node.
 * The REAL code is run, not a copy: the page's renderStats / tickStats / topbar.stats handler are cut out of
 * ui/topbar/topbar.js and main's onStats / statsFlush / statsOn out of lib/features/topbar.js, then run in a
 * vm against fakes (a #right that parses the strip's own HTML into counted elements, a fake clock, a push log).
 *   PAGE: an unchanged sample writes nothing and reads no layout; a changed value writes only its text node
 *         (and a changed tooltip only its title); a new shape / class / cell / pause / note / width rebuilds,
 *         measures and re-plans the colour under, exactly as before; the HTML is byte-for-byte the old one.
 *   MAIN: a sample the bar would draw the same is not pushed; a heartbeat every 5 s; pause, resume, detail,
 *         an open dropdown and statsOn(false) always reach the page; opening a dropdown flushes the newest.
 * Point it at other files (the fail-before proof): TOPBAR_PAGE=<topbar.js> TOPBAR_MAIN=<topbar.js> STATS_VIEW=<stats-view.js>
 *   node ui/topbar/stats-view.test.js   -> "TOPBAR STATS VIEW: n passed, m failed"
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..', '..');
const M = require(path.join(__dirname, 'model.js'));
const PAGE = process.env.TOPBAR_PAGE || path.join(__dirname, 'topbar.js');
const MAIN = process.env.TOPBAR_MAIN || path.join(ROOT, 'lib', 'features', 'topbar.js');
const SVF = process.env.STATS_VIEW || path.join(__dirname, 'stats-view.js');
let SV = null;
try { SV = require(SVF); } catch (_) { SV = null; }

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(name + (detail !== undefined ? ' -- ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 500) : ''));
  return ok;
}

/* ---- cutting the real functions out of a source file ------------------------------------------ */
function grab(src, re, indent) {
  const lines = src.split(/\r?\n/);
  const i = lines.findIndex((l) => re.test(l));
  if (i < 0) return '';
  const end = new RegExp('^' + indent + '\\}\\)?;?\\s*$');
  for (let j = i + 1; j < lines.length; j++) if (end.test(lines[j])) return lines.slice(i, j + 1).join('\n');
  return '';
}
const line = (src, re) => (src.split(/\r?\n/).find((l) => re.test(l)) || '');

/* ---- a fake #right: the strip's HTML parsed into counted elements ------------------------------ */
const dec = (s) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
function fakeRight() {
  const log = { html: 0, text: 0, attr: 0, layout: 0, ops: [] };
  let html = '', els = [];
  function parse(h) {
    const out = [];
    const re = /<button class="([^"]*)" data-k="([^"]*)" title="([^"]*)"><span class="k">([^<]*)<\/span><span class="v">([^<]*)<\/span><\/button>/g;
    let m;
    while ((m = re.exec(h))) {
      const k = m[2];
      const text = { nodeType: 3, nextSibling: null, _v: dec(m[5]) };
      Object.defineProperty(text, 'nodeValue', { get() { return this._v; }, set(v) { log.text++; log.ops.push(['text', k, v]); this._v = v; } });
      const vSpan = { classList: { contains: (c) => c === 'v' }, firstChild: text };
      const el = { className: m[1], dataset: { k: m[2] }, isConnected: true, attrs: { title: dec(m[3]) }, label: m[4], lastChild: vSpan,
        setAttribute(n, v) { log.attr++; log.ops.push(['attr', k, n, v]); this.attrs[n] = v; },
        getBoundingClientRect() { log.layout++; return { width: 60, right: 0, left: 0 }; } };
      out.push(el);
    }
    return out;
  }
  const right = {
    get innerHTML() { return html; },
    set innerHTML(h) { log.html++; log.ops.push(['innerHTML']); for (const e of els) e.isConnected = false; html = h; els = parse(h); },
    querySelectorAll(sel) { return sel === '.st' ? els.slice() : []; },
    querySelector() { return null; },
    getBoundingClientRect() { log.layout++; return { width: els.reduce((w, e) => w + 20 + e.lastChild.firstChild._v.replace(/[0-9]/g, '0').length * 7, 0) }; },
    get children() { return els; },
  };
  return { right, log, els: () => els, reset() { log.html = log.text = log.attr = log.layout = 0; log.ops = []; } };
}

/* ---- the page ---------------------------------------------------------------------------------- */
function loadPage() {
  const src = fs.readFileSync(PAGE, 'utf8');
  const parts = [line(src, /^  const SV = /), line(src, /^  const statsFrame = /),
    grab(src, /^  function renderStats\(fromBar\) \{/, '  '), grab(src, /^  function tickStats\(\) \{/, '  '),
    grab(src, /^  mantle\.on\('topbar\.stats', \(ev\) => \{/, '  ')];
  const R = fakeRight();
  const calls = { under: 0, layoutLeft: 0, sizeBar: 0, statMenu: 0 };
  const handlers = {};
  const win = { innerWidth: 1536, TopbarStatsView: SV || undefined };
  const S = { focus: null, menu: null, stats: null, paused: null, note: null, open: null, rightKey: null };
  const ctx = {
    window: win, S, M, rightEl: R.right, console,
    esc: (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
    toolsHtml: () => '<button class="t glyph tool" data-tool="timer" title="Timer and stopwatch" aria-label="Timer and stopwatch"></button>',
    visibleWidth: () => win.innerWidth,
    sizeBar: () => { calls.sizeBar++; }, layoutLeft: () => { calls.layoutLeft++; }, underRendered: () => { calls.under++; },
    renderStatMenu: () => { calls.statMenu++; }, renewDetail: () => {},
    mantle: { on: (n, fn) => { handlers[n] = fn; } },
  };
  vm.createContext(ctx);
  vm.runInContext(parts.join('\n') + '\nthis.__render = renderStats;', ctx, { filename: PAGE });
  return { S, R, calls, win, emit: (ev) => handlers['topbar.stats'](ev), render: ctx.__render, found: parts.map((p) => !!p) };
}

const GB = 1073741824;
const sample = (o) => Object.assign({
  cpu: { pct: 3.2, cores: [1, 2, 3, 4] }, mem: { used: 7.9 * GB, total: 11.7 * GB }, gpu: { pct: 1.2, engines: [] },
  net: { down: 2048, up: 1024 }, ping: { state: 'ok', ms: 23, label: 'NA', server: 'Dallas' },
}, o || {});

try {
  const P = loadPage();
  check('page: the stats handler, renderStats and (new) tickStats were found in the page', P.found[2] && P.found[4], P.found);
  // the HTML is the old one, byte for byte
  const oldCell = (c, open) => `<button class="t st${c.why ? ' na' : ''}${c.warn ? ' hi' : ''}${open === c.key ? ' open' : ''}" data-k="${c.key}"` +
    ` title="${String(c.title || c.why || '').replace(/[&<>"]/g, (x) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[x]))}"><span class="k">${c.label}</span><span class="v">${c.value}</span></button>`;
  P.emit(sample());
  const want = M.statCells(sample()).map((c) => oldCell(c, null)).join('');
  check('page: the first sample draws the strip as before (same HTML, measured, colour under re-planned)',
    P.R.right.innerHTML.startsWith(want) && P.R.log.html === 1 && P.R.log.layout >= 1 && P.calls.under === 1, { html: P.R.right.innerHTML.slice(0, 200), log: P.R.log.html, u: P.calls.under });
  const els0 = P.R.els();

  // UNCHANGED: values that round the same
  P.R.reset(); const u0 = P.calls.under;
  P.emit(sample({ cpu: { pct: 3.4, cores: [5, 6, 7, 8] }, net: { down: 2100, up: 1030 } }));
  check('page: an unchanged sample touches no DOM (no innerHTML, no text, no attribute)', P.R.log.html === 0 && P.R.log.text === 0 && P.R.log.attr === 0, P.R.log.ops);
  check('page: an unchanged sample forces no layout and does not re-plan the colour under', P.R.log.layout === 0 && P.calls.under === u0, { layout: P.R.log.layout, under: P.calls.under - u0 });
  check('page: an unchanged sample keeps the very same buttons', P.R.els() === els0 || P.R.els().every((e, i) => e === els0[i]));

  // ONE VALUE CHANGED, same shape: CPU 3% -> 7%
  P.R.reset();
  P.emit(sample({ cpu: { pct: 7.1, cores: [1, 2, 3, 4] } }));
  const cpuEl = P.R.els().find((e) => e.dataset.k === 'cpu');
  check('page: a changed value patches only its own text node', P.R.log.html === 0 && P.R.log.text === 1 && P.R.log.attr === 0 &&
    P.R.log.ops[0][1] === 'cpu' && cpuEl.lastChild.firstChild.nodeValue === '7%', P.R.log.ops);
  check('page: a patched value forces no layout and no under re-plan', P.R.log.layout === 0 && P.calls.under === u0, { layout: P.R.log.layout, under: P.calls.under - u0 });

  // PING: its value and its tooltip move together (23 -> 25 ms)
  P.R.reset();
  P.emit(sample({ cpu: { pct: 7.1 }, ping: { state: 'ok', ms: 25, label: 'NA', server: 'Dallas' } }));
  const pingEl = P.R.els().find((e) => e.dataset.k === 'ping');
  check('page: the ping\'s text and tooltip are patched in place', P.R.log.html === 0 && P.R.log.text === 1 && P.R.log.attr === 1 &&
    pingEl.lastChild.firstChild.nodeValue === '25 ms' && pingEl.attrs.title === 'NA Dallas, 25 ms' && P.R.log.layout === 0, P.R.log.ops);

  // NEW WIDTH SHAPE: 7% -> 12% rebuilds, measures, re-plans
  P.R.reset(); let u1 = P.calls.under;
  P.emit(sample({ cpu: { pct: 12 }, ping: { state: 'ok', ms: 25, label: 'NA', server: 'Dallas' } }));
  check('page: a value of a new width shape (7% -> 12%) rebuilds, measures and re-plans the colour under',
    P.R.log.html === 1 && P.R.log.layout >= 1 && P.calls.under === u1 + 1, { log: P.R.log, under: P.calls.under - u1 });

  // NEW CLASS: a high ping (warn ink: the colour under plans it with the warn tokens)
  P.R.reset(); u1 = P.calls.under;
  P.emit(sample({ cpu: { pct: 12 }, ping: { state: 'ok', ms: 140, label: 'NA', server: 'Dallas' } }));
  check('page: a class change (a high ping, "hi") rebuilds and re-plans', P.R.log.html === 1 && P.calls.under === u1 + 1 &&
    / hi"/.test(P.R.right.innerHTML), P.R.log);
  // NO READING: "--" with its reason (class na)
  P.R.reset();
  P.emit(sample({ cpu: { pct: 12 }, gpu: { pct: null, reason: 'no GPU engine reported any work in the last reading' }, ping: { state: 'ok', ms: 140, label: 'NA', server: 'Dallas' } }));
  check('page: a stat losing its reading ("na", its reason as the tooltip) rebuilds', P.R.log.html === 1 &&
    /class="t st na" data-k="gpu" title="no GPU engine reported any work in the last reading"/.test(P.R.right.innerHTML), P.R.right.innerHTML.slice(0, 400));

  // AN OPEN DROPDOWN's "open" class
  P.R.reset();
  P.S.open = { stat: 'cpu' };
  P.emit(sample({ cpu: { pct: 12 }, ping: { state: 'ok', ms: 140, label: 'NA', server: 'Dallas' } }));
  check('page: a sample with a dropdown open still redraws the dropdown, and the "open" class is drawn', P.calls.statMenu >= 1 &&
    /class="t st open" data-k="cpu"/.test(P.R.right.innerHTML), P.R.right.innerHTML.slice(0, 200));
  P.R.reset();
  P.emit(sample({ cpu: { pct: 13 }, ping: { state: 'ok', ms: 140, label: 'NA', server: 'Dallas' } }));
  check('page: with the dropdown open, a same-shape value is still a text-node patch', P.R.log.html === 0 && P.R.log.text === 1, P.R.log.ops);
  P.S.open = null;

  // PAUSE and RESUME
  P.R.reset();
  P.emit({ paused: true, reason: 'the screen is locked' });
  check('page: a pause draws "stats paused" with its reason', P.R.log.html === 1 && /stats paused/.test(P.R.right.innerHTML) && /the screen is locked/.test(P.R.right.innerHTML));
  P.R.reset();
  P.emit(sample({ cpu: { pct: 13 }, ping: { state: 'ok', ms: 140, label: 'NA', server: 'Dallas' } }));
  check('page: the first sample after a pause redraws the cells', P.R.log.html === 1 && !/stats paused/.test(P.R.right.innerHTML) && /data-k="cpu"/.test(P.R.right.innerHTML));

  // A RESIZE whose event never came: caught by the next sample, without a layout read on the way
  P.R.reset(); const lay = P.calls.layoutLeft;
  P.win.innerWidth = 1280;
  P.emit(sample({ cpu: { pct: 13 }, ping: { state: 'ok', ms: 140, label: 'NA', server: 'Dallas' } }));
  check('page: a new window width on a sample re-renders and re-fits the left side', P.R.log.html === 1 && P.calls.layoutLeft === lay + 1, { log: P.R.log, lay: P.calls.layoutLeft - lay });

  // A NOTE shown since the last render (setNote renders itself; the sample must not lose it)
  P.S.note = 'System stats are unavailable: x';
  P.R.reset();
  P.emit(sample({ cpu: { pct: 13 }, ping: { state: 'ok', ms: 140, label: 'NA', server: 'Dallas' } }));
  check('page: a note that appeared since the last draw rebuilds the strip with it', P.R.log.html === 1 && /class="warn"/.test(P.R.right.innerHTML));
  P.R.reset();
  P.emit(sample({ cpu: { pct: 14 }, ping: { state: 'ok', ms: 140, label: 'NA', server: 'Dallas' } }));
  check('page: with the note up, a same-shape value is a text-node patch and the note stays', P.R.log.html === 0 && P.R.log.text === 1 && /class="warn"/.test(P.R.right.innerHTML));

  // ANOTHER RENDER replaced the buttons (a menu closing, timer.state): the next sample patches the NEW ones
  P.render(false);
  const fresh = P.R.els();
  P.R.reset();
  P.emit(sample({ cpu: { pct: 15 }, ping: { state: 'ok', ms: 140, label: 'NA', server: 'Dallas' } }));
  check('page: after any other full render the sample patches the new buttons, not the old ones', P.R.log.html === 0 && P.R.log.text === 1 &&
    fresh.find((e) => e.dataset.k === 'cpu').lastChild.firstChild.nodeValue === '15%', P.R.log.ops);

  // 60 quiet seconds at rest: the cost
  P.R.reset(); u1 = P.calls.under;
  for (let i = 0; i < 60; i++) P.emit(sample({ cpu: { pct: 15 + (i % 2) * 0.3 }, ping: { state: 'ok', ms: 140, label: 'NA', server: 'Dallas' } }));
  check('page: 60 samples that draw the same: 0 innerHTML, 0 layout reads, 0 under re-plans', P.R.log.html === 0 && P.R.log.layout === 0 && P.calls.under === u1, P.R.log);
} catch (e) { check('page: the page code ran', false, String(e && e.stack || e).slice(0, 300)); }

/* ---- stats-view.js on its own ------------------------------------------------------------------ */
if (check('stats-view.js loads', !!SV)) {
  check('shape: digits are one width, anything else is not', SV.shape('8.1/15.7 GB') === SV.shape('9.9/11.7 GB') && SV.shape('9%') !== SV.shape('10%') &&
    SV.shape('↓999 KB/s ↑0 KB/s') !== SV.shape('↓1.0 MB/s ↑0 KB/s') && SV.shape('--') !== SV.shape('4%'));
  const a = SV.views(M.statCells(sample()), null);
  check('diff: same views -> no patches', JSON.stringify(SV.diff(a, SV.views(M.statCells(sample()), null))) === '[]');
  check('diff: a cell gone -> rebuild', SV.diff(a, a.slice(1)) === null);
  check('diff: cells reordered -> rebuild', SV.diff(a, [a[1], a[0]].concat(a.slice(2))) === null);
  check('diff: a new label -> rebuild', SV.diff(a, a.map((v, i) => (i ? v : Object.assign({}, v, { label: 'Cpu' })))) === null);
  check('tick: a stale drawing (buttons detached) -> rebuild, nothing written', (() => {
    let wrote = 0;
    const els = a.map((v) => ({ dataset: { k: v.key }, isConnected: false, lastChild: { classList: { contains: () => true }, firstChild: { nodeType: 3, nextSibling: null, set nodeValue(x) { wrote++; } } }, setAttribute() { wrote++; } }));
    const next = a.map((v, i) => (i ? v : Object.assign({}, v, { value: '9%' })));
    return SV.tick({ views: a, els }, next) === 'rebuild' && wrote === 0;
  })());
  const g = SV.pushGate({ heartbeatMs: 5000 });
  check('gate: equal key inside the heartbeat is held, after it passes', g.pass('a', 0) && !g.pass('a', 4999) && g.pass('a', 5000) && g.pass('b', 5001));
  check('gate: a null key always passes and forgets', g.pass(null, 5002) && g.pass('b', 5003));
  check('gate: reset lets the same key through', (g.reset(), g.pass('b', 5004)));
}

/* ---- main --------------------------------------------------------------------------------------- */
function loadMain() {
  const src = fs.readFileSync(MAIN, 'utf8');
  const parts = [line(src, /^const SV = require\(/).replace(/require\(.*\)\);?/, 'SVMOD;'), line(src, /^    const statsGate = /),
    grab(src, /^    function onStats\(ev\) \{/, '    '), grab(src, /^    function statsFlush\(\) \{/, '    '), grab(src, /^    async function statsOn\(on, why\) \{/, '    ')];
  const pushes = [];
  let t = 1000;
  const S = { stepAside: false, peek: { shown: false }, menu: { open: false }, stats: null, stats_: { on: true, reason: null }, quiet: null };
  const ctx = {
    S, M, SVMOD: SV, console, pushes,
    Date: { now: () => t },
    push: (n, p) => { pushes.push([n, p]); },
    under: { kick() {} }, AP: { live: { decorate: (p) => p } },
    sc: async () => ({ ok: true }), ctx: { log() {} },
  };
  vm.createContext(ctx);
  vm.runInContext(parts.join('\n') + '\nthis.__on = onStats; this.__statsOn = statsOn; this.__flush = typeof statsFlush === "function" ? statsFlush : null;', ctx, { filename: MAIN });
  return { S, pushes, on: ctx.__on, statsOn: ctx.__statsOn, flush: ctx.__flush, tick: (ms) => { t += ms; }, found: parts.map((p) => !!p) };
}

(async () => {
  const W = loadMain();
  check('main: onStats and statsOn were found', W.found[2] && W.found[4], W.found);
  const stats = () => W.pushes.filter(([n]) => n === 'topbar.stats');
  W.on(sample());
  W.tick(1000); W.on(sample({ cpu: { pct: 3.4, cores: [9, 9, 9, 9] } }));
  W.tick(1000); W.on(sample({ cpu: { pct: 2.6 } }));
  check('main: samples the bar draws the same (3.2, 3.4, 2.6 -> "3%") are pushed once', stats().length === 1, stats().length);
  check('main: main still keeps the newest sample (hello hands it to a reloaded page)', W.S.stats && W.S.stats.cpu.pct === 2.6);
  W.tick(1000); W.on(sample({ cpu: { pct: 3.6 } }));
  check('main: a shown value that changed (3% -> 4%) is pushed at once', stats().length === 2 && stats()[1][1].cpu.pct === 3.6, stats().length);
  W.tick(1000); W.on(sample({ cpu: { pct: 3.6 }, ping: { state: 'ok', ms: 24, label: 'NA', server: 'Dallas' } }));
  check('main: a ping that moved by 1 ms is pushed', stats().length === 3);
  W.tick(1000); W.on(sample({ cpu: { pct: 3.6 }, ping: { state: 'ok', ms: 24, label: 'NA', server: 'Dallas' } }));
  W.tick(1000); W.on(sample({ cpu: { pct: 3.6 }, gpu: { pct: null, reason: 'the GPU counters could not be read this time' }, ping: { state: 'ok', ms: 24, label: 'NA', server: 'Dallas' } }));
  check('main: a stat losing its reading (a new reason) is pushed', stats().length === 4 && stats()[3][1].gpu.pct === null, stats().length);

  // heartbeat: 12 identical samples a second apart -> 3 pushes (0, 5, 10 s), the page never more than 5 s behind
  const base = stats().length;
  const same = sample({ cpu: { pct: 50 } });
  let maxGap = 0, lastPush = null;
  for (let i = 0; i < 12; i++) {
    W.tick(1000); const n0 = stats().length; W.on(same);
    if (stats().length > n0) { if (lastPush != null) maxGap = Math.max(maxGap, i - lastPush); lastPush = i; }
  }
  check('main: a heartbeat: 12 equal samples are 3 pushes, never more than 5 s apart', stats().length - base === 3 && maxGap === 5, { n: stats().length - base, maxGap });

  // pause and resume: both reach the page, even when the resumed sample equals the last one pushed
  const p0 = stats().length;
  W.tick(1000); W.on({ paused: true, reason: 'the session is locked' });
  W.tick(1000); W.on(same);
  check('main: a pause is pushed, and the next sample (equal to the last) is pushed too', stats().length === p0 + 2 && stats()[p0][1].paused === true && !stats()[p0 + 1][1].paused, stats().slice(p0).map(([, p]) => !!p.paused));
  // the sampler dying is a pause with its reason: always pushed (a real stall stays visible)
  W.tick(500); W.on({ paused: true, reason: 'the stats sampler stopped: InvalidOperationException: x' });
  check('main: "the stats sampler stopped" reaches the page', stats().length === p0 + 3 && /sampler stopped/.test(stats()[p0 + 2][1].reason));
  W.tick(500); W.on(same);
  // statsOn(false) pushes "paused" itself; the next equal sample must still reach the page
  const s0 = stats().length;
  await W.statsOn(false, 'the top bar is hidden by hand');
  await W.statsOn(true);
  W.tick(1000); W.on(same);
  check('main: after statsOn(false) the first sample, though equal to the last pushed, is pushed', stats().length === s0 + 2 && stats()[s0][1].paused && !stats()[s0 + 1][1].paused, stats().slice(s0).map(([, p]) => !!p.paused));

  // detail samples and an open dropdown: every sample
  const d0 = stats().length;
  W.tick(1000); W.on(Object.assign(sample({ cpu: { pct: 50, top: [] } }), { detail: 'cpu' }));
  W.tick(1000); W.on(Object.assign(sample({ cpu: { pct: 50, top: [] } }), { detail: 'cpu' }));
  check('main: detail samples (a dropdown\'s top processes) are always pushed', stats().length === d0 + 2);
  W.S.menu.open = true;
  W.tick(1000); W.on(same); W.tick(1000); W.on(same);
  check('main: while a dropdown is open every sample is pushed (its rows move)', stats().length === d0 + 4);
  W.S.menu.open = false;

  // a dropdown opening after held samples: the newest one is flushed to the page at once
  W.tick(1000); W.on(same);
  const f0 = stats().length;
  W.tick(1000); W.on(sample({ cpu: { pct: 50, cores: [77, 77, 77, 77] } }));   // held: the bar draws the same
  const held = stats().length === f0;
  if (W.flush) W.flush();
  check('main: a dropdown opening pushes the newest held sample (its cores), once', held && stats().length === f0 + 1 && stats()[f0][1].cpu.cores[0] === 77,
    { held, n: stats().length - f0 });
  if (W.flush) W.flush();
  check('main: nothing held, nothing flushed', stats().length === f0 + 1);

  console.log(`TOPBAR STATS VIEW: ${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log('  FAIL ' + f);
  process.exit(failures.length ? 1 : 0);
})().catch((e) => {
  console.log(`TOPBAR STATS VIEW: ${passed} passed, ${failures.length + 1} failed`);
  for (const f of failures) console.log('  FAIL ' + f);
  console.log('  FAIL threw: ' + (e && e.stack || e));
  process.exit(1);
});
