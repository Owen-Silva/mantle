/* page-harness.js - the shared driver for the bar's FUNCTIONAL page tests (ui/bar/*.page.test.js).
 *
 * WHAT: opens the REAL ui/bar/index.html in headless Chromium over file:// with the mock bridge
 * (mock-mantle.js), records every call the page makes (window.__MOCK_CALLS__) and lets a test answer
 * any channel itself (window.__MOCK_REPLY__), so a test CLICKS through the real bar code and asserts
 * on what the bar asked main to do - not on a screenshot.
 * WHY: until 2026-09-29 the bar had shoot.js (pictures) and node tests of its pure helpers, and no
 * test that clicked a pin and checked that the bar asked main to open that app.
 *
 * Line 1 of every test that uses this is lowcpu.js (the machine-wide CPU cap and browser lock), and
 * every run goes through the lane's uislot.sh (at most 2 test browsers on the user's machine at once).
 *
 *   const H = require('./page-harness.js');
 *   const t = H.suite('BAR PAGE TEST');
 *   await H.withBrowser(async (open) => {
 *     const pg = await open('?mode=pill', { reply: '(ch, p) => undefined' });
 *     await pg.click('#launcher'); t.check('asked', (await pg.calls('launcher.show')).length === 1);
 *   });
 *   t.done();   // prints "BAR PAGE TEST: n passed, m failed", exits 1 on a failure
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PW_CANDIDATES = [
  ...require('../../tools/dev-env.js').playwrightPaths(),
  'playwright-core'
];

function chromium() {
  for (const c of PW_CANDIDATES) { try { return require(c).chromium; } catch (e) { /* next */ } }
  throw new Error('playwright-core not found. Tried: ' + PW_CANDIDATES.join(', '));
}

/* The newest ms-playwright chromium already on the machine. Never a download, never the system Chrome. */
function findChrome() {
  const base = require('../../tools/dev-env.js').msPlaywrightDir();
  for (const d of fs.readdirSync(base).filter((n) => n.startsWith('chromium-')).sort().reverse())
    for (const sub of ['chrome-win/chrome.exe', 'chrome-win64/chrome.exe']) {
      const p = path.join(base, d, sub);
      if (fs.existsSync(p)) return p;
    }
  return null;
}

/* The games themselves (the lane rule). A game running = the browser half is skipped, and said. */
function gaming() {
  try {
    const n = execSync('powershell -NoProfile -Command "@(Get-Process javaw,Minecraft*,RobloxPlayerBeta,VALORANT* -ErrorAction SilentlyContinue).Count"', { encoding: 'utf8', timeout: 15000 });
    return Number(String(n).trim()) > 0;
  } catch (e) { return false; }
}

const PAGE = 'file:///' + path.resolve(__dirname, 'index.html').replace(/\\/g, '/');

function suite(title) {
  let passed = 0;
  const failures = [];
  const only = process.env.ONLY ? process.env.ONLY.split(',') : null;
  return {
    only,
    want(name) { return !only || only.some((o) => name.indexOf(o) >= 0); },
    check(name, ok, detail) {
      if (ok) passed++;
      else failures.push(detail !== undefined ? name + ' (' + String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 400) + ')' : name);
      return !!ok;
    },
    done() {
      for (const f of failures) console.log('  FAIL ' + f);
      console.log(title + ': ' + passed + ' passed, ' + failures.length + ' failed');
      process.exitCode = failures.length ? 1 : 0;
    }
  };
}

/* One browser for the whole run (one slot), a fresh page per case. `open(query, opts)`:
     opts.w / opts.h / opts.dsf   viewport (default 1280 x 480 at 1.25)
     opts.reply                   a function SOURCE string '(ch, p) => value|undefined' installed as
                                  window.__MOCK_REPLY__ before any page script runs
     opts.init                    extra init script source, run before the page's own scripts
     opts.settle                  ms to wait after load (default 700: the mock answers at 30 ms and
                                  the reveal lands at 300 ms; this is slack, not a race) */
async function withBrowser(fn) {
  const exe = findChrome();
  if (!exe) throw new Error('no ms-playwright chromium on this machine');
  const browser = await chromium().launch({ headless: true, executablePath: exe });
  const ctxs = {};
  const errors = [];
  try {
    const open = async (query, opts) => {
      opts = opts || {};
      const dsf = opts.dsf || 1.25;
      const key = dsf + ':' + (opts.w || 1280) + 'x' + (opts.h || 480);
      const ctx = ctxs[key] || (ctxs[key] = await browser.newContext({ colorScheme: 'dark', deviceScaleFactor: dsf, viewport: { width: opts.w || 1280, height: opts.h || 480 } }));
      const page = await ctx.newPage();
      const pageErrors = [];
      page.on('pageerror', (e) => { pageErrors.push(String(e && e.message || e)); errors.push(String(e && e.message || e)); });
      page.on('console', (m) => { if (m.type() === 'error') pageErrors.push('console.error: ' + m.text()); });
      await page.addInitScript('window.__MOCK_CALLS__ = [];' + (opts.reply ? 'window.__MOCK_REPLY__ = ' + opts.reply + ';' : '') + (opts.init || ''));
      await page.goto(PAGE + (query || ''), { waitUntil: 'load' });
      await page.waitForTimeout(opts.settle === undefined ? 700 : opts.settle);
      const pg = {
        page,
        errors: pageErrors,
        /* every call the page made on `channel` (all calls when no channel), in order */
        calls: (channel) => page.evaluate((c) => (window.__MOCK_CALLS__ || []).filter((x) => !c || x.ch === c), channel || null),
        reset: () => page.evaluate(() => { window.__MOCK_CALLS__ = []; }),
        click: async (sel, o) => { await page.click(sel, o); await page.waitForTimeout((o && o.wait) || 250); },
        key: async (k, wait) => { await page.keyboard.press(k); await page.waitForTimeout(wait || 150); },
        wait: (ms) => page.waitForTimeout(ms),
        eval: (f, a) => page.evaluate(f, a),
        emit: (ch, p) => page.evaluate(([c, x]) => window.__mockMain.emit(c, x), [ch, p]),
        text: (sel) => page.$eval(sel, (e) => e.textContent).catch(() => null),
        visible: (sel) => page.$eval(sel, (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return !e.hidden && s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0; }).catch(() => false),
        count: (sel) => page.$$eval(sel, (es) => es.length).catch(() => 0),
        shot: (file) => page.screenshot({ path: file }),
        close: () => page.close()
      };
      return pg;
    };
    await fn(open, { errors });
  } finally {
    await browser.close();
  }
}

module.exports = { suite, withBrowser, gaming, PAGE };
