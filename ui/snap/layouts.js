/* layouts.js - the Win+Z snap layouts, ONE table for the page and for main (wave 3, 2026-09-24).
 *
 * The page draws these tiles; main (lib/features/snap.js) turns a picked zone into the
 * snap.zone call and the zones left over into Snap Assist's queue. Both read this file, so the
 * picture a person clicks and the rectangle the window lands in can never disagree.
 *
 * A zone is [x, y, w, h] in CELLS of the layout's grid [cols, rows]. The sidecar turns cells into
 * pixels with integer arithmetic (SnapGeom.Edge), so the zones of a layout tile the work area with
 * no gap and no overlap. A zone that is a half or a quarter comes back from the sidecar NAMED
 * (left, tr...), so Win+arrows carry on from a Win+Z pick exactly as from their own snap.
 *
 * The user's brief: halves, thirds, 2/3 + 1/3, quarters, columns. Laid out 3 + 2, like the flyout
 * Windows 11 shows on a landscape screen.
 */
(function (root) {
  'use strict';
  var LAYOUTS = [
    { id: 'halves', label: 'Halves', grid: [2, 1], zones: [[0, 0, 1, 1], [1, 0, 1, 1]],
      names: ['left half', 'right half'] },
    { id: 'thirds', label: 'Thirds', grid: [3, 1], zones: [[0, 0, 1, 1], [1, 0, 1, 1], [2, 0, 1, 1]],
      names: ['left third', 'middle third', 'right third'] },
    { id: 'wide', label: 'Two thirds and one third', grid: [3, 1], zones: [[0, 0, 2, 1], [2, 0, 1, 1]],
      names: ['left two thirds', 'right third'] },
    { id: 'quarters', label: 'Quarters', grid: [2, 2], zones: [[0, 0, 1, 1], [1, 0, 1, 1], [0, 1, 1, 1], [1, 1, 1, 1]],
      names: ['top-left quarter', 'top-right quarter', 'bottom-left quarter', 'bottom-right quarter'] },
    { id: 'columns', label: 'Four columns', grid: [4, 1], zones: [[0, 0, 1, 1], [1, 0, 1, 1], [2, 0, 1, 1], [3, 0, 1, 1]],
      names: ['first column', 'second column', 'third column', 'fourth column'] },
  ];
  var COLS = 3;   // tiles per row in the picker

  /** The zones of `layoutId` other than `zoneIndex`, in reading order: what Snap Assist fills next. */
  function rest(layoutId, zoneIndex) {
    var l = byId(layoutId);
    if (!l) return [];
    var out = [];
    for (var i = 0; i < l.zones.length; i++) {
      if (i !== zoneIndex) out.push({ layout: l.id, index: i, grid: l.grid.slice(), cell: l.zones[i].slice(), name: l.names[i] });
    }
    return out;
  }

  function byId(id) {
    for (var i = 0; i < LAYOUTS.length; i++) if (LAYOUTS[i].id === id) return LAYOUTS[i];
    return null;
  }

  var api = { LAYOUTS: LAYOUTS, COLS: COLS, rest: rest, byId: byId };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SnapLayouts = api;
})(typeof window !== 'undefined' ? window : this);
