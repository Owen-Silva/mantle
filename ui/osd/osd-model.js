/* osd-model.js - the volume/brightness pop-up's pure logic: when it fades, what it draws, and which
 * apps the expanded (Android-style) panel lists (osd lane, wave 3, 2026-09-24).
 *
 * Kept apart from the page so node can test it (ui/osd/osd-model.test.js) with a fake clock, and
 * main (lib/features/osd.js) can share the placement maths. Loaded as a plain <script> by
 * ui/osd/index.html (window.MantleOsdModel) and by require() in node.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MantleOsdModel = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* 1.5 s after the last key (the user's brief), measured from the LAST thing that happened: a key, a
     level change, the pointer leaving. Windows' own flyout stays ~2.3 s; shorter reads snappier. */
  var HOLD_MS = 1500;
  /* An app that stops playing stays listed this long, so a track change or a paused video does
     not make its row jump out from under the pointer. */
  var GRACE_MS = 4000;

  /* THE FADE CLOCK. Everything that can keep the pop-up up is one of three inputs:
       poke()        a key, a level change, a click in the panel: restart the 1.5 s
       hover(bool)   the pointer is over the pop-up: never fade while it is
       hold(bool)    a slider is being dragged or a set is in flight: never fade while it is
     onFade() is called once when the pop-up should go. setTimeout/clearTimeout/now are injected
     so the test runs on a fake clock. */
  function fader(opts) {
    opts = opts || {};
    var holdMs = opts.holdMs || HOLD_MS;
    var setT = opts.setTimeout || function (f, ms) { return setTimeout(f, ms); };
    var clearT = opts.clearTimeout || function (t) { clearTimeout(t); };
    var onFade = opts.onFade || function () {};
    var timer = null, hovered = false, held = false, up = false;

    function arm() {
      if (timer !== null) { clearT(timer); timer = null; }
      if (!up || hovered || held) return;
      timer = setT(function () {
        timer = null;
        if (!up || hovered || held) return;
        up = false;
        try { onFade(); } catch (e) { /* the page's fade, not ours */ }
      }, holdMs);
    }
    return {
      poke: function () { up = true; arm(); },
      hover: function (on) { hovered = !!on; arm(); },
      hold: function (on) { held = !!on; arm(); },
      /* gone without a fade (main hid it, Esc): nothing is pending any more */
      reset: function () { up = false; hovered = false; held = false; if (timer !== null) { clearT(timer); timer = null; } },
      state: function () { return { up: up, hovered: hovered, held: held, armed: timer !== null }; },
    };
  }

  function pct(v) {
    if (typeof v !== 'number' || !isFinite(v)) return null;
    return Math.max(0, Math.min(100, Math.round(v)));
  }

  /* The bar's own glyphs (ui/bar/bar.js volumeSvg), so the pop-up and the bar never draw a
     different speaker for the same level. level is 0-100 here. */
  function svg(body, size) {
    return '<svg viewBox="0 0 16 16" width="' + (size || 16) + '" height="' + (size || 16) +
      '" aria-hidden="true" focusable="false">' + body + '</svg>';
  }
  function volumeSvg(level, muted, size) {
    var l = pct(level);
    var waves = (l === null || muted) ? 0 : l <= 0 ? 0 : l <= 33 ? 1 : l <= 66 ? 2 : 3;
    var s = '<path d="M2.2 6.1h2.4L8.1 3.1v9.8L4.6 9.9H2.2z" fill="currentColor"/>';
    var arcs = ['M10 6.2a2.6 2.6 0 0 1 0 3.6', 'M11.8 4.9a5 5 0 0 1 0 6.2', 'M13.6 3.6a7.4 7.4 0 0 1 0 8.8'];
    for (var i = 0; i < waves; i++)
      s += '<path d="' + arcs[i] + '" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>';
    if (muted)
      s += '<path d="M10.2 5.6l4.6 4.8M14.8 5.6l-4.6 4.8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>';
    return svg(s, size);
  }
  /* A sun whose rays grow with the level: 4 short rays at the bottom, 8 long ones at the top. */
  function sunSvg(level, size) {
    var l = pct(level);
    var long = l === null ? 1.2 : 1.1 + (l / 100) * 1.3;
    var s = '<circle cx="8" cy="8" r="2.6" fill="' + (l !== null && l >= 50 ? 'currentColor' : 'none') +
      '" stroke="currentColor" stroke-width="1.2"/>';
    for (var i = 0; i < 8; i++) {
      var a = i * Math.PI / 4, r0 = 4.4, r1 = r0 + long;
      s += '<path d="M' + (8 + Math.cos(a) * r0).toFixed(2) + ' ' + (8 + Math.sin(a) * r0).toFixed(2) +
        'L' + (8 + Math.cos(a) * r1).toFixed(2) + ' ' + (8 + Math.sin(a) * r1).toFixed(2) +
        '" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>';
    }
    return svg(s, size);
  }

  /* A REASON IN PLAIN WORDS (capture-osd 2026-09-29). Reasons come up from Windows through the
     sidecar with codes in them ("no default playback device (HRESULT 0x80070490)"); the pop-up is
     read by someone who is not the user, so known ones become a sentence that says what to do, and any
     other loses its error codes and exception names but keeps its words (never a silent blank). */
  var NO_DEVICE = 'No speakers or headphones are connected. Plug some in, or turn a sound device on in Windows’ Sound settings';
  function plain(reason) {
    var s = typeof reason === 'string' ? reason
      : reason && typeof reason === 'object' ? (typeof reason.message === 'string' ? reason.message : '')
        : reason == null ? '' : String(reason);
    if (/no default playback device/i.test(s)) return NO_DEVICE;
    s = s.replace(/\s*\((?:HRESULT|error|code)?\s*:?\s*0x[0-9a-f]+\)/gi, '')
      .replace(/\b(?:HRESULT\s*)?0x[0-9a-f]{6,8}\b/gi, '')
      .replace(/\b[A-Z][A-Za-z]*Exception:\s*/g, '')
      .replace(/\bthe sidecar\b/gi, 'Mantle').replace(/\bsidecar\b/gi, 'Mantle')
      .replace(/\s{2,}/g, ' ').replace(/\s+([,.;:)])/g, '$1').trim();
    return s || 'no reason was given';
  }

  /* THE WHEEL over the pop-up (capture-osd 2026-09-29). Every wheel event used to be a 2-point step,
     so a touchpad (dozens of tiny deltas per swipe) threw the volume from 20 to 100 in one flick.
     Now a mouse notch (|deltaY| >= 100 px, or any line/page-mode event) is one step, and small deltas
     add up until they make a notch's worth. Returns { steps: +n up / -n down, acc: the carry }. */
  var NOTCH = 100;
  function wheel(acc, deltaY, deltaMode) {
    var d = Number(deltaY);
    if (!isFinite(d) || d === 0) return { steps: 0, acc: acc || 0 };
    if (deltaMode === 1 || deltaMode === 2 || Math.abs(d) >= NOTCH) return { steps: d < 0 ? 1 : -1, acc: 0 };
    var a = (acc || 0);
    if (a !== 0 && (a < 0) !== (d < 0)) a = 0;          // turned round: start the new direction afresh
    a += d;
    var n = 0;
    while (Math.abs(a) >= NOTCH) { n += a < 0 ? 1 : -1; a += a < 0 ? NOTCH : -NOTCH; }
    return { steps: n, acc: a };
  }

  /* What the pill says, in words, for its number, its label and its screen-reader line. */
  function describe(kind, st) {
    st = st || {};
    var l = pct(st.level);
    if (kind === 'brightness') {
      if (st.ok === false || l === null)
        return { value: '—', label: 'Brightness', aria: 'Brightness unavailable: ' + plain(st.reason), fill: 0, dead: true };
      return { value: String(l), label: 'Brightness', aria: 'Brightness ' + l + '%', fill: l, dead: false };
    }
    if (st.ok === false || l === null)
      return { value: '—', label: 'Volume', aria: 'Volume unavailable: ' + plain(st.reason), fill: 0, dead: true };
    if (st.muted) return { value: String(l), label: 'Muted', aria: 'Muted (volume ' + l + '%)', fill: l, dead: false, muted: true };
    return { value: String(l), label: 'Volume', aria: 'Volume ' + l + '%', fill: l, dead: false };
  }

  /* WHICH APPS THE PANEL LISTS: every app playing sound now, in a stable order (first seen
     first, so rows do not reshuffle as levels change), plus any that stopped less than
     GRACE_MS ago or that `keep(key)` says is in use (a row under the pointer, a set in flight).
     prev: the last result's memory ({key: {firstAt, lastActiveAt}}), carried by the caller.
     Returns { rows: [session...], memo }. System sounds are listed only while they play. */
  function listApps(sessions, memo, now, keep) {
    memo = memo || {};
    keep = keep || function () { return false; };
    var next = {}, rows = [];
    (Array.isArray(sessions) ? sessions : []).forEach(function (s, i) {
      if (!s || !s.key) return;
      var m = memo[s.key] || { firstAt: now, lastActiveAt: -Infinity };
      if (s.active) m = { firstAt: m.firstAt, lastActiveAt: now };
      var show = s.active || now - m.lastActiveAt < GRACE_MS || keep(s.key);
      if (m.lastActiveAt > -Infinity || keep(s.key)) next[s.key] = m;
      if (show) rows.push({ s: s, firstAt: m.firstAt, i: i });
    });
    // first seen first; apps seen in the same read keep Windows' own order
    rows.sort(function (a, b) { return a.firstAt - b.firstAt || a.i - b.i; });
    return { rows: rows.map(function (r) { return r.s; }), memo: next };
  }

  function appName(s) {
    if (!s) return 'An app';
    if (s.system) return 'System sounds';
    return s.name || 'An app';
  }

  /* WHERE THE POP-UP GOES (main uses this): bottom-centre of the display, just above the bar.
     bar: the bar's on-screen rect (DIP) or null; work: the display's work area; size: {w, h};
     bounds (optional): the whole display, to tell whether the bar is on THIS display at all.
     `gap` is the space between the pill and whatever is under it. Top-docked bar: the pop-up
     goes below it instead. Whole DIPs, always inside the work area. */
  function place(bar, work, size, gap, bounds) {
    gap = gap === undefined ? 10 : gap;
    var on = bounds || work;   // the whole display: a --dock bar reserves its strip OUTSIDE the work area
    var w = Math.round(size.w), h = Math.round(size.h);
    var x = Math.round(work.x + (work.width - w) / 2);
    var y;
    // Only a bar ON this display counts (capture-osd 2026-09-29): the pop-up goes to the display under
    // the cursor, the bar lives on one display, and a hover-mode bar is parked below the screen.
    var barUsable = bar && bar.width > 0 && bar.height > 0 &&
      bar.x < on.x + on.width && bar.x + bar.width > on.x &&
      bar.y < on.y + on.height && bar.y + bar.height > on.y;
    var top = barUsable && bar.y + bar.height / 2 < work.y + work.height / 2;
    if (barUsable && !top) y = Math.round(bar.y - gap - h);
    else if (barUsable && top) y = Math.round(bar.y + bar.height + gap);
    else y = Math.round(work.y + work.height - gap - h - 40);   // no bar: where it would be
    x = Math.max(work.x, Math.min(x, work.x + work.width - w));
    y = Math.max(work.y, Math.min(y, work.y + work.height - h));
    return { x: x, y: y, width: w, height: h, below: !!top };
  }

  /* WHERE THE POP-UP GOES NOW: as if the bar were not there, and it GLIDES with the bar (lane
     corner-follow-osd, 2026-10-17; lib/bar-follow.js). The user: no overlapping UI anywhere, "just have
     them smoothly move up if the taskbar comes up". place() above put the window's bottom on the bar's
     RESTING top even while the bar was hidden (ctx.host.barRect() is the resting shape then too), so a
     hidden bar left the pop-up floating a bar-height up. Here the LOW window's bottom sits on the work
     area's bottom (the page's --m margin is the gap to the edge), and `reach` is how far the page lifts
     the pane while the bar is up (reachOver: lib/bar-follow.js's, passed in so the page can load this
     file too), never more than the room above. The window while it can glide is `full` = height + reach
     tall, its bottom on the low spot's. A top-edge bar: place()'s spot (below it), reach 0, no glide.
     place() itself is unchanged: the layouts and on-top HUDs still use it. */
  function placeLow(bar, work, size, bounds, reachOver) {
    var p = place(bar, work, size, 0, bounds);
    if (p.below) return Object.assign(p, { reach: 0, full: p.height });
    var y = Math.max(work.y, Math.round(work.y + work.height - p.height));
    var low = { x: p.x, y: y, width: p.width, height: p.height, below: false };
    var on = bounds || work;
    var barOn = bar && bar.width > 0 && bar.height > 0 &&
      bar.x < on.x + on.width && bar.x + bar.width > on.x && bar.y < on.y + on.height && bar.y + bar.height > on.y;
    var reach = barOn && typeof reachOver === 'function' ? Math.max(0, Math.round(Number(reachOver(low, bar, work)) || 0)) : 0;
    low.reach = Math.min(reach, y - work.y);
    low.full = low.height + low.reach;
    return low;
  }

  return {
    HOLD_MS: HOLD_MS, GRACE_MS: GRACE_MS,
    fader: fader, pct: pct, volumeSvg: volumeSvg, sunSvg: sunSvg, describe: describe, plain: plain, wheel: wheel,
    listApps: listApps, appName: appName, place: place, placeLow: placeLow,
  };
}));
