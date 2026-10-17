'use strict';
/*
 * _player-probe.js - Mantle Player's format knowledge (lane mantle-player, 2026-10-17). PURE: bytes in,
 * answers out. Loaded by main (lib/features/player.js) AND by the page (ui/player/index.html loads this
 * file as a script: window.MantlePlayerProbe), so both sides name a codec the same way.
 *
 *   kindOf(path)            'video' | 'audio' | 'subtitle' | null, by extension
 *   probe(head, tail, size) what the file IS, from its first bytes (and its last, for an MP4 whose index
 *                           sits at the end): { container, label, tracks: [{ type, codec, label }], duration }
 *   verdict(p, can)         can Mantle Player play it? `can(codec)` is the page's question to Chromium
 *                           (canPlayType); { state: 'play' | 'partial' | 'no', reason, way }
 *   srtToVtt(text)          SubRip -> WebVTT
 *   subLabel(base, file)    "English" / "Subtitles" for a sidecar subtitle file next to the video
 *   natural(a, b)           "Episode 2" before "Episode 10"
 *
 * NEVER A SILENT FAILURE (Owen, 2026-09-12): a file that cannot play says which container and which codec,
 * in plain words, and a way out. Formats census 2026-10-17 (read-only, counts only): Videos 16 mp4 (5 of them
 * Game Bar captures), Music empty, Downloads 26 mp4 / 26 webm / 3 ogg / 3 mov / 2 mp3 (+148 .ts that are
 * TypeScript sources, not video: a .ts is only a video when its bytes say MPEG-TS).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MantlePlayerProbe = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  const VIDEO_EXT = ['mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'wmv', 'asf', 'flv', 'mpg', 'mpeg', 'm2ts', 'mts', 'ts', '3gp', 'ogv', 'vob', 'divx', 'rm', 'rmvb'];
  const AUDIO_EXT = ['mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'oga', 'opus', 'wma', 'aiff', 'aif', 'ape', 'mka', 'ac3', 'dts', 'amr', 'mid', 'midi', 'weba'];
  const SUB_EXT = ['srt', 'vtt'];
  const LIB_SKIP = new Set(['ts']);   // never listed by a library scan (TypeScript sources share the extension)

  function extOf(p) { const m = /\.([a-z0-9]{1,5})$/i.exec(String(p || '')); return m ? m[1].toLowerCase() : ''; }
  function kindOf(p) {
    const e = extOf(p);
    if (VIDEO_EXT.includes(e)) return 'video';
    if (AUDIO_EXT.includes(e)) return 'audio';
    if (SUB_EXT.includes(e)) return 'subtitle';
    return null;
  }

  /* ---- codecs: one id each, a plain label, and the question Chromium answers for it ------------ */
  const CODECS = {
    h264: { label: 'H.264', mime: 'video/mp4; codecs="avc1.42E01E"' },
    hevc: { label: 'HEVC (H.265)', mime: 'video/mp4; codecs="hvc1.1.6.L93.B0"', how: 'HEVC plays only where Windows can decode it: install "HEVC Video Extensions" from the Microsoft Store, or use a PC whose graphics chip decodes HEVC' },
    av1: { label: 'AV1', mime: 'video/mp4; codecs="av01.0.05M.08"' },
    vp9: { label: 'VP9', mime: 'video/webm; codecs="vp9"' },
    vp8: { label: 'VP8', mime: 'video/webm; codecs="vp8"' },
    theora: { label: 'Theora', mime: 'video/ogg; codecs="theora"' },
    mpeg4: { label: 'MPEG-4 Part 2 (DivX/Xvid)', mime: 'video/mp4; codecs="mp4v.20.9"' },
    mpeg2: { label: 'MPEG-2 video', mime: null },
    mpeg1: { label: 'MPEG-1 video', mime: null },
    mjpeg: { label: 'Motion JPEG', mime: null },
    wmv: { label: 'Windows Media Video', mime: null },
    vc1: { label: 'VC-1', mime: null },
    prores: { label: 'Apple ProRes', mime: null },
    realvideo: { label: 'RealVideo', mime: null },
    aac: { label: 'AAC', mime: 'audio/mp4; codecs="mp4a.40.2"' },
    mp3: { label: 'MP3', mime: 'audio/mpeg' },
    mp2: { label: 'MPEG audio layer 2', mime: null },
    opus: { label: 'Opus', mime: 'audio/webm; codecs="opus"' },
    vorbis: { label: 'Vorbis', mime: 'audio/webm; codecs="vorbis"' },
    flac: { label: 'FLAC', mime: 'audio/flac' },
    pcm: { label: 'PCM', mime: 'audio/wav; codecs="1"' },
    alac: { label: 'Apple Lossless (ALAC)', mime: 'audio/mp4; codecs="alac"' },
    ac3: { label: 'Dolby Digital (AC-3)', mime: 'audio/mp4; codecs="ac-3"' },
    eac3: { label: 'Dolby Digital Plus (E-AC-3)', mime: 'audio/mp4; codecs="ec-3"' },
    dts: { label: 'DTS', mime: null },
    truehd: { label: 'Dolby TrueHD', mime: null },
    wma: { label: 'Windows Media Audio', mime: null },
    adpcm: { label: 'ADPCM', mime: null },
    amr: { label: 'AMR', mime: null },
    ape: { label: "Monkey's Audio (APE)", mime: null },
    midi: { label: 'MIDI', mime: null },
    realaudio: { label: 'RealAudio', mime: null },
    srt: { label: 'SRT text', mime: null }, ass: { label: 'SSA/ASS text', mime: null }, webvtt: { label: 'WebVTT', mime: null },
    pgs: { label: 'Blu-ray picture subtitles (PGS)', mime: null }, vobsub: { label: 'DVD picture subtitles (VobSub)', mime: null }, movtext: { label: 'MP4 text', mime: null },
  };
  const label = (codec, raw) => (CODECS[codec] ? CODECS[codec].label : raw ? 'an unknown codec (' + raw + ')' : 'an unknown codec');

  /* Containers Chromium reads for a plain <video src> (its demuxer allow-list), and the ones it never does. */
  const CONTAINERS = {
    mp4: { label: 'MP4', native: true }, mov: { label: 'QuickTime (MOV)', native: true }, webm: { label: 'WebM', native: true },
    mkv: { label: 'Matroska (MKV)', native: true }, ogg: { label: 'Ogg', native: true }, mp3: { label: 'MP3', native: true },
    flac: { label: 'FLAC', native: true }, wav: { label: 'WAV', native: true }, adts: { label: 'AAC', native: true },
    avi: { label: 'AVI', native: false }, asf: { label: 'Windows Media (ASF)', native: false }, mpegts: { label: 'MPEG transport stream', native: false },
    mpegps: { label: 'MPEG program stream (DVD/MPG)', native: false }, flv: { label: 'Flash video (FLV)', native: false }, rm: { label: 'RealMedia', native: false },
    aiff: { label: 'AIFF', native: false }, ac3: { label: 'raw Dolby Digital', native: false }, dts: { label: 'raw DTS', native: false },
    ape: { label: "Monkey's Audio", native: false }, midi: { label: 'MIDI', native: false }, amr: { label: 'AMR', native: false },
    unknown: { label: 'an unknown format', native: null },
  };

  /* ---- byte helpers (Uint8Array in the page, Buffer in main: both index the same) ---------------- */
  const u8 = (b) => (b ? (b instanceof Uint8Array ? b : new Uint8Array(b)) : new Uint8Array(0));
  const be32 = (b, i) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
  const be16 = (b, i) => (b[i] << 8) + b[i + 1];
  const le32 = (b, i) => (b[i] + (b[i + 1] << 8) + (b[i + 2] << 16) + ((b[i + 3] << 24) >>> 0));
  const le16 = (b, i) => b[i] + (b[i + 1] << 8);
  const str = (b, i, n) => { let s = ''; for (let k = 0; k < n && i + k < b.length; k++) s += String.fromCharCode(b[i + k]); return s; };
  function find(b, s, from, to) {
    const end = Math.min(b.length - s.length, to === undefined ? b.length : to);
    outer: for (let i = from || 0; i <= end; i++) { for (let k = 0; k < s.length; k++) if (b[i + k] !== s.charCodeAt(k)) continue outer; return i; }
    return -1;
  }

  /* ---- MP4 / MOV: moov > trak > mdia > (hdlr, minf > stbl > stsd) --------------------------------- */
  function boxes(b, start, end, fn) {
    let i = start;
    while (i + 8 <= end) {
      let size = be32(b, i); const type = str(b, i + 4, 4); let hdr = 8;
      if (size === 1) { if (i + 16 > end) return; size = be32(b, i + 8) * 4294967296 + be32(b, i + 12); hdr = 16; } else if (size === 0) size = end - i;
      if (size < hdr) return;
      if (fn(type, i + hdr, Math.min(end, i + size), i) === false) return;
      i += size;
    }
  }
  function esdsObject(b, s, e) {
    // ES_Descriptor (0x03) -> DecoderConfigDescriptor (0x04): its first byte is the objectTypeIndication
    let i = s + 4;                                                                // version + flags
    const desc = () => { const tag = b[i++]; let len = 0; for (let k = 0; k < 4; k++) { const c = b[i++]; len = (len << 7) | (c & 0x7f); if (!(c & 0x80)) break; } return { tag, len }; };
    if (i >= e) return null;
    let d = desc();
    if (d.tag === 0x03) { i += 2; const fl = b[i++]; if (fl & 0x80) i += 2; if (fl & 0x40) i += 1 + b[i]; if (fl & 0x20) i += 2; d = desc(); }
    return d.tag === 0x04 && i < e ? b[i] : null;
  }
  const MP4_V = { avc1: 'h264', avc3: 'h264', hvc1: 'hevc', hev1: 'hevc', av01: 'av1', vp09: 'vp9', vp08: 'vp8', mp4v: 'mpeg4', 'mjpa': 'mjpeg', jpeg: 'mjpeg', apch: 'prores', apcn: 'prores', apcs: 'prores', apco: 'prores', ap4h: 'prores', mp2v: 'mpeg2' };
  const MP4_A = { 'ac-3': 'ac3', 'ec-3': 'eac3', opus: 'opus', Opus: 'opus', fLaC: 'flac', alac: 'alac', '.mp3': 'mp3', lpcm: 'pcm', sowt: 'pcm', twos: 'pcm', dtsc: 'dts', dtsh: 'dts', dtsl: 'dts', samr: 'amr', ulaw: 'pcm', alaw: 'pcm' };
  function mp4Moov(b, s, e, out) {
    boxes(b, s, e, (t, cs, ce) => {
      if (t === 'mvhd') { const v = b[cs]; const ts = v === 1 ? be32(b, cs + 20) : be32(b, cs + 12); const du = v === 1 ? be32(b, cs + 24) * 4294967296 + be32(b, cs + 28) : be32(b, cs + 16); if (ts) out.duration = du / ts; }
      if (t !== 'trak') return;
      let handler = null, fmt = null, entry = null;
      const walk = (a, z) => boxes(b, a, z, (t2, s2, e2) => {
        if (t2 === 'mdia' || t2 === 'minf' || t2 === 'stbl') walk(s2, e2);
        else if (t2 === 'hdlr') handler = str(b, s2 + 8, 4);
        else if (t2 === 'stsd' && e2 - s2 >= 16) { fmt = str(b, s2 + 12, 4); entry = [s2 + 8, Math.min(e2, s2 + 8 + be32(b, s2 + 8))]; }
      });
      walk(cs, ce);
      if (!fmt) return;
      if (handler === 'vide') out.tracks.push({ type: 'video', codec: MP4_V[fmt] || null, raw: fmt });
      else if (handler === 'soun') {
        let codec = MP4_A[fmt] || null;
        if (fmt === 'mp4a' && entry) { const at = find(b, 'esds', entry[0], entry[1]); const ot = at > 0 ? esdsObject(b, at + 4, entry[1]) : null; codec = ot === 0x6b || ot === 0x69 ? 'mp3' : ot === 0xa5 ? 'ac3' : ot === 0xa6 ? 'eac3' : ot === 0xa9 ? 'dts' : 'aac'; }
        out.tracks.push({ type: 'audio', codec, raw: fmt });
      } else if (handler === 'sbtl' || handler === 'text' || handler === 'subt') out.tracks.push({ type: 'text', codec: fmt === 'tx3g' ? 'movtext' : fmt === 'wvtt' ? 'webvtt' : null, raw: fmt });
    });
  }
  function probeMp4(h, tail, out) {
    let moov = false;
    boxes(h, 0, h.length, (t, s, e, at) => {
      if (t === 'ftyp') { const brand = str(h, s, 4); if (brand === 'qt  ') { out.container = 'mov'; } }
      if (t === 'moov') { moov = true; mp4Moov(h, s, e, out); return false; }
      return undefined;
    });
    if (!moov && tail && tail.length) {
      // the index at the end of the file: find "moov" whose size fits what we read
      for (let i = tail.length - 8; i >= 4; i--) {
        if (tail[i] === 0x6d && str(tail, i, 4) === 'moov') { const size = be32(tail, i - 4); if (size >= 8 && i - 4 + size <= tail.length + 8) { moov = true; mp4Moov(tail, i + 4, Math.min(tail.length, i - 4 + size), out); break; } }
      }
    }
    if (!moov) out.note = 'its index (moov) was not in the parts read';
  }

  /* ---- Matroska / WebM: the CodecID strings name every track ------------------------------------- */
  const MKV = [
    [/^V_MPEG4\/ISO\/AVC/, 'h264'], [/^V_MPEGH\/ISO\/HEVC/, 'hevc'], [/^V_AV1/, 'av1'], [/^V_VP9/, 'vp9'], [/^V_VP8/, 'vp8'], [/^V_THEORA/, 'theora'],
    [/^V_MPEG4\/ISO\//, 'mpeg4'], [/^V_MPEG2/, 'mpeg2'], [/^V_MPEG1/, 'mpeg1'], [/^V_MS\/VFW/, null], [/^V_REAL/, 'realvideo'], [/^V_MJPEG/, 'mjpeg'], [/^V_PRORES/, 'prores'],
    [/^A_AAC/, 'aac'], [/^A_MPEG\/L3/, 'mp3'], [/^A_MPEG\/L2/, 'mp2'], [/^A_OPUS/, 'opus'], [/^A_VORBIS/, 'vorbis'], [/^A_FLAC/, 'flac'], [/^A_PCM/, 'pcm'],
    [/^A_EAC3/, 'eac3'], [/^A_AC3/, 'ac3'], [/^A_DTS/, 'dts'], [/^A_TRUEHD/, 'truehd'], [/^A_ALAC/, 'alac'], [/^A_REAL/, 'realaudio'], [/^A_MS\/ACM/, null],
    [/^S_TEXT\/UTF8/, 'srt'], [/^S_TEXT\/(ASS|SSA)/, 'ass'], [/^S_(TEXT\/)?(ASS|SSA)/, 'ass'], [/^S_TEXT\/WEBVTT/, 'webvtt'], [/^D_WEBVTT/, 'webvtt'], [/^S_HDMV\/PGS/, 'pgs'], [/^S_VOBSUB/, 'vobsub'],
  ];
  function probeMkv(h, out) {
    const dt = find(h, '\x42\x82', 0, 64);
    if (dt >= 0) { const n = h[dt + 2] & 0x7f; if (str(h, dt + 3, n) === 'webm') out.container = 'webm'; }
    for (let i = 0; i < h.length - 4; i++) {
      if (h[i] !== 0x86) continue;
      const sz = h[i + 1]; if (!(sz & 0x80)) continue;            // one-byte size: every CodecID is short
      const n = sz & 0x7f; if (n < 3 || n > 40) continue;
      const id = str(h, i + 2, n).replace(/\0+$/, '');
      if (!/^[VASD]_[A-Z0-9/._-]+$/.test(id)) continue;
      const hit = MKV.find(([re]) => re.test(id));
      const type = id[0] === 'V' ? 'video' : id[0] === 'A' ? 'audio' : 'text';
      out.tracks.push({ type, codec: hit ? hit[1] : null, raw: id });
      i += n + 1;
    }
    if (!out.tracks.length) out.note = 'its track list was not in the part read';
  }

  /* ---- AVI: strh (stream type + handler) then strf (the format) ---------------------------------- */
  const WAVE_TAG = { 0x1: 'pcm', 0x3: 'pcm', 0x2: 'adpcm', 0x11: 'adpcm', 0x50: 'mp2', 0x55: 'mp3', 0xff: 'aac', 0x1610: 'aac', 0x2000: 'ac3', 0x2001: 'dts', 0x161: 'wma', 0x162: 'wma', 0x163: 'wma', 0xfffe: 'pcm', 0x674f: 'vorbis', 0xf1ac: 'flac' };
  const FOURCC_V = { XVID: 'mpeg4', DIVX: 'mpeg4', DX50: 'mpeg4', FMP4: 'mpeg4', MP4V: 'mpeg4', H264: 'h264', X264: 'h264', AVC1: 'h264', HEVC: 'hevc', H265: 'hevc', MJPG: 'mjpeg', WMV3: 'wmv', WMV2: 'wmv', WMV1: 'wmv', WVC1: 'vc1', MPG2: 'mpeg2', VP80: 'vp8', VP90: 'vp9', AV01: 'av1' };
  function probeAvi(h, out) {
    let i = 0;
    while ((i = find(h, 'strh', i)) >= 0) {
      const type = str(h, i + 8, 4), handler = str(h, i + 12, 4);
      const f = find(h, 'strf', i + 8, i + 400);
      if (type === 'vids') {
        const cc = f >= 0 ? str(h, f + 8 + 16, 4) : handler;
        const k = (cc.trim() || handler.trim()).toUpperCase();
        out.tracks.push({ type: 'video', codec: FOURCC_V[k] || null, raw: k || '?' });
      } else if (type === 'auds') {
        const tag = f >= 0 ? le16(h, f + 8) : -1;
        out.tracks.push({ type: 'audio', codec: WAVE_TAG[tag] || null, raw: tag >= 0 ? '0x' + tag.toString(16) : '?' });
      }
      i += 4;
    }
  }

  /* ---- ASF (WMV / WMA): stream properties objects ------------------------------------------------ */
  const ASF_HEAD = [0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6, 0xd9, 0x00, 0xaa, 0x00, 0x62, 0xce, 0x6c];
  const ASF_SPO = [0x91, 0x07, 0xdc, 0xb7, 0xb7, 0xa9, 0xcf, 0x11, 0x8e, 0xe6, 0x00, 0xc0, 0x0c, 0x20, 0x53, 0x65];
  const ASF_AUD = 0x409e69f8, ASF_VID = 0xbc19efc0;
  function probeAsf(h, out) {
    for (let i = 16; i < h.length - 110; i++) {
      if (h[i] !== ASF_SPO[0] || !ASF_SPO.every((v, k) => h[i + k] === v)) continue;
      const st = le32(h, i + 24);
      if (st === ASF_AUD) { const tag = le16(h, i + 78); out.tracks.push({ type: 'audio', codec: WAVE_TAG[tag] || 'wma', raw: '0x' + tag.toString(16) }); }
      else if (st === ASF_VID) { const cc = str(h, i + 78 + 11 + 16, 4).toUpperCase(); out.tracks.push({ type: 'video', codec: FOURCC_V[cc] || 'wmv', raw: cc }); }
    }
  }

  /* ---- Ogg: every stream's first packet says its codec ------------------------------------------- */
  function probeOgg(h, out) {
    let i = 0;
    while (i + 27 < h.length && str(h, i, 4) === 'OggS') {
      const segs = h[i + 26]; let len = 0; for (let k = 0; k < segs; k++) len += h[i + 27 + k];
      const p = i + 27 + segs;
      if (h[i + 5] & 0x02) {                                                     // beginning of a stream
        const sig = str(h, p, 8);
        const t = sig.startsWith('\x01vorbis') ? ['audio', 'vorbis'] : sig.startsWith('OpusHead') ? ['audio', 'opus'] : sig.startsWith('\x7fFLAC') ? ['audio', 'flac']
          : sig.startsWith('\x80theora') ? ['video', 'theora'] : sig.startsWith('Speex') ? ['audio', null] : null;
        if (t) out.tracks.push({ type: t[0], codec: t[1], raw: sig.replace(/[^\x20-\x7e]/g, '') });
      }
      i = p + len;
    }
  }

  function probeWav(h, out) {
    const f = find(h, 'fmt ', 12, 4096);
    const tag = f >= 0 ? le16(h, f + 8) : -1;
    out.tracks.push({ type: 'audio', codec: WAVE_TAG[tag] || null, raw: tag >= 0 ? '0x' + tag.toString(16) : '?' });
    if (f >= 0) { const rate = le32(h, f + 12), bps = le32(h, f + 16); const d = find(h, 'data', f, 8192); if (d >= 0 && bps) out.duration = le32(h, d + 4) / bps; void rate; }
  }

  function probe(headIn, tailIn, size) {
    const h = u8(headIn), tail = u8(tailIn);
    const out = { container: 'unknown', tracks: [], duration: null, size: size || null, note: null };
    const s4 = str(h, 0, 4), s8 = str(h, 4, 4);
    if (h.length < 4) { out.note = 'the file is empty or too short to be media'; }
    else if (s8 === 'ftyp' || s8 === 'moov' || s8 === 'mdat' || s8 === 'free' || s8 === 'wide' || s8 === 'skip') { out.container = 'mp4'; probeMp4(h, tail, out); }
    else if (h[0] === 0x1a && h[1] === 0x45 && h[2] === 0xdf && h[3] === 0xa3) { out.container = 'mkv'; probeMkv(h, out); }
    else if (s4 === 'RIFF' && s8 && str(h, 8, 4) === 'AVI ') { out.container = 'avi'; probeAvi(h, out); }
    else if (s4 === 'RIFF' && str(h, 8, 4) === 'WAVE') { out.container = 'wav'; probeWav(h, out); }
    else if (ASF_HEAD.every((v, k) => h[k] === v)) { out.container = 'asf'; probeAsf(h, out); }
    else if (s4 === 'OggS') { out.container = 'ogg'; probeOgg(h, out); }
    else if (s4 === 'fLaC') { out.container = 'flac'; out.tracks.push({ type: 'audio', codec: 'flac', raw: 'fLaC' }); }
    else if (str(h, 0, 3) === 'ID3' || (h[0] === 0xff && (h[1] & 0xe6) === 0xe2)) {
      // ID3 then MPEG audio frames; an ID3 tag in front of ADTS AAC is rare but real
      let at = 0; if (str(h, 0, 3) === 'ID3') at = 10 + ((h[6] & 0x7f) << 21 | (h[7] & 0x7f) << 14 | (h[8] & 0x7f) << 7 | (h[9] & 0x7f));
      const adts = at < h.length - 1 && h[at] === 0xff && (h[at + 1] & 0xf6) === 0xf0;
      out.container = adts ? 'adts' : 'mp3'; out.tracks.push({ type: 'audio', codec: adts ? 'aac' : 'mp3', raw: adts ? 'ADTS' : 'MPEG audio' });
    }
    else if (h[0] === 0xff && (h[1] & 0xf6) === 0xf0) { out.container = 'adts'; out.tracks.push({ type: 'audio', codec: 'aac', raw: 'ADTS' }); }
    else if (h[0] === 0x47 && h[188] === 0x47 && (h.length < 377 || h[376] === 0x47)) { out.container = 'mpegts'; }
    else if (h[0] === 0 && h[1] === 0 && h[2] === 1 && (h[3] === 0xba || h[3] === 0xb3)) { out.container = 'mpegps'; out.tracks.push({ type: 'video', codec: 'mpeg2', raw: 'MPEG-PS' }); }
    else if (str(h, 0, 3) === 'FLV') { out.container = 'flv'; }
    else if (s4 === '.RMF') { out.container = 'rm'; }
    else if (s4 === 'FORM' && /^AIF[FC]$/.test(str(h, 8, 4))) { out.container = 'aiff'; out.tracks.push({ type: 'audio', codec: 'pcm', raw: 'AIFF' }); }
    else if (h[0] === 0x0b && h[1] === 0x77) { out.container = 'ac3'; out.tracks.push({ type: 'audio', codec: 'ac3', raw: 'AC-3' }); }
    else if (h[0] === 0x7f && h[1] === 0xfe && h[2] === 0x80 && h[3] === 0x01) { out.container = 'dts'; out.tracks.push({ type: 'audio', codec: 'dts', raw: 'DTS' }); }
    else if (s4 === 'MAC ') { out.container = 'ape'; out.tracks.push({ type: 'audio', codec: 'ape', raw: 'APE' }); }
    else if (s4 === 'MThd') { out.container = 'midi'; out.tracks.push({ type: 'audio', codec: 'midi', raw: 'MIDI' }); }
    else if (str(h, 0, 5) === '#!AMR') { out.container = 'amr'; out.tracks.push({ type: 'audio', codec: 'amr', raw: 'AMR' }); }
    for (const t of out.tracks) t.label = label(t.codec, t.raw);
    out.label = (CONTAINERS[out.container] || CONTAINERS.unknown).label;
    return out;
  }

  /**
   * Can it play? `can(codecId)` -> true | false | null (null = not asked). Pure; the page passes a canPlayType
   * check, the tests a table. 'partial' = the picture plays and a sound track cannot (said, never hidden).
   */
  function verdict(p, can) {
    const c = CONTAINERS[p && p.container] || CONTAINERS.unknown;
    const tr = (p && p.tracks) || [];
    const vids = tr.filter((t) => t.type === 'video'), auds = tr.filter((t) => t.type === 'audio'), texts = tr.filter((t) => t.type === 'text');
    const ok = (t) => (t.codec && CODECS[t.codec] && CODECS[t.codec].mime ? can(t.codec) !== false : false);
    const names = (ts) => ts.map((t) => t.label).filter((x, i, a) => a.indexOf(x) === i).join(' and ');
    const inside = tr.length ? ' (inside: ' + names(tr.filter((t) => t.type !== 'text')) + ')' : '';
    const way = 'Open it with another app, or skip to the next item';
    if (c.native === false) return { state: 'no', reason: 'Mantle Player can\'t open ' + c.label + ' files' + inside, way };
    if (p && p.container === 'unknown') return { state: 'try', reason: null, way: null };
    const badV = vids.filter((t) => !ok(t)), goodV = vids.filter(ok);
    const badA = auds.filter((t) => !ok(t)), goodA = auds.filter(ok);
    const how = (ts) => { const h = ts.map((t) => CODECS[t.codec] && CODECS[t.codec].how).find(Boolean); return h ? '. ' + h : ''; };
    if (vids.length && !goodV.length) return { state: 'no', reason: 'This PC can\'t decode its video: ' + names(badV) + how(badV), way };
    if (!vids.length && auds.length && !goodA.length) return { state: 'no', reason: 'Mantle Player can\'t decode its sound: ' + names(badA), way };
    const notes = [];
    if (auds.length && !goodA.length) notes.push('No sound: its audio is ' + names(badA) + ', which Mantle Player can\'t decode');
    else if (badA.length) notes.push(badA.length + ' of its sound tracks (' + names(badA) + ') can\'t play');
    const textNo = texts.filter((t) => t.codec !== 'webvtt');
    if (textNo.length) notes.push('Its built-in subtitles (' + names(textNo) + ') can\'t be shown yet; a .srt or .vtt file with the same name can');
    return { state: notes.length && auds.length && !goodA.length ? 'partial' : 'play', reason: notes.join('. ') || null, way: notes.length ? null : null };
  }

  /** A media error from Chromium, in words, with what the probe saw. */
  function errorWords(code, message, p) {
    const c = p ? (CONTAINERS[p.container] || CONTAINERS.unknown).label : 'this file';
    const tr = p && p.tracks && p.tracks.length ? ' (' + p.tracks.filter((t) => t.type !== 'text').map((t) => t.label).join(', ') + ')' : '';
    const m = String(message || '');
    if (code === 2) return 'The file could not be read to the end (it may be on a drive that went away)';
    if (code === 3 || /DECODE/i.test(m)) return 'Part of this ' + c + ' file is damaged or uses a variant this PC can\'t decode' + tr;
    if (code === 4 || /NO_SUPPORTED_STREAMS|DEMUXER|FORMAT/i.test(m)) return p && p.container === 'unknown' ? 'This isn\'t a video or music format Mantle Player knows' + (p.note ? ' (' + p.note + ')' : '') : 'Mantle Player can\'t play this ' + c + ' file' + tr;
    return 'It stopped with an error' + (m ? ': ' + m.replace(/[A-Z_]{6,}: ?/g, '').slice(0, 120) : '');
  }

  /* ---- subtitles ---------------------------------------------------------------------------------- */
  function srtToVtt(text) {
    const t = String(text || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    if (/^WEBVTT/.test(t)) return t;
    const body = t.replace(/(\d{1,2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2').replace(/^\s*\d+\s*\n(?=\d{1,2}:\d{2}:\d{2}\.\d{3}\s*-->)/gm, '');
    return 'WEBVTT\n\n' + body.trim() + '\n';
  }
  const LANGS = { en: 'English', eng: 'English', fr: 'French', fre: 'French', fra: 'French', es: 'Spanish', spa: 'Spanish', de: 'German', ger: 'German', deu: 'German', it: 'Italian', ita: 'Italian', pt: 'Portuguese', por: 'Portuguese', ja: 'Japanese', jpn: 'Japanese', ko: 'Korean', kor: 'Korean', zh: 'Chinese', chi: 'Chinese', zho: 'Chinese', ru: 'Russian', rus: 'Russian', nl: 'Dutch', sv: 'Swedish', pl: 'Polish', ar: 'Arabic', hi: 'Hindi' };
  /** base = the video's name without extension; file = the subtitle's name. -> { lang, label } or null when it is not this video's. */
  function subLabel(base, file) {
    const b = String(base).toLowerCase(), f = String(file).toLowerCase();
    const m = /^(.*)\.(srt|vtt)$/.exec(f); if (!m) return null;
    if (m[1] === b) return { lang: null, label: 'Subtitles' };
    if (!m[1].startsWith(b + '.')) return null;
    const parts = m[1].slice(b.length + 1).split('.');
    const code = parts.find((x) => LANGS[x]) || null;
    const extra = parts.filter((x) => x !== code).map((x) => (x === 'forced' ? 'forced' : x === 'sdh' || x === 'cc' ? 'SDH' : x)).join(' ');
    return { lang: code, label: (code ? LANGS[code] : 'Subtitles') + (extra ? ' (' + extra + ')' : '') };
  }

  function natural(a, b) {
    const x = String(a).toLowerCase(), y = String(b).toLowerCase();
    const rx = /(\d+)|(\D+)/g; const xa = x.match(rx) || [], ya = y.match(rx) || [];
    for (let i = 0; i < Math.min(xa.length, ya.length); i++) {
      const p = xa[i], q = ya[i];
      if (p === q) continue;
      const pn = /^\d/.test(p), qn = /^\d/.test(q);
      if (pn && qn) { const d = Number(p) - Number(q); if (d) return d; continue; }
      return p < q ? -1 : 1;
    }
    return xa.length - ya.length;
  }

  function clock(sec) {
    if (!(sec >= 0) || !isFinite(sec)) return '--:--';
    const s = Math.floor(sec % 60), m = Math.floor(sec / 60) % 60, h = Math.floor(sec / 3600);
    return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(s).padStart(2, '0');
  }

  return { VIDEO_EXT, AUDIO_EXT, SUB_EXT, LIB_SKIP, CODECS, CONTAINERS, extOf, kindOf, probe, verdict, errorWords, srtToVtt, subLabel, natural, clock, label };
}));
