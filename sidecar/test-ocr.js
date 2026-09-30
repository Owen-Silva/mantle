// test-ocr.js - Copy text's engine, for real: Windows' OCR (sidecar/Ocr.cs) reading KNOWN text that
// this test draws into a SYNTHETIC frozen frame (`shot.grab` synthetic + text), through the same
// `shot.ocr` crop-from-memory path the overlay uses. Plain node.
//
//   MANTLE_SIDECAR_EXE=<exe> node sidecar/test-ocr.js      (or --exe=<path>)
//
// PRIVACY, the lane's hard rule: no pixel of the screen is read (every grab is synthetic) and the
// recognised text is compared IN MEMORY: this prints scores, counts and timings, never the text,
// and writes no file but the grab's own temp frames, which are released and deleted.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const T = require('./test-lib');
const X = require('../lib/features/_ocr-text.js');

const LINES = [
  'Question 7: A train leaves the station at 3:45 PM',
  'traveling 62 miles per hour. How far has it gone',
  'by 6:15 PM? Show your work (round to 0.1 mi).',
];
const WORDS = /train|station|miles|Show your work|prime number/i;   // must never appear in a log

(async () => {
  const t = T.checker('OCR');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-ocr-test-'));
  let s = null;
  try {
    s = await T.startPassive();
    // 1. The engine and its languages.
    const st = await s.send('ocr.status', {}, 15000);
    const r0 = st.result || {};
    t.check('ocr.status answers', st.ok === true, JSON.stringify(st).slice(0, 300));
    t.check('Windows\' OCR is available in process (via winrt)', r0.available === true && r0.via === 'winrt', JSON.stringify(r0));
    t.check('the engine has a language, and it is one of the installed ones', !!r0.lang && (r0.langs || []).includes(r0.lang), JSON.stringify(r0));
    // A missing engine is asked again, not remembered for the sidecar's life (a language added in
    // Windows Settings used to need a Mantle restart): the status says how soon (lane capture-shot).
    t.check('ocr.status says a missing engine is retried within a minute', r0.retryMs > 0 && r0.retryMs <= 60000, JSON.stringify({ retryMs: r0.retryMs }));
    console.log(`  OCR languages installed: ${(r0.langs || []).join(', ') || 'none'}; engine: ${r0.lang}; max image side ${r0.maxDim} px; engine made in ${r0.engineMs} ms`);

    // 2. The round trip: 3 lines of 16 px Segoe UI (screen-sized text) on a big white box.
    const at = { x: 60, y: 60 };
    const g = await s.send('shot.grab', { dir, synthetic: true, text: LINES, textAt: at, textPx: 16, textPad: 300 }, 15000);
    t.check('a synthetic grab with text draws it and says where', g.ok && g.result.synthetic === true && !!g.result.textBox, JSON.stringify(g).slice(0, 300));
    const box = g.ok ? g.result.textBox : { x: 0, y: 0, w: 10, h: 10 };
    const tx = box.x + 300, ty = box.y + 300;                    // where the text starts (inside the pad)
    const lh = g.ok ? g.result.textBox.lineH : 21;
    const want = LINES.join('\n');
    const runs = [];
    for (let i = 0; i < 3; i++) {
      const r = await s.send('shot.ocr', { grab: g.result.grab, x: tx - 40, y: ty - 30, w: 520, h: Math.ceil(3 * lh) + 60 }, 20000);
      runs.push(r);
    }
    const r1 = runs[0];
    const shaped = r1.ok ? X.shape(r1.result.lines) : { text: '', lines: 0 };
    const acc = X.similarity(shaped.text.replace(/\r\n/g, '\n'), want);
    t.check('shot.ocr reads the drawn text (3 lines)', r1.ok && shaped.lines === 3, r1.ok ? `${shaped.lines} lines` : r1.error);
    t.check('recognised vs expected: at least 97% of characters right', acc >= 0.97, `${(acc * 100).toFixed(1)}%`);
    t.check('every line has a box inside the crop (for paragraph gaps)', r1.ok && r1.result.lines.every((l) => l.h > 0 && l.w > 0 && l.y >= 0 && l.x >= 0 && l.y + l.h <= r1.result.h + 1), '');
    t.check('the reply says the scale, the language and its timings', r1.ok && r1.result.scale === 2 && r1.result.lang === r0.lang && r1.result.ms && r1.result.ms.ocr > 0, JSON.stringify(r1.ok && { scale: r1.result.scale, lang: r1.result.lang, ms: r1.result.ms }));
    const warm = runs.filter((r) => r.ok).map((r) => r.result.ms.total);
    console.log(`  ROUND TRIP (16 px, 3 lines, ${r1.ok ? `${r1.result.w}x${r1.result.h}` : '?'} crop): ${(acc * 100).toFixed(1)}% of characters right, exact=${shaped.text.replace(/\r\n/g, '\n') === want}; ` +
      `shot.ocr total ${warm.map((m) => Math.round(m)).join(' / ')} ms (first / warm), ocr alone ${runs.filter((r) => r.ok).map((r) => Math.round(r.result.ms.ocr)).join(' / ')} ms`);

    // 3. Nothing there: a white part of the same frame -> no lines, and the shaping says so.
    const blank = await s.send('shot.ocr', { grab: g.result.grab, x: tx, y: ty + Math.ceil(4 * lh) + 20, w: 400, h: 150 }, 20000);
    const bs = blank.ok ? X.shape(blank.result.lines) : null;
    t.check('an area with no text: 0 lines, "No text found in that area"', blank.ok && bs.lines === 0 && bs.text === '' && X.headline(bs) === 'No text found in that area', blank.ok ? `${bs.lines} lines` : blank.error);

    // 4. Refusals in plain words.
    const tiny = await s.send('shot.ocr', { grab: g.result.grab, x: tx, y: ty, w: 5, h: 5 }, 8000);
    t.check('a 5x5 selection is refused in plain words', !tiny.ok && /too small/.test(tiny.error), tiny.error);
    const outside = await s.send('shot.ocr', { grab: g.result.grab, x: box.x - 1e6, y: 0, w: 50, h: 50 }, 8000);
    t.check('a rect outside the capture is refused', !outside.ok && /outside the capture/.test(outside.error), outside.error);

    // 5. A whole monitor (the pattern + the text), for the worst-case time of a big drag.
    const mon = (g.result.monitors || []).find((m) => m.primary) || (g.result.monitors || [])[0];
    if (mon) {
      const big = await s.send('shot.ocr', { grab: g.result.grab, x: mon.x, y: mon.y, w: mon.w, h: mon.h }, 30000);
      t.check('a whole-monitor selection is read too (under 3 s)', big.ok && big.result.ms.total < 3000, big.ok ? `${Math.round(big.result.ms.total)} ms` : big.error);
      if (big.ok) console.log(`  whole monitor ${mon.w}x${mon.h}: ${Math.round(big.result.ms.total)} ms at ${big.result.scale}x (${big.result.lines.length} lines found, pattern included)`);
    }
    await s.send('shot.release', {}, 5000);
    const gone = await s.send('shot.ocr', { grab: g.result.grab, x: tx, y: ty, w: 100, h: 40 }, 8000);
    t.check('after shot.release the frame is gone (nothing to read)', !gone.ok && /is gone/.test(gone.error), gone.error);

    // 5b. A HUGE selection (lane capture-shot): an 8K desktop (7680x4320), all of it. 2x would pass the
    //     engine's 10000 px limit, so the scale must drop (Ocr.cs PickScale) and the text still read.
    const g8 = await s.send('shot.grab', { dir, synthetic: true, size: { w: 7680, h: 4320 }, text: LINES, textAt: { x: 3000, y: 2000 }, textPx: 24, textPad: 80 }, 30000);
    if (g8.ok) {
      const v = g8.result.virt;
      const huge = await s.send('shot.ocr', { grab: g8.result.grab, x: v.x, y: v.y, w: v.w, h: v.h }, 60000);
      const hs = huge.ok ? X.shape(huge.result.lines) : { text: '' };
      const hacc = X.similarity(hs.text.replace(/\r\n/g, '\n'), LINES.join('\n'));
      const found = LINES.every((l) => hs.text.includes(l.slice(0, 12)));
      t.check('an 8K whole-desktop selection: read at a smaller scale (under the engine limit), the text found, under 10 s',
        huge.ok && huge.result.scale <= 1.3 && found && huge.result.ms.ocr < 10000, huge.ok ? `scale ${huge.result.scale}, ${Math.round(huge.result.ms.ocr)} ms, text found ${found}` : huge.error);
      console.log(`  8K desktop 7680x4320: ${huge.ok ? `${Math.round(huge.result.ms.ocr)} ms ocr at ${huge.result.scale}x, drawn text found: ${found} (${(hacc * 100).toFixed(0)}% of all text incl. the pattern)` : huge.error}`);
      await s.send('shot.release', {}, 5000);
    } else t.check('8K synthetic grab', false, g8.error);

    // 5c. Non-English text through the installed engine (en-US here): accented Latin words. Windows
    //     reads what its language pack covers; this pins that it does not crash and prints how close.
    const INTL = ['Café crème, déjà vu, naïve façade', 'Größe: 12 Äpfel für Jürgen'];
    const gi = await s.send('shot.grab', { dir, synthetic: true, text: INTL, textAt: at, textPx: 20, textPad: 60 }, 15000);
    if (gi.ok) {
      const bi = gi.result.textBox;
      const ri = await s.send('shot.ocr', { grab: gi.result.grab, x: bi.x + 30, y: bi.y + 30, w: bi.w - 60, h: bi.h - 60 }, 20000);
      const si = ri.ok ? X.shape(ri.result.lines) : { text: '', lines: 0 };
      const acci = X.similarity(si.text.replace(/\r\n/g, '\n'), INTL.join('\n'));
      t.check('accented (non-English) Latin text: read, 2 lines, at least 80% right with the ' + (r0.lang || '?') + ' engine', ri.ok && si.lines === 2 && acci >= 0.8, ri.ok ? `${si.lines} lines, ${(acci * 100).toFixed(1)}%` : ri.error);
      console.log(`  accented Latin (${r0.lang}): ${(acci * 100).toFixed(1)}% right`);
      await s.send('shot.release', {}, 5000);
    } else t.check('accented synthetic grab', false, gi.error);

    // 6. Small text (13 px, what a dense page shows at 100%) and a paragraph gap.
    const Q = ['Which is a prime number?', '', 'A) 21', 'B) 23', 'C) 25'];
    const g2 = await s.send('shot.grab', { dir, synthetic: true, text: Q, textAt: at, textPx: 13, textPad: 60 }, 15000);
    if (g2.ok) {
      const b2 = g2.result.textBox;
      const r2 = await s.send('shot.ocr', { grab: g2.result.grab, x: b2.x + 30, y: b2.y + 30, w: b2.w - 60, h: b2.h - 60 }, 20000);
      const s2 = r2.ok ? X.shape(r2.result.lines) : { text: '', lines: 0 };
      const want2 = Q.join('\n');
      const acc2 = X.similarity(s2.text.replace(/\r\n/g, '\n'), want2);
      t.check('13 px text: 4 lines, at least 95% right', s2.lines === 4 && acc2 >= 0.95, `${s2.lines} lines, ${(acc2 * 100).toFixed(1)}%`);
      t.check('the empty line between question and choices comes back as a paragraph gap', /\r\n\r\n/.test(s2.text) && s2.text.split('\r\n')[1] === '', `${s2.text.split('\r\n').length} rows`);
      console.log(`  13 px question + choices: ${(acc2 * 100).toFixed(1)}% right, paragraph gap kept: ${s2.text.split('\r\n')[1] === ''}, ${r2.ok ? Math.round(r2.result.ms.total) : '?'} ms`);
      await s.send('shot.release', {}, 5000);
    } else t.check('second synthetic grab', false, g2.error);

    // 7. PRIVACY: nothing the sidecar logged or printed carries the text.
    const logs = s.collect('log').map((e) => String(e.message || '')).join('\n') + '\n' + (s.stderr || '');
    t.check('the sidecar logged none of the recognised text', !WORDS.test(logs), '(a log line matched a drawn word)');
    const left = fs.readdirSync(dir);
    t.check('no frame file is left behind after release', left.length === 0, left.join(','));
  } catch (e) {
    t.check('the test ran', false, e.message);
  } finally {
    if (s) await s.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  process.exit(t.summary());
})();
