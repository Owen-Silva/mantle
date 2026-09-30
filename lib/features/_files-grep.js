'use strict';
/*
 * _files-grep.js - Mantle Files' search INSIDE files (lane files2, 2026-09-29).
 *
 * WHAT: files.search with contents:true. A breadth-first walk under a folder that answers every item
 * whose NAME matches (same rule as the sidecar's name search: case-insensitive substring, or `*`/`?`
 * wildcards when the query has them) OR whose TEXT contains the query (case-insensitive). Text is
 * read from plain-text files (UTF-8 / UTF-16 with a BOM; anything with a NUL byte in its first 4 KB
 * is binary and skipped) and from the text inside Word / Excel / PowerPoint / OpenDocument files
 * (their XML, read straight out of the ZIP container with _files-zip's directory reader + zlib).
 *
 * WHY here, not Windows Search: Explorer's content search leans on the Windows Search indexer and
 * its IFilters (an old Windows service that is often off or behind). This needs neither: it reads
 * the files itself, so it works on any folder, indexed or not, right now.
 *
 * COST: at most FILE_MAX bytes per text file, DOC_MAX of XML per document, READS reads in flight, a
 * yield to the event loop between directories, the walk stops at `max` hits and on cancel. Reparse
 * points (links, junctions) are never followed. PRIVACY: nothing here logs.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const Z = require('./_files-zip.js');

const FILE_MAX = 8 * 1024 * 1024;          // a text file bigger than this is matched by name only
const DOC_MAX = 16 * 1024 * 1024;          // uncompressed XML read out of one document
const READS = 4;                           // files read at once
const SNIP = 90;                           // characters of context in a content hit's snippet

/** Extensions that are never text (skip the read entirely). Anything else is sniffed. */
const BINARY = new Set(('.exe .dll .sys .msi .cab .iso .img .vhd .vhdx .bin .dat .db .sqlite .pak .jar .class .pyc .o .obj .lib .pdb ' +
  '.zip .7z .rar .gz .tgz .bz2 .xz .zst .png .jpg .jpeg .gif .bmp .webp .heic .heif .tif .tiff .ico .psd .raw .cr2 .nef .dng .avif ' +
  '.mp3 .wav .flac .aac .m4a .ogg .opus .wma .mp4 .mkv .mov .avi .wmv .webm .m4v .ttf .otf .woff .woff2 .pdf .doc .xls .ppt .pst .ost ' +
  '.lnk .url .blend .fbx .unitypackage .apk .appx .msix .node .wasm').split(' '));
/** Office Open XML / OpenDocument: where their text lives inside the ZIP. */
const DOCS = {
  '.docx': /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/i,
  '.docm': /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/i,
  '.xlsx': /^xl\/(sharedStrings|worksheets\/sheet\d+)\.xml$/i,
  '.xlsm': /^xl\/(sharedStrings|worksheets\/sheet\d+)\.xml$/i,
  '.pptx': /^ppt\/(slides\/slide\d+|notesSlides\/notesSlide\d+)\.xml$/i,
  '.odt': /^content\.xml$/i, '.ods': /^content\.xml$/i, '.odp': /^content\.xml$/i,
};

/** The name rule, shared with the sidecar: substring, or a whole-name wildcard pattern. */
function nameMatcher(query) {
  const q = String(query || '').trim().toLowerCase();
  if (!/[*?]/.test(q)) return (n) => n.toLowerCase().includes(q);
  // A wildcard walk in linear-ish time, not a RegExp: "*a*a*a*a*a*a*a*b" as `^.*a.*a...b$` backtracks
  // for minutes on a long name and would freeze Mantle's main process (lane files-main, 2026-09-29).
  const pat = q.replace(/\*+/g, '*');
  return (name) => globMatch(pat, String(name).toLowerCase());
}

/** `*` any run, `?` one character; the classic two-pointer walk with one backtrack point, O(n*m) worst. */
function globMatch(p, s) {
  let i = 0, j = 0, star = -1, mark = 0;
  while (j < s.length) {
    if (i < p.length && (p[i] === '?' || p[i] === s[j])) { i++; j++; }
    else if (i < p.length && p[i] === '*') { star = i++; mark = j; }
    else if (star >= 0) { i = star + 1; j = ++mark; }
    else return false;
  }
  while (i < p.length && p[i] === '*') i++;
  return i === p.length;
}

/** Decode a text buffer (BOM aware); null when it looks binary. */
function decodeText(buf) {
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) return buf.subarray(2).toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) { const b = Buffer.from(buf.subarray(2, 2 + ((buf.length - 2) & ~1))); b.swap16(); return b.toString('utf16le'); }
  const head = buf.subarray(0, Math.min(buf.length, 4096));
  if (head.includes(0)) return null;
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return buf.subarray(3).toString('utf8');
  return buf.toString('utf8');
}

/** XML -> its text: tags become spaces, the five entities decoded. */
function xmlText(s) {
  return s.replace(/<\/(w:p|a:p|text:p|row|si)>/g, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ');
}

/** The text inside an Office / OpenDocument file, or null when it cannot be read. */
async function docText(file, ext) {
  const want = DOCS[ext];
  let fd = null;
  try {
    fd = await fs.promises.open(file, 'r');
    const st = await fd.stat();
    const entries = await Z.readDirectory(fd, st.size);
    const out = [];
    let total = 0;
    for (const e of entries) {
      if (e.dir || !want.test(e.name.replace(/\\/g, '/'))) continue;
      if (e.method !== 0 && e.method !== 8) continue;
      // Both sizes come from the file itself: a hostile document can claim a tiny text and a 4 GB
      // compressed part, and Buffer.alloc(csize) would try to take it (lane files-main, 2026-09-29).
      if (total + e.usize > DOC_MAX || e.csize > DOC_MAX || e.offset + e.csize > st.size) break;
      const lh = Buffer.alloc(30);
      await fd.read(lh, 0, 30, e.offset);
      if (lh.readUInt32LE(0) !== 0x04034b50) continue;
      const data = Buffer.alloc(e.csize);
      await fd.read(data, 0, e.csize, e.offset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28));
      const raw = e.method === 8 ? zlib.inflateRawSync(data, { maxOutputLength: DOC_MAX }) : data;
      total += raw.length;
      out.push(xmlText(raw.toString('utf8')));
    }
    return out.join('\n');
  } catch (_) {
    return null;
  } finally {
    if (fd) { try { await fd.close(); } catch (_) { /* gone */ } }
  }
}

/** A one-line snippet around the first match (the page shows it; never logged). */
function snippet(text, at, len) {
  const from = Math.max(0, at - Math.floor((SNIP - len) / 2));
  let s = text.slice(from, from + SNIP).replace(/\s+/g, ' ').trim();
  if (from > 0) s = '…' + s;
  if (from + SNIP < text.length) s += '…';
  return s;
}

/** Does this file's text contain the (lower-cased) needle? -> { hit, snip } | { skip: why } */
async function contentHit(file, ext, size, needle) {
  if (DOCS[ext]) {
    const t = await docText(file, ext);
    if (t == null) return { skip: 'unreadable' };
    const i = t.toLowerCase().indexOf(needle);
    return i >= 0 ? { hit: true, snip: snippet(t, i, needle.length) } : { hit: false };
  }
  if (BINARY.has(ext)) return { skip: 'binary' };
  if (size > FILE_MAX) return { skip: 'too big' };
  if (size === 0) return { hit: false };
  const buf = await fs.promises.readFile(file);
  const t = decodeText(buf);
  if (t == null) return { skip: 'binary' };
  const i = t.toLowerCase().indexOf(needle);
  return i >= 0 ? { hit: true, snip: snippet(t, i, needle.length) } : { hit: false };
}

/**
 * Walk `root` breadth first. opts: { max, onBatch(items), isCancelled(), batchMs }.
 * Items: { n, d, s, m, c, a, p, hit: 'name'|'content', snip } (a = 16 for a folder, 32 for a
 * file: node cannot read Windows' hidden bit, so content hits never hide).
 * -> { count, capped, denied, skipped, read, ms, cancelled }
 */
async function search(root, query, opts) {
  const o = opts || {};
  const max = o.max || 5000;
  const t0 = Date.now();
  const q = String(query || '').trim();
  const needle = q.toLowerCase();
  const byName = nameMatcher(q);
  const content = !/[*?]/.test(q) && needle.length > 0;
  const stats = { count: 0, capped: false, denied: 0, skipped: 0, read: 0, cancelled: false };
  let batch = [];
  let lastFlush = Date.now();
  const flush = (force) => {
    if (!batch.length) return;
    if (!force && batch.length < 200 && Date.now() - lastFlush < (o.batchMs || 60)) return;
    const b = batch;
    batch = [];
    lastFlush = Date.now();
    if (o.onBatch) o.onBatch(b);
  };
  const add = (it) => {
    if (stats.count >= max) { stats.capped = true; return false; }
    stats.count++;
    batch.push(it);
    flush(false);
    return true;
  };
  const queue = [root];
  while (queue.length) {
    if (o.isCancelled && o.isCancelled()) { stats.cancelled = true; break; }
    if (stats.capped) break;
    const dir = queue.shift();
    let ents;
    try { ents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (_) { stats.denied++; continue; }
    const files = [];
    for (const e of ents) {
      if (e.isSymbolicLink()) continue;                    // links and junctions: never followed, never listed twice
      const p = path.win32.join(dir, e.name);
      if (e.isDirectory()) {
        queue.push(p);
        if (byName(e.name)) {
          let st = null;
          try { st = await fs.promises.stat(p); } catch (_) { /* listed anyway */ }
          if (!add({ n: e.name, d: 1, s: 0, m: st ? st.mtimeMs : 0, c: st ? st.birthtimeMs : 0, a: 16, p, hit: 'name' })) break;
        }
      } else if (e.isFile()) files.push({ n: e.name, p });
    }
    // files: READS at a time; a name hit needs no read at all
    for (let i = 0; i < files.length && !stats.capped; i += READS) {
      if (o.isCancelled && o.isCancelled()) { stats.cancelled = true; break; }
      const group = files.slice(i, i + READS);
      const res = await Promise.all(group.map(async (f) => {
        let st;
        try { st = await fs.promises.stat(f.p); } catch (_) { stats.denied++; return null; }
        const base = { n: f.n, d: 0, s: st.size, m: st.mtimeMs, c: st.birthtimeMs, a: 32, p: f.p };
        if (byName(f.n)) return Object.assign(base, { hit: 'name' });
        if (!content) return null;
        try {
          const r = await contentHit(f.p, path.win32.extname(f.n).toLowerCase(), st.size, needle);
          if (r.skip) { stats.skipped++; return null; }
          stats.read++;
          return r.hit ? Object.assign(base, { hit: 'content', snip: r.snip }) : null;
        } catch (_) { stats.denied++; return null; }
      }));
      for (const it of res) if (it && !add(it)) break;
    }
    flush(false);
    await new Promise((r) => setImmediate(r));             // let the window breathe between folders
  }
  flush(true);
  stats.ms = Date.now() - t0;
  return stats;
}

module.exports = { search, nameMatcher, globMatch, decodeText, xmlText, docText, snippet, FILE_MAX };
