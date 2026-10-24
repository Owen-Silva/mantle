// _lookaway-y4m.test.js - the look-away fake-camera clip builder (lib/features/_lookaway-y4m.js):
// PNG decode, RGB -> I420 levels, y4m header / frame count / byte size, and the shipped fixtures.
// Pure node: no Electron, no browser, no camera. Writes only to os.tmpdir() and deletes what it wrote.
//
//   node lib/features/_lookaway-y4m.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const Y = require('./_lookaway-y4m.js');

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { passed++; return; }
  failures.push(name);
  console.log('  FAIL ' + name + (detail !== undefined ? ' - ' + JSON.stringify(detail) : ''));
}

/* ---- a tiny PNG writer for synthetic inputs (filter 0 rows, or a given filter per row) ---------- */
const crcTable = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc = b => { let c = -1; for (const x of b) c = crcTable[(c ^ x) & 0xFF] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function chunk(t, d) {
  const l = Buffer.alloc(4); l.writeUInt32BE(d.length);
  const td = Buffer.concat([Buffer.from(t, 'ascii'), d]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([l, td, c]);
}
/** px(x, y) -> [r, g, b] ; type 2 (RGB) or 6 (RGBA, alpha 255). */
function encodePng(w, h, px, type = 2) {
  const bpp = type === 6 ? 4 : 3, stride = w * bpp, raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = px(x, y), o = y * (stride + 1) + 1 + x * bpp;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; if (bpp === 4) raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = type;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const W = 320, H = 240, FRAME = 6 + W * H * 1.5;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lookaway-y4m-'));
const white = path.join(dir, 'white.png'), black = path.join(dir, 'black.png'), out = path.join(dir, 'clip.y4m');
try {
  fs.writeFileSync(white, encodePng(W, H, () => [255, 255, 255]));
  fs.writeFileSync(black, encodePng(W, H, () => [0, 0, 0], 6));

  /* ---- decodePng --------------------------------------------------------------------------------- */
  const dw = Y.decodePng(fs.readFileSync(white));
  check('decodePng: white RGB is 320x240, all 255, opaque', dw.w === W && dw.h === H && dw.rgba.length === W * H * 4 && dw.rgba.every(v => v === 255));
  const db = Y.decodePng(fs.readFileSync(black));
  check('decodePng: black RGBA is 320x240, rgb 0, alpha 255', db.w === W && db.h === H && db.rgba.every((v, i) => (i % 4 === 3 ? v === 255 : v === 0)));
  const grad = Y.decodePng(encodePng(7, 3, (x, y) => [x * 30, y * 80, 200 - x * 10]));
  check('decodePng: a gradient decodes pixel-exact', grad.w === 7 && grad.h === 3 &&
    [...Array(21).keys()].every(i => { const x = i % 7, y = (i / 7) | 0, o = i * 4; return grad.rgba[o] === x * 30 && grad.rgba[o + 1] === y * 80 && grad.rgba[o + 2] === 200 - x * 10; }));
  let threw = '';
  try { Y.decodePng(Buffer.from('not a png at all, just text padding padding')); } catch (e) { threw = e.message; }
  check('decodePng: rejects a non-PNG', /not a PNG/.test(threw), threw);

  /* ---- colour levels ----------------------------------------------------------------------------- */
  const yw = Y.rgbaToI420(dw.rgba, W, H), yb = Y.rgbaToI420(db.rgba, W, H);
  check('I420 frame size is w*h*1.5', yw.length === W * H * 1.5, yw.length);
  check('white -> Y near 235 (limited range)', Math.abs(yw[0] - 235) <= 1 && Math.abs(yw[W * H - 1] - 235) <= 1, yw[0]);
  check('black -> Y near 16 (limited range)', Math.abs(yb[0] - 16) <= 1 && Math.abs(yb[W * H - 1] - 16) <= 1, yb[0]);
  check('white and black -> neutral chroma (U, V near 128)', [yw, yb].every(f => Math.abs(f[W * H] - 128) <= 1 && Math.abs(f[f.length - 1] - 128) <= 1), [yw[W * H], yb[W * H]]);
  const red = Y.rgbaToI420(Buffer.from([255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255]), 2, 2);
  check('pure red -> Y 82, U 90, V 240 (BT.601 limited)', Math.abs(red[0] - 82) <= 1 && Math.abs(red[4] - 90) <= 1 && Math.abs(red[5] - 240) <= 1, [...red]);

  /* ---- a 2-segment clip -------------------------------------------------------------------------- */
  const r = Y.buildY4m({ frames: [{ file: white, seconds: 1.5 }, { file: black, seconds: 0.7 }], fps: 10 }, out);
  const header = 'YUV4MPEG2 W320 H240 F10:1 Ip A1:1 C420jpeg\n';
  const buf = fs.readFileSync(out);
  check('clip: header is exact', buf.toString('ascii', 0, header.length) === header, buf.toString('ascii', 0, header.length));
  check('clip: frame count = round(1.5*10) + round(0.7*10) = 22', r.frames === 22, r.frames);
  check('clip: byte size = frames * (6 + 320*240*1.5) + header', buf.length === 22 * FRAME + header.length && r.bytes === buf.length, { file: buf.length, ret: r.bytes });
  check('clip: returns the path it wrote', r.path === out);
  const frameAt = i => header.length + i * FRAME;
  let marks = true;
  for (let i = 0; i < 22; i++) marks = marks && buf.toString('ascii', frameAt(i), frameAt(i) + 6) === 'FRAME\n';
  check('clip: every frame starts with FRAME\\n', marks);
  check('clip: frames 0-14 are white (Y 235), 15-21 black (Y 16)',
    [0, 7, 14].every(i => Math.abs(buf[frameAt(i) + 6 + 1000] - 235) <= 1) && [15, 21].every(i => Math.abs(buf[frameAt(i) + 6 + 1000] - 16) <= 1));
  fs.unlinkSync(out);
  check('clip: deleted after the test', !fs.existsSync(out));

  /* ---- refusals: fail before writing ------------------------------------------------------------- */
  const small = path.join(dir, 'small.png');
  fs.writeFileSync(small, encodePng(16, 16, () => [9, 9, 9]));
  threw = '';
  try { Y.buildY4m({ frames: [{ file: small, seconds: 1 }] }, out); } catch (e) { threw = e.message; }
  check('a wrong-size image throws and writes nothing', /16x16, expected 320x240/.test(threw) && !fs.existsSync(out), threw);
  threw = '';
  try { Y.buildY4m({ frames: [] }, out); } catch (e) { threw = e.message; }
  check('no frames throws', /non-empty/.test(threw), threw);

  /* ---- the shipped fixtures ---------------------------------------------------------------------- */
  const names = ['frontal.png', 'turned.png', 'profile.png', 'down.png', 'empty.png'];
  let total = 0;
  for (const n of names) {
    const p = path.join(Y.FIXTURES, n), b = fs.readFileSync(p);
    total += b.length;
    const d = Y.decodePng(b);
    check(`fixture ${n}: 8-bit RGB non-interlaced 320x240`, d.w === W && d.h === H && b[24] === 8 && b[25] === 2 && b[28] === 0, { w: d.w, h: d.h, depth: b[24], type: b[25], lace: b[28] });
  }
  check('fixtures total under 600 KB', total < 600 * 1024, total);
  check('fixtures have a licence record naming each file', (() => { const t = fs.readFileSync(path.join(Y.FIXTURES, 'LICENCE.md'), 'utf8'); return names.every(n => t.includes('`' + n + '`')); })());
  const all = Y.buildY4m({ frames: names.map(file => ({ file, seconds: 0.2 })) }, out);
  check('fixtures build into a clip by name (5 x 2 frames)', all.frames === 10 && fs.statSync(out).size === all.bytes, all);
  fs.unlinkSync(out);
} catch (e) {
  check('no unexpected exception', false, e && e.stack);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
check('temp folder removed', !fs.existsSync(dir));

console.log(`LOOKAWAY-Y4M: ${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
