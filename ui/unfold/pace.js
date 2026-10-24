'use strict';
/* pace.js - frame pacing of the full-screen unfold on THIS machine's GPU (lane unfold-unlock, 2026-10-23).
 *
 *   npx electron ui/unfold/pace.js --test [--tech=layers|css|both] [--runs=6]
 *   -> one line per technique: "UNFOLD PACE <tech>: frames, p50/p95/max ms, long frames, dropped"
 *
 * A window the size of the primary display (1920x1080 at 125 % here) loads ui/unfold/index.html?bench=
 * and plays N full unfolds over a DRAWN desktop (no picture of the user's screen is taken or kept).
 * --test makes the window invisible and click-through (lib/test-quiet.js: layered alpha 0, never
 * activated); Chromium still renders every frame on the GPU, so requestAnimationFrame deltas are the
 * real cost. 'css' is the contract's first technique (clip-path + an animated filter: blur on one
 * full-screen picture); 'layers' is what the overlay uses (transform/opacity only, pre-blurred copies).
 * Run it under the machine's test gate (one Electron instance, RAM checked). */
require('../../lib/test-quiet').install(process.argv, process.env);
const path = require('path');
const { app, BrowserWindow, screen } = require('electron');

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const TECHS = arg('tech', 'both') === 'both' ? ['css', 'layers'] : [arg('tech', 'layers')];
const RUNS = parseInt(arg('runs', '6'), 10) || 6;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const OUT = arg('out', '');
process.on('unhandledRejection', (e) => { process.stdout.write(`UNFOLD PACE: FAILED ${String((e && e.stack) || e)}\n`); app.exit(2); });
// destroying the first technique's window must not quit the app (Electron quits when the last window closes)
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const d = screen.getPrimaryDisplay();
  const out = [];
  for (const tech of TECHS) {
    const win = new BrowserWindow({ x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height, show: false,
      frame: false, transparent: true, skipTaskbar: true, focusable: false, hasShadow: false, resizable: false,
      webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } });
    win.setIgnoreMouseEvents(true);
    await win.loadFile(path.join(__dirname, 'index.html'), { query: { bench: tech, runs: String(RUNS) } });
    win.showInactive();
    const t0 = Date.now();
    let res = null;
    while (Date.now() - t0 < 60000) {
      res = await win.webContents.executeJavaScript('window.__bench && window.__bench.done ? window.__bench : null');
      if (res) break;
      await sleep(300);
    }
    win.destroy();
    if (!res) { out.push(`UNFOLD PACE ${tech}: NO RESULT (the bench did not finish in 60 s)`); continue; }
    const r = res.results.filter(Boolean);
    const all = { frames: 0, long: 0, dropped: 0, p95: [], max: [], p50: [] };
    r.forEach((x) => { all.frames += x.frames; all.long += x.long; all.dropped += x.dropped; all.p95.push(x.p95); all.max.push(x.max); all.p50.push(x.p50); });
    const med = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    out.push(`UNFOLD PACE ${tech}: ${r.length} runs at ${d.bounds.width}x${d.bounds.height} DIP x${d.scaleFactor}, ` +
      `${all.frames} frames, p50 ${med(all.p50)} ms, p95 median ${med(all.p95)} ms (worst ${Math.max(...all.p95)}), ` +
      `max ${Math.max(...all.max)} ms, long frames ${all.long}, dropped ${all.dropped} (vsync ${r[0] && r[0].vsync} ms)`);
    out.push(`  per run: ${r.map((x) => `${x.frames}f/p95 ${x.p95}/max ${x.max}/drop ${x.dropped}`).join(' | ')}`);
    await sleep(800);
  }
  const text = out.join('\n') + '\n';
  if (OUT) require('fs').writeFileSync(OUT, text);
  process.stdout.write(text, () => app.exit(0));
});
