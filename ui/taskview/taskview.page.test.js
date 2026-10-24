require('../../tools/dev-env.js').lowcpu();
/* taskview.page.test.js - the REAL Task View page (index.html + layout.js + taskview.js) on its MOCK
 * (mock-mantle.js plays main: a session of fake windows; it paints fake "DWM pictures" into the boxes the
 * page reports; nothing is switched, moved or closed), in headless Chromium over file://.
 *
 * WAVE UNFOLD (2026-10-23): Task View arrives with the shared unfold (ui/shared/unfold.js, size 'pop') on
 * #stage, the host that carries the whole page, its sheet included. Proves:
 *   - it rests FOLDED before the first paint (no frame of an open page), and the sheet is on the stage
 *     (a body background is the canvas's, which nothing can fold);
 *   - while it unfolds the page reports NO boxes (DWM would draw sharp pictures over a folded page), and
 *     the boxes go, exactly the .pv elements, once it has landed: open, sharp, unclipped;
 *   - main's answer to taskview.painted starts it; taskview.shown starts it; a page whose painted call
 *     failed, or that main keeps "waiting", still opens (by 600 ms): never stuck folded;
 *   - taskview.end snaps it shut (takes no click); MantleTaskViewFold() folds it shut and resolves;
 *   - typing during the unfold filters (no key lost);
 *   - reduced motion: a cross-fade, nothing clipped, stretched or blurred;
 *   - dark: the wallpaper picture (ui/shared/wall-bdrop.js) is adopted into the stage, so it folds too.
 *   node ui/taskview/taskview.page.test.js   ->  "TASKVIEW PAGE TEST: n passed, m failed"
 */
'use strict';
const path = require('path');

let chromium = null;
for (const c of require('../../tools/dev-env.js').playwrightCandidates()) { try { chromium = require(c).chromium; break; } catch (e) { /* next */ } }
const PAGE = 'file:///' + path.join(__dirname, 'index.html').replace(/\\/g, '/');
let passed = 0;
const failures = [];
const check = (name, ok, detail) => { if (ok) passed++; else failures.push(detail !== undefined ? `${name} (${String(detail).slice(0, 300)})` : name); return ok; };
/* the unfold's no-frame fallback (finish on a timer at duration + 150 ms) would land a frozen frame
   mid-shot: while window.__freezeMs is set, that one timer is held (the seam checks only) */
const HOLD_TIMER = () => {
  const st = window.setTimeout;
  window.setTimeout = function (fn, ms) { if (window.__freezeMs && Number(ms) === window.__freezeMs) return 0; return st.apply(this, arguments); };
};
/* the seam limits (measured 2026-10-24, lane unfold-seams; the numbers are in the commit) */
const SEAM_D2 = 2.5, SEAM_LEAK = 0.05, SEAM_BAND = 3;
/* the seam numbers of a FROZEN unfold (lane unfold-seams; see 5b): the blurred part of the leaf, from 0.15
   of its width (the blur fully on) to the free edge, shot with the effect and with the effect layer hidden
   (the sharp page, the same clip). Over the column-mean luma p(x): max |p(x-1) - 2 p(x) + p(x+1)| of each,
   their ratio, the share of the sharp page's edges that shows through (the projection of the one's second
   differences on the other's), and the free edge's last 5 columns against 21-30 px before */
const seamsOf = async (page, sel, bleed) => {
  await page.waitForTimeout(150);                             // a few frames for the layers to be placed
  const g = await page.evaluate(([sel, bleed]) => {
    const el = document.querySelector(sel), r = el.getBoundingClientRect();
    const clip = el.getAnimations().find((a) => 'clipPath' in a.effect.getKeyframes()[0]);
    const t = clip && clip.effect.getComputedTiming(), e = t && t.progress !== null ? t.progress : 1, half = el.offsetWidth / 2;
    const s1 = el.querySelector(':scope > .ul-fx > .ul-strip'), m1 = s1 && /([\d.]+)px\)$/.exec(s1.style.maskImage || '');   // where the first layer is fully on
      const x0 = Math.ceil(m1 ? r.left + s1.offsetLeft + Number(m1[1]) : r.left + half + 0.15 * e * half), xe = Math.floor(Math.min(r.left + half + e * (half + bleed), r.right - 1)) - 1;   // the pane's own edge is not the blur
    const y0 = Math.max(0, Math.ceil(r.top) + 2), y1 = Math.min(innerHeight, Math.floor(r.bottom) - 2);
    return { x: x0, y: y0, width: Math.max(1, xe - x0), height: Math.max(1, y1 - y0), anim: el.dataset.unfoldAnim || '' };
  }, [sel, bleed]);
  const clip = { x: g.x, y: g.y, width: g.width, height: g.height };
  const fxShot = await page.screenshot({ clip });
  await page.evaluate((sel) => { const f = document.querySelector(sel).querySelector(':scope > .ul-fx'); if (f) f.style.visibility = 'hidden'; }, sel);
  await page.waitForTimeout(60);
  const refShot = await page.screenshot({ clip });
  await page.evaluate((sel) => { const f = document.querySelector(sel).querySelector(':scope > .ul-fx'); if (f) f.style.visibility = ''; window.__freezeMs = 0; }, sel);
  return page.evaluate(async ([a, b, anim]) => {
    const prof = async (b64) => {
      const im = new Image(); im.src = 'data:image/png;base64,' + b64; await im.decode();
      const c = document.createElement('canvas'); c.width = im.width; c.height = im.height;
      const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(im, 0, 0);
      const d = x.getImageData(0, 0, c.width, c.height).data, p = [];
      for (let i = 0; i < c.width; i++) { let s = 0; for (let j = 0; j < c.height; j++) { const o = (j * c.width + i) * 4; s += 0.2126 * d[o] + 0.7152 * d[o + 1] + 0.0722 * d[o + 2]; } p.push(s / c.height); }
      return p;
    };
    const pf = await prof(a), pr = await prof(b), n = pf.length;
    let mf = 0, mr = 0, fr = 0, rr = 0;
    for (let i = 1; i < n - 3; i++) {
      const f = pf[i - 1] - 2 * pf[i] + pf[i + 1], r = pr[i - 1] - 2 * pr[i] + pr[i + 1];
      mf = Math.max(mf, Math.abs(f)); mr = Math.max(mr, Math.abs(r)); fr += f * r; rr += r * r;
    }
    const mean = (i, j) => { let t = 0; for (let k = Math.max(0, i); k < j; k++) t += pf[k]; return t / Math.max(1, j - Math.max(0, i)); };
    const r3 = (v) => Math.round(v * 1000) / 1000;
    return { anim, cols: n, fx: r3(mf), ref: r3(mr), ratio: r3(mf / Math.max(1e-6, mr)), leak: r3(fr / Math.max(1e-6, rr)), band: r3(mean(n - 5, n) - mean(n - 31, n - 21)) };
  }, [fxShot.toString('base64'), refShot.toString('base64'), g.anim]);
};

const FIRST_FRAME = () => {
  // registered before any page script: the FIRST rAF callback, i.e. the frame before the first paint
  requestAnimationFrame(() => {
    const st = document.getElementById('stage');
    const cs = st && getComputedStyle(st);
    window.__firstFrame = st ? { state: st.dataset.unfold, size: st.dataset.unfoldSize, op: cs.opacity, clip: cs.clipPath } : null;
  });
};
/* main's painted answer, changed: 'reject' (the call fails) or 'waiting' (main is still resizing it) */
const PAINTED = (how) => {
  let v;
  Object.defineProperty(window, 'mantle', { configurable: true, get() { return v; }, set(m) {
    const real = m.call;
    m.call = function (n, a) {
      if (n === 'taskview.painted') {
        if (how === 'reject') return Promise.reject(new Error('Task View lost its window'));
        real.call(m, n, a);
        return how === 'reject' ? Promise.reject(new Error('Task View lost its window')) : Promise.resolve({ ok: true, waiting: 'the page is 1x1, the window is going to 1536x864' });
      }
      return real.call(m, n, a);
    };
    v = m;
  } });
};

async function main() {
  if (!chromium) { console.log('TASKVIEW PAGE TEST: 0 passed, 1 failed (playwright-core not found)'); process.exit(1); }
  const browser = await require('../settings/test-browser.js').launch(chromium, { headless: true });
  const errors = [];
  const open = async (qs, init, opts) => {
    const ctx = await browser.newContext(Object.assign({ viewport: { width: 1536, height: 864 }, deviceScaleFactor: 1 }, opts || {}));
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    for (const i of [].concat(init || [])) await page.addInitScript(i.fn || i, i.arg);
    await page.goto(PAGE + (qs || ''), { waitUntil: 'load' });
    return page;
  };
  const pose = (p) => p.evaluate(() => {
    const st = document.getElementById('stage'), cs = getComputedStyle(st), m = window.__mock;
    const painted = m.calls.filter((c) => c.name === 'taskview.painted').map((c) => (c.args.boxes || []).length);
    const fx = st.querySelector(':scope > .ul-fx'), r = (v) => { const mm = /blur\(([\d.]+)px\)/.exec(v || ''); return mm ? Number(mm[1]) : 0; };
    return { state: st.dataset.unfold, anim: st.dataset.unfoldAnim || '', op: Number(cs.opacity), clip: cs.clipPath, filter: cs.filter, pe: cs.pointerEvents, fx: fx ? getComputedStyle(fx).display : 'absent',
      strips: fx ? [...fx.querySelectorAll('.ul-strip')].filter((x) => getComputedStyle(x).display !== 'none').map((x) => r(getComputedStyle(x).backdropFilter)) : [],
      props: st.getAnimations().map((a) => Object.keys(a.effect.getKeyframes()[0]).filter((k) => !['offset', 'easing', 'composite', 'computedOffset'].includes(k)).join('+')),
      painted, boxes: (m.boxes || []).length, tiles: document.querySelectorAll('.tile').length };
  });
  /* the first painted call has gone and main's answer has started the unfold: read as soon as that is so */
  const started = (p) => p.waitForFunction(() => document.getElementById('stage').dataset.unfold === 'open' &&
    window.__mock.calls.some((c) => c.name === 'taskview.painted'), null, { timeout: 2000, polling: 'raf' }).then(() => true, () => false);
  const blurPx = (f) => { const m = /blur\(([\d.]+)px\)/.exec(f || ''); return m ? Number(m[1]) : 0; };
  const isOpen = (u) => u.state === 'open' && !u.anim && u.op === 1 && u.clip === 'none' && u.filter === 'none' && u.fx !== 'block' && u.props.length === 0;
  const landed = (p) => p.waitForFunction(() => { const st = document.getElementById('stage'); const m = window.__mock;
    return st.dataset.unfold === 'open' && m.boxes && m.boxes.length > 0; }, null, { timeout: 3000, polling: 20 }).then(() => true, () => false);
  try {
    /* 1. first paint folded; the sheet on the stage */
    let page = await open('?n=7', FIRST_FRAME);
    await started(page);
    const early = await pose(page);
    const ff = await page.evaluate(() => window.__firstFrame);
    check('rests FOLDED before the first paint (no frame of an open page)', ff && ff.state === 'folded' && Number(ff.op) === 0, JSON.stringify(ff));
    check('the unfold host is size pop and holds the whole page', ff && ff.size === 'pop' &&
      await page.evaluate(() => ['strip', 'search', 'grid', 'foot', 'empty', 'toast', 'dragChip'].every((id) => document.getElementById('stage').contains(document.getElementById(id)))));
    const sheet = await page.evaluate(() => ({ body: getComputedStyle(document.body).backgroundImage + '|' + getComputedStyle(document.body).backgroundColor, stage: getComputedStyle(document.getElementById('stage')).backgroundImage }));
    check('the sheet is on the stage, not on body (the canvas cannot fold)', /none\|rgba\(0, 0, 0, 0\)/.test(sheet.body) && /gradient/.test(sheet.stage), JSON.stringify(sheet));
    check('while it unfolds: no boxes reported (DWM draws nothing over a folded page)', early.painted.length >= 1 && early.painted.every((n) => n === 0) && early.boxes === 0, JSON.stringify(early));
    check('mid-open: opening from the hinge with its blur strips (and no boxes yet)', early.state === 'open' && early.anim === 'opening' && early.clip !== 'none' && early.fx === 'block', JSON.stringify(early));
    check('it lands with its boxes', await landed(page));
    let u = await pose(page);
    check('landed: at rest, nothing left on the page (no clip, filter, effect layer or animation)', isOpen(u), JSON.stringify(u));
    const same = await page.evaluate(() => {
      const pvs = [...document.querySelectorAll('.tile .pv')].map((e) => e.getBoundingClientRect()), b = window.__mock.boxes;
      return b.length === pvs.length && b.every((x, i) => Math.abs(x.x - pvs[i].left) < 0.5 && Math.abs(x.y - pvs[i].top) < 0.5 && Math.abs(x.w - pvs[i].width) < 0.5 && Math.abs(x.h - pvs[i].height) < 0.5);
    });
    check('landed: the boxes are exactly the .pv elements (no stretch left in them)', same);
    const ms = await page.evaluate(() => { const c = window.__mock.calls.filter((x) => x.name === 'taskview.painted'); return Math.round(c[c.length - 1].args.t - c[0].args.t); });
    check('the boxes go about one unfold after the first report (not before, not seconds late)', ms >= 250 && ms < 900, ms);

    /* 2. the close: taskview.end snaps it shut; the next open unfolds again */
    await page.evaluate(() => window.__mockEmit('taskview.end', { seq: window.__mockSeq(), why: 'Esc' }));
    u = await pose(page);
    check('taskview.end: snapped shut at once, takes no click', u.state === 'folded' && u.op === 0 && u.pe === 'none', JSON.stringify(u));
    await page.evaluate(() => { window.__mock.calls.length = 0; window.__mock.open(); });
    await page.waitForTimeout(60);
    u = await pose(page);
    check('a second open unfolds again, no boxes until it lands', u.state === 'open' && u.painted.every((n) => n === 0), JSON.stringify(u));
    check('a second open lands with its boxes', await landed(page));
    /* MantleTaskViewFold(): the close, played (for a main that waits for it before parking) */
    const t0 = Date.now();
    const fr = await page.evaluate(() => window.MantleTaskViewFold());
    const foldMs = Date.now() - t0;
    u = await pose(page);
    check('MantleTaskViewFold() folds it shut and resolves', fr && fr.state === 'folded' && u.state === 'folded' && u.op === 0, JSON.stringify({ fr, u }));
    check('the fold resolves inside its cap (duration + 150 ms)', foldMs < 700, foldMs);
    await page.context().close();

    /* 3. taskview.shown starts it (main's optional event): idempotent with the painted answer */
    page = await open('?n=4');
    await page.evaluate(() => window.__mockEmit('taskview.shown', { seq: window.__mockSeq() }));
    check('taskview.shown: lands open with its boxes', await landed(page) && isOpen(await pose(page)));
    await page.context().close();

    /* 4. never stuck folded: a failed painted call, a main that keeps "waiting" */
    page = await open('?n=4', { fn: PAINTED, arg: 'reject' });
    await page.waitForTimeout(700);
    u = await pose(page);
    const foot = await page.evaluate(() => document.getElementById('foot').textContent);
    check('a failed painted call: it still opens, and says why', u.state === 'open' && u.op === 1 && /lost its window/.test(foot), JSON.stringify({ u, foot }));
    await page.context().close();
    page = await open('?n=4', { fn: PAINTED, arg: 'waiting' });
    await page.waitForTimeout(250);
    check('main still sizing it: it waits folded', (await pose(page)).state === 'folded');
    await page.waitForTimeout(800);
    check('main still sizing it: open by 600 ms anyway (never stuck folded)', (await pose(page)).state === 'open');
    await page.context().close();

    /* 5. typing during the unfold filters; no key lost */
    page = await open('?n=9');
    await started(page);
    const atKey = await pose(page);
    await page.keyboard.type('code', { delay: 0 });
    check('typing: the keys land while it is still unfolding', atKey.state === 'open' && atKey.boxes === 0, JSON.stringify(atKey));
    await landed(page);
    await page.waitForTimeout(150);
    const q = await page.evaluate(() => ({ q: document.getElementById('q').textContent, tiles: document.querySelectorAll('.tile').length }));
    check('typing: every key typed during the unfold is in the filter', q.q === 'code' && q.tiles > 0 && q.tiles < 9, JSON.stringify(q));
    await page.context().close();

    /* 5b. NO SEAMS (lane unfold-seams, 2026-10-24: Owen saw steps and bands in the blur; the frames had vertical
       seams). Frozen at half its time (seamsOf above). The old tent strips let up to 25 % of the SHARP page
       through between their centres and seamed; stacked layers blur one image: no sharp edge shows through. */
    page = await open('?n=7', HOLD_TIMER);
    await landed(page);
    await page.evaluate(async () => {
      const el = document.getElementById('stage'), D = window.MantleUnfoldLive.ms(el, { size: 'pop' });
      window.__freezeMs = D + 150;
      window.__mockEmit('taskview.end', { seq: window.__mockSeq(), why: 'seams' });
      window.__mock.open();
      for (let i = 0; i < 200 && el.dataset.unfoldAnim !== 'opening'; i++) await new Promise((r) => setTimeout(r, 2));
      for (const a of el.getAnimations()) { a.pause(); a.currentTime = D / 2; }
    });
    const sm = await seamsOf(page, '#stage', 0);
    console.log('seams taskview ' + JSON.stringify(sm));
    check(`mid-open: the blur has no seams (max 2nd difference of the column means under ${SEAM_D2} levels: the 8-bit floor, HEAD 6a73958 had 2.96)`,
      sm.anim === 'opening' && sm.cols > 200 && sm.fx < SEAM_D2, JSON.stringify(sm));
    check(`mid-open: none of the sharp page shows through the blur (its share under ${SEAM_LEAK})`, sm.cols > 200 && Math.abs(sm.leak) < SEAM_LEAK, JSON.stringify(sm));
    check('mid-open: the free edge is dimmed like the leaf before it (no pale band)', sm.cols > 200 && sm.band < SEAM_BAND, JSON.stringify(sm));
    await page.context().close();

    /* 6. reduced motion: a cross-fade */
    page = await open('?n=4', null, { reducedMotion: 'reduce' });
    u = await pose(page);
    check('reduced motion: only opacity is animated', u.props.length > 0 && u.props.every((k) => k === 'opacity'), JSON.stringify(u.props));
    check('reduced motion: mid-open nothing is clipped or blurred, no effect layer', u.clip === 'none' && u.fx !== 'block' && u.strips.length === 0, JSON.stringify(u));
    check('reduced motion: lands with its boxes', await landed(page) && isOpen(await pose(page)));
    const rms = await page.evaluate(() => { const c = window.__mock.calls.filter((x) => x.name === 'taskview.painted'); return Math.round(c[c.length - 1].args.t - c[0].args.t); });
    check('reduced motion: the boxes follow the short fade, not the full unfold', rms < 300, rms);
    await page.context().close();

    /* 7. dark: the wallpaper picture folds with the page */
    const DARK = () => {
      const set = () => { if (!document.documentElement) return false; document.documentElement.dataset.theme = 'dark'; return true; };
      if (!set()) new MutationObserver((_, mo) => { if (set()) mo.disconnect(); }).observe(document, { childList: true });
    };
    page = await open('?n=4', DARK);
    await page.evaluate(() => {
      const c = document.createElement('canvas'); c.width = 64; c.height = 36;
      const g = c.getContext('2d'); g.fillStyle = '#3a5f7a'; g.fillRect(0, 0, 64, 36);
      window.__mockEmit('taskview.wall', { ok: true, png: c.toDataURL('image/png'), key: 'k1', display: { x: 0, y: 0, width: 1536, height: 864 } });
    });
    await page.waitForFunction(() => document.getElementById('wall-bdrop'), null, { timeout: 2000 }).catch(() => {});
    const wall = await page.evaluate(() => { const w = document.getElementById('wall-bdrop'); return w ? { inStage: w.parentNode === document.getElementById('stage'), first: document.getElementById('stage').firstChild === w } : null; });
    check('dark: the wallpaper picture is on the stage (it folds with the page)', wall && wall.inStage && wall.first, JSON.stringify(wall));
    check('dark: lands open with its boxes', await landed(page) && isOpen(await pose(page)));
    await page.context().close();

    check('no page errors', errors.length === 0, errors.join(' | '));
  } catch (e) {
    failures.push('crashed: ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' / ') : e));
  } finally {
    await browser.close();
  }
  for (const f of failures) console.log('FAIL ' + f);
  console.log(`TASKVIEW PAGE TEST: ${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
}
main();
