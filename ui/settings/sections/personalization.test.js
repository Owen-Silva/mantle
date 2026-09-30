require('C:/Users/user/dev-tools/tools/lowcpu.js');
/* personalization.test.js — Mantle Settings > Personalization (lane perso, 2026-09-29).
 *
 * PART 1 (node, always): the main half (lib/features/_settings-sections/personalization.js) against
 * sidecar/SysPerso*.cs: every command it asks is a real perso.* command, a test run sends EVERY write as a
 * dryRun, a live write shows the read-back. Plus the page file's shape (model.js checkSection), its
 * search rows and its ms-settings claims.
 *
 * PART 2 (headless chromium over file://, never Electron, never a real setting): the REAL page file on
 * the settings lane's mock (mock-mantle.js), with settings.personalization.*, wallpaper.list and
 * settings.mantle played by FAKE() over MADE-UP fixtures. Every page is opened and must draw every
 * search row it declares; shots go to MANTLE_SHOOT_OUT (default scratchpad/lanes/perso-shots).
 *
 *   node ui/settings/sections/personalization.test.js      (ONLY=perso-02 for some shots)
 * Prints "PERSONALIZATION PAGE TEST: n passed, m failed". A game running = part 2 is skipped (and said).
 */
'use strict';
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const CHROME = 'C:/Users/user/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const PAGE = 'file:///' + path.resolve(__dirname, '..', 'index.html').replace(/\\/g, '/');
const OUT = process.env.MANTLE_SHOOT_OUT ||
  'C:/Users/user/AppData/Local/Temp/claude/C--Users-owens/fe6c395c-2ffc-4958-a961-d5833371924e/scratchpad/lanes/perso-shots';
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
  const cs = ['SysPerso.cs', 'SysPersoFonts.cs', 'SysPersoLock.cs'].map((f) => fs.readFileSync(path.join(ROOT, 'sidecar', f), 'utf8')).join('\n');
  const cmds = new Set([...cs.matchAll(/t\.Add\("(perso\.[A-Za-z]+)"/g)].map((m) => m[1]));
  const main = require(path.join(ROOT, 'lib', 'features', '_settings-sections', 'personalization.js'));
  check('main: id is personalization', main.id === 'personalization');
  check('main: every command it asks is a real SysPerso command', Object.values(main.SIDECAR).every((c) => cmds.has(c)), Object.values(main.SIDECAR).filter((c) => !cmds.has(c)).join(' '));
  check('main: every SysPerso command can be reached', [...cmds].every((c) => Object.values(main.SIDECAR).includes(c)), [...cmds].join(' '));
  check('main: every page command is exported', Object.keys(main.SIDECAR).every((k) => typeof main.commands[k] === 'function'));
  check('sidecar: no [Elevated] action (nothing here needs an administrator)', !/\[Elevated\(/.test(cs));
  check('sidecar: never touches Lively beyond looking (no Kill/CloseMainWindow)', !/\.Kill\(|CloseMainWindow|Process\.Start/.test(cs));

  const sent = [];
  const mk = (test) => ({ id: 'personalization', test, log() {}, push() {}, elevate: async () => ({ ok: false, reason: 'no' }),
    sidecar: { on: () => () => {}, send: async (c, a) => {
      sent.push([c, a]);
      if (a.dryRun) return { ok: true, result: { ok: true, dryRun: true, would: 'use light mode for apps (1 value in your profile, then tell open apps)' } };
      return { ok: true, result: { ok: true, now: c === 'perso.set' ? a.value : 'C:\\Made\\Up\\lock.jpg', note: 'done' } };
    } } });
  const T = mk(true), L = mk(false);
  const W = [['set', { key: 'appsLight', value: false }], ['set', { key: 'accent', value: '#0078D4' }], ['set', { key: 'picture', value: 'C:\\Made\\Up\\a.jpg' }],
    ['set', { key: 'fit', value: 'fill' }], ['lockPicture', { path: 'C:\\Made\\Up\\lock.jpg' }], ['fontInstall', { path: 'C:\\Made\\Up\\font.ttf' }], ['fontRemove', { face: 'Made Up (TrueType)' }]];
  for (const [cmd, args] of W) {
    sent.length = 0;
    const r = await main.commands[cmd](args, T);
    check(`test run: ${cmd} ${args.key || ''} is a dry run`, r.ok && r.dryRun === true && sent.length === 1 && sent[0][1].dryRun === true && /^Test run, nothing changed/.test(r.reason), JSON.stringify([r, sent]));
  }
  sent.length = 0;
  const u = await main.commands.set({ key: 'appsLight', value: true }, L);
  check('live: a switch sends no dryRun and shows the read-back', u.ok && u.value === true && sent[0][1].dryRun === false, JSON.stringify([u, sent]));
  const f = await main.commands.fontRemove({ face: 'Made Up (TrueType)' }, L);
  check('live: a font removal keeps its note, no value', f.ok && f.note === 'done' && !('value' in f), JSON.stringify(f));
  const nb = await main.commands.set({ value: true }, L);
  check('main: a missing key is refused before the sidecar', nb.ok === false && /key/.test(nb.reason));
  const nf = await main.commands.fontRemove({}, L);
  check('main: a missing face is refused before the sidecar', nf.ok === false && /face/.test(nf.reason));

  // the page file
  const M = require(path.join(ROOT, 'ui', 'settings', 'model.js'));
  const src = fs.readFileSync(path.join(ROOT, 'ui', 'settings', 'sections', 'personalization.js'), 'utf8');
  vm.runInNewContext(src, { MantleSettings: { section(x) { DEF = x; } }, window: {}, document: { currentScript: { dataset: { section: 'personalization' } } }, console });
  check('page: checkSection is happy', DEF && M.checkSection(DEF, 'personalization') === null, DEF && M.checkSection(DEF, 'personalization'));
  check('page: order 40 in the Windows group, replaces nothing', DEF && DEF.order === 40 && DEF.group === 'windows' && DEF.replaces === undefined);
  const ids = DEF ? DEF.pages.map((p) => p.id) : [];
  check('page: the ten pages', ids.join(' ') === 'background colors themes lock-screen text-input dynamic-lighting start taskbar fonts device-usage', ids.join(' '));
  const rows = DEF ? DEF.pages.flatMap((p) => p.search || []) : [];
  check('page: every page has search rows, every row is personalization.*', DEF && DEF.pages.every((p) => (p.search || []).length) && rows.every((r) => /^personalization\./.test(r.row)));
  check('page: row ids are unique', new Set(rows.map((r) => r.row)).size === rows.length);
  const uris = rows.filter((r) => r.uri).map((r) => r.uri);
  check('page: claims its ms-settings pages once each', new Set(uris).size === uris.length && ['ms-settings:personalization', 'ms-settings:personalization-background', 'ms-settings:colors', 'ms-settings:themes',
    'ms-settings:lockscreen', 'ms-settings:taskbar', 'ms-settings:personalization-start', 'ms-settings:fonts', 'ms-settings:personalization-textinput', 'ms-settings:personalization-lighting', 'ms-settings:deviceusage'].every((x) => uris.includes(x)), uris.join(' '));
  check('page: never opens Windows Settings (no kit.openWindows)', !/openWindows/.test(src));
  check('page: never styles through a style attribute (the CSP forbids it)', !/setAttribute\(\s*'style'|'style'\s*:/.test(src));
}

/* ================================================================ PART 2: the page on the mock */
function FAKE() {
  const q = new URLSearchParams(location.search);
  const TEST = q.get('test') === '1', SCN = q.get('perso') || 'normal';
  const later = (ms, v) => new Promise((res) => setTimeout(() => res(v), ms));
  const no = (reason) => ({ ok: false, reason });
  const V = (on) => ({ on, set: true, why: null });
  const SW = ['#FFB900', '#FF8C00', '#F7630C', '#CA5010', '#DA3B01', '#EF6950', '#D13438', '#FF4343', '#E74856', '#E81123', '#EA005E', '#C30052', '#E3008C', '#BF0077', '#C239B3', '#9A0089',
    '#0078D4', '#0063B1', '#8E8CD8', '#6B69D6', '#8764B8', '#744DA9', '#B146C2', '#881798', '#0099BC', '#2D7D9A', '#00B7C3', '#038387', '#00B294', '#018574', '#00CC6A', '#10893E',
    '#7A7574', '#5D5A58', '#68768A', '#515C6B', '#567C73', '#486860', '#498205', '#107C10', '#767676', '#4C4A48', '#69797E', '#4A5459', '#647C64', '#525E54', '#847545', '#7E735F'];
  const colors = () => (SCN === 'fail' ? no('perso.colors failed (the sidecar is not running)') : { ok: true, highContrast: SCN === 'hc',
    locked: SCN === 'hc' ? 'a contrast theme is on (Accessibility > Contrast themes), and Windows ignores these colours while it is' : null,
    values: { appsLight: V(false), systemLight: V(false), transparency: V(true), accentOnStart: V(false), accentOnTitleBars: V(false), autoAccent: V(false) },
    accent: '#D13438', accentWhy: null, swatches: SW });
  const background = () => (SCN === 'fail' ? no('perso.background failed (the sidecar is not running)') : { ok: true, kind: 'picture', picture: 'C:\\Made\\Up\\Pictures\\mountain.jpg', pictureExists: false, fit: 'fill',
    color: '#1F1F1F', recent: [{ path: 'C:\\Made\\Up\\Pictures\\mountain.jpg', exists: true }, { path: 'C:\\Made\\Up\\Pictures\\lake.png', exists: true }, { path: 'C:\\Made\\Up\\Old\\gone.jpg', exists: false }],
    slideshow: { on: false, folder: null, shuffle: false, intervalMs: 1800000 }, monitors: 1, remoteOff: false, serviceWhy: null, livelyRunning: SCN === 'lively',
    locked: SCN === 'locked' ? 'a policy on this PC stops the background from being changed (NoChangingWallPaper)' : null,
    fits: ['center', 'tile', 'stretch', 'fit', 'fill', 'span'] });
  const more = () => (SCN === 'fail' ? no('perso.more failed (the sidecar is not running)') : { ok: true,
    themes: { current: 'C:\\Made\\Up\\Themes\\Custom.theme', why: null, applyWhy: 'Windows applies a whole theme only through its own theme service (an undocumented interface in themeui.dll that opens Windows Settings), so Mantle shows the themes and sets their parts (colours, background) on those pages instead',
      list: [{ name: 'Custom', file: 'C:\\Made\\Up\\Themes\\Custom.theme', scope: 'user', current: true }, { name: 'Windows (dark)', file: 'C:\\Windows\\Resources\\Themes\\dark.theme', scope: 'windows', current: false },
        { name: 'Glow', file: 'C:\\Windows\\Resources\\Themes\\themeB.theme', scope: 'windows', current: false }] },
    lock: { spotlight: V(false), facts: V(true), signin: { policyOff: false, why: 'Windows keeps this switch in a protected per-user store (SystemProtectedUserData) that only its own Settings may write' },
      statusWhy: 'Windows keeps the lock screen status app in a protected per-user store that only its own Settings may write' },
    usage: { gaming: V(true), family: V(false), creative: V(true), schoolwork: V(true), entertainment: V(true), business: V(false), developer: V(true) },
    usageWhy: 'Windows keeps device usage in CloudExperienceHost values it does not document (each use stores an intent and a priority), so Mantle shows what is stored and does not guess at a change',
    lighting: { present: true, values: { AmbientLightingEnabled: 1, ControlledByForegroundApp: null, UseSystemAccentColor: 0, Brightness: 80, EffectType: 0, Speed: null },
      why: 'Windows drives Dynamic Lighting through its own lighting service and WinRT LampArray devices, which this Mantle build cannot reach; changing the stored values would not reach your devices' },
    touchKeyboard: { values: { SelectedThemeIndex: null, SelectedThemeName: null, KeyboardSizeSetting: null, IsKeyBackgroundEnabled: null },
      why: 'Windows keeps the touch keyboard theme and key size in TabletTip values it does not document, and only its own touch keyboard reads them; Mantle shows them read-only' } });
  const lock = () => ({ ok: true, picture: 'C:\\Made\\Up\\Lock\\harbour.jpg', pictureExists: false, pictureWhy: null, canSet: true });
  const FAM = ['Arial', 'Bahnschrift', 'Calibri', 'Cambria', 'Cascadia Code', 'Comic Sans MS', 'Consolas', 'Courier New', 'Georgia', 'Impact', 'Made Up Display', 'Segoe UI', 'Segoe UI Emoji', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana'];
  const fonts = () => ({ ok: true, faces: FAM.length * 2 + 1, userFaces: 1, why: null, userDir: 'C:\\Made\\Up\\Fonts',
    systemWhy: 'fonts for everyone live in C:\\Windows\\Fonts and the machine\'s registry, which need an administrator, and removing one can break Windows\' own text, so Mantle shows them read-only',
    families: FAM.map((n) => ({ name: n, scope: n === 'Made Up Display' ? 'user' : 'system',
      faces: n === 'Made Up Display' ? [{ face: 'Made Up Display (TrueType)', name: n, file: 'C:\\Made\\Up\\Fonts\\display.ttf', scope: 'user', type: 'TTF' }]
        : [{ face: n + ' (TrueType)', name: n, file: 'C:\\Windows\\Fonts\\x.ttf', scope: 'system', type: 'TTF' }, { face: n + ' Bold (TrueType)', name: n + ' Bold', file: 'C:\\Windows\\Fonts\\xb.ttf', scope: 'system', type: 'TTF' }]
          .concat(n === 'Segoe UI' ? [{ face: 'Segoe UI Light (TrueType)', name: 'Segoe UI Light', file: 'C:\\Windows\\Fonts\\xl.ttf', scope: 'system', type: 'TTF' }] : []) })) });
  const wall = () => ({ items: [{ id: 'w1', title: 'Made-up Rain', type: 'video', typeLabel: 'Video', selected: true, health: { ok: true } }, { id: 'w2', title: 'Made-up Stars', type: 'web', typeLabel: 'Web', selected: false, health: { ok: true } }],
    playback: { paused: SCN === 'paused', reason: SCN === 'paused' ? 'a full-screen app is in front (your Lively rule)' : '' }, livelyInstalled: true, test: TEST });
  const mantle = () => ({ ok: true, switcher: {}, shortcuts: [], features: [
    { name: 'topbar', label: 'Top menu bar', enabled: true, running: true, options: [{ key: 'a' }, { key: 'b' }] },
    { name: 'jumplist', label: 'Jump lists (right-click an app on the bar)', enabled: true, running: true, options: [] },
    { name: 'downloads', label: 'Downloads shelf (bar)', enabled: false, running: false, options: [] },
    { name: 'timer', label: 'Timer and stopwatch (top bar)', enabled: true, running: false, reason: 'resting while a game runs', options: [] },
    { name: 'taskview', label: 'Task View (Win+Tab)', enabled: true, running: true, options: [] },
    { name: 'corners', label: 'Hot corners', enabled: true, running: true, options: [{ key: 'tl' }] },
    { name: 'search', label: 'Search (Win+S)', enabled: true, running: true, options: [] } ] });
  function write(name, a) {
    if (TEST) return later(30, { ok: true, dryRun: true, reason: 'Test run, nothing changed: Mantle would ' + (a.key ? 'change ' + a.key : 'do it') });
    if (name.endsWith('.fontRemove')) return later(40, { ok: true, note: '"Made Up Display" is removed' });
    return later(40, { ok: true, value: a.value });
  }
  let real;
  Object.defineProperty(window, 'mantle', {
    configurable: true,
    get() { return real; },
    set(m) {
      real = { on: m.on.bind(m), call(name, args) {
        const copy = args && typeof args === 'object' ? JSON.parse(JSON.stringify(args)) : {};
        if (name === 'settings.sections') return Promise.resolve({ ok: true, reason: null, sections: [{ id: 'personalization', file: 'sections/personalization.js', down: null, main: null }] });
        const P = 'settings.personalization.';
        const mine = name === P + 'colors' ? later(30, colors()) : name === P + 'background' ? later(40, background()) : name === P + 'more' ? later(30, more())
          : name === P + 'lock' ? later(30, lock()) : name === P + 'fonts' ? later(50, fonts()) : name === 'wallpaper.list' ? later(20, wall()) : name === 'settings.mantle' ? later(20, mantle())
          : name === 'wallpaper.open' ? later(20, { ok: true })
          : [P + 'set', P + 'lockPicture', P + 'fontInstall', P + 'fontRemove'].includes(name) ? write(name, copy) : null;
        if (!mine) return m.call(name, args);
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
const PG = (page, more) => `?section=personalization&page=${page}${more || ''}`;
const SETC = 'settings.personalization.set';

const SHOTS = [
  ['perso-01-overview', '?section=personalization', async (p) => {
    const t = await p.textContent('#page');
    check('01: the overview lists Background, Colors, Fonts and Taskbar', ['Background', 'Colors', 'Lock screen', 'Fonts', 'Taskbar', 'Device usage'].every((x) => t.includes(x)), t.slice(0, 200));
  }],
  ['perso-02-background', PG('background'), async (p) => {
    check("02: Mantle's wallpaper leads, with its title", /Made-up Rain \(Video\)/.test(await rowText(p, 'personalization.background.mantle') || ''));
    check("02: it says Windows' background shows only while Mantle is not running", /only while Mantle is not running/.test(await rowText(p, 'personalization.background.mantle') || ''));
    check('02: Lively is looked at and never closed', /Not running/.test(await rowText(p, 'personalization.background.lively') || '') && /never closes or restarts Lively/.test(await rowText(p, 'personalization.background.lively') || ''));
    check('02: kind reads Picture', await p.$eval(sel('personalization.background.kind') + ' [aria-checked="true"]', (b) => b.textContent) === 'Picture');
    check('02: three recent pictures, the gone one says so and cannot be used', await p.locator('[data-row^="personalization.background.recent."]').count() === 3 &&
      /This picture file is gone/.test(await p.textContent('#page')) && await p.$$eval('[data-row^="personalization.background.recent."] button', (l) => l.length === 3 && l[2].disabled));
    check('02: the picture in use is marked', /In use/.test(await p.$$eval('[data-row^="personalization.background.recent."]', (l) => l[0].textContent)));
    check('02: the gone current picture says why', /That picture file is gone/.test(await rowText(p, 'personalization.background.picture') || ''));
    await p.click('[data-row^="personalization.background.recent."] >> nth=1 >> button');
    await p.waitForTimeout(300);
    const c = await calls(p, SETC);
    check('02: Use sends picture with its path', c.length === 1 && c[0].args.key === 'picture' && /lake\.png$/.test(c[0].args.value), JSON.stringify(c));
    await p.selectOption(sel('personalization.background.fit') + ' select', 'span');
    await p.waitForTimeout(300);
    const c2 = await calls(p, SETC);
    check('02: fit sends span', c2.length === 2 && c2[1].args.key === 'fit' && c2[1].args.value === 'span', JSON.stringify(c2));
  }],
  ['perso-03-background-locked', PG('background', '&perso=locked'), async (p) => {
    for (const r of ['personalization.background.fit', 'personalization.background.color', 'personalization.background.slideshow']) {
      check(`03: ${r} is read-only WITH the policy`, /Read only here: a policy on this PC stops the background/.test(await rowText(p, r) || ''), await rowText(p, r));
    }
    check('03: Use buttons are disabled under the policy', await p.$$eval('[data-row^="personalization.background.recent."] button', (l) => l.every((b) => b.disabled)));
  }],
  ['perso-04-colors', PG('colors'), async (p) => {
    check('04: mode reads Dark', await p.$eval(sel('personalization.colors.mode') + ' [aria-checked="true"]', (b) => b.textContent) === 'Dark');
    check('04: the One Theme note is on the page', /keep Mantle's one theme/.test(await p.textContent('#page')));
    check('04: 48 swatches, the current one pressed', await p.locator('button[data-hex]').count() === 48 && await p.$eval('button[data-hex="#D13438"]', (b) => b.getAttribute('aria-pressed')) === 'true');
    check('04: the accent value is shown', /#D13438/.test(await rowText(p, 'personalization.colors.accent') || ''));
    check('04: accent on Start says Mantle replaces it', /Mantle replaces Start and the taskbar/.test(await rowText(p, 'personalization.colors.accent-start') || ''));
    await p.click('button[data-hex="#0078D4"]');
    await p.waitForTimeout(300);
    const c = await calls(p, SETC);
    check('04: a swatch sends the accent', c.length === 1 && c[0].args.key === 'accent' && c[0].args.value === '#0078D4', JSON.stringify(c));
    await p.click(sel('personalization.colors.mode') + ' button[data-v="light"]');
    await p.waitForTimeout(400);
    const c2 = (await calls(p, SETC)).slice(1).map((x) => x.args.key + '=' + x.args.value).join(' ');
    check('04: Light sets Windows then apps', c2 === 'systemLight=true appsLight=true', c2);
  }],
  ['perso-05-colors-contrast', PG('colors', '&perso=hc'), async (p) => {
    check('05: a contrast theme makes every colour row read-only WITH the reason', /Read only here: a contrast theme is on/.test(await rowText(p, 'personalization.colors.transparency') || '') &&
      await p.$eval(sw('personalization.colors.transparency'), (b) => b.disabled) && await p.$eval('button[data-hex="#0078D4"]', (b) => b.disabled));
  }],
  ['perso-06-colors-testrun', PG('colors', '&test=1'), async (p) => {
    await p.click(sw('personalization.colors.transparency'));
    await p.waitForTimeout(300);
    const t = await rowText(p, 'personalization.colors.transparency');
    check('06: a test-run change is a dry run with its note, and springs back', /Test run, nothing changed/.test(t) && await p.$eval(sw('personalization.colors.transparency'), (b) => b.getAttribute('aria-checked')) === 'true', t);
  }],
  ['perso-07-fonts', PG('fonts'), async (p) => {
    check('07: every family listed (17 < 60)', await p.locator('[data-row^="personalization.fonts.list."]').count() === 17);
    check('07: each sample is drawn in its own face', await p.$$eval('[data-row^="personalization.fonts.list."] .row-h', (l) => l.every((h) => /"/.test(h.style.fontFamily))));
    check('07: only your font has Remove', await p.locator('[data-row^="personalization.fonts.list."] button').count() === 1);
    check('07: fonts for everyone say why they are read-only', /Read only here: fonts for everyone live in/.test(await p.textContent('#page')));
    await p.click('[data-row^="personalization.fonts.list."] button');
    await p.waitForTimeout(400);
    const c = await calls(p, 'settings.personalization.fontRemove');
    check('07: Remove sends the face', c.length === 1 && c[0].args.face === 'Made Up Display (TrueType)', JSON.stringify(c));
    await p.fill(sel('personalization.fonts.filter') + ' input', 'segoe');
    await p.press(sel('personalization.fonts.filter') + ' input', 'Enter');
    await p.waitForTimeout(250);
    check('07: search narrows the list', await p.locator('[data-row^="personalization.fonts.list."]').count() === 2);
  }],
  ['perso-08-lock', PG('lock-screen'), async (p) => {
    check('08: the picture name is shown', /harbour\.jpg/.test(await rowText(p, 'personalization.lock.picture') || ''));
    check('08: picking a picture says spotlight turns off', /turns Windows spotlight off/.test(await rowText(p, 'personalization.lock.path') || ''));
    check('08: status and sign-in are read-only WITH the reason', /Read only here: Windows keeps the lock screen status app/.test(await rowText(p, 'personalization.lock.status') || '') &&
      /Read only here: Windows keeps this switch in a protected/.test(await rowText(p, 'personalization.lock.signin') || ''));
    await p.click(sw('personalization.lock.spotlight'));
    await p.waitForTimeout(300);
    const c = await calls(p, SETC);
    check('08: spotlight sends its key', c.length === 1 && c[0].args.key === 'spotlight' && c[0].args.value === true, JSON.stringify(c));
  }],
  ['perso-09-taskbar', PG('taskbar'), async (p) => {
    check('09: the taskbar page says Mantle replaces it', /Mantle replaces the taskbar/.test(await rowText(p, 'personalization.taskbar.mantle') || ''));
    check('09: six Mantle features with Open in Mantle', await p.locator('[data-row^="personalization.taskbar.features."]').count() === 6 && await p.locator('[data-row^="personalization.taskbar.features."] button').count() === 6);
    check('09: a feature not running says why', /resting while a game runs/i.test(await p.textContent('#page')));
  }],
  ['perso-10-themes', PG('themes'), async (p) => {
    check('10: current theme and three themes', /Custom/.test(await rowText(p, 'personalization.themes.current') || '') && await p.locator('[data-row^="personalization.themes.list."]').count() === 3);
    check('10: applying says why it is read-only', /Read only here: Windows applies a whole theme only through its own theme service/.test(await p.textContent('#page')));
  }],
  ['perso-11-failing', PG('background', '&perso=fail'), async (p) => {
    check('11: the rows say why they could not be read', /Windows' background could not be read: (Mantle's connection to Windows is restarting|Windows took too long to answer|something went wrong inside Mantle|this needs a newer version of Mantle|Windows did not allow it)/.test(await rowText(p, 'personalization.background.fit') || ''));
    check('11: nothing threw while drawing', !/could not be drawn/.test(await p.textContent('#page')));
  }],
  ['perso-12-usage', PG('device-usage'), async (p) => {
    check('12: seven uses, read-only with the reason', await p.locator('[data-row^="personalization.usage.list."]').count() === 7 && /Read only here: Windows keeps device usage/.test(await p.textContent('#page')));
  }],
];

async function browserTests() {
  const g = gaming();
  if (g !== 0) { console.log(g > 0 ? 'PART 2 SKIPPED: a game is running' : 'PART 2 SKIPPED: could not check for a running game'); failures.push('part 2 (the page on the mock) was not run'); return; }
  if (!fs.existsSync(CHROME)) { failures.push('no chromium at ' + CHROME); return; }
  const { chromium } = require('C:/Users/user/other-app/node_modules/playwright-core');
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const open = async (ctx, query) => {
    const page = await ctx.newPage();
    const problems = [];
    page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
    page.on('console', (m) => { if ((m.type() === 'error' || m.type() === 'warning') && !/Failed to load resource|ERR_FILE_NOT_FOUND/.test(m.text())) problems.push('console ' + m.type() + ': ' + m.text()); });
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
      await page.screenshot({ path: path.join(OUT, name + '.png') });
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
  try { await browserTests(); } catch (e) { failures.push('part 2 threw: ' + (e && e.message ? e.message.split('\n')[0] : e)); }
  for (const f of failures) console.log('FAIL ' + f);
  console.log(`PERSONALIZATION PAGE TEST: ${passed} passed, ${failures.length} failed`);
  process.exitCode = failures.length ? 1 : 0;
})();
