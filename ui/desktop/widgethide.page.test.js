require('C:/Users/user/dev-tools/tools/lowcpu.js');
/* widgethide.page.test.js - the desktop widgets stepping aside under a window, in the REAL page
 * (ui/desktop/index.html + desktop.js + desktop.css) in headless Chromium over file://. Never
 * Electron, never the sidecar, nothing on Owen's screen.
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

const CHROME = (() => {
  const base = 'C:/Users/user/AppData/Local/ms-playwright';
  try {
    for (const d of fs.readdirSync(base).filter((n) => /^chromium-[0-9]+$/.test(n)).sort((x, y) => +y.slice(9) - +x.slice(9))) {
      const p = base + '/' + d + '/chrome-win64/chrome.exe';
      if (fs.existsSync(p)) return p;
    }
  } catch (_) { /* launch without a path */ }
  return null;
})();
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

  // ---- the strip hides -> zero size; appears -> its real size
  const addRow = () => p.evaluate(() => { const li = document.createElement('li'); li.textContent = 'A problem'; document.getElementById('strip-list').appendChild(li); });
  const lastStrip = async () => { const r = await reports(p); return { n: r.length, s: r.length ? byKey(r[r.length - 1].panes).strip : null }; };
  // (the strip's own display:flex beats [hidden], so a "hidden" strip still draws as a pane today;
  //  a pane that is really not drawn is simulated with display:none)
  await p.evaluate(() => { document.getElementById('strip').style.display = 'none'; });
  await sleep(400);
  let s1 = await lastStrip();
  check(`${theme}: a pane that is not drawn is reported at zero size`, s1.s && s1.s.w === 0 && s1.s.h === 0, JSON.stringify(s1));
  await p.evaluate(() => { document.getElementById('strip').style.display = ''; });
  await addRow();
  await sleep(400);
  let s2 = await lastStrip();
  check(`${theme}: the strip coming back is reported with its real size`, s2.n === s1.n + 1 && s2.s.w === 420 && s2.s.h > 20, JSON.stringify(s2));

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
    const { chromium } = require('C:/Users/user/other-app/node_modules/playwright-core');
    browser = await chromium.launch({ timeout: 0, executablePath: CHROME || undefined, headless: true });
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
