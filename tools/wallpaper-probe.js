'use strict';
/*
 * wallpaper-probe.js -- TEST MODE ONLY. The checks behind lib/wallpaper.js's report: screenshots,
 * CPU and memory, the pause rules on synthetic windows, every web wallpaper, the Wallpapers window,
 * adding and removing. Loaded by lib/wallpaper.js when Mantle runs with --test AND the environment
 * variable MANTLE_WALL_PROBE names a directory for the screenshots; never otherwise.
 *
 *   MANTLE_WALL_PROBE=<dir> npx electron . --test --profile-name=wall
 *
 * It leaves the instance running when it is done (tools/kill-test.ps1 -Match wall stops it), and it
 * only ever moves or resizes ITS OWN test window, which toback.ps1 has already sent to the back.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, screen } = require('electron');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (s) => process.stdout.write(`wallprobe: ${s}\n`);

async function capture(win, dir, name) {
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(dir, `${name}.png`), img.toPNG());
  const sz = img.getSize();
  log(`wrote ${name}.png ${sz.width}x${sz.height}`);
  return img;
}

/** Fraction of sampled pixels that differ between two captures, over the right half (no panes). */
function motion(a, b) {
  const sa = a.getSize();
  const sb = b.getSize();
  if (sa.width !== sb.width || sa.height !== sb.height) return -1;
  const x0 = Math.floor(sa.width * 0.55);
  const A = a.crop({ x: x0, y: 0, width: sa.width - x0, height: sa.height }).toBitmap();
  const B = b.crop({ x: x0, y: 0, width: sa.width - x0, height: sa.height }).toBitmap();
  let diff = 0;
  let n = 0;
  for (let i = 0; i < A.length; i += 4 * 7) {
    n++;
    if (Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2]) > 24) diff++;
  }
  return n ? diff / n : 0;
}

/** CPU over `ms`, from each process's cumulative CPU seconds: % of the WHOLE machine, like Task Manager. */
// The desktop test window. A minimised window stops compositing, so every CPU line says whether it
// was on screen for the whole sample: a number from a minimised window measures nothing.
let WIN = null;
const shown = () => (!WIN || WIN.isDestroyed() ? 'no window' : (WIN.isMinimized() ? 'MINIMISED' : 'on screen'));

async function cpu(label, ms) {
  const cores = os.cpus().length;
  const before = shown();
  const first = new Map(app.getAppMetrics().map((p) => [p.pid, p]));
  const t0 = Date.now();
  await sleep(ms);
  const secs = (Date.now() - t0) / 1000;
  let total = 0;
  const parts = [];
  let priv = 0;
  for (const p of app.getAppMetrics()) {
    const a = first.get(p.pid);
    priv += p.memory.privateBytes || 0;
    if (!a || typeof p.cpu.cumulativeCPUUsage !== 'number') continue;
    const pct = (100 * (p.cpu.cumulativeCPUUsage - a.cpu.cumulativeCPUUsage)) / secs / cores;
    total += pct;
    parts.push(`${p.type}${p.name ? `(${p.name})` : ''} ${p.pid}: ${pct.toFixed(2)}%`);
  }
  const after = shown();
  log(`cpu ${label} [window ${before === after ? before : `${before} -> ${after}`}]: ${total.toFixed(2)}% of the machine (${cores} logical cores) over ${secs.toFixed(0)} s | ${parts.join(' | ')} | electron private total ${Math.round(priv / 1024)} MB`);
  return total;
}

async function js(win, code) {
  try { return await win.webContents.executeJavaScript(code, true); } catch (err) { return `executeJavaScript failed: ${err.message}`; }
}

const VIDEO_STATE = `(() => {
  const v = document.querySelector('#wall video');
  const pane = document.querySelector('.pane');
  const base = { hasWall: document.body.classList.contains('has-wall'), paneBackdrop: pane ? getComputedStyle(pane).backdropFilter : null,
    strip: document.getElementById('strip').hidden ? '' : document.getElementById('strip-list').innerText };
  if (!v) return Object.assign(base, { video: null, frame: !!document.querySelector('#wall iframe'), img: !!document.querySelector('#wall img') });
  const q = v.getVideoPlaybackQuality();
  return Object.assign(base, { t: +v.currentTime.toFixed(2), rate: v.playbackRate, paused: v.paused, w: v.videoWidth, h: v.videoHeight,
    frames: q.totalVideoFrames, dropped: q.droppedVideoFrames, filter: v.style.filter, fit: v.style.objectFit });
})()`;

async function waitFor(fn, ms, every = 500) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(every);
  }
  return null;
}

// MANTLE_WALL_PROBE_WEB=1: only this. When does a web wallpaper actually paint? Inside the frame a
// requestAnimationFrame counter says whether it is rendering at all; outside, the iframe's class and
// size; and (for one of them) the colours on the right half of a capture every half second.
const FRAME_JS = `(() => { if (!window.__pr) { window.__pr = { n: 0 }; const t = () => { window.__pr.n++; requestAnimationFrame(t); }; requestAnimationFrame(t); }
  return { raf: window.__pr.n, vis: document.visibilityState, rs: document.readyState, w: innerWidth, h: innerHeight }; })()`;
const OUTER_JS = `(() => { const f = document.querySelector('#wall iframe'); if (!f) return 'no iframe';
  const r = f.getBoundingClientRect(); return f.className + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) + ' vis=' + getComputedStyle(f).visibility; })()`;

function distinct(img) {
  const s = img.getSize();
  const x0 = Math.floor(s.width * 0.55);
  const B = img.crop({ x: x0, y: 0, width: s.width - x0, height: s.height }).toBitmap();
  const set = new Set();
  for (let i = 0; i < B.length; i += 4 * 97) set.add((B[i] << 16) | (B[i + 1] << 8) | B[i + 2]);
  return set.size;
}

async function webTiming(P, C, d, dir) {
  P.setOverride('play');
  for (const [id, everyTime] of [['4yvhquwl.pcv', false], ['abqqpcp4.hv3', true], ['lgz4xpht.sjn', false]]) {
    if (!P.S.lib.get(id)) continue;
    const t0 = Date.now();
    await C['wallpaper.set']({ id });
    for (let i = 0; i < 24; i++) {
      await sleep(500);
      const frame = d.webContents.mainFrame.framesInSubtree.find((f) => f.url && f.url.startsWith('mantle-wp:'));
      let inner = 'no frame';
      if (frame) { try { inner = JSON.stringify(await frame.executeJavaScript(FRAME_JS, true)); } catch (e) { inner = `js failed: ${e.message}`; } }
      const outer = await js(d, OUTER_JS);
      let px = '';
      if (everyTime || i === 23) px = ` distinct=${distinct(await d.webContents.capturePage())}`;
      const rt = P.S.runtime.get(id);
      log(`web timing ${id} +${((Date.now() - t0) / 1000).toFixed(1)}s: runtime=${rt ? rt.state : '-'} outer=${outer} inner=${inner}${px}`);
    }
    await capture(d, dir, `timing-${id}`);
  }
}

// MANTLE_WALL_PROBE_CPU=1: only the CPU figures, each one labelled with whether the window was on screen.
async function cpuOnly(P, C, d, dir) {
  P.setOverride('play');
  const def = P.S.lib.data.lively && P.S.lib.data.lively.current;
  if (def && P.S.lib.get(def)) await C['wallpaper.set']({ id: def });
  await sleep(6000);
  log(`video: ${JSON.stringify(await js(d, VIDEO_STATE)).slice(0, 400)}`);
  await cpu('video playing, test window', 20000);
  P.setOverride('pause');
  await sleep(2000);
  await cpu('video paused, test window', 20000);
  P.setOverride('play');
  const small = d.getBounds();
  const disp = screen.getPrimaryDisplay().bounds;
  d.setBounds({ x: disp.x, y: disp.y, width: disp.width, height: disp.height });
  await sleep(3000);
  log(`asked for ${disp.width}x${disp.height} at the display origin: got ${JSON.stringify(d.getBounds())}, page ${JSON.stringify(await js(d, '[innerWidth, innerHeight]'))}`);
  await capture(d, dir, 'cpu-full');
  await cpu('video playing, full display size', 20000);
  d.setBounds(small);
  for (const id of ['abqqpcp4.hv3', 'xn0quq52.bq2']) {
    if (!P.S.lib.get(id)) continue;
    await C['wallpaper.set']({ id });
    await sleep(6000);
    await capture(d, dir, `cpu-${id}`);
    await cpu(`web ${P.S.lib.get(id).title} playing, test window`, 20000);
    P.setOverride('pause');
    await sleep(2000);
    await cpu(`web ${P.S.lib.get(id).title} paused, test window`, 20000);
    P.setOverride('play');
  }
  if (def && P.S.lib.get(def)) await C['wallpaper.set']({ id: def });
  P.setOverride(null);
}

exports.run = async function run(api, dirArg) {
  const dir = path.resolve(dirArg);
  fs.mkdirSync(dir, { recursive: true });
  const P = api._probe;
  const C = P.COMMANDS;
  try {
    await sleep(2000);
    const d = P.desktopWin();
    if (!d) { log('no desktop window: nothing to probe'); return; }
    WIN = d;
    let feat = {};
    try { feat = app.getGPUFeatureStatus(); } catch (_) {}
    log(`gpu features: video_decode=${feat.video_decode} gpu_compositing=${feat.gpu_compositing} webgl=${feat.webgl}`);

    // 1. the import, then the default wallpaper playing
    const t0 = Date.now();
    const imported = await waitFor(() => P.S.lib && P.S.lib.data.lively && P.S.lib.data.lively.importedAt, 120000);
    log(`import ${imported ? 'finished' : 'DID NOT FINISH'} after ${((Date.now() - t0) / 1000).toFixed(1)} s: ${P.S.lib.data.lively ? P.S.lib.data.lively.report.reason : 'no report'}`);
    for (const l of (P.S.lib.data.lively && P.S.lib.data.lively.report.lines) || []) log(`  import ${l.livelyId} "${l.title}": ${l.ok ? 'ok' : 'FAILED'} - ${l.reason}`);
    log(`selected: ${P.S.lib.data.selected}`);
    if (process.env.MANTLE_WALL_PROBE_WEB) { await webTiming(P, C, d, dir); log('done'); return; }
    if (process.env.MANTLE_WALL_PROBE_CPU) { await cpuOnly(P, C, d, dir); log('done'); return; }

    // 2. the rules as they stand for whatever Owen has in front right now, then held playing
    await sleep(2500);
    log(`rules with the real foreground: paused=${P.S.pause.paused} reason="${P.S.pause.reason}" fgNote="${P.S.fgNote}"`);
    P.setOverride('play');
    const playing = await waitFor(async () => { const s = await js(d, VIDEO_STATE); return s && s.video !== null && s.hasWall && !s.paused && s.frames > 5 ? s : null; }, 30000);
    log(`default video state: ${JSON.stringify(playing || await js(d, VIDEO_STATE))}`);

    // 3. motion: two captures a second apart
    const a = await capture(d, dir, 'desktop-1');
    await sleep(1000);
    const b = await capture(d, dir, 'desktop-2');
    log(`motion between desktop-1 and desktop-2 (right half, no panes): ${(motion(a, b) * 100).toFixed(1)}% of sampled pixels changed`);

    // 4. CPU: playing at test size, playing at full screen size, paused
    await cpu('playing, 960x540 test window', 20000);
    const small = d.getContentBounds();
    const disp = screen.getPrimaryDisplay().bounds;
    d.setContentBounds({ x: small.x, y: small.y, width: disp.width, height: disp.height });
    await sleep(3000);
    log(`asked for a ${disp.width}x${disp.height} window, got ${JSON.stringify(d.getContentBounds())}; page ${JSON.stringify(await js(d, '[innerWidth, innerHeight]'))}`);
    log(`full-size video state: ${JSON.stringify(await js(d, VIDEO_STATE))}`);
    await capture(d, dir, 'desktop-full');
    await cpu(`playing, ${disp.width}x${disp.height} window`, 20000);
    P.setOverride('pause');
    await sleep(2000);
    log(`paused video state: ${JSON.stringify(await js(d, VIDEO_STATE))}`);
    await cpu(`paused, ${disp.width}x${disp.height} window`, 20000);
    d.setContentBounds(small);
    P.setOverride('play');
    await sleep(1500);

    // 5. the pause rules on synthetic foreground windows
    const sf = screen.getPrimaryDisplay().scaleFactor;
    const W0 = Math.round(disp.width * sf);
    const H0 = Math.round(disp.height * sf);
    // The once-a-second check would answer with Owen's REAL foreground in between: hold it.
    clearInterval(P.S.timers.fg);
    P.S.override = null;
    const cases = [
      ['a full-screen game', { hwnd: '1', exe: 'C:\\Games\\game.exe', title: 'Game', pid: 1, rect: [0, 0, W0, H0], fullscreen: true }],
      ['a maximised browser', { hwnd: '2', exe: 'C:\\x\\electron.exe', title: 'Browser', pid: 2, rect: [-8, -8, W0 + 8, H0 + 8], fullscreen: false }],
      ['a small window', { hwnd: '3', exe: 'C:\\x\\notepad.exe', title: 'notes', pid: 3, rect: [100, 100, 900, 700], fullscreen: false }],
      ['the desktop itself', { hwnd: '4', exe: 'C:\\Windows\\explorer.exe', title: 'Program Manager', pid: 4, rect: [0, 0, W0, H0], fullscreen: false }],
      ['a maximised File Explorer', { hwnd: '5', exe: 'C:\\Windows\\explorer.exe', title: 'Downloads', pid: 4, rect: [-8, -8, W0 + 8, H0 + 8], fullscreen: false }],
    ];
    for (const [label, fg] of cases) {
      P.decide(fg);
      log(`rule check, ${label}: paused=${P.S.pause.paused} unload=${P.S.pause.unload} reason="${P.S.pause.reason}"`);
    }
    P.decide({ hwnd: '1', exe: 'C:\\Games\\game.exe', title: 'Game', pid: 1, rect: [0, 0, W0, H0], fullscreen: true });
    await sleep(800);
    log(`desktop page after a synthetic full-screen game: ${JSON.stringify(await js(d, VIDEO_STATE))}`);
    P.setOverride('play');
    await sleep(1500);
    log(`desktop page after release: ${JSON.stringify(await js(d, VIDEO_STATE))}`);
    P.S.timers.fg = setInterval(() => { P.checkNow(); }, 1000);

    // 6. customised videos: speed and colour carried over from Lively
    for (const id of ['cs3hltvu.hyj', 'qd3zcg0v.zpb']) {
      if (!P.S.lib.get(id)) continue;
      await C['wallpaper.set']({ id });
      await sleep(4000);
      log(`video ${id} state: ${JSON.stringify(await js(d, VIDEO_STATE))}`);
    }
    await capture(d, dir, 'desktop-scifi-filtered');

    // 7. every web wallpaper
    for (const it of P.S.lib.data.items.filter((x) => x.type === 'web')) {
      await C['wallpaper.set']({ id: it.id });
      await sleep(9000);
      const rt = P.S.runtime.get(it.id);
      const frame = d.webContents.mainFrame.framesInSubtree.find((f) => f.url && f.url.startsWith('mantle-wp:'));
      let inner = 'no frame';
      if (frame) { try { inner = JSON.stringify(await frame.executeJavaScript(FRAME_JS, true)); } catch (e) { inner = `js failed: ${e.message}`; } }
      await sleep(1000);
      if (frame) { try { inner += ` then ${JSON.stringify(await frame.executeJavaScript(FRAME_JS, true))}`; } catch (_) {} }
      log(`web ${it.id} before capture: pause=${JSON.stringify(P.S.pause.paused)} outer=${await js(d, OUTER_JS)} inner=${inner}`);
      await capture(d, dir, `web-${it.id}`);
      log(`web ${it.id} "${it.title}": runtime=${JSON.stringify(rt)} page=${JSON.stringify(await js(d, VIDEO_STATE))}`);
    }
    // two frames of a web wallpaper, to show it animates too
    const rain = P.S.lib.get('abqqpcp4.hv3');
    if (rain) {
      await C['wallpaper.set']({ id: rain.id });
      await sleep(8000);
      const r1 = await capture(d, dir, 'web-rain-1');
      await sleep(1000);
      const r2 = await capture(d, dir, 'web-rain-2');
      log(`motion in Rain: ${(motion(r1, r2) * 100).toFixed(1)}%`);
      // a WebGL wallpaper costs more than a decoded video: say how much, playing and held
      await cpu('web wallpaper Rain playing, test window', 20000);
      P.setOverride('pause');
      await sleep(2000);
      await cpu('web wallpaper Rain paused, test window', 20000);
      P.setOverride('play');
      await sleep(1500);
      await C['wallpaper.prop']({ id: rain.id, name: 'mediaSelect', value: 'pexels-pixabay-33227.jpg', persist: false });
      await sleep(3000);
      await capture(d, dir, 'web-rain-prop-changed');
      log(`Rain after a live property change: runtime=${JSON.stringify(P.S.runtime.get(rain.id))}`);
      await C['wallpaper.propsReset']({ id: rain.id }).catch(() => {});
    }

    // 8. back to the default, and the Wallpapers window
    const def = P.S.lib.data.lively && P.S.lib.data.lively.current;
    if (def && P.S.lib.get(def)) await C['wallpaper.set']({ id: def });
    await sleep(2000);
    await C['wallpaper.open']({});
    const lw = await waitFor(() => { const w = P.libraryWin(); return w && !w.isDestroyed() && w.isVisible() ? w : null; }, 15000);
    if (!lw) { log('the Wallpapers window did not open'); } else {
      await sleep(3500);
      await capture(lw, dir, 'library');
      await js(lw, `(() => { const c = document.querySelector('.card[data-id="abqqpcp4.hv3"]'); if (c) c.click(); return !!c; })()`);
      await sleep(1500);
      await capture(lw, dir, 'library-props');

      // 9. adding: one real video (a copy of one of Owen's, so it needs a thumbnail made), one fake
      // video Chromium cannot decode, and one file that is not a wallpaper at all
      const tmp = path.join(os.tmpdir(), 'mantle-wallprobe');
      fs.mkdirSync(tmp, { recursive: true });
      const src = P.S.lib.get('gijrrowv.pdq');
      const realCopy = path.join(tmp, 'Probe copy of Earth.mp4');
      if (src) fs.copyFileSync(path.join(P.S.lib.itemDir(src.id), src.entry), realCopy);
      const fake = path.join(tmp, 'Not really a video.mp4');
      fs.writeFileSync(fake, 'this is text, not an mp4');
      const txt = path.join(tmp, 'notes.txt');
      fs.writeFileSync(txt, 'hello');
      const res = await C['wallpaper.add']({ paths: [realCopy, fake, txt] });
      for (const r of res.results) log(`add ${path.basename(r.path)}: ${r.ok ? 'ok' : 'REFUSED'} - ${r.reason}`);
      await sleep(9000);
      for (const r of res.results.filter((x) => x.ok)) {
        const it = P.S.lib.get(r.id);
        log(`after the thumbnail pass, ${r.title}: thumb=${it && it.thumb} error=${it && it.error}`);
      }
      await js(lw, `(() => { const c = document.querySelector('.card[data-id="${(res.results[1] || {}).id}"]'); if (c) c.click(); return !!c; })()`);
      await sleep(1200);
      await capture(lw, dir, 'library-added');
      for (const r of res.results.filter((x) => x.ok)) {
        await C['wallpaper.remove']({ id: r.id });
        log(`removed ${r.title}: still in library=${!!P.S.lib.get(r.id)} folder exists=${fs.existsSync(P.S.lib.itemDir(r.id))}`);
      }
    }

    // 10. the Lively source untouched
    log(`Lively library still there: ${fs.existsSync(path.join(process.env.LOCALAPPDATA, 'Lively Wallpaper', 'Library', 'SaveData', 'wptmp', 'jh143p0b.t1j'))}`);
    P.setOverride(null);
    await sleep(2500);
    log(`rules handed back to the real foreground: paused=${P.S.pause.paused} reason="${P.S.pause.reason}"`);
    log('done');
  } catch (err) {
    log(`FAILED: ${err && err.stack ? err.stack : err}`);
  }
};
