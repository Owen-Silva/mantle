/* unfold.js - MantleUnfold: plays the shared unfold motion (unfold.css) on an element
 * (wave unfold, 2026-10-23). Contract owned with unfold.css; lane unfold-unlock owns the internals.
 *
 *   MantleUnfold.rest(el, { state = 'folded', size })  jump to a pose, nothing plays
 *   MantleUnfold.open(el, { size })    -> Promise, resolves when the opening has landed
 *   MantleUnfold.fold(el, { size })    -> Promise, resolves when it is closed
 *   MantleUnfold.blur(el, { size })    -> Promise, resolves when it sits out of focus
 *
 * size: 'full' | 'pop' | 'quick' (unfold.css). Every promise also resolves on a timer
 * (duration + 150 ms), so a missed transitionend (window hidden mid-way, no frames) never leaves a
 * caller waiting; it resolves to { ok, state, timedOut, shade }.
 *
 * THE SHADE (the iPhone Duo look, 2026-10-23): while it moves, and while it sits blurred, two
 * absolutely placed, click-through spans (.unfold-cast-m / -s, unfold.css) carry the indigo darkening
 * over the element's content. They need the element to be positioned (absolute / fixed / relative /
 * sticky): on a static element there is nowhere safe to put them (nor in an img, video or canvas,
 * which draw no children), so the motion plays without them and the answer says shade: false. They are removed when the element lands open or folded, so a
 * surface at rest has exactly the children it had. */
(function () {
  'use strict';

  function durationMs(el) {
    var v = getComputedStyle(el).getPropertyValue('--u-ms').trim();
    var n = parseFloat(v);
    if (!isFinite(n)) return 400;
    return /ms$/.test(v) ? n : n * 1000;
  }

  function reduced() { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }

  function prep(el, size) {
    el.classList.add('unfold');
    if (size) el.setAttribute('data-unfold-size', size);
  }

  /** the two shade spans, added once (in the pose of the element's CURRENT state, so they move from
   * there); false when the element is not positioned or motion is reduced */
  function shade(el) {
    if (reduced()) { unshade(el); return false; }
    if (getComputedStyle(el).position === 'static') return false;
    if (/^(IMG|VIDEO|CANVAS|IFRAME|EMBED|OBJECT|INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return false;   // draws no children
    ['m', 's'].forEach(function (k) {
      if (el.querySelector(':scope > .unfold-cast-' + k)) return;
      var s = document.createElement('span');
      s.className = 'unfold-cast unfold-cast-' + k;
      s.setAttribute('aria-hidden', 'true');
      el.appendChild(s);
    });
    return true;
  }
  function unshade(el) {
    var list = el.querySelectorAll(':scope > .unfold-cast');
    for (var i = 0; i < list.length; i++) list[i].remove();
  }

  function go(el, state, opts) {
    prep(el, opts && opts.size);
    return new Promise(function (resolve) {
      var done = false;
      var timer = null;
      var shaded = false;
      function finish(timedOut) {
        if (done) return;
        done = true;
        el.removeEventListener('transitionend', onEnd);
        if (timer) clearTimeout(timer);
        // at rest open or folded there is nothing to shade; a later call may have moved it on, so
        // only when it is still in the state this call set
        if (state !== 'blurred' && el.getAttribute('data-unfold') === state) unshade(el);
        resolve({ ok: true, state: state, timedOut: !!timedOut, shade: shaded });
      }
      // Only a full-length property ends it: opacity runs for 40 % of the time, so its transitionend
      // came at 40 % and open() resolved long before the opening landed (measured, ui/unfold/pace.js).
      // With reduced motion opacity is the only transition, so then it counts.
      // An end that comes too soon is the PREVIOUS motion's (its transform ending a frame after its
      // filter, say), dispatched after this call started listening: it must not end this one.
      function onEnd(e) {
        if (e.target !== el) return;
        if (performance.now() < earliest) return;
        var p = e.propertyName;
        if (p === 'clip-path' || p === 'filter' || p === 'transform' || (p === 'opacity' && reduced())) finish(false);
      }
      if (el.getAttribute('data-unfold') === state) { shaded = state === 'blurred' && shade(el); finish(false); return; }
      shaded = shade(el);
      el.addEventListener('transitionend', onEnd);
      void el.offsetWidth; // the current pose (and the new shade's) must be painted before the change, or nothing runs
      el.setAttribute('data-unfold', state);
      var D = durationMs(el);   // read AFTER the state is set: 'blurred' has its own (--unfold-fold-ms)
      var earliest = performance.now() + (reduced() ? 60 : D * 0.6);
      timer = setTimeout(function () { finish(true); }, D + 150);
    });
  }

  window.MantleUnfold = {
    rest: function (el, opts) {
      var state = (opts && opts.state) || 'folded';
      prep(el, opts && opts.size);
      el.classList.add('unfold-snap');
      el.setAttribute('data-unfold', state);
      if (state === 'blurred') shade(el); else unshade(el);
      void el.offsetWidth;
      el.classList.remove('unfold-snap');
    },
    open: function (el, opts) { return go(el, 'open', opts); },
    fold: function (el, opts) { return go(el, 'folded', opts); },
    blur: function (el, opts) { return go(el, 'blurred', opts); },
  };
})();
