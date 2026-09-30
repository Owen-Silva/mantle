/* ontop.js (bar) - which of the bar's apps have a window Mantle keeps on top (lane ontop, 2026-09-27).
 *
 * lib/features/ontop.js pushes ontop.state {pinned:[{hwnd, name}]} (replayed on subscribe). This
 * file keeps that set, puts a small pin badge on the icon of every app that owns one of those
 * windows, adds a line to its tooltip, and answers the jump list (ui/bar/jumplist.js) "is this
 * window kept on top?". bar.js calls MantleOnTop.paint(cell, windows) from updateCell; a state push
 * repaints every cell from the windows it last painted with.
 * NO SILENT FAILURE: a bar without the channel says so in every app's tooltip and in the menu.
 */
(function () {
  'use strict';

  var pinned = {};          // hwnd -> name
  var err = null;           // why the state never arrives, or null
  var PIN = '<svg viewBox="0 0 16 16" width="9" height="9" aria-hidden="true"><path d="M9.6 2.2l4.2 4.2-1.5.4-2.4 2.4.2 2.7-1.1 1.1-2.5-2.5-3 3-.6-.6 3-3-2.5-2.5 1.1-1.1 2.7.2 2.4-2.4z" fill="currentColor"/></svg>';

  function hwndsOf(wins) {
    var out = [];
    for (var i = 0; i < (wins || []).length; i++) if (wins[i] && wins[i].hwnd != null) out.push(String(wins[i].hwnd));
    return out;
  }
  function pinnedOf(wins) {
    var h = hwndsOf(wins);
    for (var i = 0; i < h.length; i++) if (pinned[h[i]]) return h[i];
    return null;
  }

  function paint(b, wins) {
    if (!b) return;
    b._ontopWins = wins || [];
    var on = !!pinnedOf(b._ontopWins);
    if (b.classList.contains('ontop') !== on) b.classList.toggle('ontop', on);
    var badge = b.querySelector('.ontop-badge');
    if (on && !badge) {
      badge = document.createElement('span');
      badge.className = 'ontop-badge';
      badge.innerHTML = PIN;
      b.appendChild(badge);
    } else if (!on && badge) {
      badge.remove();
    }
    // the tooltip: bar.js keeps the base text in b._tip and blanks b.title while the flyout is up
    if (typeof b._tip === 'string' && !b._fly) {
      // the state and how to change it, with the shortcut (discoverable)
      var extra = on ? '\nKept on top · right-click or Win+Ctrl+T to stop' : err && b._ontopWins.length ? '\nKeep on top: ' + err : '';
      var want = b._tip + extra;
      if (b.title !== want) b.title = want;
    }
  }

  function repaintAll() {
    var cells = document.querySelectorAll('.cell');
    for (var i = 0; i < cells.length; i++) if (cells[i]._ontopWins) paint(cells[i], cells[i]._ontopWins);
  }

  function apply(s) {
    var next = {};
    var list = (s && s.pinned) || [];
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].hwnd) next[String(list[i].hwnd)] = list[i].name || 'a window';
    pinned = next;
    err = null;
    repaintAll();
  }

  // plain words (lane windows-layouts, 2026-09-29): this text reaches the tooltip and the right-click menu
  var CANT = 'the bar can’t show which windows are kept on top right now (restart Mantle to fix it)';
  var mantle = window.mantle;
  if (!mantle || typeof mantle.on !== 'function') {
    err = CANT;
  } else {
    try { mantle.on('ontop.state', apply); } catch (e) {
      err = CANT;
      try { console.warn('ontop: subscribing to ontop.state threw', e && e.message); } catch (_) { /* no console */ }
    }
  }

  window.MantleOnTop = {
    paint: paint,
    pinnedOf: pinnedOf,
    isPinned: function (hwnd) { return !!pinned[String(hwnd)]; },
    error: function () { return err; },
    _apply: apply,
  };
})();
