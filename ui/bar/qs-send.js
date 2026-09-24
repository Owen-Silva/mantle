/* qs-send.js — how a dragged slider talks to the system: at most ONE set in flight, only the newest
 * value waiting behind it, and the value the pointer stops on ALWAYS sent (2026-09-23).
 *
 * WHY. The panel sent a set every 100 ms (a throttle) plus one more on `change`, whether or not the
 * last had answered. Brightness is a WMI call (7-353 ms each here, measured the same day), so a drag
 * queued a backlog of stale levels that played out after the pointer stopped, and a slow set could
 * answer after a newer one and pull the slider back. One in flight with the newest waiting sends as
 * fast as the system can take it and never replays an old value: CoreAudio at 2-4 ms follows the
 * pointer, WMI at ~40 ms gets ~25 levels a second, and the last value lands either way.
 *
 * `minGapMs` spaces the sends (a floor, not a throttle: a send that took longer than the gap goes
 * straight on to the next), so a 165 Hz pointer on a 3 ms volume set is not 165 sets a second.
 *
 * Loaded as a plain <script> by the bar (window.MantleQsSend) and by require() in node
 * (ui/bar/qs-send.test.js). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MantleQsSend = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* send(v) -> a promise (or a value). opts: { minGapMs, onIdle(), now(), setTimeout }
     onIdle: called when the last send has answered and nothing waits - the moment the slider
     may take the system's read-back again. */
  function sender(send, opts) {
    opts = opts || {};
    var minGap = opts.minGapMs || 0;
    var onIdle = opts.onIdle || function () {};
    var now = opts.now || function () { return Date.now(); };
    var setT = opts.setTimeout || function (fn, ms) { return setTimeout(fn, ms); };
    var inFlight = false, pending = false, pendingValue, timer = 0;
    var lastSentAt = -Infinity, hasLast = false, lastValue, lastOk = false;

    function pump() {
      if (inFlight || !pending) return;
      var wait = minGap - (now() - lastSentAt);
      if (wait > 0) {
        if (!timer) timer = setT(function () { timer = 0; pump(); }, wait);
        return;
      }
      var v = pendingValue;
      pending = false;
      inFlight = true;
      lastSentAt = now();
      hasLast = true;
      lastValue = v;
      lastOk = false;
      var p;
      try { p = Promise.resolve(send(v)); } catch (e) { p = Promise.reject(e); }
      p.then(function (r) {
        inFlight = false;
        lastOk = !(r && typeof r === 'object' && r.ok === false);
        next();
      }, function () {
        inFlight = false;
        lastOk = false;
        next();
      });
    }

    function next() {
      pump();
      if (!inFlight && !pending) { try { onIdle(); } catch (e) { /* the page's repaint, not ours */ } }
    }

    return {
      /* The newest value. A value the last completed send already set, with nothing in between, is
         not sent again (the `change` at the end of a drag repeats the last `input`), and nor is
         the value already in flight: it is the newest wanted, so anything waiting is dropped. */
      push: function (v) {
        if (!inFlight && !pending && hasLast && lastOk && v === lastValue) return false;
        if (inFlight && v === lastValue) { pending = false; return false; }
        pendingValue = v;
        pending = true;
        pump();
        return true;
      },
      /* True while a set is in flight or a value is waiting: the slider is not settled, so a push
         from elsewhere must not move it. */
      busy: function () { return inFlight || pending; },
    };
  }

  return { sender: sender };
}));
