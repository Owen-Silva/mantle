/* layout.js - Task View's window grid, as pure functions (UMD: the page loads it with a <script>,
 * ui/taskview/layout.test.js and main require() it).
 *
 * WHY THE PAGE LAYS ITSELF OUT (unlike Alt+Tab, where main does): Task View is one window the size
 * of the monitor, so the page's viewport IS the screen area and there is nothing for main to size.
 * Main only needs the preview boxes, which the page measures and reports (taskview.painted), and
 * DWM draws each window into its box.
 *
 * EVERYTHING IS DIP (CSS px).
 *
 * THE SHAPE: like Windows' own Task View, tiles are CENTRED in rows and the whole grid is centred
 * in the space under the desktop strip. Unlike Alt+Tab (whose arrow keys live in the sidecar and
 * assume a left-aligned grid), the arrows here are the page's own (move() below), and Up/Down go to
 * the tile whose centre is nearest in x, so centred short rows are safe.
 *   1. Biggest tiles first (tileMax), as many columns as fit, then BALANCED (7 over 6 columns
 *      become rows of 4 and 3, not 6 and 1).
 *   2. Too tall? Tiles shrink in steps down to tileMin.
 *   3. Still too tall: whole rows only, scrolled by whole rows (a DWM picture cannot be clipped by
 *      CSS, so a half-visible row would draw over the desktop strip).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TaskViewLayout = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var L = {
    stripH: 148,     // the desktop strip across the top (taskview.css .strip height)
    searchH: 48,     // the filter pill row under it (taskview.css .search height)
    padX: 48,        // side margins
    padTop: 12,      // between the filter row and the first row of tiles
    padBottom: 36,   // under the last row (room for the foot line)
    gap: 20,         // between tiles
    tileMax: 420,    // widest tile: one or two windows should not turn into posters
    tileMin: 176,    // narrowest; below this the grid scrolls instead
    step: 8,         // how much a tile shrinks per try
    inset: 8,        // tile padding round its preview
    aspect: 0.625,   // preview h / w: 16:10 (DWM letterboxes the real shape inside, see thumbs.js)
    capH: 36,        // the icon + title + close row under the preview
  };

  function tileOf(tw) {
    var pvW = tw - 2 * L.inset;
    var pvH = Math.round(pvW * L.aspect);
    return { tileW: tw, tileH: L.inset + pvH + L.capH, pvW: pvW, pvH: pvH };
  }

  /** Columns for n tiles of width tw in availW, balanced over the rows that makes. */
  function colsFor(n, tw, availW) {
    var cols = Math.max(1, Math.floor((availW + L.gap) / (tw + L.gap)));
    cols = Math.min(cols, Math.max(1, n));
    var rows = Math.ceil(n / cols);
    return Math.max(1, Math.ceil(n / Math.max(1, rows)));
  }

  function heightOf(rows, tileH) { return rows * tileH + Math.max(0, rows - 1) * L.gap; }

  /**
   * layout(n, W, H) -> { n, cols, rows, visibleRows, scrolls, tileW, tileH, pvW, pvH, gap, area }
   * `area` is the rectangle under the strip and the filter row that the grid is centred in.
   */
  function layout(n, W, H) {
    var area = { x: L.padX, y: L.stripH + L.searchH + L.padTop, w: Math.max(0, W - 2 * L.padX), h: 0 };
    area.h = Math.max(0, H - area.y - L.padBottom);
    var t = null, cols = 1, rows = 0;
    var fitted = false;
    var maxW = Math.min(L.tileMax, Math.max(L.tileMin, area.w));
    for (var tw = maxW; tw >= L.tileMin; tw -= L.step) {
      t = tileOf(tw);
      cols = colsFor(n, tw, area.w);
      rows = n > 0 ? Math.ceil(n / cols) : 0;
      if (heightOf(rows, t.tileH) <= area.h) { fitted = true; break; }
    }
    if (!t || !fitted) {
      t = tileOf(L.tileMin);
      cols = colsFor(n, L.tileMin, area.w);
      rows = n > 0 ? Math.ceil(n / cols) : 0;
    }
    var visibleRows = fitted ? rows : Math.max(1, Math.floor((area.h + L.gap) / (t.tileH + L.gap)));
    return {
      n: n, cols: cols, rows: rows, visibleRows: Math.min(rows, visibleRows), scrolls: !fitted && rows > visibleRows,
      tileW: t.tileW, tileH: t.tileH, pvW: t.pvW, pvH: t.pvH, gap: L.gap, inset: L.inset, capH: L.capH, area: area,
    };
  }

  /** How many tiles are in `row`. */
  function rowLen(lay, row) {
    if (row < 0 || row >= lay.rows) return 0;
    return Math.min(lay.cols, lay.n - row * lay.cols);
  }

  /**
   * Where every tile goes with `firstRow` scrolled to the top: [{i, row, col, x, y, visible}],
   * page coordinates. Rows are centred; the block of visible rows is centred vertically.
   */
  function place(lay, firstRow) {
    var first = Math.max(0, Math.min(firstRow || 0, Math.max(0, lay.rows - lay.visibleRows)));
    var shownRows = Math.min(lay.visibleRows, lay.rows - first);
    var blockH = heightOf(shownRows, lay.tileH);
    var y0 = lay.area.y + Math.max(0, Math.floor((lay.area.h - blockH) / 2));
    var out = [];
    for (var i = 0; i < lay.n; i++) {
      var row = Math.floor(i / lay.cols), col = i % lay.cols;
      var k = rowLen(lay, row);
      var rowW = k * lay.tileW + (k - 1) * lay.gap;
      var x0 = lay.area.x + Math.floor((lay.area.w - rowW) / 2);
      var visible = row >= first && row < first + shownRows;
      out.push({
        i: i, row: row, col: col, visible: visible,
        x: x0 + col * (lay.tileW + lay.gap),
        y: visible ? y0 + (row - first) * (lay.tileH + lay.gap) : -10000,
      });
    }
    return out;
  }

  /**
   * The arrow keys. Left/Right step through the list (crossing rows, like reading); Up/Down go to
   * the tile in the next row whose centre is nearest in x (rows are centred, so the same column
   * number is not the tile visibly above); Home/End the ends. Never wraps.
   */
  function move(lay, sel, key) {
    var n = lay.n;
    if (n <= 0) return -1;
    var s = Math.max(0, Math.min(n - 1, sel < 0 ? 0 : sel));
    if (key === 'ArrowLeft') return Math.max(0, s - 1);
    if (key === 'ArrowRight') return Math.min(n - 1, s + 1);
    if (key === 'Home') return 0;
    if (key === 'End') return n - 1;
    if (key !== 'ArrowUp' && key !== 'ArrowDown') return s;
    var row = Math.floor(s / lay.cols);
    var to = key === 'ArrowUp' ? row - 1 : row + 1;
    if (to < 0 || to >= lay.rows) return s;
    var pos = place(lay, 0);
    var cx = pos[s].x + lay.tileW / 2;
    var best = -1, bestD = Infinity;
    for (var i = to * lay.cols; i < Math.min(n, (to + 1) * lay.cols); i++) {
      var d = Math.abs(pos[i].x + lay.tileW / 2 - cx);
      if (d < bestD - 0.5) { bestD = d; best = i; }
    }
    return best < 0 ? s : best;
  }

  /** The first row to show so that `sel` is visible, moving as little as possible from `cur`. */
  function firstRowFor(lay, sel, cur) {
    var first = Math.max(0, cur || 0);
    if (!lay.scrolls || sel < 0) return 0;
    var row = Math.floor(sel / lay.cols);
    if (row < first) first = row;
    if (row >= first + lay.visibleRows) first = row - lay.visibleRows + 1;
    return Math.max(0, Math.min(first, lay.rows - lay.visibleRows));
  }

  /**
   * Type to filter: every word of the query must appear in the title or the program name,
   * case-insensitive. Returns the indexes that match, in list order.
   */
  function filter(items, query) {
    var words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    var out = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i] || {};
      var hay = (String(it.title || '') + ' ' + String(it.app || '')).toLowerCase();
      var ok = true;
      for (var w = 0; w < words.length && ok; w++) ok = hay.indexOf(words[w]) >= 0;
      if (ok) out.push(i);
    }
    return out;
  }

  return { L: L, layout: layout, place: place, move: move, firstRowFor: firstRowFor, filter: filter, rowLen: rowLen };
}));
