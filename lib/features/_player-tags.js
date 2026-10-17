'use strict';
/*
 * _player-tags.js - song tags for Mantle Player's library (lane mantle-player, 2026-10-17). PURE: a Buffer of
 * the file's first bytes (and its last 128 for ID3v1) in, { title, artist, album, albumArtist, track, disc,
 * year, genre, cover: { mime, data } | null } out. Unknown fields stay null; the library fills the words.
 *
 *   ID3v2.2 / 2.3 / 2.4 (+ ID3v1)  .mp3 (and an .aac/.wav that carries one)
 *   FLAC Vorbis comment + PICTURE  .flac
 *   Ogg Vorbis / Opus comments     .ogg .oga .opus (METADATA_BLOCK_PICTURE covers too)
 *   MP4 ilst                       .m4a .mp4 .m4v .mov
 *
 * Never throws: a broken tag gives what was read before the break, plus `why`.
 */
const P = require('./_player-probe.js');

const be32 = (b, i) => b.readUInt32BE(i);
function text(enc, b) {
  if (!b || !b.length) return '';
  let s;
  if (enc === 1 || enc === 2) {
    let le = enc === 1;
    let start = 0;
    if (enc === 1 && b.length >= 2) { if (b[0] === 0xff && b[1] === 0xfe) { le = true; start = 2; } else if (b[0] === 0xfe && b[1] === 0xff) { le = false; start = 2; } }
    const body = Buffer.from(b.subarray(start, start + ((b.length - start) & ~1)));
    if (!le) body.swap16();
    s = body.toString('utf16le');
  } else if (enc === 3) s = b.toString('utf8');
  else s = b.toString('latin1');
  return s.replace(/\0[\s\S]*$/, '').trim();
}
function cleanNum(v) { const m = /^\s*(\d+)/.exec(String(v || '')); return m ? Number(m[1]) : null; }
function blank() { return { title: null, artist: null, album: null, albumArtist: null, track: null, disc: null, year: null, genre: null, cover: null, why: null }; }

/* ---- ID3v2 ---------------------------------------------------------------------------------- */
function unsync(b) { const out = []; for (let i = 0; i < b.length; i++) { out.push(b[i]); if (b[i] === 0xff && b[i + 1] === 0x00) i++; } return Buffer.from(out); }
const syncsafe = (b, i) => ((b[i] & 0x7f) << 21) | ((b[i + 1] & 0x7f) << 14) | ((b[i + 2] & 0x7f) << 7) | (b[i + 3] & 0x7f);
const ID3_MAP = { TIT2: 'title', TT2: 'title', TPE1: 'artist', TP1: 'artist', TALB: 'album', TAL: 'album', TPE2: 'albumArtist', TP2: 'albumArtist', TRCK: 'track', TRK: 'track', TPOS: 'disc', TPA: 'disc', TYER: 'year', TYE: 'year', TDRC: 'year', TCON: 'genre', TCO: 'genre' };
function id3v2(b, out) {
  const ver = b[3], flags = b[5];
  let size = syncsafe(b, 6);
  let body = b.subarray(10, Math.min(b.length, 10 + size));
  if (flags & 0x80 && ver < 4) body = unsync(body);
  let i = 0;
  if (flags & 0x40) i = ver >= 4 ? syncsafe(body, 0) : be32(body, 0) + 4;   // extended header
  const idLen = ver === 2 ? 3 : 4, hdr = ver === 2 ? 6 : 10;
  while (i + hdr <= body.length) {
    const id = body.toString('latin1', i, i + idLen);
    if (!/^[A-Z0-9]{3,4}$/.test(id)) break;
    const len = ver === 2 ? (body[i + 3] << 16) | (body[i + 4] << 8) | body[i + 5] : ver >= 4 ? syncsafe(body, i + 4) : be32(body, i + 4);
    const fflags = ver === 2 ? 0 : body[i + 9];
    let f = body.subarray(i + hdr, Math.min(body.length, i + hdr + len));
    if (ver >= 4 && fflags & 0x02) f = unsync(f);
    if (ver >= 4 && fflags & 0x01) f = f.subarray(4);                        // data length indicator
    i += hdr + len;
    if (len <= 0) break;
    const key = ID3_MAP[id];
    if (key && f.length > 1) { const v = text(f[0], f.subarray(1)); if (v && !out[key]) out[key] = v; continue; }
    if ((id === 'APIC' || id === 'PIC') && !out.cover && f.length > 4) {
      const enc = f[0];
      let j = 1, mime;
      if (id === 'PIC') { const fmt = f.toString('latin1', 1, 4).toLowerCase(); mime = fmt === 'png' ? 'image/png' : 'image/jpeg'; j = 4; }
      else { const z = f.indexOf(0, 1); mime = f.toString('latin1', 1, z < 0 ? 1 : z).toLowerCase() || 'image/jpeg'; j = z + 1; }
      j += 1;                                                                // picture type
      if (enc === 1 || enc === 2) { while (j + 1 < f.length && !(f[j] === 0 && f[j + 1] === 0)) j += 2; j += 2; }
      else { while (j < f.length && f[j] !== 0) j++; j += 1; }
      const data = f.subarray(j);
      if (data.length > 16) out.cover = { mime: /png/.test(mime) ? 'image/png' : 'image/jpeg', data: Buffer.from(data) };
    }
  }
  return size;
}
const GENRES = ['Blues', 'Classic Rock', 'Country', 'Dance', 'Disco', 'Funk', 'Grunge', 'Hip-Hop', 'Jazz', 'Metal', 'New Age', 'Oldies', 'Other', 'Pop', 'R&B', 'Rap', 'Reggae', 'Rock', 'Techno', 'Industrial'];
function id3v1(t, out) {
  if (!t || t.length < 128) return;
  const b = t.subarray(t.length - 128);
  if (b.toString('latin1', 0, 3) !== 'TAG') return;
  const f = (s, n) => b.toString('latin1', s, s + n).replace(/\0[\s\S]*$/, '').trim() || null;
  out.title = out.title || f(3, 30); out.artist = out.artist || f(33, 30); out.album = out.album || f(63, 30); out.year = out.year || f(93, 4);
  if (b[125] === 0 && b[126]) out.track = out.track || String(b[126]);
  if (!out.genre && GENRES[b[127]]) out.genre = GENRES[b[127]];
}

/* ---- Vorbis comments (FLAC, Ogg) -------------------------------------------------------------- */
const VC_MAP = { TITLE: 'title', ARTIST: 'artist', ALBUM: 'album', ALBUMARTIST: 'albumArtist', 'ALBUM ARTIST': 'albumArtist', TRACKNUMBER: 'track', DISCNUMBER: 'disc', DATE: 'year', YEAR: 'year', GENRE: 'genre' };
function flacPicture(b) {
  let i = 4;                                                                   // picture type
  const ml = be32(b, i); i += 4; const mime = b.toString('latin1', i, i + ml); i += ml;
  const dl = be32(b, i); i += 4 + dl + 16;
  const len = be32(b, i); i += 4;
  const data = b.subarray(i, i + len);
  return data.length > 16 ? { mime: /png/i.test(mime) ? 'image/png' : 'image/jpeg', data: Buffer.from(data) } : null;
}
function vorbisComments(b, out) {
  let i = 0;
  const vl = b.readUInt32LE(i); i += 4 + vl;
  const n = b.readUInt32LE(i); i += 4;
  for (let k = 0; k < n && i + 4 <= b.length; k++) {
    const l = b.readUInt32LE(i); i += 4;
    const s = b.toString('utf8', i, Math.min(b.length, i + l)); i += l;
    const eq = s.indexOf('='); if (eq < 1) continue;
    const key = s.slice(0, eq).toUpperCase(), v = s.slice(eq + 1).trim();
    if (VC_MAP[key] && v && !out[VC_MAP[key]]) out[VC_MAP[key]] = v;
    else if (key === 'METADATA_BLOCK_PICTURE' && !out.cover) { try { out.cover = flacPicture(Buffer.from(v, 'base64')); } catch (_) { /* a broken picture is no picture */ } }
  }
}
function flac(b, out) {
  let i = 4;
  for (;;) {
    if (i + 4 > b.length) break;
    const last = b[i] & 0x80, type = b[i] & 0x7f, len = (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3];
    const blk = b.subarray(i + 4, Math.min(b.length, i + 4 + len));
    if (type === 4) vorbisComments(blk, out);
    else if (type === 6 && !out.cover && blk.length === len) out.cover = flacPicture(blk);
    i += 4 + len;
    if (last) break;
  }
}
function ogg(b, out) {
  // reassemble the first stream's packets; packet 2 is the comment header
  let i = 0, serial = null; const packets = []; let cur = [];
  while (i + 27 <= b.length && b.toString('latin1', i, i + 4) === 'OggS' && packets.length < 2) {
    const sn = b.readUInt32LE(i + 14), segs = b[i + 26];
    let p = i + 27 + segs;
    if (serial === null) serial = sn;
    for (let k = 0; k < segs; k++) {
      const l = b[i + 27 + k];
      if (sn === serial) { cur.push(b.subarray(p, p + l)); if (l < 255) { packets.push(Buffer.concat(cur)); cur = []; } }
      p += l;
    }
    i = p;
  }
  const c = packets[1];
  if (!c) { out.why = 'the comment header was not in the part read'; return; }
  if (c.toString('latin1', 0, 7) === '\x03vorbis') vorbisComments(c.subarray(7), out);
  else if (c.toString('latin1', 0, 8) === 'OpusTags') vorbisComments(c.subarray(8), out);
}

/* ---- MP4 ilst --------------------------------------------------------------------------------- */
function mp4(b, out) {
  const kids = (s, e, fn) => { let i = s; while (i + 8 <= e) { const sz = be32(b, i); const t = b.toString('latin1', i + 4, i + 8); if (sz < 8) return; if (fn(t, i + 8, Math.min(e, i + sz)) === false) return; i += sz; } };
  const MAP = { '\xa9nam': 'title', '\xa9ART': 'artist', '\xa9alb': 'album', aART: 'albumArtist', '\xa9day': 'year', '\xa9gen': 'genre' };
  const ilst = (s, e) => kids(s, e, (t, a, z) => {
    let data = null, type = 0;
    kids(a, z, (t2, a2, z2) => { if (t2 === 'data') { type = be32(b, a2) & 0xffffff; data = b.subarray(a2 + 8, z2); } });
    if (!data) return;
    if (MAP[t]) { const v = data.toString('utf8').trim(); if (v && !out[MAP[t]]) out[MAP[t]] = v; }
    else if (t === 'trkn' && data.length >= 4) out.track = out.track || String(data.readUInt16BE(2));
    else if (t === 'disk' && data.length >= 4) out.disc = out.disc || String(data.readUInt16BE(2));
    else if (t === 'covr' && !out.cover && data.length > 16) out.cover = { mime: type === 14 ? 'image/png' : 'image/jpeg', data: Buffer.from(data) };
  });
  const walk = (s, e) => kids(s, e, (t, a, z) => {
    if (t === 'moov' || t === 'udta') walk(a, z);
    else if (t === 'meta') { const qt = b.toString('latin1', a + 4, a + 8) === 'hdlr'; walk(qt ? a : a + 4, z); }
    else if (t === 'ilst') ilst(a, z);
  });
  walk(0, b.length);
}

/** head: the file's first bytes (512 KB is plenty for tags with a cover); tail: its last 128 bytes or more. */
function read(headIn, tailIn, ext) {
  const out = blank();
  try {
    const b = Buffer.isBuffer(headIn) ? headIn : Buffer.from(headIn || []);
    const t = tailIn ? (Buffer.isBuffer(tailIn) ? tailIn : Buffer.from(tailIn)) : null;
    const s4 = b.toString('latin1', 0, 4);
    if (b.toString('latin1', 0, 3) === 'ID3') { const sz = id3v2(b, out); if (10 + sz > b.length) out.why = out.why || 'the tag is longer than the part read'; }
    else if (s4 === 'fLaC') flac(b, out);
    else if (s4 === 'OggS') ogg(b, out);
    else if (b.toString('latin1', 4, 8) === 'ftyp' || b.toString('latin1', 4, 8) === 'moov') {
      mp4(b, out);
      if (!out.title && t && t.length > 1024) mp4(t, out);
    }
    if (t) id3v1(t, out);
    void ext;
  } catch (e) { out.why = 'the tags are damaged (' + (e && e.message ? e.message : e) + ')'; }
  for (const k of ['track', 'disc']) out[k] = cleanNum(out[k]);
  out.year = out.year ? (/(\d{4})/.exec(String(out.year)) || [null, null])[1] : null;
  if (out.genre && /^\(?\d+\)?$/.test(out.genre)) out.genre = GENRES[Number(out.genre.replace(/\D/g, ''))] || null;
  return out;
}

module.exports = { read, _internals: { id3v2, flac, ogg, mp4, vorbisComments, text } };
void P;
