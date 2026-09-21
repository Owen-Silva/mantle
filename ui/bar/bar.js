/* bar.js — the Mantle bar's behaviour.
 *
 * Plain browser script on purpose: the renderer runs with contextIsolation on and sandbox on,
 * so there is no require(), no import, no Node. `window.mantle` (installed by lane B's preload,
 * or by mock-mantle.js when this page is opened outside Electron) is the ONLY way out of here.
 *
 * THE SHAPE (Owen, 2026-09-21): the bar is HIDDEN at rest. He pushes the mouse to the bottom of
 * the screen, main brings the window in and sends 'bar.reveal', and the glass detaches into view:
 * pinned app icons centred on the screen, the readouts on the right. Main owns the decision AND
 * the window's geometry — it moves, widens and rounds the window itself. This page owns the PAINT
 * (fill, border, shadow, ink, opacity, on main's duration and Northwind's curve) and reports hover
 * back so main knows when to take it away again. Nothing here animates geometry; that would race
 * the window and lag it.
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
 *    pointer events, a ResizeObserver. The reveal is one GPU transform, nothing animates at rest.
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

  var DUR_IN = 560, DUR_OUT = 320;    // Northwind's --dur-nav, and the hide main gives us (it drops the window at 340)

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
    /* Main tells us how long it is taking; the page must not out-run or lag the window. The
       fallbacks are Northwind's 560ms in and the 320ms the hide contract gives us. */
    var d = (typeof ms === 'number' && ms > 0) ? Math.round(ms) : (on ? DUR_IN : DUR_OUT);
    el.body.style.setProperty('--lg-dur', d + 'ms');

    if (!gotFirstEvent) {
      gotFirstEvent = true;
      el.body.classList.remove('pre');
      void el.bar.offsetWidth;        // commit the flush paint before the class flips, or there is no transition to run
    }
    if (revealed === on) return;
    revealed = on;
    el.body.classList.toggle('up', on);
    if (!on) { closePop(); clearBackdrop(); }   // the strip is a photograph of a screen about to change
    else refreshPinned();             // the icons are only ever looked at while the bar is up
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
  function isActive(w) { return !!(w && (w.active || w.foreground)); }

  function makeCell(key) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'cell';
    b.dataset.key = key;
    var ico = document.createElement('span'); ico.className = 'ico';
    var dot = document.createElement('span'); dot.className = 'dot';
    b.appendChild(ico); b.appendChild(dot);
    return b;
  }

  function paintDot(b, wins) {
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

    var tip = name;
    /* An icon that is missing must say WHY on the item itself: a blank tile with no explanation is
       the silent failure this shell refuses. */
    if (!it.icon) tip += '\n(no icon: ' + (it.iconReason || 'the sidecar gave no reason') + ')';
    if (wins.length) tip += '\n' + wins.length + (wins.length === 1 ? ' window' : ' windows') + ' — right-click for the list';
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
    paintDot(b, wins);
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
  var settleTimer = 0, lastKey = '', frozenMax = 'none';

  function measure() {
    /* VIEWPORT coordinates, off the bar's own rect. Nothing here may assume the bar spans the
       screen: in pill mode the window IS the island, inset from the edges and far narrower than
       the display, and the centre of the icons is the centre of THAT window. */
    var r = el.bar.getBoundingClientRect();
    if (!r.width) return null;
    var centre = r.left + r.width / 2;
    var leftEnd = el.left ? el.left.getBoundingClientRect().right : r.left + 8;
    /* The chip strip is NOT part of the wall the dock measures against: chips are the bar talking
       about problems, and the "apps clipped" chip was widening the very cluster it measured
       (a 136 -> 0 -> 355 px loop, live 2026-09-21). The wall is the first real control. */
    var tray = $('tray'), vol = $('volume');
    var anchor = (tray && tray.getBoundingClientRect().width > 0) ? tray : (vol || el.right);
    var rightStart = anchor ? anchor.getBoundingClientRect().left : r.right - 8;
    return {
      w: Math.round(r.width),
      room: Math.round(2 * Math.max(0, Math.min(centre - leftEnd - 8, rightStart - centre - 8)))
    };
  }

  function needWidth() {
    var n = items.length;
    return n ? n * CELL + (n - 1) * GAP + (divEl.parentNode ? DIV : 0) : 0;
  }

  /* No cap when they fit: then no stale or mid-morph measurement can clip a dock that was going
     to be fine. A cap when they do not — but never below one cell, because an empty dock is the
     one outcome that is always wrong. */
  function capFor(need, room) {
    if (!need || need <= room) return 'none';
    return Math.max(room, CELL) + 'px';
  }

  function layoutDock() {
    var m = measure();
    if (!m) return;
    var need = needWidth();
    var key = m.w + ':' + need;
    /* Already settled at this width with this many icons? Then this resize is something INSIDE
       the bar changing width — our own chip, a new tray icon — and the settled answer stands. */
    el.dock.style.setProperty('--dock-max', key === lastKey ? frozenMax : capFor(need, m.room));
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
      frozenMax = capFor(need, m.room);
      // Only while the bar is up: parked (hidden) the window sits at its narrow start width, and a
      // report from there is a false alarm (seen live as "507px in a 695px bar" on every hide).
      if (revealed && need > m.room + 0.5)
        fail('dockclip', 'apps clipped', items.length + ' app icons need ' + need + 'px but only ' +
          m.room + 'px is free either side of centre in a ' + m.w + 'px bar — some are not shown');
      else clearFail('dockclip');
    }
    el.dock.style.setProperty('--dock-max', frozenMax);
  }

  /* act(): fire a bridge call for a click and, if it fails, put the reason in the bar.
     Every user action goes through here, so no click can ever do nothing without saying why. */
  function act(channel, payload, what) {
    return callR(channel, payload).then(function (r) { clearFail('act'); return r; }, function (e) {
      fail('act', (what || channel.split('.')[0]) + ' failed', channel + ' was refused: ' + msg(e), 'warn');
    });
  }

  el.dock.addEventListener('click', function (ev) {
    var b = ev.target.closest ? ev.target.closest('.cell') : null;
    if (!b) return;
    closePop();
    act('bar.open', { id: b.dataset.id }, 'open');
  });

  /* Right-click lists this app's windows. Nice-to-have per the brief, so it stays small: focus a
     window, or close it. Nothing here is the only route to anything. */
  el.dock.addEventListener('contextmenu', function (ev) {
    var b = ev.target.closest ? ev.target.closest('.cell') : null;
    if (!b) return;
    ev.preventDefault();
    var it = b._item;
    if (!it || !winsOf(it).length) return;      // no windows: the left click (launch) is the only action
    openPop('app:' + b.dataset.key, b, function (pop) { buildAppPop(pop, it); });
  });

  function buildAppPop(pop, it) {
    var h = document.createElement('h3');
    h.textContent = it.name || it.exe || 'windows';
    pop.appendChild(h);
    winsOf(it).forEach(function (w) {
      var row = document.createElement('div'); row.className = 'wrow';
      var open = document.createElement('button');
      open.type = 'button';
      open.className = 'item' + (isActive(w) ? ' on' : '');
      open.textContent = w.title || '(untitled window)';
      open.title = w.title || '(untitled window)';
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
      if (b._item) paintDot(b, winsOf(b._item));
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
    popKey = null;
    el.pop.hidden = true;
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
    if (ev.target.closest && ev.target.closest('#volume, #clock, #more, .cell')) return;  // the anchors toggle themselves
    closePop();
  }, true);
  document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') closePop(); });

  /* ================================================================= volume */

  var vol = { level: null, muted: false, reason: '' };

  function volumeGlyph() {
    var level = vol.level, muted = vol.muted;
    var waves = (level === null || muted) ? 0 : level <= 0.005 ? 0 : level <= 0.33 ? 1 : level <= 0.66 ? 2 : 3;
    var s = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">';
    s += '<path d="M2.2 6.1h2.4L8.1 3.1v9.8L4.6 9.9H2.2z" fill="currentColor"/>';
    var arcs = ['M10 6.2a2.6 2.6 0 0 1 0 3.6', 'M11.8 4.9a5 5 0 0 1 0 6.2', 'M13.6 3.6a7.4 7.4 0 0 1 0 8.8'];
    for (var i = 0; i < waves; i++)
      s += '<path d="' + arcs[i] + '" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>';
    if (muted)
      s += '<path d="M10.2 5.6l4.6 4.8M14.8 5.6l-4.6 4.8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>';
    s += '</svg>';
    el.volume.innerHTML = s;
    el.volume.title = (vol.level === null
      ? 'Volume unavailable — ' + (vol.reason || 'no reason given')
      : (muted ? 'Muted' : 'Volume ' + Math.round(level * 100) + '%')) +
      '\nClick: Windows quick settings · right-click: the Mantle slider';
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
      vol.level = typeof v.level === 'number' ? v.level : null;
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

  function buildVolumePop(pop) {
    var h = document.createElement('h3'); h.textContent = 'Volume'; pop.appendChild(h);
    var row = document.createElement('div'); row.className = 'row';
    var range = document.createElement('input');
    range.type = 'range'; range.min = '0'; range.max = '100'; range.step = '1';
    range.value = String(Math.round((vol.level || 0) * 100));
    var mute = document.createElement('button');
    mute.type = 'button'; mute.className = 'mute';
    mute.textContent = vol.muted ? 'Unmute' : 'Mute';
    mute.setAttribute('aria-pressed', String(!!vol.muted));
    row.appendChild(range); row.appendChild(mute);
    pop.appendChild(row);

    var note = document.createElement('div'); note.className = 'note'; note.hidden = true;
    pop.appendChild(note);
    function problem(text) { note.textContent = text; note.hidden = false; }

    if (vol.level === null) { range.disabled = true; problem('volume unavailable — ' + (vol.reason || 'no reason given')); }

    range.addEventListener('input', function () {
      var lvl = Number(range.value) / 100;
      vol.level = lvl; volumeGlyph();
      callR('volume.set', { level: lvl }).then(function () { note.hidden = true; },
        function (e) { problem('volume.set failed — ' + msg(e)); });
    });
    mute.addEventListener('click', function () {
      var next = !vol.muted;
      vol.muted = next; mute.textContent = next ? 'Unmute' : 'Mute';
      mute.setAttribute('aria-pressed', String(next));
      volumeGlyph();
      callR('volume.set', { muted: next }).then(function () { note.hidden = true; },
        function (e) { problem('volume.set failed — ' + msg(e)); });
    });

    // refresh from the system now that the popover is open
    readVolume().then(function () {
      if (popKey !== 'volume') return;
      range.disabled = false;
      range.value = String(Math.round((vol.level || 0) * 100));
      mute.textContent = vol.muted ? 'Unmute' : 'Mute';
      mute.setAttribute('aria-pressed', String(!!vol.muted));
      note.hidden = true;
    }, function (e) {
      if (popKey !== 'volume') return;
      range.disabled = true;
      problem('could not read the system volume — ' + msg(e));
    });
  }

  /* ================================================================= the Windows flyouts

     Volume, network and the clock are Windows' own surfaces, and Windows already draws them well.
     Rather than reimplement quick settings, the bar asks the shell to press the key for it:
     win+a is volume/wifi/bluetooth, win+n is notifications + calendar. If that call fails, the
     state strip says so — a click that does nothing in silence is the one thing not allowed. */
  function keys(combo, what) {
    callR('sys.keys', { combo: combo }).then(function () { clearFail('keys'); }, function (e) {
      fail('keys', what + ' failed', 'sys.keys ' + combo + ' was refused, so the Windows flyout did not open: ' + msg(e), 'warn');
    });
  }

  el.volume.addEventListener('click', function () { closePop(); keys('win+a', 'quick settings'); });
  el.network.addEventListener('click', function () { closePop(); keys('win+a', 'quick settings'); });
  el.clock.addEventListener('click', function () { closePop(); keys('win+n', 'notifications'); });

  /* Right-click keeps Mantle's own controls reachable — and they are the fallback when the key
     injection is the thing that is broken. */
  el.volume.addEventListener('contextmenu', function (ev) { ev.preventDefault(); openPop('volume', el.volume, buildVolumePop); });
  el.clock.addEventListener('contextmenu', function (ev) { ev.preventDefault(); openPop('clock', el.clock, buildClockPop); });
  el.network.addEventListener('contextmenu', function (ev) { ev.preventDefault(); act('open', { target: 'ms-settings:network' }, 'settings'); });
  el.battery.addEventListener('click', function () { act('open', { target: 'ms-settings:batterysaver' }, 'settings'); });

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
      if (s && s.volume && vol.level === null) { vol.level = s.volume.level; vol.muted = !!s.volume.muted; volumeGlyph(); }
    }, function (e) {
      el.battery.hidden = true;
      fail('stats', 'stats off', 'sys.stats failed, so battery and volume readings are stale: ' + msg(e));
    });
  }

  /* ================================================================= clock */

  var tickN = 0;
  function pad(n) { return n < 10 ? '0' + n : String(n); }

  function tick() {
    var now = new Date();
    var t = pad(now.getHours()) + ':' + pad(now.getMinutes());     // 24h, always
    if (clkT.textContent !== t) clkT.textContent = t;
    var d = now.toLocaleDateString(undefined, { day: 'numeric', month: 'numeric', year: 'numeric' });
    if (clkD.textContent !== d) clkD.textContent = d;
    el.clock.title = now.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) +
      '\nClick: notifications and calendar · right-click: the Mantle clock';

    // Battery drifts slowly: refreshing it on every fifth minute tick avoids a second timer.
    if (tickN % 5 === 0) readStats();
    tickN++;

    /* THE one timer at rest. Aligned to the next minute boundary (+250ms of slack so we are
       never a hair early and show the previous minute), chained rather than setInterval so a
       sleep/resume cannot leave a backlog of missed ticks. */
    var delay = 60000 - (Date.now() % 60000) + 250;
    setTimeout(tick, delay);
  }

  function buildClockPop(pop) {
    var now = new Date();
    var big = document.createElement('div'); big.className = 'big';
    big.textContent = now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
    var sub = document.createElement('div'); sub.className = 'sub';
    sub.textContent = now.getFullYear() + ' · ' + pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds());
    pop.appendChild(big); pop.appendChild(sub);
    /* Seconds run ONLY while this popover is open, and as a chained setTimeout that checks
       popKey first — so there is no interval left alive anywhere in this file, and the "one
       timer at rest" rule holds by construction rather than by remembering to clear one. */
    (function second() {
      popTimer = setTimeout(function () {
        if (popKey !== 'clock') return;
        var d = new Date();
        sub.textContent = d.getFullYear() + ' · ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
        second();
      }, 1000 - (Date.now() % 1000) + 20);
    })();
  }

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
    if (state && state.bar && typeof state.bar.revealed === 'boolean' && state.bar.revealed !== revealed)
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

    on('bar.reveal', function (p) { slide(true, p && p.why, p && p.mode, p && p.ms); });
    on('bar.hide', function (p) { slide(false, p && p.why, null, p && p.ms); });
    on('bar.pinned', renderDock);
    on('bar.backdrop', setBackdrop);
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
