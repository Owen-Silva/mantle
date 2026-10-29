/* make-icon.test.js - the installer's .ico (installer/make-icon.js). Plain node, writes nothing.
 *   node installer/make-icon.test.js   -> "MAKE ICON TEST: n passed, m failed"
 */
const M = require('./make-icon');
const { squareBitmap } = require('../lib/tray-icon');

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(name + (detail !== undefined ? '  -- ' + JSON.stringify(detail) : ''));
}

const b = M.ico();
check('ICONDIR: reserved 0, type 1, one entry per size', b.readUInt16LE(0) === 0 && b.readUInt16LE(2) === 1 && b.readUInt16LE(4) === M.SIZES.length);
check('a 256 px image is there (electron-builder needs one)', M.SIZES.includes(256));
let end = 6 + 16 * M.SIZES.length;
let entriesOk = true;
M.SIZES.forEach((size, i) => {
  const e = 6 + 16 * i;
  const w = b.readUInt8(e) || 256, h = b.readUInt8(e + 1) || 256;
  const len = b.readUInt32LE(e + 8), off = b.readUInt32LE(e + 12);
  const hdr = b.slice(off, off + 40);
  const ok = w === size && h === size && b.readUInt16LE(e + 6) === 32 && off === end
    && hdr.readUInt32LE(0) === 40 && hdr.readInt32LE(4) === size && hdr.readInt32LE(8) === size * 2 && hdr.readUInt16LE(14) === 32
    && len === 40 + size * size * 4 + Math.ceil(size / 32) * 4 * size;
  if (!ok) { entriesOk = false; failures.push(`entry ${size}: w${w} h${h} off${off} end${end} len${len}`); }
  end = off + len;
});
check('every entry: right size, 32 bpp, packed back to back, DIB header + pixels + mask', entriesOk);
check('the file ends after the last image', end === b.length, { end, len: b.length });

// pixels: bottom-up, straight alpha, same shape as the tray icon
const size = 32;
const d = M.dib(size), src = squareBitmap(size);
const at = (x, y) => 40 + ((size - 1 - y) * size + x) * 4;      // the DIB's row for top-down y
const sAt = (x, y) => (y * size + x) * 4;
let alphaSame = true, centreStraight = true;
for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (d[at(x, y) + 3] !== src[sAt(x, y) + 3]) alphaSame = false;
const c = at(16, 16), s = sAt(16, 16);
if (!(d[c + 3] === 255 && d[c] === src[s] && d[c + 1] === src[s + 1] && d[c + 2] === src[s + 2])) centreStraight = false;
check('alpha is the tray drawing\'s, row for row (bottom-up)', alphaSame);
check('an opaque pixel keeps the tray colour exactly', centreStraight);
check('a corner pixel is fully transparent, colour zero', d[at(0, 0) + 3] === 0 && d[at(0, 0)] === 0);
let ex = -1, ey = -1;   // the first anti-aliased pixel (a rounded corner)
for (let y = 0; y < size && ex < 0; y++) for (let x = 0; x < size && ex < 0; x++) { const a = src[sAt(x, y) + 3]; if (a > 0 && a < 255) { ex = x; ey = y; } }
if (ex >= 0) {
  const a = src[sAt(ex, ey) + 3], pre = src[sAt(ex, ey)];
  check('an edge pixel is un-premultiplied (colour / alpha)', d[at(ex, ey)] === Math.min(255, Math.round(pre * 255 / a)), { pre, a, got: d[at(ex, ey)] });
} else check('the drawing has an anti-aliased edge to check', false);

for (const f of failures) console.log('FAIL ' + f);
console.log(`MAKE ICON TEST: ${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
