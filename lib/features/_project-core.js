/* _project-core.js - Win+P's four choices and the Project tile, PURE (lane qstiles, 2026-10-15; plan
 * notes/mantle-replace-windows.md P8 + P12).
 *
 * Shared by lib/features/project.js (main), ui/project/project.js (the pop-up) and ui/bar/qs-tiles.js
 * (the Project tile), so all three say the same words for the same state. No Electron, no DOM.
 *
 * THE READ it works from is sysdisplay.project (sidecar/SysDisplay.cs):
 *   { current: 'internal'|'clone'|'extend'|'external'|'custom'|null, reason, available: [ids],
 *     unavailable: {id: why}, connected: n|null, connectedWhy, pending: {token, kind, revertsInMs}|null }
 *
 * WINDOWS' WORDS AND ORDER (the Project flyout): PC screen only, Duplicate, Extend, Second screen only.
 * Win+P again moves to the next one (wrapping), as Windows' does; arrows move too; Enter picks.
 * A change is never left without a way back: 15 s to keep it, else Mantle switches back (KEEP_MS).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MantleProjectCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MODES = [
    { id: 'internal', label: 'PC screen only', short: 'PC screen only', help: 'Show everything on this screen only' },
    { id: 'clone', label: 'Duplicate', short: 'Duplicate', help: 'Show the same thing on both screens' },
    { id: 'extend', label: 'Extend', short: 'Extend', help: 'Use both screens as one wide desktop' },
    { id: 'external', label: 'Second screen only', short: 'Second screen', help: 'Show everything on the second screen only' },
  ];
  var KEEP_MS = 15000;
  var ONE_DISPLAY = 'Only one display is connected. Connect another display to duplicate or extend.';
  var CAST = 'Connect to a wireless display';

  function byId(id) {
    for (var i = 0; i < MODES.length; i++) if (MODES[i].id === id) return MODES[i];
    return null;
  }
  function isMode(id) { return !!byId(id); }

  function cap(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }

  /** One display connected? Said from the count when Windows gave one, else from what it would take. */
  function single(rd) {
    if (!rd) return false;
    if (typeof rd.connected === 'number') return rd.connected <= 1;
    var av = Array.isArray(rd.available) ? rd.available : null;
    return !!av && av.indexOf('clone') < 0 && av.indexOf('extend') < 0;
  }

  /** Can this choice be picked now? -> null or the plain reason it cannot. */
  function whyNot(rd, id) {
    if (!rd) return null;                                  // not read yet: let Windows decide (sysdisplay.topology validates)
    if (id === rd.current) return null;                    // the current one is always "pickable" (it just closes)
    if (single(rd) && id !== 'internal') return 'Only one display is connected';
    var av = Array.isArray(rd.available) ? rd.available : null;
    if (av && av.indexOf(id) < 0) {
      var w = rd.unavailable && rd.unavailable[id];
      return w ? cap(w) : 'Windows would not take this layout now';
    }
    return null;
  }

  /** The row the pop-up starts on: the current layout, else the first one Windows would take. */
  function startSel(rd) {
    if (rd && isMode(rd.current)) return rd.current;
    for (var i = 0; i < MODES.length; i++) if (!whyNot(rd, MODES[i].id)) return MODES[i].id;
    return MODES[0].id;
  }

  /** Win+P again / an arrow: the next pickable choice, `step` = +1 or -1, wrapping. */
  function next(rd, sel, step) {
    step = step < 0 ? -1 : 1;
    var at = -1;
    for (var i = 0; i < MODES.length; i++) if (MODES[i].id === sel) at = i;
    if (at < 0) return startSel(rd);
    for (var n = 1; n <= MODES.length; n++) {
      var j = (at + step * n + MODES.length * 4) % MODES.length;
      if (!whyNot(rd, MODES[j].id)) return MODES[j].id;
    }
    return sel;
  }

  /** The pop-up's whole picture from main's state. PURE.
   *  st = { read, readError, phase: 'choose'|'applying'|'confirm'|'done', sel, confirm: {to, from, endsAt, dry}, note, noteWarn, on } */
  function view(st, nowMs) {
    st = st || {};
    var rd = st.read || null;
    var v = { phase: st.phase || 'choose', sel: st.sel || startSel(rd), rows: [], single: single(rd), note: '', warn: false,
              current: rd && rd.current || null, title: 'Project', left: 0, confirm: null, cast: CAST };
    for (var i = 0; i < MODES.length; i++) {
      var m = MODES[i], why = whyNot(rd, m.id);
      v.rows.push({ id: m.id, label: m.label, help: m.help, current: !!rd && rd.current === m.id, sel: v.sel === m.id,
                    disabled: !!why, why: why || '' });
    }
    if (st.note) { v.note = st.note; v.warn = !!st.noteWarn; }
    else if (!rd && st.readError) { v.note = 'Mantle could not read your displays just now: ' + st.readError; v.warn = true; }
    else if (!rd) v.note = 'Reading your displays…';
    else if (v.single) v.note = ONE_DISPLAY;
    else if (rd.current === 'custom') v.note = 'Your displays use a custom layout. Pick one of these to switch to it.';
    if (v.phase === 'confirm' && st.confirm) {
      var c = st.confirm, to = byId(c.to), from = byId(c.from);
      var left = Math.max(0, Math.ceil(((c.endsAt || 0) - (nowMs || Date.now())) / 1000));
      v.left = left;
      v.title = 'Keep these display settings?';
      v.confirm = {
        to: to ? to.label : 'the new layout', from: from ? from.label : 'the old layout', dry: !!c.dry,
        text: c.dry ? 'Test run: nothing on this PC changed. In a real run, ' + (from ? from.label : 'the old layout') + ' comes back in ' + left + ' s unless you keep it.'
          : 'Switching back to ' + (from ? from.label : 'the old layout') + ' in ' + left + ' s',
      };
    } else if (v.phase === 'applying') v.title = 'Switching…';
    return v;
  }

  /** The Project tile in quick settings. PURE. st = main's project.state. */
  function tile(st) {
    st = st || {};
    var rd = st.read || null, m = rd ? byId(rd.current) : null;
    if (st.on === false) {
      return { dead: false, on: false, sub: 'Windows’ panel', tip: 'Project: Mantle’s pop-up is switched off in the tray, so this opens Windows’ own (Win+P)', windows: true };
    }
    if (!rd) return { dead: false, on: false, sub: st.readError ? 'Unknown' : 'Choose…', tip: st.readError ? 'Project: your displays could not be read (' + st.readError + '). Click to choose anyway' : 'Choose how your screens are used (Win+P)' };
    var sub = m ? m.short : rd.current === 'custom' ? 'Custom layout' : 'Choose…';
    if (single(rd)) return { dead: false, on: false, sub: sub, tip: ONE_DISPLAY + '\nClick to see the choices (Win+P)' };
    // never lit: like Windows' Project tile it opens a choice, it is not a switch
    return { dead: false, on: false, sub: sub,
             tip: 'Now: ' + (m ? m.label : 'a custom layout') + '. Click to choose how your screens are used (Win+P)' };
  }

  return { MODES: MODES, KEEP_MS: KEEP_MS, ONE_DISPLAY: ONE_DISPLAY, CAST: CAST, byId: byId, isMode: isMode,
           single: single, whyNot: whyNot, startSel: startSel, next: next, view: view, tile: tile };
}));
