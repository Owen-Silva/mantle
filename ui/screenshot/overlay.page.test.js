require('C:/Users/user/dev-tools/tools/lowcpu.js');
/* overlay.page.test.js - the screenshot overlay (index.html + overlay.js, on mock-mantle.js) when the
 * frozen frame of the screen will not decode (lane pagewords, 2026-10-14). A REAL broken image: a PNG
 * cut off after its header, handed over as the frame's data URL, so Chromium's own decode() fails.
 * The screen must say what happened and what to do in plain words; the browser's reason (with its
 * name, from lib/plain-error.js forLog) goes to main in ready.problem, which main writes to mantle.log.
 *   node ui/screenshot/overlay.page.test.js   -> "OVERLAY PAGE TEST: n passed, m failed"
 */
'use strict';
const path = require('path');

let chromium = null;
for (const c of ['C:/Users/user/other-app/node_modules/playwright-core', 'C:/Users/user/Downloads/other-app/node_modules/playwright-core', 'playwright-core']) { try { chromium = require(c).chromium; break; } catch (e) { /* next */ } }
const PAGE = 'file:///' + path.join(__dirname, 'index.html').replace(/\\/g, '/');
let passed = 0;
const failures = [];
const check = (name, ok, detail) => { if (ok) passed++; else failures.push(detail !== undefined ? `${name} (${String(detail).slice(0, 300)})` : name); return ok; };
const JARGON = /EncodingError|DOMException|decode\(\)|cannot be decoded|source image|0x[0-9a-f]{4,}|undefined|\[object/i;

async function main() {
  if (!chromium) { console.log('OVERLAY PAGE TEST: 0 passed, 1 failed (playwright-core not found)'); process.exit(1); }
  const browser = await require('../settings/test-browser.js').launch(chromium, { headless: true });
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(PAGE, { waitUntil: 'load' });
    check('a good frame is ready first', await page.waitForFunction(() => window.__mock.ready && window.__mock.ready.seq === 1, null, { timeout: 5000 }).then(() => true, () => false));
    check('the good frame has no problem', await page.evaluate(() => !window.__mock.ready.problem && document.getElementById('problem').hidden));

    // the broken frame: an 8-byte PNG signature plus half an IHDR chunk, nothing else
    const broken = 'data:image/png;base64,' + Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0]).toString('base64');
    await page.evaluate((src) => window.__mockEmit('screenshot.frame', Object.assign({}, window.__mock.frame, { seq: 2, src })), broken);
    const gotReady = await page.waitForFunction(() => window.__mock.ready && window.__mock.ready.seq === 2, null, { timeout: 5000 }).then(() => true, () => false);
    check('the broken frame still reports ready (main is never left waiting)', gotReady);
    const r = await page.evaluate(() => ({ ready: window.__mock.ready, shown: !document.getElementById('problem').hidden, text: document.getElementById('problem').textContent }));
    check('the failure panel shows', r.shown, JSON.stringify(r));
    check('screen: plain words and what to do', /Mantle could not show the picture of this screen\. Press Esc and take the screenshot again\./.test(r.text), r.text);
    check('screen: no browser words or codes', !JARGON.test(r.text), r.text);
    const prob = r.ready && r.ready.problem;
    check('log: the browser\'s reason, with its name, goes to main (mantle.log)', /^the frozen frame of this screen could not be decoded \(EncodingError: .+\)$/.test(prob || ''), prob);
    check('log: no file address in it', !/file:|data:image/.test(prob || ''), prob);
    // RAW PIXELS (lane speeddebt): main's ImageData bytes go on a canvas, no decode; bad bytes fall back.
    await page.goto(PAGE + '?raw=1', { waitUntil: 'load' });
    check('raw pixels: ready', await page.waitForFunction(() => window.__mock.ready && window.__mock.ready.seq === 1, null, { timeout: 5000 }).then(() => true, () => false));
    const rp = await page.evaluate(() => {
      const c = document.querySelector('canvas[aria-hidden="true"]');
      const f = window.__mock.frame.pixels;
      const d = c ? c.getContext('2d', { alpha: false }).getImageData(5, 3, 1, 1).data : null;
      return { path: window.__mock.ready.path, cw: c && c.width, ch: c && c.height, w: f.w, h: f.h, px: d ? Array.from(d) : null,
        hidden: c ? c.hidden : null, img: document.getElementById('frame').hasAttribute('src'), problem: window.__mock.ready.problem || null };
    });
    check('raw pixels: drawn on the canvas, not decoded', rp.path === 'raw pixels' && !rp.img && !rp.problem, JSON.stringify(rp));
    check('raw pixels: the canvas is the frame\'s size and shown', rp.cw === rp.w && rp.ch === rp.h && rp.hidden === false, JSON.stringify(rp));
    check('raw pixels: the bytes land as they are (R = x, G = y, B = 77, opaque)', JSON.stringify(rp.px) === JSON.stringify([5, 3, 77, 255]), JSON.stringify(rp.px));
    await page.evaluate(() => window.__mockEmit('screenshot.clear', { seq: 1 }));
    const cl = await page.evaluate(() => { const c = document.querySelector('canvas[aria-hidden="true"]'); return { w: c.width, h: c.height, hidden: c.hidden }; });
    check('parked: the canvas keeps no picture of the screen (0x0, hidden)', cl.w === 0 && cl.h === 0 && cl.hidden === true, JSON.stringify(cl));
    await page.goto(PAGE + '?raw=bad', { waitUntil: 'load' });
    check('bad raw pixels: still ready', await page.waitForFunction(() => window.__mock.ready && window.__mock.ready.seq === 1, null, { timeout: 5000 }).then(() => true, () => false));
    const bp = await page.evaluate(() => ({ path: window.__mock.ready.path, img: document.getElementById('frame').hasAttribute('src'), problem: window.__mock.ready.problem || null }));
    check('bad raw pixels: the picture is decoded instead, and the reason is said', /^BMP decode \(raw pixels failed: .+\)$/.test(bp.path || '') && bp.img && !bp.problem, JSON.stringify(bp));
    check('no page errors', errors.length === 0, errors.join(' | '));
  } catch (e) {
    check('ran to the end', false, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' / ') : e);
  } finally {
    await browser.close();
  }
  for (const f of failures) console.log('FAIL ' + f);
  console.log(`OVERLAY PAGE TEST: ${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
}
main();
