/* _qstiles-core.js - the words of quick settings' new tiles, PURE (lane qstiles, 2026-10-15; plan
 * notes/mantle-replace-windows.md P8). Shared by lib/features/qstiles.js (main) and
 * ui/bar/qs-tiles.js (the bar), so a tile and its tooltip never disagree with main.
 *
 *   Do not disturb   sysnotify.dnd (Mantle Settings > Notifications' own switch); Mantle's banners
 *                    check Windows' ACTIVE quiet-hours profile before each one, so they honour it
 *   Airplane mode    netair.set (Mantle Settings > Network & internet's own switch)
 *   Focus            Mantle's timer (30 min) + Do not disturb; when the timer ends or is cancelled,
 *                    Do not disturb goes back to what it was
 *   Project          _project-core.tile (Win+P's pop-up)
 *   Cast             Windows' own Cast panel (Win+K): no public API lets an app start a whole-screen
 *                    Miracast session, so Mantle hands this one over and says so
 *   Mobile hotspot   NOT HERE: Mantle Settings has no hotspot switch yet (its page says why)
 *
 * state (qstiles.state) = { on, dnd: {ok, on, writable, reason, rule}, airplane: {ok, on, canSet, reason},
 *   focus: {on, endAt, minutes, dndByFocus} | null, timer: {ok, reason}, readAt, readError, test }
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MantleQsTilesCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var FOCUS_MIN = 30;
  var TILES = [
    ['airplane', 'Airplane mode'], ['dnd', 'Do not disturb'], ['focus', 'Focus'], ['project', 'Project'], ['cast', 'Cast'],
  ];

  function cap(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }
  function mins(ms) { var m = Math.max(1, Math.ceil(ms / 60000)); return m + ' min'; }

  function dnd(st) {
    var d = st && st.dnd;
    if (st && st.on === false) return off('Do not disturb');
    if (!d) return { dead: false, on: false, sub: st && st.readError ? 'Unknown' : 'Reading…', tip: 'Do not disturb is still being read', reading: true };
    if (d.ok === false || d.writable === false) {
      return { dead: true, on: false, sub: 'Unavailable', tip: 'Do not disturb: ' + cap(d.reason || 'Windows did not say whether it is on') };
    }
    var byFocus = !!(st.focus && st.focus.on && st.focus.dndByFocus);
    if (d.on) return { dead: false, on: true, sub: byFocus ? 'On · Focus' : 'On',
                       tip: 'Do not disturb is on: banners are silenced (Mantle’s too).\nClick to turn it off' + (byFocus ? ' (Focus keeps running)' : '') };
    if (d.rule) return { dead: false, on: false, sub: 'Off · a rule is on',
                         tip: 'One of Windows’ automatic rules is silencing banners right now (' + d.rule + ').\nClick to turn Do not disturb on yourself' };
    return { dead: false, on: false, sub: 'Off', tip: 'Turn Do not disturb on: banners are silenced, Mantle’s too' };
  }

  function airplane(st) {
    var a = st && st.airplane;
    if (st && st.on === false) return off('Airplane mode');
    if (!a) return { dead: false, on: false, sub: st && st.readError ? 'Unknown' : 'Reading…', tip: 'Airplane mode is still being read', reading: true };
    if (a.ok === false || a.canSet === false || a.on == null) {
      return { dead: true, on: !!a.on, sub: a.on == null ? 'Unavailable' : (a.on ? 'On' : 'Off'),
               tip: 'Airplane mode: ' + cap(a.reason || 'Mantle cannot switch airplane mode on this PC') };
    }
    return a.on ? { dead: false, on: true, sub: 'On', tip: 'Airplane mode is on: Wi-Fi, Bluetooth and mobile data are off.\nClick to turn it off' }
      : { dead: false, on: false, sub: 'Off', tip: 'Turn airplane mode on: Wi-Fi, Bluetooth and mobile data go off' };
  }

  function focus(st, nowMs) {
    if (st && st.on === false) return off('Focus');
    var f = st && st.focus, t = st && st.timer;
    if (f && f.on) {
      var left = Math.max(0, (f.endAt || 0) - (nowMs || Date.now()));
      return { dead: false, on: true, sub: mins(left) + ' left',
               tip: 'Focus: ' + mins(left) + ' left on Mantle’s timer' + (f.dndByFocus ? ', with Do not disturb on' : '') +
                    '.\nClick to end it' + (f.dndByFocus ? ' (Do not disturb goes back off)' : '') };
    }
    if (t && t.ok === false) return { dead: true, on: false, sub: 'Unavailable', tip: 'Focus: ' + cap(t.reason || 'Mantle’s timer is not running') };
    var d = st && st.dnd;
    var quiet = d && d.ok !== false && d.writable !== false;
    return { dead: false, on: false, sub: FOCUS_MIN + ' min',
             tip: 'Start ' + FOCUS_MIN + ' minutes of focus: Mantle’s timer' + (quiet ? ' and Do not disturb' : '') +
                  (quiet ? '' : '\n(Do not disturb cannot be switched here: ' + ((d && d.reason) || 'it is still being read') + ')') };
  }

  function cast() {
    return { dead: false, on: false, sub: 'Windows’ panel',
             tip: 'Connect to a wireless display: opens Windows’ own Cast panel (Win+K).\nWindows gives other apps no way to start screen casting, so Mantle hands this one over' };
  }

  function off(name) {
    return { dead: true, on: false, sub: 'Switched off', tip: name + ': this tile is switched off in Mantle’s tray menu (Quick settings tiles)' };
  }

  /** The guess drawn the moment a tile is clicked (the reply has the last word). PURE: a new state. */
  function guess(st, tile, want) {
    var s = JSON.parse(JSON.stringify(st || {}));
    if (tile === 'dnd' && s.dnd) s.dnd.on = !!want;
    if (tile === 'airplane' && s.airplane) s.airplane.on = !!want;
    if (tile === 'focus') {
      s.focus = want ? { on: true, endAt: Date.now() + FOCUS_MIN * 60000, minutes: FOCUS_MIN, dndByFocus: !(s.dnd && s.dnd.on) } : null;
      if (want && s.dnd && s.dnd.writable !== false) s.dnd.on = true;
    }
    return s;
  }

  return { FOCUS_MIN: FOCUS_MIN, TILES: TILES, dnd: dnd, airplane: airplane, focus: focus, cast: cast, guess: guess };
}));
