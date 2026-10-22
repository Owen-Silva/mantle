/* bt.js — the Bluetooth device list's words and glyphs, from ONE sidecar reply (sidecar/BtDevices.cs).
 *
 * The quick-settings panel's '>' on the Bluetooth tile opens the PAIRED devices in the same panel,
 * Windows 11's shape (qsx lane, 2026-09-23): a type icon, the name, Connected / Not connected, the
 * battery where Windows knows it, and Connect / Disconnect on audio devices. ui/bar/qs-more.js draws
 * it; every word it draws comes from here, and ui/bar/bt.test.js pins them down in node.
 *
 * THE TYPE ICON comes from what the device says it is (its Bluetooth Class of Device, or its LE
 * Appearance), else from Windows' own category for it; never from its name. Measured on the user's
 * machine: WH-CH520 = class 4/1 (a headset), Xbox Wireless Controller = 5/2 (a gamepad), Living Room
 * TV = 4/15 (a video display: "other").
 *
 * THE BATTERY only while connected, the way Windows shows it. A device node keeps the last level it
 * saw after the device goes (both WH-CH520 read 100 while switched off, 2026-09-23), so a level
 * beside "Not connected" would be a stale number dressed as a reading.
 *
 * CONNECT / DISCONNECT only where the sidecar found Windows' Bluetooth audio control under the
 * device's sound devices (canConnect). Everything else gets the reason and Windows' own settings.
 *
 * Loaded as a plain <script> by the bar (window.MantleBt) and by require() in node. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MantleBt = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var KINDS = {
    headphones: 'Headphones',
    speaker: 'Speaker',
    mouse: 'Mouse',
    keyboard: 'Keyboard',
    phone: 'Phone',
    gamepad: 'Game controller',
    other: 'Bluetooth device'
  };

  /* 16x16 bodies for the bar's svg(), drawn in the same 1.2 px stroke as the panel's other glyphs. */
  var LINE = ' fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"';
  /* The rune is the Bluetooth tile's own (bar.js BT_GLYPH), so "other" reads as the tile's device. */
  var RUNE = '<path d="M6 4.4L10.2 8 6 11.6M8 2v12l2.2-2.4M8 8L5.2 5.8M8 8l-2.8 2.2"' +
             ' fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>';
  var ICONS = {
    headphones: '<path d="M2.8 10.2V8.3a5.2 5.2 0 0 1 10.4 0v1.9"' + LINE + '/>' +
                '<rect x="1.9" y="9.2" width="3" height="4.6" rx="1.2" fill="currentColor"/>' +
                '<rect x="11.1" y="9.2" width="3" height="4.6" rx="1.2" fill="currentColor"/>',
    speaker: '<rect x="3.7" y="1.8" width="8.6" height="12.4" rx="1.8"' + LINE + '/>' +
             '<circle cx="8" cy="9.9" r="2.3"' + LINE + '/><circle cx="8" cy="4.9" r=".9" fill="currentColor"/>',
    mouse: '<rect x="4.3" y="1.8" width="7.4" height="12.4" rx="3.7"' + LINE + '/><path d="M8 2.2v3.6"' + LINE + '/>',
    keyboard: '<rect x="1.3" y="3.9" width="13.4" height="8.2" rx="1.6"' + LINE + '/>' +
              '<path d="M4.1 6.6h.01M6.4 6.6h.01M8.7 6.6h.01M11 6.6h.01M4.1 9.4h.01M11 9.4h.01M6.3 9.4h3.4"' +
              ' fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
    phone: '<rect x="4.4" y="1.4" width="7.2" height="13.2" rx="1.7"' + LINE + '/><path d="M7 12.2h2"' + LINE + '/>',
    gamepad: '<path d="M5.3 4.7h5.4a3.2 3.2 0 0 1 3.1 2.5l.7 3.1a1.6 1.6 0 0 1-2.8 1.4L10.6 10.4H5.4l-1.1 1.3a1.6 1.6 0 0 1-2.8-1.4l.7-3.1a3.2 3.2 0 0 1 3.1-2.5z"' + LINE + '/>' +
             '<path d="M5.2 6.6v2.4M4 7.8h2.4"' + LINE + '/>' +
             '<circle cx="10.6" cy="7.2" r=".8" fill="currentColor"/><circle cx="11.9" cy="8.6" r=".8" fill="currentColor"/>',
    other: RUNE
  };
  var NO_BT = '<path d="M6 4.4L10.2 8 6 11.6M8 2v12l2.2-2.4M8 8L5.2 5.8M8 8l-2.8 2.2"' +
              ' fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" opacity=".4"/>' +
              '<path d="M3 2.5l10 10.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>';
  var PLUS = '<path d="M8 3.2v9.6M3.2 8h9.6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>';

  /* A small battery for a row's right edge: outline, nub, and a fill to the level. */
  function batteryGlyph(pct) {
    var p = typeof pct === 'number' && isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 0;
    var s = '<rect x="1.3" y="5.1" width="11.4" height="5.8" rx="1.6"' + LINE + '/>' +
            '<rect x="13.3" y="6.8" width="1.4" height="2.4" rx=".6" fill="currentColor"/>';
    var w = 8.6 * p / 100;
    if (w >= 0.4) s += '<rect x="2.7" y="6.5" width="' + w.toFixed(2) + '" height="3" rx=".8" fill="currentColor"/>';
    return s;
  }

  function kindOf(d) {
    return d && Object.prototype.hasOwnProperty.call(KINDS, d.kind) ? d.kind : 'other';
  }

  /* The level to show, or null: only a whole 0-100 number, and only while connected. */
  function battery(d) {
    if (!d || d.connected !== true) return null;
    var b = d.battery;
    if (typeof b !== 'number' || !isFinite(b) || b < 0 || b > 100) return null;
    return Math.round(b);
  }

  /* A failed attempt shows where it is still true: a connect that failed on a device that is not
     connected, a disconnect that failed on one that still is. */
  function failShows(f, d) { return !!f && (f.op === 'disconnect' ? d.connected === true : d.connected !== true); }

  /* One row. st: { busy: {id, what: 'connect'|'disconnect'} or null, fail: {id: {op, lead, reason}} } */
  function describe(d, st) {
    d = d || {};
    st = st || {};
    var kind = kindOf(d);
    var name = typeof d.name === 'string' && d.name.trim() ? d.name : 'Unnamed device';
    var busy = st.busy && st.busy.id === d.id ? st.busy.what : null;
    var f = st.fail && d.id && st.fail[d.id];
    var failed = !busy && failShows(f, d) ? f : null;
    var state = busy === 'connect' ? 'connecting'
      : busy === 'disconnect' ? 'disconnecting'
      : failed ? 'failed'
      : d.connected === true ? 'connected' : 'disconnected';
    var sub = state === 'connecting' ? 'Connecting…'
      : state === 'disconnecting' ? 'Disconnecting…'
      : state === 'failed' ? (failed.op === 'disconnect' ? 'Couldn’t disconnect' : 'Couldn’t connect')
      : state === 'connected' ? 'Connected' : 'Not connected';
    var pct = battery(d);
    var batteryWhy = d.connected === true && pct === null
      ? (typeof d.batteryWhy === 'string' && d.batteryWhy ? d.batteryWhy : 'Windows gave no battery level for it')
      : null;
    var action = d.canConnect === true ? (d.connected === true ? 'disconnect' : 'connect') : 'settings';
    var actionWhy = action === 'settings'
      ? (typeof d.connectWhy === 'string' && d.connectWhy ? d.connectWhy : 'Mantle has no way to connect this device')
      : null;
    var actionLabel = action === 'settings' ? 'Open Bluetooth settings'
      : busy === action ? (action === 'connect' ? 'Connecting…' : 'Disconnecting…')
      : action === 'connect' ? 'Connect' : 'Disconnect';
    var tip = name + '\n' + KINDS[kind] + ' · ' + (d.connected === true ? 'Connected' : 'Not connected') +
      (pct !== null ? ' · battery ' + pct + '%' : '') +
      (batteryWhy ? '\nBattery: ' + batteryWhy : '') +
      (actionWhy ? '\n' + actionWhy : '');
    return {
      id: d.id, name: name, kind: kind, kindLabel: KINDS[kind], icon: ICONS[kind],
      state: state, sub: sub, connected: d.connected === true,
      battery: pct, batteryText: pct === null ? '' : pct + '%', batteryWhy: batteryWhy,
      action: action, actionLabel: actionLabel, actionWhy: actionWhy,
      failLead: failed ? failed.lead || (failed.op === 'disconnect' ? 'Couldn’t disconnect.' : 'Couldn’t connect.') : null,
      failWhy: failed ? failed.reason || 'no reason given' : null,
      tip: tip
    };
  }

  /* A reason that stands alone: a capital first letter and a full stop. */
  function said(s) {
    s = String(s || '').trim();
    if (!s) return s;
    s = s.charAt(0).toUpperCase() + s.slice(1);
    return /[.!?…]$/.test(s) ? s : s + '.';
  }

  /* The whole view: a list, or a state block with what is wrong and why. */
  function view(r) {
    if (!r) return { state: 'loading', title: 'Looking for devices…', why: null };
    if (r.ok === false) return { state: 'error', title: 'Bluetooth devices can’t be read', why: r.reason || 'no reason given' };
    if (r.present === false) {
      return { state: 'none', title: 'No Bluetooth adapter',
               why: said(r.reason || r.radioReason || 'Windows lists no Bluetooth radio on this machine') };
    }
    if (r.on === false) {
      return { state: 'off', title: 'Bluetooth is off', why: 'Turn it on to connect your paired devices.' };
    }
    var list = Array.isArray(r.devices) ? r.devices : [];
    if (!list.length) {
      return { state: 'empty', title: 'No paired devices',
               why: 'Pair a device in Windows’ Bluetooth settings, and it shows up here.' };
    }
    return { state: 'list', title: null, why: null };
  }

  /* The radio could not be read, but the list could: the list shows, and this says why the
     on/off state is a guess. */
  function radioNote(r) {
    if (!r || r.ok === false || r.present === false) return '';
    if (r.on !== true && r.on !== false) {
      return 'Bluetooth’s on/off state could not be read' + (r.radioReason ? ': ' + r.radioReason : '');
    }
    return '';
  }

  /* THE QUICK-SETTINGS TILE (2026-09-27). The user: "when i turn blutooth off it just does this and
     then doesnt let me turn it back on" - the tile read "No radio" and went dead. The sidecar took
     Win32's radio enumeration as the truth, and his Realtek radio is not enumerated while it is
     OFF (sidecar/Bluetooth.cs Present). The sidecar now reads Windows' radio list (`radio`, and
     `present` only false when that list has no Bluetooth radio at all), and this turns ONE part
     (qs.get's `bluetooth`) into the tile:
       sub      the small line under "Bluetooth"
       tip      the tooltip, and the note a click adds when there is nothing to do
       on       lit
       live     a click switches the radio
       open     a click opens this Settings page instead ({target, what}), or null
       glyph    'rune', or 'none' for the struck-through rune (no radio)
     Never a dead tile once read: a radio Mantle cannot switch gets Windows' own page. */
  var BT_SETTINGS = { target: 'ms-settings:bluetooth', what: 'Bluetooth settings' };
  var PLANE_SETTINGS = { target: 'ms-settings:network-airplanemode', what: 'airplane mode settings' };
  var RADIO_SETTINGS = { target: 'ms-settings:privacy-radios', what: 'radio privacy settings' };

  function tile(b) {
    if (!b) return { sub: 'Unknown', tip: 'Bluetooth has not been read yet', on: false, live: false, open: null, glyph: 'rune' };
    if (b.pending) {
      return { sub: 'Checking…', tip: said(b.reason || 'Bluetooth is still being read for the first time'),
               on: false, live: false, open: null, glyph: 'rune' };
    }
    var slow = !!(b.via && /powershell/i.test(String(b.via)));
    var plane = b.airplane === true;
    var then = function (o) { return '\nClick to open ' + o.what + '.'; };
    if (b.ok === false) {
      var why = said(b.reason || 'the shell gave no reason why Bluetooth is unavailable');
      return { sub: 'Unavailable', tip: 'Bluetooth can’t be read: ' + why + then(BT_SETTINGS),
               on: false, live: false, open: BT_SETTINGS, glyph: 'rune' };
    }
    if (b.present === false) {
      return { sub: 'No radio', tip: 'No Bluetooth radio: ' + said(b.reason || 'Windows lists no Bluetooth radio on this PC') + then(BT_SETTINGS),
               on: false, live: false, open: BT_SETTINGS, glyph: 'none' };
    }
    if (b.radio === 'disabled') {
      var o = plane ? PLANE_SETTINGS : BT_SETTINGS;
      return { sub: plane ? 'Airplane mode' : 'Disabled',
               tip: said(b.reason || (plane ? 'Bluetooth is turned off by airplane mode' : 'Bluetooth is disabled by a hardware switch or the firmware')) +
                    '\nMantle can’t switch it on: Windows refuses a disabled radio.' + then(o),
               on: false, live: false, open: o, glyph: 'rune' };
    }
    if (b.canSwitch === false) {
      // read fine, but Windows will not take a switch from Mantle (radio access denied)
      var blocked = b.access && b.access !== 'Allowed';
      var ob = blocked ? RADIO_SETTINGS : BT_SETTINGS;
      return { sub: (b.on ? 'On' : 'Off') + ' · locked',
               tip: 'Bluetooth is ' + (b.on ? 'on' : 'off') + ', and Mantle can’t switch it: ' +
                    said(b.reason || 'Windows does not let Mantle switch this radio') + then(ob),
               on: !!b.on, live: false, open: ob, glyph: 'rune' };
    }
    var sub = b.on ? 'On' : 'Off' + (plane ? ' · airplane mode' : '');
    var tip = (slow ? 'Switched via PowerShell, so it takes a second or two\n' : '') +
              'Turn Bluetooth ' + (b.on ? 'off' : 'on') +
              (!b.on && plane ? '\nAirplane mode is on; Bluetooth can still be switched on by itself' : '');
    return { sub: sub + (slow ? ' · slow' : ''), tip: tip, on: !!b.on, live: true, open: null, glyph: 'rune' };
  }

  /* The panel's note for a switch Windows (or Mantle) refused: which way it was going, and the
     sidecar's reason, which names Windows' RadioAccessStatus (DeniedByUser / DeniedBySystem /
     Unspecified) and what to do about it. Never silent: no reason still says so. */
  function refusedNote(reason, want) {
    var why = said(reason || 'Windows refused and gave no reason');
    // the sidecar's refusals already say "Windows refused to switch Bluetooth on (...)"
    if (/switch bluetooth (on|off)/i.test(why)) return why;
    return 'Bluetooth did not switch ' + (want ? 'on' : 'off') + ': ' + why;
  }

  function ago(ms) {
    var s = Math.round((typeof ms === 'number' && isFinite(ms) ? ms : 0) / 1000);
    return s < 5 ? 'just now' : s < 60 ? s + ' s ago' : Math.round(s / 60) + ' min ago';
  }

  /* The sidecar keeps the last connect or disconnect for two minutes, so an outcome that landed
     after the panel closed is still told when the list opens again. Not when that row already
     shows its own failure. */
  function lastNote(r, rowFails) {
    var l = r && r.last;
    if (!l || l.ok !== false) return '';
    if (rowFails && l.device && rowFails[l.device]) return '';
    var who = l.name || 'the device';
    return 'Last attempt (' + ago(l.agoMs) + '): ' + who + (l.op === 'disconnect' ? ' did not disconnect' : ' did not connect') +
      ' — ' + (l.reason || 'no reason given');
  }

  /* The sidecar's own in-flight connect (from a panel that has since closed), as the view's busy. */
  function busyOf(r) {
    var b = r && r.busy;
    return b && b.device && (b.op === 'connect' || b.op === 'disconnect') ? { id: b.device, what: b.op } : null;
  }

  return {
    KINDS: KINDS, ICONS: ICONS, RUNE: RUNE, NO_BT: NO_BT, PLUS: PLUS,
    batteryGlyph: batteryGlyph, kindOf: kindOf, battery: battery, failShows: failShows, said: said,
    describe: describe, view: view, radioNote: radioNote, lastNote: lastNote, busyOf: busyOf, ago: ago,
    tile: tile, refusedNote: refusedNote
  };
}));
