'use strict';
/*
 * settings.test.js - Mantle Settings (Win+I), in node, no Electron, no sidecar (lane settings-tests,
 * 2026-09-28).
 *
 *   node lib/features/settings.test.js
 *
 * WHY fakes for everything: the feature's whole job is to touch Owen's machine (a real window, the
 * Windows Settings app, the log folder, his startup entries in the registry). Here every one of those
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
  check('navFrom: a known section, a good row and a query are kept', eq(n, { section: 'sound', row: 'sound.output', query: 'volume', seq: 3 }), show(n));
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
  check('navFrom: null gives an empty nav with the seq', eq(T.navFrom(null, 7), { section: null, row: null, query: '', seq: 7 }));
  check('navFrom: a bare string is not a nav', eq(T.navFrom('sound', 2), { section: null, row: null, query: '', seq: 2 }));
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
  check('catalog: ms-settings:startupapps is {section apps, row apps.startup}', st && st.section === 'apps' && st.row === 'apps.startup', show(st));
  const wu = items.find((i) => i.uri === 'ms-settings:windowsupdate');
  check('catalog: ms-settings:windowsupdate is section null (Windows keeps it)', wu && wu.section === null && wu.row === null, show(wu));
  const marked = items.filter((i) => i.section);
  check('catalog: exactly the MANTLE_SETTINGS pages are marked', marked.length === Object.keys(LI.MANTLE_SETTINGS).length, marked.length);
  check('catalog: every marked section is one the page knows', marked.every((i) => T.SECTIONS.includes(i.section)));

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
  loadFile(p) { this.file = p; }
  show() { this.shown++; }
  focus() { this.focused++; }
  isMinimized() { return false; }
  restore() {}
  isFocused() { return true; }                   // so reveal's sidecar focus hand-over never runs
  isDestroyed() { return this.destroyed; }
  destroy() { if (this.destroyed) return; this.destroyed = true; this.emit('closed'); }
  close() { this.closes++; this.destroy(); }
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
  return { wins, shell, dialog, app, deps: { electron: { app }, BrowserWindow: W, screen: fakeScreen(), shell, dialog, icon: null } };
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

  // closed by Owen (the X, Alt+F4): forgotten, the next Win+I makes a new one at Home
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
  check("mantle-open 'settings': the log names the launcher", c.logs.some((l) => /opened by the launcher at network/.test(l)), show(c.logs));
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
  check('settings.window close: closes the window', cl.ok === true && w.closes === 1 && w.destroyed && inst._win() === null, show(cl));

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

(async () => {
  try {
    navTests();
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
