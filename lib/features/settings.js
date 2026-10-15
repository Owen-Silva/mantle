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
 * exact title "Mantle Settings" through). FAST COLD, NOTHING KEPT (lane settingsfast, 2026-10-15; Owen:
 * "no i dont want these open in the backround i need to save ram"): closing DESTROYS it (the old 3-minute
 * hidden keep caught 1 open in 16 for ~44 MB each time, so it is gone), and a cold open is fast instead
 * (SHOW_BY_MS below). Keep ready (lib/keep-ready.js, off by default) keeps ONE hidden window instead.
 * `rest: true` DESTROYS any window the moment a game runs (stop(), Win+I is Windows' again until the game
 * exits), as do switching it off, a crash and quitting. A hidden page stops its loops and its qs.watch
 * lease (ui/settings/settings.js sleep()), so a kept window costs memory, not CPU.
 *
 * WAYS IN: Win+I; the top bar's Mantle menu (topbar.settings runs Win+I's handler through
 * ctx.runChord); the launcher's "Mantle Settings" row and the Windows pages this window covers
 * (lib/launcher-index.js MANTLE_SETTINGS, through app 'mantle-open' 'settings' with a reply object);
 * any page through settings.open {section, row, query}.
 *
 * SECTION MODULES (lane settingsfx, contract in ui/settings/SECTIONS.md): Windows' categories are built
 * by other lanes as ui/settings/sections/<id>.js (page) + lib/features/_settings-sections/<id>.js
 * (main, optional). Main lists them (settings.sections), registers each main command as
 * settings.<id>.<name>, and gives it env (sidecar, log, a settings store, onRest, elevate, push). A module
 * that does not load is that section DOWN with its reason; the rest of Settings carries on.
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
const vm = require('vm');
const WW = require('./_wall-window.js');
const OT = require('./_open-timing.js');

const CHORD = 'Win+I';
const TITLE = 'Mantle Settings';               // sidecar AltTab.cs MantleAppTitles + main.js MANTLE_APP_TITLES
const WIN_W = 1040, WIN_H = 700, MIN_W = 760, MIN_H = 520;
const SECTIONS = ['home', 'display', 'sound', 'bluetooth', 'network', 'power', 'notifications', 'apps', 'mantle', 'shortcuts', 'about'];
const MS_RE = /^ms-settings:[a-z0-9-]*$/i;
const ROW_RE = /^[A-Za-z0-9_.+-]{1,80}$/;
/* Section modules (ui/settings/SECTIONS.md): a section id is its file name in ui/settings/sections/
   (the page half) and lib/features/_settings-sections/ (the main half, optional); a page id the same
   shape. = ui/settings/model.js SECTION_ID_RE. */
const SECTION_ID_RE = /^[a-z][a-z0-9-]{0,39}$/;
const CMD_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,59}$/;
const NO_ELEVATE = 'Mantle cannot ask for administrator rights yet';
const CHANGE_MS = 120;                          // many switches in one tick = one redraw
const HEALTHY = 'Win+I opens Mantle Settings';
/* Its OWN icon and app id (Owen: "they need to have there own icons that replace windows icons not just be
   electron"): the artwork is the icons lane's; Windows, the bar and Alt+Tab group the window by APP_ID. */
const ICON_FILE = 'assets/icons/mantle-settings.ico';
const APP_ID = 'Mantle.Settings';
/* --lg-ground in each theme (ui/shared/glass-light.css): a solid window's colour before its first paint */
const GROUND = { light: '#F4F6FA', dark: '#1B1C1F' };
/* OPENING FAST, COLD (lane settingsfast, 2026-10-15; Owen: "no i dont want these open in the backround i need
   to save ram"). No hidden window by default and no 3-minute keep: closing destroys the window and its memory
   goes back at once. A cold open shows the window at its first paint (the page draws Home from its own cache,
   ui/settings/settings.js), the dark wallpaper waits at most COLD_HOLD_MS, and a page that has not painted
   SHOW_BY_MS after the trigger is shown on its plain ground anyway. Keep ready (lib/keep-ready.js, off by
   default) makes ONE hidden window PREWARM_MS after start, once the CPU is calm, and keeps it until a game. */
const SHOW_BY_MS = 300;
const PREWARM_MS = 60 * 1000;                   // keep ready: after start (and after a game), once things settle
const PREWARM_ON_MS = 2000;                     // keep ready just turned on
const PREWARM_RETRY_MS = 30 * 1000;             // the CPU was busy: try again this much later
const PREWARM_BUSY = 0.6;                       // ... busy = over 60% of the whole CPU for a second
const PREWARM_TRIES = 6;                        // then make it anyway

/* GLASS like the taskbar (lane settingsfx2; Owen: "glass like the taskbar"): DWM's acrylic system backdrop
   behind a page whose big surfaces let it through (ui/settings/settings.css html.glass). DWM draws a system
   backdrop only on the ACTIVE window (sidecar/Glass.cs says why the bar cannot use it); this is a window
   Owen clicks into, so the page turns to the opaque --lg-ground while it is in the background.
   Windows' app mode tints the acrylic (dark Windows = dark glass), whatever Mantle's page is: the sidecar's
   taskmgr.frame sets THIS window's frame to MANTLE'S appearance, light or dark (lib/theme.js; never nativeTheme)
   and reads DWM's attributes back, so the page stays glass only when Windows really holds acrylic + a
   matching frame, and About says why when it does not. No CSS backdrop-filter anywhere (it cost a quarter
   of a core on the bar). */
const MATERIAL = 'acrylic';
const DWMSBT_TRANSIENTWINDOW = 3;       // DWMWA_SYSTEMBACKDROP_TYPE's value for acrylic
const MIN_BACKDROP_BUILD = 22621;       // Windows 11 22H2: the first with DWMWA_SYSTEMBACKDROP_TYPE
/** { material, why }: acrylic, or null and why not, from os.release() (`10.0.<build>`). */
function glassPlan(release) {
  if (process.platform !== 'win32') return { material: null, why: 'glass needs Windows 11, so the window is solid' };
  const build = Number(String(release || '').split('.')[2]) || 0;
  if (build < MIN_BACKDROP_BUILD) return { material: null, why: `this Windows (build ${build || 'unknown'}) has no system backdrop (it needs Windows 11 22H2 or later), so the window is solid` };
  return { material: MATERIAL, why: null };
}

/* What each chord Mantle can own does, for the Keyboard shortcuts page. */
const WHAT = {
  'Win+S': 'Search', 'Win+V': 'Clipboard history', 'Win+Tab': 'Task view',
  'Win+Left': 'Snap the window left', 'Win+Right': 'Snap the window right', 'Win+Up': 'Maximise or snap up',
  'Win+Down': 'Restore or minimise', 'Win+Z': 'Snap layouts', 'Win+Shift+S': 'Screenshot (pick an area)',
  PrintScreen: 'Screenshot', VolumeUp: 'Volume up (Mantle pop-up)', VolumeDown: 'Volume down (Mantle pop-up)',
  VolumeMute: 'Mute (Mantle pop-up)', 'Win+Alt+T': 'Hide or show the top bar', 'Win+Ctrl+T': 'Keep the window on top',
  'Win+Alt+N': 'Quick notes', 'Win+I': 'Mantle Settings', 'Ctrl+Shift+Esc': 'Task manager',
  // lane keysrun's chords (plan P5 + P9), labelled here so that lane never touches this file
  'Win+R': 'Run', 'Win+X': 'Quick links',
};

function words(e) { return e && e.message ? e.message : String(e); }
/** " at <file>:<line>" of a thrown error's first stack frame (the file's NAME only, never its path), or ''. */
function throwSite(e) {
  const m = e && typeof e.stack === 'string' ? /\n\s+at (?:[^\n]*?[\\/(])?([^\\/:()\s]+\.js):(\d+)/.exec(e.stack) : null;
  return m ? ` at ${m[1]}:${m[2]}` : '';
}

/** A navigation request from a chord, a menu, the launcher or a page. PURE but for `known(id)`, which
 *  says whether a section module of that id exists (built-in sections need no asking). */
function navFrom(a, seq, known) {
  const o = a && typeof a === 'object' ? a : {};
  const mod = typeof o.section === 'string' && SECTION_ID_RE.test(o.section) && typeof known === 'function' && known(o.section);
  return {
    section: SECTIONS.includes(o.section) || mod ? o.section : null,
    page: typeof o.page === 'string' && SECTION_ID_RE.test(o.page) ? o.page : null,
    row: typeof o.row === 'string' && ROW_RE.test(o.row) ? o.row : null,
    query: typeof o.query === 'string' ? o.query.slice(0, 100) : '',
    seq,
  };
}

/** The section module files in `dir` (`<id>.js`, not `_*.js`, not `*.test.js`), sorted. A missing
 *  folder is no modules; any other read error throws. */
function listSectionFiles(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  return names.filter((f) => f.endsWith('.js') && !f.startsWith('_') && !f.endsWith('.test.js')).sort();
}

/** Why a main-side section module cannot be used, or null. PURE. */
function checkMainSection(mod, id) {
  if (!mod || typeof mod !== 'object') return 'it exports nothing usable (module.exports = { id, commands, install? })';
  if (mod.id !== id) return `its id ${JSON.stringify(mod.id)} is not its file name "${id}"`;
  if (!mod.commands || typeof mod.commands !== 'object' || Array.isArray(mod.commands)) return 'commands must be an object of async (args, env) => result';
  for (const [name, fn] of Object.entries(mod.commands)) {
    if (!CMD_NAME_RE.test(name)) return `the command name ${JSON.stringify(name)} is not a plain word (letters, digits, _)`;
    if (typeof fn !== 'function') return `the command "${name}" is not a function`;
  }
  if (mod.install !== undefined && typeof mod.install !== 'function') return 'install must be a function (env) -> stop';
  return null;
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

/** The ms-settings catalog, each page marked with the section that covers it (or null): a built-in
 *  (MANTLE_SETTINGS) or a section module that claims it (lane wire: the launcher's coverOf, so the
 *  launcher and this search agree), with `page` for a module's subpage. */
function catalog() {
  const LI = require('../launcher-index')._internals;
  return LI.SETTINGS.map(([name, uri, keywords]) => {
    const m = LI.coverOf(uri);
    return { name, uri, keywords: keywords || '', section: m ? m.section : null, page: m ? m.page : null, row: m ? m.row : null };
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
  const timing = OT.create(ctx);
  const canShow = live || (test && OT.testShows(d.env));   // a --test copy shows only to time an open (invisible: lib/test-quiet.js)
  const root = path.join(__dirname, '..', '..');
  let win = null;
  let seq = 0;
  let nav = navFrom({ section: 'home' }, seq);
  let stopped = false;
  const pageDir = d.pageSectionsDir || path.join(root, 'ui', 'settings', 'sections');
  const mainDir = d.mainSectionsDir || path.join(__dirname, '_settings-sections');
  /* --test ONLY: MANTLE_SETTINGS_FIXTURES=1 also lists the mock's fixture pages (ui/settings/test-sections:
     one throws while loading, one has the wrong id), so a real-Electron run proves the DOWN path without
     a file in sections/, which is the category lanes'. Never read in a live Mantle. */
  const fixDir = d.fixturesDir !== undefined ? d.fixturesDir
    : test && process.env.MANTLE_SETTINGS_FIXTURES === '1' ? path.join(root, 'ui', 'settings', 'test-sections') : null;
  const secs = new Map();                // main-side section modules: id -> { ok, reason, commands, stops, offs }
  let mainProblem = null;                // the main-side folder could not be read
  const known = (id) => secs.has(id) || fs.existsSync(path.join(pageDir, `${id}.js`));
  let changeTimer = null;
  let warm = false, quitting = false;     // warm = a hidden window kept ready (keep ready on), never a timed keep
  let showFor = null;                     // the window an open is waiting to show (its first paint, the hold)
  let prewarmTimer = null, prewarmTries = 0;
  const KR = d.keepReady || require('../keep-ready.js');
  const keepOn = () => { try { return KR.get('settings') === true; } catch (_) { return false; } };
  // glass: the plan at make time, then DWM's read-back once the sidecar has answered (lightFrame)
  let glass = { material: null, ok: null, why: null, backdrop: null, dark: null };
  let frameSeq = 0;
  /* lane dm-core (2026-10-08): Mantle's appearance (ctx.host.theme; 'light' where a host has none). The
     frame follows it (lightFrame) and so does the solid window's ground, LIVE: no reload, no restart. */
  const themeNow = () => (ctx.host && ctx.host.theme ? ctx.host.theme.get() : 'light');
  if (ctx.host && ctx.host.theme && typeof ctx.host.theme.onChange === 'function') {
    ctx.host.theme.onChange((t) => {
      if (!win || win.isDestroyed()) return;
      if (!glass.material) { try { win.setBackgroundColor(GROUND[t] || GROUND.light); } catch (_) { /* gone */ } }
      lightFrame(win);
    });
  }
  /* lane helm-wall-apps (2026-10-09): in DARK the window is opaque (no acrylic) and the page paints the desktop
     wallpaper under its tint, as Helm does (lib/features/_wall-window.js, ui/shared/wall-bdrop.js). Light is the
     window glassPlan() made, exactly; a Windows with no system backdrop keeps its solid window in both. */
  const plan0 = glassPlan(d.osRelease !== undefined ? d.osRelease : os.release());
  const wall = WW.feed(ctx, { event: 'settings.wall', pos: 'settings.wallpos', light: plan0.material ? { material: plan0.material, color: '#00000000' } : null });
  let commit = null;                     // readCommit's answer, once
  const problems = new Map();            // key -> words: what needs a look (Home's list), each logged once
  function note(key, why) {
    if (!why) { problems.delete(key); return; }
    if (problems.get(key) !== why) ctx.log(why);
    problems.set(key, why);
  }
  /** The icon file, or null (and why) when it is missing: the window still opens, with the tray icon. */
  function iconFor() {
    const p = d.iconPath !== undefined ? d.iconPath : path.join(root, ICON_FILE);
    let ok = false;
    try { ok = !!p && fs.statSync(p).isFile(); } catch (_) { ok = false; }
    note('icon', ok ? null : `its own icon (${ICON_FILE}) is missing, so the window shows Mantle's tray icon`);
    return ok ? p : null;
  }
  const startedAt = Date.now() - Math.round(process.uptime() * 1000);

  ctx.health(true, HEALTHY);

  /* ---- the window ---- */

  function push(event, payload) { return win ? ctx.push(win, event, payload) : false; }

  function makeWindow() {
    const { BrowserWindow } = d.BrowserWindow ? { BrowserWindow: d.BrowserWindow } : electron();
    const iconPath = iconFor();
    let icon;
    try { icon = d.icon !== undefined ? d.icon : iconPath || require('../tray-icon').trayImage(); } catch (_) { icon = undefined; }
    const disp = ctx.host.display ? ctx.host.display() : null;
    const wa = disp && disp.workArea ? disp.workArea : { x: 0, y: 0, width: WIN_W, height: WIN_H };
    const width = Math.min(WIN_W, Math.max(MIN_W, wa.width - 48)), height = Math.min(WIN_H, Math.max(MIN_H, wa.height - 48));
    const plan = glassPlan(d.osRelease !== undefined ? d.osRelease : os.release());
    glass = { material: plan.material, ok: plan.material ? null : false, why: plan.why, backdrop: null, dark: null };
    if (plan.why) ctx.log(`glass: ${plan.why}`);
    const w = new BrowserWindow(Object.assign({
      show: false, frame: false, transparent: false, skipTaskbar: false, hasShadow: true, focusable: true,
      resizable: true, movable: true, minimizable: true, maximizable: true, fullscreenable: false,
      width, height, minWidth: MIN_W, minHeight: MIN_H,
      x: Math.round(wa.x + (wa.width - width) / 2), y: Math.round(wa.y + (wa.height - height) / 2),
      // glass: a fully clear window colour so DWM's backdrop is what shows where the page is clear
      title: TITLE, backgroundColor: plan.material ? '#00000000' : (GROUND[themeNow()] || GROUND.light), icon,
      webPreferences: { preload: ctx.preload, contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
    }, plan.material ? { backgroundMaterial: plan.material } : {}));
    wall.attach(w);
    try {
      w.setAppDetails(Object.assign({ appId: APP_ID, relaunchDisplayName: TITLE }, iconPath ? { appIconPath: iconPath, appIconIndex: 0 } : {}));
    } catch (e) { note('appid', `Windows would not take its own app id (${words(e)}), so the bar may group it with Electron`); }
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
    // Closing really closes it (its memory goes back at once), unless keep ready is on: then it HIDES, kept
    // for the next open with no time limit (a game still destroys it). Mantle stopping or quitting, or the
    // feature switched off, always really closes.
    w.on('close', (e) => {
      if (win !== w || stopped || quitting || !ctx.enabled() || !keepOn()) return;
      e.preventDefault();
      try { w.hide(); } catch (_) { return; }
      warm = true; showFor = null;
      ctx.log('closed: kept hidden for the next open (keep ready is on)');
    });
    w.on('closed', () => { if (win === w) { win = null; warm = false; showFor = null; ctx.log('closed (the window is destroyed, nothing kept in memory)'); } });
    w.once('ready-to-show', () => {
      w.__painted = true;
      if (win !== w || stopped || showFor !== w) return;     // made ahead (keep ready): it stays hidden
      if (!canShow) { showFor = null; timing.testReady(); return; }
      // dark: the wallpaper picture gets at most COLD_HOLD_MS, else the window shows solid and it swaps in
      wall.hold(w, () => { if (win === w && !stopped && showFor === w) { showFor = null; reveal(w); } }, WW.COLD_HOLD_MS);
    });
    // the light frame on every show (the task manager's pattern) and once now: a --test window is never shown
    w.on('show', () => { lightFrame(w); timing.shown(w); });
    // The page knows it is glass before its first paint (no clear-then-solid flash); DWM's read-back follows.
    w.loadFile(ctx.page('index.html'), plan.material ? { query: { glass: plan.material } } : undefined);
    lightFrame(w);
    return w;
  }

  /** The frame in Mantle's appearance (light or dark) + DWM's own read-back of it (sidecar/TaskMgr.cs
   *  taskmgr.frame, shared with the task manager; it refuses any window that is not this Electron's). The
   *  page is glass only when Windows reads back acrylic AND the frame it was asked for; otherwise it is
   *  solid and About says why. */
  async function lightFrame(w) {
    // lane dm-core (2026-10-08): the frame follows Mantle's appearance: light under a light page, dark
    // under a dark one (DWM tints the acrylic by it), and the read-back must match what was asked.
    const want = themeNow() === 'dark' ? 'dark' : 'light';
    const other = want === 'dark' ? 'light' : 'dark';
    const mine = ++frameSeq;           // a theme switch mid-call: only the newest ask may decide
    if (!glass.material || !w || w.isDestroyed() || typeof w.getNativeWindowHandle !== 'function') return;
    let hwnd;
    try {
      const buf = w.getNativeWindowHandle();
      hwnd = buf.length >= 8 ? Number(buf.readBigUInt64LE(0)) : buf.readUInt32LE(0);
    } catch (e) { setGlass(w, false, `its window handle could not be read (${words(e)}), so the window is solid`); return; }
    // LIGHT ACRYLIC CALL SITE (the pattern of lib/features/taskmgr.js)
    // taskmgr.frame runs on the sidecar's Slow lane: measured, it did not answer within 3 s while a
    // test Mantle was still starting, so it gets longer and one more try before the window is solid.
    let r = await ctx.sidecar.send('taskmgr.frame', { hwnd, light: want === 'light' }, { timeoutMs: 6000 });
    if (!r.ok && /did not answer|not running|restarting/.test(String(r.error)) && win === w && !w.isDestroyed()) {
      r = await ctx.sidecar.send('taskmgr.frame', { hwnd, light: want === 'light' }, { timeoutMs: 6000 });
    }
    if (win !== w || w.isDestroyed() || mine !== frameSeq) return;
    const res = r.ok && r.result ? r.result : {};
    if (!r.ok) setGlass(w, false, `the ${want} frame could not be set (${r.error}), so the window is solid instead of ${want} glass`);
    // dark: the window is OPAQUE and the page paints the wallpaper (lane helm-wall-apps); DWM must hold NO acrylic
    else if (want === 'dark') setGlass(w, res.backdrop !== DWMSBT_TRANSIENTWINDOW, res.backdrop === DWMSBT_TRANSIENTWINDOW ? 'Windows kept the acrylic backdrop under the dark window (it was asked for none); the page still paints over it' : null, res);
    else if (res.backdrop !== DWMSBT_TRANSIENTWINDOW) setGlass(w, false, `Windows did not take the acrylic backdrop (it reads back ${res.backdrop === -1 || res.backdrop == null ? 'nothing' : res.backdrop}), so the window is solid`, res);
    else if (res.dark !== (want === 'dark' ? 1 : 0)) setGlass(w, false, `Windows kept the frame ${other} (it reads back ${res.dark}), so the window is solid instead of ${want} glass`, res);
    else setGlass(w, true, null, res);
  }
  function setGlass(w, ok, why, res) {
    if (why && why !== glass.why) ctx.log(`glass: ${why}`);
    glass = { material: glass.material, ok, why, backdrop: res ? res.backdrop : null, dark: res ? res.dark : null };
    if (win === w) push('settings.glass', glass);
  }

  function reveal(w) {
    try {
      if (w.isMinimized()) w.restore();
      w.show();
      w.focus();
    } catch (_) { return; }
    if (!live) return;                   // a test copy never takes the keyboard
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
    const n = navFrom(a, ++seq, known);
    const asked = !!(n.section || n.page || n.row || n.query);
    if (win && win.isDestroyed()) win = null;
    // A warm (closed, hidden) window opens like a new one: at Home unless asked for a place.
    const wasWarm = !!(win && warm);
    if (asked) nav = n;
    else if (!win || wasWarm) nav = navFrom({ section: 'home' }, n.seq);
    let created = false;
    try {
      const where = nav.section ? ` at ${nav.section}` : '';
      if (!win) {
        timing.start('cold', via, where);
        win = makeWindow();
        created = true;
        showWhenPainted(win);
      } else if (wasWarm) {
        // kept ready: shown at once if its page has painted, else at its first paint (made ahead, still loading)
        warm = false;
        push('settings.nav', nav);
        timing.start('warm', via, win.__painted ? where : `${where} (still loading)`);
        if (!win.__painted) showWhenPainted(win);
        else if (canShow) reveal(win);
        else timing.testReady();
      } else if (showFor !== win) {            // open already: to the front (a cold one still loading shows when painted)
        if (asked) push('settings.nav', nav);
        if (canShow) reveal(win);
      } else if (asked) push('settings.nav', nav);
    } catch (err) {
      win = null;
      ctx.log(`the window could not be made: ${words(err)}`);
      return { ok: false, reason: `the Settings window could not be made (${words(err)})` };
    }
    if (!created && !wasWarm) ctx.log(`brought to the front via ${via || 'a page'}${nav.section ? ` at ${nav.section}` : ''}`);
    return { ok: true, reason: null, created, warm: wasWarm, shown: canShow };
  }
  /* Show `w` at its first paint (ready-to-show, then at most COLD_HOLD_MS for the dark wallpaper). A page that
     has not painted SHOW_BY_MS after the trigger (a loaded machine) is shown on its plain ground anyway: the
     window is there at once and the page fills in (R9: never an open that seems to do nothing). */
  function showWhenPainted(w) {
    showFor = w;
    if (!canShow) return;
    const by = d.showByMs || SHOW_BY_MS;
    const t = setTimeout(() => {
      if (showFor !== w || win !== w || stopped || w.isDestroyed()) return;
      showFor = null;
      ctx.log(`its page had not drawn ${by} ms after the open, so the window shows on its plain ground and the page fills in`);
      reveal(w);
    }, by);
    if (t.unref) t.unref();
  }

  /* KEEP READY (lib/keep-ready.js 'settings', off by default): ONE hidden window, made PREWARM_MS after
     start (install() runs again after a game, so after a game too) once the CPU is calm, kept until a game
     (rest: true destroys it), switched off, or the switch goes off. Its page sleeps while hidden. */
  function cpuBusy(ms) {
    if (d.cpuBusy) return Promise.resolve(d.cpuBusy());
    const t = () => os.cpus().reduce((a, c) => { const v = c.times; a.idle += v.idle; a.all += v.user + v.nice + v.sys + v.idle + v.irq; return a; }, { idle: 0, all: 0 });
    const a = t();
    return new Promise((res) => { const tm = setTimeout(() => { const b = t(); res(b.all > a.all ? 1 - (b.idle - a.idle) / (b.all - a.all) : 0); }, ms); if (tm.unref) tm.unref(); });
  }
  function prewarmSoon(ms) {
    clearTimeout(prewarmTimer);
    prewarmTimer = null;
    if (stopped || !keepOn() || !ctx.enabled() || win) return;
    prewarmTimer = setTimeout(async () => {
      prewarmTimer = null;
      if (stopped || !keepOn() || !ctx.enabled() || win) return;
      const busy = await cpuBusy(1000);
      if (stopped || !keepOn() || !ctx.enabled() || win) return;
      if (busy > PREWARM_BUSY && prewarmTries < PREWARM_TRIES) { prewarmTries++; prewarmSoon(d.prewarmRetryMs || PREWARM_RETRY_MS); return; }
      prewarmTries = 0;
      try {
        win = makeWindow();
        warm = true;
        showFor = null;
        ctx.log(`made ahead and kept hidden: keep ready is on (about ${KR.SURFACES ? KR.SURFACES.settings.mb : 45} MB while it waits)`);
      } catch (e) {
        win = null; warm = false;
        ctx.log(`the window could not be made ahead (${words(e)}); Win+I makes one when asked`);
      }
    }, ms);
    if (prewarmTimer.unref) prewarmTimer.unref();
  }
  const offKeep = KR.onChange((s, on) => {
    if (s !== 'settings' || stopped) return;
    if (on) { prewarmTries = 0; prewarmSoon(d.prewarmOnMs !== undefined ? d.prewarmOnMs : PREWARM_ON_MS); return; }
    clearTimeout(prewarmTimer); prewarmTimer = null;
    if (win && warm) {                     // hidden and kept: let it go now
      const w = win; win = null; warm = false;
      try { w.destroy(); } catch (_) { /* gone */ }
      ctx.log('keep ready turned off: the hidden window is let go');
    }
  });
  prewarmSoon(d.prewarmMs !== undefined ? d.prewarmMs : PREWARM_MS);

  ctx.onChord(CHORD, () => { open({}, CHORD); });
  ctx.onEnabled((on) => {
    if (!on && win) { try { win.destroy(); } catch (_) { /* gone */ } win = null; }
    if (on) prewarmSoon(d.prewarmOnMs !== undefined ? d.prewarmOnMs : PREWARM_ON_MS);
  });

  // The launcher: 'mantle-open' 'settings' {section, row, uri, via, reply} (lib/launcher-index.js).
  // `reply` is how the launcher knows it really opened (any listener makes app.emit return true).
  const onMantleOpen = (target, p) => {
    if (target !== 'settings') return;
    const r = open(p || {}, (p && p.via) || 'the launcher');
    if (p && p.reply && typeof p.reply === 'object') Object.assign(p.reply, { handled: true, ok: r.ok, reason: r.reason });
  };
  const app = (() => { try { return electron().app || null; } catch (_) { return null; } })();
  if (app && typeof app.on === 'function') app.on('mantle-open', onMantleOpen);
  // quitting: the warm window must really close, or it would hold Electron's quit up
  const onQuit = () => { quitting = true; };
  if (app && typeof app.on === 'function') app.on('before-quit', onQuit);

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
  // wall: the dark wallpaper picture's main side (what, why, move pushes and their cost; never the picture)
  ctx.command('hello', async () => Object.assign({ ok: true, test, glass, wall: wall.state() }, nav));
  // the page's glass state on subscribe (DWM's read-back can land before the page listens)
  if (typeof ctx.replay === 'function') ctx.replay('settings.glass', () => glass);

  /* ---- section modules (ui/settings/SECTIONS.md) ----
     The MAIN half: every lib/features/_settings-sections/<id>.js exporting { id, commands, install? }.
     Each command is registered as settings.<id>.<name> (a page calls it through kit.call). A module
     that does not load, has the wrong shape or throws in install() is that section DOWN with its
     reason (the page shows it in the sidebar); the rest of Settings carries on. */
  async function elevate(id, action, args) {
    let E;
    try {
      if (d.elevate !== undefined) E = d.elevate;
      else {
        try { require.resolve('../elevate'); } catch (_) { return { ok: false, reason: NO_ELEVATE }; }
        E = require('../elevate');
      }
    } catch (e) { return { ok: false, reason: `Mantle's administrator helper did not load (${words(e)})` }; }
    const fn = typeof E === 'function' ? E : E && typeof E.elevate === 'function' ? E.elevate : null;
    if (!fn) return { ok: false, reason: NO_ELEVATE };
    try {
      // the Settings window owns the UAC prompt, so it comes to the front (sidecar/ELEVATE.md)
      const r = await fn(String(action || ''), args === undefined ? {} : args,
        { test, via: `settings.${id}`, sidecar: ctx.sidecar, log: (t) => ctx.log(t), owner: win && !win.isDestroyed() ? win : undefined });
      return r && typeof r === 'object' ? r : { ok: false, reason: 'the administrator helper answered with nothing' };
    } catch (e) { return { ok: false, reason: `the administrator request did not go through (${words(e)})` }; }
  }
  function sectionEnv(id, rec) {
    const store = `sections.${id}`;
    return Object.freeze({
      id, test,
      sidecar: ctx.sidecar,
      log: (text) => ctx.log(`section ${id}: ${text}`),
      settings: Object.freeze({
        get(key, dflt) { const all = ctx.settings ? ctx.settings.get(store, {}) : {}; return all && Object.prototype.hasOwnProperty.call(all, key) ? all[key] : dflt; },
        set(key, value) {
          if (!ctx.settings) throw new Error('this Mantle has no settings store for sections');
          const all = Object.assign({}, ctx.settings.get(store, {}) || {});
          all[key] = value;
          ctx.settings.set(store, all);
          return value;
        },
      }),
      onRest(fn) {
        if (typeof fn !== 'function') throw new Error(`section ${id}: onRest needs a function`);
        const off = typeof ctx.onRest === 'function' ? ctx.onRest(fn) : () => {};
        rec.offs.push(off);
        return off;
      },
      elevate: (action, args) => elevate(id, action, args),
      push(event, payload) {
        if (typeof event !== 'string' || !event.startsWith(`settings.${id}.`)) throw new Error(`section ${id}: push events must start with "settings.${id}."`);
        return push(event, payload);
      },
    });
  }
  function loadMainSections() {
    let files = [];
    try { files = listSectionFiles(mainDir); } catch (e) {
      mainProblem = `the main-side section folder could not be read (${e.code || words(e)})`;
      ctx.log(mainProblem);
    }
    for (const file of files) {
      const id = file.slice(0, -3);
      const rec = { ok: false, reason: null, commands: [], stops: [], offs: [] };
      secs.set(id, rec);
      const down = (why) => { rec.reason = why; ctx.log(`section ${id} is DOWN: ${why}`); };
      if (!SECTION_ID_RE.test(id)) { down('its file name is not a section id (lower-case letters, digits and -, starting with a letter)'); continue; }
      if (SECTIONS.includes(id)) { down(`"${id}" is a built-in section's id; take it over with replaces under a new id`); continue; }
      let mod;
      try { mod = (d.requireSection || require)(path.join(mainDir, file)); } catch (e) { down(`lib/features/_settings-sections/${file} did not load (${words(e)})`); continue; }
      const bad = checkMainSection(mod, id);
      if (bad) { down(bad); continue; }
      const env = sectionEnv(id, rec);
      if (mod.install) {
        let st;
        try { st = mod.install(env); } catch (e) { down(`its install() threw (${words(e)})`); continue; }
        if (st && typeof st.then === 'function') {
          st.then((v) => { if (typeof v === 'function') rec.stops.push(v); }, (e) => { rec.ok = false; down(`its install() failed (${words(e)})`); });
        } else if (typeof st === 'function') rec.stops.push(st);
        else if (st && typeof st.stop === 'function') rec.stops.push(() => st.stop());
      }
      for (const [name, fn] of Object.entries(mod.commands)) {
        rec.commands.push(ctx.command(`${id}.${name}`, async (args) => {
          if (!rec.ok) return { ok: false, reason: `the ${id} section is down (${rec.reason})` };
          try { return await fn(args && typeof args === 'object' ? args : {}, env); } catch (e) {
            // logged (never silent), but only the error's kind and where it was thrown: its message
            // can carry a device name or a path, and those never reach mantle.log
            ctx.log(`section ${id}: command ${name} threw ${(e && e.name) || typeof e}${throwSite(e)}`);
            return { ok: false, reason: `${id}.${name} failed (${words(e)})` };
          }
        }));
      }
      rec.ok = true;
    }
  }
  /** settings.sections: what the page loads. Each page file is compiled (never run) here, so a syntax
   *  error is named with its line instead of a bare "Script error." in the page. */
  function sectionsList() {
    let files = [], problem = null;
    try { files = listSectionFiles(pageDir); } catch (e) { problem = `the section pages folder could not be read (${e.code || words(e)})`; }
    const pageIds = files.map((f) => f.slice(0, -3));
    const ids = [...new Set([...pageIds, ...secs.keys()])].sort();
    const sections = ids.map((id) => {
      const rec = secs.get(id) || null, hasPage = pageIds.includes(id);
      let down = null;
      if (!SECTION_ID_RE.test(id)) down = 'its file name is not a section id (lower-case letters, digits and -, starting with a letter)';
      else if (SECTIONS.includes(id)) down = `"${id}" is a built-in section's id; take it over with replaces under a new id`;
      else if (rec && !rec.ok) down = rec.reason;
      else if (!hasPage) down = `it has main-side commands but no page (ui/settings/sections/${id}.js)`;
      else {
        try { new vm.Script(fs.readFileSync(path.join(pageDir, `${id}.js`), 'utf8'), { filename: `sections/${id}.js` }); }
        catch (e) { down = `sections/${id}.js does not compile (${words(e)}${e.stack && /:(\d+)\n/.test(e.stack) ? `, line ${e.stack.match(/:(\d+)\n/)[1]}` : ''})`; }
      }
      return { id, file: hasPage && !down ? `sections/${id}.js` : null, down,
        main: rec ? { ok: rec.ok, reason: rec.reason, commands: rec.commands.slice() } : null };
    });
    if (fixDir) {
      let fx = [];
      try { fx = listSectionFiles(fixDir); } catch (e) { problem = problem || `the test fixtures folder could not be read (${e.code || words(e)})`; }
      for (const f of fx) {
        const id = f.slice(0, -3);
        if (ids.includes(id)) continue;
        let down = null;
        try { new vm.Script(fs.readFileSync(path.join(fixDir, f), 'utf8'), { filename: `test-sections/${f}` }); } catch (e) { down = `test-sections/${f} does not compile (${words(e)})`; }
        sections.push({ id, file: down ? null : `test-sections/${f}`, down, main: null, fixture: true });
      }
    }
    return { ok: !problem && !mainProblem, reason: problem || mainProblem, sections };
  }
  loadMainSections();
  ctx.command('sections', async () => sectionsList());

  // A folder picker for any section (kit.folder); the feature options keep pickFolder.
  ctx.command('pickPath', async (a) => {
    const title = typeof (a && a.title) === 'string' && a.title.trim() ? a.title.slice(0, 100) : 'Choose a folder';
    if (test) return { ok: false, reason: 'a test run never opens a folder dialog', path: null, cancelled: false };
    if (!win) return { ok: false, reason: 'the Settings window is not open', path: null, cancelled: false };
    const { dialog } = d.dialog ? { dialog: d.dialog } : electron();
    let pick;
    try {
      pick = await dialog.showOpenDialog(win, { title, properties: ['openDirectory', 'createDirectory'], defaultPath: typeof (a && a.defaultPath) === 'string' ? a.defaultPath : undefined });
    } catch (e) { return { ok: false, reason: `the folder dialog did not open (${words(e)})`, path: null, cancelled: false }; }
    if (!pick || pick.canceled || !pick.filePaths || !pick.filePaths[0]) return { ok: true, cancelled: true, reason: null, path: null };
    return { ok: true, cancelled: false, reason: null, path: pick.filePaths[0] };
  });

  ctx.command('mantle', async () => {
    const features = needF().list().map(featureView);
    const switcher = switcherView();
    return { ok: true, features, switcher, shortcuts: shortcutsOf(features, switcher), problems: [...problems.values()], keepReady: keepView() };
  });

  /* Keep ready in the background (lib/keep-ready.js): the rows, and one switch {surface, on}. */
  function keepView() {
    try { return KR.view(); } catch (e) { return { ok: false, reason: `the keep-ready switches could not be read (${words(e)})`, rows: [] }; }
  }
  ctx.command('keepReady', async (a) => {
    if (a && typeof a.surface === 'string') {
      const r = KR.set(a.surface, a.on === true);
      return Object.assign({ ok: !!r.ok, reason: r.reason || null, on: !!r.on }, { keepReady: keepView() });
    }
    return keepView();
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
      glass,
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
      wall.stop();
      clearTimeout(changeTimer);
      if (app && typeof app.removeListener === 'function') { app.removeListener('mantle-open', onMantleOpen); app.removeListener('before-quit', onQuit); }
      clearTimeout(prewarmTimer);
      try { offKeep(); } catch (_) { /* gone */ }
      if (win) { try { win.destroy(); } catch (_) { /* gone */ } win = null; }
      for (const [id, rec] of secs) {
        for (const off of rec.offs.splice(0)) { try { off(); } catch (_) { /* gone */ } }
        for (const st of rec.stops.splice(0)) { try { st(why); } catch (e) { ctx.log(`section ${id}: its stop threw (${words(e)})`); } }
      }
      ctx.log(`stopped (${why})`);
    },
    // for lib/features/settings.test.js
    _win: () => win,
    _nav: () => nav,
    _glass: () => glass,
    _warm: () => warm,
  };
}

module.exports = {
  name: 'settings',
  label: 'Mantle Settings (Win+I)',
  defaultOn: true,
  chords: [CHORD],
  rest: true,
  install: (ctx) => install(ctx),
  _test: { ICON_FILE, APP_ID, install, navFrom, shortcutsOf, featureView, catalog, readCommit, listSectionFiles, checkMainSection, glassPlan, SHOW_BY_MS, PREWARM_MS, SECTIONS, WHAT, TITLE, NO_ELEVATE },
};
