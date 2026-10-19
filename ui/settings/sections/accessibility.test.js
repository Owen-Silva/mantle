require('../../../tools/dev-env.js').lowcpu();
/* accessibility.test.js — Mantle Settings > Accessibility (lane access, 2026-09-29).
 *
 * PART 1 (node, always): the main half (lib/features/_settings-sections/accessibility.js) against
 * sidecar/SysAccess*.cs: every command it asks is a real access.* command, no administrator actions,
 * a test run sends EVERY write (a change AND starting a tool) as a dryRun, and a live change shows the
 * read-back. The page file's shape (model.js checkSection), its search rows and URI claims, and that
 * every key the page draws is one the sidecar answers (and every sidecar key is drawn).
 *
 * PART 2 (headless chromium over file://, never Electron, never a real setting): the REAL page file on
 * the settings lane's mock (mock-mantle.js), with settings.accessibility.* played by FAKE() over MADE-UP
 * fixtures. Every page is opened and must draw every search row it declares; some are shot to
 * MANTLE_SHOOT_OUT (default %TEMP%/mantle-shots/access). Line 1 is the CPU cap and browser lock.
 *
 *   node ui/settings/sections/accessibility.test.js      (ONLY=acc-02 for some shots)
 * Prints "ACCESSIBILITY PAGE TEST: n passed, m failed". A game running = part 2 is skipped (and said).
 */
'use strict';
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PAGE = 'file:///' + path.resolve(__dirname, '..', 'index.html').replace(/\\/g, '/');
const OUT = process.env.MANTLE_SHOOT_OUT ||
  path.join(require('os').tmpdir(), 'mantle-shots', 'access');
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
  const cs = ['SysAccess.cs', 'SysAccessTools.cs'].map((f) => fs.readFileSync(path.join(ROOT, 'sidecar', f), 'utf8')).join('\n');
  const cmds = new Set([...cs.matchAll(/t\.Add\("(access\.[A-Za-z]+)"/g)].map((m) => m[1]));
  const main = require(path.join(ROOT, 'lib', 'features', '_settings-sections', 'accessibility.js'));
  check('main: id is accessibility', main.id === 'accessibility');
  check('main: every command it asks is a real SysAccess command', Object.values(main.SIDECAR).every((c) => cmds.has(c)), Object.values(main.SIDECAR).filter((c) => !cmds.has(c)).join(' '));
  check('main: every SysAccess command can be reached', [...cmds].every((c) => Object.values(main.SIDECAR).includes(c)), [...cmds].join(' '));
  check('main: every page command is exported', Object.keys(main.SIDECAR).every((k) => typeof main.commands[k] === 'function'));
  check('main + sidecar: no administrator actions (per-user settings only)', main.ADMIN.length === 0 && !/\[Elevated\(/.test(cs));

  const sent = [];
  const mk = (test) => ({ id: 'accessibility', test, log() {}, push() {}, elevate: async () => { throw new Error('no elevation here'); },
    sidecar: { on: () => () => {}, send: async (c, a) => {
      sent.push([c, a]);
      if (a.dryRun) return { ok: true, result: { ok: true, dryRun: true, would: c === 'access.start' ? 'start Magnifier (Magnify.exe from Windows\' System32)' : 'turn the Sticky keys keyboard shortcut off' } };
      if (c === 'access.start') return { ok: true, result: { ok: true, started: true, now: true } };
      return { ok: true, result: { ok: true, now: a.value, note: null } };
    } } });
  const T = mk(true), L = mk(false);
  for (const [cmd, args] of [['set', { key: 'stickyShortcut', value: false }], ['set', { key: 'textSize', value: 150 }], ['set', { key: 'contrastTheme', value: 'aquatic' }],
    ['start', { tool: 'magnifier' }], ['start', { tool: 'narrator' }]]) {
    sent.length = 0;
    const r = await main.commands[cmd](args, T);
    check(`test run: ${cmd} ${args.key || args.tool} is a dry run`, r.ok && r.dryRun === true && sent.length === 1 && sent[0][1].dryRun === true && /^Test run, nothing changed/.test(r.reason), JSON.stringify([r, sent]));
  }
  sent.length = 0;
  const u = await main.commands.set({ key: 'stickyShortcut', value: false }, L);
  check('live: a change sends no dryRun and shows the read-back', u.ok && u.value === false && sent[0][0] === 'access.set' && sent[0][1].dryRun === false && sent[0][1].key === 'stickyShortcut', JSON.stringify([u, sent]));
  sent.length = 0;
  const st = await main.commands.start({ tool: 'magnifier' }, L);
  check('live: start asks access.start with only the tool', st.ok && sent[0][0] === 'access.start' && JSON.stringify(Object.keys(sent[0][1]).sort()) === '["dryRun","tool"]' && !('value' in st), JSON.stringify([st, sent]));
  sent.length = 0;
  const nb = await main.commands.set({ value: true }, L);
  const nv = await main.commands.set({ key: 'stickyOn' }, L);
  const nt = await main.commands.start({}, L);
  check('main: no key, no value or no tool is refused before the sidecar', nb.ok === false && nv.ok === false && nt.ok === false && sent.length === 0, JSON.stringify([nb, nv, nt]));

  // the page file
  const M = require(path.join(ROOT, 'ui', 'settings', 'model.js'));
  const src = fs.readFileSync(path.join(ROOT, 'ui', 'settings', 'sections', 'accessibility.js'), 'utf8');
  vm.runInNewContext(src, { MantleSettings: { section(x) { DEF = x; } }, window: {}, document: { currentScript: { dataset: { section: 'accessibility' } } }, console });
  check('page: checkSection is happy', DEF && M.checkSection(DEF, 'accessibility') === null, DEF && M.checkSection(DEF, 'accessibility'));
  check('page: order 90 in the Windows group, replaces nothing', DEF && DEF.order === 90 && DEF.group === 'windows' && DEF.replaces === undefined);
  const ids = DEF ? DEF.pages.map((p) => p.id) : [];
  const WANT = ['text-size', 'visual-effects', 'mouse-pointer', 'text-cursor', 'magnifier', 'color-filters', 'contrast-themes', 'narrator', 'audio', 'captions', 'speech', 'keyboard', 'mouse', 'eye-control'];
  check('page: the 14 pages of Windows\' Accessibility, in its order', ids.join() === WANT.join(), ids.join(' '));
  const rows = DEF ? DEF.pages.flatMap((p) => p.search || []) : [];
  check('page: every page has search rows, every row is accessibility.<page>.*', DEF && DEF.pages.every((p) => (p.search || []).length && p.search.every((r) => r.row.startsWith('accessibility.' + p.id + '.'))));
  check('page: row ids are unique', new Set(rows.map((r) => r.row)).size === rows.length);
  const uris = rows.filter((r) => r.uri).map((r) => r.uri);
  const URIS = ['ms-settings:easeofaccess', 'ms-settings:easeofaccess-display', 'ms-settings:easeofaccess-visualeffects', 'ms-settings:easeofaccess-mousepointer',
    'ms-settings:easeofaccess-cursor', 'ms-settings:easeofaccess-magnifier', 'ms-settings:easeofaccess-colorfilter', 'ms-settings:easeofaccess-highcontrast',
    'ms-settings:easeofaccess-narrator', 'ms-settings:easeofaccess-audio', 'ms-settings:easeofaccess-closedcaptioning', 'ms-settings:easeofaccess-speechrecognition',
    'ms-settings:easeofaccess-keyboard', 'ms-settings:easeofaccess-mouse', 'ms-settings:easeofaccess-eyecontrol'];
  check('page: claims every Accessibility ms-settings page once', uris.length === URIS.length && new Set(uris).size === uris.length && URIS.every((x) => uris.includes(x)), uris.join(' '));
  check('page: never opens Windows Settings (no kit.openWindows)', !/openWindows/.test(src));
  const catalog = fs.readFileSync(path.join(ROOT, 'lib', 'launcher-index.js'), 'utf8');
  check('page: every launcher-catalog easeofaccess page is claimed', [...catalog.matchAll(/'(ms-settings:easeofaccess[a-z-]*)'/g)].every((m) => uris.includes(m[1])));

  // every key the page draws is one the sidecar answers, and every sidecar key is drawn
  const sideKeys = new Set([...cs.matchAll(/\b(?:RegBool|RegNum|SpiBool|SpiNum|Flags?|Field|ReadOnlyReg|Fixed|SignIn|RegBoolEntry|RegNumEntry|E)\("([a-z][A-Za-z]+)"/g)].map((m) => m[1])
    .concat([...cs.matchAll(/\.Key = "([a-z][A-Za-z]+)"/g)].map((m) => m[1])).filter((k) => k !== 'key'));
  const pageKeys = new Set([...src.matchAll(/B\.(?:toggle|choice|slider|number|status)\('([A-Za-z]+)'/g)].map((m) => m[1]));
  check('page: every key it draws is a sidecar key', [...pageKeys].every((k) => sideKeys.has(k)), [...pageKeys].filter((k) => !sideKeys.has(k)).join(' '));
  check('page: every sidecar key is drawn', [...sideKeys].every((k) => pageKeys.has(k)), [...sideKeys].filter((k) => !pageKeys.has(k)).join(' '));
  const toolsBlock = (cs.match(/string\[\]\[\] TOOLS = \{([\s\S]*?)\r?\n\s*\};/) || ['', ''])[1];
  const sideTools = new Set([...toolsBlock.matchAll(/new\[\] \{ "([a-zA-Z]+)", "/g)].map((m) => m[1]));
  const pageTools = new Set([...src.matchAll(/B\.tool\('([A-Za-z]+)'/g)].map((m) => m[1]));
  check('page: every tool it starts is a sidecar tool, and all five are drawn', pageTools.size === 5 && [...pageTools].every((k) => sideTools.has(k)) && sideTools.size === 5, [...pageTools].join(' ') + ' / ' + [...sideTools].join(' '));
  console.log(`  (${pageKeys.size} keys drawn, ${sideKeys.size} in the sidecar, ${rows.length} search rows)`);
}

/* ================================================================ PART 2: the page on the mock */
function FAKE() {
  const q = new URLSearchParams(location.search);
  const TEST = q.get('test') === '1', SCN = q.get('acc') || 'normal';
  const later = (ms, v) => new Promise((res) => setTimeout(() => res(v), ms));
  const V = (value, extra) => Object.assign({ value, set: true, why: null, readOnly: null }, extra || {});
  const RO = (value, why) => V(value, { readOnly: why });
  function settings() {
    if (SCN === 'fail') return { ok: false, reason: 'access.settings failed (the sidecar is not running)' };
    const themes = [{ value: 'none', label: 'None', present: true }, { value: 'aquatic', label: 'Aquatic', file: 'hcblack.theme', present: true },
      { value: 'desert', label: 'Desert', file: 'hcwhite.theme', present: true }, { value: 'dusk', label: 'Dusk', file: 'hc1.theme', present: true },
      { value: 'nightSky', label: 'Night sky', file: 'hc2.theme', present: true }];
    return { ok: true, reason: null, values: {
      textSize: V(125), scrollbars: V(false), transparency: V(true), animations: V(true), notifyDuration: V(15),
      pointerStyle: RO(SCN === 'custom' ? 6 : 1, 'Windows draws the black, inverted and coloured pointers itself, from its own accessibility pointer set built inside its Settings; there is no documented call another program may use to build them, so Mantle shows the style read-only'),
      pointerColor: RO(0x0000FF00, 'The custom pointer colour is built by Windows\' own Settings with the style (see above), so Mantle shows it read-only'),
      pointerSize: V(3), touchIndicator: V(1), caretWidth: V(2),
      contrastTheme: V(SCN === 'custom' ? 'custom' : 'none', { on: SCN === 'custom', scheme: SCN === 'custom' ? 'Made-up Scheme' : 'High Contrast Black', themes }), contrastShortcut: V(true),
      colorFilters: RO(0, 'Windows turns colour filters on and off through its own colour-filtering service (or its shortcut, Windows logo key + Ctrl + C, when that is on below), with no documented call another program may make, so Mantle shows it read-only'),
      colorFilter: V(3), colorFilterShortcut: V(false),
      monoAudio: RO(0, 'Windows\' audio service applies mono audio when its own Settings tells it to; saving the value alone only takes effect after the audio service restarts, so Mantle shows it read-only'),
      flashScreen: V('off'),
      captionStyle: RO(null, 'Windows keeps caption styles in its own Settings\' style editor, with no documented setting another program may change, so Mantle shows them read-only'),
      voiceTyping: RO(null, 'Voice typing is Windows\' own (Windows logo key + H) and keeps its choices in its own Settings, with no documented setting another program may change'),
      eyeControl: RO(null, 'Eye control needs a supported eye tracker and Windows\' own Eye Control app to set it up; Mantle cannot run or change it, so it is read-only here'),
      stickyOn: V(false), stickyShortcut: V(true), stickyIndicator: V(true), stickyLock: V(true), stickyTwoKeysOff: V(false), stickySound: V(true),
      filterOn: V(false), filterShortcut: V(true), filterIndicator: V(true), filterBeep: V(true), toggleOn: V(false), toggleShortcut: V(true),
      shortcutWarning: V(true), shortcutSound: V(true), accessKeys: V(false), printScreen: V(true, { set: false }),
      mouseKeysOn: V(false), mouseKeysShortcut: V(true), mouseKeysIndicator: V(true), mouseKeysNumLock: V(true), mouseKeysModifiers: V(false), mouseKeysSpeed: V(80), mouseKeysAccel: V(3000),
      magZoom: V(200, { set: false }), magIncrement: V(100), magInvert: V(false), magSmooth: V(true), magSignIn: V(false), narratorShortcut: V(true), narratorSignIn: V(false),
      oskSignIn: V(false, { readOnly: SCN === 'missing' ? 'Windows on this PC has no "osk" assistive tool registered to start after sign-in' : null }),
      cursorIndicator: RO(false, 'Windows runs the text cursor indicator as one of its own assistive tools, sized and coloured inside its own Settings, with no documented call another program may make; Mantle shows whether it is on'),
    }, tools: {
      magnifier: { present: true, running: SCN === 'running', why: null }, narrator: { present: true, running: false, why: null }, osk: { present: true, running: false, why: null },
      voiceAccess: { present: true, running: false, why: null },
      liveCaptions: SCN === 'missing' ? { present: false, running: false, why: 'Windows on this PC does not have live captions (LiveCaptions.exe is not in System32)' } : { present: true, running: false, why: null },
    } };
  }
  function write(name, a) {
    if (TEST) return later(30, { ok: true, dryRun: true, reason: 'Test run, nothing changed: Mantle would ' + (name.endsWith('.start') ? 'start ' + a.tool : 'change ' + a.key) });
    if (name.endsWith('.start')) return later(40, { ok: true, started: true, now: true });
    return later(40, { ok: true, value: a.value, note: a.key === 'contrastTheme' ? 'Windows is switching every window to the contrast theme; it can take a few seconds' : null });
  }
  let real;
  Object.defineProperty(window, 'mantle', {
    configurable: true,
    get() { return real; },
    set(m) {
      real = { on: m.on.bind(m), call(name, args) {
        const copy = args && typeof args === 'object' ? JSON.parse(JSON.stringify(args)) : {};
        if (name === 'settings.sections') return Promise.resolve({ ok: true, reason: null, sections: [{ id: 'accessibility', file: 'sections/accessibility.js', down: null, main: null }] });
        const mine = name === 'settings.accessibility.settings' ? later(30, settings())
          : name === 'settings.accessibility.set' || name === 'settings.accessibility.start' ? write(name, copy) : null;
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
const on = (p, row) => p.$eval(sw(row), (b) => b.getAttribute('aria-checked'));
const PG = (page, more) => `?section=accessibility&page=${page}${more || ''}`;
const A = (x) => 'accessibility.' + x;
const slide = (p, row, v) => p.$eval(sel(row) + ' input[type=range]', (i, val) => { i.value = String(val); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); }, v);

const SHOTS = [
  ['acc-01-overview', '?section=accessibility', async (p) => {
    const t = await p.textContent('#page');
    check('01: the overview lists Text size, Contrast themes, Keyboard and Eye control', ['Text size', 'Contrast themes', 'Keyboard', 'Eye control', 'Narrator'].every((x) => t.includes(x)), t.slice(0, 200));
  }],
  ['acc-02-text-size', PG('text-size'), async (p) => {
    const fs0 = await p.$eval(sel(A('text-size.preview')) + ' .row-t', (e) => e.style.fontSize);
    check('02: the preview draws at the size Windows reports (125% = 17.5px)', fs0 === '17.5px', fs0);
    check('02: the slider reads 125%', /125%/.test(await rowText(p, A('text-size.size')) || ''));
    await slide(p, A('text-size.size'), 150);
    await p.waitForTimeout(300);
    const c = await calls(p, 'settings.accessibility.set');
    check('02: letting go sends textSize 150', c.length === 1 && c[0].args.key === 'textSize' && c[0].args.value === 150, JSON.stringify(c));
    check('02: the preview follows the read-back (21px)', await p.$eval(sel(A('text-size.preview')) + ' .row-t', (e) => e.style.fontSize) === '21px');
  }],
  ['acc-03-text-size-testrun', PG('text-size', '&test=1'), async (p) => {
    await slide(p, A('text-size.size'), 200);
    await p.waitForTimeout(300);
    check('03: a test run says so and the slider springs back', /Test run, nothing changed/.test(await rowText(p, A('text-size.size')) || '') && /125%/.test(await rowText(p, A('text-size.size')) || ''));
    check('03: the preview springs back with it (17.5px)', await p.$eval(sel(A('text-size.preview')) + ' .row-t', (e) => e.style.fontSize) === '17.5px');
  }],
  ['acc-04-visual-effects', PG('visual-effects'), async (p) => {
    check('04: transparency on, scrollbars off', await on(p, A('visual-effects.transparency')) === 'true' && await on(p, A('visual-effects.scrollbars')) === 'false');
    check('04: notifications stay 15 seconds', await p.$eval(sel(A('visual-effects.notify-duration')) + ' select', (s) => s.value) === '15');
    await p.click(sw(A('visual-effects.animations')));
    await p.waitForTimeout(300);
    const c = await calls(p, 'settings.accessibility.set');
    check('04: a switch sends its key', c.length === 1 && c[0].args.key === 'animations' && c[0].args.value === false, JSON.stringify(c));
  }],
  ['acc-05-pointer', PG('mouse-pointer'), async (p) => {
    const t = await rowText(p, A('mouse-pointer.style'));
    check('05: the style is Black, read-only WITH its reason', /Black/.test(t) && /Read only here: Windows draws the black, inverted and coloured pointers itself/.test(t), t);
    check('05: the colour is not in use for the black style', /Not in use \(Black style\)/.test(await rowText(p, A('mouse-pointer.color')) || ''));
    check('05: size 3 and the touch indicator on', /3/.test(await rowText(p, A('mouse-pointer.size')) || '') && await p.$eval(sel(A('mouse-pointer.touch-indicator')) + ' select', (s) => s.value) === '1');
  }],
  ['acc-06-contrast', PG('contrast-themes'), async (p) => {
    const opts = await p.$$eval(sel(A('contrast-themes.theme')) + ' option', (l) => l.map((o) => o.textContent));
    check('06: None and the four Windows 11 themes', opts.join() === 'None,Aquatic,Desert,Dusk,Night sky', opts.join());
    await p.selectOption(sel(A('contrast-themes.theme')) + ' select', 'aquatic');
    await p.waitForTimeout(300);
    const c = await calls(p, 'settings.accessibility.set');
    check('06: picking Aquatic sends it and shows Windows\' note', c.length === 1 && c[0].args.value === 'aquatic' && /switching every window/.test(await rowText(p, A('contrast-themes.theme')) || ''), JSON.stringify(c));
  }],
  ['acc-07-keyboard', PG('keyboard'), async (p) => {
    check('07: sticky keys off, its shortcut on', await on(p, A('keyboard.sticky')) === 'false' && await on(p, A('keyboard.sticky-shortcut')) === 'true');
    check('07: Print Screen says Mantle answers the key', /Mantle's own screenshot overlay answers Print Screen/.test(await rowText(p, A('keyboard.print-screen')) || ''));
    await p.click(sw(A('keyboard.sticky-shortcut')));
    await p.waitForTimeout(300);
    const c = await calls(p, 'settings.accessibility.set');
    check('07: the Sticky keys shortcut sends stickyShortcut false', c.length === 1 && c[0].args.key === 'stickyShortcut' && c[0].args.value === false, JSON.stringify(c));
    await p.click(sel(A('keyboard.osk')) + ' button');
    await p.waitForTimeout(300);
    const s = await calls(p, 'settings.accessibility.start');
    check('07: Start sends the osk tool and says it is starting', s.length === 1 && s[0].args.tool === 'osk' && /On-screen keyboard is starting/.test(await rowText(p, A('keyboard.osk')) || ''), JSON.stringify(s));
  }],
  ['acc-08-keyboard-testrun', PG('keyboard', '&test=1'), async (p) => {
    await p.click(sw(A('keyboard.sticky-shortcut')));
    await p.waitForTimeout(300);
    check('08: a test-run change is a dry run with its note, and springs back', /Test run, nothing changed/.test(await rowText(p, A('keyboard.sticky-shortcut')) || '') && await on(p, A('keyboard.sticky-shortcut')) === 'true');
  }],
  ['acc-09-magnifier-running', PG('magnifier', '&acc=running'), async (p) => {
    const t = await rowText(p, A('magnifier.start'));
    check('09: a running Magnifier says so, and Start is off', /Magnifier is running/.test(t) && await p.$eval(sel(A('magnifier.start')) + ' button', (b) => b.disabled && b.textContent === 'Running'), t);
    check('09: zoom 200%, increment 100%', await p.$eval(sel(A('magnifier.zoom')) + ' input', (i) => i.value) === '200' && await p.$eval(sel(A('magnifier.increment')) + ' select', (s) => s.value) === '100');
  }],
  ['acc-10-failing', PG('keyboard', '&acc=fail'), async (p) => {
    check('10: the switches say why they could not be read', /These settings could not be read: (Mantle's connection to Windows is restarting|Windows took too long to answer|something went wrong inside Mantle|this needs a newer version of Mantle|Windows did not allow it)/.test(await rowText(p, A('keyboard.sticky')) || ''));
    check('10: nothing threw while drawing', !/could not be drawn/.test(await p.textContent('#page')));
  }],
  ['acc-11-audio', PG('audio'), async (p) => {
    check('11: mono audio is read-only WITH its reason', /Read only here: Windows' audio service applies mono audio/.test(await rowText(p, A('audio.mono')) || ''));
    check('11: flash reads No flash', await p.$eval(sel(A('audio.flash')) + ' select', (s) => s.value) === 'off');
  }],
  ['acc-12-custom-contrast', PG('contrast-themes', '&acc=custom'), async (p) => {
    const opts = await p.$$eval(sel(A('contrast-themes.theme')) + ' option', (l) => l.map((o) => o.textContent));
    check('12: a custom theme is shown as itself', /Custom \(Made-up Scheme\)/.test(opts.join()) && await p.$eval(sel(A('contrast-themes.theme')) + ' select', (s) => s.value) === 'custom', opts.join());
  }],
  ['acc-13-missing-tool', PG('captions', '&acc=missing'), async (p) => {
    check('13: a missing tool says why, Start disabled', /does not have live captions/.test(await rowText(p, A('captions.live')) || '') && await p.$eval(sel(A('captions.live')) + ' button', (b) => b.disabled));
    check('13: the caption style is read-only WITH its reason', /Read only here: Windows keeps caption styles/.test(await rowText(p, A('captions.style')) || ''));
  }],
  ['acc-14-mouse', PG('mouse'), async (p) => {
    check('14: acceleration shows seconds', /3\.0 s/.test(await rowText(p, A('mouse.keys-acceleration')) || ''));
    check('14: speed 80', /80/.test(await rowText(p, A('mouse.keys-speed')) || ''));
  }],
];

async function browserTests() {
  const g = gaming();
  if (g !== 0) { console.log(g > 0 ? 'PART 2 SKIPPED: a game is running' : 'PART 2 SKIPPED: could not check for a running game'); failures.push('part 2 (the page on the mock) was not run'); return; }
  const { chromium } = require('../../../tools/dev-env.js').playwright();
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
        // No Silent Failures: nothing may still say "Reading…" once the read came back
        if (/Reading…/.test(txt)) errs.push(pg.id + ': a row still says Reading…');
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
  try { await browserTests(); } catch (e) { failures.push('part 2 threw: ' + (e && e.message ? e.message.split('\n')[0] : e)); }
  for (const f of failures) console.log('FAIL ' + f);
  console.log(`ACCESSIBILITY PAGE TEST: ${passed} passed, ${failures.length} failed`);
  process.exitCode = failures.length ? 1 : 0;
})();
