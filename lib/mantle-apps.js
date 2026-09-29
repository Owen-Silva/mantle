'use strict';
/*
 * mantle-apps.js - Mantle's two APP windows as apps: Mantle Settings (Win+I, lib/features/settings.js)
 * and Mantle Task Manager (Ctrl+Shift+Esc, lib/features/taskmgr.js). Icons lane, 2026-09-28.
 *
 * Owen: "they need to have there own icons that replace windows icons not just be electron". Both
 * windows are electron.exe, so every surface that asks "which program is this?" got electron.exe's
 * icon, and the bar filed them under one electron.exe button. This module is the one place that
 * knows them, so the bar (main.js buildPinned), Alt+Tab (lib/switcher.js), the launcher
 * (lib/launcher-index.js) and the bar's pins agree:
 *   - WHICH window is one: its per-window AppUserModelID (the windows call
 *     win.setAppDetails({ appId: 'Mantle.Settings' | 'Mantle.TaskManager' }), which the sidecar
 *     reads per window), else electron.exe + the exact page title (main.js MANTLE_APP_TITLES,
 *     sidecar AltTab.cs MantleAppTitles).
 *   - ITS ICON: assets/icons/<name>.ico for the windows themselves, the PNGs for Mantle's pages
 *     (tools/make-icons.js renders both from the SVGs).
 *   - WHICH WINDOWS APP IT STANDS IN FOR: a pin or a launcher row for Windows' Settings or Task
 *     Manager opens Mantle's version with Mantle's icon, and Windows' own stays one click away
 *     ("Windows Settings" / "Windows Task Manager"). Off or resting = Windows' own, with the reason.
 */
const fs = require('fs');
const path = require('path');

const ICON_DIR = path.join(__dirname, '..', 'assets', 'icons');
const SYS32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');

/* Windows' Settings app: its AUMID (a Store pin has no shortcut, only this), its exe. */
const WIN_SETTINGS_AUMID = 'windows.immersivecontrolpanel_cw5n1h2txyewy!microsoft.windows.immersivecontrolpanel';
/* File Explorer's (its taskbar pin carries this AUMID; the shortcut itself has no file target). */
const WIN_EXPLORER_AUMID = 'microsoft.windows.explorer';
const base = (p) => (p ? path.basename(String(p)).toLowerCase() : '');

/*
 * ONE ENTRY PER APP WINDOW. A new one (a third window) is one entry here plus its title in main.js
 * MANTLE_APP_TITLES and sidecar AltTab.cs MantleAppTitles (so the window is listed at all) and its
 * drawing in assets/icons (tools/make-icons.js ICONS). Everything else keys on this table.
 *   feature        lib/features/<feature>.js, for availability()
 *   title          the page <title>, exact
 *   aumid          the setAppDetails appId the window carries
 *   icon           assets/icons/<icon>.ico / .png / png/<icon>-<n>.png
 *   windowsName    Windows' own app it replaces, as the secondary rows and menus name it
 *   windowsTarget  how to open Windows' own
 *   standsIn(pin)  true for a pin / shortcut of Windows' own app, which Mantle's then stands in
 *                  for (null: no pin is taken over)
 */
const APPS = {
  settings: {
    key: 'settings',
    feature: 'settings',                       // lib/features/settings.js
    title: 'Mantle Settings',                  // its page <title>
    aumid: 'Mantle.Settings',                  // setAppDetails appId
    icon: 'mantle-settings',
    windowsName: 'Windows Settings',
    windowsTarget: 'ms-settings:',
    standsIn: (p) => p.aumid === WIN_SETTINGS_AUMID || p.names.includes('systemsettings.exe') || /^ms-settings:/.test(p.target),
  },
  taskmgr: {
    key: 'taskmgr',
    feature: 'taskmgr',                        // lib/features/taskmgr.js
    title: 'Mantle Task Manager',
    aumid: 'Mantle.TaskManager',
    icon: 'mantle-taskmgr',
    windowsName: 'Windows Task Manager',
    windowsTarget: path.join(SYS32, 'Taskmgr.exe'),
    standsIn: (p) => p.names.includes('taskmgr.exe'),
  },
  /* lane files (2026-09-28): Mantle Files (Win+E). Its icon and its own bar entry come from this
     entry. Lane barfiles (2026-09-29), Owen: "it also takes super long to actaully open": the bar's
     File Explorer pin (Explorer's AUMID, or bare explorer.exe with no folder argument) now opens
     Mantle Files directly, the way Win+E does, instead of starting explorer.exe; a pin of
     explorer.exe WITH a folder argument is a folder shortcut and is left alone. */
  files: {
    key: 'files',
    feature: 'files',                          // lib/features/files.js
    title: 'Mantle Files',
    aumid: 'Mantle.Files',
    icon: 'mantle-files',
    windowsName: 'File Explorer',
    windowsTarget: path.join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe'),
    standsIn: (p) => p.aumid === WIN_EXPLORER_AUMID || (p.names.includes('explorer.exe') && !p.args),
  },
};
const KEYS = Object.keys(APPS);

function icoPath(key) { return APPS[key] ? path.join(ICON_DIR, APPS[key].icon + '.ico') : null; }
function pngPath(key, size) {
  if (!APPS[key]) return null;
  return size ? path.join(ICON_DIR, 'png', APPS[key].icon + '-' + size + '.png') : path.join(ICON_DIR, APPS[key].icon + '.png');
}

/* data: URLs, read once per file. A missing file is an answer with a reason, never a throw. */
const urlCache = new Map();
function iconOf(key, size = 32) {
  const file = pngPath(key, size);
  if (!file) return { icon: null, reason: 'no such Mantle app: ' + key };
  if (urlCache.has(file)) return urlCache.get(file);
  let got;
  try {
    got = { icon: 'data:image/png;base64,' + fs.readFileSync(file).toString('base64'), reason: null };
  } catch (err) {
    got = { icon: null, reason: 'Mantle\'s ' + APPS[key].title + ' icon is missing (' + path.basename(file) + ': ' + (err.code || err.message) + '; run node tools/make-icons.js)' };
  }
  urlCache.set(file, got);
  return got;
}
function iconUrl(key, size) { return iconOf(key, size).icon; }

/** A window from the sidecar ({ exe, title, aumid }) -> 'settings' | 'taskmgr' | null. */
function forWindow(w) {
  if (!w) return null;
  const aumid = w.aumid ? String(w.aumid).toLowerCase() : '';
  for (const k of KEYS) if (aumid && aumid === APPS[k].aumid.toLowerCase()) return k;
  if (w.exe && base(w.exe) !== 'electron.exe') return null;
  const title = String(w.title || '');
  for (const k of KEYS) if (title === APPS[k].title) return k;
  return null;
}

/** A title alone (the switcher's snapshot has no exe) -> key | null. Exact, like the sidecar. */
function forTitle(title) {
  for (const k of KEYS) if (String(title || '') === APPS[k].title) return k;
  return null;
}

/** A pin (lib/pinned.js record) or a shortcut's parse for Windows' own Settings / Task Manager -> key | null. */
function standInFor(pin) {
  if (!pin) return null;
  const p = {
    aumid: pin.aumid ? String(pin.aumid).toLowerCase() : '',
    names: [pin.exe, pin.target].map(base),
    target: String(pin.target || '').trim().toLowerCase(),
    args: String(pin.args || '').trim(),
  };
  for (const k of KEYS) if (typeof APPS[k].standsIn === 'function' && APPS[k].standsIn(p)) return k;
  return null;
}

/**
 * Can Mantle's version open right now? From lib/features.js list(): the feature is loaded, on,
 * not stopped, not resting, healthy. { ok, reason } where reason says why not, in words.
 */
function availability(key, list) {
  const a = APPS[key];
  if (!a) return { ok: false, reason: 'no such Mantle app: ' + key };
  const f = (Array.isArray(list) ? list : []).find((x) => x && x.name === a.feature);
  if (!f) return { ok: false, reason: a.title + ' is not loaded (lib/features/' + a.feature + '.js)' };
  if (f.loaded === false) return { ok: false, reason: a.title + ' did not load' + (f.reason ? ': ' + f.reason : '') };
  if (!f.enabled) return { ok: false, reason: a.title + ' is switched off in the tray' };
  if (f.resting) return { ok: false, reason: a.title + ' is resting while ' + (typeof f.resting === 'string' ? f.resting.replace(/^while /, '') : 'a game runs') };
  if (f.stopped) return { ok: false, reason: a.title + ' was stopped when Mantle put Windows back' };
  if (f.ok === false) return { ok: false, reason: a.title + ' is down: ' + (f.reason || 'it did not say why') };
  return { ok: true, reason: null };
}

/**
 * A PIN of one of Mantle's own apps (the bar's "Pin to taskbar" on a Mantle Files / Settings /
 * Task Manager window stores electron.exe plus the window's AUMID) -> its key | null. By AUMID
 * alone: electron.exe is every Mantle window's exe, and Owen's browser's too.
 */
function forPin(pin) {
  const aumid = pin && pin.aumid ? String(pin.aumid).toLowerCase() : '';
  if (!aumid) return null;
  for (const k of KEYS) if (aumid === APPS[k].aumid.toLowerCase()) return k;
  return null;
}

module.exports = { APPS, KEYS, WIN_SETTINGS_AUMID, WIN_EXPLORER_AUMID, ICON_DIR, forPin, icoPath, pngPath, iconOf, iconUrl, forWindow, forTitle, standInFor, availability };
