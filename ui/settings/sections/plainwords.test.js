require('../../../tools/dev-env.js').lowcpu();
/* plainwords.test.js - no raw error code on the Windows Update pages (lane mn-plainwords, 2026-10-12).
 *
 * The settings lane found Settings > Windows Update showing "COMException (0x8024...)" when the update
 * agent fails: in the last-checked line, in the update list's error and in the history's error. Main now
 * turns every reply into words where it crosses to a page (lib/plain-error.js toPage, in main.js
 * mantle:call). This test draws the REAL page files on the settings mock (headless Chromium over
 * file://, never Electron, never a real setting) with sidecar-shaped failures carrying real codes:
 *   RAW   the replies as the sidecar words them   -> the page shows the codes (the control: the test can see them)
 *   PLAIN the same replies through toPage          -> no code, no exception name on the page, and the words are there
 * Both themes (MANTLE_THEME is set per run by this file).
 *
 *   node ui/settings/sections/plainwords.test.js   -> "PLAINWORDS PAGE TEST: n passed, m failed"
 */
'use strict';
const path = require('path');
const { toPage } = require('../../../lib/plain-error');

const PAGE = 'file:///' + path.resolve(__dirname, '..', 'index.html').replace(/\\/g, '/');
let passed = 0;
const failures = [];
const check = (name, ok, detail) => { if (ok) passed++; else failures.push(detail ? `${name} (${String(detail).slice(0, 300)})` : name); return ok; };
const RAW = /0x[0-9a-f]{8}|exception|hresult|\(\d+\)|win32/i;

function fixtures() {
  const now = Date.now();
  return {
    'settings.update.status': {
      ok: true, build: { name: 'Windows 11 Home', version: '25H2', build: '26200.9550' }, lastCheck: null, lastInstall: null,
      wuaWhy: 'Windows Update Agent did not answer: COMException (0x8024402C)',
      rebootRequired: false, noAutoUpdate: null, installing: false,
      pause: { paused: false, until: null, since: null, maxDays: 35, locked: null, admin: true, does: 'x' },
      hours: { start: 9, end: 2, set: true, auto: false, locked: null, admin: true },
      flags: { latest: { on: true, set: true }, otherProducts: { on: false, set: false }, expedite: { on: true, set: true }, metered: { on: false, set: false }, restartNotify: { on: false, set: false },
        why: 'the switches could not be read: UnauthorizedAccessException: Access to the registry key is denied.' },
      delivery: { mode: null, words: null, policy: false, why: 'Windows keeps it in the Delivery Optimization service\'s own profile (NETWORK SERVICE), which this account may not read (access denied (5))', readOnly: 'Windows keeps this' },
      insider: { joined: false, channel: null, why: 'only Windows\' own Settings joins or leaves it' },
      check: { running: false, started: now - 60e3, finished: now - 50e3, found: null, optional: null, error: null, busy: false },
      elevated: false, reason: null,
    },
    'settings.update.list': { ok: false, reason: 'Windows Update\'s list could not be read: COMException (0x80240009)' },
    'settings.update.history': { ok: false, reason: 'The update history could not be read: COMException (0x8024FFFF)' },
  };
}

function FAKE(replies) {
  const later = (ms, v) => new Promise((res) => setTimeout(() => res(v), ms));
  let real;
  Object.defineProperty(window, 'mantle', {
    configurable: true,
    get() { return real; },
    set(m) {
      real = { on: m.on.bind(m), call(name, args) {
        if (name === 'settings.sections') return Promise.resolve({ ok: true, reason: null, sections: [{ id: 'update', file: 'sections/update.js', down: null, main: null }] });
        if (Object.prototype.hasOwnProperty.call(replies, name)) return later(30, JSON.parse(JSON.stringify(replies[name])));
        if (/^settings\.update\./.test(name)) return later(30, { ok: true, dryRun: true, reason: 'Test run, nothing changed' });
        return m.call(name, args);
      } };
    },
  });
}

async function run() {
  const { chromium } = require('../../../tools/dev-env.js').playwright();
  const raw = fixtures();
  const plain = {};
  for (const [k, v] of Object.entries(raw)) plain[k] = toPage(k, v);
  for (const theme of ['light', 'dark']) {
    process.env.MANTLE_THEME = theme;
    delete require.cache[require.resolve('../test-browser.js')];
    const browser = await require('../test-browser.js').launch(chromium);
    try {
      for (const [mode, replies] of [['RAW', raw], ['PLAIN', plain]]) {
        const ctx = await browser.newContext({ viewport: { width: 1040, height: 760 }, colorScheme: theme });
        await ctx.addInitScript(FAKE, replies);
        const texts = {};
        for (const pg of ['windows-update', 'history', 'advanced']) {
          const page = await ctx.newPage();
          const problems = [];
          page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
          await page.goto(`${PAGE}?section=update&page=${pg}`, { waitUntil: 'load' });
          try { await page.waitForSelector('html[data-ready="1"]', { timeout: 6000 }); } catch (_) { problems.push('never reached data-ready'); }
          await page.waitForTimeout(600);
          texts[pg] = await page.evaluate(() => { const p = document.getElementById('page'); return p ? p.innerText : ''; });
          check(`${theme} ${mode} ${pg}: drawn without a page error`, !problems.length && texts[pg].length > 20 && !/could not be drawn|did not load/.test(texts[pg]), problems.join(' | ') || texts[pg].slice(0, 200));
          await page.close();
        }
        const all = Object.values(texts).join('\n');
        if (mode === 'RAW') {
          // the control: without main's words the page shows the codes (so the PLAIN run below can fail)
          check(`${theme} RAW: the page shows the update agent's exception name (control; the page's own plain() already drops a bare "(0x...)")`, /COMException/.test(texts['windows-update']), texts['windows-update'].slice(0, 300));
          check(`${theme} RAW: the history shows its exception name (control)`, /COMException/.test(texts.history), texts.history.slice(0, 300));
        } else {
          const hits = all.split('\n').filter((l) => RAW.test(l));
          check(`${theme} PLAIN: no raw code or exception name anywhere on the three pages`, !hits.length, hits.join(' | '));
          check(`${theme} PLAIN: the last-checked line says why in words`, /did not answer: the server could not be reached; check the internet connection/.test(texts['windows-update']), texts['windows-update'].slice(0, 400));
          check(`${theme} PLAIN: the list's failure says Windows Update is busy`, /Windows Update is busy with another check or an install/.test(texts['windows-update']), texts['windows-update'].slice(0, 400));
          check(`${theme} PLAIN: the history's failure is a plain sentence, not silent`, /The update history could not be read: Windows Update reported an error it did not explain/.test(texts.history), texts.history.slice(0, 300));
          check(`${theme} PLAIN: the history's failure is not said twice`, !/could not be read: The update history could not be read/i.test(texts.history), texts.history.slice(0, 300));
        }
        await ctx.close();
      }
    } finally { await browser.close(); }
  }
}

run().catch((e) => failures.push('threw: ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' ') : e))).then(() => {
  for (const f of failures) console.log('FAIL ' + f);
  console.log(`PLAINWORDS PAGE TEST: ${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
});
