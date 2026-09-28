'use strict';
/*
 * _notes-store.js - the quick notes FILE (lane tbnotes, 2026-09-27). fs only: no Electron, no ctx.
 * lib/features/notes.js drives it; lib/features/notes.test.js proves it in a temp folder.
 *
 * THE FILE: several notes in ONE Markdown file Owen can open and read by hand.
 *     <!-- mantle:note -->
 *     first note's text
 *     <!-- mantle:note -->
 *     second note's text
 *   Each note = the marker line, then its text, then "\n". A file without any marker is ONE note
 *   (written by hand). CRLF reads as LF, a UTF-8 BOM is dropped. Text before the first marker (a hand
 *   edit) becomes a note of its own, so nothing typed into the file is ever dropped.
 * ESCAPE: any text round-trips exactly. On write, a text line matching /^\\*<!-- mantle:note/ gets
 *   one more leading backslash; on read one is removed. So no text line can ever look like a marker.
 *   (A "\r" inside a note is written as "\n": a textarea never holds one.)
 *
 * SAVES never lose text:
 *   - ATOMIC: notes.md.tmp-<pid> then rename over notes.md, retrying EPERM/EBUSY/EACCES for ~1 s
 *     (antivirus, OneDrive and editors hold files for a moment). The tmp file never stays behind.
 *   - SERIALIZED: one write at a time; while one runs, the newest text waits (older ones are
 *     dropped: the latest text wins).
 *   - OUTSIDE CHANGE: the mtime+size (and the text) of what was last read or written is kept. If the
 *     file on disk differs before a write, it is first copied to
 *     "notes (changed outside Mantle YYYY-MM-DD HHMMSS).md" in the same folder; if that copy cannot
 *     be made the write is REFUSED (the outside text is never overwritten unkept).
 *   - DELETE: a deleted note's text is appended to deleted.md (a dated marker line first) BEFORE it
 *     leaves notes.md; the caller refuses the delete if that append fails.
 *   - FAILURES answer { ok:false, reason } in plain words with the path. Nothing here throws.
 * PRIVACY: reasons carry paths and error codes only, never a word of note text.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const MARKER = '<!-- mantle:note -->';
const IS_MARKER = /^<!-- mantle:note/;
const NEEDS_ESC = /^\\*<!-- mantle:note/;
const HAS_ESC = /^\\+<!-- mantle:note/;
const RETRY = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RETRY_MS = 100;
const RETRY_TRIES = 10;                 // ~1 s

const pad2 = (n) => String(n).padStart(2, '0');
/** "2026-09-27 211403" (local time): the outside-change copy's name. */
function stamp(d) {
  const t = d instanceof Date ? d : new Date(d || Date.now());
  return `${t.getFullYear()}-${pad2(t.getMonth() + 1)}-${pad2(t.getDate())} ${pad2(t.getHours())}${pad2(t.getMinutes())}${pad2(t.getSeconds())}`;
}
/** "2026-09-27 21:14:03" (local time): deleted.md's marker. */
function stampHuman(d) {
  const t = d instanceof Date ? d : new Date(d || Date.now());
  return `${t.getFullYear()}-${pad2(t.getMonth() + 1)}-${pad2(t.getDate())} ${pad2(t.getHours())}:${pad2(t.getMinutes())}:${pad2(t.getSeconds())}`;
}

function escapeText(text) {
  return String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n')
    .map((l) => (NEEDS_ESC.test(l) ? '\\' + l : l)).join('\n');
}
const unescapeLines = (lines) => lines.map((l) => (HAS_ESC.test(l) ? l.slice(1) : l));

/** texts[] -> the file's text. Never empty: no notes is written as one empty note. */
function serialize(texts) {
  const list = Array.isArray(texts) && texts.length ? texts : [''];
  return list.map((t) => MARKER + '\n' + escapeText(t) + '\n').join('');
}

/** The file's text -> { texts[], markers, preamble }. PURE. */
function parse(raw) {
  let s = String(raw == null ? '' : raw);
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
  s = s.replace(/\r\n/g, '\n');
  if (s.endsWith('\n')) s = s.slice(0, -1);          // the last note's own "\n"
  const lines = s.split('\n');
  const first = lines.findIndex((l) => IS_MARKER.test(l));
  if (first < 0) return { texts: [s], markers: 0, preamble: false };   // hand-written: one note, as is
  const texts = [];
  const pre = lines.slice(0, first).join('\n');
  const preamble = pre.trim() !== '';
  if (preamble) texts.push(pre);                      // a hand edit above the first marker is kept
  let body = null, markers = 0;
  for (let i = first; i < lines.length; i++) {
    if (IS_MARKER.test(lines[i])) {
      if (body) texts.push(unescapeLines(body).join('\n'));
      body = [];
      markers++;
    } else body.push(lines[i]);
  }
  texts.push(unescapeLines(body).join('\n'));
  return { texts, markers, preamble };
}

/** Plain words for an fs error at path p. Paths and codes only: never text. */
function why(err, p) {
  const code = err && err.code;
  switch (code) {
    case 'ENOSPC': return 'the disk is full';                 // every caller already names the file
    case 'EACCES': case 'EPERM': return `Windows refused access to ${p} (read-only, or another program holds it)`;
    case 'EBUSY': return `${p} is in use by another program`;
    case 'EROFS': return `the drive of ${p} is read-only`;
    case 'ENOENT': return `${p} does not exist`;
    case 'EISDIR': return `${p} is a folder, not a file`;
    case 'ENOTDIR': case 'EEXIST': return `a file is in the way of the folder ${p}`;
    default: return `${p}: ${code || (err && err.message) || 'unknown error'}`;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function statOf(p) {
  try { const s = await fsp.stat(p); return { exists: true, mtimeMs: s.mtimeMs, size: s.size, dir: s.isDirectory() }; } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return { exists: false };
    return { error: e };
  }
}
const same = (a, b) => !!a && !!b && a.exists === b.exists && (!a.exists || (a.mtimeMs === b.mtimeMs && a.size === b.size));

/** mkdir -p, then make sure it IS a folder. -> null or the reason. */
async function ensureDir(dir) {
  try {
    await fsp.mkdir(dir, { recursive: true });
  } catch (e) {
    if (e && (e.code === 'EEXIST' || e.code === 'ENOTDIR')) return `a file is in the way of the folder ${dir}`;
    return `the folder could not be made: ${why(e, dir)}`;
  }
  const s = await statOf(dir);
  if (s.error) return why(s.error, dir);
  if (!s.exists || !s.dir) return `a file is in the way of the folder ${dir}`;
  return null;
}

async function renameRetry(from, to) {
  let last = null;
  for (let i = 0; i < RETRY_TRIES; i++) {
    try { await fsp.rename(from, to); return null; } catch (e) {
      last = e;
      if (!RETRY.has(e && e.code)) break;
      await sleep(RETRY_MS);
    }
  }
  return last;
}

/**
 * createStore({ dir }) -> { dir, file, deletedFile, load, save, changedOnDisk, appendDeleted, rescue }
 */
function createStore(opts) {
  const dir = opts.dir;
  const file = path.join(dir, 'notes.md');
  const deletedFile = path.join(dir, 'deleted.md');
  const pid = opts.pid || process.pid;
  let known = null;        // stat of what was last read or written: { exists, mtimeMs, size }
  let lastText = null;     // the exact file text last read or written
  let queued = null;       // { texts, waiters[] }: the newest text waiting for the running write
  let running = false;

  /** -> { ok, texts, missing, reason, markers, preamble } (ok:false = unreadable; texts is then ['']) */
  async function load() {
    const s = await statOf(file);
    if (s.error) { known = null; return { ok: false, texts: [''], reason: `could not read ${file}: ${why(s.error, file)}` }; }
    if (!s.exists) { known = { exists: false }; lastText = null; return { ok: true, texts: [''], missing: true }; }
    if (s.dir) { known = null; return { ok: false, texts: [''], reason: `${file} is a folder, not a file` }; }
    let raw;
    try { raw = await fsp.readFile(file, 'utf8'); } catch (e) { known = null; return { ok: false, texts: [''], reason: `could not read ${file}: ${why(e, file)}` }; }
    const after = await statOf(file);
    known = after.exists ? after : s;
    lastText = raw;
    const p = parse(raw);
    return { ok: true, texts: p.texts, missing: false, markers: p.markers, preamble: p.preamble };
  }

  /** Did notes.md change on disk since it was last read or written? A touch with the same text is not a change. */
  async function changedOnDisk() {
    const s = await statOf(file);
    if (s.error) return false;
    if (same(s, known)) return false;
    if (!s.exists) return !!(known && known.exists);
    try {
      const raw = await fsp.readFile(file, 'utf8');
      if (lastText !== null && raw === lastText) { known = s; return false; }
    } catch (_) { /* unreadable: report it changed; the caller loads and says why */ }
    return true;
  }

  async function copyAside(when) {
    const base = `notes (changed outside Mantle ${stamp(when)})`;
    for (let n = 1; n < 50; n++) {
      const p = path.join(dir, (n === 1 ? base : `${base} ${n}`) + '.md');
      try { await fsp.copyFile(file, p, fs.constants.COPYFILE_EXCL); return { path: p }; } catch (e) {
        if (e && e.code === 'EEXIST') continue;
        return { reason: why(e, p) };
      }
    }
    return { reason: `too many copies named "${base}" already in ${dir}` };
  }

  async function writeNow(texts, now) {
    const at = now || Date.now();
    const count = texts.length || 1;
    const chars = texts.reduce((a, t) => a + String(t).length, 0);
    const bad = await ensureDir(dir);
    if (bad) return { ok: false, reason: `could not save ${file}: ${bad}` };
    const out = serialize(texts);
    let outside = null;
    const s = await statOf(file);
    if (s.error) return { ok: false, reason: `could not check ${file} before saving: ${why(s.error, file)}` };
    if (s.exists && s.dir) return { ok: false, reason: `could not save: ${file} is a folder, not a file` };
    if (!same(s, known) && s.exists) {
      // Changed since we last read or wrote it (or never read): keep that version before ours goes over it.
      let raw = null;
      try { raw = await fsp.readFile(file, 'utf8'); } catch (e) {
        return { ok: false, reason: `${file} changed outside Mantle and could not be read (${why(e, file)}), so it was not overwritten` };
      }
      if (raw === out) { known = s; lastText = raw; return { ok: true, at, count, chars, bytes: Buffer.byteLength(out), outside: null, skipped: true }; }
      if (lastText === null || raw !== lastText) {
        const c = await copyAside(at);
        if (!c.path) return { ok: false, reason: `${file} changed outside Mantle and a copy of that version could not be kept (${c.reason}), so it was not overwritten` };
        outside = c.path;
      }
    } else if (s.exists && out === lastText) {
      return { ok: true, at, count, chars, bytes: Buffer.byteLength(out), outside: null, skipped: true };
    }
    const tmp = `${file}.tmp-${pid}`;
    try {
      await fsp.writeFile(tmp, out, 'utf8');
    } catch (e) {
      await fsp.unlink(tmp).catch(() => {});
      return { ok: false, reason: `could not save ${file}: ${why(e, tmp)}`, outside };
    }
    const err = await renameRetry(tmp, file);
    if (err) {
      await fsp.unlink(tmp).catch(() => {});
      return { ok: false, reason: `could not save ${file}: ${why(err, file)}`, outside };
    }
    const after = await statOf(file);
    known = after.exists ? after : null;
    lastText = out;
    return { ok: true, at, count, chars, bytes: Buffer.byteLength(out), outside };
  }

  /** Queue texts[] for writing; resolves with that write's result (or the newer one that replaced it). */
  function save(texts, now) {
    const list = (Array.isArray(texts) ? texts : []).map((t) => String(t == null ? '' : t));
    return new Promise((resolve) => {
      if (queued) { queued.texts = list; queued.now = now; queued.waiters.push(resolve); } else queued = { texts: list, now, waiters: [resolve] };
      pump();
    });
  }
  async function pump() {
    if (running || !queued) return;
    running = true;
    const job = queued;
    queued = null;
    let r;
    try { r = await writeNow(job.texts, job.now); } catch (e) { r = { ok: false, reason: `could not save ${file}: ${e && e.message}` }; }
    running = false;
    for (const w of job.waiters) w(r);
    pump();
  }

  /** Append one deleted note to deleted.md: a dated marker line, then its text. -> { ok, reason } */
  async function appendDeleted(text, now) {
    const bad = await ensureDir(dir);
    if (bad) return { ok: false, reason: `could not keep the note in ${deletedFile}: ${bad}` };
    const block = `<!-- mantle:deleted ${stampHuman(now)} -->\n${escapeText(text)}\n`;
    try { await fsp.appendFile(deletedFile, block, 'utf8'); return { ok: true, file: deletedFile }; } catch (e) {
      return { ok: false, reason: `could not keep the note in ${deletedFile}: ${why(e, deletedFile)}` };
    }
  }

  return {
    dir, file, deletedFile, load, save, changedOnDisk, appendDeleted,
    get known() { return known; },
    get writing() { return running || !!queued; },
  };
}

/** A last-ditch copy of unsaved notes (Mantle is stopping and notes.md cannot be written). -> { ok, file, reason } */
async function writeRescue(folder, texts, now) {
  const p = path.join(folder, `notes-rescue ${stamp(now)}.md`);
  try {
    await fsp.mkdir(folder, { recursive: true });
    await fsp.writeFile(p, serialize(texts), { encoding: 'utf8', flag: 'wx' });
    return { ok: true, file: p };
  } catch (e) { return { ok: false, reason: why(e, p) }; }
}
/** Rescue files left by an earlier run, newest last. Names only. */
async function listRescue(folder) {
  try { return (await fsp.readdir(folder)).filter((n) => /^notes-rescue .*\.md$/.test(n)).sort().map((n) => path.join(folder, n)); } catch (_) { return []; }
}

module.exports = { MARKER, serialize, parse, escapeText, stamp, stampHuman, why, createStore, writeRescue, listRescue };
