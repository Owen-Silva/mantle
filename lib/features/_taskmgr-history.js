'use strict';
/**
 * _taskmgr-history.js - App history from Mantle's OWN record (lane tm-data, 2026-10-28).
 *
 * WHY: Windows' App history reads SRUM, which only an administrator can open. When the elevated helper
 * is set up, taskmgr.js reads SRUM through it (taskmgr.apphistory, source 'srum'). Otherwise this keeps
 * Mantle's own record from the day it started: CPU time per app, summed from the task manager's
 * process snapshots (one NtQuerySystemInformation read, at most once a minute while the window is open
 * and once every 5 minutes while it is closed). The page says which source it shows.
 *
 *   const H = require('./_taskmgr-history.js');
 *   const h = H.create({ file });            // loads the saved record (a bad file starts again, said so)
 *   h.record(snap);                          // a taskmgr.snapshot result: adds each process's CPU since the last record
 *   h.model({ allProcesses });               // -> model.apphistory { since, rows, source:'mantle', error, why, note }
 *   h.clear();                               // "Delete usage history": since = now
 *   h.save(); h.load();
 *
 * WHAT IT COUNTS: CPU time only. A process seen at both records adds the difference; a process that
 * STARTED after the last record adds all of its CPU time; a process already running at the very first
 * record (or after Delete usage history) adds only what it uses from then on. Network, metered network,
 * downloads, uploads and tile updates are null: per-app network use needs Windows' event tracing as
 * administrator, and Windows keeps no tile-update count an app can read. `why` says so for each.
 * "Apps" (the default list) are Store (packaged) apps, as in Windows: an exe under \WindowsApps\ or
 * \SystemApps\ (row.app true); allProcesses adds desktop programs and the rest, like Windows' "Show
 * history for all processes". Each row also carries `path` (the exe, for Properties / Open file location;
 * null + why.path when Mantle never saw it). Session 0 (Windows services) is never counted: the page is
 * "for current user account".
 */
const fs = require('fs');
const path = require('path');
const C = require('./_taskmgr-core.js');

const VERSION = 1;
const MAX_APPS = 2000;                  // the record never grows without bound (lowest CPU time goes first)
const EPOCH_DIFF_MS = 11644473600000;   // FILETIME (1601) -> Unix (1970), in ms
const WHY = {
  net: "per-app network use needs Windows' event tracing as administrator; set up administrator access to see Windows' own App history",
  tiles: 'Windows keeps no tile-update count that apps can read',
  path: "Windows did not let Mantle see where this app's file is",
};
/** A Store (packaged) app's exe lives under WindowsApps (Store installs) or SystemApps (Windows' own). */
const PACKAGED = /\\(windowsapps|systemapps)\\/i;
function isPackagedPath(p) { return typeof p === 'string' && PACKAGED.test(p); }
const NULL_FIELDS = ['net', 'metered', 'tiles', 'nonMetered', 'downloads', 'uploads'];

/** A FILETIME decimal string -> ms since 1970 (null when it is not one). */
function createdMs(created) {
  const n = Number(created);
  return Number.isFinite(n) && n > 0 ? n / 10000 - EPOCH_DIFF_MS : null;
}

function fresh(now) { return { v: VERSION, since: now, lastAt: null, apps: {}, seen: {} }; }

/** Only the fields this file wrote, with the right types (a hand-edited or half-written file cannot inject). */
function sanitize(raw, now) {
  if (!raw || typeof raw !== 'object' || raw.v !== VERSION || !Number.isFinite(raw.since)) return null;
  const out = fresh(raw.since);
  out.lastAt = Number.isFinite(raw.lastAt) ? raw.lastAt : null;
  if (out.since > now + 60000) return null;   // a record from the future is not one this machine made
  const apps = raw.apps && typeof raw.apps === 'object' ? raw.apps : {};
  for (const id of Object.keys(apps)) {
    const a = apps[id];
    if (!a || typeof a !== 'object' || typeof id !== 'string' || id.length > 1024) continue;
    const cpuSec = Number(a.cpuSec);
    if (!Number.isFinite(cpuSec) || cpuSec < 0) continue;
    out.apps[id] = { name: typeof a.name === 'string' ? a.name.slice(0, 260) : id, cpuSec, app: a.app === true,
      path: typeof a.path === 'string' && a.path.length <= 1024 && /^[a-z]:\\/i.test(a.path) ? a.path : null };
  }
  const seen = raw.seen && typeof raw.seen === 'object' ? raw.seen : {};
  for (const k of Object.keys(seen)) { const v = Number(seen[k]); if (/^\d+\|\d*$/.test(k) && Number.isFinite(v) && v >= 0) out.seen[k] = v; }
  return out;
}

function create(opts) {
  const o = opts || {};
  const file = o.file;
  if (!file || typeof file !== 'string') throw new Error('app history needs a file to keep its record in');
  const now = typeof o.now === 'function' ? o.now : Date.now;
  let st = fresh(now());
  let loadError = null;

  function load() {
    loadError = null;
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
      if (e.code !== 'ENOENT') loadError = `the saved app history could not be read (${e.message}), so it starts again from now`;
      st = fresh(now());
      return false;
    }
    let raw = null;
    try { raw = JSON.parse(text); } catch (_) { raw = null; }
    const s = sanitize(raw, now());
    if (!s) { loadError = 'the saved app history was damaged, so it starts again from now'; st = fresh(now()); return false; }
    st = s;
    return true;
  }

  function save() {
    const tmp = `${file}.tmp`;
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch (_) { /* exists */ }
    fs.writeFileSync(tmp, JSON.stringify(st));
    fs.renameSync(tmp, file);
  }

  function trim() {
    const ids = Object.keys(st.apps);
    if (ids.length <= MAX_APPS) return;
    ids.sort((a, b) => st.apps[a].cpuSec - st.apps[b].cpuSec);
    for (const id of ids.slice(0, ids.length - MAX_APPS)) delete st.apps[id];
  }

  /** One snapshot: add every user process's CPU time since the last record. Returns the apps touched. */
  function record(snap) {
    if (!snap || !Array.isArray(snap.procs)) return 0;
    const at = now();
    const last = st.lastAt;
    const seen = {};
    let touched = 0;
    for (const p of snap.procs) {
      if (!p || !(p.pid > 0) || p.session === 0) continue;
      const cpu = Number(p.cpu);
      if (!Number.isFinite(cpu) || cpu < 0) continue;
      const k = `${p.pid}|${p.created}`;
      seen[k] = cpu;
      let add = 0;
      const before = st.seen[k];
      if (before !== undefined) add = cpu - before;
      else if (last !== null) { const c = createdMs(p.created); if (c !== null && c >= last) add = cpu; }   // started since the last record
      const id = C.identityOf(p);
      const hadWindow = (p.windows || 0) > 0;
      if (add <= 0 && !(hadWindow && st.apps[id] && !st.apps[id].app)) continue;
      const a = st.apps[id] || (st.apps[id] = { name: C.nameOf(p), cpuSec: 0, app: false, path: null });
      if (add > 0) { a.cpuSec += add / 1e7; touched++; }   // 100 ns units -> seconds
      if (hadWindow) a.app = true;   // the record's own "showed a window" (kept in the file; the model's app is "a Store app")
      a.name = C.nameOf(p);
      if (typeof p.path === 'string' && p.path) a.path = p.path;
    }
    st.seen = seen;
    st.lastAt = at;
    trim();
    save();
    return touched;
  }

  /** model.apphistory (TM-SPEC App history). */
  function model(mo) {
    const all = !!(mo && mo.allProcesses);
    const rows = [];
    for (const id of Object.keys(st.apps)) {
      const a = st.apps[id];
      // path: the exe as the snapshot saw it (an older record kept only the lower-cased identity, which opens the same file)
      const file = a.path || (/^[a-z]:\\/i.test(id) ? id : null);
      const app = isPackagedPath(file || id);
      if (!all && !app) continue;
      const row = { name: a.name, identity: id, cpuTimeSec: Math.round(a.cpuSec * 1000) / 1000, app, path: file };
      for (const f of NULL_FIELDS) row[f] = null;
      row.why = { net: WHY.net, metered: WHY.net, nonMetered: WHY.net, downloads: WHY.net, uploads: WHY.net, tiles: WHY.tiles };
      if (!file) row.why.path = WHY.path;
      rows.push(row);
    }
    rows.sort((x, y) => y.cpuTimeSec - x.cpuTimeSec);
    return {
      since: new Date(st.since).toISOString(),
      rows,
      source: 'mantle',
      error: loadError,
      why: { net: WHY.net, tiles: WHY.tiles },
      note: "Mantle's own record (CPU time only), kept since it started. Windows keeps the full App history for administrators: set up administrator access to see it.",
    };
  }

  /** "Delete usage history": the record starts again now; what is running now counts only from here. */
  function clear() {
    const seen = st.seen;
    st = fresh(now());
    st.seen = seen;
    st.lastAt = now();
    loadError = null;
    save();
  }

  load();
  return { record, model, clear, save, load, get since() { return st.since; } };
}

module.exports = { create, createdMs, isPackagedPath, WHY, MAX_APPS };
