require('C:/Users/user/dev-tools/tools/lowcpu.js');
/* gaming.test.js — Mantle Settings > Gaming (lane gameupd, 2026-09-29).
 *
 * PART 1 (node, always): the main half (lib/features/_settings-sections/gaming.js) against
 * sidecar/SysGaming.cs: every command it asks is a real gaming.* command, a test run sends EVERY write
 * as a dryRun, a live write shows the read-back, bad arguments stop before the sidecar. Plus the page
 * file's shape (model.js checkSection), its search rows and the ms-settings pages it claims.
 *
 * PART 2 (headless chromium over file://, never Electron, never a real setting): the REAL page file on
 * the settings lane's mock (mock-mantle.js), with settings.gaming.* played by FAKE() over MADE-UP
 * fixtures (and gamemode.state for Mantle's game mode). Every page must draw every search row it
 * declares; the shots go to MANTLE_SHOOT_OUT (default scratchpad/lanes/gameupd-shots).
 *
 *   node ui/settings/sections/gaming.test.js      (ONLY=game-03 for some shots)
 * Prints "GAMING PAGE TEST: n passed, m failed". A game running = part 2 is skipped (and said).
 */
'use strict';
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PAGE = 'file:///' + path.resolve(__dirname, '..', 'index.html').replace(/\\/g, '/');
const OUT = process.env.MANTLE_SHOOT_OUT ||
  'C:/Users/user/AppData/Local/Temp/claude/C--Users-owens/fe6c395c-2ffc-4958-a961-d5833371924e/scratchpad/lanes/gameupd-shots';
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;

let passed = 0;
const failures = [];
const check = (name, ok, detail) => { if (ok) passed++; else failures.push(detail ? `${name} (${String(detail).slice(0, 300)})` : name); return ok; };

function gaming() {
  try {
    const n = execSync('powershell -NoProfile -Command "@(Get-Process javaw,Minecraft*,RobloxPlayerBeta,VALORANT* -ErrorAction SilentlyContinue).Count"', { encoding: 'utf8' });
    return parseInt(n.trim(), 10) || 0;
  } catch (_) { return -1; }
}

let DEF = null;
/* ================================================================ PART 1: node */
async function nodeTests() {
  const cs = fs.readFileSync(path.join(ROOT, 'sidecar', 'SysGaming.cs'), 'utf8');
  const cmds = new Set([...cs.matchAll(/t\.Add\("(gaming\.[A-Za-z]+)"/g)].map((m) => m[1]));
  const main = require(path.join(ROOT, 'lib', 'features', '_settings-sections', 'gaming.js'));
  check('main: id is gaming', main.id === 'gaming');
  check('main: every command it asks is a real SysGaming command', Object.values(main.SIDECAR).every((c) => cmds.has(c)), Object.values(main.SIDECAR).filter((c) => !cmds.has(c)).join(' '));
  check('main: every SysGaming command can be reached', [...cmds].every((c) => Object.values(main.SIDECAR).includes(c)), [...cmds].join(' '));
  check('main: every page command is exported', Object.keys(main.SIDECAR).every((k) => typeof main.commands[k] === 'function'));
  check('main: no administrator actions (every value is per-user)', main.ADMIN.length === 0 && !/\[Elevated\(/.test(cs));
  check('sidecar: the fps cost words are the page\'s', /FpsCost = "background recording keeps the graphics chip encoding the last seconds of every game, which costs frames on this PC's integrated graphics"/.test(cs));

  const sent = [];
  const mk = (test) => ({ id: 'gaming', test, log() {}, push() {}, elevate: async () => ({ ok: false, kind: 'error', reason: 'no admin here' }),
    sidecar: { on: () => () => {}, send: async (c, a) => {
      sent.push([c, a]);
      if (a.dryRun) return { ok: true, result: { ok: true, dryRun: true, would: 'turn background recording (record what happened) on (HistoricalCaptureEnabled = 1 in your profile)' } };
      return { ok: true, result: { ok: true, now: a.value } };
    } } });
  const T = mk(true), L = mk(false);
  for (const args of [{ key: 'background', value: true }, { key: 'gameMode', value: false }, { key: 'frameRate', value: '60' }]) {
    sent.length = 0;
    const r = await main.commands.set(args, T);
    check(`test run: ${args.key} is a dry run`, r.ok && r.dryRun === true && sent.length === 1 && sent[0][1].dryRun === true && /^Test run, nothing changed/.test(r.reason), JSON.stringify([r, sent]));
  }
  sent.length = 0;
  const u = await main.commands.set({ key: 'gameMode', value: false }, L);
  check('live: a switch sends no dryRun and shows the read-back', u.ok && u.value === false && sent[0][1].dryRun === false, JSON.stringify([u, sent]));
  sent.length = 0;
  const nb = await main.commands.set({ key: 'gameMode', value: 1 }, L);
  const nk = await main.commands.set({ value: true }, L);
  check('main: bad arguments are refused before the sidecar', nb.ok === false && nk.ok === false && sent.length === 0);
  sent.length = 0;
  await main.commands.set({ key: 'gameMode', value: true, id: 'x', path: 'y' }, T);
  check('main: only key and value (and dryRun) reach the sidecar', sent.length === 1 && Object.keys(sent[0][1]).sort().join() === 'dryRun,key,value', JSON.stringify(sent));
  const g = await main.commands.get({}, L);
  check('main: get asks gaming.get', sent[1] && sent[1][0] === 'gaming.get' && g.ok, JSON.stringify(sent));

  // the page file
  const M = require(path.join(ROOT, 'ui', 'settings', 'model.js'));
  const src = fs.readFileSync(path.join(ROOT, 'ui', 'settings', 'sections', 'gaming.js'), 'utf8');
  vm.runInNewContext(src, { MantleSettings: { section(x) { DEF = x; } }, window: {}, document: { currentScript: { dataset: { section: 'gaming' } } }, console });
  check('page: checkSection is happy', DEF && M.checkSection(DEF, 'gaming') === null, DEF && M.checkSection(DEF, 'gaming'));
  check('page: order 80 in the Windows group, game icon, replaces nothing', DEF && DEF.order === 80 && DEF.group === 'windows' && DEF.icon === 'game' && DEF.replaces === undefined);
  const ids = DEF ? DEF.pages.map((p) => p.id) : [];
  check('page: three pages (Xbox Game Bar, Captures, Game Mode)', ids.join() === 'game-bar,captures,game-mode', ids.join(' '));
  const rows = DEF ? DEF.pages.flatMap((p) => p.search || []) : [];
  check('page: every page has search rows, every row is gaming.*, no row twice', DEF && DEF.pages.every((p) => (p.search || []).length) && rows.every((r) => /^gaming\./.test(r.row)) && new Set(rows.map((r) => r.row)).size === rows.length);
  const uris = rows.filter((r) => r.uri).map((r) => r.uri);
  check('page: claims the three Gaming pages once each', uris.sort().join() === 'ms-settings:gaming-gamebar,ms-settings:gaming-gamedvr,ms-settings:gaming-gamemode', uris.join());
  check('page: never opens Windows Settings (no kit.openWindows)', !/openWindows/.test(src));
  check('page: never touches the game mode feature files', !/require\(|gamemode\.(set|auto|liftSaver)/.test(src));
}

/* ================================================================ PART 2: the page on the mock */
function FAKE() {
  const q = new URLSearchParams(location.search);
  const TEST = q.get('test') === '1', SCN = q.get('gm') || 'normal';
  const later = (ms, v) => new Promise((res) => setTimeout(() => res(v), ms));
  const no = (reason) => ({ ok: false, reason });
  const POL = SCN === 'policy' ? 'a policy on this PC turns Game Bar captures off (GameDVR AllowGameDVR = 0)' : null;
  const sw = (on, extra) => Object.assign({ on, set: true, locked: null, why: null }, extra || {});
  const cap = (on, extra) => sw(POL ? false : on, Object.assign({ locked: POL }, extra || {}));
  const O = (vals, labels) => vals.map((v, i) => ({ value: v, label: labels[i] }));
  const ch = (value, options, extra) => Object.assign({ value, raw: 1, set: true, options, locked: POL, why: null }, extra || {});
  function get() {
    if (SCN === 'fail') return no('gaming.get failed (the sidecar is not running)');
    return { ok: true, policy: POL, gameBar: SCN !== 'nobar', capturesOff: null, fpsCost: 'background recording keeps the graphics chip encoding the last seconds of every game, which costs frames on this PC\'s integrated graphics',
      folder: { path: 'C:\\Users\\Made-up\\Videos\\Captures', exists: true, files: 18, why: null },
      values: {
        controller: sw(true, { set: false, why: 'not set (Windows\' default applies)' }), gameMode: sw(true),
        background: cap(SCN === 'bgon'), battery: cap(true), wireless: cap(true), audio: cap(true), mic: cap(false), cursor: cap(true),
        frameRate: ch('60', O(['30', '60'], ['30 fps', '60 fps'])), quality: ch('standard', O(['standard', 'high'], ['Standard', 'High'])),
        audioQuality: ch('128', O(['128', '192'], ['128 kbps', '192 kbps'])),
        buffer: ch('30', O(['15', '30', '60', '180', '300', '600'], ['15 seconds', '30 seconds', '1 minute', '3 minutes', '5 minutes', '10 minutes'])),
        maxLength: ch(SCN === 'custom' ? 'custom' : '240', O(['30', '60', '120', '240'], ['30 minutes', '1 hour', '2 hours', '4 hours']), SCN === 'custom' ? { why: 'another program stored a value that is not one of Windows\' choices' } : null),
      } };
  }
  const GM = { on: true, how: 'auto', game: { file: 'MadeUpGame.exe', title: 'Made-up Game', why: 'known game' }, since: Date.now() - 600e3, busy: null, auto: true, liftSaver: false,
    dry: false, enabled: true, watching: true, reason: 'a game is running', last: null,
    actions: [{ key: 'power', label: 'Power mode', status: 'ok', text: 'Best performance while plugged in; Balanced back after' },
      { key: 'background', label: 'Background apps', status: 'ok', text: '12 apps in efficiency mode' },
      { key: 'saver', label: 'Energy saver', status: 'blocked', text: 'Energy saver is on and "Lift Energy saver" is off' }],
    rest: { on: true, why: 'Made-up Game', since: Date.now() - 600e3 } };
  function set(a) {
    if (TEST) return later(30, { ok: true, dryRun: true, reason: 'Test run, nothing changed: Mantle would turn ' + a.key + ' ' + a.value });
    return later(40, { ok: true, value: a.value });
  }
  let real;
  Object.defineProperty(window, 'mantle', {
    configurable: true,
    get() { return real; },
    set(m) {
      real = { on: m.on.bind(m), call(name, args) {
        const copy = args && typeof args === 'object' ? JSON.parse(JSON.stringify(args)) : {};
        if (name === 'settings.sections') return Promise.resolve({ ok: true, reason: null, sections: [{ id: 'gaming', file: 'sections/gaming.js', down: null, main: null }] });
        const mine = name === 'settings.gaming.get' ? later(30, get()) : name === 'settings.gaming.set' ? set(copy)
          : name === 'gamemode.state' && SCN === 'gmon' ? later(20, GM) : null;
        if (!mine) return m.call(name, args);   // the mock records its own calls
        (window.__mockCalls = window.__mockCalls || []).push({ name, args: copy });
        return mine;
      } };
    },
  });
}

const sel = (row) => `[data-row="${row}"]`;
const rowText = (p, row) => p.evaluate((s) => { const e = document.querySelector(s); return e ? e.textContent : null; }, sel(row));
const calls = (p, name) => p.evaluate((n) => (window.__mockCalls || []).filter((c) => c.name === n), name);
const sw = (row) => sel(row) + ' button[role="switch"]';
const on = (p, row) => p.$eval(sw(row), (b) => b.getAttribute('aria-checked'));
const PG = (page, more) => `?section=gaming&page=${page}${more || ''}`;

const SHOTS = [
  ['game-01-overview', '?section=gaming', async (p) => {
    const t = await p.textContent('#page');
    check('01: the overview lists Xbox Game Bar, Captures and Game Mode', /Xbox Game Bar/.test(t) && /Captures/.test(t) && /Game Mode/.test(t), t.slice(0, 200));
  }],
  ['game-02-gamebar', PG('game-bar'), async (p) => {
    const t = await rowText(p, 'gaming.game-bar.controller');
    check('02: the controller button reads on, not set yet, and says so', await on(p, 'gaming.game-bar.controller') === 'true' && /Not set yet: Windows treats it as on/.test(t), t);
    check('02: the Game Bar app is installed', /Installed/.test(await rowText(p, 'gaming.game-bar.app') || ''));
    await p.click(sw('gaming.game-bar.controller'));
    await p.waitForTimeout(250);
    const c = await calls(p, 'settings.gaming.set');
    check('02: the switch sends its key', c.length === 1 && c[0].args.key === 'controller' && c[0].args.value === false, JSON.stringify(c));
  }],
  ['game-03-captures', PG('captures'), async (p) => {
    const bg = await rowText(p, 'gaming.captures.background');
    check('03: background recording off, and the row says it costs frames', await on(p, 'gaming.captures.background') === 'false' && /costs frames on this PC's integrated graphics/.test(bg), bg);
    const bat = await rowText(p, 'gaming.captures.battery');
    check('03: battery recording is read-only while background recording is off, WITH the reason', await p.$eval(sw('gaming.captures.battery'), (b) => b.disabled) && /Read only while "Record what happened" is off/.test(bat), bat);
    const f = await rowText(p, 'gaming.captures.folder');
    check('03: the captures folder shows its path, its files and why it is read-only', /Videos\\Captures/.test(f) && /18 files/.test(f) && /moves only when the Videos folder moves/.test(f), f);
    check('03: frame rate reads 60 fps', await p.$eval(sel('gaming.captures.frame-rate') + ' button[aria-checked="true"]', (b) => b.textContent) === '60 fps');
    await p.click(sel('gaming.captures.frame-rate') + ' button[data-v="30"]');
    await p.waitForTimeout(250);
    const c = await calls(p, 'settings.gaming.set');
    check('03: a choice sends its key and value', c.length === 1 && c[0].args.key === 'frameRate' && c[0].args.value === '30', JSON.stringify(c));
  }],
  ['game-04-captures-on', PG('captures', '&gm=bgon'), async (p) => {
    const bg = await rowText(p, 'gaming.captures.background');
    check('04: background recording ON warns about frames', await on(p, 'gaming.captures.background') === 'true' && /^.*On: background recording keeps the graphics chip/.test(bg) && !!(await p.$(sel('gaming.captures.background') + ' .why')), bg);
    check('04: the battery switch is live while background recording is on', !(await p.$eval(sw('gaming.captures.battery'), (b) => b.disabled)));
  }],
  ['game-05-policy', PG('captures', '&gm=policy'), async (p) => {
    const t = await p.textContent('#page');
    check('05: the page says every capture setting is locked by the policy', /Every capture setting is read only here: a policy on this PC turns Game Bar captures off \(GameDVR AllowGameDVR = 0\)/.test(t));
    for (const r of ['gaming.captures.background', 'gaming.captures.audio', 'gaming.captures.frame-rate']) {
      check(`05: ${r} is read-only WITH the policy`, /Read only here: a policy on this PC/.test(await rowText(p, r) || ''), await rowText(p, r));
    }
    check('05: capture switches are disabled', await p.$$eval('[data-row^="gaming.captures."] button[role="switch"]', (l) => l.length === 6 && l.every((b) => b.disabled)));
  }],
  ['game-06-gamemode', PG('game-mode', '&gm=gmon'), async (p) => {
    const w = await rowText(p, 'gaming.game-mode.windows');
    check('06: Windows Game Mode on, with its one line', await on(p, 'gaming.game-mode.windows') === 'true' && /Windows' own: the game gets first call/.test(w), w);
    const s = await rowText(p, 'gaming.game-mode.mantle-status');
    check('06: Mantle game mode says it is on for the made-up game, with its one line', /On · Made-up Game/.test(s) && /Mantle's own, on top of Windows'/.test(s), s);
    check('06: Mantle\'s switches read from the Mantle section\'s feature list', await on(p, 'gaming.game-mode.mantle') === 'true' && await on(p, 'gaming.game-mode.mantle-auto') === 'true' && await on(p, 'gaming.game-mode.mantle-saver') === 'false');
    check('06: what it is doing: three actions, the blocked one with its reason', await p.locator('[data-row^="gaming.game-mode.mantle-actions."]').count() === 3 &&
      /Energy saver is on/.test(await rowText(p, 'gaming.game-mode.mantle-actions.saver') || ''));
    await p.click(sw('gaming.game-mode.mantle-auto'));
    await p.waitForTimeout(300);
    const c = await calls(p, 'settings.option');
    check('06: a Mantle option goes through settings.option (the Mantle section\'s own write)', c.length === 1 && c[0].args.feature === 'gamemode' && c[0].args.key === 'auto' && c[0].args.value === false, JSON.stringify(c));
  }],
  ['game-07-testrun', PG('captures', '&test=1'), async (p) => {
    await p.click(sw('gaming.captures.background'));
    await p.waitForTimeout(300);
    const t = await rowText(p, 'gaming.captures.background');
    check('07: switching background recording on in a test run is a dry run and springs back OFF', /Test run, nothing changed/.test(t) && await on(p, 'gaming.captures.background') === 'false', t);
  }],
  ['game-08-failing', PG('captures', '&gm=fail'), async (p) => {
    check('08: the rows say why they could not be read', /Game settings could not be read: (Mantle's connection to Windows is restarting|Windows took too long to answer|something went wrong inside Mantle|this needs a newer version of Mantle|Windows did not allow it)/.test(await rowText(p, 'gaming.captures.background') || '') &&
      /could not be read/.test(await rowText(p, 'gaming.captures.folder') || '') && !/gaming\.get failed|sidecar/.test(await rowText(p, 'gaming.captures.folder') || ''), await rowText(p, 'gaming.captures.folder'));
    check('08: nothing threw while drawing', !/could not be drawn/.test(await p.textContent('#page')));
  }],
  ['game-09-custom', PG('captures', '&gm=custom'), async (p) => {
    const t = await rowText(p, 'gaming.captures.max-length');
    check('09: a value another program stored shows as Custom, with why', /Custom: another program stored a value/.test(t) && await p.$eval(sel('gaming.captures.max-length') + ' select', (s) => s.value) === 'custom', t);
  }],
  ['game-10-nobar', PG('game-bar', '&gm=nobar'), async (p) => {
    check('10: no Game Bar app says what that means', /Not installed/.test(await rowText(p, 'gaming.game-bar.app') || '') && /do nothing until it is installed/.test(await rowText(p, 'gaming.game-bar.app') || ''));
  }],
];

async function browserTests() {
  const g = gaming();
  if (g !== 0) { console.log(g > 0 ? 'PART 2 SKIPPED: a game is running' : 'PART 2 SKIPPED: could not check for a running game'); failures.push('part 2 (the page on the mock) was not run'); return; }
  const { chromium } = require('C:/Users/user/other-app/node_modules/playwright-core');
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await require('../test-browser.js').launch(chromium);
  const open = async (ctx, query) => {
    const page = await ctx.newPage();
    const problems = [];
    page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push('console ' + m.type() + ': ' + m.text()); });
    await page.goto(PAGE + query, { waitUntil: 'load' });
    try { await page.waitForSelector('html[data-ready="1"]', { timeout: 6000 }); } catch (_) { problems.push('never reached data-ready'); }
    await page.waitForTimeout(350);
    return { page, problems };
  };
  try {
    const ctx = await browser.newContext({ viewport: { width: 1040, height: 760 }, deviceScaleFactor: 1.25, colorScheme: 'light' });
    await ctx.addInitScript(FAKE);
    if (!ONLY && DEF) {
      const missing = [], errs = [];
      for (const pg of DEF.pages) {
        const { page, problems } = await open(ctx, PG(pg.id));
        const gone = await page.evaluate((rows) => rows.filter((r) => !document.querySelector(`[data-row="${r}"]`)), (pg.search || []).map((s) => s.row));
        missing.push(...gone);
        const txt = await page.textContent('#page');
        if (/could not be drawn|did not load/.test(txt)) errs.push(pg.id + ': not drawn');
        errs.push(...problems.map((x) => pg.id + ': ' + x));
        await page.close();
      }
      check('every page draws every search row it declares', !missing.length, missing.join(' '));
      check('every page opens without an error', !errs.length, errs.join(' | '));
      // Settings search finds a Gaming row by its words and lands on it
      const { page } = await open(ctx, '?q=background%20recording');
      const hit = await page.evaluate(() => document.body.textContent);
      check('search: "background recording" finds Record what happened', /Record what happened/.test(hit));
      await page.close();
    }
    for (const [name, query, prep] of SHOTS) {
      if (ONLY && !ONLY.some((x) => name.startsWith(x))) continue;
      const { page, problems } = await open(ctx, query);
      try { await prep(page); } catch (e) { problems.push('prep threw: ' + e.message.split('\n')[0]); }
      await page.waitForTimeout(150);
      const probe = await page.evaluate(() => {
        const out = [];
        document.querySelectorAll('.row-t, .row-h, .btn, h1, .why span, select, .val').forEach((el) => {
          const r = el.getBoundingClientRect();
          if (!r.width || getComputedStyle(el).webkitLineClamp !== 'none') return;
          if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflow !== 'visible') out.push('clipped: ' + el.className + ' "' + el.textContent.slice(0, 40) + '"');
          if (r.right > window.innerWidth + 1) out.push('off-screen right: ' + el.className + ' "' + el.textContent.slice(0, 40) + '"');
        });
        const pg = document.getElementById('page');
        return { out, rows: pg ? pg.querySelectorAll('.row').length : 0, text: pg ? pg.textContent : '' };
      });
      await page.screenshot({ path: path.join(OUT, name + '.png'), fullPage: true });
      check(`${name}: drawn, not DOWN`, probe.rows >= 1 && !/could not be drawn|did not load/.test(probe.text), probe.text.slice(0, 200));
      check(`${name}: no page errors, nothing clipped`, problems.length + probe.out.length === 0, problems.concat(probe.out).join(' | '));
      console.log(`${name}: ${probe.rows} rows`);
      await page.close();
    }
  } finally { await browser.close(); }
  console.log(`shots in ${OUT}`);
}

(async () => {
  try { await nodeTests(); } catch (e) { failures.push('part 1 threw: ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' ') : e)); }
  try { await browserTests(); } catch (e) { failures.push('part 2 threw: ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' ') : e)); }
  for (const f of failures) console.log('FAIL ' + f);
  console.log(`GAMING PAGE TEST: ${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();
