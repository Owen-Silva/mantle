'use strict';
/* pace.js - frame pacing of the full-screen unfold on THIS machine's GPU (lane unfold-unlock, 2026-10-23).
 *
 *   npx electron ui/unfold/pace.js --test [--tech=gl|layers|css|both|all] [--runs=6] [--idle=3000]
 *   -> per technique: "UNFOLD PACE <tech>: ..." (every run), "UNFOLD PACE <tech> first: ..." (the first play
 *      after the page sat parked --idle ms, as the overlay does for hours) and "... warm: ..." (the rest)
 *
 * A window the size of the primary display (1920x1080 at 125 % here) loads ui/unfold/index.html?bench=
 * and plays N full unfolds over a DRAWN desktop (no picture of the user's screen is taken or kept).
 * --test makes the window invisible and click-through (lib/test-quiet.js: layered alpha 0, never
 * activated); Chromium still renders every frame on the GPU, so requestAnimationFrame deltas are the
 * real cost. 'gl' is what the overlay ships (the iPhone Duo look per pixel in WebGL over pre-blurred
 * levels); 'layers' is its fallback (transform/opacity over pre-blurred copies); 'css' is the contract's
 * element technique on one full-screen picture (clip-path + an animated filter: blur). Every play is
 * followed by a park, as main does, so every play builds its picture again.
 * Run it under the machine's test gate (one Electron instance, RAM checked). */
require('../../lib/test-quiet').install(process.argv, process.env);
const path = require('path');
const { app, BrowserWindow, screen } = require('electron');

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const TA = arg('tech', 'both');
const TECHS = TA === 'both' ? ['gl', 'layers'] : (TA === 'all' ? ['gl', 'layers', 'css'] : TA.split(','));
const IDLE = parseInt(arg('idle', '3000'), 10) || 3000;
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
    await win.loadFile(path.join(__dirname, 'index.html'), { query: { bench: tech, runs: String(RUNS), idle: String(IDLE) } });
    win.showInactive();
    const t0 = Date.now();
    let res = null;
    while (Date.now() - t0 < 60000 + IDLE) {
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
    out.push(`  per run: ${r.map((x) => `${x.frames}f/p95 ${x.p95}/max ${x.max}/drop ${x.dropped}/prep ${x.prepMs}`).join(' | ')}`);
    const one = (x) => `${x.frames} frames, p50 ${x.p50} ms, p95 ${x.p95} ms, max ${x.max} ms, long ${x.long}, dropped ${x.dropped}, prep ${x.prepMs} ms` + (x.technique && x.technique !== tech ? ` (drawn by ${x.technique}: ${x.fallback || 'no reason'})` : '');
    if (r[0]) out.push(`UNFOLD PACE ${tech} first: ${one(r[0])} (after ${IDLE} ms parked; gl warm-up at load ${res.gl && res.gl.warmMs} ms, WebGL ${res.gl && res.gl.version})`);
    const w = r.slice(1);
    if (w.length) out.push(`UNFOLD PACE ${tech} warm: ${w.length} runs, frames ${w.reduce((t, x) => t + x.frames, 0)}, p95 median ${med(w.map((x) => x.p95))} ms, max ${Math.max(...w.map((x) => x.max))} ms, long ${w.reduce((t, x) => t + x.long, 0)}, dropped ${w.reduce((t, x) => t + x.dropped, 0)}, prep median ${med(w.map((x) => x.prepMs || 0))} ms`);
    await sleep(800);
  }
  const text = out.join('\n') + '\n';
  if (OUT) require('fs').writeFileSync(OUT, text);
  process.stdout.write(text, () => app.exit(0));
});
