'use strict';
/*
 * settings.test.js - Mantle Settings (Win+I), in node, no Electron, no sidecar (lane settings-tests,
 * 2026-09-28).
 *
 *   node lib/features/settings.test.js
 *
 * WHY fakes for everything: the feature's whole job is to touch the user's machine (a real window, the
 * Windows Settings app, the log folder, their startup entries in the registry). Here every one of those
 * is a fake that only counts: FakeWin never draws, the fake shell never opens anything, the fake
 * sidecar never reaches the registry, and `electron` is NEVER required (the npm package's index.js
 * can spawn Electron's installer in plain node). The only temp folders are the ones readCommit is
 * pointed at, made under os.tmpdir() and removed at the end.
 *
 * Proves the pure parts (navFrom, shortcutsOf, featureView, catalog, readCommit) and the feature:
 * one window per Win+I with the app-window options, never shown or focused in --test, shown and
 * focused on ready-to-show when live; settings.open / settings.hello navigation; the window forgotten
 * on 'closed', destroyed on switch-off and on stop(); the launcher's 'mantle-open' reply object; the
 * Mantle page's reads and writes through ctx.host.features / ctx.host.switcher; every write that
 * would reach Windows a dry run in --test (openWindows, openLogs, startupSet, the folder dialog);
 * displays, startup apps, window ops, About; and PRIVACY: no startup entry name or command, display
 * label or folder path fed in here ever reaches a log line or a health reason.
 *
 * SECTION MODULES (ui/settings/SECTIONS.md, lane settingsfx): the main half loaded from temp folders
 * (settings.<id>.<name> commands, every DOWN reason, env.settings / env.push / env.elevate's fallback,
 * stop) and the page half's pure rules through ui/settings/model.js (shape check, replacing, subpages,
 * sidebar order, deep links, search metadata).
 *
 * Prints one summary line, "SETTINGS TEST: n passed, m failed"; exits 1 if anything failed.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const F = require('./settings.js');
const T = F._test;

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(name + (detail !== undefined ? ' -- ' + detail : ''));
}
const show = (x) => JSON.stringify(x);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const clone = (x) => JSON.parse(JSON.stringify(x));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ROOT = path.join(__dirname, '..', '..');
const TMPS = [];

/* ---- the private things fed in; none may ever reach a log line ---- */
const SECRET_ENTRY = 'ZULU-startup-entry-7719';
const SECRET_CMD = '"C:\\SecretApps\\zulu-7719.exe" --background';
const SECRET_ID = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\\' + SECRET_ENTRY;
const SECRET_DISPLAY = 'YANKEE-monitor-LG-4411';
const SECRET_FOLDER = 'C:\\Users\\fake\\XRAY-private-folder-2291';
const SECRET_LOG = 'C:\\fake\\WHISKEY-logs-6630\\mantle.log';
const SECRETS = [SECRET_ENTRY, SECRET_CMD, SECRET_ID, SECRET_DISPLAY, SECRET_FOLDER, SECRET_LOG, 'ZULU', 'YANKEE', 'XRAY', 'WHISKEY', 'SecretApps'];

/* ------------------------------------------------------------------ pure: navFrom */
function navTests() {
  const n = T.navFrom({ section: 'sound', row: 'sound.output', query: 'volume' }, 3);
  check('navFrom: a known section, a good row and a query are kept', eq(n, { section: 'sound', page: null, row: 'sound.output', query: 'volume', seq: 3 }), show(n));
  check('navFrom: every SECTIONS entry is kept', T.SECTIONS.every((s) => T.navFrom({ section: s }, 1).section === s));
  check('navFrom: an unknown section becomes null', T.navFrom({ section: 'registry' }, 1).section === null);
  check('navFrom: a section is matched exactly (no case folding)', T.navFrom({ section: 'Sound' }, 1).section === null);
  for (const bad of ['a b', '', 'x'.repeat(81), '<script>', 'row/../x', 42, null, { r: 1 }]) {
    check(`navFrom: row ${show(bad)} fails the row regex and becomes null`, T.navFrom({ section: 'sound', row: bad }, 1).row === null);
  }
  for (const good of ['apps.startup', 'a+b-c_d.9', 'x'.repeat(80)]) {
    check(`navFrom: row ${show(good.slice(0, 20))} passes the row regex`, T.navFrom({ row: good }, 1).row === good);
  }
  const long = T.navFrom({ query: 'q'.repeat(250) }, 1);
  check('navFrom: the query is clipped to 100 characters', long.query.length === 100, long.query.length);
  check('navFrom: a non-string query becomes ""', T.navFrom({ query: 12 }, 1).query === '');
  check('navFrom: null gives an empty nav with the seq', eq(T.navFrom(null, 7), { section: null, page: null, row: null, query: '', seq: 7 }));
  check('navFrom: a bare string is not a nav', eq(T.navFrom('sound', 2), { section: null, page: null, row: null, query: '', seq: 2 }));
}

/* ------------------------------------------------------------------ pure: shortcutsOf + featureView */
const FEATURES = () => [
  { name: 'notes', label: 'Quick notes', enabled: true, ok: true, chords: ['Win+Alt+N'], keys: true, keysReason: '',
    options: [{ key: 'folder', type: 'folder', label: 'Notes folder', value: SECRET_FOLDER }, { key: 'size', type: 'number', label: 'Size', value: 3 }] },
  { name: 'snap', label: 'Snapping', enabled: false, chords: ['Win+Left', 'Win+Right'], keys: false, keysReason: 'switched off' },
  { name: 'osd', label: 'Pop-ups', enabled: true, resting: 'a game is running', chords: ['VolumeUp'], keys: false },
  { name: 'odd', label: 'Odd one', enabled: true, chords: ['Win+Q'], keys: true },
  { name: 'wallpaper', label: 'Wallpaper', enabled: true, running: true },
];
const SW = () => ({ ok: true, altTab: true, altTabLive: true, altTabReason: '', winKeys: false, winKeysLive: false, winKeysReason: 'switched off in the tray' });

function shortcutTests() {
  const rows = T.shortcutsOf(FEATURES(), SW());
  const by = (k) => rows.find((r) => r.keys === k);
  check('shortcutsOf: one row per feature chord plus Alt+Tab, Win+N, Win+A', rows.length === 5 + 3, rows.map((r) => r.keys).join(','));
  const n = by('Win+Alt+N');
  check('shortcutsOf: a feature chord carries owner / label / on / live / why / toggle',
    n && n.what === 'Quick notes' && n.owner === 'notes' && n.ownerLabel === 'Quick notes' && n.on === true && n.live === true && n.why === '' &&
    eq(n.toggle, { kind: 'feature', feature: 'notes' }), show(n));
  const l = by('Win+Left');
  check('shortcutsOf: a switched-off feature is on:false live:false with its keysReason',
    l && l.on === false && l.live === false && l.why === 'switched off' && l.what === T.WHAT['Win+Left'], show(l));
  check('shortcutsOf: every chord of a feature is listed', !!by('Win+Right') && by('Win+Right').owner === 'snap');
  const v = by('VolumeUp');
  check("shortcutsOf: a resting feature says Windows' own while Mantle rests (why)", v && /Windows' own while Mantle rests \(a game is running\)/.test(v.why), show(v));
  check('shortcutsOf: a chord WHAT does not know is described by its keys', by('Win+Q') && by('Win+Q').what === 'Win+Q');
  const at = by('Alt+Tab');
  check('shortcutsOf: Alt+Tab from the switcher view',
    at && at.owner === 'switcher' && at.on === true && at.live === true && eq(at.toggle, { kind: 'switcher', key: 'altTab' }), show(at));
  const wn = by('Win+N'), wa = by('Win+A');
  check('shortcutsOf: Win+N and Win+A follow winKeys, with its reason',
    wn && wa && wn.on === false && wa.on === false && wn.live === false && wn.why === 'switched off in the tray' && wa.why === wn.why &&
    eq(wn.toggle, { kind: 'switcher', key: 'winKeys' }) && eq(wa.toggle, wn.toggle), show([wn, wa]));
  const noSw = T.shortcutsOf(FEATURES(), { ok: false, reason: 'not reachable' });
  check('shortcutsOf: a switcher view with ok:false adds no Alt+Tab / Win+N / Win+A', noSw.length === 5 && !noSw.some((r) => r.owner === 'switcher'), noSw.map((r) => r.keys).join(','));
  check('shortcutsOf: no switcher view adds none either', T.shortcutsOf(FEATURES(), null).length === 5);
  check('shortcutsOf: no features and no switcher is an empty list', eq(T.shortcutsOf(null, null), []));

  const fv = T.featureView({ name: 'x', label: 'X' });
  check('featureView: missing fields get safe defaults (ok true, loaded true, options [], chords [])',
    fv.ok === true && fv.loaded === true && fv.enabled === false && eq(fv.options, []) && eq(fv.chords, []) && fv.resting === null && fv.broken === null, show(fv));
  check('featureView: ok:false and loaded:false survive', T.featureView({ name: 'x', ok: false, loaded: false }).ok === false && T.featureView({ name: 'x', loaded: false }).loaded === false);
  check('featureView: nothing outside its list is passed to the page', !('secret' in T.featureView({ name: 'x', secret: 'y' })));
}

/* ------------------------------------------------------------------ pure: catalog + readCommit */
async function catalogCommitTests() {
  const LI = require('../launcher-index')._internals;
  const items = T.catalog();
  check("catalog: one entry per launcher Settings page (~100)", items.length === LI.SETTINGS.length && items.length >= 90, items.length);
  check('catalog: every entry has name, uri and keywords', items.every((i) => i.name && /^ms-settings:/.test(i.uri) && typeof i.keywords === 'string'));
  const st = items.find((i) => i.uri === 'ms-settings:startupapps');
  // (the Apps category module `applist` replaced the built-in Apps; its Startup page is `apps`)
  check('catalog: ms-settings:startupapps is {section applist, page apps, row apps.startup}', st && st.section === 'applist' && st.page === 'apps' && st.row === 'apps.startup', show(st));
  // lane wire: a page a section module claims is marked with that module's section/page/row (the
  // launcher's coverOf); a page nobody covers stays section null (Windows keeps it)
  const bare = items.find((i) => !LI.coverOf(i.uri));
  check('catalog: a page no section covers is section null (Windows keeps it)', !bare || (bare.section === null && bare.page === null && bare.row === null), show(bare));
  const marked = items.filter((i) => i.section);
  check('catalog: exactly the covered pages are marked (built-ins + module claims)',
    marked.length === items.filter((i) => LI.coverOf(i.uri)).length && marked.length >= Object.keys(LI.MANTLE_SETTINGS).length, marked.length);
  const modIds = T.listSectionFiles(LI.SECTIONS_DIR).map((f) => f.slice(0, -3));
  check('catalog: every marked section is one the page knows (a built-in or a section module file)', marked.every((i) => T.SECTIONS.includes(i.section) || modIds.includes(i.section)),
    show(marked.filter((i) => !T.SECTIONS.includes(i.section) && !modIds.includes(i.section))));
  const claims = LI.sectionClaims().claims;
  const pv = items.find((i) => i.uri === 'ms-settings:privacy-webcam');
  check('catalog: a module-claimed page carries the module\'s section, page and row', !claims['ms-settings:privacy-webcam'] ||
    (pv.section === claims['ms-settings:privacy-webcam'].section && pv.page === claims['ms-settings:privacy-webcam'].page && pv.row === claims['ms-settings:privacy-webcam'].row), show(pv));

  // readCommit: this checkout, then three temp folders that are NOT repositories
  const here = await T.readCommit(ROOT);
  check('readCommit: this checkout gives a commit or a reason', (here.commit && /^[0-9a-f]{4,40}$/.test(here.commit) && here.reason === null) || (here.commit === null && typeof here.reason === 'string' && here.reason.length > 0), show(here));
  const mk = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-settings-test-')); TMPS.push(d); return d; };
  const broken = mk();
  fs.writeFileSync(path.join(broken, '.git'), 'gitdir: nowhere-at-all\n');
  const b = await T.readCommit(broken);
  check('readCommit: a .git file pointing nowhere is "not a git checkout", in words', b.commit === null && /not a git checkout/.test(b.reason), show(b));
  const detached = mk();
  fs.mkdirSync(path.join(detached, 'gd'));
  fs.writeFileSync(path.join(detached, 'gd', 'HEAD'), 'a'.repeat(40) + '\n');
  fs.writeFileSync(path.join(detached, '.git'), 'gitdir: gd\n');
  const dd = await T.readCommit(detached);
  check('readCommit: git refusing, a detached HEAD read by hand gives 7 characters', dd.commit === 'aaaaaaa' && dd.reason === null, show(dd));
  const branch = mk();
  fs.mkdirSync(path.join(branch, 'gd'));
  fs.writeFileSync(path.join(branch, 'gd', 'HEAD'), 'ref: refs/heads/master\n');
  fs.writeFileSync(path.join(branch, '.git'), 'gitdir: gd\n');
  const bb = await T.readCommit(branch);
  check('readCommit: a HEAD that is only a branch name says so', bb.commit === null && /a branch name only/.test(bb.reason), show(bb));
}

/* ------------------------------------------------------------------ fakes */
function emitter(o) {
  const L = {};
  o.on = (ev, fn) => { (L[ev] = L[ev] || []).push(fn); return o; };
  o.once = (ev, fn) => { const w = (...a) => { o.off(ev, w); fn(...a); }; return o.on(ev, w); };
  o.off = (ev, fn) => { L[ev] = (L[ev] || []).filter((f) => f !== fn); return o; };
  o.removeListener = o.off;
  o.emit = (ev, ...a) => { const fns = (L[ev] || []).slice(); for (const f of fns) f(...a); return fns.length > 0; };
  o.listenerCount = (ev) => (L[ev] || []).length;
  return o;
}

class FakeWin {
  constructor(opts) {
    emitter(this);
    this.opts = opts; this.shown = 0; this.focused = 0; this.closes = 0; this.minimized = 0; this.maxed = false; this.destroyed = false;
    this.webContents = emitter({ setWindowOpenHandler: (fn) => { this.openHandler = fn; } });
  }
  loadFile(p, o) { this.file = p; this.loadOpts = o; }
  setAppDetails(o) { this.appDetails = o; }
  setBackgroundColor(c) { this.bg = c; }
  setBackgroundMaterial(m) { this.mat = m; }
  show() { this.shown++; }
  focus() { this.focused++; }
  isMinimized() { return false; }
  restore() {}
  isFocused() { return true; }                   // so reveal's sidecar focus hand-over never runs
  isDestroyed() { return this.destroyed; }
  destroy() { if (this.destroyed) return; this.destroyed = true; this.emit('closed'); }
  // like Electron: 'close' can be prevented (the warm window hides instead); destroy() skips it
  close() { this.closes++; const e = { prevented: false, preventDefault() { this.prevented = true; } }; this.emit('close', e); if (!e.prevented) this.destroy(); }
  hide() { this.hidden = (this.hidden || 0) + 1; }
  minimize() { this.minimized++; }
  maximize() { this.maxed = true; }
  unmaximize() { this.maxed = false; }
  isMaximized() { return this.maxed; }
  getNativeWindowHandle() { return Buffer.alloc(8); }
}

function fakeScreen() {
  return {
    getPrimaryDisplay: () => ({ id: 2 }),
    getAllDisplays: () => [
      { id: 1, label: SECRET_DISPLAY, internal: false, size: { width: 1280, height: 720 }, scaleFactor: 1.5, displayFrequency: 143.9, rotation: 0 },
      { id: 2, label: '', internal: true, size: { width: 1920, height: 1080 }, scaleFactor: 1, displayFrequency: 60 },
    ],
  };
}

function mkDeps() {
  const wins = [];
  class W extends FakeWin { constructor(o) { super(o); wins.push(this); } }
  const shell = { ext: [], paths: [], openExternal: async (u) => { shell.ext.push(u); }, openPath: async (p) => { shell.paths.push(p); return ''; } };
  const dialog = { calls: 0, showOpenDialog: async () => { dialog.calls++; return { canceled: true, filePaths: [] }; } };
  const app = emitter({});
  return { wins, shell, dialog, app, deps: { electron: { app }, BrowserWindow: W, screen: fakeScreen(), shell, dialog, icon: null,
    // no section modules unless a test brings its own: the real folders fill up as the category lanes land
    pageSectionsDir: path.join(os.tmpdir(), 'mantle-settings-test-no-sections'), mainSectionsDir: path.join(os.tmpdir(), 'mantle-settings-test-no-sections') } };
}

const ALL = [];                                     // every fake ctx, for the privacy sweep
function fakeCtx(o) {
  const opts = o || {};
  const c = { logs: [], health: [], pushes: [], commands: {}, chords: {}, enabledFns: [], changeFns: [], sends: [], featOps: [], swSets: [], on: true, swStuck: false };
  c.features = FEATURES();
  c.sw = SW();
  c.reply = () => ({ ok: false, error: 'passive sidecar: refused' });
  c.ctx = {
    name: 'settings',
    flags: { test: !opts.live, live: !!opts.live },
    log: (t) => c.logs.push(String(t)),
    health: (ok, why) => c.health.push({ ok, why }),
    enabled: () => c.on,
    onEnabled: (fn) => c.enabledFns.push(fn),
    push: (w, ev, p) => { c.pushes.push({ w, ev, p: clone(p) }); return true; },
    command: (verb, fn) => { c.commands[verb] = fn; return `settings.${verb}`; },
    onChord: (ch, fn) => { c.chords[ch] = fn; return () => {}; },
    page: (f) => path.join(ROOT, 'ui', 'settings', f || 'index.html'),
    preload: path.join(ROOT, 'preload.js'),
    host: {
      display: () => ({ workArea: { x: 0, y: 0, width: 1536, height: 824 } }),
      features: opts.noFeatures ? undefined : {
        list: () => clone(c.features),
        setEnabled: (name, on) => {
          c.featOps.push(['setEnabled', name, on]);
          const f = c.features.find((x) => x.name === name);
          if (!f) return { ok: false, reason: `there is no feature called "${name}"` };
          f.enabled = !!on;
          return { ok: true, reason: null, feature: clone(f) };
        },
        setOption: (name, key, value) => {
          c.featOps.push(['setOption', name, key, value]);
          const f = c.features.find((x) => x.name === name);
          const opt = f && (f.options || []).find((x) => x.key === key);
          if (!opt) return { ok: false, reason: `"${key}" is not an option of ${name}` };
          opt.value = value;
          return { ok: true, reason: null, option: clone(opt) };
        },
        onChange: (fn) => { c.changeFns.push(fn); return () => {}; },
      },
      switcher: opts.noSwitcher ? null : {
        get: () => clone(c.sw),
        set: (patch) => { c.swSets.push(clone(patch)); if (!c.swStuck) Object.assign(c.sw, patch); return clone(c.sw); },
      },
    },
    sidecar: { ready: true, send: async (cmd, args, so) => { c.sends.push({ cmd, args: clone(args), so }); return c.reply(cmd, args); } },
  };
  c.call = (verb, args) => c.commands[verb](args);
  c.navPushes = () => c.pushes.filter((p) => p.ev === 'settings.nav');
  ALL.push(c);
  return c;
}

/* ------------------------------------------------------------------ feature: the window */
async function windowTests() {
  const c = fakeCtx();
  const K = mkDeps();
  const inst = T.install(c.ctx, K.deps);
  check('install: health says Win+I opens Mantle Settings', c.health.length === 1 && c.health[0].ok === true && /Win\+I/.test(c.health[0].why), show(c.health));
  check('install: the chord is Win+I', typeof c.chords['Win+I'] === 'function' && Object.keys(c.chords).length === 1, Object.keys(c.chords).join(','));
  check('install: the launcher listener is on app', K.app.listenerCount('mantle-open') === 1);
  check('install: every settings.* command is registered',
    ['open', 'hello', 'mantle', 'enable', 'option', 'pickFolder', 'switcher', 'about', 'openLogs', 'openWindows', 'catalog', 'displays', 'startup', 'startupSet', 'window']
      .every((v) => typeof c.commands[v] === 'function'), Object.keys(c.commands).join(','));
  check('install: no window before anything asks', K.wins.length === 0);

  c.chords['Win+I']();
  const w = K.wins[0];
  check('Win+I: makes exactly one window', K.wins.length === 1, K.wins.length);
  const o = (w && w.opts) || {};
  check('Win+I: the window is titled "Mantle Settings"', o.title === 'Mantle Settings' && o.title === T.TITLE, o.title);
  check('Win+I: frameless, resizable, min 760 x 520, on the taskbar, made hidden',
    o.frame === false && o.resizable === true && o.minWidth === 760 && o.minHeight === 520 && o.skipTaskbar === false && o.show === false, show(o));
  check('Win+I: the page is sandboxed with the preload', o.webPreferences && o.webPreferences.sandbox === true && o.webPreferences.contextIsolation === true && o.webPreferences.nodeIntegration === false && o.webPreferences.preload === c.ctx.preload);
  check('Win+I: it fits the work area (1040 x 700 at most, centred)', o.width === 1040 && o.height === 700 && o.x === Math.round((1536 - 1040) / 2) && o.y === Math.round((824 - 700) / 2), show([o.width, o.height, o.x, o.y]));
  check('Win+I: it loads ui/settings/index.html', w && w.file === path.join(ROOT, 'ui', 'settings', 'index.html'));
  check('Win+I: ui/settings/index.html exists', fs.existsSync(path.join(ROOT, 'ui', 'settings', 'index.html')));
  check('Win+I: a new window starts at Home', inst._nav().section === 'home', show(inst._nav()));
  check('Win+I: the page may not open windows', w && w.openHandler && eq(w.openHandler(), { action: 'deny' }));
  let prevented = 0;
  w.webContents.emit('will-navigate', { preventDefault: () => { prevented++; } });
  w.emit('page-title-updated', { preventDefault: () => { prevented++; } });
  check('Win+I: navigation and the page title are both held', prevented === 2, prevented);

  w.emit('ready-to-show');
  check('--test: ready-to-show never shows or focuses it', w.shown === 0 && w.focused === 0, show([w.shown, w.focused]));
  const navBefore = c.navPushes().length;
  c.chords['Win+I']();
  check('--test: a second Win+I makes no second window', K.wins.length === 1, K.wins.length);
  check('--test: a second Win+I pushes no settings.nav', c.navPushes().length === navBefore, c.navPushes().length);
  check('--test: a second Win+I still shows / focuses nothing', w.shown === 0 && w.focused === 0);

  const seqBefore = inst._nav().seq;
  const r = await c.call('open', { section: 'sound', row: 'sound.output' });
  check('settings.open: ok, the same window', r.ok === true && r.created === false && K.wins.length === 1, show(r));
  const last = c.navPushes().pop();
  check('settings.open: pushes settings.nav with that section and row', last && last.w === w && last.p.section === 'sound' && last.p.row === 'sound.output', show(last && last.p));
  check('settings.open: with a higher seq', last && last.p.seq > seqBefore, show([seqBefore, last && last.p.seq]));
  const h = await c.call('hello');
  check('settings.hello answers the current nav', h.ok === true && h.test === true && h.section === 'sound' && h.row === 'sound.output' && h.seq === last.p.seq, show(h));
  const nPush = c.navPushes().length;
  await c.call('open', { section: 'registry', row: 'a b' });
  check('settings.open: an unknown place is not a navigation (no push, nav kept)', c.navPushes().length === nPush && inst._nav().section === 'sound');
  check('--test: nothing above showed or focused the window', w.shown === 0 && w.focused === 0);

  // the settings.changed redraw: many changes in one tick = one push
  c.changeFns.forEach((fn) => { for (let i = 0; i < 5; i++) fn({ what: 'enabled' }); });
  await wait(170);
  const changed = c.pushes.filter((p) => p.ev === 'settings.changed');
  check('onChange: five changes in a tick redraw once', changed.length === 1 && changed[0].p.what === 'enabled', show(changed.map((x) => x.p)));

  // closed by the user (the X, Alt+F4): forgotten, the next Win+I makes a new one at Home
  w.destroyed = true;
  w.emit('closed');
  check("'closed': the window is forgotten", inst._win() === null);
  c.chords['Win+I']();
  const w2 = K.wins[1];
  check("'closed': the next Win+I makes a new window", K.wins.length === 2 && w2 && !w2.destroyed, K.wins.length);
  check("'closed': the new window starts at Home", inst._nav().section === 'home' && inst._nav().row === null);

  c.changeFns.forEach((fn) => fn({ what: 'option' }));
  c.enabledFns.forEach((fn) => fn(true));
  check('onEnabled(true) makes no window', K.wins.length === 2);
  c.on = false;
  c.enabledFns.forEach((fn) => fn(false));
  check('onEnabled(false) destroys the window', w2.destroyed === true && inst._win() === null);
  await wait(170);
  check('onEnabled(false): a redraw due after the window went pushes nothing', c.pushes.filter((p) => p.ev === 'settings.changed').length === 1);
  const off = await c.call('open', { section: 'display' });
  check('settings.open while switched off: ok:false in words, no window', off.ok === false && /switched off/.test(off.reason) && K.wins.length === 2, show(off));
  c.chords['Win+I']();
  check('Win+I while switched off: no window', K.wins.length === 2);
  c.on = true;

  // a page that fails to load: health false, the window gone; a good load says healthy again
  c.chords['Win+I']();
  const w3 = K.wins[2];
  w3.webContents.emit('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND', 'file:///x', true);
  const hf = c.health[c.health.length - 1];
  check('did-fail-load: health false in words, the window destroyed', hf.ok === false && /did not load \(ERR_FILE_NOT_FOUND\)/.test(hf.why) && w3.destroyed && inst._win() === null, show(hf));
  c.chords['Win+I']();
  const w4 = K.wins[3];
  w4.webContents.emit('did-finish-load');
  check('did-finish-load: health back to ok', c.health[c.health.length - 1].ok === true);
  w4.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  check('render-process-gone: the window is closed, Win+I makes a fresh one', w4.destroyed && inst._win() === null);

  // stop() while a window is open
  c.chords['Win+I']();
  const w5 = K.wins[4];
  inst.stop('test over');
  check('stop(): destroys the window', w5.destroyed === true && inst._win() === null);
  check('stop(): removes the mantle-open listener', K.app.listenerCount('mantle-open') === 0);
  const after = await c.call('open', {});
  check('stop(): a later open answers ok:false in words', after.ok === false && /stopped/.test(after.reason) && K.wins.length === 5, show(after));
  check('--test: no window of this run was ever shown or focused', K.wins.every((x) => x.shown === 0 && x.focused === 0), show(K.wins.map((x) => [x.shown, x.focused])));
}

async function liveWindowTests() {
  const c = fakeCtx({ live: true });
  const K = mkDeps();
  const inst = T.install(c.ctx, K.deps);
  c.chords['Win+I']();
  const w = K.wins[0];
  check('live: the window is made hidden (shown on ready-to-show, not before)', w && w.opts.show === false && w.shown === 0);
  w.emit('ready-to-show');
  check('live: ready-to-show shows and focuses it', w.shown === 1 && w.focused === 1, show([w.shown, w.focused]));
  c.chords['Win+I']();
  check('live: a second Win+I brings the same window back (shown again, no new one)', K.wins.length === 1 && w.shown === 2 && w.focused === 2, show([K.wins.length, w.shown]));
  inst.stop('test over');
  check('live: stop() destroys it', w.destroyed);
  // ready-to-show arriving after the window was replaced shows nothing
  const c2 = fakeCtx({ live: true });
  const K2 = mkDeps();
  const i2 = T.install(c2.ctx, K2.deps);
  c2.chords['Win+I']();
  const a = K2.wins[0];
  a.destroyed = true; a.emit('closed');
  a.emit('ready-to-show');
  check('live: a ready-to-show for a forgotten window shows nothing', a.shown === 0);
  i2.stop('test over');
}

/* ------------------------------------------------------------------ feature: the launcher's 'mantle-open' */
async function launcherEventTests() {
  const c = fakeCtx();
  const K = mkDeps();
  const inst = T.install(c.ctx, K.deps);
  const reply = { handled: false, ok: false, reason: null };
  K.app.emit('mantle-open', 'settings', { section: 'network', row: null, uri: 'ms-settings:network', via: 'the launcher', reply });
  check("mantle-open 'settings': reply {handled:true, ok:true}", reply.handled === true && reply.ok === true && reply.reason === null, show(reply));
  check("mantle-open 'settings': the window opens at that section", K.wins.length === 1 && inst._nav().section === 'network');
  K.wins[0].emit('ready-to-show');
  check("mantle-open 'settings': the open's line names the launcher (a test run logs at the first paint)", c.logs.some((l) => /^opened \(cold\) via the launcher at network \(test: not shown\): ready \d+ ms$/.test(l)), show(c.logs));
  c.on = false;
  const r2 = { handled: false, ok: false, reason: null };
  K.app.emit('mantle-open', 'settings', { section: 'sound', reply: r2 });
  check("mantle-open 'settings' switched off: {handled:true, ok:false, reason}", r2.handled === true && r2.ok === false && typeof r2.reason === 'string' && /switched off/.test(r2.reason), show(r2));
  c.on = true;
  const r3 = { handled: false, ok: false, reason: null };
  K.app.emit('mantle-open', 'wallpapers', { reply: r3 });
  check("mantle-open 'wallpapers' is not ours: reply untouched", eq(r3, { handled: false, ok: false, reason: null }), show(r3));
  let threw = null;
  try { K.app.emit('mantle-open', 'settings'); K.app.emit('mantle-open', 'settings', { reply: 'not an object' }); } catch (e) { threw = e; }
  check("mantle-open 'settings' with no reply object does not throw", threw === null, threw && threw.message);
  const w = K.wins[0];
  inst.stop('test over');
  const r4 = { handled: false, ok: false, reason: null };
  K.app.emit('mantle-open', 'settings', { section: 'sound', reply: r4 });
  check('stop(): a later mantle-open leaves the reply untouched', eq(r4, { handled: false, ok: false, reason: null }), show(r4));
  check('stop(): the window is destroyed', w.destroyed === true && K.wins.length === 1);
}

/* ------------------------------------------------------------------ feature: the Mantle page */
async function mantlePageTests() {
  const c = fakeCtx();
  const K = mkDeps();
  const inst = T.install(c.ctx, K.deps);
  const m = await c.call('mantle');
  check('settings.mantle: ok with features, switcher, shortcuts', m.ok === true && Array.isArray(m.features) && Array.isArray(m.shortcuts) && !!m.switcher, show(Object.keys(m)));
  check('settings.mantle: every feature from host.features.list(), as featureView', m.features.length === 5 && eq(m.features, FEATURES().map(T.featureView)));
  check('settings.mantle: the switcher view passes through', eq(m.switcher, SW()), show(m.switcher));
  check('settings.mantle: shortcuts = feature chords + Alt+Tab, Win+N, Win+A', m.shortcuts.length === 8 && ['Alt+Tab', 'Win+N', 'Win+A', 'Win+Alt+N'].every((k) => m.shortcuts.some((s) => s.keys === k)));

  const en = await c.call('enable', { feature: 'snap', on: true });
  check('settings.enable: passes through to host.features.setEnabled', eq(c.featOps[c.featOps.length - 1], ['setEnabled', 'snap', true]), show(c.featOps));
  check('settings.enable: returns {ok, reason, feature}', en.ok === true && en.reason === null && en.feature && en.feature.name === 'snap' && en.feature.enabled === true, show(en));
  const enBad = await c.call('enable', { feature: 'nope', on: false });
  check('settings.enable: a refusal comes back in words, feature null', enBad.ok === false && /no feature called "nope"/.test(enBad.reason) && enBad.feature === null, show(enBad));
  const op = await c.call('option', { feature: 'notes', key: 'size', value: 5 });
  check('settings.option: passes through to host.features.setOption', eq(c.featOps[c.featOps.length - 1], ['setOption', 'notes', 'size', 5]), show(c.featOps[c.featOps.length - 1]));
  check('settings.option: returns {ok, reason, option}', op.ok === true && op.reason === null && op.option && op.option.value === 5, show(op));
  const opNull = await c.call('option', { feature: 'notes', key: 'size', value: null });
  check('settings.option: value null (back to the default) passes through as null', opNull.ok === true && c.featOps[c.featOps.length - 1][3] === null);
  const opBad = await c.call('option', { feature: 'notes', key: 'colour', value: 'red' });
  check('settings.option: a refusal comes back in words, option null', opBad.ok === false && typeof opBad.reason === 'string' && opBad.option === null, show(opBad));

  const pf = await c.call('pickFolder', { feature: 'notes', key: 'folder' });
  check('settings.pickFolder --test: refused in words, no dialog', pf.ok === false && /never opens a folder dialog/.test(pf.reason) && K.dialog.calls === 0, show(pf.reason));
  const pfBad = await c.call('pickFolder', { feature: 'notes', key: 'size' });
  check('settings.pickFolder: a non-folder option is refused in words', pfBad.ok === false && /no folder option called "size"/.test(pfBad.reason) && K.dialog.calls === 0, show(pfBad.reason));

  const s0 = await c.call('switcher', {});
  check('settings.switcher: an empty patch is refused in words, nothing set', s0.ok === false && /altTab or winKeys/.test(s0.reason) && c.swSets.length === 0, show(s0));
  const s1 = await c.call('switcher', { altTab: 'no', winKeys: 1 });
  check('settings.switcher: non-boolean values are refused too', s1.ok === false && c.swSets.length === 0);
  const s2 = await c.call('switcher', { altTab: false });
  check('settings.switcher: {altTab:false} passes through', eq(c.swSets[c.swSets.length - 1], { altTab: false }) && s2.ok === true && s2.reason === null && s2.switcher.altTab === false, show(s2));
  c.swStuck = true;
  const s3 = await c.call('switcher', { winKeys: true });
  check('settings.switcher: a switch that did not move says so', s3.ok === false && /did not move/.test(s3.reason), show(s3));
  inst.stop('test over');

  const c2 = fakeCtx({ noFeatures: true, noSwitcher: true });
  const i2 = T.install(c2.ctx, mkDeps().deps);
  let err = null;
  try { await c2.call('mantle'); } catch (e) { err = e; }
  check('settings.mantle with no host.features: fails in words', err && /no feature list/.test(err.message), err && err.message);
  const sNo = await c2.call('switcher', { altTab: true });
  check('settings.switcher with no switcher: ok:false in words', sNo.ok === false && /not reachable/.test(sNo.reason));
  i2.stop('test over');
}

/* ------------------------------------------------------------------ feature: what reaches Windows */
async function windowsTests() {
  const c = fakeCtx();
  const K = mkDeps();
  const inst = T.install(c.ctx, K.deps);
  const bad = await c.call('openWindows', { uri: 'https://example.com' });
  check('settings.openWindows: a non ms-settings uri is refused', bad.ok === false && /not a Windows Settings page/.test(bad.reason), show(bad));
  const sneaky = await c.call('openWindows', { uri: 'ms-settings:sound & calc' });
  check('settings.openWindows: an ms-settings uri with extra words is refused', sneaky.ok === false);
  const dr = await c.call('openWindows', { uri: 'ms-settings:sound' });
  check('settings.openWindows --test: a dry run naming the page', dr.ok === true && dr.dryRun === true && /ms-settings:sound/.test(dr.reason), show(dr));
  check('settings.openWindows --test: shell.openExternal never called', K.shell.ext.length === 0, show(K.shell.ext));

  const argv = process.argv.slice();
  try {
    process.argv = argv.filter((x) => !String(x).startsWith('--log='));
    const nl = await c.call('openLogs');
    check('settings.openLogs with no --log=: ok:false in words', nl.ok === false && /--log=/.test(nl.reason), show(nl));
    const ab = await c.call('about');
    check('settings.about with no --log=: logFile null with a reason', ab.logFile === null && /--log=/.test(ab.logReason));
    process.argv = argv.concat(['--log=' + SECRET_LOG]);
    const dl = await c.call('openLogs');
    check('settings.openLogs --test with --log=: a dry run, nothing opened', dl.ok === true && dl.dryRun === true && K.shell.paths.length === 0, show(dl));
  } finally { process.argv = argv; }
  check('settings.openLogs: process.argv is restored', eq(process.argv, argv));

  const ds = await c.call('displays');
  const [d1, d2] = ds.displays || [];
  check('settings.displays: two displays', ds.ok === true && ds.displays.length === 2, show(ds.ok));
  check('settings.displays: 1280x720 at 1.5 is 1920x1080 physical, 150%, 144 Hz, not primary',
    d1 && d1.width === 1920 && d1.height === 1080 && d1.scalePercent === 150 && d1.hz === 144 && d1.primary === false && d1.label === SECRET_DISPLAY, show(d1));
  check('settings.displays: the unlabelled 1x internal one is 100%, 60 Hz, primary, "Display 2"',
    d2 && d2.width === 1920 && d2.height === 1080 && d2.scalePercent === 100 && d2.hz === 60 && d2.primary === true && d2.internal === true && d2.label === 'Display 2', show(d2));

  c.reply = (cmd) => cmd === 'startup.list'
    ? { ok: true, result: { ok: true, elevated: false, items: [{ id: SECRET_ID, name: SECRET_ENTRY, command: SECRET_CMD, on: true, scope: 'user' }], problems: [] } }
    : { ok: false, error: 'passive sidecar: refused' };
  const st = await c.call('startup');
  const sl = c.sends[c.sends.length - 1];
  check('settings.startup: asks the sidecar for startup.list', sl.cmd === 'startup.list' && sl.so && sl.so.timeoutMs > 0, show(sl));
  check('settings.startup: the list passes through', st.ok === true && st.reason === null && st.elevated === false && st.items.length === 1 && st.items[0].name === SECRET_ENTRY && st.items[0].command === SECRET_CMD && eq(st.problems, []), show(st.ok));
  c.reply = () => ({ ok: true, result: { ok: true, items: 'not a list', problems: null } });
  const odd = await c.call('startup');
  check('settings.startup: a malformed result gives empty lists, not a crash', odd.ok === true && eq(odd.items, []) && eq(odd.problems, []));
  c.reply = () => ({ ok: false, error: 'unknown command: startup.list' });
  const unk = await c.call('startup');
  check('settings.startup: "unknown command" becomes build-the-sidecar words', unk.ok === false && /build the sidecar/.test(unk.reason) && /npm run build:sidecar/.test(unk.reason) && eq(unk.items, []), show(unk.reason));
  c.reply = () => ({ ok: false, error: 'the sidecar timed out after 6000 ms' });
  const to = await c.call('startup');
  check('settings.startup: any other sidecar error is passed on', to.ok === false && /timed out/.test(to.reason), show(to.reason));

  const nSends = c.sends.length;
  const m1 = await c.call('startupSet', { on: true });
  check('settings.startupSet: no item is refused in words', m1.ok === false && /which startup entry/.test(m1.reason));
  const m2 = await c.call('startupSet', { item: SECRET_ID });
  const m3 = await c.call('startupSet', { item: SECRET_ID, on: 'yes' });
  check('settings.startupSet: a non-boolean on is refused in words', m2.ok === false && m3.ok === false && /true or false/.test(m2.reason) && /true or false/.test(m3.reason));
  check('settings.startupSet: refusals never reach the sidecar', c.sends.length === nSends);
  c.reply = (cmd, a) => ({ ok: true, result: { ok: true, dryRun: !!a.dryRun, wouldBe: a.on ? 'enabled' : 'disabled', item: { id: a.item, name: SECRET_ENTRY, on: !a.on } } });
  const t1 = await c.call('startupSet', { item: SECRET_ID, on: false });
  const ss = c.sends[c.sends.length - 1];
  check('settings.startupSet --test: the sidecar is sent {item, on, dryRun:true}', ss.cmd === 'startup.set' && eq(ss.args, { item: SECRET_ID, on: false, dryRun: true }), show(ss.args && ss.args.dryRun));
  check('settings.startupSet --test: a dry-run answer, nothing changed', t1.ok === true && t1.dryRun === true && /nothing was changed/.test(t1.reason) && /turned it off/.test(t1.reason), show(t1.reason));
  const t2 = await c.call('startupSet', { item: SECRET_ID, on: true });
  check('settings.startupSet --test: turning on says "turned it on"', t2.dryRun === true && /turned it on/.test(t2.reason));
  c.reply = () => ({ ok: true, result: { dryRun: true, wouldRefuse: 'that entry is machine-wide and Mantle is not running as admin' } });
  const t3 = await c.call('startupSet', { item: SECRET_ID, on: false });
  check('settings.startupSet --test: wouldRefuse becomes ok:false with that reason', t3.ok === false && t3.dryRun === true && t3.reason === 'that entry is machine-wide and Mantle is not running as admin', show(t3));
  c.reply = () => ({ ok: false, error: 'unknown command: startup.set' });
  const t4 = await c.call('startupSet', { item: SECRET_ID, on: false });
  check('settings.startupSet: "unknown command" becomes build-the-sidecar words', t4.ok === false && /npm run build:sidecar/.test(t4.reason));
  const sets = c.sends.filter((x) => x.cmd === 'startup.set');
  check('settings.startupSet --test: EVERY startup.set sent was dryRun:true', sets.length === 4 && sets.every((x) => x.args.dryRun === true), show(sets.map((x) => x.args.dryRun)));

  // window ops
  const none = await c.call('window', { op: 'close' });
  check('settings.window with no window: ok:false in words', none.ok === false && /not open/.test(none.reason), show(none));
  c.chords['Win+I']();
  const w = K.wins[0];
  const mn = await c.call('window', { op: 'minimize' });
  check('settings.window --test minimize: a dry run, nothing minimised', mn.ok === true && mn.dryRun === true && w.minimized === 0, show(mn));
  // An unknown op is refused BEFORE the test-mode dry run (it once answered "would have minimised").
  const unkT = await c.call('window', { op: 'explode' });
  check('settings.window --test: an unknown op is refused, not dry-run', unkT.ok === false && /not minimize, maximize or close/.test(unkT.reason || ''), show(unkT));
  const cl = await c.call('window', { op: 'close' });
  check('settings.window close: closes the window (destroyed: nothing kept, keep ready is off)', cl.ok === true && w.closes === 1 && !w.hidden && w.destroyed && inst._win() === null && inst._warm() === false, show(cl));

  const ab = await c.call('about');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  check('settings.about: version from package.json', ab.ok === true && ab.version === pkg.version, show(ab.version));
  check("settings.about: mode 'test'", ab.mode === 'test');
  check('settings.about: uptimeMs > 0 and a startedAt', ab.uptimeMs > 0 && typeof ab.startedAt === 'number' && ab.startedAt <= Date.now(), show(ab.uptimeMs));
  check('settings.about: a commit or a reason', (typeof ab.commit === 'string' && /^[0-9a-f]{4,40}$/.test(ab.commit)) || (ab.commit === null && typeof ab.commitReason === 'string' && ab.commitReason.length > 0), show([ab.commit, ab.commitReason]));
  check('settings.about: node version, electron null in plain node', ab.node === process.versions.node && ab.electron === null);
  const cat = await c.call('catalog');
  check('settings.catalog: ok with the catalog', cat.ok === true && cat.items.length === T.catalog().length);
  inst.stop('test over');
}

async function liveWindowsTests() {
  const c = fakeCtx({ live: true });
  const K = mkDeps();
  const inst = T.install(c.ctx, K.deps);
  const lb = await c.call('openWindows', { uri: 'javascript:alert(1)' });
  check('live openWindows: a non ms-settings uri never reaches the shell', lb.ok === false && K.shell.ext.length === 0);
  const lv = await c.call('openWindows', { uri: 'ms-settings:sound' });
  check('live openWindows: shell.openExternal once with that uri', lv.ok === true && lv.reason === null && eq(K.shell.ext, ['ms-settings:sound']), show(K.shell.ext));
  K.shell.openExternal = async () => { throw new Error('no handler for ms-settings'); };
  const lf = await c.call('openWindows', { uri: 'ms-settings:display' });
  check('live openWindows: a shell failure comes back in words', lf.ok === false && /did not open \(no handler for ms-settings\)/.test(lf.reason), show(lf));

  const argv = process.argv.slice();
  try {
    process.argv = argv.filter((x) => !String(x).startsWith('--log=')).concat(['--log=' + SECRET_LOG]);
    const ol = await c.call('openLogs');
    check('live openLogs: shell.openPath once with the log folder', ol.ok === true && eq(K.shell.paths, [path.dirname(SECRET_LOG)]), show(K.shell.paths));
    const ab = await c.call('about');
    check("live about: mode 'live', logFile from --log=", ab.mode === 'live' && ab.logFile === SECRET_LOG && ab.logDir === path.dirname(SECRET_LOG));
  } finally { process.argv = argv; }

  c.reply = (cmd, a) => ({ ok: true, result: { ok: true, item: { id: a.item, on: a.on } } });
  const ls = await c.call('startupSet', { item: SECRET_ID, on: false });
  const ss = c.sends[c.sends.length - 1];
  check('live startupSet: dryRun false only when not --test (the fake sidecar changes nothing)', ss.args.dryRun === false && ls.ok === true && ls.dryRun === undefined, show(ss.args.dryRun));
  check('live startupSet: the log line names no entry', c.logs.some((l) => l === 'a startup entry was turned off'), show(c.logs));

  const none = await c.call('window', { op: 'maximize' });
  check('live window with no window: ok:false', none.ok === false);
  c.chords['Win+I']();
  const w = K.wins[0];
  const mn = await c.call('window', { op: 'minimize' });
  check('live window minimize: minimises', mn.ok === true && w.minimized === 1);
  const mx = await c.call('window', { op: 'maximize' });
  const mx2 = await c.call('window', { op: 'maximize' });
  check('live window maximize: toggles', mx.maximized === true && mx2.maximized === false, show([mx, mx2]));
  const un = await c.call('window', { op: 'explode' });
  check('live window: an unknown op is refused in words', un.ok === false && /"explode" is not minimize, maximize or close/.test(un.reason), show(un));

  // live pickFolder: the fake dialog, cancelled, then a pick written through setOption
  const pc = await c.call('pickFolder', { feature: 'notes', key: 'folder' });
  check('live pickFolder: a cancelled dialog is ok, cancelled, nothing written', pc.ok === true && pc.cancelled === true && K.dialog.calls === 1 && !c.featOps.length, show(pc));
  K.dialog.showOpenDialog = async () => { K.dialog.calls++; return { canceled: false, filePaths: [SECRET_FOLDER + '-new'] }; };
  const pk = await c.call('pickFolder', { feature: 'notes', key: 'folder' });
  check('live pickFolder: a pick goes through host.features.setOption', pk.ok === true && eq(c.featOps[c.featOps.length - 1], ['setOption', 'notes', 'folder', SECRET_FOLDER + '-new']), show(c.featOps));
  inst.stop('test over');
}

/* ------------------------------------------------------------------ privacy + wiring */
function privacyTests() {
  const lines = [];
  for (const c of ALL) {
    for (const l of c.logs) lines.push(l);
    for (const h of c.health) lines.push(String(h.why));
  }
  const leaks = lines.filter((l) => SECRETS.some((s) => l.includes(s)));
  check('PRIVACY: no log line or health reason holds a startup name/command, display label or folder path', leaks.length === 0, show(leaks));
  check('PRIVACY: the sweep saw real log lines', lines.length > 20, lines.length);
}

function wiringTests() {
  check("module: name 'settings', chord Win+I, rest:true, on by default", F.name === 'settings' && eq(F.chords, ['Win+I']) && F.rest === true && F.defaultOn === true);
  check('module: WHAT describes Win+I', T.WHAT['Win+I'] === 'Mantle Settings');
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  check("wiring: main.js MANTLE_APP_TITLES lets 'Mantle Settings' through", /const MANTLE_APP_TITLES = new Set\(\[[^\]]*'Mantle Settings'/.test(main));
  const alt = fs.readFileSync(path.join(ROOT, 'sidecar', 'AltTab.cs'), 'utf8');
  check('wiring: sidecar AltTab.cs MantleAppTitles lets "Mantle Settings" through', /MantleAppTitles = new HashSet<string>\([^)]*\)\s*\{[^}]*"Mantle Settings"/.test(alt));
}

/* ------------------------------------------------------------------ section modules (ui/settings/SECTIONS.md)
   The MAIN half from temp folders (never the real ones: the category lanes fill those), and the PAGE
   half's pure rules through ui/settings/model.js: shape check, replacing, subpages, deep links and
   search metadata. The DOM half (loading scripts, the kit's controls) is proved on the mock by the
   lane's headless probe. */
const SM = require('../../ui/settings/model.js');
function sectionDirs() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-settings-sections-'));
  TMPS.push(base);
  const main = path.join(base, 'main'), page = path.join(base, 'page');
  fs.mkdirSync(main); fs.mkdirSync(page);
  const w = (dir, f, src) => fs.writeFileSync(path.join(dir, f), src);
  w(main, 'good.js', `module.exports = { id: 'good',
    commands: {
      async ping(args, env) { return { ok: true, got: args.n, test: env.test, id: env.id }; },
      async boom() { throw new Error('made-up boom'); },
      async lift(args, env) { return env.elevate('pagefile.set', { mb: 4096 }); },
      async keep(args, env) { env.settings.set('k', args.v); return { ok: true, v: env.settings.get('k', null), none: env.settings.get('none', 'dflt') }; },
      async shout(args, env) { try { env.push('settings.other.x', {}); return { ok: true }; } catch (e) { return { ok: false, reason: e.message }; } },
    },
    install(env) { global.__secRest = env.onRest(() => {}); return () => { global.__secStopped = (global.__secStopped || 0) + 1; }; } };`);
  w(main, 'throws.js', "throw new Error('made-up load failure');");
  w(main, 'wrongid.js', "module.exports = { id: 'nope', commands: {} };");
  w(main, 'badcmd.js', "module.exports = { id: 'badcmd', commands: { 'bad name': async () => ({}) } };");
  w(main, 'installthrows.js', "module.exports = { id: 'installthrows', commands: { a: async () => ({ ok: true }) }, install() { throw new Error('made-up install failure'); } };");
  w(main, 'display.js', "module.exports = { id: 'display', commands: {} };");
  w(main, 'mainonly.js', "module.exports = { id: 'mainonly', commands: {} };");
  w(main, '_skipped.js', "throw new Error('an _ file must never be loaded');");
  w(main, 'good.test.js', "throw new Error('a test file must never be loaded');");
  for (const id of ['good', 'throws', 'wrongid', 'badcmd', 'installthrows', 'pageonly']) w(page, `${id}.js`, `MantleSettings.section({ id: '${id}' });`);
  w(page, 'syntax.js', 'MantleSettings.section({ id: "syntax", \n  title: ;\n});');
  w(page, '_example.js', 'not even javascript (');
  return { main, page };
}
async function sectionMainTests() {
  const D = sectionDirs();
  const c = fakeCtx();
  const store = {};
  c.ctx.settings = { get: (k, dflt) => (k in store ? clone(store[k]) : dflt), set: (k, v) => { store[k] = clone(v); } };
  let restOffs = 0;
  c.ctx.onRest = () => () => { restOffs++; };
  const K = mkDeps();
  const lifts = [];
  const inst = T.install(c.ctx, Object.assign({}, K.deps, { mainSectionsDir: D.main, pageSectionsDir: D.page, elevate: null }));
  check('sections: a good module\'s commands are settings.<id>.<name>', ['good.ping', 'good.boom', 'good.lift'].every((v) => typeof c.commands[v] === 'function'), Object.keys(c.commands).filter((k) => k.includes('.')).join(','));
  check('sections: a broken module registers no commands', !Object.keys(c.commands).some((k) => /^(throws|wrongid|badcmd|installthrows|display)\./.test(k)), Object.keys(c.commands).join(','));
  const p = await c.call('good.ping', { n: 3 });
  check('sections: a command gets (args, env) with env.id and env.test', p.ok && p.got === 3 && p.test === true && p.id === 'good', show(p));
  const b = await c.call('good.boom', {});
  check('sections: a command that throws answers { ok:false, reason }', b.ok === false && /good\.boom failed \(made-up boom\)/.test(b.reason), show(b));
  // quality pass 2026-09-29: a throw used to leave no trace in mantle.log; now it logs its kind and
  // site, never its message (a message can carry a device name or a path)
  const bl = c.logs.filter((l) => /section good: command boom threw Error/.test(l));
  check('sections: a command that throws is logged with its kind and site', bl.length === 1 && / at good\.js:\d+/.test(bl[0]), show(c.logs.slice(-3)));
  check('sections: the log line of a throw never carries its message', !c.logs.some((l) => /made-up boom/.test(l)), show(c.logs.filter((l) => /boom/.test(l))));
  const l = await c.call('good.lift', {});
  check('sections: env.elevate before lib/elevate.js exists says so in words', l.ok === false && l.reason === T.NO_ELEVATE, show(l));
  const k = await c.call('good.keep', { v: 7 });
  check('sections: env.settings is the section\'s own namespace', k.ok && k.v === 7 && k.none === 'dflt' && eq(store['sections.good'], { k: 7 }), show([k, store]));
  const sh = await c.call('good.shout', {});
  check('sections: env.push refuses another section\'s events', sh.ok === false && /settings\.good\./.test(sh.reason), show(sh));
  const L = await c.call('sections');
  const by = (id) => L.sections.find((x) => x.id === id);
  check('sections: settings.sections lists page and main ids, _ and .test files left out',
    eq(L.sections.map((x) => x.id), ['badcmd', 'display', 'good', 'installthrows', 'mainonly', 'pageonly', 'syntax', 'throws', 'wrongid']), L.sections.map((x) => x.id).join(','));
  check('sections: a good module has its file and commands', by('good').down === null && by('good').file === 'sections/good.js' && by('good').main.ok === true && by('good').main.commands.includes('settings.good.ping'), show(by('good')));
  check('sections: a page-only section is fine', by('pageonly').down === null && by('pageonly').main === null && by('pageonly').file === 'sections/pageonly.js', show(by('pageonly')));
  check('sections: a main module that throws at load is DOWN with the reason', /did not load \(made-up load failure\)/.test(by('throws').down) && by('throws').file === null, show(by('throws')));
  check('sections: a wrong id is DOWN', /"nope" is not its file name "wrongid"/.test(by('wrongid').down), show(by('wrongid').down));
  check('sections: a bad command name is DOWN', /not a plain word/.test(by('badcmd').down), show(by('badcmd').down));
  check('sections: install() throwing is DOWN', /install\(\) threw \(made-up install failure\)/.test(by('installthrows').down), show(by('installthrows').down));
  check('sections: a built-in id is DOWN (take it over with replaces)', /built-in section's id/.test(by('display').down), show(by('display').down));
  check('sections: main commands with no page are DOWN', /no page \(ui\/settings\/sections\/mainonly\.js\)/.test(by('mainonly').down), show(by('mainonly').down));
  check('sections: a page file that does not compile is DOWN with its line', /does not compile .*line 2/.test(by('syntax').down) && by('syntax').file === null, show(by('syntax').down));
  check('sections: each DOWN module is one log line', c.logs.filter((x) => /section \w+ is DOWN/.test(x)).length === 5, c.logs.filter((x) => /DOWN/.test(x)).join(' | '));
  // navigation into a module section
  c.chords['Win+I']();
  await c.call('open', { section: 'good', page: 'storage', row: 'good.storage.x' });
  const hi = await c.call('hello');
  check('sections: settings.open accepts a module section and a page', hi.section === 'good' && hi.page === 'storage' && hi.row === 'good.storage.x', show(hi));
  check('sections: navFrom takes a module id only when it exists', T.navFrom({ section: 'nosuch' }, 1, () => false).section === null && T.navFrom({ section: 'good' }, 1, (id) => id === 'good').section === 'good');
  check('sections: navFrom never asks about a malformed id', T.navFrom({ section: '../x' }, 1, () => true).section === null);
  const pp = await c.call('pickPath', { title: 'x' });
  check('sections: pickPath in a test run is refused in words, no dialog', pp.ok === false && /never opens a folder dialog/.test(pp.reason) && K.dialog.calls === 0, show(pp));
  inst.stop('test over');
  check('sections: stop() runs each install()\'s stop and drops its onRest', global.__secStopped === 1 && restOffs === 1, show([global.__secStopped, restOffs]));
  // an elevate that exists is called with (action, args, { test, via })
  const c2 = fakeCtx();
  T.install(c2.ctx, Object.assign({}, mkDeps().deps, { mainSectionsDir: D.main, pageSectionsDir: D.page, elevate: { elevate: async (a, x, o) => { lifts.push([a, x, o]); return { ok: true, dryRun: true }; } } }));
  const l2 = await c2.call('good.lift', {});
  const lo = lifts[0] ? lifts[0][2] : {};
  check('sections: env.elevate hands (action, args, { test, via, sidecar, log, owner }) to lib/elevate.js', l2.ok === true && lifts[0][0] === 'pagefile.set' && eq(lifts[0][1], { mb: 4096 }) &&
    lo.test === true && lo.via === 'settings.good' && lo.sidecar === c2.ctx.sidecar && typeof lo.log === 'function' && lo.owner === undefined, show(lifts));
  delete global.__secRest; delete global.__secStopped;
}

/* ------------------------------------------------------------------ its own icon and app id */
/* ------------------------------------------------------------------ glass (lane settingsfx2) */
const tick = () => new Promise((r) => setImmediate(r));
async function glassTests() {
  const P = T.glassPlan;
  check('glass: Windows 11 22H2+ plans acrylic', eq(P('10.0.26200'), { material: 'acrylic', why: null }) && eq(P('10.0.22621'), { material: 'acrylic', why: null }), show(P('10.0.26200')));
  check('glass: an older Windows plans no material, and says its build', P('10.0.22000').material === null && /build 22000/.test(P('10.0.22000').why) && /solid/.test(P('10.0.22000').why), show(P('10.0.22000')));
  check('glass: an unreadable release plans no material', P('').material === null && /build unknown/.test(P('').why), show(P('')));

  // acrylic taken and the light frame read back
  const c = fakeCtx(), K = mkDeps();
  c.reply = (cmd) => (cmd === 'taskmgr.frame' ? { ok: true, result: { dark: 0, backdrop: 3, set: true } } : { ok: false, error: 'passive sidecar: refused' });
  T.install(c.ctx, Object.assign({}, K.deps, { osRelease: '10.0.26200' }));
  c.chords['Win+I']();
  const w = K.wins[0];
  check('glass: the window asks for acrylic on a clear, non-transparent window', w.opts.backgroundMaterial === 'acrylic' && w.opts.backgroundColor === '#00000000' && w.opts.transparent === false, show([w.opts.backgroundMaterial, w.opts.backgroundColor, w.opts.transparent]));
  check('glass: the page is told in its URL before its first paint', eq(w.loadOpts, { query: { glass: 'acrylic' } }), show(w.loadOpts));
  await tick(); await tick();
  const fr = c.sends.filter((x) => x.cmd === 'taskmgr.frame');
  check('glass: the light frame is asked for this window (taskmgr.frame, light)', fr.length === 1 && fr[0].args.light === true && typeof fr[0].args.hwnd === 'number', show(fr));
  check('glass: DWM\'s read-back (acrylic + light) makes it glass', eq((await c.call('hello')).glass, { material: 'acrylic', ok: true, why: null, backdrop: 3, dark: 0 }), show((await c.call('hello')).glass));
  check('glass: the page is pushed the read-back', c.pushes.some((x) => x.ev === 'settings.glass' && x.p.ok === true), show(c.pushes.map((x) => x.ev)));
  check('glass: About carries it', (await c.call('about')).glass.ok === true);
  w.emit('show');
  await tick(); await tick();
  check('glass: every show sets the light frame again', c.sends.filter((x) => x.cmd === 'taskmgr.frame').length === 2);

  // each way it can fail: solid, with the reason, logged once
  const fails = [
    ['the sidecar refuses', { ok: false, error: 'refused: not a window of Mantle\'s own Electron' }, /light frame could not be set \(refused: not a window/],
    ['DWM holds no acrylic', { ok: true, result: { dark: 0, backdrop: 1, set: true } }, /did not take the acrylic backdrop \(it reads back 1\)/],
    ['DWM cannot say', { ok: true, result: { dark: 0, backdrop: -1, set: true } }, /it reads back nothing/],
    ['the frame stays dark', { ok: true, result: { dark: 1, backdrop: 3, set: true } }, /kept the frame dark \(it reads back 1\)/],
  ];
  for (const [what, reply, re] of fails) {
    const c2 = fakeCtx(), K2 = mkDeps();
    c2.reply = (cmd) => (cmd === 'taskmgr.frame' ? reply : { ok: false, error: 'passive sidecar: refused' });
    T.install(c2.ctx, Object.assign({}, K2.deps, { osRelease: '10.0.26200' }));
    c2.chords['Win+I']();
    await tick(); await tick();
    const g = (await c2.call('about')).glass;
    check('glass: ' + what + ' = solid, and About says why', g.ok === false && re.test(g.why) && /solid/.test(g.why), show(g));
    K2.wins[0].emit('show');
    await tick(); await tick();
    check('glass: ' + what + ' is logged once', c2.logs.filter((x) => /^glass: /.test(x)).length === 1, show(c2.logs));
  }

  // an older Windows: no material asked, no sidecar call, solid with its reason
  const c3 = fakeCtx(), K3 = mkDeps();
  T.install(c3.ctx, Object.assign({}, K3.deps, { osRelease: '10.0.19045' }));
  c3.chords['Win+I']();
  await tick(); await tick();
  const w3 = K3.wins[0];
  check('glass: an older Windows gets the old opaque window', !('backgroundMaterial' in w3.opts) && w3.opts.backgroundColor === '#F4F6FA' && w3.loadOpts === undefined, show([w3.opts.backgroundColor, w3.loadOpts]));
  check('glass: an older Windows never calls the sidecar for it', !c3.sends.some((x) => x.cmd === 'taskmgr.frame'));
  const g3 = (await c3.call('hello')).glass;
  check('glass: an older Windows is solid with its reason', g3.ok === false && /build 19045/.test(g3.why), show(g3));

  // lane dm-core (2026-10-08): Mantle's appearance (ctx.host.theme) decides the frame and the solid ground, live
  const fakeTheme = (t) => { const th = { t, fns: [] }; th.api = { get: () => th.t, onChange: (fn) => { th.fns.push(fn); return () => {}; } }; th.flip = (x) => { th.t = x; th.fns.forEach((fn) => fn(x)); }; return th; };
  const c4 = fakeCtx(), K4 = mkDeps(), th4 = fakeTheme('dark');
  c4.ctx.host.theme = th4.api;
  // lane helm-wall-apps: in dark the window has NO acrylic (DWM reads back 1, none); light reads back acrylic (3)
  c4.reply = (cmd, a) => (cmd === 'taskmgr.frame' ? { ok: true, result: { dark: a.light ? 0 : 1, backdrop: a.light ? 3 : 1, set: true } } : { ok: false, error: 'passive sidecar: refused' });
  T.install(c4.ctx, Object.assign({}, K4.deps, { osRelease: '10.0.26200' }));
  c4.chords['Win+I']();
  await tick(); await tick();
  const fr4 = c4.sends.filter((x) => x.cmd === 'taskmgr.frame');
  check('theme: dark asks DWM for a DARK frame', fr4.length === 1 && fr4[0].args.light === false, show(fr4));
  check('theme: dark = an OPAQUE window, no acrylic read back (backdrop 1), no complaint', eq((await c4.call('hello')).glass, { material: 'acrylic', ok: true, why: null, backdrop: 1, dark: 1 }), show((await c4.call('hello')).glass));
  check('theme: dark asks Electron for NO material and the dark ground (helm-wall-apps)', K4.wins[0].mat === 'none' && K4.wins[0].bg === '#131415', show({ mat: K4.wins[0].mat, bg: K4.wins[0].bg }));
  check('theme: dark with no wallpaper provider pushes the reason to the page', c4.pushes.some((p) => p.ev === 'settings.wall' && p.p && p.p.ok === false && /no wallpaper picture provider/.test(p.p.reason)), show(c4.pushes.filter((p) => p.ev === 'settings.wall').map((p) => p.p)));
  th4.flip('light');
  await tick(); await tick();
  check('theme: a switch to light puts the acrylic back exactly as made (clear colour + acrylic)', K4.wins[0].mat === 'acrylic' && K4.wins[0].bg === '#00000000', show({ mat: K4.wins[0].mat, bg: K4.wins[0].bg }));
  const fr4b = c4.sends.filter((x) => x.cmd === 'taskmgr.frame');
  check('theme: a switch to light asks again, live, for a LIGHT frame', fr4b.length === 2 && fr4b[1].args.light === true && (await c4.call('hello')).glass.dark === 0, show(fr4b));
  const c5 = fakeCtx(), K5 = mkDeps(), th5 = fakeTheme('dark');
  c5.ctx.host.theme = th5.api;
  c5.reply = (cmd) => (cmd === 'taskmgr.frame' ? { ok: true, result: { dark: 1, backdrop: 3, set: true } } : { ok: false, error: 'passive sidecar: refused' });
  T.install(c5.ctx, Object.assign({}, K5.deps, { osRelease: '10.0.26200' }));
  c5.chords['Win+I']();
  await tick(); await tick();
  const g5 = (await c5.call('hello')).glass;
  check('theme: Windows keeping ACRYLIC under the dark (opaque) window is said', g5.ok === false && /kept the acrylic backdrop under the dark window/.test(g5.why), show(g5));
  const c6 = fakeCtx(), K6 = mkDeps(), th6 = fakeTheme('dark');
  c6.ctx.host.theme = th6.api;
  T.install(c6.ctx, Object.assign({}, K6.deps, { osRelease: '10.0.19045' }));
  c6.chords['Win+I']();
  const w6 = K6.wins[0];
  check('theme: an older Windows\' solid window starts on the DARK ground', w6.opts.backgroundColor === '#1B1C1F', show(w6.opts.backgroundColor));
  th6.flip('light');
  check('theme: and follows a switch live (setBackgroundColor)', w6.bg === '#F4F6FA', show(w6.bg));
}

/* --test fixtures (MANTLE_SETTINGS_FIXTURES=1): the real-Electron proof of the DOWN path */
async function fixtureTests() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-settings-fx-'));
  TMPS.push(dir);
  fs.writeFileSync(path.join(dir, 'fx-good.js'), "MantleSettings.section({ id: 'fx-good', title: 'Good', render() {} });\n");
  fs.writeFileSync(path.join(dir, 'fx-syntax.js'), 'this is not javascript (\n');
  const c = fakeCtx(), K = mkDeps();
  T.install(c.ctx, Object.assign({}, K.deps, { fixturesDir: dir }));
  const r = await c.call('sections');
  const good = r.sections.find((x) => x.id === 'fx-good'), bad = r.sections.find((x) => x.id === 'fx-syntax');
  check('fixtures: a fixture page is listed from test-sections/', good && good.file === 'test-sections/fx-good.js' && good.fixture === true && good.down === null, show(good));
  check('fixtures: a fixture that does not compile is DOWN with its reason', bad && bad.file === null && /test-sections\/fx-syntax\.js does not compile/.test(bad.down), show(bad));
  const had = process.env.MANTLE_SETTINGS_FIXTURES;
  process.env.MANTLE_SETTINGS_FIXTURES = '1';
  try {
    const c2 = fakeCtx(), K2 = mkDeps();
    T.install(c2.ctx, K2.deps);
    const t = (await c2.call('sections')).sections;
    check('fixtures: a --test run with MANTLE_SETTINGS_FIXTURES=1 lists ui/settings/test-sections', t.some((x) => x.id === 'fx-broken' && x.file === 'test-sections/fx-broken.js'), show(t.map((x) => x.id)));
    const c3 = fakeCtx({ live: true }), K3 = mkDeps();
    T.install(c3.ctx, K3.deps);
    const l = (await c3.call('sections')).sections;
    check('fixtures: a LIVE Mantle never lists them, whatever the environment says', !l.some((x) => x.fixture), show(l.map((x) => x.id)));
  } finally { if (had === undefined) delete process.env.MANTLE_SETTINGS_FIXTURES; else process.env.MANTLE_SETTINGS_FIXTURES = had; }
}

/* kit.js: a declined administrator prompt is a neutral note on a list action as on a toggle (the page
   half runs in the page, so this pins the source: cancelled is looked at BEFORE ok:false, as info) */
function kitCancelledTests() {
  const src = fs.readFileSync(path.join(ROOT, 'ui', 'settings', 'kit.js'), 'utf8');
  const act = src.slice(src.indexOf('function act('), src.indexOf('const K = {'));
  const list = src.slice(src.indexOf('      list(o) {'));
  const order = (body) => {
    const c = body.indexOf("x.cancelled) "), info = body.indexOf("note = { tone: 'info', text: CANCELLED }"), f = body.indexOf('x.ok === false)');
    return c >= 0 && info > c && f > info;
  };
  check('kit: the declined-prompt words are one constant', src.includes("const CANCELLED = 'You said no to the administrator prompt; nothing changed.';"));
  check('kit: a toggle takes a declined prompt as an info note, before ok:false', order(act));
  check('kit: a list action takes a declined prompt as an info note, before ok:false', order(list));
}

/* review2 #2 (lane mantle-review2fix), the page half: a made-ahead window reads document.hidden === false on
   its first load, so the page must take "hidden" from main (settings.hello { hidden }, settings.wake,
   settings.sleep), and every live part (the boot's qs.watch, the loops, wake) must ask that, not
   document.hidden alone. The page runs in a renderer, so this pins its source as kitCancelledTests does. */
function keptHiddenPageTests() {
  const src = fs.readFileSync(path.join(ROOT, 'ui', 'settings', 'settings.js'), 'utf8').replace(/\r\n/g, '\n');
  const body = (start, end) => { const i = src.indexOf(start); return i < 0 ? '' : src.slice(i, src.indexOf(end, i + start.length)); };
  const loops = body('function startLoops(sec) {', '\n  }\n');
  const wakeFn = body('function wake() {', '\n  }\n');
  const booted = body('const booted = Promise.all(', '});');
  check('page: one "is it hidden" answer that counts main\'s word', /function hiddenNow\(\) \{ return keptHidden \|\| document\.hidden; \}/.test(src));
  check('page: the hello answer sets it (a made-ahead page starts asleep)', /keptHidden = r\.hidden === true;/.test(src));
  check('page: the loops (and the 30 s qs.watch re-assert) start only when not hidden', /if \(hiddenNow\(\)\) return;/.test(loops) && !/document\.hidden/.test(loops), loops.slice(0, 120));
  check('page: wake asks the same', /if \(awake \|\| hiddenNow\(\)\) return;/.test(wakeFn) && !/document\.hidden/.test(wakeFn));
  check('page: boot takes the qs.watch lease only when not hidden', /awake = !hiddenNow\(\);/.test(booted) && !/document\.hidden/.test(booted), booted.slice(0, 120));
  check('page: settings.wake wakes it (no visibilitychange on a first show)', /on\('settings\.wake', \(\) => \{ keptHidden = false; if \(bootDone\) wake\(\); \}\)/.test(src));
  check('page: settings.sleep puts it to sleep', /on\('settings\.sleep', \(\) => \{ keptHidden = true; sleep\(\); \}\)/.test(src));
}

/* fast cold, nothing kept (lane settingsfast): with keep ready OFF (the default) close destroys the window and
   nothing is made ahead; a live cold open shows at its first paint and logs one timed line; a page that has not
   painted SHOW_BY_MS after the open is shown anyway. With keep ready ON: one hidden window is made ahead (after
   a calm CPU), reused at Home, kept on close with no time limit, let go when the switch goes off, and a stop
   (a game rest), switching off and quitting always really close it. */
const KR = require('../keep-ready.js');
function keepStore(on) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-keepready-'));
  TMPS.push(dir);
  const s = KR.create({ file: path.join(dir, 'keep-ready.json') });
  if (on) s.set('settings', true);
  return s;
}
/* a window that behaves like Electron's for an open's timing: show() fires 'show', the page answers a frame */
function liveDeps(K) {
  class LW extends K.deps.BrowserWindow {
    constructor(o) { super(o); this.vis = false; this.webContents.executeJavaScript = async () => ({ at: Date.now(), rows: Date.now() }); }
    show() { super.show(); const was = this.vis; this.vis = true; if (!was) this.emit('show'); }
    hide() { super.hide(); this.vis = false; }
    isVisible() { return this.vis; }
  }
  return Object.assign({}, K.deps, { BrowserWindow: LW });
}
async function warmTests() {
  check('cold: the show-by fallback is 300 ms and keep ready makes its window a minute after start', T.SHOW_BY_MS === 300 && T.PREWARM_MS === 60000);
  // keep ready OFF (the default)
  const c = fakeCtx(), K = mkDeps();
  const inst = T.install(c.ctx, Object.assign({}, K.deps, { keepReady: keepStore(false), prewarmMs: 0, cpuBusy: () => 0 }));
  await wait(20);
  check('keep off: nothing is made ahead', K.wins.length === 0, K.wins.length);
  c.chords['Win+I']();
  const w = K.wins[0];
  w.close();
  check('keep off: close destroys the window (its memory goes back at once)', w.destroyed && !w.hidden && inst._win() === null && inst._warm() === false, show([w.hidden, w.destroyed]));
  check('keep off: the close is logged as nothing kept', c.logs.some((x) => /closed \(the window is destroyed, nothing kept in memory\)/.test(x)), show(c.logs.slice(-3)));
  c.chords['Win+I']();
  check('keep off: the next Win+I makes a fresh window', K.wins.length === 2);
  inst.stop('test over');

  // a LIVE cold open: shown at the first paint, one timed line after the frame is drawn
  const cl = fakeCtx({ live: true }), KL = mkDeps();
  const instL = T.install(cl.ctx, Object.assign(liveDeps(KL), { keepReady: keepStore(false), prewarmMs: 0 }));
  cl.chords['Win+I']();
  const wl = KL.wins[0];
  check('live cold: not shown before its first paint', wl.shown === 0);
  wl.emit('ready-to-show');
  await wait(20);
  check('live cold: shown at its first paint (light: no wallpaper wait)', wl.shown === 1, wl.shown);
  check('live cold: one timed line, written after the frame', cl.logs.filter((x) => /^opened \(cold\) via Win\+I at home: shown \d+, painted \d+, interactive \d+ ms$/.test(x)).length === 1, show(cl.logs));
  cl.chords['Win+I']();
  check('live: Win+I on an open window brings it to the front (no second window, no second timed line)', KL.wins.length === 1 && cl.logs.some((x) => /^brought to the front via Win\+I/.test(x)) && cl.logs.filter((x) => /^opened \(/.test(x)).length === 1);
  instL.stop('test over');

  // a page that has not painted by SHOW_BY_MS: the window shows anyway, and says so
  const cs = fakeCtx({ live: true }), KS = mkDeps();
  const instS = T.install(cs.ctx, Object.assign(liveDeps(KS), { keepReady: keepStore(false), prewarmMs: 0, showByMs: 20 }));
  cs.chords['Win+I']();
  await wait(50);
  const ws = KS.wins[0];
  check('show-by: an unpainted page is shown anyway', ws.shown === 1, ws.shown);
  check('show-by: it says why', cs.logs.some((x) => /had not drawn 20 ms after the open, so the window shows on its plain ground/.test(x)), show(cs.logs));
  ws.emit('ready-to-show');
  check('show-by: the late first paint does not show it twice', ws.shown === 1, ws.shown);
  instS.stop('test over');

  // keep ready ON: one hidden window made ahead, reused, kept on close
  const ck = fakeCtx({ live: true }), KK = mkDeps();
  const store = keepStore(true);
  const instK = T.install(ck.ctx, Object.assign(liveDeps(KK), { keepReady: store, prewarmMs: 0, cpuBusy: () => 0 }));
  await wait(20);
  const wk = KK.wins[0];
  check('keep on: one window is made ahead and kept hidden', KK.wins.length === 1 && wk.shown === 0 && instK._warm() === true, KK.wins.length);
  check('keep on: making it is logged with its cost', ck.logs.some((x) => /made ahead and kept hidden: keep ready is on \(about \d+ MB/.test(x)), show(ck.logs));
  wk.emit('ready-to-show');
  check('keep on: its first paint does not show it', wk.shown === 0);
  // review2 #2: Electron calls a show:false window VISIBLE on its first load, so the page is TOLD it is hidden
  const helloK = await ck.commands.hello({});
  check('keep on: the made-ahead page is told it is hidden (it starts asleep: no qs.watch, no loops)', helloK && helloK.hidden === true, helloK && helloK.hidden);
  ck.pushes.length = 0;
  ck.chords['Win+I']();
  await wait(20);
  const evsK = ck.pushes.map((x) => x.ev);
  check('keep on: the open that shows it wakes its page (settings.wake, before the nav)', evsK.indexOf('settings.wake') >= 0 && evsK.indexOf('settings.wake') < evsK.indexOf('settings.nav'), evsK);
  check('keep on: once shown, a reload of its page is told it is not hidden', (await ck.commands.hello({})).hidden === false);
  check('keep on: Win+I shows the kept window (no second window)', KK.wins.length === 1 && wk.shown === 1 && instK._warm() === false, show([KK.wins.length, wk.shown]));
  check('keep on: it opens at Home', ck.navPushes().length === 1 && ck.navPushes()[0].p.section === 'home');
  check('keep on: the open is logged warm', ck.logs.some((x) => /^opened \(warm\) via Win\+I at home: shown \d+, painted \d+, interactive \d+ ms$/.test(x)), show(ck.logs.slice(-3)));
  ck.pushes.length = 0;
  wk.close();
  check('keep on: a close that hides it puts its page to sleep (settings.sleep)', ck.pushes.some((x) => x.ev === 'settings.sleep'), ck.pushes.map((x) => x.ev));
  check('keep on: close hides it (kept, no time limit)', wk.hidden === 1 && !wk.destroyed && instK._win() === wk && instK._warm() === true, show([wk.hidden, wk.destroyed]));
  check('keep on: the hide is logged', ck.logs.some((x) => /kept hidden for the next open \(keep ready is on\)/.test(x)));
  store.set('settings', false);
  check('keep on -> off: the hidden window is let go at once', wk.destroyed && instK._win() === null && ck.logs.some((x) => /keep ready turned off: the hidden window is let go/.test(x)));
  store.set('settings', true);
  await wait(2100);                       // PREWARM_ON_MS
  check('keep off -> on: a window is made ahead again', KK.wins.length === 2 && KK.wins[1].shown === 0 && instK._warm() === true, KK.wins.length);
  instK.stop('VALORANT runs');
  check('keep on: a stop (a game rest) destroys the kept window at once', KK.wins[1].destroyed && instK._win() === null);

  // keep ready ON with a busy CPU: not made yet, tried again later
  const cb = fakeCtx(), KB = mkDeps();
  const instB = T.install(cb.ctx, Object.assign({}, KB.deps, { keepReady: keepStore(true), prewarmMs: 0, prewarmRetryMs: 60000, cpuBusy: () => 0.95 }));
  await wait(20);
  check('keep on, busy CPU: nothing is made while the CPU is busy', KB.wins.length === 0, KB.wins.length);
  instB.stop('test over');

  const c2 = fakeCtx(), K2 = mkDeps();
  T.install(c2.ctx, Object.assign({}, K2.deps, { keepReady: keepStore(true), prewarmMs: 60000 }));
  c2.chords['Win+I']();
  K2.deps.electron.app.emit('before-quit');
  K2.wins[0].close();
  check('keep on: while Mantle quits, close really closes', K2.wins[0].destroyed === true);

  const c3 = fakeCtx(), K3 = mkDeps();
  T.install(c3.ctx, Object.assign({}, K3.deps, { keepReady: keepStore(true), prewarmMs: 60000 }));
  c3.chords['Win+I']();
  K3.wins[0].close();
  check('keep on: close hid it', K3.wins[0].hidden === 1 && !K3.wins[0].destroyed);
  c3.on = false;
  c3.enabledFns.forEach((fn) => fn(false));
  check('keep on: switching Settings off destroys the hidden window', K3.wins[0].destroyed === true);

  // the keep-ready rows reach the page through settings.mantle / settings.keepReady
  const c4 = fakeCtx(), K4 = mkDeps();
  const s4 = keepStore(false);
  T.install(c4.ctx, Object.assign({}, K4.deps, { keepReady: s4, prewarmMs: 60000 }));
  const mv = await c4.call('mantle');
  const rows = mv.keepReady && mv.keepReady.rows || [];
  check('rows: settings.mantle carries one keep-ready row per surface, all off', eq(rows.map((r) => [r.key, r.on]), [['keepReady.settings', false], ['keepReady.taskmgr', false], ['keepReady.files', false]]), show(rows));
  check('rows: each says its memory cost in plain words', rows.every((r) => /holds about \d+ MB of memory all the time/.test(r.help) && /uses no memory while closed/.test(r.help)), show(rows.map((r) => r.help)));
  const set = await c4.call('keepReady', { surface: 'taskmgr', on: true });
  check('keepReady: a switch is saved and read back', set.ok === true && set.on === true && s4.get('taskmgr') === true && set.keepReady.rows[1].on === true, show(set));
  const bad = await c4.call('keepReady', { surface: 'explorer', on: true });
  check('keepReady: an unknown surface is refused in words', bad.ok === false && /not a window Mantle can keep ready/.test(bad.reason), show(bad));
}

async function iconTests() {
  check('icon: the file is assets/icons/mantle-settings.ico and the app id Mantle.Settings', T.ICON_FILE === 'assets/icons/mantle-settings.ico' && T.APP_ID === 'Mantle.Settings');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-settings-icon-'));
  TMPS.push(dir);
  const ico = path.join(dir, 'fake-settings.ico');
  fs.writeFileSync(ico, 'not really an icon');
  const c = fakeCtx(), K = mkDeps();
  delete K.deps.icon;
  T.install(c.ctx, Object.assign({}, K.deps, { iconPath: ico }));
  c.chords['Win+I']();
  const w = K.wins[0];
  check('icon: the window gets the .ico as its icon', w && w.opts.icon === ico, show(w && w.opts.icon));
  check('icon: setAppDetails gives Windows its own app id and icon', w && eq(w.appDetails, { appId: 'Mantle.Settings', relaunchDisplayName: 'Mantle Settings', appIconPath: ico, appIconIndex: 0 }), show(w && w.appDetails));
  check('icon: nothing needs a look when the icon is there', eq((await c.call('mantle')).problems, []));
  const c2 = fakeCtx(), K2 = mkDeps();
  T.install(c2.ctx, Object.assign({}, K2.deps, { iconPath: path.join(os.tmpdir(), 'mantle-no-such-icon.ico') }));
  c2.chords['Win+I']();
  const w2 = K2.wins[0];
  check('icon: a missing icon still opens the window', K2.wins.length === 1 && !!w2.file, K2.wins.length);
  check('icon: a missing icon keeps the app id (no icon path)', w2 && eq(w2.appDetails, { appId: 'Mantle.Settings', relaunchDisplayName: 'Mantle Settings' }), show(w2 && w2.appDetails));
  check('icon: a missing icon is logged once', c2.logs.filter((x) => /its own icon .* is missing/.test(x)).length === 1, c2.logs.join(' | '));
  const pr = (await c2.call('mantle')).problems;
  check('icon: a missing icon is on Home\'s "needs a look" list (settings.mantle problems)', pr.length === 1 && /mantle-settings\.ico\) is missing/.test(pr[0]), show(pr));
}

function sectionModelTests() {
  const fn = () => ({ dispose() {} });
  const sys = { id: 'system', title: 'System', group: 'windows', order: 10, replaces: ['display', 'sound', 'power'],
    search: [{ row: 'system.name', label: 'Device name', keywords: 'rename pc' }],
    pages: [{ id: 'sound' }, { id: 'power', title: 'Power & battery', render: fn, search: [{ row: 'power.mode', label: 'Power mode' }] },
      { id: 'storage', title: 'Storage', render: fn, search: [{ row: 'system.storage.sense', label: 'Storage Sense', keywords: 'cleanup', uri: 'ms-settings:storagesense' }] }] };
  const one = { id: 'gaming', title: 'Gaming', group: 'windows', order: 80, render: fn, search: [{ row: 'gaming.bar', label: 'Game Bar' }] };
  const bt = { id: 'devices', title: 'Bluetooth & devices', group: 'windows', replaces: 'bluetooth', render: fn };
  // the shape check
  check('checkSection: a category with pages is fine', SM.checkSection(sys, 'system') === null, SM.checkSection(sys, 'system'));
  check('checkSection: a one-page section is fine', SM.checkSection(one, 'gaming') === null);
  const bad = (d, f, re) => { const w = SM.checkSection(d, f); check(`checkSection: ${re} is refused`, re.test(String(w)), w); };
  bad(Object.assign({}, one, { id: 'other' }), 'gaming', /not its file name/);
  bad(Object.assign({}, one, { id: 'display' }), 'display', /built-in section's id/);
  bad(Object.assign({}, one, { group: 'extra' }), 'gaming', /group must be/);
  bad(Object.assign({}, one, { replaces: 'mantle' }), 'gaming', /replaces "mantle", which is not one of/);
  bad(Object.assign({}, one, { render: undefined }), 'gaming', /no pages and no render/);
  bad(Object.assign({}, one, { search: [{ row: 'has space', label: 'x' }] }), 'gaming', /no usable row id/);
  bad(Object.assign({}, one, { search: [{ row: 'gaming.a', label: 'A', uri: 'https://x' }] }), 'gaming', /uri must be an ms-settings/);
  bad(Object.assign({}, sys, { pages: [{ id: 'storage', title: 'S', render: fn }, { id: 'storage', title: 'S', render: fn }] }), 'system', /page id "storage" is used twice/);
  bad(Object.assign({}, sys, { pages: [{ id: 'network' }] }), 'system', /page "network" has no render/);
  bad(Object.assign({}, sys, { search: [{ row: 'power.mode', label: 'x' }] }), 'system', /"power.mode" is used twice/);
  // replacing and subpages
  const mo = SM.sectionModel([sys, one, bt, { id: 'broken', title: 'Broken', down: 'made-up load failure' }, Object.assign({}, bt, { id: 'devices2' })]);
  const nav = mo.nav.map((e) => e.id + (e.down ? '!' : ''));
  check('model: a module takes its replaced built-ins\' slot; the built-ins leave the sidebar',
    eq(nav, ['home', 'system', 'notifications', 'devices', 'network', 'apps', 'gaming', 'broken!', 'devices2!', 'mantle', 'shortcuts', 'about']), nav.join(','));
  check('model: a second module replacing the same built-in is DOWN, naming the first', /Bluetooth & devices section already replaces/.test(mo.mods.devices2.down), mo.mods.devices2.down);
  check('model: pages = unlisted replaced built-ins first, then the listed ones in order',
    eq(mo.pages.system.map((p) => p.id + (p.builtin ? '*' : '')), ['display*', 'sound*', 'power', 'storage']), show(mo.pages.system));
  check('model: a module page with a built-in\'s id replaces its content', mo.owner.power.drawn === false && mo.owner.display.drawn === true);
  check('model: a one-page module supersedes the built-in whole', mo.owner.bluetooth && mo.owner.bluetooth.page === null && mo.pages.devices === null);
  // deep links
  const R = (n) => { const r = SM.resolve(mo, n); return [r.section, r.page, r.view, r.row]; };
  check('resolve: a built-in row goes to its owner\'s page, drawn by the built-in', eq(R({ row: 'display.brightness' }), ['system', 'display', 'display', 'display.brightness']));
  check('resolve: a replaced built-in section id lands on its page', eq(R({ section: 'sound' }), ['system', 'sound', 'sound', null]));
  check('resolve: a module row lands on its page', eq(R({ row: 'system.storage.sense' }), ['system', 'storage', null, 'system.storage.sense']));
  check('resolve: a row the module took over from a built-in lands on the module page', eq(R({ row: 'power.mode' }), ['system', 'power', null, 'power.mode']));
  check('resolve: a category alone opens its overview', eq(R({ section: 'system' }), ['system', null, null, null]));
  check('resolve: an unknown page opens the overview', eq(R({ section: 'system', page: 'nosuch' }), ['system', null, null, null]));
  check('resolve: a superseded built-in lands on the one-page module', eq(R({ section: 'bluetooth', row: 'bluetooth.devices' }), ['devices', null, null, 'bluetooth.devices']));
  const dn = SM.resolve(mo, { section: 'broken' });
  check('resolve: a DOWN module carries its reason', dn.section === 'broken' && dn.down === 'made-up load failure', show(dn));
  check('resolve: an untouched built-in is itself', eq(R({ section: 'network' }), ['network', null, 'network', null]));
  check('resolve: nothing known is Home', eq(R({ section: 'nosuch' }), ['home', null, 'home', null]));
  // search metadata
  const idx = SM.buildIndex({ model: mo, catalog: [{ name: 'Storage Sense', uri: 'ms-settings:storagesense' }, { name: 'Bluetooth', uri: 'ms-settings:bluetooth', section: 'bluetooth', row: 'bluetooth.radio' }] });
  const top = (q) => { const h = SM.search(idx, q)[0]; return h ? [h.entry.kind, h.entry.label, h.entry.section, h.entry.page || null] : null; };
  check('search: a module page row is found from its static metadata', eq(top('storage sense'), ['row', 'Storage Sense', 'system', 'storage']), show(top('storage sense')));
  check('search: a module page is found', eq(top('storage'), ['page', 'Storage', 'system', 'storage']), show(top('storage')));
  check('search: a one-page module\'s row is found', eq(top('game bar'), ['row', 'Game Bar', 'gaming', null]), show(top('game bar')));
  check('search: a built-in drawn as a page stays findable, as a page of its owner', idx.some((e) => e.id === 'display' && e.kind === 'page' && e.sub === 'System') && idx.some((e) => e.id === 'display.brightness'));
  check('search: an overridden built-in\'s static rows are gone', !idx.some((e) => e.id === 'power.saver') && idx.filter((e) => e.id === 'power.mode').length === 1);
  check('search: a claimed ms-settings page joins its row instead of a second entry', !idx.some((e) => e.kind === 'catalog' && e.uri === 'ms-settings:storagesense') && /storage sense/i.test(idx.find((e) => e.id === 'system.storage.sense').kw));
  check('search: a DOWN module is still listed, as down', idx.some((e) => e.id === 'section.broken' && /^Down: /.test(e.sub)));
  // lane wire: a section or a page claims a Windows page WITHOUT naming a row (a category's root)
  const priv = { id: 'privacy', title: 'Privacy & security', group: 'windows', order: 100, uri: 'ms-settings:privacy',
    pages: [{ id: 'camera', title: 'Camera', uri: ['ms-settings:privacy-webcam'], render: fn, search: [{ row: 'privacy.camera.user', label: 'Camera access', uri: 'ms-settings:privacy-webcam2' }] }] };
  check('checkSection: a section-level uri and a page-level uri list are fine', SM.checkSection(priv, 'privacy') === null, SM.checkSection(priv, 'privacy'));
  bad(Object.assign({}, priv, { uri: 'https://x' }), 'privacy', /its uri must be an ms-settings: page or a list of them/);
  bad(Object.assign({}, priv, { uri: [] }), 'privacy', /its uri must be an ms-settings: page/);
  bad(Object.assign({}, priv, { pages: [Object.assign({}, priv.pages[0], { uri: ['ms-settings:ok', 7] })] }), 'privacy', /page "camera" uri must be an ms-settings: page/);
  const upd = { id: 'update', title: 'Windows Update', group: 'windows', order: 110, render: fn, search: [{ row: 'update.main.check', label: 'Check for updates', uri: 'ms-settings:windowsupdate' }] };
  const mo2 = SM.sectionModel([priv, upd, { id: 'personalization', title: 'Personalization', down: 'made-up load failure' }]);
  check('model: claims = section root, page and row uris, lower-cased', eq(mo2.claims['ms-settings:privacy'], { section: 'privacy', page: null, row: null }) &&
    eq(mo2.claims['ms-settings:privacy-webcam'], { section: 'privacy', page: 'camera', row: null }) && eq(mo2.claims['ms-settings:windowsupdate'], { section: 'update', page: null, row: 'update.main.check' }), show(mo2.claims));
  check('claimOf: a claimed page -> its section/page/row; unclaimed -> null', eq(SM.claimOf(mo2, 'MS-SETTINGS:PRIVACY'), { section: 'privacy', page: null, row: null }) && SM.claimOf(mo2, 'ms-settings:colors') === null);
  const R2 = (n) => { const r = SM.resolve(mo2, n); return [r.section, r.page, r.row]; };
  check('resolve: a root claim opens the category overview, a page claim that page', eq(R2(SM.claimOf(mo2, 'ms-settings:privacy')), ['privacy', null, null]) && eq(R2(SM.claimOf(mo2, 'ms-settings:privacy-webcam')), ['privacy', 'camera', null]));
  const idx2 = SM.buildIndex({ model: mo2, catalog: [{ name: 'Privacy & security', uri: 'ms-settings:privacy', keywords: 'permissions' }, { name: 'Camera access', uri: 'ms-settings:privacy-webcam', keywords: 'webcam permission' },
    { name: 'Colors', uri: 'ms-settings:colors', section: 'personalization', row: 'personalization.colors' }] });
  check('search: a root claim joins the section entry (no Windows entry for it)', !idx2.some((e) => e.kind === 'catalog' && e.uri === 'ms-settings:privacy') && /permissions/.test(idx2.find((e) => e.id === 'section.privacy').kw));
  check('search: a page claim joins the page entry', !idx2.some((e) => e.kind === 'catalog' && e.uri === 'ms-settings:privacy-webcam') && /webcam permission/.test(idx2.find((e) => e.id === 'page.privacy.camera').kw));
  const col = idx2.find((e) => e.kind === 'catalog' && e.uri === 'ms-settings:colors');
  check('search: a page whose module is DOWN is Windows\' (it says so, and opens Windows\' page)', col && col.sub === 'Windows Settings' && col.section === null, show(col));
  const mh = SM.more('home', mo2), mm = SM.more('mantle', mo2);
  check('more: a page a module claims links into Mantle; the rest still name their Windows page',
    eq(mh.find((l) => l.uri === 'ms-settings:privacy').to, { section: 'privacy', page: null, row: null }) && eq(mh.find((l) => l.uri === 'ms-settings:windowsupdate').to, { section: 'update', page: null, row: 'update.main.check' }) &&
    !('to' in mh.find((l) => l.uri === 'ms-settings:yourinfo')) && mm.every((l) => !l.to), show(mh));
  const nokeys = { name: 'wallpaper', label: 'Wallpaper', enabled: true, ok: true, running: true, chords: [], keys: false, keysReason: 'it takes no keys from Windows' };
  check('health: a feature that owns no chords is not "its keys are Windows\'" (sweep 2026-09-29)', SM.featureState(nokeys).tone === 'ok' && SM.health([nokeys]).bad.length === 0, show(SM.featureState(nokeys)));
  const lostKeys = Object.assign({}, nokeys, { chords: ['Win+V'], keysReason: 'Win+V: another app holds it' });
  check('health: a feature whose chords are Windows\' still needs a look', SM.featureState(lostKeys).tone === 'warn' && SM.health([lostKeys]).bad.length === 1);
  check('more: without a model every link is Windows\' (as before)', SM.more('home').every((l) => !l.to && /^ms-settings:/.test(l.uri)));
  const plain = SM.sectionModel([]);
  check('model: no modules = the built-in sidebar', eq(plain.nav.map((e) => e.id), ['home', 'display', 'sound', 'notifications', 'power', 'bluetooth', 'network', 'apps', 'mantle', 'shortcuts', 'about']), plain.nav.map((e) => e.id).join(','));
}

(async () => {
  try {
    navTests();
    sectionModelTests();
    await iconTests();
    kitCancelledTests();
    keptHiddenPageTests();
    await glassTests();
    await warmTests();
    await fixtureTests();
    await sectionMainTests();
    shortcutTests();
    wiringTests();
    await catalogCommitTests();
    await windowTests();
    await liveWindowTests();
    await launcherEventTests();
    await mantlePageTests();
    await windowsTests();
    await liveWindowsTests();
    privacyTests();
  } catch (e) {
    failures.push('threw: ' + (e && e.stack ? e.stack : e));
  }
  for (const d of TMPS) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* a temp folder */ } }
  for (const f of failures) console.log('FAIL ' + f);
  console.log(`SETTINGS TEST: ${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();
