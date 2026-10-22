'use strict';
/*
 * player.test.js - Mantle Player's pure parts (lane mantle-player, 2026-10-17). No Electron, no registry, no
 * real files of the user's: every fixture is built here, byte by byte, in a temp folder.
 *   node lib/features/player.test.js   -> "PLAYER TEST: n passed, m failed"
 * Covers: the format probe (MP4/MOV/MKV/WebM/AVI/ASF/Ogg/WAV/FLAC/MP3/ADTS/TS/PS/unknown), the play verdict,
 * error words, subtitles (SRT->VTT, labels), natural order, tags (ID3v2.3/2.4/v1, FLAC, Ogg Opus, MP4 ilst),
 * the library scan (incremental, rescan, covers shared, folder art, .ts and node_modules skipped, search,
 * a broken cache), and "Use Mantle Player" (the plan, both dry runs touching nothing, use -> undo leaving a
 * fake registry exactly as it was, a failure midway rolled back, never UserChoice).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('./_player-probe.js');
const T = require('./_player-tags.js');
const { createLibrary } = require('./_player-library.js');
const A = require('./_player-assoc.js');

let passed = 0; const fails = [];
const ok = (c, name, d) => { if (c) passed++; else fails.push(name + (d !== undefined ? ' -- ' + (typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 300) : '')); return c; };

/* ---- byte builders ---------------------------------------------------------------------------- */
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
const box = (type, ...kids) => { const body = Buffer.concat(kids); return Buffer.concat([u32(8 + body.length), Buffer.from(type, 'latin1'), body]); };
const full = (type, ver, ...kids) => box(type, Buffer.from([ver, 0, 0, 0]), ...kids);
function stsdEntry(fmt, extra) { const body = Buffer.concat([Buffer.alloc(6), Buffer.from([0, 1]), Buffer.alloc(20), extra || Buffer.alloc(0)]); return Buffer.concat([u32(8 + body.length), Buffer.from(fmt, 'latin1'), body]); }
function esds(ot) { return full('esds', 0, Buffer.from([0x03, 0x19, 0x00, 0x01, 0x00, 0x04, 0x11, ot, 0x15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])); }
function trak(handler, fmt, extra) {
  return box('trak', box('mdia', full('hdlr', 0, Buffer.alloc(4), Buffer.from(handler, 'latin1'), Buffer.alloc(12)), box('minf', box('stbl', full('stsd', 0, u32(1), stsdEntry(fmt, extra))))));
}
function mvhd(ts, du) { return full('mvhd', 0, u32(0), u32(0), u32(ts), u32(du), Buffer.alloc(80)); }
function mp4(brand, traks, moovLast) {
  const ftyp = box('ftyp', Buffer.from(brand, 'latin1'), u32(0));
  const moov = box('moov', mvhd(1000, 125000), ...traks);
  const mdat = box('mdat', Buffer.alloc(64));
  return moovLast ? Buffer.concat([ftyp, mdat, moov]) : Buffer.concat([ftyp, moov, mdat]);
}
function ebmlStr(id, s) { const b = Buffer.from(s, 'latin1'); return Buffer.concat([Buffer.from(id), Buffer.from([0x80 | b.length]), b]); }
function mkv(doc, ids) { return Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f]), ebmlStr([0x42, 0x82], doc), Buffer.alloc(16), ...ids.map((x) => Buffer.concat([Buffer.from([0xae, 0x90, 0x83, 0x81, x[0] === 'V' ? 1 : x[0] === 'A' ? 2 : 17]), ebmlStr([0x86], x)]))]); }
function riff(form, chunks) { const body = Buffer.concat([Buffer.from(form, 'latin1'), ...chunks]); return Buffer.concat([Buffer.from('RIFF'), Buffer.from(Uint32Array.of(body.length).buffer), body]); }
const chunk = (id, data) => Buffer.concat([Buffer.from(id, 'latin1'), Buffer.from(Uint32Array.of(data.length).buffer), data]);
function le16(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; }
function avi(vfcc, atag) {
  const strhV = chunk('strh', Buffer.concat([Buffer.from('vids'), Buffer.from(vfcc), Buffer.alloc(48)]));
  const strfV = chunk('strf', Buffer.concat([Buffer.alloc(16), Buffer.from(vfcc), Buffer.alloc(20)]));
  const strhA = chunk('strh', Buffer.concat([Buffer.from('auds'), Buffer.alloc(4), Buffer.alloc(48)]));
  const strfA = chunk('strf', Buffer.concat([le16(atag), Buffer.alloc(16)]));
  return riff('AVI ', [chunk('LIST', Buffer.concat([Buffer.from('hdrl'), chunk('LIST', Buffer.concat([Buffer.from('strl'), strhV, strfV])), chunk('LIST', Buffer.concat([Buffer.from('strl'), strhA, strfA]))]))]);
}
function oggPage(serial, seq, flags, packet) {
  const segs = []; let n = packet.length; while (n >= 255) { segs.push(255); n -= 255; } segs.push(n);
  const h = Buffer.alloc(27); h.write('OggS', 0, 'latin1'); h[5] = flags; h.writeUInt32LE(serial, 14); h.writeUInt32LE(seq, 18); h[26] = segs.length;
  return Buffer.concat([h, Buffer.from(segs), packet]);
}
function vcomments(pairs, prefix) {
  const parts = [Buffer.from(Uint32Array.of(6).buffer), Buffer.from('mantle'), Buffer.from(Uint32Array.of(pairs.length).buffer)];
  for (const s of pairs) { const b = Buffer.from(s, 'utf8'); parts.push(Buffer.from(Uint32Array.of(b.length).buffer), b); }
  return Buffer.concat([Buffer.from(prefix, 'latin1'), ...parts]);
}
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 7)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 3)]);
function syncsafe(n) { return Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]); }
function id3(ver, frames) {
  const fr = frames.map(([id, data]) => Buffer.concat([Buffer.from(id, 'latin1'), ver === 4 ? syncsafe(data.length) : u32(data.length), Buffer.from([0, 0]), data]));
  const body = Buffer.concat(fr);
  return Buffer.concat([Buffer.from('ID3'), Buffer.from([ver, 0, 0]), syncsafe(body.length), body]);
}
const tx = (s, enc) => (enc === 3 ? Buffer.concat([Buffer.from([3]), Buffer.from(s, 'utf8')]) : enc === 1 ? Buffer.concat([Buffer.from([1, 0xff, 0xfe]), Buffer.from(s, 'utf16le')]) : Buffer.concat([Buffer.from([0]), Buffer.from(s, 'latin1')]));
const apic = (img, mime) => Buffer.concat([Buffer.from([0]), Buffer.from(mime + '\0', 'latin1'), Buffer.from([3]), Buffer.from('\0'), img]);
const MP3FRAMES = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(400)]);
function mp3(tags, title) { return Buffer.concat([id3(3, [['TIT2', tx(title || 'Song')], ...tags]), MP3FRAMES]); }
function flacPic(img, mime) { return Buffer.concat([u32(3), u32(mime.length), Buffer.from(mime), u32(0), u32(1), u32(1), u32(24), u32(0), u32(img.length), img]); }
function flac(pairs, pic) {
  const vc = vcomments(pairs, '');
  const blk = (type, data, last) => Buffer.concat([Buffer.from([(last ? 0x80 : 0) | type, (data.length >> 16) & 255, (data.length >> 8) & 255, data.length & 255]), data]);
  return Buffer.concat([Buffer.from('fLaC'), blk(0, Buffer.alloc(34)), blk(4, vc, !pic), ...(pic ? [blk(6, flacPic(pic, 'image/png'), true)] : [])]);
}

/* ---- 1. the probe ------------------------------------------------------------------------------ */
{
  const avc = trak('vide', 'avc1'), aac = trak('soun', 'mp4a', esds(0x40)), mp3a = trak('soun', 'mp4a', esds(0x6b)), ac3 = trak('soun', 'ac-3');
  let p = P.probe(mp4('isom', [avc, aac]), null, 999);
  ok(p.container === 'mp4' && p.tracks.map((t) => t.codec).join() === 'h264,aac', 'probe: MP4 H.264 + AAC (esds 0x40)', p);
  ok(Math.abs(p.duration - 125) < 0.01, 'probe: MP4 duration from mvhd (125 s)', p.duration);
  p = P.probe(mp4('isom', [avc, mp3a]), null, 999);
  ok(p.tracks[1].codec === 'mp3', 'probe: MP4 mp4a with objectType 0x6B is MP3, not AAC', p.tracks);
  p = P.probe(mp4('qt  ', [trak('vide', 'hvc1'), ac3]), null, 999);
  ok(p.container === 'mov' && p.label === 'QuickTime (MOV)' && p.tracks.map((t) => t.codec).join() === 'hevc,ac3', 'probe: MOV brand, HEVC + AC-3', p);
  const tail = mp4('isom', [avc, aac], true);
  p = P.probe(tail.subarray(0, 40), tail, tail.length);
  ok(p.tracks.length === 2, 'probe: MP4 whose index (moov) sits at the END is read from the tail', p);
  p = P.probe(tail.subarray(0, 40), null, tail.length);
  ok(p.tracks.length === 0 && /moov/.test(p.note), 'probe: index not read says so (note)', p);
  p = P.probe(mkv('matroska', ['V_MPEG4/ISO/AVC', 'A_DTS', 'S_TEXT/UTF8', 'A_AAC']), null, 1);
  ok(p.container === 'mkv' && p.tracks.map((t) => t.type + ':' + t.codec).join() === 'video:h264,audio:dts,text:srt,audio:aac', 'probe: MKV codec IDs (H.264, DTS, SRT, AAC)', p.tracks);
  p = P.probe(mkv('webm', ['V_VP9', 'A_OPUS']), null, 1);
  ok(p.container === 'webm' && p.label === 'WebM' && p.tracks.map((t) => t.codec).join() === 'vp9,opus', 'probe: WebM doc type, VP9 + Opus', p);
  p = P.probe(mkv('matroska', ['V_MPEGH/ISO/HEVC', 'A_EAC3', 'S_HDMV/PGS']), null, 1);
  ok(p.tracks.map((t) => t.codec).join() === 'hevc,eac3,pgs', 'probe: MKV HEVC + E-AC-3 + PGS', p.tracks);
  p = P.probe(avi('MJPG', 0x1), null, 1);
  ok(p.container === 'avi' && p.tracks.map((t) => t.codec).join() === 'mjpeg,pcm', 'probe: AVI MJPEG + PCM', p.tracks);
  p = P.probe(avi('XVID', 0x2000), null, 1);
  ok(p.tracks.map((t) => t.codec).join() === 'mpeg4,ac3', 'probe: AVI Xvid + AC-3', p.tracks);
  const asf = Buffer.concat([Buffer.from([0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6, 0xd9, 0x00, 0xaa, 0x00, 0x62, 0xce, 0x6c]), Buffer.alloc(200)]);
  p = P.probe(asf, null, 1);
  ok(p.container === 'asf' && p.label === 'Windows Media (ASF)', 'probe: ASF (WMV/WMA) header', p);
  const ogg = Buffer.concat([oggPage(7, 0, 2, Buffer.concat([Buffer.from('OpusHead'), Buffer.alloc(11)])), oggPage(7, 1, 0, vcomments(['TITLE=T'], 'OpusTags'))]);
  p = P.probe(ogg, null, 1);
  ok(p.container === 'ogg' && p.tracks.map((t) => t.codec).join() === 'opus', 'probe: Ogg Opus', p);
  const wav = riff('WAVE', [chunk('fmt ', Buffer.concat([le16(1), le16(2), Buffer.from(Uint32Array.of(48000, 192000).buffer), le16(4), le16(16)])), chunk('data', Buffer.alloc(192000 * 2))]);
  p = P.probe(wav.subarray(0, 4096), null, wav.length);
  ok(p.container === 'wav' && p.tracks[0].codec === 'pcm' && Math.abs(p.duration - 2) < 0.01, 'probe: WAV PCM with duration', p);
  p = P.probe(flac(['TITLE=x']), null, 1);
  ok(p.container === 'flac' && p.tracks[0].codec === 'flac', 'probe: FLAC', p);
  p = P.probe(mp3([]), null, 1);
  ok(p.container === 'mp3' && p.tracks[0].codec === 'mp3', 'probe: ID3 + MPEG audio = MP3', p);
  p = P.probe(Buffer.concat([Buffer.from([0xff, 0xf1, 0x50, 0x80]), Buffer.alloc(20)]), null, 1);
  ok(p.container === 'adts' && p.tracks[0].codec === 'aac', 'probe: ADTS AAC', p);
  const ts = Buffer.alloc(188 * 3); ts[0] = ts[188] = ts[376] = 0x47;
  ok(P.probe(ts, null, 1).container === 'mpegts', 'probe: MPEG-TS by its sync bytes');
  ok(P.probe(Buffer.from('import x from "y";\nexport const a = 1;\n'.repeat(20)), null, 1).container === 'unknown', 'probe: a TypeScript .ts is NOT a video (unknown)');
  ok(P.probe(Buffer.from([0, 0, 1, 0xba, 0, 0, 0, 0]), null, 1).container === 'mpegps', 'probe: MPEG-PS');
  const e = P.probe(Buffer.alloc(0), null, 0);
  ok(e.container === 'unknown' && /empty/.test(e.note), 'probe: an empty file says it is empty', e);
  ok(P.kindOf('C:\\a\\b.MKV') === 'video' && P.kindOf('x.flac') === 'audio' && P.kindOf('x.srt') === 'subtitle' && P.kindOf('x.txt') === null, 'kindOf by extension, case-blind');
  ok(P.LIB_SKIP.has('ts'), 'the library never lists .ts (TypeScript shares the extension)');
}

/* ---- 2. the verdict ------------------------------------------------------------------------------ */
{
  const yes = (c) => ['h264', 'aac', 'mp3', 'opus', 'vorbis', 'vp9', 'vp8', 'av1', 'flac', 'pcm'].includes(c);
  const V = (buf) => P.verdict(P.probe(buf, null, 1), yes);
  let r = V(mp4('isom', [trak('vide', 'avc1'), trak('soun', 'mp4a', esds(0x40))]));
  ok(r.state === 'play' && !r.reason, 'verdict: H.264 + AAC plays', r);
  r = V(mkv('matroska', ['V_MPEG4/ISO/AVC', 'A_DTS']));
  ok(r.state === 'partial' && /No sound: its audio is DTS/.test(r.reason), 'verdict: H.264 + DTS plays WITHOUT sound and says so', r);
  r = V(mkv('matroska', ['V_MPEG4/ISO/AVC', 'A_DTS', 'A_AAC']));
  ok(r.state === 'play' && /1 of its sound tracks \(DTS\)/.test(r.reason), 'verdict: a second, playable sound track: plays, names the one that cannot', r);
  r = V(mp4('qt  ', [trak('vide', 'hvc1'), trak('soun', 'mp4a', esds(0x40))]));
  ok(r.state === 'no' && /HEVC \(H\.265\)/.test(r.reason) && /HEVC Video Extensions/.test(r.reason) && /another app/.test(r.way), 'verdict: HEVC on a PC without it: no, with the codec, the fix and a way out', r);
  r = P.verdict(P.probe(mp4('qt  ', [trak('vide', 'hvc1')]), null, 1), (c) => c === 'hevc');
  ok(r.state === 'play', 'verdict: HEVC on a PC that decodes it plays (asks Chromium, never assumes)', r);
  r = V(avi('XVID', 0x55));
  ok(r.state === 'no' && /can't open AVI files/.test(r.reason) && /MPEG-4 Part 2/.test(r.reason) && /MP3/.test(r.reason), 'verdict: AVI is refused with its container AND codecs named', r);
  r = V(mkv('matroska', ['V_VP9', 'A_OPUS', 'S_TEXT/UTF8']));
  ok(r.state === 'play' && /built-in subtitles \(SRT text\) can't be shown yet/.test(r.reason), 'verdict: built-in SRT subtitles are named, not hidden', r);
  r = V(Buffer.from([0x0b, 0x77, 0, 0, 0, 0]));
  ok(r.state === 'no', 'verdict: raw AC-3 is refused', r);
  ok(P.verdict(P.probe(Buffer.from('hello world, not media at all'), null, 1), yes).state === 'try', 'verdict: unknown bytes are left for Chromium to try (its error is then shown)');
  ok(/damaged/.test(P.errorWords(3, 'PIPELINE_ERROR_DECODE', P.probe(mp4('isom', [trak('vide', 'avc1')]), null, 1))), 'errorWords: decode error = damaged');
  ok(/isn't a video or music format/.test(P.errorWords(4, 'DEMUXER_ERROR_COULD_NOT_OPEN', P.probe(Buffer.from('garbage bytes'), null, 1))), 'errorWords: unknown format');
  ok(!/[A-Z_]{6,}/.test(P.errorWords(5, 'PIPELINE_ERROR_X: something', null)), 'errorWords: no raw Chromium codes on screen');
}

/* ---- 3. subtitles, order, clock ------------------------------------------------------------------- */
{
  const srt = '\uFEFF1\r\n00:00:01,000 --> 00:00:02,500\r\nHello\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nWorld\r\n';
  const vtt = P.srtToVtt(srt);
  ok(vtt.startsWith('WEBVTT\n\n') && vtt.includes('00:00:01.000 --> 00:00:02.500\nHello') && !/\r/.test(vtt) && !/^1$/m.test(vtt), 'srtToVtt: header, dots, no cue numbers, no CR', vtt);
  ok(P.srtToVtt('WEBVTT\n\n00:01.000 --> 00:02.000\nx').startsWith('WEBVTT\n\n00:01.000'), 'srtToVtt: a VTT passes through');
  ok(JSON.stringify(P.subLabel('Movie', 'movie.srt')) === '{"lang":null,"label":"Subtitles"}', 'subLabel: same name');
  ok(P.subLabel('Movie', 'Movie.en.srt').label === 'English' && P.subLabel('Movie', 'Movie.fre.forced.vtt').label === 'French (forced)', 'subLabel: language codes and forced');
  ok(P.subLabel('Movie', 'Movie 2.srt') === null && P.subLabel('Movie', 'Movie.txt') === null, 'subLabel: another video\'s subtitles are not this one\'s');
  const names = ['Ep 10.mp4', 'Ep 2.mp4', 'ep 1.mp4', 'Ep 2b.mp4'];
  ok(names.slice().sort(P.natural).join('|') === 'ep 1.mp4|Ep 2.mp4|Ep 2b.mp4|Ep 10.mp4', 'natural order: 2 before 10', names.slice().sort(P.natural));
  ok(P.clock(0) === '0:00' && P.clock(65) === '1:05' && P.clock(3725) === '1:02:05' && P.clock(NaN) === '--:--', 'clock');
}

/* ---- 4. tags ------------------------------------------------------------------------------------- */
{
  let t = T.read(mp3([['TPE1', tx('Artist A')], ['TALB', tx('Album A')], ['TRCK', tx('3/12')], ['TYER', tx('2019')], ['APIC', apic(JPG, 'image/jpeg')]], 'Title A'));
  ok(t.title === 'Title A' && t.artist === 'Artist A' && t.album === 'Album A' && t.track === 3 && t.year === '2019' && t.cover && t.cover.mime === 'image/jpeg' && t.cover.data.equals(JPG), 'tags: ID3v2.3 text + track "3/12" + cover', Object.assign({}, t, { cover: !!t.cover }));
  t = T.read(Buffer.concat([id3(4, [['TIT2', tx('Ünïcode ✓', 3)], ['TPE1', tx('Ärtist', 1)], ['TDRC', tx('2021-05-01', 3)]]), MP3FRAMES]));
  ok(t.title === 'Ünïcode ✓' && t.artist === 'Ärtist' && t.year === '2021', 'tags: ID3v2.4 UTF-8, UTF-16 with BOM, TDRC year', t);
  const v1 = Buffer.alloc(128); v1.write('TAG', 0, 'latin1'); v1.write('Old Title', 3, 'latin1'); v1.write('Old Artist', 33, 'latin1'); v1[126] = 7;
  t = T.read(MP3FRAMES, Buffer.concat([MP3FRAMES, v1]));
  ok(t.title === 'Old Title' && t.artist === 'Old Artist' && t.track === 7, 'tags: ID3v1 from the tail', t);
  t = T.read(flac(['TITLE=Flac T', 'ARTIST=Flac A', 'ALBUM=Flac Al', 'TRACKNUMBER=05', 'ALBUMARTIST=Various'], PNG));
  ok(t.title === 'Flac T' && t.track === 5 && t.albumArtist === 'Various' && t.cover && t.cover.mime === 'image/png', 'tags: FLAC Vorbis comment + PICTURE', Object.assign({}, t, { cover: !!t.cover }));
  const pic64 = flacPic(JPG, 'image/jpeg').toString('base64');
  const ogg = Buffer.concat([oggPage(9, 0, 2, Buffer.concat([Buffer.from('OpusHead'), Buffer.alloc(11)])), oggPage(9, 1, 0, vcomments(['TITLE=Opus T', 'ARTIST=Opus A', 'METADATA_BLOCK_PICTURE=' + pic64], 'OpusTags'))]);
  t = T.read(ogg);
  ok(t.title === 'Opus T' && t.artist === 'Opus A' && t.cover && t.cover.data.equals(JPG), 'tags: Ogg Opus comments + METADATA_BLOCK_PICTURE', Object.assign({}, t, { cover: !!t.cover }));
  const item = (k, data, type) => box(k, box('data', u32(type || 1), u32(0), data));
  const trkn = Buffer.from([0, 0, 0, 4, 0, 10, 0, 0]);
  const m4a = Buffer.concat([box('ftyp', Buffer.from('M4A '), u32(0)), box('moov', mvhd(1000, 1000), box('udta', full('meta', 0, full('hdlr', 0, Buffer.alloc(4), Buffer.from('mdir'), Buffer.alloc(12)), box('ilst', item('\xa9nam', Buffer.from('M4A T')), item('\xa9ART', Buffer.from('M4A A')), item('\xa9alb', Buffer.from('M4A Al')), item('trkn', trkn, 0), item('covr', PNG, 14)))))]);
  t = T.read(m4a);
  ok(t.title === 'M4A T' && t.artist === 'M4A A' && t.album === 'M4A Al' && t.track === 4 && t.cover && t.cover.mime === 'image/png', 'tags: MP4 ilst (©nam ©ART ©alb trkn covr)', Object.assign({}, t, { cover: !!t.cover }));
  t = T.read(Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0x7f, 0x7f, 0x7f, 0x7f, 0x54, 0x49]));
  ok(t.title === null && typeof t.why === 'string', 'tags: a truncated tag never throws and says why', t);
}

/* ---- 5. the library ------------------------------------------------------------------------------ */
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-player-lib-'));
  try {
    const music = path.join(tmp, 'Music'), videos = path.join(tmp, 'Videos');
    const al = path.join(music, 'Artist A', 'Album A'), al2 = path.join(music, 'B Side');
    for (const d of [al, al2, videos, path.join(music, 'node_modules', 'x'), path.join(videos, 'Captures')]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(al, '01 one.mp3'), mp3([['TPE1', tx('Artist A')], ['TALB', tx('Album A')], ['TRCK', tx('1')], ['APIC', apic(JPG, 'image/jpeg')]], 'One'));
    fs.writeFileSync(path.join(al, '02 two.mp3'), mp3([['TPE1', tx('Artist A')], ['TALB', tx('Album A')], ['TRCK', tx('2')], ['APIC', apic(JPG, 'image/jpeg')]], 'Two'));
    fs.writeFileSync(path.join(al2, 'side.flac'), flac(['TITLE=Side', 'ARTIST=Bee', 'ALBUM=B Side']));
    fs.writeFileSync(path.join(al2, 'folder.jpg'), JPG);
    fs.writeFileSync(path.join(al2, 'untagged.wav'), riff('WAVE', [chunk('fmt ', Buffer.concat([le16(1), le16(1), Buffer.from(Uint32Array.of(8000, 16000).buffer), le16(2), le16(16)])), chunk('data', Buffer.alloc(100))]));
    fs.writeFileSync(path.join(music, 'node_modules', 'x', 'hidden.mp3'), mp3([], 'Hidden'));
    fs.writeFileSync(path.join(videos, 'clip.mp4'), mp4('isom', [trak('vide', 'avc1')]));
    fs.writeFileSync(path.join(videos, 'Captures', 'game.mp4'), mp4('isom', [trak('vide', 'avc1')]));
    fs.writeFileSync(path.join(videos, 'source.ts'), 'export const x = 1;');
    fs.writeFileSync(path.join(videos, 'notes.txt'), 'x');
    const cacheFile = path.join(tmp, 'ud', 'player-library.json'), coverDir = path.join(tmp, 'ud', 'covers');
    let reads = 0;
    const spyFs = Object.assign({}, fs, { promises: Object.assign({}, fs.promises, { open: (...a) => { reads++; return fs.promises.open(...a); } }) });
    const mk = () => createLibrary({ roots: [{ dir: music, kind: 'music', label: 'Music' }, { dir: videos, kind: 'videos', label: 'Videos' }, { dir: path.join(tmp, 'Nope'), kind: 'music', label: 'Elsewhere' }], cacheFile, coverDir, fs: spyFs });
    let L = mk(); await L.load();
    let r = await L.scan();
    ok(r.ok && r.added === 6 && r.kept === 0, 'library: first scan finds 4 songs + 2 videos (node_modules, .ts, .txt skipped)', r);
    let v = L.view();
    ok(v.songs.length === 4 && v.videos.length === 2, 'library: 4 songs, 2 videos (Captures included)', { s: v.songs.length, v: v.videos.length });
    ok(!v.songs.some((s) => s.title === 'Hidden') && !v.videos.some((x) => /source/.test(x.title)), 'library: node_modules and TypeScript .ts never listed');
    ok(v.songs.map((s) => s.title).join('|') === 'One|Two|Side|untagged', 'library: songs ordered by album artist, album, track; untagged by file name', v.songs.map((s) => s.title));
    ok(reads === 4, 'library: only the 4 songs were opened for tags (videos are listed by name)', reads);
    const covers = fs.readdirSync(coverDir);
    ok(covers.length === 1 && v.songs[0].cover === v.songs[1].cover, 'library: two songs with the same picture share ONE cover file', covers);
    ok(v.songs.find((s) => s.title === 'Side').cover === path.join(al2, 'folder.jpg'), 'library: folder.jpg is the fallback cover');
    ok(v.albums.length === 3 && v.albums.find((a) => a.album === 'Album A').songs.length === 2, 'library: albums grouped (Album A has 2)', v.albums.map((a) => a.album));
    ok(v.artists.some((a) => a.artist === 'Artist A' && a.songs.length === 2 && a.albums === 1), 'library: artists grouped with album counts');
    ok(/not found: Elsewhere/.test(v.reason || ''), 'library: a missing root is said, by its label (never a path)', v.reason);
    reads = 0;
    L = mk(); await L.load(); r = await L.scan();
    ok(r.kept === 6 && r.added === 0 && reads === 0, 'library: a second scan (new start, from the cache) reads NO file again', { r, reads });
    await new Promise((res) => setTimeout(res, 20));
    fs.writeFileSync(path.join(al, '02 two.mp3'), mp3([['TPE1', tx('Artist A')], ['TALB', tx('Album A')], ['TRCK', tx('2')]], 'Two (remix)'));
    fs.rmSync(path.join(al2, 'untagged.wav'));
    reads = 0; r = await L.scan();
    ok(r.changed === 1 && r.removed === 1 && r.kept === 4 && reads === 1, 'library: rescan re-reads only the changed song; a deleted one is dropped', { r, reads });
    ok(L.view().songs.some((s) => s.title === 'Two (remix)'), 'library: the changed song has its new title');
    reads = 0; r = await L.scan({ force: true });
    ok(r.changed === 5 && reads === 3, 'library: a full rescan (force) reads every song again', { r, reads });
    const s = L.search('artist a two');
    ok(s.songs.length === 1 && s.songs[0].title === 'Two (remix)' && s.videos.length === 0, 'library: search matches every word across title/artist/album', s.songs.map((x) => x.title));
    ok(L.search('game').videos.length === 1, 'library: search finds videos by name');
    const p1 = L.scan(), p2 = L.scan();
    ok(p1 === p2, 'library: one scan at a time (a second call gets the running one)');
    await p1;
    fs.writeFileSync(cacheFile, '{not json');
    L = mk(); await L.load();
    ok(/could not be read/.test(L.view().reason || '') && L.view().songs.length === 0, 'library: a broken cache is an empty library with the reason', L.view().reason);
    r = await L.scan();
    ok(r.added === 5, 'library: and the next scan rebuilds it', r);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }

  /* ---- 6. "Use Mantle Player for video and music" ----------------------------------------------- */
  const o0 = { exe: 'C:\\m\\electron.exe', appDir: 'C:\\m', icon: 'C:\\m\\assets\\icons\\mantle-player.ico' };
  const plan = A.plan(o0);
  ok(plan.every((x) => !/UserChoice/i.test(x.key) && !/UserChoice/i.test(String(x.name))), 'assoc: the plan never touches UserChoice');
  ok(plan.every((x) => /^Software\\(Classes|Mantle|RegisteredApplications)/.test(x.key)), 'assoc: every key is under HKCU\\Software\\Classes, \\Mantle or \\RegisteredApplications');
  ok(plan.some((x) => x.key === 'Software\\RegisteredApplications' && x.name === 'Mantle Player' && x.data === A.CAPS), 'assoc: RegisteredApplications points at the Capabilities key');
  ok(plan.some((x) => x.key === 'Software\\Classes\\.mp4\\OpenWithProgids' && x.name === 'MantlePlayer.Video' && x.type === 'REG_NONE'), 'assoc: .mp4 OpenWithProgids gets MantlePlayer.Video (REG_NONE)');
  const cmdline = plan.find((x) => /MantlePlayer\.Video\\shell\\open\\command$/.test(x.key)).data;
  ok(cmdline === '"C:\\m\\electron.exe" "C:\\m" --open=player "--play=%1"', 'assoc: the open command is the running Mantle\'s --open=player --play', cmdline);
  ok(!A.VIDEO.includes('.avi') && !A.VIDEO.includes('.wmv'), 'assoc: no type it cannot play is claimed (no AVI/WMV)');
  const calls = [];
  const spy = async (args) => { calls.push(args); return { code: 0, out: '' }; };
  let rec = null; const record = { get: () => rec, set: (x) => { rec = x; } };
  let u = await A.use(Object.assign({}, o0, { dryRun: true, reg: spy, record }));
  ok(u.ok && u.dryRun && calls.length === 0 && rec === null && /nothing was written/.test(u.reason) && u.lines.length === plan.length, 'assoc: --test dry run runs NOTHING (not even a read) and lists what it would write', { calls: calls.length, u: u.reason });
  process.env.MANTLE_PLAYER_DRYRUN = '1';
  u = await A.use(Object.assign({}, o0, { dryRun: false, reg: spy, record }));
  const st = await A.status(Object.assign({}, o0, { dryRun: false, reg: spy, record }));
  ok(u.dryRun && calls.length === 0 && st.dryRun, 'assoc: MANTLE_PLAYER_DRYRUN=1 is a dry run too (use and status)', calls.length);
  delete process.env.MANTLE_PLAYER_DRYRUN;
  // a fake HKCU: keys -> Map(valueName -> data); reg.exe semantics for query/add/delete
  function fakeReg(seed) {
    const K = new Map(seed || []);
    const norm = (k) => k.replace(/^HKCU\\/, '').toLowerCase();
    const ensure = (k) => { const parts = k.split('\\'); for (let i = 1; i <= parts.length; i++) { const kk = parts.slice(0, i).join('\\'); if (!K.has(kk)) K.set(kk, new Map()); } };
    const run = async (args) => {
      const [op, key] = args; const k = norm(key); const vi = args.indexOf('/v'); const vn = args.includes('/ve') ? '' : vi > 0 ? args[vi + 1].toLowerCase() : null;
      if (run.failOn && op === 'add' && run.failOn(k, vn)) return { code: 1, out: 'ERROR: Access is denied.' };
      if (op === 'query') { if (!K.has(k)) return { code: 1, out: '' }; if (vn === null) return { code: 0, out: '' }; return { code: K.get(k).has(vn) ? 0 : 1, out: '' }; }
      if (op === 'add') { ensure(k); K.get(k).set(vn === null ? '' : vn, args.includes('/d') ? args[args.indexOf('/d') + 1] : ''); return { code: 0, out: '' }; }
      if (op === 'delete') { if (vn === null) { for (const kk of Array.from(K.keys())) if (kk === k || kk.startsWith(k + '\\')) K.delete(kk); return { code: 0, out: '' }; } if (K.has(k)) K.get(k).delete(vn); return { code: 0, out: '' }; }
      return { code: 1, out: 'bad op' };
    };
    run.dump = () => JSON.stringify(Array.from(K.entries()).map(([k, m]) => [k, Array.from(m.entries()).sort()]).sort());
    return run;
  }
  const seed = [['software', new Map()], ['software\\classes', new Map()], ['software\\classes\\.mp4', new Map([['', 'WMP11.AssocFile.MP4']])], ['software\\classes\\.mp4\\openwithprogids', new Map([['appx123', '']])], ['software\\registeredapplications', new Map([['other app', 'x']])]];
  const reg = fakeReg(seed); const before = reg.dump();
  rec = null;
  u = await A.use(Object.assign({}, o0, { reg, record }));
  ok(u.ok && !u.dryRun && rec && rec.done, 'assoc: use() on a fake registry succeeds and records what it did', u);
  ok(reg.dump() !== before && (await reg(['query', 'HKCU\\Software\\RegisteredApplications', '/v', 'Mantle Player'])).code === 0, 'assoc: Mantle Player is registered');
  const s1 = await A.status(Object.assign({}, o0, { reg, record }));
  ok(s1.registered && s1.recorded, 'assoc: status reads it back', s1);
  u = await A.use(Object.assign({}, o0, { reg, record }));
  ok(u.ok && u.already, 'assoc: a second Set up changes nothing (already)');
  const un = await A.undo(Object.assign({}, o0, { reg, record }));
  ok(un.ok && rec === null, 'assoc: undo() succeeds and clears the record', un);
  ok(reg.dump() === before, 'assoc: after undo the registry is EXACTLY as before (the existing .mp4 keys and the other app kept)', { before: before.slice(0, 200), after: reg.dump().slice(0, 200) });
  const un2 = await A.undo(Object.assign({}, o0, { reg, record }));
  ok(un2.ok && un2.nothing && un2.note === un2.reason && /nothing to take out/.test(un2.note), 'assoc: undo with nothing added says so, as a note Settings shows under the button', un2);

  // the launcher: once Windows' Store list is in, "media player" must still find MANTLE Player first (the e2e caught
  // Windows' own row, exact name less the secondary penalty, outranking Mantle's keyword match)
  {
    const LI = require('../launcher-index.js');
    const G = LI._internals.state, was = G.store;
    G.store = { list: [{ name: 'Media Player', aumid: 'Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic' }] };
    try {
      for (const q of ['media player', 'media', 'player', 'mantle player']) {
        const hits = LI.search(q, []).filter((x) => x && x.kind === 'app');
        const iM = hits.findIndex((x) => x.path === 'mantle:player'), iW = hits.findIndex((x) => x.secondary && /ZuneMusic/.test(x.path));
        ok(iM === 0 && (iW === -1 || iW > iM), `launcher: "${q}" lists Mantle Player first, Windows' Media Player under it`, hits.slice(0, 3).map((x) => x.name + (x.secondary ? ' (secondary)' : '')));
      }
      const hits = LI.search('media player', []).filter((x) => x && x.kind === 'app');
      const standIn = hits.find((x) => x.path === 'mantle:player' && x.aumid), own = hits.find((x) => x.secondary && x.aumid);
      const r1 = standIn ? await LI.launch(standIn, { dryRun: true }) : null, r2 = own ? await LI.launch(own, { dryRun: true }) : null;
      ok(r1 && /would open Mantle's player window/.test(r1.reason), 'launcher: the stand-in row (it keeps the Store aumid) opens MANTLE Player, not Media Player', r1);
      ok(r2 && /shell:AppsFolder\\Microsoft\.ZuneMusic/.test(r2.reason), 'launcher: Windows\' own row still opens Media Player', r2);
    } finally { G.store = was; }
  }
  const reg2 = fakeReg(seed); rec = null;
  reg2.failOn = (k) => k.includes('.flac');
  u = await A.use(Object.assign({}, o0, { reg: reg2, record }));
  ok(!u.ok && /Access is denied/.test(u.reason) && /taken out again/.test(u.reason) && reg2.dump() === before, 'assoc: a refusal midway is rolled back, the registry as before, and said in words', u.reason);
})().catch((e) => ok(false, 'the async part ran', e && e.stack)).then(() => {
  for (const f of fails) console.log('FAIL ' + f);
  console.log(`PLAYER TEST: ${passed} passed, ${fails.length} failed`);
  process.exit(fails.length ? 1 : 0);
});
