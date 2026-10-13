/* helmbadge.js (bar) - a count on an app's icon, e.g. Helm's "chats that need you" (lane badge, 2026-10-09;
 * wired in by lane mn-helmbadge, 2026-10-12).
 *
 * lib/helm-badge.js (feature "helmbadge") pushes helmbadge.state {badges:[{exe, label, count, waiting,
 * errors, reason, tip}]} (replayed on subscribe). This file puts a number disc in the top-right corner of
 * every cell whose item's exe matches a badge (hidden at 0), adds the count to the tooltip, and repaints
 * every cell on each push. bar.js calls MantleBadges.paint(cell, item) from updateCell (BEFORE ontop.js's
 * paint), MantleBadges.paintMore(btn) from applyOverflow and MantleBadges.paintTile(tile, cell) from the
 * "+N" panel's tiles.
 * Accent disc = only waiting; warn disc = at least one stopped on an error.
 *
 * THE TOOLTIP. bar.js writes the base text into cell._tip on every updateCell; ontop.js and the "+N"
 * panel read cell._tip. So the count line goes INTO cell._tip (base kept in cell._hbBase), and ontop.js's
 * own line, written after, lands below it. A push from main (no updateCell) rebuilds _tip from the kept
 * base and lets ontop.js put its line back. While a flyout or a drag holds the tooltip back (cell._fly)
 * the title is not touched; bar.js puts it back from _tip when the hold ends.
 *
 * AN APP BEHIND "+N" keeps its count: the "+N" button carries the sum of the hidden apps' counts, and
 * the panel's tile for the app carries its own disc. Nothing is counted out of sight.
 * NO SILENT FAILURE: a bar without the channel says so in the matching app's tooltip.
 */
(function () {
  'use strict';

  var badges = [];          // the last push
  var err = null;           // why the state never arrives, or null
  var LINE = /\n(?:\d+ needs? you[^\n]*|Count hidden: [^\n]*)$/;
  // reasons that are a normal state, not a failure: the app is closed (or crashed), or the switch is off
  var QUIET = { 'not running': 1, 'turned off': 1, '': 1 };

  function lower(s) { return String(s || '').toLowerCase().replace(/\//g, '\\'); }
  // same rule as lib/helm-badge.js matches(): full path = equal, bare name = the item's file name
  function match(b, item) {
    if (!b || !item || !item.exe) return false;
    var want = lower(b.exe), have = lower(item.exe);
    if (!want) return false;
    if (want.indexOf('\\') !== -1) return have === want;
    return have === want || have.slice(-(want.length + 1)) === '\\' + want;
  }
  function badgeFor(item) {
    for (var i = 0; i < badges.length; i++) if (match(badges[i], item)) return badges[i];
    return null;
  }
  function countOf(item) {
    var b = item ? badgeFor(item) : null;
    return b && b.count > 0 ? b.count : 0;
  }

  /* The disc itself, on any element (a cell, the "+N" button, a panel tile): n = 0 removes it. */
  function disc(host, n, warn) {
    var el = host.querySelector(':scope > .hb-badge');
    if (n > 0) {
      if (!el) {
        el = document.createElement('span');
        el.className = 'hb-badge';
        el.setAttribute('aria-hidden', 'true');
        host.appendChild(el);
      }
      var text = n > 9 ? '9+' : String(n);
      if (el.textContent !== text) el.textContent = text;
      if (el.classList.contains('warn') !== !!warn) el.classList.toggle('warn', !!warn);
      if (el.classList.contains('wide') !== (text.length > 1)) el.classList.toggle('wide', text.length > 1);
    } else if (el) {
      el.remove();
    }
  }

  function paint(cell, item) {
    if (!cell) return;
    if (item) cell._hbItem = item;
    var it = cell._hbItem;
    var b = it ? badgeFor(it) : null;
    var n = b && b.count > 0 ? b.count : 0;
    var on = n > 0;
    if (cell.classList.contains('hb-on') !== on) cell.classList.toggle('hb-on', on);
    disc(cell, n, on && b.errors > 0);

    if (typeof cell._tip !== 'string' || !it) return;
    // a _tip that is not the one this file wrote last is bar.js's fresh base
    if (cell._tip !== cell._hbTip) cell._hbBase = cell._tip.replace(LINE, '');
    var line = on ? (b.tip || n + (n === 1 ? ' needs you' : ' need you')) : '';
    var why = !line && b && b.reason && !QUIET[b.reason] ? b.reason : '';
    if (!line && !why && err && (b || matchesAnySource(it))) why = err;
    var extra = line ? '\n' + line : why ? '\nCount hidden: ' + why : '';
    var tip = cell._hbBase + extra;
    cell._tip = cell._hbTip = tip;
    var label = (it.name || 'app') + (line ? ', ' + line : '');
    if (cell.getAttribute('aria-label') !== label) cell.setAttribute('aria-label', label);
    if (!cell._fly && cell.title !== tip) cell.title = tip;   // ontop.js (after this) adds its line
  }
  // with no state at all (err), only an app that looks like a badge source gets the reason
  function matchesAnySource(it) { return /(^|\\)helm\.exe$/.test(lower(it.exe)); }

  /* "+N": the sum of the counts of the apps behind it, and a line saying whose. */
  function paintMore(btn) {
    if (!btn) return;
    var cells = document.querySelectorAll('#dock .cell.ovf');
    var n = 0, warn = false, names = [];
    for (var i = 0; i < cells.length; i++) {
      var it = cells[i]._hbItem || cells[i]._item;
      var b = it ? badgeFor(it) : null;
      if (!b || !(b.count > 0)) continue;
      n += b.count;
      if (b.errors > 0) warn = true;
      names.push((it.name || 'an app') + ' ' + b.count);
    }
    disc(btn, btn.hidden ? 0 : n, warn);
    if (btn.classList.contains('hb-on') !== (n > 0)) btn.classList.toggle('hb-on', n > 0);
    var base = (btn.title || '').replace(/\nNeeds you: [^\n]*$/, '');
    var want = base + (n > 0 && !btn.hidden ? '\nNeeds you: ' + names.join(', ') : '');
    if (btn.title !== want) { btn.title = want; btn.setAttribute('aria-label', want.replace(/\n/g, '. ')); }
  }

  /* A tile in the "+N" panel: the same disc as its cell. */
  function paintTile(tile, cell) {
    if (!tile || !cell) return;
    tile._hbCell = cell;
    var it = cell._hbItem || cell._item;
    var b = it ? badgeFor(it) : null;
    var n = b && b.count > 0 ? b.count : 0;
    var ico = tile.querySelector('.ovf-ico');
    if (ico && ico.parentNode === tile) {
      // the disc sits on the icon, so the icon gets a positioned wrapper of its own
      var wrap = tile.querySelector(':scope > .hb-wrap');
      if (!wrap) { wrap = document.createElement('span'); wrap.className = 'hb-wrap'; tile.insertBefore(wrap, ico); wrap.appendChild(ico); }
    }
    var host = tile.querySelector(':scope > .hb-wrap') || tile;
    disc(host, n, n > 0 && b.errors > 0);
    if (typeof cell._tip === 'string' && tile.title !== cell._tip) tile.title = cell._tip;
  }

  function repaintAll() {
    var cells = document.querySelectorAll('.cell');
    for (var i = 0; i < cells.length; i++) {
      var c = cells[i];
      var it = c._hbItem || c._item;
      if (!it) continue;
      paint(c, it);
      // ontop.js's line goes back below ours (its own repaint writes b._tip + its line)
      if (window.MantleOnTop && c._ontopWins && !c._fly) window.MantleOnTop.paint(c, c._ontopWins);
    }
    paintMore(document.getElementById('dock-more'));
    var tiles = document.querySelectorAll('.ovf-app');
    for (var k = 0; k < tiles.length; k++) if (tiles[k]._hbCell) paintTile(tiles[k], tiles[k]._hbCell);
  }

  function apply(s) {
    badges = (s && Array.isArray(s.badges)) ? s.badges.slice() : [];
    err = null;
    repaintAll();
  }

  var CANT = 'the bar can’t show app counts right now (restart Mantle to fix it)';
  var mantle = window.mantle;
  if (!mantle || typeof mantle.on !== 'function') {
    err = CANT;
  } else {
    try { mantle.on('helmbadge.state', apply); } catch (e) {
      err = CANT;
      try { console.warn('helmbadge: subscribing to helmbadge.state threw', e && e.message); } catch (_) { /* no console */ }
    }
  }

  window.MantleBadges = {
    paint: paint,
    paintMore: paintMore,
    paintTile: paintTile,
    badgeFor: badgeFor,
    countOf: countOf,
    state: function () { return badges.slice(); },
    error: function () { return err; },
    _apply: apply,
  };
})();
