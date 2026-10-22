'use strict';
/*
 * _files-zip.js - "Compress to ZIP" and "Extract all" for Mantle Files (lane files, 2026-09-28).
 *
 * WHY our own zip, in main, in plain node. Windows' zip support is the shell's Compressed Folder
 * (CLSID_CompressedFolder through IFileOperation): asynchronous with no completion signal, its own
 * progress dialog, and the very "old Windows feature" the user wants Mantle not to lean on. csc's
 * System.IO.Compression would mean a new /r: in the shared sidecar build. Node already has
 * deflate (zlib) and a CRC-32 (zlib.crc32), so a streaming writer and reader are ~300 lines
 * with nothing to install, and they run off the sidecar's lanes entirely.
 *
 * WHAT IT WRITES: PKZIP 2.0 entries with UTF-8 names (flag bit 11, so accents and emoji survive
 * Explorer, 7-Zip and bsdtar), data descriptors (bit 3: one pass, no seeking back), ZIP64 records
 * only when a file or the archive passes 4 GB or 65,535 entries. Already-compressed formats
 * (jpg, mp4, zip, ...) are STORED rather than deflated: deflating them costs CPU for ~0% gain,
 * and the user's CPU is shared with simulations.
 *
 * WHAT IT READS: stored and deflated entries, ZIP64, UTF-8 or legacy names. It REFUSES, per entry
 * and with the reason: encrypted entries, other methods, and any name that would land outside
 * the destination ("zip slip": absolute paths, drive letters, "..", alternate data streams).
 * Nothing is ever overwritten: files open with the 'wx' flag.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const W = path.win32;
const STORE_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'heic', 'mp4', 'mkv', 'mov', 'webm', 'avi', 'mp3', 'm4a', 'aac', 'ogg', 'opus', 'flac',
  'zip', '7z', 'rar', 'gz', 'tgz', 'bz2', 'xz', 'zst', 'cab', 'msi', 'docx', 'xlsx', 'pptx', 'jar', 'apk', 'woff', 'woff2', 'pdf']);
const U32 = 0xFFFFFFFF;

/* ---- CRC-32: zlib's when it has one (node 22.2+), else a table ---------------------------------- */
let TABLE = null;
function crcTable(buf, prev) {
  if (!TABLE) {
    TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; TABLE[n] = c; }
  }
  let c = (prev ^ U32) >>> 0;
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ U32) >>> 0;
}
const crc32 = typeof zlib.crc32 === 'function' ? (buf, prev) => zlib.crc32(buf, prev || 0) : (buf, prev) => crcTable(buf, prev || 0);

function dosTime(ms) {
  const d = new Date(ms);
  const y = Math.max(1980, d.getFullYear());
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}
function fromDos(date, time) {
  return new Date(((date >> 9) & 0x7F) + 1980, ((date >> 5) & 0x0F) - 1, date & 0x1F, (time >> 11) & 0x1F, (time >> 5) & 0x3F, (time & 0x1F) * 2).getTime();
}
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };

/** A new file, never an existing one ('wx'); zip() and unzip() take `makeStream` so a test can fail it. */
const newFile = (p) => fs.createWriteStream(p, { flags: 'wx' });

/** Every entry under the given items: folders first as "name/", links skipped (and counted). */
async function collect(items, isCancelled) {
  const out = [];
  let skipped = 0;
  async function visit(abs, rel) {
    if (isCancelled && isCancelled()) throw new Error('cancelled');
    const st = await fs.promises.lstat(abs);
    if (st.isSymbolicLink()) { skipped++; return; }
    if (st.isDirectory()) {
      out.push({ abs, rel: rel + '/', dir: true, size: 0, mtime: st.mtimeMs });
      const kids = await fs.promises.readdir(abs, { withFileTypes: true });
      for (const k of kids) await visit(W.join(abs, k.name), rel + '/' + k.name);
    } else if (st.isFile()) {
      out.push({ abs, rel, dir: false, size: st.size, mtime: st.mtimeMs });
    } else skipped++;
  }
  for (const it of items) await visit(it, W.basename(it));
  return { entries: out, skipped };
}

/**
 * Writes `dest` (must not exist) from `items` (absolute paths). onProgress({done, total, items,
 * itemsTotal, item}) after every chunk (the caller throttles). Resolves {files, dirs, bytes,
 * written, skipped}; rejects on failure or cancel, after deleting the partial archive.
 */
async function zip({ items, dest, onProgress, isCancelled, makeStream }) {
  const cancelled = () => !!(isCancelled && isCancelled());
  const { entries, skipped } = await collect(items, isCancelled);
  const total = entries.reduce((a, e) => a + e.size, 0);
  const fileCount = entries.filter((e) => !e.dir).length;
  const out = (makeStream || newFile)(dest);
  let offset = 0;
  let failed = null;
  const waiting = new Set();     // writes parked on 'drain': a write error (disk full) must fail them, not strand them
  out.on('error', (e) => { failed = failed || e; for (const rej of waiting) rej(failed); waiting.clear(); });
  const write = (buf) => new Promise((res, rej) => {
    if (failed) return rej(failed);
    offset += buf.length;
    if (out.write(buf)) return res();
    // MEASURED (lane files-main, 2026-09-29): on a disk-full error 'drain' never fires, so a write
    // parked on it hung the job for ever and its partial archive was never removed.
    waiting.add(rej);
    out.once('drain', () => { waiting.delete(rej); res(); });
  });
  const central = [];
  let done = 0;
  let filesDone = 0;
  let created = false;           // only an archive WE opened is ever deleted on failure (never one that was there)
  try {
    await new Promise((res, rej) => { out.once('open', res); out.once('error', rej); });
    created = true;
    for (const e of entries) {
      if (cancelled()) throw new Error('cancelled');
      const name = Buffer.from(e.rel, 'utf8');
      const ext = e.dir ? '' : (W.extname(e.abs).slice(1).toLowerCase());
      const method = e.dir || STORE_EXT.has(ext) ? 0 : 8;
      const big = e.size >= U32 - 65536 || offset >= U32;
      const flags = 0x0800 | (e.dir ? 0 : 0x0008);
      const { time, date } = dosTime(e.mtime);
      const localOffset = offset;
      const extra = big ? Buffer.concat([Buffer.from([1, 0, 16, 0]), u64(0), u64(0)]) : Buffer.alloc(0);
      const h = Buffer.alloc(30);
      h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(big ? 45 : 20, 4); h.writeUInt16LE(flags, 6); h.writeUInt16LE(method, 8);
      h.writeUInt16LE(time, 10); h.writeUInt16LE(date, 12); h.writeUInt32LE(0, 14);
      h.writeUInt32LE(big ? U32 : 0, 18); h.writeUInt32LE(big ? U32 : 0, 22);
      h.writeUInt16LE(name.length, 26); h.writeUInt16LE(extra.length, 28);
      await write(Buffer.concat([h, name, extra]));
      let crc = 0;
      let csize = 0;
      if (!e.dir) {
        const src = fs.createReadStream(e.abs, { highWaterMark: 256 * 1024 });
        const z = method === 8 ? zlib.createDeflateRaw({ level: 6 }) : null;
        const pump = new Promise((res, rej) => {
          const sink = z || src;
          sink.on('data', (chunk) => {
            csize += chunk.length;
            const w = write(chunk);
            // every write's failure reaches the job: an unwatched rejected write (disk full) was an
            // unhandled rejection, which ends Mantle's main process (MEASURED, lane files-main)
            if (!out.writableNeedDrain) { w.then(null, rej); return; }
            sink.pause();
            w.then(() => sink.resume(), rej);
          });
          sink.on('end', res);
          sink.on('error', rej);
          if (z) src.on('error', rej);
        });
        src.on('data', (chunk) => {
          crc = crc32(chunk, crc);
          done += chunk.length;
          if (cancelled()) src.destroy(new Error('cancelled'));
          if (onProgress) onProgress({ done, total, items: filesDone, itemsTotal: fileCount, item: e.rel });
        });
        if (z) src.pipe(z);
        // A failed write or a cancel must also close the file being read: a paused stream keeps its
        // handle open, and Windows will not delete or move a file that is still open.
        try { await pump; } catch (err) { src.destroy(); if (z) z.destroy(); throw err; }
        filesDone++;
        const dd = big ? Buffer.alloc(24) : Buffer.alloc(16);
        dd.writeUInt32LE(0x08074b50, 0); dd.writeUInt32LE(crc >>> 0, 4);
        if (big) { dd.writeBigUInt64LE(BigInt(csize), 8); dd.writeBigUInt64LE(BigInt(e.size), 16); } else { dd.writeUInt32LE(csize, 8); dd.writeUInt32LE(e.size, 12); }
        await write(dd);
      }
      central.push({ name, flags, method, time, date, crc: crc >>> 0, csize, usize: e.size, offset: localOffset, dir: e.dir });
    }
    const cdStart = offset;
    for (const c of central) {
      const needU = c.usize >= U32, needC = c.csize >= U32, needO = c.offset >= U32;
      const x = [];
      if (needU) x.push(u64(c.usize));
      if (needC) x.push(u64(c.csize));
      if (needO) x.push(u64(c.offset));
      const xb = x.length ? Buffer.concat([Buffer.from([1, 0, x.length * 8, 0]), ...x]) : Buffer.alloc(0);
      const r = Buffer.alloc(46);
      r.writeUInt32LE(0x02014b50, 0); r.writeUInt16LE(x.length ? 45 : 20, 4); r.writeUInt16LE(x.length ? 45 : 20, 6);
      r.writeUInt16LE(c.flags, 8); r.writeUInt16LE(c.method, 10); r.writeUInt16LE(c.time, 12); r.writeUInt16LE(c.date, 14);
      r.writeUInt32LE(c.crc, 16); r.writeUInt32LE(needC ? U32 : c.csize, 20); r.writeUInt32LE(needU ? U32 : c.usize, 24);
      r.writeUInt16LE(c.name.length, 28); r.writeUInt16LE(xb.length, 30); r.writeUInt16LE(0, 32); r.writeUInt16LE(0, 34); r.writeUInt16LE(0, 36);
      r.writeUInt32LE(c.dir ? 0x10 : 0x20, 38); r.writeUInt32LE(needO ? U32 : c.offset, 42);
      await write(Buffer.concat([r, c.name, xb]));
    }
    const cdSize = offset - cdStart;
    const z64 = central.length >= 0xFFFF || cdStart >= U32 || cdSize >= U32;
    if (z64) {
      const eocd64At = offset;
      const r = Buffer.alloc(56);
      r.writeUInt32LE(0x06064b50, 0); r.writeBigUInt64LE(44n, 4); r.writeUInt16LE(45, 12); r.writeUInt16LE(45, 14);
      r.writeBigUInt64LE(BigInt(central.length), 24); r.writeBigUInt64LE(BigInt(central.length), 32);
      r.writeBigUInt64LE(BigInt(cdSize), 40); r.writeBigUInt64LE(BigInt(cdStart), 48);
      const loc = Buffer.alloc(20);
      loc.writeUInt32LE(0x07064b50, 0); loc.writeBigUInt64LE(BigInt(eocd64At), 8); loc.writeUInt32LE(1, 16);
      await write(Buffer.concat([r, loc]));
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(z64 ? 0xFFFF : central.length, 8); end.writeUInt16LE(z64 ? 0xFFFF : central.length, 10);
    end.writeUInt32LE(z64 ? U32 : cdSize, 12); end.writeUInt32LE(z64 ? U32 : cdStart, 16);
    await write(end);
    await new Promise((res, rej) => out.end((err) => (err ? rej(err) : res())));
    if (failed) throw failed;
    return { files: fileCount, dirs: entries.length - fileCount, bytes: total, written: offset, skipped };
  } catch (err) {
    if (!out.closed) {
      await new Promise((r) => { out.once('close', r); out.destroy(); setTimeout(r, 2000); });
    }
    if (created) { try { await fs.promises.unlink(dest); } catch (_) { /* already gone */ } }
    throw err;
  }
}

/* ---- reading ------------------------------------------------------------------------------------ */

/** The central directory: [{name, dir, method, flags, crc, csize, usize, offset, mtime}]. */
async function readDirectory(fd, size) {
  const tailLen = Math.min(size, 65557);
  const tail = Buffer.alloc(tailLen);
  await fd.read(tail, 0, tailLen, size - tailLen);
  let at = -1;
  for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { at = i; break; }
  if (at < 0) throw new Error('not a zip file (no end-of-archive record)');
  let count = tail.readUInt16LE(at + 10);
  let cdSize = tail.readUInt32LE(at + 12);
  let cdStart = tail.readUInt32LE(at + 16);
  if (count === 0xFFFF || cdSize === U32 || cdStart === U32) {
    const locAt = at - 20;
    if (locAt < 0 || tail.readUInt32LE(locAt) !== 0x07064b50) throw new Error('a ZIP64 archive without its locator');
    const z = Buffer.alloc(56);
    await fd.read(z, 0, 56, Number(tail.readBigUInt64LE(locAt + 8)));
    if (z.readUInt32LE(0) !== 0x06064b50) throw new Error('a broken ZIP64 end record');
    count = Number(z.readBigUInt64LE(32));
    cdSize = Number(z.readBigUInt64LE(40));
    cdStart = Number(z.readBigUInt64LE(48));
  }
  // The directory must lie inside the file: a damaged or hostile zip could claim 4 GB here and
  // Buffer.alloc would take it (lane files-main, 2026-09-29).
  if (!(cdStart >= 0 && cdSize >= 0 && cdStart + cdSize <= size)) throw new Error('a broken central directory');
  const cd = Buffer.alloc(cdSize);
  await fd.read(cd, 0, cdSize, cdStart);
  const out = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) throw new Error('a broken central directory');
    const flags = cd.readUInt16LE(p + 8);
    const method = cd.readUInt16LE(p + 10);
    const time = cd.readUInt16LE(p + 12), date = cd.readUInt16LE(p + 14);
    const crc = cd.readUInt32LE(p + 16);
    let csize = cd.readUInt32LE(p + 20), usize = cd.readUInt32LE(p + 24);
    const nl = cd.readUInt16LE(p + 28), xl = cd.readUInt16LE(p + 30), cl = cd.readUInt16LE(p + 32);
    let offset = cd.readUInt32LE(p + 42);
    const raw = cd.subarray(p + 46, p + 46 + nl);
    const ex = cd.subarray(p + 46 + nl, p + 46 + nl + xl);
    for (let q = 0; q + 4 <= ex.length;) {
      const tag = ex.readUInt16LE(q), len = ex.readUInt16LE(q + 2);
      if (tag === 1) {
        let r = q + 4;
        if (usize === U32 && r + 8 <= q + 4 + len) { usize = Number(ex.readBigUInt64LE(r)); r += 8; }
        if (csize === U32 && r + 8 <= q + 4 + len) { csize = Number(ex.readBigUInt64LE(r)); r += 8; }
        if (offset === U32 && r + 8 <= q + 4 + len) { offset = Number(ex.readBigUInt64LE(r)); r += 8; }
      }
      q += 4 + len;
    }
    let name;
    if (flags & 0x0800) name = raw.toString('utf8');
    else { const u = raw.toString('utf8'); name = u.includes('�') ? raw.toString('latin1') : u; }
    out.push({ name, dir: name.endsWith('/') || name.endsWith('\\'), method, flags, crc, csize, usize, offset, mtime: fromDos(date, time) });
    p += 46 + nl + xl + cl;
  }
  return out;
}

/** The entry's path under `dest`, or null when it would land outside it (zip slip). */
function safeTarget(dest, name) {
  const rel = String(name).replace(/\\/g, '/').replace(/\/+$/, '');
  if (!rel || rel.startsWith('/') || /^[a-zA-Z]:/.test(rel) || rel.includes(':')) return null;
  const segs = rel.split('/').filter((s) => s && s !== '.');
  // "..", Windows' invalid characters, a name ending in a dot or space (Windows trims it, so
  // "a." and "a" would be one file) and device names (CON, NUL, COM1 ...: a write there is not a file).
  if (!segs.length || segs.some((s) => s === '..' || /[<>"|?*\x00-\x1f]/.test(s) || /[. ]$/.test(s) ||
    /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\..*)?$/i.test(s.trim()))) return null;
  const t = W.resolve(dest, ...segs);
  const d = W.resolve(dest);
  return t.toLowerCase().startsWith(d.toLowerCase() + '\\') ? t : null;
}

/**
 * Extracts `zipPath` into `dest` (created; must not exist, so nothing is overwritten).
 * Resolves {files, dirs, bytes, failed:[{name, why}]}; a failed ENTRY is reported, not thrown.
 */
async function unzip({ zipPath, dest, onProgress, isCancelled, makeStream }) {
  const cancelled = () => !!(isCancelled && isCancelled());
  const fd = await fs.promises.open(zipPath, 'r');
  const failed = [];
  let files = 0, dirs = 0, done = 0;
  let made = false;              // dest is OURS only once mkdir made it: only then is it removed on a stop
  try {
    const st = await fd.stat();
    const entries = await readDirectory(fd, st.size);
    const total = entries.reduce((a, e) => a + (e.dir ? 0 : e.usize), 0);
    const itemsTotal = entries.filter((e) => !e.dir).length;
    await fs.promises.mkdir(dest, { recursive: false });
    made = true;
    for (const e of entries) {
      if (cancelled()) throw new Error('cancelled');
      const target = safeTarget(dest, e.name);
      if (!target) { failed.push({ name: e.name, why: 'its name is not allowed on Windows or would land outside the destination folder, so it was skipped' }); continue; }
      if (e.dir) { await fs.promises.mkdir(target, { recursive: true }); dirs++; continue; }
      if (e.flags & 1) { failed.push({ name: e.name, why: 'it is password-protected (encrypted zips are not supported yet)' }); continue; }
      if (e.method !== 0 && e.method !== 8) { failed.push({ name: e.name, why: `it uses compression method ${e.method}, which Mantle cannot read yet` }); continue; }
      await fs.promises.mkdir(W.dirname(target), { recursive: true });
      const lh = Buffer.alloc(30);
      await fd.read(lh, 0, 30, e.offset);
      if (lh.readUInt32LE(0) !== 0x04034b50) { failed.push({ name: e.name, why: 'its local header is broken' }); continue; }
      const start = e.offset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
      let crc = 0;
      let wrote = 0;
      let opened = false;        // the entry's file is OURS once 'wx' opened it (EEXIST: someone else's)
      try {
        await new Promise((res, rej) => {
          const src = e.csize > 0 ? fs.createReadStream(zipPath, { start, end: start + e.csize - 1, highWaterMark: 256 * 1024 }) : null;
          const outS = (makeStream || newFile)(target);
          // Settle only once the output file is CLOSED: Windows will not delete a file that is still open.
          let settled = false;
          const settle = (err) => {
            if (settled) return;
            settled = true;
            if (src) src.destroy();
            const fin = () => (err ? rej(err) : res());
            if (outS.closed) { fin(); return; }
            outS.once('close', fin);
            setTimeout(fin, 3000).unref();
            if (err) outS.destroy();
          };
          const stop = (err) => settle(err);
          outS.on('open', () => { opened = true; });
          outS.on('error', stop);
          outS.on('finish', () => settle(null));
          if (!src) { outS.end(); return; }
          const body = e.method === 8 ? src.pipe(zlib.createInflateRaw()) : src;
          src.on('error', stop);
          body.on('error', stop);
          body.on('data', (chunk) => {
            crc = crc32(chunk, crc);
            done += chunk.length;
            wrote += chunk.length;
            if (cancelled()) { stop(new Error('cancelled')); return; }
            // A zip bomb (or a damaged zip) inflates past the size it declares: stop at that size.
            if (wrote > e.usize) { const err = new Error('bigger than declared'); err.code = 'EZIPSIZE'; stop(err); return; }
            if (onProgress) onProgress({ done, total, items: files, itemsTotal, item: e.name });
          });
          body.pipe(outS);
        });
        if ((crc >>> 0) !== (e.crc >>> 0)) {
          await removeFile(target);
          failed.push({ name: e.name, why: 'its contents do not match its checksum (the zip is damaged), so it was not kept' });
          continue;
        }
        try { await fs.promises.utimes(target, new Date(), new Date(e.mtime)); } catch (_) { /* a date is cosmetic */ }
        files++;
      } catch (err) {
        if (opened) await removeFile(target);             // never leave half a file behind
        if (cancelled() || /cancelled/.test(err.message)) throw new Error('cancelled');
        if (err.code === 'ENOSPC' || err.code === 'EDQUOT') throw err;   // the rest cannot fit either: stop
        failed.push({ name: e.name, why: err.code === 'EEXIST' ? 'a file with that name was already extracted (a duplicate entry)'
          : err.code === 'EZIPSIZE' ? 'it holds more data than the zip says (a damaged or unsafe zip), so it was not kept'
            : `it could not be written (${err.code || 'error'})` });
      }
    }
    return { files, dirs, bytes: done, failed };
  } catch (err) {
    // Cancelled, disk full or unreadable: the folder this call made goes, so no half-extracted copy is left.
    if (made) { try { await fs.promises.rm(dest, { recursive: true, force: true, maxRetries: 3 }); } catch (_) { /* reported by the caller */ } }
    throw err;
  } finally {
    await fd.close().catch(() => {});
  }
}

async function removeFile(p) {
  for (let i = 0; i < 3; i++) {
    try { await fs.promises.unlink(p); return; } catch (e) { if (e.code === 'ENOENT') return; await new Promise((r) => setTimeout(r, 50)); }
  }
}

module.exports = { zip, unzip, safeTarget, readDirectory, crc32, STORE_EXT };
