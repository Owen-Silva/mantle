require('../../tools/dev-env.js').lowcpu();
/* unfold.page.test.js - the REAL unfold overlay page (index.html + unfold-page.js + the shared unfold
 * css/js) on its MOCK bridge (mock-mantle.js: every answer recorded, nothing else), driven op by op the
 * way main drives it, in headless Chromium over file:// (lane unfold-unlock, 2026-10-23).
 *
 * What it proves: every op answers once with its seq and display; a play with a picture runs the
 * layers and ends with the stage gone; no picture, a picture that will not decode and a black picture
 * all take the fade with a reason in plain words; cover / reveal / finish / skip / park; an unknown op
 * is an error; FROZEN frames (every animation paused) still end on the page's own hard timer
 * (duration + 400 ms) with the stage gone; reduced motion is a fade and 120 ms cover/reveal; an
 * interrupted unfold fades from where it is (no snap back to the seam); no answer carries image data.
 *
 * The pictures are drawn here (gradients and text on a canvas); nothing looks at the real screen.
 *   node ui/unfold/unfold.page.test.js
 * Prints "UNFOLD PAGE TEST: n passed, m failed".
 */
'use strict';
const path = require('path');
const { pathToFileURL } = require('url');

let chromium = null;
for (const c of require('../../tools/dev-env.js').playwrightCandidates()) { try { chromium = require(c).chromium; break; } catch (e) { /* next */ } }
const PAGE = pathToFileURL(path.join(__dirname, 'index.html')).href + '?display=7';
const MOCK = path.join(__dirname, 'mock-mantle.js');
const VIEW = { width: 640, height: 360 };
const FULL_MS = 1100, REVEAL_MS = 200, PAD = 400;
let passed = 0;
const failures = [];
const check = (name, ok, detail) => { if (ok) passed++; else failures.push(detail !== undefined ? `${name} (${String(detail).slice(0, 300)})` : name); return ok; };
const JARGON = /0x[0-9a-f]{4,}|\bE(NOENT|ACCES|PERM|BUSY)\b|sidecar|undefined|\bnull\b|NaN|\[object|DOMException|EncodingError|Error:/i;

/* runs in a page: a picture at w x h (a gradient, shapes and lines of text), or all black */
function picture(o) {
  const w = o.w, h = o.h, kind = o.kind;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d');
  if (kind === 'stripes') {
    // 2 px white, 2 px black columns: any blur of 2 px or more flattens them, so the stripes' contrast
    // along a row says how sharp the frame is at that x
    g.fillStyle = '#000'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#fff';
    for (let x = 0; x < w; x += 4) g.fillRect(x, 0, 2, h);
    return c.toDataURL('image/png');
  }
  if (kind === 'edge') {
    // a light top half over a dark bottom half: along a row near the edge between them the luminance
    // changes smoothly as the blur grows toward the free edge, and a step between blur levels shows
    g.fillStyle = '#2b2e36'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#dcdde3'; g.fillRect(0, 0, w, Math.round(h / 2));
    return c.toDataURL('image/png');
  }
  if (kind === 'black') {
    g.fillStyle = '#000'; g.fillRect(0, 0, w, h);
    g.fillStyle = 'rgb(3,3,3)'; g.fillRect(w / 3, h / 3, w / 6, h / 6);   // "nearly" black: a capture's noise floor
    return c.toDataURL('image/png');
  }
  const bg = g.createLinearGradient(0, 0, w, h); bg.addColorStop(0, '#5d6f8c'); bg.addColorStop(1, '#a7a19a');
  g.fillStyle = bg; g.fillRect(0, 0, w, h);
  g.fillStyle = '#f7f7f8'; g.fillRect(w * 0.1, h * 0.12, w * 0.5, h * 0.6);
  g.fillStyle = '#24272c'; g.font = '13px "Segoe UI", sans-serif';
  for (let i = 0; i < 9; i++) g.fillText('Lines of text in a window ' + i, w * 0.1 + 12, h * 0.12 + 28 + i * 20);
  return c.toDataURL('image/png');
}

async function main() {
  if (!chromium) { console.log('UNFOLD PAGE TEST: 0 passed, 1 failed (playwright-core not found)'); process.exit(1); }
  const browser = await require('../settings/test-browser.js').launch(chromium, { headless: true });
  const errors = [];
  const pages = [];
  let pics = null;

  async function open(reduced, init) {
    const ctx = await browser.newContext({ viewport: VIEW, deviceScaleFactor: 1, reducedMotion: reduced ? 'reduce' : 'no-preference' });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript({ path: MOCK });
    if (init) await page.addInitScript(init);
    await page.goto(PAGE, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__told && window.__told.some((t) => t.msg.event === 'ready'), null, { timeout: 10000 });
    if (!pics) pics = { ok: await page.evaluate(picture, { w: VIEW.width, h: VIEW.height }), black: await page.evaluate(picture, { w: VIEW.width, h: VIEW.height, kind: 'black' }),
      stripes: await page.evaluate(picture, { w: VIEW.width, h: VIEW.height, kind: 'stripes' }),
      edge: await page.evaluate(picture, { w: VIEW.width, h: VIEW.height, kind: 'edge' }) };
    pages.push(page);
    return page;
  }
  let seq = 100;
  /** send an op the way main does (unfold.cmd); remembers when, for the answer's latency */
  const send = (page, c) => { c.seq = c.seq !== undefined ? c.seq : ++seq; return page.evaluate((cmd) => { (window.__sent = window.__sent || {})[cmd.seq] = performance.now(); window.__mockSend(cmd); return cmd.seq; }, c); };
  /** the page's answer to seq (and how long after the send it came) */
  const answer = (page, s, timeout) => page.waitForFunction((x) => {
    const t = window.__told.find((a) => a.msg.seq === x && a.msg.event !== 'ready');
    return t ? { msg: t.msg, ms: Math.round(t.at - ((window.__sent || {})[x] || 0)) } : null;
  }, s, { timeout: timeout || 8000 }).then((h) => h.jsonValue()).catch((e) => ({ msg: null, ms: null, timeout: String(e.message).split('\n')[0] }));
  const state = (page) => page.evaluate(() => window.__unfold.state());
  const op = async (page, c, timeout) => answer(page, await send(page, c), timeout);
  /** hold every timeline the moment op `pose` runs (a renderer that gets no frames): the page's own
   * test hold, which covers its gl frame clock and its Web Animations alike */
  const freezeWhen = (page, pose) => page.evaluate((p) => new Promise((res) => {
    const t0 = performance.now();
    (function look() {
      if (document.getElementById('stage').dataset.pose === p && window.__unfold.state().running) { const at = performance.now(); window.__unfold.freeze(0.3); res(at); return; }
      if (performance.now() - t0 > 8000) { res(null); return; }
      setTimeout(look, 2);
    })();
  }), pose);

  /** the element version (ui/shared/unfold.css + unfold.js) on a made-up panel in the same page */
  async function elementChecks(page, reducedMotion) {
    const tag = reducedMotion ? 'element (reduced): ' : 'element: ';
    const r = await page.evaluate(async () => {
      const mk = (pos) => {
        const el = document.createElement('div');
        el.style.cssText = 'position:' + pos + ';left:40px;top:40px;width:300px;height:160px;background:#fff;border-radius:16px;z-index:5';
        el.innerHTML = '<b>Panel</b><i>row</i>';
        document.body.appendChild(el);
        return el;
      };
      const kids = (el) => Array.from(el.children).map((c) => c.className || c.tagName).join(',');
      const out = {};
      const el = mk('absolute');
      window.MantleUnfold.rest(el, { state: 'folded', size: 'pop' });
      out.restKids = kids(el);
      out.restOpacity = getComputedStyle(el).opacity;
      out.restClip = getComputedStyle(el).clipPath;
      const t0 = performance.now();
      const p = window.MantleUnfold.open(el, { size: 'pop' });
      await new Promise((res) => setTimeout(res, 90));
      out.midKids = kids(el);
      const m = document.querySelector('.unfold-cast-m');
      out.midCast = m ? { op: +getComputedStyle(m).opacity, tf: getComputedStyle(m).transform } : null;
      out.midClip = getComputedStyle(el).clipPath;
      out.open = await p;
      out.openMs = Math.round(performance.now() - t0);
      out.openKids = kids(el);
      out.openStyle = { op: getComputedStyle(el).opacity, filter: getComputedStyle(el).filter, clip: getComputedStyle(el).clipPath };
      out.blur = await window.MantleUnfold.blur(el, { size: 'pop' });
      out.blurKids = kids(el);
      const bm = document.querySelector('.unfold-cast-m');
      out.blurCast = bm ? +getComputedStyle(bm).opacity : null;
      out.fold = await window.MantleUnfold.fold(el, { size: 'pop' });
      out.foldKids = kids(el);
      out.foldOpacity = getComputedStyle(el).opacity;
      const st = mk('static');
      window.MantleUnfold.rest(st, { state: 'folded', size: 'quick' });
      out.staticOpen = await window.MantleUnfold.open(st, { size: 'quick' });
      out.staticKids = kids(st);
      el.remove(); st.remove();
      return out;
    });
    check(tag + 'rest folded: hidden, no shade children', r.restKids === 'B,I' && r.restOpacity === '0', JSON.stringify(r).slice(0, 300));
    check(tag + 'open resolves, not timed out', r.open && r.open.ok && r.open.state === 'open' && !r.open.timedOut, JSON.stringify(r.open));
    check(tag + 'lands open: opacity 1, sharp, unclipped', r.openStyle.op === '1' && /blur\(0px\) brightness\(1\)|none/.test(r.openStyle.filter) && /inset\(0px\)|none/.test(r.openStyle.clip), JSON.stringify(r.openStyle));
    check(tag + 'at rest open the children are the panel\'s own again', r.openKids === 'B,I', r.openKids);
    check(tag + 'fold resolves, ends hidden, no shade children', r.fold && r.fold.state === 'folded' && !r.fold.timedOut && r.foldOpacity === '0' && r.foldKids === 'B,I', JSON.stringify(r.fold) + ' ' + r.foldOpacity + ' ' + r.foldKids);
    check(tag + 'a static element opens without the shade and says so', r.staticOpen && r.staticOpen.ok && r.staticOpen.shade === false && r.staticKids === 'B,I', JSON.stringify(r.staticOpen) + ' ' + r.staticKids);
    if (!reducedMotion) {
      check(tag + 'rest folded: the cover half only (clip from the hinge)', /inset\(0px 0px 0px 50%\)/.test(r.restClip), r.restClip);
      check(tag + 'mid-open: the shade rides the opening (scaled, darkening)', r.midKids === 'B,I,unfold-cast unfold-cast-m,unfold-cast unfold-cast-s' && r.midCast && r.midCast.op > 0.05 && /matrix/.test(r.midCast.tf), JSON.stringify(r.midCast) + ' ' + r.midKids);
      check(tag + 'mid-open: the left half part way open', /inset\(0px 0px 0px (\d+(\.\d+)?)%\)/.test(r.midClip) && parseFloat(/0px (\d+(\.\d+)?)%\)/.exec(r.midClip)[1]) < 50, r.midClip);
      check(tag + 'open said shade true', r.open.shade === true, JSON.stringify(r.open));
      check(tag + 'open takes about --unfold-pop-ms (340)', r.openMs >= 300 && r.openMs < 600, r.openMs);
      check(tag + 'blurred keeps the shade up', r.blur && r.blur.state === 'blurred' && r.blur.shade === true && /unfold-cast-m/.test(r.blurKids) && r.blurCast > 0.3, JSON.stringify(r.blur) + ' ' + r.blurCast);
    } else {
      check(tag + 'no shade with reduced motion', r.open.shade === false && r.midKids === 'B,I', r.midKids);
      check(tag + 'reduced open is the short fade', r.openMs < 300, r.openMs);
    }
  }

  try {
    if (process.env.UNFOLD_ONLY === 'element') {
      await elementChecks(await open(false), false);
      await elementChecks(await open(true), true);
      throw new Error('ONLY');
    }
    /* 1. ready on load */
    let page = await open(false);
    let told = await page.evaluate(() => window.__told.map((t) => t.msg));
    check('ready on load (seq 0, display)', told.length === 1 && told[0].event === 'ready' && told[0].seq === 0 && told[0].display === '7', JSON.stringify(told));
    const gl0 = await page.evaluate(() => window.__unfold.gl());
    console.log(`  gl: ${JSON.stringify(gl0)}`);
    check('ready says gl, with the load-time warm-up timed', told[0].technique === 'gl' && !told[0].fallback && typeof told[0].warmMs === 'number', JSON.stringify(told[0]));
    check('gl at load: built and run once, then freed (nothing held while parked)', gl0.ok === true && gl0.builds === 1 && gl0.ready === false && gl0.atlas === null && gl0.warmMs !== null, JSON.stringify(gl0));
    let st = await state(page);
    check('parked at load (stage hidden, no picture)', st.pose === 'parked' && st.stage === 0 && st.still === false, JSON.stringify(st));

    /* 2. arm: the unlit display */
    let a = await op(page, { op: 'arm' });
    st = await state(page);
    check('arm -> armed', a.msg && a.msg.event === 'armed', JSON.stringify(a));
    check('armed: stage opacity 1', st.stage === 1 && st.pose === 'armed', JSON.stringify(st));

    /* 3. play with a picture: the layers, frames, then gone */
    a = await op(page, { op: 'play', still: pics.ok, size: 'full' });
    st = await state(page);
    check('play -> played', a.msg && a.msg.event === 'played', JSON.stringify(a));
    check('play: technique gl, no fallback', a.msg && a.msg.technique === 'gl' && !a.msg.fallback, a.msg && JSON.stringify([a.msg.technique, a.msg.fallback]));
    const gl1 = await page.evaluate(() => window.__unfold.gl());
    check('play: 12 blur levels from 2 to 72 px in one atlas', gl1.levels && gl1.levels.length === 12 && gl1.levels[0][0] === 2 && gl1.levels[11][0] === 72 && gl1.atlas && gl1.atlas[0] > 0, JSON.stringify(gl1));
    check('play: frames counted', a.msg && a.msg.stats && a.msg.stats.frames > 0, JSON.stringify(a.msg && a.msg.stats));
    check('play: stats carry p50/p95/max/dropped/long/vsync/ms', a.msg && a.msg.stats && ['p50', 'p95', 'max', 'dropped', 'long', 'vsync', 'ms'].every((k) => typeof a.msg.stats[k] === 'number'), JSON.stringify(a.msg && a.msg.stats));
    check('play: prepMs a number', a.msg && typeof a.msg.prepMs === 'number', a.msg && a.msg.prepMs);
    check('play: not timed out, no error', a.msg && a.msg.timedOut === false && !a.msg.error, JSON.stringify(a.msg));
    check('play: ends with the stage at 0 and the pose gone', st.stage === 0 && st.pose === 'gone' && st.running === 0, JSON.stringify(st));
    check('play: about its duration (700 ms + the picture)', a.ms !== null && a.ms >= FULL_MS - 50 && a.ms < FULL_MS + PAD + 1500, a.ms);

    /* 4. play with no picture: the fade */
    await op(page, { op: 'arm' });
    a = await op(page, { op: 'play', still: null, size: 'full' });
    st = await state(page);
    check('play without a picture -> played, technique fade', a.msg && a.msg.event === 'played' && a.msg.technique === 'fade', JSON.stringify(a.msg));
    check('fade ends with the stage at 0', st.stage === 0, st.stage);

    /* 5. a picture that does not decode: the fade, said in plain words */
    await op(page, { op: 'arm' });
    a = await op(page, { op: 'play', still: 'data:image/png;base64,AAAAbm90IGEgcGljdHVyZQ==', size: 'full' });
    st = await state(page);
    check('undecodable picture -> played, technique fade', a.msg && a.msg.event === 'played' && a.msg.technique === 'fade', JSON.stringify(a.msg));
    check('undecodable picture: a reason in plain words', a.msg && typeof a.msg.error === 'string' && /picture of the screen/.test(a.msg.error) && !JARGON.test(a.msg.error), a.msg && a.msg.error);
    check('undecodable picture: stage 0 after', st.stage === 0, st.stage);

    /* 6. a black picture: the fade, with the black reason */
    await op(page, { op: 'arm' });
    a = await op(page, { op: 'play', still: pics.black, size: 'full' });
    st = await state(page);
    check('black picture -> played, technique fade', a.msg && a.msg.event === 'played' && a.msg.technique === 'fade', JSON.stringify(a.msg));
    check('black picture: says it came back black', a.msg && a.msg.error === 'the picture of the screen came back black', a.msg && a.msg.error);
    check('black picture: nothing kept, stage 0', st.stage === 0 && st.still === false, JSON.stringify(st));
    a = await op(page, { op: 'cover', still: pics.black });
    check('black picture on cover -> covered ok false, the black reason', a.msg && a.msg.event === 'covered' && a.msg.ok === false && a.msg.error === 'the picture of the screen came back black', JSON.stringify(a.msg));
    a = await op(page, { op: 'cover' });
    check('cover without a picture -> covered ok false, plain words', a.msg && a.msg.ok === false && typeof a.msg.error === 'string' && !JARGON.test(a.msg.error), JSON.stringify(a.msg));

    /* 7. cover: sharp, then folded into blur, and it stays */
    a = await op(page, { op: 'cover', still: pics.ok });
    st = await state(page);
    check('cover -> covered ok true', a.msg && a.msg.event === 'covered' && a.msg.ok === true, JSON.stringify(a.msg));
    check('covered: pose covered, stage 1', st.pose === 'covered' && st.stage === 1, JSON.stringify(st));
    check('covered: drawn by gl, folded all the way, on screen', st.technique === 'gl' && st.frame && st.frame.cover === true && st.frame.fold === 1 && st.glShown === true, JSON.stringify(st));

    /* 8. reveal: back into focus and gone, fast */
    a = await op(page, { op: 'reveal' });
    st = await state(page);
    check('reveal -> revealed', a.msg && a.msg.event === 'revealed' && !a.msg.timedOut, JSON.stringify(a.msg));
    check('revealed: stage 0', st.stage === 0 && st.pose === 'gone', JSON.stringify(st));
    check('reveal within ~400 ms', a.ms !== null && a.ms < 400, a.ms + ' ms');
    console.log(`  reveal answered in ${a.ms} ms`);
    a = await op(page, { op: 'reveal' });
    check('reveal when nothing is up -> revealed (already)', a.msg && a.msg.event === 'revealed' && a.msg.already === true, JSON.stringify(a.msg));

    /* 9. finish mid-play: a fast fade from WHERE IT IS (no snap back to the seam) */
    await op(page, { op: 'arm' });
    const playSeq = await send(page, { op: 'play', still: pics.ok, size: 'full' });
    await page.waitForFunction(() => document.getElementById('stage').dataset.pose === 'opening' && window.__unfold.state().running > 0, null, { timeout: 8000 });
    await page.waitForTimeout(260);
    const before = await page.evaluate(() => { const f = window.__unfold.state().frame; return f ? f.open : 0; });
    const finSeq = await send(page, { op: 'finish' });
    const after = await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => { const f = window.__unfold.state().frame; r(f ? f.open : 0); })));
    a = await answer(page, finSeq);
    st = await state(page);
    check('finish mid-play -> finished', a.msg && a.msg.event === 'finished', JSON.stringify(a.msg));
    check('finish within ~300 ms', a.ms !== null && a.ms < 300, a.ms + ' ms');
    check('finished: stage 0', st.stage === 0, st.stage);
    check('finish holds the opening where it was (no snap back to the seam)', before > 0.2 && after >= before * 0.9, `opening ${before} -> ${after}`);
    console.log(`  finish answered in ${a.ms} ms (opening ${before.toFixed(3)} -> ${after.toFixed(3)})`);
    const p = await answer(page, playSeq, 3000);
    check('the interrupted play still answers once', p.msg && p.msg.event === 'played', JSON.stringify(p.msg));

    /* 10. skip */
    await op(page, { op: 'arm' });
    a = await op(page, { op: 'skip', reason: 'no picture came' });
    st = await state(page);
    check('skip -> skipped, stage 0', a.msg && a.msg.event === 'skipped' && st.stage === 0, JSON.stringify(a.msg) + ' ' + st.stage);

    /* 11. park: the pictures dropped */
    await op(page, { op: 'cover', still: pics.ok });
    check('a cover keeps the picture', (await state(page)).still === true);
    a = await op(page, { op: 'park' });
    st = await state(page);
    check('park -> parked', a.msg && a.msg.event === 'parked', JSON.stringify(a.msg));
    check('parked: pictures dropped, hidden', st.still === false && st.pose === 'parked' && st.stage === 0, JSON.stringify(st));
    const canv = await page.evaluate(() => ['ground', 'soft', 'smear'].map((id) => document.getElementById(id).width * document.getElementById(id).height).concat([document.getElementById('sharp').getAttribute('src') ? 1 : 0]));
    check('parked: canvases emptied, sharp picture removed', canv.join(',') === '1,1,1,0', canv.join(','));
    const glP = await page.evaluate(() => window.__unfold.gl());
    check('parked: the gl copies freed and the surface hidden', glP.ready === false && glP.atlas === null && st.glShown === false, JSON.stringify(glP) + ' shown ' + st.glShown);

    /* 12. unknown op */
    a = await op(page, { op: 'dance' });
    check('unknown op -> error', a.msg && a.msg.event === 'error' && /unknown op/.test(a.msg.error || ''), JSON.stringify(a.msg));

    /* 13. FROZEN frames: the hard timer ends play */
    await op(page, { op: 'arm' });
    let s = await send(page, { op: 'play', still: pics.ok, size: 'full' });
    let frozeAt = await freezeWhen(page, 'opening');
    a = await answer(page, s, 6000);
    let end = await page.evaluate((x) => { const t = window.__told.find((m) => m.msg.seq === x); return t ? t.at : null; }, s);
    st = await state(page);
    check('frozen play: froze', frozeAt !== null);
    check('frozen play -> played, timedOut true', a.msg && a.msg.event === 'played' && a.msg.timedOut === true, JSON.stringify(a.msg));
    const fp = frozeAt !== null && end !== null ? Math.round(end - frozeAt) : null;
    check('frozen play ends at its duration + 400 ms', fp !== null && fp >= FULL_MS + PAD - 120 && fp < FULL_MS + PAD + 400, fp + ' ms after it froze');
    check('frozen play: stage 0 after', st.stage === 0 && st.running === 0, JSON.stringify(st));
    console.log(`  frozen play ended ${fp} ms after the freeze (duration + pad = ${FULL_MS + PAD})`);

    /* 14. FROZEN frames: the hard timer ends reveal */
    await op(page, { op: 'cover', still: pics.ok });
    s = await send(page, { op: 'reveal' });
    frozeAt = await freezeWhen(page, 'revealing');
    a = await answer(page, s, 4000);
    end = await page.evaluate((x) => { const t = window.__told.find((m) => m.msg.seq === x); return t ? t.at : null; }, s);
    st = await state(page);
    check('frozen reveal -> revealed, timedOut true', a.msg && a.msg.event === 'revealed' && a.msg.timedOut === true, JSON.stringify(a.msg));
    const fr = frozeAt !== null && end !== null ? Math.round(end - frozeAt) : null;
    check('frozen reveal ends at its duration + 400 ms', fr !== null && fr >= REVEAL_MS + PAD - 120 && fr < REVEAL_MS + PAD + 400, fr + ' ms after it froze');
    check('frozen reveal: stage 0 after', st.stage === 0, st.stage);
    console.log(`  frozen reveal ended ${fr} ms after the freeze (duration + pad = ${REVEAL_MS + PAD})`);

    /* 14b. THE LOOK, per pixel (gl): a stripes picture (2 px columns), the frame held at 25/50/75 % */
    {
      const W = VIEW.width, H = VIEW.height, hx = W / 2, y = Math.round(H / 2);
      /** around x: the stripes' contrast (max - min luminance over 8 px; 0 = blurred flat), the mean
       * colour, the brightest channel, and which pixels are bright (the stripes' phase) */
      const look = async (x) => {
        const row = await page.evaluate((v) => window.__unfold.probe(v[0], v[1], v[2]), [y, x - 4, x + 4]);
        if (!row) return null;
        const L = row.map((p) => 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]);
        return { c: Math.round(Math.max(...L) - Math.min(...L)), mean: [0, 1, 2].map((k) => Math.round(row.reduce((t, p) => t + p[k], 0) / row.length)),
          top: Math.max(...row.map((p) => Math.max(...p))), phase: row.map((p) => (p[0] + p[1] + p[2] > 300 ? 1 : 0)).join('') };
      };
      const held = async (f) => {
        const fr = await page.evaluate((v) => window.__unfold.freeze(v, true), f);
        const w = fr.frame.open * hx, at = (d) => look(Math.round(hx - d * w));
        return { f: fr.frame, R: { fixed: await look(hx + 12), nearHinge: await at(0.03), d1: await at(0.06), d2: await at(0.12), d9: await at(0.9),
          out: fr.frame.open < 0.9 ? await look(Math.max(5, Math.round(hx - w - 24))) : null } };
      };
      await op(page, { op: 'arm' });
      const ps = await send(page, { op: 'play', still: pics.stripes, size: 'full' });
      await page.waitForFunction(() => document.getElementById('stage').dataset.pose === 'opening' && window.__unfold.state().running > 0, null, { timeout: 8000 });
      // 25 %: swinging; 50 %: landed with its blur and dimming still on (the Duo's linger); 75 %:
      // releasing; 97 %: released (sharp, full brightness) as the stage hands over
      const q = await held(0.25), h2 = await held(0.5), h3 = await held(0.75), h4 = await held(0.97);
      for (const [n, x] of [['25', q], ['50', h2], ['75', h3], ['97', h4]]) console.log(`  look at ${n} %: open ${x.f.open.toFixed(3)}, blur ${x.f.strength.toFixed(3)}, dimming ${x.f.dark.toFixed(3)}; ` + JSON.stringify(x.R));
      const R = q.R;
      const neutral = (m) => m && Math.abs(m[2] - m[0]) <= 3 && Math.abs(m[2] - m[1]) <= 3 && Math.abs(m[1] - m[0]) <= 3;
      check('look 25 %: part way open (the moving half between a fifth and nine tenths open)', q.f.open > 0.2 && q.f.open < 0.9, q.f.open);
      check('look 25 %: the fixed half is sharp and at full brightness (Apple\'s clips)', R.fixed && R.fixed.c > 120 && R.fixed.top >= 250, JSON.stringify(R.fixed));
      check('look 25 %: sharp at the hinge on the moving half too', R.nearHinge && R.nearHinge.c > 120, JSON.stringify(R.nearHinge));
      check('look 25 %: the blur grows from the hinge toward the moving free edge', R.d1 && R.d2 && R.d9 && R.nearHinge.c > R.d1.c && R.d1.c > R.d2.c && R.d2.c >= R.d9.c && R.d9.c < 25,
        JSON.stringify([R.nearHinge && R.nearHinge.c, R.d1 && R.d1.c, R.d2 && R.d2.c, R.d9 && R.d9.c]));
      // Owen 2026-10-23, live: "way too blue", "more transparent so you can see the outline of the
      // background"; Apple's clips: the dimming is a neutral black multiply and the free edge never black
      check('look 25 %: the free edge dims, but never to black (the blurred stripes stay well above it)', R.d9 && R.d9.mean[1] > 45 && R.d9.mean[1] < 110, JSON.stringify(R.d9 && R.d9.mean));
      check('look 25 %: no tint anywhere (the free edge, the hinge and the fixed half are neutral)', neutral(R.d9 && R.d9.mean) && neutral(R.nearHinge && R.nearHinge.mean) && neutral(R.fixed && R.fixed.mean),
        JSON.stringify([R.d9 && R.d9.mean, R.nearHinge && R.nearHinge.mean, R.fixed && R.fixed.mean]));
      check('look 25 %: past the free edge is the unlit display (black)', R.out && R.out.top <= 3, JSON.stringify(R.out));
      check('look 50 %: landed open with the blur and dimming still on (the Duo lands first, then releases)', h2.f.open > 0.95 && h2.R.d9 && h2.R.d9.c < 25 && h2.R.d9.mean[1] < 110, JSON.stringify([h2.f.open, h2.R.d9]));
      check('look 75 %: releasing (the free edge lighter and no blurrier than at 50 %)', h3.R.d9 && h2.R.d9 && h3.R.d9.mean[1] > h2.R.d9.mean[1] && h3.R.d9.c >= h2.R.d9.c, JSON.stringify([h2.R.d9, h3.R.d9]));
      check('look 97 %: released, sharp and at full brightness all the way to the edge', h4.f.open > 0.999 && h4.R.d9 && h4.R.d9.c > 120 && h4.R.d9.top >= 250 && h4.R.fixed && h4.R.fixed.top >= 250, JSON.stringify([h4.f.open, h4.R.d9, h4.R.fixed]));
      check('look: the content is fixed in space (the stripes keep their phase at 25, 50, 75 and 97 %)', [q, h2, h3, h4].every((x) => x.R.fixed && x.R.fixed.phase === R.fixed.phase),
        JSON.stringify([q, h2, h3, h4].map((x) => x.R.fixed && x.R.fixed.phase)));
      await page.evaluate(() => window.__unfold.freeze(null));
      a = await answer(page, ps, 4000);
      check('look: the held play ends played once let go (not timed out)', a.msg && a.msg.event === 'played' && a.msg.timedOut === false, JSON.stringify(a.msg));
      // the cover: the outer edges first, the hinge last, then evenly out of focus and shaded
      const cs = await send(page, { op: 'cover', still: pics.stripes });
      await page.waitForFunction(() => document.getElementById('stage').dataset.pose === 'covering' && window.__unfold.state().running > 0, null, { timeout: 8000 });
      const cf = await page.evaluate(() => window.__unfold.freeze(0.05, true));   // the fold eases in fast: 5 % is early in it
      const cHinge = await look(hx + 4), cEdge = await look(12);
      await page.evaluate(() => window.__unfold.freeze(null));
      a = await answer(page, cs, 4000);
      const eHinge = await look(hx + 4), eEdge = await look(12);
      console.log(`  cover at 5 % (fold ${cf.frame.fold.toFixed(3)}): hinge ${JSON.stringify(cHinge)}, edge ${JSON.stringify(cEdge)}; covered: hinge ${JSON.stringify(eHinge)}, edge ${JSON.stringify(eEdge)}`);
      check('cover mid-fold: the edges blur first (flatter at the edge than at the hinge)', cHinge && cEdge && cEdge.c < cHinge.c, JSON.stringify([cHinge && cHinge.c, cEdge && cEdge.c]));
      check('covered: evenly out of focus (no stripes at the hinge or the edge)', a.msg && a.msg.ok === true && eHinge && eEdge && eHinge.c < 8 && eEdge.c < 8, JSON.stringify([eHinge, eEdge]));
      check('covered: lightly dimmed (the same lighter look: well above half brightness) and neutral everywhere', eHinge && eEdge && eHinge.mean[1] > 80 && eHinge.mean[1] < 122 && eEdge.mean[1] > 80 && [eHinge.mean, eEdge.mean].every((m) => Math.abs(m[2] - m[0]) <= 3 && Math.abs(m[1] - m[0]) <= 3), JSON.stringify([eHinge && eHinge.mean, eEdge && eEdge.mean]));
      a = await op(page, { op: 'reveal' });
      check('look: the cover reveals', a.msg && a.msg.event === 'revealed' && (await state(page)).stage === 0, JSON.stringify(a.msg));
      // ONE smooth gradient (Owen, live: the blur showed steps where its levels change): a light top
      // half over a dark bottom half, rows just above and below the edge, across the moving half at
      // 15/25/35 %. As the blur grows toward the free edge the luminance along a row changes smoothly:
      // the slope over the next 5 px never turns from the slope over the last 5 px by more than KINK
      // (a hand-over between levels shows as such a turn) and no neighbour jumps more than JUMP.
      {
        const KINK = 3, JUMP = 12;
        await op(page, { op: 'arm' });
        const es = await send(page, { op: 'play', still: pics.edge, size: 'full' });
        await page.waitForFunction(() => document.getElementById('stage').dataset.pose === 'opening' && window.__unfold.state().running > 0, null, { timeout: 8000 });
        const bands = [];
        for (const f of [0.15, 0.25, 0.35]) {
          const fr = await page.evaluate((v) => window.__unfold.freeze(v, true), f);
          const w = Math.round(fr.frame.open * hx), x0 = Math.round(hx - w + 2), x1 = Math.round(hx);
          for (const dy of [-12, -5, 5, 12]) {
            const row = await page.evaluate((v) => window.__unfold.probe(v[0], v[1], v[2]), [Math.round(H / 2 + dy), x0, x1]);
            const L = (row || []).map((p) => 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]);
            let kink = 0, jump = 0;
            const K = 5;
            for (let i = 1; i < L.length; i++) jump = Math.max(jump, Math.abs(L[i] - L[i - 1]));
            for (let i = K; i + K < L.length; i++) kink = Math.max(kink, Math.abs((L[i + K] - L[i]) / K - (L[i] - L[i - K]) / K));
            bands.push({ f, dy, n: L.length, kink: +kink.toFixed(2), jump: +jump.toFixed(1) });
          }
        }
        await page.evaluate(() => window.__unfold.freeze(null));
        await answer(page, es, 4000);
        console.log('  smoothness (edge picture, kink/jump per row): ' + bands.map((b) => `${b.f}/${b.dy}:${b.kink}/${b.jump}`).join(' '));
        check('look: the blur is one smooth gradient across the moving half (no turn or jump where its levels hand over)',
          bands.length === 12 && bands.every((b) => b.n > 20 && b.kink <= KINK && b.jump <= JUMP), JSON.stringify(bands.filter((b) => !(b.n > 20 && b.kink <= KINK && b.jump <= JUMP))));
      }
      // the comparison technique on request (the bench's), no fallback reason
      await op(page, { op: 'arm' });
      a = await op(page, { op: 'play', still: pics.ok, size: 'full', tech: 'layers' });
      check('tech layers on request: played by layers, no fallback', a.msg && a.msg.event === 'played' && a.msg.technique === 'layers' && !a.msg.fallback && a.msg.stats && a.msg.stats.frames > 0, JSON.stringify(a.msg));
      await op(page, { op: 'park' });
    }

    /* 14c. NO WebGL: the simpler unfold plays and covers, and every answer says why in plain words */
    {
      const np = await open(false, () => { const g = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function (k, o) { return /webgl/i.test(k) ? null : g.call(this, k, o); }; });
      const r0 = (await np.evaluate(() => window.__told.map((t) => t.msg)))[0] || {};
      check('no WebGL: ready says layers, with the reason', r0.technique === 'layers' && typeof r0.fallback === 'string' && /graphics card/.test(r0.fallback) && !JARGON.test(r0.fallback), JSON.stringify(r0));
      await op(np, { op: 'arm' });
      a = await op(np, { op: 'play', still: pics.ok, size: 'full' });
      check('no WebGL: play is played by layers, frames counted, the reason carried', a.msg && a.msg.event === 'played' && a.msg.technique === 'layers' && a.msg.fallback === r0.fallback && a.msg.stats && a.msg.stats.frames > 0 && !a.msg.timedOut, JSON.stringify(a.msg));
      a = await op(np, { op: 'cover', still: pics.ok });
      const npc = await np.evaluate(() => ({ ground: +getComputedStyle(document.getElementById('ground')).opacity, tint: +getComputedStyle(document.getElementById('tint')).opacity }));
      check('no WebGL: cover covers (the frosted picture and the tint up), the reason carried', a.msg && a.msg.ok === true && a.msg.technique === 'layers' && a.msg.fallback === r0.fallback && npc.ground > 0.9 && npc.tint > 0.15 && npc.tint < 0.4, JSON.stringify(a.msg) + ' ' + JSON.stringify(npc));
      a = await op(np, { op: 'reveal' });
      check('no WebGL: reveal', a.msg && a.msg.event === 'revealed' && (await state(np)).stage === 0, JSON.stringify(a.msg));
    }

    /* 15. reduced motion (Windows "Animation effects" off) */
    const rp = await open(true);
    check('reduced motion seen by the page', (await state(rp)).reduced === true);
    await op(rp, { op: 'arm' });
    a = await op(rp, { op: 'play', still: pics.ok, size: 'full' });
    check('reduced: play -> fade', a.msg && a.msg.event === 'played' && a.msg.technique === 'fade' && a.msg.reduced === true, JSON.stringify(a.msg));
    check('reduced: play is short', a.ms !== null && a.ms < 400, a.ms + ' ms');
    a = await op(rp, { op: 'cover', still: pics.ok });
    check('reduced: cover -> covered ok, 120 ms', a.msg && a.msg.ok === true && a.msg.stats && a.msg.stats.ms === 120, JSON.stringify(a.msg && a.msg.stats));
    check('reduced: cover answered soon', a.ms !== null && a.ms < (a.msg && a.msg.prepMs || 0) + 400, a.ms + ' ms');
    a = await op(rp, { op: 'reveal' });
    check('reduced: reveal 120 ms', a.msg && a.msg.event === 'revealed' && a.msg.stats && a.msg.stats.ms === 120, JSON.stringify(a.msg && a.msg.stats));
    check('reduced: reveal answered within ~300 ms', a.ms !== null && a.ms < 300, a.ms + ' ms');
    console.log(`  reduced reveal answered in ${a.ms} ms`);

    /* 0. the element version (shared unfold.css/js), normal and reduced motion */
    await elementChecks(page, false);
    await elementChecks(rp, true);

    /* 16. every answer: seq and display, never image data */
    for (const pg of pages) {
      const all = await pg.evaluate(() => window.__told.map((t) => ({ name: t.name, msg: t.msg })));
      const noSeq = all.filter((t) => typeof t.msg.seq !== 'number' || t.msg.display !== '7');
      check('every answer has a seq and the display (' + all.length + ' answers)', all.length > 3 && noSeq.length === 0, JSON.stringify(noSeq).slice(0, 200));
      check('every answer goes to unfold.page', all.every((t) => t.name === 'unfold.page'));
      const fat = all.filter((t) => /data:image|base64/.test(JSON.stringify(t.msg)) || JSON.stringify(t.msg).length > 1500);
      check('no answer carries image data', fat.length === 0, JSON.stringify(fat).slice(0, 200));
      const jargon = all.filter((t) => t.msg.error && t.msg.event !== 'error' && JARGON.test(t.msg.error));
      check('every reason is in plain words', jargon.length === 0, JSON.stringify(jargon.map((t) => t.msg.error)));
    }
    check('no page errors', errors.length === 0, errors.join(' | '));
  } catch (e) {
    if (String(e && e.message) !== 'ONLY') failures.push('harness: ' + String((e && e.stack) || e).split('\n').slice(0, 3).join(' '));
  } finally {
    await browser.close();
  }
  if (failures.length) failures.forEach((f) => console.log('  FAIL ' + f));
  console.log(`UNFOLD PAGE TEST: ${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
}

main();
