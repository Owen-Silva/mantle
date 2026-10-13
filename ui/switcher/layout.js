/* layout.js — the Alt+Tab switcher's geometry, as ONE pure function shared by three callers.
 *
 * WHO USES IT, AND WHY IT IS ONE FILE: main (lib/switcher.js) sizes and centres the overlay window
 * with it and tells the sidecar how many columns the arrow keys move through; the mock harness
 * (mock-mantle.js) lays the page out with it for the screenshots; lib/switcher.test.js checks it.
 * The page itself never computes a layout: it draws exactly the numbers main sends, so a window
 * that is 1 px off the page's idea of itself cannot happen. UMD so the same file is require()d by
 * Node and loaded by a <script> tag.
 *
 * EVERYTHING IS DIP (CSS px). Main converts the monitor's work area from physical px with that
 * monitor's scale before it calls this, and converts the answer back.
 *
 * THE SHAPE: tiles in rows, left to right, the way Windows' own Alt+Tab lays them out. Index i is
 * in row floor(i / cols), which is exactly what the sidecar's SwitchMath.Move assumes for Up and
 * Down, so a row is NEVER centred or reflowed here: a centred short last row would put the tile
 * "below" a tile somewhere it visibly is not.
 *
 *   1. Biggest tiles first (tileMax), as many columns as the width allows, then the columns are
 *      BALANCED: 7 windows over 6 columns become rows of 4 and 3, not 6 and 1.
 *   2. Too tall? The tiles shrink in steps and it tries again, down to tileMin.
 *   3. Still too tall at tileMin (dozens of windows on a small screen): the grid shows whole rows
 *      only and scrolls by whole rows. Whole rows because a DWM thumbnail cannot be clipped by
 *      CSS: a half-visible row would draw its pictures over the panel's edge.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SwitcherLayout = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var L = {
    margin: 18,       // transparent room round the panel for its drop shadow, on every side
    pad: 14,          // the panel's padding round the grid
    gap: 8,           // between tiles
    tileMax: 240,     // widest tile
    tileMin: 136,     // narrowest tile; below this the grid scrolls instead
    step: 4,          // how much a tile shrinks per try
    inset: 6,         // the tile's padding round its preview
    aspect: 0.625,    // preview height / width: 16:10, the common window shape (DWM letterboxes)
    capH: 30,         // the icon + title row under the preview
    maxW: 0.92,       // of the work area: Windows' own switcher leaves about this much air
    maxH: 0.84,
    emptyW: 380,      // the panel that says there is nothing to switch to
    emptyH: 64,
    noticeW: 460,     // the "could not switch" notice
    noticeH: 104,
  };

  function tileOf(tw) {
    var previewW = tw - 2 * L.inset;
    var previewH = Math.round(previewW * L.aspect);
    return { tileW: tw, previewW: previewW, previewH: previewH, tileH: L.inset + previewH + L.capH };
  }

  function grid(n, tw, availW) {
    var t = tileOf(tw);
    var maxCols = Math.max(1, Math.floor((availW - 2 * L.pad + L.gap) / (tw + L.gap)));
    var cols = Math.min(n, maxCols);
    var rows = Math.ceil(n / cols);
    cols = Math.ceil(n / rows);                        // balance the rows (see 1. above)
    t.cols = cols;
    t.rows = rows;
    t.gridW = cols * tw + (cols - 1) * L.gap;
    t.gridH = rows * t.tileH + (rows - 1) * L.gap;
    return t;
  }

  function finish(t, n, visibleRows) {
    var vr = Math.min(t.rows, visibleRows);
    var gridH = vr * t.tileH + (vr - 1) * L.gap;
    var panelW = 2 * L.pad + t.gridW;
    var panelH = 2 * L.pad + gridH;
    return {
      n: n, cols: t.cols, rows: t.rows, visibleRows: vr, scroll: vr < t.rows,
      tileW: t.tileW, tileH: t.tileH, previewW: t.previewW, previewH: t.previewH,
      inset: L.inset, capH: L.capH, pad: L.pad, gap: L.gap, margin: L.margin,
      gridW: t.gridW, gridH: gridH,
      panelW: panelW, panelH: panelH,
      w: panelW + 2 * L.margin, h: panelH + 2 * L.margin,
    };
  }

  /**
   * n windows in a work area of workW x workH DIP -> the whole geometry (see finish()).
   * Never throws; nonsense in gives the smallest sane answer out.
   */
  function layout(n, workW, workH) {
    n = Math.max(0, Math.floor(Number(n) || 0));
    workW = Number(workW) > 0 ? Number(workW) : 1280;
    workH = Number(workH) > 0 ? Number(workH) : 720;
    var availW = workW * L.maxW - 2 * L.margin;
    var availH = workH * L.maxH - 2 * L.margin;
    if (n === 0) {
      return {
        n: 0, cols: 0, rows: 0, visibleRows: 0, scroll: false,
        tileW: 0, tileH: 0, previewW: 0, previewH: 0,
        inset: L.inset, capH: L.capH, pad: L.pad, gap: L.gap, margin: L.margin,
        gridW: 0, gridH: 0,
        panelW: L.emptyW, panelH: L.emptyH,
        w: L.emptyW + 2 * L.margin, h: L.emptyH + 2 * L.margin,
      };
    }
    for (var tw = L.tileMax; tw >= L.tileMin; tw -= L.step) {
      var t = grid(n, tw, availW);
      if (2 * L.pad + t.gridH <= availH) return finish(t, n, t.rows);
    }
    var small = grid(n, L.tileMin, availW);
    var fit = Math.max(1, Math.floor((availH - 2 * L.pad + L.gap) / (small.tileH + L.gap)));
    return finish(small, n, fit);
  }

  /**
   * The layout for a list that CHANGED while the switcher is up (lane mn-alttab, 2026-10-12): the
   * tiles keep the size and the column count they opened with, so a window that comes or goes
   * fills or empties a slot and the panel only grows or loses rows; its width changes only when a
   * single row gets shorter or longer than it was, or when the old grid would no longer fit the
   * screen (then it is a fresh layout(), as at open). n = 0 is the empty panel.
   */
  function reflow(n, workW, workH, prev) {
    n = Math.max(0, Math.floor(Number(n) || 0));
    if (!prev || !(prev.cols > 0) || !(prev.tileW > 0) || n === 0) return layout(n, workW, workH);
    workW = Number(workW) > 0 ? Number(workW) : 1280;
    workH = Number(workH) > 0 ? Number(workH) : 720;
    var availW = workW * L.maxW - 2 * L.margin;
    var availH = workH * L.maxH - 2 * L.margin;
    var t = tileOf(prev.tileW);
    var cols = Math.min(n, prev.cols);
    var rows = Math.ceil(n / cols);
    t.cols = cols;
    t.rows = rows;
    t.gridW = cols * t.tileW + (cols - 1) * L.gap;
    t.gridH = rows * t.tileH + (rows - 1) * L.gap;
    if (2 * L.pad + t.gridW > availW) return layout(n, workW, workH);
    if (2 * L.pad + t.gridH <= availH) return finish(t, n, rows);
    // Too tall at this tile size: a grid that already scrolled keeps scrolling by whole rows;
    // one that did not starts over, exactly as a fresh Alt+Tab would lay it out.
    if (!prev.scroll) return layout(n, workW, workH);
    return finish(t, n, Math.max(1, Math.floor((availH - 2 * L.pad + L.gap) / (t.tileH + L.gap))));
  }

  /** The notice panel's window size, DIP. */
  function notice() {
    return { panelW: L.noticeW, panelH: L.noticeH, margin: L.margin, w: L.noticeW + 2 * L.margin, h: L.noticeH + 2 * L.margin };
  }

  /**
   * Which row the grid should start at so that `sel` is visible, given the row it starts at now.
   * Moves as little as possible: the page scrolls only when the selection leaves the window.
   */
  function firstRow(lay, sel, current) {
    if (!lay || !lay.scroll || sel < 0) return 0;
    var row = Math.floor(sel / lay.cols);
    var first = Math.max(0, Math.min(current || 0, lay.rows - lay.visibleRows));
    if (row < first) return row;
    if (row >= first + lay.visibleRows) return row - lay.visibleRows + 1;
    return first;
  }

  return { layout: layout, reflow: reflow, notice: notice, firstRow: firstRow, L: L };
}));
