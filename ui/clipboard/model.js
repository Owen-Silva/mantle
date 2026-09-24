/* model.js — the clipboard panel's pure logic: filtering, previews, labels, keys and placement.
 *
 * No DOM and no Electron in here, so the SAME file runs in the page (window.ClipModel), in main
 * (lib/features/clipboard.js requires it for placement) and under node for model.test.js.
 *
 * Nothing here logs or returns item text anywhere but to its caller: the page draws it, and
 * that is the only place Owen's clipboard content is ever meant to be seen.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ClipModel = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---- geometry (DIP) -------------------------------------------------------------------------
  // Windows' own Win+V panel is ~360 x 460 at 100%; Mantle's is the same size so it covers the
  // same amount of the window Owen is pasting into. The margin is transparent room for the shadow.
  var PANEL_W = 360;
  var PANEL_H = 460;
  var MARGIN = 18;
  var GAP = 6;          // between the caret (or the pointer) and the panel
  var EDGE = 8;         // the panel never touches the work area's edge

  /** Items matching every word of `query` (case-insensitive), in their original order. */
  function filter(items, query) {
    var words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return items.slice();
    return items.filter(function (it) {
      var hay = haystack(it);
      return words.every(function (w) { return hay.indexOf(w) >= 0; });
    });
  }

  function haystack(it) {
    var parts = [];
    if (it.text) parts.push(it.text);
    if (it.files) it.files.forEach(function (f) { parts.push(f.name, f.path || ''); });
    if (it.kind === 'image') parts.push('image picture screenshot');
    if (it.kind === 'files') parts.push('file files');
    if (it.pinned) parts.push('pinned');
    return parts.join('\n').toLowerCase();
  }

  /** The first `max` lines worth showing: leading blank lines dropped, tabs opened up, each line
   *  cut at 240 characters (CSS clamps the rest). `more` = something was left out. */
  function previewLines(text, max) {
    max = max || 3;
    var lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    while (lines.length && !lines[0].trim()) lines.shift();
    var out = [];
    for (var i = 0; i < lines.length && out.length < max; i++) {
      var l = lines[i].replace(/\t/g, '    ').replace(/\s+$/, '');
      out.push(l.length > 240 ? l.slice(0, 240) + '…' : l);
    }
    var rest = lines.slice(i).some(function (l) { return l.trim(); });
    return { lines: out, more: rest, blank: out.every(function (l) { return !l.trim(); }) };
  }

  /** "just now", "4 min ago", "2 h ago", "Yesterday", "3 days ago", then a date. */
  function ago(ts, now) {
    var s = Math.max(0, Math.round(((now || Date.now()) - ts) / 1000));
    if (s < 45) return 'just now';
    var m = Math.round(s / 60);
    if (m < 60) return m + ' min ago';
    var h = Math.round(m / 60);
    if (h < 24) return h + ' h ago';
    var d = Math.round(h / 24);
    if (d === 1) return 'Yesterday';
    if (d < 7) return d + ' days ago';
    var dt = new Date(ts);
    return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }

  /** The quiet line under an item: what it is and when. */
  function meta(it, now) {
    var what;
    if (it.kind === 'image') what = (it.w && it.h) ? it.w + ' × ' + it.h + ' image' : 'Image';
    else if (it.kind === 'files') what = plural(it.fileCount || (it.files || []).length, 'file');
    else if ((it.lines || 0) > 3) what = plural(it.lines, 'line');
    else what = plural(it.chars || 0, 'character');
    if (it.rich && it.kind === 'text') what += ', formatted';
    if (it.kind === 'image' && (it.fileCount || 0) > 0) what += ' and its file';
    return what + ' · ' + ago(it.ts, now);
  }

  /** What a key does. `st` = { query, filterArmed }. Returns an action name, or null to let the
   *  filter box have the key.
   *
   *  "P pins" and "type to filter" want the same key. The rule: P pins while the filter is EMPTY
   *  and not armed; once Owen is typing a filter, P is a letter and Ctrl+P pins. "/" arms an empty
   *  filter, so a filter can still start with p. */
  function keyAction(e, st) {
    var q = (st && st.query) || '';
    var armed = !!(st && st.filterArmed);
    var k = e.key;
    if (k === 'Escape') return 'close';
    if (k === 'ArrowDown') return 'down';
    if (k === 'ArrowUp') return 'up';
    if (k === 'PageDown') return 'pagedown';
    if (k === 'PageUp') return 'pageup';
    if (k === 'Enter') return 'paste';
    if (k === 'Delete' && !e.ctrlKey && !e.altKey) {
      // Del is the filter's own key only while it would edit text: a selection in the box, or text
      // after the caret. At the end of the filter (the normal case) it deletes the item.
      var s = st && st.selStart, t = st && st.selEnd;
      if (q && s != null && (s !== t || t < q.length)) return null;
      return 'delete';
    }
    if ((k === 'p' || k === 'P') && e.ctrlKey && !e.altKey) return 'pin';
    if ((k === 'p' || k === 'P') && !e.ctrlKey && !e.altKey && !e.metaKey && !q && !armed) return 'pin';
    if (k === '/' && !q && !armed && !e.ctrlKey && !e.altKey) return 'arm-filter';
    if (k === 'Home' && !q) return 'home';
    if (k === 'End' && !q) return 'end';
    return null;
  }

  /** The selection after `action` over `n` visible items (page = rows per page). */
  function moveSel(sel, action, n, page) {
    if (!n) return -1;
    page = page || 4;
    var s = sel < 0 ? 0 : sel;
    if (action === 'down') s = Math.min(n - 1, s + 1);
    else if (action === 'up') s = Math.max(0, s - 1);
    else if (action === 'pagedown') s = Math.min(n - 1, s + page);
    else if (action === 'pageup') s = Math.max(0, s - page);
    else if (action === 'home') s = 0;
    else if (action === 'end') s = n - 1;
    return Math.max(0, Math.min(n - 1, s));
  }

  /** Keep the same item selected across a list refresh; else the same index; else the top. */
  function reselect(prevId, prevIndex, list) {
    if (!list.length) return -1;
    for (var i = 0; i < list.length; i++) if (list[i].id === prevId) return i;
    return Math.max(0, Math.min(list.length - 1, prevIndex || 0));
  }

  /** Where the WINDOW goes (DIP, top-left), so the PANEL inside its shadow margin sits just below
   *  the caret (or the pointer) like Windows' Win+V, flipped above it when there is no room below,
   *  and always wholly inside the work area.
   *    anchor = { x, y, h? }   caret bottom-left (h = caret height) or the pointer
   *    work   = { x, y, width, height }   the work area of the display the anchor is on */
  function place(anchor, work, size) {
    size = size || {};
    var pw = size.w || PANEL_W, ph = size.h || PANEL_H, m = size.m != null ? size.m : MARGIN;
    var ah = anchor.h || 0;
    var px = anchor.x;
    var py = anchor.y + GAP;
    var roomBelow = work.y + work.height - EDGE - py;
    var roomAbove = anchor.y - ah - GAP - (work.y + EDGE);
    // no room below: above, as long as above is the roomier side (when neither fits, the clamp
    // below slides the panel over the caret from whichever side has more space)
    if (roomBelow < ph && roomAbove > roomBelow) py = anchor.y - ah - GAP - ph;
    var minX = work.x + EDGE, maxX = work.x + work.width - EDGE - pw;
    var minY = work.y + EDGE, maxY = work.y + work.height - EDGE - ph;
    px = Math.max(minX, Math.min(maxX, px));
    py = Math.max(minY, Math.min(maxY, py));
    return { x: Math.round(px - m), y: Math.round(py - m), width: pw + 2 * m, height: ph + 2 * m,
             panel: { x: Math.round(px), y: Math.round(py), width: pw, height: ph } };
  }

  return {
    PANEL_W: PANEL_W, PANEL_H: PANEL_H, MARGIN: MARGIN,
    filter: filter, previewLines: previewLines, ago: ago, meta: meta,
    keyAction: keyAction, moveSel: moveSel, reselect: reselect, place: place,
  };
}));
