/* glass.js — the top bar's glass in DARK, the pure parts (lane see-topbar, 2026-10-09). No DOM, no
 * IPC: the page (browser global TopbarGlass) and lib/features/topbar-glass.test.js (require) share it.
 * Kept out of model.js, which the ping lane owns. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TopbarGlass = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  /* ---- THE GLASS, dark only (lane see-topbar, 2026-10-09) ------------------------------------
     The page gets a small picture of the desktop's strip (what is really under the bar) and blurs it
     with --lg-blur under its tint. The pure parts (read the CSS tokens, model the blur the compositor
     will draw, solve the THINNEST tint at which ink-2 still reads >= 4.5:1 against the brightest pixel
     of that blurred picture) live in ONE place now, ../shared/glass-adapt.js (lane same-bars,
     2026-10-09, Owen: "everything the same"): the bottom bar and every pop-up of both bars use the
     same rule with the same thresholds. The names are kept so the page and the tests read the same. */
  var GA = (typeof module === 'object' && module.exports) ? require('../shared/glass-adapt.js')
    : (typeof self !== 'undefined' ? self.MantleGlassAdapt : null);
  if (!GA) throw new Error('ui/topbar/glass.js needs ../shared/glass-adapt.js loaded before it');
  var parseColor = GA.parseColor, parseFilter = GA.parseFilter, lum = GA.lum, ratio = GA.contrast;
  var glassPixels = GA.glassPixels, glassTint = GA.glassTint, glassSettle = GA.glassSettle;
  /* The Mantle menu's first row says why the glass is flat (a failure only; light, a peek or a
     full-screen window under the bar are the design, not a fault). Mutates in place, like peekMenu. */
  function glassMenu(menu, why) {
    if (!menu) return null;
    var at = -1;
    for (var i = 0; i < menu.length; i++) if (menu[i].glass) { at = i; break; }
    if (!why) { if (at >= 0) menu.splice(at, 1); return null; }
    var row = { t: 'info', bad: true, enabled: false, glass: true, text: 'The top bar is not frosted: ' + why };
    if (at >= 0) menu[at] = row; else menu.unshift(row);
    return row;
  }

  return { parseColor: parseColor, parseFilter: parseFilter, lum: lum, ratio: ratio, glassPixels: glassPixels, glassTint: glassTint, glassSettle: glassSettle, glassMenu: glassMenu };
}));
