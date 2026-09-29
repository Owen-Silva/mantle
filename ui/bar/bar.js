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
    media: $('media'), mchip: $('mchip'), mtog: $('mtog'),
    mart: document.querySelector('#mchip .mart'), mtxt: document.querySelector('#mchip .mtxt'),
    volume: $('volume'), network: $('network'), battery: $('battery'), clock: $('clock'),
    more: $('more'), pop: $('pop')
  };
  var clkT = el.clock.querySelector('.t');
  var clkD = el.clock.querySelector('.d');
  /* The ⋯ button's pip: in pill mode it stands in for the status strip (see renderChips). */
  var morePip = document.createElement('span');
  morePip.className = 'mpip';
  morePip.hidden = true;
  morePip.setAttribute('aria-hidden', 'true');
  el.more.appendChild(morePip);

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
    var p = call(channel, payload).then(function (r) {
      if (r && typeof r === 'object' && r.ok === false)
        throw new Error(r.reason || channel + ' replied ok:false and gave no reason');
      return r || {};
    });
    /* Every popover room request, whoever sends it (this file, qs-more, downloads, notifications,
       the jump list), has its answer checked here: main's room is capped (POPOVER_MAX), and a
       panel taller than that SCROLLS and says so instead of losing its top (popFit). */
    if (channel === 'bar.popover' && payload && payload.open) {
      if (!popLast || popLast.key !== payload.key) popLast = { key: payload.key, asked: 0, room: 0, max: 0 };
      popLast.asked = Math.round(Number(payload.height)) || 0;
      p = p.then(function (r) { popFit(payload.key, r); return r; });
    }
    return p;
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
    /* PILL MODE HAS NO STRIP (2026-09-22, bar.css): the dock never measured against it, so on a
       full island the right-most pins were drawn over the pips. One pip on the ⋯ button stands
       in for all of them, warn-coloured if any is a warning, and its tooltip and its menu say
       every one in words. In edge mode the strip is shown and the pip is hidden by CSS. */
    morePip.hidden = !data.length;
    morePip.classList.toggle('warn', data.some(function (c) { return c.tone === 'warn'; }));
    el.more.title = data.length
      ? 'More — ' + data.length + (data.length === 1 ? ' thing needs' : ' things need') + ' attention:\n' +
        data.map(function (c) { return c.label + ': ' + c.reason; }).join('\n')
      : 'More';
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
    /* The media chip's fit is judged only on the LANDED pill: mid-entrance the pill is still
       narrowing in from 62 % and every measurement says "does not fit" (measured in the mock: a
       923 px bar at 512 ms of a 1000 px one), which would drop the title on every reveal and bring
       it back 500 ms later. So it waits for the entrance, and is looked at once more when it ends. */
    if (on) {
      mediaFitAfter = Date.now() + d + 40;
      setTimeout(layoutDock, d + 60);
    }
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
    // the window flyout's hover dwell (see THE WINDOW FLYOUT below); cells are reused, so once each
    b.addEventListener('mouseenter', function () { flyCellEnter(b); });
    b.addEventListener('mouseleave', function () { flyCellLeave(b); });
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
    /* Mantle's own app (Mantle Settings / Task Manager), and a pin of Windows' own that it stands in
       for (icons lane, 2026-09-28): say so, where Windows' own is, and why a click would open Windows'. */
    if (it.mantleApp && it.standsInFor) tip += '\n(' + (it.kind === 'pinned' && !it.selfPin ? 'Mantle\'s, in place of ' + it.standsInFor + '; ' : '') + 'right-click: ' + it.standsInFor + ')';
    if (it.standInReason) tip += '\n(' + it.standInReason + ')';
    if (wins.length > 1) tip += '\n(right-click: the window list)';
    if (it.kind === 'pinned') tip += '\n(middle-click: new window)';
    /* While this icon's window flyout is up the tooltip is held back (b._fly): Chromium's tooltip
       is a window of its own and would open on top of the live previews. It comes back on close. */
    b._tip = tip;
    var shown = b._fly ? '' : tip;
    if (b.title !== shown) { b.title = shown; b.setAttribute('aria-label', name); }

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
    if (window.MantleOnTop) MantleOnTop.paint(b, wins);   // the "kept on top" pin badge (ui/bar/ontop.js)
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
    // ...and one whose windows changed (one closed, one opened, a title moved on) is redrawn
    flyRefresh();

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
    /* In PILL mode the chip strip is NOT part of the wall the dock measures against: chips are the
       bar talking about problems, and the "apps clipped" chip was widening the very cluster it
       measured (a 136 -> 0 -> 355 px loop, live 2026-09-21). The wall is the first real control.
       Edge mode is the exception, below. */
    /* The now-playing chip IS a real control (2026-09-22), and it sits left of the tray, so while
       it shows it is the wall; it measured 0 wide (hidden) otherwise. Like the tray, its left edge
       never moves with the chips: the island is right-anchored and the chips are to its left. */
    var tray = $('tray'), vol = $('volume');
    /* The Downloads button (ui/bar/downloads.js) sits left of the speaker: while it shows, IT is the
       first instrument, so the wall (with an empty tray the dock slid under it, mock 2026-09-27). */
    var dlb = $('downloads');
    if (dlb && dlb.getBoundingClientRect().width > 0) vol = dlb;
    var anchor = (el.media && el.media.getBoundingClientRect().width > 0) ? el.media
      : (tray && tray.getBoundingClientRect().width > 0) ? tray : (vol || el.right);
    /* EDGE MODE COUNTS THE STRIP (2026-09-23). Pill mode hides the strip (bar.css), so the rule
       above is all it needs. Edge mode DRAWS the strip, and with the wall at the tray the icons
       were painted over it: in the mock at 1280 px, 14 icons (589 px) centred ended at x=938,
       over the "hotkey off" chip at 857-942 (bar-1280.png); now they slide 85 px left and end at
       853. So in edge mode a strip that shows anything is the wall, and pill mode measures exactly
       as before (pixel-compared). The 2026-09-21 loop cannot come back: the rule now slides before it
       clips and keys each decision to the wall, and a wider "N apps hidden" chip only ever means
       more hidden, never fewer, so settle after settle converges (one more at most, per extra
       digit or the plural "s"). The price is honest: that chip takes room from the icons too. */
    if (barMode === 'edge' && el.chips && el.chips.getBoundingClientRect().width > 0) anchor = el.chips;
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

  /* The settled answer's key. `revealed` is in it (2026-09-23) because the judgement made while
     the bar is down is made SILENTLY (no chip while hidden, below), and in edge mode a reveal
     changes nothing else: same width, same icons, same wall, so the key matched, the silent
     answer stood, and "apps hidden" was never raised at all. Measured in the mock: a 900 px edge
     bar with 15 icons capped the dock at 475 px and showed no chip (pill mode was spared only
     because its reveal changes the width). Same geometry, same decision, so nothing visual moves. */
  function dockKey(m, need) {
    return (revealed ? 'up:' : 'down:') + m.w + ':' + need + ':' + Math.round(m.spanR);
  }

  function applyDock(d) {
    el.dock.style.setProperty('--dock-max', d.cap);
    el.dock.style.setProperty('--dock-shift', Math.round(d.shift) + 'px');
  }

  function layoutDock() {
    var m = measure();
    if (!m) return;
    var need = needWidth();
    /* The wall is in the key since the media chip (2026-09-22): it can appear, or change width with
       every track, without the bar's width or the icon count changing, and the dock must move for
       it. Safe from the old 136 -> 0 -> 355 loop: in pill mode the chips never move the wall, and
       in edge mode, where they do, measure() says why it converges. */
    var key = dockKey(m, need);
    /* Already settled at this width, with this many icons, against this wall? Then this resize is
       something INSIDE the bar changing width (our own status chips) and the settled answer stands. */
    applyDock(key === lastKey ? frozen : decide(m, need));
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(settleDock, 50);
  }

  function settleDock() {
    settleTimer = 0;
    var m = measure();
    if (!m) return;
    var need = needWidth();
    /* THE PILL MUST HAVE LANDED (2026-09-23). Live on 09344ef, 3 reveals in ~30 raised "5 apps
       hidden -- 13 app icons need 540px and the free span ... is only 348px in a 694px bar" the
       moment the bar came up. 694 dip is 62 % of the 1120 dip pill window: the entrance's FIRST
       width, read after main had already put the window at its pill rect. This settle runs 50 ms
       after the last resize it saw, and when the frames after a reveal come late, nothing resizes
       in those 50 ms, so it judged a width the pill was only passing through. ui/bar/check-reveal.js
       reproduces it by freezing the animation clock across a reveal from parked ("in a 694px bar"
       every time), and under its CPU cap it also caught an ordinary reveal mid-entrance ("in a
       881px bar"). So while the pill's width is still on its way (the transition running, or
       created and not yet started), nothing is judged and the media chip is left alone. The dock
       still tracks every frame in layoutDock; the judgement waits for the transition to finish and
       is made against the width the pill lands at. */
    if (revealed && widthInFlight()) return;
    /* The media chip is judged FIRST: if it gives up its title, the wall moves and the dock is
       judged against the new one, so "apps hidden" is never raised for the instant between. */
    if (revealed && Date.now() >= mediaFitAfter && mediaFit(m, need)) {
      m = measure();
      if (!m) return;
    }
    var key = dockKey(m, need);
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
  var mediaFitAfter = 0;               // set by slide(): not before the pill has landed

  /* Is .bar's width transition (the entrance: settleDock asks only while revealed) still running, or
     waiting for its first frame? Then the settle is re-run once it finishes, so a late entrance is
     still judged the moment it lands. `finished` REJECTS when the transition is cancelled (a hide
     mid-entrance, or a re-reveal restarting it); that is not a failure and nothing is lost: whatever
     cancelled it changes the bar's width again, and that change brings its own settle. */
  var landing = null;                  // the transition a judgement is waiting for
  function widthInFlight() {
    if (!el.bar.getAnimations) return false;          // an engine without it keeps the old timing
    var list = el.bar.getAnimations(), a = null;
    for (var i = 0; i < list.length && !a; i++)
      if (list[i].transitionProperty === 'width' && list[i].playState !== 'finished' && list[i].playState !== 'idle') a = list[i];
    if (!a) return false;
    if (a !== landing) {
      landing = a;
      a.finished.then(function () { if (landing === a) landing = null; layoutDock(); },
        function () { if (landing === a) landing = null; });
    }
    return true;
  }

  /* THE MEDIA CHIP GIVES WAY TO THE APPS (2026-09-22). Measured in the first --test run with a
     real session: a 1106 px island with 13 pins had a 494 px span for 540 px of icons once the
     chip's title took its ~160 px, so two pinned apps went. An app Owen launches from matters more
     than a song title he can see in the card, so when the icons do not fit the chip drops to art +
     glyph (the title stays in its tooltip), and it takes the title back only when the icons would
     still fit WITH it. Both sides of that test are the same geometry, so it cannot flap. The ~7 px
     is the art-to-title gap, which goes with the title. */
  function mediaFit(m, need) {       // true = it changed the chip, so the wall moved
    if (!el.media || el.media.hidden) return false;
    var compact = el.media.classList.contains('compact');
    var textW = Math.min(el.mtxt.scrollWidth, 162) + 7;   // .mchip's 200 max - art, gap, padding
    if (!compact && need > m.span) { el.media.classList.add('compact'); return true; }
    if (compact && need <= m.span - textW) { el.media.classList.remove('compact'); return true; }
    return false;
  }

  /* act(): fire a bridge call for a click and, if it fails, put the reason in the bar.
     Every user action goes through here, so no click can ever do nothing without saying why. */
  function act(channel, payload, what) {
    return callR(channel, payload).then(function (r) { clearFail('act'); return r; }, function (e) {
      fail('act', (what || channel.split('.')[0]) + ' failed', channel + ' was refused: ' + msg(e), 'warn');
    });
  }

  /* ================================================================= THE WINDOW FLYOUT

     Windows 11's taskbar previews (2026-09-22). Owen: "if you hover your mouse over an app that is
     open you can see the tabs that are open and choose between them ... and you can see what's
     happening in that app on a small screen". Hover a RUNNING app's icon for 400 ms and a flyout
     rises above it with one card per window of that app: the app's icon, the window's title, a
     close button, and a LIVE picture of the window. Click a card to go to that window; the X sends
     the window its own close (WM_CLOSE through the sidecar), never a process kill.

     PER WINDOW, NOT PER TAB: Windows only knows windows. A browser's tabs are drawn inside one
     window and the OS has no handle, title or picture for a background tab, so a browser with
     three windows gets three cards, and a browser with one window and thirty tabs gets one.

     THE PICTURES ARE NOT IN THIS PAGE. Main asks DWM to draw each window straight into the bar
     window, on top of the card's empty box (lib/thumbs.js, 'bar.thumbs'), so all this page does
     is measure the boxes and send them. DWM paints OVER the page, which is why nothing may sit on
     top of a box (the X lives in the header row) and why every road that moves or removes the
     boxes also takes the pictures down (main does that on every bar.popover, hide and park).
     Whatever DWM cannot draw comes back with a reason and the box says it in words.

     ONE POPOVER, THREE WAYS IN: the hover dwell, a left click when main answers action:'list'
     (two or more windows, where Windows shows these same previews), and the right-click. They
     used to open a plain list of titles; if the ways in were built separately they would drift,
     and a taskbar where two routes to the same windows look different is worse than one route.
     A flyout that the HOVER opened closes when the pointer leaves the icon and the flyout; one a
     click opened stays until a click elsewhere or Escape, like every other popover here. */

  var FLY_DWELL_MS = 400;              // Windows' own hover delay is about this
  var FLY_LEAVE_MS = 350;              // long enough to cross the 7px gap between icon and flyout
  var SHOT_W = 200, SHOT_H = 112;      // the preview box at full size (16:9-ish, like Windows')
  var SHOT_MIN_W = 128;                // below this a picture says nothing; show the list instead
  var CARD_PAD = 6, CARD_GAP = 6;      // keep in step with .card / .fly-row in bar.css

  var fly = null;                      // the open flyout: {key, cell, by, gen, sig, ready}
  var flyGen = 0;                      // bumps on every build, so a late reply for an old one is dropped
  var flyDwell = 0, flyLeave = 0, flyHover = null, flySyncQueued = false;

  function cellOf(ev) { return ev.target.closest ? ev.target.closest('.cell') : null; }
  function popKeyOf(b) { return 'app:' + b.dataset.key; }
  function isFlyKey(k) { return !!(k && k.indexOf('app:') === 0); }
  function winSig(wins) { return wins.map(function (w) { return String(w.hwnd); }).join(','); }

  function flyCancelLeave() { if (flyLeave) { clearTimeout(flyLeave); flyLeave = 0; } }
  function flyScheduleLeave() {
    if (!fly || fly.by !== 'hover') return;
    flyCancelLeave();
    flyLeave = setTimeout(function () { flyLeave = 0; if (fly && fly.by === 'hover') closePop(); }, FLY_LEAVE_MS);
  }

  function flyCellEnter(b) {
    flyHover = b;
    flyCancelLeave();
    if (flyDwell) { clearTimeout(flyDwell); flyDwell = 0; }
    var running = winsOf(b._item).length > 0;
    /* A flyout is already up: follow the pointer across the icons with no dwell, the way Windows
       swaps its previews. A pinned app that is not running has no windows to show, so crossing it
       starts the same close a leave would (and entering a running one after it cancels that). */
    if (isFlyKey(popKey)) {
      if (popKey === popKeyOf(b)) return;
      if (running) openFly(b, 'hover');
      else flyScheduleLeave();
      return;
    }
    // Pinned-only apps get their tooltip and no flyout; and a hover never replaces Quick Settings,
    // the calendar or the overflow menu, which the user opened on purpose.
    if (!running || popKey || b._noFly) return;
    flyDwell = setTimeout(function () {
      flyDwell = 0;
      if (flyHover === b && !popKey && b.isConnected && winsOf(b._item).length) openFly(b, 'hover');
    }, FLY_DWELL_MS);
  }

  function flyCellLeave(b) {
    if (flyHover === b) flyHover = null;
    b._noFly = false;
    if (flyDwell) { clearTimeout(flyDwell); flyDwell = 0; }
    flyScheduleLeave();
  }

  el.pop.addEventListener('mouseenter', flyCancelLeave);
  el.pop.addEventListener('mouseleave', flyScheduleLeave);

  /* Tear down this page's half of a flyout. The pictures are main's half: they go on the
     bar.popover call that always follows (closePop's shrink, or the next flyout's resize). */
  function flyTeardown() {
    if (flyDwell) { clearTimeout(flyDwell); flyDwell = 0; }
    flyCancelLeave();
    if (fly && fly.cell) {
      fly.cell._fly = false;
      if (fly.cell._tip && fly.cell.title !== fly.cell._tip) fly.cell.title = fly.cell._tip;
    }
    fly = null;
  }

  function openAppPop(b, it) {
    if (!it || !winsOf(it).length) return;       // nothing to list; the click itself was the action
    openFly(b, 'click');
  }

  function openFly(b, by) {
    var it = b._item;
    if (!it || !winsOf(it).length) return;
    var key = popKeyOf(b);
    if (popKey === key && fly) { fly.by = by === 'click' ? 'click' : fly.by; return; }   // already up: a click only takes ownership
    openPop(key, b, function (pop) { flyBuild(pop, b, it, by); }, { swap: isFlyKey(popKey) })
      .then(function () { flyRoomReady(key); });
  }

  /* The window has grown (or failed to, which the popover has already said in a note). Only now
     are the boxes where they will stay, so this is the first moment their rectangles mean anything. */
  function flyRoomReady(key) {
    if (!fly || popKey !== key) return;
    fly.ready = true;
    flyQueueSync();
  }

  /* Measure after layout: two frames, so a resize the window just went through has reached the
     page's own geometry. Coalesced, because a resize, a transition end and a rebuild can all ask
     in the same frame. */
  function flyQueueSync() {
    if (flySyncQueued) return;
    flySyncQueued = true;
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { flySyncQueued = false; flySync(); });
    });
  }
  /* A resize while the flyout is up: taller (the popover room arriving) only moves the boxes, so
     re-send them; a different WIDTH means the placement and the number of cards that fit are both
     stale, so rebuild. Measured 2026-09-22 in test mode: the bar window went 1282 -> 1106 css px
     wide AFTER the flyout had been placed (the sidecar's move of the window landed late), which
     left the flyout hanging off the right edge. */
  window.addEventListener('resize', function () {
    if (!fly || !fly.ready) return;
    if (window.innerWidth !== fly.iw) flyRebuild();
    else flyQueueSync();
  });
  /* The pill's own movement (its entrance, or re-centring after the window changed width) moves the
     icons: put the flyout back over its icon, then re-send the boxes. Measured 2026-09-22 in test
     mode: placed mid-transition, the flyout sat 41 css px to the right of its icon. */
  el.bar.addEventListener('transitionend', function (ev) {
    if (ev.target !== el.bar || !fly || !fly.ready || !isFlyKey(popKey)) return;
    if (fly.cell && fly.cell.isConnected) popPlace(fly.cell);
    flyQueueSync();
  });

  function flyBuild(pop, b, it, by) {
    var wins = winsOf(it);
    fly = { key: popKeyOf(b), cell: b, by: by, gen: ++flyGen, sig: winSig(wins), ready: false, iw: window.innerWidth };
    b._fly = true;
    if (b.title) b.title = '';          // see updateCell: no tooltip window over the previews
    pop.classList.add('fly');

    /* As many full-size cards as fit across the bar window; past that they shrink, and past the
       smallest useful size the flyout falls back to the list of titles -- a row of postage
       stamps would be a picture of nothing, and a row that ran off the window would hide
       windows without saying so. */
    var avail = window.innerWidth - 16 - 2 * 9;   // .pop's 8px inset each side, its padding and border
    var n = wins.length, sw = SHOT_W;
    function need(w) { return n * (w + 2 * CARD_PAD) + (n - 1) * CARD_GAP; }
    while (sw > SHOT_MIN_W && need(sw) > avail) sw -= 8;
    if (need(sw) > avail) {
      flyList(pop, it, n + ' windows are too many to preview side by side in this bar, so this is the list');
      return;
    }
    var sh = Math.round(sw * SHOT_H / SHOT_W);
    var row = document.createElement('div');
    row.className = 'fly-row';
    wins.forEach(function (w) { row.appendChild(flyCard(w, it, sw, sh)); });
    pop.appendChild(row);
  }

  function flyCard(w, it, sw, sh) {
    var title = w.title || '(untitled window)';
    var card = document.createElement('div');
    card.className = 'card' + (isActive(w) ? ' on' : '') + (w.minimized ? ' min' : '');
    card.dataset.hwnd = String(w.hwnd);
    // A FIXED width (border-box): left to itself a card is as wide as its title's max-content,
    // and one long window title would push the row past the window's edge.
    card.style.width = (sw + 2 * CARD_PAD) + 'px';

    var head = document.createElement('div'); head.className = 'card-head';
    var ico = document.createElement('span'); ico.className = 'card-ico';
    if (it.icon) {
      var img = document.createElement('img'); img.alt = '';
      img.onerror = function () { ico.className = 'card-ico tile'; ico.textContent = letterOf(it.name || title); };
      img.src = it.icon;
      ico.appendChild(img);
    } else {
      ico.className = 'card-ico tile';
      ico.textContent = letterOf(it.name || title);
    }
    // the full title on the TITLE only: a tooltip anywhere else would open over the picture
    var name = document.createElement('span'); name.className = 'card-title'; name.textContent = title;
    name.title = title + (w.minimized ? '\n(minimized)' : '');
    var x = document.createElement('button');
    x.type = 'button'; x.className = 'x'; x.title = 'Close this window'; x.textContent = '×';
    head.appendChild(ico); head.appendChild(name); head.appendChild(x);

    // The box DWM draws into. Until main answers it says what is happening; if main answers
    // without a picture it says why. It is never an unexplained grey rectangle.
    var shot = document.createElement('div'); shot.className = 'card-shot';
    shot.style.width = sw + 'px'; shot.style.height = sh + 'px';
    var why = document.createElement('span'); why.className = 'card-why';
    why.textContent = 'asking Windows for a live picture…';
    shot.appendChild(why);

    card.appendChild(head); card.appendChild(shot);

    card.addEventListener('click', function (ev) {
      if (ev.target.closest && ev.target.closest('.x')) return;
      closePop();
      // the one you are in minimises, like clicking its taskbar icon; any other one comes forward
      act('bar.window', { hwnd: w.hwnd, action: isActive(w) ? 'toggle' : 'focus' }, 'window');
    });
    x.addEventListener('click', function (ev) {
      ev.stopPropagation();
      flyClose(card, w, why, x);
    });
    return card;
  }

  /* The X: ask the WINDOW to close (WM_CLOSE), and keep the flyout up the way Windows does, so the
     card goes when the window actually goes (the windows push rebuilds the flyout). A window that
     answers with a "save changes?" prompt stays open: its card says "still open" and its live
     picture shows the prompt. A close the sidecar REFUSED is held in words (.held): the picture
     comes off so the reason can be read. */
  function flyClose(card, w, why, x) {
    x.disabled = true;
    card.classList.add('closing');
    callR('bar.window', { hwnd: w.hwnd, action: 'close' }).then(function () {
      clearFail('act');
      setTimeout(function () {
        if (!card.isConnected || card.classList.contains('gone')) return;
        card.classList.remove('closing');
        card.classList.add('stillopen');
        x.disabled = false;
      }, 4000);
    }, function (e) {
      card.classList.remove('closing', 'live');
      card.classList.add('fail', 'held');
      x.disabled = false;
      fail('act', 'close failed', 'bar.window close was refused: ' + msg(e), 'warn');
      why.textContent = 'not closed: ' + msg(e);
      flyQueueSync();   // resend without this card, so main takes its picture off the words
    });
  }

  /* Send main the box of every card that should carry a picture: all of them except a window
     that has gone and a card held in words (above). A card whose picture failed IS sent again,
     so a failure that was only momentary heals on the next resize or rebuild. */
  function flySync() {
    if (!fly || !fly.ready || !isFlyKey(popKey)) return;
    if (window.innerWidth !== fly.iw) { flyRebuild(); return; }   // see the resize listener
    var gen = fly.gen, items = [], vh = window.innerHeight, vw = window.innerWidth;
    var cards = el.pop.querySelectorAll('.card');
    for (var i = 0; i < cards.length; i++) {
      var c = cards[i];
      if (c.classList.contains('gone') || c.classList.contains('held')) continue;
      var r = c.querySelector('.card-shot').getBoundingClientRect();
      /* A box outside the window cannot carry a picture (DWM would draw it over the bar or off
         the window). It says so, and the next resize -- the room still arriving -- asks again. */
      if (r.top < 0 || r.left < 0 || r.bottom > vh + 1 || r.right > vw + 1) {
        c.classList.remove('live');
        c.classList.add('fail');
        c.querySelector('.card-why').textContent = 'no live picture yet: this card is outside the bar window, which is still being resized';
        continue;
      }
      items.push({ hwnd: c.dataset.hwnd, x: r.left, y: r.top, w: r.width, h: r.height });
    }
    call('bar.thumbs', { items: items, dpr: window.devicePixelRatio || 1 }).then(function (res) {
      if (fly && fly.gen === gen) flyPaint(res);
    }, function (e) {
      if (fly && fly.gen === gen) flyPaint({ ok: false, reason: 'no live picture: bar.thumbs was refused: ' + msg(e), thumbs: [] });
    });
  }

  function flyPaint(res) {
    var by = Object.create(null);
    ((res && res.thumbs) || []).forEach(function (t) { by[String(t.hwnd)] = t; });
    var cards = el.pop.querySelectorAll('.card');
    for (var i = 0; i < cards.length; i++) {
      var c = cards[i], t = by[c.dataset.hwnd];
      if (!t) continue;                                  // not sent (gone, or held in words)
      var why = c.querySelector('.card-why');
      c.classList.toggle('live', !!t.ok);
      c.classList.toggle('fail', !t.ok);
      if (t.gone) c.classList.add('gone');
      why.textContent = t.ok ? '' : (t.reason || (res && res.reason) || 'no live picture, and Mantle was not told why');
    }
    if (res && res.ok === false && res.reason && !Object.keys(by).length) {
      // refused before any card was looked at: every box says it
      for (var j = 0; j < cards.length; j++) {
        cards[j].classList.add('fail');
        cards[j].querySelector('.card-why').textContent = res.reason;
      }
    }
  }

  /* main dropped the pictures of windows that just closed; say so in their cards at once (the
     rebuild follows with the next pinned push, a few hundred ms later) */
  on('bar.thumbs.gone', function (p) {
    if (!fly || !p || !Array.isArray(p.hwnds)) return;
    p.hwnds.forEach(function (h) {
      var c = el.pop.querySelector('.card[data-hwnd="' + String(h).replace(/[^0-9]/g, '') + '"]');
      if (!c) return;
      c.classList.remove('live', 'closing');
      c.classList.add('gone');
      c.querySelector('.card-why').textContent = 'this window has closed';
    });
  });

  /* The pinned list was pushed again. Same windows: update titles and the active mark in place,
     no rebuild, no flicker. Different windows: rebuild the flyout where it stands. No windows left:
     close it. */
  function flyRefresh() {
    if (!fly || !isFlyKey(popKey)) return;
    var b = cells[popKey.slice(4)];
    var wins = b ? winsOf(b._item) : [];
    if (!b || !wins.length) { closePop(); return; }
    if (winSig(wins) === fly.sig) {
      wins.forEach(function (w) {
        var c = el.pop.querySelector('.card[data-hwnd="' + String(w.hwnd).replace(/[^0-9]/g, '') + '"]');
        if (!c) return;
        var t = w.title || '(untitled window)';
        var n = c.querySelector('.card-title');
        if (n && n.textContent !== t) { n.textContent = t; c.title = t + (w.minimized ? '\n(minimized)' : ''); }
        c.classList.toggle('on', isActive(w));
        c.classList.toggle('min', !!w.minimized);
      });
      return;
    }
    flyRebuild();
  }

  /* Build the open flyout again where it stands (its windows changed, or the bar window changed
     width). Same key, same owner; openPop's swap path keeps the window grown. */
  function flyRebuild() {
    if (!fly || !isFlyKey(popKey)) return;
    var b = cells[popKey.slice(4)];
    if (!b || !winsOf(b._item).length) { closePop(); return; }
    var by = fly.by;
    openPop(popKey, b, function (pop) { flyBuild(pop, b, b._item, by); }, { swap: true, rebuild: true })
      .then(function () { flyRoomReady(popKeyOf(b)); });
  }

  /* The fallback for more windows than fit as pictures: the plain list of titles this popover
     was before it had previews, with the reason it is a list on top. */
  function flyList(pop, it, why) {
    pop.classList.add('list');
    var h = document.createElement('h3');
    h.textContent = it.name || it.exe || 'windows';
    pop.appendChild(h);
    var note = document.createElement('div');
    note.className = 'sub';
    note.textContent = why;
    pop.appendChild(note);
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
      x.type = 'button'; x.className = 'x'; x.title = 'Close this window'; x.textContent = '×';
      x.addEventListener('click', function () {
        closePop();
        act('bar.window', { hwnd: w.hwnd, action: 'close' }, 'window');
      });
      row.appendChild(open); row.appendChild(x);
      pop.appendChild(row);
    });
  }

  /* LEFT CLICK = Windows 11's own semantics, and main decides which one applies: focus a window,
     minimize the one that is already focused, launch the app if it is not running — or, when
     there are two or more windows, hand the decision back with action:'list', because only the
     renderer can put a popover under the icon that was clicked. */
  el.dock.addEventListener('click', function (ev) {
    var b = cellOf(ev);
    if (!b) return;
    b._noFly = true;                 // no dwell-opened flyout on the icon just clicked, until the pointer leaves it
    if (flyDwell) { clearTimeout(flyDwell); flyDwell = 0; }
    /* The HOVER flyout for this icon is already showing the previews. Two or more windows: that
       is exactly what the click would open, so the click just keeps it (it stops closing on
       leave). One window: fall through, and the click does what it always did. */
    if (fly && popKey === popKeyOf(b) && fly.by === 'hover') {
      if (winsOf(b._item).length >= 2) { fly.by = 'click'; return; }
      closePop();
    } else {
      /* Clicking the icon whose list is already open just closes it (closePop() below clears popKey,
         so the toggle has to be read first). */
      var wasOpen = (popKey === popKeyOf(b));
      closePop();
      if (wasOpen) return;
    }
    act('bar.open', { id: b.dataset.id }, 'open').then(function (r) {
      if (r && r.action === 'list') openAppPop(b, b._item);
      fellBack(r);
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
    act('bar.open', { id: b.dataset.id, fresh: true }, 'open').then(fellBack);
  });

  /* Mantle Settings / Task Manager / Files could not open (off, resting for a game): main opened WINDOWS'
     own instead and says why (r.fellBack); the Settings links (gear, Energy saver, tiles, Quick Settings) too. Said on the strip for a few seconds, never swallowed. */
  var fellBackTimer = 0;
  function fellBack(r) {
    if (!r || !r.fellBack) return;
    fail('fellback', String(r.reason || 'opened Windows\' own').split(':')[0], String(r.fellBack), '');
    clearTimeout(fellBackTimer);
    fellBackTimer = setTimeout(function () { clearFail('fellback'); }, 8000);
  }

  /* RIGHT CLICK = Windows 11's taskbar menu (lane jumplist, 2026-09-24; Owen: "right click the apps
     on the taskbar and have the same options regular windows shows"): the app's jump list, the app
     itself, Pin/Unpin, Close (ui/bar/jumplist.js). Hover keeps the window previews. Without that
     module it is the window flyout as before; switched off in the tray, the menu keeps its own
     rows and says the list is off. */
  var JL = window.MantleJumpList || null;
  function jlKey(b) { return 'jl:' + b.dataset.key; }
  function openJump(b) {
    var it = b._item;
    openPop(jlKey(b), b, function (pop) {
      JL.open(pop, it, {
        call: call, callR: callR, msg: msg,
        resize: function () {
          if (popKey !== jlKey(b)) return;
          callR('bar.popover', { open: true, height: popNeed(), key: popKey }).catch(function () {});
          popPlace(b);
        },
        close: closePop,
        refreshPinned: refreshPinned,
        // pinned: the pin's own shortcut, like a middle-click; running only: the shortcut Windows would use
        openFresh: function (item, app) {
          // (Mantle's own apps open through main too: a running-only one has no shortcut to start)
          return item.kind === 'pinned' || item.mantleApp ? callR('bar.open', { id: item.id, fresh: true })
            : callR('jumplist.open', { app: app, item: 'app' });
        },
      });
    });
  }
  el.dock.addEventListener('contextmenu', function (ev) {
    var b = cellOf(ev);
    if (!b) return;
    ev.preventDefault();
    if (flyDwell) { clearTimeout(flyDwell); flyDwell = 0; }
    if (JL && b._item) {
      if (popKey === jlKey(b)) { closePop(); return; }   // a second right-click closes it
      openJump(b);
      return;
    }
    if (fly && popKey === popKeyOf(b)) { fly.by = 'click'; return; }
    openAppPop(b, b._item);
  });

  /* TEST HOOK (--test only: main sends this only in test mode). Opens the flyout of the first
     running app whose name or exe contains `match`, through the same openFly the hover dwell uses,
     so a test run can photograph the real flyout without anyone's mouse moving. */
  on('bar.test.flyout', function (p) {
    var match = String((p && p.match) || '').toLowerCase();
    var keys = Object.keys(cells), hit = null;
    // the NAME first, then the exe: several apps can share an exe (every Electron app is electron.exe)
    ['name', 'exe'].forEach(function (field) {
      for (var i = 0; i < keys.length && !hit; i++) {
        var it = cells[keys[i]]._item;
        if (!it || !winsOf(it).length) continue;
        if (!match || String(it[field] || '').toLowerCase().indexOf(match) !== -1) hit = cells[keys[i]];
      }
    });
    if (!hit) { fail('flytest', 'no flyout', 'the test hook found no running app matching "' + match + '"', 'warn'); return; }
    openFly(hit, 'hover');
  });

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

  /* THE LIST (2026-09-22) comes from the sidecar's UI Automation tray (sidecar/TrayUia.cs):
     {id, title, icon, exe, promoted, clickable, reason}. Promoted icons are the ones on Windows'
     own taskbar and are the only ones UIA can click; HIDDEN ones (promoted:false) live in Windows'
     "show hidden icons" flyout, which does not exist until someone opens it on the real screen, so
     they cannot be clicked from here at all. They are not dropped: they are listed dimmed in the
     overflow menu (buildMorePop) with the sidecar's reason on hover, which names the Settings
     switch that makes them clickable. promoted:null means UIA was unavailable, so nothing is
     known to be clickable: those stay on the strip, dimmed, with that reason. Main has already
     left Mantle's own icon out (trayForBar in main.js). */
  var trayHidden = [];                  // promoted:false icons, for the overflow menu
  var traySig = null;

  function renderTray(list) {
    var unavailable = (state && state.tray && state.tray.status === 'unavailable') || trayThrew;
    /* applyState() calls this on every state push: rebuild only when what is drawn would change,
       so tray icons never blink (rule 3 at the top). */
    var sig = (unavailable ? 'U' : 'A') + '\u0001' + (list || []).map(function (it) {
      return [it.id, it.title, it.clickable, it.promoted, it.reason, (it.icon || '').length, (it.icon || '').slice(-24)].join('\u0002');
    }).join('\u0001');
    if (sig === traySig) return;
    traySig = sig;
    el.tray.textContent = '';
    trayHidden = [];
    if (unavailable) {
      /* Nothing on the strip: on this Windows build the notification area cannot be read at all
         (TrayNotifyWnd has no ToolbarWindow32), so a permanent chip would be noise, not news.
         The reason is still said somewhere: the overflow menu (buildMorePop) carries it. */
      layoutDock();
      return;
    }
    (list || []).forEach(function (it) {
      if (it.promoted === false) { trayHidden.push(it); return; }
      el.tray.appendChild(trayButton(it, function (reason) {
        fail('trayclick', 'can’t click ' + (it.title || 'that icon'), reason, 'warn');
      }));
    });
    layoutDock();
  }

  /* One tray icon as a button, on the strip or in the overflow. `onRefuse(reason)` is how the
     caller says "this one cannot be clicked" out loud; nothing is ever sent for such an icon. */
  function trayButton(it, onRefuse) {
    var b = document.createElement('button');
    b.type = 'button';
    var name = it.title || it.tooltip || it.id || 'tray icon';
    var can = it.clickable !== false;
    b.className = 'btn ti' + (can ? '' : ' off');
    b.title = can ? name : name + '\n\n' + (it.reason || 'Mantle cannot click this icon, and the sidecar did not say why');
    b.setAttribute('aria-label', name);
    if (!can) b.setAttribute('aria-disabled', 'true');
    var ico = document.createElement('span');
    ico.className = 'tico';
    b.appendChild(ico);
    if (it.icon) {
      var img = document.createElement('img'); img.alt = '';
      img.onerror = function () { ico.textContent = letterOf(name); ico.classList.add('letter'); };
      img.src = it.icon;
      ico.appendChild(img);
      toneOf(it.icon, function (tone, why) {
        if (tone === 'light') b.classList.add('light');
        if (why) b.title += '\n(its contrast could not be checked, so it is drawn as it came: ' + why + ')';
      });
    } else {
      ico.textContent = letterOf(name);
      ico.classList.add('letter');
    }
    b.addEventListener('click', function () {
      if (!can) { onRefuse(it.reason || 'Mantle cannot click ' + name + ', and the sidecar did not say why'); return; }
      act('tray.click', { id: it.id, button: 'left' }, 'tray');
    });
    b.addEventListener('contextmenu', function (ev) {
      ev.preventDefault();
      if (!can) { onRefuse(it.reason || 'Mantle cannot click ' + name + ', and the sidecar did not say why'); return; }
      act('tray.click', { id: it.id, button: 'right' }, 'tray');    // the sidecar says why menus are unreachable
    });
    return b;
  }

  /* WHITE TRAY ICONS (2026-09-22). Windows Update's and Tailscale's icons are drawn white, for
     Windows' DARK taskbar, and on this light glass they all but vanish. Each icon is measured once
     (cached by its data URL, so the 5 s tray poll costs nothing): the mean luminance of its pixels
     WEIGHTED BY ALPHA. Not "opaque pixels only": measured on Owen's tray the same day, Tailscale's
     disconnected icon is nine white dots with NO pixel above alpha 128, so an opaque-only mean saw
     nothing at all (alpha-weighted it is 1.00; Windows Update's restart icon 0.54, Lively 0.34,
     Windhawk 0.41, Windows Security 0.53). A light one sits on a small dark plate (bar.css .ti.light). A plate rather than
     tinting the icon dark, because a tint repaints EVERY pixel one colour: it would erase the
     coloured badge Windows Update puts on its icon when a restart is due, which is the part that
     carries the news. data: URLs never taint a canvas, so getImageData is allowed here. */
  var LIGHT_LUMA = 0.75;                // 0..1; a white glyph measures ~1.0, every coloured icon here 0.34-0.54
  var tones = Object.create(null);      // icon data URL -> {v, why}, or an array of waiters
  function toneOf(src, done) {
    var t = tones[src];
    if (t && !Array.isArray(t)) { done(t.v, t.why); return; }
    if (t) { t.push(done); return; }
    tones[src] = [done];
    var img = new Image();
    function settle(v, why) {
      var waiters = tones[src];
      tones[src] = { v: v, why: why || null };
      (Array.isArray(waiters) ? waiters : []).forEach(function (f) { try { f(v, why || null); } catch (e) { /* one caller's bug is not another's */ } });
    }
    img.onload = function () {
      var v = 'normal', why = null;
      try {
        var w = img.naturalWidth || 16, h = img.naturalHeight || 16;
        var c = document.createElement('canvas'); c.width = w; c.height = h;
        var g = c.getContext('2d', { willReadFrequently: true });
        g.drawImage(img, 0, 0);
        var d = g.getImageData(0, 0, w, h).data, cover = 0, sum = 0;
        for (var i = 0; i < d.length; i += 4) {
          var a = d[i + 3] / 255;
          cover += a;
          sum += a * (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
        }
        if (cover >= 6 && sum / cover > LIGHT_LUMA) v = 'light';
      } catch (e) {
        why = msg(e);
      }
      settle(v, why);
    };
    img.onerror = function () { settle('normal'); };   // the <img> itself falls back to a letter
    img.src = src;
  }
  var trayThrew = '';

  /* ================================================================= popovers */

  var popKey = null, popTimer = 0;
  var popLast = null;   // the open popover's last room request {key, asked} and main's answer {room, max}

  /* ROOM (2026-09-27): main gives a popover at most POPOVER_MAX (its reply's `max`). A panel taller
     than that used to be cut off by the window's edge with no word (the live log had Quick Settings
     asking up to 618 px of a 480 cap). Now it is held to the room it got and scrolls, and a line at
     its top says why. The flyouts are left alone: their live previews are DWM boxes placed over the
     page, and a scrolling flyout would slide its cards out from under them. */

  /* What the popover needs, as the bar.popover height: its NATURAL height (not the capped box,
     and not counting the cap's own note) plus the 16 main has always been asked for. */
  function popNeed() {
    var p = el.pop, note = p.querySelector(':scope > .popcap');
    if (!p.style.maxHeight && !note) return p.offsetHeight + 16;
    var mh = p.style.maxHeight, top = p.scrollTop;
    p.style.maxHeight = '';
    if (note) note.style.display = 'none';
    var h = p.offsetHeight;
    if (note) note.style.display = '';
    p.style.maxHeight = mh;
    p.scrollTop = top;
    return h + 16;
  }

  /* The sticky line at the popover's top: the cap, or a room request that failed. */
  function popNote(text, tip) {
    var note = el.pop.querySelector(':scope > .popcap');
    if (!text) { if (note) note.parentNode.removeChild(note); return; }
    if (!note) {
      note = document.createElement('div');
      note.className = 'note popcap';
      note.setAttribute('role', 'status');
    }
    if (el.pop.firstChild !== note) el.pop.insertBefore(note, el.pop.firstChild);
    note.textContent = text;
    note.title = tip || text;
  }

  function popUncap() {
    el.pop.classList.remove('popcapped');
    el.pop.style.maxHeight = '';
    popNote('');
  }

  /* Main's answer to a room request: fits, capped (scroll + say so), or the panel grew while the
     request was in flight and asks again. `r` is {height, total, capped, max} (main.js bar.popover). */
  function popFit(key, r) {
    if (!key || popKey !== key || isFlyKey(key) || el.pop.hidden || !r) return;
    var room = Math.round(Number(r.height)), max = Math.round(Number(r.max));
    if (!(room > 0) || !(max > 0)) return;   // an answer without its numbers: nothing to judge by
    if (popLast && popLast.key === key) { popLast.room = room; popLast.max = max; }
    var need = popNeed();
    if (need <= room) { popUncap(); return; }
    if (!r.capped && room < max) { popAsk(key, need); return; }   // it grew since it asked (or asked from a capped box)
    el.pop.classList.add('popcapped');
    el.pop.style.maxHeight = Math.max(80, room - 16) + 'px';
    popNote('Taller than the screen allows: scroll for the rest',
      'This panel needs ' + need + ' px and a popover gets at most ' + max + ' px (main.js POPOVER_MAX), so it scrolls');
  }

  function popAsk(key, need) {
    callR('bar.popover', { open: true, height: need, key: key }).catch(function (e) {
      if (popKey === key) popNote('This panel may be clipped: bar.popover — ' + msg(e));
    });
  }

  /* A panel that changes height after it opened (Quick Settings filling in, Game mode's Details, a
     note appearing) asks for its room again. A module that already asked for this height (qs-more,
     notifications, downloads, the jump list, the media card) is not asked for twice, and a panel
     already scrolling at the cap is not re-asked while it still does not fit. */
  function popResized() {
    if (!popKey || isFlyKey(popKey) || el.pop.hidden || !popLast || popLast.key !== popKey) return;
    var need = popNeed();
    if (need === popLast.asked) return;
    if (popLast.max && popLast.room >= popLast.max && need > popLast.max && el.pop.classList.contains('popcapped')) return;
    popAsk(popKey, need);
  }
  if (window.ResizeObserver) new ResizeObserver(popResized).observe(el.pop);

  function closePop() {
    if (!popKey) return;
    /* The quick-settings watch exists only for the open panel: leaving it on would have main
       pushing the whole system state at a closed popover every 2 seconds, on a bar whose entire
       point is that it costs nothing at rest. */
    if (popKey === 'qs') {
      qsPaint = null; qsWatch(false);
      if (window.MantleQsMore) MantleQsMore.closed();   // its polls stop and the keyboard goes back
      if (window.MantlePowerMode) MantlePowerMode.closed(); // its 3 s re-read and its push stop
      if (window.MantleGameMode) MantleGameMode.closed();   // its push subscription stops
      if (window.MantleTopbarHide) MantleTopbarHide.closed();
      if (window.MantleCorners) MantleCorners.closed();     // its push subscription stops
    }
    if (popKey === 'media') {
      mediaPaint = null; mediaNote = ''; mediaRoom = 0;
      if (window.MantleSpotify) MantleSpotify.closed();   // its 8 s queue refresh stops, the keyboard goes back
    }
    if (popKey.indexOf('jl:') === 0 && window.MantleJumpList) MantleJumpList.closed();   // gives the keyboard back
    if (popKey === 'dl' && window.MantleDownloads) MantleDownloads.closed();             // its 30 s age ticker stops
    if (isFlyKey(popKey)) flyTeardown();
    popKey = null;
    popLast = null;
    el.pop.hidden = true;
    el.pop.className = 'pop';          // drop any per-panel class (.cal, and .popcapped)
    el.pop.style.maxHeight = '';       // a cap belongs to the panel that was held to it
    el.pop.textContent = '';
    if (popTimer) { clearTimeout(popTimer); popTimer = 0; }
    call('bar.popover', { open: false }).catch(function () {});   // shrink request; failure is reported on open, not here
    // the leave that was suppressed while the popover held the bar open (see mouseleave)
    if (!pointerIn) hover(false);
  }

  /* Returns the bar.popover promise, so a popover that needs the grown window (the flyout's live
     previews measure their boxes in it) can wait for the room to be there. */
  function openPop(key, anchor, build, opts) {
    var o = opts || {};
    if (popKey === key && !o.rebuild) { closePop(); return Promise.resolve(null); }
    /* A flyout replacing a flyout (the pointer moved on to the next running icon, or that app's
       windows changed) keeps the window grown: closing first would shrink it and grow it straight
       back, a visible jump on every icon crossed. The one bar.popover call below resizes it only if
       the height changed, and main takes the old pictures down on that call. */
    if (o.swap && isFlyKey(popKey)) { flyTeardown(); el.pop.className = 'pop'; el.pop.style.maxHeight = ''; }
    else closePop();
    popKey = key;
    el.pop.textContent = '';
    // measured from the left edge: a stale left from the previous popover would squeeze this one
    el.pop.style.left = '8px';
    el.pop.hidden = false;
    build(el.pop);

    /* The bar window is only 48px tall, so a popover drawn here would be cut off by the window,
       not by CSS. Ask the main process for room. If that channel does not exist yet, SAY SO in
       the popover instead of letting it silently disappear off the edge of the window. A panel
       taller than the room main can give scrolls, and says so (callR -> popFit). */
    var h = popNeed();
    var room = callR('bar.popover', { open: true, height: h, key: key }).catch(function (e) {
      if (popKey !== key) return;
      var note = document.createElement('div');
      note.className = 'note';
      note.textContent = 'this popover may be clipped: bar.popover — ' + msg(e);
      el.pop.appendChild(note);
    });

    popPlace(anchor);
    return room;
  }

  /* Horizontal placement: centred under its button, clamped into the bar. Also run again for an
     open flyout when the pill finishes moving (see the .bar transitionend listener), because a
     button measured mid-transition puts the flyout beside its icon instead of over it. */
  function popPlace(anchor) {
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
    if (ev.target.closest && ev.target.closest('#volume, #network, #battery, #clock, #notifs, #downloads, #more, #media, .cell')) return;
    closePop();
  }, true);
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') { closePop(); return; }
    // the right-click menu's arrows / Enter / Right / Left (ui/bar/jumplist.js)
    if (popKey && popKey.indexOf('jl:') === 0 && window.MantleJumpList && MantleJumpList.key(ev)) ev.preventDefault();
  });

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

     Two surfaces Mantle does not fully replicate — the full quick-settings flyout and the notification
     centre (Mantle's own panel covers the list; see notifications.js) — are still Windows', and the bar asks the shell to press the key for it. Every panel
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
  /* A set that did not take, said IN the panel until that part is set again or the panel is
     rebuilt: part -> sentence. The state strip's chip is 56 px in pill mode; nobody reads it. */
  var qsNote = Object.create(null);
  /* part -> function saying whether the panel is holding that part: a set in flight, or a slider
     under the pointer. A push from main never moves a held part (the reply has the last word). */
  var qsHold = Object.create(null);

  function qsHeld(key) {
    if (key === 'volume' && (qsBusy.volume || qsBusy.mute)) return true;
    if (qsBusy[key]) return true;
    return !!(qsHold[key] && qsHold[key]());
  }

  /* The speaker glyph reads the same volume as the panel (0-100 there, 0-1 on vol). */
  function qsTakeVolume(v) {
    if (!v || v.ok === false || typeof v.level !== 'number') return;
    vol.level = v.level / 100; vol.muted = !!v.muted; vol.reason = '';
    volumeGlyph();
  }

  /* A whole picture from main (qs.get, or a push): every part not held takes it. */
  function qsTake(d) {
    if (!d || typeof d !== 'object') return;
    var next = Object.assign({}, d);
    if (qs) Object.keys(next).forEach(function (key) {
      if (qs[key] && typeof qs[key] === 'object' && qsHeld(key)) next[key] = qs[key];
    });
    qs = next;
    if (!qsHeld('volume')) qsTakeVolume(qs.volume);
  }

  function qsLabel(part) {
    return { wifi: 'Wi-Fi', bluetooth: 'Bluetooth', nightlight: 'Night light', brightness: 'Brightness',
      volume: 'Volume', mute: 'Mute' }[part] || part;
  }

  function qsPart(name) { return (qs && qs[name]) || null; }
  function partOk(p) { return !!(p && p.ok !== false); }
  function partWhy(p, what) {
    return (p && p.reason) || ('the shell gave no reason why ' + what + ' is unavailable');
  }

  function qsSnapshot() {
    return callR('qs.get').then(function (d) {
      qsTake(d); clearFail('qs');
      return d;
    }, function (e) {
      fail('qs', 'quick settings off', 'qs.get was refused, so the panel cannot read the system: ' + msg(e), 'warn');
      throw e;
    });
  }

  /* The watch is on ONLY while the panel is open: main then holds a lease on the sidecar's own
     watch, which pushes each part the moment it changes (2026-09-23; it was a 2 s re-read). */
  function qsWatch(on) {
    callR('qs.watch', { on: !!on }).then(function () { clearFail('qswatch'); }, function (e) {
      if (on) fail('qswatch', 'qs stale', 'qs.watch was refused, so the panel shows a snapshot and will not update itself: ' + msg(e));
    });
  }

  /* The reply is the part READ BACK after the set: `state` is the whole part as qs.get shows it
     (so its reason and, for Wi-Fi, the network come with it), `value` the one level or switch in
     the units it was set in. Until 2026-09-23 main sent the whole part as `value` and this wrote
     that object into .level, so the slider's number read '—' until the next push. A level that
     is not a number is not written at all. */
  function qsApplyReply(r) {
    if (!r || !r.part || !qs) return;
    var key = r.part === 'mute' ? 'volume' : r.part;
    if (!qs[key]) return;
    if (r.state && typeof r.state === 'object') qs[key] = Object.assign({}, r.state);
    else {
      var v = r.value;
      if ((r.part === 'volume' || r.part === 'brightness') && typeof v === 'number') qs[key].level = v;
      else if (r.part === 'mute') qs.volume.muted = !!v;
      else if (r.part === 'wifi' || r.part === 'bluetooth') qs[key].on = !!v;
    }
    if (key === 'volume') qsTakeVolume(qs.volume);       // the readout's glyph too
  }

  /* A SET, OPTIMISTICALLY (2026-09-23). Owen: "be way more responsive". A tile waited for the
     reply before it changed at all: 260-510 ms for a Wi-Fi or Bluetooth radio under load
     (measured), long enough to click again. Now `guess` changes the part on screen in the same
     frame and the tile shows pending; the reply - the part READ BACK from Windows - has the last
     word. A switch Windows refused springs back AND its reason is written in the panel. */
  function qsSet(part, value, guess) {
    var key = part === 'mute' ? 'volume' : part;
    if (guess && qs && qs[key]) {
      qs[key] = Object.assign({}, qs[key]);
      guess(qs[key]);
      if (key === 'volume') qsTakeVolume(qs.volume);
    }
    qsBusy[part] = (qsBusy[part] || 0) + 1;
    delete qsNote[key];
    if (qsPaint) qsPaint();
    function settle() {
      qsBusy[part] = Math.max(0, (qsBusy[part] || 0) - 1);
      if (!qsBusy[part]) delete qsBusy[part];
    }
    return call('qs.set', { part: part, value: value }).then(function (r) {
      settle();
      if (!r || typeof r !== 'object') r = { ok: false, part: part, reason: 'qs.set answered with nothing' };
      if (r.state) qsApplyReply(r);           // the read-back, not the click
      if (r.ok === false) {
        qsNote[key] = part === 'bluetooth' && window.MantleBt && MantleBt.refusedNote
          ? MantleBt.refusedNote(r.reason, value) : qsWhy(part, r.reason);
        fail('qsset', part + ' failed', 'qs.set ' + part + ' was refused: ' + (r.reason || 'no reason given'), 'warn');
        // no read-back came with it (an unknown part, a bad value): what the system says, again
        if (!r.state) qsSnapshot().then(qsRepaint, qsRepaint);
      } else clearFail('qsset');
      qsRepaint();
      return r;
    }, function (e) {
      settle();
      qsNote[key] = qsWhy(part, msg(e));
      fail('qsset', part + ' failed', 'qs.set ' + part + ' was refused: ' + msg(e), 'warn');
      qsSnapshot().then(qsRepaint, qsRepaint); // the guess is undone by what the system says
      qsRepaint();
      return { ok: false, part: part, reason: msg(e) };
    });
  }

  function qsRepaint() { if (popKey === 'qs' && qsPaint) qsPaint(); }

  /* "<Part> did not change: <why>" - unless the reason already names the part, as main's own
     refusals do ("Night light could not be changed: ..."), which read doubled in a --test run. */
  function qsWhy(part, reason) {
    var label = qsLabel(part), why = reason || 'no reason was given';
    return why.toLowerCase().indexOf(label.toLowerCase()) === 0 ? why : label + ' did not change: ' + why;
  }

  /* The Bluetooth tile's words and what a click does (bt.js tile). bt.js is loaded before this
     file; if it ever is not, the tile says so rather than the panel throwing. */
  function btTile(b) {
    if (window.MantleBt && MantleBt.tile) return MantleBt.tile(b);
    return { sub: 'Unavailable', tip: 'Bluetooth: bt.js did not load, so the tile cannot be drawn',
             on: false, live: false, open: null, glyph: 'rune' };
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
    /* bar.css has sized this panel as .pop.qs (min-width 268, alongside .cal) since it was
       written, but nothing ever added the class; closePop resets it with every other one. */
    pop.classList.add('qs');
    var tiles = {}, notes = document.createElement('div'), sliders = {};

    qsNote = Object.create(null);             // a new panel starts with nothing to apologise for
    var grid = document.createElement('div'); grid.className = 'qsgrid';
    [['wifi', 'Wi-Fi'], ['bluetooth', 'Bluetooth'], ['nightlight', 'Night light'], ['saver', 'Energy saver']]
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

    /* A click on a switch ALWAYS does something visible: it switches (at once, pending until
       Windows answers), or - when the part cannot be switched - it says why in the panel. It used
       to return silently when the panel had no reading yet. A dead part's reason is already a
       note line and its tooltip; a click on it adds nothing, and does not pretend to try. */
    function toggle(key) {
      return function () {
        var p = qsPart(key);
        if (!p) {
          qsNote[key] = qsLabel(key) + ' is still being read, so it cannot be switched yet';
          paint();
          qsSnapshot().then(qsRepaint, qsRepaint);
          return;
        }
        if (!partOk(p) || p.present === false || qsBusy[key]) return;
        var want = !p.on;
        qsSet(key, want, function (part) {
          part.on = want;
          if (key === 'wifi' && !want) { part.connected = false; }
        });
      };
    }
    tiles.wifi.b.addEventListener('click', toggle('wifi'));
    /* Bluetooth (2026-09-27): a radio Mantle cannot switch (none, disabled, access denied, not
       readable) opens Windows' own page for it rather than doing nothing; one still being read
       says so. bt.js tile() decides which. */
    tiles.bluetooth.b.addEventListener('click', function () {
      var p = qsPart('bluetooth'), t = btTile(p);
      if (!t.live && t.open) { closePop(); act('open', { target: t.open.target }, t.open.what).then(fellBack); return; }
      if (p && !t.live && !qsBusy.bluetooth) { qsNote.bluetooth = t.tip.split('\n')[0]; paint(); return; }
      toggle('bluetooth')();
    });
    tiles.nightlight.b.addEventListener('click', toggle('nightlight'));
    /* ENERGY SAVER has no switch another app may use (powrprof.dll exports only the power-mode
       overlay; checked 2026-09-23), so the tile shows the state and opens Windows' own page. It
       used to be a dead tile that did nothing at all when clicked. */
    tiles.saver.b.addEventListener('click', function () {
      closePop();
      act('open', { target: 'ms-settings:batterysaver' }, 'energy saver settings').then(fellBack);
    });

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
      /* Whole percentages, 0-100: the scale qs.set and the sidecar take. These divided by 100
         until 2026-09-23, the sidecar rounded 0.42 to 0, and a drag set Windows to 0-1 %.
         THE SENDER (qs-send.js): one set in flight, only the newest value waiting, the last one
         always sent - so the system follows the pointer as fast as it can answer and never
         replays a stale level after the pointer stops. While the slider is held (dragged, or a
         set in flight), nothing but the pointer moves it or its number. */
      var sl = { wrap: wrap, range: range, val: val, line: line, part: part, dragging: false };
      sl.send = window.MantleQsSend
        ? MantleQsSend.sender(function (v) {
            return qsSet(setPart, v, function (p) { p.level = v; });
          }, { minGapMs: 16, onIdle: function () { qsRepaint(); } })
        : { push: function (v) { qsSet(setPart, v, function (p) { p.level = v; }); }, busy: function () { return false; } };
      qsHold[part] = function () { return sl.dragging || sl.send.busy(); };
      range.addEventListener('pointerdown', function () { sl.dragging = true; });
      var letGo = function () { if (sl.dragging) { sl.dragging = false; qsRepaint(); } };
      window.addEventListener('pointerup', letGo);
      window.addEventListener('pointercancel', letGo);
      range.addEventListener('input', function () {
        var v = Number(range.value);
        val.textContent = v + '%';
        if (setPart === 'volume') { vol.level = v / 100; volumeGlyph(); }
        sl.send.push(v);
      });
      range.addEventListener('change', function () { sl.send.push(Number(range.value)); });
      sliders[key] = sl;
      return sl;
    }

    slider('brightness', 'Brightness', 'brightness', 'brightness');
    var v = slider('volume', 'Volume', 'volume', 'volume');
    var mute = document.createElement('button');
    mute.type = 'button'; mute.className = 'qsmute';
    mute.addEventListener('click', function () {
      var p = qsPart('volume');
      if (qsBusy.mute) return;
      var want = !(p && p.muted);
      qsSet('mute', want, function (part) { part.muted = want; });
    });
    v.line.appendChild(mute);
    v.mute = mute;

    notes.className = 'qsnotes';
    pop.appendChild(notes);

    /* POWER MODE (osd lane, 2026-09-24): Best power efficiency / Balanced / Best performance, the
       panel's optimistic pattern with the read-back deciding (ui/bar/powermode.js). Muted with its
       reason when Windows would not apply it (any plan but Balanced). */
    if (window.MantlePowerMode) MantlePowerMode.attach(pop, { call: call, on: on }, notes);
    else fail('powermode', 'power mode missing', 'ui/bar/powermode.js did not load, so quick settings has no power-mode switch', 'warn');
    /* GAME MODE (lane gamemode, 2026-09-25): on/off, what it did and did not do, and why (ui/bar/gamemode.js). */
    if (window.MantleGameMode) MantleGameMode.attach(pop, { call: call, on: on }, notes);
    else fail('gamemode', 'game mode missing', 'ui/bar/gamemode.js did not load, so quick settings has no Game mode tile', 'warn');
    /* TOP BAR (lane tbvideo, 2026-09-26): hide / show it by hand, and "Hidden · Win+Alt+T to show" while it is (ui/bar/topbarhide.js). */
    if (window.MantleTopbarHide) MantleTopbarHide.attach(pop, { call: call, on: on }, notes);
    else fail('topbarhide', 'top bar row missing', 'ui/bar/topbarhide.js did not load, so quick settings cannot show a hidden top bar again (Win+Alt+T still does)', 'warn');
    /* HOT CORNERS (lane corners, 2026-09-27): what each screen corner does (ui/bar/corners.js); its choices open below the grid, so it asks for room again. */
    if (window.MantleCorners) MantleCorners.attach(pop, { call: call, on: on, resize: function () {
      if (popKey === 'qs') callR('bar.popover', { open: true, height: popNeed(), key: 'qs' }).catch(function (e) {
        if (popKey === 'qs') popNote('This panel may be clipped: bar.popover — ' + msg(e));
      });
    } }, notes);
    else fail('corners', 'hot corners row missing', 'ui/bar/corners.js did not load, so quick settings cannot change what the screen corners do', 'warn');

    var foot = document.createElement('div'); foot.className = 'qsfoot';
    var power = document.createElement('div'); power.className = 'qspower';
    var acts = document.createElement('div'); acts.className = 'qsacts';
    var toWin = document.createElement('button');
    toWin.type = 'button'; toWin.className = 'qslink';
    toWin.textContent = 'Windows quick settings';
    // Plain words, and short: the old "Open the real Windows flyout (Win+A) — everything Mantle does
    // not wrap yet" was jargon, and three lines in the 160 px beside the link, so under a power-mode
    // warning its tip had nowhere to go but out of the panel (tips.js, headless 2026-09-25).
    toWin.title = "Open Windows' own quick settings (Win+A)";
    toWin.addEventListener('click', function () { closePop(); keys('win+a', 'quick settings'); });
    var gear = document.createElement('button');
    gear.type = 'button'; gear.className = 'qsgear';
    gear.title = 'Open Windows Settings';
    gear.innerHTML = svg('<path d="M8 5.6A2.4 2.4 0 1 0 8 10.4 2.4 2.4 0 0 0 8 5.6z" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M8 1.6l1 1.7 2-.3.5 1.9 1.8.9-.9 1.8.9 1.8-1.8.9-.5 1.9-2-.3-1 1.7-1-1.7-2 .3-.5-1.9-1.8-.9.9-1.8-.9-1.8 1.8-.9.5-1.9 2 .3z" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/>');
    // Mantle Settings Home (main.js 'open' -> lib/open-route.js); Windows' only when Mantle's is off, said via fellBack
    gear.addEventListener('click', function () { closePop(); act('open', { target: 'ms-settings:' }, 'settings').then(fellBack); });
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

      // ---- Bluetooth: its words are bt.js tile() (2026-09-27: an OFF radio read "No radio" and
      // the tile went dead). A radio Mantle cannot switch still clicks: it opens Settings.
      var bt = btTile(b);
      paintTile('bluetooth', bt.on, true, bt.live || !!bt.open, bt.sub, bt.tip,
        bt.glyph === 'none' ? svg(MantleBt.NO_BT) : BT_GLYPH, false);
      if (!partOk(b)) problems.push('Bluetooth: ' + partWhy(b, 'Bluetooth'));

      // ---- Night light (a switch since 2026-09-23: Display.SetNightLight)
      paintTile('nightlight', n && n.on, !n || n.present !== false, partOk(n),
        !n ? 'Unknown' : !partOk(n) ? 'Unavailable' : n.present === false ? 'Not set up' : (n.on ? 'On' : 'Off'),
        !partOk(n) ? 'Night light — ' + partWhy(n, 'night light')
          : n && n.present === false ? 'Night light — ' + partWhy(n, 'night light')
          : 'Turn night light ' + (n && n.on ? 'off' : 'on'),
        MOON_GLYPH, false);
      if (!partOk(n)) problems.push('Night light: ' + partWhy(n, 'night light'));

      // ---- Energy saver: its state, and a click opens Windows' own switch for it
      paintTile('saver', p && p.saver, !!p, partOk(p),
        !p ? 'Unknown' : !partOk(p) ? 'Unavailable' : (p.saver ? 'On' : 'Off') + ' \u00b7 Settings',
        !partOk(p) ? 'Energy saver — ' + partWhy(p, 'energy saver')
          : 'Energy saver is ' + (p && p.saver ? 'on' : 'off') + '.\nWindows lets only its own Settings switch it: click to open that page',
        SAVER_GLYPH, false);
      if (!partOk(p)) problems.push('Power: ' + partWhy(p, 'power'));

      // ---- sliders
      /* A HELD slider (under the pointer, or a set in flight) keeps the pointer's value and its
         number: a reading that crosses the drag is older than the pointer. It used to test
         document.activeElement, which a focusable:false bar window never reliably sets, and
         rewrote the number on every push regardless. */
      function paintSlider(s, part, pct, ok, present, why) {
        var live = ok && present;
        var held = qsHeld(part);
        s.range.disabled = !live;
        s.wrap.classList.toggle('dead', !live);
        if (!held && typeof pct === 'number') s.range.value = String(Math.round(pct));
        if (!held || !live) s.val.textContent = live ? (typeof pct === 'number' ? Math.round(pct) + '%' : '—') : 'unavailable';
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

      // ---- footer power line: the readout's own reading and words (battery.js), so the two can
      // never disagree on screen. It used to word the `power` part for itself, and said "Plugged
      // in · 72%" beside a readout drawing a bolt from a different, older number (2026-09-23).
      // The whole sentence is its tooltip: the line is one row and ellipsizes.
      var bd = battNow ? battDescribe(battNow) : p ? battDescribe(partOk(p) ? p : { ok: false, reason: partWhy(p, 'power') }) : null;
      power.textContent = bd ? bd.footer : 'Battery state unknown';
      power.title = bd ? bd.tip.replace(/\nClick: quick settings$/, '') : '';
      if (bd && (bd.state === 'error' || bd.state === 'unknown') && partOk(p)) problems.push('Battery: ' + bd.reason);

      // ---- a set that did not take, until that part is set again
      Object.keys(qsNote).forEach(function (k) { problems.push(qsNote[k]); });

      // ---- the notes: one line per part that is not ok, never a blank tile with no explanation
      notes.textContent = '';
      problems.forEach(function (text) {
        var d = document.createElement('div'); d.className = 'note'; d.textContent = text;
        notes.appendChild(d);
      });
    }

    // The three '>' buttons (Wi-Fi networks; Bluetooth devices; sound output and mixer) and their views: ui/bar/qs-more.js
    if (window.MantleQsMore) MantleQsMore.attach(pop, { wifiTile: tiles.wifi.b, btTile: tiles.bluetooth.b, volumeLine: v.line, repaint: paint });
    qsPaint = paint;
    paint();                                    // draw from whatever we already know, immediately
    qsSnapshot().then(function () { if (popKey === 'qs') paint(); },
      function () { if (popKey === 'qs') paint(); });
    qsWatch(true);
  }

  function openQs(anchor) { openPop('qs', anchor || el.right, buildQsPop); }
  /* A HOT CORNER set to Quick settings (lib/features/corners.js): open it (or close it, like Win+A
     twice) and answer, so a panel that did not open is a failure with a reason on the corner. */
  on('corners.qs', function (p) {
    var seq = p && p.seq;
    try {
      var was = popKey === 'qs';
      if (was) closePop(); else openQs();
      call('corners.ack', { seq: seq, ok: true, closed: was }).catch(function () {});
    } catch (e) {
      call('corners.ack', { seq: seq, ok: false, reason: 'the bar could not open it: ' + msg(e) }).catch(function () {});
    }
  }, function () { /* no feature seam: nothing sends it */ });

  el.volume.addEventListener('click', function () { openQs(el.volume); });
  el.network.addEventListener('click', function () { openQs(el.network); });
  el.battery.addEventListener('click', function () { openQs(el.battery); });
  /* THE SPEAKER, ANDROID-STYLE (osd lane, 2026-09-24). Owen: "can you make it so that i can adjust
     volumes of different apps like the android feature". Right- or middle-click opens the pop-up's
     per-app panel (every app playing sound, each with its slider and mute: ui/osd/); the wheel
     over the speaker changes the master volume 2 a notch, with the pop-up showing it. If the pop-up
     feature is off or down, right-click falls back to the quick-settings panel and says why. */
  function openMixer() {
    closePop();
    callR('osd.mixer').then(function () { clearFail('osdmixer'); }, function (e) {
      fail('osdmixer', 'app volumes', 'the per-app volume panel did not open (' + msg(e) + '), so quick settings opened instead', 'warn');
      openQs(el.volume);
    });
  }
  el.volume.addEventListener('contextmenu', function (ev) { ev.preventDefault(); openMixer(); });
  el.volume.addEventListener('auxclick', function (ev) { if (ev.button === 1) { ev.preventDefault(); openMixer(); } });
  el.volume.addEventListener('mousedown', function (ev) { if (ev.button === 1) ev.preventDefault(); });  // no autoscroll
  var wheelTarget = null, wheelIdle = 0;
  var wheelSend = window.MantleQsSend
    ? MantleQsSend.sender(function (v) { return call('qs.set', { part: 'volume', value: v }); },
        { minGapMs: 16, onIdle: function () { clearTimeout(wheelIdle); wheelIdle = setTimeout(function () { wheelTarget = null; }, 400); } })
    : { push: function (v) { call('qs.set', { part: 'volume', value: v }); }, busy: function () { return false; } };
  el.volume.addEventListener('wheel', function (ev) {
    ev.preventDefault();
    if (vol.level === null && wheelTarget === null) return;      // nothing read yet: the glyph's tooltip says why
    var base = wheelTarget !== null ? wheelTarget : Math.round(vol.level * 100);
    var v = Math.max(0, Math.min(100, base + (ev.deltaY < 0 ? 2 : -2)));
    wheelTarget = v;
    clearTimeout(wheelIdle);
    vol.level = v / 100; volumeGlyph();                         // the glyph follows at once; the watch has the last word
    wheelSend.push(v);
    call('osd.show', { via: 'wheel', state: { ok: true, level: v, muted: !!vol.muted, reason: null } }).catch(function () { /* the glyph still moved */ });
  }, { passive: false });
  el.network.addEventListener('contextmenu', function (ev) { ev.preventDefault(); openQs(el.network); });
  el.battery.addEventListener('contextmenu', function (ev) { ev.preventDefault(); openQs(el.battery); });

  /* ================================================================= network

     THE READOUT BESIDE THE SPEAKER (2026-09-23) was a fixed Wi-Fi drawing in index.html: full
     bars with the radio off, on Ethernet, with no internet, with no network at all. Owen: "make
     the Internet thing ... actually work". main pushes the sidecar's reading ('net', replayed on
     subscribe) and net.js words and draws it; a reading that fails is a dimmed globe with the
     reason in the tooltip. */
  function renderNet(r) {
    var d = window.MantleNet ? MantleNet.describe(r || null)
      : { state: 'error', tip: 'Network state unknown\nnet.js did not load, so the network cannot be shown', label: 'Network state unknown' };
    el.network.innerHTML = window.MantleNet ? MantleNet.svg(d) : '';
    el.network.title = d.tip + '\nClick: quick settings';
    el.network.setAttribute('aria-label', d.label);
    el.network.setAttribute('data-state', d.state);
    el.network.classList.toggle('dead', d.state === 'error' || d.state === 'unknown');
  }
  renderNet(null);                    // the first frame says "not read yet", never a made-up signal

  /* ================================================================= battery */

  /* ONE READING, PUSHED (2026-09-23). Owen: "there are problems with it showing how charged my
     computer is". This drew sys.stats' Win32_Battery answer, re-asked every fifth clock tick
     through main's 60 s cache: 71 % where Windows said 72, a bolt whenever the charger was in
     (even held at a charge limit, not charging) and all but invisible on the fill, up to a minute
     behind a plug or unplug, hidden for good after one slow PowerShell start, and a tooltip
     offering "battery settings" for a click that opens quick settings. Now main pushes the
     sidecar's reading on every change ('battery', replayed on subscribe) and battery.js words and
     draws it. A reading that fails stays on screen as a dash with its reason in the tooltip. */
  var battNow = null;                  // the reading on screen; the panel's footer words this same one

  function battDescribe(r) {
    if (window.MantleBattery) return MantleBattery.describe(r);
    var why = 'battery.js did not load, so the battery cannot be worded';
    return { show: true, state: 'error', short: '—', footer: 'Battery: ' + why, tip: 'Battery status: unknown\n' + why,
      level: null, bolt: false, plug: false, reason: why };
  }

  function renderBattery(r) {
    battNow = r || null;
    var d = battDescribe(battNow);
    if (!d.show) el.battery.hidden = true;                  // no battery (a desktop): nothing to draw
    else {
      el.battery.innerHTML = (window.MantleBattery ? MantleBattery.svg(d) : '') + '<span class="pct">' + d.short + '</span>';
      el.battery.title = d.tip;
      el.battery.setAttribute('aria-label', d.tip.split('\n')[0]);
      el.battery.classList.toggle('dead', d.state === 'error' || d.state === 'unknown');
      el.battery.setAttribute('data-state', d.state);
      el.battery.hidden = false;
    }
    if (popKey === 'qs' && qsPaint) qsPaint();              // the footer words the same reading
  }

  function readBattery() {
    return call('battery.get').then(renderBattery, function (e) {
      renderBattery({ ok: false, reason: 'battery.get was refused: ' + msg(e) });
    });
  }

  /* ================================================================= clock */

  var tickTimer = 0;
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

    // No battery read here any more (2026-09-23): main pushes it on every change.
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

     The clock opens a month, the way Windows' does. Windows puts the notification centre above
     it; Mantle's is the bell's own panel (ui/bar/notifications.js, 2026-09-22), and the link at
     the bottom goes there. */
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
    /* Mantle draws the notification centre itself now (the bell, ui/bar/notifications.js); the
       Windows one stays reachable from inside that panel. */
    link.textContent = 'Notifications';
    link.title = 'Open Mantle\'s notification centre (the bell beside the clock)';
    link.addEventListener('click', function () {
      if (window.MantleNotifs) MantleNotifs.open();
      else { closePop(); keys('win+n', 'notifications'); }
    });
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

  /* ================================================================= now playing

     The chip in the right island and the card behind it (2026-09-22). MAIN does the choosing
     and the guarding (main.js, NOW PLAYING): which session is shown, whether the LessonPlayer rule has
     taken its controls away, and main refuses a control aimed at an LessonPlayer session whatever this
     page sends. This page draws what it is given, and every button names its session by AUMID.

     Idle cost stays ~0: the chip changes only when main pushes 'media' (the sidecar's change
     events, never a poll), and the card's progress bar ticks from a local clock ONLY while the
     card is open and the session is playing. */
  var media = null;              // main's last 'media' payload
  var mediaAt = 0;               // when it arrived: positionNowMs was true at about this moment
  var mediaPaint = null;         // repaints the open card in place, or null
  var mediaNote = '';            // the last refusal, said in the card until the next success
  var mediaBusy = '';            // the action in flight, so a double click sends one
  var mediaRoom = 0;             // the popover height last asked of main for the card

  var MEDIA_SVG = {
    play: '<path d="M5 3.2v9.6a.6.6 0 0 0 .92.5l7.3-4.8a.6.6 0 0 0 0-1l-7.3-4.8A.6.6 0 0 0 5 3.2z" fill="currentColor"/>',
    pause: '<rect x="4" y="3" width="2.8" height="10" rx=".7" fill="currentColor"/><rect x="9.2" y="3" width="2.8" height="10" rx=".7" fill="currentColor"/>',
    next: '<path d="M3 3.6v8.8a.55.55 0 0 0 .85.46L10 8.46a.55.55 0 0 0 0-.92L3.85 3.14A.55.55 0 0 0 3 3.6z" fill="currentColor"/><rect x="11.2" y="3" width="1.8" height="10" rx=".6" fill="currentColor"/>',
    previous: '<path d="M13 3.6v8.8a.55.55 0 0 1-.85.46L6 8.46a.55.55 0 0 1 0-.92l6.15-4.4A.55.55 0 0 1 13 3.6z" fill="currentColor"/><rect x="3" y="3" width="1.8" height="10" rx=".6" fill="currentColor"/>',
    note: '<path d="M6 11.6V3.9l6.4-1.4v7.3" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><circle cx="4.6" cy="11.8" r="1.6" fill="currentColor"/><circle cx="11" cy="10.2" r="1.6" fill="currentColor"/>'
  };
  var VERB = { toggle: 'play/pause', play: 'play', pause: 'pause', next: 'next track', previous: 'previous track' };

  function mediaShown() { return media && media.ok !== false && media.shown ? media.shown : null; }
  function mediaApp(s) { return (s && s.app && s.app.name) || (s && s.aumid) || 'this app'; }
  function mediaLine(s) {
    var t = s.title || mediaApp(s);
    return s.artist ? t + ' · ' + s.artist : t;
  }
  function mediaStatus(s) {
    var st = String((s && s.status) || 'unknown');
    return st.charAt(0).toUpperCase() + st.slice(1);
  }
  function mediaGuarded(s) { return !!(s && s.controls && s.controls.ok === false); }

  /* {ok, why}: may this button be pressed for this session, and if not, why not, in words. */
  function mediaCan(s, action) {
    if (!s) return { ok: false, why: 'nothing is playing' };
    if (mediaGuarded(s)) return { ok: false, why: s.controls.reason || 'controls are off for this session' };
    var c = s.can;
    if (!c) return { ok: false, why: mediaApp(s) + ' did not say which buttons it accepts' };
    var yes = action === 'toggle' ? (c.toggle || (s.playing ? c.pause : c.play)) : !!c[action];
    return yes ? { ok: true, why: null } : { ok: false, why: mediaApp(s) + ' does not accept ' + VERB[action] + ' right now' };
  }

  /* A refusal goes where the eye is: into the open card, or a chip when it came from the bar. */
  function mediaSay(text, where) {
    if (where === 'card' && popKey === 'media') { mediaNote = text; if (mediaPaint) mediaPaint(); }
    else fail('mediactl', 'play/pause refused', text, 'warn');
  }

  function mediaDo(action, where) {
    var s = mediaShown();
    var can = mediaCan(s, action);
    if (!can.ok) { mediaSay(can.why, where); return; }
    if (mediaBusy) return;
    mediaBusy = action;
    if (mediaPaint) mediaPaint();
    callR('media.control', { aumid: s.aumid, action: action }).then(function () {
      mediaNote = '';
      clearFail('mediactl');
    }, function (e) {
      mediaSay(VERB[action] + ' did not happen: ' + msg(e), where);
    }).then(function () {
      mediaBusy = '';
      if (mediaPaint) mediaPaint();
    });
  }

  /* The artwork, else the app's own icon on a tile, else a note glyph. Keyed on the source so a
     push that changed only the position never re-creates the <img>. */
  function paintArt(box, s) {
    var src = s.artwork || (s.app && s.app.icon) || null;
    var kind = s.artwork ? 'art' : (src ? 'app' : 'none');
    box.title = s.artwork ? '' : (s.artworkReason ? 'no artwork: ' + s.artworkReason : '');
    if (box._src === src && box.dataset.kind === kind) return;
    box._src = src;
    box.dataset.kind = kind;
    box.textContent = '';
    if (src) {
      var img = document.createElement('img'); img.alt = '';
      img.onerror = function () { box.dataset.kind = 'none'; box.innerHTML = svg(MEDIA_SVG.note, 12); };
      img.src = src;
      box.appendChild(img);
    } else {
      box.innerHTML = svg(MEDIA_SVG.note, 12);
    }
  }

  function renderMedia(p) {
    media = p || null;
    mediaAt = Date.now();
    if (media && media.ok === false) fail('media', 'now playing off', media.reason || 'now playing could not be read, and main gave no reason', 'warn');
    else clearFail('media');
    var s = mediaShown();
    el.media.hidden = !s;
    if (!s) {
      if (popKey === 'media') closePop();
      layoutDock();
      return;
    }
    el.media.classList.toggle('paused', !s.playing);
    paintArt(el.mart, s);
    el.mtxt.textContent = mediaLine(s);
    el.mchip.title = mediaLine(s) + '\n' + mediaApp(s) + ' · ' + mediaStatus(s) +
      (mediaGuarded(s) ? '\n' + s.controls.reason : '') + '\nClick for the media card';
    /* Under the LessonPlayer rule there is no glyph at all, not a greyed one: a button that is there
       invites exactly the stray click the rule exists to stop. The card says why. */
    var guarded = mediaGuarded(s);
    el.mtog.hidden = guarded;
    if (!guarded) {
      var can = mediaCan(s, 'toggle');
      var glyph = s.playing ? 'pause' : 'play';
      if (el.mtog.dataset.glyph !== glyph) { el.mtog.innerHTML = svg(MEDIA_SVG[glyph], 12); el.mtog.dataset.glyph = glyph; }
      el.mtog.classList.toggle('off', !can.ok);
      el.mtog.title = can.ok ? (s.playing ? 'Pause ' : 'Play ') + mediaApp(s) : can.why;
      el.mtog.setAttribute('aria-label', el.mtog.title);
    }
    layoutDock();
    if (popKey === 'media' && mediaPaint) mediaPaint();
  }

  function fmtMs(ms) {
    var t = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), x = t % 60;
    return (h ? h + ':' + pad(m) : String(m)) + ':' + pad(x);
  }
  /* Where the track is NOW: the sidecar's estimate at read time, moved on by the local clock
     while playing. Null when the app publishes no position (the card says so instead). */
  function mediaPos(s) {
    var t = s && s.timeline;
    if (!t || !t.available || !(t.durationMs > 0)) return null;
    var pos = Number(t.positionNowMs != null ? t.positionNowMs : t.positionMs) || 0;
    if (s.playing) pos += (Date.now() - mediaAt) * (Number(s.rate) || 1);
    return { pos: Math.max(0, Math.min(t.durationMs, pos)), dur: t.durationMs };
  }

  function mk(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function buildMediaPop(pop) {
    pop.classList.add('mcard');
    var head = mk('div', 'mc-head'), art = mk('div', 'mc-art'), meta = mk('div', 'mc-meta');
    var title = mk('div', 'mc-title'), artist = mk('div', 'mc-artist');
    var app = mk('div', 'mc-app'), appIco = mk('span', 'mc-appico'), appTxt = mk('span', 'mc-apptxt');
    app.appendChild(appIco); app.appendChild(appTxt);
    meta.appendChild(title); meta.appendChild(artist); meta.appendChild(app);
    head.appendChild(art); head.appendChild(meta);
    pop.appendChild(head);

    var prog = mk('div', 'mc-prog'), track = mk('div', 'mc-bar'), fill = mk('div', 'mc-fill');
    var times = mk('div', 'mc-times'), tNow = mk('span'), tDur = mk('span');
    track.appendChild(fill); times.appendChild(tNow); times.appendChild(tDur);
    prog.appendChild(track); prog.appendChild(times);
    var progWhy = mk('div', 'sub mc-progwhy');
    pop.appendChild(prog); pop.appendChild(progWhy);

    var ctl = mk('div', 'mc-ctl'), btns = {};
    ['previous', 'toggle', 'next'].forEach(function (a) {
      var b = mk('button', 'mc-btn' + (a === 'toggle' ? ' main' : ''));
      b.type = 'button';
      /* aria-disabled, not disabled: a disabled button swallows the click, and a greyed button
         that is clicked must still say why it did nothing. */
      b.addEventListener('click', function () { mediaDo(a, 'card'); });
      btns[a] = b;
      ctl.appendChild(b);
    });
    pop.appendChild(ctl);

    var lock = mk('div', 'mc-lock'), lockHead = mk('div', 'mc-lockhead'), lockHow = mk('div', 'sub');
    lock.appendChild(lockHead); lock.appendChild(lockHow);
    pop.appendChild(lock);

    var note = mk('div', 'note mc-note');
    pop.appendChild(note);

    var src = mk('div', 'mc-src'), srcWhy = mk('div', 'sub mc-srcwhy'), srcList = mk('div', 'mc-srclist');
    src.appendChild(srcWhy); src.appendChild(srcList);
    pop.appendChild(src);
    var foot = mk('div', 'sub mc-foot');
    pop.appendChild(foot);
    /* Spotify's "Up next" queue (ui/bar/spotify.js, spotq lane 2026-09-25): a collapsed row between
       the buttons and the source list, drawn only while the card shows Spotify. */
    if (window.MantleSpotify) {
      MantleSpotify.attach(pop, src, { call: call, on: on, msg: msg, repaint: function () { if (mediaPaint) mediaPaint(); } });
    }

    function paintProgress(s) {
      var p = mediaPos(s);
      prog.hidden = !p;
      progWhy.hidden = !!p;
      if (p) {
        fill.style.width = (100 * p.pos / p.dur).toFixed(2) + '%';
        tNow.textContent = fmtMs(p.pos);
        tDur.textContent = fmtMs(p.dur);
      } else {
        progWhy.textContent = (s.timeline && s.timeline.reason) || 'no position: ' + mediaApp(s) + ' does not publish one';
      }
      return p;
    }

    function arm(s) {
      if (popTimer || popKey !== 'media' || !s.playing || !mediaPos(s)) return;
      popTimer = setTimeout(function () {
        popTimer = 0;
        var cur = mediaShown();
        if (popKey !== 'media' || !cur) return;
        paintProgress(cur);
        arm(cur);
      }, 1000);
    }

    /* THE SOURCE LIST HOLDS STILL (lane mediapick, 2026-09-25). Owen: "i press spotify but it
       keeps switching to accelus or automatic". The rows followed main's session order (which
       moves when Windows' current session does) and an "Automatic" row was APPENDED the moment a
       pick was made; the card grows upward from the bar, so every row jumped up by one and the
       next click, or a double-click's second half, landed on LessonPlayer or Automatic. Now: one row
       per app in NAME order, "Automatic" always last (lit when it is in charge), exactly one row
       lit (the choice, not merely what shows), rows reused in place and rebuilt only when the set
       of apps changes, a picked app whose session blinked out keeps its row while main holds the
       pick, and a click within SRC_SETTLE_MS of the rows moving on screen is not taken (and says
       so). */
    var SRC_SETTLE_MS = 400;
    var srcKeys = null, srcBtns = Object.create(null), srcAuto = null, srcMovedAt = 0, srcAt = null;
    var srcIcons = Object.create(null);   // an app's icon, kept so a row waiting for its session still has one
    function srcKey(aumid) { return String(aumid || '').toLowerCase(); }
    /* Where the rows are ON SCREEN (the window itself grows and shrinks from its top edge, so a
       page-relative position would call a resize a move). A change stamps srcMovedAt. */
    function srcMoved() {
      var r = srcList.getBoundingClientRect();
      var at = Math.round((window.screenY || 0) + r.top) + ':' + Math.round((window.screenY || 0) + r.bottom);
      if (srcAt !== null && at !== srcAt) srcMovedAt = Date.now();
      srcAt = at;
    }
    function srcPick(aumid, label) {
      srcMoved();   // a move since the last paint counts too: it is under the pointer NOW
      if (Date.now() - srcMovedAt < SRC_SETTLE_MS) {
        mediaSay('That click on ' + label + ' was not taken: the source list had just moved under the pointer. Click again if you meant it.', 'card');
        return;
      }
      callR('media.select', { aumid: aumid }).then(function (r) { mediaNote = ''; renderMedia(r); }, function (e) {
        mediaSay(aumid ? 'could not switch to ' + label + ': ' + msg(e) : 'could not go back to automatic: ' + msg(e), 'card');
      });
    }
    mediaPaint = function () {
      var s = mediaShown();
      if (!s) return;
      paintArt(art, s);
      title.textContent = s.title || mediaApp(s);
      title.title = s.title || '';
      artist.textContent = s.artist ? (s.album ? s.artist + ' · ' + s.album : s.artist)
        : (s.detailsReason ? 'no track details: ' + s.detailsReason : (s.title ? '' : 'no track details'));
      artist.classList.toggle('why', !s.artist && !!s.detailsReason);
      appTxt.textContent = mediaApp(s) + ' · ' + mediaStatus(s);
      if (appIco._src !== ((s.app && s.app.icon) || '')) {
        appIco._src = (s.app && s.app.icon) || '';
        appIco.textContent = '';
        if (appIco._src) { var ai = document.createElement('img'); ai.alt = ''; ai.src = appIco._src; appIco.appendChild(ai); }
        else appIco.textContent = letterOf(mediaApp(s));
      }
      paintProgress(s);

      var guarded = mediaGuarded(s);
      ctl.hidden = guarded;
      lock.hidden = !guarded;
      if (guarded) {
        lockHead.textContent = s.controls.reason || 'controls are off for this session';
        // text nodes, with the --flag in a no-wrap span: the card must never split it at a hyphen
        lockHow.textContent = '';
        String(s.controls.how || '').split(/(--[a-z][a-z-]*)/).forEach(function (part, i) {
          if (!part) return;
          lockHow.appendChild(i % 2 ? mk('span', 'mc-flag', part) : document.createTextNode(part));
        });
        lockHow.hidden = !s.controls.how;
      } else {
        ['previous', 'toggle', 'next'].forEach(function (a) {
          var b = btns[a], can = mediaCan(s, a);
          var g = a === 'toggle' ? (s.playing ? 'pause' : 'play') : a;
          if (b.dataset.glyph !== g) { b.innerHTML = svg(MEDIA_SVG[g], a === 'toggle' ? 16 : 14); b.dataset.glyph = g; }
          b.classList.toggle('off', !can.ok);
          b.classList.toggle('busy', mediaBusy === a);
          b.setAttribute('aria-disabled', can.ok ? 'false' : 'true');
          var label = a === 'toggle' ? (s.playing ? 'Pause' : 'Play') : (a === 'next' ? 'Next track' : 'Previous track');
          b.title = can.ok ? label : label + ': ' + can.why;
          b.setAttribute('aria-label', b.title);
        });
      }
      note.textContent = mediaNote;
      note.hidden = !mediaNote;

      /* The source switcher: one row per app with a session, when there is more than one. Sessions
         are told apart by AUMID, which is all Windows gives a control to aim at; two sessions from
         one app (two browser tabs) share it, so they are one row, said out loud. */
      var seen = Object.create(null), rows = [], dup = 0;
      (media.sessions || []).forEach(function (x) {
        var k = srcKey(x.aumid);
        if (seen[k]) { dup++; return; }
        seen[k] = true;
        if (x.app && x.app.icon) srcIcons[k] = x.app.icon;
        rows.push(x);
      });
      var pk = media.pick || {}, by = pk.by, wait = by === 'waiting' && pk.waiting ? pk.waiting : null;
      // the pick main is HOLDING: the one row lit. None = Automatic is lit.
      var held = by === 'you' ? srcKey(s.aumid) : (wait ? srcKey(wait.aumid) : '');
      if (wait && !seen[held]) rows.push({ aumid: wait.aumid, app: { name: wait.name || wait.aumid, icon: srcIcons[held] || null }, gone: true });
      rows.sort(function (a, b) {
        var na = String((a.app && a.app.name) || a.aumid || '').toLowerCase(), nb = String((b.app && b.app.name) || b.aumid || '').toLowerCase();
        return na < nb ? -1 : na > nb ? 1 : (srcKey(a.aumid) < srcKey(b.aumid) ? -1 : 1);
      });
      src.hidden = rows.length < 2;
      if (!src.hidden) {
        var keys = rows.map(function (x) { return srcKey(x.aumid); }).join('\u0001');
        if (keys !== srcKeys) {
          // the set of apps changed: rebuild (rows only ever move here, and srcMovedAt says so;
          // not on the card's first paint, when the pointer is still on the chip below it)
          if (srcKeys !== null) srcMovedAt = Date.now();
          srcKeys = keys;
          srcList.textContent = '';
          srcBtns = Object.create(null);
          rows.forEach(function (x) {
            var b = mk('button', 'mc-s');
            b.type = 'button';
            b.dataset.aumid = x.aumid || '';
            b.appendChild(mk('span', 'mc-sico'));
            b.appendChild(mk('span', 'mc-stxt'));
            b.addEventListener('click', function () {
              if (b.classList.contains('on') && !b._gone) return;   // already the choice (a gone row: a new pick restarts its grace)
              srcPick(b.dataset.aumid, b._name);
            });
            srcBtns[srcKey(x.aumid)] = b;
            srcList.appendChild(b);
          });
          srcAuto = mk('button', 'mc-s mc-auto', 'Automatic');
          srcAuto.type = 'button';
          srcAuto.dataset.aumid = '';
          srcAuto.title = 'Go back to the session Windows calls current (under the LessonPlayer rule, anything but LessonPlayer first)';
          srcAuto.addEventListener('click', function () {
            if (srcAuto.classList.contains('on')) return;
            srcPick(null, 'Automatic');
          });
          srcList.appendChild(srcAuto);
        }
        // in place: the text, the icon and which row is lit, never the order
        rows.forEach(function (x) {
          var k = srcKey(x.aumid), b = srcBtns[k];
          if (!b) return;
          var name = (x.app && x.app.name) || x.aumid || 'an app';
          b._name = name; b._gone = !!x.gone;
          b.classList.toggle('on', k === held);
          var ic = b.firstChild, icon = (x.app && x.app.icon) || srcIcons[k] || '';
          if (ic._src !== icon || !ic.firstChild) {
            ic._src = icon; ic.textContent = '';
            if (icon) { var im = document.createElement('img'); im.alt = ''; im.src = icon; ic.appendChild(im); }
            else ic.textContent = letterOf(name);
          }
          b.lastChild.textContent = name + (x.gone ? ' · session gone, waiting for it' : x.lessonplayer ? ' · lesson' : (x.title ? ' · ' + x.title : ''));
          b.title = x.gone
            ? name + "'s media session is missing right now. Your pick is kept for up to " + Math.round((wait.graceMs || 60000) / 1000) + ' s and applies again the moment it is back'
            : name + (x.title ? ': ' + x.title : '') + ' (' + mediaStatus(x) + ')';
        });
        srcAuto.classList.toggle('on', !held);
      }
      srcMoved();
      var autoWhy = by === 'waiting' ? pk.auto : by;
      srcWhy.textContent = by === 'you' ? 'Showing the source you picked'
        : wait ? (pk.reason || wait.reason || (wait.name || 'The picked app') + "'s session is missing; showing automatic until it's back")
        : autoWhy === 'lessonplayer-rule' ? 'Automatic: showing ' + mediaApp(s) + ' rather than your LessonPlayer lesson (the LessonPlayer rule)'
        : 'Automatic: showing the session Windows calls current';
      if (!held && pk.dropped && pk.dropped.reason) srcWhy.textContent += ' · ' + pk.dropped.reason;
      if (dup) srcWhy.textContent += ' · ' + dup + ' more from the same app' + (dup > 1 ? 's' : '') + ' (Windows gives them one address, so they share a row)';

      foot.textContent = media.events === false
        ? 'Updates every 10 s instead of live: ' + (media.eventsReason || 'the change events could not be hooked')
        : '';
      foot.hidden = !foot.textContent;

      // the queue sizes its scrolling list here, so the card measured below always fits main's room
      if (window.MantleSpotify) MantleSpotify.paint(s, el.pop);

      /* The card can change height after it opened (a refusal note, a second source, the queue
         opening): ask main for the room again so nothing is cut off by the window's edge. Over
         main's cap the card scrolls and its top line says so (callR -> popFit), as every panel does. */
      var h = popNeed();
      if (mediaRoom && h !== mediaRoom && popKey === 'media') {
        callR('bar.popover', { open: true, height: h, key: 'media' }).then(null, function (e) {
          note.textContent = 'this card may be clipped: bar.popover — ' + msg(e);
          note.hidden = false;
        });
      }
      mediaRoom = h;
      arm(s);
    };
    mediaRoom = 0;
    mediaNote = '';
    mediaPaint();
  }

  function openMedia() {
    openPop('media', el.media, buildMediaPop);
    if (popKey !== 'media') return;       // it was open, and that click closed it
    /* Fresh on open: the position and the buttons as of now, not as of the last change event
       (main skips position-only events while the card is shut, so the chip stays quiet). */
    call('media.get').then(renderMedia, function (e) {
      mediaSay('could not refresh: ' + msg(e), 'card');
    });
  }

  el.mchip.addEventListener('click', openMedia);
  el.mchip.addEventListener('contextmenu', function (ev) { ev.preventDefault(); openMedia(); });
  el.mtog.addEventListener('click', function () { mediaDo('toggle', popKey === 'media' ? 'card' : 'chip'); });

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
    /* The tray icons Windows keeps in its hidden-icons flyout: listed, dimmed, never clicked.
       Hover says why per icon (the sidecar's words, which name the Settings switch); a click says
       it in the line under the row, so a click on one is never a silent nothing. */
    if (trayHidden.length) {
      var hh = document.createElement('div');
      hh.className = 'hidhead';
      hh.textContent = 'Hidden tray icons';
      pop.appendChild(hh);
      var row = document.createElement('div');
      row.className = 'hidtray';
      var why = document.createElement('div');
      why.className = 'sub hidwhy';
      why.textContent = 'Windows keeps these in its hidden-icons flyout, which Mantle cannot reach. Turn one On under Settings › Personalization › Taskbar › Other system tray icons and it becomes clickable here.';
      trayHidden.forEach(function (it) {
        row.appendChild(trayButton(it, function (reason) { why.textContent = reason; why.classList.add('said'); }));
      });
      pop.appendChild(row);
      pop.appendChild(why);
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

    /* Restart (Owen, 2026-09-22): the same clean quit as Quit, then Mantle comes back by itself --
       through the "Mantle" logon task when that is what started it, app.relaunch() otherwise
       (main decides; see shell.restart). No second click: unlike Quit it does not leave Owen
       without a bar. If main cannot arrange the way back it refuses, says why here, and Mantle
       keeps running. */
    var restart = document.createElement('button');
    restart.type = 'button'; restart.className = 'item';
    restart.textContent = 'Restart Mantle';
    restart.addEventListener('click', function () {
      if (restart.disabled) return;
      restart.disabled = true;
      restart.classList.remove('armed');
      restart.textContent = 'Restarting…';
      callR('shell.restart').then(function (r) {
        restart.textContent = 'Restarting (' + ((r && r.via) || 'relaunch') + ')…';
      }, function (e) {
        restart.disabled = false;
        restart.textContent = 'Restart failed — ' + msg(e);
        restart.classList.add('armed');
      });
    });
    pop.appendChild(restart);

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

  /* TEST HOOK (main sends this only to a --test instance, from `electron . --test
     --profile-name=<x> --test-click=restart` run as a second instance): open this menu and
     click its Restart item through the DOM, i.e. the real button and the real handler, with no
     mouse involved. */
  on('bar.test.click', function (p) {
    /* 'media' / 'more' / 'close': main's --test-pops screenshot run opening a popover through
       the same open path a click takes, then closing it again. */
    if (p && p.what === 'close') { closePop(); return; }
    /* 'jumplist' / 'jumplist-<match>': the right-click menu of the first app (or the first whose
       name/exe contains <match>) through the same openJump a right-click takes; 'jumplist-sub-...'
       also opens its first item's own actions. Every action in it is a dry run in --test. */
    if (p && typeof p.what === 'string' && p.what.indexOf('jumplist') === 0 && JL) {
      var jm = p.what.replace(/^jumplist(-sub)?-?/, '').toLowerCase(), sub = p.what.indexOf('jumplist-sub') === 0;
      var jk = Object.keys(cells), jhit = null;
      for (var ji = 0; ji < jk.length && !jhit; ji++) {
        var jit = cells[jk[ji]]._item;
        if (jit && (!jm || (String(jit.name || '') + ' ' + String(jit.exe || '')).toLowerCase().indexOf(jm) !== -1)) jhit = cells[jk[ji]];
      }
      if (!jhit) { fail('testclick', 'no app', 'the test hook found no bar app matching "' + jm + '"', 'warn'); return; }
      if (popKey !== jlKey(jhit)) openJump(jhit);
      if (sub) setTimeout(function () { var f = el.pop.querySelector('.jl-list .jl-i'); if (f) f.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); }, 900);
      return;
    }
    if (p && p.what === 'more') { if (popKey !== 'more') openPop('more', el.more, buildMorePop); return; }
    if (p && p.what === 'notifs') { if (window.MantleNotifs) MantleNotifs.open(); return; }
    // 'qs': the quick-settings panel, fed by the real (passive) sidecar's watch (2026-09-23)
    if (p && p.what === 'qs') { if (popKey !== 'qs') openQs(); return; }
    /* 'qs-nightlight': ...and click its Night light tile, so a --test run photographs a set going
       through main to the PASSIVE sidecar and coming back refused, with the note in the panel. */
    if (p && p.what === 'qs-nightlight') {
      if (popKey !== 'qs') openQs();
      var nl = Array.prototype.filter.call(el.pop.querySelectorAll('.qstile'), function (t) {
        var l = t.querySelector('.qslbl');
        return l && l.textContent === 'Night light';
      })[0];
      if (nl) setTimeout(function () { nl.click(); }, 600);   // after the panel's first picture
      else fail('testclick', 'no night light tile', 'the test hook opened quick settings and found no Night light tile', 'warn');
      return;
    }
    if (p && (p.what === 'media' || p.what === 'media-play')) {
      if (el.media.hidden) { fail('testclick', 'no media chip', 'the test hook was asked to open the media card, but nothing is playing so there is no chip', 'warn'); return; }
      if (popKey !== 'media') openMedia();
      /* 'media-play' presses the card's own play/pause button through the DOM, so the refusal a
         --test sidecar gives (it is --passive: no control ever reaches WinRT) is photographed in
         the card. main.js aims it at the shown session's AUMID, i.e. the test's own session. */
      if (p.what === 'media-play') {
        /* ...and ONLY on a test's own silent session: the passive sidecar would refuse anything
           else too, but a test hook that could press Owen's music is one bug away from doing it. */
        var ms = mediaShown();
        if (!ms || !/^Mantle probe/.test(ms.title || '')) {
          fail('testclick', 'not a probe', 'the test hook presses play only on a "Mantle probe" test session, and the card is showing ' + (ms ? mediaLine(ms) : 'nothing'), 'warn');
          return;
        }
        var b = el.pop.querySelector('.mc-btn.main');
        if (b) b.click();
        else fail('testclick', 'no play button', 'the test hook opened the media card and found no play/pause button (LessonPlayer rule, or no session)', 'warn');
      }
      return;
    }
    if (!p || p.what !== 'restart') return;
    if (popKey !== 'more') openPop('more', el.more, buildMorePop);
    var items = el.pop.querySelectorAll('.item');
    for (var i = 0; i < items.length; i++) {
      if (items[i].textContent === 'Restart Mantle') { items[i].click(); return; }
    }
    fail('testclick', 'no restart item', 'the test hook opened the menu and found no "Restart Mantle" item', 'warn');
  });

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

  /* The notification centre (ui/bar/notifications.js) is handed the bar's own popover, bridge and
     failure helpers, so its panel opens, sizes, closes and reports problems like every other one.
     If that file did not load, the bell still works: it opens Windows' centre, and says why. */
  /* The quick-settings sub-views (ui/bar/qs-more.js): the Wi-Fi list, the Bluetooth devices, the
     output picker and the mixer. Without that file the panel still works, minus its three '>'
     buttons, and says why. on: the Bluetooth view's pushes ('btdevices'). */
  if (window.MantleQsMore) {
    MantleQsMore.init({
      call: call, callR: callR, on: on, msg: msg, fail: fail, closePop: closePop, fellBack: fellBack,
      svg: svg, wifiGlyph: wifiGlyph, volumeSvg: volumeSvg, popNeed: popNeed
    });
  } else {
    fail('qsmore', 'Wi-Fi list missing', 'ui/bar/qs-more.js did not load, so quick settings has no Wi-Fi list, Bluetooth devices, output picker or mixer', 'warn');
  }

  /* The Downloads shelf (ui/bar/downloads.js), handed the same helpers as the bell. Without that
     file the button would be dead, so it is hidden and the strip says why. */
  if (window.MantleDownloads && MantleDownloads.init) {
    MantleDownloads.init({
      call: call, callR: callR, on: on, msg: msg, fail: fail, clearFail: clearFail,
      openPop: openPop, closePop: closePop, popKey: function () { return popKey; }
    });
  } else {
    var dlBtn = document.getElementById('downloads');
    if (dlBtn) dlBtn.hidden = true;
    fail('downloads', 'downloads shelf missing', 'ui/bar/downloads.js did not load, so the Downloads button is hidden', 'warn');
  }

  if (window.MantleNotifs) {
    MantleNotifs.init({
      call: call, callR: callR, on: on, msg: msg, fail: fail, clearFail: clearFail, keys: keys,
      openPop: openPop, closePop: closePop, popPlace: popPlace,
      popKey: function () { return popKey; }
    });
  } else {
    var bell = document.getElementById('notifs');
    if (bell) bell.addEventListener('click', function () { closePop(); keys('win+n', 'notifications'); });
    fail('notifs', 'notifications panel missing', 'ui/bar/notifications.js did not load, so the bell opens Windows\' notification centre instead', 'warn');
  }

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
    /* Pushed the moment a part changes while the panel is open (the sidecar's watch), and
       replayed on subscribe, so the panel opens on a whole picture. Levels are 0-100: this
       wrote them straight into the 0-1 glyph until 2026-09-23 ("Volume 3700%"). A part the
       panel is holding (a set in flight, a slider under the pointer) keeps what is on screen. */
    on('qs', function (d) {
      qsTake(d);
      qsRepaint();
    });
    /* The speaker, pushed on every change from anywhere (the volume keys, Windows' flyout,
       another app) whether or not the panel is open; it was read once at start. */
    on('volume', function (v) {
      if (!v || typeof v !== 'object') return;
      if (v.ok !== false && typeof v.level === 'number') {
        if (qsHeld('volume')) return;                  // the pointer is the truth mid-drag
        if (qs) qs.volume = { ok: true, level: v.level, muted: !!v.muted, reason: null };
        qsTakeVolume(v);
      } else {
        vol.level = null; vol.reason = v.reason || 'the volume could not be read, and no reason was given';
        volumeGlyph();
      }
      qsRepaint();
    });
    /* The network readout: pushed on every change (net.js words and draws it). */
    var netPushed = false;
    on('net', function (r) { netPushed = true; renderNet(r); });
    call('net.get').then(function (r) { if (!netPushed) renderNet(r); }, function (e) {
      if (!netPushed) renderNet({ ok: false, state: 'unknown', reason: 'net.get was refused: ' + msg(e) });
    });
    on('windows', renderWindows);
    /* Now playing: pushed by main on every media change (and replayed on subscribe), so the chip
       is right from the first frame without a call of its own. */
    on('media', renderMedia);
    /* A pushed list CLEARS trayThrew (2026-09-22). The boot-time tray.list below can lose the race
       with the sidecar ("sidecar started, waiting for its ready line"), and trayThrew then stuck
       for the page's whole life: main's first real list arrived a few seconds later and was
       drawn as "unavailable", so the strip had no icons and the overflow no hidden row while
       its note read "6 notification-area items". Measured in a --test run. A list that arrived
       is the proof the tray can be read. */
    var trayPushed = false;   // main has pushed a list: a late boot-call failure is stale news
    on('tray', function (list) { trayPushed = true; trayThrew = ''; lastTray = list || []; renderTray(lastTray); },
      function (reason) { trayThrew = reason; renderTray(lastTray); });   // the tray says it in its own chip

    /* tray.list is called once on boot purely to catch the "explorer exposes no tray" case with
       its reason, which is the form the failure takes on Windows 11 26200. If it fails AFTER main
       has already pushed a list, the list wins: the failure is older than what is on screen. */
    call('tray.list').then(function (list) {
      trayThrew = '';
      if (Array.isArray(list) && list.length) { lastTray = list; renderTray(lastTray); }
    }, function (e) {
      if (trayPushed) return;
      trayThrew = msg(e);
      renderTray(lastTray);
    });

    refreshPinned();    // draw the icons now, so the first reveal slides up a bar that is already right
    /* The battery: pushed by main on every change, and replayed on subscribe. battery.get draws
       the first frame anyway, and says why if it cannot. */
    on('battery', renderBattery);
    readBattery();
    readVolume().catch(function () { /* already reported on the glyph tooltip and the chip */ });
  }

  /* Win+N / Win+A (the alttab lane, 2026-09-23). The sidecar's hook swallows the LETTER, never
     Win (so Windows' own panels stay shut and Start does not open), and main passes it on as
     'bar.winkey'. Both toggle, as Windows' own do; opening a popover is what brings a hidden bar
     up (main's bar.popover). With no panel of our own, Windows' is pressed on purpose instead. */
  on('bar.winkey', function (p) {
    var key = p && p.key;
    if (key === 'a') { openQs(); return; }
    if (key !== 'n') return;
    if (popKey === 'notifs') { closePop(); return; }
    if (window.MantleNotifs) MantleNotifs.open();
    else keys('win+n', 'notifications');
  });
})();
