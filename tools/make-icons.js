/* make-icons.js - Mantle's app icons: SVG sources -> PNGs at every size -> multi-size .ico.
 *
 * LINE 1 of the work below is not optional: lowcpu.js pins this process (and the headless browser
 * it spawns) to a few cores at below-normal priority and takes the machine-wide one-browser lock,
 * the same as ui/bar/shoot.js.
 *
 *   node tools/make-icons.js                  render + pack every icon in ICONS
 *   node tools/make-icons.js --sheet=<png>    also a contact sheet: each icon at every size, on
 *                                             white and on the bar's glass colour
 *
 * WHY THESE WINDOWS NEED THEIR OWN ICONS (icons lane, 2026-09-28). Owen: "they need to have there
 * own icons that replace windows icons not just be electron". Mantle Settings and Mantle Task
 * Manager are electron.exe windows, and everything that draws a window's icon (Windows' own
 * taskbar and Alt+Tab, Mantle's bar, switcher and launcher) fell back to electron.exe's icon.
 * The windows now carry these files (BrowserWindow `icon` + setAppDetails appIconPath) and
 * Mantle's surfaces map the two titles to them (lib/mantle-apps.js).
 *
 * THE DRAWINGS (assets/icons/*.svg): one plate, the bar's accent (--lg-acc #4436E8 in
 * ui/shared/glass-light.css), with a white glyph; a gear for Settings, an activity pulse for the
 * task manager. Flat, no glow. 32 px and up render the master drawing; 16-24 px render the
 * `-small.svg` drawing, which is the same icon hinted to a 16 px grid (fewer, wider gear teeth; the
 * pulse's flat runs on a pixel row), because the master at 16 px blurs into a disc.
 *
 * OUTPUT, beside the SVGs (committed, so Mantle never renders at run time):
 *   <name>.ico         16 20 24 32 40 48 64 256, every entry a PNG (Vista+ reads PNG entries)
 *   <name>.png         256 px
 *   png/<name>-<n>.png every size on its own (the bar and launcher read the 32 and 64)
 *
 * The renderer is the ms-playwright headless Chromium through playwright-core, borrowed from
 * another project on this machine exactly as ui/bar/shoot.js does (this repo ships no browser).
 */
'use strict';
require('C:/Users/user/dev-tools/tools/lowcpu.js');

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'assets', 'icons');
const SIZES = [16, 20, 24, 32, 40, 48, 64, 256];
const SMALL_MAX = 24;                      // 16, 20, 24 use the hinted drawing
const ICONS = ['mantle-settings', 'mantle-taskmgr', 'mantle-files'];   // one per lib/mantle-apps.js APPS entry

/* The bar's glass as it reads on screen: --lg-fill (white at .45) over a mid wallpaper. */
const GLASS = '#C9CEDB';

const PW_CANDIDATES = [
  'C:/Users/user/other-app/node_modules/playwright-core',
  'C:/Users/user/Downloads/other-app/node_modules/playwright-core',
  'playwright-core',
];

function loadChromium() {
  for (const c of PW_CANDIDATES) {
    try { return require(c).chromium; } catch (_) { /* the next one */ }
  }
  throw new Error('playwright-core not found. Tried:\n  ' + PW_CANDIDATES.join('\n  '));
}

function findChrome() {
  const base = 'C:/Users/user/AppData/Local/ms-playwright';
  const dirs = fs.existsSync(base) ? fs.readdirSync(base) : [];
  for (const d of dirs.filter((n) => n.startsWith('chromium_headless_shell-')).sort().reverse()) {
    for (const sub of ['chrome-headless-shell-win64/chrome-headless-shell.exe', 'chrome-win/headless_shell.exe']) {
      const p = path.join(base, d, sub);
      if (fs.existsSync(p)) return p;
    }
  }
  for (const d of dirs.filter((n) => n.startsWith('chromium-')).sort().reverse()) {
    for (const sub of ['chrome-win/chrome.exe', 'chrome-win64/chrome.exe']) {
      const p = path.join(base, d, sub);
      if (fs.existsSync(p)) return p;
    }
  }
  throw new Error('no ms-playwright Chromium under ' + base);
}

function svgFor(name, size) {
  const small = path.join(DIR, name + '-small.svg');
  const file = size <= SMALL_MAX && fs.existsSync(small) ? small : path.join(DIR, name + '.svg');
  // sized by the page, not by the file: strip the fixed width/height off the root element
  return fs.readFileSync(file, 'utf8').replace(/<svg([^>]*?)\s+width="[^"]*"\s+height="[^"]*"/, '<svg$1')
    .replace('<svg', '<svg width="' + size + '" height="' + size + '" style="display:block"');
}

/* ICO = ICONDIR (6 bytes) + one ICONDIRENTRY (16 bytes) per image + the images. An entry's image
   may be a whole PNG file; width/height 0 means 256. */
function packIco(pngs) {
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);                // 1 = icon
  head.writeUInt16LE(pngs.length, 4);
  let offset = head.length;
  pngs.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i;
    head.writeUInt8(size >= 256 ? 0 : size, e);
    head.writeUInt8(size >= 256 ? 0 : size, e + 1);
    head.writeUInt8(0, e + 2);             // no palette
    head.writeUInt8(0, e + 3);
    head.writeUInt16LE(1, e + 4);          // planes
    head.writeUInt16LE(32, e + 6);         // bits per pixel
    head.writeUInt32LE(data.length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([head].concat(pngs.map((p) => p.data)));
}

/* Read back what packIco wrote, so a bad pack fails here and not as a blank icon in Windows. */
function readIco(buf) {
  if (buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) throw new Error('not an ICO header');
  const n = buf.readUInt16LE(4);
  const out = [];
  for (let i = 0; i < n; i++) {
    const e = 6 + 16 * i;
    const size = buf.readUInt8(e) || 256;
    const len = buf.readUInt32LE(e + 8);
    const at = buf.readUInt32LE(e + 12);
    const data = buf.subarray(at, at + len);
    if (data.readUInt32BE(0) !== 0x89504e47) throw new Error('entry ' + i + ' is not a PNG');
    const w = data.readUInt32BE(16), h = data.readUInt32BE(20);
    if (w !== size || h !== size) throw new Error('entry ' + i + ' says ' + size + ' px but its PNG is ' + w + 'x' + h);
    out.push(size);
  }
  return out;
}

async function render(page, name, size) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent('<!doctype html><html><head><style>html,body{margin:0;background:transparent}</style></head><body>' +
    svgFor(name, size) + '</body></html>');
  return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}

async function sheet(page, file) {
  // each size at 1:1, then 16-32 again at 4x (pixelated) so the hinting can be judged, 256 at half
  const src = (name, size) => 'data:image/png;base64,' + fs.readFileSync(path.join(DIR, 'png', name + '-' + size + '.png')).toString('base64');
  const cell = (name, size, bg, zoom, label) => '<div class="c" style="background:' + bg + '"><img src="' + src(name, size) +
    '" width="' + Math.round(size * zoom) + '" height="' + Math.round(size * zoom) + '"' + (zoom > 1 ? ' class="z"' : '') + '><span>' + label + '</span></div>';
  const rows = [];
  for (const bg of [['white', '#FFFFFF'], ['bar glass', GLASS]]) {
    for (const name of ICONS) {
      rows.push('<div class="r"><b>' + name + '<br><i>on ' + bg[0] + '</i></b>' +
        SIZES.filter((s) => s <= 64).map((s) => cell(name, s, bg[1], 1, s)).join('') +
        [16, 20, 24, 32].map((s) => cell(name, s, bg[1], 4, s + ' x4')).join('') +
        cell(name, 256, bg[1], 0.5, '256 at half') + '</div>');
    }
  }
  await page.setViewportSize({ width: 1400, height: 800 });
  await page.setContent('<!doctype html><html><head><style>' +
    'body{margin:0;padding:16px;background:#F4F6FA;font:12px Segoe UI,sans-serif;color:#333A4E}' +
    '.r{display:flex;align-items:flex-end;gap:10px;margin-bottom:12px}' +
    'b{width:120px;font-weight:600}i{font-weight:400;color:#5B6478}' +
    '.c{display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:4px;padding:8px;border-radius:8px;min-width:28px}' +
    'img.z{image-rendering:pixelated}span{font-size:10px;color:#5B6478}' +
    '</style></head><body>' + rows.join('') + '</body></html>');
  const box = await page.evaluate(() => { const r = document.body.getBoundingClientRect(); return { w: Math.ceil(r.width), h: Math.ceil(document.body.scrollHeight) }; });
  await page.screenshot({ path: file, clip: { x: 0, y: 0, width: box.w, height: box.h } });
}

async function main() {
  const sheetArg = process.argv.find((a) => a.startsWith('--sheet='));
  const chromium = loadChromium();
  const browser = await chromium.launch({ executablePath: findChrome(), headless: true });
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    fs.mkdirSync(path.join(DIR, 'png'), { recursive: true });
    for (const name of ICONS) {
      const pngs = [];
      for (const size of SIZES) {
        const data = await render(page, name, size);
        fs.writeFileSync(path.join(DIR, 'png', name + '-' + size + '.png'), data);
        pngs.push({ size, data });
      }
      fs.writeFileSync(path.join(DIR, name + '.png'), pngs[pngs.length - 1].data);
      const ico = packIco(pngs);
      const got = readIco(ico);
      fs.writeFileSync(path.join(DIR, name + '.ico'), ico);
      console.log('make-icons: ' + name + '.ico ' + got.join(' ') + ' px, ' + ico.length + ' bytes; ' + name + '.png 256 px');
    }
    if (sheetArg) {
      const file = path.resolve(sheetArg.slice('--sheet='.length));
      await sheet(page, file);
      console.log('make-icons: contact sheet ' + file);
    }
  } finally {
    await browser.close();
  }
}

if (require.main === module) {
  main().catch((err) => { console.error('make-icons FAILED: ' + (err && err.stack || err)); process.exit(1); });
}

module.exports = { packIco, readIco, SIZES, ICONS };
