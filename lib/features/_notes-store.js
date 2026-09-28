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
 *
 * HOSTILE FILES (security review 2, 2026-09-27). A notes.md the pad cannot hold faithfully is NOT
 * opened (load answers ok:false with the reason, shown in the pad) and is kept as a copy before any
 * save goes over it (known = null, so writeNow treats it as an outside version):
 *   - over MAX_BYTES (8 MB): a 100 MB file blocked main ~350 ms on EVERY autosave (serialize);
 *   - not valid UTF-8 (an ANSI "café", Notepad's UTF-16): read with U+FFFD in place of the bytes,
 *     the first autosave used to write that back, and the original bytes were gone for good;
 *   - over MAX_NOTES (500) notes: 100k tabs would each be a button in the pad.
 * A save over MAX_BYTES of text is refused (the text stays in the pad, which says why).
 * RACES: notes.md is stat-ed again right before EVERY rename try; if it changed since the save
 * began (OneDrive landing a synced version while it held the file and the rename was retrying),
 * the save starts over, so that version is kept as a copy instead of being renamed over.
 * LINKS: the tmp file is removed and made with O_EXCL (a planted link cannot redirect it), and
 * deleted.md is never appended through a symbolic link or a hard link (the delete is refused).
 * COPIES: at most MAX_COPIES outside-change copies per COPY_WINDOW_MS; past that a save is refused
 * with the reason (text stays in the pad) instead of filling the folder.
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
const MAX_BYTES = 8 * 1024 * 1024;      // the most the pad opens or saves
const MAX_NOTES = 500;                  // the most notes (tabs) the pad opens
const MAX_COPIES = 10;                  // outside-change copies ...
const COPY_WINDOW_MS = 10 * 60 * 1000;  // ... per 10 minutes
const RESTARTS = 3;                     // a save that finds notes.md changed under it starts over this often
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
let isUtf8 = null;
try { isUtf8 = require('buffer').isUtf8 || null; } catch (_) { isUtf8 = null; }
/** Valid UTF-8? (buffer.isUtf8 in Node >= 18.14; a fatal TextDecoder otherwise) */
function validUtf8(buf) {
  if (isUtf8) return isUtf8(buf);
  try { new TextDecoder('utf-8', { fatal: true }).decode(buf); return true; } catch (_) { return false; }
}

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

/** rename, retrying the "held for a moment" errors. `unchanged()` runs before EVERY try: false ->
 * an error with code 'CHANGED' (the target changed under the save: never rename over it). */
async function renameRetry(from, to, unchanged) {
  let last = null;
  for (let i = 0; i < RETRY_TRIES; i++) {
    if (unchanged && !(await unchanged())) { const e = new Error('changed during the save'); e.code = 'CHANGED'; return e; }
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

  /** -> { ok, texts, missing, reason, markers, preamble } (ok:false = unreadable or refused; texts is then ['']) */
  async function load() {
    const s = await statOf(file);
    if (s.error) { known = null; return { ok: false, texts: [''], reason: `could not read ${file}: ${why(s.error, file)}` }; }
    if (!s.exists) { known = { exists: false }; lastText = null; return { ok: true, texts: [''], missing: true }; }
    if (s.dir) { known = null; return { ok: false, texts: [''], reason: `${file} is a folder, not a file` }; }
    // A file the pad cannot hold as it is: not opened, and known = null so the first save keeps it as a copy.
    const refuse = (words) => { known = null; lastText = null; return { ok: false, texts: [''], refused: true, reason: `${words}, so the pad did not open it; it is left as it is, and if you save notes here it is first kept as a copy` }; };
    if (s.size > MAX_BYTES) return refuse(`${file} is ${mb(s.size)}, over the ${mb(MAX_BYTES)} the pad opens`);
    let buf;
    try { buf = await fsp.readFile(file); } catch (e) { known = null; return { ok: false, texts: [''], reason: `could not read ${file}: ${why(e, file)}` }; }
    if (buf.length > MAX_BYTES) return refuse(`${file} is ${mb(buf.length)}, over the ${mb(MAX_BYTES)} the pad opens`);
    if (!validUtf8(buf)) return refuse(`${file} is not UTF-8 text${buf[0] === 0xff && buf[1] === 0xfe ? ' (it looks like UTF-16)' : ''}`);
    const raw = buf.toString('utf8');
    const p = parse(raw);
    if (p.texts.length > MAX_NOTES) return refuse(`${file} holds ${p.texts.length} notes, over the ${MAX_NOTES} the pad opens`);
    const after = await statOf(file);
    known = after.exists ? after : s;
    lastText = raw;
    return { ok: true, texts: p.texts, missing: false, markers: p.markers, preamble: p.preamble };
  }

  /** notes.md as text, or null when it is too big or not UTF-8 (a version the pad never holds). Throws on a read error. */
  async function readText(s) {
    if (s && s.size > MAX_BYTES) return null;
    const buf = await fsp.readFile(file);
    if (buf.length > MAX_BYTES || !validUtf8(buf)) return null;
    return buf.toString('utf8');
  }

  /** Did notes.md change on disk since it was last read or written? A touch with the same text is not a change. */
  async function changedOnDisk() {
    const s = await statOf(file);
    if (s.error) return false;
    if (same(s, known)) return false;
    if (!s.exists) return !!(known && known.exists);
    try {
      const raw = await readText(s);
      if (raw !== null && lastText !== null && raw === lastText) { known = s; return false; }
    } catch (_) { /* unreadable: report it changed; the caller loads and says why */ }
    return true;
  }

  const copies = [];   // when this store made each outside-change copy (the flood cap)
  async function copyAside(when) {
    const t = Date.now();
    while (copies.length && t - copies[0] >= COPY_WINDOW_MS) copies.shift();
    if (copies.length >= MAX_COPIES) {
      return { reason: `it changed outside Mantle ${copies.length} times in ${Math.round(COPY_WINDOW_MS / 60000)} min and each version was already kept as a copy in ${dir}; close the program that keeps changing it (your text stays in the pad and is saved once it stops)` };
    }
    const base = `notes (changed outside Mantle ${stamp(when)})`;
    for (let n = 1; n < 50; n++) {
      const p = path.join(dir, (n === 1 ? base : `${base} ${n}`) + '.md');
      try { await fsp.copyFile(file, p, fs.constants.COPYFILE_EXCL); copies.push(t); return { path: p }; } catch (e) {
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
    if (chars > MAX_BYTES) return { ok: false, reason: `could not save ${file}: the notes are ${mb(chars)} of text, over the ${mb(MAX_BYTES)} the pad saves; the text stays in the pad (make it shorter)` };
    const bad = await ensureDir(dir);
    if (bad) return { ok: false, reason: `could not save ${file}: ${bad}` };
    const out = serialize(texts);
    const bytes = Buffer.byteLength(out);
    if (bytes > MAX_BYTES) return { ok: false, reason: `could not save ${file}: the notes are ${mb(bytes)}, over the ${mb(MAX_BYTES)} the pad saves; the text stays in the pad (make it shorter)` };
    let outside = null;
    for (let attempt = 0; ; attempt++) {
      const s = await statOf(file);
      if (s.error) return { ok: false, reason: `could not check ${file} before saving: ${why(s.error, file)}`, outside };
      if (s.exists && s.dir) return { ok: false, reason: `could not save: ${file} is a folder, not a file`, outside };
      if (!same(s, known) && s.exists) {
        // Changed since we last read or wrote it (or never read, or refused): keep that version before ours goes over it.
        let raw = null;
        try { raw = await readText(s); } catch (e) {
          return { ok: false, reason: `${file} changed outside Mantle and could not be read (${why(e, file)}), so it was not overwritten`, outside };
        }
        if (raw !== null && raw === out) { known = s; lastText = raw; return { ok: true, at, count, chars, bytes, outside, skipped: true }; }
        if (raw === null || lastText === null || raw !== lastText) {
          const c = await copyAside(at);
          if (!c.path) return { ok: false, reason: `${file} changed outside Mantle and a copy of that version could not be kept (${c.reason}), so it was not overwritten`, outside };
          outside = c.path;
        }
      } else if (s.exists && out === lastText) {
        return { ok: true, at, count, chars, bytes, outside, skipped: true };
      }
      const tmp = `${file}.tmp-${pid}`;
      try {
        await fsp.unlink(tmp).catch(() => {});                      // a leftover (or a planted link) goes first
        await fsp.writeFile(tmp, out, { encoding: 'utf8', flag: 'wx' });   // O_EXCL: never written THROUGH a link
      } catch (e) {
        if (!(e && e.code === 'EEXIST')) await fsp.unlink(tmp).catch(() => {});
        return { ok: false, reason: `could not save ${file}: ${why(e, tmp)}`, outside };
      }
      // notes.md must still be the version checked above at the moment it is renamed over.
      const err = await renameRetry(tmp, file, async () => same(await statOf(file), s));
      if (err) {
        await fsp.unlink(tmp).catch(() => {});
        if (err.code === 'CHANGED') {
          if (attempt + 1 < RESTARTS) continue;                     // start over: that version is kept first
          return { ok: false, reason: `could not save ${file}: it kept changing outside Mantle while saving (${RESTARTS} tries), so it was not overwritten`, outside };
        }
        return { ok: false, reason: `could not save ${file}: ${why(err, file)}`, outside };
      }
      const after = await statOf(file);
      known = after.exists ? after : null;
      lastText = out;
      return { ok: true, at, count, chars, bytes, outside };
    }
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
    // Never append THROUGH a link: a deleted.md that is a symbolic or hard link would put note text
    // into some other file. (lstat does not follow; nlink > 1 = a hard link to another name.)
    try {
      const l = await fsp.lstat(deletedFile);
      if (l.isSymbolicLink() || (l.isFile() && l.nlink > 1)) {
        return { ok: false, reason: `could not keep the note in ${deletedFile}: it is a link to another file, so Mantle did not write into it (move it away and delete again)` };
      }
    } catch (e) {
      if (!(e && e.code === 'ENOENT')) return { ok: false, reason: `could not keep the note in ${deletedFile}: ${why(e, deletedFile)}` };
    }
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

module.exports = { MARKER, MAX_BYTES, MAX_NOTES, MAX_COPIES, serialize, parse, escapeText, stamp, stampHuman, why, validUtf8, createStore, writeRescue, listRescue };
