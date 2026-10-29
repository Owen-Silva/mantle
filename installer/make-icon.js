'use strict';
/*
 * installer/make-icon.js -- Mantle.exe's and the installer's icon, drawn in code (lane inst-mantle, 2026-10-29).
 *
 *   node installer/make-icon.js <out.ico>
 *
 * The same rounded square in the accent colour as the notification-area icon (lib/tray-icon.js squareBitmap),
 * so the app's icon and its tray icon are one drawing and there is no binary asset in the repo to drift from
 * the palette. Sizes 16-256 as 32-bit DIBs with straight (not premultiplied) alpha, which is what an .ico holds.
 * Pure node: no browser, no Electron.
 */
const fs = require('fs');
const { squareBitmap } = require('../lib/tray-icon');

const SIZES = Object.freeze([16, 20, 24, 32, 40, 48, 64, 128, 256]);

/** squareBitmap's premultiplied top-down BGRA -> straight-alpha bottom-up BGRA rows + an empty AND mask. */
function dib(size) {
  const src = squareBitmap(size);
  const maskRow = Math.ceil(size / 32) * 4;
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);              // biSize
  header.writeInt32LE(size, 4);             // biWidth
  header.writeInt32LE(size * 2, 8);         // biHeight: colour + mask
  header.writeUInt16LE(1, 12);              // biPlanes
  header.writeUInt16LE(32, 14);             // biBitCount
  header.writeUInt32LE(0, 16);              // BI_RGB
  header.writeUInt32LE(size * size * 4 + maskRow * size, 20);
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const s = (y * size + x) * 4;
      const d = ((size - 1 - y) * size + x) * 4;
      const a = src[s + 3];
      const un = (c) => (a ? Math.min(255, Math.round((c * 255) / a)) : 0);
      px[d] = un(src[s]); px[d + 1] = un(src[s + 1]); px[d + 2] = un(src[s + 2]); px[d + 3] = a;
    }
  }
  return Buffer.concat([header, px, Buffer.alloc(maskRow * size)]);
}

/** -> the .ico file's bytes. */
function ico(sizes) {
  const list = sizes || SIZES;
  const images = list.map(dib);
  const dir = Buffer.alloc(6 + 16 * list.length);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2);                  // type 1 = icon
  dir.writeUInt16LE(list.length, 4);
  let offset = dir.length;
  list.forEach((size, i) => {
    const e = 6 + 16 * i;
    dir.writeUInt8(size >= 256 ? 0 : size, e);       // 0 means 256
    dir.writeUInt8(size >= 256 ? 0 : size, e + 1);
    dir.writeUInt8(0, e + 2);
    dir.writeUInt8(0, e + 3);
    dir.writeUInt16LE(1, e + 4);
    dir.writeUInt16LE(32, e + 6);
    dir.writeUInt32LE(images[i].length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += images[i].length;
  });
  return Buffer.concat([dir, ...images]);
}

if (require.main === module) {
  const out = process.argv[2];
  if (!out) { console.error('usage: node installer/make-icon.js <out.ico>'); process.exit(2); }
  const bytes = ico();
  fs.writeFileSync(out, bytes);
  console.log(`make-icon: wrote ${out} (${bytes.length} bytes, ${SIZES.join('/')} px)`);
}

module.exports = { SIZES, dib, ico };
