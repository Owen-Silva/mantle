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
const crypto = require('crypto');
const cp = require('child_process');

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

const START_MENU_ROOTS = [
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
const iconCache = new Map();     // lnk path -> dataUrl | null
let iconFailReason = '';         // first icon failure, in plain words

async function fillIcons(items, icon) {
  if (typeof icon !== 'function') {
    iconFailReason = 'no icon resolver was passed to build()';
    return { pending: items.length };
  }
  const todo = items.filter(it => !iconCache.has(it.path));
  let cursor = 0;

  async function worker() {
    while (cursor < todo.length) {
      const it = todo[cursor++];
      try {
        const url = await icon(it.path);
        iconCache.set(it.path, url || null);
        it.icon = url || null;          // in place: late icons still reach main's cached array
      } catch (err) {
        iconCache.set(it.path, null);
        it.icon = null;
        if (!iconFailReason) iconFailReason = String((err && err.message) || err);
      }
    }
  }

  const pool = Promise.all(Array.from({ length: Math.min(ICON_BATCH, todo.length || 1) }, worker));
  pool.catch(() => { /* per-icon errors are already recorded above */ });
  let timer;
  await Promise.race([pool, new Promise(r => { timer = setTimeout(r, ICON_CAP_MS); if (timer.unref) timer.unref(); })]);
  clearTimeout(timer);

  let pending = 0;
  for (const it of items) {
    if (iconCache.has(it.path)) it.icon = iconCache.get(it.path);
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

  const items = Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
  let status = 'ok', reason = '';
  if (roots === 0) { status = 'error'; reason = 'no Start Menu folder could be read: ' + errors.join('; '); }
  else if (items.length === 0) { status = 'error'; reason = 'the Start Menu folders are empty or unreadable'; }
  else if (errors.length) { reason = errors.length + ' folder(s) unreadable: ' + errors.slice(0, 2).join('; '); }
  return { items, status, reason };
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
    status = 'error';
    reason = 'no PowerShell profile found at ' + looked.join(' or ');
  } else if (items.length === 0) {
    status = 'error';
    reason = 'no functions or aliases in ' + read[0];
  } else if (errors.length) {
    reason = 'unreadable: ' + errors.join('; ');
  }
  return { items, status, reason };
}

/* ---- source 3: Settings pages ------------------------------------------ */

/* Curated rather than enumerated: Windows exposes hundreds of ms-settings:
   pages and no list of them; these are the ones a person actually reaches for.
   Name them the way the Settings app names them so search matches muscle
   memory ("wifi" -> Wi-Fi, "bt" -> Bluetooth by subsequence). */
const SETTINGS = [
  ['Display', 'ms-settings:display'],
  ['Sound', 'ms-settings:sound'],
  ['Bluetooth & devices', 'ms-settings:bluetooth'],
  ['Wi-Fi', 'ms-settings:network-wifi'],
  ['Network & internet', 'ms-settings:network'],
  ['Installed apps', 'ms-settings:appsfeatures'],
  ['Personalization', 'ms-settings:personalization'],
  ['Windows Update', 'ms-settings:windowsupdate'],
  ['Storage', 'ms-settings:storagesense'],
  ['Power & battery', 'ms-settings:batterysaver'],
  ['Privacy & security', 'ms-settings:privacy'],
  ['Accounts', 'ms-settings:yourinfo'],
  ['Date & time', 'ms-settings:dateandtime'],
  ['Notifications', 'ms-settings:notifications'],
  ['Focus', 'ms-settings:quiethours'],
  ['Printers & scanners', 'ms-settings:printers'],
  ['Mouse', 'ms-settings:mousetouchpad'],
  ['Keyboard', 'ms-settings:keyboard'],
  ['Typing', 'ms-settings:typing'],
  ['Default apps', 'ms-settings:defaultapps'],
  ['Startup apps', 'ms-settings:startupapps'],
  ['About this PC', 'ms-settings:about'],
  ['Optional features', 'ms-settings:optionalfeatures'],
  ['For developers', 'ms-settings:developers'],
  ['Windows Security', 'ms-settings:windowsdefender'],
  ['Multitasking', 'ms-settings:multitasking'],
];

function buildSettings() {
  const items = SETTINGS.map(([name, uri]) => ({
    id: stableId('set', uri),
    kind: 'setting',
    name,
    subtitle: 'Settings',
    path: uri,
    icon: null,
  }));
  return { items, status: 'ok', reason: '' };
}

/* ---- build -------------------------------------------------------------- */

async function build({ icon } = {}) {
  const apps = buildApps();
  const commands = buildCommands();
  const settings = buildSettings();

  // icons only make sense for .lnk files; commands/settings draw a glyph
  const { pending } = await fillIcons(apps.items, icon);

  let appsReason = apps.reason;
  if (apps.status === 'ok') {
    if (iconFailReason) {
      appsReason = (appsReason ? appsReason + '; ' : '') + 'icons unavailable: ' + iconFailReason;
    } else if (pending > 0) {
      appsReason = (appsReason ? appsReason + '; ' : '') +
        pending + ' icons still loading, they appear next time you open this';
    }
  }

  const items = apps.items.concat(commands.items, settings.items);
  const sources = [
    { name: 'apps', count: apps.items.length, status: apps.status, reason: appsReason },
    { name: 'commands', count: commands.items.length, status: commands.status, reason: commands.reason },
    { name: 'settings', count: settings.items.length, status: settings.status, reason: settings.reason },
  ];
  return { items, sources };
}

/* ---- search ------------------------------------------------------------- */

const KIND_ORDER = { app: 0, command: 1, setting: 2, url: 3 };
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

function scoreItem(item, q) {
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
  const list = Array.isArray(items) ? items : [];
  const query = String(q == null ? '' : q).trim().toLowerCase();

  if (!query) {
    /* Empty query: Owen's own commands first — his `dash`, `bot`, `northwind` are
       what he reaches for, and they are unguessable from an icon grid — then
       apps alphabetically to fill the twelve. */
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

  const out = scored.map(x => x.it);

  if (looksLikeUrl(query)) {
    const url = normalizeUrl(String(q).trim());
    out.unshift({
      id: stableId('url', url),
      kind: 'url',
      name: 'Open ' + String(q).trim(),
      subtitle: 'in your browser',
      path: url,
      icon: null,
    });
  }
  return out.slice(0, LIMIT);
}

/* ---- launch ------------------------------------------------------------- */

const BROWSER_DIR = path.join(os.homedir(), 'browser');
const BROWSER_EXE = path.join(BROWSER_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');

function spawnDetached(exe, args) {
  // detached + unref so closing Mantle never takes the launched app with it
  const child = cp.spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  return child;
}

/* Every branch below returns a plain-words reason on failure. The renderer
   prints it under the row and keeps the launcher open, so a launch can never
   just "do nothing". */
async function launch(item, { dryRun } = {}) {
  if (!item || !item.kind) return { ok: false, reason: 'that row has no item attached (a bug in the launcher)' };

  /* Work out the exact command first, so the dry run can quote it verbatim. */
  let exe = null, args = null, via = '';
  let note = '';

  if (item.kind === 'app') {
    if (!fs.existsSync(item.path)) {
      const gone = 'the shortcut is gone from disk: ' + item.path;
      if (dryRun) return { ok: true, reason: 'dry run: would open ' + item.path + ' (but the file is missing)' };
      return { ok: false, reason: gone };
    }
    if (shell) via = 'shell.openPath(' + quote(item.path) + ')';
    else { exe = 'cmd'; args = ['/c', 'start', '', item.path]; via = 'cmd /c start "" ' + quote(item.path); }
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
    if (!fs.existsSync(BROWSER_EXE)) {
      const missing = 'your browser is not installed at ' + BROWSER_EXE;
      if (dryRun) return { ok: true, reason: 'dry run: would run ' + quote(BROWSER_EXE) + ' ' + quote(BROWSER_DIR) + ' ' + quote(item.path) + ' (but the browser is missing)' };
      return { ok: false, reason: missing };
    }
    exe = BROWSER_EXE;
    args = [BROWSER_DIR, item.path];
    via = quote(BROWSER_EXE) + ' ' + quote(BROWSER_DIR) + ' ' + quote(item.path);
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

module.exports = { build, search, launch, _internals: { looksLikeUrl, scoreItem, stableId } };
