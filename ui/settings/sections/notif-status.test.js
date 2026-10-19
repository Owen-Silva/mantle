require('../../../tools/dev-env.js').lowcpu();
/* notif-status.test.js - Settings > System > Notifications says which banners are showing and why
 * (lane mantle-notif-safety-ui, 2026-10-17). No Silent Failures: polling because Windows sends no change
 * events, the notification helper dying and Windows' banners being put back used to reach only the log.
 *
 * The REAL page file sections/system.js on the settings mock (headless chromium over file://, never
 * Electron, never a real setting). mock-mantle.js plays toasts.state's `status` (?tstatus=helper|none|absent,
 * ?toasts=off|denied|failing). Each case in LIGHT and DARK (MANTLE_THEME per run, as plainwords.test.js):
 *   - the row 'notifications.banners.status' sits right after "Mantle's banners now" and reads EXACTLY
 *     `${line} (${why})` (or `${line}` alone), one quiet line, no "(null)";
 *   - its colour is the theme's --lg-ink-3 (ok / info) or --lg-warn (warn), never --lg-acc, no fill,
 *     and differs between light and dark.
 * Plus node checks on the source: no new timer in renderNotifications, nothing added to the bar.
 *
 *   node ui/settings/sections/notif-status.test.js
 * Prints "NOTIF STATUS TEST: n passed, m failed". A game running = the page part is skipped (and said).
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PAGE = 'file:///' + path.resolve(__dirname, '..', 'index.html').replace(/\\/g, '/');
const OUT = process.env.MANTLE_SHOOT_OUT || path.join(os.tmpdir(), 'mantle-notif-status-shots');
const ROW = 'notifications.banners.status';

let passed = 0;
const failures = [];
const check = (name, ok, detail) => { if (ok) passed++; else failures.push(detail ? `${name} (${String(detail).slice(0, 300)})` : name); return ok; };
function gaming() {
  try {
    const n = execSync('powershell -NoProfile -Command "@(Get-Process javaw,Minecraft*,RobloxPlayerBeta,VALORANT*,Riot* -ErrorAction SilentlyContinue).Count"', { encoding: 'utf8' });
    return parseInt(n.trim(), 10) || 0;
  } catch (_) { return -1; }
}

/* ================================================================ node: the source */
const SRC = fs.readFileSync(path.join(ROOT, 'ui', 'settings', 'sections', 'system.js'), 'utf8');
function nodeTests() {
  const a = SRC.indexOf('function renderNotifications'), b = SRC.indexOf('\n  /* ----', a + 1);
  const fn = a >= 0 ? SRC.slice(a, b > a ? b : undefined) : '';
  check('src: renderNotifications found', !!fn);
  check('src: the status row is declared in renderNotifications', fn.includes(`'${ROW}'`));
  check('src: no new timer (one kit.every, no setInterval)', (fn.match(/kit\.every\(/g) || []).length === 1 && !/setInterval/.test(fn));
}

/* ================================================================ the page */
const FAIL_WORDS = 'Mantle\'s banners are not running; Mantle\'s banners could not be read: this part of Mantle did not start. Restart Mantle to try again';
const CASES = [
  ['mantle-poll', 'toasts=on', 'ok', 'Banners: Mantle (checking every 0.1 s, because Windows won\'t send change events to this app)'],
  ['helper-stopped', 'tstatus=helper', 'warn', 'Banners: Windows\' own (Mantle\'s notification helper stopped; restored at 01:12)'],
  ['off', 'toasts=off', 'info', 'Banners: Windows\' own (Mantle\'s style is off)'],
  ['none', 'tstatus=none', 'warn', 'Banners: none (Mantle\'s notification helper stopped and Windows\' pop-ups could not be put back (made up: Windows refused the change))'],
  ['old-main-on', 'tstatus=absent', 'ok', 'Banners: Mantle'],
  ['old-main-off', 'tstatus=absent&toasts=off', 'info', 'Banners: Windows\' own (Mantle\'s style is off)'],
  ['old-main-denied', 'tstatus=absent&toasts=denied', 'warn', 'Banners: Windows\' own (Windows is not letting Mantle read notifications, so Windows keeps showing its own pop-ups. Allow it in Windows Settings > Privacy > Notifications)'],
  ['failing', 'toasts=failing', 'warn', `Banners: Windows' own (${FAIL_WORDS})`],
];

/* runs in the page: the row's one shown line, its colours, and the theme tokens it should use */
function probe(row) {
  const r = document.querySelector(`[data-row="${row}"]`);
  if (!r) return null;
  const prev = r.previousElementSibling;
  const lines = [...r.querySelectorAll('.row-h, .why')].filter((e) => !e.hidden && e.offsetParent && e.textContent.trim());
  const tok = (name) => { const p = document.createElement('span'); p.style.color = `var(${name})`; r.append(p); const c = getComputedStyle(p).color; p.remove(); return c; };
  const l = lines[0];
  const cs = l ? getComputedStyle(l) : null;
  return {
    label: (r.querySelector('.row-t') || {}).textContent || '',
    after: prev ? prev.getAttribute('data-row') : null,
    count: lines.length,
    text: l ? l.textContent : null,
    color: cs ? cs.color : null, bg: cs ? cs.backgroundColor : null, size: cs ? parseFloat(cs.fontSize) : null,
    all: r.textContent,
    ink3: tok('--lg-ink-3'), warn: tok('--lg-warn'), acc: tok('--lg-acc'),
    theme: document.documentElement.dataset.theme || 'light',
  };
}

async function browserTests() {
  const g = gaming();
  if (g !== 0) { console.log(g > 0 ? 'PAGE PART SKIPPED: a game is running' : 'PAGE PART SKIPPED: could not check for a running game'); failures.push('the page part was not run'); return; }
  const { chromium } = require('../../../tools/dev-env.js').playwright();
  fs.mkdirSync(OUT, { recursive: true });
  const seen = {};
  for (const theme of ['light', 'dark']) {
    process.env.MANTLE_THEME = theme;
    delete require.cache[require.resolve('../test-browser.js')];
    const browser = await require('../test-browser.js').launch(chromium);
    try {
      const ctx = await browser.newContext({ viewport: { width: 1040, height: 760 }, colorScheme: theme });
      for (const [name, query, tone, want] of CASES) {
        const page = await ctx.newPage();
        const problems = [];
        page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
        await page.goto(`${PAGE}?real=1&section=system&page=notifications&${query}`, { waitUntil: 'load' });
        try { await page.waitForSelector('html[data-ready="1"]', { timeout: 6000 }); } catch (_) { problems.push('never reached data-ready'); }
        await page.waitForTimeout(500);
        const p = await page.evaluate(probe, ROW);
        const T = `${theme} ${name}`;
        if (!check(`${T}: the status row is on the page`, !!p)) { await page.close(); continue; }
        await page.evaluate((s) => { const e = document.querySelector(s); e.scrollIntoView({ block: 'center' }); }, `[data-row="${ROW}"]`);
        await page.screenshot({ path: path.join(OUT, `${theme}-${name}.png`) });
        check(`${T}: drawn in the asked theme`, p.theme === theme, p.theme);
        check(`${T}: labelled, right after "Mantle's banners now"`, p.label === 'Notification status' && p.after === 'notifications.banners.state', `${p.label} | after ${p.after}`);
        check(`${T}: one line, reading exactly`, p.count === 1 && p.text === want, `${p.count} line(s): ${p.text}`);
        check(`${T}: no "(null)", no period closing the brackets`, !/\(null\)|null|undefined|\.\)$/.test(p.all), p.all);
        const tokenWant = tone === 'warn' ? p.warn : p.ink3;
        check(`${T}: the colour is the theme's ${tone === 'warn' ? '--lg-warn' : '--lg-ink-3'}`, p.color === tokenWant, `${p.color} vs ${tokenWant}`);
        check(`${T}: never the accent`, p.color !== p.acc, p.color);
        check(`${T}: quiet: small text, no fill`, p.size <= 12.5 && /rgba\(0, 0, 0, 0\)|transparent/.test(p.bg), `${p.size}px ${p.bg}`);
        check(`${T}: no page errors`, problems.length === 0, problems.join(' | '));
        seen[name] = seen[name] || {};
        seen[name][theme] = p.color;
        await page.close();
      }
      await ctx.close();
    } finally { await browser.close(); }
  }
  for (const [name] of CASES) {
    const s = seen[name] || {};
    check(`${name}: the colour differs between light and dark`, s.light && s.dark && s.light !== s.dark, JSON.stringify(s));
  }
  console.log(`shots in ${OUT}`);
}

(async () => {
  try { nodeTests(); } catch (e) { failures.push('node part threw: ' + (e && e.message)); }
  try { await browserTests(); } catch (e) { failures.push('page part threw: ' + (e && e.message ? e.message.split('\n')[0] : e)); }
  for (const f of failures) console.log('FAIL ' + f);
  console.log(`NOTIF STATUS TEST: ${passed} passed, ${failures.length} failed`);
  process.exitCode = failures.length ? 1 : 0;
})();
