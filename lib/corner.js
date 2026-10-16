'use strict';
/*
 * lib/corner.js - who else is in the bottom-right corner right now (lane mantle-toasts3, 2026-10-15).
 *
 * Owen wants Mantle's notification banners bottom right, like Windows' own. That corner is shared: the
 * screenshot card comes up there too. The banners sit just ABOVE whatever is in it, so the card's owner
 * says where its window is (set), clears it when the card goes (set null), and the banners re-place on
 * every change (onChange). The bar is not in here: lib/features/toasts.js reads it through
 * ctx.host.barRect() (its resting shape plus any open pop-up), and main calls changed() when a bar pop-up
 * opens or closes so the banners move at once.
 *
 * Rects are screen DIP { x, y, width, height }. One process, one registry (a module singleton).
 *   node lib/corner.test.js
 */
const spots = new Map();   // key -> rect
const fns = new Set();

function norm(r) {
  if (!r) return null;
  const x = Math.round(Number(r.x)), y = Math.round(Number(r.y));
  const width = Math.round(Number(r.width)), height = Math.round(Number(r.height));
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}
function same(a, b) {
  if (!a || !b) return a === b;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}
function emit(why) {
  for (const fn of Array.from(fns)) { try { fn(why); } catch (_) { /* one listener never stops the rest */ } }
}

/** `key` is in the corner at `rect` (screen DIP), or gone (null). Listeners hear only real changes. */
function set(key, rect) {
  const k = String(key || 'unnamed');
  const r = norm(rect);
  if (same(spots.get(k) || null, r)) return false;
  if (r) spots.set(k, r); else spots.delete(k);
  emit(`${k} ${r ? 'is up' : 'went'}`);
  return true;
}
/** Everything in the corner now: [{ key, x, y, width, height }]. */
function list() {
  return Array.from(spots, ([key, r]) => ({ key, x: r.x, y: r.y, width: r.width, height: r.height }));
}
function onChange(fn) { fns.add(fn); return () => { fns.delete(fn); }; }
/** Something the registry does not hold moved (a bar pop-up opened or closed): tell the listeners. */
function changed(why) { emit(String(why || 'something moved')); }
/** Tests only: forget everything. */
function reset() { spots.clear(); fns.clear(); }

module.exports = { set, list, onChange, changed, reset };
