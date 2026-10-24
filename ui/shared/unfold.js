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
 * caller waiting; it resolves to { ok, state, timedOut }. */
(function () {
  'use strict';

  function durationMs(el) {
    var v = getComputedStyle(el).getPropertyValue('--u-ms').trim();
    var n = parseFloat(v);
    if (!isFinite(n)) return 400;
    return /ms$/.test(v) ? n : n * 1000;
  }

  function prep(el, size) {
    el.classList.add('unfold');
    if (size) el.setAttribute('data-unfold-size', size);
  }

  function go(el, state, opts) {
    prep(el, opts && opts.size);
    return new Promise(function (resolve) {
      var done = false;
      var timer = null;
      function finish(timedOut) {
        if (done) return;
        done = true;
        el.removeEventListener('transitionend', onEnd);
        if (timer) clearTimeout(timer);
        resolve({ ok: true, state: state, timedOut: !!timedOut });
      }
      function onEnd(e) {
        if (e.target === el && (e.propertyName === 'clip-path' || e.propertyName === 'filter' || e.propertyName === 'opacity')) finish(false);
      }
      if (el.getAttribute('data-unfold') === state) { finish(false); return; }
      el.addEventListener('transitionend', onEnd);
      void el.offsetWidth; // the current pose must be painted before the change, or nothing runs
      el.setAttribute('data-unfold', state);
      timer = setTimeout(function () { finish(true); }, durationMs(el) + 150);
    });
  }

  window.MantleUnfold = {
    rest: function (el, opts) {
      prep(el, opts && opts.size);
      el.classList.add('unfold-snap');
      el.setAttribute('data-unfold', (opts && opts.state) || 'folded');
      void el.offsetWidth;
      el.classList.remove('unfold-snap');
    },
    open: function (el, opts) { return go(el, 'open', opts); },
    fold: function (el, opts) { return go(el, 'folded', opts); },
    blur: function (el, opts) { return go(el, 'blurred', opts); },
  };
})();
