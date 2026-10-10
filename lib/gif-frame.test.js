'use strict';
/*
 * gif-frame.test.js -- lib/gif-frame.js, the pure-JS GIF first-frame decoder, under plain node
 * (lane looksync-gif, 2026-10-10). Every test GIF is BUILT here with a small LZW encoder, so the
 * decoder is checked pixel for pixel against known images. If real .gif wallpapers exist under
 * %APPDATA%\mantle\wallpapers they are decoded too (read only); none there = that check is skipped.
 *
 *   node lib/gif-frame.test.js
 *
 * Prints "GIF FRAME TEST: n passed, m failed"; exits 1 on any failure.
 */
const fs = require('fs');
const path = require('path');
const { firstFrame } = require('./gif-frame');

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(name + (detail !== undefined ? ' -- ' + String(detail).slice(0, 300) : ''));
}

/* seeded PRNG so failures repeat */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/*
 * Variable-width GIF LZW encoder. opts.clearEvery = emit a clear code after every N data codes;
 * opts.deferred = when the table is full at 4096, keep going with 12-bit codes instead of clearing.
 */
function lzwEncode(indices, minSize, opts = {}) {
  const out = [];
  let acc = 0;
  let nb = 0;
  function write(code, size) {
    acc |= code << nb;
    nb += size;
    while (nb >= 8) { out.push(acc & 255); acc >>>= 8; nb -= 8; }
  }
  const clear = 1 << minSize;
  const eoi = clear + 1;
  let size = minSize + 1;
  let next = eoi + 1;
  let dict = new Map();
  const reset = () => { size = minSize + 1; next = eoi + 1; dict = new Map(); };
  write(clear, size);
  let cur = indices[0];
  let emitted = 0;
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = cur * 256 + k;
    const hit = dict.get(key);
    if (hit !== undefined) { cur = hit; continue; }
    write(cur, size);
    emitted++;
    if (opts.clearEvery && emitted % opts.clearEvery === 0) { write(clear, size); reset(); }
    else if (next === 4096) { if (!opts.deferred) { write(clear, size); reset(); } }
    else {
      if (next >= (1 << size)) size++;
      dict.set(key, next++);
    }
    cur = k;
  }
  write(cur, size);
  write(eoi, size);
  if (nb > 0) out.push(acc & 255);
  return Buffer.from(out);
}

function subBlocks(data) {
  const parts = [];
  for (let i = 0; i < data.length; i += 255) {
    const chunk = data.subarray(i, i + 255);
    parts.push(Buffer.from([chunk.length]), chunk);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

function colourTable(colours) {
  let bits = 1;
  while ((1 << bits) < colours.length) bits++;
  const t = Buffer.alloc((1 << bits) * 3);
  colours.forEach((c, i) => { t[i * 3] = c[0]; t[i * 3 + 1] = c[1]; t[i * 3 + 2] = c[2]; });
  return { t, sizeField: bits - 1 };
}

function interlaceOrder(h) {
  const rows = [];
  for (const [s, st] of [[0, 8], [4, 8], [2, 4], [1, 2]]) for (let y = s; y < h; y += st) rows.push(y);
  return rows;
}

/*
 * Build a GIF. frames: [{ x, y, w, h, idx (row-major, natural order), lct, interlaced, transparent,
 * minSize, enc }]. extras: Buffers inserted before the first frame (comment, plain text...).
 */
function buildGif({ version = '89a', sw, sh, gct, frames, netscape = false, extras = [] }) {
  const parts = [Buffer.from('GIF' + version, 'latin1')];
  const lsd = Buffer.alloc(7);
  lsd.writeUInt16LE(sw, 0);
  lsd.writeUInt16LE(sh, 2);
  let g = null;
  if (gct) { g = colourTable(gct); lsd[4] = 0x80 | (7 << 4) | g.sizeField; }
  parts.push(lsd);
  if (g) parts.push(g.t);
  if (netscape) parts.push(Buffer.from([0x21, 0xff, 11]), Buffer.from('NETSCAPE2.0', 'latin1'), Buffer.from([3, 1, 0, 0, 0]));
  for (const e of extras) parts.push(e);
  for (const f of frames) {
    if (f.transparent !== undefined || version === '89a') {
      const t = f.transparent !== undefined;
      parts.push(Buffer.from([0x21, 0xf9, 4, t ? 1 : 0, 10, 0, t ? f.transparent : 0, 0]));
    }
    const id = Buffer.alloc(10);
    id[0] = 0x2c;
    id.writeUInt16LE(f.x || 0, 1);
    id.writeUInt16LE(f.y || 0, 3);
    id.writeUInt16LE(f.w, 5);
    id.writeUInt16LE(f.h, 7);
    let l = null;
    if (f.lct) { l = colourTable(f.lct); id[9] |= 0x80 | l.sizeField; }
    if (f.interlaced) id[9] |= 0x40;
    parts.push(id);
    if (l) parts.push(l.t);
    let stream = f.idx;
    if (f.interlaced) {
      stream = [];
      for (const y of interlaceOrder(f.h)) for (let x = 0; x < f.w; x++) stream.push(f.idx[y * f.w + x]);
    }
    const ms = f.minSize || 8;
    parts.push(Buffer.from([ms]), subBlocks(lzwEncode(stream, ms, f.enc || {})));
  }
  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}

/* what the decoder should produce: frame 0 over black, transparent -> black, clipped */
function expected(sw, sh, gct, f) {
  const b = Buffer.alloc(sw * sh * 4);
  for (let i = 0; i < sw * sh; i++) b[i * 4 + 3] = 255;
  const table = f.lct || gct;
  for (let y = 0; y < f.h; y++) for (let x = 0; x < f.w; x++) {
    const X = (f.x || 0) + x, Y = (f.y || 0) + y;
    if (X >= sw || Y >= sh) continue;
    const ix = f.idx[y * f.w + x];
    if (ix === f.transparent) continue;
    const c = table[ix] || [0, 0, 0];
    const o = (Y * sw + X) * 4;
    b[o] = c[2]; b[o + 1] = c[1]; b[o + 2] = c[0];
  }
  return b;
}

function firstDiff(a, b) {
  if (!a || !b) return 'missing buffer';
  if (a.length !== b.length) return 'length ' + a.length + ' vs ' + b.length;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return 'byte ' + i + ' (pixel ' + (i >> 2) + ') got ' + a[i] + ' want ' + b[i];
  return null;
}

function checkImage(name, opts, decodeOpts) {
  const buf = buildGif(opts);
  const r = firstFrame(buf, decodeOpts);
  if (!r.ok) { check(name, false, r.reason); return r; }
  const want = expected(opts.sw, opts.sh, opts.gct, opts.frames[0]);
  const diff = firstDiff(r.bgra, want);
  check(name, r.w === opts.sw && r.h === opts.sh && r.frames === 1 && diff === null, `w=${r.w} h=${r.h} ${diff}`);
  return r;
}

function palette(n, seed) {
  const R = rng(seed);
  const p = [];
  for (let i = 0; i < n; i++) p.push([Math.floor(R() * 256), Math.floor(R() * 256), Math.floor(R() * 256)]);
  return p;
}
function noise(w, h, colours, seed) {
  const R = rng(seed);
  const a = new Array(w * h);
  for (let i = 0; i < a.length; i++) a[i] = Math.floor(R() * colours);
  return a;
}

try {
  // 1. 2-colour GIF87a checkerboard
  {
    const gct = [[255, 255, 255], [10, 20, 30]];
    const idx = [];
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) idx.push((x + y) & 1);
    const r = checkImage('2-colour 87a checkerboard', { version: '87a', sw: 8, sh: 8, gct, frames: [{ w: 8, h: 8, idx, minSize: 2 }] });
    check('2-colour 87a: every alpha 255', r.ok && r.bgra.every((v, i) => (i & 3) !== 3 || v === 255));
    check('2-colour 87a: pixel 0 is white, pixel 1 is (10,20,30) as BGRA', r.ok && r.bgra[0] === 255 && r.bgra[4] === 30 && r.bgra[5] === 20 && r.bgra[6] === 10, r.ok && [...r.bgra.subarray(0, 8)]);
    check('2-colour 87a: not interlaced', r.ok && r.interlaced === false);
  }

  // 2. 256-colour 300x200 noise: 9..12-bit codes, full table + clear
  {
    const gct = palette(256, 7);
    const idx = noise(300, 200, 256, 11);
    const enc = lzwEncode(idx, 8);
    check('noise encoder really fills the table (stream > 60k pixels of codes)', enc.length > 50000, enc.length);
    checkImage('256-colour 300x200 noise (table fills, clears at 4096)', { sw: 300, sh: 200, gct, frames: [{ w: 300, h: 200, idx }] });
    checkImage('256-colour noise, clear every 50 codes', { sw: 300, sh: 200, gct, frames: [{ w: 300, h: 200, idx, enc: { clearEvery: 50 } }] });
    checkImage('256-colour noise, deferred clear (table full at 4096, no clear)', { sw: 300, sh: 200, gct, frames: [{ w: 300, h: 200, idx, enc: { deferred: true } }] });
    // few colours, long runs: long chains, many 12-bit strings
    const runs = [];
    for (let i = 0; i < 300 * 200; i++) runs.push(Math.floor(i / 977) % 3);
    checkImage('3-colour long runs (deep LZW chains)', { sw: 300, sh: 200, gct: palette(3, 5), frames: [{ w: 300, h: 200, idx: runs, minSize: 2 }] });
    checkImage('3-colour long runs, deferred clear', { sw: 300, sh: 200, gct: palette(3, 5), frames: [{ w: 300, h: 200, idx: runs, minSize: 2, enc: { deferred: true } }] });
    for (let ms = 2; ms <= 8; ms++) {
      const n = 1 << ms;
      checkImage(`min code size ${ms} noise 97x61`, { sw: 97, sh: 61, gct: palette(n, ms), frames: [{ w: 97, h: 61, idx: noise(97, 61, n, ms * 3), minSize: ms }] });
    }
  }

  // 3. animated 89a: NETSCAPE loop + 2 frames, frame 2 differs -> frame 1's pixels
  {
    const gct = palette(16, 3);
    const f1 = { w: 40, h: 30, idx: noise(40, 30, 16, 1), minSize: 4 };
    const f2 = { w: 40, h: 30, idx: noise(40, 30, 16, 2), minSize: 4 };
    const comment = Buffer.concat([Buffer.from([0x21, 0xfe]), subBlocks(Buffer.from('made by gif-frame.test.js, a comment long enough to need two sub-blocks '.repeat(5)))]);
    const plain = Buffer.concat([Buffer.from([0x21, 0x01, 12, 0, 0, 0, 0, 10, 0, 10, 0, 8, 8, 1, 0]), subBlocks(Buffer.from('hello'))]);
    const opts = { sw: 40, sh: 30, gct, netscape: true, extras: [comment, plain], frames: [f1, f2] };
    const r = checkImage('animated 89a with NETSCAPE, comment, plain text ext: frame 1 pixels', opts);
    const second = expected(40, 30, gct, f2);
    check('animated 89a: result is NOT frame 2', r.ok && firstDiff(r.bgra, second) !== null);
    check('animated 89a: frames is 1', r.ok && r.frames === 1);
    // frame 2 corrupt after a valid frame 1 still decodes (we stop after frame 1)
    const buf = buildGif(opts);
    const cut = buf.subarray(0, buf.length - 20);
    const rc = firstFrame(cut);
    check('animated 89a cut inside frame 2: frame 1 still decodes', rc.ok && firstDiff(rc.bgra, expected(40, 30, gct, f1)) === null, rc.reason);
  }

  // 4. transparency index -> black
  {
    const gct = [[200, 100, 50], [255, 255, 255], [0, 128, 255], [9, 9, 9]];
    const idx = noise(20, 20, 4, 9);
    const r = checkImage('transparent index 1 -> black', { sw: 20, sh: 20, gct, frames: [{ w: 20, h: 20, idx, minSize: 2, transparent: 1 }] });
    const i = idx.indexOf(1);
    check('transparent pixel is (0,0,0,255)', r.ok && i >= 0 && r.bgra[i * 4] === 0 && r.bgra[i * 4 + 1] === 0 && r.bgra[i * 4 + 2] === 0 && r.bgra[i * 4 + 3] === 255);
    // a GCE that belongs to frame 2 must not affect frame 1
    const f1 = { w: 20, h: 20, idx, minSize: 2 };
    const f2 = { w: 20, h: 20, idx, minSize: 2, transparent: 1 };
    checkImage('GCE of frame 2 does not make frame 1 transparent', { sw: 20, sh: 20, gct, frames: [f1, f2] });
  }

  // 5. smaller image offset inside the screen; outside -> black
  {
    const gct = palette(8, 21);
    const r = checkImage('first image 10x6 at (7,5) on a 30x20 screen', { sw: 30, sh: 20, gct, frames: [{ x: 7, y: 5, w: 10, h: 6, idx: noise(10, 6, 8, 4), minSize: 3 }] });
    check('outside the rect is opaque black', r.ok && r.bgra[0] === 0 && r.bgra[1] === 0 && r.bgra[2] === 0 && r.bgra[3] === 255);
    checkImage('image rect past the screen edge is clipped', { sw: 30, sh: 20, gct, frames: [{ x: 22, y: 15, w: 17, h: 11, idx: noise(17, 11, 8, 5), minSize: 3 }] });
    checkImage('image entirely off screen -> all black', { sw: 30, sh: 20, gct, frames: [{ x: 40, y: 40, w: 5, h: 5, idx: noise(5, 5, 8, 6), minSize: 3 }] });
  }

  // 6. interlaced
  {
    const gct = palette(16, 33);
    const r = checkImage('interlaced 23x37', { sw: 23, sh: 37, gct, frames: [{ w: 23, h: 37, idx: noise(23, 37, 16, 8), minSize: 4, interlaced: true }] });
    check('interlaced flag reported', r.ok && r.interlaced === true);
    for (const h of [1, 2, 3, 4, 5, 8, 9]) {
      checkImage(`interlaced height ${h}`, { sw: 6, sh: h, gct, frames: [{ w: 6, h, idx: noise(6, h, 16, h + 50), minSize: 4, interlaced: true }] });
    }
    checkImage('interlaced + offset + clipped', { sw: 20, sh: 20, gct, frames: [{ x: 5, y: 9, w: 21, h: 17, idx: noise(21, 17, 16, 77), minSize: 4, interlaced: true }] });
  }

  // 7. local colour table overrides global
  {
    const gct = [[255, 0, 0], [255, 0, 0], [255, 0, 0], [255, 0, 0]];
    const lct = [[1, 2, 3], [4, 5, 6], [7, 8, 9], [10, 11, 12]];
    const r = checkImage('local colour table overrides global', { sw: 9, sh: 9, gct, frames: [{ w: 9, h: 9, idx: noise(9, 9, 4, 3), minSize: 2, lct }] });
    check('no red from the global table', r.ok && !r.bgra.some((v, i) => (i & 3) === 2 && v === 255));
    checkImage('local colour table with no global table', { sw: 9, sh: 9, gct: null, frames: [{ w: 9, h: 9, idx: noise(9, 9, 4, 3), minSize: 2, lct }] });
  }

  // 8. truncated
  {
    const gct = palette(256, 1);
    const buf = buildGif({ sw: 64, sh: 64, gct, frames: [{ w: 64, h: 64, idx: noise(64, 64, 256, 2) }] });
    const r = firstFrame(buf.subarray(0, Math.floor(buf.length * 0.6)));
    check('truncated mid picture data -> ok:false', !r.ok && /cut short/.test(r.reason) && /pixels arrived/.test(r.reason), r.reason);
    let threw = 0, okBad = 0;
    const want = expected(64, 64, gct, { w: 64, h: 64, idx: noise(64, 64, 256, 2) });
    for (let n = 0; n < buf.length; n++) {
      let rr;
      try { rr = firstFrame(buf.subarray(0, n)); } catch (_) { threw++; continue; }
      if (!rr || (rr.ok !== true && rr.ok !== false) || (!rr.ok && !(typeof rr.reason === 'string' && rr.reason.length > 10))) okBad++;
      else if (rr.ok && firstDiff(rr.bgra, want) !== null) okBad++;
    }
    check('every prefix of a GIF: never throws, ok:false has a reason, ok:true is the full picture', threw === 0 && okBad === 0, `threw=${threw} bad=${okBad}`);
    const h = firstFrame(buf.subarray(0, 10));
    check('cut inside the screen descriptor -> ok:false with a reason', !h.ok && /cut short/.test(h.reason), h.reason);
  }

  // 9. not a GIF
  {
    const r = firstFrame(Buffer.from('\x89PNG\r\n\x1a\n0000000000000000', 'latin1'));
    check('PNG bytes -> not a GIF', !r.ok && /not a GIF/.test(r.reason) && /GIF87a\/GIF89a/.test(r.reason), r.reason);
    const e = firstFrame(Buffer.alloc(0));
    check('empty buffer -> not a GIF', !e.ok && /not a GIF/.test(e.reason), e.reason);
    const u = firstFrame(undefined);
    check('undefined -> ok:false', !u.ok && typeof u.reason === 'string', u.reason);
    const noImg = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.from([4, 0, 4, 0, 0, 0, 0, 0x3b])]);
    const ni = firstFrame(noImg);
    check('GIF with no images -> ok:false', !ni.ok && /no images/.test(ni.reason), ni.reason);
    // random garbage after a valid header never throws
    const R = rng(99);
    let threw = 0, okFalse = 0;
    for (let t = 0; t < 300; t++) {
      const g = Buffer.alloc(13 + Math.floor(R() * 400));
      for (let i = 0; i < g.length; i++) g[i] = Math.floor(R() * 256);
      g.write('GIF89a', 0, 'latin1');
      g[6] = 1 + (t % 40); g[7] = 0; g[8] = 1 + (t % 30); g[9] = 0;
      try { const rr = firstFrame(g); if (!rr.ok && rr.reason) okFalse++; } catch (_) { threw++; }
    }
    check('300 random-garbage GIFs: none throws', threw === 0, `threw=${threw} okFalse=${okFalse}`);
  }

  // 10. zero-size screen -> image's own size
  {
    const gct = palette(4, 4);
    const f = { x: 3, y: 3, w: 12, h: 7, idx: noise(12, 7, 4, 1), minSize: 2 };
    const r = firstFrame(buildGif({ sw: 0, sh: 0, gct, frames: [f] }));
    const want = expected(12, 7, gct, { ...f, x: 0, y: 0 });
    check('zero-size screen uses the image size (12x7)', r.ok && r.w === 12 && r.h === 7 && firstDiff(r.bgra, want) === null, r.reason || `${r.w}x${r.h}`);
  }

  // 11. maxPixels refusal
  {
    const buf = buildGif({ sw: 100, sh: 100, gct: palette(4, 1), frames: [{ w: 100, h: 100, idx: noise(100, 100, 4, 1), minSize: 2 }] });
    const r = firstFrame(buf, { maxPixels: 5000 });
    check('maxPixels 5000 refuses a 100x100 GIF with a reason', !r.ok && /too big/.test(r.reason) && /100 x 100/.test(r.reason), r.reason);
    check('maxPixels 10000 allows a 100x100 GIF', firstFrame(buf, { maxPixels: 10000 }).ok);
    const big = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.from([0x00, 0x20, 0x00, 0x20, 0, 0, 0]), Buffer.from([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x4c, 1, 0, 0x3b])]);
    const rb = firstFrame(big);
    check('8192x8192 screen refused by the default 64M limit', !rb.ok && /too big/.test(rb.reason), rb.reason);
  }

  // 12. missing colour table -> greyscale, still ok
  {
    const idx = noise(10, 10, 4, 12);
    const r = firstFrame(buildGif({ sw: 10, sh: 10, gct: null, frames: [{ w: 10, h: 10, idx, minSize: 2 }] }));
    const i3 = idx.indexOf(3), i0 = idx.indexOf(0);
    check('no colour table -> ok:true greyscale', r.ok && r.bgra[i3 * 4] === 255 && r.bgra[i3 * 4 + 1] === 255 && r.bgra[i0 * 4] === 0 && r.bgra[i0 * 4 + 3] === 255, r.reason);
  }

  // 13. timing: 1920x1080 noise frame
  {
    const gct = palette(256, 2);
    const W = 1920, H = 1080;
    const R = rng(5);
    const idx = new Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) idx[y * W + x] = R() < 0.5 ? Math.floor(R() * 256) : ((x >> 4) + (y >> 4)) & 255;
    const buf = buildGif({ sw: W, sh: H, gct, frames: [{ w: W, h: H, idx }] });
    firstFrame(buf); // warm
    const t0 = process.hrtime.bigint();
    const r = firstFrame(buf);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    console.log(`  1920x1080 frame (${(buf.length / 1024).toFixed(0)} KB gif) decoded in ${ms.toFixed(1)} ms`);
    check('1920x1080 decodes under 1000 ms', r.ok && ms < 1000, `${ms.toFixed(1)} ms ${r.reason || ''}`);
    let ok = r.ok;
    if (ok) for (let i = 0; i < W * H; i += 997) { const c = gct[idx[i]]; if (r.bgra[i * 4] !== c[2] || r.bgra[i * 4 + 1] !== c[1] || r.bgra[i * 4 + 2] !== c[0]) { ok = false; break; } }
    check('1920x1080 sampled pixels correct', ok);
  }

  // 14. real wallpaper GIFs (read only); skipped when none exist
  {
    const root = path.join(process.env.APPDATA || '', 'mantle', 'wallpapers');
    const found = [];
    try {
      for (const d of fs.readdirSync(root, { withFileTypes: true })) {
        const p = path.join(root, d.name);
        if (d.isFile() && /\.gif$/i.test(d.name)) found.push(p);
        else if (d.isDirectory()) for (const f of fs.readdirSync(p)) if (/\.gif$/i.test(f)) found.push(path.join(p, f));
      }
    } catch (_) { /* no folder */ }
    if (!found.length) console.log('  SKIP real file decodes (no .gif under ' + root + ')');
    for (const f of found) {
      const buf = fs.readFileSync(f);
      const t0 = process.hrtime.bigint();
      const r = firstFrame(buf);
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      const sw = buf.readUInt16LE(6), sh = buf.readUInt16LE(8);
      const sizeOk = r.ok && (sw && sh ? r.w === sw && r.h === sh : r.w > 0) && r.bgra.length === r.w * r.h * 4;
      // not all black: a real wallpaper has some colour
      let lit = 0;
      if (r.ok) for (let i = 0; i < r.bgra.length; i += 4 * 101) if (r.bgra[i] | r.bgra[i + 1] | r.bgra[i + 2]) lit++;
      console.log(`  real ${path.basename(path.dirname(f))}/${path.basename(f)}: ${r.ok ? r.w + 'x' + r.h + (r.interlaced ? ' interlaced' : '') + ' in ' + ms.toFixed(1) + ' ms' : 'FAILED ' + r.reason}`);
      check('real file decodes: ' + path.basename(f), sizeOk && lit > 0, r.reason || `lit=${lit}`);
    }
  }
} catch (err) {
  failures.push('crashed: ' + (err && err.stack ? err.stack.split('\n').slice(0, 3).join(' / ') : err));
}

for (const f of failures) console.log('  FAIL ' + f);
console.log(`GIF FRAME TEST: ${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
