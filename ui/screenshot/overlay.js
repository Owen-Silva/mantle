/* overlay.js - one monitor's screenshot overlay (Win+Shift+S / PrintScreen).
 *
 * Main hands the page `screenshot.frame`: the frozen frame of THIS monitor (a BMP the sidecar wrote
 * to %TEMP%), the monitor's physical rect, and the top-level windows (physical, topmost first).
 * The page decodes the frame while its window is still parked off screen and says
 * `screenshot.ready`; main then moves the window on screen, so the first thing Owen sees is the
 * frozen frame already drawn, never an empty window.
 *
 * Every rect that leaves this page is PHYSICAL (virtual-screen) px, computed by geometry.js from
 * this monitor's own physical-to-CSS ratio: that is what makes a mixed-DPI desktop correct - each
 * monitor has its own page, and each page has exactly one scale.
 *
 * Modes: Rectangle (drag; mouse-up captures, like Windows), Window (the window under the pointer
 * is highlighted, a click captures it), Full screen (a click captures this monitor), Copy text
 * (drag like Rectangle; main reads the text in the area with Windows' OCR and copies it as plain
 * text instead of saving a picture). Keyboard: R / W / F / T pick the mode, the arrows move a
 * crosshair (Shift: 10 px), Enter or Space acts (in Rectangle and Copy text: the first press
 * anchors, the arrows stretch, the second captures), Esc cancels, Tab walks the mode bar.
 *
 * Copy text is a MODE (a fourth button) rather than a modifier because the bar already is the
 * place a capture's outcome is picked, and a held key is invisible: the pressed button and its
 * hint say what the drag will do. It is NOT remembered for the next capture (main never stores
 * it), so Win+Shift+S always opens as a screenshot. When Windows' OCR cannot be reached, the
 * button is aria-disabled with the reason as its tooltip, and T or a click says it in the hint.
 */
(function () {
  'use strict';
  var G = window.ShotGeometry;
  var bridge = window.mantle;
  var $ = function (id) { return document.getElementById(id); };
  var frame = $('frame'), hole = $('hole'), size = $('size'), hint = $('hint');
  var gx = $('guide-x'), gy = $('guide-y'), bar = $('bar');

  var HINTS = {
    rect: 'Drag to capture an area · Esc to cancel',
    window: 'Click a window to capture it · Esc to cancel',
    full: 'Click to capture this screen · Esc to cancel',
    text: 'Drag over text to copy it · Esc to cancel',
  };
  var S = {
    seq: 0, grab: 0, mon: null, windows: [], mode: 'rect', view: null,
    ocr: { available: false, why: 'Mantle has not said yet whether Windows’ OCR is available' },
    ptr: null,          // the last pointer position on this page (CSS px)
    kbd: null,          // the keyboard crosshair (CSS px), when the arrows are in use
    anchor: null,       // where a Rectangle drag (or a keyboard selection) started
    dragging: false, done: true, failed: false,
    pressed: false,     // the left button went down on the page (not the bar) during this capture
  };
  window.__shot = S;    // for the tests and shoot.js: read-only use

  function view() { return { w: window.innerWidth, h: window.innerHeight }; }

  function send(verb, args) {
    if (!bridge) return Promise.resolve(null);
    return bridge.call('screenshot.' + verb, args || {}).catch(function (err) {
      console.error('screenshot.' + verb + ' failed: ' + (err && err.message));
      return null;
    });
  }

  /* ---- drawing ------------------------------------------------------------------------------ */

  function showHole(css, phys) {
    if (!css) {
      hole.hidden = true;
      size.hidden = true;
      document.body.classList.remove('has-hole');
      return;
    }
    hole.hidden = false;
    document.body.classList.add('has-hole');
    hole.style.transform = 'translate(' + css.x + 'px,' + css.y + 'px)';
    hole.style.width = css.w + 'px';
    hole.style.height = css.h + 'px';
    size.textContent = G.sizeText(phys.w, phys.h);
    size.hidden = false;
    var v = S.view || view();
    var vis = G.intersect(css, { x: 0, y: 0, w: v.w, h: v.h }) || css;
    var spot = G.labelSpot(vis, v, size.offsetWidth || 90, size.offsetHeight || 24, 8);
    size.style.transform = 'translate(' + Math.round(spot.x) + 'px,' + Math.round(spot.y) + 'px)';
  }

  function showGuides(p) {
    var on = !!p && drags(S.mode) && !S.dragging && !S.anchor;
    gx.hidden = gy.hidden = !on;
    if (!on) return;
    gx.style.transform = 'translateY(' + Math.round(p.y) + 'px)';
    gy.style.transform = 'translateX(' + Math.round(p.x) + 'px)';
  }

  /** What would be captured right now, as {css, phys}, or null. */
  function target(p) {
    if (!S.mon || !p) return null;
    var v = S.view || view();
    var phys;
    if (drags(S.mode)) {
      if (!S.anchor) return null;
      var r = G.normRect(S.anchor.x, S.anchor.y, p.x, p.y);
      phys = G.cssToPhys(r, S.mon, v);
    } else if (S.mode === 'window') {
      var hit = G.windowAt(S.windows, G.pointToPhys(p.x, p.y, S.mon, v), S.mon);
      phys = hit ? { x: hit.x, y: hit.y, w: hit.w, h: hit.h, kind: hit.kind, hwnd: hit.hwnd } : null;
    } else {
      phys = { x: S.mon.x, y: S.mon.y, w: S.mon.w, h: S.mon.h, kind: 'monitor' };
    }
    if (!phys || !phys.w || !phys.h) return null;
    return { css: G.physToCss(phys, S.mon, v), phys: phys };
  }

  function redraw() {
    var p = S.kbd || S.ptr;
    showGuides(p);
    var t = target(p);
    showHole(t && t.css, t && t.phys);
  }

  /** Rectangle and Copy text are both a drag; they differ only in what main does with the area. */
  function drags(mode) { return mode === 'rect' || mode === 'text'; }

  /** The Copy text button says whether Windows' OCR can be reached, and if not, why (its tooltip). */
  function showOcr() {
    var b = bar.querySelector('button[data-mode="text"]');
    if (!b) return;
    var ok = !!(S.ocr && S.ocr.available);
    b.setAttribute('aria-disabled', String(!ok));
    b.classList.toggle('off', !ok);
    b.title = ok ? 'Copy text (T)' : 'Copy text is unavailable: ' + ((S.ocr && S.ocr.why) || 'no reason was given');
  }

  function setMode(mode, tell) {
    if (!HINTS[mode]) return;
    if (mode === 'text' && !(S.ocr && S.ocr.available)) {
      // NO SILENT FAILURES: the press is answered, in the hint, with the reason; the mode stays.
      hint.textContent = 'Copy text is unavailable: ' + ((S.ocr && S.ocr.why) || 'no reason was given');
      hint.classList.add('warn');
      return;
    }
    hint.classList.remove('warn');
    S.mode = mode;
    S.anchor = null;
    S.dragging = false;
    document.body.classList.remove('mode-rect', 'mode-window', 'mode-full', 'mode-text', 'selecting');
    document.body.classList.add('mode-' + mode);
    Array.prototype.forEach.call(bar.querySelectorAll('.mode'), function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-mode') === mode));
    });
    hint.textContent = HINTS[mode];
    redraw();
    if (tell) send('mode', { mode: mode });
  }

  function fail(reason) {
    S.failed = true;
    document.body.classList.add('failed');
    $('problem-text').textContent = reason;
    $('problem').hidden = false;
    showHole(null);
  }

  /* ---- the session ---------------------------------------------------------------------------- */

  function commit(t, via) {
    if (S.done || !t || !G.isCapture(t.phys)) return false;
    S.done = true;
    send('commit', {
      seq: S.seq, grab: S.grab, monitor: S.mon.index, mode: S.mode, via: via,
      rect: { x: t.phys.x, y: t.phys.y, w: t.phys.w, h: t.phys.h },
      kind: t.phys.kind || 'area',
    });
    return true;
  }

  function cancel(why) {
    if (S.done && !S.failed) return;
    S.done = true;
    send('cancel', { seq: S.seq, why: why });
  }

  function clear() {
    S.done = true;
    S.anchor = null; S.dragging = false; S.pressed = false; S.kbd = null; S.ptr = null; S.mon = null; S.windows = [];
    frame.removeAttribute('src');            // a parked window holds no picture of the screen
    showHole(null);
    showGuides(null);
    document.body.classList.remove('selecting', 'failed');
    $('problem').hidden = true;
  }

  function onFrame(f) {
    if (!f || !f.monitor) return;
    clear();
    S.seq = f.seq; S.grab = f.grab; S.mon = f.monitor; S.windows = f.windows || [];
    S.failed = false; S.done = false;
    S.view = view();
    S.ocr = f.ocr || { available: false, why: 'Mantle did not say whether Windows’ OCR is available' };
    showOcr();
    setMode(f.mode === 'text' && !S.ocr.available ? 'rect' : (f.mode || 'rect'), false);
    if (f.cursor) {
      // Where the pointer already is (physical), so the guides and the Window highlight are
      // right from the first frame, before any mouse move.
      var v = S.view, s = { sx: S.mon.w / v.w, sy: S.mon.h / v.h };
      var cx = (f.cursor.x - S.mon.x) / s.sx, cy = (f.cursor.y - S.mon.y) / s.sy;
      if (cx >= 0 && cy >= 0 && cx < v.w && cy < v.h) S.ptr = { x: cx, y: cy };
    }
    if (f.problem) { fail(f.problem); send('ready', { seq: f.seq, monitor: S.mon.index, ms: 0, problem: f.problem }); return; }
    var t0 = performance.now();
    frame.src = f.src;
    frame.decode().then(function () {
      if (S.seq !== f.seq) return;
      var nat = { w: frame.naturalWidth, h: frame.naturalHeight };
      var decodeMs = Math.round((performance.now() - t0) * 10) / 10;
      redraw();
      // Two frames: the decoded picture has to be PAINTED before main moves the window on screen.
      // A window that is hidden (a --test run keeps it so) gets no animation frames at all, so a
      // 250 ms timer stands in; whichever comes first says ready, once.
      var said = false;
      var ready = function (how) {
        if (said || S.seq !== f.seq) return;
        said = true;
        send('ready', { seq: f.seq, monitor: S.mon.index, ms: Math.round((performance.now() - t0) * 10) / 10,
          decodeMs: decodeMs, natural: nat, view: S.view, dpr: window.devicePixelRatio, how: how });
      };
      requestAnimationFrame(function () { requestAnimationFrame(function () { ready('painted'); }); });
      setTimeout(function () { ready('timer (no animation frames: the window is hidden)'); }, 250);
    }, function (err) {
      if (S.seq !== f.seq) return;
      // The screen shows plain words; main's log gets the browser's own reason (ready.problem).
      fail('Mantle could not show the picture of this screen. Press Esc and take the screenshot again.');
      send('ready', { seq: f.seq, monitor: S.mon.index, ms: Math.round(performance.now() - t0),
        problem: 'the frozen frame of this screen could not be decoded (' +
          (window.MantlePlain ? window.MantlePlain.forLog(err) : ((err && err.message) || 'no reason given')) + ')' });
    });
  }

  /* ---- input ----------------------------------------------------------------------------------- */

  function pt(e) { return { x: e.clientX, y: e.clientY }; }
  function onBar(e) { return !!(e.target && e.target.closest && e.target.closest('#bar, #problem')); }

  /* RIGHT-CLICK (lane capture-shot, 2026-09-29; it did nothing before): during a drag it drops the
     selection and the crosshair is back (start over without leaving); otherwise it cancels, like Esc.
     The way ShareX and Greenshot behave, and the one a hand already on the mouse reaches for. */
  function rightClick() {
    if (S.done) return;
    if (drags(S.mode) && S.anchor) {
      S.anchor = null; S.dragging = false; S.pressed = false;
      document.body.classList.remove('selecting');
      redraw();
      return;
    }
    cancel('right-click');
  }
  document.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  // mousedown, not pointerdown: a second button pressed DURING a left drag is a chorded press, which
  // fires no pointerdown (Pointer Events), only a pointermove; the mouse event still comes.
  document.addEventListener('mousedown', function (e) { if (e.button === 2) { e.preventDefault(); rightClick(); } });

  document.addEventListener('pointerdown', function (e) {
    if (e.button === 2) return;          // the right button: mousedown above
    // A press that starts on the bar (or the problem box) never captures when it is let go over
    // the screen: before, pressing a mode button and sliding off it captured a window or the screen.
    S.pressed = !(S.done || S.failed || e.button !== 0 || onBar(e));
    if (!S.pressed) return;
    S.kbd = null;
    S.ptr = pt(e);
    if (drags(S.mode)) {
      S.anchor = S.ptr;
      S.dragging = true;
      document.body.classList.add('selecting');
      try { document.body.setPointerCapture(e.pointerId); } catch (_) { /* the drag still works inside */ }
      redraw();
    }
  });

  document.addEventListener('pointermove', function (e) {
    if (S.done) return;
    S.ptr = pt(e);
    if (!S.dragging) S.kbd = null;
    redraw();
  });

  document.addEventListener('pointerup', function (e) {
    if (S.done || S.failed || e.button !== 0) return;
    if (onBar(e) && !S.dragging) return;
    if (!S.pressed) return;              // the press began on the bar, or before this capture
    S.pressed = false;
    S.ptr = pt(e);
    var t = target(S.ptr);
    if (drags(S.mode)) {
      S.dragging = false;
      document.body.classList.remove('selecting');
      if (!commit(t, 'pointer')) { S.anchor = null; redraw(); }     // a click, not a drag: keep going
    } else {
      commit(t, 'pointer');
    }
  });

  bar.addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b || S.done) return;
    if (b.id === 'close') { cancel('the close button'); return; }
    setMode(b.getAttribute('data-mode'), true);
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { e.preventDefault(); cancel('Esc'); return; }
    if (S.done || S.failed) return;
    var onButton = e.target && e.target.tagName === 'BUTTON';
    var k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    var byKey = { r: 'rect', w: 'window', f: 'full', t: 'text' }[k];
    if (byKey) { setMode(byKey, true); e.preventDefault(); return; }
    var step = e.shiftKey ? 10 : 1;
    var d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[k];
    var v = S.view || view();
    if (d) {
      e.preventDefault();
      var from = S.kbd || S.ptr || { x: Math.round(v.w / 2), y: Math.round(v.h / 2) };
      S.kbd = { x: Math.max(0, Math.min(v.w - 1, from.x + d[0])), y: Math.max(0, Math.min(v.h - 1, from.y + d[1])) };
      redraw();
      return;
    }
    if ((k === 'Enter' || k === ' ') && !onButton) {
      e.preventDefault();
      var p = S.kbd || S.ptr || { x: Math.round(v.w / 2), y: Math.round(v.h / 2) };
      S.kbd = p;
      if (drags(S.mode) && !S.anchor) { S.anchor = p; document.body.classList.add('selecting'); redraw(); return; }
      commit(target(p), 'keyboard');
    }
  });

  window.addEventListener('resize', function () { S.view = view(); redraw(); });

  /* ---- the bridge ------------------------------------------------------------------------------ */

  if (!bridge) { fail('this page was opened without Mantle (no window.mantle bridge)'); return; }
  bridge.on('screenshot.frame', onFrame);
  bridge.on('screenshot.mode', function (m) { if (m && m.mode && m.mode !== S.mode && !S.done) setMode(m.mode, false); });
  bridge.on('screenshot.clear', function (c) { canary({ on: false }); clear(c); });
  // Main asked Windows' OCR again during this capture (it was unavailable): the Copy text button follows.
  bridge.on('screenshot.ocr', function (o) {
    if (!o || S.done) return;
    S.ocr = o;
    showOcr();
    if (hint.classList.contains('warn') && o.available) { hint.classList.remove('warn'); hint.textContent = HINTS[S.mode]; }
  });

  // THE CANARY (lib/features/screenshot.js canary()): a magenta dot a few device pixels wide, on
  // top of everything on this page for one check, so main can read the SCREEN's pixel there and
  // know the overlay is really what Owen sees (2026-09-24: a capture that every window flag called
  // "on screen" was invisible). Painted, then two frames, then main is told; main turns it off.
  var dot = null;
  function canary(c) {
    if (!c || !c.on) { if (dot) { dot.remove(); dot = null; } return; }
    if (!dot) { dot = document.createElement('div'); dot.id = 'canary'; document.body.appendChild(dot); }
    var sz = Math.max(c.size || 3, 1);
    dot.style.width = dot.style.height = sz + 'px';
    dot.style.left = (c.x - sz / 2) + 'px';
    dot.style.top = (c.y - sz / 2) + 'px';
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        send('canary', { seq: c.seq, focus: document.hasFocus(), visibility: document.visibilityState });
      });
    });
  }
  bridge.on('screenshot.canary', canary);
  send('loaded', { at: Math.round(performance.now()) });
}());
