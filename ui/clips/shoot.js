/* shoot.js - pictures of the Clips pages over file:// with mock-mantle.js (stand-in clips ONLY, drawn
 * here; never one of the user's captures). Headless Chromium, nothing on screen.
 *   node ui/clips/shoot.js [outDir] [theme]   -> clips-1.png (Record panel), clips-2.png (gallery)
 */
require('../../tools/dev-env.js').lowcpu();
const fs = require('fs');
const path = require('path');
let chromium;
({ chromium } = require('../../tools/dev-env.js').playwright());
const UI = 'file:///' + __dirname.replace(/\\/g, '/') + '/';
const OUT = path.resolve(process.argv[2] || path.join(require('os').tmpdir(), 'mantle-clips-shots'));
const THEME = process.argv[3] || 'dark';
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await require('../settings/test-browser.js').launch(chromium, { headless: true });
  try {
    // the Record panel, recording, with the region row: as tall as its card + the window's margin
    let ctx = await browser.newContext({ viewport: { width: 376, height: 400 }, deviceScaleFactor: 2, reducedMotion: 'reduce' });
    let page = await ctx.newPage();
    await page.goto(UI + `record.html?mock=recording&screenrec=1&theme=${THEME}`);
    await page.waitForFunction(() => window.__clipsPanel && window.__clipsPanel.state().shown);
    await page.waitForTimeout(400);
    const h = await page.evaluate(() => Math.ceil(document.getElementById('card').getBoundingClientRect().height) + 36);
    await page.setViewportSize({ width: 376, height: h });
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(OUT, 'clips-1.png') });
    await ctx.close();
    // the gallery: stand-in clips, hover on the first card
    ctx = await browser.newContext({ viewport: { width: 1180, height: 760 }, deviceScaleFactor: 1.5, reducedMotion: 'reduce' });
    page = await ctx.newPage();
    await page.goto(UI + `index.html?mock=gallery&theme=${THEME}`);
    await page.waitForFunction(() => window.__clips && window.__clips.state().painted >= 8);
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, 'clips-2.png') });
    await ctx.close();
    console.log(`CLIPS SHOTS: ${OUT}\\clips-1.png, clips-2.png (${THEME})`);
  } finally { await browser.close(); }
})().catch((e) => { console.log(`CLIPS SHOTS FAILED: ${e.stack}`); process.exitCode = 1; });
