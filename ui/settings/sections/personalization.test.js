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
// playwright-core 1.63 finds its own installed chromium (the pinned chromium-1234 build was removed 2026-10-05)
const PLAYWRIGHT = 'C:/Users/user/other-app/node_modules/playwright-core';
const PAGE = 'file:///' + path.resolve(__dirname, '..', 'index.html').replace(/\\/g, '/');
const OUT = process.env.MANTLE_SHOOT_OUT ||
  'C:/Users/user/AppData/Local/Temp/claude/C--Users-owens/fe6c395c-2ffc-4958-a961-d5833371924e/scratchpad/lanes/perso-shots';
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;
// the built-in wallpapers as lib/wallpaper.js lists them: the real catalog and real thumbs, in catalog order
const BG = path.join(ROOT, 'assets', 'backgrounds');
const PRESETS = JSON.parse(fs.readFileSync(path.join(BG, 'catalog.json'), 'utf8')).map((c) => ({ id: 'builtin:' + c.file.replace(/\.[a-z]+$/i, ''), title: c.title,
  type: 'picture', typeLabel: 'Picture', preset: true, category: c.category, credit: c.credit, creditUrl: c.url, origin: 'Built in', runtime: null,
  thumbUrl: 'file:///' + path.join(BG, 'thumbs', c.file).replace(/\\/g, '/') }));

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
  const colorRows = DEF ? ((DEF.pages.find((p) => p.id === 'colors') || {}).search || []) : [];
  const mm = colorRows.find((r) => r.row === 'personalization.colors.mantle-mode');
  check('page: Colors lists Mantle appearance first, findable by dark mode / theme', colorRows[0] === mm && mm && /dark mode/.test(mm.keywords) && /theme/.test(mm.keywords) && /appearance/.test(mm.keywords), JSON.stringify(mm));
  check("page: Mantle's look goes through theme.get / theme.set and follows the 'theme' event", /kit\.call\('theme\.get'\)/.test(src) && /kit\.call\('theme\.set', \{ mode: v \}\)/.test(src) && /kit\.watch\('theme'/.test(src));
  check("page: look sync goes through look.get / look.sync / look.glass / look.accent and follows the 'look' event",
    ["kit.call('look.get')", "send('look.sync'", "send('look.glass'", "send('look.accent'", "kit.watch('look'"].every((s) => src.includes(s)));
  const lookRows = ['look-sync', 'look-status', 'look-desktop', 'glass-blur', 'glass-dim', 'glass-panel', 'glass-reset', 'accent-mode', 'accent-hue'].map((x) => 'personalization.colors.' + x);
  check('page: every look sync row is searchable, right after Mantle appearance', colorRows.slice(1, 10).map((r) => r.row).join() === lookRows.join() &&
    /helm/.test(colorRows[1].keywords) && /quartz/.test(colorRows[1].keywords) && /see-through/.test(colorRows[6].keywords) && /hue/.test(colorRows[9].keywords), colorRows.map((r) => r.row).join(' '));
  check("page: the old One Theme claim is gone", !/keep Mantle's one theme|One Theme whatever/.test(src));
  check('page: never sets data-theme itself (the preload does)', !/dataset\.theme|data-theme/.test(src));
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
  /* the built-in wallpapers: window.__PRESETS is the REAL catalog (assets/backgrounds/catalog.json, its real
   * thumbs), shaped as lib/wallpaper.js lists it. perso=builtin: one is the pick; tilebad: one photo is
   * missing, one thumb is the full photo, a damaged catalog line; catbad: the catalog is unreadable;
   * setbad: Stone summit is picked and set / shuffle / creditOpen are refused; legacy: a Mantle that sends no presets or current. */
  const LIB = [{ id: 'w1', title: 'Made-up Rain', type: 'video', typeLabel: 'Video', health: { ok: true } }, { id: 'w2', title: 'Made-up Stars', type: 'web', typeLabel: 'Web', health: { ok: true } }];
  const CATS = ['Mountains', 'Forest', 'Water', 'Coast', 'Desert', 'Sky & Night', 'Snow', 'City', 'Abstract', 'Minimal'];
  let PICK = SCN === 'builtin' || SCN === 'setbad' ? 'builtin:stone' : 'w1';
  const presetOf = (x) => Object.assign({}, x, { selected: PICK === x.id,
    health: SCN === 'tilebad' && x.id === 'builtin:snow-ridge' ? { ok: false, reason: 'made up: its photo file is missing from Mantle\'s backgrounds folder' } : { ok: true, reason: null },
    thumbNote: SCN === 'tilebad' && x.id === 'builtin:forest' ? 'Its small preview is missing, so the full photo is shown instead.' : '' });
  const wall = () => {
    const items = LIB.map((x) => Object.assign({}, x, { selected: PICK === x.id }));
    const out = { items, playback: { paused: SCN === 'paused', reason: SCN === 'paused' ? 'a full-screen app is in front (your Lively rule)' : '' }, livelyInstalled: true, test: TEST };
    if (SCN === 'legacy') return out;
    const pre = (window.__PRESETS || []).map(presetOf);
    out.presets = SCN === 'catbad' ? { ok: false, reason: 'made up: the list of built-in wallpapers (catalog.json) is missing from this copy of Mantle', note: null, categories: [], items: [] }
      : { ok: true, reason: null, note: SCN === 'tilebad' ? 'made up: 1 line of the built-in list was damaged, so it is left out' : null, categories: CATS, items: pre };
    const cur = items.concat(pre).find((x) => x.selected);
    out.current = cur ? { id: cur.id, title: cur.title, type: cur.type, typeLabel: cur.typeLabel, preset: !!cur.preset, category: cur.category || null, credit: cur.credit || null,
      creditUrl: cur.creditUrl || null, thumbUrl: cur.thumbUrl || null, health: cur.health } : null;
    return out;
  };
  const wset = (a) => {
    if (SCN === 'setbad') return no('made up: Mantle\'s wallpaper library could not be saved (library.json is read-only)');
    if (!(window.__PRESETS || []).some((x) => x.id === a.id) && !LIB.some((x) => x.id === a.id)) return no('there is no wallpaper with that id');
    PICK = a.id;
    return { ok: true };
  };
  const wshuffle = (a) => {
    if (SCN === 'setbad') return no('made up: no built-in photo could be used');
    const pool = (window.__PRESETS || []).filter((x) => (a.category === 'All' || x.category === a.category) && x.id !== PICK);
    if (!pool.length) return no('there is no other photo in ' + a.category);
    PICK = pool[0].id;
    return { ok: true, id: pool[0].id, title: pool[0].title };
  };
  const wcredit = (a) => (SCN === 'setbad' ? no('made up: the photo\'s page could not be opened (no browser answered)')
    : { ok: true, dryRun: true, url: ((window.__PRESETS || []).find((x) => x.id === a.id) || {}).creditUrl, reason: 'Test run, nothing opened: Mantle would open the photo\'s Unsplash page' });
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
        // perso=themebad: main refuses Mantle's own light/dark change (theme.get stays the mock's)
        const mine = name === 'theme.set' && SCN === 'themebad' ? later(40, no('Mantle could not save the setting (its settings file is read-only)'))
          : name === P + 'colors' ? later(30, colors()) : name === P + 'background' ? later(40, background()) : name === P + 'more' ? later(30, more())
          : name === P + 'lock' ? later(30, lock()) : name === P + 'fonts' ? later(50, fonts()) : name === 'wallpaper.list' ? later(20, wall()) : name === 'settings.mantle' ? later(20, mantle())
          : name === 'wallpaper.open' ? later(20, { ok: true })
          : name === 'wallpaper.set' ? later(30, wset(copy)) : name === 'wallpaper.shuffle' ? later(30, wshuffle(copy)) : name === 'wallpaper.creditOpen' ? later(20, wcredit(copy))
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
// look sync with Helm and Quartz (Colors, right under Mantle appearance)
const LR = (x) => 'personalization.colors.' + x;
const [LS, LST, LDK, GB, GD, GP, GR, AM, AH] = ['look-sync', 'look-status', 'look-desktop', 'glass-blur', 'glass-dim', 'glass-panel', 'glass-reset', 'accent-mode', 'accent-hue'].map(LR);
/* a slider released at v: the range input's own input + change events, so the page's real handler runs */
const slide = (p, row, v) => p.$eval(sel(row) + ' input[type="range"]', (i, x) => {
  i.value = String(x); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true }));
}, v);
const rng = (p, row) => p.$eval(sel(row), (e) => ({ v: e.querySelector('input').value, out: e.querySelector('.rng-v').textContent, dis: e.querySelector('input').disabled, text: e.textContent }));
const seg = (p, row) => p.$eval(sel(row) + ' [aria-checked="true"]', (b) => b.textContent).catch(() => null);

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
    check("04: the note says the modes below are Windows' and Mantle's look is set above", /below are Windows' own, for Windows and your apps\. Mantle's look is the setting above/.test(await p.textContent('#page')) &&
      !/keep Mantle's one theme/.test(await p.textContent('#page')));
    check('04: Mantle appearance is the first row on the page', await p.$eval('#page [data-row^="personalization."]', (e) => e.dataset.row) === 'personalization.colors.mantle-mode');
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
  ['perso-13-mantle-look', PG('colors'), async (p) => {
    const MM = 'personalization.colors.mantle-mode';
    const on = () => p.$eval(sel(MM) + ' [aria-checked="true"]', (b) => b.textContent).catch(() => null);
    check('13: Mantle appearance draws Light / Dark / Match Windows', (await p.$$eval(sel(MM) + ' button[data-v]', (l) => l.map((b) => b.dataset.v + '=' + b.textContent).join(' '))) === 'light=Light dark=Dark system=Match Windows');
    check('13: it reads Match Windows (the default)', await on() === 'Match Windows', await on());
    const t0 = await rowText(p, MM) || '';
    check("13: it says it is Mantle's own bar, panels and windows", /Mantle's own bar, panels and windows/.test(t0), t0);
    check("13: it says which way Windows is set right now", /Following Windows: dark right now/.test(t0), t0);
    check('13: the page never set data-theme (no ?theme= given)', await p.evaluate(() => document.documentElement.dataset.theme) === undefined);
    await p.evaluate(() => { window.__lookEvents = []; window.addEventListener('mantle-theme', (e) => window.__lookEvents.push(e.detail.theme)); });
    await p.click(sel(MM) + ' button[data-v="light"]');
    await p.waitForTimeout(300);
    const c = await calls(p, 'theme.set');
    check('13: a click sends theme.set { mode: light }', c.length === 1 && c[0].args.mode === 'light' && Object.keys(c[0].args).length === 1, JSON.stringify(c));
    const t1 = await rowText(p, MM) || '';
    check('13: the read-back shows Light, the Following line is gone', await on() === 'Light' && !/Following Windows/.test(t1), t1);
    check('13: the mock painted light and fired mantle-theme, like the preload', await p.evaluate(() => document.documentElement.dataset.theme) === 'light' && (await p.evaluate(() => window.__lookEvents)).join() === 'light');
    await p.click(sel(MM) + ' button[data-v="dark"]');
    await p.waitForTimeout(300);
    const c2 = await calls(p, 'theme.set');
    check('13: Dark sends theme.set { mode: dark } and reads back Dark', c2.length === 2 && c2[1].args.mode === 'dark' && await on() === 'Dark', JSON.stringify(c2));
    await p.click(sel(MM) + ' button[data-v="system"]');
    await p.waitForTimeout(300);
    await p.evaluate(() => window.__mockWindowsMode('light'));
    await p.waitForTimeout(150);
    const t2 = await rowText(p, MM) || '';
    check("13: Match Windows follows a Windows change live (the 'theme' event)", await on() === 'Match Windows' && /Following Windows: light right now/.test(t2), t2);
    await p.evaluate(() => window.__mockEmit('theme', { ok: true, mode: 'dark', theme: 'dark', windows: 'light', windowsWhy: null, pinned: 'This test run was started with --theme=dark, so changes last until it quits and are not saved', note: null, reason: null }));
    await p.waitForTimeout(100);
    const t3 = await rowText(p, MM) || '';
    check("13: a 'theme' event from elsewhere moves the row, and pinned is shown", await on() === 'Dark' && /started with --theme=dark/.test(t3), t3);
    await p.evaluate(() => window.__mockEmit('theme', { ok: true, mode: 'system', theme: 'light', windows: null, windowsWhy: 'made up: the Personalize key is missing', pinned: null, note: null, reason: null }));
    await p.waitForTimeout(100);
    const t4 = await rowText(p, MM) || '';
    check("13: Windows' mode unknown says why", /Following Windows, but its mode could not be read \(made up: the Personalize key is missing\), so Mantle shows light/.test(t4), t4);
    const w = await calls(p, SETC);
    check("13: Mantle's look never touches Windows' own mode", w.length === 0, JSON.stringify(w));
  }],
  ['perso-14-mantle-look-refused', PG('colors', '&perso=themebad'), async (p) => {
    const MM = 'personalization.colors.mantle-mode';
    await p.click(sel(MM) + ' button[data-v="dark"]');
    await p.waitForTimeout(300);
    const t = await rowText(p, MM) || '';
    check('14: a refused change springs back to Match Windows with its reason', await p.$eval(sel(MM) + ' [aria-checked="true"]', (b) => b.textContent) === 'Match Windows' &&
      /its settings file is read-only/.test(t), t);
  }],
  ['perso-15-mantle-look-unreadable', PG('colors', '&mock=failing'), async (p) => {
    const MM = 'personalization.colors.mantle-mode';
    const t = await rowText(p, MM) || '';
    check('15: an unreadable theme.get disables the row WITH the reason', /Mantle's appearance could not be read: made up: Mantle's settings file could not be read/.test(t) &&
      await p.$$eval(sel(MM) + ' button[data-v]', (l) => l.length === 3 && l.every((b) => b.disabled)), t);
    check("15: Windows' own rows still work", !(await p.$eval(sw('personalization.colors.transparency'), (b) => b.disabled)));
  }],
  ['perso-16-colors-dark', PG('colors', '&theme=dark'), async (p) => {
    check('16: ?theme=dark paints dark before the page draws', await p.evaluate(() => document.documentElement.dataset.theme) === 'dark');
    check('16: Match Windows says dark', /Following Windows: dark right now/.test(await rowText(p, 'personalization.colors.mantle-mode') || ''));
  }],
  ['perso-23-look-sync', PG('colors'), async (p) => {
    const groups = await p.$$eval('#page .group-t', (l) => l.map((g) => g.textContent));
    check('23: "Match Helm and Quartz" is the group right after Mantle appearance', groups[0] === 'Mantle' && groups[1] === 'Match Helm and Quartz', groups.join(' | '));
    const order = await p.$$eval('#page [data-row^="personalization.colors."]', (l) => l.map((e) => e.dataset.row.replace('personalization.colors.', '')));
    check('23: its rows follow Mantle appearance in order', order.slice(0, 10).join(' ') === 'mantle-mode look-sync look-status look-desktop glass-blur glass-dim glass-panel glass-reset accent-mode accent-hue', order.join(' '));
    check('23: it reads the shared look once (look.get)', (await calls(p, 'look.get')).length === 1);
    check('23: sync reads On', await p.$eval(sw(LS), (b) => b.getAttribute('aria-checked')) === 'true' && /Theme, accent and glass follow when you change them in any of the three/.test(await rowText(p, LS) || ''));
    const st0 = await rowText(p, LST) || '';
    check("23: status reads main's text, with the ok pip", /On · in sync \(last change from Quartz, just now\)/.test(st0) && await p.$eval(sel(LST) + ' .pip', (e) => e.classList.contains('ok')), st0);
    const d0 = await rowText(p, LDK) || '';
    check("23: the desktop row names the shared wallpaper and says Windows' matches", /Shared with Helm and Quartz: "Snow peak" \(rev 41\)/.test(d0) && /Windows' wallpaper matches/.test(d0), d0);
    const g0 = [await rng(p, GB), await rng(p, GD), await rng(p, GP)];
    check('23: the sliders show 5 px, 50%, 83%', g0.map((x) => x.out).join(' ') === '5 px 50% 83%' && g0.every((x) => !x.dis), JSON.stringify(g0));
    check('23: dark: the sliders say they edit the dark look', /Editing the dark look/.test(await rowText(p, GB) || '') && !/Editing the light look/.test(await p.textContent('#page')), await rowText(p, GB));
    check('23: Reset glass is off at the defaults, and says so', await p.$eval(sel(GR) + ' button', (b) => b.disabled && b.textContent === 'Reset glass') && /The glass is at its defaults/.test(await rowText(p, GR) || ''));
    check("23: accent reads Mantle's own, the hue slider is off and says how to turn it on", await seg(p, AM) === "Mantle's own" && (await rng(p, AH)).dis && /Pick Custom hue to choose one/.test(await rowText(p, AH) || ''));
    check('23: the accent swatch is drawn from --lg-acc', await p.$eval(sel(AM) + ' [data-accent-swatch]', (e) => /var\(--lg-acc\)/.test(e.style.background)));
    // sync off, then on
    await p.click(sw(LS));
    await p.waitForTimeout(250);
    const s1 = await calls(p, 'look.sync');
    check('23: Off sends look.sync { on: false }', s1.length === 1 && s1[0].args.on === false && Object.keys(s1[0].args).length === 1, JSON.stringify(s1));
    check('23: status now reads Off, no pip', /Off: Mantle keeps its own look/.test(await rowText(p, LST) || '') && !(await p.$(sel(LST) + ' .pip')) && await p.$eval(sw(LS), (b) => b.getAttribute('aria-checked')) === 'false', await rowText(p, LST));
    await p.click(sw(LS));
    await p.waitForTimeout(250);
    const s2 = await calls(p, 'look.sync');
    check('23: On sends look.sync { on: true } and the status shows the new change', s2.length === 2 && s2[1].args.on === true && /last change from Mantle/.test(await rowText(p, LST) || ''), JSON.stringify(s2) + ' ' + await rowText(p, LST));
    // each slider writes once on release, and redraws from the answer
    await slide(p, GB, 20);
    await p.waitForTimeout(250);
    let gl = await calls(p, 'look.glass');
    check('23: Blur release sends look.glass { blurPx: 20 } once', gl.length === 1 && JSON.stringify(gl[0].args) === '{"look":"dark","blurPx":20}' && (await rng(p, GB)).out === '20 px', JSON.stringify(gl));
    check('23: Reset glass turns on once the glass moved', await p.$eval(sel(GR) + ' button', (b) => !b.disabled) && !/at its defaults/.test(await rowText(p, GR) || ''));
    await p.focus(sel(GB) + ' input');
    await p.keyboard.press('ArrowRight');
    await p.waitForTimeout(250);
    gl = await calls(p, 'look.glass');
    check('23: the keyboard moves Blur by one and writes it', gl.length === 2 && gl[1].args.blurPx === 21 && (await rng(p, GB)).out === '21 px', JSON.stringify(gl));
    await slide(p, GD, 35);
    await p.waitForTimeout(250);
    gl = await calls(p, 'look.glass');
    check('23: Bar tint 35% sends { look: dark, dim: 0.35 }', gl.length === 3 && JSON.stringify(gl[2].args) === '{"look":"dark","dim":0.35}' && (await rng(p, GD)).out === '35%', JSON.stringify(gl));
    await slide(p, GP, 70);
    await p.waitForTimeout(250);
    gl = await calls(p, 'look.glass');
    check('23: Panel opacity 70% sends { look: dark, panel: -0.13 } and shows 70%', gl.length === 4 && JSON.stringify(gl[3].args) === '{"look":"dark","panel":-0.13}' && (await rng(p, GP)).out === '70%', JSON.stringify(gl));
    check('23: Panel opacity says lower is more see-through', /Lower is more see-through/.test(await rowText(p, GP) || ''));
    // a refused write springs back with the reason
    await p.evaluate(() => window.__mockLookRefuse('made up: look.json is read-only'));
    await slide(p, GB, 40);
    await p.waitForTimeout(250);
    const rb = await rng(p, GB);
    check('23: a refused Blur springs back to 21 px with the reason', (await calls(p, 'look.glass')).length === 5 && rb.out === '21 px' && rb.v === '21' && /made up: look\.json is read-only/i.test(rb.text), JSON.stringify(rb));
    await p.evaluate(() => window.__mockLookRefuse(null));
    // reset sends the seed
    await p.click(sel(GR) + ' button');
    await p.waitForTimeout(250);
    gl = await calls(p, 'look.glass');
    const g1 = [await rng(p, GB), await rng(p, GD), await rng(p, GP)].map((x) => x.out).join(' ');
    check('23: Reset glass sends { blurPx: 5, dim: 0.5, panel: 0 } and every slider is back', gl.length === 6 && JSON.stringify(gl[5].args) === '{"look":"dark","blurPx":5,"dim":0.5,"panel":0}' && g1 === '5 px 50% 83%' &&
      await p.$eval(sel(GR) + ' button', (b) => b.disabled), JSON.stringify(gl[5]) + ' ' + g1);
    // accent: own -> custom -> a hue -> own -> custom keeps the last hue
    await p.click(sel(AM) + ' button[data-v="custom"]');
    await p.waitForTimeout(250);
    let ac = await calls(p, 'look.accent');
    check('23: Custom hue sends { hue: 212 } and turns the hue slider on at 212°', ac.length === 1 && ac[0].args.hue === 212 && await seg(p, AM) === 'Custom hue' && !(await rng(p, AH)).dis && (await rng(p, AH)).out === '212°', JSON.stringify(ac));
    await slide(p, AH, 30);
    await p.waitForTimeout(250);
    ac = await calls(p, 'look.accent');
    check('23: the hue slider sends { hue: 30 }', ac.length === 2 && ac[1].args.hue === 30 && (await rng(p, AH)).out === '30°', JSON.stringify(ac));
    await p.click(sel(AM) + ' button[data-v="own"]');
    await p.waitForTimeout(250);
    ac = await calls(p, 'look.accent');
    check("23: Mantle's own sends { hue: null } and the hue slider goes off", ac.length === 3 && ac[2].args.hue === null && 'hue' in ac[2].args && (await rng(p, AH)).dis, JSON.stringify(ac));
    await p.click(sel(AM) + ' button[data-v="custom"]');
    await p.waitForTimeout(250);
    ac = await calls(p, 'look.accent');
    check('23: Custom hue again brings back the last hue (30)', ac.length === 4 && ac[3].args.hue === 30, JSON.stringify(ac));
    // a change made in Helm or Quartz redraws every row within a second
    const t0 = Date.now();
    await p.evaluate(() => window.__mockLook({ glass: { blurPx: 12, dim: 0.7, panel: 0.1 }, accent: { hue: 300 }, sync: { by: 'Helm', text: null },
      desktop: { text: 'Shared with Helm and Quartz: "Lake" (rev 44)', rev: 44 } }));
    const redrawn = await p.waitForFunction((s) => {
      const q = (r) => `[data-row="${r}"]`;
      const t = (r) => (document.querySelector(q(r)) || {}).textContent || '';
      const out = (r) => { const e = document.querySelector(q(r) + ' .rng-v'); return e ? e.textContent : ''; };
      return out(s.GB) === '12 px' && out(s.GD) === '70%' && out(s.GP) === '93%' && out(s.AH) === '300°' && /last change from Helm/.test(t(s.LST)) && /"Lake" \(rev 44\)/.test(t(s.LDK));
    }, { GB, GD, GP, AH, LST, LDK }, { timeout: 1000, polling: 50 }).then(() => true, () => false);
    check("23: a 'look' event from Helm redraws every row within 1 s", redrawn && Date.now() - t0 < 1500 && await seg(p, AM) === 'Custom hue',
      JSON.stringify([await rng(p, GB), await rng(p, GD), await rng(p, GP), await rng(p, AH), await rowText(p, LST), await rowText(p, LDK)].map((x) => x && (x.out || x))));
    check('23: the look rows never touch Windows or the theme', (await calls(p, SETC)).length === 0 && (await calls(p, 'theme.set')).length === 0);
  }],
  ['perso-24-look-trouble', PG('colors'), async (p) => {
    // sync could not write: the status warns with the reason
    await p.evaluate(() => window.__mockLook({ sync: { state: 'error', reason: "made up: Can't write %APPDATA%\\look-sync: EPERM", text: 'On · not shared yet' } }));
    await p.waitForTimeout(150);
    const st = await rowText(p, LST) || '';
    check('24: a sync error shows its text, the warn pip and the reason in plain words (no raw EPERM)', /On · not shared yet/.test(st) && /made up: Can't write %APPDATA%\\look-sync/i.test(st) && !/EPERM/.test(st) && await p.$eval(sel(LST) + ' .pip', (e) => e.classList.contains('warn')), st);
    check('24: the reason is not shown twice when the text already has it', await (async () => {
      await p.evaluate(() => window.__mockLook({ sync: { state: 'missing', reason: 'made up: look.json is not there yet', text: 'On · not shared yet: made up: look.json is not there yet' } }));
      await p.waitForTimeout(150);
      return ((await rowText(p, LST) || '').match(/look\.json is not there yet/g) || []).length === 1;
    })(), await rowText(p, LST));
    // the wallpaper could not be shared, Windows' could not be set
    await p.evaluate(() => window.__mockLook({ desktop: { ok: false, text: 'Not shared', reason: 'made up: the wallpaper still could not be made' },
      windows: { ok: false, text: "Windows' wallpaper was not changed", reason: 'made up: SystemParametersInfo said no' } }));
    await p.waitForTimeout(150);
    const dk = await rowText(p, LDK) || '';
    check('24: desktop and Windows failures each show their reason', /Not shared/.test(dk) && /made up: the wallpaper still could not be made/i.test(dk) &&
      /Windows' wallpaper was not changed/.test(dk) && /Windows' wallpaper: made up: SystemParametersInfo said no/.test(dk), dk);
    // the shared top-band darkening (lane guard-mantle): its value under the status line when shared,
    // the reason on the status line (warn pip) when it could not be worked out
    await p.evaluate(() => window.__mockLook({ sync: { state: 'ok', reason: null, text: 'On · in sync (last change from Quartz, rev 50)' },
      guard: { ok: true, text: 'Top band darkened to 54% for Helm, Quartz and Mantle', reason: null, alpha: 0.54 } }));
    await p.waitForTimeout(150);
    const gOk = await rowText(p, LST) || '';
    check('24: the shared darkening shows its value under the sync status', /Top band darkened to 54% for Helm, Quartz and Mantle/.test(gOk) && await p.$eval(sel(LST) + ' .pip', (e) => e.classList.contains('ok')), gOk);
    await p.evaluate(() => window.__mockLook({ guard: { ok: false, text: 'Top-band darkening not shared: each app works out its own', reason: 'made up: the still\'s top band could not be read as pixels', alpha: null } }));
    await p.waitForTimeout(150);
    const gBad = await rowText(p, LST) || '';
    check('24: a darkening failure warns on the sync status line with its reason', /On · in sync/.test(gBad) && /Top-band darkening not shared: made up: the still's top band could not be read as pixels/.test(gBad)
      && !/darkened to 54%/.test(gBad) && await p.$eval(sel(LST) + ' .pip', (e) => e.classList.contains('warn')), gBad);
    // guard.light (CONTRACT "Light look"): its value beside the dark one; a light-only failure warns with its reason
    await p.evaluate(() => window.__mockLook({ guard: { ok: true, text: 'Top band darkened to 54% for Helm, Quartz and Mantle', reason: null, alpha: 0.54, light: { ok: true, alpha: 0.47, contrast: 4.9, reason: null } } }));
    await p.waitForTimeout(150);
    const glOk = await rowText(p, LST) || '';
    check('24: the light top band shows its white under the sync status', /Light top band: white 47% for Helm and Quartz/.test(glOk) && await p.$eval(sel(LST) + ' .pip', (e) => e.classList.contains('ok')), glOk);
    await p.evaluate(() => window.__mockLook({ guard: { ok: true, text: 'Top band darkened to 54% for Helm, Quartz and Mantle', reason: null, alpha: 0.54, light: { ok: false, alpha: null, contrast: null, reason: 'made up: the light band could not be read' } } }));
    await p.waitForTimeout(150);
    const glBad = await rowText(p, LST) || '';
    check('24: a light-only failure warns with its reason (the dark value still shows)', /Light top band not shared: made up: the light band could not be read/.test(glBad) && /darkened to 54%/.test(glBad)
      && await p.$eval(sel(LST) + ' .pip', (e) => e.classList.contains('warn')), glBad);
    await p.evaluate(() => window.__mockLook({ guard: { ok: true, text: 'Top band darkened to 54% for Helm, Quartz and Mantle', reason: null, alpha: 0.54, light: null } }));
    // a newer Helm or Quartz: glass and accent are read-only with the reason; sync stays usable
    await p.evaluate(() => window.__mockLook({ sync: { state: 'newer', reason: 'made up: Quartz 3.0 wrote look.json in a newer format', text: 'On · read only' } }));
    await p.waitForTimeout(150);
    const ro = await p.evaluate((rows) => rows.map((r) => {
      const e = document.querySelector(`[data-row="${r}"]`);
      const c = [...e.querySelectorAll('input, button')];
      return { r, dis: c.length > 0 && c.every((x) => x.disabled), why: /Read only here: made up: Quartz 3\.0 wrote look\.json in a newer format/.test(e.textContent) };
    }), [GB, GD, GP, AM, AH]);
    check("24: state 'newer' disables the sliders and the accent rows WITH the reason", ro.every((x) => x.dis && x.why), JSON.stringify(ro));
    check("24: ...and sync itself can still be switched", !(await p.$eval(sw(LS), (b) => b.disabled)));
    await p.evaluate(() => window.__mockLook({ sync: { state: 'ok', reason: null, text: null } }));
    await p.waitForTimeout(150);
    check('24: back in sync, the rows open again', !(await rng(p, GB)).dis && !(await p.$eval(sel(AM) + ' button[data-v="custom"]', (b) => b.disabled)));
  }],
  ['perso-25-look-unreadable', PG('colors', '&mock=failing'), async (p) => {
    const rows = [LS, LST, LDK, GB, GD, GP, GR, AM, AH];
    const st = await p.evaluate((rs) => rs.map((r) => {
      const e = document.querySelector(`[data-row="${r}"]`);
      const c = [...e.querySelectorAll('input, button')];
      return { r, dis: c.every((x) => x.disabled), why: /Mantle's shared look could not be read: made up: the shared look file could not be read \(look\.json is locked by another program\)/.test(e.textContent) };
    }), rows);
    check('25: an unreadable look.get disables every row WITH the reason', st.every((x) => x.dis && x.why), JSON.stringify(st));
    await p.evaluate(() => window.__mockEmit('look', { ok: true, theme: 'dark', sync: { on: true, state: 'ok', text: 'On · in sync', reason: null }, glass: { blurPx: 9, dim: 0.4, panel: 0 },
      ranges: {}, accent: { hue: null }, desktop: { ok: true, text: 'Shared', reason: null }, windows: { ok: true, text: "Windows' wallpaper matches", reason: null } }));
    await p.waitForTimeout(150);
    check("25: a good 'look' event later brings the rows back", !(await rng(p, GB)).dis && (await rng(p, GB)).out === '9 px' && !/could not be read/.test(await rowText(p, GB) || ''));
  }],
  ['perso-26-look-light', PG('colors', '&theme=light'), async (p) => {
    await p.setViewportSize({ width: 1280, height: 900 });
    check('26: painted light', await p.evaluate(() => document.documentElement.dataset.theme) === 'light');
    // the light look un-held (CONTRACT "Light look", 2026-10-14): in light the sliders edit glass.light, and say so
    check('26: light: the sliders say they edit the light look', /Editing the light look/.test(await rowText(p, GB) || ''), await rowText(p, GB));
    const l0 = [await rng(p, GB), await rng(p, GD), await rng(p, GP)];
    check('26: light: the sliders show the light glass (12 px, 45%, 76%)', l0.map((x) => x.out).join(' ') === '12 px 45% 76%' && l0.every((x) => !x.dis), JSON.stringify(l0));
    check('26: light: Bar tint says how white', /How white the bar's glass is/.test(await rowText(p, GD) || ''), await rowText(p, GD));
    check('26: light: Reset names the light defaults', /Blur 12 px, bar tint 45%, panel opacity 76% \(the light look\)/.test(await rowText(p, GR) || ''), await rowText(p, GR));
    await slide(p, GD, 60);
    await p.waitForTimeout(250);
    const gl = await calls(p, 'look.glass');
    check('26: light: Bar tint 60% sends { look: light, dim: 0.6 }', gl.length === 1 && JSON.stringify(gl[0].args) === '{"look":"light","dim":0.6}' && (await rng(p, GD)).out === '60%', JSON.stringify(gl));
    await p.evaluate(() => window.__mockWindowsMode('dark'));
    await p.waitForTimeout(200);
    check('26: Match Windows going dark: the sliders edit the dark look and show it (the look event carries the theme)', /Editing the dark look/.test(await rowText(p, GB) || '')
      && (await rng(p, GD)).out === '50%' && (await rng(p, GB)).out === '5 px', await rowText(p, GB));
    await p.evaluate(() => window.__mockWindowsMode('light'));
    await p.waitForTimeout(200);
    await p.$eval(sel('personalization.colors.mantle-mode'), (e) => e.scrollIntoView({ block: 'start' }));
  }],
  ['perso-27-look-dark', PG('colors', '&theme=dark'), async (p) => {
    await p.setViewportSize({ width: 1280, height: 900 });
    check('27: painted dark', await p.evaluate(() => document.documentElement.dataset.theme) === 'dark');
    check('27: dark: the sliders say they edit the dark look', /Editing the dark look/.test(await rowText(p, GB) || ''), await rowText(p, GB));
    await p.click(sel(AM) + ' button[data-v="custom"]');
    await p.waitForTimeout(250);
    await p.$eval(sel('personalization.colors.mantle-mode'), (e) => e.scrollIntoView({ block: 'start' }));
  }],
  ['perso-12-usage', PG('device-usage'), async (p) => {
    check('12: seven uses, read-only with the reason', await p.locator('[data-row^="personalization.usage.list."]').count() === 7 && /Read only here: Windows keeps device usage/.test(await p.textContent('#page')));
  }],
  ['perso-22-gallery-legacy', PG('background', '&perso=legacy'), async (p) => {
    const row = await rowText(p, MW) || '';
    check("22: with no presets/current sent, his own pick is found from items", /Made-up Rain \(Video\)/.test(row) && /2 in its library/.test(row), row);
    check('22: the gallery says why it is empty', /The built-in wallpapers could not be read: this Mantle sends no built-in list/.test(await p.textContent('#page')) && await p.locator('[data-builtin-id]').count() === 0);
  }],
].concat(...['', '&theme=dark'].map((t) => galleryShots(t)));

/* ---- the built-in wallpapers (lane mantle-bg-settings): every scene runs light and dark */
const MW = 'personalization.background.mantle';
const BI = 'personalization.background.builtin';
const CATS = ['Mountains', 'Forest', 'Water', 'Coast', 'Desert', 'Sky & Night', 'Snow', 'City', 'Abstract', 'Minimal'];
const P = (id) => PRESETS.find((x) => x.id === id);
const tiles = (p) => p.$$eval('[data-builtin-id]', (l) => l.map((t) => ({ id: t.dataset.builtinId, on: t.getAttribute('aria-checked') === 'true', shown: t.offsetParent !== null,
  check: getComputedStyle(t.querySelector('[data-check]')).display !== 'none', dis: t.getAttribute('aria-disabled') === 'true', tip: t.title, label: t.getAttribute('aria-label'),
  dim: t.querySelector('img').style.opacity, tab: t.tabIndex })));
const picked = async (p) => (await tiles(p)).filter((t) => t.on).map((t) => t.id).join(',');
const credLine = (p) => p.textContent('[data-credit-line]');
const active = (p) => p.evaluate(() => (document.activeElement && document.activeElement.dataset.builtinId) || null);
const lastSet = async (p) => { const c = await calls(p, 'wallpaper.set'); return c.length ? c[c.length - 1].args.id : null; };
const describes = (row, it) => row.includes(it.title + ' (Built-in photo)') && row.includes('Photo by ' + it.credit + ' on Unsplash') && /2 in its library/.test(row) && !/25 in its library/.test(row);
const toGallery = (p) => p.$eval(sel(BI), (e) => e.scrollIntoView({ block: 'start' }));

function galleryShots(t) {
  const T = t ? 'dark' : 'light', N = t ? '-dark' : '';
  const dark = async (p, n) => { if (t) check(`${n} ${T}: painted dark`, await p.evaluate(() => document.documentElement.dataset.theme) === 'dark'); };
  return [
    ['perso-17-gallery' + N, PG('background', t), async (p) => {
      await dark(p, '17');
      const ts = await tiles(p);
      check(`17 ${T}: 23 tiles in the catalog's order`, ts.length === 23 && ts.map((x) => x.id).join() === PRESETS.map((x) => x.id).join(), ts.map((x) => x.id).join());
      check(`17 ${T}: tiles are radios in one radiogroup, each named (aria-label + tooltip with its photographer)`, await p.$$eval('[role="radiogroup"] > button[role="radio"][data-builtin-id]', (l) => l.length) === 23 &&
        ts.every((x) => x.label === P(x.id).title && x.tip.startsWith(P(x.id).title + ' · Photo by ' + P(x.id).credit)));
      const chips = await p.$$eval('[data-cat]', (l) => l.map((b) => b.dataset.cat + '=' + b.getAttribute('aria-pressed')));
      check(`17 ${T}: chips are All then the categories in order, All pressed`, chips.join('|') === ['All=true'].concat(CATS.map((c) => c + '=false')).join('|'), chips.join('|'));
      check(`17 ${T}: his own pick: no tile checked, the neutral credit line`, !ts.some((x) => x.on || x.check) &&
        (await credLine(p)) === 'Photos from Unsplash, free under the Unsplash License. Pick one to use it; its photographer is credited here.', await credLine(p));
      const row = await rowText(p, MW) || '';
      check(`17 ${T}: his own pick still reads (Video), the library counts only his own`, /Made-up Rain \(Video\)/.test(row) && /2 in its library/.test(row), row);
      check(`17 ${T}: Open Wallpapers is still there`, await p.locator(sel('personalization.background.wallpapers') + ' button').count() === 1);
      check(`17 ${T}: one tab stop in the grid`, ts.filter((x) => x.tab === 0).length === 1 && ts[0].tab === 0);
      await p.click('[data-cat="Snow"]');
      const snow = (await tiles(p)).filter((x) => x.shown).map((x) => x.id);
      check(`17 ${T}: the Snow chip shows its 2 photos`, snow.join() === 'builtin:snow-peak,builtin:snow-ridge', snow.join());
      check(`17 ${T}: Snow is pressed, All is not`, await p.$eval('[data-cat="Snow"]', (b) => b.getAttribute('aria-pressed')) === 'true' && await p.$eval('[data-cat="All"]', (b) => b.getAttribute('aria-pressed')) === 'false');
      check(`17 ${T}: Shuffle says what it does`, await p.$eval('[data-shuffle]', (b) => b.title) === 'Use a random built-in photo');
      await p.click('[data-shuffle]');
      await p.waitForTimeout(300);
      const sh = await calls(p, 'wallpaper.shuffle');
      check(`17 ${T}: Shuffle sends the active chip's category`, sh.length === 1 && sh[0].args.category === 'Snow', JSON.stringify(sh));
      check(`17 ${T}: after Shuffle the Snow photo is checked and the row names it`, await picked(p) === 'builtin:snow-peak' && describes(await rowText(p, MW) || '', P('builtin:snow-peak')), await rowText(p, MW));
      await p.click('[data-cat="All"]');
      check(`17 ${T}: All shows the 23 again`, (await tiles(p)).filter((x) => x.shown).length === 23);
      await p.click('[data-builtin-id="builtin:lake"]');
      await p.waitForTimeout(300);
      const s1 = await calls(p, 'wallpaper.set');
      check(`17 ${T}: a click sends wallpaper.set with its id`, s1.length === 1 && s1[0].args.id === 'builtin:lake' && Object.keys(s1[0].args).length === 1, JSON.stringify(s1));
      const a1 = await tiles(p);
      check(`17 ${T}: the check mark moved to it after the re-read`, a1.filter((x) => x.on).map((x) => x.id).join() === 'builtin:lake' && a1.filter((x) => x.check).map((x) => x.id).join() === 'builtin:lake');
      check(`17 ${T}: the pick wears the accent border`, await p.$eval('[data-builtin-id="builtin:lake"]', (b) => /var\(--lg-acc\)/.test(b.style.boxShadow)) &&
        await p.$eval('[data-builtin-id="builtin:stone"]', (b) => !/--lg-acc\)/.test(b.style.boxShadow)));
      const L = P('builtin:lake');
      check(`17 ${T}: the row describes the built-in pick with its credit`, describes(await rowText(p, MW) || '', L), await rowText(p, MW));
      check(`17 ${T}: the credit line is its title and photographer`, (await credLine(p)) === L.title + ' · Photo by ' + L.credit + ' on Unsplash', await credLine(p));
      await p.focus('[data-builtin-id="builtin:forest"]');
      await p.keyboard.press('Enter');
      await p.waitForTimeout(300);
      check(`17 ${T}: Enter on a focused tile picks it, focus stays`, await lastSet(p) === 'builtin:forest' && await picked(p) === 'builtin:forest' && await active(p) === 'builtin:forest');
      await p.focus('[data-builtin-id="builtin:stone"]');
      await p.keyboard.press(' ');
      await p.waitForTimeout(300);
      check(`17 ${T}: Space on a focused tile picks it`, await lastSet(p) === 'builtin:stone' && await picked(p) === 'builtin:stone' && await active(p) === 'builtin:stone');
      check(`17 ${T}: the pick is the grid's tab stop`, (await tiles(p)).filter((x) => x.tab === 0).map((x) => x.id).join() === 'builtin:stone');
      await p.keyboard.press('ArrowRight');
      await p.waitForTimeout(250);   // dark's ring eases in over --lg-dur-ui
      check(`17 ${T}: ArrowRight moves to the next photo, with a focus ring`, await active(p) === 'builtin:cloud-peaks' &&
        /* light: a solid outline; dark: Helm's ring, box-shadow var(--lg-focus), no outline (lane same-finish) */
        await p.evaluate((dk) => { const cs = getComputedStyle(document.activeElement);
          return dk ? cs.outlineStyle === 'none' && /rgba\(159, 180, 204, 0\.55\) 0px 0px 0px 3px/.test(cs.boxShadow) : cs.outlineStyle === 'solid'; }, T === 'dark'));
      await p.keyboard.press('ArrowLeft');
      await p.click('[data-credit]');
      await p.waitForTimeout(200);
      const cr = await calls(p, 'wallpaper.creditOpen');
      check(`17 ${T}: the credit link sends wallpaper.creditOpen with the pick`, cr.length === 1 && cr[0].args.id === 'builtin:stone', JSON.stringify(cr));
      check(`17 ${T}: its test-run answer is shown`, /Test run, nothing opened: Mantle would open the photo's Unsplash page/.test(await p.textContent('#page')));
      check(`17 ${T}: no other wallpaper command was sent`, (await calls(p, 'wallpaper.set')).length === 3);
      await toGallery(p);
    }],
    ['perso-18-gallery-picked' + N, PG('background', '&perso=builtin' + t), async (p) => {
      await dark(p, '18');
      const S = P('builtin:stone');
      const row = await rowText(p, MW) || '';
      check(`18 ${T}: the row reads "Stone summit (Built-in photo)" with "Photo by Fabrizio Conti on Unsplash"`, describes(row, S) && /Stone summit \(Built-in photo\)/.test(row) && /Photo by Fabrizio Conti on Unsplash/.test(row), row);
      check(`18 ${T}: Stone summit is checked`, await picked(p) === 'builtin:stone' && (await tiles(p)).find((x) => x.id === 'builtin:stone').check);
      check(`18 ${T}: the credit line names it`, (await credLine(p)) === 'Stone summit · Photo by Fabrizio Conti on Unsplash');
      check(`18 ${T}: the credit is a link to its Unsplash page`, await p.$eval('[data-credit]', (a) => a.tagName === 'A' && a.textContent === 'Fabrizio Conti' && /^https:\/\/unsplash\.com\//.test(a.getAttribute('href'))));
      check(`18 ${T}: every thumbnail loaded`, await p.$$eval('[data-builtin-id] img', (l) => l.every((i) => i.complete && i.naturalWidth > 0)));
      await p.$eval(sel(MW), (e) => e.scrollIntoView({ block: 'start' }));   // this shot shows the row naming the pick
    }],
    ['perso-19-gallery-bad' + N, PG('background', '&perso=tilebad' + t), async (p) => {
      await dark(p, '19');
      const pg = () => p.textContent('#page');
      check(`19 ${T}: the catalog's note is shown`, /Made up: 1 line of the built-in list was damaged, so it is left out/.test(await pg()), (await pg()).slice(-600));   // the kit capitalises a note
      const bad = (await tiles(p)).find((x) => x.id === 'builtin:snow-ridge');
      check(`19 ${T}: a photo that cannot be used is dimmed, aria-disabled, and its tooltip says why`, bad.dis && bad.dim === '0.4' && /cannot be used, made up: its photo file is missing/.test(bad.tip) && /cannot be used/.test(bad.label), JSON.stringify(bad));
      check(`19 ${T}: it carries the warning mark`, await p.$eval('[data-builtin-id="builtin:snow-ridge"] [data-warn]', (w) => getComputedStyle(w).display !== 'none'));
      check(`19 ${T}: a thumb note is on that tile's tooltip`, /Its small preview is missing, so the full photo is shown instead\./.test((await tiles(p)).find((x) => x.id === 'builtin:forest').tip));
      await p.click('[data-builtin-id="builtin:snow-ridge"]', { force: true });   // aria-disabled: playwright would wait for it to enable
      await p.waitForTimeout(200);
      check(`19 ${T}: clicking it sends nothing and shows the reason`, (await calls(p, 'wallpaper.set')).length === 0 && /cannot be used: made up: its photo file is missing/.test(await pg()));
      await p.focus('[data-builtin-id="builtin:lake"]');
      check(`19 ${T}: focusing a good photo clears that reason`, !/cannot be used: made up/.test(await pg()));
      await p.focus('[data-builtin-id="builtin:snow-ridge"]');
      check(`19 ${T}: focusing it (keyboard) shows the reason again`, /cannot be used: made up: its photo file is missing/.test(await pg()));
      await toGallery(p);
    }],
    ['perso-20-gallery-catalog' + N, PG('background', '&perso=catbad' + t), async (p) => {
      await dark(p, '20');
      check(`20 ${T}: an unreadable catalog shows its reason instead of a grid`, /The built-in wallpapers could not be read: made up: the list of built-in wallpapers \(catalog\.json\) is missing/.test(await p.textContent('#page')) &&
        await p.locator('[data-builtin-id]').count() === 0 && !(await p.isVisible('[data-shuffle]')));
      check(`20 ${T}: his own wallpaper row and Open Wallpapers are untouched`, /Made-up Rain \(Video\)/.test(await rowText(p, MW) || '') && await p.locator(sel('personalization.background.wallpapers') + ' button').count() === 1);
      await toGallery(p);
    }],
    ['perso-21-gallery-refused' + N, PG('background', '&perso=setbad' + t), async (p) => {
      await dark(p, '21');
      await p.click('[data-builtin-id="builtin:lake"]');
      await p.waitForTimeout(250);
      check(`21 ${T}: a refused pick shows its reason, the check stays`, (await calls(p, 'wallpaper.set')).length === 1 &&
        new RegExp('"' + P('builtin:lake').title + '" could not be used: made up: Mantle\'s wallpaper library could not be saved').test(await p.textContent('#page')) && await picked(p) === 'builtin:stone');
      await p.click('[data-shuffle]');
      await p.waitForTimeout(250);
      check(`21 ${T}: a refused Shuffle shows its reason`, /Shuffle did not pick a photo: made up: no built-in photo could be used/.test(await p.textContent('#page')));
      await p.click('[data-credit]');
      await p.waitForTimeout(200);
      check(`21 ${T}: a refused credit link shows its reason`, /The photo's Unsplash page could not be opened: made up: the photo's page could not be opened/.test(await p.textContent('#page')));
      await toGallery(p);
    }],
  ];
}

async function browserTests() {
  const g = gaming();
  if (g !== 0) { console.log(g > 0 ? 'PART 2 SKIPPED: a game is running' : 'PART 2 SKIPPED: could not check for a running game'); failures.push('part 2 (the page on the mock) was not run'); return; }
  const { chromium } = require(PLAYWRIGHT);
  fs.mkdirSync(OUT, { recursive: true });
  // lowcpu.js queues the launch behind the machine-wide one-browser lock for up to 8 minutes; playwright's
  // default 3-minute launch timeout gave up on a queued launch first (2026-10-08, other lanes shooting)
  const browser = await chromium.launch({ headless: true, timeout: 9 * 60 * 1000 });
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
    await ctx.addInitScript((d) => { window.__PRESETS = d; }, PRESETS);
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
