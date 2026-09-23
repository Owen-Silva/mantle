/*
 * lively-shim.js -- the part of Lively that a web wallpaper expects to be talking to.
 *
 * lib/wallpaper.js serves every web wallpaper from mantle-wp://<id>/ and puts THIS script first in
 * the wallpaper's <head>, before any of the wallpaper's own scripts. It is the whole of Mantle's
 * side of Lively's web-wallpaper contract (github.com/rocksdanister/lively/wiki, "Web Guide"):
 *
 *   livelyPropertyListener(name, value)  called once per saved property after the page loads, and
 *                                        again whenever Owen changes one in the Wallpapers window
 *   livelySystemInformation(json)        a JSON STRING of machine stats, about once a second, to a
 *                                        wallpaper whose LivelyInfo.json asks for
 *                                        "--system-information"
 *   the mouse                            the cursor position, as synthetic mousemove/pointermove
 *                                        events: Lively forwards input (Owen's InputForward is 1,
 *                                        "mouse"), and the desktop layer itself never receives a
 *                                        real one -- it sits under the icons
 *
 * All of it arrives by postMessage from the desktop page, which is the ONLY window this accepts
 * messages from. The wallpaper lives on its own origin (mantle-wp://<id>), so it cannot reach the
 * desktop page, window.mantle, or another wallpaper; this file is the one door and it opens inward.
 *
 * PAUSE. Lively suspends a wallpaper's whole process; a page cannot do that to itself, so a pause
 * here is cooperative and total for everything a wallpaper animates with: requestAnimationFrame
 * callbacks are held, setInterval ticks are skipped, setTimeouts that come due are held (so a
 * self-rescheduling clock resumes instead of dying), media elements pause and CSS/Web Animations
 * pause. On resume everything held runs once, in order. The last painted frame stays on screen.
 *
 * Nothing is swallowed: a listener that throws, a missing listener, and the wallpaper's own
 * uncaught errors are all posted back to the desktop page, which puts them on the wallpaper's card.
 */
(function () {
  'use strict';
  var parentWin = window.parent;
  if (!parentWin || parentWin === window) return;   // opened on its own: nothing to talk to

  function post(msg) {
    msg.mantle = 'wp';
    try { parentWin.postMessage(msg, '*'); } catch (_) { /* the desktop page is gone */ }
  }

  // ---- pause -----------------------------------------------------------
  var paused = false;
  var nRaf = window.requestAnimationFrame.bind(window);
  var nCaf = window.cancelAnimationFrame.bind(window);
  var nSetTimeout = window.setTimeout.bind(window);
  var nClearTimeout = window.clearTimeout.bind(window);
  var nSetInterval = window.setInterval.bind(window);

  var HELD_BASE = 1e9;               // held rAF ids live far above Chromium's own
  var heldSeq = 0;
  var heldRaf = new Map();           // held id -> callback
  var heldToNative = new Map();      // held id -> the native id it got on resume
  var dueTimeouts = new Map();       // native timeout id -> the call it owes

  window.requestAnimationFrame = function (cb) {
    if (!paused) return nRaf(cb);
    var id = HELD_BASE + (++heldSeq);
    heldRaf.set(id, cb);
    return id;
  };
  window.cancelAnimationFrame = function (id) {
    if (heldRaf.has(id)) { heldRaf.delete(id); return; }
    if (heldToNative.has(id)) { nCaf(heldToNative.get(id)); heldToNative.delete(id); return; }
    nCaf(id);
  };
  window.setTimeout = function (fn, ms) {
    if (typeof fn !== 'function') return nSetTimeout.apply(window, arguments);
    var args = Array.prototype.slice.call(arguments, 2);
    var id = nSetTimeout(function () {
      if (paused) { dueTimeouts.set(id, function () { fn.apply(window, args); }); return; }
      fn.apply(window, args);
    }, ms);
    return id;
  };
  window.clearTimeout = function (id) { dueTimeouts.delete(id); nClearTimeout(id); };
  window.setInterval = function (fn, ms) {
    if (typeof fn !== 'function') return nSetInterval.apply(window, arguments);
    var args = Array.prototype.slice.call(arguments, 2);
    return nSetInterval(function () { if (!paused) fn.apply(window, args); }, ms);
  };

  var pausedMedia = [];
  var pausedAnims = [];

  function pause() {
    if (paused) return;
    paused = true;
    pausedMedia = Array.prototype.filter.call(document.querySelectorAll('video, audio'), function (m) { return !m.paused; });
    pausedMedia.forEach(function (m) { try { m.pause(); } catch (_) {} });
    try {
      pausedAnims = document.getAnimations().filter(function (a) { return a.playState === 'running'; });
      pausedAnims.forEach(function (a) { a.pause(); });
    } catch (_) { pausedAnims = []; }
  }

  function resume() {
    if (!paused) return;
    paused = false;
    heldRaf.forEach(function (cb, id) { heldToNative.set(id, nRaf(cb)); });
    heldRaf.clear();
    var due = Array.from(dueTimeouts.values());
    dueTimeouts.clear();
    due.forEach(function (call) { nSetTimeout(call, 0); });
    pausedMedia.forEach(function (m) { try { var p = m.play(); if (p && p.catch) p.catch(function () {}); } catch (_) {} });
    pausedMedia = [];
    pausedAnims.forEach(function (a) { try { a.play(); } catch (_) {} });
    pausedAnims = [];
  }

  // ---- calling the wallpaper -------------------------------------------
  var reported = 0;
  function report(reason) {
    if (reported++ < 5) post({ kind: 'error', reason: String(reason) });
  }

  function callLively(name, args) {
    var fn = window[name];
    if (typeof fn !== 'function') return false;
    try { fn.apply(window, args); } catch (err) {
      report(name + '(' + JSON.stringify(args[0]) + ') threw: ' + (err && err.message ? err.message : String(err)));
    }
    return true;
  }

  // ---- the mouse ------------------------------------------------------------
  var lastTarget = null;
  function moveTo(x, y) {
    var target = document.elementFromPoint(x, y) || document.body || document.documentElement;
    if (!target) return;
    var init = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, screenX: x, screenY: y, view: window };
    if (lastTarget !== target) {
      try { target.dispatchEvent(new MouseEvent('mouseover', init)); } catch (_) {}
      lastTarget = target;
    }
    try { target.dispatchEvent(new PointerEvent('pointermove', Object.assign({ pointerType: 'mouse', isPrimary: true }, init))); } catch (_) {}
    try { target.dispatchEvent(new MouseEvent('mousemove', init)); } catch (_) {}
  }

  // ---- the channel ------------------------------------------------------------
  window.addEventListener('message', function (e) {
    if (e.source !== parentWin) return;
    var m = e.data;
    if (!m || m.mantle !== 'wp') return;
    switch (m.kind) {
      case 'props': {
        var missing = !m.list.length ? false : typeof window.livelyPropertyListener !== 'function';
        if (missing) {
          report('it has customisable properties but no livelyPropertyListener function, so its saved values could not be applied');
          break;
        }
        for (var i = 0; i < m.list.length; i++) callLively('livelyPropertyListener', m.list[i]);
        break;
      }
      case 'prop':
        if (!callLively('livelyPropertyListener', [m.name, m.value])) {
          report('it has no livelyPropertyListener function, so "' + m.name + '" could not be applied');
        }
        break;
      case 'sysinfo':
        callLively('livelySystemInformation', [m.json]);
        break;
      case 'cursor':
        if (!paused) moveTo(m.x, m.y);
        break;
      case 'pause': pause(); break;
      case 'resume': resume(); break;
    }
  });

  window.addEventListener('error', function (e) {
    var where = e.filename ? ' (' + String(e.filename).replace(/^mantle-wp:\/\/[^/]+\//, '') + ':' + e.lineno + ')' : '';
    report((e.message || 'a script error') + where);
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    report('an unhandled promise rejection: ' + (r && r.message ? r.message : String(r)));
  });

  window.addEventListener('load', function () {
    post({
      kind: 'ready',
      listener: typeof window.livelyPropertyListener === 'function',
      sysinfo: typeof window.livelySystemInformation === 'function',
    });
  });
})();
