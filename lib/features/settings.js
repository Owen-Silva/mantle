'use strict';
/*
 * settings.js - MANTLE SETTINGS, Win+I (lane settings, 2026-09-28).
 *
 * Owen: "i think you should just add a mantle section or something to the existing settings and then
 * make the existing settings better and the mantle style". So Win+I opens ui/settings/, a Mantle-styled
 * Settings window:
 *   - a Mantle section with every Mantle option in one place: each feature's switch (the tray's own
 *     setEnabled), each feature's declared `options` (lib/features.js OPTIONS, written through that
 *     feature's own settings store), the switcher's Alt+Tab and Win+N / Win+A switches, the hot
 *     corners (the corners feature's own commands), every chord Mantle owns, and About;
 *   - Windows sections that are better than Windows': one page per area, live values, a search that
 *     finds any setting, and "More in Windows Settings" deep links for the rest. They use the SAME
 *     backends the bar's quick settings use (qs.*, volume.*, net.get, battery.get, powermode.*); the
 *     ONE new backend is Startup apps (sidecar/Startup.cs), reached through settings.startup /
 *     settings.startupSet here;
 *   - "All Windows settings" always opens the real app (settings.openWindows).
 *
 * THE WINDOW is an app window, not a panel: frameless, draggable header, resizable (min 760 x 520),
 * listed on the bar and in Alt+Tab (sidecar Switcher.IsMantleApp / main.js MANTLE_APP_TITLES let the
 * exact title "Mantle Settings" through). It is made on open and DESTROYED on close, never kept hidden:
 * Owen fights for RAM while gaming, and `rest: true` closes it while a game runs (Win+I is Windows'
 * again until the game exits).
 *
 * WAYS IN: Win+I; the top bar's Mantle menu (topbar.settings runs Win+I's handler through
 * ctx.runChord); the launcher's "Mantle Settings" row and the Windows pages this window covers
 * (lib/launcher-index.js MANTLE_SETTINGS, through app 'mantle-open' 'settings' with a reply object);
 * any page through settings.open {section, row, query}.
 *
 * --test: the window is made and its page runs, but it is NEVER shown or focused (Owen's desktop);
 * every write that would reach Windows is a dry run (openWindows, openLogs, startupSet) and the
 * folder dialog is refused in words.
 *
 * PRIVACY: startup entry names and commands, device names, SSIDs and paths reach the page only in
 * command RESULTS (never logged); nothing here logs them. Arguments of a failed call are logged by
 * main as lengths only (lib/call-log.js).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const CHORD = 'Win+I';
const TITLE = 'Mantle Settings';               // sidecar AltTab.cs MantleAppTitles + main.js MANTLE_APP_TITLES
const WIN_W = 1040, WIN_H = 700, MIN_W = 760, MIN_H = 520;
const SECTIONS = ['home', 'display', 'sound', 'bluetooth', 'network', 'power', 'notifications', 'apps', 'mantle', 'shortcuts', 'about'];
const MS_RE = /^ms-settings:[a-z0-9-]*$/i;
const ROW_RE = /^[A-Za-z0-9_.+-]{1,80}$/;
const CHANGE_MS = 120;                          // many switches in one tick = one redraw
const HEALTHY = 'Win+I opens Mantle Settings';

/* What each chord Mantle can own does, for the Keyboard shortcuts page. */
const WHAT = {
  'Win+S': 'Search', 'Win+V': 'Clipboard history', 'Win+Tab': 'Task view',
  'Win+Left': 'Snap the window left', 'Win+Right': 'Snap the window right', 'Win+Up': 'Maximise or snap up',
  'Win+Down': 'Restore or minimise', 'Win+Z': 'Snap layouts', 'Win+Shift+S': 'Screenshot (pick an area)',
  PrintScreen: 'Screenshot', VolumeUp: 'Volume up (Mantle pop-up)', VolumeDown: 'Volume down (Mantle pop-up)',
  VolumeMute: 'Mute (Mantle pop-up)', 'Win+Alt+T': 'Hide or show the top bar', 'Win+Ctrl+T': 'Keep the window on top',
  'Win+Alt+N': 'Quick notes', 'Win+I': 'Mantle Settings', 'Ctrl+Shift+Esc': 'Task manager',
};

function words(e) { return e && e.message ? e.message : String(e); }

/** A navigation request from a chord, a menu, the launcher or a page. PURE. */
function navFrom(a, seq) {
  const o = a && typeof a === 'object' ? a : {};
  return {
    section: SECTIONS.includes(o.section) ? o.section : null,
    row: typeof o.row === 'string' && ROW_RE.test(o.row) ? o.row : null,
    query: typeof o.query === 'string' ? o.query.slice(0, 100) : '',
    seq,
  };
}

/** The Keyboard shortcuts page: every chord a feature owns, plus the switcher's keys. PURE. */
function shortcutsOf(features, sw) {
  const out = [];
  for (const f of features || []) {
    for (const c of f.chords || []) {
      out.push({ keys: c, what: WHAT[c] || c, owner: f.name, ownerLabel: f.label, on: !!f.enabled, live: !!f.keys,
        why: f.resting ? `Windows' own while Mantle rests (${f.resting})` : (f.keysReason || ''), toggle: { kind: 'feature', feature: f.name } });
    }
  }
  if (sw && sw.ok) {
    out.push({ keys: 'Alt+Tab', what: 'Switch windows', owner: 'switcher', ownerLabel: "Mantle's window switcher", on: !!sw.altTab, live: !!sw.altTabLive, why: sw.altTabReason || '', toggle: { kind: 'switcher', key: 'altTab' } });
    out.push({ keys: 'Win+N', what: 'Notifications', owner: 'switcher', ownerLabel: "Mantle's panels", on: !!sw.winKeys, live: !!sw.winKeysLive, why: sw.winKeysReason || '', toggle: { kind: 'switcher', key: 'winKeys' } });
    out.push({ keys: 'Win+A', what: 'Quick settings', owner: 'switcher', ownerLabel: "Mantle's panels", on: !!sw.winKeys, live: !!sw.winKeysLive, why: sw.winKeysReason || '', toggle: { kind: 'switcher', key: 'winKeys' } });
  }
  return out;
}

/** A feature record as the page draws it (features.list minus what the page has no use for). PURE. */
function featureView(f) {
  return { name: f.name, label: f.label, enabled: !!f.enabled, ok: f.ok !== false, reason: f.reason || '', resting: f.resting || null,
    running: !!f.running, stopped: !!f.stopped, loaded: f.loaded !== false, chords: f.chords || [], keys: !!f.keys, keysReason: f.keysReason || '',
    broken: f.broken || null, options: f.options || [] };
}

/** The ms-settings catalog, each page marked with the section that covers it (or null). */
function catalog() {
  const LI = require('../launcher-index')._internals;
  return LI.SETTINGS.map(([name, uri, keywords]) => {
    const m = LI.MANTLE_SETTINGS[uri];
    return { name, uri, keywords: keywords || '', section: m ? m.section : null, row: m ? m.row : null };
  });
}

/** The running build's commit, read once (git, else .git/HEAD by hand); never throws. */
function readCommit(root) {
  return new Promise((resolve) => {
    cp.execFile('git', ['-C', root, 'rev-parse', '--short', 'HEAD'], { timeout: 3000, windowsHide: true }, (err, out) => {
      const c = String(out || '').trim();
      if (!err && /^[0-9a-f]{4,40}$/.test(c)) return resolve({ commit: c, reason: null });
      try {
        let dir = path.join(root, '.git');
        if (fs.statSync(dir).isFile()) dir = path.resolve(root, fs.readFileSync(dir, 'utf8').replace(/^gitdir:\s*/, '').trim());
        const head = fs.readFileSync(path.join(dir, 'HEAD'), 'utf8').trim();
        if (/^[0-9a-f]{40}$/.test(head)) return resolve({ commit: head.slice(0, 7), reason: null });
        return resolve({ commit: null, reason: `git could not say (${err ? err.code || words(err) : 'no output'}) and HEAD is ${head.startsWith('ref:') ? 'a branch name only' : 'unreadable'}` });
      } catch (e) {
        return resolve({ commit: null, reason: `this build is not a git checkout (${e.code || words(e)})` });
      }
    });
  });
}

function install(ctx, deps) {
  const d = deps || {};
  const electron = () => d.electron || require('electron');
  const test = !!(ctx.flags && ctx.flags.test);
  const live = !test;
  const root = path.join(__dirname, '..', '..');
  let win = null;
  let seq = 0;
  let nav = navFrom({ section: 'home' }, seq);
  let stopped = false;
  let changeTimer = null;
  let commit = null;                     // readCommit's answer, once
  const startedAt = Date.now() - Math.round(process.uptime() * 1000);

  ctx.health(true, HEALTHY);

  /* ---- the window ---- */

  function push(event, payload) { return win ? ctx.push(win, event, payload) : false; }

  function makeWindow() {
    const { BrowserWindow } = d.BrowserWindow ? { BrowserWindow: d.BrowserWindow } : electron();
    let icon;
    try { icon = d.icon !== undefined ? d.icon : require('../tray-icon').trayImage(); } catch (_) { icon = undefined; }
    const disp = ctx.host.display ? ctx.host.display() : null;
    const wa = disp && disp.workArea ? disp.workArea : { x: 0, y: 0, width: WIN_W, height: WIN_H };
    const width = Math.min(WIN_W, Math.max(MIN_W, wa.width - 48)), height = Math.min(WIN_H, Math.max(MIN_H, wa.height - 48));
    const w = new BrowserWindow({
      show: false, frame: false, transparent: false, skipTaskbar: false, hasShadow: true, focusable: true,
      resizable: true, movable: true, minimizable: true, maximizable: true, fullscreenable: false,
      width, height, minWidth: MIN_W, minHeight: MIN_H,
      x: Math.round(wa.x + (wa.width - width) / 2), y: Math.round(wa.y + (wa.height - height) / 2),
      title: TITLE, backgroundColor: '#F4F6FA', icon,
      webPreferences: { preload: ctx.preload, contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
    });
    const wc = w.webContents;
    wc.on('will-navigate', (e) => e.preventDefault());
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    // The page crashing is this window gone, not Mantle Settings broken: the next Win+I makes a new one.
    wc.on('render-process-gone', (_e, det) => {
      ctx.log(`the Settings page's renderer died (${det && det.reason}); the window is closed, Win+I opens a fresh one`);
      if (win === w) { win = null; try { w.destroy(); } catch (_) { /* gone */ } }
    });
    wc.on('did-fail-load', (_e, code, desc, _url, isMain) => {
      if (isMain === false || win !== w) return;
      ctx.health(false, `the Settings page did not load (${desc || code}), so Win+I is Windows' again`);
      win = null;
      try { w.destroy(); } catch (_) { /* gone */ }
    });
    wc.on('did-finish-load', () => { if (win === w) ctx.health(true, HEALTHY); });
    // Its own title, never the page's changing one: the bar and Alt+Tab match it exactly.
    w.on('page-title-updated', (e) => e.preventDefault());
    w.on('closed', () => { if (win === w) { win = null; ctx.log('closed (the window is destroyed, nothing kept in memory)'); } });
    w.once('ready-to-show', () => { if (live && win === w && !stopped) reveal(w); });
    w.loadFile(ctx.page('index.html'));
    return w;
  }

  function reveal(w) {
    try {
      if (w.isMinimized()) w.restore();
      w.show();
      w.focus();
    } catch (_) { return; }
    // Electron's focus() can lose to Windows' foreground lock after a swallowed chord; the sidecar
    // can hand it over (as the notes pad does).
    const t = setTimeout(async () => {
      if (win !== w || w.isDestroyed() || w.isFocused()) return;
      try {
        const buf = w.getNativeWindowHandle();
        const hwnd = buf.length >= 8 ? buf.readBigUInt64LE(0).toString() : String(buf.readUInt32LE(0));
        const r = await ctx.sidecar.send('focus', { hwnd });
        if (!r.ok) ctx.log(`the window could not take the keyboard (${r.error}); click in it to type`);
      } catch (e) { ctx.log(`the window could not take the keyboard (${words(e)}); click in it to type`); }
    }, 80);
    if (t.unref) t.unref();
  }

  /** Open (or bring back) the window at `a` {section, row, query}. -> {ok, reason, created}. Never throws. */
  function open(a, via) {
    if (stopped) return { ok: false, reason: 'Mantle Settings is stopped' };
    if (!ctx.enabled()) return { ok: false, reason: 'Mantle Settings is switched off (the tray menu, or Mantle Settings > Mantle)' };
    // Asked for a place: go there. Asked for nothing (Win+I): a new window starts at Home, an open
    // one just comes to the front where Owen left it.
    const n = navFrom(a, ++seq);
    const asked = !!(n.section || n.row || n.query);
    if (win && win.isDestroyed()) win = null;
    if (asked) nav = n;
    else if (!win) nav = navFrom({ section: 'home' }, n.seq);
    let created = false;
    try {
      if (!win) { win = makeWindow(); created = true; }
      else {
        if (asked) push('settings.nav', nav);
        if (live) reveal(win);
      }
    } catch (err) {
      win = null;
      ctx.log(`the window could not be made: ${words(err)}`);
      return { ok: false, reason: `the Settings window could not be made (${words(err)})` };
    }
    ctx.log(`opened by ${via || 'a page'}${nav.section ? ` at ${nav.section}` : ''}${created ? ' (new window)' : ''}${test ? ' (test: not shown)' : ''}`);
    return { ok: true, reason: null, created, shown: live };
  }

  ctx.onChord(CHORD, () => { open({}, CHORD); });
  ctx.onEnabled((on) => { if (!on && win) { try { win.destroy(); } catch (_) { /* gone */ } win = null; } });

  // The launcher: 'mantle-open' 'settings' {section, row, uri, via, reply} (lib/launcher-index.js).
  // `reply` is how the launcher knows it really opened (any listener makes app.emit return true).
  const onMantleOpen = (target, p) => {
    if (target !== 'settings') return;
    const r = open(p || {}, (p && p.via) || 'the launcher');
    if (p && p.reply && typeof p.reply === 'object') Object.assign(p.reply, { handled: true, ok: r.ok, reason: r.reason });
  };
  const app = (() => { try { return electron().app || null; } catch (_) { return null; } })();
  if (app && typeof app.on === 'function') app.on('mantle-open', onMantleOpen);

  // Redraw on any switch, option or health change, whoever made it (the tray, a card, a game).
  const hostF = ctx.host.features || null;
  if (hostF) hostF.onChange((e) => {
    if (!win || changeTimer) return;
    changeTimer = setTimeout(() => { changeTimer = null; push('settings.changed', { what: e && e.what }); }, CHANGE_MS);
    if (changeTimer.unref) changeTimer.unref();
  });

  /* ---- commands ---- */

  const dry = (what) => ({ ok: true, dryRun: true, reason: `test run: would have ${what}; nothing was changed` });
  const needF = () => { if (!hostF) throw new Error('this Mantle has no feature list to show (lib/features.js is older than Mantle Settings)'); return hostF; };
  const switcherView = () => {
    const sw = ctx.host.switcher;
    if (!sw) return { ok: false, reason: "Mantle's switcher settings are not reachable from here" };
    try { return sw.get(); } catch (e) { return { ok: false, reason: `Mantle's switcher settings could not be read (${words(e)})` }; }
  };

  ctx.command('open', async (a) => open(a, (a && typeof a.via === 'string' && a.via.slice(0, 60)) || 'a page'));
  ctx.command('hello', async () => Object.assign({ ok: true, test }, nav));

  ctx.command('mantle', async () => {
    const features = needF().list().map(featureView);
    const switcher = switcherView();
    return { ok: true, features, switcher, shortcuts: shortcutsOf(features, switcher) };
  });

  ctx.command('enable', async (a) => {
    const r = needF().setEnabled(String((a && a.feature) || ''), a && a.on);
    return { ok: !!r.ok, reason: r.reason || null, feature: r.feature ? featureView(r.feature) : null };
  });

  ctx.command('option', async (a) => {
    const r = needF().setOption(String((a && a.feature) || ''), String((a && a.key) || ''), a && a.value !== undefined ? a.value : undefined);
    return { ok: !!r.ok, reason: r.reason || null, option: r.option || null };
  });

  ctx.command('pickFolder', async (a) => {
    const feature = String((a && a.feature) || ''), key = String((a && a.key) || '');
    const f = needF().list().find((x) => x.name === feature);
    const opt = f && (f.options || []).find((o) => o.key === key && o.type === 'folder');
    if (!opt) return { ok: false, reason: `${f ? f.label : `"${feature}"`} has no folder option called "${key}"`, option: null };
    if (test) return { ok: false, reason: 'a test run never opens a folder dialog', option: opt, cancelled: false };
    if (!win) return { ok: false, reason: 'the Settings window is not open', option: opt };
    const { dialog } = d.dialog ? { dialog: d.dialog } : electron();
    let pick;
    try {
      pick = await dialog.showOpenDialog(win, { title: opt.label, properties: ['openDirectory', 'createDirectory'], defaultPath: typeof opt.value === 'string' ? opt.value : undefined });
    } catch (e) { return { ok: false, reason: `the folder dialog did not open (${words(e)})`, option: opt }; }
    if (!pick || pick.canceled || !pick.filePaths || !pick.filePaths[0]) return { ok: true, cancelled: true, reason: null, option: opt };
    const r = needF().setOption(feature, key, pick.filePaths[0]);
    return { ok: !!r.ok, reason: r.reason || null, option: r.option || opt, cancelled: false };
  });

  ctx.command('switcher', async (a) => {
    const sw = ctx.host.switcher;
    if (!sw) return { ok: false, reason: "Mantle's switcher settings are not reachable from here", switcher: null };
    const patch = {};
    for (const k of ['altTab', 'winKeys']) if (a && typeof a[k] === 'boolean') patch[k] = a[k];
    if (!Object.keys(patch).length) return { ok: false, reason: 'say altTab or winKeys, true or false', switcher: switcherView() };
    let now;
    try { now = sw.set(patch); } catch (e) { return { ok: false, reason: `it could not be changed (${words(e)})`, switcher: switcherView() }; }
    const moved = Object.keys(patch).every((k) => now && now[k] === patch[k]);
    return { ok: moved, reason: moved ? null : 'the switch did not move', switcher: now };
  });

  ctx.command('about', async () => {
    if (!commit) commit = await readCommit(root);
    let version = '?';
    try { version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version || '?'; } catch (_) { /* shown as ? */ }
    const logArg = process.argv.find((x) => typeof x === 'string' && x.startsWith('--log='));
    const logFile = logArg ? logArg.slice('--log='.length).replace(/^"|"$/g, '') : null;
    return {
      ok: true, version, commit: commit.commit, commitReason: commit.reason, startedAt, uptimeMs: Date.now() - startedAt,
      mode: test ? 'test' : 'live', logFile, logDir: logFile ? path.dirname(logFile) : null,
      logReason: logFile ? null : 'this run writes no log file (Mantle was started without --log=)',
      electron: process.versions.electron || null, chrome: process.versions.chrome || null, node: process.versions.node,
      windows: `${os.release()}`,
    };
  });

  ctx.command('openLogs', async () => {
    const logArg = process.argv.find((x) => typeof x === 'string' && x.startsWith('--log='));
    if (!logArg) return { ok: false, reason: 'this run writes no log file (Mantle was started without --log=)' };
    const dir = path.dirname(logArg.slice('--log='.length).replace(/^"|"$/g, ''));
    if (test) return dry('opened the log folder');
    const { shell } = d.shell ? { shell: d.shell } : electron();
    const err = await shell.openPath(dir);
    return err ? { ok: false, reason: `Windows would not open the log folder (${err})` } : { ok: true, reason: null };
  });

  ctx.command('openWindows', async (a) => {
    const uri = String((a && a.uri) || 'ms-settings:');
    if (!MS_RE.test(uri)) return { ok: false, reason: 'that is not a Windows Settings page (ms-settings:...)' };
    if (test) return dry(`opened Windows Settings at ${uri}`);
    const { shell } = d.shell ? { shell: d.shell } : electron();
    try { await shell.openExternal(uri); return { ok: true, reason: null }; } catch (e) { return { ok: false, reason: `Windows Settings did not open (${words(e)})` }; }
  });

  ctx.command('catalog', async () => {
    try { return { ok: true, items: catalog() }; } catch (e) { return { ok: false, reason: `the Windows Settings list could not be read (${words(e)})`, items: [] }; }
  });

  ctx.command('displays', async () => {
    let screen;
    try { screen = d.screen || electron().screen; } catch (e) { return { ok: false, reason: `the displays cannot be read here (${words(e)})`, displays: [] }; }
    try {
      const primary = screen.getPrimaryDisplay().id;
      const displays = screen.getAllDisplays().map((x, i) => ({
        label: x.label || `Display ${i + 1}`, primary: x.id === primary, internal: !!x.internal,
        width: Math.round(x.size.width * x.scaleFactor), height: Math.round(x.size.height * x.scaleFactor),
        scalePercent: Math.round(x.scaleFactor * 100), hz: x.displayFrequency ? Math.round(x.displayFrequency) : null, rotation: x.rotation || 0,
      }));
      return { ok: true, reason: null, displays };
    } catch (e) { return { ok: false, reason: `the displays could not be read (${words(e)})`, displays: [] }; }
  });

  // Startup apps (sidecar/Startup.cs). Its errors are name-free by contract, so they are passed on.
  const sidecarWords = (err, cmd) => (/unknown command|no command|not a command/i.test(String(err))
    ? `the sidecar exe has no ${cmd} command yet (build the sidecar: npm run build:sidecar)` : String(err || 'the sidecar did not answer'));
  ctx.command('startup', async () => {
    const r = await ctx.sidecar.send('startup.list', {}, { timeoutMs: 6000 });
    if (!r.ok) return { ok: false, reason: `the startup apps could not be read: ${sidecarWords(r.error, 'startup.list')}`, items: [], problems: [], elevated: false };
    const x = r.result || {};
    return { ok: x.ok !== false, reason: x.reason || null, elevated: !!x.elevated, items: Array.isArray(x.items) ? x.items : [], problems: Array.isArray(x.problems) ? x.problems : [] };
  });
  ctx.command('startupSet', async (a) => {
    const item = typeof (a && a.item) === 'string' ? a.item : '';
    if (!item) return { ok: false, reason: 'say which startup entry (item)' };
    if (typeof (a && a.on) !== 'boolean') return { ok: false, reason: 'on must be true or false' };
    // A test run is ALWAYS a dry run: it builds the bytes it would write and changes nothing.
    const r = await ctx.sidecar.send('startup.set', { item, on: a.on, dryRun: test }, { timeoutMs: 6000 });
    if (!r.ok) return { ok: false, reason: sidecarWords(r.error, 'startup.set') };
    const x = r.result || {};
    if (x.dryRun) return { ok: !x.wouldRefuse, dryRun: true, reason: x.wouldRefuse || `test run: nothing was changed (it would have ${x.wouldBe === 'enabled' ? 'turned it on' : 'turned it off'})`, item: x.item || null };
    ctx.log(`a startup entry was turned ${a.on ? 'on' : 'off'}`);
    return { ok: x.ok !== false, reason: x.reason || null, item: x.item || null };
  });

  ctx.command('window', async (a) => {
    const op = String((a && a.op) || '');
    if (!win || win.isDestroyed()) return { ok: false, reason: 'the Settings window is not open' };
    try {
      if (op === 'close') { win.close(); return { ok: true }; }
      if (op !== 'minimize' && op !== 'maximize') return { ok: false, reason: `"${op.slice(0, 20)}" is not minimize, maximize or close` };
      if (test) return dry(`${op === 'maximize' ? 'maximised' : 'minimised'} the Settings window`);
      if (op === 'minimize') { win.minimize(); return { ok: true, maximized: false }; }
      if (op === 'maximize') { if (win.isMaximized()) win.unmaximize(); else win.maximize(); return { ok: true, maximized: win.isMaximized() }; }
    } catch (e) { return { ok: false, reason: words(e) }; }
    return { ok: false, reason: `"${op.slice(0, 20)}" is not minimize, maximize or close` };
  });

  return {
    stop(why) {
      stopped = true;
      clearTimeout(changeTimer);
      if (app && typeof app.removeListener === 'function') app.removeListener('mantle-open', onMantleOpen);
      if (win) { try { win.destroy(); } catch (_) { /* gone */ } win = null; }
      ctx.log(`stopped (${why})`);
    },
    // for lib/features/settings.test.js
    _win: () => win,
    _nav: () => nav,
  };
}

module.exports = {
  name: 'settings',
  label: 'Mantle Settings (Win+I)',
  defaultOn: true,
  chords: [CHORD],
  rest: true,
  install: (ctx) => install(ctx),
  _test: { install, navFrom, shortcutsOf, featureView, catalog, readCommit, SECTIONS, WHAT, TITLE },
};
