/* unfold-live.js - MantleUnfoldLive: the iPhone Duo unfold on a LIVE pane (the launcher, Task View); the
 * look is described in unfold-live.css (wave unfold, 2026-10-23). The names follow MantleUnfold's:
 *
 *   MantleUnfoldLive.rest(el, { state = 'folded', size })   jump to a pose, nothing plays
 *   MantleUnfoldLive.open(el, { size, bleed })  -> Promise { ok, state: 'open', timedOut, frames }
 *   MantleUnfoldLive.fold(el, { size, bleed })  -> Promise { ok, state: 'folded', timedOut, frames }
 *   MantleUnfoldLive.ms(el, { size })           the duration it plays for (reduced motion: the fade)
 *
 * size: 'full' | 'pop' | 'quick' -> unfold.css's --unfold-<size>-ms; the curve is unfold-live.css's
 * --ul-ease-in (open) / --ul-ease-out (fold), else unfold.css's --unfold-in / --unfold-out. bleed: px the
 * pane paints OUTSIDE its box (a drop shadow), kept unclipped above, below and on the cover side. The
 * promise resolves when the WHOLE motion has landed (the effect's release included), and on a timer
 * (duration + 150 ms) if no frame comes (a hidden window), so a caller never waits forever.
 *
 * MEASURED DUO (real Apple footage, mantle-night/duo-ref/SPEC.md, 2026-10-23), which this follows:
 *   - the leaf swings open with a slow start, peak speed mid-way and a strong ease-out, and LANDS at about
 *     85 % of the time; the blur and the dim stay on the landed pane and fade out over the last ~15 %;
 *   - blur only on the moving leaf: sharp at the hinge, growing fast and flattening toward the free edge
 *     (closer to linear/sqrt than cubic), at most ~3.3 % of the open width; weaker by the landing;
 *   - the dim is a NEUTRAL black multiply, no hue: gain ~0.9 near the hinge, ~0.8 mid-leaf, ~0.43 at the
 *     free edge (never black); the stationary half stays at full brightness throughout.
 *
 * HOW: the pane is clipped to its left half + the open width (a Web Animation of clip-path on the curve,
 * over the geometry's share of the time), and while it plays a layer on top (.ul-fx) carries the
 * backdrop-filter layers (stacked: one smooth ramp, below) and the dim; each frame reads the time and the
 * clip's own eased progress and places them. When it lands the layer goes (display: none) and the pane has
 * no clip or filter left: zero cost at rest. Prefers-reduced-motion: opacity only, 120 ms linear. A pane
 * whose data-unfold is "folded" is invisible (unfold-live.css).
 *
 * THE BLUR LAYERS, and why they are stacked (lane unfold-seams, 2026-10-24: Owen saw steps and bands; the
 * frames showed vertical seams). Two facts of backdrop-filter decide the shape:
 *   1. a layer is drawn OVER what is under it (mask = its alpha): out = m * blur(under) + (1 - m) * under.
 *      Crossfading levels with tents (each full at its centre, nothing at its neighbours') therefore does
 *      not add up to one: between two centres (1 - m1)(1 - m2) of the SHARP pane showed through, 25 % at
 *      every midpoint, and the next layer blurred the previous one's output as well. That was the seams.
 *   2. a layer only sees the backdrop inside its own box (the edges are mirrored), so its blur is wrong
 *      within ~2 radii of its box edges.
 * So: layer k's mask ramps from nothing at band k-1 to full at band k and STAYS full out to the free edge.
 * Each layer then blurs everything under it, all of it already blurred by the layers before, and Gaussians
 * compound (radii add in squares), so layer k's own radius is the increment sqrt(T(k)^2 - T(k-1)^2) that
 * takes the blur from level k-1's target to level k's. Between two centres the result is a crossfade of
 * level k-1 and level k of the SAME image: no sharp leak, no seam, one smooth ramp. Each box starts PAD
 * radii left of where its mask starts (the mirrored edge falls where the mask is nothing) and reaches PAD
 * radii past the free edge (the clip hides that part; the blur at the edge reads the content that is
 * really there, as the Duo's one shared image does), but stops --ul-bezel short of the pane's own edge,
 * so its hairline is never pulled into the blur. */
(function () {
  'use strict';

  /* the blur levels, as d = distance from the hinge / open width: [start, centre 1, ..., centre N]. Layer k
     ramps in from band k-1 to band k (the first from the start: the hinge stays sharp) and stays on to the
     free edge (the blur has flattened there). */
  var BANDS = [0.04, 0.15, 0.3, 0.45, 0.62];
  /* a pane wider than BIG_W (Task View, full screen): TWO levels. The stacked layers each reach the free edge, so
     four of them on 1536x864 cost frames at the landing (2026-10-24, 15 opens x 2, dropped: HEAD tents 4 and 0,
     four stacked 24 and 13, three + cut at 8 px 13 and 4, two + cut at 6 px 6 and 0) */
  var BANDS_BIG = [0.04, 0.25, 0.62];
  var BIG_W = 1000;
  /* the blur's shape over d, 0..1 of the edge's: rises from the hinge and flattens by d = KNEE (the Duo's
     measured sigma over d: 4, 8, 10, 13, 13 at d .08, .25, .42, .58, .75) */
  var KNEE = 0.6;
  var EXP = 0.7;
  function shape(d) { var x = (d - 0.04) / (KNEE - 0.04); return x <= 0 ? 0 : x >= 1 ? 1 : Math.pow(x, EXP); }
  /* the share of the time the effect lingers on the landed pane and fades (the Duo: ~0.4 s of ~2.7 s) */
  var RELEASE = 0.15;
  /* the blur's strength at the landing, as a share of mid-motion's (the Duo: ~1.3 % of the width at the
     landing, ~3.3 % before it) */
  var LAND = 0.55;
  /* the strips go off (together) once the outermost one's radius is under this, px, after fading out over
     the radius' last stretch above it (so the hand-off to sharp is a fade, never a snap). Wide strips at a
     pixel or two of blur cost the most and show the least on a big pane (measured 2026-10-23, Task View
     1536x864, 3 x 15 opens interleaved, dropped frames: off under 0.5 px 92, under 2 px 50, under 4 px 20,
     no blur at all 20). The launcher drops none at 0.5 px. */
  var RMIN = 0.5;
  var RMIN_BIG = 6;
  /* a layer's box reaches this many of its radii left of where its mask starts (2.5 radii: the mirrored
     edge's error is under 1 % of the content's contrast where the mask begins) */
  var PAD = 2.5;
  var RM = '(prefers-reduced-motion: reduce)';
  var RM_MS = 120;

  function reduced() { try { return window.matchMedia(RM).matches; } catch (_) { return false; } }
  function cssVar(el, name) { return getComputedStyle(el).getPropertyValue(name).trim(); }
  function toMs(v, dflt) {
    var n = parseFloat(v);
    if (!isFinite(n)) return dflt;
    return /ms$/.test(v) ? n : n * 1000;
  }
  function ms(el, opts) {
    if (reduced()) return RM_MS;
    var size = (opts && opts.size) || el.getAttribute('data-unfold-size') || 'pop';
    return toMs(cssVar(el, '--unfold-' + size + '-ms'), 340);
  }
  function easing(el, name, dflt) {
    var v = cssVar(el, name);
    return v && !/var\(/.test(v) ? v : dflt;
  }

  function fx(el) {
    var f = el.querySelector(':scope > .ul-fx');
    if (f) return f;
    f = document.createElement('div');
    f.className = 'ul-fx';
    f.setAttribute('aria-hidden', 'true');
    var cover = document.createElement('div'); cover.className = 'ul-cover'; f.appendChild(cover);
    for (var i = 1; i < BANDS.length; i++) { var s = document.createElement('div'); s.className = 'ul-strip'; f.appendChild(s); }
    var shade = document.createElement('div'); shade.className = 'ul-shade'; f.appendChild(shade);
    el.appendChild(f);
    return f;
  }

  function prep(el, opts) {
    el.classList.add('unfold-live');
    if (opts && opts.size) el.setAttribute('data-unfold-size', opts.size);
  }

  function stop(el) {
    var st = el.__unfoldLive;
    if (!st) return;
    el.__unfoldLive = null;
    st.dead = true;
    if (st.raf) cancelAnimationFrame(st.raf);
    if (st.timer) clearTimeout(st.timer);
    for (var i = 0; i < st.anims.length; i++) { try { st.anims[i].cancel(); } catch (_) { /* gone */ } }
    el.removeAttribute('data-unfold-anim');
    if (st.resolve) st.resolve({ ok: false, state: el.getAttribute('data-unfold'), timedOut: false, frames: st.frames, cancelled: true });
  }

  /* the look's numbers, read ONCE per play (a getComputedStyle per frame would cost a style pass) */
  function num(el, name, dflt) { var v = parseFloat(cssVar(el, name)); return isFinite(v) ? v : dflt; }
  /* --ul-bands / --ul-bands-big (unfold-live.css) override the strips: "0.04 0.15 0.3 0.45 0.62", ascending */
  function bandsVar(el, name, dflt) {
    var v = cssVar(el, name);
    if (!v) return dflt;
    var a = v.split(/[\s,]+/).map(parseFloat);
    for (var i = 0; i < a.length; i++) if (!(a[i] >= 0 && a[i] <= 1) || (i && a[i] <= a[i - 1])) return dflt;
    return a.length >= 2 && a.length <= BANDS.length ? a : dflt;
  }
  function config(el, opts) {
    var W = el.offsetWidth || 1;
    var rel = num(el, '--ul-release', RELEASE);
    var pad = num(el, '--ul-pad', PAD);
    return { W: W, bands: W > BIG_W ? bandsVar(el, '--ul-bands-big', BANDS_BIG) : bandsVar(el, '--ul-bands', BANDS),
      bEdge: Math.min(num(el, '--ul-blur-cap', 72), num(el, W > BIG_W ? '--ul-blur-ratio-big' : '--ul-blur-ratio', num(el, '--ul-blur-ratio', 0.033)) * W),
      rMin: W > BIG_W ? num(el, '--ul-blur-min-big', RMIN_BIG) : num(el, '--ul-blur-min', RMIN),
      rel: rel > 0 && rel < 0.5 ? rel : RELEASE, land: num(el, '--ul-blur-land', LAND),
      dim: num(el, '--ul-dim', 1), dimCover: num(el, '--ul-dim-cover', 0),
      pad: pad >= 0 && pad <= 6 ? pad : PAD, bezel: Math.max(0, num(el, '--ul-bezel', 1)),
      // the clip's right inset runs from 50 % to -bleed, so the visible leaf reaches past the pane's box by
      // the bleed (the drop shadow) as it lands: the dim and the blur follow the CLIP's edge, not half * e
      // (that left an undimmed, unblurred sliver at the free edge: the pale band of the dark frames)
      bleed: Math.max(0, Number(opts && opts.bleed) || 0) };
  }
  function set(node, key, prop, v) { if (node[key] !== v) { node.style[prop] = v; node[key] = v; } }
  function px(v) { return Math.round(v * 10) / 10; }
  /* one frame: e = the leaf's eased openness (0 = at the hinge, 1 = landed), blur / dim = the effect's
     strengths now (1 = mid-motion) */
  function place(el, f, e, blur, dim, c) {
    var half = c.W / 2;
    var p = e < 0 ? 0 : e > 1 ? 1 : e;
    var reach = half + c.bleed;                      // the leaf's full visible width (its bleed included)
    var w = reach * p;                               // the opening half's visible width now
    var edge = half + w;                             // the visible free edge, px from the pane's left
    var bMax = c.bEdge * blur;
    var kids = f.children;
    var cover = kids[0], shade = kids[kids.length - 1];
    // the stationary half stays at full brightness (the Duo, measured); --ul-dim-cover can dip it
    if (c.dimCover > 0) {
      set(cover, '__w', 'width', c.W + 'px');
      set(cover, '__t', 'transform', 'scaleX(' + (Math.min(c.W, edge) / c.W) + ')');
      set(cover, '__o', 'opacity', String(Math.round(c.dimCover * dim * 1000) / 1000));
      set(cover, '__d', 'display', '');
    } else set(cover, '__d', 'display', 'none');
    var bands = c.bands, n = bands.length - 1;
    // the layers go on and off TOGETHER, once each way, on the outermost level's radius: switching them off
    // one by one changed the layer tree several frames running, and those were late frames (measured
    // 2026-10-23, Task View 1536x864, 3 x 15 opens interleaved: 25 dropped one by one, 13 together). Over
    // the last stretch above rMin they fade (opacity on a backdrop-filter = a cross-fade to the sharp
    // pane), so going off is never a snap.
    var rOuter = bMax * shape(bands[n]);
    var allOn = rOuter >= c.rMin && Math.min(edge, c.W - c.bezel) - (half + w * bands[n - 1]) >= 1;
    var fade = Math.max(c.rMin, 0.5);
    var a = String(allOn ? Math.round(Math.min(1, (rOuter - c.rMin) / fade) * 100) / 100 : 0);
    var prev = 0;                                    // the blur the layers below have built up (its square)
    for (var k = 1; k < BANDS.length; k++) {
      var strip = kids[k];
      if (k > n || !allOn) { set(strip, '__d', 'display', 'none'); continue; }
      var T = bMax * shape(bands[k]);                // level k's target radius
      var inc = Math.sqrt(Math.max(0, T * T - prev)); // this layer's own: Gaussians compound in squares
      prev = Math.max(prev, T * T);
      var r = Math.max(0.25, Math.round(inc * 4) / 4);
      var x0 = half + w * bands[k - 1], x1 = half + w * bands[k];   // its mask: nothing at x0, full from x1 on
      var left = Math.max(0, Math.floor(x0 - c.pad * r));
      // past the free edge too: the content there is hidden by the clip but is still the content (the Duo
      // blurs ONE image of the whole screen), so the blur at the edge reads it, not a mirror of the edge
      var width = Math.max(1, Math.min(c.W - c.bezel, Math.ceil(edge + c.pad * r)) - left);
      set(strip, '__d', 'display', '');
      strip.style.left = left + 'px';
      strip.style.width = px(width) + 'px';
      var a0 = px(x0 - left), a1 = Math.max(a0 + 0.1, px(x1 - left));
      var m = 'linear-gradient(to right, transparent ' + a0 + 'px, #000 ' + a1 + 'px)';
      if (strip.__m !== m) { strip.style.webkitMaskImage = m; strip.style.maskImage = m; strip.__m = m; }
      set(strip, '__a', 'opacity', a);
      var b = 'blur(' + r + 'px)';
      if (strip.__b !== b) { strip.style.backdropFilter = b; strip.style.webkitBackdropFilter = b; strip.__b = b; }
    }
    // the dim: the leaf's measured gain over d is in the shade's gradient (unfold-live.css); it is sized once
    // and scaled from the hinge (a transform: the compositor only), its opacity is the strength. It spans the
    // visible leaf, bleed included (.ul-fx's paint containment clips it at the pane's box)
    set(shade, '__l', 'left', half + 'px');
    set(shade, '__w', 'width', reach + 'px');
    shade.style.transform = 'scaleX(' + p + ')';
    set(shade, '__o', 'opacity', String(Math.round(Math.max(0, Math.min(1, c.dim * dim)) * 1000) / 1000));
  }
  /* the effect's strengths at u = the time as openness (0 = folded, 1 = open; a fold runs it backwards) and
     e = the leaf's eased openness: full while the leaf moves (the blur easing to LAND by the landing), then
     the release fades both out over the last rel of the time */
  function strengths(u, e, c) {
    var g = 1 - c.rel;
    if (u <= g) return { blur: 1 - (1 - c.land) * e, dim: 1 };
    var k = Math.max(0, (1 - u) / c.rel);
    return { blur: c.land * k, dim: k };
  }

  function go(el, target, opts) {
    prep(el, opts);
    var playing = el.__unfoldLive;
    if (playing && playing.target === target) return playing.promise;   // already on its way there
    stop(el);                                                           // the other way: from where it is
    var from = el.getAttribute('data-unfold') || 'open';
    var st = { anims: [], raf: 0, timer: 0, frames: 0, resolve: null, dead: false, target: target, promise: null };
    st.promise = new Promise(function (resolve) {
      st.resolve = resolve;
      if (from === target) { st.dead = true; resolve({ ok: true, state: target, timedOut: false, frames: 0 }); return; }
      var D = ms(el, opts);
      el.__unfoldLive = st;
      var opening = target === 'open';
      function finish(timedOut) {
        if (st.dead) return;
        st.dead = true; el.__unfoldLive = null;
        if (st.raf) cancelAnimationFrame(st.raf);
        if (st.timer) clearTimeout(st.timer);
        el.setAttribute('data-unfold', target);    // the CSS pose first, then the animations go: no frame between
        el.removeAttribute('data-unfold-anim');
        for (var i = 0; i < st.anims.length; i++) { try { st.anims[i].cancel(); } catch (_) { /* gone */ } }
        resolve({ ok: true, state: target, timedOut: !!timedOut, frames: st.frames });
      }
      if (opening) el.setAttribute('data-unfold', 'open');   // visible while it plays (the fold keeps 'open' until it lands)
      if (!el.animate) { finish(true); return; }

      if (reduced()) {
        st.anims.push(el.animate([{ opacity: opening ? 0 : 1 }, { opacity: opening ? 1 : 0 }], { duration: D, easing: 'linear', fill: 'forwards' }));
        st.anims[0].finished.then(function () { finish(false); }, function () { /* cancelled */ });
        st.timer = setTimeout(function () { finish(true); }, D + 150);
        return;
      }

      var f = fx(el);
      var cfg = config(el, opts);
      var G = Math.round(D * (1 - cfg.rel));                // the leaf's own share of the time
      var bleed = Math.max(0, Number(opts && opts.bleed) || 0);
      var B = -bleed + 'px';
      var shut = 'inset(' + B + ' 50% ' + B + ' ' + B + ')', full = 'inset(' + B + ' ' + B + ' ' + B + ' ' + B + ')';
      var curve = opening ? easing(el, '--ul-ease-in', easing(el, '--unfold-in', 'cubic-bezier(.4, 0, .1, 1)'))
        : easing(el, '--ul-ease-out', easing(el, '--unfold-out', 'cubic-bezier(.9, 0, .6, 1)'));
      // opening: the leaf moves first, then the effect releases on the landed pane; folding: the effect
      // gathers on the still pane first (delay), then the leaf folds shut
      var timing = { duration: G, delay: opening ? 0 : D - G, fill: 'both' };
      var kf = [{ clipPath: opening ? shut : full }, { clipPath: opening ? full : shut }];
      var clip;
      try { timing.easing = curve; clip = el.animate(kf, timing); }
      catch (_) { timing.easing = 'ease-out'; clip = el.animate(kf, timing); }
      st.anims.push(clip);
      /* the clock: a no-op animation over the whole time (its currentTime is the elapsed time, on the
         same timeline as the clip) */
      var clock = el.animate([{ '--ul-clock': '0' }, { '--ul-clock': '1' }], { duration: D });
      st.anims.push(clock);
      /* the pane comes on (and goes off) over the first (last) eighth, so the cover half does not pop */
      var fadeMs = Math.round(D * 0.125);
      st.anims.push(el.animate(opening ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 1 }, { opacity: 1, offset: 0.875 }, { opacity: 0 }],
        { duration: opening ? fadeMs : D, easing: 'linear', fill: 'forwards' }));
      el.setAttribute('data-unfold-anim', opening ? 'opening' : 'folding');
      function at() {
        var ct = clock.currentTime, tt = ct === null ? 1 : Math.max(0, Math.min(1, ct / D));
        var t = clip.effect.getComputedTiming();
        var e = t.progress === null ? (opening ? 1 : 0) : (opening ? t.progress : 1 - t.progress);
        var u = opening ? tt : 1 - tt;
        var s = strengths(u, e, cfg);
        place(el, f, e, s.blur, s.dim, cfg);
      }
      function frame() {
        if (st.dead) return;
        at();
        st.frames++;
        if (clock.playState === 'finished') { finish(false); return; }
        st.raf = requestAnimationFrame(frame);
      }
      var s0 = strengths(opening ? 0 : 1, opening ? 0 : 1, cfg);
      place(el, f, opening ? 0 : 1, s0.blur, s0.dim, cfg);   // the first painted frame is the start pose
      st.raf = requestAnimationFrame(frame);
      clock.finished.then(function () { finish(false); }, function () { /* cancelled */ });
      st.timer = setTimeout(function () { finish(true); }, D + 150);
    });
    return st.promise;
  }

  window.MantleUnfoldLive = {
    rest: function (el, opts) {
      prep(el, opts);
      stop(el);
      el.setAttribute('data-unfold', (opts && opts.state) || 'folded');
    },
    open: function (el, opts) { return go(el, 'open', opts); },
    fold: function (el, opts) { return go(el, 'folded', opts); },
    ms: ms,
  };
})();
