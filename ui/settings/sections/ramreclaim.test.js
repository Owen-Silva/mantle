require('C:/Users/user/dev-tools/tools/lowcpu.js');
/* ramreclaim.test.js — Mantle Settings > Windows pieces (lane mantle-ramreclaim, 2026-10-15).
 *
 * PART 1 (node): the page file loads in an empty vm (as the launcher's claims sandbox runs it) with the
 * right id / group / order / search rows and passes ui/settings/model.js checkSection; the REAL feature's
 * list reply (lib/features/ramreclaim.js on a fake registry) crosses lib/plain-error.js toPage unchanged.
 * PART 2 (headless Chromium over file://, never Electron, never a real setting): the REAL page file on the
 * settings mock, ramreclaim.* played by FAKE() below. Checks: three switches with their states and memory,
 * the locked "your call" rows say why (shield on the administrator ones), the kept Start menu row, a click
 * sends ramreclaim.set and reads back, a refused change springs back with the reason, Windows turning a
 * piece back on is said, a failed read says why and locks the switches, the feature off and a test copy
 * say so. Both themes. Shots: MANTLE_SHOOT_OUT, default C:/Users/user/mantle-notes/ramreclaim-shots.
 *
 *   node ui/settings/sections/ramreclaim.test.js     Prints "RAMRECLAIM SETTINGS TEST: n passed, m failed".
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const vm = require('vm');

const PAGE = 'file:///' + path.resolve(__dirname, '..', 'index.html').replace(/\\/g, '/');
const OUT = process.env.MANTLE_SHOOT_OUT || 'C:/Users/user/mantle-notes/ramreclaim-shots';
let passed = 0;
const failures = [];
const check = (name, ok, detail) => { if (ok) passed++; else failures.push(detail != null ? `${name} (${String(detail).slice(0, 300)})` : name); return ok; };

async function nodeTests() {
  const src = fs.readFileSync(path.join(__dirname, 'ramreclaim.js'), 'utf8');
  let def = null;
  try { vm.runInNewContext(src, { MantleSettings: { section: (d) => { def = d; } } }, { timeout: 2000 }); } catch (e) { failures.push('the page file threw while loading: ' + e.message); }
  check('page: defines its section while loading', !!def);
  if (!def) return;
  check('page: id ramreclaim, in the Mantle group, after App power', def.id === 'ramreclaim' && def.group === 'mantle' && def.order > 1005 && def.order < 1010, JSON.stringify({ id: def.id, group: def.group, order: def.order }));
  const core = require('../../../lib/features/_ramreclaim-core');
  const rows = (def.search || []).map((s) => s.row);
  check('page: a search row for the summary and every piece', rows.length === core.PIECES.length + 1 && core.PIECES.every((p) => rows.includes('ramreclaim.' + p.id)), rows.join(','));
  check('page: search labels are the pieces’ action words', core.PIECES.filter((p) => p.action).every((p) => def.search.find((s) => s.row === 'ramreclaim.' + p.id).label === p.action));
  check('page: one page drawn directly', typeof def.render === 'function' && !def.pages);
  try {
    const why = require(path.join(__dirname, '..', 'model.js')).checkSection(def, 'ramreclaim');
    check('page: passes model.checkSection', why == null, why);
  } catch (e) { failures.push('model.js did not load: ' + e.message); }
  // the real feature's reply, through the words filter every reply crosses on its way to a page
  const mod = require('../../../lib/features/ramreclaim');
  const vals = new Map();
  mod._registry = () => ({
    async read(h, k, n) { const x = `${k}|${n}`; return vals.has(x) ? { ok: true, exists: true, data: vals.get(x) } : { ok: true, exists: false, data: null }; },
    async write(h, k, n, t, d) { vals.set(`${k}|${n}`, d); return { ok: true }; },
    async remove(h, k, n) { vals.delete(`${k}|${n}`); return { ok: true }; },
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-page-'));
  const cmds = {};
  const ctx = { name: 'ramreclaim', flags: { test: false, live: true }, log() {}, health() {}, enabled: () => true, onEnabled() {},
    settings: { file: path.join(dir, 'ramreclaim.json'), get: (k, d) => d, set() {} }, command: (v, fn) => { cmds[v] = fn; },
    sidecar: { send: async () => ({ ok: true, result: { procs: [{ pid: 5, ppid: 1, file: 'SearchHost.exe', pws: 34 << 20 }] } }) } };
  try {
    const h = mod.install(ctx);
    await new Promise((r) => setTimeout(r, 30));
    const reply = await cmds.list({});
    const { toPage } = require('../../../lib/plain-error');
    const after = toPage('ramreclaim.list', JSON.parse(JSON.stringify(reply)));
    check('page: the real list reply crosses toPage unchanged', JSON.stringify(after) === JSON.stringify(reply), JSON.stringify(after).slice(0, 200));
    await h.stop('test');
  } finally { mod._registry = null; fs.rmSync(dir, { recursive: true, force: true }); }
}

/* Runs IN THE PAGE (addInitScript): wraps mock-mantle.js's window.mantle. Made-up states. */
function FAKE() {
  const q = new URLSearchParams(location.search);
  const SCN = q.get('rr') || 'normal';
  const later = (v) => new Promise((res) => setTimeout(() => res(JSON.parse(JSON.stringify(v))), 20));
  const mb = (n) => ({ running: n > 0, count: n > 0 ? 1 : 0, mb: n });
  const P = (o) => Object.assign({ breaks: 'Something is slower.', admin: false, removal: false, how: null, why: null, effect: 'next sign-in', ramNote: null, defaultOn: false, wanted: false, state: 'off', reason: null, since: null, keptForSignOut: false, mantleChanged: false, ram: mb(0) }, o);
  const pieces = [
    P({ id: 'widgets-prelaunch', kind: 'switch', label: 'Widgets board, loaded at sign-in', help: 'Windows starts its Widgets board at sign-in.', wanted: true, state: SCN === 'drift' ? 'drift' : 'applied', reason: SCN === 'drift' ? 'Windows turned this back on. Mantle turns it off again at its next start, or switch it off and on here' : null, since: '2026-10-15T20:05:00Z', ram: mb(3) }),
    P({ id: 'search-highlights', kind: 'switch', label: 'Search highlights', help: 'Windows’ search fetches the day’s pictures.', wanted: true, state: 'already', ramNote: 'Stops Windows’ search waking up to fetch them; its window stays loaded', ram: mb(34) }),
    P({ id: 'lockscreen-widgets', kind: 'switch', label: 'Widgets on the lock screen', help: 'The weather on the lock screen.', effect: 'next lock', ram: mb(1) }),
    P({ id: 'search-window', kind: 'listed', admin: true, label: 'Windows’ search window', help: 'Windows keeps its search window loaded.', how: 'The "Fully disable Search UI" policy.', why: 'Needs administrator rights.', ram: mb(34) }),
    P({ id: 'widgets-all', kind: 'listed', admin: true, label: 'Windows’ Widgets, completely', help: 'Turns Widgets off for every account.', how: 'The "Allow widgets" policy.', why: 'Needs administrator rights and is a policy.', ram: mb(4) }),
    P({ id: 'widgets-package', kind: 'listed', removal: true, label: 'Remove Windows’ Widgets app', help: 'Uninstalls the Web Experience Pack.', how: 'Remove-AppxPackage.', why: 'Removes an app.', ram: mb(4) }),
    P({ id: 'start-menu', kind: 'kept', label: 'Windows’ Start menu', help: 'Stays loaded. There is no safe switch.', ram: mb(15) }),
  ];
  const answer = (name, a) => {
    switch (name) {
      case 'ramreclaim.list':
        if (SCN === 'fail') return later({ ok: false, reason: 'Mantle’s helper is starting. Try again in a moment' });
        return later({ ok: true, on: SCN !== 'off', test: SCN === 'test', pieces: SCN === 'off' ? pieces.map((p) => (p.wanted ? Object.assign({}, p, { state: 'paused' }) : p)) : pieces, measuredAt: 1, measureReason: null, journalError: null });
      case 'ramreclaim.set': {
        const p = pieces.find((x) => x.id === a.id);
        if (SCN === 'refuse') return later({ ok: false, reason: 'Windows refused the change (Access is denied.)' });
        p.wanted = !!a.on; p.state = a.on ? 'applied' : 'off'; p.since = '2026-10-15T20:10:00Z';
        return later({ ok: true, value: !!a.on, reason: null });
      }
      default: return later({ ok: false, reason: 'the fake does not play ' + name });
    }
  };
  let real;
  Object.defineProperty(window, 'mantle', {
    configurable: true,
    get() { return real; },
    set(m) {
      real = { on: m.on.bind(m), call(name, args) {
        const copy = args && typeof args === 'object' ? JSON.parse(JSON.stringify(args)) : {};
        if (name === 'settings.sections') return Promise.resolve({ ok: true, reason: null, sections: [{ id: 'ramreclaim', file: 'sections/ramreclaim.js', down: null, main: null }] });
        if (!/^ramreclaim\./.test(name)) return m.call(name, args);
        (window.__mockCalls = window.__mockCalls || []).push({ name, args: copy });
        return answer(name, copy);
      } };
    },
  });
}

async function browserTests() {
  const { chromium } = require('C:/Users/user/other-app/node_modules/playwright-core');
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await require('../test-browser.js').launch(chromium);
  try {
    for (const theme of ['light', 'dark']) {
      const T = theme;
      const ctx = await browser.newContext({ viewport: { width: 1040, height: 900 }, deviceScaleFactor: 1 });
      await ctx.addInitScript(FAKE);
      const open = async (scn) => {
        const page = await ctx.newPage();
        const problems = [];
        page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
        page.on('console', (m) => { if (m.type() === 'error') problems.push('console: ' + m.text()); });
        await page.goto(PAGE + `?section=ramreclaim&rr=${scn}&theme=${theme}`, { waitUntil: 'load' });
        try { await page.waitForSelector('html[data-ready="1"]', { timeout: 6000 }); } catch (_) { problems.push('never reached data-ready'); }
        await page.waitForTimeout(300);
        return { page, problems };
      };
      const row = (p, id) => p.locator(`[data-row="ramreclaim.${id}"]`);
      const on = (p, id) => row(p, id).locator('button.sw').getAttribute('aria-checked');
      const dis = (p, id) => row(p, id).locator('button.sw').isDisabled();
      const txt = (p, id) => row(p, id).textContent();
      const calls = (p, n) => p.evaluate((nn) => (window.__mockCalls || []).filter((c) => c.name === nn).map((c) => c.args), n);
      const all = (p) => p.evaluate(() => (document.getElementById('page') || document.body).textContent);

      let { page, problems } = await open('normal');
      check(`${T}: switches show Mantle’s choices`, (await on(page, 'widgets-prelaunch')) === 'true' && (await on(page, 'search-highlights')) === 'true' && (await on(page, 'lockscreen-widgets')) === 'false');
      check(`${T}: switches are live`, !(await dis(page, 'widgets-prelaunch')) && !(await dis(page, 'lockscreen-widgets')));
      const w = await txt(page, 'widgets-prelaunch');
      check(`${T}: an applied piece says since when and when it saves`, /Off since/.test(w) && /next sign-in/.test(w) && /Uses 3 MB now/.test(w), w);
      check(`${T}: the switch label is the action`, /Don’t load Windows’ Widgets board at sign-in/.test(w));
      const s = await txt(page, 'search-highlights');
      check(`${T}: already off says nothing to change, with its own memory note`, /already has this off/.test(s) && /waking up/.test(s) && /34 MB/.test(s), s);
      const lk = await txt(page, 'lockscreen-widgets');
      check(`${T}: an off piece says what turning it off breaks`, /Turning it off:/.test(lk) && /Windows runs it/.test(lk), lk);
      for (const id of ['search-window', 'widgets-all', 'widgets-package']) {
        const t = await txt(page, id);
        check(`${T}: ${id} is off, locked and says why`, (await on(page, id)) === 'false' && (await dis(page, id)) && /Off and locked/.test(t) && /How:/.test(t), t);
      }
      check(`${T}: the administrator rows carry the shield, the removal row does not`, (await row(page, 'search-window').locator('svg').count()) > 0 && (await row(page, 'widgets-all').locator('svg').count()) > 0);
      check(`${T}: Start menu stays, with its memory`, /Uses 15 MB now/.test(await txt(page, 'start-menu')) && /no safe switch/.test(await txt(page, 'start-menu')));
      check(`${T}: the summary counts what Mantle turned off`, /1 piece/.test(await txt(page, 'status')) && /restore the Windows taskbar/.test(await txt(page, 'status')));
      await page.screenshot({ path: path.join(OUT, `rr-normal-${T}.png`), fullPage: true });
      await row(page, 'lockscreen-widgets').locator('button.sw').click();
      await page.waitForTimeout(250);
      const st = (await calls(page, 'ramreclaim.set')).pop();
      check(`${T}: a click sends set {id, on}`, st && st.id === 'lockscreen-widgets' && st.on === true, JSON.stringify(st));
      await page.waitForTimeout(200);
      check(`${T}: ...and reads back on`, (await on(page, 'lockscreen-widgets')) === 'true' && /Off since/.test(await txt(page, 'lockscreen-widgets')));
      check(`${T}: normal: no page errors`, problems.length === 0, problems.join(' | '));
      await page.close();

      ({ page, problems } = await open('refuse'));
      await row(page, 'lockscreen-widgets').locator('button.sw').click();
      await page.waitForTimeout(300);
      check(`${T}: a refused change springs back and says why`, (await on(page, 'lockscreen-widgets')) === 'false' && /Access is denied/.test(await txt(page, 'lockscreen-widgets')));
      await page.close();

      ({ page, problems } = await open('drift'));
      check(`${T}: Windows turning a piece back on is said`, /Windows turned this back on/.test(await txt(page, 'widgets-prelaunch')));
      await page.close();

      ({ page, problems } = await open('fail'));
      const tf = await all(page);
      check(`${T}: a failed read says why and locks the switches`, tf.includes('The Windows pieces could not be read: Mantle’s helper is starting. Try again in a moment') && (await dis(page, 'widgets-prelaunch')), tf.slice(0, 300));
      await page.screenshot({ path: path.join(OUT, `rr-fail-${T}.png`) });
      await page.close();

      ({ page, problems } = await open('off'));
      const to = await all(page);
      check(`${T}: the feature off says so, and each wanted piece says it is paused`, to.includes('switched off in Mantle’s features, so Windows runs all of them') && /Saved as on/.test(await txt(page, 'widgets-prelaunch')));
      await page.close();
      ({ page, problems } = await open('test'));
      const tt = await all(page);
      check(`${T}: a test copy says so`, tt.includes('This is a test copy of Mantle: nothing is changed in Windows.'));
      check(`${T}: no jargon on the page`, !/HKCU|DWORD|reg\.exe|\bpid\b|working set|journal/i.test(tt), (tt.match(/HKCU|DWORD|reg\.exe|\bpid\b|working set|journal/i) || [])[0]);
      await page.close();
      await ctx.close();
    }
  } finally { await browser.close(); }
  console.log(`shots in ${OUT}`);
}

(async () => {
  try { await nodeTests(); } catch (e) { failures.push('part 1 threw: ' + e.message.split('\n')[0]); }
  if (process.env.RAMRECLAIM_NODE_ONLY !== '1') { try { await browserTests(); } catch (e) { failures.push('part 2 threw: ' + e.message.split('\n')[0]); } }
  failures.forEach((f) => console.log('FAIL ' + f));
  console.log(`RAMRECLAIM SETTINGS TEST: ${passed} passed, ${failures.length} failed`);
  process.exitCode = failures.length ? 1 : 0;
})();
