'use strict';
/*
 * lib/bar-intent.js -- where the cursor may be and still mean "I am using the bar" (lane mn-pop,
 * 2026-10-12, audit finding #6; re-cut by lane mantle-barhover, 2026-10-17). Pure: main.js hoverTick
 * asks zone() where the cursor is and shownStep() whether the bar goes; lib/bar-intent.test.js drives
 * both with made-up cursor traces.
 *
 * THE FAULT (10-12). The live log, 10-04..10-12: 176 times "the cursor came back before the bar
 * finished sliding away", and 306 of 3,146 edge reveals (9.7%) began hiding again within 1 s. The
 * bar's keep zone was the pill itself (plus the reveal band and the strip under the pill), so a cursor
 * going a pixel above the pill, on its way to an icon or overshooting one, started the 180 ms grace,
 * and the bar slid away under it. The 10-12 fix grew the keep zone 28 DIP up and 12 DIP to the sides.
 *
 * THE FAULT (10-17). The user: "i can hold my mouse a lot of pixels above it without it going away like a
 * lot". The 28 DIP held for as long as the cursor stayed in it: 35 physical px above a 60 px pill at
 * 1.25x, plus the ~370 ms slide-away, in which a cursor still in those 28 DIP pulled the bar back up.
 * Measured live (read-only cursor/window poll against the live log, 2026-10-17): every hide started
 * 180-240 ms after the cursor crossed 28 DIP above the pill, never lower.
 *
 * THE RULE NOW: two bands, hysteresis in space AND time.
 *   - to REVEAL, the cursor still has to reach the screen edge (main.js REVEAL_BAND_DIP);
 *   - the REST band, the pill plus KEEP_ABOVE_DIP (8) towards the middle of the screen and
 *     KEEP_SIDE_DIP (8) at each end, keeps the bar for as long as the cursor is in it;
 *   - the OVERSHOOT band, out to OVERSHOOT_ABOVE_DIP (28) / OVERSHOOT_SIDE_DIP (12), keeps it only
 *     for a pass: the bar goes once the cursor has been out of the rest band for OVERSHOOT_MS (500),
 *     wherever in the overshoot band it is. An overshoot on the way to an icon comes back within
 *     ~100-300 ms, so the 10-12 fix still holds; a cursor RESTING up there no longer keeps the bar.
 *   - beyond the overshoot band the 180 ms grace runs as it always has.
 * Only the rest band pulls a sliding-away bar back (main.js "came back"), so a cursor resting in the
 * overshoot band can never bounce it.
 */

const KEEP_ABOVE_DIP = 8;          // the rest band: the pill's own edge plus a hand's tremor
const KEEP_SIDE_DIP = 8;
const OVERSHOOT_ABOVE_DIP = 28;    // the audit's 24-32 DIP; about half an icon row (the 10-12 band)
const OVERSHOOT_SIDE_DIP = 12;
const OVERSHOOT_MS = 500;          // out of the rest band this long (in the overshoot band) and the bar goes

function grow(rest, edge, above, side) {
  if (!rest || !Number.isFinite(rest.x) || !Number.isFinite(rest.y)) return null;
  const top = edge === 'top';
  return {
    x: rest.x - side,
    y: top ? rest.y : rest.y - above,
    width: rest.width + 2 * side,
    height: rest.height + above,
  };
}

/** The rest band around the pill's resting rectangle `rest` ({x, y, width, height}, DIP).
    edge 'top' grows it downwards (a bar at the top edge), anything else upwards. */
function band(rest, edge) { return grow(rest, edge, KEEP_ABOVE_DIP, KEEP_SIDE_DIP); }

/** The overshoot band: wider, but it only keeps the bar for OVERSHOOT_MS. */
function overshootBand(rest, edge) { return grow(rest, edge, OVERSHOOT_ABOVE_DIP, OVERSHOOT_SIDE_DIP); }

function inRect(r, pt) {
  return !!r && !!pt && pt.x >= r.x && pt.x < r.x + r.width && pt.y >= r.y && pt.y < r.y + r.height;
}

/** Is the cursor inside the rest band? */
function holds(pt, rest, edge) { return inRect(band(rest, edge), pt); }

/**
 * Where the cursor is, for a SHOWN bar: 'in' (keeps it), 'overshoot' (keeps it for a pass) or 'out'.
 * g = {
 *   rest:    the pill's resting rect, DIP (in pill mode it includes the 14 DIP of air under the pill),
 *   win:     the bar's own rect, DIP: the shaped rect (rest plus an open pop-up's room) in hover mode,
 *            the window in --dock / a framed --test bar,
 *   screen:  the display bounds, DIP,
 *   edge:    'top' | 'bottom',
 *   pill:    true in pill mode (the island floats above the edge, so the column under it counts),
 *   inBand:  the cursor is in the reveal band (main.js works it out: hot corners take their squares),
 * }
 * A pop-up and the page's own hover report are main's to add; they hold the bar whatever this says.
 */
function zone(pt, g) {
  if (!pt || !g) return 'out';
  if (g.inBand) return 'in';
  if (inRect(g.win, pt)) return 'in';
  const rest = g.rest;
  if (g.pill && rest && g.screen) {
    const b = g.screen;
    const column = g.edge === 'top'
      ? { x: rest.x, y: b.y, width: rest.width, height: rest.y - b.y }
      : { x: rest.x, y: rest.y + rest.height, width: rest.width, height: (b.y + b.height) - (rest.y + rest.height) };
    if (column.height > 0 && inRect(column, pt)) return 'in';
  }
  if (holds(pt, rest, g.edge)) return 'in';
  if (inRect(overshootBand(rest, g.edge), pt)) return 'overshoot';
  return 'out';
}

/**
 * One tick of a SHOWN bar. `st` = {leftAt, outAt}: when the cursor last left the rest band and when it
 * last left the overshoot band (null while in it). -> {leftAt, outAt, hide}. hide = out of the overshoot
 * band for graceMs, or out of the rest band for OVERSHOOT_MS (whichever comes first).
 */
function shownStep(st, now, where, graceMs, overshootMs) {
  const s = st || {};
  if (where === 'in') return { leftAt: null, outAt: null, hide: false };
  const leftAt = s.leftAt === null || s.leftAt === undefined ? now : s.leftAt;
  const outAt = where === 'out' ? (s.outAt === null || s.outAt === undefined ? now : s.outAt) : null;
  const allow = Number.isFinite(overshootMs) ? overshootMs : OVERSHOOT_MS;
  const hide = (outAt !== null && now - outAt >= graceMs) || now - leftAt >= Math.max(graceMs, allow);
  return { leftAt, outAt, hide };
}

/**
 * The 10-12 rule, kept for its callers and tests: `keep` = is it in the keep zone now (and nothing
 * else holds the bar). -> {leftAt, hide}: hide is true once it has been out for graceMs.
 */
function shownTick(leftAt, now, keep, graceMs) {
  if (keep) return { leftAt: null, hide: false };
  if (leftAt === null || leftAt === undefined) return { leftAt: now, hide: false };
  return { leftAt, hide: now - leftAt >= graceMs };
}

/** Plain words for the log: where the bar keeps and for how long, from the pill's resting rect. */
function describe(rest, edge) {
  const r = band(rest, edge), o = overshootBand(rest, edge);
  if (!r || !o) return 'no resting rect, so nothing keeps the bar';
  const top = edge === 'top';
  const keepEdge = top ? r.y + r.height : r.y, overEdge = top ? o.y + o.height : o.y;
  return `kept while the cursor is ${top ? 'above' : 'below'} y ${keepEdge} (the pill and ${KEEP_ABOVE_DIP} DIP), ` +
    `for ${OVERSHOOT_MS} ms ${top ? 'above' : 'below'} y ${overEdge} (${OVERSHOOT_ABOVE_DIP} DIP), x ${r.x}..${r.x + r.width - 1} (DIP)`;
}

module.exports = {
  KEEP_ABOVE_DIP, KEEP_SIDE_DIP, OVERSHOOT_ABOVE_DIP, OVERSHOOT_SIDE_DIP, OVERSHOOT_MS,
  band, overshootBand, holds, zone, shownStep, shownTick, describe,
};
