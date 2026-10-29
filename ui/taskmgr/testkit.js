/* testkit.js - the one harness every task manager page test uses (ui/taskmgr/taskmgr.page.test.js and
 * ui/taskmgr/pages/<id>.page.test.js). Headless Chromium over file:// (never Electron, never a real process):
 * the REAL page files on ui/taskmgr/mock-mantle.js, whose apps and numbers are MADE UP. Destructive commands
 * only ever reach the mock (window.__mockCalls), never Windows.
 *
 *   const kit = require('../testkit.js');          // (from pages/: '../testkit.js'; from ui/taskmgr: './testkit.js')
 *   kit.run('TASKMGR DETAILS PAGE TEST', async (t) => {
 *     const p = await t.open('view=details', { theme: 'dark', w: 1280, h: 800 });
 *     t.check('the rows are drawn', (await p.$$('#pg-details .trow')).length > 10);
 *     t.check('End task asked of Mantle', (await t.calls(p, 'taskmgr.endPid')).length === 1);
 *   });
 * Prints "<LABEL>: n passed, m failed" (the suite's verdict line). Guards, before any browser starts:
 * a running game = skipped; under 3.3 GB free RAM it waits (60 s, twice) and then says it skipped.
 * lowcpu.js (tools/dev-env.js) pins the process and its browser to a few cores at below-normal priority and
 * holds the machine-wide one-browser lock.
 */
'use strict';
require('../../tools/dev-env.js').lowcpu();
const path = require('path');
const { execSync } = require('child_process');

const PAGE = 'file:///' + path.join(__dirname, 'index.html').replace(/\\/g, '/');
const sh = (cmd) => { try { return execSync(cmd, { encoding: 'utf8', windowsHide: true }).trim(); } catch (_) { return ''; } };
const gaming = () => parseInt(sh('powershell -NoProfile -Command "@(Get-Process VALORANT*,javaw,Minecraft*,RobloxPlayerBeta -ErrorAction SilentlyContinue).Count"'), 10) || 0;
const freeGB = () => parseFloat(sh('powershell -NoProfile -Command "(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1MB"')) || 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(label, body) {
  if (gaming() > 0) { console.log(`${label}: skipped (a game is running)`); process.exit(0); }
  let gb = freeGB();
  for (let i = 0; i < 2 && gb > 0 && gb < 3.3; i++) { console.log(`waiting: ${gb.toFixed(2)} GB free RAM, a browser needs 3.3`); await sleep(60000); gb = freeGB(); }
  if (gb > 0 && gb < 3.3) { console.log(`${label}: skipped (only ${gb.toFixed(2)} GB free RAM; a test browser needs 3.3)`); process.exit(0); }
  const { chromium } = require('../../tools/dev-env.js').playwright();
  const browser = await require('../settings/test-browser.js').launch(chromium, { timeout: 0, headless: true });
  let passed = 0;
  const failures = [], errors = [];
  const t = {
    PAGE,
    check(name, ok, detail) { if (ok) passed++; else failures.push(detail !== undefined ? `${name} (${String(detail).slice(0, 300)})` : name); return !!ok; },
    /* open the page on the mock: query like 'view=details&nulls=1'; opts { w, h, theme: 'light'|'dark', reducedMotion } */
    async open(query, opts) {
      const o = Object.assign({ w: 1280, h: 800, theme: 'light' }, opts || {});
      const ctx = await browser.newContext({ viewport: { width: o.w, height: o.h }, deviceScaleFactor: 1, reducedMotion: o.reducedMotion ? 'reduce' : 'no-preference' });
      await ctx.addInitScript((theme) => {
        const set = () => { if (!document.documentElement) return false; document.documentElement.dataset.theme = theme; window.dispatchEvent(new CustomEvent('mantle-theme', { detail: { theme } })); return true; };
        if (!set()) new MutationObserver((_, mo) => { if (set()) mo.disconnect(); }).observe(document, { childList: true });
      }, o.theme);
      const page = await ctx.newPage();
      page.on('pageerror', (e) => errors.push(`${query}: ${e.message}`));
      page.on('console', (m) => { if (m.type() === 'error') errors.push(`${query}: console: ${m.text()}`); });
      await page.goto(`${PAGE}?${query || ''}`);
      await page.waitForFunction(() => document.documentElement.dataset.shot === '1', null, { timeout: 8000 });
      page._ctx = ctx;
      return page;
    },
    async close(page) { try { await page._ctx.close(); } catch (_) { /* already gone */ } },
    calls: (page, name) => page.evaluate((nm) => window.__mockCalls.filter((c) => c.name === nm), name),
    clearCalls: (page) => page.evaluate(() => { window.__mockCalls.length = 0; }),
    /* the shell's own errors (a page that threw while drawing) */
    shellErrors: (page) => page.evaluate(() => (window.__tmErrors || []).map((e) => String(e && e.stack || e))),
    sleep,
  };
  try { await body(t); } catch (e) { failures.push(`no exception (${e.stack})`); } finally { await browser.close(); }
  for (const e of errors) failures.push(`no page error (${e})`);
  for (const f of failures) console.log('  FAIL ' + f);
  console.log(`${label}: ${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
}
module.exports = { run, PAGE, freeGB };
