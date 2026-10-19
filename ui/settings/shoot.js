require('../../tools/dev-env.js').lowcpu();
/* shoot.js — headless screenshots of Mantle Settings (ui/settings), on the mock only.
 *
 * Line 1 is the machine-wide CPU cap and browser lock (one headless browser at a time). Nothing here
 * runs Electron or touches a real setting: the page loads over file:// with mock-mantle.js standing
 * in for main, so every device, network and startup entry in the shots is made up.
 *
 * WHY A PROBE AS WELL AS A PHOTO: a clipped label or a page error can hide in a small PNG, so each
 * shot also reports page errors, console errors and any text box whose content overflows it.
 *
 *   node ui/settings/shoot.js            (ONLY=01,07 shoots just those)
 *   MANTLE_THEME=dark node ui/settings/shoot.js     (dark glass; test-browser.js sets <html data-theme>)
 * Owen gaming (a game process running) = no shots at all.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const { chromium } = require('../../tools/dev-env.js').playwright();

const PAGE = require('url').pathToFileURL(path.join(__dirname, 'index.html')).href;
const OUT = process.env.MANTLE_SHOOT_OUT ||
  path.join(require('os').tmpdir(), 'mantle-shots', 'settings');
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;

function gaming() {
  try {
    const n = execSync('powershell -NoProfile -Command "@(Get-Process javaw,Minecraft*,RobloxPlayerBeta,VALORANT* -ErrorAction SilentlyContinue).Count"', { encoding: 'utf8' });
    return parseInt(n.trim(), 10) || 0;
  } catch (_) { return -1; }
}

const SHOTS = [
  ['01-home', '?section=home'],
  ['02-mantle', '?section=mantle'],
  ['03-shortcuts', '?section=shortcuts'],
  ['04-sound', '?section=sound'],
  ['05-bluetooth', '?section=bluetooth'],
  ['06-startup', '?section=apps'],
  ['07-search', '?section=home', async (p) => { await p.click('#find'); await p.keyboard.type('night', { delay: 30 }); await p.waitForTimeout(200); }],
  ['08-cant', '?section=apps&mock=admin', async (p) => { await p.evaluate(() => { const r = document.querySelector('[data-row="apps.startup.run-machine:AudioHelper"]'); if (r) r.scrollIntoView({ block: 'center' }); }); }],
  ['09-display', '?section=display'],
  ['10-failing', '?section=home&mock=failing'],
  ['11-network', '?section=network'],
  ['12-nobridge', '?section=sound&mock=nobridge'],
  // the glass material: main's acrylic, read back ok, over the mock's made-up desktop
  ['13-glass', '?section=home&glass=acrylic&glassok=1&desk=1'],
  ['14-glass-apps', '?section=apps&glass=acrylic&glassok=1&desk=1'],
  // the eleven Windows categories as their real files (each read answers ok:false on the mock, so these
  // are their overview + error states; their page tests shoot them with data)
  ...['system', 'devices', 'internet', 'personalization', 'applist', 'accounts', 'time', 'gaming', 'accessibility', 'privacy', 'update']
    .map((id, i) => [String(20 + i) + '-' + id, '?section=' + id + '&real=1']),
];

(async () => {
  const g = gaming();
  if (g !== 0) { process.stdout.write(g > 0 ? 'a game is running: no shots taken\n' : 'could not check for a running game: no shots taken\n'); return; }
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await require('./test-browser.js').launch(chromium);
  const ctx = await browser.newContext({ viewport: { width: 1040, height: 700 }, deviceScaleFactor: 1.25, colorScheme: 'light' });
  let bad = 0;
  for (const [name, query, prep] of SHOTS) {
    if (ONLY && !ONLY.some((p) => name.startsWith(p))) continue;
    const page = await ctx.newPage();
    const problems = [];
    page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push('console ' + m.type() + ': ' + m.text()); });
    await page.goto(PAGE + query, { waitUntil: 'load' });
    try { await page.waitForSelector('html[data-ready="1"]', { timeout: 5000 }); } catch (_) { problems.push('never reached data-ready'); }
    await page.waitForTimeout(250);
    if (prep) await prep(page);
    await page.waitForTimeout(300);
    const probe = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll('.row-t, .row-h, .t-v, .t-s, .btn, .nav-i span, h1, .summary, .kc, .state, .why span, select').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (!r.width || getComputedStyle(el).webkitLineClamp !== 'none') return;
        if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflow !== 'visible') out.push('clipped: ' + el.className + ' "' + el.textContent.slice(0, 40) + '"');
        if (r.right > window.innerWidth + 1) out.push('off-screen right: ' + el.className + ' "' + el.textContent.slice(0, 40) + '"');
      });
      const page = document.getElementById('page');
      return { out, rows: page.querySelectorAll('.row').length, warns: page.querySelectorAll('.why:not(.info)').length, title: document.title, ready: document.documentElement.dataset.ready };
    });
    await page.screenshot({ path: path.join(OUT, name + '.png') });
    const all = problems.concat(probe.out);
    if (all.length) bad++;
    process.stdout.write(`${name}: ${probe.rows} rows, ${probe.warns} warn lines, ready=${probe.ready}${all.length ? '\n  ' + all.join('\n  ') : ''}\n`);
    await page.close();
  }
  await browser.close();
  process.stdout.write(`shots in ${OUT}; ${bad} with problems\n`);
})().catch((e) => { process.stdout.write('shoot failed: ' + e.message + '\n'); process.exitCode = 1; });
