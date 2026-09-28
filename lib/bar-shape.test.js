'use strict';
/* bar-shape.test.js - plain node, no Electron: the arithmetic of the bar window's shape.
 *
 * The property that matters (see lib/bar-shape.js): at every scale and every popover height,
 * the shape Chromium ends up with (scaled, rounded OUT) must
 *   - start at or above the pill's / the room's first physical row, by at most ~1 DIP,
 *   - reach the bottom of the window,
 *   - and leave the rest of the window OUT, so it cannot take clicks meant for what is behind
 *     (all of it but the one DIP of slack, which at 639 of 640 is the whole window).
 * The screen numbers are built the way main.js builds them (toPhys rounds each edge, the
 * window's bottom is the screen's bottom), so a rounding change there shows up here.
 *
 *   node lib/bar-shape.test.js
 */
const { shapeRect, shapeToPhys } = require('./bar-shape');

let passed = 0, failed = 0;
const failures = [];
function ok(cond, label) {
  if (cond) passed++;
  else { failed++; failures.push(label); }
}

const POPOVER_MAX = 640;   // main.js POPOVER_MAX (480 until 2026-09-27)
const BAR_H = 48;
const LIFT = 14;

// A primary display of `w`x`h` physical px at `sf`, bar at the bottom edge, as barGeometry builds it.
function geometry(wPhys, hPhys, sf, edge) {
  const b = { x: 0, y: 0, width: Math.round(wPhys / sf), height: Math.round(hPhys / sf) };
  const pillW = Math.min(1120, b.width - 64);
  const rest = edge === 'top'
    ? { x: Math.round((b.width - pillW) / 2), y: b.y, width: pillW, height: BAR_H + LIFT }
    : { x: Math.round((b.width - pillW) / 2), y: b.y + b.height - BAR_H - LIFT, width: pillW, height: BAR_H + LIFT };
  const win = edge === 'top'
    ? { x: rest.x, y: rest.y, width: rest.width, height: rest.height + POPOVER_MAX }
    : { x: rest.x, y: rest.y - POPOVER_MAX, width: rest.width, height: rest.height + POPOVER_MAX };
  const bottomPhys = Math.round(b.height * sf);
  const winPhysY = Math.round(win.y * sf);
  const winPhysH = edge === 'top' ? Math.round(win.height * sf) : bottomPhys - winPhysY;
  return { rest, win, winPhysY, winPhysH, bottomPhys };
}

const screens = [[1920, 1080], [2560, 1440], [1366, 768], [3840, 2160]];
const scales = [1, 1.25, 1.5, 1.75, 2];
const extras = [0, 1, 162, 192, 281, 350, 372, 395, 479, 480, 618, 639, 640];

for (const [W, H] of screens) {
  for (const sf of scales) {
    const g = geometry(W, H, sf, 'bottom');
    for (const extra of extras) {
      const tag = `${W}x${H} @${sf} extra ${extra}`;
      const s = shapeRect({ edge: 'bottom', win: g.win, rest: g.rest, extra });
      const px = shapeToPhys(s, sf);
      // the first row the bar (or its room) paints, window-relative physical px
      const want = Math.round((g.rest.y - extra) * sf) - g.winPhysY;
      ok(px.top <= want, `${tag}: the shape starts at or above the first painted row (${px.top} <= ${want})`);
      ok(px.top >= want - Math.ceil(sf) - 1, `${tag}: and no more than ~1 dip above it (${px.top} >= ${want - Math.ceil(sf) - 1})`);
      ok(px.bottom >= g.winPhysH, `${tag}: the shape reaches the window's bottom (${px.bottom} >= ${g.winPhysH})`);
      ok(px.left <= 0 && px.right >= Math.round(g.win.width * sf) - 1, `${tag}: and its full width`);
      if (extra < POPOVER_MAX - 1) ok(px.top > 0, `${tag}: the room nobody asked for is cut away (top ${px.top} > 0)`);
    }
  }
}

// The top edge: the bar is the top of the window and the room grows down.
for (const sf of scales) {
  const g = geometry(1920, 1080, sf, 'top');
  for (const extra of extras) {
    const tag = `top edge @${sf} extra ${extra}`;
    const s = shapeRect({ edge: 'top', win: g.win, rest: g.rest, extra });
    const px = shapeToPhys(s, sf);
    const wantBottom = Math.round((g.rest.y + g.rest.height + extra) * sf) - g.winPhysY;
    ok(px.top <= 0, `${tag}: the shape starts at the window's top`);
    ok(px.bottom >= wantBottom, `${tag}: and reaches past the last painted row (${px.bottom} >= ${wantBottom})`);
    ok(px.bottom <= wantBottom + Math.ceil(sf) + 1, `${tag}: by no more than ~1 dip`);
    if (extra < POPOVER_MAX - 1) ok(px.bottom < g.winPhysH, `${tag}: the room nobody asked for is cut away`);
  }
}

// Owen's screen, the numbers the trace logged (1920x1080 at 1.25): the pill's top is physical row
// 1003, the window's top 203 (1003 - 640 DIP x 1.25; 403 at the old 480 cap), so the resting shape
// must start at window row 800 or just above.
{
  const g = geometry(1920, 1080, 1.25, 'bottom');
  ok(g.winPhysY === 203 && g.winPhysY + g.winPhysH === 1080, `Owen's window is 203..1080 (got ${g.winPhysY}..${g.winPhysY + g.winPhysH})`);
  const px = shapeToPhys(shapeRect({ edge: 'bottom', win: g.win, rest: g.rest, extra: 0 }), 1.25);
  ok(px.top >= 798 && px.top <= 800, `Owen's resting shape starts at window row 798..800 (got ${px.top})`);
}

// Junk in, a sane shape out: a missing or negative extra is no room at all.
{
  const g = geometry(1920, 1080, 1.25, 'bottom');
  const a = shapeRect({ edge: 'bottom', win: g.win, rest: g.rest, extra: undefined });
  const b = shapeRect({ edge: 'bottom', win: g.win, rest: g.rest, extra: -40 });
  const c = shapeRect({ edge: 'bottom', win: g.win, rest: g.rest, extra: 0 });
  ok(JSON.stringify(a) === JSON.stringify(c) && JSON.stringify(b) === JSON.stringify(c), 'undefined and negative extra are the resting shape');
}

console.log(`bar-shape: ${passed} passed, ${failed} failed`);
for (const f of failures.slice(0, 20)) console.log('  FAIL ' + f);
process.exit(failed ? 1 : 0);
