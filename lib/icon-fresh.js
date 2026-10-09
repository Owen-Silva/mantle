'use strict';
/*
 * icon-fresh.js - when a cached app icon has to be asked for again (mantle-icon, 2026-10-08).
 *
 * WHY: Owen's bar showed Helm's OLD icon for a day after helm.exe was rebuilt at the same path
 * with a new one. Every icon cache on the way kept the first picture until Mantle restarted: the
 * sidecar's (sidecar/Icons.cs, now checks the file), main.js's iconFor cache (the bar) and the
 * launcher's G.icons (lib/launcher-index.js). Both JS caches use this:
 *   - an entry remembers the file's stamp (last-write time + size) when it was asked for, and a
 *     lookup re-stats the file at most once per statEveryMs: a changed file is asked for again;
 *   - an entry older than recheckMs is asked for again too, because a .lnk's stamp does not move
 *     when the exe it points at is rebuilt, and a Store app id has no file at all. That re-ask is
 *     cheap: the sidecar answers from its own cache unless the file (or the shortcut's target)
 *     changed, which it checks itself.
 * A path that is not a file path (a 'shell:AppsFolder\<id>' Store app) has no stamp: age only.
 */
const fs = require('fs');

const STAT_EVERY_MS = 2000;

/** 'mtimeMs:size' for a file, 'missing' / 'not-a-file' for none, null for a path that is not a file path. */
function fileStamp(p, statSync = fs.statSync) {
  if (typeof p !== 'string' || !/^(?:[A-Za-z]:[\\/]|\\\\)/.test(p)) return null;
  try {
    const st = statSync(p);
    return st.isFile() ? `${Math.round(st.mtimeMs)}:${st.size}` : 'not-a-file';
  } catch (_) {
    return 'missing';
  }
}

/** A cache entry: `fields` plus what it was asked against. */
function stamp(fields, p, opts = {}) {
  const now = opts.now != null ? opts.now : Date.now();
  return Object.assign({}, fields, { stamp: fileStamp(p, opts.statSync), askedAt: now, checkedAt: now, stale: false });
}

/**
 * Can `entry` still be served for path `p`? False once the file changed (sticky: the entry is
 * marked stale) or the entry is older than opts.recheckMs. No entry is never fresh.
 */
function isFresh(entry, p, opts = {}) {
  if (!entry) return false;
  if (entry.stale) return false;
  const now = opts.now != null ? opts.now : Date.now();
  if (opts.recheckMs != null && now - (entry.askedAt || 0) >= opts.recheckMs) return false;
  const every = opts.statEveryMs != null ? opts.statEveryMs : STAT_EVERY_MS;
  if (now - (entry.checkedAt || 0) < every) return true;
  entry.checkedAt = now;
  if (fileStamp(p, opts.statSync) === (entry.stamp === undefined ? null : entry.stamp)) return true;
  entry.stale = true;
  return false;
}

module.exports = { fileStamp, stamp, isFresh, STAT_EVERY_MS };
