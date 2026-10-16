require('C:/Users/user/dev-tools/tools/lowcpu.js');
/*
 * tools/measure-emoji-glyphs.js - which emoji SEQUENCES Segoe UI Emoji draws as one picture (lane
 * mantle-emoji, 2026-10-15). A ZWJ sequence, a keycap, a flag or a toned person is one picture only
 * if the font has a ligature for it, and the font's GSUB (chained contexts, then ligatures) is a
 * shaper's job: so Chromium's own HarfBuzz shapes each one with the real font on a canvas, and a
 * sequence that comes out as one emoji's width is one picture (an unsupported one is two or more
 * pictures side by side, or letters: Windows draws no country flags). Headless, file-less, offline.
 *
 *   node tools/measure-emoji-glyphs.js --src=<dir with emoji-test.txt> --out=<json>
 * then: node tools/build-emoji-data.js --src=<dir> --glyphs=<json>
 */
'use strict';
const fs = require('fs');

const arg = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
const SRC = arg('src'), OUT = arg('out');
if (!SRC || !OUT) { console.error('usage: node tools/measure-emoji-glyphs.js --src=<dir> --out=<json>'); process.exit(2); }

let chromium = null;
for (const c of ['C:/Users/user/other-app/node_modules/playwright-core', 'C:/Users/user/Downloads/other-app/node_modules/playwright-core', 'playwright-core']) {
  try { chromium = require(c).chromium; break; } catch (_) { /* next */ }
}

(async () => {
  if (!chromium) { console.error('playwright-core not found'); process.exit(1); }
  const seqs = [];
  for (const line of fs.readFileSync(require('path').join(SRC, 'emoji-test.txt'), 'utf8').split(/\r?\n/)) {
    const m = /^([0-9A-F ]+?)\s*;\s*fully-qualified/.exec(line);
    if (!m) continue;
    const cp = m[1].trim().split(/\s+/).map((h) => parseInt(h, 16));
    if (cp.filter((c) => c !== 0xFE0F).length > 1) seqs.push(String.fromCodePoint(...cp));
  }
  const browser = await require('../ui/settings/test-browser.js').launch(chromium, { headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<canvas id="c" width="10" height="10"></canvas>');
    const res = await page.evaluate((list) => {
      const g = document.getElementById('c').getContext('2d');
      g.font = '40px "Segoe UI Emoji"';
      const ref = g.measureText('\u{1F600}').width;
      const one = [];
      for (const s of list) if (g.measureText(s).width < ref * 1.4) one.push(s);
      return { ref, one };
    }, seqs);
    fs.writeFileSync(OUT, JSON.stringify({ font: 'Segoe UI Emoji', measured: seqs.length, ref: res.ref, one: res.one }));
    console.log(`MEASURE EMOJI: ${seqs.length} sequences, ${res.one.length} draw as one picture (ref width ${res.ref.toFixed(1)} px) -> ${OUT}`);
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
