'use strict';
/*
 * lib/gif-frame.js - the FIRST frame of a .gif file as a BGRA bitmap, in pure JS
 * (lane looksync-gif, 2026-10-10).
 *
 * Why: the look-sync publisher needs a GIF wallpaper's first frame as a JPEG still, and
 * Electron's nativeImage cannot decode GIF. This decodes just enough of the file to draw the
 * picture a viewer shows with animation off, then stops (later frames are never decoded).
 *
 *   const { firstFrame } = require('./gif-frame');
 *   firstFrame(buf, { maxPixels })
 *     -> { ok: true, w, h, bgra, frames: 1, interlaced }   bgra = w*h*4 bytes, B,G,R,A, every A = 255
 *     -> { ok: false, reason: 'plain words' }
 *
 * The first image is composited onto the logical screen (w, h from the Logical Screen
 * Descriptor). Pixels outside the image's rectangle, and pixels equal to the transparent index of
 * a Graphic Control Extension that precedes the image, are opaque BLACK: this is a wallpaper
 * still, drawn over black like Mantle's desktop. A screen of 0x0 takes the image's own size. An
 * image rect that runs past the screen is clipped. A file with no colour table at all decodes as
 * greyscale. Never throws.
 *
 * Supports GIF87a and GIF89a, global and local colour tables, every extension block (skipped by
 * sub-blocks), variable-width LZW (min code size 1..8, clear, end, growth to 12 bits, and the
 * "deferred clear" where the table sits full at 4096 and the encoder keeps going), and interlaced
 * images (the 4-pass row order).
 *
 * Tested by lib/gif-frame.test.js (plain node).
 */

const DEFAULT_MAX_PIXELS = 64e6;

/* LZW-decode the first image straight into out32 (clipped to the screen); stops at the last pixel.
 * Returns how many pixels arrived and whether an impossible code was met. */
function decodeInto(o) {
  const { data, dataLen, minSize, iw, ih, interlaced, out32, pal32, W, H, ox, oy } = o;
  const clear = 1 << minSize;
  const eoi = clear + 1;
  const prefix = new Uint16Array(4096);
  const suffix = new Uint8Array(4096);
  const first = new Uint8Array(4096);
  const stack = new Uint8Array(4097);
  for (let i = 0; i < clear; i++) { suffix[i] = i; first[i] = i; }

  let codeSize = minSize + 1;
  let codeMask = (1 << codeSize) - 1;
  let next = eoi + 1;
  let prev = -1;
  let datum = 0;
  let bits = 0;
  let pos = 0;

  // pixel cursor
  const total = iw * ih;
  let count = 0;
  let x = 0;
  let y = 0;
  let pass = 0;
  const PASS_START = [0, 4, 2, 1];
  const PASS_STEP = [8, 8, 4, 2];
  let step = interlaced ? 8 : 1;
  const colLimit = Math.max(0, Math.min(iw, W - ox));
  let rowVis = oy + y < H;
  let rowBase = (oy + y) * W + ox;

  for (;;) {
    while (bits < codeSize) {
      if (pos >= dataLen) return { count, total, corrupt: false };
      datum |= data[pos++] << bits;
      bits += 8;
    }
    const code = datum & codeMask;
    datum >>>= codeSize;
    bits -= codeSize;

    if (code === clear) {
      codeSize = minSize + 1;
      codeMask = (1 << codeSize) - 1;
      next = eoi + 1;
      prev = -1;
      continue;
    }
    if (code === eoi) return { count, total, corrupt: false };

    let c;
    if (prev === -1) {
      if (code > clear) return { count, total, corrupt: true };
      c = code;
    } else if (code < next) {
      c = code;
      if (next < 4096) {
        prefix[next] = prev;
        suffix[next] = first[code];
        first[next] = first[prev];
        next++;
      }
    } else if (code === next && next < 4096) {
      prefix[next] = prev;
      suffix[next] = first[prev];
      first[next] = first[prev];
      next++;
      c = code;
    } else {
      return { count, total, corrupt: true };
    }
    if (prev !== -1 && next === codeMask + 1 && codeSize < 12) {
      codeSize++;
      codeMask = (1 << codeSize) - 1;
    }
    prev = code;

    // walk the chain onto the stack, then pop it out in order
    let sp = 0;
    while (c > eoi) { stack[sp++] = suffix[c]; c = prefix[c]; }
    stack[sp++] = c;

    while (sp > 0) {
      const idx = stack[--sp];
      if (rowVis && x < colLimit) out32[rowBase + x] = pal32[idx];
      x++;
      count++;
      if (x === iw) {
        if (count >= total) return { count, total, corrupt: false };
        x = 0;
        y += step;
        if (interlaced) {
          while (y >= ih && pass < 3) { pass++; y = PASS_START[pass]; step = PASS_STEP[pass]; }
          if (y >= ih) return { count, total, corrupt: false };
        }
        rowVis = oy + y < H;
        rowBase = (oy + y) * W + ox;
      }
    }
  }
}

function firstFrameInner(buf, opts) {
  if (!buf || typeof buf.length !== 'number') return { ok: false, reason: 'no file contents were given (expected a Buffer of the .gif file)' };
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  const maxPixels = opts && Number.isFinite(opts.maxPixels) && opts.maxPixels > 0 ? opts.maxPixels : DEFAULT_MAX_PIXELS;
  const n = buf.length;

  if (n < 6) return { ok: false, reason: 'the file is not a GIF (no GIF87a/GIF89a header; it is only ' + n + ' bytes long)' };
  const sig = buf.toString('latin1', 0, 6);
  if (sig !== 'GIF87a' && sig !== 'GIF89a') return { ok: false, reason: 'the file is not a GIF (no GIF87a/GIF89a header)' };
  if (n < 13) return { ok: false, reason: 'the file is cut short: it ends inside the GIF screen descriptor' };

  let sw = buf.readUInt16LE(6);
  let sh = buf.readUInt16LE(8);
  const lsdPacked = buf[10];
  let p = 13;
  let gct = null;
  let gctCount = 0;
  if (lsdPacked & 0x80) {
    gctCount = 1 << ((lsdPacked & 7) + 1);
    if (p + gctCount * 3 > n) return { ok: false, reason: 'the file is cut short: it ends inside the global colour table' };
    gct = buf.subarray(p, p + gctCount * 3);
    p += gctCount * 3;
  }

  let transparent = -1;
  for (;;) {
    if (p >= n) return { ok: false, reason: 'the file ends before its first image (no image data found)' };
    const b = buf[p++];
    if (b === 0x3b) return { ok: false, reason: 'the GIF has no images (the trailer comes before any picture)' };
    if (b === 0x21) {
      if (p >= n) return { ok: false, reason: 'the file is cut short inside an extension block' };
      const label = buf[p++];
      if (label === 0xf9 && p < n && buf[p] >= 4 && p + 4 < n) {
        const packed = buf[p + 1];
        transparent = (packed & 1) ? buf[p + 4] : -1;
      }
      // skip sub-blocks
      for (;;) {
        if (p >= n) return { ok: false, reason: 'the file is cut short inside an extension block' };
        const len = buf[p++];
        if (len === 0) break;
        p += len;
      }
      continue;
    }
    if (b !== 0x2c) {
      return { ok: false, reason: 'the GIF is corrupt: an unknown block (byte 0x' + b.toString(16).padStart(2, '0') + ') at offset ' + (p - 1) + ' before the first image' };
    }

    // Image Descriptor
    if (p + 9 > n) return { ok: false, reason: 'the file is cut short inside the first image descriptor' };
    let ox = buf.readUInt16LE(p);
    let oy = buf.readUInt16LE(p + 2);
    const iw = buf.readUInt16LE(p + 4);
    const ih = buf.readUInt16LE(p + 6);
    const idPacked = buf[p + 8];
    p += 9;
    const interlaced = !!(idPacked & 0x40);
    let table = gct;
    let tableCount = gctCount;
    if (idPacked & 0x80) {
      tableCount = 1 << ((idPacked & 7) + 1);
      if (p + tableCount * 3 > n) return { ok: false, reason: 'the file is cut short inside the first image\'s local colour table' };
      table = buf.subarray(p, p + tableCount * 3);
      p += tableCount * 3;
    }

    if (sw === 0 || sh === 0) { sw = iw; sh = ih; ox = 0; oy = 0; }
    if (sw === 0 || sh === 0) return { ok: false, reason: 'the GIF has no pixels (its screen and its first image are both 0 wide or 0 tall)' };
    if (sw * sh > maxPixels) return { ok: false, reason: 'the GIF is too big: ' + sw + ' x ' + sh + ' is more than the ' + maxPixels + '-pixel limit' };
    if (iw * ih > maxPixels) return { ok: false, reason: 'the GIF\'s first image is too big: ' + iw + ' x ' + ih + ' is more than the ' + maxPixels + '-pixel limit' };

    if (p >= n) return { ok: false, reason: 'the file is cut short: it ends before the first image\'s picture data' };
    const minSize = buf[p++];
    if (minSize < 1 || minSize > 8) return { ok: false, reason: 'the GIF is corrupt: the first image\'s LZW code size is ' + minSize + ' (it must be between 1 and 8)' };

    // gather the data sub-blocks into one run
    let cut = false;
    let dataLen = 0;
    let q = p;
    for (;;) {
      if (q >= n) { cut = true; break; }
      const len = buf[q++];
      if (len === 0) break;
      dataLen += Math.min(len, n - q);
      if (q + len > n) { cut = true; break; }
      q += len;
    }
    const data = Buffer.allocUnsafe(dataLen);
    let d = 0;
    q = p;
    for (;;) {
      if (q >= n) break;
      const len = buf[q++];
      if (len === 0) break;
      const take = Math.min(len, n - q);
      buf.copy(data, d, q, q + take);
      d += take;
      q += len;
    }

    // palette: BGRA bytes, read as uint32 by the same view type as the output (endian-agnostic)
    const palBytes = new Uint8Array(256 * 4);
    for (let i = 0; i < 256; i++) {
      const o = i * 4;
      if (table) {
        if (i < tableCount) { palBytes[o] = table[i * 3 + 2]; palBytes[o + 1] = table[i * 3 + 1]; palBytes[o + 2] = table[i * 3]; }
      } else {
        const g = minSize >= 8 ? i : Math.min(255, Math.round(i * 255 / ((1 << minSize) - 1)));
        palBytes[o] = g; palBytes[o + 1] = g; palBytes[o + 2] = g;
      }
      palBytes[o + 3] = 255;
    }
    if (transparent >= 0) { const o = transparent * 4; palBytes[o] = 0; palBytes[o + 1] = 0; palBytes[o + 2] = 0; palBytes[o + 3] = 255; }
    const pal32 = new Uint32Array(palBytes.buffer);

    const ab = new ArrayBuffer(sw * sh * 4);
    const out32 = new Uint32Array(ab);
    out32.fill(new Uint32Array(new Uint8Array([0, 0, 0, 255]).buffer)[0]);

    const r = decodeInto({ data, dataLen, minSize, iw, ih, interlaced, out32, pal32, W: sw, H: sh, ox, oy });
    if (r.corrupt) return { ok: false, reason: 'the GIF is corrupt: the first image\'s LZW picture data has an impossible code (after ' + r.count + ' of ' + r.total + ' pixels)' };
    if (cut && r.count < r.total) return { ok: false, reason: 'the file is cut short: it ends partway through the first image (' + r.count + ' of ' + r.total + ' pixels arrived)' };
    // A complete container whose LZW stream simply stops early is drawn as far as it goes (the rest
    // stays black), as browsers do.
    return { ok: true, w: sw, h: sh, bgra: Buffer.from(ab), frames: 1, interlaced };
  }
}

function firstFrame(buf, opts) {
  try {
    return firstFrameInner(buf, opts);
  } catch (err) {
    return { ok: false, reason: 'the GIF could not be read: ' + (err && err.message ? err.message : String(err)) };
  }
}

module.exports = { firstFrame };
