/*
 * ui/bar/qs-more.js — the quick-settings panel, one level down (qsx lane, 2026-09-23).
 *
 * The goal: finish Mantle's quick settings "the way Windows 11's works, so Owen never needs
 * Windows' own flyouts for Wi-Fi or sound". Windows 11 has two '>' buttons in that panel, and so
 * does this one:
 *   - on the Wi-Fi tile: the network list, INSIDE the same panel (a sub-view with a back arrow)
 *   - beside the volume slider: the output devices, then the volume mixer (Windows 11 24H2's shape)
 *
 * WI-FI: saved networks first, then by signal (the sidecar sorts: sidecar/Wlan.cs). Each row has
 * signal bars, a lock on a secured network, and "Connected" on the current one. A row opens to what
 * Mantle can honestly do with it: Disconnect; Connect (a saved or an open network); a password
 * (WPA/WPA2/WPA3-Personal); or, for enterprise, WEP, Enhanced Open and hidden networks, the reason
 * plus Windows' own Wi-Fi list. Refresh scans (WlanScan) and re-reads once Windows says the scan
 * finished. Radio off, no adapter, nothing in range and a list that cannot be read each say so.
 *
 * SOUND: the active playback devices with the default checked. The check comes from a read-back
 * (audio devices, or the device list the set returns), never from the click. A click makes that
 * device the default for all three roles. Below: one row per app with sound
 * (IAudioSessionManager2), each with its own level and mute (ISimpleAudioVolume).
 *
 * COST: nothing here runs while the panel is closed. An open Bluetooth view costs one 26 ms list per
 * change Windows reports (measured 2026-09-23), plus a lease renewal every 30 s. An open Wi-Fi view re-reads the list every
 * 4 s (23-34 ms of sidecar time, measured 2026-09-23). An open sound view re-reads the apps every
 * 1.5 s (5-10 ms) and the devices every third tick (4-5 ms). Both stop when their view or the
 * panel closes.
 *
 * BLUETOOTH (the tile's '>', 2026-09-23): the PAIRED devices, Windows 11's shape. Each row has a
 * type icon, Connected / Not connected and, while connected, the battery where Windows knows it
 * (sidecar/BtDevices.cs; the words are ui/bar/bt.js). A row opens to Connect / Disconnect on an
 * audio device with Windows' Bluetooth audio control under it, else the reason and Windows' own
 * settings. "Add device" is Windows' Settings: pairing stays Windows'. While the view is open the
 * sidecar's DeviceWatcher pushes changes ('btdevices'), renewed every 30 s so a dead view cannot
 * leave it running; without the watch the list is re-read every 3 s instead, and says so.
 *
 * THE PASSWORD is typed into a field that appears only once main says the bar holds the keyboard
 * (qs.keyboard). The bar is focusable:false, so without that the keys would go to the app in
 * front. It is read once on submit, the field is cleared in the same tick, and it goes straight
 * into one qs.wifi.connect call. It is never kept, logged, cached, or put in any error text.
 *
 * NO SILENT FAILURES: every refusal comes back with a reason, and the reason is shown in words in
 * the view, next to what was clicked.
 *
 * bar.js hands this file its bridge helpers (init) and, each time it builds the panel, the three
 * places the '>' buttons go (attach); it calls closed() when the panel closes.
 */
(function () {
  'use strict';

  var B = null;                 // bar.js helpers, from init()
  var S = null;                 // the open panel's state; null while the panel is closed
  var gen = 0;                  // bumps on every view change, so a late reply cannot paint a gone view

  var WIFI_POLL_MS = 4000;
  var SOUND_POLL_MS = 1500;
  var DEVICES_EVERY = 3;        // sound ticks per device re-read
  var BT_RENEW_MS = 30000;      // the sidecar's watch lapses 90 s after its last renewal
  var BT_POLL_MS = 3000;        // only when the watch cannot run: a list is 26 ms (measured 2026-09-23)
  /* The sub-view's own height. The popover adds 24 (padding and border) and main's room request
     another 16, so 360 asks for 400 of main's 480 cap (POPOVER_MAX), leaving slack for a note. */
  var VIEW_H = 360;

  /* The last reads, so reopening a view draws at once and then refreshes. Names, levels and
     reasons only: nothing here ever holds a password. */
  var wifiData = null, devData = null, mixData = null, btData = null;
  var btEventsBroken = null;    // why 'btdevices' pushes cannot arrive, if they cannot

  /* Windows' reason texts are exact but technical ("PSK mismatch suspected"), so the commonest
     ones get a plain first line. The texts beside each code are what WlanReasonCodeToString
     returned on this machine, 2026-09-23. */
  var LEADS = {
    294932: 'The password looks wrong.',                  // 0x48014 "PSK mismatch suspected"
    294930: 'That password is not in a valid format.',    // 0x48012 "Entered key is not in a valid format"
    229379: 'The network did not answer in time.',        // 0x38003 "Association with the network timed out."
    163842: 'The network is out of range.'                // 0x28002 "The wireless network is not visible."
  };

  /* ------------------------------------------------------------------ glyphs */

  function svg(body, size) { return B.svg(body, size); }
  var CHEV_R = '<path d="M6.2 3.6L10.6 8l-4.4 4.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>';
  var CHEV_L = '<path d="M9.8 3.6L5.4 8l4.4 4.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>';
  var REFRESH = '<path d="M12.9 8.6a4.9 4.9 0 1 1-1.3-4.2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>' +
                '<path d="M12.2 1.9v2.9H9.3" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>';
  var CHECK = '<path d="M3.4 8.3l2.9 2.9 6.3-6.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>';
  var BELL = '<path d="M8 2.3a3.6 3.6 0 0 0-3.6 3.6v2.5L3.1 10.6h9.8l-1.3-2.2V5.9A3.6 3.6 0 0 0 8 2.3z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>' +
             '<path d="M6.6 12.5a1.5 1.5 0 0 0 2.8 0" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>';
  var NO_WIFI = '<path d="M1.6 5.6a9.5 9.5 0 0 1 12.8 0M4 8.2a6 6 0 0 1 8 0M6.3 10.8a2.6 2.6 0 0 1 3.4 0" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" opacity=".35"/>' +
                '<path d="M3 2.5l10 10.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>';
  var NO_NETS = '<circle cx="8" cy="13.2" r="1" fill="currentColor"/>' +
                '<path d="M6.3 10.8a2.6 2.6 0 0 1 3.4 0M4 8.2a6 6 0 0 1 8 0M1.6 5.6a9.5 9.5 0 0 1 12.8 0" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" opacity=".45"/>';
  var LOCK = '<svg viewBox="0 0 8 9" width="8" height="9" aria-hidden="true" focusable="false">' +
             '<path d="M2.3 4.1V2.9a1.7 1.7 0 0 1 3.4 0v1.2" fill="none" stroke="currentColor" stroke-width="1.1"/>' +
             '<rect x=".9" y="4" width="6.2" height="4.4" rx="1.1" fill="currentColor"/></svg>';

  /* ------------------------------------------------------------------ small helpers */

  function h(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }
  function button(cls, text, title) {
    var b = h('button', cls, text);
    b.type = 'button';
    if (title) { b.title = title; b.setAttribute('aria-label', title); }
    return b;
  }
  function alive(g) { return !!S && g === gen; }
  function bars(signal) { return Math.max(1, Math.min(3, Math.ceil((signal || 0) / 34))); }
  function ago(ms) {
    var s = Math.round((ms || 0) / 1000);
    return s < 5 ? 'just now' : s < 60 ? s + ' s ago' : Math.round(s / 60) + ' min ago';
  }

  /* A row of buttons: [label, onClick, disabled, accent, title] each. */
  function buttons(parent, list) {
    var row = h('div', 'qsx-btns');
    list.forEach(function (b) {
      var el = button('qsx-btn' + (b[3] ? ' acc' : ''), b[0]);
      if (b[4]) el.title = b[4];
      el.disabled = !!b[2];
      el.addEventListener('click', function (ev) { ev.stopPropagation(); b[1](); });
      row.appendChild(el);
    });
    parent.appendChild(row);
    return row;
  }

  /* A whole-view state (radio off, no adapter, nothing in range, cannot read): what, why, and
     what can be done about it. `bad` paints the reason as a failure rather than as a fact. */
  function stateBlock(parent, glyph, title, why, actions, bad) {
    var box = h('div', 'qsx-state');
    if (glyph) { var g = h('div', 'qsx-stateico'); g.innerHTML = svg(glyph, 24); box.appendChild(g); }
    box.appendChild(h('div', 'qsx-statetitle', title));
    if (why) box.appendChild(h('div', 'qsx-statewhy' + (bad ? ' bad' : ''), why));
    if (actions && actions.length) buttons(box, actions);
    parent.appendChild(box);
  }

  /* ------------------------------------------------------------------ wiring */

  function init(helpers) {
    B = helpers;
    /* The Bluetooth watch's pushes. One subscription for the bar's life; a push lands only while
       the Bluetooth view is open (onBtPush checks). */
    if (typeof B.on === 'function') {
      B.on('btdevices', onBtPush, function (reason) { btEventsBroken = reason; });
    } else {
      btEventsBroken = 'bar.js gave this file no event channel';
    }
  }

  /* bar.js calls this every time it builds the quick-settings panel. ctx: wifiTile (the tile's
     button), volumeLine (the volume slider's row), repaint (the panel's paint). */
  function attach(pop, ctx) {
    if (!B) return;
    gen++;
    S = { pop: pop, ctx: ctx, view: null, el: null, timer: 0, room: 0, kbd: false, w: null, a: null, b: null };

    /* Wi-Fi: Windows 11 splits the tile. The tile itself still toggles the radio; its '>'
       opens the list. The chevron takes the tile's colours in CSS (on = accent, dead = sunk),
       and it always opens, because the list is where "off" and "no adapter" explain themselves. */
    var tile = ctx.wifiTile;
    if (tile && tile.parentNode) {
      var split = h('div', 'qsx-split');
      tile.parentNode.insertBefore(split, tile);
      split.appendChild(tile);
      var wchev = button('qsx-chev', null, 'Show Wi-Fi networks');
      wchev.innerHTML = svg(CHEV_R);
      wchev.addEventListener('click', function () { enter('wifi'); });
      split.appendChild(wchev);
    }
    /* Bluetooth: the same split as Wi-Fi; the tile toggles the radio, its '>' opens the paired
       devices, and always opens, for the same reason. */
    var btile = ctx.btTile;
    if (btile && btile.parentNode) {
      var bsplit = h('div', 'qsx-split');
      btile.parentNode.insertBefore(bsplit, btile);
      bsplit.appendChild(btile);
      var bchev = button('qsx-chev', null, 'Show Bluetooth devices');
      bchev.innerHTML = svg(CHEV_R);
      bchev.addEventListener('click', function () { enter('bt'); });
      bsplit.appendChild(bchev);
    }
    /* Sound: after the mute button, where Windows 11 puts its '>' */
    if (ctx.volumeLine) {
      var schev = button('qsmute qsx-more', null, 'Sound output and volume mixer');
      schev.innerHTML = svg(CHEV_R);
      schev.addEventListener('click', function () { enter('sound'); });
      ctx.volumeLine.appendChild(schev);
    }
  }

  /* bar.js calls this from closePop when the quick-settings panel closes, for any reason. */
  function closed() {
    if (!S) return;
    gen++;
    stopPoll();
    if (S.kbd) releaseKeyboard(true);
    if (S.b) stopBtWatch();
    if (S.pop) { S.pop.style.width = ''; S.pop.classList.remove('qsx-sub'); }
    S = null;
  }

  /* ------------------------------------------------------------------ views */

  function enter(kind) {
    if (!S || S.view) return;
    gen++;
    var pop = S.pop;
    /* The panel keeps its width, so long names ellipsize and nothing jumps sideways. It is
       border-box (bar.css), so the computed width is the whole box. */
    pop.style.width = getComputedStyle(pop).width;
    pop.classList.add('qsx-sub');
    var el = h('div', 'qsx-view');
    el.style.height = VIEW_H + 'px';
    pop.appendChild(el);
    S.view = kind;
    S.el = el;
    if (kind === 'wifi') buildWifi(el);
    else if (kind === 'bt') buildBt(el);
    else buildSound(el);
    room();
  }

  function back() {
    if (!S || !S.view) return;
    gen++;
    stopPoll();
    if (S.kbd) releaseKeyboard(false);
    if (S.b) stopBtWatch();
    if (S.el && S.el.parentNode) S.el.parentNode.removeChild(S.el);
    S.el = null; S.view = null; S.w = null; S.a = null; S.b = null;
    S.pop.classList.remove('qsx-sub');
    S.pop.style.width = '';
    room();
    if (S.ctx.repaint) S.ctx.repaint();
  }

  /* The panel changes height between the main view and a sub-view: ask main for the room again
     (the notification centre's pattern), and say so if it cannot be had. */
  function room() {
    if (!S) return;
    var hgt = S.pop.offsetHeight + 16;
    if (hgt === S.room) return;
    S.room = hgt;
    B.callR('bar.popover', { open: true, height: hgt, key: 'qs' }).catch(function (e) {
      viewNote('room', 'this panel may be clipped: bar.popover — ' + B.msg(e));
    });
  }

  function header(el, title) {
    var head = h('div', 'qsx-head');
    var b = button('qsx-icon qsx-back', null, 'Back to quick settings');
    b.innerHTML = svg(CHEV_L);
    b.addEventListener('click', back);
    head.appendChild(b);
    head.appendChild(h('span', 'qsx-title', title));
    el.appendChild(head);
    return head;
  }

  function footer(el, label, title, target, what) {
    var foot = h('div', 'qsx-foot');
    var more = button('qslink', label);
    more.title = title;
    more.addEventListener('click', function () { openOut(target, what, null); });
    foot.appendChild(more);
    el.appendChild(foot);
    return foot;
  }

  /* One chain per open view: setTimeout after each reply, never setInterval, so a slow sidecar
     can never stack requests up behind itself. */
  function poll(fn, ms) {
    stopPoll();
    var g = gen;
    S.timer = setTimeout(function () {
      if (!alive(g)) return;
      S.timer = 0;
      fn().then(function () { if (alive(g)) poll(fn, ms); });
    }, ms);
  }
  function stopPoll() {
    if (S && S.timer) { clearTimeout(S.timer); S.timer = 0; }
  }

  /* Notes along the bottom of a view: one per source, each replaced by that source's next word. */
  function viewNote(key, text) {
    var v = S && (S.w || S.a || S.b);
    if (!v) {
      if (text) B.fail('qsx', 'quick settings', text, 'warn');
      return;
    }
    if (text) v.notes[key] = text;
    else delete v.notes[key];
    paintNotes();
  }
  function paintNotes() {
    var v = S && (S.w || S.a || S.b);
    if (!v || !v.noteEl) return;
    v.noteEl.textContent = '';
    Object.keys(v.notes).forEach(function (k) {
      v.noteEl.appendChild(h('div', 'note', v.notes[k]));
    });
    v.noteEl.hidden = !v.noteEl.childNodes.length;
  }

  /* Open something of Windows'. Only on success does the panel close, the way Windows' own links
     behave. A refusal stays on screen with its reason, and with the fallback's reason too if one
     was tried. */
  function openOut(target, what, fallback, firstWhy) {
    B.call('open', { target: target }).then(function (r) {
      if (r && r.ok !== false) { B.closePop(); return; }
      var why = (r && r.reason) || 'no reason given';
      if (fallback) { openOut(fallback, what, null, why); return; }
      viewNote('open', what + ' did not open: ' + (firstWhy ? firstWhy + '; then ' : '') + why);
    }, function (e) {
      if (fallback) { openOut(fallback, what, null, B.msg(e)); return; }
      viewNote('open', what + ' did not open: ' + (firstWhy ? firstWhy + '; then ' : '') + B.msg(e));
    });
  }

  /* ------------------------------------------------------------------ keyboard */

  function takeKeyboard() {
    return B.call('qs.keyboard', { on: true }).then(function (r) {
      r = r || { ok: false, reason: 'qs.keyboard gave no answer' };
      if (S) S.kbd = !!r.ok;
      if (r.ok && r.note) viewNote('kbd', r.note);
      return r;
    }, function (e) { return { ok: false, reason: 'qs.keyboard was refused: ' + B.msg(e) }; });
  }

  /* afterClose: the panel is already gone, so a failure has to go to the bar's strip. */
  function releaseKeyboard(afterClose) {
    if (S) S.kbd = false;
    B.call('qs.keyboard', { on: false }).then(function (r) {
      if (r && r.ok === false) {
        if (afterClose || !S) B.fail('qskbd', 'focus', r.reason, 'warn');
        else viewNote('kbd', r.reason);
      }
    }, function (e) {
      B.fail('qskbd', 'focus', 'the bar may still hold the keyboard: qs.keyboard off was refused (' + B.msg(e) + ')', 'warn');
    });
  }

  /* ================================================================== WI-FI */

  function buildWifi(el) {
    var W = S.w = {
      list: null, status: null, refresh: null, noteEl: null, notes: {},
      open: null,          // the key of the expanded row
      pwFor: null,         // the key of the row showing the password field (the KEY, never the password)
      busy: null,          // { key, what: 'connect' | 'disconnect' } while one is in flight
      fail: {},            // key -> { lead, reason, codeHex } from the last attempt on that row
      auto: {},            // key -> false when "Connect automatically" was unticked
      scanning: false, scanHeld: false, sig: ''
    };
    var head = header(el, 'Wi-Fi');
    W.status = h('span', 'qsx-status');
    head.appendChild(W.status);
    W.refresh = button('qsx-icon qsx-refresh', null, 'Scan for networks');
    W.refresh.innerHTML = svg(REFRESH);
    W.refresh.addEventListener('click', scan);
    head.appendChild(W.refresh);
    W.list = h('div', 'qsx-scroll');
    el.appendChild(W.list);
    W.noteEl = h('div', 'qsx-notes');
    W.noteEl.hidden = true;
    el.appendChild(W.noteEl);
    footer(el, 'More Wi-Fi settings', 'Settings › Network & internet › Wi-Fi', 'ms-settings:network-wifi', 'Wi-Fi settings');

    if (wifiData) renderWifi(true);
    else stateBlock(W.list, null, 'Looking for networks…', null, null);
    // What Windows already knows first (a few ms), then a fresh scan, the way Windows' list opens.
    readWifi().then(function () { if (usable(wifiData)) scan(); });
    poll(readWifi, WIFI_POLL_MS);
  }

  /* A list that can be scanned: read, an adapter, the radio on. Otherwise the view's own state
     block already says why, and a scan could only say the same thing again. */
  function usable(r) { return !!r && r.ok !== false && r.present !== false && r.on !== false; }

  function readWifi() {
    var g = gen;
    return B.call('qs.wifi.list').then(function (r) {
      if (!alive(g) || !S.w) return;
      wifiData = r || { ok: false, reason: 'qs.wifi.list gave no answer' };
      renderWifi(false);
    }, function (e) {
      if (!alive(g) || !S.w) return;
      wifiData = { ok: false, reason: 'the Wi-Fi list could not be asked for: ' + B.msg(e) };
      renderWifi(false);
    });
  }

  function scan() {
    var W = S && S.w;
    if (!W || W.scanning) return;
    var g = gen;
    W.scanning = true;
    paintStatus();
    B.call('qs.wifi.scan').then(function (r) {
      if (!alive(g) || !S.w) return;
      W.scanning = false;
      r = r || { ok: false, reason: 'qs.wifi.scan gave no answer' };
      var s = r.scan;
      /* A scan that did not finish still returned the list as it stood: show both. When the
         list itself is off, missing or unreadable, its state block says so and the note stays out. */
      viewNote('scan', !usable(r) ? ''
        : s && s.ok === false && s.reason ? 'Scan: ' + s.reason
        : (!s && r.ok === false ? 'Scan: ' + (r.reason || 'no reason given') : ''));
      if (r.networks || r.present === false || r.on === false) wifiData = r;
      paintStatus();
      renderWifi(false);
    }, function (e) {
      if (!alive(g) || !S.w) return;
      W.scanning = false;
      viewNote('scan', 'Scan: the scan could not be asked for: ' + B.msg(e));
      paintStatus();
    });
  }

  function paintStatus() {
    var W = S && S.w;
    if (!W) return;
    W.status.textContent = W.scanning ? 'Scanning…' : W.busy ? (W.busy.what === 'connect' ? 'Connecting…' : 'Disconnecting…') : '';
    W.refresh.disabled = W.scanning;
    W.refresh.classList.toggle('spin', W.scanning);
  }

  function netKey(n) { return n.hex || ('ssid:' + n.ssid); }

  /* force: redraw even if nothing changed. A poll never redraws over an open password field:
     a redraw would wipe what is being typed into it. */
  function renderWifi(force) {
    var W = S && S.w, r = wifiData;
    if (!W || !r) return;
    paintStatus();
    lastNote(r);
    if (W.pwFor && !force) return;
    var nets = Array.isArray(r.networks) ? r.networks : [];
    var sig = JSON.stringify([r.ok, r.present, r.on, r.reason, nets.map(function (n) {
      return [n.hex, n.ssid, n.signal, n.known, n.connected, n.connecting, n.action];
    }), W.open, W.pwFor, W.busy, W.fail, W.auto]);
    if (!force && sig === W.sig) return;
    W.sig = sig;
    var keepScroll = W.list.scrollTop;
    W.list.textContent = '';

    if (r.ok === false) {
      stateBlock(W.list, NO_WIFI, 'Wi-Fi can’t be read', r.reason || 'no reason given',
        [['Try again', function () { readWifi(); }]], true);
      return;
    }
    if (r.present === false) {
      stateBlock(W.list, NO_WIFI, 'No Wi-Fi adapter', r.reason || 'Windows lists no wireless adapter on this machine',
        [['Network settings', function () { openOut('ms-settings:network', 'Network settings', null); }]]);
      return;
    }
    if (r.on === false) {
      stateBlock(W.list, NO_WIFI, 'Wi-Fi is off', r.reason || 'the Wi-Fi radio is switched off',
        [['Turn on Wi-Fi', turnOn, false, true]]);
      return;
    }
    if (!nets.length) {
      stateBlock(W.list, NO_NETS, 'No networks found',
        W.scanning ? 'Scanning for networks…'
          : 'Windows sees no Wi-Fi networks in range right now.',
        [['Scan again', scan, W.scanning]]);
      return;
    }
    nets.forEach(function (n) { W.list.appendChild(netRow(n)); });
    W.list.scrollTop = keepScroll;
    if (force && W.open) {
      var openRow = W.list.querySelector('.qsx-net.open');
      if (openRow && openRow.scrollIntoView) openRow.scrollIntoView({ block: 'nearest' });
    }
  }

  /* The sidecar remembers the last connect or disconnect for a while, so an outcome that landed
     after the panel closed is still told the next time the list opens. */
  function lastNote(r) {
    var W = S.w, l = r && r.last;
    var shown = l && !l.ok && l.ssid && !(W.fail && Object.keys(W.fail).length);
    viewNote('last', shown
      ? 'Last attempt (' + ago(l.agoMs) + '): ' + (l.op === 'disconnect' ? 'Wi-Fi did not disconnect' : 'Mantle could not connect to “' + l.ssid + '”') +
        ' — ' + (l.reason || 'no reason given')
      : '');
  }

  function subline(n, key) {
    var W = S.w;
    if ((W.busy && W.busy.key === key && W.busy.what === 'connect') || n.connecting) return 'Connecting…';
    if (W.busy && W.busy.key === key) return 'Disconnecting…';
    if (n.connected) return n.secure ? 'Connected, secured' : 'Connected, open';
    if (W.fail[key]) return W.fail[key].short;
    return (n.known ? 'Saved · ' : '') + (n.secure ? n.security : 'Open');
  }

  /* One attempt's failure, kept on its row until the next attempt. op says where it shows:
     a connect or keyboard failure on a row that is not connected, a disconnect failure on the
     row that still is. */
  function failure(op, lead, reason, codeHex) {
    return {
      op: op, lead: lead, reason: reason || 'Mantle gave no reason', codeHex: codeHex || null,
      short: op === 'disconnect' ? 'Couldn’t disconnect' : op === 'kbd' ? 'Needs Windows’ Wi-Fi list' : 'Couldn’t connect'
    };
  }
  function failShows(f, n) { return !!f && (f.op === 'disconnect' ? !!n.connected : !n.connected); }

  function netRow(n) {
    var W = S.w, key = netKey(n);
    var row = h('div', 'qsx-net');
    row.setAttribute('data-ssid', n.hidden ? '' : (n.ssid || ''));
    row.classList.toggle('on', !!n.connected);
    row.classList.toggle('open', W.open === key);
    row.classList.toggle('busy', !!(W.busy && W.busy.key === key) || !!n.connecting);
    row.classList.toggle('fail', failShows(W.fail[key], n) && !n.connected);
    row.classList.toggle('hid', !!n.hidden);

    var head = button('qsx-nethead');
    var ico = h('span', 'qsx-netico');
    ico.innerHTML = B.wifiGlyph(bars(n.signal));
    if (n.secure) { var lock = h('span', 'qsx-lock'); lock.innerHTML = LOCK; ico.appendChild(lock); }
    var txt = h('span', 'qsx-nettext');
    txt.appendChild(h('span', 'qsx-netname', n.hidden ? 'Hidden network' : n.ssid));
    txt.appendChild(h('span', 'qsx-netsub', subline(n, key)));
    head.appendChild(ico);
    head.appendChild(txt);
    head.title = (n.hidden ? 'A network that hides its name' : n.ssid) + '\n' +
      (n.secure ? n.security : 'Open (no password)') + ' · signal ' + n.signal + '%' +
      (n.known ? ' · saved in Windows' : '');
    head.setAttribute('aria-expanded', String(W.open === key));
    head.addEventListener('click', function () {
      var opening = W.open !== key;
      if (W.pwFor) cancelPassword();       // leaving a password field, by any row: it closes and the keyboard goes back
      W.open = opening ? key : null;
      renderWifi(true);
    });
    row.appendChild(head);
    if (W.open === key) row.appendChild(netBody(n, key));
    return row;
  }

  function autoBox(key) {
    var W = S.w;
    var lbl = h('label', 'qsx-auto');
    var box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = W.auto[key] !== false;
    box.addEventListener('change', function () { W.auto[key] = box.checked; });
    lbl.appendChild(box);
    lbl.appendChild(document.createTextNode('Connect automatically'));
    return lbl;
  }

  function netBody(n, key) {
    var W = S.w, body = h('div', 'qsx-netbody');
    var busy = !!(W.busy && W.busy.key === key);
    var other = !!(W.busy && W.busy.key !== key);
    var otherWhy = other ? 'Mantle is busy with another network; wait for it to finish' : '';
    var f = W.fail[key];
    if (failShows(f, n)) {
      var err = h('div', 'qsx-err');
      err.appendChild(h('div', 'qsx-errlead', f.lead));
      err.appendChild(h('div', 'qsx-errwhy', f.reason));
      if (f.codeHex && f.codeHex !== '0x0') err.title = 'Windows reason code ' + f.codeHex;
      body.appendChild(err);
    }
    var act = n.action;
    if (act === 'disconnect') {
      buttons(body, [[busy ? 'Disconnecting…' : 'Disconnect', function () { disconnect(key); }, busy || other, false, otherWhy]]);
    } else if (act === 'connect' || act === 'open' || act === 'password') {
      if (act === 'open') body.appendChild(h('div', 'qsx-hint', 'An open network: other people nearby might be able to see what you send over it.'));
      if (act !== 'connect') body.appendChild(autoBox(key));
      if (W.pwFor === key) body.appendChild(passwordForm(n, key, busy));
      else {
        var list = [[busy ? 'Connecting…' : 'Connect', function () {
          if (act === 'password') askPassword(key);
          else connect(n, key, null);
        }, busy || other, true, otherWhy]];
        /* A saved network that failed may have a changed password, which Windows' own list can
           update; and a password that cannot be typed here can be typed there. */
        if (f && !n.connected && (act === 'connect' || f.op === 'kbd')) list.unshift(['Windows Wi-Fi list', function () {
          openOut('ms-availablenetworks:', 'The Windows Wi-Fi list', 'ms-settings:network-wifi');
        }, false, false, f.op === 'kbd' ? 'Type the password in Windows’ own Wi-Fi list' : 'Windows can update a saved password there']);
        buttons(body, list);
      }
    } else {
      body.appendChild(h('div', 'qsx-hint', 'Mantle can’t connect this one: ' + (n.why || 'Windows handles this kind of network') + '.'));
      buttons(body, [['Open Windows Wi-Fi settings', function () {
        openOut('ms-availablenetworks:', 'The Windows Wi-Fi list', 'ms-settings:network-wifi');
      }, false, true]]);
    }
    return body;
  }

  /* The password field appears only once the bar holds the keyboard (see qs.keyboard in main.js).
     Without it, the keys would go to the app in front. */
  function askPassword(key) {
    var W = S.w, g = gen;
    delete W.fail[key];
    takeKeyboard().then(function (r) {
      if (!alive(g) || !S.w) return;
      if (!r.ok) {
        W.fail[key] = failure('kbd', 'A password can’t be typed here.', r.reason);
        renderWifi(true);
        return;
      }
      W.pwFor = key;
      renderWifi(true);
    });
  }

  function cancelPassword() {
    var W = S && S.w;
    if (!W || !W.pwFor) return;
    W.pwFor = null;
    if (S.kbd) releaseKeyboard(false);
  }

  /* A Wi-Fi key is 8-63 printable ASCII characters, or exactly 64 hex digits: the sidecar's own
     rule (Wlan.CheckPassword), checked here too so a short one is caught before a round trip. */
  function passwordProblem(pw) {
    if (pw.length === 64 && /^[0-9a-fA-F]{64}$/.test(pw)) return null;
    if (pw.length < 8) return 'A Wi-Fi password is at least 8 characters.';
    if (pw.length > 63) return 'A Wi-Fi password is at most 63 characters (or exactly 64 hex digits).';
    if (!/^[\x20-\x7e]+$/.test(pw)) return 'A Wi-Fi password can only use letters, digits, spaces and the usual symbols.';
    return null;
  }

  function passwordForm(n, key, busy) {
    var form = h('form', 'qsx-pw');
    form.setAttribute('autocomplete', 'off');
    var lbl = h('label', 'qsx-pwlbl', 'Enter the network security key');
    var inp = document.createElement('input');
    inp.className = 'qsx-pwin';
    inp.type = 'password';
    inp.id = 'qsxpw';
    inp.autocomplete = 'new-password';     // never offered back by any autofill
    inp.spellcheck = false;
    inp.maxLength = 64;
    inp.disabled = busy;
    inp.setAttribute('aria-label', 'Network security key for ' + (n.ssid || 'this network'));
    lbl.htmlFor = 'qsxpw';
    var problem = h('div', 'qsx-err');
    problem.hidden = true;
    form.appendChild(lbl);
    form.appendChild(inp);
    form.appendChild(problem);
    var row = h('div', 'qsx-btns');
    var cancel = button('qsx-btn', 'Cancel');
    cancel.disabled = busy;
    cancel.addEventListener('click', function () { cancelPassword(); renderWifi(true); });
    var next = button('qsx-btn acc', busy ? 'Connecting…' : 'Next');
    next.type = 'submit';
    next.disabled = busy;
    row.appendChild(cancel);
    row.appendChild(next);
    form.appendChild(row);
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      if (S.w.busy) return;
      var bad = passwordProblem(inp.value);
      if (bad) { problem.textContent = bad; problem.hidden = false; inp.focus(); return; }
      var pw = inp.value;
      inp.value = '';                      // cleared in the same tick it is read
      connect(n, key, pw);
      pw = null;
    });
    setTimeout(function () { if (!inp.disabled) inp.focus(); }, 0);
    return form;
  }

  function connect(n, key, password) {
    var W = S.w, g = gen;
    W.busy = { key: key, what: 'connect' };
    delete W.fail[key];
    var args = { auto: W.auto[key] !== false };
    if (n.hex) args.hex = n.hex;
    if (n.ssid) args.ssid = n.ssid;
    if (password) args.password = password;
    password = null;
    // The bridge copies the arguments when it sends them (structured clone), so the only copy
    // left here goes the moment the call is made.
    var sent = B.call('qs.wifi.connect', args);
    delete args.password;
    renderWifi(true);
    sent.then(function (r) { done(r || { ok: false, reason: 'qs.wifi.connect gave no answer' }); },
      function (e) { done({ ok: false, reason: 'the connect could not be asked for: ' + B.msg(e) }); });

    function done(r) {
      if (!alive(g) || !S.w) return;
      W.busy = null;
      if (r.ok) {
        W.pwFor = null;
        W.open = null;
        if (S.kbd) releaseKeyboard(false);
      } else {
        W.fail[key] = failure('connect', LEADS[r.code] || 'Couldn’t connect.', r.reason, r.codeHex);
        W.open = key;                      // the password field stays, empty, under the reason
      }
      /* A list read DURING the attempt still says "connecting", and while the password field is
         open no poll redraws the list (it would wipe what is being typed): so the attempt's own
         end is written into the list here before the one redraw. */
      if (wifiData && Array.isArray(wifiData.networks)) {
        wifiData.networks.forEach(function (x) { if (netKey(x) === key) x.connecting = false; });
        wifiData.connecting = null;
      }
      renderWifi(true);
      readWifi();
    }
  }

  function disconnect(key) {
    var W = S.w, g = gen;
    W.busy = { key: key, what: 'disconnect' };
    renderWifi(true);
    B.call('qs.wifi.disconnect').then(function (r) { done(r || { ok: false, reason: 'qs.wifi.disconnect gave no answer' }); },
      function (e) { done({ ok: false, reason: 'the disconnect could not be asked for: ' + B.msg(e) }); });
    function done(r) {
      if (!alive(g) || !S.w) return;
      W.busy = null;
      if (r.ok) { W.open = null; delete W.fail[key]; }
      else W.fail[key] = failure('disconnect', 'Couldn’t disconnect.', r.reason);
      renderWifi(true);
      readWifi();
    }
  }

  function turnOn() {
    var g = gen;
    viewNote('radio', '');
    B.callR('qs.set', { part: 'wifi', value: true }).then(function () {
      if (!alive(g)) return;
      // the radio takes a moment to come up before Windows can list or scan anything
      setTimeout(function () {
        if (alive(g) && S.w) readWifi().then(function () { if (usable(wifiData)) scan(); });
      }, 900);
    }, function (e) {
      if (alive(g)) viewNote('radio', 'Wi-Fi could not be turned on: ' + B.msg(e));
    });
  }

  /* ================================================================== BLUETOOTH */

  function BTW() { return window.MantleBt || null; }
  function sentence(s) { s = String(s || ''); return /[.!?…]$/.test(s) ? s : s + '.'; }

  function buildBt(el) {
    var T = S.b = {
      list: null, status: null, noteEl: null, notes: {},
      open: null,          // the id of the expanded row
      busy: null,          // { id, what: 'connect' | 'disconnect' } while one of ours is in flight
      fail: {},            // id -> { op, lead, reason } from the last attempt on that row
      watch: false,        // the sidecar's watch is running for this view
      tick: 0, sig: ''
    };
    var head = header(el, 'Bluetooth');
    T.status = h('span', 'qsx-status');
    head.appendChild(T.status);
    T.list = h('div', 'qsx-scroll');
    el.appendChild(T.list);
    T.noteEl = h('div', 'qsx-notes');
    T.noteEl.hidden = true;
    el.appendChild(T.noteEl);
    footer(el, 'More Bluetooth settings', 'Settings › Bluetooth & devices', 'ms-settings:bluetooth', 'Bluetooth settings');

    if (!BTW()) {
      stateBlock(T.list, null, 'Bluetooth devices can’t be shown', 'ui/bar/bt.js did not load, so this view has no words or icons',
        [['Bluetooth settings', addDevice]], true);
      return;
    }
    if (btData) renderBt(true);
    else stateBlock(T.list, null, 'Looking for devices…', null, null);
    readBt();
    startBtWatch();
  }

  function readBt() {
    var g = gen;
    return B.call('qs.bt.list').then(function (r) {
      if (!alive(g) || !S.b) return;
      btData = r || { ok: false, reason: 'qs.bt.list gave no answer' };
      renderBt(false);
    }, function (e) {
      if (!alive(g) || !S.b) return;
      btData = { ok: false, reason: 'the Bluetooth devices could not be asked for: ' + B.msg(e) };
      renderBt(false);
    });
  }

  /* THE WATCH: the sidecar's DeviceWatcher, for as long as this view is open. It is renewed every
     BT_RENEW_MS and lapses on its own 90 s after the last renewal, so a bar that dies cannot leave
     it running. Without it (an older sidecar, a refusal, no event channel) the view re-reads the
     list every BT_POLL_MS instead, and its note says so and why. */
  function startBtWatch() {
    var g = gen;
    if (btEventsBroken) {
      viewNote('watch', fallbackNote('the view cannot hear its pushes: ' + btEventsBroken));
      btLoop();
      return;
    }
    renewBt(g).then(function () { if (alive(g) && S.b) btLoop(); });
  }

  function fallbackNote(why) {
    return 'Re-reading every ' + (BT_POLL_MS / 1000) + ' s, because the live watch is off: ' + sentence(why);
  }

  function renewBt(g) {
    return B.call('qs.bt.watch', { on: true }).then(function (r) {
      if (!alive(g) || !S.b) return;
      r = r || { ok: false, reason: 'qs.bt.watch gave no answer' };
      S.b.watch = !!(r.ok && r.watching);
      viewNote('watch', S.b.watch ? '' : fallbackNote(r.reason || 'the sidecar did not say why'));
    }, function (e) {
      if (!alive(g) || !S.b) return;
      S.b.watch = false;
      viewNote('watch', fallbackNote('qs.bt.watch was refused: ' + B.msg(e)));
    });
  }

  /* One chain, like poll(): the next step is chosen after each reply. With the watch on, a
     renewal every 30 s; without it, a list every 3 s and another try at the watch every 30 s. */
  function btLoop() {
    stopPoll();
    var T = S && S.b;
    if (!T) return;
    var g = gen;
    S.timer = setTimeout(function () {
      if (!alive(g) || !S.b) return;
      S.timer = 0;
      var T2 = S.b;
      T2.tick++;
      var step = T2.watch ? renewBt(g)
        : (!btEventsBroken && T2.tick % (BT_RENEW_MS / BT_POLL_MS) === 0) ? renewBt(g).then(readBt)
        : readBt();
      step.then(function () { if (alive(g) && S.b) btLoop(); });
    }, T.watch ? BT_RENEW_MS : BT_POLL_MS);
  }

  /* Always sent on the way out, whatever the view believes: a stop is idempotent, and a start still
     in flight when the panel closed would otherwise run until its lease lapsed. */
  function stopBtWatch() {
    B.call('qs.bt.watch', { on: false }).then(function (r) {
      if (r && r.ok === false) {
        B.fail('qsbt', 'Bluetooth watch', 'the Bluetooth device watch did not stop (' + (r.reason || 'no reason given') +
          '); it stops itself within 90 s', 'warn');
      }
    }, function (e) {
      B.fail('qsbt', 'Bluetooth watch', 'the Bluetooth device watch did not stop (' + B.msg(e) + '); it stops itself within 90 s', 'warn');
    });
  }

  /* A push from the watch: the whole list after a change settled, or word that the watch stopped. */
  function onBtPush(ev) {
    if (!S || !S.b || !ev) return;
    if (!Array.isArray(ev.devices) && ev.ok !== false) {
      if (ev.watching === false) {
        S.b.watch = false;
        viewNote('watch', fallbackNote(ev.watchReason || 'it stopped'));
        btLoop();
      }
      return;
    }
    btData = ev;
    renderBt(false);
  }

  function paintBtStatus(busy) {
    var T = S && S.b;
    if (!T) return;
    T.status.textContent = busy ? (busy.what === 'connect' ? 'Connecting…' : 'Disconnecting…') : '';
  }

  /* force: redraw even if nothing changed (a row opened, an attempt started or ended). */
  function renderBt(force) {
    var T = S && S.b, r = btData, M = BTW();
    if (!T || !r || !M) return;
    var busy = T.busy || M.busyOf(r);
    paintBtStatus(busy);
    viewNote('radio', M.radioNote(r));
    viewNote('last', M.lastNote(r, T.fail));
    var v = M.view(r);
    var list = v.state === 'list' ? r.devices : [];
    var sig = JSON.stringify([v.state, v.why, list.map(function (d) {
      return [d.id, d.name, d.kind, d.connected, d.battery, d.batteryWhy, d.canConnect, d.connectWhy];
    }), T.open, busy, T.fail]);
    if (!force && sig === T.sig) return;
    T.sig = sig;
    var keepScroll = T.list.scrollTop;
    T.list.textContent = '';

    if (v.state === 'error') {
      stateBlock(T.list, M.NO_BT, v.title, v.why, [['Try again', function () { readBt(); }]], true);
      return;
    }
    if (v.state === 'none') {
      stateBlock(T.list, M.NO_BT, v.title, v.why, [['Bluetooth settings', addDevice]]);
      return;
    }
    if (v.state === 'off') {
      stateBlock(T.list, M.NO_BT, v.title, v.why, [['Turn on Bluetooth', btTurnOn, false, true]]);
      return;
    }
    if (v.state === 'empty') {
      stateBlock(T.list, M.RUNE, v.title, v.why, [['Add device', addDevice, false, true]]);
      return;
    }
    list.forEach(function (d) { T.list.appendChild(btRow(d, busy)); });
    T.list.appendChild(addRow());
    T.list.scrollTop = keepScroll;
    if (force && T.open) {
      var openRow = T.list.querySelector('.qsx-net.open');
      if (openRow && openRow.scrollIntoView) openRow.scrollIntoView({ block: 'nearest' });
    }
  }

  function btRow(d, busy) {
    var T = S.b, M = BTW();
    var x = M.describe(d, { busy: busy, fail: T.fail });
    var row = h('div', 'qsx-net qsx-bt');
    row.setAttribute('data-bt', x.name);
    row.classList.toggle('on', x.state === 'connected');
    row.classList.toggle('open', T.open === d.id);
    row.classList.toggle('busy', x.state === 'connecting' || x.state === 'disconnecting');
    row.classList.toggle('fail', x.state === 'failed');

    var head = button('qsx-nethead');
    var ico = h('span', 'qsx-netico');
    ico.innerHTML = svg(x.icon);
    var txt = h('span', 'qsx-nettext');
    txt.appendChild(h('span', 'qsx-netname', x.name));
    txt.appendChild(h('span', 'qsx-netsub', x.sub));
    head.appendChild(ico);
    head.appendChild(txt);
    if (x.battery !== null) {
      var bat = h('span', 'qsx-btbatt');
      bat.innerHTML = svg(M.batteryGlyph(x.battery));
      bat.appendChild(h('span', null, x.batteryText));
      head.appendChild(bat);
    }
    head.title = x.tip;
    head.setAttribute('aria-expanded', String(T.open === d.id));
    head.addEventListener('click', function () {
      T.open = T.open === d.id ? null : d.id;
      renderBt(true);
    });
    row.appendChild(head);
    if (T.open === d.id) row.appendChild(btBody(d, x, busy));
    return row;
  }

  function btBody(d, x, busy) {
    var body = h('div', 'qsx-netbody');
    if (x.failLead) {
      var err = h('div', 'qsx-err');
      err.appendChild(h('div', 'qsx-errlead', x.failLead));
      err.appendChild(h('div', 'qsx-errwhy', x.failWhy));
      body.appendChild(err);
    }
    if (x.batteryWhy) body.appendChild(h('div', 'qsx-hint', 'Battery: ' + sentence(x.batteryWhy)));
    if (x.action === 'settings') {
      body.appendChild(h('div', 'qsx-hint', sentence(x.actionWhy)));
      buttons(body, [['Open Bluetooth settings', addDevice]]);
      return body;
    }
    var mine = !!(busy && busy.id === d.id);
    var other = !!(busy && busy.id !== d.id);
    buttons(body, [[x.actionLabel, function () { btToggle(d, x.action); }, mine || other, x.action === 'connect',
      other ? 'Mantle is busy with another device; wait for it to finish' : '']]);
    return body;
  }

  /* Pairing stays Windows': its Settings page is where devices are added. */
  function addRow() {
    var b = button('qsx-nethead qsx-add');
    var ico = h('span', 'qsx-netico');
    ico.innerHTML = svg(BTW().PLUS);
    b.appendChild(ico);
    b.appendChild(h('span', 'qsx-netname', 'Add device'));
    b.title = 'Pair a new device in Settings › Bluetooth & devices';
    b.addEventListener('click', addDevice);
    return b;
  }
  function addDevice() { openOut('ms-settings:bluetooth', 'Bluetooth settings', null); }

  function btToggle(d, what) {
    var T = S.b, g = gen, M = BTW();
    if (T.busy || M.busyOf(btData)) return;
    T.busy = { id: d.id, what: what };
    delete T.fail[d.id];
    renderBt(true);
    B.call(what === 'connect' ? 'qs.bt.connect' : 'qs.bt.disconnect', { device: d.id }).then(function (r) {
      done(r || { ok: false, reason: 'qs.bt.' + what + ' gave no answer' });
    }, function (e) {
      done({ ok: false, reason: 'the ' + what + ' could not be asked for: ' + B.msg(e) });
    });
    function done(r) {
      if (!alive(g) || !S.b) return;
      T.busy = null;
      if (r.ok) delete T.fail[d.id];
      else T.fail[d.id] = { op: what, lead: what === 'connect' ? 'Couldn’t connect.' : 'Couldn’t disconnect.', reason: r.reason || 'no reason given' };
      // THE STATE COMES FROM THE READ-BACK: the sidecar re-read Windows' own flag before answering.
      if (typeof r.connected === 'boolean' && btData && Array.isArray(btData.devices)) {
        btData.devices.forEach(function (x) { if (x.id === d.id) x.connected = r.connected; });
      }
      renderBt(true);
      readBt();
    }
  }

  function btTurnOn() {
    var g = gen;
    viewNote('radioOn', '');
    B.callR('qs.set', { part: 'bluetooth', value: true }).then(function () {
      if (!alive(g)) return;
      // the radio takes a moment before Windows reports the paired devices' state again
      setTimeout(function () { if (alive(g) && S.b) readBt(); }, 900);
    }, function (e) {
      if (alive(g)) viewNote('radioOn', 'Bluetooth could not be turned on: ' + B.msg(e));
    });
  }

  /* ================================================================== SOUND */

  function buildSound(el) {
    var A = S.a = {
      devs: null, mix: null, noteEl: null, notes: {},
      busyDev: null, devErr: null, rows: {}, keys: '', tick: 0, devSig: ''
    };
    header(el, 'Sound output');
    var scroll = h('div', 'qsx-scroll');
    A.devs = h('div', 'qsx-devs');
    scroll.appendChild(A.devs);
    scroll.appendChild(h('div', 'qsx-section', 'Volume mixer'));
    A.mix = h('div', 'qsx-mix');
    scroll.appendChild(A.mix);
    el.appendChild(scroll);
    A.noteEl = h('div', 'qsx-notes');
    A.noteEl.hidden = true;
    el.appendChild(A.noteEl);
    footer(el, 'More volume settings', 'Settings › System › Sound › Volume mixer', 'ms-settings:apps-volume', 'Volume settings');

    if (devData) renderDevices(true);
    else stateBlock(A.devs, null, 'Reading playback devices…', null, null);
    if (mixData) renderMixer(true);
    readDevices();
    readSessions();
    poll(soundTick, SOUND_POLL_MS);
  }

  function soundTick() {
    var A = S && S.a;
    if (!A) return Promise.resolve();
    A.tick++;
    return A.tick % DEVICES_EVERY === 0 ? Promise.all([readSessions(), readDevices()]) : readSessions();
  }

  function readDevices() {
    var g = gen;
    return B.call('qs.audio.devices').then(function (r) {
      if (!alive(g) || !S.a) return;
      devData = r || { ok: false, reason: 'qs.audio.devices gave no answer' };
      renderDevices(false);
    }, function (e) {
      if (!alive(g) || !S.a) return;
      devData = { ok: false, reason: 'the playback devices could not be asked for: ' + B.msg(e) };
      renderDevices(false);
    });
  }

  function renderDevices(force) {
    var A = S && S.a, r = devData;
    if (!A || !r) return;
    var list = Array.isArray(r.devices) ? r.devices : [];
    var sig = JSON.stringify([r.ok, r.reason, list.map(function (d) { return [d.id, d.name, d.isDefault, d.roles]; }), A.busyDev, A.devErr]);
    if (!force && sig === A.devSig) return;
    A.devSig = sig;
    A.devs.textContent = '';
    if (r.ok === false) {
      stateBlock(A.devs, null, 'Playback devices can’t be read', r.reason || 'no reason given', [['Try again', function () { readDevices(); }]], true);
      return;
    }
    if (!list.length) {
      stateBlock(A.devs, null, 'No playback devices', 'Windows lists no active speakers or headphones. Plug one in, or enable one in Sound settings.',
        [['Sound settings', function () { openOut('ms-settings:sound', 'Sound settings', null); }]]);
      return;
    }
    list.forEach(function (d) { A.devs.appendChild(devRow(d)); });
    if (A.devErr) {
      var err = h('div', 'qsx-err qsx-deverr');
      err.appendChild(h('div', 'qsx-errlead', 'The output did not change.'));
      err.appendChild(h('div', 'qsx-errwhy', A.devErr));
      A.devs.appendChild(err);
    }
  }

  function devRow(d) {
    var A = S.a;
    var b = button('qsx-dev');
    b.classList.toggle('on', !!d.isDefault);
    b.classList.toggle('busy', A.busyDev === d.id);
    b.setAttribute('aria-pressed', String(!!d.isDefault));
    var ck = h('span', 'qsx-check');
    ck.innerHTML = d.isDefault ? svg(CHECK) : '';
    b.appendChild(ck);
    b.appendChild(h('span', 'qsx-devname', d.name));
    var roles = d.roles || {};
    var partly = d.isDefault && roles.communications === false;
    var calls = !d.isDefault && roles.communications === true;
    if (A.busyDev === d.id) b.appendChild(h('span', 'qsx-devsub', 'Switching…'));
    else if (calls) b.appendChild(h('span', 'qsx-devsub', 'Calls'));
    b.title = d.isDefault
      ? d.name + ' is the output' + (partly ? ' (calls still go to another device; click another device and back to move them too)' : '')
      : 'Play sound through ' + d.name + (calls ? '\n(already the device for calls)' : '');
    b.addEventListener('click', function () {
      if (d.isDefault || A.busyDev) return;   // already the output: a no-op call would still make Windows re-announce it
      setDefault(d);
    });
    return b;
  }

  function setDefault(d) {
    var A = S.a, g = gen;
    A.busyDev = d.id;
    A.devErr = null;
    renderDevices(true);
    B.call('qs.audio.default', { device: d.id }).then(function (r) { done(r || { ok: false, reason: 'qs.audio.default gave no answer' }); },
      function (e) { done({ ok: false, reason: 'the change could not be asked for: ' + B.msg(e) }); });
    function done(r) {
      if (!alive(g) || !S.a) return;
      A.busyDev = null;
      // THE CHECK COMES FROM THE READ-BACK: the device list the set returns after it re-read Windows
      if (Array.isArray(r.devices) && r.devices.length) devData = { ok: true, devices: r.devices, reason: null };
      A.devErr = r.ok ? null : (r.reason || 'no reason given');
      renderDevices(true);
      if (!r.devices) readDevices();
      readSessions();                      // the mixer follows the default device
    }
  }

  /* ------------------------------------------------------------------ the mixer */

  function readSessions() {
    var g = gen;
    return B.call('qs.audio.sessions').then(function (r) {
      if (!alive(g) || !S.a) return;
      mixData = r || { ok: false, reason: 'qs.audio.sessions gave no answer' };
      renderMixer(false);
    }, function (e) {
      if (!alive(g) || !S.a) return;
      mixData = { ok: false, reason: 'the apps playing sound could not be asked for: ' + B.msg(e), sessions: [] };
      renderMixer(false);
    });
  }

  /* The rows are rebuilt only when the set of apps changes; otherwise each row is updated in place,
     so a slider being dragged is never replaced under the pointer. */
  function renderMixer(force) {
    var A = S && S.a, r = mixData;
    if (!A || !r) return;
    var ss = Array.isArray(r.sessions) ? r.sessions : [];
    var keys = (r.ok === false ? 'x:' + r.reason : '') + '|' + ss.map(function (s) { return s.key; }).join('|');
    if (force || keys !== A.keys) {
      A.keys = keys;
      A.rows = {};
      A.mix.textContent = '';
      if (r.ok === false) {
        stateBlock(A.mix, null, 'The mixer can’t be read', r.reason || 'no reason given', [['Try again', function () { readSessions(); }]], true);
        return;
      }
      if (!ss.length) {
        stateBlock(A.mix, null, 'No apps are playing sound',
          r.reason || ('Apps appear here while they have sound open' + (r.device && r.device.name ? ' on ' + r.device.name : '') + '.'), null);
        return;
      }
      ss.forEach(function (s) { var row = appRow(s); A.rows[s.key] = row; A.mix.appendChild(row.el); });
    }
    ss.forEach(function (s) { if (A.rows[s.key]) paintApp(A.rows[s.key], s); });
  }

  function appIcon(s) {
    var box = h('span', 'qsx-appico');
    if (s.system) { box.innerHTML = svg(BELL); box.title = 'Windows system sounds'; return box; }
    if (s.icon) {
      var img = document.createElement('img');
      img.alt = '';
      img.src = s.icon;
      img.onerror = function () { box.textContent = ''; box.appendChild(letter(s, 'the icon did not load')); };
      box.appendChild(img);
      return box;
    }
    box.appendChild(letter(s, s.iconReason || 'no icon was given'));
    return box;
  }
  function letter(s, why) {
    var l = h('span', 'qsx-letter', ((s.name || '?').replace(/[^0-9A-Za-z]/g, '').charAt(0) || '?').toUpperCase());
    l.title = why;                         // a letter instead of an icon says why, one hover away
    return l;
  }

  function appRow(s) {
    var row = { el: h('div', 'qsx-app'), key: s.key, drag: false, dragUntil: 0, err: null, s: s };
    var top = h('div', 'qsx-apptop');
    row.ico = appIcon(s);
    row.name = h('span', 'qsx-appname');
    row.val = h('span', 'qsx-appval');
    top.appendChild(row.ico);
    top.appendChild(row.name);
    top.appendChild(row.val);
    var line = h('div', 'qsline qsx-appline');
    var range = document.createElement('input');
    range.type = 'range'; range.min = '0'; range.max = '100'; range.step = '1';
    range.setAttribute('aria-label', 'Volume for ' + (s.name || 'this app'));
    row.range = range;
    row.mute = button('qsmute qsx-appmute');
    line.appendChild(range);
    line.appendChild(row.mute);
    row.errEl = h('div', 'qsx-err qsx-apperr');
    row.errEl.hidden = true;
    row.el.appendChild(top);
    row.el.appendChild(line);
    row.el.appendChild(row.errEl);

    /* The panel's own sliders' sender (qs-send.js, 2026-09-23): one set in flight, only the newest
       level waiting, the level the pointer stops on always sent. It was a 100 ms throttle plus a
       set on `change`, whether or not the last had answered. While a set is in flight, a read-back
       of an older level does not move the slider; the last one is painted when all have answered. */
    var born = gen;                        // this row's view; a later view has rows of its own
    var send = row.send = window.MantleQsSend
      ? MantleQsSend.sender(function (v) { return setApp(row, { level: v }); },
          { minGapMs: 16, onIdle: function () { if (alive(born)) paintApp(row, row.s); } })
      : { push: function (v) { setApp(row, { level: v }); }, busy: function () { return false; } };
    range.addEventListener('pointerdown', function () { row.drag = true; });
    range.addEventListener('input', function () {
      row.dragUntil = Date.now() + 700;
      row.val.textContent = range.value + '%';
      send.push(Number(range.value));
    });
    range.addEventListener('change', function () {
      row.drag = false;
      row.dragUntil = Date.now() + 700;
      send.push(Number(range.value));
    });
    range.addEventListener('pointerup', function () { row.drag = false; });
    row.mute.addEventListener('click', function () { setApp(row, { muted: !row.s.muted }); });
    return row;
  }

  function paintApp(row, s) {
    row.s = s;
    row.el.classList.toggle('idle', !s.active);
    row.el.classList.toggle('muted', !!s.muted);
    row.name.textContent = s.system ? 'System sounds' : (s.name || 'An app');
    row.name.title = (s.system ? 'Windows system sounds' : (s.name || '')) +
      (s.path ? '\n' + s.path : '') +
      (s.sessions > 1 ? '\n' + s.sessions + ' audio sessions, one slider' : '') +
      (s.active ? '' : '\nNot playing right now');
    var dragging = row.drag || Date.now() < row.dragUntil || !!(row.send && row.send.busy());
    if (!dragging && typeof s.level === 'number') {
      row.range.value = String(s.level);
      row.val.textContent = s.level + '%';
    }
    row.mute.innerHTML = B.volumeSvg(s.muted ? 0 : (s.level || 0) / 100, !!s.muted);
    row.mute.classList.toggle('on', !!s.muted);
    row.mute.title = (s.muted ? 'Unmute ' : 'Mute ') + (s.system ? 'system sounds' : (s.name || 'this app'));
    row.mute.setAttribute('aria-pressed', String(!!s.muted));
    row.errEl.textContent = row.err || '';
    row.errEl.hidden = !row.err;
  }

  function setApp(row, change) {
    var g = gen;
    var args = { key: row.key };
    if (change.level !== undefined) args.level = change.level;
    if (change.muted !== undefined) args.muted = change.muted;
    if (change.muted !== undefined) row.mute.classList.add('pending');
    // the answer goes back to the sender too (qs-send.js), so it knows when a set did not take
    return B.call('qs.audio.session', args).then(function (r) { r = r || { ok: false, reason: 'qs.audio.session gave no answer' }; done(r); return r; },
      function (e) { var r = { ok: false, reason: 'the change could not be asked for: ' + B.msg(e) }; done(r); return r; });
    function done(r) {
      if (!alive(g) || !S.a) return;
      row.mute.classList.remove('pending');
      row.err = r.ok ? null : (r.reason || 'no reason given');
      // THE READ-BACK WINS: the row shows what the session holds now, not what was asked for
      if (r.session) {
        if (change.level !== undefined) row.dragUntil = 0;
        paintApp(row, r.session);
        if (mixData && Array.isArray(mixData.sessions)) {
          mixData.sessions = mixData.sessions.map(function (s) { return s.key === r.session.key ? Object.assign({}, s, r.session, { icon: s.icon, iconReason: s.iconReason }) : s; });
        }
      } else {
        paintApp(row, row.s);
        if (!r.ok) readSessions();
      }
    }
  }

  window.MantleQsMore = { init: init, attach: attach, closed: closed };
})();
