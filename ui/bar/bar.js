/* bar.js — the Mantle bar's behaviour.
 *
 * Plain browser script on purpose: the renderer runs with contextIsolation on and sandbox on,
 * so there is no require(), no import, no Node. `window.mantle` (installed by lane B's preload,
 * or by mock-mantle.js when this page is opened outside Electron) is the ONLY way out of here.
 *
 * Two rules shape almost every decision below:
 *
 * 1. NOTHING FAILS SILENTLY. Every call that can reject, and every State flag that can be off,
 *    ends up as a chip in the bar with a short label and the reason in its tooltip. A console
 *    line does not count — Owen will never have devtools open on his taskbar.
 *
 * 2. IDLE COST ~0. This page is on screen every waking hour. There is exactly ONE timer at rest:
 *    the clock, a chained setTimeout aligned to the minute boundary (not setInterval, which
 *    drifts and would fire while the machine is asleep). Everything else is event-driven:
 *    bridge pushes, clicks, and a ResizeObserver. Window buttons are diffed by hwnd so an update
 *    that changes one title does not rebuild the strip (a rebuild costs a relayout and flickers).
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var el = {
    body: document.body,
    bar: $('bar'), start: $('start'), windows: $('windows'), chips: $('chips'), tray: $('tray'),
    volume: $('volume'), network: $('network'), battery: $('battery'), clock: $('clock'),
    more: $('more'), pop: $('pop')
  };

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
     Both feed one chip strip; chips are the bar's way of talking. */
  var failures = Object.create(null);
  var state = null;

  function fail(key, label, reason, tone) {
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
      n.title = c.reason;
      var pip = document.createElement('span'); pip.className = 'pip';
      var lbl = document.createElement('span'); lbl.className = 'lbl'; lbl.textContent = c.label;
      n.appendChild(pip); n.appendChild(lbl);
      el.chips.appendChild(n);
    });
  }

  /* ================================================================= window buttons */

  var winEls = Object.create(null);   // hwnd -> button element, so updates reuse the DOM
  var winCount = 0;

  function letterOf(title) {
    var t = (title || '').replace(/^[^\p{L}\p{N}]+/u, '');
    return (t.charAt(0) || '?').toUpperCase();
  }

  function makeWin(w) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn win';
    b.dataset.hwnd = String(w.hwnd);
    var ico = document.createElement('span'); ico.className = 'ico';
    var t = document.createElement('span'); t.className = 't';
    b.appendChild(ico); b.appendChild(t);
    return b;
  }

  function updateWin(b, w) {
    var title = w.title || '(untitled window)';
    if (b.title !== title) { b.title = title; b.setAttribute('aria-label', title); }
    var t = b.lastChild;
    if (t.textContent !== title) t.textContent = title;

    var ico = b.firstChild;
    var want = w.icon || '';
    if (ico.dataset.src !== want) {
      ico.dataset.src = want;
      ico.textContent = '';
      if (want) {
        var img = document.createElement('img');
        img.src = want; img.alt = '';
        /* A broken data URL would otherwise leave an empty square: fall back to the letter tile
           and say so in the tooltip rather than showing a hole. */
        img.onerror = function () {
          ico.classList.remove('has-img');
          ico.textContent = letterOf(title);
          b.title = title + '\n(icon failed to decode)';
        };
        ico.classList.add('has-img');
        ico.appendChild(img);
      } else {
        ico.classList.remove('has-img');
        ico.textContent = letterOf(title);
      }
    }

    var active = !!(w.foreground || w.active) && !w.minimized;
    var min = !!w.minimized;
    if (b.classList.contains('active') !== active) b.classList.toggle('active', active);
    if (b.classList.contains('min') !== min) b.classList.toggle('min', min);
  }

  function renderWindows(list) {
    if (!Array.isArray(list)) {
      fail('windows', 'windows off', 'the "windows" channel sent ' + (list === null ? 'null' : typeof list) + ' instead of an array', 'warn');
      return;
    }
    clearFail('windows');
    var seen = Object.create(null);
    var prev = null;                 // walk the strip in order, inserting only where the order actually differs
    list.forEach(function (w) {
      var key = String(w.hwnd);
      seen[key] = true;
      var b = winEls[key];
      if (!b) { b = winEls[key] = makeWin(w); }
      updateWin(b, w);
      var shouldFollow = prev ? prev.nextSibling : el.windows.firstChild;
      if (b !== shouldFollow) el.windows.insertBefore(b, shouldFollow);
      prev = b;
    });
    Object.keys(winEls).forEach(function (key) {
      if (!seen[key]) { var b = winEls[key]; if (b.parentNode) b.parentNode.removeChild(b); delete winEls[key]; }
    });
    winCount = list.length;
    layoutWindows();
  }

  /* Overflow policy: labels are dropped BEFORE any button is clipped. The decision is a pure
     function of (strip width, window count), so the ResizeObserver below can never oscillate —
     switching to icon mode does not change the strip's own width (it is flex-sized by its
     siblings, with min-width:0). */
  var GAP = 4, WIN_MIN = 112, WIN_ICON = 32;
  function layoutWindows() {
    var avail = el.windows.clientWidth - 4;       // minus the strip's own 2px padding
    var n = winCount;
    var iconMode = n > 0 && (n * WIN_MIN + (n - 1) * GAP) > avail;
    el.windows.classList.toggle('icons', iconMode);

    /* Last-resort honesty: if even 24px-wide icons cannot all fit, the strip IS hiding windows,
       and that has to be said out loud instead of quietly cropping. */
    if (n > 0 && (n * 24 + (n - 1) * GAP) > avail)
      fail('clip', 'windows clipped', n + ' windows do not fit in ' + Math.round(avail) + 'px of bar — some are not shown');
    else clearFail('clip');
  }

  el.windows.addEventListener('click', function (ev) {
    var b = ev.target.closest ? ev.target.closest('.win') : null;
    if (!b) return;
    act('win.toggle', { hwnd: Number(b.dataset.hwnd) });
  });
  /* Middle-click closes. mousedown must be swallowed too, or Chromium starts its autoscroll. */
  el.windows.addEventListener('mousedown', function (ev) { if (ev.button === 1) ev.preventDefault(); });
  el.windows.addEventListener('auxclick', function (ev) {
    if (ev.button !== 1) return;
    var b = ev.target.closest ? ev.target.closest('.win') : null;
    if (!b) return;
    ev.preventDefault();
    act('win.close', { hwnd: Number(b.dataset.hwnd) });
  });

  /* act(): fire a bridge call for a click and, if it rejects, put the reason in the bar.
     Every user action goes through here, so no click can ever do nothing without saying why. */
  function act(channel, payload) {
    call(channel, payload).then(function () { clearFail('act'); }, function (e) {
      fail('act', channel.split('.')[0] + ' failed', channel + ' was refused: ' + msg(e), 'warn');
    });
  }

  if (window.ResizeObserver) new ResizeObserver(layoutWindows).observe(el.windows);
  else window.addEventListener('resize', layoutWindows);   // older engines: still correct, just coarser

  /* ================================================================= tray */

  function renderTray(list) {
    el.tray.textContent = '';
    var unavailable = (state && state.tray && state.tray.status === 'unavailable') || trayThrew;
    if (unavailable) {
      var chip = document.createElement('div');
      chip.className = 'chip';
      chip.title = (state && state.tray && state.tray.reason) || trayThrew || 'the tray is unavailable and no reason was given';
      var pip = document.createElement('span'); pip.className = 'pip';
      var lbl = document.createElement('span'); lbl.className = 'lbl'; lbl.textContent = 'tray off';
      chip.appendChild(pip); chip.appendChild(lbl);
      el.tray.appendChild(chip);
      return;
    }
    (list || []).forEach(function (it) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn ti';
      b.title = it.title || it.id || 'tray icon';
      if (it.icon) {
        var img = document.createElement('img'); img.src = it.icon; img.alt = '';
        img.onerror = function () { b.textContent = letterOf(it.title || it.id); };
        b.appendChild(img);
      } else {
        b.textContent = letterOf(it.title || it.id);
      }
      b.addEventListener('click', function () { act('tray.click', { id: it.id, button: 'left' }); });
      b.addEventListener('contextmenu', function (ev) { ev.preventDefault(); act('tray.click', { id: it.id, button: 'right' }); });
      el.tray.appendChild(b);
    });
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
  }

  function openPop(key, anchor, build) {
    if (popKey === key) { closePop(); return; }
    closePop();
    popKey = key;
    el.pop.textContent = '';
    el.pop.hidden = false;
    build(el.pop);

    /* The bar window is only 44px tall, so a popover drawn here would be cut off by the window,
       not by CSS. Ask the main process for room. If that channel does not exist yet, SAY SO in
       the popover instead of letting it silently disappear off the edge of the window. */
    var h = el.pop.offsetHeight + 16;
    call('bar.popover', { open: true, height: h, key: key }).catch(function (e) {
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
    if (ev.target.closest && ev.target.closest('#volume, #clock, #more')) return;  // the anchors toggle themselves
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
    el.volume.title = vol.level === null
      ? 'Volume unavailable — ' + (vol.reason || 'no reason given')
      : (muted ? 'Muted' : 'Volume ' + Math.round(level * 100) + '%');
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
      call('volume.set', { level: lvl }).then(function () { note.hidden = true; },
        function (e) { problem('volume.set failed — ' + msg(e)); });
    });
    mute.addEventListener('click', function () {
      var next = !vol.muted;
      vol.muted = next; mute.textContent = next ? 'Unmute' : 'Mute';
      mute.setAttribute('aria-pressed', String(next));
      volumeGlyph();
      call('volume.set', { muted: next }).then(function () { note.hidden = true; },
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

  el.volume.addEventListener('click', function () { openPop('volume', el.volume, buildVolumePop); });

  /* ================================================================= network / battery */

  el.network.addEventListener('click', function () { act('open', { target: 'ms-settings:network' }); });
  el.battery.addEventListener('click', function () { act('open', { target: 'ms-settings:batterysaver' }); });

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
    var txt = pad(now.getHours()) + ':' + pad(now.getMinutes());     // 24h, always
    if (el.clock.textContent !== txt) el.clock.textContent = txt;
    el.clock.title = now.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

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
  el.clock.addEventListener('click', function () { openPop('clock', el.clock, buildClockPop); });

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
      (!mantle ? 'no bridge'
        : failures.bridge ? 'bridge failing'          // never claim "ok" while a chip says otherwise
        : mantle.mode === 'mock' ? 'mock bridge'
        : 'bridge ok');
    pop.appendChild(who);

    var restore = document.createElement('button');
    restore.type = 'button'; restore.className = 'item';
    restore.textContent = 'Restore Windows taskbar';
    restore.addEventListener('click', function () {
      call('shell.restore').then(function () { closePop(); }, function (e) {
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
      call('shell.quit').then(function () { closePop(); }, function (e) {
        quit.textContent = 'Quit failed — ' + msg(e);
      });
    });
    pop.appendChild(quit);
  }
  el.more.addEventListener('click', function () { openPop('more', el.more, buildMorePop); });

  /* ================================================================= start */

  el.start.addEventListener('click', function () { closePop(); act('launcher.show'); });

  /* ================================================================= boot */

  function applyState(s) {
    state = s || null;
    if (state && (state.edge === 'top' || state.edge === 'bottom')) el.body.dataset.edge = state.edge;
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

    // Live State updates, if lane B pushes them. Absent, the one-shot state.get above still stands.
    if (typeof mantle.on === 'function') {
      try { mantle.on('state', function (s) { applyState(s); }); } catch (e) { /* optional channel */ }
    }

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

    readStats();
    readVolume().catch(function () { /* already reported on the glyph tooltip and the chip */ });
  }
})();
