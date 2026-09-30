'use strict';
/* pinned.js — the apps Owen pinned to the Windows taskbar, in taskbar order.
 *
 * WHY this is a plain CommonJS module and not part of main.js: like
 * launcher-index.js, the only interesting thing here is logic over real
 * Windows data — a folder of .lnk files, a REG_BINARY blob, and a shortcut
 * format from 1995 — so it has to be runnable and testable WITHOUT Electron.
 * `node lib/pinned.test.js` builds fixtures, parses them, and then does a
 * read-only smoke pass over the real pins on this machine.
 *
 * There are three sources and each can fail on its own:
 *
 *   1. WHICH apps  %APPDATA%\Microsoft\Internet Explorer\Quick Launch\
 *                  User Pinned\TaskBar\*.lnk
 *                  This is the only source that is allowed to fail the whole
 *                  call (ok:false) — with no folder there is nothing to show.
 *
 *   2. WHAT ORDER  HKCU\...\Explorer\Taskband, REG_BINARY `Favorites`.
 *                  An undocumented blob of packed shell ITEMIDLISTs. We do NOT
 *                  try to parse it: we look for each .lnk basename's bytes
 *                  inside it (UTF-16LE first, ANSI second — Windows writes
 *                  both) and sort by where they first appear. That is
 *                  best-effort by design; when it fails we fall back to
 *                  alphabetical and SAY SO in `reason` rather than silently
 *                  showing a scrambled bar.
 *
 *   3. WHAT EACH IS  the shortcut's target/args/icon/AUMID. The C# sidecar's
 *                  `lnk` command does this properly (IShellLink + the property
 *                  store, which is the only way to get a Store app's
 *                  AppUserModelId). When the sidecar is old or absent we fall
 *                  back to the minimal MS-SHLLINK parser below, which reads
 *                  LinkInfo and StringData and gets file targets right but
 *                  cannot see a Store app's AUMID.
 *
 * The rule shaping every branch: nothing fails silently, and a per-item
 * failure never drops the item. A pin we cannot resolve still comes back with
 * target:null and a plain-words `reason` the bar can show on hover, because a
 * missing icon the user cannot explain is worse than an ugly one.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const PINS_SUBPATH = ['Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar'];
const TASKBAND_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Taskband';
const DEBOUNCE_MS = 500;
const RETRY_MS = 30000;   // a dead or missing folder watch tries again this often (unref'd: costs nothing)

/** Why the pins folder failed, in plain words and with NO path (these reasons reach the log). */
function folderWhy(err) {
  const code = err && err.code;
  if (code === 'ENOENT') return 'is missing';
  if (code === 'EACCES' || code === 'EPERM') return 'could not be opened: access was denied';
  if (code === 'ENOTDIR') return 'is not a folder';
  return 'could not be read' + (code ? ' (' + code + ')' : '');
}

/* watchPins cannot return its failure to a caller that only wants an unwatch
   function, so the reason is parked here and merged into the next listPinned
   result. Same contract as everywhere else in Mantle: the reason reaches a
   surface the user can read, not just a log line. */
let watchReason = null;

function defaultAppData() {
  return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
}

function pinsDir(appData) {
  return path.join(appData || defaultAppData(), ...PINS_SUBPATH);
}

/* Windows writes %SystemRoot% and friends into shortcut targets and icon
   locations verbatim; Node's process.env is case-insensitive on Windows, so a
   plain lookup handles %systemroot% too. An unknown variable is left alone
   rather than blanked, so a broken path still reads as the path it was. */
function expandVars(s) {
  return String(s == null ? '' : s).replace(/%([^%\\/]+)%/g, (whole, name) => {
    const v = process.env[name];
    return v === undefined ? whole : v;
  });
}

/* "C:\\Windows\\system32\\shell32.dll,15" -> { iconPath, iconIndex:15 }.
   A negative index is legal (it means "resource id", not "position"). */
function splitIconLocation(s) {
  const str = String(s == null ? '' : s).trim();
  if (!str) return { iconPath: null, iconIndex: 0 };
  const m = /^(.*[^,]),\s*(-?\d+)$/.exec(str);
  if (m) return { iconPath: m[1].trim(), iconIndex: parseInt(m[2], 10) };
  return { iconPath: str, iconIndex: 0 };
}

/* ---- source 2: taskbar order ------------------------------------------- */

/* reg.exe prints a REG_BINARY as one unbroken hex string, which is exactly
   what we want. A PowerShell child would cost ~400 ms and a window flash for
   the same bytes, so this spawns reg.exe directly, once per listPinned. */
function readFavoritesFromRegistry() {
  return new Promise((resolve, reject) => {
    execFile('reg.exe', ['query', TASKBAND_KEY, '/v', 'Favorites'],
      { windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(new Error('reg.exe could not read ' + TASKBAND_KEY + ' (' + (err.code === 1 ? 'the value is not there' : String(err.message).trim()) + ')'));
        const m = /REG_BINARY\s+([0-9A-Fa-f]+)/.exec(String(stdout));
        if (!m) return reject(new Error('reg.exe returned no REG_BINARY Favorites value'));
        const buf = Buffer.from(m[1], 'hex');
        if (!buf.length) return reject(new Error('the Favorites value is empty'));
        resolve(buf);
      });
  });
}

/* Best-effort ordering. `blob` and the needles are compared as latin1 strings
   so one JS char is one byte: lowercasing both sides then gives a
   case-insensitive byte search without decoding anything. Names the blob does
   not mention (a pin added since the last Explorer write) go after the known
   ones, alphabetically, so the bar is stable rather than random. */
function orderNames(names, blob) {
  const hay = Buffer.isBuffer(blob) ? blob.toString('latin1').toLowerCase() : '';
  const found = [];
  const missing = [];
  for (const name of names) {
    let at = -1;
    if (hay) {
      at = hay.indexOf(Buffer.from(name, 'utf16le').toString('latin1').toLowerCase());
      if (at === -1) at = hay.indexOf(name.toLowerCase());   // ANSI second try
    }
    if (at === -1) missing.push(name); else found.push({ name, at });
  }
  found.sort((a, b) => a.at - b.at || a.name.localeCompare(b.name));
  missing.sort((a, b) => a.localeCompare(b));
  const order = new Map();
  let i = 0;
  for (const f of found) order.set(f.name, i++);
  for (const n of missing) order.set(n, i++);
  return order;
}

/* ---- source 3 (fallback): a minimal MS-SHLLINK reader -------------------- */

const F_ID_LIST = 0x00000001;
const F_LINK_INFO = 0x00000002;
const F_NAME = 0x00000004;
const F_RELATIVE_PATH = 0x00000008;
const F_WORKING_DIR = 0x00000010;
const F_ARGUMENTS = 0x00000020;
const F_ICON_LOCATION = 0x00000040;
const F_UNICODE = 0x00000080;

const LINK_CLSID = Buffer.from([
  0x01, 0x14, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00,
  0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46,
]);

function readAnsiZ(buf, at) {
  if (at < 0 || at >= buf.length) return '';
  let end = at;
  while (end < buf.length && buf[end] !== 0) end++;
  return buf.toString('latin1', at, end);
}

function readUtf16Z(buf, at) {
  if (at < 0 || at + 1 >= buf.length) return '';
  let end = at;
  while (end + 1 < buf.length && !(buf[end] === 0 && buf[end + 1] === 0)) end += 2;
  return buf.toString('utf16le', at, end);
}

/* Throws an Error with a plain-words message on anything malformed; the caller
   turns that into the item's `reason`. Returns only what we can actually read:
   this deliberately does NOT walk the ExtraData property store, so a Store
   app's AUMID comes back null and the caller says the sidecar is needed. */
function parseLnkBuffer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 0x4C) {
    throw new Error('the file is too small to be a shortcut (' + (Buffer.isBuffer(buf) ? buf.length : 0) + ' bytes)');
  }
  const headerSize = buf.readUInt32LE(0);
  if (headerSize !== 0x4C) throw new Error('not a shortcut: its header says ' + headerSize + ' bytes, a .lnk header is 76');
  if (!buf.slice(4, 20).equals(LINK_CLSID)) throw new Error('not a shortcut: the class id in the header is wrong');

  const flags = buf.readUInt32LE(0x14);
  const unicode = !!(flags & F_UNICODE);
  let pos = 0x4C;

  if (flags & F_ID_LIST) {
    if (pos + 2 > buf.length) throw new Error('the shortcut ends before its target list');
    const size = buf.readUInt16LE(pos);
    pos += 2 + size;
    if (pos > buf.length) throw new Error('the shortcut is cut off inside its target list');
  }

  let target = null;
  if (flags & F_LINK_INFO) {
    if (pos + 8 > buf.length) throw new Error('the shortcut ends before its link info');
    const start = pos;
    const size = buf.readUInt32LE(start);
    const hdrSize = buf.readUInt32LE(start + 4);
    if (size < 0x1C || start + size > buf.length) throw new Error('the shortcut has a damaged link info block');
    const liFlags = buf.readUInt32LE(start + 8);
    if (liFlags & 0x01) {                       // VolumeIDAndLocalBasePath
      let base = '';
      let suffix = '';
      if (hdrSize >= 0x24) {                    // the Unicode pair only exists here
        const uBase = buf.readUInt32LE(start + 0x1C);
        const uSuffix = buf.readUInt32LE(start + 0x20);
        if (uBase) base = readUtf16Z(buf, start + uBase);
        if (uSuffix) suffix = readUtf16Z(buf, start + uSuffix);
      }
      if (!base) {
        const aBase = buf.readUInt32LE(start + 0x10);
        const aSuffix = buf.readUInt32LE(start + 0x18);
        if (aBase) base = readAnsiZ(buf, start + aBase);
        if (!suffix && aSuffix) suffix = readAnsiZ(buf, start + aSuffix);
      }
      if (base) target = base + suffix;
    }
    pos = start + size;
  }

  /* StringData, always in this order, each one present only if its flag is. */
  function readString() {
    if (pos + 2 > buf.length) throw new Error('the shortcut is cut off inside its text');
    const count = buf.readUInt16LE(pos);
    pos += 2;
    const bytes = count * (unicode ? 2 : 1);
    if (pos + bytes > buf.length) throw new Error('the shortcut is cut off inside its text');
    const s = buf.toString(unicode ? 'utf16le' : 'latin1', pos, pos + bytes);
    pos += bytes;
    return s;
  }
  const name = (flags & F_NAME) ? readString() : '';
  const relativePath = (flags & F_RELATIVE_PATH) ? readString() : '';
  const workdir = (flags & F_WORKING_DIR) ? readString() : '';
  const args = (flags & F_ARGUMENTS) ? readString() : '';
  const iconLocation = (flags & F_ICON_LOCATION) ? readString() : '';

  const icon = splitIconLocation(iconLocation);
  return {
    target, args, workdir, name, relativePath,
    iconPath: icon.iconPath, iconIndex: icon.iconIndex,
    aumid: null,
  };
}

/* The second chance for a shortcut with no LinkInfo: RELATIVE_PATH is stored
   against the .lnk's own folder ("..\\..\\Program Files\\x\\x.exe"). */
function parseLnkFile(fullPath) {
  const parsed = parseLnkBuffer(fs.readFileSync(fullPath));
  if (!parsed.target && parsed.relativePath) {
    try { parsed.target = path.resolve(path.dirname(fullPath), parsed.relativePath); } catch (_) { /* keep null */ }
  }
  return parsed;
}

/* ---- list --------------------------------------------------------------- */

function isFileOnDisk(p) {
  try { return fs.statSync(p).isFile(); } catch (_) { return false; }
}

async function listPinned(opts = {}) {
  const { sidecarCall } = opts;
  const dir = pinsDir(opts.appData);
  const readFavorites = typeof opts._readFavorites === 'function' ? opts._readFavorites : readFavoritesFromRegistry;

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    // The ONLY ok:false. Everything below degrades instead of failing.
    // no path: this reason reaches the log, and the folder's path names Owen's profile
    return { ok: false, reason: "Windows' pinned-apps folder " + folderWhy(err), items: [] };
  }

  const names = entries
    .filter(e => !e.isDirectory() && /\.lnk$/i.test(e.name))
    .map(e => e.name)
    .sort((a, b) => a.localeCompare(b));
  const full = names.map(n => path.join(dir, n));

  const notes = [];
  if (watchReason) notes.push(watchReason);

  /* --- the blob: the ONLY place Store pins exist at all --- */
  let blob = null;
  let blobReason = null;
  try {
    blob = await readFavorites();
  } catch (err) {
    blobReason = String((err && err.message) || err);
  }

  /* --- the shell's own reading of the blob ---
     Five of Owen's fourteen pins (Calculator, Settings, Terminal, LessonPlayer,
     Xbox) are absolute PIDLs into the Applications folder and have NO .lnk
     file anywhere — the folder scan above can never see them. Only the
     sidecar's `pins` command, which walks the blob through the shell, can.
     Without it we show nine of fourteen, so the miss is named out loud. */
  let pinsReply = null;
  let pinsReason = null;
  if (!blob) {
    pinsReason = 'the taskbar order could not be read: ' + blobReason;
  } else if (typeof sidecarCall !== 'function') {
    pinsReason = 'no sidecar connection was passed to listPinned';
  } else {
    try {
      const res = await sidecarCall('pins', { blob: blob.toString('base64') });
      if (!res || res.ok === false) pinsReason = (res && res.reason) || 'the sidecar could not read the taskbar pin list';
      else if (!Array.isArray(res.items)) pinsReason = 'the sidecar\'s pins command returned no items';
      else pinsReply = res;
    } catch (err) {
      pinsReason = String((err && err.message) || err);   // old exe: 'unknown command'
    }
  }
  if (pinsReason) notes.push('the Store-app pins are not shown: ' + pinsReason);
  if (!blob) notes.push('taskbar order unavailable: ' + blobReason);

  /* The name-offset sort is now only the fallback, for when `pins` is out. */
  const order = orderNames(names, pinsReply ? null : blob);

  /* --- resolve, one sidecar round trip for all of them --- */
  const resolved = new Map();                   // lowercased .lnk path -> sidecar record
  let sidecarReason = null;
  if (typeof sidecarCall !== 'function') {
    sidecarReason = 'no sidecar connection was passed to listPinned';
  } else {
    try {
      const res = await sidecarCall('lnk', { paths: full });
      const list = res && Array.isArray(res.items) ? res.items : null;
      if (!list) sidecarReason = 'the sidecar\'s lnk command returned no items';
      else for (const it of list) if (it && it.path) resolved.set(String(it.path).toLowerCase(), it);
    } catch (err) {
      sidecarReason = String((err && err.message) || err);
    }
  }
  if (sidecarReason && names.length) {
    notes.push('shortcuts read without the sidecar (' + sidecarReason + ')');
  }

  const lnkPins = names.map((name, i) => {
    const lnkPath = full[i];
    const rec = resolved.get(lnkPath.toLowerCase());
    let info = null;
    let reason = null;

    if (rec && rec.ok !== false) {
      info = rec;
      if (!rec.target && !rec.aumid) reason = rec.reason || 'the sidecar found no target and no app id in this shortcut';
    } else {
      const sidecarSaid = rec ? (rec.reason || 'the sidecar could not read this shortcut') : null;
      try {
        const parsed = parseLnkFile(lnkPath);
        if (parsed.target) {
          info = parsed;
        } else {
          info = parsed;
          reason = sidecarSaid || (sidecarReason
            ? 'no file target (Store app?) and sidecar lnk unavailable'
            : 'no file target (Store app?)');
        }
      } catch (err) {
        reason = sidecarSaid || String((err && err.message) || err);
      }
    }

    const target = info && info.target ? expandVars(String(info.target)) : null;
    /* A pin whose app has been uninstalled still sits on the taskbar (Owen's
       Comet pin is one right now). Resolving perfectly to a path that is not
       there would give the bar a blank icon and nothing to say about it, so
       the item carries the reason even though nothing "failed". */
    /* "::{CLSID}" and shell: targets are shell items (File Explorer's pin), not files: no exe, no "gone". */
    const isShellTarget = !!target && /^(::|shell:)/i.test(target);
    const exe = target && !isShellTarget && isFileOnDisk(target) ? target.toLowerCase() : null;
    if (target && !exe && !isShellTarget && !reason) reason = 'the app this pin points at is gone (it was uninstalled or moved)';
    const icon = splitIconLocation(info && info.iconPath ? expandVars(String(info.iconPath)) : '');
    let iconPath = icon.iconPath;
    let iconIndex = (info && Number.isInteger(info.iconIndex)) ? info.iconIndex : icon.iconIndex;
    if (!iconPath) { iconPath = target; iconIndex = 0; }

    return {
      id: name.toLowerCase(),
      name: name.replace(/\.lnk$/i, ''),
      kind: 'lnk',
      lnkPath,
      target,
      args: info && info.args ? String(info.args) : '',
      exe,
      aumid: info && info.aumid ? String(info.aumid) : null,
      iconPath,
      iconIndex,
      /* the sidecar renders shell items (and anything else it can) to a PNG data URL; main prefers it */
      // ...but only for pins WITHOUT a file exe: for those the sidecar renders the .lnk itself and its icon carries the shortcut-arrow overlay.
      iconPng: (!exe && info && typeof info.iconPng === 'string' && info.iconPng) ? info.iconPng : null,
      order: order.has(name) ? order.get(name) : i,
      reason,
    };
  });

  /* --- assemble --- */
  let items;
  if (!pinsReply) {
    items = lnkPins.slice().sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  } else {
    const byFile = new Map(lnkPins.map(p => [path.basename(p.lnkPath).toLowerCase(), p]));
    const used = new Set();
    const merged = [];
    const orphans = [];                         // the blob says pinned, no .lnk on disk
    const blobItems = pinsReply.items.filter(Boolean).slice()
      .sort((a, b) => (Number(a.index) || 0) - (Number(b.index) || 0));

    for (const it of blobItems) {
      if (it.kind === 'lnk') {
        const key = (it.lnk ? path.basename(String(it.lnk)) : String(it.name || '') + '.lnk').toLowerCase();
        const pin = byFile.get(key);
        if (pin) { used.add(key); merged.push(pin); }
        else orphans.push(String(it.name || key));
      } else if (it.kind === 'app' && it.aumid) {
        merged.push({
          id: 'app:' + it.aumid,
          name: String(it.name || it.aumid),
          kind: 'app',
          lnkPath: null,
          target: null,
          args: '',
          exe: null,
          aumid: String(it.aumid),
          iconPath: null,
          iconIndex: 0,
          iconPng: it.iconPng || null,
          order: 0,
          reason: null,
        });
      }
      /* 'other' (a URL, a folder, something the shell would not run as an app)
         is skipped on purpose; the sidecar names them in its own reason. */
    }

    /* A .lnk in the folder the blob never mentions is still pinned as far as
       the user is concerned (Owen's uninstalled Comet is one today), so it is
       shown — last, and said out loud rather than quietly dropped. */
    const extras = lnkPins
      .filter(p => !used.has(path.basename(p.lnkPath).toLowerCase()))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (extras.length) {
      notes.push('not in the saved taskbar list, shown last: ' + extras.map(p => p.name).join(', ') +
        ' (the saved order is stale, or it was pinned another way)');
    }
    if (orphans.length) notes.push('pinned but no shortcut file on disk: ' + orphans.join(', '));
    if (pinsReply.skipped) {
      notes.push(pinsReply.skipped + ' taskbar entr' + (pinsReply.skipped === 1 ? 'y is' : 'ies are') +
        ' not apps' + (pinsReply.reason ? ': ' + pinsReply.reason : ''));
    } else if (pinsReply.reason) notes.push(String(pinsReply.reason));

    items = merged.concat(extras);

    /* One `app` call per app pin that came back without icon bytes — never
       two, and never one for a pin that already has them. */
    const needIcon = items.filter(p => p.kind === 'app' && !p.iconPng);
    await Promise.all(needIcon.map(async p => {
      if (typeof sidecarCall !== 'function') {
        p.reason = 'no icon for ' + p.name + ": Mantle's helper is not running yet";
        return;
      }
      try {
        const r = await sidecarCall('app', { aumid: p.aumid });
        if (r && r.ok !== false && r.iconPng) {
          p.iconPng = r.iconPng;
          if (r.name) p.name = String(r.name);
        } else {
          p.reason = 'no icon for ' + p.name + ': ' + ((r && r.reason) || 'Windows gave no icon');
        }
      } catch (err) {
        p.reason = 'no icon for ' + p.name + ': ' + String((err && err.message) || err);
      }
    }));
  }

  /* order IS the position on the bar: dense 0..n-1, whatever the blob skipped. */
  items.forEach((p, i) => { p.order = i; });

  if (!items.length) notes.push('nothing is pinned to the taskbar');
  return { ok: true, reason: notes.length ? notes.join('; ') : null, items };
}

/* ---- watch -------------------------------------------------------------- */

/* Windows fires several change events for one pin/unpin (the .lnk is written,
   then desktop.ini is touched, then the folder timestamp moves), so the 500 ms
   debounce is not a nicety — without it the bar would rebuild three or four
   times per drag. */
function watchPins(onChange, opts = {}) {
  const dir = pinsDir(opts.appData);
  const noop = () => {};

  if (typeof onChange !== 'function') {
    watchReason = 'the pinned-apps folder is not being watched: watchPins was called without a callback';
    noop.reason = watchReason;
    return noop;
  }

  /* RE-ARM (quality pass, 2026-09-29): a watcher that died (the folder was deleted and made again,
     a profile sync, a network hiccup on a redirected AppData) used to stay dead for the whole run,
     so pins changed after it were never seen until Mantle restarted. Now a dead or missing watch
     tries again every RETRY_MS, and a watch that comes back fires onChange once: whatever changed
     while it was down is read. The reasons name no path (they reach the log). */
  const retryMs = Number(opts.retryMs) > 0 ? Number(opts.retryMs) : RETRY_MS;
  let watcher = null;
  let timer = null;
  let retry = null;
  let stopped = false;
  function schedule() {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; if (!stopped) onChange(); }, DEBOUNCE_MS);
  }
  function later() {
    if (stopped || retry) return;
    retry = setTimeout(() => { retry = null; if (arm()) schedule(); }, retryMs);
    if (retry.unref) retry.unref();
  }
  function arm() {
    if (stopped) return false;
    try {
      // persistent:false so a plain `node` script (the test) can still exit.
      watcher = fs.watch(dir, { persistent: false }, () => schedule());
    } catch (err) {
      watcher = null;
      watchReason = 'the pinned-apps folder is not being watched: ' + folderWhy(err) + '; trying again every ' + Math.round(retryMs / 1000) + ' s';
      later();
      return false;
    }
    watcher.on('error', err => {
      // A watcher that died must not look like "nothing ever changes": say so, and try again.
      watchReason = 'watching the pinned-apps folder stopped (' + ((err && err.code) || 'no reason given') + '); trying again';
      try { watcher.close(); } catch (_) { /* already gone */ }
      watcher = null;
      later();
    });
    watchReason = null;
    return true;
  }

  const first = arm();
  const unwatch = () => {
    if (stopped) return;
    stopped = true;
    if (timer) { clearTimeout(timer); timer = null; }
    if (retry) { clearTimeout(retry); retry = null; }
    try { if (watcher) watcher.close(); } catch (_) { /* already gone */ }
    watcher = null;
  };
  unwatch.reason = first ? null : watchReason;
  unwatch._rearm = () => arm();   // tests: what a retry does
  return unwatch;
}

module.exports = {
  listPinned,
  watchPins,
  _internals: { pinsDir, orderNames, parseLnkBuffer, parseLnkFile, splitIconLocation, expandVars, readFavoritesFromRegistry },
};
