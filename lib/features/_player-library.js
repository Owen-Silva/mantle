'use strict';
/*
 * _player-library.js - Mantle Player's music and video library (lane mantle-player, 2026-10-17).
 *
 * INCREMENTAL AND QUIET: the scan runs only while the player window is open (never at Mantle start), walks the
 * roots (Windows' Music and Videos folders, or a test's own), and reads tags ONLY for a file that is new or
 * whose size or modified time changed; everything else comes from the cache (<userData>/player-library.json).
 * It yields to the event loop every few files (main stays responsive) and keeps one scan at a time: a second
 * scan() while one runs gets the running one's promise. Covers are written once per picture
 * (<coverDir>/<sha1>.jpg|png, shared by every song of an album); a folder.jpg / cover.jpg next to the songs is
 * the fallback. Nothing here logs a file name or path (privacy rule, 2026-10-01).
 *
 *   const L = createLibrary({ roots: [{ dir, kind }], cacheFile, coverDir, fs?, now? })
 *   await L.load()                 the cache (a missing or broken cache is an empty library, with why)
 *   await L.scan({ force })        { ok, added, changed, removed, kept, ms, reason }
 *   L.view()                       { songs, albums, artists, videos, at, scanning, reason }
 *   L.search(q)                    { songs, albums, artists, videos } matching every word
 */
const fsReal = require('fs');
const path = require('path');
const crypto = require('crypto');
const P = require('./_player-probe.js');
const T = require('./_player-tags.js');

const VERSION = 2;
const HEAD = 512 * 1024;                  // tags with a big cover fit; the rest of the file is never read
const YIELD_EVERY = 6;                    // files between yields to the event loop
const MAX_FILES = 50000;                  // a runaway root stops here, and says so
const FOLDER_ART = ['cover.jpg', 'folder.jpg', 'front.jpg', 'cover.png', 'folder.png', 'albumart.jpg'];

function createLibrary(o) {
  const fs = o.fs || fsReal;
  const now = o.now || Date.now;
  const S = { files: {}, at: null, roots: [], scanning: null, reason: null, lastScan: null };

  async function load() {
    try {
      const j = JSON.parse(await fs.promises.readFile(o.cacheFile, 'utf8'));
      if (j && j.version === VERSION && j.files && typeof j.files === 'object') { S.files = j.files; S.at = j.at || null; S.roots = j.roots || []; }
      else S.reason = 'the library list was from an older Mantle Player, so it is read again';
    } catch (e) { if (e.code !== 'ENOENT') S.reason = 'the saved library list could not be read (' + (e.code || e.message) + '), so it is read again'; }
    return view();
  }
  async function save() {
    const tmp = o.cacheFile + '.tmp';
    await fs.promises.mkdir(path.dirname(o.cacheFile), { recursive: true });
    await fs.promises.writeFile(tmp, JSON.stringify({ version: VERSION, at: S.at, roots: S.roots, files: S.files }));
    await fs.promises.rename(tmp, o.cacheFile);
  }
  const tick = () => new Promise((r) => setImmediate(r));

  async function readPart(p, size) {
    const fh = await fs.promises.open(p, 'r');
    try {
      const n = Math.min(size, HEAD);
      const head = Buffer.alloc(n); await fh.read(head, 0, n, 0);
      const tn = Math.min(size, size > HEAD ? 4096 : 0);
      const tail = Buffer.alloc(tn); if (tn) await fh.read(tail, 0, tn, size - tn);
      return { head, tail };
    } finally { await fh.close(); }
  }
  async function saveCover(c) {
    const hash = crypto.createHash('sha1').update(c.data).digest('hex').slice(0, 20);
    const file = hash + (c.mime === 'image/png' ? '.png' : '.jpg');
    const full = path.join(o.coverDir, file);
    try { await fs.promises.access(full); } catch (_) { await fs.promises.mkdir(o.coverDir, { recursive: true }); await fs.promises.writeFile(full, c.data); }
    return full;
  }
  const folderArt = new Map();
  async function folderCover(dir) {
    if (folderArt.has(dir)) return folderArt.get(dir);
    let hit = null;
    try { const names = new Set((await fs.promises.readdir(dir)).map((n) => n.toLowerCase())); const f = FOLDER_ART.find((n) => names.has(n)); hit = f ? path.join(dir, f) : null; } catch (_) { hit = null; }
    folderArt.set(dir, hit);
    return hit;
  }

  async function entryFor(p, st, kind) {
    const e = { kind, size: st.size, mtime: Math.round(st.mtimeMs), title: null, artist: null, album: null, albumArtist: null, track: null, disc: null, year: null, genre: null, cover: null, why: null };
    if (kind === 'audio') {
      try {
        const { head, tail } = await readPart(p, st.size);
        const t = T.read(head, tail, P.extOf(p));
        Object.assign(e, { title: t.title, artist: t.artist, album: t.album, albumArtist: t.albumArtist, track: t.track, disc: t.disc, year: t.year, genre: t.genre, why: t.why });
        if (t.cover) e.cover = await saveCover(t.cover);
      } catch (err) { e.why = 'its tags could not be read (' + (err.code || err.message) + ')'; }
      if (!e.cover) e.cover = await folderCover(path.dirname(p));
    }
    return e;
  }

  async function walk(dir, kind, seen, count, depth) {
    if (depth > 12 || count.n > MAX_FILES) return;
    let ents;
    try { ents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (_) { count.unread++; return; }
    for (const d of ents) {
      if (d.name.startsWith('.') || d.name === 'node_modules' || d.isSymbolicLink()) continue;
      const p = path.join(dir, d.name);
      if (d.isDirectory()) { await walk(p, kind, seen, count, depth + 1); continue; }
      const k = P.kindOf(d.name);
      if (k !== 'audio' && k !== 'video') continue;
      if (P.LIB_SKIP.has(P.extOf(d.name))) continue;
      if (++count.n > MAX_FILES) return;
      seen.set(p, k);
    }
  }

  function scan(opts) {
    if (S.scanning) return S.scanning;
    const force = !!(opts && opts.force);
    const t0 = now();
    S.scanning = (async () => {
      const seen = new Map(), count = { n: 0, unread: 0 };
      const roots = (o.roots || []).filter((r) => r && r.dir);
      const missing = [];
      for (const r of roots) { try { await fs.promises.access(r.dir); await walk(r.dir, r.kind, seen, count, 0); } catch (_) { missing.push(r.label || r.kind); } }
      let added = 0, changed = 0, kept = 0, removed = 0, i = 0;
      const next = {};
      for (const [p, kind] of seen) {
        let st;
        try { st = await fs.promises.stat(p); } catch (_) { continue; }
        const old = S.files[p];
        if (!force && old && old.size === st.size && old.mtime === Math.round(st.mtimeMs) && old.kind === kind) { next[p] = old; kept++; }
        else { next[p] = await entryFor(p, st, kind); if (old) changed++; else added++; }
        if (++i % YIELD_EVERY === 0) await tick();
      }
      for (const p of Object.keys(S.files)) if (!(p in next)) removed++;
      S.files = next; S.at = now(); S.roots = roots.map((r) => r.dir);
      const notes = [];
      if (missing.length) notes.push('not found: ' + missing.join(', '));
      if (count.n > MAX_FILES) notes.push('stopped at ' + MAX_FILES + ' files');
      if (count.unread) notes.push(count.unread + ' folder' + (count.unread === 1 ? '' : 's') + ' could not be read');
      S.reason = notes.length ? notes.join('; ') : null;
      try { await save(); } catch (e) { S.reason = (S.reason ? S.reason + '; ' : '') + 'the library list could not be saved (' + (e.code || e.message) + ')'; }
      S.lastScan = { ok: true, added, changed, removed, kept, ms: now() - t0, reason: S.reason };
      return S.lastScan;
    })().catch((e) => { S.reason = 'the library could not be read (' + (e && e.message) + ')'; S.lastScan = { ok: false, reason: S.reason }; return S.lastScan; })
      .finally(() => { S.scanning = null; });
    return S.scanning;
  }

  function songOf(p, e) {
    const base = path.basename(p).replace(/\.[^.]+$/, '');
    return {
      path: p, kind: 'audio', title: e.title || base, artist: e.artist || null, album: e.album || null,
      albumArtist: e.albumArtist || e.artist || null, track: e.track, disc: e.disc, year: e.year, genre: e.genre, cover: e.cover || null, mtime: e.mtime, size: e.size,
    };
  }
  function view() {
    const songs = [], videos = [];
    for (const [p, e] of Object.entries(S.files)) {
      if (e.kind === 'audio') songs.push(songOf(p, e));
      else videos.push({ path: p, kind: 'video', title: path.basename(p).replace(/\.[^.]+$/, ''), folder: path.basename(path.dirname(p)), mtime: e.mtime, size: e.size });
    }
    // album artist, album, disc, track, title; an unknown artist or album sorts LAST
    const skey = (x) => (x.albumArtist || '￿') + '\u0001' + (x.album || '￿') + '\u0001' + String(x.disc || 0).padStart(3, '0') + String(x.track || 0).padStart(4, '0') + x.title;
    songs.sort((a, b) => P.natural(skey(a), skey(b)));
    videos.sort((a, b) => b.mtime - a.mtime);
    const albums = new Map(), artists = new Map();
    for (const s of songs) {
      const ak = (s.albumArtist || '') + '\u0001' + (s.album || '');
      if (!albums.has(ak)) albums.set(ak, { key: ak, album: s.album, artist: s.albumArtist, year: s.year, cover: s.cover, songs: [] });
      const a = albums.get(ak); a.songs.push(s.path); if (!a.cover && s.cover) a.cover = s.cover;
      const rk = s.artist || '';
      if (!artists.has(rk)) artists.set(rk, { key: rk, artist: s.artist, cover: s.cover, songs: [], albums: new Set() });
      const r = artists.get(rk); r.songs.push(s.path); r.albums.add(ak); if (!r.cover && s.cover) r.cover = s.cover;
    }
    return {
      songs, videos,
      albums: Array.from(albums.values()).sort((a, b) => P.natural(a.album || '￿', b.album || '￿')),
      artists: Array.from(artists.values()).map((r) => Object.assign({}, r, { albums: r.albums.size })).sort((a, b) => P.natural(a.artist || '￿', b.artist || '￿')),
      at: S.at, scanning: !!S.scanning, reason: S.reason, last: S.lastScan,
    };
  }
  function search(q) {
    const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
    const v = view();
    if (!words.length) return v;
    const hit = (...xs) => { const s = xs.filter(Boolean).join(' ').toLowerCase(); return words.every((w) => s.includes(w)); };
    return Object.assign({}, v, {
      songs: v.songs.filter((s) => hit(s.title, s.artist, s.album, s.albumArtist, s.genre)),
      albums: v.albums.filter((a) => hit(a.album, a.artist)),
      artists: v.artists.filter((a) => hit(a.artist)),
      videos: v.videos.filter((x) => hit(x.title, x.folder)),
    });
  }
  return { load, scan, view, search, get scanning() { return !!S.scanning; }, get at() { return S.at; }, _state: S };
}

module.exports = { createLibrary, VERSION };
