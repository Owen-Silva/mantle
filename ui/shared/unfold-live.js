/* unfold-live.js - MantleUnfoldLive: the iPhone Duo unfold on a LIVE pane (the launcher, Task View); the
 * look is described in unfold-live.css (wave unfold, 2026-10-23). The names follow MantleUnfold's:
 *
 *   MantleUnfoldLive.rest(el, { state = 'folded', size })   jump to a pose, nothing plays
 *   MantleUnfoldLive.open(el, { size, bleed })  -> Promise { ok, state: 'open', timedOut, frames }
 *   MantleUnfoldLive.fold(el, { size, bleed })  -> Promise { ok, state: 'folded', timedOut, frames }
 *   MantleUnfoldLive.ms(el, { size })           the duration it plays for (reduced motion: the fade)
 *
 * size: 'full' | 'pop' | 'quick' -> unfold.css's --unfold-<size>-ms; the curve is unfold-live.css's
 * --ul-ease-in (open) / --ul-ease-out (fold), else unfold.css's --unfold-in / --unfold-out. bleed: px the pane paints OUTSIDE its box (a drop shadow), kept unclipped above,
 * below and on the cover side. The promise resolves when the WHOLE motion has landed, and on a timer
 * (duration + 150 ms) if no frame comes (a hidden window), so a caller never waits forever.
 *
 * HOW: the pane is clipped to its left half + the open width (a Web Animation of clip-path on the
 * curve), and while it plays a layer on top (.ul-fx) carries the stepped backdrop-filter strips and the
 * two darks; each frame reads the animation's own eased progress and places them. When it lands the
 * layer goes (display: none) and the pane has no clip or filter left: zero cost at rest. Prefers-reduced-
 * motion: opacity only, 120 ms linear. A pane whose data-unfold is "folded" is invisible (unfold-live.css). */
(function () {
  'use strict';

  /* the strips: band edges as d = distance from the hinge / open width. Below .35 the cubic blur is
     under 5 % of the edge's: sharp, so no strip (that is the cost saved). */
  var BANDS = [0.35, 0.55, 0.7, 0.82, 0.92, 1.0];
  /* a big pane (Task View, full screen) pays per pixel for every strip: three coarser levels there
     (measured on this iGPU, 2026-10-23: five strips over a 768x864 half dropped about a frame in four) */
  var BANDS_BIG = [0.45, 0.7, 0.88, 1.0];
  var BIG_W = 1000;
  /* the strips go off (together) once the outermost one's radius is under this, px. The late half of an
     open is wide strips at a pixel or two of blur: on a big pane they cost the most and show the least
     (measured 2026-10-23, Task View 1536x864, 3 x 15 opens interleaved, dropped frames: off under 0.5 px
     92, under 2 px 50, under 4 px 20, no blur at all 20). The launcher drops none at 0.5 px. */
  var RMIN = 0.5;
  var RMIN_BIG = 4;
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

  /* one frame of the look, at eased progress e (0 = folded at the hinge, 1 = open) */
  /* the look's numbers, read ONCE per play (a getComputedStyle per frame would cost a style pass) */
  function num(el, name, dflt) { var v = parseFloat(cssVar(el, name)); return isFinite(v) ? v : dflt; }
  /* --ul-bands / --ul-bands-big (unfold-live.css) override the strip edges: "0.5 0.8 1", ascending, last 1 */
  function bandsVar(el, name, dflt) {
    var v = cssVar(el, name);
    if (!v) return dflt;
    var a = v.split(/[\s,]+/).map(parseFloat);
    for (var i = 0; i < a.length; i++) if (!(a[i] > 0 && a[i] <= 1) || (i && a[i] <= a[i - 1])) return dflt;
    return a.length >= 2 && a.length <= BANDS.length && a[a.length - 1] === 1 ? a : dflt;
  }
  function config(el) {
    var W = el.offsetWidth || 1;
    return { W: W, bands: W > BIG_W ? bandsVar(el, '--ul-bands-big', BANDS_BIG) : bandsVar(el, '--ul-bands', BANDS),
      bEdge: Math.min(num(el, '--ul-blur-cap', 72), num(el, W > BIG_W ? '--ul-blur-ratio-big' : '--ul-blur-ratio', num(el, '--ul-blur-ratio', 0.018)) * W),
      rMin: W > BIG_W ? num(el, '--ul-blur-min-big', RMIN_BIG) : num(el, '--ul-blur-min', RMIN),
      ov: num(el, '--ul-overlap', 14), darkEdge: num(el, '--ul-dark-edge', 0.62), darkCover: num(el, '--ul-dark-cover', 0.45) };
  }
  function place(el, f, e, c) {
    var half = c.W / 2, ov = c.ov, darkEdge = c.darkEdge, darkCover = c.darkCover;
    var p = e < 0 ? 0 : e > 1 ? 1 : e;
    var s = 1 - p;                                   // the transition's strength: 1 at the hinge, 0 open
    var w = half * p;                                // the opening half's visible width
    var bMax = c.bEdge * s;
    var kids = f.children;
    var cover = kids[0], shade = kids[kids.length - 1];
    // the cover half's dark runs on under the opening half too, so the two meet at the hinge without a
    // seam; the opening half's own dark (the shade) adds to it toward the free edge
    // the darks are sized once and scaled (a transform: no repaint per frame, only the compositor)
    cover.style.width = c.W + 'px';
    cover.style.transform = 'scaleX(' + ((half + w) / c.W) + ')';
    cover.style.opacity = String(darkCover * s);
    var bands = c.bands;
    // the strips go on and off TOGETHER, once each way, on the outermost strip's radius: switching them off
    // one by one near the landing changed the layer tree several frames running, and those were the late
    // frames (measured 2026-10-23, Task View 1536x864, 3 x 15 opens interleaved: 25 dropped one by one,
    // 13 together, 6 with no blur at all). An inner strip below half a pixel stays at half a pixel.
    var outer = bands[bands.length - 2], om = (outer + 1) / 2;
    var allOn = Math.round(bMax * om * om * om * 2) / 2 >= c.rMin && w * (1 - outer) + 2 * ov >= 2;
    for (var i = 1; i < BANDS.length; i++) {        // strip i-1 spans bands[i-1]..bands[i]; the first edge is where blur starts
      var strip = kids[i];
      if (i >= bands.length) { if (strip.__on !== 0) { strip.style.display = 'none'; strip.__on = 0; } continue; }
      var lo = bands[i - 1], d1 = bands[i];
      var mid = (lo + d1) / 2, r = Math.round(bMax * mid * mid * mid * 2) / 2;
      // the last strip runs ov past the free edge: its mask fade lands outside the pane's clip, so the
      // free edge (the softest part) is never left sharp by the cross-fade
      var x0 = half + w * lo - ov, x1 = half + w * d1 + ov;
      if (!allOn) { if (strip.__on !== 0) { strip.style.display = 'none'; strip.__on = 0; } continue; }
      if (r < 0.5) r = 0.5;
      if (strip.__on !== 1) { strip.style.display = ''; strip.__on = 1; }
      strip.style.left = x0 + 'px';
      strip.style.width = (x1 - x0) + 'px';
      var b = 'blur(' + r + 'px)';
      if (strip.__b !== b) { strip.style.backdropFilter = b; strip.style.webkitBackdropFilter = b; strip.__b = b; }
    }
    shade.style.left = half + 'px';
    shade.style.width = half + 'px';
    shade.style.transform = 'scaleX(' + p + ')';
    shade.style.opacity = String(Math.min(darkEdge, 2 * s * darkEdge));
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

      var bleed = Math.max(0, Number(opts && opts.bleed) || 0);
      var B = -bleed + 'px';
      var shut = 'inset(' + B + ' 50% ' + B + ' ' + B + ')', full = 'inset(' + B + ' ' + B + ' ' + B + ' ' + B + ')';
      var curve = opening ? easing(el, '--ul-ease-in', easing(el, '--unfold-in', 'cubic-bezier(.42, 0, .2, 1)'))
        : easing(el, '--ul-ease-out', easing(el, '--unfold-out', 'cubic-bezier(.5, 0, .85, .45)'));
      var clip;
      try { clip = el.animate([{ clipPath: opening ? shut : full }, { clipPath: opening ? full : shut }], { duration: D, easing: curve, fill: 'forwards' }); }
      catch (_) { clip = el.animate([{ clipPath: opening ? shut : full }, { clipPath: opening ? full : shut }], { duration: D, easing: 'ease-out', fill: 'forwards' }); }
      st.anims.push(clip);
      /* the pane comes on (and goes off) over the first (last) eighth, so the cover half does not pop */
      var fadeMs = Math.round(D * 0.125);
      st.anims.push(el.animate(opening ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 1 }, { opacity: 1, offset: 0.875 }, { opacity: 0 }],
        { duration: opening ? fadeMs : D, easing: 'linear', fill: 'forwards' }));
      var f = fx(el);
      el.setAttribute('data-unfold-anim', opening ? 'opening' : 'folding');
      var cfg = config(el);
      function frame() {
        if (st.dead) return;
        var t = clip.effect.getComputedTiming();
        var e = t.progress === null ? (opening ? 1 : 0) : (opening ? t.progress : 1 - t.progress);
        place(el, f, e, cfg);
        st.frames++;
        if (clip.playState === 'finished') { finish(false); return; }
        st.raf = requestAnimationFrame(frame);
      }
      place(el, f, opening ? 0 : 1, cfg);           // the first painted frame is the start pose
      st.raf = requestAnimationFrame(frame);
      clip.finished.then(function () { finish(false); }, function () { /* cancelled */ });
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
