'use strict';
/*
 * _clips-mp4.js - read and CUT Game Bar's MP4s without re-encoding (lane mantle-clips, 2026-10-15).
 *
 * WHY HERE AND NOT ffmpeg: there is no ffmpeg on Owen's PC, and Windows' own MediaTranscoder can
 * only re-encode (a few seconds per minute of clip, and a generation of quality lost). A Game Bar
 * file is a plain ISO-BMFF movie (ftyp, mdat, moov; H.264 + AAC), so a trim can copy the coded
 * samples as they are: the video starts on the KEYFRAME at or before the asked start (an H.264
 * frame can only be decoded from one), the audio from the same moment, and both end at the asked
 * end. Nothing is decoded, so it is lossless and runs at disk speed.
 *
 * STREAMING: a 500 MB clip is never read into memory. The index (moov) is read whole (a 5-minute
 * clip's is ~0.5 MB; over 64 MB is refused), the samples are copied in <= 4 MB runs through one
 * reused buffer, and the new file is written to "<name>.part" then renamed: a half-written trim is
 * never left under a finished name, and the source is opened read-only.
 *
 * REFUSED with a plain reason (the caller then re-encodes or says so): no index, a FRAGMENTED movie
 * (moof: a live stream's layout), no video and no audio track, a track without sample tables.
 *
 *   quickInfo(path)               -> {durationMs, width, height} from the first 4 KB of the index
 *   readMovie(path)               -> the whole index, parsed (tests, cut)
 *   planCut(movie, startMs, endMs)-> {startMs (the keyframe's), endMs, tracks:[{first, last}]}
 *   cut(src, dst, startMs, endMs) -> {ok, startMs, endMs, bytes, ms}
 */
const fs = require('fs');

const MAX_MOOV = 64 * 1024 * 1024;
const RUN_MAX = 4 * 1024 * 1024;
const CHUNK_S = 1.0;                 // the new file interleaves its tracks in chunks of about a second

/* ---- reading boxes -------------------------------------------------------------------------- */
async function topBoxes(fh, size) {
  const out = [];
  const b = Buffer.alloc(16);
  let pos = 0;
  while (pos + 8 <= size && out.length < 4096) {
    await fh.read(b, 0, 16, pos);
    let sz = b.readUInt32BE(0);
    const type = b.toString('latin1', 4, 8);
    let hdr = 8;
    if (sz === 1) { sz = Number(b.readBigUInt64BE(8)); hdr = 16; } else if (sz === 0) sz = size - pos;
    if (sz < hdr) throw new Error(`the file is damaged (a box at byte ${pos} has size ${sz})`);
    out.push({ type, at: pos, size: sz, hdr });
    pos += sz;
  }
  return out;
}

function children(buf, start, end) {
  const out = [];
  let p = start;
  while (p + 8 <= end) {
    let sz = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    let hdr = 8;
    if (sz === 1) { sz = Number(buf.readBigUInt64BE(p + 8)); hdr = 16; } else if (sz === 0) sz = end - p;
    if (sz < hdr || p + sz > end) break;
    out.push({ type, at: p, size: sz, body: p + hdr, end: p + sz });
    p += sz;
  }
  return out;
}
const find = (list, t) => list.find((c) => c.type === t) || null;

function fullBox(buf, b) { return { v: buf[b.body], flags: buf.readUIntBE(b.body + 1, 3), p: b.body + 4 }; }

function parseMvhd(buf, b) {
  const f = fullBox(buf, b);
  return f.v === 1 ? { timescale: buf.readUInt32BE(f.p + 16), duration: Number(buf.readBigUInt64BE(f.p + 20)), v: 1 }
    : { timescale: buf.readUInt32BE(f.p + 8), duration: buf.readUInt32BE(f.p + 12), v: 0 };
}
const parseMdhd = parseMvhd;   // the same layout up to the duration
function parseTkhd(buf, b) {
  const f = fullBox(buf, b);
  const o = f.v === 1 ? f.p + 32 : f.p + 20;            // after the times + track id + reserved + duration
  const wh = o + 8 + 8 + 36;                            // reserved(8) layer/alt/vol/res(8) matrix(36)
  return { id: buf.readUInt32BE(f.v === 1 ? f.p + 16 : f.p + 8), width: buf.readUInt32BE(wh) / 65536, height: buf.readUInt32BE(wh + 4) / 65536, v: f.v };
}

/* ---- the whole index ------------------------------------------------------------------------ */
async function openMovie(path) {
  const fh = await fs.promises.open(path, 'r');
  try {
    const st = await fh.stat();
    const tops = await topBoxes(fh, st.size);
    return { fh, size: st.size, tops };
  } catch (err) { await fh.close(); throw err; }
}

async function quickInfo(path) {
  const m = await openMovie(path);
  try {
    const moov = find(m.tops, 'moov');
    if (!moov) return { durationMs: null, width: null, height: null, why: 'no index (moov) in the file' };
    // lane mantle-clips2: walk the index by box HEADERS and read only mvhd and each trak's head. The
    // old read of the first 4 KB missed every trak bigger than that (a real minute of 60 fps video has
    // a ~30 KB sample table), so a real clip had no picture size.
    const out = { durationMs: null, width: null, height: null };
    const head = Buffer.alloc(16);
    const end = moov.at + moov.size;
    for (let p = moov.at + moov.hdr; p + 8 <= end;) {
      await m.fh.read(head, 0, 16, p);
      let sz = head.readUInt32BE(0), hdr = 8;
      const type = head.toString('latin1', 4, 8);
      if (sz === 1) { sz = Number(head.readBigUInt64BE(8)); hdr = 16; } else if (sz === 0) sz = end - p;
      if (sz < hdr || p + sz > end) break;
      if (type === 'mvhd' || type === 'trak') {
        const n = Math.min(sz, 512);                  // mvhd is 108-120 bytes; tkhd is a trak's first child
        const buf = Buffer.alloc(n);
        await m.fh.read(buf, 0, n, p);
        if (type === 'mvhd') { if (n === sz) { const h = parseMvhd(buf, { body: hdr }); if (h.timescale) out.durationMs = Math.round(h.duration * 1000 / h.timescale); } } else if (out.width === null) {
          const tk = find(children(buf, hdr, n), 'tkhd');
          if (tk) { const h = parseTkhd(buf, tk); if (h.width > 0 && h.height > 0) { out.width = Math.round(h.width); out.height = Math.round(h.height); } }
        }
      }
      p += sz;
    }
    return out;
  } finally { await m.fh.close(); }
}

function sampleTables(buf, stbl) {
  const k = children(buf, stbl.body, stbl.end);
  const need = (t) => { const b = find(k, t); if (!b) throw new Error(`a track has no ${t} table, so it cannot be cut losslessly`); return b; };
  const stsz = need('stsz'), stsc = need('stsc'), stts = need('stts');
  const co = find(k, 'stco') || find(k, 'co64');
  if (!co) throw new Error('a track has no chunk offsets, so it cannot be cut losslessly');
  // sizes
  let f = fullBox(buf, stsz);
  const fixed = buf.readUInt32BE(f.p), n = buf.readUInt32BE(f.p + 4);
  const size = new Array(n);
  for (let i = 0; i < n; i++) size[i] = fixed || buf.readUInt32BE(f.p + 8 + 4 * i);
  // chunk offsets
  f = fullBox(buf, co);
  const nc = buf.readUInt32BE(f.p);
  const chunk = new Array(nc);
  for (let i = 0; i < nc; i++) chunk[i] = co.type === 'co64' ? Number(buf.readBigUInt64BE(f.p + 4 + 8 * i)) : buf.readUInt32BE(f.p + 4 + 4 * i);
  // sample -> offset through stsc
  f = fullBox(buf, stsc);
  const ne = buf.readUInt32BE(f.p);
  const runs = [];
  for (let i = 0; i < ne; i++) runs.push({ first: buf.readUInt32BE(f.p + 4 + 12 * i), per: buf.readUInt32BE(f.p + 8 + 12 * i), desc: buf.readUInt32BE(f.p + 12 + 12 * i) });
  const offset = new Array(n);
  let s = 0;
  for (let r = 0; r < runs.length && s < n; r++) {
    const lastChunk = r + 1 < runs.length ? runs[r + 1].first - 1 : nc;
    for (let c = runs[r].first; c <= lastChunk && s < n; c++) {
      let o = chunk[c - 1];
      for (let j = 0; j < runs[r].per && s < n; j++) { offset[s] = o; o += size[s]; s++; }
    }
  }
  if (s < n) throw new Error('the sample-to-chunk table does not cover every sample');
  // decode times
  f = fullBox(buf, stts);
  const dts = new Array(n), dur = new Array(n);
  let t = 0; s = 0;
  for (let i = 0, e = buf.readUInt32BE(f.p); i < e; i++) {
    const cnt = buf.readUInt32BE(f.p + 4 + 8 * i), d = buf.readUInt32BE(f.p + 8 + 8 * i);
    for (let j = 0; j < cnt && s < n; j++) { dts[s] = t; dur[s] = d; t += d; s++; }
  }
  for (; s < n; s++) { dts[s] = t; dur[s] = 0; }
  // composition offsets, sync samples (no stss = every sample is a sync sample)
  let cts = null, cttsV = 0;
  const ct = find(k, 'ctts');
  if (ct) {
    f = fullBox(buf, ct); cttsV = f.v; cts = new Array(n).fill(0); s = 0;
    for (let i = 0, e = buf.readUInt32BE(f.p); i < e; i++) {
      const cnt = buf.readUInt32BE(f.p + 4 + 8 * i);
      const off = f.v === 1 ? buf.readInt32BE(f.p + 8 + 8 * i) : buf.readUInt32BE(f.p + 8 + 8 * i);
      for (let j = 0; j < cnt && s < n; j++) cts[s++] = off;
    }
  }
  let sync = null;
  const ss = find(k, 'stss');
  if (ss) {
    f = fullBox(buf, ss); sync = new Uint8Array(n);
    for (let i = 0, e = buf.readUInt32BE(f.p); i < e; i++) { const x = buf.readUInt32BE(f.p + 4 + 4 * i); if (x >= 1 && x <= n) sync[x - 1] = 1; }
  }
  return { n, size, offset, dts, dur, cts, cttsV, sync, stsd: find(k, 'stsd') };
}

async function readMovie(path) {
  const m = await openMovie(path);
  try {
    if (m.tops.some((b) => b.type === 'moof')) throw new Error('the clip is a fragmented movie (a live-stream layout), which cannot be cut without re-encoding');
    const moov = find(m.tops, 'moov');
    if (!moov) throw new Error('the clip has no index (moov): it may still be recording, or it was not finished');
    if (moov.size > MAX_MOOV) throw new Error(`the clip's index is ${Math.round(moov.size / 1048576)} MB, too big to cut here`);
    const buf = Buffer.alloc(moov.size);
    await m.fh.read(buf, 0, moov.size, moov.at);
    const kids = children(buf, moov.hdr, moov.size);
    const mvhdB = find(kids, 'mvhd');
    if (!mvhdB) throw new Error('the clip\'s index has no movie header');
    const movie = { buf, kids, mvhd: parseMvhd(buf, mvhdB), mvhdB, tracks: [], ftyp: find(m.tops, 'ftyp'), size: m.size };
    for (const t of kids.filter((x) => x.type === 'trak')) {
      const tk = children(buf, t.body, t.end);
      const mdia = find(tk, 'mdia');
      if (!mdia) continue;
      const mk = children(buf, mdia.body, mdia.end);
      const hdlr = find(mk, 'hdlr'), mdhd = find(mk, 'mdhd'), minf = find(mk, 'minf');
      if (!hdlr || !mdhd || !minf) continue;
      const handler = buf.toString('latin1', hdlr.body + 8, hdlr.body + 12);
      const stbl = find(children(buf, minf.body, minf.end), 'stbl');
      if (!stbl) continue;
      const edts = find(tk, 'edts');
      let mediaTime = 0;
      if (edts) {
        const el = find(children(buf, edts.body, edts.end), 'elst');
        if (el) {
          const f = fullBox(buf, el);
          const cnt = buf.readUInt32BE(f.p);
          for (let i = 0; i < cnt; i++) {
            const mt = f.v === 1 ? Number(buf.readBigInt64BE(f.p + 4 + 20 * i + 8)) : buf.readInt32BE(f.p + 4 + 12 * i + 4);
            if (mt >= 0) { mediaTime = mt; break; }   // the first real edit; an empty edit (-1) is a delay we drop
          }
        }
      }
      movie.tracks.push({ trak: t, tkhd: find(tk, 'tkhd'), mdia, mdhd, mdhdH: parseMdhd(buf, mdhd), hdlr, minf, stbl, handler, mediaTime, s: sampleTables(buf, stbl) });
    }
    if (!movie.tracks.some((t) => t.handler === 'vide' || t.handler === 'soun')) throw new Error('the clip has no video or audio track');
    return movie;
  } finally { await m.fh.close(); }
}

/* ---- the cut -------------------------------------------------------------------------------- */
function planCut(movie, startMs, endMs) {
  const vid = movie.tracks.find((t) => t.handler === 'vide');
  const lead = vid || movie.tracks[0];
  const ts = lead.mdhdH.timescale;
  const s = lead.s;
  const want = Math.max(0, startMs) / 1000 * ts + lead.mediaTime;
  // the keyframe at or before the asked start (by decode time; no stss = every sample is one)
  let first = 0;
  for (let i = 0; i < s.n; i++) {
    if (s.dts[i] > want) break;
    if (!s.sync || s.sync[i]) first = i;
  }
  const t0 = (s.dts[first] - lead.mediaTime) / ts;               // seconds on the movie's clock
  const t1 = Math.max(t0 + 0.05, endMs / 1000);
  const tracks = movie.tracks.map((t) => {
    const k = t.mdhdH.timescale, x = t.s;
    const a = t === lead ? first : x.dts.findIndex((d) => (d - t.mediaTime) / k >= t0 - 1e-6);
    let b = a - 1;
    if (a >= 0) for (let i = a; i < x.n && (x.dts[i] - t.mediaTime) / k < t1; i++) b = i;
    return { first: a, last: b };
  });
  const lastLead = tracks[movie.tracks.indexOf(lead)].last;
  const endS = lastLead >= first ? (s.dts[lastLead] + s.dur[lastLead] - lead.mediaTime) / ts : t1;
  return { startMs: Math.round(t0 * 1000), endMs: Math.round(Math.min(t1, endS) * 1000), tracks, lead: movie.tracks.indexOf(lead) };
}

/* box writers */
function box(type, ...parts) {
  const body = Buffer.concat(parts);
  const h = Buffer.alloc(8);
  h.writeUInt32BE(8 + body.length, 0); h.write(type, 4, 'latin1');
  return Buffer.concat([h, body]);
}
function full(type, v, flags, ...parts) {
  const h = Buffer.alloc(4); h[0] = v; h.writeUIntBE(flags, 1, 3);
  return box(type, h, ...parts);
}
function u32s(arr) { const b = Buffer.alloc(4 * arr.length); arr.forEach((x, i) => b.writeUInt32BE(x >>> 0, 4 * i)); return b; }
function rle(vals) { const out = []; for (const v of vals) { const l = out[out.length - 1]; if (l && l[1] === v) l[0]++; else out.push([1, v]); } return out; }

/* A copy of a header box with its duration replaced (mvhd / mdhd / tkhd, v0 or v1). */
function withDuration(buf, b, dur, kind) {
  const c = Buffer.from(buf.subarray(b.at, b.end));
  const v = c[b.body - b.at];
  const p = b.body - b.at + 4;
  const off = kind === 'tkhd' ? (v === 1 ? p + 24 : p + 16) : (v === 1 ? p + 16 + 4 : p + 8 + 4);
  if (v === 1) c.writeBigUInt64BE(BigInt(Math.max(0, Math.round(dur))), off); else c.writeUInt32BE(Math.max(0, Math.min(0xffffffff, Math.round(dur))), off);
  return c;
}
const raw = (buf, b) => Buffer.from(buf.subarray(b.at, b.end));

/* Everything about the new file's layout but the chunk offsets' base. */
function layout(movie, plan) {
  const sel = movie.tracks.map((t, i) => ({ t, i, first: plan.tracks[i].first, last: plan.tracks[i].last })).filter((x) => x.first >= 0 && x.last >= x.first);
  const chunks = [];
  for (const x of sel) {
    const k = x.t.mdhdH.timescale, s = x.t.s;
    let c = null;
    for (let i = x.first; i <= x.last; i++) {
      const at = (s.dts[i] - x.t.mediaTime) / k;
      if (!c || at - c.at >= CHUNK_S) { c = { track: x.i, at, samples: [] }; chunks.push(c); }
      c.samples.push(i);
    }
  }
  chunks.sort((a, b) => (a.at - b.at) || (a.track - b.track));
  let pos = 0;
  for (const c of chunks) { c.rel = pos; for (const i of c.samples) pos += movie.tracks[c.track].s.size[i]; }
  return { sel, chunks, dataBytes: pos };
}

function buildMoov(movie, plan, lay, base) {
  const { buf } = movie;
  const mts = movie.mvhd.timescale;
  const big = base + lay.dataBytes > 0xffffffff;
  const traks = [];
  let movieDur = 0;
  for (const x of lay.sel) {
    const t = x.t, s = t.s, k = t.mdhdH.timescale;
    const idx = [];
    for (let i = x.first; i <= x.last; i++) idx.push(i);
    const mediaDur = idx.reduce((a, i) => a + s.dur[i], 0);
    // the new edit: the source's first real media time when samples carry composition offsets
    // (H.264 with B-frames starts showing at that offset), else none
    const keepTime = s.cts ? Math.max(0, t.mediaTime) : 0;
    const shownDur = Math.max(0, mediaDur - keepTime);
    const trackDur = shownDur * mts / k;
    movieDur = Math.max(movieDur, trackDur);
    const stts = rle(idx.map((i) => s.dur[i]));
    const parts = [];
    parts.push(raw(buf, s.stsd));
    parts.push(full('stts', 0, 0, u32s([stts.length]), u32s([].concat(...stts))));
    if (s.cts) {
      const c = rle(idx.map((i) => s.cts[i]));
      const b = Buffer.alloc(4 + 8 * c.length); b.writeUInt32BE(c.length, 0);
      c.forEach(([n, v], j) => { b.writeUInt32BE(n, 4 + 8 * j); if (s.cttsV === 1) b.writeInt32BE(v, 8 + 8 * j); else b.writeUInt32BE(v >>> 0, 8 + 8 * j); });
      parts.push(full('ctts', s.cttsV, 0, b));
    }
    if (s.sync) {
      const list = []; idx.forEach((i, j) => { if (s.sync[i]) list.push(j + 1); });
      parts.push(full('stss', 0, 0, u32s([list.length]), u32s(list)));
    }
    const mine = lay.chunks.filter((c) => c.track === x.i);
    const per = rle(mine.map((c) => c.samples.length));
    const stsc = []; let ci = 1;
    for (const [n, v] of per) { stsc.push(ci, v, 1); ci += n; }
    parts.push(full('stsc', 0, 0, u32s([stsc.length / 3]), u32s(stsc)));
    parts.push(full('stsz', 0, 0, u32s([0, idx.length]), u32s(idx.map((i) => s.size[i]))));
    if (big) {
      const b = Buffer.alloc(4 + 8 * mine.length); b.writeUInt32BE(mine.length, 0);
      mine.forEach((c, j) => b.writeBigUInt64BE(BigInt(base + c.rel), 4 + 8 * j));
      parts.push(full('co64', 0, 0, b));
    } else parts.push(full('stco', 0, 0, u32s([mine.length]), u32s(mine.map((c) => base + c.rel))));
    const stbl = box('stbl', ...parts);
    const minfKids = children(buf, t.minf.body, t.minf.end).filter((c) => c.type !== 'stbl').map((c) => raw(buf, c));
    const minf = box('minf', ...minfKids, stbl);
    const mdiaKids = children(buf, t.mdia.body, t.mdia.end).filter((c) => c.type !== 'minf' && c.type !== 'mdhd').map((c) => raw(buf, c));
    const mdia = box('mdia', withDuration(buf, t.mdhd, mediaDur, 'mdhd'), ...mdiaKids, minf);
    const ed = [];
    if (keepTime > 0) {
      const el = Buffer.alloc(4 + 12); el.writeUInt32BE(1, 0); el.writeUInt32BE(Math.round(trackDur), 4); el.writeInt32BE(keepTime, 8); el.writeUInt32BE(0x00010000, 12);
      ed.push(box('edts', full('elst', 0, 0, el)));
    }
    const trakKids = children(buf, t.trak.body, t.trak.end).filter((c) => !['tkhd', 'mdia', 'edts'].includes(c.type)).map((c) => raw(buf, c));
    traks.push(box('trak', withDuration(buf, t.tkhd, trackDur, 'tkhd'), ...ed, ...trakKids, mdia));
  }
  const rest = movie.kids.filter((c) => c.type !== 'mvhd' && c.type !== 'trak').map((c) => raw(buf, c));
  return box('moov', withDuration(buf, movie.mvhdB, movieDur, 'mvhd'), ...traks, ...rest);
}

/* The new file is written to `${dst}.part` and renamed; `dst` must not exist (never overwrite). */
async function cut(src, dst, startMs, endMs) {
  const t0 = Date.now();
  if (fs.existsSync(dst)) throw new Error('a file with the new name is already there; nothing was overwritten');
  if (!(Number(endMs) > Number(startMs))) throw new Error('the part asked for is empty (its end is not after its start)');
  const movie = await readMovie(src);
  const lenMs = movie.mvhd.timescale ? movie.mvhd.duration * 1000 / movie.mvhd.timescale : 0;
  if (lenMs > 0 && Number(startMs) >= lenMs) throw new Error('the part asked for starts after the clip ends');
  const plan = planCut(movie, startMs, endMs);
  const lay = layout(movie, plan);
  if (!lay.chunks.length) throw new Error('the part asked for has no frames in it');
  const ftyp = movie.ftyp ? await (async () => { const fh = await fs.promises.open(src, 'r'); try { const b = Buffer.alloc(movie.ftyp.size); await fh.read(b, 0, b.length, movie.ftyp.at); return b; } finally { await fh.close(); } })()
    : box('ftyp', Buffer.from('isom\0\0\x02\0isomiso2avc1mp41', 'latin1'));
  // the moov's size does not depend on the base unless the offsets need 64 bits: build twice
  const mdatHdr = 16;
  let moov = buildMoov(movie, plan, lay, 0);
  let base = ftyp.length + moov.length + mdatHdr;
  moov = buildMoov(movie, plan, lay, base);
  if (ftyp.length + moov.length + mdatHdr !== base) { base = ftyp.length + moov.length + mdatHdr; moov = buildMoov(movie, plan, lay, base); }
  const part = `${dst}.part`;
  const out = await fs.promises.open(part, 'wx');
  const inp = await fs.promises.open(src, 'r');
  let written = 0;
  try {
    await out.write(ftyp, 0, ftyp.length, 0);
    await out.write(moov, 0, moov.length, ftyp.length);
    const mh = Buffer.alloc(16);
    mh.writeUInt32BE(1, 0); mh.write('mdat', 4, 'latin1'); mh.writeBigUInt64BE(BigInt(16 + lay.dataBytes), 8);
    await out.write(mh, 0, 16, ftyp.length + moov.length);
    const io = Buffer.alloc(RUN_MAX);
    let wpos = base;
    for (const c of lay.chunks) {
      const s = movie.tracks[c.track].s;
      let i = 0;
      while (i < c.samples.length) {
        // one read for a run of samples that sit back to back in the source
        let j = i, from = s.offset[c.samples[i]], len = s.size[c.samples[i]];
        while (j + 1 < c.samples.length && s.offset[c.samples[j + 1]] === from + len && len + s.size[c.samples[j + 1]] <= RUN_MAX) { j++; len += s.size[c.samples[j]]; }
        if (len > RUN_MAX) throw new Error('a single frame is bigger than 4 MB');
        const { bytesRead } = await inp.read(io, 0, len, from);
        if (bytesRead !== len) throw new Error('the clip ended before its index said it would (it may be damaged)');
        await out.write(io, 0, len, wpos);
        wpos += len; written += len; i = j + 1;
      }
    }
  } catch (err) {
    await out.close().catch(() => {}); await inp.close().catch(() => {});
    await fs.promises.unlink(part).catch(() => {});
    throw err;
  }
  await out.close(); await inp.close();
  if (fs.existsSync(dst)) { await fs.promises.unlink(part).catch(() => {}); throw new Error('a file with the new name appeared while cutting; nothing was overwritten'); }
  await fs.promises.rename(part, dst);
  return { ok: true, startMs: plan.startMs, endMs: plan.endMs, bytes: base + written, ms: Date.now() - t0 };
}

module.exports = { quickInfo, readMovie, planCut, cut, _box: box, _full: full, _u32s: u32s };
