'use strict';
/*
 * _lookaway-y4m.js - build a fake-camera clip for the look-away tests (lane lookaway, 2026-10-23).
 *
 * WHY: the look-away tests must never open the real webcam (the camera light is personal). Chromium can
 * play a YUV4MPEG2 file as the camera instead:
 *   --use-fake-device-for-media-stream --use-file-for-fake-video-capture=<file>.y4m
 * This module turns the still photos in _lookaway-fixtures/ (see LICENCE.md there) into such a clip:
 * each image held for N seconds, so a test can script "facing the screen, then turned away, then back".
 *
 * Pure node, no dependencies (zlib only). PNG input only: 8-bit, non-interlaced, greyscale / grey+alpha /
 * RGB / RGBA. Alpha is ignored (the fixtures are opaque). Every image must already be exactly width x
 * height: a size mismatch throws rather than silently stretching the face.
 *
 * Colour: RGB -> I420 with BT.601 limited range (Y 16..235, U/V 16..240), which is what Chromium's y4m
 * reader assumes for C420jpeg. Chroma is the average of each 2x2 block.
 *
 * The clip is written ONLY to the outPath the caller passes (tests use os.tmpdir()); never in the repo.
 *
 *   const { buildY4m } = require('./_lookaway-y4m');
 *   buildY4m({ frames: [{ file: 'frontal.png', seconds: 3 }, { file: 'profile.png', seconds: 3 }] }, out);
 *
 * CLI: node lib/features/_lookaway-y4m.js <out.y4m> <file.png>:<seconds> [...]
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const FIXTURES = path.join(__dirname, '_lookaway-fixtures');

/** Decode an 8-bit non-interlaced PNG. Returns { w, h, rgba } (rgba: Buffer, 4 bytes per pixel). */
function decodePng(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 33 || buf.readUInt32BE(0) !== 0x89504E47 || buf.readUInt32BE(4) !== 0x0D0A1A0A) {
    throw new Error('not a PNG');
  }
  let pos = 8, w = 0, h = 0, depth = 0, type = -1, lace = 0, seenEnd = false;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos), t = buf.toString('ascii', pos + 4, pos + 8);
    if (pos + 12 + len > buf.length) throw new Error(`PNG truncated in ${t} chunk`);
    const d = buf.subarray(pos + 8, pos + 8 + len);
    if (t === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); depth = d[8]; type = d[9]; lace = d[12]; }
    else if (t === 'IDAT') idat.push(d);
    else if (t === 'IEND') { seenEnd = true; break; }
    pos += 12 + len;
  }
  if (!seenEnd) throw new Error('PNG has no IEND (truncated)');
  const bppOf = { 0: 1, 2: 3, 4: 2, 6: 4 };
  if (depth !== 8 || !(type in bppOf) || lace) {
    throw new Error(`unsupported PNG: depth ${depth}, colour type ${type}, interlace ${lace} (need 8-bit, non-interlaced, grey/RGB[A])`);
  }
  if (!w || !h || !idat.length) throw new Error('PNG has no size or no image data');
  const bpp = bppOf[type], stride = w * bpp, data = zlib.inflateSync(Buffer.concat(idat));
  if (data.length < h * (stride + 1)) throw new Error('PNG image data is short');
  const rgba = Buffer.alloc(w * h * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const off = y * (stride + 1), f = data[off];
    if (f > 4) throw new Error(`PNG row ${y} has bad filter ${f}`);
    const cur = Buffer.from(data.subarray(off + 1, off + 1 + stride));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let add = 0;
      if (f === 1) add = a; else if (f === 2) add = b; else if (f === 3) add = (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[i] = (cur[i] + add) & 0xFF;
    }
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4, s = x * bpp;
      if (bpp >= 3) { rgba[o] = cur[s]; rgba[o + 1] = cur[s + 1]; rgba[o + 2] = cur[s + 2]; }
      else { rgba[o] = rgba[o + 1] = rgba[o + 2] = cur[s]; }
      rgba[o + 3] = bpp === 4 ? cur[s + 3] : bpp === 2 ? cur[s + 1] : 255;
    }
    prev = cur;
  }
  return { w, h, rgba };
}

/** RGBA -> one I420 frame (Y plane, then U, then V), BT.601 limited range. w and h must be even. */
function rgbaToI420(rgba, w, h) {
  const ySize = w * h, cw = w >> 1, ch = h >> 1, out = Buffer.alloc(ySize + 2 * cw * ch);
  for (let i = 0, p = 0; i < ySize; i++, p += 4) {
    out[i] = ((66 * rgba[p] + 129 * rgba[p + 1] + 25 * rgba[p + 2] + 128) >> 8) + 16;
  }
  const U = ySize, V = ySize + cw * ch;
  for (let cy = 0; cy < ch; cy++) {
    for (let cx = 0; cx < cw; cx++) {
      let r = 0, g = 0, b = 0;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const p = ((cy * 2 + dy) * w + cx * 2 + dx) * 4;
          r += rgba[p]; g += rgba[p + 1]; b += rgba[p + 2];
        }
      }
      r = (r + 2) >> 2; g = (g + 2) >> 2; b = (b + 2) >> 2;
      out[U + cy * cw + cx] = ((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128;
      out[V + cy * cw + cx] = ((112 * r - 94 * g - 18 * b + 128) >> 8) + 128;
    }
  }
  return out;
}

/**
 * Write a YUV4MPEG2 clip. frames: [{ file, seconds }] (file: absolute, or a name inside
 * _lookaway-fixtures/). Each image is repeated round(seconds * fps) times (at least once).
 * Returns { path, frames, bytes }.
 */
function buildY4m(opts, outPath) {
  const { frames, fps = 10, width = 320, height = 240 } = opts || {};
  if (!Array.isArray(frames) || !frames.length) throw new Error('buildY4m: frames must be a non-empty list');
  if (!outPath) throw new Error('buildY4m: outPath is required');
  if (!(Number.isInteger(fps) && fps > 0)) throw new Error(`buildY4m: fps must be a positive integer, got ${fps}`);
  if (!(width > 0 && height > 0 && width % 2 === 0 && height % 2 === 0)) throw new Error(`buildY4m: ${width}x${height} must be even`);
  // Decode and convert everything first, so a bad image fails before any file is written.
  const segs = frames.map((f, i) => {
    if (!f || !f.file) throw new Error(`buildY4m: frame ${i} has no file`);
    const file = path.isAbsolute(f.file) ? f.file : path.join(FIXTURES, f.file);
    const img = decodePng(fs.readFileSync(file));
    if (img.w !== width || img.h !== height) {
      throw new Error(`buildY4m: frame ${i} is ${img.w}x${img.h}, expected ${width}x${height}`);
    }
    const secs = Number(f.seconds);
    if (!(secs > 0)) throw new Error(`buildY4m: frame ${i} needs seconds > 0`);
    return { yuv: rgbaToI420(img.rgba, width, height), count: Math.max(1, Math.round(secs * fps)) };
  });
  const header = Buffer.from(`YUV4MPEG2 W${width} H${height} F${fps}:1 Ip A1:1 C420jpeg\n`, 'ascii');
  const mark = Buffer.from('FRAME\n', 'ascii');
  let total = 0, bytes = 0;
  const fd = fs.openSync(outPath, 'w');
  try {
    bytes += fs.writeSync(fd, header);
    for (const s of segs) {
      for (let k = 0; k < s.count; k++) { bytes += fs.writeSync(fd, mark); bytes += fs.writeSync(fd, s.yuv); total++; }
    }
  } finally { fs.closeSync(fd); }
  return { path: outPath, frames: total, bytes };
}

module.exports = { buildY4m, decodePng, rgbaToI420, FIXTURES };

if (require.main === module) {
  const [out, ...specs] = process.argv.slice(2);
  if (!out || !specs.length) {
    console.log('usage: node _lookaway-y4m.js <out.y4m> <file.png>:<seconds> [...]');
    process.exit(2);
  }
  const frames = specs.map(s => { const i = s.lastIndexOf(':'); return { file: s.slice(0, i), seconds: Number(s.slice(i + 1)) }; });
  const r = buildY4m({ frames }, out);
  console.log(`wrote ${r.frames} frames, ${r.bytes} bytes`);
}
