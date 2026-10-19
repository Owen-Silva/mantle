require('../../../tools/dev-env.js').lowcpu();
/* apppower.test.js — Mantle Settings > App power (lane mantle-power-ui, 2026-10-14).
 *
 * PART 1 (node): the page file loads in an empty vm (only MantleSettings.section exists, as the launcher's
 * claims sandbox runs it), with the right id / group / order / search rows, and passes ui/settings/model.js
 * checkSection.
 * PART 2 (headless chromium over file://, never Electron): the REAL page file on the settings mock, the
 * apppower.* commands played by FAKE() below over MADE-UP rules. Checks: the list (labels, summaries,
 * "Only until Mantle restarts"), Remove sends forget + Undo puts the exact rule back, Reset all sends
 * resetAll + Undo puts every removed rule back, the empty state's words, the error state (the reason, Reset
 * all disabled), App power off and a test copy say so. Shots (light + dark): MANTLE_SHOOT_OUT, default
 * power-shots in the tools/dev-env.js scratch folder (else the temp folder).
 *
 *   node ui/settings/sections/apppower.test.js     Prints "APP POWER SETTINGS TEST: n passed, m failed".
 */
'use strict';
const path = require('path');
const fs = require('fs');
const vm = require('vm');

const PAGE = 'file:///' + path.resolve(__dirname, '..', 'index.html').replace(/\\/g, '/');
const OUT = process.env.MANTLE_SHOOT_OUT || path.join(require('../../../tools/dev-env.js').scratch() || require('os').tmpdir(), 'power-shots');
let passed = 0;
const failures = [];
const check = (name, ok, detail) => { if (ok) passed++; else failures.push(detail != null ? `${name} (${String(detail).slice(0, 300)})` : name); return ok; };

function nodeTests() {
  const src = fs.readFileSync(path.join(__dirname, 'apppower.js'), 'utf8');
  let def = null;
  try { vm.runInNewContext(src, { MantleSettings: { section: (d) => { def = d; } } }, { timeout: 2000 }); } catch (e) { failures.push('the page file threw while loading: ' + e.message); }
  check('page: defines its section while loading', !!def);
  if (!def) return;
  check('page: id apppower, in the Mantle group, after Mantle', def.id === 'apppower' && def.group === 'mantle' && def.order > 1000 && def.order < 1010, JSON.stringify({ id: def.id, group: def.group, order: def.order }));
  check('page: search rows are its own rows', (def.search || []).map((s) => s.row).join(',') === 'apppower.rules,apppower.reset');
  check('page: one page drawn directly', typeof def.render === 'function' && !def.pages);
  try {
    const model = require(path.join(__dirname, '..', 'model.js'));
    const why = model.checkSection(def, 'apppower');   // null = a valid section, else the reason
    check('page: passes model.checkSection', why == null, why);
  } catch (e) { failures.push('model.js did not load: ' + e.message); }
}

/* Runs IN THE PAGE (addInitScript): wraps mock-mantle.js's window.mantle. Made-up rules. */
function FAKE() {
  const q = new URLSearchParams(location.search);
  const SCN = q.get('ap') || 'normal';
  const later = (v) => new Promise((res) => setTimeout(() => res(JSON.parse(JSON.stringify(v))), 20));
  const R = (key, label, set, summary, remembered) => ({ key, exe: label.toLowerCase(), path: 'C:\\Made up\\' + label + '.exe', label, set, summary, remembered });
  let rules = SCN === 'empty' ? [] : [
    R('k1', 'Quartz', { eco: true, cpuCap: 25 }, 'Efficiency mode, CPU limit 25%', true),
    R('k6', 'Code', { memLow: true, memCap: 2147483648 }, 'Lower memory priority, Memory limit 2 GB', true),
    R('k9', 'Video Converter', { priority: 'low' }, 'Low priority', false),
  ];
  const sorted = () => rules.slice().sort((a, b) => a.label.localeCompare(b.label));
  const answer = (name, a) => {
    switch (name) {
      case 'apppower.rules':
        if (SCN === 'fail') return later({ ok: false, reason: 'Mantle’s helper is starting. Try again in a moment' });
        return later({ ok: true, on: SCN !== 'off', rules: sorted(), test: SCN === 'test' });
      case 'apppower.forget': {
        if (!rules.some((r) => r.key === a.key)) return later({ ok: false, reason: 'That rule is already gone' });
        rules = rules.filter((r) => r.key !== a.key);
        return later({ ok: true, rules: sorted() });
      }
      case 'apppower.resetAll': { const removed = rules; rules = []; return later({ ok: true, removed, rules: [] }); }
      case 'apppower.restoreRules': {
        (a.rules || []).forEach((x) => { if (!rules.some((r) => r.key === x.key)) rules.push(x); });
        return later({ ok: true, restored: (a.rules || []).length, rules: sorted() });
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
        if (name === 'settings.sections') return Promise.resolve({ ok: true, reason: null, sections: [{ id: 'apppower', file: 'sections/apppower.js', down: null, main: null }] });
        if (!/^apppower\./.test(name)) return m.call(name, args);
        (window.__mockCalls = window.__mockCalls || []).push({ name, args: copy });
        return answer(name, copy);
      } };
    },
  });
}

async function browserTests() {
  const { chromium } = require('../../../tools/dev-env.js').playwright();
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await require('../test-browser.js').launch(chromium);
  try {
    for (const theme of ['light', 'dark']) {
      const T = theme;
      const ctx = await browser.newContext({ viewport: { width: 1040, height: 760 }, deviceScaleFactor: 1.25 });
      await ctx.addInitScript(FAKE);
      const open = async (scn) => {
        const page = await ctx.newPage();
        const problems = [];
        page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
        page.on('console', (m) => { if (m.type() === 'error') problems.push('console: ' + m.text()); });
        await page.goto(PAGE + `?section=apppower&ap=${scn}&theme=${theme}`, { waitUntil: 'load' });
        try { await page.waitForSelector('html[data-ready="1"]', { timeout: 6000 }); } catch (_) { problems.push('never reached data-ready'); }
        await page.waitForTimeout(250);
        return { page, problems };
      };
      const rows = (p) => p.evaluate(() => [...document.querySelectorAll('[data-row^="apppower.rules."]')].map((r) => [r.querySelector('.row-t').textContent, (r.querySelector('.row-h') || {}).textContent]));
      const calls = (p, n) => p.evaluate((nn) => (window.__mockCalls || []).filter((c) => c.name === nn).map((c) => c.args), n);
      const text = (p) => p.evaluate(() => (document.getElementById('page') || document.body).textContent);

      // normal: list, Remove + Undo, Reset all + Undo
      let { page, problems } = await open('normal');
      let rs = await rows(page);
      check(`${T}: three apps, sorted, with their summaries`, JSON.stringify(rs) === JSON.stringify([['Code', 'Lower memory priority, Memory limit 2 GB'], ['Quartz', 'Efficiency mode, CPU limit 25%'], ['Video Converter', 'Low priority · Only until Mantle restarts']]), JSON.stringify(rs));
      await page.screenshot({ path: path.join(OUT, `set-list-${T}.png`) });
      await page.locator('[data-row="apppower.rules.k1"] button', { hasText: 'Remove' }).click();
      await page.waitForTimeout(200);
      const fg = (await calls(page, 'apppower.forget')).pop();
      check(`${T}: Remove sends forget {key}`, fg && fg.key === 'k1', JSON.stringify(fg));
      rs = await rows(page);
      check(`${T}: the app leaves the list`, rs.length === 2 && !rs.some((r) => r[0] === 'Quartz'), JSON.stringify(rs));
      check(`${T}: Undo is offered, naming the app`, /Removed the limits for Quartz/.test(await page.locator('[data-row="apppower.undo"]').textContent()));
      await page.locator('[data-row="apppower.undo"] button', { hasText: 'Undo' }).click();
      await page.waitForTimeout(200);
      const ur = (await calls(page, 'apppower.restoreRules')).pop();
      check(`${T}: Undo sends restoreRules with the rule as listed`, ur && ur.rules.length === 1 && ur.rules[0].key === 'k1' && ur.rules[0].exe === 'quartz' && ur.rules[0].set.cpuCap === 25 && ur.rules[0].label === 'Quartz', JSON.stringify(ur));
      check(`${T}: the app is back, the Undo gone`, (await rows(page)).length === 3 && (await page.locator('[data-row="apppower.undo"]').count()) === 0);
      await page.locator('[data-row="apppower.reset"] button').click();
      await page.waitForTimeout(200);
      check(`${T}: Reset all sends resetAll`, (await calls(page, 'apppower.resetAll')).length === 1);
      const t1 = await text(page);
      check(`${T}: the list is empty and says how to set one`, (await rows(page)).length === 0 && t1.includes('No app limits yet. Open the CPU, memory or graphics meter in the top bar to set one.'), t1.slice(0, 300));
      check(`${T}: Undo says how many`, /Removed 3 app limits/.test(await page.locator('[data-row="apppower.undo"]').textContent()));
      check(`${T}: Reset all is disabled with nothing left`, await page.locator('[data-row="apppower.reset"] button').isDisabled());
      await page.screenshot({ path: path.join(OUT, `set-undo-${T}.png`) });
      await page.locator('[data-row="apppower.undo"] button', { hasText: 'Undo' }).click();
      await page.waitForTimeout(200);
      const ua = (await calls(page, 'apppower.restoreRules')).pop();
      check(`${T}: Undo of Reset all puts every rule back`, ua && ua.rules.length === 3 && (await rows(page)).length === 3, JSON.stringify(ua).slice(0, 200));
      check(`${T}: normal: no page errors`, problems.length === 0, problems.join(' | '));
      await page.close();

      // empty
      ({ page, problems } = await open('empty'));
      const te = await text(page);
      check(`${T}: empty state`, (await rows(page)).length === 0 && te.includes('No app limits yet. Open the CPU, memory or graphics meter in the top bar to set one.') && await page.locator('[data-row="apppower.reset"] button').isDisabled(), te.slice(0, 300));
      await page.screenshot({ path: path.join(OUT, `set-empty-${T}.png`) });
      await page.close();

      // error
      ({ page, problems } = await open('fail'));
      const tf = await text(page);
      check(`${T}: error state says why`, tf.includes('The app limits could not be read: Mantle’s helper is starting. Try again in a moment') && !tf.includes('No app limits yet'), tf.slice(0, 300));
      check(`${T}: error: Reset all disabled with a reason`, await page.locator('[data-row="apppower.reset"] button').isDisabled() && tf.includes('Reset all needs the list first'));
      await page.screenshot({ path: path.join(OUT, `set-error-${T}.png`) });
      await page.close();

      // off / test copy
      ({ page, problems } = await open('off'));
      check(`${T}: App power off says so`, (await text(page)).includes('App power is turned off in Mantle’s features'));
      await page.close();
      ({ page, problems } = await open('test'));
      check(`${T}: a test copy says so`, (await text(page)).includes('This is a test copy of Mantle'));
      const tt = await text(page);
      check(`${T}: no jargon`, !/EcoQoS|job object|working set|\bpid\b|dryRun|priority class/i.test(tt));
      await page.close();
      await ctx.close();
    }
  } finally { await browser.close(); }
  console.log(`shots in ${OUT}`);
}

(async () => {
  nodeTests();
  try { await browserTests(); } catch (e) { failures.push('part 2 threw: ' + e.message.split('\n')[0]); }
  failures.forEach((f) => console.log('FAIL ' + f));
  console.log(`APP POWER SETTINGS TEST: ${passed} passed, ${failures.length} failed`);
  process.exitCode = failures.length ? 1 : 0;
})();
