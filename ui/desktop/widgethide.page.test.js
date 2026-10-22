require('../../tools/dev-env.js').lowcpu();
/* widgethide.page.test.js - the desktop widgets stepping aside under a window, in the REAL page
 * (ui/desktop/index.html + desktop.js + desktop.css) in headless Chromium over file://. Never
 * Electron, never the sidecar, nothing on the user's screen.
 *
 * An init script puts a FAKE window.mantle in place before the page's scripts (so mock-mantle.js
 * stands aside, as it does for the real preload), records every call, and lets this file play
 * lib/features/widgethide.js by emitting 'widgethide.cover'.
 *
 * Checks: the page reports its four panes (keys, CSS px rects, a pane not drawn at zero size) on
 * load, again when a pane changes size and when a resize moves them, and not again when nothing
 * moved; a covered pane fades out on the exit timing (opacity 0, visibility hidden, no clicks) and
 * an uncovered one comes back on the entrance timing; per widget; no layout shift (every pane's
 * rect identical covered vs not); on:false and a missing answer show everything (fail open); a
 * rejected report does not break the page and is retried on the next change; light and dark.
 *
 *   node ui/desktop/widgethide.page.test.js
 * Prints "WIDGETHIDE PAGE TEST: n passed, m failed"; exits 1 if anything failed.
 */
'use strict';
const path = require('path');
const fs = require('fs');

const PAGE = 'file:///' + path.resolve(__dirname, 'index.html').replace(/\\/g, '/');

let passed = 0;
const failures = [];
const check = (name, ok, detail) => { if (ok) passed++; else failures.push(`  FAIL ${name}${detail !== undefined ? ` (${String(detail).slice(0, 300)})` : ''}`); return ok; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FAKE = `
  (function () {
    var L = {};
    window.__calls = [];
    window.__reject = {};
    window.mantle = {
      on: function (name, cb) { (L[name] = L[name] || []).push(cb); return function () {}; },
      call: function (name, args) {
        window.__calls.push({ name: name, args: args === undefined ? null : JSON.parse(JSON.stringify(args)) });
        if (window.__reject[name]) return Promise.reject(new Error('no answer'));
        if (name === 'sys.stats') return Promise.resolve({ cpu: 12, mem: { used: 8e9, total: 16e9 } });
        if (name === 'net.probe') return Promise.resolve({ ok: false, reason: 'refused' });
        return Promise.resolve({ ok: true });
      },
    };
    window.__emit = function (name, p) { (L[name] || []).forEach(function (cb) { cb(p); }); };
  })();
`;

const reports = (p) => p.evaluate(() => window.__calls.filter((c) => c.name === 'widgethide.rects').map((c) => c.args));
const look = (p) => p.evaluate(() => Array.from(document.querySelectorAll('.pane[data-cover]')).map((el) => {
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  return { key: el.dataset.cover, covered: el.classList.contains('covered'), opacity: Number(cs.opacity), visibility: cs.visibility, pe: cs.pointerEvents,
    dur: cs.transitionDuration, rect: [r.left, r.top, r.width, r.height].map(Math.round).join(',') };
}));
const byKey = (arr) => Object.fromEntries(arr.map((x) => [x.key, x]));

async function run(browser, theme) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, colorScheme: theme });
  await ctx.addInitScript(FAKE);
  await ctx.addInitScript((t) => { try { document.documentElement.setAttribute('data-theme', t); } catch (_) { /* later */ } }, theme);
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(PAGE);
  await sleep(500);

  // ---- the report
  let reps = await reports(p);
  const first = reps[0];
  check(`${theme}: the page reports its panes once on load (load + first resize coalesced)`, reps.length === 1 && first && typeof first.why === "string", JSON.stringify(reps).slice(0, 200));
  const keys = first ? first.panes.map((x) => x.key).join() : '';
  check(`${theme}: four panes, keyed clock/stats/mc/strip`, keys === 'clock,stats,mc,strip', keys);
  const P = first ? byKey(first.panes) : {};
  check(`${theme}: the clock is reported at its CSS position (left 44, top 38, 420 wide)`, P.clock && P.clock.x === 44 && P.clock.y === 38 && P.clock.w === 420 && P.clock.h > 40, JSON.stringify(P.clock));
  const stripBox = await p.evaluate(() => { const r = document.getElementById("strip").getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; });
  check(`${theme}: the strip is reported at the size it is drawn`, P.strip && P.strip.w === stripBox.w && P.strip.h === stripBox.h, JSON.stringify([P.strip, stripBox]));
  check(`${theme}: nothing to report on load = the strip is not drawn and reported at zero size (widgethide skips it)`, P.strip && P.strip.w === 0 && P.strip.h === 0 && stripBox.w === 0, JSON.stringify(P.strip));

  await sleep(400);
  check(`${theme}: no second report while nothing moved`, (await reports(p)).length === 1, (await reports(p)).length);

  // ---- cover the clock only
  const before = byKey(await look(p));
  await p.evaluate(() => window.__emit('widgethide.cover', { on: true, covered: { clock: true, stats: false, mc: false, strip: false }, by: { clock: 'Notepad' }, reason: null }));
  await sleep(60);
  let mid = byKey(await look(p));
  check(`${theme}: covering starts on the exit timing (260ms)`, mid.clock.covered && mid.clock.dur.split(',')[0].trim() === '0.26s', mid.clock.dur);
  check(`${theme}: hidden panes take no clicks at once`, mid.clock.pe === 'none', mid.clock.pe);
  await sleep(450);
  let L = byKey(await look(p));
  check(`${theme}: covered clock is fully faded and hidden`, L.clock.opacity === 0 && L.clock.visibility === 'hidden', JSON.stringify(L.clock));
  check(`${theme}: the others stay up (per widget)`, L.stats.opacity === 1 && L.stats.visibility === 'visible' && L.mc.opacity === 1 && L.stats.pe !== 'none', JSON.stringify([L.stats, L.mc]));
  check(`${theme}: no layout shift: every pane keeps its exact box`, ['clock', 'stats', 'mc', 'strip'].every((k) => L[k].rect === before[k].rect), JSON.stringify([before, L].map((o) => Object.values(o).map((x) => x.rect))));
  check(`${theme}: no new report from a cover change (boxes did not move)`, (await reports(p)).length === 1);
  const hit = await p.evaluate(() => { const r = document.querySelector('.pane.time').getBoundingClientRect(); const el = document.elementFromPoint(r.left + 20, r.top + 20); return el ? (el.closest('.pane') ? 'pane' : el.tagName) : 'none'; });
  check(`${theme}: hit-testing passes through the hidden clock`, hit !== 'pane', hit);

  // ---- uncover
  await p.evaluate(() => window.__emit('widgethide.cover', { on: true, covered: { clock: false }, by: {}, reason: null }));
  await sleep(60);
  mid = byKey(await look(p));
  check(`${theme}: coming back starts on the entrance timing (560ms) and is visible at once`, !mid.clock.covered && mid.clock.dur.split(',')[0].trim() === '0.56s' && mid.clock.visibility === 'visible' && mid.clock.opacity < 1, JSON.stringify(mid.clock));
  await sleep(700);
  L = byKey(await look(p));
  check(`${theme}: uncovered clock is fully back`, L.clock.opacity === 1 && L.clock.visibility === 'visible' && L.clock.pe !== 'none', JSON.stringify(L.clock));

  // ---- a maximised window, then the switch off / no answer = fail open
  await p.evaluate(() => window.__emit('widgethide.cover', { on: true, covered: { clock: true, stats: true, mc: true, strip: true }, by: {}, reason: null }));
  await sleep(450);
  L = byKey(await look(p));
  check(`${theme}: a window over everything hides every widget`, Object.values(L).every((x) => x.covered), JSON.stringify(Object.values(L).map((x) => x.covered)));
  await p.evaluate(() => window.__emit('widgethide.cover', { on: false, covered: { clock: true }, by: {}, reason: 'switched off' }));
  await sleep(50);
  L = byKey(await look(p));
  check(`${theme}: switched off shows every widget even if covered says otherwise`, Object.values(L).every((x) => !x.covered));
  await p.evaluate(() => window.__emit('widgethide.cover', { on: true, covered: { clock: true }, by: {} }));
  await sleep(30);
  await p.evaluate(() => window.__emit('widgethide.cover', null));
  await sleep(30);
  L = byKey(await look(p));
  check(`${theme}: an empty answer shows every widget (fail open)`, Object.values(L).every((x) => !x.covered));

  // ---- the "Needs attention" strip, through the page's real path (a 'state' push -> renderState):
  // nothing to report = not drawn, no space, zero rect; one problem = drawn at its real size; back
  // to nothing = gone again. (Before 2026-10-10 the strip's display:flex beat [hidden] and an empty
  // strip still drew as an empty pane.)
  const addRow = () => p.evaluate(() => { const li = document.createElement('li'); li.textContent = 'A problem'; document.getElementById('strip-list').appendChild(li); });
  const lastStrip = async () => { const r = await reports(p); return { n: r.length, s: r.length ? byKey(r[r.length - 1].panes).strip : null, panes: r.length ? r[r.length - 1].panes : [] }; };
  const stripLook = () => p.evaluate(() => {
    const st = document.getElementById('strip'), cl = document.querySelector('.cluster');
    const panes = Array.from(cl.children).filter((el) => el !== st && getComputedStyle(el).display !== 'none');
    const r = st.getBoundingClientRect(), c = cl.getBoundingClientRect();
    return { hidden: st.hidden, display: getComputedStyle(st).display, w: Math.round(r.width), h: Math.round(r.height),
      rows: st.querySelectorAll('.strip-list li').length, clusterBottom: Math.round(c.bottom),
      lastOtherBottom: Math.round(Math.max.apply(null, panes.map((el) => el.getBoundingClientRect().bottom))) };
  });
  const NONE = { mode: 'live', features: {} };
  const ONE = { mode: 'live', features: { demo: { on: true, ok: false, label: 'Demo feature', reason: 'not working for a test' } } };
  await p.evaluate((s) => window.__emit('state', s), NONE);
  await sleep(400);
  let e0 = await stripLook();
  check(`${theme}: strip: empty state = hidden and not drawn`, e0.hidden && e0.display === 'none' && e0.w === 0 && e0.h === 0, JSON.stringify(e0));
  check(`${theme}: strip: empty takes no space (the cluster ends at the last other pane, no trailing gap)`, e0.clusterBottom === e0.lastOtherBottom, JSON.stringify(e0));
  let s1 = await lastStrip();
  check(`${theme}: strip: empty reports a zero rect (skipped by widgethide)`, s1.s && s1.s.w === 0 && s1.s.h === 0, JSON.stringify(s1.s));
  await p.evaluate((s) => window.__emit('state', s), ONE);
  await sleep(400);
  const e1 = await stripLook();
  check(`${theme}: strip: one problem = shown with one row`, !e1.hidden && e1.display === 'flex' && e1.rows === 1 && e1.w === 420 && e1.h > 20, JSON.stringify(e1));
  check(`${theme}: strip: shown takes its place below the other panes`, e1.clusterBottom > e0.clusterBottom, JSON.stringify([e0.clusterBottom, e1.clusterBottom]));
  let s2 = await lastStrip();
  check(`${theme}: strip: appearing is reported once with its real size`, s2.n === s1.n + 1 && s2.s.w === 420 && s2.s.h === e1.h, JSON.stringify([s1.n, s2.n, s2.s]));
  check(`${theme}: strip: the other panes are still reported with real sizes`, ['clock', 'stats', 'mc'].every((k) => { const x = byKey(s2.panes)[k]; return x && x.w > 0 && x.h > 0; }), JSON.stringify(s2.panes));
  await p.evaluate((s) => window.__emit('state', s), NONE);
  await sleep(400);
  const e2 = await stripLook();
  const s1b = await lastStrip();
  check(`${theme}: strip: back to empty = hidden again, no space`, e2.hidden && e2.display === 'none' && e2.rows === 0 && e2.clusterBottom === e2.lastOtherBottom, JSON.stringify(e2));
  check(`${theme}: strip: hiding is reported once, strip zero, the others still real`, s1b.n === s2.n + 1 && s1b.s.w === 0 && s1b.s.h === 0 && ['clock', 'stats', 'mc'].every((k) => byKey(s1b.panes)[k].w > 0), JSON.stringify(s1b.panes));
  // a cover answer while the strip is hidden still applies to the others
  await p.evaluate(() => window.__emit('widgethide.cover', { on: true, covered: { clock: true, strip: false }, by: {}, reason: null }));
  await sleep(450);
  L = byKey(await look(p));
  check(`${theme}: strip hidden: covering still works for the other panes`, L.clock.covered && L.clock.opacity === 0 && !L.stats.covered && L.stats.opacity === 1, JSON.stringify([L.clock, L.stats]));
  await p.evaluate(() => window.__emit('widgethide.cover', { on: true, covered: {}, by: {}, reason: null }));
  await sleep(700);
  // and up again for the rest of this run (later checks grow it row by row)
  await p.evaluate((s) => window.__emit('state', s), ONE);
  await sleep(400);
  s2 = await lastStrip();
  check(`${theme}: strip: shown again with its real size`, s2.n === s1b.n + 1 && s2.s.w === 420 && s2.s.h > 20, JSON.stringify(s2.s));

  // ---- a window resize that moves the widgets (the cluster's small-screen rule) is reported
  await p.setViewportSize({ width: 1200, height: 760 });
  await sleep(800);
  const s3 = await lastStrip();
  const moved = (await reports(p)).slice(-1)[0];
  check(`${theme}: a resize that moved the widgets is reported once, at their new place`, s3.n === s2.n + 1 && byKey(moved.panes).clock.x !== 44, JSON.stringify(byKey(moved.panes).clock));
  await p.setViewportSize({ width: 1201, height: 760 });
  await sleep(500);
  check(`${theme}: a resize that moves nothing sends nothing`, (await lastStrip()).n === s3.n);
  s2 = s3;

  // ---- a refused report is sent again on the next change; the page keeps working
  await p.evaluate(() => { window.__reject['widgethide.rects'] = true; });
  await addRow();
  await sleep(400);
  const refused = await lastStrip();
  await p.evaluate(() => { window.__reject['widgethide.rects'] = false; });
  await addRow();
  await sleep(400);
  const again = await lastStrip();
  check(`${theme}: a refused report is sent again on the next change, with the new size`, refused.n === s2.n + 1 && again.n === refused.n + 1 && again.s.h > refused.s.h, JSON.stringify([s2, refused, again]));
  await p.evaluate(() => window.__emit('widgethide.cover', { on: true, covered: { strip: true }, by: {}, reason: null }));
  await sleep(450);
  L = byKey(await look(p));
  check(`${theme}: after a refused report the page still wears answers`, L.strip.covered && L.strip.opacity === 0 && !L.clock.covered, JSON.stringify(L.strip));
  check(`${theme}: no page errors`, errors.length === 0, errors.join(' | '));
  await ctx.close();
}

(async () => {
  let browser = null;
  try {
    const { chromium } = require('../../tools/dev-env.js').playwright();
    browser = await require('../settings/test-browser.js').launch(chromium, { timeout: 0, headless: true });
    await run(browser, 'light');
    await run(browser, 'dark');
  } catch (e) {
    failures.push(`  FAIL the run finished (${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e})`);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
  console.log(`WIDGETHIDE PAGE TEST: ${passed} passed, ${failures.length} failed`);
  if (failures.length) console.log(failures.join('\n'));
  process.exit(failures.length ? 1 : 0);
})();
