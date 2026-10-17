'use strict';
/* launcher-index.js — what the launcher can open, and how it opens it.
 *
 * WHY this is a plain CommonJS module and not part of main.js: the index is the
 * one piece of the launcher with real logic (walking the Start Menu, parsing a
 * PowerShell profile, ranking), so it has to be runnable and testable WITHOUT
 * Electron — `node lib/launcher-index.test.js` builds the real index on this
 * machine in about a second. Electron is therefore optional here: we require it
 * inside a try and only use it when it actually looks like the Electron runtime
 * (in plain node the `electron` npm package resolves to a STRING, the path of
 * electron.exe, so `electron.shell` is undefined — hence the typeof guards).
 *
 * The other rule shaping this file: nothing may fail silently. Every source
 * returns a { status, reason } the launcher prints in its footer, so "no
 * commands" always comes with the reason ("no PowerShell profile found at …")
 * instead of an empty list the user has to guess about.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const QUARTZ = require('./quartz-exe');
const crypto = require('crypto');
const cp = require('child_process');
const vm = require('vm');
const iconFresh = require('./icon-fresh');

/* ---- optional Electron -------------------------------------------------
 * The version check comes FIRST and is not optional: under plain node the
 * `electron` npm package's index.js SPAWNS ITS INSTALLER when the binary is
 * missing ("Downloading Electron binary…"), so a bare require() here would
 * turn `node lib/launcher-index.test.js` into a 200 MB download. Inside
 * Electron, process.versions.electron is set and the require is free. */
let electron = null;
if (process.versions && process.versions.electron) {
  try { electron = require('electron'); } catch (_) { electron = null; }
}
/* Only a real Electron main process has shell.openPath. */
const shell = (electron && electron.shell && typeof electron.shell.openPath === 'function')
  ? electron.shell
  : null;

/* ---- small helpers ------------------------------------------------------ */

/* A stable id: the same shortcut keeps the same id across rebuilds, so the
   renderer can hold a selection across a refresh and `apps.launch {id}` is
   meaningful. Path-derived, lowercased, so case noise in Windows paths does
   not produce two ids for one file. */
function stableId(kind, key) {
  return kind + ':' + crypto.createHash('sha1').update(String(key).toLowerCase()).digest('hex').slice(0, 12);
}

function quote(s) { return '"' + String(s) + '"'; }

/* STATE THAT OUTLIVES A RE-REQUIRE (lane launch-ui, 2026-09-29). lib/apps.js deletes this module
   from the require cache and loads it again on every search, launch and rebuild (so an edited
   module is picked up live), and that wiped every module-level cache each time. MEASURED here:
   the Settings-page claims ran every section file again on each Enter on a Settings row (200-440
   ms of Mantle's main thread per Enter), every ten-minute rebuild asked the sidecar for all ~90
   icons again, and powercfg ran on every rebuild. The caches live on one process-wide object
   instead; lib/features/search.js (which loads this file once) shares it too. */
const G = (() => {
  const k = '__mantleLauncherIndexState1';
  if (!global[k]) global[k] = { icons: new Map(), iconFail: '', claims: new Map(), sleep: null, store: null, storeIcons: null, recents: null };
  return global[k];
})();

/* Is `exe` reachable on PATH? Used to decide between Windows Terminal and a
   plain PowerShell window — and, when it is not, to SAY so in the result. */
function onPath(exe) {
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    try { if (fs.existsSync(path.join(d, exe))) return path.join(d, exe); } catch (_) { /* unreadable dir */ }
  }
  return null;
}

/* ---- source 1: Start Menu apps ------------------------------------------ */

/* Names that are shortcuts to a web page or an uninstaller, never to an app
   you meant to launch. Keeping them out is the difference between 212 useful
   rows and 400 rows of noise. */
const APP_NOISE = /uninstall|help|read ?me|web ?site|documentation|release notes/i;

let START_MENU_ROOTS = [
  // machine-wide first, user second: the user copy wins the dedupe below
  { dir: path.join(process.env.ProgramData || 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs'), scope: 'all users' },
  { dir: path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs'), scope: 'you' },
];

function walkLnks(root, out, errors, depth) {
  if (depth > 8) return;                       // a symlink loop would otherwise spin
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (err) {
    errors.push(root + ' (' + err.code + ')');  // surfaced, never swallowed
    return;
  }
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) walkLnks(full, out, errors, depth + 1);
    else if (/\.lnk$/i.test(e.name)) out.push(full);
  }
}

/* The icon cache lives at module scope on purpose. Icons come from the C#
   sidecar over IPC and are slow-ish; `build` must NOT wait for all of them or
   the first Win tap feels broken. So: apply whatever is cached immediately,
   start the rest with 8 in flight, wait at most ICON_CAP_MS, return — whatever
   is done is done, the rest stay null.
   The workers that miss the cap KEEP RUNNING, and each one writes its icon
   straight onto the item object it belongs to. Because main caches the array
   `build` returned (lib/apps.js holds it for ten minutes), those same objects
   are what the next `apps.index` hands back: the cached index heals itself and
   the icons appear the second time the launcher opens, with no rebuild. */
const ICON_CAP_MS = 4000;
const ICON_BATCH = 8;
const iconCache = G.icons;       // lnk path -> { url, at } + its file stamp (lib/icon-fresh.js; process-wide: see G)
/* A path with NO icon (the sidecar was down, or Windows had none) is asked again after this long,
   so a sidecar that was restarting at the first build does not leave letter tiles for good. */
const ICON_RETRY_MS = 10 * 60 * 1000;
/* A path WITH an icon is asked again when its .lnk changed, or once per ten-minute rebuild (mantle-icon,
   2026-10-08): a shortcut's own file does not change when the app it points at is rebuilt or updated,
   and the launcher kept that app's old picture until Mantle restarted. The re-ask runs in the
   background with the old picture still showing, and costs the sidecar a stat or two: it answers
   from its own cache unless the shortcut or its target changed (sidecar/Icons.cs). */
const ICON_RECHECK_MS = 10 * 60 * 1000;
const ICON_REFRESH_BATCH = 2;
function iconKnown(p) {
  const hit = iconCache.get(p);
  if (!hit) return false;
  if (hit.url === null) return Date.now() - hit.at < ICON_RETRY_MS && iconFresh.isFresh(hit, p);
  return iconFresh.isFresh(hit, p, { recheckMs: ICON_RECHECK_MS });
}

async function fillIcons(items, icon, capMs = ICON_CAP_MS) {
  if (typeof icon !== 'function') {
    G.iconFail = 'no icon resolver was passed to build()';
    return { pending: items.length };
  }
  const due = items.filter(it => !iconKnown(it.path));
  // no picture yet: the build waits for these (up to the cap)
  const todo = due.filter(it => !(iconCache.get(it.path) || {}).url);
  // a picture that is due a re-ask: it keeps showing, and the re-ask runs in the background
  const refresh = due.filter(it => !!(iconCache.get(it.path) || {}).url);
  let cursor = 0;

  async function ask(it) {
    const had = (iconCache.get(it.path) || {}).url || null;
    try {
      const url = await icon(it.path);
      iconCache.set(it.path, iconFresh.stamp({ url: url || null, at: Date.now() }, it.path));
      it.icon = url || null;          // in place: late icons still reach main's cached array
    } catch (err) {
      // a failed ask keeps the picture it had (asked again next rebuild); with none, it is a miss
      iconCache.set(it.path, iconFresh.stamp({ url: had, at: Date.now() }, it.path));
      it.icon = had;
      if (!G.iconFail) G.iconFail = String((err && err.message) || err);
    }
  }
  async function worker() {
    while (cursor < todo.length) await ask(todo[cursor++]);
  }
  let rcursor = 0;
  async function refresher() {
    while (rcursor < refresh.length) await ask(refresh[rcursor++]);
  }
  if (refresh.length) {
    Promise.all(Array.from({ length: Math.min(ICON_REFRESH_BATCH, refresh.length) }, refresher))
      .catch(() => { /* per-icon errors are recorded in ask */ });
  }

  const pool = Promise.all(Array.from({ length: Math.min(ICON_BATCH, todo.length || 1) }, worker));
  pool.catch(() => { /* per-icon errors are already recorded above */ });
  let timer;
  await Promise.race([pool, new Promise(r => { timer = setTimeout(r, capMs); if (timer.unref) timer.unref(); })]);
  clearTimeout(timer);

  let pending = 0;
  for (const it of items) {
    if (iconCache.has(it.path)) it.icon = iconCache.get(it.path).url;
    else { it.icon = null; pending++; }
  }
  return { pending };
}

function buildApps() {
  const byName = new Map();       // lowercased name -> item (user scope overwrites)
  const errors = [];
  let roots = 0;

  for (const { dir, scope } of START_MENU_ROOTS) {
    if (!fs.existsSync(dir)) { errors.push('missing folder ' + dir); continue; }
    roots++;
    const lnks = [];
    walkLnks(dir, lnks, errors, 0);
    for (const full of lnks) {
      const name = path.basename(full, path.extname(full));
      if (APP_NOISE.test(name)) continue;
      const folder = path.basename(path.dirname(full));
      byName.set(name.toLowerCase(), {
        id: stableId('app', full),
        kind: 'app',
        name,
        // the folder the shortcut sits in is the closest thing Windows gives us
        // to a publisher; at the root of Programs there is no folder to show
        subtitle: (folder.toLowerCase() === 'programs' ? 'Start Menu (' + scope + ')' : folder),
        path: full,
        icon: null,
      });
    }
  }

  const items = standInApps(Array.from(byName.values())).sort((a, b) => a.name.localeCompare(b.name));
  let status = 'ok', reason = '';
  if (roots === 0) { status = 'error'; reason = 'no Start Menu folder could be read: ' + errors.join('; '); }
  else if (items.length === 0) { status = 'error'; reason = 'the Start Menu folders are empty or unreadable'; }
  else if (errors.length) { reason = errors.length + ' folder(s) unreadable: ' + errors.slice(0, 2).join('; '); }
  return { items, status, reason };
}

/* ---- source 1b: Store apps (lane launch-ui, 2026-09-29) --------------------------------------
 *
 * THE HOLE: the Start Menu folders hold only desktop shortcuts. Calculator, Notepad, Paint,
 * Terminal, Photos, Microsoft Store, Minecraft Launcher and LessonPlayer are PACKAGED apps with no .lnk
 * anywhere, so typing "calc" or "notepad" found nothing - MEASURED here: 50 of the 147 apps Start
 * lists were missing. Windows' own list of them is Get-StartApps (Name + AppID); a packaged app's
 * AppID is its AUMID ("Microsoft.WindowsCalculator_8wekyb3d8bbwe!App"), and it starts through
 * shell:AppsFolder\<aumid>, the way Start starts it.
 *
 * COST: Get-StartApps took 4.4 s here (a PowerShell start plus the shell's app list), so it never
 * sits on the keystroke path: the answer is kept process-wide (G.store) for STORE_TTL_MS and
 * refreshed in the background; only the very first build waits for it, and no longer than the
 * icons' own cap. A failed read keeps the last good list and says why in the footer. */
const STORE_TTL_MS = 10 * 60 * 1000;
const STORE_TIMEOUT_MS = 20000;
// PackageFamilyName!AppId: letters, digits, dot, dash, underscore - never a path, a space or a quote
const AUMID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}_[A-Za-z0-9]{8,20}![A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/* Packaged apps Mantle already lists in a better form: Windows' Settings app is the "Windows
   Settings" row (and Mantle Settings above it). */
const STORE_SKIP = /^windows\.immersivecontrolpanel_/i;

const STORE_PS = '[Console]::OutputEncoding=[Text.Encoding]::UTF8; ' +
  'Get-StartApps | Where-Object { $_.AppID -like \'*!*\' } | ForEach-Object { $_.Name + [char]9 + $_.AppID }';

function readStartAppsPs() {
  return new Promise((resolve) => {
    cp.execFile(path.join(SYS32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', STORE_PS],
      { windowsHide: true, timeout: STORE_TIMEOUT_MS, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        const text = String(stdout || '');
        if (err && !text.trim()) {
          resolve({ ok: false, list: [], reason: 'Windows did not list its Store apps' + (err.killed ? ' in time' : '') });
          return;
        }
        resolve({ ok: true, list: parseStartApps(text), reason: '' });
      });
  });
}

/** "Name<TAB>AUMID" lines -> [{ name, aumid }], keeping only well-formed AUMIDs. */
function parseStartApps(text) {
  const out = [];
  const seen = new Set();
  for (const line of String(text).replace(/^﻿/, '').split(/\r?\n/)) {
    const tab = line.indexOf('\t');
    if (tab <= 0) continue;
    const name = line.slice(0, tab).trim();
    const aumid = line.slice(tab + 1).trim();
    if (!name || !AUMID_RE.test(aumid) || seen.has(aumid.toLowerCase())) continue;
    seen.add(aumid.toLowerCase());
    out.push({ name, aumid });
  }
  return out;
}

let storeRunner = readStartAppsPs;      // tests swap in a fake (_setStoreRunnerForTest)
let storeGuardMs = STORE_TIMEOUT_MS + 5000;   // past execFile's own timeout; tests shorten it

/** The cached Store list, starting a background read when it is missing or older than the TTL. */
function storeNow() {
  const s = G.store || { at: 0, list: null, ok: false, reason: '', pending: null };
  if (!s.pending && (!s.list || Date.now() - s.at >= STORE_TTL_MS)) {
    // the guard: a read that never answers still ENDS (as "not in time"), so a build waiting to
    // merge the list (mergeLateStore) is let go and the next build may ask again
    let guard;
    const late = new Promise((r) => { guard = setTimeout(() => r({ ok: false, list: [], reason: 'Windows did not list its Store apps in time' }), storeGuardMs); if (guard.unref) guard.unref(); });
    s.pending = Promise.race([Promise.resolve().then(() => storeRunner()), late]).then((r) => r, (err) => ({ ok: false, list: [], reason: 'Windows did not list its Store apps: ' + String((err && err.message) || err) }))
      .then((r) => { clearTimeout(guard); return r; })
      .then((r) => {
        const now = G.store || s;
        if (r && r.ok) { now.list = r.list; now.ok = true; now.reason = ''; }
        else { now.ok = false; now.reason = (r && r.reason) || 'Windows did not list its Store apps'; if (!now.list) now.list = null; }
        now.at = Date.now();
        now.pending = null;
      });
    G.store = s;
  }
  return s;
}

function storeItems(list, lnkNames) {
  const items = [];
  for (const { name, aumid } of list || []) {
    if (STORE_SKIP.test(aumid) || APP_NOISE.test(name)) continue;
    if (lnkNames.has(name.toLowerCase())) continue;      // a desktop shortcut of the same name wins
    /* lane mantle-player: Windows' Media Player row becomes Mantle Player (same muscle memory: "media player"
       finds it first), with Windows' own one row below, named for what it is */
    const MA = mantleApps();
    if (MA && MA.APPS.player && MA.standInFor({ aumid })) {
      const a = MA.APPS.player;
      items.push({ id: stableId('app', 'aumid:' + aumid), kind: 'app', name: a.title, subtitle: 'Mantle · in place of ' + a.windowsName, path: 'mantle:player', windowsPath: 'shell:AppsFolder\\' + aumid, aumid, mantleApp: 'player', icon: MA.iconUrl('player', 64), keywords: (a.title + ' ' + name + ' music video songs films groove').toLowerCase() });
      items.push({ id: stableId('app', 'aumid:' + aumid + '#windows'), kind: 'app', name: a.windowsName, subtitle: 'Microsoft Store app · Windows\' own', path: 'shell:AppsFolder\\' + aumid, aumid, icon: null, secondary: true });
      continue;
    }
    items.push({
      id: stableId('app', 'aumid:' + aumid),
      kind: 'app',
      name,
      subtitle: 'Microsoft Store app',
      path: 'shell:AppsFolder\\' + aumid,
      aumid,
      icon: null,
    });
  }
  return items;
}

/* ---- source 2: Owen's own PowerShell commands --------------------------- */

/* The brief names two profile paths; on this machine Documents is redirected
   into OneDrive, so the real profile is a third path. Rather than hardcode the
   winner we try every place a profile can legally live and use each that
   exists — and if NONE exist we say all the places we looked. */
function profileCandidates() {
  const home = os.homedir();
  const docs = [
    path.join(home, 'Documents'),
    process.env.OneDrive ? path.join(process.env.OneDrive, 'Documents') : null,
    path.join(home, 'OneDrive', 'Documents'),
  ].filter(Boolean);
  const out = [];
  for (const d of docs) {
    out.push(path.join(d, 'PowerShell', 'Microsoft.PowerShell_profile.ps1'));         // PS 7
    out.push(path.join(d, 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1'));  // PS 5.1
  }
  return Array.from(new Set(out));
}

/* Only TOP-LEVEL declarations count: `function Draw-Menu` indented inside
   another function is a private helper, not something you can type at a
   prompt. That is why both regexes are anchored at column 0. */
const RE_FUNC = /^function\s+([A-Za-z0-9_][A-Za-z0-9_.\-]*)/;
const RE_ALIAS = /^Set-Alias\s+(?:-Name\s+)?([A-Za-z0-9_][A-Za-z0-9_.\-]*)/;

function buildCommands() {
  const found = new Map();
  const looked = profileCandidates();
  const read = [];
  const errors = [];

  for (const file of looked) {
    if (!fs.existsSync(file)) continue;
    let text;
    try { text = fs.readFileSync(file, 'utf8'); }
    catch (err) { errors.push(path.basename(path.dirname(file)) + ': ' + err.code); continue; }
    read.push(file);
    for (const line of text.split(/\r?\n/)) {
      const m = RE_FUNC.exec(line) || RE_ALIAS.exec(line);
      if (!m) continue;
      const name = m[1];
      if (name.startsWith('_')) continue;      // private by convention
      if (found.has(name.toLowerCase())) continue;
      found.set(name.toLowerCase(), {
        id: stableId('cmd', name),
        kind: 'command',
        name,
        subtitle: 'PowerShell profile',
        path: name,                            // for a command the "path" IS the command
        icon: null,
      });
    }
  }

  const items = Array.from(found.values()).sort((a, b) => a.name.localeCompare(b.name));
  let status = 'ok', reason = '';
  if (read.length === 0) {
    /* no profile is normal (most people have none): no commands, and nothing to warn about */
    status = 'ok';
    reason = '';
  } else if (items.length === 0) {
    status = 'error';
    reason = 'no functions or aliases in ' + read[0];
  } else if (errors.length) {
    reason = 'unreadable: ' + errors.join('; ');
  }
  return { items, status, reason };
}

/* ---- source 3: Settings pages ------------------------------------------ */

/* Curated rather than enumerated: Windows exposes hundreds of ms-settings: pages and no list of
   them; these are the ~100 a person actually reaches for (Win+S brief, 2026-09-24). Named the way
   the Settings app names them so search matches muscle memory, and each carries the WORDS people
   type for it that are not in its name - "dark mode" is Colors, "wallpaper" is Background,
   "uninstall" is Installed apps, "bt" is Bluetooth. Keywords score BELOW an exact app name and a
   power row's own words (see scoreSettingKeywords), so "sleep" is still the Sleep action and
   "lock" is still Lock. The first 26 URIs are the pre-Win+S table's, unchanged, so their row ids
   (stableId of the URI) did not move. Every URI here is one of Microsoft's documented
   ms-settings: pages; a page a build lacks opens Settings' home, never an error. */
const SETTINGS = [
  // [name, uri, keywords]
  ['Display', 'ms-settings:display', 'screen monitor resolution scale scaling brightness orientation refresh rate'],
  ['Sound', 'ms-settings:sound', 'audio volume speakers headphones microphone mic output input'],
  ['Bluetooth & devices', 'ms-settings:bluetooth', 'bt pair pairing wireless headphones earbuds controller'],
  ['Wi-Fi', 'ms-settings:network-wifi', 'wifi wireless wlan ssid internet'],
  ['Network & internet', 'ms-settings:network', 'internet connection network status connectivity'],
  ['Installed apps', 'ms-settings:appsfeatures', 'uninstall remove programs apps and features add or remove'],
  ['Personalization', 'ms-settings:personalization', 'customize look appearance'],
  ['Windows Update', 'ms-settings:windowsupdate', 'updates update check for updates patch upgrade pause updates'],
  ['Storage', 'ms-settings:storagesense', 'disk space drive storage sense free up space'],
  ['Power & battery', 'ms-settings:batterysaver', 'battery energy saver power mode battery saver'],
  ['Privacy & security', 'ms-settings:privacy', 'permissions privacy app permissions'],
  ['Accounts', 'ms-settings:yourinfo', 'your info account profile picture microsoft account'],
  ['Date & time', 'ms-settings:dateandtime', 'clock time zone timezone date sync time'],
  ['Notifications', 'ms-settings:notifications', 'alerts banners toasts notification'],
  ['Focus', 'ms-settings:quiethours', 'do not disturb dnd focus assist quiet hours'],
  ['Printers & scanners', 'ms-settings:printers', 'printer print scanner scan'],
  ['Mouse', 'ms-settings:mousetouchpad', 'pointer speed scroll wheel buttons primary button'],
  ['Keyboard', 'ms-settings:keyboard', 'input method keyboard layout'],
  ['Typing', 'ms-settings:typing', 'autocorrect spelling spellcheck text suggestions'],
  ['Default apps', 'ms-settings:defaultapps', 'default browser file associations open with file type'],
  ['Startup apps', 'ms-settings:startupapps', 'startup autostart launch at login run at startup boot'],
  ['About this PC', 'ms-settings:about', 'system info specs rename pc pc name device name ram cpu processor windows version'],
  ['Optional features', 'ms-settings:optionalfeatures', 'add a feature windows features'],
  ['For developers', 'ms-settings:developers', 'developer mode sudo dev drive'],
  ['Windows Security', 'ms-settings:windowsdefender', 'antivirus defender virus firewall protection malware'],
  ['Multitasking', 'ms-settings:multitasking', 'snap windows snap layouts alt tab virtual desktops'],

  // System
  ['Night light', 'ms-settings:nightlight', 'blue light warm color evening night mode'],
  ['HDR', 'ms-settings:display-hdr', 'hdr high dynamic range'],
  ['Graphics', 'ms-settings:display-advancedgraphics', 'gpu graphics performance preference'],
  ['Volume mixer', 'ms-settings:apps-volume', 'app volume per app volume mixer'],
  ['Sound devices', 'ms-settings:sound-devices', 'audio devices output devices input devices'],
  ['Screen and sleep', 'ms-settings:powersleep', 'sleep timeout screen timeout turn off display power plan'],
  ['Battery saver', 'ms-settings:batterysaver-settings', 'battery saver energy saver low battery'],
  ['Cleanup recommendations', 'ms-settings:storagerecommendations', 'disk cleanup clean up temporary files free space'],
  ['Nearby sharing', 'ms-settings:crossdevice', 'share nearby share'],
  ['Activation', 'ms-settings:activation', 'product key license activate windows'],
  ['Troubleshoot', 'ms-settings:troubleshoot', 'fix problems troubleshooter'],
  ['Recovery', 'ms-settings:recovery', 'reset this pc advanced startup go back restore'],
  ['Projecting to this PC', 'ms-settings:project', 'miracast wireless display cast'],
  ['Remote Desktop', 'ms-settings:remotedesktop', 'rdp remote access'],
  ['Clipboard', 'ms-settings:clipboard', 'clipboard history copy paste'],

  // Bluetooth & devices
  ['Devices', 'ms-settings:connecteddevices', 'connected devices add device'],
  ['Phone Link', 'ms-settings:mobile-devices', 'phone android iphone mobile devices'],
  ['Cameras', 'ms-settings:camera', 'webcam camera'],
  ['Touchpad', 'ms-settings:devices-touchpad', 'trackpad gestures tap to click precision touchpad'],
  ['Pen & Windows Ink', 'ms-settings:pen', 'stylus pen ink handwriting'],
  ['AutoPlay', 'ms-settings:autoplay', 'removable drive memory card'],
  ['USB', 'ms-settings:usb', 'usb notifications usb power'],
  ['Game controllers', 'ms-settings:devices-gamecontroller', 'gamepad controller joystick'],

  // Network & internet
  ['Ethernet', 'ms-settings:network-ethernet', 'wired lan cable'],
  ['VPN', 'ms-settings:network-vpn', 'virtual private network'],
  ['Mobile hotspot', 'ms-settings:network-mobilehotspot', 'hotspot tethering share internet'],
  ['Airplane mode', 'ms-settings:network-airplanemode', 'flight mode offline'],
  ['Proxy', 'ms-settings:network-proxy', 'proxy server'],
  ['Advanced network settings', 'ms-settings:network-advancedsettings', 'network adapters network reset adapter'],
  ['Known Wi-Fi networks', 'ms-settings:network-wifisettings', 'saved networks forget network'],
  ['Data usage', 'ms-settings:datausage', 'metered data limit'],

  // Personalization
  ['Background', 'ms-settings:personalization-background', 'wallpaper desktop background picture slideshow'],
  ['Colors', 'ms-settings:colors', 'dark mode light mode accent color theme transparency'],
  ['Themes', 'ms-settings:themes', 'theme desktop icons cursor'],
  ['Lock screen', 'ms-settings:lockscreen', 'lock screen picture spotlight'],
  ['Start', 'ms-settings:personalization-start', 'start menu recommended layout'],
  ['Taskbar', 'ms-settings:taskbar', 'taskbar alignment system tray icons'],
  ['Fonts', 'ms-settings:fonts', 'font typeface install fonts'],
  ['Touch keyboard', 'ms-settings:personalization-textinput', 'touch keyboard theme text input'],
  ['Dynamic Lighting', 'ms-settings:personalization-lighting', 'rgb lighting leds'],

  // Apps
  ['Advanced app settings', 'ms-settings:advanced-apps', 'app execution aliases archive apps'],
  ['Apps for websites', 'ms-settings:appsforwebsites', 'open links in apps'],
  ['Video playback', 'ms-settings:videoplayback', 'hdr video streaming'],
  ['Offline maps', 'ms-settings:maps', 'maps download'],

  // Accounts
  ['Sign-in options', 'ms-settings:signinoptions', 'password pin windows hello fingerprint face login sign in'],
  ['Email & accounts', 'ms-settings:emailandaccounts', 'email mail accounts'],
  ['Other users', 'ms-settings:otherusers', 'add user family other people'],
  ['Windows Backup', 'ms-settings:backup', 'backup onedrive folders sync'],
  ['Access work or school', 'ms-settings:workplace', 'work account school account'],

  // Time & language
  ['Language & region', 'ms-settings:regionlanguage', 'language region locale format display language'],
  ['Speech', 'ms-settings:speech', 'voice speech recognition voice typing'],

  // Gaming
  ['Game Mode', 'ms-settings:gaming-gamemode', 'gaming performance'],
  ['Game Bar', 'ms-settings:gaming-gamebar', 'xbox game bar'],
  ['Captures', 'ms-settings:gaming-gamedvr', 'game clips recording screen recording'],

  // Accessibility
  ['Accessibility', 'ms-settings:easeofaccess', 'ease of access'],
  ['Text size', 'ms-settings:easeofaccess-display', 'bigger text font size make text bigger'],
  ['Mouse pointer and touch', 'ms-settings:easeofaccess-mousepointer', 'cursor size pointer color'],
  ['Text cursor', 'ms-settings:easeofaccess-cursor', 'caret cursor thickness'],
  ['Magnifier', 'ms-settings:easeofaccess-magnifier', 'zoom magnify'],
  ['Color filters', 'ms-settings:easeofaccess-colorfilter', 'colorblind color blind grayscale'],
  ['Contrast themes', 'ms-settings:easeofaccess-highcontrast', 'high contrast'],
  ['Narrator', 'ms-settings:easeofaccess-narrator', 'screen reader read aloud'],
  ['Captions', 'ms-settings:easeofaccess-closedcaptioning', 'subtitles closed captions live captions'],
  ['Visual effects', 'ms-settings:easeofaccess-visualeffects', 'animations transparency effects scrollbars'],
  ['Accessibility keyboard', 'ms-settings:easeofaccess-keyboard', 'sticky keys filter keys on-screen keyboard'],
  ['Accessibility audio', 'ms-settings:easeofaccess-audio', 'mono audio flash screen'],

  // Privacy & security
  ['Find my device', 'ms-settings:findmydevice', 'lost device locate'],
  ['Location', 'ms-settings:privacy-location', 'gps location services'],
  ['Camera access', 'ms-settings:privacy-webcam', 'webcam permission camera permission'],
  ['Microphone access', 'ms-settings:privacy-microphone', 'mic permission microphone permission'],
  ['Activity history', 'ms-settings:privacy-activityhistory', 'timeline history'],
  ['Search permissions', 'ms-settings:search-permissions', 'safe search cloud search'],
  ['Searching Windows', 'ms-settings:cortana-windowssearch', 'indexing search index indexer indexed locations'],
  ['Diagnostics & feedback', 'ms-settings:privacy-feedback', 'telemetry diagnostic data'],
  ['Device encryption', 'ms-settings:deviceencryption', 'bitlocker encryption'],

  // Windows Update
  ['Windows Update history', 'ms-settings:windowsupdate-history', 'installed updates uninstall updates'],
  ['Advanced update options', 'ms-settings:windowsupdate-options', 'active hours optional updates restart notifications'],
  ['Windows Insider Program', 'ms-settings:windowsinsider', 'insider preview builds'],
  ['Delivery Optimization', 'ms-settings:delivery-optimization', 'download bandwidth peer updates'],

  /* Pages Mantle Settings' section modules claim that the list above lacked (lane wire,
     2026-09-29), so each is findable by Windows' own name. The app permissions say "access" like
     Camera access above: a bare "Pictures" or "Documents" would crowd out the folders. Any page a
     module claims that is STILL not here is added from the module's own row (buildSettings). */
  ['Network status', 'ms-settings:network-status', 'network status connected internet access connection properties'],
  ['Dial-up', 'ms-settings:network-dialup', 'dial up dialup modem connection'],
  ['Device usage', 'ms-settings:deviceusage', 'device usage gaming family creativity school entertainment business tips ads'],
  ['Regional format', 'ms-settings:regionformatting', 'regional format date format time format currency first day of week locale'],
  ['Eye control', 'ms-settings:easeofaccess-eyecontrol', 'eye tracker gaze eye tracking'],
  ['Mouse keys', 'ms-settings:easeofaccess-mouse', 'numpad numeric keypad move pointer accessibility mouse'],
  ['Voice access', 'ms-settings:easeofaccess-speechrecognition', 'voice control speech recognition dictation accessibility speech'],
  ['General privacy options', 'ms-settings:privacy-general', 'advertising id ads tracking app launches suggested content language list privacy general'],
  ['Online speech recognition', 'ms-settings:privacy-speech', 'speech privacy voice online speech'],
  ['Inking & typing personalization', 'ms-settings:privacy-speechtyping', 'custom dictionary typing history inking personal dictionary'],
  ['Voice activation', 'ms-settings:privacy-voiceactivation', 'voice activation keyword wake word app permission'],
  ['Notification access', 'ms-settings:privacy-notifications', 'app permission notifications listener privacy'],
  ['Account info access', 'ms-settings:privacy-accountinfo', 'app permission account info name picture privacy'],
  ['Contacts access', 'ms-settings:privacy-contacts', 'app permission contacts people privacy'],
  ['Calendar access', 'ms-settings:privacy-calendar', 'app permission calendar appointments privacy'],
  ['Phone calls access', 'ms-settings:privacy-phonecalls', 'app permission phone calls privacy'],
  ['Call history access', 'ms-settings:privacy-callhistory', 'app permission call history privacy'],
  ['Email access', 'ms-settings:privacy-email', 'app permission email mail privacy'],
  ['Tasks access', 'ms-settings:privacy-tasks', 'app permission tasks to do privacy'],
  ['Messaging access', 'ms-settings:privacy-messaging', 'app permission messaging sms mms text privacy'],
  ['Radios access', 'ms-settings:privacy-radios', 'app permission radios bluetooth radio control privacy'],
  ['Other devices access', 'ms-settings:privacy-customdevices', 'app permission other devices unpaired wireless beacons privacy'],
  ['App diagnostics access', 'ms-settings:privacy-appdiagnostics', 'app permission diagnostic info other apps privacy'],
  ['Automatic file downloads', 'ms-settings:privacy-automaticfiledownloads', 'online storage providers file downloads privacy'],
  ['Documents library access', 'ms-settings:privacy-documents', 'app permission documents library privacy'],
  ['Downloads folder access', 'ms-settings:privacy-downloadsfolder', 'app permission downloads folder privacy'],
  ['Music library access', 'ms-settings:privacy-musiclibrary', 'app permission music library privacy'],
  ['Pictures library access', 'ms-settings:privacy-pictures', 'app permission pictures photos library privacy'],
  ['Videos library access', 'ms-settings:privacy-videos', 'app permission videos library privacy'],
  ['File system access', 'ms-settings:privacy-broadfilesystemaccess', 'app permission all files file system privacy'],
  ['Screenshots and apps', 'ms-settings:privacy-graphicscaptureprogrammatic', 'app permission screenshots screen capture privacy'],
  ['Screenshot borders', 'ms-settings:privacy-graphicscapturewithoutborder', 'app permission screenshot yellow border privacy'],
  ['Text and image generation', 'ms-settings:privacy-systemaimodels', 'app permission generative ai copilot models privacy'],
  ['Presence sensing', 'ms-settings:privacy-presence', 'app permission human presence sensor privacy'],
];

/* Mantle's own windows, opened in-process rather than by Windows. Listed as settings (the same
   glyph, the same place in the ranking) because that is what they are: somewhere to change how
   Mantle looks. "Wallpapers" is the only way to reach the wallpaper library besides the tray menu
   -- the desktop layer itself sits under the icons and never gets a click. */
const MANTLE_TARGETS = [
  ['Wallpapers', 'mantle:wallpapers'],
  // lane settings (2026-09-28): Mantle Settings (Win+I), Mantle's own Settings window
  ['Mantle Settings', 'mantle:settings', 'settings preferences options mantle features shortcuts win+i'],
  // lane taskmgr (2026-09-28): Mantle's task manager (Ctrl+Shift+Esc), and its "Get ready to game" view
  ['Mantle Task Manager', 'mantle:taskmgr', 'task manager processes end task running apps cpu memory ram ctrl+shift+esc'],
  ['Get ready to game (free RAM)', 'mantle:taskmgr:game', 'free ram memory game close apps task manager'],
  // 2026-09-29 (Owen: Files "takes super long to actually open"): Mantle Files (Win+E), Mantle's own file manager
  ['Mantle Files', 'mantle:files', 'files file explorer folders documents downloads browse win+e'],
  // lane mantle-player (2026-10-17): Mantle Player, in place of Windows' Media Player
  ['Mantle Player', 'mantle:player', 'player media player music video movies films songs albums artists playlist play groove'],
  // lane mantle-clips2 (2026-10-15): Clips, the gallery of Windows' Captures folder (Win+G records)
  ['Clips', 'mantle:clips', 'clips recordings captures videos screenshots game bar record trim share win+g'],
];

/* The Settings pages Mantle Settings covers itself (lane settings, 2026-09-28): a launcher hit on
   one of these opens Mantle Settings at that section (and row) instead of Windows' app; every other
   page, and these too whenever Mantle Settings is off or resting, opens Windows' own (launch()).
   lib/features/settings.js serves the same map to its search. Row ids are ui/settings/model.js's. */
const MANTLE_SETTINGS = {
  'ms-settings:display': { section: 'display', row: null },
  'ms-settings:nightlight': { section: 'display', row: 'display.nightlight' },
  'ms-settings:sound': { section: 'sound', row: null },
  'ms-settings:sound-devices': { section: 'sound', row: 'sound.output' },
  'ms-settings:apps-volume': { section: 'sound', row: 'sound.mixer' },
  'ms-settings:bluetooth': { section: 'bluetooth', row: null },
  'ms-settings:connecteddevices': { section: 'bluetooth', row: 'bluetooth.devices' },
  'ms-settings:network-wifi': { section: 'network', row: 'network.wifi' },
  'ms-settings:network': { section: 'network', row: null },
  'ms-settings:batterysaver': { section: 'power', row: null },
  'ms-settings:notifications': { section: 'notifications', row: null },
  'ms-settings:startupapps': { section: 'apps', row: 'apps.startup' },
};

/* ---- the pages Mantle's section modules claim (lane wire, 2026-09-29) -------------------------
 *
 * Mantle Settings' Windows categories are section modules (ui/settings/SECTIONS.md): each
 * ui/settings/sections/<id>.js registers one with MantleSettings.section({...}), and every `uri`
 * on it (on the section itself, on a page, or on a search row) CLAIMS that Windows Settings page:
 * Mantle's page replaces it. MANTLE_SETTINGS above only knows the built-in sections, so the
 * launcher reads the claims from the files themselves: each page file is RUN in an empty vm
 * context whose only global is a MantleSettings that records the definition (no require, no
 * process, no DOM; the files only build their definition while loading, render() is never
 * called), under a 250 ms timeout. A file that throws, times out or registers nothing claims
 * nothing, and its reason is kept (sectionClaims().down) so the tests and the footer can say why.
 * Cached by size + mtime, so a rebuild re-reads only a changed file. The first file (by name) to
 * claim a page keeps it, the same order Settings' own search uses (ui/settings/model.js).
 */
const SECTIONS_DIR = path.join(__dirname, '..', 'ui', 'settings', 'sections');
const MS_URI_RE = /^ms-settings:[a-z0-9-]*$/i;
const CLAIM_ROW_RE = /^[A-Za-z0-9_.+-]{1,80}$/;        // = lib/features/settings.js ROW_RE (navFrom keeps it)
const CLAIM_PAGE_RE = /^[a-z][a-z0-9-]{0,39}$/;        // = SECTION_ID_RE there
const claimCache = G.claims;                           // file -> { key, def, down } (process-wide: see G)
function readSectionDef(file, id) {
  let st;
  try { st = fs.statSync(file); } catch (e) { return { def: null, down: 'it could not be read (' + (e.code || e.message) + ')' }; }
  const key = st.size + ':' + st.mtimeMs;
  const hit = claimCache.get(file);
  if (hit && hit.key === key) return hit;
  let def = null, down = null;
  try {
    const sandbox = { MantleSettings: { section(d) { if (def === null) def = d; } } };
    sandbox.window = sandbox;
    sandbox.self = sandbox;
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: 'sections/' + id + '.js', timeout: 250 });
    if (!def || typeof def !== 'object') down = 'it registered no section while loading';
    else if (def.id !== id) down = 'its id ' + JSON.stringify(def.id) + ' is not its file name';
  } catch (e) { down = 'it threw while loading (' + (e && e.message ? e.message : String(e)) + ')'; }
  const r = { key, def: down ? null : def, down };
  claimCache.set(file, r);
  return r;
}
/** Every ms-settings: page a section module claims -> { claims: { uri: { uri, section, page, row,
 *  name, keywords, where } }, down: { id: why }, sections: [{ id, title }], reason }. Never throws. */
function sectionClaims(dir = SECTIONS_DIR) {
  const claims = Object.create(null), down = {}, sections = [];
  let names;
  try { names = fs.readdirSync(dir); }
  catch (e) { return { claims, down, sections, reason: e.code === 'ENOENT' ? '' : 'the Settings section folder could not be read (' + (e.code || e.message) + ')' }; }
  names = names.filter((f) => /^[a-z][a-z0-9-]{0,39}\.js$/.test(f) && !f.endsWith('.test.js')).sort();
  for (const f of names) {
    const id = f.slice(0, -3);
    const r = readSectionDef(path.join(dir, f), id);
    if (!r.def) { down[id] = r.down; continue; }
    const def = r.def;
    const title = typeof def.title === 'string' && def.title.trim() ? def.title : id;
    sections.push({ id, title });
    const str = (v) => (typeof v === 'string' ? v : '');
    const claim = (uri, to) => {
      for (const u of [].concat(uri === undefined ? [] : uri)) {
        if (typeof u !== 'string' || !MS_URI_RE.test(u)) continue;
        const k = u.toLowerCase();
        if (!claims[k]) claims[k] = Object.assign({ uri: k, section: id }, to);
      }
    };
    const rows = (list, page, pageTitle) => {
      for (const s of Array.isArray(list) ? list : []) {
        if (!s || !CLAIM_ROW_RE.test(String(s.row))) continue;
        claim(s.uri, { page, row: s.row, name: str(s.label) || s.row, keywords: str(s.keywords), where: pageTitle ? title + ' › ' + pageTitle : title });
      }
    };
    claim(def.uri, { page: null, row: null, name: title, keywords: str(def.keywords), where: title });
    rows(def.search, null, null);
    for (const p of Array.isArray(def.pages) ? def.pages : []) {
      if (!p || !CLAIM_PAGE_RE.test(String(p.id))) continue;
      const pt = str(p.title) || null;
      claim(p.uri, { page: p.id, row: null, name: pt || p.id, keywords: str(p.help), where: pt ? title + ' › ' + pt : title });
      rows(p.search, p.id, pt);
    }
  }
  return { claims, down, sections, reason: '' };
}
let lastClaims = null;
function claimsNow() { if (!lastClaims) lastClaims = sectionClaims(); return lastClaims; }
/** Where Mantle Settings opens a Windows Settings page: a section module's claim, else the built-in
 *  table (MANTLE_SETTINGS) -> { section, page, row }, or null when Windows' own is the only page. */
function coverOf(uri) {
  const k = String(uri || '').toLowerCase();
  const c = claimsNow().claims[k];
  if (c) return { section: c.section, page: c.page, row: c.row };
  const m = MANTLE_SETTINGS[k];
  return m ? { section: m.section, page: null, row: m.row } : null;
}

/* ---- Mantle's app windows in place of Windows' (icons lane, 2026-09-28) ----------------------
 *
 * Owen: "they need to have there own icons that replace windows icons not just be electron". Where
 * WINDOWS' Settings or Task Manager would come up, Mantle's version comes up in its place, with its
 * own icon (assets/icons, lib/mantle-apps.js) and opening Mantle's:
 *   - the Mantle rows (MANTLE_TARGETS) carry Mantle's icons;
 *   - a Settings page Mantle Settings covers (MANTLE_SETTINGS) carries Mantle Settings' icon and
 *     says "Mantle Settings"; every other page says "Windows Settings", because Windows' opens;
 *   - Windows' Task Manager shortcut (Start Menu > System Tools) becomes Mantle's task manager in
 *     the Apps group (same row id, so it keeps its place in Owen's muscle memory);
 *   - Windows' own stays one row away, named for what it is: "Windows Settings" and "Windows Task
 *     Manager", ranked just under Mantle's (SECONDARY_PENALTY);
 *   - Mantle's off or resting: launch() opens Windows' own and says why, as Mantle Settings did. */
const SECONDARY_PENALTY = 40;
function mantleApps() { try { return require('./mantle-apps'); } catch (_) { return null; } }
function mantleIcon(key) {
  const MA = mantleApps();
  return MA ? MA.iconUrl(key, 64) : null;
}
const MANTLE_TARGET_APP = { 'mantle:settings': 'settings', 'mantle:taskmgr': 'taskmgr', 'mantle:taskmgr:game': 'taskmgr', 'mantle:files': 'files', 'mantle:player': 'player' };

function buildSettings() {
  // re-read what the section modules claim on every build (cached per file: only a changed file runs)
  lastClaims = sectionClaims();
  const listed = new Set(SETTINGS.map((r) => r[1].toLowerCase()));
  // (their words: the row's own + where it sits, minus "settings"/"windows", which would put every
  //  one of them above Mantle Settings itself for a plain "settings")
  const extra = Object.values(lastClaims.claims).filter((c) => !listed.has(c.uri))
    .map((c) => [c.name, c.uri, (c.keywords + ' ' + c.where.replace(/›/g, ' ')).replace(/\b(settings?|windows)\b/gi, ' ')]);
  const items = SETTINGS.concat(extra).map(([name, uri, words]) => ({
    id: stableId('set', uri),
    kind: 'setting',
    name,
    subtitle: coverOf(uri) ? 'Mantle Settings' : 'Windows Settings',
    path: uri,
    icon: coverOf(uri) ? mantleIcon('settings') : null,
    keywords: String(words || '').toLowerCase().replace(/\s+/g, ' ').trim(),
  })).concat(MANTLE_TARGETS.map(([name, uri, words]) => Object.assign({
    id: stableId('set', uri),
    kind: 'setting',
    name,
    subtitle: 'Mantle',
    path: uri,
    icon: MANTLE_TARGET_APP[uri] ? mantleIcon(MANTLE_TARGET_APP[uri]) : null,
  }, words ? { keywords: words } : {}))).concat([{
    // Windows' own Settings app, one row under Mantle Settings (always Windows': launch() opens ms-settings:)
    id: stableId('set', 'ms-settings:'),
    kind: 'setting',
    name: 'Windows Settings',
    subtitle: 'Windows\' own Settings app',
    path: 'ms-settings:',
    icon: null,
    secondary: true,
    keywords: 'settings windows settings control panel system settings pc settings',
  }]);
  // a section module whose page file does not load claims nothing: its pages open Windows' own, and the footer says why
  const down = Object.entries(lastClaims.down).map(([id, why]) => 'Mantle Settings\' ' + id + ' section claims nothing: ' + why);
  if (lastClaims.reason) down.unshift(lastClaims.reason);
  return { items, status: 'ok', reason: down.join('; ') };
}

/* Windows' Task Manager shortcut in the Start Menu -> Mantle's row in its place + "Windows Task
   Manager". Found by what the shortcut RUNS (Taskmgr.exe, via lib/pinned.js's .lnk reader), read
   only for shortcuts named like it, so one odd file costs nothing. */
function standInApps(items) {
  const MA = mantleApps();
  if (!MA) return items;
  let parse = null;
  try { parse = require('./pinned')._internals.parseLnkFile; } catch (_) { parse = null; }
  const out = [];
  for (const it of items) {
    let key = null;
    if (/task ?manager|settings|file explorer/i.test(it.name)) {
      let lnk = null;
      try { lnk = parse ? parse(it.path) : null; } catch (_) { lnk = null; }
      /* Windows' own Task Manager.lnk has NO target path (it lives in the shortcut's item list,
         measured 2026-09-28); its icon location is %windir%\system32\Taskmgr.exe, so that counts too. */
      key = (lnk && MA.standInFor({ target: lnk.target, exe: lnk.target ? null : lnk.iconPath })) ||
        (/^task manager$/i.test(it.name) ? 'taskmgr' : /^file explorer$/i.test(it.name) ? 'files' : null);
    }
    const a = key && MA.APPS[key];
    const mantlePath = key === 'taskmgr' ? 'mantle:taskmgr' : key === 'settings' ? 'mantle:settings' : key === 'files' ? 'mantle:files' : null;
    if (!a || !mantlePath) { out.push(it); continue; }
    out.push(Object.assign({}, it, {
      name: a.title,
      subtitle: 'Mantle · in place of ' + a.windowsName,
      path: mantlePath,
      windowsPath: it.path,
      mantleApp: key,
      icon: MA.iconUrl(key, 64),
      // what the shortcut was called still finds it first: "task manager" is Mantle's now
      keywords: (a.title + ' ' + it.name + ' ' + (key === 'taskmgr' ? 'taskmgr ctrl+shift+esc' : key === 'files' ? 'explorer folders win+e' : 'win+i')).toLowerCase(),
    }));
    out.push(Object.assign({}, it, {
      id: stableId('app', it.path + '#windows'),
      name: a.windowsName,
      subtitle: it.subtitle + ' · Windows\' own',
      secondary: true,
    }));
  }
  return out;
}

/* ---- source 4: power and session ----------------------------------------
 *
 * What Start's power button does, as rows: Lock, Sleep, Restart, Shut down, Sign out, and
 * Hibernate only where Windows says hibernation is available. Found by the words people type
 * ("reboot", "log out", "turn off"), not only by their names.
 *
 * HOW EACH ONE RUNS, and why (see power() below for the code):
 *   Lock       rundll32 user32.dll,LockWorkStation  LockWorkStation takes no arguments, so
 *                                                   rundll32's calling convention cannot garble it
 *   Restart    shutdown /r /t 0                     Windows' own tool; /t 0 without /f, so an app
 *   Shut down  shutdown /s /hybrid /t 0             with unsaved work can still say "wait" - the same
 *              (or /s /t 0: see shutdownArgs)       as Start. /hybrid is what Start does while Fast
 *   Sign out   shutdown /l                          Startup is on (on here, 2026-09-23:
 *   Hibernate  shutdown /h                          HiberbootEnabled=1), so it is added only while
 *                                                   powercfg /a lists Fast Startup; otherwise a FULL /s
 *   Sleep      the sidecar: SetSuspendState(FALSE, FALSE, FALSE), sidecar/Session.cs. There is no
 *              exe for it, and the famous `rundll32 powrprof.dll,SetSuspendState` HIBERNATES any
 *              machine with hibernation on (rundll32 passes its hwnd as bHibernate).
 * The five exes run from main, so they work while the sidecar is down.
 *
 * Restart, Shut down and Sign out ASK FIRST: the launcher turns the row into "Press Enter again
 * to …" and only a second Enter within a few seconds sends confirmed:true. power() refuses them
 * without it, so a renderer bug cannot shut the machine down on one keypress.
 *
 * Lock and Sleep need no confirm - and that is exactly why they can never match a one- or
 * two-letter query: "s" + Enter must open Spotify, not put the machine to sleep. */
const POWER = [
  { action: 'lock', name: 'Lock', subtitle: 'Session', glyph: 'lock',
    keywords: ['lock screen', 'lock computer', 'lock pc'] },
  { action: 'sleep', name: 'Sleep', subtitle: 'Power', glyph: 'sleep',
    keywords: ['suspend', 'standby'] },
  { action: 'hibernate', name: 'Hibernate', subtitle: 'Power', glyph: 'hibernate',
    keywords: ['hibernation'] },
  { action: 'restart', name: 'Restart', subtitle: 'Power · asks first', glyph: 'restart',
    keywords: ['reboot', 'restart computer', 'restart pc'], confirm: 'Press Enter again to restart' },
  { action: 'shutdown', name: 'Shut down', subtitle: 'Power · asks first', glyph: 'power',
    keywords: ['shutdown', 'turn off', 'power off', 'switch off'], confirm: 'Press Enter again to shut down' },
  { action: 'signout', name: 'Sign out', subtitle: 'Session · asks first', glyph: 'signout',
    keywords: ['log out', 'logout', 'log off', 'logoff', 'sign off', 'signout'], confirm: 'Press Enter again to sign out' },
];
/* Typed on their own these reach every row of the group, below anything with that name. */
const POWER_GROUP_WORDS = ['power', 'session'];

const SYS32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const POWER_RUN = {
  lock: { exe: 'rundll32.exe', args: ['user32.dll,LockWorkStation'] },
  restart: { exe: 'shutdown.exe', args: ['/r', '/t', '0'] },
  shutdown: { exe: 'shutdown.exe', args: ['/s', '/t', '0'] },
  signout: { exe: 'shutdown.exe', args: ['/l'] },
  hibernate: { exe: 'shutdown.exe', args: ['/h'] },
  sleep: { sidecar: 'session' },
};

/* Which sleep states this machine has, from `powercfg /a` - Windows' own answer, reasons
   included, and READ-ONLY. MEASURED 2026-09-22: 168 ms here, run once per index build (every ten
   minutes, off the keystroke path). Its output is localised, so an unrecognised layout is not
   guessed at: Hibernate is left out and the footer says why. */
function readSleepStates() {
  return new Promise((resolve) => {
    cp.execFile(path.join(SYS32, 'powercfg.exe'), ['/a'], { windowsHide: true, timeout: 5000, encoding: 'utf8' },
      (err, stdout) => {
        const text = String(stdout || '');
        if (err && !text) {
          resolve({ ok: false, reason: 'powercfg /a failed: ' + String(err.message || err).split(/\r?\n/)[0] });
          return;
        }
        resolve(parseSleepStates(text));
      });
  });
}

function parseSleepStates(text) {
  const lines = String(text).split(/\r?\n/);
  const headAvail = lines.findIndex(l => /^The following sleep states are available/i.test(l.trim()));
  const headNot = lines.findIndex(l => /^The following sleep states are not available/i.test(l.trim()));
  if (headAvail < 0) {
    return { ok: false, reason: 'powercfg /a answered in a layout this parser does not know ("' + (lines[0] || '').trim().slice(0, 60) + '")' };
  }
  const availEnd = headNot > headAvail ? headNot : lines.length;
  const available = lines.slice(headAvail + 1, availEnd).map(l => l.trim()).filter(Boolean);
  // Reasons are the more-indented lines under each unavailable state's name.
  const why = {};
  let current = null;
  if (headNot >= 0) {
    for (const raw of lines.slice(headNot + 1)) {
      if (!raw.trim()) continue;
      if (/^\s{4}\S/.test(raw) && !/^\t/.test(raw)) { current = raw.trim(); why[current] = []; }
      else if (current) why[current].push(raw.trim());
    }
  }
  const hibernate = available.some(s => /^Hibernate$/i.test(s));
  const standby = available.filter(s => /^Standby/i.test(s));
  return {
    ok: true,
    hibernate,
    hibernateWhy: hibernate ? '' : ((why.Hibernate || []).join(' ') || 'powercfg /a does not list it as available'),
    sleep: standby.length > 0,
    sleepMode: standby[0] || '',
    sleepWhy: standby.length ? '' : 'powercfg /a lists no standby state as available',
    fastStartup: available.some(s => /^Fast Startup$/i.test(s)),
  };
}

/* Shut down does what Start's Shut down does. With Fast Startup on, Start performs a HYBRID
   shutdown (the kernel session hibernates, so the next boot is faster); `shutdown /s` alone is a
   full one. Owen asked Mantle to replace Start, so it follows his Fast Startup setting rather
   than picking for him: /hybrid only while powercfg /a lists Fast Startup, and a full shutdown
   when it does not or when the states could not be read (the safe, always-valid choice). */
function shutdownArgs(states) {
  return states && states.ok && states.fastStartup ? ['/s', '/hybrid', '/t', '0'] : ['/s', '/t', '0'];
}

/* The newest powercfg /a answer, kept by buildPower for power(). Process-wide (G) and read again
   only after SLEEP_TTL_MS: the launcher now refreshes its index when it opens (to catch a new
   app), and a powercfg process on every open would be waste - the sleep states change only when
   someone turns hibernation on or off. */
const SLEEP_TTL_MS = 10 * 60 * 1000;
let lastSleepStates = G.sleep && G.sleep.states;

async function buildPower() {
  let states;
  if (G.sleep && Date.now() - G.sleep.at < SLEEP_TTL_MS) states = G.sleep.states;
  else {
    states = await readSleepStates();
    G.sleep = { at: Date.now(), states };
  }
  lastSleepStates = states;
  const notes = [];
  const items = [];
  for (const p of POWER) {
    if (p.action === 'hibernate') {
      if (!states.ok) { notes.push('Hibernate left out: ' + states.reason); continue; }
      if (!states.hibernate) { notes.push('Hibernate left out: ' + states.hibernateWhy); continue; }
    }
    if (p.action === 'sleep' && states.ok && !states.sleep) { notes.push('Sleep left out: ' + states.sleepWhy); continue; }
    items.push({
      id: stableId('power', p.action),
      kind: 'power',
      name: p.name,
      subtitle: p.subtitle,
      path: p.action,                    // for a power row the "path" IS the action
      icon: null,
      glyph: p.glyph,
      keywords: p.keywords,
      confirm: p.confirm || null,
    });
  }
  return { items, status: 'ok', reason: notes.join('; ') };
}

/* ---- build -------------------------------------------------------------- */

/* A Store app's icon comes through the same resolver, as 'shell:AppsFolder\<aumid>' - which only a
   main that routes that prefix to the sidecar's `app` command can answer. ONE icon is asked first;
   if it comes back empty, the rest are not asked (each miss would be a sidecar warning in the log),
   and the probe is tried again after ICON_RETRY_MS. Until then those rows wear a letter tile. */
async function fillStoreIcons(items, icon, capMs) {
  if (!items.length || typeof icon !== 'function' || capMs <= 0) return;
  const probe = G.storeIcons;
  if (!probe || (!probe.ok && Date.now() - probe.at >= ICON_RETRY_MS)) {
    let url = null;
    try { url = await icon(items[0].path); } catch (_) { url = null; }
    G.storeIcons = { ok: !!url, at: Date.now() };
    if (url) iconCache.set(items[0].path, iconFresh.stamp({ url, at: Date.now() }, items[0].path));
  }
  if (!G.storeIcons.ok) return;
  await fillIcons(items, icon, capMs);
}

function capWait(p, ms) {
  let timer;
  return Promise.race([p, new Promise(r => { timer = setTimeout(r, ms); if (timer.unref) timer.unref(); })])
    .then(() => clearTimeout(timer));
}

async function build({ icon } = {}) {
  const t0 = Date.now();
  const lnk = buildApps();
  const commands = buildCommands();
  const settings = buildSettings();
  const powerP = buildPower();          // powercfg runs while the icons load
  const store = storeNow();             // cached; a stale one is re-read in the background
  G.iconFail = '';                      // this build's failures only: a sidecar that came back is not still "down"

  // icons only make sense for .lnk files; commands/settings draw a glyph
  // (Mantle's own rows in place of Windows' already carry Mantle's icon: standInApps)
  const lnkIcons = fillIcons(lnk.items.filter(it => !it.mantleApp), icon);
  // the very first build waits for the Store list, never longer than the icons may take
  if (!store.list && store.pending) await capWait(store.pending, ICON_CAP_MS);
  const lnkNames = new Set(lnk.items.map(i => i.name.toLowerCase()));
  const storeList = storeItems(store.list, lnkNames);
  const storeIconsP = fillStoreIcons(storeList, icon, ICON_CAP_MS - (Date.now() - t0));
  const { pending } = await lnkIcons;
  await storeIconsP;
  const power = await powerP;

  const apps = {
    items: lnk.items.concat(storeList).sort((a, b) => a.name.localeCompare(b.name)),
    status: lnk.status === 'ok' || storeList.length ? 'ok' : lnk.status,
    reason: lnk.status === 'ok' ? lnk.reason : (storeList.length ? '' : lnk.reason),
  };
  let iconsPart = '';
  if (apps.status === 'ok') {
    if (G.iconFail) iconsPart = 'icons unavailable: ' + G.iconFail;
    else if (pending > 0) iconsPart = pending + ' icons still loading, they appear next time you open this';
  }

  // a Mantle row that took Windows' shortcut's place in Apps is listed once, there (standInApps)
  const inApps = new Set(apps.items.filter(i => i.mantleApp).map(i => i.path));
  const items = apps.items.concat(commands.items, settings.items.filter(i => !inApps.has(i.path)), power.items);
  const appsSource = { name: 'apps', count: apps.items.length, status: apps.status, reason: joinReasons([apps.reason, storePart(store), iconsPart]) };
  const sources = [
    appsSource,
    { name: 'commands', count: commands.items.length, status: commands.status, reason: commands.reason },
    { name: 'settings', count: settings.items.length, status: settings.status, reason: settings.reason },
    { name: 'power', count: power.items.length, status: power.status, reason: power.reason },
  ];

  /* A build that missed the Store list (under start-up load Get-StartApps outlasts the ICON_CAP_MS
     wait) takes it in AS SOON AS it lands, not at the next rebuild ten minutes on: the Store rows
     are spliced into this build's own arrays IN PLACE, the way late icons are (lib/apps.js keeps
     these very arrays), so apps.index, apps.launch and the empty-query grid all have them.
     MEASURED: without this, Electron --test showed "Store apps 0" 25 s after start. Once per
     build, never a rebuild: a read that fails or never answers only changes the words. */
  if (!store.list) {
    const merge = () => mergeLateStore({ items, appsSource, appsLen: apps.items.length, lnk, lnkNames, iconsPart, icon });
    if (G.store && G.store.list) merge();                              // it landed while the icons loaded
    else if (store.pending) store.pending.then(merge, merge);
  }
  return { items, sources };
}

function joinReasons(parts) { return parts.filter(Boolean).join('; '); }

/** The Store part of the apps source's reason: '' once the list is in. */
function storePart(st) {
  if (st && st.list) return '';
  if (st && !st.ok && st.reason) return 'Store apps are missing: ' + st.reason;
  if (st && !st.pending) return 'Store apps are missing: Windows did not list them';
  return 'Store apps are still loading';
}

/** Splice a Store list that arrived after the build into that build's items + apps source. */
function mergeLateStore({ items, appsSource, appsLen, lnk, lnkNames, iconsPart, icon }) {
  const st = G.store;
  if (items.some(i => i && i.aumid)) return;                          // already in (never twice)
  const late = st && st.list ? storeItems(st.list, lnkNames) : [];
  if (late.length) {
    const appRows = items.slice(0, appsLen).concat(late).sort((a, b) => a.name.localeCompare(b.name));
    items.splice(0, appsLen, ...appRows);
    appsSource.count += late.length;
    appsSource.status = 'ok';
    // icons in the background, in place: they show from the next keystroke (the probe caps the asks)
    fillStoreIcons(late, icon, ICON_CAP_MS).catch(() => {});
  }
  const base = lnk.status === 'ok' ? lnk.reason : (late.length ? '' : lnk.reason);
  appsSource.reason = joinReasons([base, storePart(st), iconsPart]);
}

/* ---- search ------------------------------------------------------------- */

/* lib/launcher-layouts.js (lane layouts): its rows are never cached here (this file is re-required
   on every rebuild), and a missing or broken module costs only the layout rows. */
function layoutRows() {
  try { return require('./launcher-layouts').rows(); } catch (_) { return []; }
}

const KIND_ORDER = { app: 0, command: 1, setting: 2, power: 3, url: 4, file: 5 };
const LIMIT = 12;

/* "does it look like somewhere to go?" — http(s) always, otherwise one token
   with a dot and a letter suffix. Deliberately loose: a false positive costs a
   row you ignore, a false negative costs you the ability to type a domain. */
function looksLikeUrl(q) {
  if (/^https?:\/\//i.test(q)) return true;
  if (/\s/.test(q)) return false;
  return /^[a-z0-9][a-z0-9.\-]*\.[a-z]{2,}(?:[/:?#].*)?$/i.test(q);
}
function normalizeUrl(q) { return /^https?:\/\//i.test(q) ? q : 'https://' + q; }

/* Is `q` a subsequence of `s`? Returns a score that prefers matches whose
   letters sit close together and early, so "chr" beats a match scattered over
   twenty characters. -1 when there is no match at all. */
function subsequenceScore(s, q) {
  let si = 0, first = -1, last = -1;
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi];
    const at = s.indexOf(c, si);
    if (at === -1) return -1;
    if (first === -1) first = at;
    last = at;
    si = at + 1;
  }
  const spread = last - first + 1;
  return Math.max(0, 200 - (spread - q.length) * 6 - first * 2);
}

/* Power rows score on their own rules (see source 4 for why):
 *   the whole name or a whole keyword ("reboot", "log out")       1000, like any exact name
 *   under three letters                                           never
 *   a prefix of the name or a keyword ("shut", "rebo")            700..760, BELOW an app whose
 *                                                                 name starts the same way
 *   a word inside one ("down", "off")                             690
 *   the group word ("power", "session")                           650, under PowerShell and
 *                                                                 "Power & battery"
 * Returns -1 when nothing matches. */
function scorePower(item, q) {
  const words = [item.name.toLowerCase()].concat(item.keywords || []);
  for (const w of words) if (w === q) return 1000;
  if (q.length < 3) return -1;
  let best = -1;
  for (const w of words) {
    if (w.startsWith(q)) best = Math.max(best, 760 - Math.min(60, w.length - q.length));
    else if (w.split(/\s+/).some(part => part.startsWith(q))) best = Math.max(best, 690);
  }
  if (best >= 0) return best;
  const group = (item.subtitle || '').toLowerCase().split(/[^a-z]+/)[0];
  if (POWER_GROUP_WORDS.includes(group) && group.startsWith(q)) return 650;
  return -1;
}

/* A Settings page found by words that are not in its name ("dark mode" -> Colors, "uninstall" ->
 * Installed apps). item.keywords is the table's keyword string, lowercased. Deliberately BELOW the
 * name tiers that matter:
 *   a whole word or phrase in it ("dark mode")   880   under an exact name (1000), so "sleep" stays
 *                                                      the Sleep action and "lock" stays Lock
 *   the start of one ("wallp", "dark m")         760   (2+ letters)
 *   every typed word starts a keyword word       700   ("mode dark"; 3+ letters)
 * -1 when nothing matches. */
function scoreSettingKeywords(item, q) {
  const text = item.keywords;
  if (typeof text !== 'string' || !text) return -1;
  const hay = ' ' + text + ' ';
  if (hay.includes(' ' + q + ' ')) return 880;
  if (q.length >= 2 && hay.includes(' ' + q)) return 760;
  if (q.length >= 3) {
    const typed = q.split(/\s+/).filter(Boolean);
    const words = text.split(' ');
    if (typed.length > 1 && typed.every(t => words.some(w => w.startsWith(t)))) return 700;
  }
  return -1;
}

function scoreItem(item, q) {
  if (item.kind === 'power') return scorePower(item, q);
  const s = ((item.kind === 'setting' || item.mantleApp) && item.keywords) ? Math.max(scoreByName(item, q), scoreSettingKeywords(item, q)) : scoreByName(item, q);
  // Windows' own Settings / Task Manager: always found, always just under Mantle's (standInApps)
  return (item.secondary && s >= 0) ? Math.max(0, s - SECONDARY_PENALTY) : s;
}

function scoreByName(item, q) {
  const name = item.name.toLowerCase();
  const sub = (item.subtitle || '').toLowerCase();

  if (name === q) return 1000;
  if (name.startsWith(q)) return 900 - Math.min(80, name.length - q.length);

  // a prefix of any word inside the name: "term" -> "Windows Terminal"
  const words = name.split(/[^a-z0-9]+/).filter(Boolean);
  for (const w of words) if (w.startsWith(q)) return 800 - Math.min(80, name.length - q.length);

  // subtitle matches are real but weaker: "sett" finds every Settings page,
  // "vs code" finds everything in the "Visual Studio Code" folder
  if (sub === q) return 520;
  if (sub.startsWith(q)) return 500;
  const subWords = sub.split(/[^a-z0-9]+/).filter(Boolean);
  for (const w of subWords) if (w.startsWith(q)) return 460;

  const seq = subsequenceScore(name, q);
  if (seq >= 0) return 200 + seq;              // 200..400
  if (sub.includes(q)) return 150;
  return -1;
}

function search(q, items) {
  // + the window layouts' rows ("school" -> Layout: Work), asked for fresh on every search
  /* The Store list can land AFTER the build that missed it (the first build waits only ICON_CAP_MS
     for a ~4 s Get-StartApps, and main keeps that build ten minutes): while the index has no Store
     rows at all, they are added here from the shared cache, so they are searchable the moment
     Windows answers. Their ids are the build's own, so apps.launch finds them in lib/apps.js's
     lastHits. (build() now splices them into its own arrays when they land - mergeLateStore -
     so this is the fallback for an items array that did not come from a build.) */
  const base = Array.isArray(items) ? items : [];
  let late = [];
  if (G.store && G.store.list && G.store.list.length && !base.some(i => i && i.aumid)) {
    late = storeItems(G.store.list, new Set(base.filter(i => i && i.kind === 'app').map(i => String(i.name).toLowerCase())));
  }
  const list = base.concat(late, layoutRows());
  const query = String(q == null ? '' : q).trim().toLowerCase();

  if (!query) {
    /* Empty query: Owen's own commands first — his `dash`, `bot`, `northwind` are
       what he reaches for, and they are unguessable from an icon grid — then
       apps alphabetically to fill the twelve. (Never a power row: Enter on an
       empty launcher must not be able to lock or sleep the machine.) */
    const cmds = list.filter(i => i.kind === 'command');
    const apps = list.filter(i => i.kind === 'app');
    return cmds.slice(0, LIMIT).concat(apps.slice(0, Math.max(0, LIMIT - Math.min(cmds.length, LIMIT))));
  }

  const scored = [];
  for (const it of list) {
    const s = scoreItem(it, query);
    if (s >= 0) scored.push({ it, s });
  }
  scored.sort((a, b) => (
    b.s - a.s ||
    (KIND_ORDER[a.it.kind] ?? 9) - (KIND_ORDER[b.it.kind] ?? 9) ||
    a.it.name.localeCompare(b.it.name) ||
    a.it.id.localeCompare(b.it.id)              // last tie-break: never reorder run to run
  ));

  /* Each row carries its score (on a COPY: the cached index objects stay clean) so the launcher
     can slot file results in among these by the same scale - see fileScore(). */
  const out = scored.map(x => Object.assign({}, x.it, { score: x.s }));

  if (looksLikeUrl(query)) {
    const url = normalizeUrl(String(q).trim());
    out.unshift({
      id: stableId('url', url),
      kind: 'url',
      name: 'Open ' + String(q).trim(),
      subtitle: 'in your browser',
      path: url,
      icon: null,
      score: 1100,                     // it was put first on purpose; keep it there after a merge
    });
  }
  return capByGroup(out);
}

/* The launcher shows these rows in GROUPS since Win+S (ui/launcher/groups.js), so the twelve are
   shared out rather than taken off the top: "s" matches forty apps, and a plain top-12 would leave
   no room for the Settings pages it also matches. Best-first within each group, the caps below,
   and still never more than LIMIT (lib/apps.js cuts at 12 as well). */
// app 5, not 6: with the Store apps indexed, "power" matched six apps (Power Automate and its
// Troubleshooter joined the four PowerShells) and pushed Sleep out of the twelve.
const GROUP_CAP = { app: 5, command: 4, setting: 4, power: 6, url: 1 };   // "power" lists them all
function capByGroup(rows) {
  const used = {};
  const out = [];
  for (const r of rows) {
    const cap = GROUP_CAP[r.kind] || LIMIT;
    if ((used[r.kind] || 0) >= cap) continue;
    used[r.kind] = (used[r.kind] || 0) + 1;
    out.push(r);
    if (out.length >= LIMIT) break;
  }
  return out;
}

/* ---- launch ------------------------------------------------------------- */

// Quartz (lib/quartz-exe.js): started as Quartz.exe when it exists, else as its bare electron.exe.
// Resolved per launch, not at load: an Electron update removes Quartz.exe until its generator re-runs.
const BROWSER_DIR = QUARTZ.BROWSER_DIR;
let browserExists = (p) => { try { return fs.existsSync(p); } catch (_) { return false; } };   // tests swap this
const browserExe = () => QUARTZ.browserExe({ exists: browserExists });

function spawnDetached(exe, args) {
  // detached + unref so closing Mantle never takes the launched app with it
  const child = cp.spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  return child;
}

/* Every branch below returns a plain-words reason on failure. The renderer
   prints it under the row and keeps the launcher open, so a launch can never
   just "do nothing". */
/* Windows' own Task Manager: the Start Menu shortcut the Mantle row took the place of, else
   Taskmgr.exe. Through Electron's shell when there is one (read NOW, so a test's fake is used). */
async function openWindowsTaskManager(item) {
  const exe = path.join(SYS32, 'Taskmgr.exe');
  const target = item && item.windowsPath && fs.existsSync(item.windowsPath) ? item.windowsPath : exe;
  const sh = electron && electron.shell && typeof electron.shell.openPath === 'function' ? electron.shell : null;
  try {
    if (sh) {
      const err = await sh.openPath(target);
      return err ? { ok: false, reason: 'Windows refused to open ' + target + ': ' + err } : { ok: true };
    }
    spawnDetached('cmd', ['/c', 'start', '', target]);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: 'could not start ' + target + ': ' + String((err && err.message) || err) };
  }
}

/** Windows' File Explorer, at `folder` when given: the launcher's fallback while Mantle Files is off. */
async function openWindowsExplorer(item, folder) {
  const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe');
  const target = folder || (item && item.windowsPath && fs.existsSync(item.windowsPath) ? item.windowsPath : exe);
  const sh = electron && electron.shell && typeof electron.shell.openPath === 'function' ? electron.shell : null;
  try {
    if (sh) {
      const err = await sh.openPath(target);
      return err ? { ok: false, reason: 'Windows refused to open File Explorer: ' + err } : { ok: true };
    }
    spawnDetached(exe, folder ? [folder] : []);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: 'could not start File Explorer: ' + String((err && err.message) || err) };
  }
}

async function launch(item, { dryRun, spotifyPort } = {}) {
  if (!item || !item.kind) return { ok: false, reason: 'that row has no item attached (a bug in the launcher)' };
  // a window layout row (lib/launcher-layouts.js): before the generic 'mantle:' branch below
  if (item.kind === 'setting' && /^mantle:layout:/.test(String(item.path))) return require('./launcher-layouts').run(item.path, { dryRun: !!dryRun });
  /* Mantle Settings (lane settings): its own row, and the Windows pages it covers (MANTLE_SETTINGS).
     Asked through the same 'mantle-open' event as the Wallpapers row, with a reply object that
     lib/features/settings.js fills in: it is the only way to know it really opened, because any
     listener (the wallpaper library's) makes app.emit return true. Not opened (off, resting, not
     loaded) = Windows' own page opens instead, and the row says why. */
  // lane wire: a page a section module claims (coverOf) opens Mantle's page too, at its section/page/row
  const cover = (item.kind === 'setting' || item.mantleApp) && MS_URI_RE.test(String(item.path)) ? coverOf(item.path) : null;
  const mantleSettings = (item.kind === 'setting' || item.mantleApp) && (String(item.path) === 'mantle:settings' || cover);
  let fellBack = '';
  if (mantleSettings) {
    const to = cover || { section: null, page: null, row: null };
    const winUri = cover ? item.path : 'ms-settings:';
    if (dryRun) return { ok: true, reason: 'dry run: would open Mantle Settings' + (to.section ? ' at ' + to.section + (to.page ? '/' + to.page : '') : '') + ' (Windows\' ' + winUri + ' if Mantle Settings is off)' };
    const app = electron && electron.app;
    const reply = { handled: false, ok: false, reason: null };
    if (app && typeof app.emit === 'function') app.emit('mantle-open', 'settings', { section: to.section, page: to.page, row: to.row, uri: winUri, via: 'the launcher', reply });
    if (reply.handled && reply.ok) return { ok: true };
    fellBack = 'opened Windows Settings: ' + (reply.handled ? (reply.reason || 'Mantle Settings did not open and did not say why') : 'Mantle Settings is not running');
    item = Object.assign({}, item, { path: winUri, kind: 'setting', mantleApp: null });
  }

  /* Work out the exact command first, so the dry run can quote it verbatim. */
  let exe = null, args = null, via = '';
  let note = fellBack;

  if (item.kind === 'app' && item.aumid) {
    /* A Store app (source 1b): Start's own way in, shell:AppsFolder\<aumid> through Explorer. The
       AUMID is checked again here, so nothing but a package id can ever reach that argument. */
    if (!AUMID_RE.test(String(item.aumid))) return { ok: false, reason: 'that Store app has an id Mantle does not trust, so it was not opened' };
    exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe');
    args = ['shell:AppsFolder\\' + item.aumid];
    via = 'explorer.exe shell:AppsFolder\\' + item.aumid;
  } else if (item.kind === 'app' && !item.mantleApp) {
    if (!fs.existsSync(item.path)) {
      const gone = 'the shortcut is gone from disk: ' + item.path;
      if (dryRun) return { ok: true, reason: 'dry run: would open ' + item.path + ' (but the file is missing)' };
      return { ok: false, reason: gone };
    }
    /* Spotify, not running, while the Spotify queue is on (main passes spotifyPort): start it with Up
       next's port the way the now-playing card does (lib/spotify-launch.js). Anything else, or a
       Spotify already running, opens below exactly as before; a failed flagged start says why. */
    if (spotifyPort) {
      const sp = await require('./spotify-launch').launchSpotifyWithPort({ path: item.path }, { dryRun, source: 'the launcher' });
      if (sp.handled) return sp.dryRun ? { ok: true, reason: sp.reason } : { ok: true };
      if (sp.spotify && sp.why && !sp.quiet) note = sp.why;
    }
    if (shell) via = 'shell.openPath(' + quote(item.path) + ')';
    else { exe = 'cmd'; args = ['/c', 'start', '', item.path]; via = 'cmd /c start "" ' + quote(item.path); }
  } else if ((item.kind === 'setting' || item.mantleApp) && /^mantle:/.test(String(item.path))) {
    /* One of Mantle's own windows. Raised as an event on the Electron app, not called on a module,
       because lib/apps.js re-requires this file on every rebuild and a registry kept here would be
       wiped each time; lib/wallpaper.js listens for 'mantle-open' on app. */
    const target = String(item.path).slice('mantle:'.length);
    if (dryRun) return { ok: true, reason: 'dry run: would open Mantle\'s ' + target + ' window' };
    const app = electron && electron.app;
    if (!app || typeof app.emit !== 'function') return { ok: false, reason: 'Mantle\'s ' + target + ' window can only open inside Mantle itself' };
    /* The task manager listens on its OWN event, and only while it is on and awake: the shared
       'mantle-open' always has the wallpaper library listening, so its emit() says nothing. */
    if (target === 'taskmgr' || target === 'taskmgr:game') {
      if (typeof app.listenerCount !== 'function' || app.listenerCount('mantle-open:taskmgr') === 0) {
        /* Off or resting: WINDOWS' Task Manager opens instead, and the row says why (icons lane,
           2026-09-28; the same road as Mantle Settings above). "Get ready to game" is Mantle's
           alone: Windows has nothing like it, so that row still refuses with the reason. */
        const off = 'Mantle\'s task manager is off or resting while a game runs';
        if (target === 'taskmgr:game') return { ok: false, reason: off };
        const r = await openWindowsTaskManager(item);
        return r.ok ? { ok: true, reason: 'opened Windows Task Manager: ' + off }
          : { ok: false, reason: off + ', and Windows Task Manager did not open either: ' + r.reason };
      }
      app.emit('mantle-open:taskmgr', target === 'taskmgr:game' ? 'game' : 'apps');
      return { ok: true };
    }
    /* Clips (lane mantle-clips2) listens on its own event while it is on (lib/features/clips.js):
       off, the row says so (Windows' Game Bar gallery is Win+G then; nothing else opens unasked). */
    if (target === 'clips') {
      if (typeof app.listenerCount !== 'function' || app.listenerCount('mantle-open:clips') === 0) return { ok: false, reason: 'Mantle Clips is off (Settings > Mantle)' };
      app.emit('mantle-open:clips', { via: 'the launcher' });
      return { ok: true };
    }
    /* Mantle Files listens on its OWN event only while on (lib/features/files.js), like the task
       manager: off or resting, WINDOWS' File Explorer opens instead and the row says why. */
    if (target === 'files' || target.startsWith('files:')) {
      const folder = target.slice(6) || undefined;
      if (typeof app.listenerCount !== 'function' || app.listenerCount('mantle-open:files') === 0) {
        const off = 'Mantle Files is off or resting while a game runs';
        const r = await openWindowsExplorer(item, folder);
        return r.ok ? { ok: true, reason: 'opened File Explorer: ' + off }
          : { ok: false, reason: off + ', and File Explorer did not open either: ' + r.reason };
      }
      const reply = {};
      app.emit('mantle-open:files', { path: folder, via: 'the launcher', reply });
      if (reply.handled && !reply.ok) return { ok: false, reason: reply.reason || 'Mantle Files did not open, and gave no reason' };
      return { ok: true };
    }
    /* Mantle Player (lane mantle-player) listens on its own event while on: off, WINDOWS' Media Player opens
       instead (the Store row's own path) and the row says why. */
    if (target === 'player') {
      if (typeof app.listenerCount !== 'function' || app.listenerCount('mantle-open:player') === 0) {
        const off = 'Mantle Player is switched off (Settings > Mantle)';
        if (!item.windowsPath) return { ok: false, reason: off };
        try { await (electron.shell ? electron.shell.openExternal(item.windowsPath) : Promise.reject(new Error('no shell here'))); return { ok: true, reason: 'opened Media Player: ' + off }; } catch (e) { return { ok: false, reason: off + ', and Media Player did not open either: ' + e.message }; }
      }
      const reply = {};
      app.emit('mantle-open:player', { via: 'the launcher', reply });
      if (reply.handled && !reply.ok) return { ok: false, reason: reply.reason || 'Mantle Player did not open, and gave no reason' };
      return { ok: true };
    }
    if (!app.emit('mantle-open', target)) return { ok: false, reason: 'nothing in Mantle opens "' + target + '" (lib/wallpaper.js did not load?)' };
    return { ok: true };
  } else if (item.kind === 'setting') {
    if (shell) via = 'shell.openExternal(' + quote(item.path) + ')';
    else { exe = 'cmd'; args = ['/c', 'start', '', item.path]; via = 'cmd /c start "" ' + quote(item.path); }
  } else if (item.kind === 'command') {
    const wt = onPath('wt.exe');
    if (wt) {
      exe = wt;
      args = ['-w', '0', 'nt', 'powershell', '-NoExit', '-Command', item.path];
      via = 'wt.exe -w 0 nt powershell -NoExit -Command ' + quote(item.path);
    } else {
      exe = 'cmd';
      args = ['/c', 'start', '', 'powershell', '-NoExit', '-Command', item.path];
      via = 'cmd /c start "" powershell -NoExit -Command ' + quote(item.path);
      note = 'opened in a plain PowerShell window: wt.exe not found';
    }
  } else if (item.kind === 'url') {
    const bexe = browserExe();
    if (!browserExists(bexe)) {
      const missing = 'your browser is not installed at ' + bexe;
      if (dryRun) return { ok: true, reason: 'dry run: would run ' + quote(bexe) + ' ' + quote(BROWSER_DIR) + ' ' + quote(item.path) + ' (but the browser is missing)' };
      return { ok: false, reason: missing };
    }
    exe = bexe;
    args = [BROWSER_DIR, item.path];
    via = quote(bexe) + ' ' + quote(BROWSER_DIR) + ' ' + quote(item.path);
  } else if (item.kind === 'power') {
    /* Never from here: this path has no confirm step and no dry-run switch of its own, and a
       power row that reached it would shut the machine down on one Enter. power() is the way. */
    return { ok: false, reason: item.name + ' runs through launcher.power (which asks first), not apps.launch' };
  } else {
    return { ok: false, reason: 'the launcher does not know how to open a "' + item.kind + '"' };
  }

  if (dryRun) return { ok: true, reason: 'dry run: would run ' + via + (note ? ' — ' + note : '') };

  try {
    if (!exe && shell) {
      if (item.kind === 'app') {
        const err = await shell.openPath(item.path);   // '' on success, a message on failure
        if (err) return { ok: false, reason: 'Windows refused to open it: ' + err };
      } else {
        await shell.openExternal(item.path);
      }
    } else {
      spawnDetached(exe, args);
    }
  } catch (err) {
    return { ok: false, reason: 'could not start it: ' + String((err && err.message) || err) };
  }
  return note ? { ok: true, reason: note } : { ok: true };
}

/* ---- power: run one of source 4's actions -------------------------------
 *
 * Called by main's `launcher.power` with { action, confirmed } from the launcher and { sidecar,
 * dryRun } from main. Always resolves { ok, reason?, dryRun? }; the launcher prints the reason
 * under the row.
 *
 * THE DRY RUN is the only way any of this has been exercised on Owen's machine: a real lock or
 * sleep would end his session mid-lesson. It is on when main passes dryRun (main does for a
 * --test instance) or when MANTLE_POWER_DRYRUN=1 is in the environment, and it logs
 * "would run: …" and answers the same line instead of running anything. The one place a real
 * action starts is runPowerExe(), and every path to it goes through the `dry` check first. */
async function power(a, { sidecar, dryRun } = {}) {
  const action = String((a && a.action) || '');
  const def = POWER.find(p => p.action === action);
  if (!def) return { ok: false, reason: 'there is no power action called "' + action + '"' };
  if (def.confirm && !(a && a.confirmed === true)) {
    return { ok: false, reason: def.name + ' asks first: press Enter on it twice' };
  }
  const run = POWER_RUN[action];
  const dry = !!dryRun || process.env.MANTLE_POWER_DRYRUN === '1';

  if (run.sidecar) {
    if (typeof sidecar !== 'function') return { ok: false, reason: def.name + ' is unavailable right now: the Mantle helper is not connected' };
    let res;
    try {
      res = await sidecar(run.sidecar, { action, dryRun: dry }, 4000);
    } catch (err) {
      const m = String((err && err.message) || err);
      if (/unknown command/i.test(m)) {
        // (the running sidecar predates sidecar/Session.cs)
        return { ok: false, reason: def.name + ' needs a newer Mantle helper: restart Mantle to update it' };
      }
      return { ok: false, reason: def.name + ' did not happen: ' + m };
    }
    if (!res || res.ok !== true) return { ok: false, reason: def.name + ' did not happen: ' + ((res && res.reason) || 'Windows said no and gave no reason') };
    if (dry) {
      const line = 'would call ' + (res.wouldCall || '?') + ' in the sidecar after ' + res.afterMs + ' ms (' + (res.mode || 'unknown sleep mode') + ')';
      process.stdout.write('mantle: power dry run: ' + line + '\n');
      return { ok: true, dryRun: true, reason: 'dry run: ' + line };
    }
    return { ok: true };
  }

  const exe = path.join(SYS32, run.exe);
  const args = action === 'shutdown' ? shutdownArgs(lastSleepStates || await readSleepStates()) : run.args;
  const line = quote(exe) + ' ' + args.join(' ');
  if (dry) {
    process.stdout.write('mantle: power dry run: would run: ' + line + '\n');
    return { ok: true, dryRun: true, reason: 'dry run: would run ' + line };
  }
  if (!fs.existsSync(exe)) return { ok: false, reason: def.name + ' did not happen: ' + exe + ' is missing' };
  return runPowerExe(def, exe, args);
}

/* Starts the exe and waits a moment for it to fail. shutdown.exe exits within ~100 ms with a
   non-zero code and a sentence on stderr when it refuses ("A system shutdown has already been
   scheduled.(1190)"), and that sentence is the reason the launcher shows. One that is still
   running when the wait ends (shutdown /h returns only after the machine wakes) has not failed. */
function runPowerExe(def, exe, args) {
  return new Promise((resolve) => {
    let child;
    let err = '';
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    try {
      child = cp.spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      finish({ ok: false, reason: def.name + ' did not happen: ' + String((e && e.message) || e) });
      return;
    }
    child.stdout.on('data', (d) => { err += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => finish({ ok: false, reason: def.name + ' did not happen: ' + String((e && e.message) || e) }));
    child.on('exit', (code) => {
      if (code === 0 || code === null) finish({ ok: true });
      else finish({ ok: false, reason: def.name + ' did not happen: ' + path.basename(exe) + ' exited ' + code + (err.trim() ? ' — ' + err.trim().split(/\r?\n/)[0] : '') });
    });
    const t = setTimeout(() => finish({ ok: true }), 1500);
    if (t.unref) t.unref();
  });
}

/* ---- files: the Windows Search index, via sidecar/Search.cs ---------------
 *
 * Called by main's `launcher.files` with { q } and { sidecar }. Resolves
 *   { ok:true, q, items, ms, reason }  items already scored and capped at FILE_LIMIT
 *   { ok:true, q, superseded:true }    a newer query took over; the launcher ignores it
 *   { ok:false, q, items:[], reason }  why there are no file results, in words
 *
 * RANKING. The sidecar returns name-prefix matches first, then word-prefix ones, newest first
 * within each; this re-scores them on the same scale as the apps so the launcher can merge the
 * two lists. A file tops out at 700 (its whole name, extension aside) and a prefix lands at
 * 660-690, so an app whose name starts with the query (820-900) always stays above it and an app
 * that only matched loosely (a subsequence, 200-400) falls below it. Ties go to the app. Within
 * the files, a name that is a closer fit wins, then the personal folders (Desktop, Documents,
 * Downloads, OneDrive, Pictures, Videos, Music) over the rest of the profile, then the newest -
 * FILE_FETCH candidates are asked for so that ordering has something to choose from. */
const FILE_LIMIT = 8;
const FILE_FETCH = 24;
const FILE_MIN_CHARS = 2;          // one letter matches half the disk: MEASURED 1.3 s for "a"
const PERSONAL = /^(desktop|documents|downloads|onedrive[^\\]*|pictures|videos|music)(\\|$)/i;

function fileScore(name, q) {
  const lower = name.toLowerCase();
  const stem = lower.replace(/\.[^.\\]{1,8}$/, '');
  let s = Math.max(scoreItem({ kind: 'file', name: stem, subtitle: '' }, q),
                   scoreItem({ kind: 'file', name: lower, subtitle: '' }, q));
  if (s < 0) s = 100;             // the index matched it by a rule this scorer does not share
  return 500 + Math.round(s / 5);
}

function tildePath(folder) {
  const home = os.homedir();
  if (folder && folder.toLowerCase().startsWith(home.toLowerCase())) return '~' + folder.slice(home.length);
  return folder || '';
}

/* `cmd`: which sidecar command answers. main.js's launcher.files uses the original `search`
   (sidecar/Search.cs); the Win+S feature (lib/features/search.js) uses `search.files`
   (sidecar/SearchIndex.cs), which adds the contains tier. Same request, same answer shape. */
async function files(a, { sidecar, cmd } = {}) {
  const command = cmd || 'search';
  const q = String((a && a.q) || '').trim();
  if (q.length < FILE_MIN_CHARS) return { ok: true, q, items: [], reason: '' };
  if (typeof sidecar !== 'function') return { ok: false, q, items: [], reason: 'File search is unavailable right now: the Mantle helper is not connected' };
  let res;
  try {
    res = await sidecar(command, { q, max: FILE_FETCH, scope: os.homedir(), ttl: 5000 }, 6000);
  } catch (err) {
    const m = String((err && err.message) || err);
    if (/^cancelled$/i.test(m)) return { ok: true, q, superseded: true, items: [] };
    if (/unknown command/i.test(m)) {
      // (the running sidecar predates sidecar/Search.cs or SearchIndex.cs)
      return { ok: false, q, items: [], reason: 'File search needs a newer Mantle helper: restart Mantle to update it' };
    }
    return { ok: false, q, items: [], reason: 'File search did not answer: ' + m };
  }
  if (!res || res.ok !== true) return { ok: false, q, items: [], reason: (res && res.reason) || 'File search answered without results or a reason' };

  const home = os.homedir().toLowerCase();
  const lower = q.toLowerCase();
  const scored = (Array.isArray(res.items) ? res.items : []).map((f, i) => {
    const rel = String(f.folder || '').toLowerCase().startsWith(home + '\\') ? String(f.folder).slice(home.length + 1) : '';
    return {
      f, i,
      s: fileScore(String(f.name || ''), lower),
      personal: PERSONAL.test(rel) || rel === '' ? 1 : 0,
    };
  });
  scored.sort((x, y) => y.s - x.s || y.personal - x.personal || x.i - y.i);
  const items = scored.slice(0, FILE_LIMIT).map(({ f, s }) => ({
    id: stableId('file', f.path),
    kind: 'file',
    name: String(f.name || path.basename(String(f.path))),
    subtitle: tildePath(f.folder),
    path: String(f.path),
    icon: null,
    glyph: f.isDir ? 'folder' : 'file',
    isDir: !!f.isDir,
    modified: f.modified || null,
    score: s,
  }));
  return { ok: true, q, items, ms: res.ms, reason: res.reason || '' };
}

/* Open a file row (Enter) or show it in its folder (Ctrl+Enter). The path comes from the
   renderer, so it is checked, not trusted: absolute, inside the profile the search was scoped
   to, and still on disk. */
async function openFile(a, { dryRun } = {}) {
  const p = String((a && a.path) || '');
  const reveal = !!(a && a.reveal);
  if (!path.isAbsolute(p)) return { ok: false, reason: 'not an absolute path: ' + p };
  const norm = path.normalize(p);
  const home = os.homedir();
  if (!norm.toLowerCase().startsWith(home.toLowerCase() + path.sep)) {
    return { ok: false, reason: 'the launcher only opens files inside ' + home + ', and this is ' + norm };
  }
  if (!fs.existsSync(norm)) return { ok: false, reason: 'it is gone from disk (the search index had not caught up): ' + norm };

  if (reveal) {
    const via = shell && typeof shell.showItemInFolder === 'function'
      ? 'shell.showItemInFolder(' + quote(norm) + ')'
      : 'explorer.exe /select,' + quote(norm);
    if (dryRun) return { ok: true, dryRun: true, reason: 'dry run: would run ' + via };
    try {
      /* Electron's showItemInFolder is SHOpenFolderAndSelectItems: it reuses an Explorer window
         already on that folder instead of opening a second one. Outside Electron, explorer's
         own /select, which takes the path quoted AFTER the comma - hence verbatim arguments. */
      if (shell && typeof shell.showItemInFolder === 'function') shell.showItemInFolder(norm);
      else cp.spawn('explorer.exe', ['/select,"' + norm + '"'], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref();
    } catch (err) {
      return { ok: false, reason: 'could not show it in its folder: ' + String((err && err.message) || err) };
    }
    return { ok: true };
  }

  if (dryRun) return { ok: true, dryRun: true, reason: 'dry run: would open ' + norm + (shell ? ' with shell.openPath' : ' with cmd /c start') };
  try {
    if (shell) {
      const err = await shell.openPath(norm);     // '' on success, a message on failure
      if (err) return { ok: false, reason: 'Windows refused to open it: ' + err };
    } else {
      spawnDetached('cmd', ['/c', 'start', '', norm]);
    }
  } catch (err) {
    return { ok: false, reason: 'could not open it: ' + String((err && err.message) || err) };
  }
  return { ok: true };
}

/* ---- the Win+S rows that are not in the index: the web, and the calculator ----------------
 *
 * "Search the web for …" is the launcher's last row for any query. It opens the SAME way a typed
 * URL does (your browser at ~/browser, the one Mantle treats as yours everywhere), and only when
 * that browser is not installed does it fall back to Windows' default browser - saying so under
 * the row. The URL is built HERE from the text, never taken from the renderer. */
const WEB_ENGINE = { name: 'Google', url: 'https://www.google.com/search?q=' };
const WEB_MAX = 500;

function webSearchUrl(q) {
  const text = String(q == null ? '' : q).trim();
  if (!text) return null;
  return WEB_ENGINE.url + encodeURIComponent(text).replace(/%20/g, '+');
}

async function openWeb(a, { dryRun } = {}) {
  const q = String((a && a.q) || '').trim();
  if (!q) return { ok: false, reason: 'there is nothing typed to search the web for' };
  if (q.length > WEB_MAX) return { ok: false, reason: 'that is too long to search the web for (over ' + WEB_MAX + ' characters)' };
  const url = webSearchUrl(q);
  const bexe = browserExe();
  if (browserExists(bexe)) {
    const res = await launch({ kind: 'url', name: 'Search the web', path: url }, { dryRun });
    return Object.assign({ url, dryRun: !!dryRun }, res);
  }
  const why = 'your browser is not installed at ' + bexe;
  if (dryRun) return { ok: true, dryRun: true, url, reason: 'dry run: would open ' + url + ' in the Windows default browser (' + why + ')' };
  if (!shell || typeof shell.openExternal !== 'function') return { ok: false, reason: why + ', and outside Mantle there is no default browser to hand it to' };
  try {
    await shell.openExternal(url);
  } catch (err) {
    return { ok: false, reason: 'Windows would not open the search page: ' + String((err && err.message) || err) };
  }
  return { ok: true, url, reason: 'opened in the Windows default browser: ' + why };
}

/* The calculator row's Enter: copy the ANSWER. The renderer sends the expression, not the number,
   and it is worked out again here with the same parser (ui/launcher/calc.js), so this command can
   only ever put a computed number on the clipboard - never arbitrary text from a page. A --test
   Mantle is always a dry run: a test must never write Owen's clipboard. */
function copyCalc(a, { dryRun, clipboard } = {}) {
  const expr = String((a && a.expr) || '').trim();
  let calc;
  try { calc = require(path.join(__dirname, '..', 'ui', 'launcher', 'calc.js')); } catch (err) {
    return { ok: false, reason: 'the calculator (ui/launcher/calc.js) would not load: ' + err.message };
  }
  const res = calc.evaluate(expr);
  if (!res) return { ok: false, reason: '"' + expr + '" is not a calculation, so there is no answer to copy' };
  if (!res.ok) return { ok: false, reason: res.reason };
  if (dryRun) return { ok: true, dryRun: true, copied: res.copy, reason: 'dry run: would copy ' + res.copy };
  if (!clipboard || typeof clipboard.writeText !== 'function') return { ok: false, reason: 'the clipboard can only be written inside Mantle itself' };
  try {
    clipboard.writeText(res.copy);
  } catch (err) {
    return { ok: false, reason: 'Windows would not take the copy: ' + String((err && err.message) || err) };
  }
  return { ok: true, copied: res.copy };
}

module.exports = {
  build, search, launch, power, files, openFile, openWeb, webSearchUrl, copyCalc,
  _internals: { fillIcons, looksLikeUrl, scoreItem, stableId, parseSleepStates, shutdownArgs, fileScore, POWER, SETTINGS, MANTLE_SETTINGS, WEB_ENGINE, sectionClaims, coverOf, SECTIONS_DIR, parseStartApps, AUMID_RE, STORE_PS, state: G },
  // tests: a temp Start Menu fixture instead of the real folders; returns the old roots
  _setStartMenuRootsForTest(roots) { const was = START_MENU_ROOTS; START_MENU_ROOTS = roots; return was; },
  // tests: a fake Get-StartApps (() => Promise<{ ok, list, reason }>); returns the old one
  _setStoreRunnerForTest(fn) { const was = storeRunner; storeRunner = fn; G.store = null; G.storeIcons = null; return was; },
  // tests: how long a Store read may take before it counts as "not in time"; returns the old value
  _setStoreGuardForTest(ms) { const was = storeGuardMs; storeGuardMs = ms; return was; },
  // launcher-index.test.js: a fake Electron (just `app`) for the 'mantle:' rows' live branch; returns the old one
  _setElectronForTest(e) { const was = electron; electron = e; return was; },
  // stands in for the disk when asking which Quartz exe exists (Quartz.exe / electron.exe); returns the old one
  _setBrowserExistsForTest(fn) { const was = browserExists; browserExists = fn; return was; },
};
