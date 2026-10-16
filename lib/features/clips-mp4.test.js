'use strict';
/* clips-mp4.test.js - the LOSSLESS trim on synthetic MP4s in the layouts real encoders write (lane
 * mantle-clips2, 2026-10-15). clips.test.js proves one layout (mdat first, one sample per chunk, stco);
 * this one varies what Game Bar, OBS, phones and Windows' own encoder do:
 *   moov first ("fast start"), several samples per chunk (stsc runs), 64-bit chunk offsets (co64),
 *   B-frames (ctts), cuts at the very start / to the very end / past the end, a trim of a trim, and the
 *   refusals (an empty part, a part between two frames). Every sample's bytes say which track and sample
 *   it is, so each cut is checked byte for byte. No Electron, no sidecar, nothing of Owen's.
 *   node lib/features/clips-mp4.test.js   -> "CLIPS MP4: n passed, m failed"
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const M = require('./_clips-mp4');
const { _box: box, _full: full, _u32s: u32s } = M;

let passed = 0; const failed = [];
function check(name, ok, detail) { if (ok) passed++; else failed.push(`${name}${detail !== undefined ? ` (${typeof detail === 'string' ? detail : JSON.stringify(detail)})` : ''}`); return ok; }
function sampleBytes(track, i, len) { const b = Buffer.alloc(len); for (let k = 0; k < len; k++) b[k] = (track * 101 + i * 7 + k) & 255; b.writeUInt16BE(i, 0); b[2] = track; return b; }

/* o: {moovFirst, co64, perChunk (video samples per chunk), ctts, vN, key} */
function makeMovie(file, o) {
  const V = { n: o.vN || 240, ts: 90000, d: 3000, key: o.key || 30 }, A = { n: Math.floor((o.vN || 240) / 30 * 48000 / 1024), ts: 48000, d: 1024 };
  const per = o.perChunk || 1, aPer = o.perChunk ? 4 : 1;
  const vs = [], as = [];
  for (let i = 0; i < V.n; i++) vs.push(sampleBytes(1, i, 180 + (i % V.key === 0 ? 700 : i % 13)));
  for (let i = 0; i < A.n; i++) as.push(sampleBytes(2, i, 50 + (i % 7)));
  // chunks interleaved: per video samples, then aPer audio samples, until both run out
  const order = [];
  let vi = 0, ai = 0;
  while (vi < V.n || ai < A.n) {
    if (vi < V.n) { const c = []; for (let k = 0; k < per && vi < V.n; k++) c.push(vi++); order.push(['v', c]); }
    if (ai < A.n) { const c = []; for (let k = 0; k < aPer && ai < A.n; k++) c.push(ai++); order.push(['a', c]); }
  }
  const ftyp = box('ftyp', Buffer.from('isom\0\0\x02\0isomavc1mp41', 'latin1'));
  const hdlr = (t) => full('hdlr', 0, 0, u32s([0]), Buffer.from(t, 'latin1'), Buffer.alloc(12), Buffer.from('x\0', 'latin1'));
  const mdhd = (ts, dur) => full('mdhd', 0, 0, u32s([0, 0, ts, dur]), Buffer.from([0x55, 0xc4, 0, 0]));
  const tkhd = (id, dur, w, h) => { const b = Buffer.alloc(80); b.writeUInt32BE(id, 8); b.writeUInt32BE(dur, 16); b.writeUInt32BE(w * 65536, 72); b.writeUInt32BE(h * 65536, 76); return full('tkhd', 0, 3, b); };
  const offBox = (offs) => {
    if (!o.co64) return full('stco', 0, 0, u32s([offs.length, ...offs]));
    const b = Buffer.alloc(4 + 8 * offs.length); b.writeUInt32BE(offs.length, 0); offs.forEach((x, i) => b.writeBigUInt64BE(BigInt(x), 4 + 8 * i)); return full('co64', 0, 0, b);
  };
  const stsc = (chunks) => { const runs = []; chunks.forEach((c, i) => { const l = runs[runs.length - 1]; if (!l || l[1] !== c.length) runs.push([i + 1, c.length, 1]); }); return full('stsc', 0, 0, u32s([runs.length, ...[].concat(...runs)])); };
  const ctts = () => { const b = []; for (let i = 0; i < V.n; i++) b.push(1, i % V.key === 0 ? 0 : (i % 3) * V.d); return full('ctts', 0, 0, u32s([V.n, ...b])); };
  function build(dataAt) {
    const vOff = [], aOff = [], vCh = [], aCh = [];
    let p = dataAt;
    for (const [k, c] of order) {
      if (k === 'v') { vOff.push(p); vCh.push(c); for (const i of c) p += vs[i].length; } else { aOff.push(p); aCh.push(c); for (const i of c) p += as[i].length; }
    }
    const sync = []; for (let i = 0; i < V.n; i += V.key) sync.push(i + 1);
    const stbl = (sizes, offs, chunks, d, syncs, withCtts) => box('stbl', full('stsd', 0, 0, u32s([0])), full('stts', 0, 0, u32s([1, sizes.length, d])),
      ...(withCtts ? [ctts()] : []), ...(syncs ? [full('stss', 0, 0, u32s([syncs.length, ...syncs]))] : []), stsc(chunks), full('stsz', 0, 0, u32s([0, sizes.length, ...sizes])), offBox(offs));
    const trak = (id, ts, n, d, h, sizes, offs, chunks, syncs, withCtts, w, hh) => box('trak', tkhd(id, Math.round(n * d / ts * 1000), w, hh),
      box('mdia', mdhd(ts, n * d), hdlr(h), box('minf', full(h === 'vide' ? 'vmhd' : 'smhd', 0, 1, Buffer.alloc(h === 'vide' ? 8 : 4)), stbl(sizes, offs, chunks, d, syncs, withCtts))));
    return box('moov', full('mvhd', 0, 0, u32s([0, 0, 1000, Math.round(V.n * V.d / V.ts * 1000)]), Buffer.alloc(80)),
      trak(1, V.ts, V.n, V.d, 'vide', vs.map((b) => b.length), vOff, vCh, sync, !!o.ctts, 1280, 720),
      trak(2, A.ts, A.n, A.d, 'soun', as.map((b) => b.length), aOff, aCh, null, false, 0, 0));
  }
  const body = Buffer.concat(order.map(([k, c]) => Buffer.concat(c.map((i) => (k === 'v' ? vs[i] : as[i])))));
  let out;
  if (o.moovFirst) {
    const size0 = build(0).length;                      // the moov's size does not depend on the offsets
    const moov = build(ftyp.length + size0 + 8);
    out = Buffer.concat([ftyp, moov, box('mdat', body)]);
  } else {
    const moov = build(ftyp.length + 8);
    out = Buffer.concat([ftyp, box('mdat', body), moov]);
  }
  fs.writeFileSync(file, out);
  return { vs, as, V, A };
}

async function bytesOf(file, t, i) { const fd = fs.openSync(file, 'r'); try { const b = Buffer.alloc(t.s.size[i]); fs.readSync(fd, b, 0, b.length, t.s.offset[i]); return b; } finally { fs.closeSync(fd); } }
async function sameFrames(dst, src, firstV, label) {
  const mv = await M.readMovie(dst);
  const v = mv.tracks.find((t) => t.handler === 'vide');
  let same = v.s.n > 0;
  for (let i = 0; i < v.s.n && same; i++) if (!(await bytesOf(dst, v, i)).equals(src.vs[firstV + i])) same = false;
  check(`${label}: every video frame copied byte for byte from frame ${firstV}`, same, v.s.n);
  check(`${label}: the first frame is a keyframe`, v.s.sync[0] === 1);
  return { mv, v, a: mv.tracks.find((t) => t.handler === 'soun') };
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clips-mp4-'));
  const at = (n) => path.join(dir, n);
  try {
    for (const [label, o] of [['moov first (fast start)', { moovFirst: true }], ['4 frames per chunk', { perChunk: 4 }], ['64-bit offsets (co64)', { co64: true, perChunk: 3 }],
      ['B-frames (ctts)', { ctts: true }], ['all of it at once', { moovFirst: true, perChunk: 5, co64: true, ctts: true }]]) {
      const src = at(`${label.replace(/[^a-z0-9]+/gi, '_')}.mp4`);
      const m = makeMovie(src, o);
      const qi = await M.quickInfo(src);
      check(`${label}: quickInfo reads 8 s at 1280x720`, qi.durationMs === 8000 && qi.width === 1280 && qi.height === 720, qi);
      const dst = at(`${label.replace(/[^a-z0-9]+/gi, '_')}-cut.mp4`);
      let r = null;
      try { r = await M.cut(src, dst, 2500, 5000); } catch (e) { check(`${label}: the cut works`, false, e.message); continue; }
      check(`${label}: starts on the keyframe at 2.0 s for 2.5 s, ends at 5.0 s`, r.startMs === 2000 && r.endMs === 5000, r);
      const c = await sameFrames(dst, m, 60, label);
      check(`${label}: 90 frames (2.0 .. 4.97 s)`, c.v.s.n === 90, c.v.s.n);
      check(`${label}: the audio is there and starts at 2.0 s`, c.a && c.a.s.n > 0 && (await bytesOf(dst, c.a, 0)).equals(m.as[Math.ceil(2.0 * 48000 / 1024 - 1e-9)]), c.a && c.a.s.n);
      if (o.ctts) check(`${label}: the B-frame offsets come along (ctts kept)`, !!(c.v.s.cttsV || c.v.s.cts), Object.keys(c.v.s));
    }

    // the edges, on one movie
    const src = at('edges.mp4');
    const m = makeMovie(src, { perChunk: 2 });
    let r = await M.cut(src, at('from0.mp4'), 0, 1000);
    check('a cut from 0 starts at 0', r.startMs === 0 && r.endMs === 1000, r);
    await sameFrames(at('from0.mp4'), m, 0, 'from 0');
    r = await M.cut(src, at('toend.mp4'), 6100, 8000);
    check('a cut to the very end keeps the last frame (6.0 .. 8.0 s)', r.startMs === 6000 && r.endMs === 8000, r);
    const te = await sameFrames(at('toend.mp4'), m, 180, 'to the end');
    check('... 60 frames', te.v.s.n === 60, te.v.s.n);
    let threw = null;
    try { r = await M.cut(src, at('past.mp4'), 7000, 99000); } catch (e) { threw = e.message; }
    check('an end past the clip stops at the clip\'s end', !threw && r.endMs <= 8000, threw || r);
    // a trim of a trim: the new file is a movie the cut can read again
    r = await M.cut(at('toend.mp4'), at('again.mp4'), 1000, 1900);
    check('a trim of a trim works (the keyframe 1.0 s into the cut, 1.0 .. 1.9 s)', r.startMs === 1000 && Math.abs(r.endMs - 1900) < 1, r);
    await sameFrames(at('again.mp4'), m, 210, 'trim of a trim');
    threw = null;
    try { await M.cut(src, at('empty.mp4'), 3000, 3000); } catch (e) { threw = e.message; }
    check('an empty part is refused, nothing written', !!threw && !fs.existsSync(at('empty.mp4')), threw);
    threw = null;
    try { await M.cut(src, at('void.mp4'), 9000, 9500); } catch (e) { threw = e.message; }
    check('a part after the end is refused, nothing written', !!threw && !fs.existsSync(at('void.mp4')), threw);
    check('no ".part" file is left anywhere', !fs.readdirSync(dir).some((f) => f.endsWith('.part')), fs.readdirSync(dir).filter((f) => f.endsWith('.part')));
  } catch (err) {
    failed.push(`threw: ${err.stack}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`CLIPS MP4: ${passed} passed, ${failed.length} failed`);
  for (const f of failed) console.log(`  FAIL ${f}`);
  process.exitCode = failed.length ? 1 : 0;
})();
