/* ui/shared/tips.js - Mantle's own tooltips, drawn inside the page (2026-09-24).
 *
 * Owen, with a screenshot of the speaker's "Volume 40%" tooltip whose bottom was hidden behind the
 * bar: "can you make these popout things the same theme as the rest of it and make sure they dont
 * go behind the taskbar please". Those were Chromium's NATIVE tooltips, one per `title` attribute:
 * Windows' dark style, and a separate OS window below the topmost bar window in z-order, so the
 * bar drew over them.
 *
 * WHAT THIS DOES, with no change to the pages that set titles:
 *   - On hover (or keyboard focus) of anything with a `title`, the title is moved into
 *     data-mtip, so the native tooltip never appears. Blink reads the title for its tooltip AFTER
 *     the pointer events of a move are dispatched, and every later move re-reads it, so taking it
 *     in pointerover is soon enough. The element also gets its own `title` accessor over data-mtip,
 *     so page code that reads, compares, clears or appends to `el.title` (bar.js does all four)
 *     sees exactly what it wrote. uninstall() puts every title back as an attribute.
 *   - A themed tip (tips.css) is shown above the element after 450 ms (the OS's initial delay),
 *     at once when the pointer moves on from one tipped element to the next while a tip is up,
 *     and hidden on pointerdown, wheel, scroll, any key, leaving, or the window losing focus. It
 *     never takes a click, the hover or the focus (pointer-events: none). A title that changes
 *     while its tip is up (the live volume level) is updated in place. Keyboard focus shows it
 *     too, and the element is aria-describedby the tip while it is up; an element whose only
 *     accessible name was its title keeps that name as an aria-label.
 *
 * ROOM (the bar, data-room="bar" on the script tag). Since 339e911 the bar window is POPOVER_MAX
 * (480 DIP) taller than the pill, and a window REGION (lib/bar-shape.js, set in main.js
 * setBarShape) shows only the pill plus whatever room the open popover asked for through
 * `bar.popover`; outside it nothing is drawn. So a tip above the pill must ask for room the same
 * way: bar.popover {open:true, key:'tip', height} and {open:false} to give it back. In hover mode
 * that is a region change only (no resize, so no dip). main keeps ONE room owner (barPopover): the
 * latest open wins and any close shuts whatever is open. So the rules here are:
 *   - never ask while a popover (#pop) is open: a tip then fits inside the room the popover holds
 *     (for an element IN the popover: next to it, off the panel's words, see placeIn below);
 *   - never give back while a popover is open: bar.js's own open already replaced the tip's room
 *     in main, and a close from here would shut THE POPOVER's room under it;
 *   - give back only from a timer (a later task), never synchronously from a title setter or a
 *     DOM observer: bar.js opens a popover in the same task as it clears a title, so by the time
 *     the timer runs, #pop already says whether the room is still ours;
 *   - hide the moment #pop opens or closes (the room is changing under the tip).
 * main answers a FRESH open only after the popover wipe (POP_WIPE_MS, 200 ms), but sets the shape
 * the moment the call arrives, so the tip does not wait for the answer; the fade-in's first step
 * (50 ms) lands after the shape has changed.
 * A window with no room above the pill (a framed --test bar, --dock) cannot grow without a resize
 * (the dip Owen asked to be rid of), so there the tip is clamped INTO the window instead: over
 * the pill rather than off the window.
 *
 * The placement arithmetic (place) is pure and tested in node: node ui/shared/tips.test.js.
 */
(function () {
  'use strict';

  var ATTR = 'data-mtip';          // where an adopted title lives
  var NAME = 'data-mtip-name';     // the aria-label this module wrote, so it only ever takes back its own
  var TIP_ID = 'mantle-tip';
  var T = {
    delay: 450,        // first tip: Windows' own initial delay (TTDT_INITIAL at the default double-click time is 500)
    handoff: 500,      // after a tip was up, the next one within this long shows at once
    grace: 80,         // leaving an element: the tip waits this long for the next one, so a hand-off never blinks
    release: 220,      // after hiding: the 100 ms fade has finished before the room goes
    focusAutopop: 6000,// a keyboard-focus tip holds the bar up (main pins it while room is held): not forever
    watch: 250         // while up: is the element still there, still hovered, still where it was?
  };
  var GAP = 6;        // between the element (or the pill, for anything in it) and the tip
  var MARGIN = 4;     // from the window's sides
  var SLACK = 2;      // extra room past the tip's edge: Chromium rounds the shape to whole pixels
  var ROOM_MAX = 480; // main.js POPOVER_MAX: main caps any ask at this
  var ROOM_HYST = 20; // re-ask only when the need grows, or shrinks by more than this

  /* ------------------------------------------------------------------ placement (pure) */

  function mirror(r, vh) {
    return r ? { left: r.left, right: r.right, top: vh - r.bottom, bottom: vh - r.top } : null;
  }

  /**
   * Where a w x h tip goes for anchor rect `a`, and how much room it needs. Page px (= DIP).
   *   o = { a, w, h, vw, vh, edge: 'bottom'|'top', pill: rect|null, inPill: bool,
   *         vis: {top, bottom} (what is on screen now without asking), canAsk: bool }
   * Returns { x, y, side, need }: side 'out' = away from the screen edge (above, on a bottom bar),
   * 'in' = flipped toward it, 'over' = clamped into what is visible; need = DIP of room to ask for
   * (0 = none). Worked for a bottom bar; a top bar is the same sum mirrored.
   */
  function place(o) {
    if (o.panel) { var q = placeIn(o); if (q) return q; }
    var flip = o.edge === 'top';
    var vh = o.vh;
    var a = flip ? mirror(o.a, vh) : o.a;
    var pill = flip ? mirror(o.pill, vh) : o.pill;
    var vis = flip ? { top: vh - o.vis.bottom, bottom: vh - o.vis.top } : o.vis;
    var h = o.h;
    var x = Math.max(MARGIN, Math.min((o.a.left + o.a.right) / 2 - o.w / 2, o.vw - o.w - MARGIN));

    // Out: above the element -- above the whole pill for anything in it, never over or under it.
    var ref = o.inPill && pill ? Math.min(a.top, pill.top) : a.top;
    var y = ref - GAP - h;
    var side = 'out';
    var need = 0;
    if (y < vis.top) {
      var room = pill ? Math.ceil(pill.top - y) + SLACK : Infinity;
      if (o.canAsk && pill && y >= 0 && room <= Math.min(ROOM_MAX, Math.floor(pill.top))) {
        need = room;
      } else {
        // In: below the element, if that is visible and does not run under the pill.
        var y2 = (o.inPill && pill ? Math.max(a.bottom, pill.bottom) : a.bottom) + GAP;
        var limit = !o.inPill && pill && a.bottom <= pill.top + 0.5 ? pill.top - 1 : vis.bottom - 1;
        if (y2 >= vis.top && y2 + h <= limit) {
          y = y2; side = 'in';
        } else {
          // Over: nowhere clean, so inside what is visible, even over the element.
          y = Math.max(vis.top + 1, Math.min(y, vis.bottom - h - 1));
          side = 'over';
        }
      }
    }
    return { x: x, y: flip ? vh - (y + h) : y, side: side, need: need };
  }

  /* INSIDE AN OPEN PANEL (2026-09-25). Owen's screenshot: the quick-settings footer link's tip went
   * straight up over the power tile's warning ("Power mode did not change: ..."), the two texts
   * mixed through the frost, and its right end ran off the panel. A panel is dense with words that
   * matter (a failure reason most of all), so here a tip looks for a spot next to the element that
   * covers none of them:
   *   o.panel  the open popover's rect;   o.avoid  [{left,right,top,bottom, warn}] its text lines
   *   o.measure(width) -> height of the tip wrapped to that width (optional: lets a side spot
   *                       narrow the tip into the room beside the element instead of skipping it)
   * Candidates, in order: away from the screen edge (above, on a bottom bar), toward it, then the
   * side with more room, then the other; above/below try centred, flush with the element's right
   * edge and flush with its left; a side tries centred, top-aligned and bottom-aligned. First every
   * spot inside the panel, then every spot in the rest of the room the window shows (the band
   * beside the panel, never over the pill). Best = covers no warning text, then stays inside the
   * panel, then covers no text at all, then the least warning, then the least text, then order.
   * Inside-the-panel ranks above no-text because a tip hanging off the panel's edge reads as cut
   * off (the first try, measured 2026-09-25: the footer link's tip went 155 px out past the
   * panel's left edge to dodge a battery line); a failure reason ranks above both.
   * Returns null when nothing fits (place() then clamps as before).
   */
  // A side spot narrower than this is a column, not a tip: at 120 px the footer link's 58-character
  // title ran to five lines, 81 px tall, hanging off the panel's edge (headless, 2026-09-25).
  var SIDE_MIN = 150;

  function overlap(r, s) {
    var w = Math.min(r.right, s.right) - Math.max(r.left, s.left);
    var h = Math.min(r.bottom, s.bottom) - Math.max(r.top, s.top);
    return w > 0.5 && h > 0.5 ? w * h : 0;
  }

  function placeIn(o) {
    var a = o.a, P = o.panel, vh = o.vh, top = o.edge === 'top';
    // The band a tip may use: what is visible, minus the pill (never over or under it).
    var band = top
      ? { left: MARGIN, right: o.vw - MARGIN, top: (o.pill ? o.pill.bottom : 0) + 1, bottom: Math.min(vh, o.vis.bottom) - 1 }
      : { left: MARGIN, right: o.vw - MARGIN, top: Math.max(0, o.vis.top) + 1, bottom: (o.pill ? o.pill.top : vh) - 1 };
    var inner = {
      left: Math.max(band.left, P.left + MARGIN), right: Math.min(band.right, P.right - MARGIN),
      top: Math.max(band.top, P.top + MARGIN), bottom: Math.min(band.bottom, P.bottom - MARGIN)
    };
    var avoid = o.avoid || [];
    var vert = top ? ['below', 'above'] : ['above', 'below'];
    var best = null, idx = 0;

    function consider(side, x, y, w, h, B) {
      var r = { left: x, right: x + w, top: y, bottom: y + h };
      idx++;
      if (r.left < B.left - 0.01 || r.right > B.right + 0.01 || r.top < B.top - 0.01 || r.bottom > B.bottom + 0.01) return;
      if (overlap(r, a)) return;
      var warn = 0, text = 0;
      for (var i = 0; i < avoid.length; i++) {
        var v = overlap(r, avoid[i]);
        if (avoid[i].warn) warn += v; else text += v;
      }
      var out = r.left < P.left - 0.5 || r.right > P.right + 0.5 || r.top < P.top - 0.5 || r.bottom > P.bottom + 0.5 ? 1 : 0;
      var key = [warn > 0 ? 1 : 0, out, text > 0 ? 1 : 0, warn, text, idx];
      if (best) {
        for (var k = 0; k < key.length && key[k] === best.key[k]; k++) { /* equal so far */ }
        if (k === key.length || key[k] > best.key[k]) return;
      }
      best = { key: key, x: x, y: y, w: w, h: h, side: side };
    }
    function clamp(v, lo, hi) { return Math.max(lo, Math.min(v, hi)); }

    [inner, band].forEach(function (B) {
      if (B.right - B.left < 1 || B.bottom - B.top < 1) return;
      var w = o.w, h = o.h;
      vert.forEach(function (side) {
        var y = side === 'above' ? a.top - GAP - h : a.bottom + GAP;
        [(a.left + a.right) / 2 - w / 2, a.right - w, a.left].forEach(function (x) {
          consider(side, clamp(x, B.left, B.right - w), y, w, h, B);
        });
      });
      var roomL = a.left - GAP - B.left, roomR = B.right - (a.right + GAP);
      (roomR > roomL ? ['right', 'left'] : ['left', 'right']).forEach(function (side) {
        var room = Math.floor(side === 'left' ? roomL : roomR);
        var ww = w, hh = h;
        if (room < w) {
          if (!o.measure || room < SIDE_MIN) return;
          ww = room; hh = o.measure(ww);
          if (!(hh > 0)) return;
        }
        var x = side === 'left' ? a.left - GAP - ww : a.right + GAP;
        [(a.top + a.bottom) / 2 - hh / 2, a.top, a.bottom - hh].forEach(function (y) {
          consider(side, x, clamp(y, B.top, B.bottom - hh), ww, hh, B);
        });
      });
    });
    return best ? { x: best.x, y: best.y, side: best.side, need: 0, w: best.w, h: best.h, covers: { warn: best.key[3], text: best.key[4] } } : null;
  }

  var api = { place: place, SIDE_MIN: SIDE_MIN, T: T, GAP: GAP, MARGIN: MARGIN, SLACK: SLACK, ROOM_MAX: ROOM_MAX, ATTR: ATTR };
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  /* ------------------------------------------------------------------ runtime */

  var SCRIPT_ROOM = (document.currentScript && document.currentScript.getAttribute('data-room')) || '';
  var own = Object.prototype.hasOwnProperty;

  var installed = false;
  var room = null;            // the room provider (bar), or null: clamp into the window
  var tip = null;
  var anchor = null;          // the element the tip is for (shown or pending)
  var mode = null;            // 'pointer' | 'focus'
  var hoverEl = null;         // the tipped element under the pointer
  var suppressed = null;      // clicked / wheeled / Esc'd: no tip for it until the pointer leaves it
  var shown = false;
  var hiddenAt = 0;
  var showT = 0, graceT = 0, relT = 0, watchT = 0;
  var held = 0;               // DIP of room this module holds in main (0 = none)
  var roomNote = '';          // why the room could not be opened: said in the tip itself
  var built = null;
  var last = null;            // {x, y, w, h, side, need, ax, ay}
  var described = null, describedPrev = null;
  var popWas = false, upWas = false;
  var listeners = [];
  var moTitle = null, moBar = null;
  var lastErr = '';

  function msgOf(e) { return (e && e.message) ? String(e.message).split('\n')[0] : String(e); }

  function textOf(el) {
    var v = el.getAttribute(ATTR);
    if (v === null) v = el.getAttribute('title');
    return v ? String(v).replace(/\s+$/, '') : '';
  }

  function tipOf(node) {
    var el = node && node.nodeType === 1 ? node : (node && node.parentElement) || null;
    if (!el || !el.closest) return null;
    var t = el.closest('[title],[' + ATTR + ']');
    return t && t !== document.documentElement && t !== document.body ? t : null;
  }

  /* --- adopting a title --- */

  function titleGet() {
    if (!installed) { restoreOne(this); return this.getAttribute('title') || ''; }
    var v = this.getAttribute(ATTR);
    return v === null ? '' : v;
  }
  function titleSet(v) {
    if (!installed) { restoreOne(this); this.setAttribute('title', String(v)); return; }
    var s = String(v);
    this.setAttribute(ATTR, s);
    nameFor(this, s);
    if (this === anchor) refresh();
  }

  function adopt(el) {
    if (el.hasAttribute('title')) {
      var v = el.getAttribute('title');
      el.removeAttribute('title');
      el.setAttribute(ATTR, v);
      nameFor(el, v);
    }
    if (!own.call(el, 'title')) {
      try { Object.defineProperty(el, 'title', { configurable: true, enumerable: true, get: titleGet, set: titleSet }); } catch (_) { /* a frozen element: the attribute move alone still stops the native tip */ }
    }
  }

  function restoreOne(el) {
    if (own.call(el, 'title')) delete el.title;
    var v = el.getAttribute(ATTR);
    if (v !== null) { el.setAttribute('title', v); el.removeAttribute(ATTR); }
    var mine = el.getAttribute(NAME);
    if (mine !== null) {
      if (el.getAttribute('aria-label') === mine) el.removeAttribute('aria-label');
      el.removeAttribute(NAME);
    }
  }

  /* The title was the accessible NAME of an icon-only button (#volume has nothing else). Moving
     it would leave a screen reader saying just "button", so such an element gets the same words
     as its aria-label -- only when nothing else names it, and only ever changed back by us. */
  function nameFor(el, v) {
    var mine = el.getAttribute(NAME);
    var al = el.getAttribute('aria-label');
    if (mine !== null) {
      if (al !== mine) { el.removeAttribute(NAME); return; }   // the page labelled it since: theirs now
      if (v) { el.setAttribute('aria-label', v); el.setAttribute(NAME, v); }
      else { el.removeAttribute('aria-label'); el.removeAttribute(NAME); }
      return;
    }
    if (!v || al !== null || el.hasAttribute('aria-labelledby') || (el.textContent || '').trim()) return;
    el.setAttribute('aria-label', v);
    el.setAttribute(NAME, v);
  }

  function describe(el) {
    if (described === el) return;
    unDescribe();
    describedPrev = el.getAttribute('aria-describedby');
    var ids = (describedPrev || '').split(/\s+/).filter(Boolean);
    if (ids.indexOf(TIP_ID) < 0) ids.push(TIP_ID);
    el.setAttribute('aria-describedby', ids.join(' '));
    described = el;
  }
  function unDescribe() {
    if (!described) return;
    if (describedPrev === null) described.removeAttribute('aria-describedby');
    else described.setAttribute('aria-describedby', describedPrev);
    described = null; describedPrev = null;
  }

  /* --- room (the bar) --- */

  function barRoom() {
    function bridge() { return window.mantle && typeof window.mantle.call === 'function' ? window.mantle : null; }
    function pop() { var p = document.getElementById('pop'); return p && !p.hidden ? p : null; }
    function rect(el) { var r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; }
    return {
      popover: pop,
      ask: function (h) {
        var b = bridge();
        if (!b) return Promise.reject(new Error('window.mantle is not present, so no room above the bar could be asked for'));
        // dark: main also takes one picture of what is behind the bar window for the tip's glass
        var args = { open: true, height: h, key: 'tip' };
        if (dark()) args.backdrop = true;
        return b.call('bar.popover', args);
      },
      // key 'tip' on the close too: today's main ignores it (any close shuts the one room), but it
      // lets main tell a tip's close from a popover's if it ever keeps a room per owner.
      give: function () { var b = bridge(); return b ? b.call('bar.popover', { open: false, key: 'tip' }) : Promise.resolve(null); },
      // The pill is off screen (hidden, or on its way): nothing to tip, and asking would reveal it.
      away: function () { var c = document.body.classList; return c.contains('pill') && !c.contains('up'); },
      context: function (el) {
        var vh = window.innerHeight;
        var edge = document.body.getAttribute('data-edge') === 'top' ? 'top' : 'bottom';
        var bar = document.getElementById('bar');
        var p = pop();
        var pill = bar ? rect(bar) : null;
        var pr = p ? rect(p) : null;
        var inPill = !!(bar && bar.contains(el) && !(p && p.contains(el)));
        var vis = edge === 'top'
          ? { top: 0, bottom: pill ? Math.max(pill.bottom, pr ? pr.bottom : -Infinity) : vh }
          : { top: pill ? Math.min(pill.top, pr ? pr.top : Infinity) : 0, bottom: vh };
        return { edge: edge, pill: pill, inPill: inPill, vis: vis, canAsk: !p, panel: p && p.contains(el) ? pr : null, panelEl: p };
      }
    };
  }

  function popoverOpen() { return !!(room && room.popover && room.popover()); }

  /* --- glass (DARK ONLY; lane same-huds, 2026-10-09) ---
     Owen: every surface the same glass, Helm's look. A tip above the pill floats over the desktop,
     so it gets what the bar's pop-ups get: ONE picture of the bar window's whole rectangle, taken by
     main when the tip asks for room (bar.popover {backdrop: true} -> 'bar.popbackdrop' {key:'tip'}),
     blurred once with --lg-blur and nothing else onto a canvas the tip's size, under ONE --lg-fill
     layer (inline, so tips.css's own face is the fallback). The picture covers the whole window, so
     the next tip in the same held room reuses it: no capture per tip. A tip inside an open pop-up
     uses that pop-up's picture (the same window rectangle). Until a picture lands the tip waits,
     unseen, at most GLASS_HOLD ms; when one cannot, it keeps its own face and glass.why says why.
     Light: nothing here runs. */
  var GLASS_HOLD = 150;
  var glass = { img: null, key: null, at: null, win: null, why: '', bakes: 0, ms: null, holdT: 0, url: null, sig: '' };
  var glassCanvas = null, glassOff = null;
  function dark() { return document.documentElement.getAttribute('data-theme') === 'dark'; }
  function onPopBackdrop(p) {
    if (!p || !dark()) return;
    if (typeof p.png !== 'string' || p.png.slice(0, 5) !== 'data:') {
      if (p.key === 'tip') { glass.why = 'no picture behind the tip' + (p.reason ? ': ' + p.reason : ''); unholdGlass(); }
      return;
    }
    var im = new Image();
    im.onload = function () {
      glass.img = im; glass.key = p.key; glass.at = p.at || { x: 0, y: 0, w: 1, h: 1 }; glass.win = p.win || null;
      glass.ms = typeof p.ms === 'number' ? p.ms : null; glass.why = ''; glass.sig = '';
      if (shown) paintGlass();
    };
    im.onerror = function () { if (p.key === 'tip') { glass.why = 'the picture behind the tip did not decode'; unholdGlass(); } };
    im.src = p.png;
  }
  // a pop-up's picture only while a pop-up is open; the tip's own only while its room is held
  function glassUsable() { return !!(glass.img && dark() && room && (popoverOpen() || (glass.key === 'tip' && held > 0))); }
  function holdGlass() {
    if (!tip || glass.holdT) return;
    tip.style.visibility = 'hidden';
    glass.holdT = setTimeout(unholdGlass, GLASS_HOLD);
  }
  function unholdGlass() {
    if (glass.holdT) { clearTimeout(glass.holdT); glass.holdT = 0; }
    if (tip) tip.style.removeProperty('visibility');
  }
  function clearGlass() {
    if (!tip) return;
    glass.sig = '';
    ['background-image', 'background-color', 'background-size', 'background-repeat', 'background-origin'].forEach(function (k) { tip.style.removeProperty(k); });
  }
  function dropGlass(why) { glass.img = null; glass.key = null; glass.why = why || ''; unholdGlass(); clearGlass(); }
  function paintGlass() {
    if (!tip || !last) return;
    if (!glassUsable()) { clearGlass(); return; }
    var r = tip.getBoundingClientRect();
    if (!(r.width > 0) || !(r.height > 0)) return;
    var W = glass.win && glass.win.w > 0 ? glass.win.w : window.innerWidth;
    var H = glass.win && glass.win.h > 0 ? glass.win.h : window.innerHeight;
    var ax = glass.at.x * W, ay = glass.at.y * H, aw = glass.at.w * W, ah = glass.at.h * H;
    // the page is anchored to the bar's edge: a window that grew since keeps the picture on that edge
    if (document.body.getAttribute('data-edge') !== 'top') ay += window.innerHeight - H;
    var sig = [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height), glass.img.src.length, ax, ay].join(',');
    if (sig === glass.sig) { unholdGlass(); return; }
    var tok = getComputedStyle(document.documentElement).getPropertyValue('--lg-blur').trim() || 'none';
    if (!glassCanvas) glassCanvas = document.createElement('canvas');
    var c = glassCanvas, w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
    c.width = w; c.height = h;
    var url;
    try {
      var g = c.getContext('2d');
      g.clearRect(0, 0, w, h);
      g.filter = tok;
      g.drawImage(glass.img, ax - r.left, ay - r.top, aw, ah);
      g.filter = 'none';
      url = c.toDataURL('image/png');
    } catch (e) { glass.why = 'the tip\'s picture could not be drawn: ' + msgOf(e); clearGlass(); unholdGlass(); return; }
    glass.sig = sig; glass.bakes++;
    tip.style.backgroundImage = 'linear-gradient(var(--lg-fill), var(--lg-fill)), url("' + url + '")';
    tip.style.backgroundColor = 'transparent';
    tip.style.backgroundSize = 'auto, 100% 100%';
    tip.style.backgroundRepeat = 'no-repeat, no-repeat';
    tip.style.backgroundOrigin = 'border-box, border-box';
    unholdGlass();
  }

  function askRoom(need) {
    if (!room) return;
    if (relT) { clearTimeout(relT); relT = 0; }
    if (held && need <= held && need >= held - ROOM_HYST) return;
    held = need;
    // dark: this ask brings a fresh picture; without a usable one the tip waits for it, unseen
    if (dark() && !glassUsable()) holdGlass();
    var p;
    try { p = room.ask(need); } catch (e) { p = Promise.reject(e); }
    Promise.resolve(p).then(function (r) {
      setNote(r && r.capped ? 'the room above the bar is capped at ' + r.max + ' px, so this tip may be cut off' : '');
    }, function (e) {
      lastErr = msgOf(e);
      setNote('This tip may be cut off: ' + lastErr);
    });
  }

  function scheduleRelease(ms) {
    if (!held) return;
    if (relT) clearTimeout(relT);
    relT = setTimeout(function () { relT = 0; releaseNow(); }, ms);
  }
  function releaseNow() {
    if (relT) { clearTimeout(relT); relT = 0; }
    if (!held || shown) return;
    held = 0;
    if (glass.key === 'tip') dropGlass('the room above the bar was given back');
    // A popover opened since: bar.js's open replaced this room in main, and a close now would
    // shut the popover's.
    if (popoverOpen()) return;
    try {
      Promise.resolve(room.give()).catch(function (e) { lastErr = 'giving the room back: ' + msgOf(e); });
    } catch (e) { lastErr = 'giving the room back: ' + msgOf(e); }
  }

  function setNote(n) {
    if (n === roomNote) return;
    roomNote = n;
    if (shown && anchor) { build(textOf(anchor)); layout(); }
  }

  /* --- showing --- */

  function build(text) {
    var key = text + '\u0001' + roomNote;
    if (key === built) return;
    built = key;
    tip.textContent = text;
    if (roomNote) {
      var n = document.createElement('span');
      n.className = 'mtip-note';
      n.textContent = roomNote;
      tip.appendChild(n);
    }
  }

  /* The words in an open panel, one rect per line box, so a tip can keep off them. `warn` marks a
     line drawn in --lg-warn: by the house rule (NO SILENT FAILURES) that is a failure's reason,
     the one thing a tip must never hide (Owen's screenshot, 2026-09-25). The anchor's own words
     are left out: a tip is never placed over its element anyway. */
  var WALK_MAX = 600;   // text nodes: a panel has ~150 (quick settings, 2026-09-25); a cap, not a budget
  function textRects(root, skip) {
    var out = [];
    var probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--lg-warn)';
    tip.appendChild(probe);         // ours, not the panel: no mutation a page observer could see
    var warnColor = getComputedStyle(probe).color;
    tip.removeChild(probe);
    var walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var range = document.createRange();
    var colors = new Map();
    for (var n = walk.nextNode(), i = 0; n && i < WALK_MAX; n = walk.nextNode(), i++) {
      if (!/\S/.test(n.nodeValue) || (skip && skip.contains(n))) continue;
      var el = n.parentElement;
      if (!el) continue;
      var col = colors.get(el);
      if (col === undefined) { var cs = getComputedStyle(el); col = cs.visibility === 'visible' ? cs.color : ''; colors.set(el, col); }
      if (!col) continue;
      range.selectNodeContents(n);
      var rs = range.getClientRects();
      for (var j = 0; j < rs.length; j++) {
        var r = rs[j];
        if (r.width > 0 && r.height > 0) out.push({ left: r.left, right: r.right, top: r.top, bottom: r.bottom, warn: col === warnColor });
      }
    }
    return out;
  }

  function layout() {
    var vw = window.innerWidth, vh = window.innerHeight;
    var c = room ? room.context(anchor)
      : { edge: 'bottom', pill: null, inPill: false, vis: { top: 0, bottom: vh }, canAsk: false };
    // In a panel a tip is never wider than the panel: it wraps in whole lines inside it rather
    // than running off its side (the screenshot's tip ran 43 px past the quick-settings panel).
    var cap = Math.min(320, vw - 2 * MARGIN);
    if (c.panel) cap = Math.min(cap, c.panel.right - c.panel.left - 2 * MARGIN);
    tip.style.width = '';
    tip.style.maxWidth = Math.max(80, cap) + 'px';
    var w = tip.offsetWidth, h = tip.offsetHeight;
    var ar = anchor.getBoundingClientRect();
    var a = { left: ar.left, right: ar.right, top: ar.top, bottom: ar.bottom };
    var o = { a: a, w: w, h: h, vw: vw, vh: vh, edge: c.edge, pill: c.pill, inPill: c.inPill, vis: c.vis, canAsk: c.canAsk };
    if (c.panel) {
      o.panel = c.panel;
      try { o.avoid = textRects(c.panelEl, anchor); } catch (e) { o.avoid = []; lastErr = 'reading the panel\'s text: ' + msgOf(e); }
      o.measure = function (width) { tip.style.width = width + 'px'; var hh = tip.offsetHeight; tip.style.width = ''; return hh; };
    }
    var p = place(o);
    if (p.w && p.w !== w) { tip.style.width = p.w + 'px'; w = p.w; h = p.h; }
    var dpr = window.devicePixelRatio || 1;
    // Whole device pixels (a fractional translate blurs the text), rounded AWAY from what the tip
    // must stay clear of: up off the pill for a tip above it, down off the element for one below.
    var away = p.side === 'over' || p.side === 'left' || p.side === 'right' ? Math.round
      : p.side === 'above' ? Math.floor : p.side === 'below' ? Math.ceil
      : ((c.edge === 'top') !== (p.side === 'in') ? Math.ceil : Math.floor);
    var x = Math.round(p.x * dpr) / dpr, y = away(p.y * dpr) / dpr;
    tip.style.transform = 'translate(' + x + 'px,' + y + 'px)';
    tip.setAttribute('data-side', p.side);
    last = { x: x, y: y, w: w, h: h, side: p.side, need: p.need, covers: p.covers || null, ax: a.left, ay: a.top };
    if (p.need) askRoom(p.need);
    if (dark()) paintGlass();
  }

  function showNow(instant) {
    showT = 0;
    if (!anchor || !anchor.isConnected || anchor === suppressed) return;
    if (room && room.away()) return;
    var text = textOf(anchor);
    if (!text) return;
    if (graceT) { clearTimeout(graceT); graceT = 0; }
    tip.classList.toggle('now', !!(instant && shown));
    build(text);
    layout();
    shown = true;
    describe(anchor);
    tip.classList.add('on');
    if (dark()) paintGlass();
    startWatch();
  }

  function hide(instant) {
    if (showT) { clearTimeout(showT); showT = 0; }
    if (graceT) { clearTimeout(graceT); graceT = 0; }
    stopWatch();
    if (!shown) return;
    shown = false;
    hiddenAt = Date.now();
    unDescribe();
    tip.classList.toggle('now', !!instant);
    tip.classList.remove('on');
    scheduleRelease(instant ? 0 : T.release);
  }

  function enter(el, how) {
    if (el === anchor && how === mode && (shown || showT)) return;
    if (el === suppressed) return;
    if (showT) { clearTimeout(showT); showT = 0; }
    var handing = shown || (hiddenAt && Date.now() - hiddenAt < T.handoff);
    if (anchor && anchor !== el) unDescribe();
    anchor = el; mode = how;
    adopt(el);
    if (!textOf(el)) { if (shown) hide(false); return; }
    if (handing) showNow(true);
    else showT = setTimeout(function () { showNow(false); }, T.delay);
  }

  function leave(now) {
    if (showT) { clearTimeout(showT); showT = 0; }
    if (!shown || now) { hide(true); anchor = null; mode = null; return; }
    if (graceT) return;
    graceT = setTimeout(function () { graceT = 0; hide(false); anchor = null; mode = null; }, T.grace);
  }

  function refresh() {
    if (!anchor) return;
    var text = textOf(anchor);
    if (!text) { if (shown) hide(false); return; }
    if (shown) { build(text); layout(); }
    else if (!showT && anchor !== suppressed && (mode === 'focus' || safeMatches(anchor, ':hover'))) {
      showT = setTimeout(function () { showNow(false); }, T.delay);
    }
  }

  function safeMatches(el, sel) { try { return el.matches(sel); } catch (_) { return false; } }

  function startWatch() {
    if (watchT) return;
    var since = Date.now();
    watchT = setInterval(function () {
      if (!shown || !anchor) { stopWatch(); return; }
      if (!anchor.isConnected || !textOf(anchor) || !anchor.getClientRects().length) { hide(false); anchor = null; mode = null; return; }
      if (mode === 'pointer' && !graceT && !safeMatches(anchor, ':hover')) { leave(false); return; }
      if (mode === 'focus') {
        var f = document.activeElement;
        if (!f || !anchor.contains(f) || Date.now() - since > T.focusAutopop) { hide(false); return; }
      }
      var r = anchor.getBoundingClientRect();
      if (last && (Math.abs(r.left - last.ax) > 0.5 || Math.abs(r.top - last.ay) > 0.5)) layout();
    }, T.watch);
  }
  function stopWatch() { if (watchT) { clearInterval(watchT); watchT = 0; } }

  /* --- events --- */

  function onOver(e) {
    var t = tipOf(e.target);
    if (t === hoverEl) return;
    var old = hoverEl;
    hoverEl = t;
    if (old) {
      if (suppressed === old) suppressed = null;
      if (anchor === old && mode === 'pointer') leave(false);
    }
    if (t) { if (graceT) { clearTimeout(graceT); graceT = 0; } enter(t, 'pointer'); }
  }
  function onOut(e) { if (!e.relatedTarget) onOver({ target: null }); }   // left the window

  function silence() {
    suppressed = hoverEl || anchor;
    hide(true);
    hiddenAt = 0;              // no instant hand-off after a click: the next tip waits its delay
  }
  function onDown() { silence(); }
  function onWheel() { silence(); }
  function onScroll() { if (shown || showT) silence(); }
  function onKey(e) {
    if (e.key === 'Escape') { silence(); return; }
    if (showT) { clearTimeout(showT); showT = 0; }
    hide(true);                // Tab / arrows hand the tip straight on: hiddenAt stays
  }
  function onFocus(e) {
    var t = tipOf(e.target);
    if (!t || t === suppressed || !safeMatches(e.target, ':focus-visible')) return;
    enter(t, 'focus');
  }
  function onFocusOut(e) {
    if (mode !== 'focus' || !anchor) return;
    if (anchor.contains(e.target) && !(e.relatedTarget && anchor.contains(e.relatedTarget))) leave(true);
  }
  function onBlur() { hide(true); hiddenAt = 0; anchor = null; mode = null; hoverEl = null; }
  function onVis() { if (document.hidden) { onBlur(); releaseNow(); } }
  function onResize() { if (shown && anchor) layout(); }

  /* A popover opening or closing changes the room under the tip: take it down at once. An open
     means bar.js's own call replaced the tip's room in main (never give that back). */
  function barChanged() {
    var open = popoverOpen();
    if (open !== popWas) {
      popWas = open;
      if (open) { if (relT) { clearTimeout(relT); relT = 0; } held = 0; }
      var a = anchor, m = mode;
      hide(true);
      hiddenAt = 0;
      anchor = null; mode = null;
      if (a && m && a.isConnected && a !== suppressed && (m === 'focus' || a === hoverEl)) enter(a, m);
    }
    var up = !(room && room.away());
    if (up !== upWas) {
      upWas = up;
      if (!up) { hide(true); anchor = null; mode = null; releaseNow(); }
      // Up again with the pointer already resting on something (the reveal came from that very
      // hover, live 2026-09-24): its delay may have run out while the pill was away, so start it again.
      else if (anchor && !shown && !showT && anchor !== suppressed && (mode === 'focus' || safeMatches(anchor, ':hover'))) {
        showT = setTimeout(function () { showNow(false); }, T.delay);
      }
    }
  }

  function on(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    listeners.push([target, type, fn, opts]);
  }

  function install(opts) {
    if (installed) return api;
    var o = opts || {};
    installed = true;
    room = (o.room === undefined ? SCRIPT_ROOM : o.room) === 'bar' ? barRoom() : null;
    tip = document.getElementById(TIP_ID) || document.createElement('div');
    tip.id = TIP_ID;
    tip.className = 'mtip';
    tip.setAttribute('role', 'tooltip');
    if (!tip.isConnected) document.body.appendChild(tip);

    on(document, 'pointerover', onOver, true);
    on(document, 'pointerout', onOut, true);
    on(window, 'pointerdown', onDown, true);
    on(window, 'wheel', onWheel, { capture: true, passive: true });
    on(document, 'scroll', onScroll, { capture: true, passive: true });
    on(window, 'keydown', onKey, true);
    on(document, 'focusin', onFocus, true);
    on(document, 'focusout', onFocusOut, true);
    on(window, 'blur', onBlur, false);
    on(document, 'visibilitychange', onVis, false);
    on(window, 'resize', onResize, false);
    // dark glass: the bar's pop-up pictures (one per room asked) and a theme switch
    if (room && window.mantle && typeof window.mantle.on === 'function') {
      try { glassOff = window.mantle.on('bar.popbackdrop', onPopBackdrop); } catch (e) { glass.why = 'no bar.popbackdrop: ' + msgOf(e); }
    }
    on(window, 'mantle-theme', function () { if (!dark()) dropGlass('light'); else if (shown) paintGlass(); }, false);

    // A title written back as an ATTRIBUTE (setAttribute, innerHTML, a clone) on an adopted
    // element: take it again, so the native tooltip stays gone and the tip shows the new words.
    moTitle = new MutationObserver(function (recs) {
      var touched = false;
      for (var i = 0; i < recs.length; i++) {
        var t = recs[i].target;
        if (t.nodeType !== 1 || !t.hasAttribute('title')) continue;
        if (own.call(t, 'title') || t === anchor) { adopt(t); if (t === anchor) touched = true; }
      }
      if (touched) refresh();
    });
    moTitle.observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['title'] });

    if (room) {
      popWas = popoverOpen();
      upWas = !room.away();
      moBar = new MutationObserver(barChanged);
      moBar.observe(document.body, { attributes: true, attributeFilter: ['class', 'data-edge'] });
      var p = document.getElementById('pop');
      if (p) moBar.observe(p, { attributes: true, attributeFilter: ['hidden'] });
    }
    return api;
  }

  function uninstall() {
    if (!installed) return;
    hide(true);
    if (relT) { clearTimeout(relT); relT = 0; }
    if (held && room && !popoverOpen()) { try { Promise.resolve(room.give()).catch(function () {}); } catch (_) { /* gone */ } }
    held = 0;
    listeners.forEach(function (l) { l[0].removeEventListener(l[1], l[2], l[3]); });
    listeners = [];
    if (moTitle) moTitle.disconnect();
    if (moBar) moBar.disconnect();
    if (typeof glassOff === 'function') { try { glassOff(); } catch (_) { /* the bridge is gone */ } }
    glassOff = null;
    dropGlass('uninstalled');
    moTitle = moBar = null;
    unDescribe();
    installed = false;
    var all = document.querySelectorAll('[' + ATTR + ']');
    for (var i = 0; i < all.length; i++) restoreOne(all[i]);
    if (tip && tip.parentNode) tip.parentNode.removeChild(tip);
    tip = null; anchor = null; mode = null; hoverEl = null; suppressed = null; built = null; room = null;
  }

  function state() {
    var n = anchor;
    return {
      installed: installed, shown: shown, mode: mode,
      anchor: n ? (n.id ? '#' + n.id : n.tagName.toLowerCase() + (n.className && typeof n.className === 'string' ? '.' + n.className.split(/\s+/).join('.') : '')) : null,
      text: n ? textOf(n) : '', held: held, note: roomNote, lastError: lastErr,
      box: shown && last ? { x: last.x, y: last.y, w: last.w, h: last.h, side: last.side, need: last.need, covers: last.covers } : null,
      room: room ? 'bar' : null,
      glass: { on: !!glass.sig, key: glass.key, why: glass.why, bakes: glass.bakes, ms: glass.ms, held: !!glass.holdT }
    };
  }

  api.install = install;
  api.uninstall = uninstall;
  api.state = state;
  window.MantleTips = api;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { install(); });
  else install();
})();
