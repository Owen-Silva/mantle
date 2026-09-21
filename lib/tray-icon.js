'use strict';
/*
 * electron is required lazily: plain `node` resolving 'electron' gets the npm
 * package's index.js, which can start the Electron installer. squareBitmap()
 * below is pure arithmetic and stays testable under node on its own.
 */

/*
 * The notification-area icon, drawn in code.
 *
 * WHY drawn rather than shipped as a .png: the icon has to be the accent colour
 * from ui/shared/tokens.css and nothing else, and a binary asset in the repo is a
 * second place that colour lives -- it would silently drift the first time the
 * palette moves. nativeImage.createFromBitmap takes raw BGRA, so a rounded square
 * is twenty lines of arithmetic and no build step.
 *
 * Coverage is sampled 3x3 per pixel, which is enough anti-aliasing for a 16px
 * square and costs microseconds, once, at startup.
 */

const ION = { r: 0x72, g: 0xad, b: 0xca };   // --ion

/** Coverage 0..1 of a pixel by a rounded rectangle, sampled 3x3. */
function coverage(px, py, x0, y0, x1, y1, radius) {
  let hits = 0;
  for (let sy = 0; sy < 3; sy++) {
    for (let sx = 0; sx < 3; sx++) {
      const x = px + (sx + 0.5) / 3;
      const y = py + (sy + 0.5) / 3;
      if (x < x0 || x > x1 || y < y0 || y > y1) continue;
      // Corner test: outside the rounded corner circle means outside the shape.
      const cx = x < x0 + radius ? x0 + radius : (x > x1 - radius ? x1 - radius : x);
      const cy = y < y0 + radius ? y0 + radius : (y > y1 - radius ? y1 - radius : y);
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= radius * radius) hits++;
    }
  }
  return hits / 9;
}

/** A size x size BGRA buffer holding a rounded square in --ion on transparent. */
function squareBitmap(size) {
  const inset = Math.max(1, Math.round(size / 16));
  const radius = Math.max(2, Math.round(size / 4));
  const buf = Buffer.alloc(size * size * 4);
  const x0 = inset;
  const y0 = inset;
  const x1 = size - inset;
  const y1 = size - inset;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const a = coverage(x, y, x0, y0, x1, y1, radius);
      const i = (y * size + x) * 4;
      // Premultiplied BGRA: Windows composites the tray icon itself and expects
      // the colour channels already scaled by alpha.
      buf[i + 0] = Math.round(ION.b * a);
      buf[i + 1] = Math.round(ION.g * a);
      buf[i + 2] = Math.round(ION.r * a);
      buf[i + 3] = Math.round(255 * a);
    }
  }
  return buf;
}

/** The tray image, with a 2x representation so a scaled display stays crisp. */
function trayImage() {
  if (!process.versions.electron) throw new Error('the tray icon can only be built inside Electron');
  const { nativeImage } = require('electron');
  const img = nativeImage.createFromBitmap(squareBitmap(16), { width: 16, height: 16 });
  try {
    img.addRepresentation({ scaleFactor: 2, width: 32, height: 32, buffer: squareBitmap(32) });
  } catch (_) {
    // A representation that will not attach is cosmetic; the 1x icon still shows.
  }
  return img;
}

module.exports = { trayImage, squareBitmap };
