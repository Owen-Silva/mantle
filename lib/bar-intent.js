'use strict';
/*
 * lib/bar-intent.js -- where the cursor may be and still mean "I am using the bar" (lane mn-pop,
 * 2026-10-12, audit finding #6). Pure: main.js hoverTick calls it with the cursor and the pill's
 * resting rectangle; lib/bar-intent.test.js drives it with made-up cursor traces.
 *
 * THE FAULT. The live log, 10-04..10-12: 176 times "the cursor came back before the bar finished
 * sliding away", and 306 of 3,146 edge reveals (9.7%) began hiding again within 1 s. The bar's keep
 * zone was the pill itself (plus the reveal band and the strip under the pill), so a cursor going
 * a pixel above the pill, on its way to an icon or overshooting one, started the 180 ms grace, and
 * the bar slid away under it.
 *
 * THE FIX: hysteresis in SPACE, not in time (a dock's, not a longer delay; the 180 ms grace and the
 * instant reveal are Owen's call from build 23 and stay as they are):
 *   - to REVEAL, the cursor still has to reach the screen edge (main.js REVEAL_BAND_DIP);
 *   - to STAY, it only has to be within the INTENT BAND: the pill grown by KEEP_ABOVE_DIP towards
 *     the middle of the screen and KEEP_SIDE_DIP at each end. The 180 ms grace starts only once
 *     the cursor is out of that.
 * A deliberate exit costs almost nothing: at an ordinary 1,000 DIP/s the band is crossed in ~30 ms.
 */

const KEEP_ABOVE_DIP = 28;   // the audit's 24-32 DIP; about half an icon row
const KEEP_SIDE_DIP = 12;

/** The intent band around the pill's resting rectangle `rest` ({x, y, width, height}, DIP).
    edge 'top' grows it downwards (a bar at the top edge), anything else upwards. */
function band(rest, edge) {
  if (!rest || !Number.isFinite(rest.x) || !Number.isFinite(rest.y)) return null;
  const top = edge === 'top';
  return {
    x: rest.x - KEEP_SIDE_DIP,
    y: top ? rest.y : rest.y - KEEP_ABOVE_DIP,
    width: rest.width + 2 * KEEP_SIDE_DIP,
    height: rest.height + KEEP_ABOVE_DIP,
  };
}

function inRect(r, pt) {
  return !!r && !!pt && pt.x >= r.x && pt.x < r.x + r.width && pt.y >= r.y && pt.y < r.y + r.height;
}

/** Is the cursor inside the intent band? */
function holds(pt, rest, edge) { return inRect(band(rest, edge), pt); }

/**
 * One tick of a SHOWN bar. `leftAt` = when the cursor last left the keep zone (null while in it),
 * `keep` = is it in the keep zone now (and nothing else holds the bar). -> {leftAt, hide}: hide is
 * true once it has been out for graceMs. The same rule main.js has always had; only `keep` grew.
 */
function shownTick(leftAt, now, keep, graceMs) {
  if (keep) return { leftAt: null, hide: false };
  if (leftAt === null || leftAt === undefined) return { leftAt: now, hide: false };
  return { leftAt, hide: now - leftAt >= graceMs };
}

module.exports = { KEEP_ABOVE_DIP, KEEP_SIDE_DIP, band, holds, shownTick };
