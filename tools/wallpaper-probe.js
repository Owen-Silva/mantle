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

async function capture(win, dir, name, opts) {
  // a window Mantle never shows (Settings in --test) paints only when asked: the first capture returns the LAST frame
  if (opts && opts.fresh) { await win.webContents.capturePage(undefined, { stayHidden: true }); await sleep(400); }
  const img = opts ? await win.webContents.capturePage(undefined, { stayHidden: true }) : await win.webContents.capturePage();
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
    await cpu(`web ${id} playing, test window`, 20000);
    P.setOverride('pause');
    await sleep(2000);
    await cpu(`web ${id} paused, test window`, 20000);
    P.setOverride('play');
  }
  if (def && P.S.lib.get(def)) await C['wallpaper.set']({ id: def });
  P.setOverride(null);
}

/*
 * MANTLE_WALL_PROBE_PRESETS=1|2 (lane mantle-bg-presets, 2026-10-09): the built-in wallpapers in a
 * real --test Mantle, driven through the Wallpapers window's own buttons (clicks in its page, so the
 * bridge, wallpaper.set and the desktop page all run for real). 1 = pick two built-in photos and
 * prove each through the listing, library.json and the desktop page's own <img>, then a third in Settings > Personalization > Background; 2 = after a
 * restart of the same profile, the Settings pick is still up, then back to one of the user's own (both pages follow).
 * Writes presets-<phase>.json (every check with its value) and captures beside it.
 */
const WALL_SRC = `(() => { const i = document.querySelector('#wall img'); const v = document.querySelector('#wall video'); const f = document.querySelector('#wall iframe');
  const m = i || v || f; return { tag: m ? m.tagName : null, src: m ? (m.currentSrc || m.src || '') : '', loaded: i ? (i.complete && i.naturalWidth > 0) : (v ? v.readyState >= 2 : !!f),
  w: i ? i.naturalWidth : (v ? v.videoWidth : 0), hasWall: document.body.classList.contains('has-wall') }; })()`;

async function presetsProbe(P, C, d, dir, phase) {
  const LAST = 'builtin:forest';   // phase 1's last pick (made in Settings); phase 2 expects it after the restart
  const out = { phase, checks: [], errors: [] };
  const ok = (name, pass, value) => { out.checks.push({ name, pass: !!pass, value }); log(`${pass ? 'PASS' : 'FAIL'} ${name} -- ${JSON.stringify(value)}`); };
  const libJson = () => { try { return JSON.parse(fs.readFileSync(path.join(P.S.lib.dir, 'library.json'), 'utf8')).selected; } catch (e) { return `unreadable: ${e.message}`; } };
  const watchErrors = (win, label) => win.webContents.on('console-message', (e) => {
    const level = e && e.level !== undefined ? e.level : null;
    if (level === 'error' || level === 3) out.errors.push(`${label}: ${String(e.message || '').slice(0, 200)}`);
  });
  watchErrors(d, 'desktop');
  const desk = async (want) => waitFor(async () => { const s = await js(d, WALL_SRC); return s && s.src && s.src.endsWith(want) && s.loaded ? s : null; }, 20000, 300);

  out.userData = app.getPath('userData');
  out.presetsLog = P.S.presets ? { ok: P.S.presets.ok, n: P.S.presets.items.length, dir: P.S.presets.dir } : null;
  ok('catalog: 23 built-in photos read from the app folder', P.S.presets && P.S.presets.ok && P.S.presets.items.length === 23, out.presetsLog);
  const own = (P.S.lib.data.items.find((i) => P.S.lib.health(i).ok) || {}).id || null;
  out.own = own;

  await C['wallpaper.open']({});
  const lw = await waitFor(() => { const w = P.libraryWin(); return w && !w.isDestroyed() && !w.webContents.isLoading() ? w : null; }, 15000);
  if (!lw) { ok('the Wallpapers window opened', false, null); fs.writeFileSync(path.join(dir, `presets-${phase}.json`), JSON.stringify(out, null, 2)); return; }
  watchErrors(lw, 'wallpapers');
  await waitFor(async () => (await js(lw, `document.querySelectorAll('#grid .card[data-id]').length`)) > 0, 15000);
  await sleep(800);
  const click = (sel, ev) => js(lw, `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; ${ev === 'dblclick' ? "e.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))" : 'e.click()'}; return true; })()`);
  const view = () => js(lw, `({ builtin: document.getElementById('view-builtin').getAttribute('aria-selected') === 'true', cards: Array.from(document.querySelectorAll('#grid .card[data-id]')).map((c) => c.dataset.id),
    ticks: Array.from(document.querySelectorAll('#grid .card .tick')).map((t) => t.closest('.card').dataset.id), credit: document.getElementById('credit').textContent.trim(),
    head: document.getElementById('head-sub').textContent, theme: document.documentElement.dataset.theme || 'light',
    thumbs: Array.from(document.querySelectorAll('#grid .card .thumb img')).slice(0, 6).map((i) => i.complete && i.naturalWidth > 0) })`);

  // Settings > Personalization > Background, opened the way the launcher does ('mantle-open'), in this
  // same --test instance (its window is quiet like every test window). `want` = the id that must be
  // ticked (null = none); `pickId` (optional) = a built-in tile clicked in Settings, proven on the desktop.
  const setView = (sw) => js(sw, `(() => { const tiles = Array.from(document.querySelectorAll('[data-builtin-id]'));
    const shown = tiles.filter((t) => t.style.display !== 'none');
    return { n: tiles.length, ids: tiles.map((t) => t.dataset.builtinId), checked: tiles.filter((t) => t.getAttribute('aria-checked') === 'true').map((t) => t.dataset.builtinId),
      chips: Array.from(document.querySelectorAll('[data-cat]')).map((c) => c.dataset.cat).join('|'), shuffle: !!document.querySelector('[data-shuffle]'),
      thumbs: shown.slice(0, 8).map((t) => { const i = t.querySelector('img'); return !!(i && i.complete && i.naturalWidth > 0); }), gone: tiles.filter((t) => t.dataset.thumbGone).length,
      credit: ((document.querySelector('[data-credit-line]') || {}).textContent || '').trim(), theme: document.documentElement.dataset.theme || 'light' }; })()`);
  const titleOf = (id) => ((P.S.presets.items.find((x) => x.id === id)) || {}).title;
  async function settingsStep(want, pickId) {
    const reply = {};
    app.emit('mantle-open', 'settings', { section: 'personalization', page: 'background', row: 'personalization.background.builtin', via: 'the wallpaper probe', reply });
    ok(`settings: opened at Personalization > Background (${want || 'his own'} up)`, reply.ok === true, reply);
    const { BrowserWindow } = require('electron');
    const sw = await waitFor(() => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && /ui[\\/]settings[\\/]index\.html/.test(w.webContents.getURL()) && !w.webContents.isLoading()), 15000);
    if (!sw) { ok('settings: the window exists', false, null); return; }
    watchErrors(sw, 'settings');
    // Settings in --test is made but never shown, so Chromium stops painting it and captures come back stale;
    // shown through lib/test-quiet (alpha 0, click-through, never focused) it paints like the Wallpapers window.
    const wasShown = sw.isVisible();
    if (!wasShown) sw.showInactive();
    let sv = await waitFor(async () => { const x = await setView(sw); return x && x.n >= 23 && x.thumbs.length && x.thumbs.every(Boolean) ? x : null; }, 20000, 300) || await setView(sw);
    ok('settings: Background shows the 23 built-in photos with real thumbs', sv.n === 23 && sv.ids.every((x) => /^builtin:/.test(x)) && sv.thumbs.every(Boolean) && !sv.gone, { n: sv.n, thumbs: sv.thumbs, gone: sv.gone });
    ok('settings: Helm\'s categories and Shuffle', sv.chips === 'All|Mountains|Forest|Water|Coast|Desert|Sky & Night|Snow|City|Abstract|Minimal' && sv.shuffle, sv.chips);
    ok(`settings: ${want ? 'the pick is ticked and credited' : 'no built-in tile is ticked, the neutral credit line shows'}`,
      want ? sv.checked.join() === want && sv.credit.startsWith(titleOf(want) + ' · Photo by ') : sv.checked.length === 0 && /Photos from Unsplash, free under the Unsplash License/.test(sv.credit), { checked: sv.checked, credit: sv.credit });
    await js(sw, `(() => { const g = document.querySelector('[data-builtin-id]'); if (g) g.closest('.card, section, div').scrollIntoView({ block: 'start' }); return true; })()`);
    await sleep(500);
    await capture(sw, dir, `${phase === '1' ? 'p1' : 'p2'}-settings-${(want || 'own').replace('builtin:', '')}-${sv.theme}`, { fresh: true });
    if (pickId) {
      await js(sw, `(() => { const b = document.querySelector('[data-builtin-id="${pickId}"]'); if (b) b.click(); return !!b; })()`);
      const sd = await desk(`/assets/backgrounds/${pickId.replace('builtin:', '')}.jpg`);
      sv = await waitFor(async () => { const x = await setView(sw); return x.checked.join() === pickId ? x : null; }, 8000, 200) || await setView(sw);
      ok(`settings pick (${pickId}, a tile click in Settings): selected, saved, drawn on the desktop, ticked + credited in Settings`,
        P.S.lib.data.selected === pickId && libJson() === pickId && !!sd && sv.checked.join() === pickId && sv.credit.startsWith(titleOf(pickId) + ' · Photo by '), { selected: P.S.lib.data.selected, desk: sd, checked: sv.checked, credit: sv.credit });
      await capture(sw, dir, `p1-settings-${pickId.replace('builtin:', '')}-${sv.theme}`, { fresh: true });
      await capture(d, dir, `p1-desktop-${pickId.replace('builtin:', '')}`);
    }
    if (!wasShown && !sw.isDestroyed()) sw.hide();
  }

  const viewWhen = async (pred) => { const t0 = Date.now(); const got = await waitFor(async () => { const x = await view(); return pred(x) ? x : null; }, 6000, 100); const x = got || await view(); x.ms = Date.now() - t0; return x; };

  if (phase === '1') {
    let v = await view();
    ok('window: opens on Your library (one of his own is up) with only his cards', !v.builtin && v.cards.length === P.S.lib.data.items.length && !v.cards.some((x) => /^builtin:/.test(x)), { cards: v.cards.length, lib: P.S.lib.data.items.length });
    await capture(lw, dir, `p1-window-yours-${v.theme}`);
    await click('#view-builtin');
    await sleep(1500);
    v = await view();
    const chips = await js(lw, `Array.from(document.querySelectorAll('#cats .cat')).map((c) => c.textContent).join('|')`);
    ok('window: Built-in shows the 23 photos with real thumbs', v.builtin && v.cards.length === 23 && v.cards.every((x) => /^builtin:/.test(x)) && v.thumbs.length === 6 && v.thumbs.every(Boolean), { n: v.cards.length, thumbs: v.thumbs });
    ok('window: Helm\'s categories, All first', chips === 'All|Mountains|Forest|Water|Coast|Desert|Sky & Night|Snow|City|Abstract|Minimal', chips);
    ok('window: the credit line names Unsplash and its license', /Photos from Unsplash, free under the Unsplash License/.test(v.credit), v.credit);
    await capture(lw, dir, `p1-window-builtin-${v.theme}`);

    // pick 1: the card, then its "Set as wallpaper" button
    await click('.card[data-id="builtin:stone"]');
    await sleep(300);
    await click('#d-set');
    const s1 = await desk('/assets/backgrounds/stone.jpg');
    v = await viewWhen((x) => x.ticks.join() === 'builtin:stone');
    ok('pick 1 (Stone summit, by its Set button): wallpaper.list says it is selected', P.listing().presets.items.filter((x) => x.selected).map((x) => x.id).join() === 'builtin:stone' && P.S.lib.data.selected === 'builtin:stone', P.S.lib.data.selected);
    ok('pick 1: saved in library.json', libJson() === 'builtin:stone', libJson());
    ok('pick 1: the desktop page draws that photo (its own <img>, loaded)', !!s1, s1 || await js(d, WALL_SRC));
    await waitFor(() => { const r = P.S.runtime.get('builtin:stone'); return r && r.state === 'playing'; }, 8000);
    ok('pick 1: the desktop reports it on screen', (P.S.runtime.get('builtin:stone') || {}).state === 'playing', P.S.runtime.get('builtin:stone'));
    ok('pick 1: the window ticks it and credits it under the grid', v.ticks.join() === 'builtin:stone' && v.credit === 'Stone summit · Photo by Fabrizio Conti on Unsplash', { ticks: v.ticks, credit: v.credit, msAfterDesktop: v.ms });
    const det = await js(lw, `(document.querySelector('#detail .d-credit') || {}).textContent`);
    ok('pick 1: its details credit the photographer', det === 'Photo by Fabrizio Conti on Unsplash', det);
    await capture(lw, dir, `p1-window-stone-${v.theme}`);
    await capture(d, dir, 'p1-desktop-stone');

    // pick 2: the Sky & Night chip, then a double-click on the card
    await click('#cats .cat[data-cat="Sky & Night"]');
    await sleep(300);
    await click('.card[data-id="builtin:night-fjord"]', 'dblclick');
    const s2 = await desk('/assets/backgrounds/night-fjord.jpg');
    v = await viewWhen((x) => x.ticks.join() === 'builtin:night-fjord');
    ok('pick 2 (Fjord at night, by a double-click): selected and saved', P.S.lib.data.selected === 'builtin:night-fjord' && libJson() === 'builtin:night-fjord', libJson());
    ok('pick 2: the desktop page now draws that photo', !!s2, s2 || await js(d, WALL_SRC));
    ok('pick 2: the window moved the tick', v.ticks.join() === 'builtin:night-fjord' && /^Fjord at night · Photo by .+ on Unsplash$/.test(v.credit), { ticks: v.ticks, credit: v.credit, msAfterDesktop: v.ms });
    await capture(lw, dir, `p1-window-fjord-${v.theme}`);
    await capture(d, dir, 'p1-desktop-fjord');
    // pick 3: in Settings > Personalization > Background; the Wallpapers window follows it
    await settingsStep('builtin:night-fjord', LAST);
    await click('#cats .cat[data-cat="All"]');   // the window is still on Sky & Night from pick 2, which hides Forest
    v = await viewWhen((x) => x.ticks.join() === LAST);
    ok('pick 3: the open Wallpapers window moved its tick to the Settings pick', v.ticks.join() === LAST, { ticks: v.ticks, credit: v.credit });
    await cpu('a built-in photo on the desktop (still image), Wallpapers + Settings open, test window', 20000);
  } else {
    const s = await desk(`/assets/backgrounds/${LAST.replace('builtin:', '')}.jpg`);
    ok('after a restart: the built-in pick is still selected', P.S.lib.data.selected === LAST && libJson() === LAST, P.S.lib.data.selected);
    ok('after a restart: the desktop draws it again', !!s, s || await js(d, WALL_SRC));
    let v = await viewWhen((x) => x.builtin && x.ticks.join() === LAST);
    ok('after a restart: the window opens on Built-in with it ticked', v.builtin && v.ticks.join() === LAST, { builtin: v.builtin, ticks: v.ticks });
    await capture(lw, dir, `p2-window-forest-${v.theme}`);
    await capture(d, dir, 'p2-desktop-forest');
    await cpu('a built-in photo on the desktop after a restart, Wallpapers open, test window', 20000);
    // back to one of his own
    await click('#view-yours');
    await sleep(600);
    await click(`.card[data-id="${own}"]`, 'dblclick');
    const back = await waitFor(async () => { const w = await js(d, WALL_SRC); return P.S.lib.data.selected === own && w && w.src && !/assets\/backgrounds/.test(w.src) && w.loaded ? w : null; }, 30000, 500);
    v = await viewWhen((x) => x.ticks.join() === own);
    ok('back to his own: it is selected, saved, and the desktop draws it', !!back && libJson() === own && P.listing().current && !P.listing().current.preset, { own, selected: P.S.lib.data.selected, desk: back });
    ok('back to his own: no built-in card is ticked, his card is', v.ticks.join() === own && !v.builtin, v.ticks);
    await capture(lw, dir, `p2-window-own-${v.theme}`);
    await click('#view-builtin');
    await sleep(600);
    v = await view();
    ok('back to his own: Built-in shows no tick and the neutral credit line', v.builtin && v.ticks.length === 0 && /Photos from Unsplash/.test(v.credit), { ticks: v.ticks, credit: v.credit });
    await capture(lw, dir, `p2-window-builtin-own-${v.theme}`);
    await settingsStep(null, null);
    await cpu(`his own wallpaper (${(P.S.lib.data.items.find((i) => i.id === own) || {}).kind || '?'}) on the desktop, Wallpapers + Settings open, test window`, 20000);
  }
  ok('no console errors in the Wallpapers window, Settings or the desktop page', out.errors.length === 0, out.errors);
  out.passed = out.checks.filter((c) => c.pass).length;
  out.failed = out.checks.length - out.passed;
  log(`PRESETS PROBE phase ${phase}: ${out.passed} passed, ${out.failed} failed`);
  fs.writeFileSync(path.join(dir, `presets-${phase}.json`), JSON.stringify(out, null, 2));
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
    for (const l of (P.S.lib.data.lively && P.S.lib.data.lively.report.lines) || []) log(`  import ${l.livelyId}: ${l.ok ? 'ok' : 'FAILED'} - ${l.reason}`);
    log(`selected: ${P.S.lib.data.selected}`);
    if (process.env.MANTLE_WALL_PROBE_PRESETS) { await presetsProbe(P, C, d, dir, process.env.MANTLE_WALL_PROBE_PRESETS); log('done'); return; }
    if (process.env.MANTLE_WALL_PROBE_WEB) { await webTiming(P, C, d, dir); log('done'); return; }
    if (process.env.MANTLE_WALL_PROBE_CPU) { await cpuOnly(P, C, d, dir); log('done'); return; }

    // 2. the rules as they stand for whatever the user has in front right now, then held playing
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
    // The once-a-second check would answer with the user's REAL foreground in between: hold it.
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
      log(`web ${it.id}: runtime=${JSON.stringify(rt)} page=${JSON.stringify(await js(d, VIDEO_STATE))}`);
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

      // 9. adding: one real video (a copy of one of the user's, so it needs a thumbnail made), one fake
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
        log(`after the thumbnail pass, ${r.id}: thumb=${it && it.thumb} error=${it && it.error}`);
      }
      await js(lw, `(() => { const c = document.querySelector('.card[data-id="${(res.results[1] || {}).id}"]'); if (c) c.click(); return !!c; })()`);
      await sleep(1200);
      await capture(lw, dir, 'library-added');
      for (const r of res.results.filter((x) => x.ok)) {
        await C['wallpaper.remove']({ id: r.id });
        log(`removed ${r.id}: still in library=${!!P.S.lib.get(r.id)} folder exists=${fs.existsSync(P.S.lib.itemDir(r.id))}`);
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
