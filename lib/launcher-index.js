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

/* Mantle's own windows, opened in-process rather than by Windows. Listed as settings (the same
   glyph, the same place in the ranking) because that is what they are: somewhere to change how
   Mantle looks. "Wallpapers" is the only way to reach the wallpaper library besides the tray menu
   -- the desktop layer itself sits under the icons and never gets a click. */
const MANTLE_TARGETS = [
  ['Wallpapers', 'mantle:wallpapers'],
];

function buildSettings() {
  const items = SETTINGS.map(([name, uri]) => ({
    id: stableId('set', uri),
    kind: 'setting',
    name,
    subtitle: 'Settings',
    path: uri,
    icon: null,
  })).concat(MANTLE_TARGETS.map(([name, uri]) => ({
    id: stableId('set', uri),
    kind: 'setting',
    name,
    subtitle: 'Mantle',
    path: uri,
    icon: null,
  })));
  return { items, status: 'ok', reason: '' };
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
 *   Shut down  shutdown /s /t 0                     with unsaved work can still say "wait" - the same
 *   Sign out   shutdown /l                          as Start. /s is a FULL shutdown: Start would do
 *   Hibernate  shutdown /h                          a hybrid one (Fast Startup) here; see the report
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
  };
}

async function buildPower() {
  const states = await readSleepStates();
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

async function build({ icon } = {}) {
  const apps = buildApps();
  const commands = buildCommands();
  const settings = buildSettings();
  const powerP = buildPower();          // powercfg runs while the icons load

  // icons only make sense for .lnk files; commands/settings draw a glyph
  const { pending } = await fillIcons(apps.items, icon);
  const power = await powerP;

  let appsReason = apps.reason;
  if (apps.status === 'ok') {
    if (iconFailReason) {
      appsReason = (appsReason ? appsReason + '; ' : '') + 'icons unavailable: ' + iconFailReason;
    } else if (pending > 0) {
      appsReason = (appsReason ? appsReason + '; ' : '') +
        pending + ' icons still loading, they appear next time you open this';
    }
  }

  const items = apps.items.concat(commands.items, settings.items, power.items);
  const sources = [
    { name: 'apps', count: apps.items.length, status: apps.status, reason: appsReason },
    { name: 'commands', count: commands.items.length, status: commands.status, reason: commands.reason },
    { name: 'settings', count: settings.items.length, status: settings.status, reason: settings.reason },
    { name: 'power', count: power.items.length, status: power.status, reason: power.reason },
  ];
  return { items, sources };
}

/* ---- search ------------------------------------------------------------- */

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

function scoreItem(item, q) {
  if (item.kind === 'power') return scorePower(item, q);
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
  } else if (item.kind === 'setting' && /^mantle:/.test(String(item.path))) {
    /* One of Mantle's own windows. Raised as an event on the Electron app, not called on a module,
       because lib/apps.js re-requires this file on every rebuild and a registry kept here would be
       wiped each time; lib/wallpaper.js listens for 'mantle-open' on app. */
    const target = String(item.path).slice('mantle:'.length);
    if (dryRun) return { ok: true, reason: 'dry run: would open Mantle\'s ' + target + ' window' };
    const app = electron && electron.app;
    if (!app || typeof app.emit !== 'function') return { ok: false, reason: 'Mantle\'s ' + target + ' window can only open inside Mantle itself' };
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
    if (!fs.existsSync(BROWSER_EXE)) {
      const missing = 'your browser is not installed at ' + BROWSER_EXE;
      if (dryRun) return { ok: true, reason: 'dry run: would run ' + quote(BROWSER_EXE) + ' ' + quote(BROWSER_DIR) + ' ' + quote(item.path) + ' (but the browser is missing)' };
      return { ok: false, reason: missing };
    }
    exe = BROWSER_EXE;
    args = [BROWSER_DIR, item.path];
    via = quote(BROWSER_EXE) + ' ' + quote(BROWSER_DIR) + ' ' + quote(item.path);
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
    if (typeof sidecar !== 'function') return { ok: false, reason: def.name + ' goes through the sidecar, and main did not hand it one' };
    let res;
    try {
      res = await sidecar(run.sidecar, { action, dryRun: dry }, 4000);
    } catch (err) {
      const m = String((err && err.message) || err);
      if (/unknown command/i.test(m)) {
        return { ok: false, reason: def.name + ' needs the sidecar\'s "session" command (sidecar/Session.cs), and the running sidecar was built without it: rebuild the sidecar' };
      }
      return { ok: false, reason: def.name + ' did not happen: ' + m };
    }
    if (!res || res.ok !== true) return { ok: false, reason: def.name + ' did not happen: ' + ((res && res.reason) || 'the sidecar said no and gave no reason') };
    if (dry) {
      const line = 'would call ' + (res.wouldCall || '?') + ' in the sidecar after ' + res.afterMs + ' ms (' + (res.mode || 'unknown sleep mode') + ')';
      process.stdout.write('mantle: power dry run: ' + line + '\n');
      return { ok: true, dryRun: true, reason: 'dry run: ' + line };
    }
    return { ok: true };
  }

  const exe = path.join(SYS32, run.exe);
  const line = quote(exe) + ' ' + run.args.join(' ');
  if (dry) {
    process.stdout.write('mantle: power dry run: would run: ' + line + '\n');
    return { ok: true, dryRun: true, reason: 'dry run: would run ' + line };
  }
  if (!fs.existsSync(exe)) return { ok: false, reason: def.name + ' did not happen: ' + exe + ' is missing' };
  return runPowerExe(def, exe, run.args);
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

async function files(a, { sidecar } = {}) {
  const q = String((a && a.q) || '').trim();
  if (q.length < FILE_MIN_CHARS) return { ok: true, q, items: [], reason: '' };
  if (typeof sidecar !== 'function') return { ok: false, q, items: [], reason: 'file search goes through the sidecar, and main did not hand it one' };
  let res;
  try {
    res = await sidecar('search', { q, max: FILE_FETCH, scope: os.homedir(), ttl: 5000 }, 6000);
  } catch (err) {
    const m = String((err && err.message) || err);
    if (/^cancelled$/i.test(m)) return { ok: true, q, superseded: true, items: [] };
    if (/unknown command/i.test(m)) {
      return { ok: false, q, items: [], reason: 'the running sidecar was built without the "search" command (sidecar/Search.cs): rebuild the sidecar' };
    }
    return { ok: false, q, items: [], reason: m };
  }
  if (!res || res.ok !== true) return { ok: false, q, items: [], reason: (res && res.reason) || 'the sidecar answered without results or a reason' };

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

module.exports = {
  build, search, launch, power, files, openFile,
  _internals: { looksLikeUrl, scoreItem, stableId, parseSleepStates, fileScore, POWER },
};
