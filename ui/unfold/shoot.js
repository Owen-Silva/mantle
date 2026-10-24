require('../../tools/dev-env.js').lowcpu();
/* shoot.js - headless screenshots of the full-screen unfold (the iPhone Duo look, WebGL), held at chosen
 * moments, and a labelled strip of them (lane unfold-unlock, 2026-10-23). ONE version: the effect is
 * the screen content itself, lightly darkened with a faint trace of Mantle indigo, no light/dark variant.
 *
 * Line 1 is the machine-wide CPU cap and browser lock (one headless browser at a time). It is
 * required, not optional.
 *
 * Nothing here runs Electron and nothing here looks at the real screen: the desktop is DRAWN
 * (drawDesktop below: a wallpaper, three app windows with text, a bar-like strip), the page loads over
 * file:// with mock-mantle.js standing in for the bridge, and the same drawn picture is painted under
 * the overlay as the "live screen" it dissolves into.
 *
 * Holding a frame: the page's own test hold, window.__unfold.freeze(f, true): its gl frame clock (and
 * any Web Animation) sits at fraction f and its hard timer waits, so a slow screenshot cannot end it.
 *
 *   node ui/unfold/shoot.js                        the page: unfold 0/10/25/50/75/100 %, cover half
 *                                                  folded, covered (look-away end state), reveal half way
 *   UNFOLD_SHOOT=element node ui/unfold/shoot.js   the element version on the launcher, light and dark
 *   -> %TEMP%\mantle-shots\unfold\<name>.png, strip.png and frames.json (each frame's values)
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { chromium } = require('../../tools/dev-env.js').playwright();

const ENV_THEME = ['dark', 'light'].includes(process.env.MANTLE_THEME) ? process.env.MANTLE_THEME : null;
const THEMES = ENV_THEME ? [ENV_THEME] : ['light', 'dark'];
const PAGE = pathToFileURL(path.join(__dirname, 'index.html')).href + '?display=0';
const LAUNCHER = pathToFileURL(path.join(__dirname, '..', 'launcher', 'index.html')).href;
const MOCK = path.join(__dirname, 'mock-mantle.js');
const OUT = process.env.MANTLE_SHOOT_OUT || path.join(require('os').tmpdir(), 'mantle-shots', 'unfold');
const VIEW = { width: 1536, height: 864 }, DPR = 1.25;     // 1920 x 1080 pixels, as on Owen's screen
const PLAY_AT = [0, 0.1, 0.25, 0.5, 0.62, 0.75, 0.9, 1.0];   // 0.62: the leaf lands (blur and dimming still on); 0.75: releasing
const LAUNCHER_RECT = { x: 620, y: 310, w: 680, h: 460 };  // where mock-mantle.js (launcher) puts the panel over a 1920x1080 scene

/* ---- the drawn desktop (runs in a page; returns a PNG data URL at W x H pixels) ------------------- */
function drawDesktop(size) {
  const W = size.W, H = size.H;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d'), k = W / 1920;
  const px = (v) => v * k;
  // a dusk mountain lake: a photograph-like wallpaper (soft gradients, a few hard ridges)
  const sky = g.createLinearGradient(0, 0, 0, H * 0.62);
  sky.addColorStop(0, '#22324a'); sky.addColorStop(0.55, '#7d8ea6'); sky.addColorStop(1, '#e6cdb0');
  g.fillStyle = sky; g.fillRect(0, 0, W, H);
  const sun = g.createRadialGradient(W * 0.72, H * 0.58, 0, W * 0.72, H * 0.58, W * 0.32);
  sun.addColorStop(0, 'rgba(255,236,205,.85)'); sun.addColorStop(1, 'rgba(255,236,205,0)');
  g.fillStyle = sun; g.fillRect(0, 0, W, H);
  const ridge = (pts, fill) => { g.beginPath(); g.moveTo(0, H); pts.forEach((p) => g.lineTo(p[0] * W, p[1] * H)); g.lineTo(W, H); g.closePath(); g.fillStyle = fill; g.fill(); };
  ridge([[0, 0.5], [0.08, 0.42], [0.17, 0.47], [0.27, 0.33], [0.35, 0.44], [0.46, 0.38], [0.55, 0.47], [0.66, 0.36], [0.76, 0.45], [0.88, 0.39], [1, 0.48]], '#6f7f95');
  // snow on the far peaks
  [[0.27, 0.33], [0.66, 0.36], [0.46, 0.38]].forEach((p) => { g.beginPath(); g.moveTo(p[0] * W - px(70), p[1] * H + px(46)); g.lineTo(p[0] * W, p[1] * H); g.lineTo(p[0] * W + px(64), p[1] * H + px(44)); g.lineTo(p[0] * W + px(20), p[1] * H + px(36)); g.lineTo(p[0] * W - px(14), p[1] * H + px(50)); g.closePath(); g.fillStyle = 'rgba(246,244,240,.92)'; g.fill(); });
  ridge([[0, 0.6], [0.1, 0.52], [0.22, 0.58], [0.34, 0.5], [0.47, 0.6], [0.6, 0.54], [0.74, 0.6], [0.86, 0.53], [1, 0.6]], '#3c4858');
  const lake = g.createLinearGradient(0, H * 0.64, 0, H);
  lake.addColorStop(0, '#a99f97'); lake.addColorStop(0.3, '#5c6a7c'); lake.addColorStop(1, '#1d2633');
  g.fillStyle = lake; g.fillRect(0, H * 0.64, W, H * 0.36);
  for (let i = 0; i < 26; i++) { g.fillStyle = 'rgba(255,240,220,' + (0.05 + (i % 4) * 0.03) + ')'; g.fillRect(W * 0.6 + ((i * 131) % 380) * k, H * (0.66 + (i % 13) * 0.018), px(60 + (i * 53) % 140), px(2)); }

  const font = (size, weight, mono) => (weight || 400) + ' ' + px(size) + 'px ' + (mono ? '"Cascadia Mono", Consolas, monospace' : '"Segoe UI", sans-serif');
  const rr = (x, y, w, h, r) => { g.beginPath(); g.roundRect(x, y, w, h, r); };
  const win = (x, y, w, h, bg, title, ink) => {
    g.save(); g.shadowColor = 'rgba(0,0,0,.35)'; g.shadowBlur = px(40); g.shadowOffsetY = px(14);
    rr(px(x), px(y), px(w), px(h), px(8)); g.fillStyle = bg; g.fill(); g.restore();
    g.fillStyle = ink; g.font = font(12, 600); g.fillText(title, px(x + 16), px(y + 22));
    ['#9a9a9a', '#9a9a9a', '#9a9a9a'].forEach((col, i) => { g.fillStyle = col; g.fillRect(px(x + w - 26 - i * 34), px(y + 15), px(10), px(1.5)); });
  };
  // a code editor (dark)
  win(120, 110, 820, 620, '#1e1f22', 'unfold-page.js', '#c9c9c9');
  g.fillStyle = '#26272b'; g.fillRect(px(120), px(140), px(48), px(590));
  const code = ['function unfoldTracks(D) {', '  var W = innerWidth;', '  var open = function (t) {', '    return E.spring(clamp(t / OPEN_END));', '  };', '  return [', '    [stage, fade(HANDOVER, 1)],', '    [ground, fadeIn(0, 0.22)],', '    [leaf, scaleX(p)],', '  ];', '}', '', 'function coverTracks() {', '  var stretch = 1.03;', '  return [soft, ground, tint];', '}', '', '// the picture holds still', '// while the screen opens', 'module.exports = run;', 'var a = 1, b = 2, c = 3;', 'if (a < b) c = a + b;'];
  code.forEach((line, i) => {
    g.font = font(13, 400, true);
    g.fillStyle = '#6b6d73'; g.fillText(String(i + 1), px(134), px(168 + i * 24));
    g.fillStyle = /^\s*\/\//.test(line) ? '#7f8c7a' : (/function|return|var|if/.test(line) ? '#c8a2d8' : '#d6d6d6');
    g.fillText(line, px(184), px(168 + i * 24));
  });
  // a browser window (light)
  win(860, 190, 900, 660, '#fbfbfc', 'Field notes - Browser', '#2a2c31');
  rr(px(880), px(214), px(860), px(30), px(15)); g.fillStyle = '#eef0f3'; g.fill();
  g.fillStyle = '#6a6e78'; g.font = font(12); g.fillText('notes.example.org/alpine-lakes', px(898), px(234));
  g.fillStyle = '#16181d'; g.font = font(30, 600); g.fillText('Alpine lakes at first light', px(900), px(300));
  g.font = font(15); g.fillStyle = '#3a3d45';
  ['Morning fog lifts off the water in long, slow sheets. The far ridge', 'catches the sun minutes before the valley floor does, and the lake', 'holds the colour of the sky for a little while longer.', '', 'Bring layers. The shore trail is two hours each way and the wind', 'turns after noon; plan to be back at the hut by three.'].forEach((t, i) => g.fillText(t, px(900), px(344 + i * 26)));
  const pic = g.createLinearGradient(0, px(520), 0, px(810));
  pic.addColorStop(0, '#8fa3b8'); pic.addColorStop(1, '#41505f');
  g.fillStyle = pic; g.fillRect(px(900), px(520), px(400), px(290));
  g.fillStyle = '#e9edf1'; g.fillRect(px(1330), px(520), px(390), px(130));
  g.fillStyle = '#3a3d45'; g.font = font(14);
  ['Distance 11.4 km', 'Climb 620 m', 'Time 4 h 10 min'].forEach((t, i) => g.fillText(t, px(1350), px(556 + i * 30)));
  // a small notes window (white) over both
  win(520, 690, 420, 260, '#ffffff', 'Notes', '#2a2c31');
  g.fillStyle = '#2a2c31'; g.font = font(14);
  ['Call the hut about Saturday', 'Pack the small stove', 'Check the forecast at 6', 'Batteries for the lamp'].forEach((t, i) => { g.fillStyle = '#c4c7cd'; g.fillRect(px(540), px(734 + i * 34 - 11), px(12), px(12)); g.fillStyle = '#2a2c31'; g.fillText(t, px(564), px(734 + i * 34)); });
  // a bar-like strip along the top (a translucent island with a clock and a few marks)
  rr(px(640), px(14), px(640), px(40), px(20)); g.fillStyle = 'rgba(244,246,250,.62)'; g.fill();
  g.strokeStyle = 'rgba(255,255,255,.7)'; g.lineWidth = px(1); g.stroke();
  g.fillStyle = '#0b0e1a'; g.font = font(14, 600); g.fillText('Fri 23 Oct   9:41', px(895), px(40));
  [0, 1, 2, 3].forEach((i) => { rr(px(662 + i * 36), px(22), px(24), px(24), px(6)); g.fillStyle = 'rgba(11,14,26,' + (0.18 + i * 0.05) + ')'; g.fill(); });
  [0, 1, 2].forEach((i) => { g.beginPath(); g.arc(px(1180 + i * 30), px(34), px(5), 0, 7); g.fillStyle = 'rgba(11,14,26,.45)'; g.fill(); });
  return c.toDataURL('image/png');
}

/* ---- init scripts (run in the page before its own scripts) -------------------------------------- */
function themeInit(t) {
  const set = () => !!document.documentElement && !!(document.documentElement.dataset.theme = t);
  if (!set()) new MutationObserver((_, mo) => { if (set()) mo.disconnect(); }).observe(document, { childList: true });
  const fire = () => window.dispatchEvent(new CustomEvent('mantle-theme', { detail: { theme: t } }));
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fire, { once: true }); else fire();
}
/** the ELEMENT version (ui/shared/unfold.css + unfold.js) on the launcher's real panel, over the drawn
 * desktop, frozen at 0/25/50/75/100 % of a pop opening. The launcher does not load unfold.css/js
 * itself (yet), so they are added here; bypassCSP only because they go in as inline tags. */
async function shootElement(browser, theme, desk, save, problems) {
  const ctx = await browser.newContext({ viewport: { width: LAUNCHER_RECT.w, height: LAUNCHER_RECT.h }, deviceScaleFactor: DPR, colorScheme: theme, bypassCSP: true });
  if (!ENV_THEME) await ctx.addInitScript(themeInit, theme);
  await ctx.addInitScript((url) => { window.__mockScene = { url: url }; }, desk);
  const lp = await ctx.newPage();
  lp.on('pageerror', (e) => problems.push(theme + ' element pageerror: ' + e.message));
  await lp.goto(LAUNCHER, { waitUntil: 'load' });
  await lp.addStyleTag({ path: path.join(__dirname, '..', 'shared', 'unfold.css') });
  await lp.addScriptTag({ path: path.join(__dirname, '..', 'shared', 'unfold.js') });
  await lp.waitForTimeout(600);
  for (const f of [0, 0.25, 0.5, 0.75, 1]) {
    const info = await lp.evaluate(async (fr) => {
      const el = document.querySelector('.panel');
      window.MantleUnfold.rest(el, { state: 'folded', size: 'pop' });
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      window.MantleUnfold.open(el, { size: 'pop' });
      await new Promise((r) => requestAnimationFrame(r));
      const D = 340, as = document.getAnimations();
      as.forEach((a) => { a.pause(); a.currentTime = fr * D; });
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return { anims: as.length, clip: getComputedStyle(el).clipPath, filter: getComputedStyle(el).filter, casts: el.querySelectorAll('.unfold-cast').length };
    }, f);
    save(theme + '-element-' + String(Math.round(f * 100)).padStart(3, '0'), await lp.screenshot());
    console.log(`${theme}-element ${f}: ${JSON.stringify(info)}`);
    await lp.evaluate(() => document.getAnimations().forEach((a) => { try { a.finish(); } catch (_) { /* gone */ } }));
  }
  await ctx.close();
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await require('../settings/test-browser.js').launch(chromium, { headless: true });
  const problems = [];
  const files = [];
  const save = (name, buf) => { const f = path.join(OUT, name + '.png'); fs.writeFileSync(f, buf); files.push(f); return f; };

  if (process.env.UNFOLD_SHOOT === 'element') {
    // the element version (launcher / task view / maximize), both themes: its surfaces keep their look
    for (const theme of THEMES) {
      const ctx = await browser.newContext({ viewport: VIEW, deviceScaleFactor: DPR, colorScheme: theme });
      if (!ENV_THEME) await ctx.addInitScript(themeInit, theme);
      const lab = await ctx.newPage();
      await lab.goto('about:blank');
      const desk = await lab.evaluate(drawDesktop, { W: 1920, H: 1080 });
      await shootElement(browser, theme, desk, save, problems);
      await ctx.close();
    }
  } else {
    /* ---- the full-screen unfold: ONE version (the effect is the content itself; no light/dark) ---- */
    const ctx = await browser.newContext({ viewport: VIEW, deviceScaleFactor: DPR });
    const lab = await ctx.newPage();
    await lab.goto('about:blank');
    const desk = await lab.evaluate(drawDesktop, { W: 1920, H: 1080 });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error') problems.push('console: ' + m.text()); });
    await page.addInitScript({ path: MOCK });
    await page.goto(PAGE, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__told && window.__told.some((t) => t.msg.event === 'ready'));
    const ready = await page.evaluate(() => ({ told: window.__told[0].msg, gl: window.__unfold.gl() }));
    console.log(`ready: ${JSON.stringify(ready.told)}; gl ${JSON.stringify(ready.gl)}`);
    if (ready.told.technique !== 'gl') problems.push('the page did not get WebGL: ' + (ready.told.fallback || 'no reason'));
    // the "live screen" under the overlay: the same drawn picture (CSSOM, which the page's CSP allows)
    await page.evaluate((url) => { document.documentElement.style.background = 'url("' + url + '") 0 0 / 100% 100% no-repeat'; }, desk);

    let seq = 10;
    const answer = (s, ev) => page.waitForFunction(([s2, ev2]) => window.__told.some((t) => t.msg.seq === s2 && t.msg.event === ev2), [s, ev], { timeout: 15000 });
    const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const pct = (f) => String(Math.round(f * 100)).padStart(3, '0');
    const meta = {};
    /** hold the page's own clock at fraction f BEFORE op `c` starts (its hard timer waits too; a
     * software-drawn frame here takes ~250 ms, so a hold set after the start can land too late), shoot,
     * let go */
    async function frozen(name, c, pose, f, endEvent) {
      c.seq = ++seq;
      await page.evaluate((fr) => window.__unfold.freeze(fr, true), f);
      await page.evaluate((cmd) => { window.__mockSend(cmd); }, c);
      await page.waitForFunction((p) => document.getElementById('stage').dataset.pose === p && window.__unfold.state().running > 0, pose, { timeout: 15000 });
      await settle(); await settle();
      const st = await page.evaluate(() => window.__unfold.state());
      save(name, await page.screenshot());
      await page.evaluate(() => window.__unfold.freeze(null));
      await answer(c.seq, endEvent);
      const fr = st.frame || {};
      meta[name] = fr;
      console.log(`${name}: f ${f}, technique ${st.technique}, stage ${(+fr.stage).toFixed(2)}` + (fr.cover ? `, fold ${fr.fold.toFixed(3)}` :
        `, open ${(+fr.open).toFixed(3)} (free edge ${Math.round(960 * fr.open)} px left of the hinge), strength ${(+fr.strength).toFixed(3)} (edge blur ${(72 * fr.strength).toFixed(1)} px), fixed half darkening ${(+fr.fixedDark).toFixed(3)}, light ${(+fr.fixedLight).toFixed(2)}`));
    }

    for (const f of PLAY_AT) {
      await page.evaluate((s) => window.__mockSend({ op: 'arm', seq: s }), ++seq);
      await frozen('play-' + pct(f), { op: 'play', still: desk, size: 'full' }, 'opening', f, 'played');
    }
    await frozen('cover-050', { op: 'cover', still: desk }, 'covering', 0.5, 'covered');
    // the covered end state: the cover played to its end (no hold)
    {
      const s = ++seq;
      await page.evaluate((x) => window.__mockSend({ op: 'cover', seq: x[0], still: x[1] }), [s, desk]);
      await answer(s, 'covered');
      await settle();
      save('covered', await page.screenshot());
      console.log('covered: the end state (look-away)');
    }
    await frozen('reveal-050', { op: 'reveal' }, 'revealing', 0.5, 'revealed');
    const told = await page.evaluate(() => window.__told.map((t) => t.msg));
    const bad = told.filter((m) => m.error || m.timedOut || (m.technique && m.technique !== 'gl'));
    if (bad.length) problems.push('answers: ' + JSON.stringify(bad).slice(0, 400));
    await page.close();

    /* ---- the strip: every frame, labelled, 3 across ---- */
    const names = PLAY_AT.map((f) => 'play-' + pct(f)).concat(['cover-050', 'covered', 'reveal-050']);
    const labels = PLAY_AT.map((f) => 'Unfold ' + Math.round(f * 100) + ' %').concat(['Cover, half folded', 'Covered (look-away)', 'Reveal, half way']);
    const tiles = names.map((n, i) => [labels[i], 'data:image/png;base64,' + fs.readFileSync(path.join(OUT, n + '.png')).toString('base64')]);
    const strip = await lab.evaluate(async (list) => {
      const load = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
      const tw = 640, th = 360, gap = 16, lab2 = 34, cols = 3, rows = Math.ceil(list.length / cols);
      const c = document.createElement('canvas');
      c.width = cols * tw + (cols + 1) * gap; c.height = rows * (th + lab2) + (rows + 1) * gap;
      const g = c.getContext('2d');
      g.fillStyle = '#e7e8ea'; g.fillRect(0, 0, c.width, c.height);
      for (let i = 0; i < list.length; i++) {
        const img = await load(list[i][1]);
        const x = gap + (i % cols) * (tw + gap), y = gap + Math.floor(i / cols) * (th + lab2 + gap);
        g.drawImage(img, x, y, tw, th);
        g.fillStyle = '#0b0e1a'; g.font = '600 15px "Segoe UI", sans-serif'; g.fillText(list[i][0], x, y + th + 22);
      }
      return c.toDataURL('image/png');
    }, tiles);
    save('strip', Buffer.from(strip.split(',')[1], 'base64'));
    fs.writeFileSync(path.join(OUT, 'frames.json'), JSON.stringify(meta, null, 1));
    await ctx.close();
  }
  await browser.close();
  console.log('UNFOLD SHOTS: ' + files.length + ' files in ' + OUT);
  for (const f of files) console.log('  ' + f);
  if (problems.length) console.log('PROBLEMS: ' + problems.join(' | '));
})().catch((err) => {
  console.error('shoot.js failed: ' + ((err && err.stack) || err));
  process.exit(1);
});
