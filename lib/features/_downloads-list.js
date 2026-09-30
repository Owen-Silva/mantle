'use strict';
/*
 * _downloads-list.js - what the Downloads shelf shows, and the plain fallback read (lane downloads,
 * 2026-09-27). Pure except listFolder(); lib/features/downloads.test.js proves both on a temp folder.
 *
 * The ONE place the shelf's policy lives:
 *   - a partial download (.crdownload Chrome/Edge, .part Firefox, .opdownload Opera, .partial old
 *     Edge, .tmp anything) is skipped until it is renamed to its real name, but COUNTED, so the panel
 *     can say "1 still downloading";
 *   - hidden and system files: the sidecar's read drops them by their Windows attributes; here the
 *     names Windows or Office hide by convention go too (desktop.ini, Thumbs.db, ~$ lock files,
 *     dot-files), which is all the plain read below can do;
 *   - newest ARRIVAL first: the later of the creation and the last-write time (see sidecar/Downloads.cs).
 *
 * listFolder() is the read used ONLY when the sidecar cannot answer (down, or a sidecar build from
 * before this lane). It cannot see file attributes, so the panel says it is the plainer read.
 *
 * PRIVACY: nothing here logs, and no reason carries a file name or a path.
 */
const fs = require('fs');
const path = require('path');

const PARTIAL = new Set(['.crdownload', '.part', '.partial', '.tmp', '.opdownload']);
const PARTIAL_STALE_MS = 10 * 60 * 1000;   // unwritten this long: an abandoned partial, not a download
const JUNK = new Set(['desktop.ini', 'thumbs.db', 'ehthumbs.db', '.ds_store']);

/** 'partial' | 'hidden' | null (shown). */
function skipReason(name) {
  const low = String(name || '').toLowerCase();
  if (!low) return 'hidden';
  if (JUNK.has(low) || low.startsWith('.') || low.startsWith('~$')) return 'hidden';
  if (PARTIAL.has(path.extname(low))) return 'partial';
  return null;
}

function arrival(e) {
  return Math.max(Number(e && e.birthMs) || 0, Number(e && e.mtimeMs) || 0);
}

/**
 * entries: [{name, dir, size, birthMs, mtimeMs}] (the sidecar's shape, any order).
 * -> { items: [{name, dir, size, at, fresh}] newest first (at most `max`), newCount, partial, skipped, shown }
 * `fresh`: arrived after seenAt (the last time Owen opened the shelf).
 */
function shelf(entries, opts) {
  const o = opts || {};
  const max = Number.isFinite(o.max) ? Math.max(0, o.max) : 12;
  const seenAt = Number(o.seenAt) || 0;
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const keep = [];
  let partial = 0, skipped = 0;
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || typeof e.name !== 'string') { skipped++; continue; }
    const why = skipReason(e.name);
    /* A partial file counts as "still downloading" only while it is being written: one left behind
       by a cancelled or crashed download (Owen's folder had two .part files from August) would
       otherwise say "2 still downloading…" forever. No write time (the plain read does not stat
       partials) keeps the old answer. */
    if (why === 'partial') {
      const m = Number(e.mtimeMs);
      if (Number.isFinite(m) && m > 0 && now - m > PARTIAL_STALE_MS) skipped++; else partial++;
      continue;
    }
    if (why) { skipped++; continue; }
    keep.push(e);
  }
  keep.sort((a, b) => (arrival(b) - arrival(a)) || a.name.localeCompare(b.name));
  let newCount = 0;
  for (const e of keep) if (arrival(e) > seenAt) newCount++;
  const items = keep.slice(0, max).map((e) => ({
    name: e.name,
    dir: !!e.dir,
    size: e.dir ? 0 : Math.max(0, Number(e.size) || 0),
    at: arrival(e),
    fresh: arrival(e) > seenAt,
  }));
  return { items, newCount, partial, skipped, shown: keep.length };
}

/* The words for a failed fs call, never with the path node puts in err.message. The reason is for the
   SCREEN (plain words, no error codes); `code` is for the log line only. */
function fsWhy(err, doing) {
  const code = (err && err.code) || 'error';
  if (code === 'ENOENT') return { state: 'missing', code, reason: 'the Downloads folder does not exist (it was moved, renamed or deleted)' };
  if (code === 'ENOTDIR') return { state: 'missing', code, reason: 'the Downloads location is a file, not a folder' };
  if (code === 'EACCES' || code === 'EPERM') return { state: 'unreadable', code, reason: `Windows did not let Mantle ${doing} the Downloads folder (access denied)` };
  return { state: 'unreadable', code, reason: `the Downloads folder could not be ${doing === 'list' ? 'listed' : 'read'}: Windows reported a disk or network error` };
}

/* Jargon a reason must never put on screen (BRIEF: no error codes, HRESULTs, "sidecar", "Electron",
   "undefined"...). downloads.test.js runs every reason the shelf can show through this. */
const JARGON = /\b(E[A-Z]{3,}|HRESULT|0x[0-9a-fA-F]{4,}|[Ss]idecar|[Ee]lectron|hwnd|IPC|[Rr]enderer|dryRun|undefined|null|NaN|\w+Exception)\b|\[object/;

/**
 * The plain read: the folder walked a batch at a time + a stat per shown name (partials and junk are
 * counted, never stat'ed). Same answer shape as the sidecar's downloads.list; never throws.
 *
 * MAIN-THREAD COST: this runs in Electron's main process, so it never does the whole folder in one go.
 * A readdir + one Promise.all of stats over 100k entries blocked main 4 s (measured 2026-09-27); here
 * the walk is fs.opendir in batches, stats go STAT_BATCH at a time, and only the newest `max` are kept.
 *
 * A name Windows keeps with a lone UTF-16 surrogate comes back from node with U+FFFD in it, a path that
 * does not exist: it is counted in `unspellable`, never listed (a row that cannot open, or opens a twin).
 */
const STAT_BATCH = 64;
async function listFolder(folder, opts) {
  const o = opts || {};
  const max = Number.isFinite(o.max) ? Math.max(0, o.max) : 60;
  let dir;
  try {
    dir = await fs.promises.opendir(folder, { bufferSize: 128 });
  } catch (err) {
    return Object.assign({ ok: false, folder, via: 'plain read' }, fsWhy(err, 'list'));
  }
  let out = [];
  const named = [];   // partials and junk, kept (uncut) so shelf() can count them
  let total = 0, unspellable = 0, batch = [];
  const byArrival = (a, b) => (arrival(b) - arrival(a)) || a.name.localeCompare(b.name);
  async function statBatch(ds) {
    const got = await Promise.all(ds.map(async (d) => {
      try {
        const st = await fs.promises.stat(path.join(folder, d.name));
        return { name: d.name, dir: st.isDirectory(), size: st.isDirectory() ? 0 : st.size, birthMs: Math.round(st.birthtimeMs || 0), mtimeMs: Math.round(st.mtimeMs || 0) };
      } catch (err) {
        if (err && err.code === 'ENOENT' && d.name.includes('�')) { unspellable++; return null; }
        /* gone between the listing and the stat (a browser renaming its partial), or locked: listed
           without times, so it sorts last and the next read has it right */
        return { name: d.name, dir: d.isDirectory(), size: 0, birthMs: 0, mtimeMs: 0 };
      }
    }));
    for (const e of got) if (e) { out.push(e); total++; }
    if (out.length > max) { out.sort(byArrival); out = out.slice(0, max); }
  }
  try {
    for await (const d of dir) {
      if (skipReason(d.name)) { named.push({ name: d.name, dir: false, size: 0, birthMs: 0, mtimeMs: 0 }); continue; }
      batch.push(d);
      if (batch.length >= STAT_BATCH) { const b = batch; batch = []; await statBatch(b); }
    }
    if (batch.length) await statBatch(batch);
  } catch (err) {
    try { await dir.close(); } catch (_) { /* already closed by the iterator */ }
    return Object.assign({ ok: false, folder, via: 'plain read' }, fsWhy(err, 'list'));
  }
  out.sort(byArrival);
  return { ok: true, folder, via: 'plain read', total: total + named.length, hidden: null, unspellable, items: out.slice(0, max).concat(named) };
}


module.exports = { PARTIAL, JUNK, JARGON, skipReason, arrival, shelf, listFolder, fsWhy };
