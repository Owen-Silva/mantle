/* bar.js — the Mantle bar's behaviour.
 *
 * Plain browser script on purpose: the renderer runs with contextIsolation on and sandbox on,
 * so there is no require(), no import, no Node. `window.mantle` (installed by lane B's preload,
 * or by mock-mantle.js when this page is opened outside Electron) is the ONLY way out of here.
 *
 * THE SHAPE (Owen, 2026-09-21): the bar is HIDDEN at rest. He pushes the mouse to the bottom of
 * the screen, main shows the window and sends 'bar.reveal', and the glass detaches into view:
 * pinned app icons centred on the screen, the readouts on the right.
 *
 * WHO ANIMATES WHAT (rewritten the same day, after "when the taskbar expands out it isn't that
 * smooth"): main decides WHEN and shows the window ONCE, already at its final rect — it no longer
 * resizes anything per frame, which is what wasn't smooth. THIS PAGE animates the pill: transform
 * and width on .bar plus the paint (fill, border, shadow, ink, opacity), all on main's duration
 * and Northwind's curve, driven by one class. The page also reports hover back, so main knows when to
 * take the bar away again.
 *
 * Three rules shape almost every decision below:
 *
 * 1. NOTHING FAILS SILENTLY. Every call that can reject or reply {ok:false}, and every State
 *    piece that is not ok, ends up as a chip in the state strip with a short label and the reason
 *    in its tooltip. A console line does not count — Owen will never have devtools open on his
 *    taskbar.
 *
 * 2. IDLE COST ~0. This page is alive every waking hour. There is exactly ONE timer at rest: the
 *    clock, a chained setTimeout aligned to the minute boundary (not setInterval, which drifts and
 *    would fire while the machine is asleep). Everything else is event-driven: bridge pushes,
 *    pointer events, a ResizeObserver. The reveal is a transition on ONE element, and it only
 *    runs on a state change — between states nothing is animating at all.
 *
 * 3. THE DOM IS DIFFED, NEVER REBUILT. App cells are keyed by item id, so a push that changes one
 *    window title does not re-create an <img> — a rebuild costs a relayout and makes icons blink.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var el = {
    body: document.body,
    bar: $('bar'), start: $('start'), dock: $('dock'),
    backdrop: $('backdrop'), bdrop: document.querySelector('.bdrop'),
    left: document.querySelector('.left'), right: document.querySelector('.right'),
    chips: $('chips'), tray: $('tray'),
    volume: $('volume'), network: $('network'), battery: $('battery'), clock: $('clock'),
    more: $('more'), pop: $('pop')
  };
  var clkT = el.clock.querySelector('.t');
  var clkD = el.clock.querySelector('.d');

  /* ================================================================= the bridge */

  var mantle = window.mantle || null;

  /* call(): always returns a promise, even when the bridge is missing or throws synchronously,
     so no caller has to special-case "there is no bridge" — the rejection carries the reason
     and the reason lands on screen. */
  function call(channel, payload) {
    if (!mantle || typeof mantle.call !== 'function')
      return Promise.reject(new Error('window.mantle is not present (preload did not run)'));
    try {
      var p = mantle.call(channel, payload);
      return (p && typeof p.then === 'function') ? p : Promise.resolve(p);
    } catch (e) { return Promise.reject(e); }
  }

  /* callR(): the {ok, reason, …} envelope lane A replies with. An ok:false is a FAILURE with a
     reason attached, so it is turned into a rejection here and travels the same path as a thrown
     one — one failure path, one place that can forget to report. Channels that still reply with a
     bare object (state.get, sys.stats, volume.get) pass straight through untouched. */
  function callR(channel, payload) {
    return call(channel, payload).then(function (r) {
      if (r && typeof r === 'object' && r.ok === false)
        throw new Error(r.reason || channel + ' replied ok:false and gave no reason');
      return r || {};
    });
  }

  /* on(): subscribe, and if that is impossible SAY WHY. onFail lets a caller report the failure
     in its own words (the tray already owns a chip of its own, so it must not get a second one). */
  function on(channel, cb, onFail) {
    function broke(reason) {
      if (onFail) onFail(reason);
      else fail('chan:' + channel, channel + ' off', reason, 'warn');
    }
    if (!mantle || typeof mantle.on !== 'function') {
      broke('window.mantle.on is not available, so "' + channel + '" never updates');
      return function () {};
    }
    try { return mantle.on(channel, cb) || function () {}; }
    catch (e) {
      broke('subscribing to "' + channel + '" threw: ' + msg(e));
      return function () {};
    }
  }

  function msg(e) { return (e && (e.message || e.reason || e.toString())) || 'no reason given'; }

  /* ================================================================= status chips */

  /* failures: things that went wrong at runtime. state: the shell's own health report.
     Both feed one strip; chips are the bar's way of talking. */
  var failures = Object.create(null);
  var state = null;

  function fail(key, label, reason, tone) {
    /* Re-reporting the SAME failure is a no-op. layoutDock() can raise the clipping failure on
       every resize frame, and renderChips() calls layoutDock() — without this guard that is a
       console flood and a re-entrant render loop. */
    var was = failures[key];
    if (was && was.label === label && was.reason === reason && was.tone === (tone || '')) return;
    failures[key] = { key: key, label: label, reason: reason, tone: tone || '' };
    console.warn('[bar]', label, '—', reason);
    renderChips();
  }
  function clearFail(key) {
    if (failures[key]) { delete failures[key]; renderChips(); }
  }

  function chipData() {
    var out = [], k;
    for (k in failures) out.push(failures[k]);
    /* A dead bridge explains every other failure on the strip, so it reads first. */
    out.sort(function (a, b) { return (a.key === 'bridge' ? 0 : 1) - (b.key === 'bridge' ? 0 : 1); });
    if (state) {
      // Contract: state.sidecar.status is 'ok' | 'starting' | 'down' (main session, 2026-09-21).
      if (state.sidecar && state.sidecar.status && state.sidecar.status !== 'ok')
        out.push({ label: 'sidecar ' + state.sidecar.status, reason: state.sidecar.reason || 'the sidecar is not running and no reason was given', tone: state.sidecar.status === 'down' ? 'warn' : '' });
      // The taskbar only matters in live mode: in test mode Mantle deliberately leaves it alone.
      if (state.mode === 'live' && state.taskbar && state.taskbar.hidden === false)
        out.push({ label: 'taskbar showing', reason: state.taskbar.reason || 'the Windows taskbar could not be hidden and no reason was given', tone: '' });
      if (state.desktop && state.desktop.attached === false)
        out.push({ label: 'desktop off', reason: state.desktop.reason || 'the desktop layer is not attached and no reason was given', tone: '' });
      if (state.hotkey && state.hotkey.winTap === false)
        out.push({ label: 'hotkey off', reason: state.hotkey.reason || 'the global hotkey is not registered and no reason was given', tone: '' });
      /* bar:{mode, revealed, reason} — lane A's own report about the reveal machinery. A reason
         at all means something is off (the edge watcher could not start, the bar is pinned open
         because a popover is up, …), so it is shown whatever `mode` says. */
      if (state.bar && state.bar.reason && state.bar.ok === false)   // main narrates healthy states too; only a not-ok reason is a chip
        out.push({ label: 'bar ' + (state.bar.mode || 'mode?'), reason: state.bar.reason, tone: '' });
      /* tray:{watch, reason} — watch:false means tray changes are not being followed, so what is
         drawn is a snapshot that will silently go stale. Suppressed when the tray is already
         saying it is unavailable in its own chip: one problem, one chip. */
      if (state.tray && state.tray.watch === false && !(state.tray.status === 'unavailable' || trayThrew))
        out.push({ label: 'tray watch off', reason: state.tray.reason || 'tray changes are not being watched and no reason was given', tone: '' });
    }
    return out;
  }

  var chipSig = null;
  function renderChips() {
    var data = chipData();
    var sig = data.map(function (c) { return c.tone + '|' + c.label + '|' + c.reason; }).join('\u0001');
    if (sig === chipSig) return;     // nothing changed: do not touch the DOM (and do not retrigger layout)
    chipSig = sig;
    el.chips.textContent = '';
    data.forEach(function (c) {
      var n = document.createElement('div');
      // the bridge chip carries a message, not a label, so it gets more room before the ellipsis
      n.className = 'chip' + (c.tone ? ' ' + c.tone : '') + (c.key === 'bridge' ? ' wide' : '');
      n.title = c.label + ' — ' + c.reason;   // pill mode hides the label (pip only): the tooltip carries it
      var pip = document.createElement('span'); pip.className = 'pip';
      var lbl = document.createElement('span'); lbl.className = 'lbl'; lbl.textContent = c.label;
      n.appendChild(pip); n.appendChild(lbl);
      el.chips.appendChild(n);
    });
    layoutDock();      // the strip just changed width, so the centred dock may have less room
  }

  /* ================================================================= reveal / hide */

  /* THE DIVISION OF LABOUR: main animates the WINDOW (it slides it up from under the screen, and
     in pill mode grows its width and rounds its corners). This page animates PAINT ONLY, over
     main's own duration and Northwind's curve, so the glass detaches as the window arrives instead of
     racing it. Before the first event the page paints in the flush (fully transparent) state with
     no transition at all — body.pre, set in index.html. */
  var revealed = false, gotFirstEvent = false, barMode = 'edge';

  var DUR_IN = 560, DUR_OUT = 260;    // Northwind's --dur-nav in; out is quicker, and must beat main's window drop
  var OUT_MAX = 300;                  // main hides the window ~350ms after the event: never animate past that
  var lastEventAt = 0;                // when main last told us to move, so a stale state push cannot fight it

  /* The shape is main's call: 'pill' floats the window off the edge, 'edge' keeps it docked.
     Anything else (or nothing) is edge — the docked shape is the safe one, because a pill radius
     on a full-width window would round corners the window itself has left square. */
  function setMode(mode) {
    var m = (mode === 'pill') ? 'pill' : 'edge';
    if (m === barMode && el.body.classList.contains(m)) return;
    barMode = m;
    el.body.classList.toggle('pill', m === 'pill');
    el.body.classList.toggle('edge', m !== 'pill');
  }

  function slide(on, why, mode, ms) {
    if (mode) setMode(mode);
    /* Main tells us how long it is taking; the page must not out-run or lag the window. In goes at
       Northwind's 560ms. Out is capped at OUT_MAX whatever main asks for, because main drops the window
       ~350ms after the event and an exit the window cuts off is the snap we are fixing. The two
       durations live in SEPARATE variables so neither write can land on the wrong state: bar.css
       picks --lg-dur under body.up and --lg-dur-out without it, so the exit has a real duration
       even if this line never ran. */
    var d = (typeof ms === 'number' && ms > 0) ? Math.round(ms) : (on ? DUR_IN : DUR_OUT);
    if (!on) d = Math.max(140, Math.min(d, OUT_MAX));
    el.body.style.setProperty(on ? '--lg-dur' : '--lg-dur-out', d + 'ms');

    if (!gotFirstEvent) {
      gotFirstEvent = true;
      el.body.classList.remove('pre');
      void el.bar.offsetWidth;        // commit the flush paint before the class flips, or there is no transition to run
    }

    /* The CLASS is the truth, not the flag. They used to be able to drift — a state push could set
       revealed=false while body.up was still on, and the real bar.hide would then early-return and
       never remove it: the pill stayed up until main dropped the window out from under it. That is
       exactly the reported bug. Now the class is always reconciled, and only the side effects are
       skipped when nothing actually moved. */
    var wasUp = el.body.classList.contains('up');
    revealed = on;
    if (wasUp === on) {
      /* A reveal while we are already up means main hid the window under us and is showing it
         again: rewind to the down state with transitions off, then let the entry play from there.
         Anything else here is a genuine no-op. */
      if (on) {
        el.body.classList.add('pre');
        el.body.classList.remove('up');
        void el.bar.offsetWidth;      // commit the down state un-transitioned
        el.body.classList.remove('pre');
        void el.bar.offsetWidth;      // and commit the transitions being back on, before .up returns
        el.body.classList.add('up');
        cancelClearBackdrop();
        refreshPinned();
        console.log('[bar] re-reveal (re-armed)', barMode, d + 'ms', '—', (why || 'no reason given'));
      }
      return;
    }
    el.body.classList.toggle('up', on);
    if (!on) {
      closePop();
      scheduleClearBackdrop(d);       // the strip is a photograph of a screen about to change — but not yet
    } else {
      cancelClearBackdrop();          // a reveal mid-exit: the pill never left, so nothing is stale
      refreshPinned();                // the icons are only ever looked at while the bar is up
    }
    clockGear();                      // seconds while it is up, minutes while it is not
    console.log('[bar]', on ? 'reveal' : 'hide', barMode, d + 'ms', '—', (why || 'no reason given'));
  }

  /* ================================================================= the backdrop

     The bar blurs its own backdrop, because nothing else could: DWM acrylic renders a near-opaque
     white slab and DWM blur-behind a black one, and neither is tunable. Main photographs the
     screen strip behind the bar (downscaled 4x) about four times a second while the bar is up —
     never during the morph, never while hidden — and this swaps the <img> src. That is the whole
     update: no layout, no reflow, one composited layer repainted.

     body.no-backdrop is the honest fallback state: it thickens the tint so the bar is still a
     readable pane when there is nothing blurred underneath. It is on at boot, off from the first
     strip, and back on the moment the bar hides (the strip is of a screen that is about to be
     wrong; showing it again on the next reveal would flash a stale photograph of the desktop). */
  var haveBackdrop = false;

  function setBackdrop(p) {
    if (!p || typeof p.png !== 'string' || p.png.slice(0, 5) !== 'data:') {
      fail('backdrop', 'no blur', 'bar.backdrop arrived without a png data URL, so the bar cannot' +
        ' blur what is behind it and is showing a thicker tint instead' +
        (p && p.reason ? ': ' + p.reason : ''));
      return;
    }
    clearFail('backdrop');
    el.backdrop.src = p.png;                 // the ONLY per-frame work: a src swap
    if (!haveBackdrop) {
      haveBackdrop = true;
      el.body.classList.remove('no-backdrop');
      el.bdrop.classList.add('on');          // 150ms fade, once, on the first strip after a reveal
    }
  }

  /* The clear has to wait for the pill to be GONE. Clearing it the moment 'bar.hide' arrives
     drops the blurred strip out from under a pill that is still on screen, and the glass flashes
     to the flat fallback fill on its way down. So: on the transform's transitionend, or on a
     timer main's own duration long, whichever comes first — and cancelled outright if a reveal
     arrives mid-exit, because then the pill never left. */
  var clearTimer = 0, clearOnEnd = null;

  function cancelClearBackdrop() {
    if (clearTimer) { clearTimeout(clearTimer); clearTimer = 0; }
    if (clearOnEnd) { el.bar.removeEventListener('transitionend', clearOnEnd); clearOnEnd = null; }
  }

  function scheduleClearBackdrop(ms) {
    cancelClearBackdrop();
    function done() { cancelClearBackdrop(); clearBackdrop(); }
    clearOnEnd = function (ev) {
      if (ev.target === el.bar && ev.propertyName === 'transform') done();
    };
    el.bar.addEventListener('transitionend', clearOnEnd);
    clearTimer = setTimeout(done, (ms || DUR_OUT) + 20);   // the belt to transitionend's braces
  }

  function clearBackdrop() {
    haveBackdrop = false;
    el.bdrop.classList.remove('on');
    /* removeAttribute, never src='': an empty src re-requests the PAGE in some engines. With no
       src at all the <img> draws nothing, which is what a hidden bar should hold. */
    el.backdrop.removeAttribute('src');
    el.body.classList.add('no-backdrop');
  }

  /* Hover is the signal main hides on: it cannot see the pointer inside this window. */
  var pointerIn = false;
  function hover(inside) {
    callR('bar.hover', { inside: inside }).then(function () { clearFail('hover'); }, function (e) {
      fail('hover', 'hover off', 'bar.hover was refused, so the bar may not hide itself: ' + msg(e), 'warn');
    });
  }
  el.bar.addEventListener('mouseenter', function () { pointerIn = true; hover(true); });
  el.bar.addEventListener('mouseleave', function () {
    pointerIn = false;
    /* A popover floats 7px ABOVE the bar, so reaching it crosses a gap that is not inside .bar.
       Reporting "outside" there would let main hide the bar out from under the pointer, so while
       a popover is open the bar counts as in use; closePop() reports the truth again. */
    if (popKey) return;
    hover(false);
  });

  /* ================================================================= the app dock */

  var cells = Object.create(null);     // id -> cell element, so updates reuse the DOM
  var items = [];                      // the last items[] as given, for the per-window popover
  var divEl = document.createElement('span');
  divEl.className = 'div';
  divEl.setAttribute('aria-hidden', 'true');

  function letterOf(name) {
    var t = (name || '').replace(/^[^\p{L}\p{N}]+/u, '');
    return (t.charAt(0) || '?').toUpperCase();
  }

  function winsOf(it) { return Array.isArray(it && it.windows) ? it.windows : []; }
  /* A minimized window is never the active one, whatever the flat list says: Windows leaves the
     foreground flag on a window it has just minimized for a frame or two, and a bar that lights
     the accent for a window you cannot see is lying. */
  function isActive(w) { return !!(w && (w.active || w.foreground) && !w.minimized); }

  function makeCell(key) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'cell';
    b.dataset.key = key;
    var ico = document.createElement('span'); ico.className = 'ico';
    var ind = document.createElement('span'); ind.className = 'ind';   // the running line, see bar.css
    b.appendChild(ico); b.appendChild(ind);
    return b;
  }

  function paintInd(b, wins) {
    var run = wins.length > 0;
    var act = false;
    for (var i = 0; i < wins.length; i++) if (isActive(wins[i])) { act = true; break; }
    if (b.classList.contains('run') !== run) b.classList.toggle('run', run);
    if (b.classList.contains('act') !== (run && act)) b.classList.toggle('act', run && act);
  }

  function updateCell(b, it) {
    var name = it.name || it.exe || it.id || 'app';
    var wins = winsOf(it);
    b.dataset.id = String(it.id == null ? '' : it.id);

    /* "<name> — N windows", then anything that needs explaining, then what the other two buttons
       do. The middle-click line is shown for PINS only, because "new window" is what a pin means;
       a running-only entry has no launcher behind it to start a second instance from. */
    var tip = name + (wins.length ? ' — ' + wins.length + (wins.length === 1 ? ' window' : ' windows') : '');
    /* An icon that is missing must say WHY on the item itself: a blank tile with no explanation is
       the silent failure this shell refuses. */
    if (!it.icon) tip += '\n(no icon: ' + (it.iconReason || 'the sidecar gave no reason') + ')';
    if (wins.length > 1) tip += '\n(right-click: the window list)';
    if (it.kind === 'pinned') tip += '\n(middle-click: new window)';
    if (b.title !== tip) { b.title = tip; b.setAttribute('aria-label', name); }

    var ico = b.firstChild;
    var want = it.icon || '';
    /* The comparison key lives on a JS property, NOT in a data-attribute: a real Windows icon is
       several KB of base64 and writing it into the DOM as an attribute would put every icon in
       the document twice. */
    if (ico._src !== want) {
      ico._src = want;
      ico.textContent = '';
      if (want) {
        ico.className = 'ico';
        var img = document.createElement('img');
        img.alt = '';
        /* A broken data URL would otherwise leave an empty square: fall back to the letter tile
           and say so in the tooltip rather than showing a hole. */
        img.onerror = function () {
          ico.className = 'ico tile';
          ico.textContent = letterOf(name);
          b.title = name + '\n(icon failed to decode)';
        };
        img.src = want;
        ico.appendChild(img);
      } else {
        ico.className = 'ico tile';
        ico.textContent = letterOf(name);
      }
    }
    paintInd(b, wins);
  }

  /* place(): put `node` right after `prev`, and only touch the DOM when it is not already there. */
  function place(node, prev) {
    var should = prev ? prev.nextSibling : el.dock.firstChild;
    if (node !== should) el.dock.insertBefore(node, should);
    return node;
  }

  function renderDock(res) {
    if (!res || typeof res !== 'object') {
      fail('pinned', 'apps off', 'bar.pinned replied ' + (res === null ? 'null' : typeof res) + ' instead of {ok, reason, items}', 'warn');
      return;
    }
    if (!Array.isArray(res.items)) {
      fail('pinned', 'apps off', (res.ok === false ? (res.reason || 'bar.pinned replied ok:false and gave no reason')
        : 'bar.pinned replied without an items array (got ' + typeof res.items + ')'), 'warn');
      return;
    }
    /* PARTIAL IS NOT OFF. At startup the sidecar is still coming up, so the first reply is
       ok:false — "the running apps could not be read: … waiting for its ready line" — while
       already carrying the pinned items. Throwing those away and showing "apps off" was wrong
       twice over: it hid icons the reply had handed us, and it put a chip in the right cluster
       that ate the space the dock measures against. So render whatever arrived, and say only
       that it is incomplete; the next complete reply clears it. */
    if (res.ok === false && res.items.length) {
      fail('pinned', 'apps partial', res.reason || 'bar.pinned replied ok:false and gave no reason — showing what it did send');
    } else if (res.ok === false) {
      fail('pinned', 'apps off', res.reason || 'bar.pinned replied ok:false and gave no reason', 'warn');
      return;
    } else {
      clearFail('pinned');
    }
    items = res.items;

    var seen = Object.create(null), prev = null, divPlaced = false;
    items.forEach(function (it, i) {
      /* The key is the item id, which is what keeps an icon's DOM node (and its decoded bitmap)
         alive across pushes. A duplicate id would otherwise collapse two apps into one cell, so
         it is disambiguated rather than dropped. */
      var key = String(it.id != null ? it.id : (it.exe || 'item' + i));
      if (seen[key]) key = key + '\u0001' + i;
      seen[key] = true;

      // running-but-unpinned apps sit after a hairline, exactly like Windows' overflow of them
      if (it.kind === 'running' && !divPlaced && prev) { prev = place(divEl, prev); divPlaced = true; }

      var b = cells[key] || (cells[key] = makeCell(key));
      b._item = it;
      updateCell(b, it);
      prev = place(b, prev);
    });

    if (!divPlaced && divEl.parentNode) divEl.parentNode.removeChild(divEl);
    Object.keys(cells).forEach(function (key) {
      if (!seen[key]) {
        var b = cells[key];
        if (b.parentNode) b.parentNode.removeChild(b);
        delete cells[key];
      }
    });

    // the app whose windows are listed has gone away: its popover would be lying
    if (popKey && popKey.indexOf('app:') === 0 && !cells[popKey.slice(4)]) closePop();

    layoutDock();
  }

  var pinInFlight = false;
  function refreshPinned() {
    if (pinInFlight) return;
    pinInFlight = true;
    call('bar.pinned').then(function (r) { pinInFlight = false; renderDock(r); },
      function (e) {
        pinInFlight = false;
        fail('pinned', 'apps off', 'bar.pinned was refused, so there are no icons to show: ' + msg(e), 'warn');
      });
  }

  /* ---------------------------------------------------------------- dock sizing

     The dock is centred on the WINDOW, so the space it may use is the SYMMETRIC space: twice the
     distance from the centre to whichever cluster is nearer. It has to be told that number,
     because an absolutely centred row has no idea the clock exists.

     This is the code that emptied the bar live (2026-09-21): during a pill morph the sidecar
     resizes the window every ~16ms for 560ms, and a frame measured while the window was still
     narrow put the right cluster LEFT of the centre, which makes the symmetric room 0 — and a
     0px cap on an overflow:hidden row is a dock with nothing in it. Worse, raising the "apps
     clipped" chip to explain it made the right cluster wider, which made the room smaller, which
     changed the numbers, which re-rendered the chip: 136px → 0px → 355px → 0px, for ever.

     So: measure on every resize (the dock must track the window), measure ONCE MORE 50ms after
     the last one (that is the only measurement allowed to decide anything), never cap below one
     cell, and never cap at all while the icons fit. The decision is keyed to window width + how
     much the icons need, so the chip the decision produces cannot feed back into the decision. */

  /* CELL/GAP/DIV must match --cell, --cell-gap and .dock .div in bar.css. They are duplicated
     here rather than read back with getComputedStyle because this runs on every resize frame. */
  var CELL = 36, GAP = 6, DIV = 7;
  var settleTimer = 0, lastKey = '', frozen = { cap: 'none', shift: 0, hidden: 0 };

  /* THE FIT RULE, rebuilt 2026-09-21 after build 20 cut Riot in half and dropped Comet. The old
     rule measured the SYMMETRIC room (twice the distance to the nearer cluster) and clipped when
     the icons did not fit inside it. That throws away half the bar: with a wide right cluster —
     and the seconds clock made it wider — the symmetric room is small while the actual free span
     is nearly the whole bar. Windows 11 does not do that. It keeps the icons centred while they
     fit, and SLIDES them when they do not.

     So: centred on the bar's centre while that sits inside the free span; otherwise shifted by the
     MINIMUM that brings it inside; clipped only when the icons cannot fit in the whole span, and
     only then does a chip appear — saying how many are hidden. Owen: "i want to be able to see all
     my pinned stuff not just some of them". */
  function measure() {
    /* VIEWPORT coordinates, off the bar's own rect. Nothing here may assume the bar spans the
       screen: in pill mode the window IS the island, inset from the edges and far narrower than
       the display, and the centre of the icons is the centre of THAT window. */
    var r = el.bar.getBoundingClientRect();
    if (!r.width) return null;
    var leftEnd = el.left ? el.left.getBoundingClientRect().right : r.left + 8;
    /* The chip strip is NOT part of the wall the dock measures against: chips are the bar talking
       about problems, and the "apps clipped" chip was widening the very cluster it measured
       (a 136 -> 0 -> 355 px loop, live 2026-09-21). The wall is the first real control. */
    var tray = $('tray'), vol = $('volume');
    var anchor = (tray && tray.getBoundingClientRect().width > 0) ? tray : (vol || el.right);
    var rightStart = anchor ? anchor.getBoundingClientRect().left : r.right - 8;
    var spanL = leftEnd + 8, spanR = rightStart - 8;
    return {
      w: Math.round(r.width),
      centre: r.left + r.width / 2,
      spanL: spanL,
      spanR: spanR,
      span: Math.max(0, spanR - spanL)
    };
  }

  function needWidth() {
    var n = items.length;
    return n ? n * CELL + (n - 1) * GAP + (divEl.parentNode ? DIV : 0) : 0;
  }

  /* How many cells actually survive a given width, so the chip can say how many are hidden rather
     than just that some are. The divider counts as part of the first running item. */
  function fitCount(width) {
    var used = 0, n = 0;
    for (var i = 0; i < items.length; i++) {
      var add = (i ? GAP : 0) + CELL + (items[i].kind === 'running' && i > 0 && items[i - 1].kind !== 'running' ? DIV : 0);
      if (used + add > width) break;
      used += add; n++;
    }
    return n;
  }

  /* decide(): the whole rule in one pure function of (measurement, need). Returns the cap, the
     shift off centre, and how many icons are lost — nothing here touches the DOM. */
  function decide(m, need) {
    if (!need) return { cap: 'none', shift: 0, hidden: 0 };
    if (need <= m.span) {
      var l = m.centre - need / 2, r = m.centre + need / 2;
      var shift = 0;
      if (l < m.spanL) shift = m.spanL - l;          // pushed right, off the launcher
      else if (r > m.spanR) shift = m.spanR - r;     // pushed left, off the clock (the usual one)
      return { cap: 'none', shift: shift, hidden: 0 };
    }
    /* Genuinely too many: fill the span from its left edge and say what was lost. */
    return {
      cap: Math.max(Math.round(m.span), CELL) + 'px',
      shift: m.spanL - (m.centre - Math.max(m.span, CELL) / 2),
      hidden: Math.max(1, items.length - fitCount(m.span))
    };
  }

  function applyDock(d) {
    el.dock.style.setProperty('--dock-max', d.cap);
    el.dock.style.setProperty('--dock-shift', Math.round(d.shift) + 'px');
  }

  function layoutDock() {
    var m = measure();
    if (!m) return;
    var need = needWidth();
    var key = m.w + ':' + need;
    /* Already settled at this width with this many icons? Then this resize is something INSIDE
       the bar changing width — our own chip, a new tray icon — and the settled answer stands. */
    applyDock(key === lastKey ? frozen : decide(m, need));
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(settleDock, 50);
  }

  function settleDock() {
    settleTimer = 0;
    var m = measure();
    if (!m) return;
    var need = needWidth();
    var key = m.w + ':' + need;
    if (key !== lastKey) {
      lastKey = key;
      frozen = decide(m, need);
      // Only while the bar is up: parked (hidden) the window sits at its narrow start width, and a
      // report from there is a false alarm (seen live as "507px in a 695px bar" on every hide).
      if (revealed && frozen.hidden)
        fail('dockclip', frozen.hidden + ' app' + (frozen.hidden === 1 ? '' : 's') + ' hidden',
          items.length + ' app icons need ' + need + 'px and the free span between the launcher and' +
          ' the readouts is only ' + Math.round(m.span) + 'px in a ' + m.w + 'px bar, so the last ' +
          frozen.hidden + ' cannot be shown');
      else clearFail('dockclip');
    }
    applyDock(frozen);
  }

  /* act(): fire a bridge call for a click and, if it fails, put the reason in the bar.
     Every user action goes through here, so no click can ever do nothing without saying why. */
  function act(channel, payload, what) {
    return callR(channel, payload).then(function (r) { clearFail('act'); return r; }, function (e) {
      fail('act', (what || channel.split('.')[0]) + ' failed', channel + ' was refused: ' + msg(e), 'warn');
    });
  }

  /* THE WINDOW LIST, and one function for it: the right-click opens it directly, and a left click
     opens it when main replies action:'list'. Two callers, one popover \u2014 if they were built
     separately they would drift, and a taskbar where the two ways of reaching the same list look
     different is worse than one that only has one way. */
  function cellOf(ev) { return ev.target.closest ? ev.target.closest('.cell') : null; }
  function popKeyOf(b) { return 'app:' + b.dataset.key; }

  function openAppPop(b, it) {
    if (!it || !winsOf(it).length) return;       // nothing to list; the click itself was the action
    openPop(popKeyOf(b), b, function (pop) { buildAppPop(pop, it); });
  }

  /* LEFT CLICK = Windows 11's own semantics, and main decides which one applies: focus a window,
     minimize the one that is already focused, launch the app if it is not running \u2014 or, when
     there are two or more windows, hand the decision back with action:'list', because only the
     renderer can put a popover under the icon that was clicked. */
  el.dock.addEventListener('click', function (ev) {
    var b = cellOf(ev);
    if (!b) return;
    /* Clicking the icon whose list is already open just closes it (closePop() below clears popKey,
       so the toggle has to be read first). */
    var wasOpen = (popKey === popKeyOf(b));
    closePop();
    if (wasOpen) return;
    act('bar.open', { id: b.dataset.id }, 'open').then(function (r) {
      if (r && r.action === 'list') openAppPop(b, b._item);
    });
  });

  /* MIDDLE CLICK = a new instance, the way Windows has always done it. mousedown must be
     swallowed too, or Chromium starts its autoscroll on the way through. */
  el.dock.addEventListener('mousedown', function (ev) { if (ev.button === 1) ev.preventDefault(); });
  el.dock.addEventListener('auxclick', function (ev) {
    if (ev.button !== 1) return;
    var b = cellOf(ev);
    if (!b) return;
    ev.preventDefault();
    closePop();
    act('bar.open', { id: b.dataset.id, fresh: true }, 'open');
  });

  /* RIGHT CLICK = the list, always, whatever main would have done with a left click. */
  el.dock.addEventListener('contextmenu', function (ev) {
    var b = cellOf(ev);
    if (!b) return;
    ev.preventDefault();
    openAppPop(b, b._item);
  });

  function buildAppPop(pop, it) {
    var h = document.createElement('h3');
    h.textContent = it.name || it.exe || 'windows';
    pop.appendChild(h);
    winsOf(it).forEach(function (w) {
      var title = w.title || '(untitled window)';
      var row = document.createElement('div'); row.className = 'wrow';
      var open = document.createElement('button');
      open.type = 'button';
      /* .on carries the accent bar (the active window); .min mutes a minimized one to --lg-ink-3,
         so the list reads at a glance the way the taskbar itself does. */
      open.className = 'item' + (isActive(w) ? ' on' : '') + (w.minimized ? ' min' : '');
      open.textContent = title;
      open.title = title + (w.minimized ? '\n(minimized)' : '');
      open.addEventListener('click', function () {
        closePop();
        act('bar.window', { hwnd: w.hwnd, action: isActive(w) ? 'toggle' : 'focus' }, 'window');
      });
      var x = document.createElement('button');
      x.type = 'button'; x.className = 'x'; x.title = 'Close this window'; x.textContent = '\u00d7';
      x.addEventListener('click', function () {
        closePop();
        act('bar.window', { hwnd: w.hwnd, action: 'close' }, 'window');
      });
      row.appendChild(open); row.appendChild(x);
      pop.appendChild(row);
    });
  }

  if (window.ResizeObserver) {
    var ro = new ResizeObserver(layoutDock);
    ro.observe(el.bar);
    if (el.right) ro.observe(el.right);
  } else {
    window.addEventListener('resize', layoutDock);   // older engines: still correct, just coarser
  }

  /* ================================================================= windows channel

     bar.pinned is the source of truth for WHICH apps exist; the 'windows' push is faster and is
     used for the cheap half of the job — repainting the running/active dots immediately. When the
     set of window handles actually changes, a pinned refresh is scheduled once (not per event) so
     a newly launched app appears without polling anything. */
  var hwndSig = '', refreshTimer = 0;

  function renderWindows(list) {
    if (!Array.isArray(list)) {
      fail('windows', 'windows off', 'the "windows" channel sent ' + (list === null ? 'null' : typeof list) + ' instead of an array', 'warn');
      return;
    }
    clearFail('windows');

    var active = Object.create(null), keys = [];
    list.forEach(function (w) {
      var k = String(w.hwnd);
      keys.push(k);
      if (isActive(w) && !w.minimized) active[k] = true;
    });

    items.forEach(function (it) {
      winsOf(it).forEach(function (w) { w.active = !!active[String(w.hwnd)]; });
    });
    Object.keys(cells).forEach(function (key) {
      var b = cells[key];
      if (b._item) paintInd(b, winsOf(b._item));
    });

    var sig = keys.sort().join(',');
    if (sig !== hwndSig) {
      hwndSig = sig;
      if (!refreshTimer) refreshTimer = setTimeout(function () { refreshTimer = 0; refreshPinned(); }, 300);
    }
  }

  /* ================================================================= tray */

  function renderTray(list) {
    el.tray.textContent = '';
    var unavailable = (state && state.tray && state.tray.status === 'unavailable') || trayThrew;
    if (unavailable) {
      /* Nothing on the strip: on this Windows build the notification area cannot be read at all
         (TrayNotifyWnd has no ToolbarWindow32), so a permanent chip would be noise, not news.
         The reason is still said somewhere: the overflow menu (buildMorePop) carries it. */
      layoutDock();
      return;
    }
    (list || []).forEach(function (it) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn ti';
      b.title = it.title || it.id || 'tray icon';
      if (it.icon) {
        var img = document.createElement('img'); img.alt = '';
        img.onerror = function () { b.textContent = letterOf(it.title || it.id); };
        img.src = it.icon;
        b.appendChild(img);
      } else {
        b.textContent = letterOf(it.title || it.id);
      }
      b.addEventListener('click', function () { act('tray.click', { id: it.id, button: 'left' }, 'tray'); });
      b.addEventListener('contextmenu', function (ev) { ev.preventDefault(); act('tray.click', { id: it.id, button: 'right' }, 'tray'); });
      el.tray.appendChild(b);
    });
    layoutDock();
  }
  var trayThrew = '';

  /* ================================================================= popovers */

  var popKey = null, popTimer = 0;

  function closePop() {
    if (!popKey) return;
    /* The quick-settings watch exists only for the open panel: leaving it on would have main
       pushing the whole system state at a closed popover every 2 seconds, on a bar whose entire
       point is that it costs nothing at rest. */
    if (popKey === 'qs') { qsPaint = null; qsWatch(false); }
    popKey = null;
    el.pop.hidden = true;
    el.pop.className = 'pop';          // drop any per-panel class (.cal)
    el.pop.textContent = '';
    if (popTimer) { clearTimeout(popTimer); popTimer = 0; }
    call('bar.popover', { open: false }).catch(function () {});   // shrink request; failure is reported on open, not here
    // the leave that was suppressed while the popover held the bar open (see mouseleave)
    if (!pointerIn) hover(false);
  }

  function openPop(key, anchor, build) {
    if (popKey === key) { closePop(); return; }
    closePop();
    popKey = key;
    el.pop.textContent = '';
    el.pop.hidden = false;
    build(el.pop);

    /* The bar window is only 48px tall, so a popover drawn here would be cut off by the window,
       not by CSS. Ask the main process for room. If that channel does not exist yet, SAY SO in
       the popover instead of letting it silently disappear off the edge of the window. */
    var h = el.pop.offsetHeight + 16;
    callR('bar.popover', { open: true, height: h, key: key }).catch(function (e) {
      if (popKey !== key) return;
      var note = document.createElement('div');
      note.className = 'note';
      note.textContent = 'this popover may be clipped: bar.popover — ' + msg(e);
      el.pop.appendChild(note);
    });

    /* Horizontal placement: centred under its button, clamped into the bar. */
    var a = anchor.getBoundingClientRect();
    var w = el.pop.offsetWidth;
    var left = Math.round(a.left + a.width / 2 - w / 2);
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    el.pop.style.left = left + 'px';
  }

  /* The window is focusable:false in production, so Escape may never reach us — outside click is
     the load-bearing close path and is handled on the document in the capture phase. */
  document.addEventListener('mousedown', function (ev) {
    if (!popKey) return;
    if (el.pop.contains(ev.target)) return;
    // the anchors toggle themselves, so a click on one must not also be an outside click
    if (ev.target.closest && ev.target.closest('#volume, #network, #battery, #clock, #more, .cell')) return;
    closePop();
  }, true);
  document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') closePop(); });

  /* ================================================================= volume */

  var vol = { level: null, muted: false, reason: '' };

  /* The speaker, as a string, so the bar glyph and the panel's mute button are the SAME drawing at
     the same level — two speakers that disagreed would be a bug nobody could see. */
  function volumeSvg(level, muted) {
    var waves = (level === null || muted) ? 0 : level <= 0.005 ? 0 : level <= 0.33 ? 1 : level <= 0.66 ? 2 : 3;
    var s = '<path d="M2.2 6.1h2.4L8.1 3.1v9.8L4.6 9.9H2.2z" fill="currentColor"/>';
    var arcs = ['M10 6.2a2.6 2.6 0 0 1 0 3.6', 'M11.8 4.9a5 5 0 0 1 0 6.2', 'M13.6 3.6a7.4 7.4 0 0 1 0 8.8'];
    for (var i = 0; i < waves; i++)
      s += '<path d="' + arcs[i] + '" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>';
    if (muted)
      s += '<path d="M10.2 5.6l4.6 4.8M14.8 5.6l-4.6 4.8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>';
    return svg(s);
  }

  function volumeGlyph() {
    el.volume.innerHTML = volumeSvg(vol.level, vol.muted);
    el.volume.title = (vol.level === null
      ? 'Volume unavailable — ' + (vol.reason || 'no reason given')
      : (vol.muted ? 'Muted' : 'Volume ' + Math.round(vol.level * 100) + '%')) +
      '\nClick: quick settings';
  }

  /* Volume is read fresh every time the popover opens: another app changes it constantly, and a
     cached number on a taskbar is a lie. volume.get is the channel; sys.stats.volume is accepted
     as a fallback so whichever shape lane B ships, the bar works. */
  function readVolume() {
    return call('volume.get').then(function (v) { return v; }, function (e1) {
      return call('sys.stats').then(function (s) {
        if (s && s.volume) return s.volume;
        throw new Error(msg(e1));
      });
    }).then(function (v) {
      vol.level = typeof v.level === 'number' ? v.level / 100 : null;   // the sidecar reports 0-100; vol.level is 0-1 (glyph + tooltip)
      vol.muted = !!v.muted;
      vol.reason = vol.level === null ? 'the bridge returned no level' : '';
      volumeGlyph();
      return v;
    }, function (e) {
      vol.level = null; vol.reason = msg(e);
      volumeGlyph();
      throw e;
    });
  }

  /* ================================================================= the Windows flyouts

     Two surfaces Mantle cannot replicate — the full quick-settings flyout and the notification
     centre — are still Windows', and the bar asks the shell to press the key for it. Every panel
     below keeps one of these as its escape hatch, because "Mantle does 90% of it" is only honest
     if the last 10% is one click away. A refused key press lands in the state strip. */
  function keys(combo, what) {
    callR('sys.keys', { combo: combo }).then(function () { clearFail('keys'); }, function (e) {
      fail('keys', what + ' failed', 'sys.keys ' + combo + ' was refused, so the Windows flyout did not open: ' + msg(e), 'warn');
    });
  }

  /* ================================================================= quick settings

     Owen, 2026-09-21, pointing at volume / Wi-Fi / battery / clock: "these buttons need to go to a
     wrapper version of where they used to go … some of them just go to settings now". So the three
     readouts on the right open ONE panel — Windows 11's shape, Mantle's glass — instead of three
     different fates (a slider, a settings URI, a key press).

     Everything in it is driven by qs.get / qs.set / qs.watch, and every part carries its own
     ok/reason. A part that is not ok renders MUTED with the reason in its tooltip AND as a note
     line at the bottom; it is never blank, and it never silently does nothing. A toggle in flight
     shows a pending state and is re-rendered from the reply, so a switch that did not take cannot
     stay lit. */
  var qs = null, qsBusy = Object.create(null), qsPaint = null;

  function qsPart(name) { return (qs && qs[name]) || null; }
  function partOk(p) { return !!(p && p.ok !== false); }
  function partWhy(p, what) {
    return (p && p.reason) || ('the shell gave no reason why ' + what + ' is unavailable');
  }

  function qsSnapshot() {
    return callR('qs.get').then(function (d) {
      qs = d; clearFail('qs');
      if (d && d.volume && typeof d.volume.level === 'number') {
        vol.level = typeof d.volume.level === 'number' ? d.volume.level / 100 : null; vol.muted = !!d.volume.muted; vol.reason = ''; volumeGlyph();
      }
      return d;
    }, function (e) {
      fail('qs', 'quick settings off', 'qs.get was refused, so the panel cannot read the system: ' + msg(e), 'warn');
      throw e;
    });
  }

  /* The watch is on ONLY while the panel is open: a 2s push into a closed popover is pure cost on
     a bar that is meant to be free at rest. */
  function qsWatch(on) {
    callR('qs.watch', { on: !!on }).then(function () { clearFail('qswatch'); }, function (e) {
      if (on) fail('qswatch', 'qs stale', 'qs.watch was refused, so the panel shows a snapshot and will not update itself: ' + msg(e));
    });
  }

  function qsApplyReply(r) {
    if (!r || !r.part || !qs) return;
    var v = r.value;
    if (r.part === 'volume' && qs.volume) qs.volume.level = v;
    else if (r.part === 'mute' && qs.volume) qs.volume.muted = !!v;
    else if (r.part === 'wifi' && qs.wifi) qs.wifi.on = !!v;
    else if (r.part === 'bluetooth' && qs.bluetooth) qs.bluetooth.on = !!v;
    else if (r.part === 'brightness' && qs.brightness) qs.brightness.level = v;
  }

  function qsSet(part, value) {
    qsBusy[part] = true;
    if (qsPaint) qsPaint();
    return callR('qs.set', { part: part, value: value }).then(function (r) {
      qsBusy[part] = false;
      qsApplyReply(r);                      // the reply is authoritative, not the click
      if (qsPaint) qsPaint();
      clearFail('qsset');
      return r;
    }, function (e) {
      qsBusy[part] = false;
      if (qsPaint) qsPaint();               // straight back to what the system actually says
      fail('qsset', part + ' failed', 'qs.set ' + part + ' was refused: ' + msg(e), 'warn');
    });
  }

  /* 10 sets a second while a slider is dragged, and the last value always lands (the trailing
     call), because the one the user stops on is the one that matters. */
  function throttled(fn, ms) {
    var last = 0, t = 0, pending = null;
    return function (v) {
      pending = v;
      var now = Date.now(), wait = ms - (now - last);
      if (wait <= 0) { last = now; fn(pending); }
      else if (!t) t = setTimeout(function () { t = 0; last = Date.now(); fn(pending); }, wait);
    };
  }

  function svg(body, size) {
    return '<svg viewBox="0 0 16 16" width="' + (size || 16) + '" height="' + (size || 16) +
      '" aria-hidden="true" focusable="false">' + body + '</svg>';
  }
  function wifiGlyph(bars) {
    var arcs = ['M6.3 10.8a2.6 2.6 0 0 1 3.4 0', 'M4 8.2a6 6 0 0 1 8 0', 'M1.6 5.6a9.5 9.5 0 0 1 12.8 0'];
    var s = '<circle cx="8" cy="13.2" r="1" fill="currentColor"/>';
    for (var i = 0; i < 3; i++)
      s += '<path d="' + arcs[i] + '" fill="none" stroke="currentColor" stroke-width="1.3" ' +
        'stroke-linecap="round" opacity="' + (i < bars ? '1' : '.28') + '"/>';
    return svg(s);
  }
  var BT_GLYPH = svg('<path d="M6 4.4L10.2 8 6 11.6M8 2v12l2.2-2.4M8 8L5.2 5.8M8 8l-2.8 2.2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>');
  var MOON_GLYPH = svg('<path d="M12.6 10.2A5.2 5.2 0 0 1 6.1 3.6a5.4 5.4 0 1 0 6.5 6.6z" fill="currentColor"/>');
  var SAVER_GLYPH = svg('<rect x="1.4" y="5" width="10.8" height="6" rx="2" fill="none" stroke="currentColor" stroke-width="1.2"/><rect x="13.2" y="6.8" width="1.4" height="2.4" rx=".7" fill="currentColor"/><path d="M7.4 5.9L5.6 8.4h1.6l-.4 1.8 2-2.4H7.1z" fill="currentColor"/>');

  function buildQsPop(pop) {
    var tiles = {}, notes = document.createElement('div'), sliders = {};

    var grid = document.createElement('div'); grid.className = 'qsgrid';
    [['wifi', 'Wi-Fi'], ['bluetooth', 'Bluetooth'], ['nightlight', 'Night light'], ['saver', 'Battery saver']]
      .forEach(function (t) {
        var b = document.createElement('button');
        b.type = 'button'; b.className = 'qstile';
        var ico = document.createElement('span'); ico.className = 'qsico';
        var lbl = document.createElement('span'); lbl.className = 'qslbl'; lbl.textContent = t[1];
        var sub = document.createElement('span'); sub.className = 'qssub';
        b.appendChild(ico); b.appendChild(lbl); b.appendChild(sub);
        tiles[t[0]] = { b: b, ico: ico, sub: sub, name: t[1] };
        grid.appendChild(b);
      });
    pop.appendChild(grid);

    tiles.wifi.b.addEventListener('click', function () {
      var p = qsPart('wifi');
      if (!partOk(p) || !p.present || qsBusy.wifi) return;
      qsSet('wifi', !p.on);
    });
    tiles.bluetooth.b.addEventListener('click', function () {
      var p = qsPart('bluetooth');
      if (!partOk(p) || !p.present || qsBusy.bluetooth) return;
      qsSet('bluetooth', !p.on);
    });
    // night light and battery saver are read-only for now, and say so in their tooltips

    function slider(key, label, part, setPart) {
      var wrap = document.createElement('div'); wrap.className = 'qsrow';
      var head = document.createElement('div'); head.className = 'qsrowhead';
      var name = document.createElement('span'); name.textContent = label;
      var val = document.createElement('span'); val.className = 'qsval';
      head.appendChild(name); head.appendChild(val);
      var line = document.createElement('div'); line.className = 'qsline';
      var range = document.createElement('input');
      range.type = 'range'; range.min = '0'; range.max = '100'; range.step = '1';
      line.appendChild(range);
      wrap.appendChild(head); wrap.appendChild(line);
      pop.appendChild(wrap);
      var send = throttled(function (v) { qsSet(setPart, v / 100); }, 100);
      range.addEventListener('input', function () {
        val.textContent = range.value + '%';
        if (setPart === 'volume') { vol.level = Number(range.value) / 100; volumeGlyph(); }
        send(Number(range.value));
      });
      range.addEventListener('change', function () { qsSet(setPart, Number(range.value) / 100); });
      sliders[key] = { wrap: wrap, range: range, val: val, line: line, part: part };
      return sliders[key];
    }

    slider('brightness', 'Brightness', 'brightness', 'brightness');
    var v = slider('volume', 'Volume', 'volume', 'volume');
    var mute = document.createElement('button');
    mute.type = 'button'; mute.className = 'qsmute';
    mute.addEventListener('click', function () {
      var p = qsPart('volume');
      if (qsBusy.mute) return;
      qsSet('mute', !(p && p.muted));
    });
    v.line.appendChild(mute);
    v.mute = mute;

    notes.className = 'qsnotes';
    pop.appendChild(notes);

    var foot = document.createElement('div'); foot.className = 'qsfoot';
    var power = document.createElement('div'); power.className = 'qspower';
    var acts = document.createElement('div'); acts.className = 'qsacts';
    var toWin = document.createElement('button');
    toWin.type = 'button'; toWin.className = 'qslink';
    toWin.textContent = 'Windows quick settings';
    toWin.title = 'Open the real Windows flyout (Win+A) — everything Mantle does not wrap yet';
    toWin.addEventListener('click', function () { closePop(); keys('win+a', 'quick settings'); });
    var gear = document.createElement('button');
    gear.type = 'button'; gear.className = 'qsgear';
    gear.title = 'Open Windows Settings';
    gear.innerHTML = svg('<path d="M8 5.6A2.4 2.4 0 1 0 8 10.4 2.4 2.4 0 0 0 8 5.6z" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M8 1.6l1 1.7 2-.3.5 1.9 1.8.9-.9 1.8.9 1.8-1.8.9-.5 1.9-2-.3-1 1.7-1-1.7-2 .3-.5-1.9-1.8-.9.9-1.8-.9-1.8 1.8-.9.5-1.9 2 .3z" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/>');
    gear.addEventListener('click', function () { closePop(); act('open', { target: 'ms-settings:' }, 'settings'); });
    acts.appendChild(toWin); acts.appendChild(gear);
    foot.appendChild(power); foot.appendChild(acts);
    pop.appendChild(foot);

    function paintTile(key, on, present, ok, sub, tip, glyphHTML, fixed) {
      var t = tiles[key];
      t.ico.innerHTML = glyphHTML;
      t.sub.textContent = sub;
      t.b.classList.toggle('on', !!on && ok && present);
      t.b.classList.toggle('dead', !ok || !present || fixed);
      t.b.classList.toggle('pending', !!qsBusy[key]);
      t.b.title = tip;
      if (!ok || !present || fixed) t.b.setAttribute('aria-disabled', 'true');
      else t.b.removeAttribute('aria-disabled');
      t.b.setAttribute('aria-pressed', String(!!on));
    }

    function paint() {
      var w = qsPart('wifi'), b = qsPart('bluetooth'), n = qsPart('nightlight'),
          p = qsPart('power'), br = qsPart('brightness'), vv = qsPart('volume');
      var problems = [];

      // ---- Wi-Fi
      var wBars = w && w.connected ? Math.max(1, Math.min(3, Math.ceil((w.signal || 0) / 34))) : 0;
      paintTile('wifi', w && w.on, !w || w.present !== false, partOk(w),
        !w ? 'Unknown'
          : !partOk(w) ? 'Unavailable'
          : w.present === false ? 'No adapter'
          : !w.on ? 'Off'
          : w.connected ? (w.ssid || 'Connected') + (w.band ? ' · ' + w.band : '') : 'Not connected',
        !partOk(w) ? 'Wi-Fi — ' + partWhy(w, 'Wi-Fi')
          : (w && w.present === false) ? 'No Wi-Fi adapter on this machine'
          : 'Turn Wi-Fi ' + (w && w.on ? 'off' : 'on'),
        wifiGlyph(w && w.on ? (wBars || 1) : 0), false);
      if (!partOk(w)) problems.push('Wi-Fi: ' + partWhy(w, 'Wi-Fi'));

      // ---- Bluetooth
      var slow = b && b.via && /powershell/i.test(String(b.via));
      paintTile('bluetooth', b && b.on, !b || b.present !== false, partOk(b),
        !b ? 'Unknown'
          : !partOk(b) ? 'Unavailable'
          : b.present === false ? 'No radio'
          : (b.on ? 'On' : 'Off') + (slow ? ' · slow' : ''),
        !partOk(b) ? 'Bluetooth — ' + partWhy(b, 'Bluetooth')
          : (slow ? 'Switched via PowerShell, so it takes a second or two\n' : '') +
            'Turn Bluetooth ' + (b && b.on ? 'off' : 'on'),
        BT_GLYPH, false);
      if (!partOk(b)) problems.push('Bluetooth: ' + partWhy(b, 'Bluetooth'));

      // ---- Night light (state only)
      paintTile('nightlight', n && n.on, !n || n.present !== false, partOk(n),
        !n ? 'Unknown' : !partOk(n) ? 'Unavailable' : n.present === false ? 'Not set up' : (n.on ? 'On' : 'Off'),
        !partOk(n) ? 'Night light — ' + partWhy(n, 'night light')
          : 'Mantle cannot switch this yet — it reads the state only',
        MOON_GLYPH, true);
      if (!partOk(n)) problems.push('Night light: ' + partWhy(n, 'night light'));

      // ---- Battery saver (state only)
      paintTile('saver', p && p.saver, !!p, partOk(p),
        !p ? 'Unknown' : !partOk(p) ? 'Unavailable' : (p.saver ? 'On' : 'Off'),
        !partOk(p) ? 'Battery saver — ' + partWhy(p, 'battery saver')
          : 'Mantle cannot switch this yet — it reads the state only',
        SAVER_GLYPH, true);
      if (!partOk(p)) problems.push('Power: ' + partWhy(p, 'power'));

      // ---- sliders
      function paintSlider(s, part, pct, ok, present, why) {
        var live = ok && present;
        s.range.disabled = !live;
        s.wrap.classList.toggle('dead', !live);
        if (document.activeElement !== s.range && typeof pct === 'number')
          s.range.value = String(Math.round(pct));
        s.val.textContent = live ? (typeof pct === 'number' ? Math.round(pct) + '%' : '—') : 'unavailable';
        s.wrap.title = live ? '' : why;
      }
      paintSlider(sliders.brightness, 'brightness',
        br && typeof br.level === 'number' ? br.level : null,   // qs.get levels are already 0-100 (live: "10000%" before this)
        partOk(br), !!br && br.present !== false,
        !br ? 'brightness was not reported' : !partOk(br) ? partWhy(br, 'brightness') : 'This display does not report a brightness control');
      if (br && !partOk(br)) problems.push('Brightness: ' + partWhy(br, 'brightness'));

      paintSlider(sliders.volume, 'volume',
        vv && typeof vv.level === 'number' ? vv.level : null,   // 0-100 from qs.get, not the 0-1 of volume.get
        partOk(vv), !!vv, partOk(vv) ? 'volume was not reported' : partWhy(vv, 'volume'));
      if (vv && !partOk(vv)) problems.push('Volume: ' + partWhy(vv, 'volume'));
      var muted = !!(vv && vv.muted);
      sliders.volume.mute.innerHTML = volumeSvg(muted ? 0 : (vv && vv.level) || 0, muted);
      sliders.volume.mute.classList.toggle('on', muted);
      sliders.volume.mute.classList.toggle('pending', !!qsBusy.mute);
      sliders.volume.mute.title = muted ? 'Unmute' : 'Mute';
      sliders.volume.mute.setAttribute('aria-pressed', String(muted));

      // ---- footer power line
      power.textContent = !p ? 'Power state unknown'
        : !partOk(p) ? 'Power: ' + partWhy(p, 'power')
        : !p.onBattery ? 'Plugged in' + (typeof p.percent === 'number' ? ' · ' + Math.round(p.percent) + '%' : '')
        : (typeof p.percent === 'number' ? Math.round(p.percent) + '%' : 'On battery') +
          (p.minutesLeft ? ' · ' + Math.floor(p.minutesLeft / 60) + 'h ' + (p.minutesLeft % 60) + 'm left' : '');

      // ---- the notes: one line per part that is not ok, never a blank tile with no explanation
      notes.textContent = '';
      problems.forEach(function (text) {
        var d = document.createElement('div'); d.className = 'note'; d.textContent = text;
        notes.appendChild(d);
      });
    }

    qsPaint = paint;
    paint();                                    // draw from whatever we already know, immediately
    qsSnapshot().then(function () { if (popKey === 'qs') paint(); },
      function () { if (popKey === 'qs') paint(); });
    qsWatch(true);
  }

  function openQs(anchor) { openPop('qs', anchor || el.right, buildQsPop); }

  el.volume.addEventListener('click', function () { openQs(el.volume); });
  el.network.addEventListener('click', function () { openQs(el.network); });
  el.battery.addEventListener('click', function () { openQs(el.battery); });
  el.volume.addEventListener('contextmenu', function (ev) { ev.preventDefault(); openQs(el.volume); });
  el.network.addEventListener('contextmenu', function (ev) { ev.preventDefault(); openQs(el.network); });
  el.battery.addEventListener('contextmenu', function (ev) { ev.preventDefault(); openQs(el.battery); });

  /* ================================================================= battery */

  function renderBattery(b) {
    if (!b || typeof b.percent !== 'number') { el.battery.hidden = true; return; }   // a desktop: no battery, nothing to say
    var p = Math.max(0, Math.min(100, Math.round(b.percent)));
    var fillW = (8.4 * p / 100).toFixed(2);
    var s = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">';
    s += '<rect x="1.2" y="4.7" width="11.6" height="6.6" rx="2" fill="none" stroke="currentColor" stroke-width="1.2"/>';
    s += '<rect x="13.5" y="6.7" width="1.5" height="2.6" rx=".7" fill="currentColor"/>';
    if (p > 0) s += '<rect x="2.8" y="6.3" width="' + fillW + '" height="3.4" rx="1" fill="currentColor"/>';
    // No var() inside SVG presentation attributes: they are not custom-property aware.
    if (b.charging) s += '<path d="M8.6 5.4L6.2 8.6h1.9l-.5 2.2 2.4-3H8.2z" fill="currentColor" opacity=".95"/>';
    s += '</svg><span class="pct">' + p + '%</span>';
    el.battery.innerHTML = s;
    el.battery.title = 'Battery ' + p + '%' + (b.charging ? ', charging' : '') + ' — open battery settings';
    el.battery.hidden = false;
  }

  function readStats() {
    return call('sys.stats').then(function (s) {
      clearFail('stats');
      renderBattery(s && s.battery);
      if (s && s.volume && vol.level === null && typeof s.volume.level === 'number') { vol.level = s.volume.level / 100; vol.muted = !!s.volume.muted; volumeGlyph(); }
    }, function (e) {
      el.battery.hidden = true;
      fail('stats', 'stats off', 'sys.stats failed, so battery and volume readings are stale: ' + msg(e));
    });
  }

  /* ================================================================= clock */

  var tickN = 0, tickTimer = 0;
  function pad(n) { return n < 10 ? '0' + n : String(n); }

  /* 12-hour with seconds, Windows' own shape: "4:15:32 PM" — no leading zero on the hour, two
     digits on the minutes and seconds, one space before the meridiem. Hand-formatted rather than
     Intl, because Intl's hour12 output is locale-dependent (it gives "4:15:32 p.m." on some
     locales and a narrow no-break space before the meridiem on modern ICU), and Owen asked for
     the Windows en-US string, not for whatever his locale happens to render. The DATE line below
     still goes through toLocaleDateString: that one SHOULD follow the machine. */
  function clockText(now) {
    var h = now.getHours();
    var mer = h < 12 ? 'AM' : 'PM';
    h = h % 12; if (h === 0) h = 12;
    return h + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds()) + ' ' + mer;
  }

  /* One tick does the least it can: the time is a text node swap on a box that is already wide
     enough for the longest string it will ever hold (see .clock .t in bar.css — tabular-nums and
     a min-width), so "9:59:59 PM" → "10:00:00 PM" cannot reflow the cluster, and nothing here
     measures anything. The date and the tooltip only change on the minute, so they are only
     touched when their own text actually differs. */
  function tick() {
    var now = new Date();
    var t = clockText(now);
    if (clkT.textContent !== t) clkT.textContent = t;
    var d = now.toLocaleDateString(undefined, { day: 'numeric', month: 'numeric', year: 'numeric' });
    if (clkD.textContent !== d) clkD.textContent = d;
    var tip = now.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) +
      '\nClick: the calendar';
    if (el.clock.title !== tip) el.clock.title = tip;

    // Battery drifts slowly: refreshing it on every fifth minute tick avoids a second timer.
    if (tickN % 5 === 0) readStats();
    tickN++;
    schedule();
  }

  /* THE one timer, and it changes gear with the bar. While the bar is UP the seconds are on
     screen, so it fires on the second boundary. While it is hidden nobody can see the digits, so
     it drops back to the minute boundary — the text may be up to a minute stale in a window that
     is off screen, which costs nothing and is the difference between one wakeup a minute and
     sixty. Chained setTimeout, never setInterval: a sleep/resume must not leave a backlog, and
     each hop re-aligns to the real clock instead of drifting. */
  function schedule() {
    if (tickTimer) clearTimeout(tickTimer);
    var period = revealed ? 1000 : 60000;
    var slack = revealed ? 20 : 250;     // never a hair early, or we would paint the previous second
    tickTimer = setTimeout(tick, period - (Date.now() % period) + slack);
  }

  /* Called by slide() the instant a reveal or a hide lands: repaint NOW (the hidden bar's text
     can be a minute old and it is about to be looked at) and re-aim the timer at the new gear. */
  function clockGear() {
    var now = new Date();
    var t = clockText(now);
    if (clkT.textContent !== t) clkT.textContent = t;
    schedule();
  }

  /* ================================================================= the calendar

     The clock opens a month, the way Windows' does. The notification centre is the one half of
     that flyout Mantle cannot replicate, so it is a link at the bottom that says so rather than
     something quietly missing. */
  var calShown = null;          // the 1st of the month on screen; null = follow today

  function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }

  function buildCalPop(pop) {
    pop.classList.add('cal');
    var today = new Date();
    if (!calShown) calShown = new Date(today.getFullYear(), today.getMonth(), 1);

    var head = document.createElement('div'); head.className = 'calhead';
    var big = document.createElement('div'); big.className = 'big';
    var sub = document.createElement('div'); sub.className = 'sub';
    head.appendChild(big); head.appendChild(sub);
    pop.appendChild(head);

    var nav = document.createElement('div'); nav.className = 'calnav';
    function navBtn(text, tip, fn) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'calbtn'; b.textContent = text; b.title = tip;
      b.addEventListener('click', fn);
      return b;
    }
    var title = document.createElement('div'); title.className = 'caltitle';
    var prev = navBtn('‹', 'Previous month', function () {
      calShown = new Date(calShown.getFullYear(), calShown.getMonth() - 1, 1); paintGrid();
    });
    var next = navBtn('›', 'Next month', function () {
      calShown = new Date(calShown.getFullYear(), calShown.getMonth() + 1, 1); paintGrid();
    });
    var now = navBtn('Today', 'Back to this month', function () {
      var t = new Date();
      calShown = new Date(t.getFullYear(), t.getMonth(), 1); paintGrid();
    });
    nav.appendChild(title); nav.appendChild(now); nav.appendChild(prev); nav.appendChild(next);
    pop.appendChild(nav);

    var dow = document.createElement('div'); dow.className = 'calgrid caldow';
    /* Sunday-first, with the weekday names taken from the machine's locale the same way the date
       line is — a hard-coded English row would be the one thing in the panel that ignores it. */
    for (var i = 0; i < 7; i++) {
      var d = new Date(2026, 1, 1 + i);      // 2026-02-01 is a Sunday: a known week to read names off
      var c = document.createElement('div'); c.className = 'caldowc';
      c.textContent = d.toLocaleDateString(undefined, { weekday: 'short' }).slice(0, 2);
      dow.appendChild(c);
    }
    pop.appendChild(dow);

    var grid = document.createElement('div'); grid.className = 'calgrid';
    pop.appendChild(grid);

    var foot = document.createElement('div'); foot.className = 'calfoot';
    var link = document.createElement('button');
    link.type = 'button'; link.className = 'qslink';
    link.textContent = 'Windows notifications';
    link.title = 'Open the notification centre (Win+N) — the one part of this flyout Mantle cannot draw yet';
    link.addEventListener('click', function () { closePop(); keys('win+n', 'notifications'); });
    foot.appendChild(link);
    pop.appendChild(foot);

    function paintGrid() {
      var t = new Date();
      title.textContent = calShown.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
      grid.textContent = '';
      var first = new Date(calShown.getFullYear(), calShown.getMonth(), 1);
      var start = new Date(first);
      start.setDate(1 - first.getDay());                 // back to the Sunday on or before the 1st
      for (var i = 0; i < 42; i++) {
        var d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
        var c = document.createElement('div');
        c.className = 'calday' +
          (d.getMonth() !== calShown.getMonth() ? ' other' : '') +
          (sameDay(d, t) ? ' today' : '');
        c.textContent = String(d.getDate());
        c.title = d.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
        grid.appendChild(c);
      }
    }

    function paintClock() {
      var d = new Date();
      big.textContent = clockText(d);
      sub.textContent = d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    }

    paintClock();
    paintGrid();
    /* Seconds run ONLY while this popover is open, and as a chained setTimeout that checks popKey
       first — so there is no interval left alive anywhere in this file, and the "one timer at
       rest" rule holds by construction rather than by remembering to clear one. */
    (function second() {
      popTimer = setTimeout(function () {
        if (popKey !== 'cal') return;
        paintClock();
        second();
      }, 1000 - (Date.now() % 1000) + 20);
    })();
  }

  el.clock.addEventListener('click', function () { openPop('cal', el.clock, buildCalPop); });
  el.clock.addEventListener('contextmenu', function (ev) { ev.preventDefault(); openPop('cal', el.clock, buildCalPop); });

  /* ================================================================= overflow menu */

  function buildMorePop(pop) {
    var h = document.createElement('h3');
    h.textContent = 'Mantle';
    pop.appendChild(h);
    /* Which mode and which bridge, always in words: a mock bridge must never be mistakable for
       the real shell, and "live" vs "test" changes what Restore/Quit actually do. */
    var who = document.createElement('div');
    who.className = 'sub';
    who.style.margin = '-4px 0 8px';
    who.textContent = (state && state.mode ? state.mode + ' mode' : 'mode unknown') + ' · ' +
      (state && state.bar && state.bar.mode ? 'bar ' + state.bar.mode + ' · ' : '') +
      (!mantle ? 'no bridge'
        : failures.bridge ? 'bridge failing'          // never claim "ok" while a chip says otherwise
        : mantle.mode === 'mock' ? 'mock bridge'
        : 'bridge ok');
    pop.appendChild(who);
    if ((state && state.tray && state.tray.status === 'unavailable') || trayThrew) {
      var trayNote = document.createElement('div');
      trayNote.className = 'sub';
      trayNote.style.margin = '-2px 0 8px';
      trayNote.textContent = 'notification area: ' + ((state && state.tray && state.tray.reason) || trayThrew || 'unavailable, and no reason was given');
      pop.appendChild(trayNote);
    }
    /* every chip, in words: in pill mode the strip shows pips only */
    chipData().forEach(function (c) {
      var line = document.createElement('div'); line.className = 'sub'; line.style.margin = '-2px 0 8px';
      line.textContent = c.label + ': ' + c.reason;
      pop.appendChild(line);
    });

    var restore = document.createElement('button');
    restore.type = 'button'; restore.className = 'item';
    restore.textContent = 'Restore Windows taskbar';
    restore.addEventListener('click', function () {
      callR('shell.restore').then(function () { closePop(); }, function (e) {
        restore.textContent = 'Restore failed — ' + msg(e);
        restore.classList.add('armed');
      });
    });
    pop.appendChild(restore);

    /* Quit is behind a second click: the bar is the only way back to a normal desktop, so a
       stray click must not take the shell down. */
    var quit = document.createElement('button');
    quit.type = 'button'; quit.className = 'item danger';
    quit.textContent = 'Quit Mantle';
    var armed = false;
    quit.addEventListener('click', function () {
      if (!armed) { armed = true; quit.textContent = 'Click again to quit'; quit.classList.add('armed'); return; }
      callR('shell.quit').then(function () { closePop(); }, function (e) {
        quit.textContent = 'Quit failed — ' + msg(e);
      });
    });
    pop.appendChild(quit);
  }
  el.more.addEventListener('click', function () { openPop('more', el.more, buildMorePop); });

  /* ================================================================= start */

  el.start.addEventListener('click', function () { closePop(); act('launcher.show', null, 'launcher'); });

  /* ================================================================= boot */

  function applyState(s) {
    state = s || null;
    if (state && (state.edge === 'top' || state.edge === 'bottom')) el.body.dataset.edge = state.edge;
    // main may also report the shape it is holding the window in; the events carry it too
    if (state && state.bar && (state.bar.mode === 'pill' || state.bar.mode === 'edge')) setMode(state.bar.mode);
    /* Main's own view of the reveal wins if it ever disagrees with ours (a missed event, a
       reload while the bar was up): the bar must never be parked off screen while the shell
       believes it is showing. */
    /* ...but only once the events have gone quiet. A state push that lands in the middle of a
       reveal is main's OLD view arriving late, and honouring it there reverses the animation the
       events just started (and, before the class became the truth, left the two out of step for
       good). The events own the movement; this is the repair for a missed one. */
    if (state && state.bar && typeof state.bar.revealed === 'boolean' &&
        state.bar.revealed !== el.body.classList.contains('up') &&
        Date.now() - lastEventAt > 1200)
      slide(state.bar.revealed, 'state.bar.revealed');
    renderChips();
    renderTray(lastTray);
  }

  var lastTray = [];

  volumeGlyph();      // draw the speaker immediately, in its "unknown" form, rather than an empty square
  tick();             // clock first: it is the one thing that must be right even if the bridge is dead

  if (!mantle) {
    fail('bridge', 'bridge missing', 'window.mantle is not present (preload did not run) — the bar cannot see Windows', 'warn');
    renderTray([]);
  } else {
    call('state.get').then(function (s) {
      clearFail('bridge');
      applyState(s);
    }, function (e) {
      // The brief's literal case: one chip, and the message in it.
      fail('bridge', 'bridge missing: ' + msg(e), 'state.get was refused: ' + msg(e), 'warn');
      renderTray([]);
    });

    // Live State updates, if lane A pushes them. Absent, the one-shot state.get above still stands.
    if (typeof mantle.on === 'function') {
      try { mantle.on('state', function (s) { applyState(s); }); } catch (e) { /* optional channel */ }
    }

    on('bar.reveal', function (p) { lastEventAt = Date.now(); slide(true, p && p.why, p && p.mode, p && p.ms); });
    on('bar.hide', function (p) { lastEventAt = Date.now(); slide(false, p && p.why, null, p && p.ms); });
    on('bar.pinned', renderDock);
    on('bar.backdrop', setBackdrop);
    /* Pushed every 2s ONLY while the quick-settings panel is open (and after every set), so this
       repaints the panel in place and keeps the bar's own speaker honest for free. */
    on('qs', function (d) {
      qs = d;
      if (d && d.volume && typeof d.volume.level === 'number') {
        vol.level = d.volume.level; vol.muted = !!d.volume.muted; volumeGlyph();
      }
      if (popKey === 'qs' && qsPaint) qsPaint();
    });
    on('windows', renderWindows);
    on('tray', function (list) { lastTray = list || []; renderTray(lastTray); },
      function (reason) { trayThrew = reason; renderTray(lastTray); });   // the tray says it in its own chip

    /* tray.list is called once on boot purely to catch the "explorer exposes no tray" case with
       its reason, which is the form the failure takes on Windows 11 26200. */
    call('tray.list').then(function (list) {
      trayThrew = '';
      if (Array.isArray(list) && list.length) { lastTray = list; renderTray(lastTray); }
    }, function (e) {
      trayThrew = msg(e);
      renderTray(lastTray);
    });

    refreshPinned();    // draw the icons now, so the first reveal slides up a bar that is already right
    readStats();
    readVolume().catch(function () { /* already reported on the glyph tooltip and the chip */ });
  }
})();
