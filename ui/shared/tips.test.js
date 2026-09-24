'use strict';
/*
 * node ui/shared/tips.test.js - the tooltip placement arithmetic (ui/shared/tips.js place()),
 * checked against the REAL shape arithmetic (lib/bar-shape.js shapeRect) on the screens and
 * scales the bar-shape tests use: the tip must sit wholly inside the region main draws for the
 * room it asks for, never over or under the pill, never off the window, and must never ask for
 * room while a popover holds it. Ends with "tips: N passed, M failed".
 */
const { place, GAP, MARGIN, SLACK, ROOM_MAX } = require('./tips.js');
const { shapeRect, shapeToPhys } = require('../../lib/bar-shape.js');

let passed = 0, failed = 0;
const failures = [];
function ok(cond, what) { if (cond) passed++; else { failed++; failures.push(what); } }

const BAR_H = 48, LIFT = 14, POPOVER_MAX = 480;   // main.js: the pill, its lift, the tall window's room
ok(ROOM_MAX === POPOVER_MAX, 'ROOM_MAX is main.js POPOVER_MAX');

/* The tall bar window (barTall) in window-relative DIP = page px, as barGeometry lays it out. */
function geometry(wPhys, hPhys, sf, edge) {
  const b = { width: Math.round(wPhys / sf), height: Math.round(hPhys / sf) };
  const pillW = Math.min(1120, b.width - 64);
  const rest = edge === 'top'
    ? { x: Math.round((b.width - pillW) / 2), y: 0, width: pillW, height: BAR_H + LIFT }
    : { x: Math.round((b.width - pillW) / 2), y: b.height - BAR_H - LIFT, width: pillW, height: BAR_H + LIFT };
  const win = edge === 'top'
    ? { x: rest.x, y: rest.y, width: rest.width, height: rest.height + POPOVER_MAX }
    : { x: rest.x, y: rest.y - POPOVER_MAX, width: rest.width, height: rest.height + POPOVER_MAX };
  const vw = win.width, vh = win.height;
  // The pill in page px: at the bottom it is the top of the resting rect (the lift is under it);
  // at the top it sits LIFT below the window's top edge.
  const pill = edge === 'top'
    ? { left: 0, right: vw, top: LIFT, bottom: LIFT + BAR_H }
    : { left: 0, right: vw, top: rest.y - win.y, bottom: rest.y - win.y + BAR_H };
  return { rest, win, vw, vh, pill };
}

/* An icon cell in the pill at x (page px): 36 x 36, centred vertically. */
function cell(g, x) {
  const top = g.pill.top + (BAR_H - 36) / 2;
  return { left: x, right: x + 36, top, bottom: top + 36 };
}

const screens = [[1920, 1080], [2560, 1440], [1366, 768], [3840, 2160]];
const scales = [1, 1.25, 1.5, 1.75, 2];
const sizes = [[64, 26], [180, 26], [320, 43], [320, 94], [320, 162]];   // one line .. a tray icon's reason

for (const edge of ['bottom', 'top']) {
  for (const [W, H] of screens) {
    for (const sf of scales) {
      const g = geometry(W, H, sf, edge);
      const vis = edge === 'top' ? { top: 0, bottom: g.pill.bottom } : { top: g.pill.top, bottom: g.vh };
      for (const [w, h] of sizes) {
        for (const ax of [2, 300, g.vw / 2 - 18, g.vw - 38]) {
          const a = cell(g, ax);
          const p = place({ a, w, h, vw: g.vw, vh: g.vh, edge, pill: g.pill, inPill: true, vis, canAsk: true });
          const tag = `${edge} ${W}x${H}@${sf} tip ${w}x${h} at x ${ax}`;
          ok(p.side === 'out', `${tag}: goes away from the edge (got ${p.side})`);
          ok(p.need > 0 && p.need <= POPOVER_MAX, `${tag}: asks for room within the cap (${p.need})`);
          ok(p.x >= MARGIN - 0.001 && p.x + w <= g.vw - MARGIN + 0.001, `${tag}: stays inside the window across (${p.x})`);
          if (edge === 'bottom') {
            ok(p.y + h <= g.pill.top - GAP + 0.001, `${tag}: wholly above the pill, a gap clear (${p.y + h} vs ${g.pill.top})`);
          } else {
            ok(p.y >= g.pill.bottom + GAP - 0.001, `${tag}: wholly below the pill, a gap clear (${p.y} vs ${g.pill.bottom})`);
          }
          // Inside the region main draws for that room, in DIP and in the pixels Windows gets.
          const s = shapeRect({ edge, win: g.win, rest: g.rest, extra: p.need });
          ok(p.y >= s.y && p.y + h <= s.y + s.height, `${tag}: inside the shape ${JSON.stringify(s)} (tip ${p.y}..${p.y + h})`);
          const ph = shapeToPhys(s, sf);
          ok(Math.floor(p.y * sf) >= ph.top && Math.ceil((p.y + h) * sf) <= ph.bottom, `${tag}: inside the shape in physical px`);
          // ...and not much more room than it needs: the band eats clicks while it is open.
          ok(p.need <= GAP + h + SLACK + 1, `${tag}: asks for no more than it needs (${p.need})`);
        }
      }
    }
  }
}

// A popover is open (canAsk false): never ask, fit inside the popover's own room.
{
  const g = geometry(1920, 1080, 1.25, 'bottom');
  const pop = { left: 8, right: 358, top: g.pill.top - 7 - 420, bottom: g.pill.top - 7 };
  const vis = { top: pop.top, bottom: g.vh };
  // a row in the middle of the panel: above it, no room asked
  const row = { left: 20, right: 340, top: pop.top + 200, bottom: pop.top + 230 };
  let p = place({ a: row, w: 200, h: 26, vw: g.vw, vh: g.vh, edge: 'bottom', pill: g.pill, inPill: false, vis, canAsk: false });
  ok(p.side === 'out' && p.need === 0 && p.y + 26 <= row.top - GAP + 0.001, 'popover row: above it, no room asked');
  // the panel's header: no space above inside the popover -> flipped below it, clear of the pill
  const head = { left: 20, right: 340, top: pop.top + 8, bottom: pop.top + 34 };
  p = place({ a: head, w: 200, h: 26, vw: g.vw, vh: g.vh, edge: 'bottom', pill: g.pill, inPill: false, vis, canAsk: false });
  ok(p.side === 'in' && p.need === 0 && p.y >= head.bottom + GAP - 0.001 && p.y + 26 <= g.pill.top, `popover header: flipped below it (${p.side} ${p.y})`);
  // the last row, low in the panel, with a tall tip that fits neither way: clamped into the visible part, never asks
  const low = { left: 20, right: 340, top: pop.top + 2, bottom: pop.bottom - 2 };
  p = place({ a: low, w: 320, h: 200, vw: g.vw, vh: g.vh, edge: 'bottom', pill: g.pill, inPill: false, vis, canAsk: false });
  ok(p.side === 'over' && p.need === 0 && p.y >= vis.top && p.y + 200 <= g.vh, `popover: nowhere clean -> clamped into what is visible (${p.side} ${p.y})`);
  // a pill icon while the popover is open: above the pill, inside the popover's room, no ask
  p = place({ a: cell(g, 900), w: 120, h: 26, vw: g.vw, vh: g.vh, edge: 'bottom', pill: g.pill, inPill: true, vis, canAsk: false });
  ok(p.side === 'out' && p.need === 0 && p.y >= vis.top && p.y + 26 <= g.pill.top - GAP + 0.001, 'pill icon under an open popover: above the pill, no ask');
}

// A window with no room above the pill (a framed --test bar, --dock): never asks, stays in the window.
{
  const vw = 1120, vh = BAR_H + LIFT;
  const pill = { left: 0, right: vw, top: 0, bottom: BAR_H };
  const a = { left: 900, right: 936, top: 6, bottom: 42 };
  const p = place({ a, w: 120, h: 26, vw, vh, edge: 'bottom', pill, inPill: true, vis: { top: 0, bottom: vh }, canAsk: true });
  ok(p.need === 0, `no room in the window: no ask (${p.need})`);
  ok(p.y >= 0 && p.y + 26 <= vh, `no room in the window: clamped inside it (${p.side} ${p.y})`);
}

// A room that would pass the cap (a very long title) is never asked for: it is clamped instead.
{
  const g = geometry(1920, 1080, 1, 'bottom');
  const p = place({ a: cell(g, 500), w: 320, h: 500, vw: g.vw, vh: g.vh, edge: 'bottom', pill: g.pill, inPill: true, vis: { top: g.pill.top, bottom: g.vh }, canAsk: true });
  ok(p.need === 0 && p.side !== 'out', `taller than the cap: not asked for (${p.side} ${p.need})`);
}

// No room provider (a launcher / desktop page): the whole window is visible, above if it fits, else below.
{
  const vw = 800, vh = 600;
  let p = place({ a: { left: 100, right: 140, top: 300, bottom: 330 }, w: 150, h: 26, vw, vh, edge: 'bottom', pill: null, inPill: false, vis: { top: 0, bottom: vh }, canAsk: false });
  ok(p.side === 'out' && p.need === 0 && p.y === 300 - GAP - 26, 'plain page: above the element');
  p = place({ a: { left: 100, right: 140, top: 4, bottom: 34 }, w: 150, h: 26, vw, vh, edge: 'bottom', pill: null, inPill: false, vis: { top: 0, bottom: vh }, canAsk: false });
  ok(p.side === 'in' && p.y === 34 + GAP, 'plain page, element at the top: below it');
  p = place({ a: { left: 780, right: 800, top: 300, bottom: 330 }, w: 150, h: 26, vw, vh, edge: 'bottom', pill: null, inPill: false, vis: { top: 0, bottom: vh }, canAsk: false });
  ok(p.x + 150 <= vw - MARGIN && p.x >= MARGIN, 'plain page, element at the right edge: clamped in');
  p = place({ a: { left: 10, right: 30, top: 300, bottom: 330 }, w: 900, h: 60, vw, vh, edge: 'bottom', pill: null, inPill: false, vis: { top: 0, bottom: vh }, canAsk: false });
  ok(p.x === MARGIN, 'a tip wider than the window starts at the margin');
}

console.log(`tips: ${passed} passed, ${failed} failed`);
for (const f of failures.slice(0, 20)) console.log('  FAIL ' + f);
process.exit(failed ? 1 : 0);
