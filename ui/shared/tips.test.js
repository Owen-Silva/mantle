'use strict';
/*
 * node ui/shared/tips.test.js - the tooltip placement arithmetic (ui/shared/tips.js place()),
 * checked against the REAL shape arithmetic (lib/bar-shape.js shapeRect) on the screens and
 * scales the bar-shape tests use: the tip must sit wholly inside the region main draws for the
 * room it asks for, never over or under the pill, never off the window, and must never ask for
 * room while a popover holds it. Ends with "tips: N passed, M failed".
 */
const { place, GAP, MARGIN, SLACK, ROOM_MAX, SIDE_MIN } = require('./tips.js');
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

/* ---------------------------------------------------------------- inside an open panel (2026-09-25)
   Owen's screenshot: the quick-settings footer link's tip sat on the power tile's warning. The
   scene below is the headless one (ui/shared/tips-shoot.js, 1120 x 660, 2026-09-25): the panel,
   the footer link, the warning's line boxes, the battery line left of the link, the pill below. */
{
  const vw = 1120, vh = 660;
  const pill = { left: 0, right: vw, top: 598, bottom: 646 };
  const panel = { left: 675, right: 1035, top: 213, bottom: 591 };
  const vis = { top: panel.top, bottom: vh };
  const link = { left: 847, right: 985, top: 556, bottom: 578 };
  const warn = [{ left: 687, right: 1010, top: 499, bottom: 516, warn: true }, { left: 687, right: 860, top: 516, bottom: 533, warn: true }];
  const battery = { left: 687, right: 830, top: 560, bottom: 577 };
  // A tip whose text is 250 px long: 2 lines at its natural 170 px, more when narrowed.
  const TEXT = 250, PADX = 18, LINE = 17, PADY = 15;
  const measure = (width) => Math.ceil(TEXT / (width - PADX)) * LINE + PADY;
  const W = 170, H = measure(170);
  const base = { a: link, w: W, h: H, vw, vh, edge: 'bottom', pill, inPill: false, vis, canAsk: false, panel, measure };
  const hit = (p, r) => Math.min(p.x + (p.w || W), r.right) - Math.max(p.x, r.left) > 0.5 && Math.min(p.y + (p.h || H), r.bottom) - Math.max(p.y, r.top) > 0.5;
  const inside = (p) => p.x >= panel.left - 0.01 && p.x + p.w <= panel.right + 0.01 && p.y >= panel.top - 0.01 && p.y + p.h <= panel.bottom + 0.01;
  const gapTo = (p, r) => Math.max(r.top - (p.y + p.h), p.y - r.bottom, r.left - (p.x + p.w), p.x - r.right);

  // Nothing in the way: above, centred on the link, inside the panel, no room asked.
  let p = place(Object.assign({}, base, { avoid: [battery] }));
  ok(p.side === 'above' && p.need === 0 && Math.abs(p.y - (link.top - GAP - H)) < 0.01 && inside(p) && p.covers.text === 0,
    `panel, nothing above: the tip goes above the link (${p.side} y ${p.y})`);
  ok(Math.abs(p.x + W / 2 - (link.left + link.right) / 2) < 0.01, 'panel, nothing above: centred on the link');

  // Owen's scene: the warning above, the pill below, the battery line to the left. Never the warning:
  // the only spot that avoids it is left of the link, over the battery line, narrowed into the panel.
  p = place(Object.assign({}, base, { avoid: warn.concat([battery]) }));
  ok(p.covers.warn === 0 && !warn.some(r => hit(p, r)), `panel, warning above: the tip is not over the warning (${p.side} ${p.x},${p.y} ${p.w}x${p.h})`);
  ok(p.side === 'left' && inside(p) && gapTo(p, link) >= GAP - 0.01 && gapTo(p, link) <= GAP + 0.01, `panel, warning above: beside the link, inside the panel (${p.side}, gap ${gapTo(p, link)})`);
  ok(p.y + p.h <= pill.top - 1 && p.y + p.h <= panel.bottom, 'panel, warning above: never over the pill');

  // The same, but a free spot on the right (the gear is an icon, not text, and there is room): no text wins.
  const mid = { left: 760, right: 860, top: 556, bottom: 578 };
  p = place(Object.assign({}, base, { a: mid, avoid: warn.concat([{ left: 687, right: 750, top: 560, bottom: 577, warn: false }]) }));
  ok(p.side === 'right' && p.covers.warn === 0 && p.covers.text === 0, `panel with room on the right: the text-free side wins (${p.side}, covers ${JSON.stringify(p.covers)})`);

  // Room below inside the panel (the link higher up): below beats a warning above.
  const hi = { left: 847, right: 985, top: 450, bottom: 472 };
  const warnHi = [{ left: 687, right: 1010, top: 410, bottom: 444, warn: true }];
  p = place(Object.assign({}, base, { a: hi, avoid: warnHi }));
  ok(p.side === 'below' && Math.abs(p.y - (hi.bottom + GAP)) < 0.01 && p.covers.warn === 0 && p.covers.text === 0, `panel, warning above, room below: below (${p.side} y ${p.y})`);

  // Ordinary text above and free text-less room below: below wins (covers no text).
  p = place(Object.assign({}, base, { a: hi, avoid: [{ left: 687, right: 1010, top: 410, bottom: 444, warn: false }] }));
  ok(p.side === 'below' && p.covers.text === 0, `panel, text above, room below: below (${p.side})`);

  // Every spot next to the link covers text, none a warning: the least text, still inside the panel.
  p = place(Object.assign({}, base, { avoid: [{ left: 687, right: 1030, top: 480, bottom: 548, warn: false }, battery] }));
  ok(p.covers.warn === 0 && inside(p), `panel, text everywhere: inside the panel (${p.side}, covers ${JSON.stringify(p.covers)})`);

  // Boxed in: every spot inside the panel covers a warning. The tip may use the room beside the
  // panel (the window's band above the pill) rather than cover it.
  // (The link at the panel's left edge, warnings everywhere else in it, text starting 12 px in.)
  const edgeLink = { left: 690, right: 760, top: 556, bottom: 578 };
  const boxed = [{ left: 687, right: 1031, top: 400, bottom: 550, warn: true }, { left: 766, right: 1031, top: 550, bottom: 587, warn: true }];
  p = place(Object.assign({}, base, { a: edgeLink, avoid: boxed }));
  ok(p.covers.warn === 0 && !inside(p) && p.x >= MARGIN - 0.01 && p.x + p.w <= vw - MARGIN + 0.01 && p.y + p.h <= pill.top - 1 + 0.01 && p.y >= vis.top,
    `boxed in by a warning: out beside the panel, never over it or the pill (${p.side} ${p.x},${p.y} ${p.w}x${p.h})`);

  // A side narrower than SIDE_MIN is never used: a column of single words is not a tip. Here both
  // sides have 130 px, the warning covers everything above and the pill is below: above it is.
  {
    const nl = { left: 140, right: 278, top: 556, bottom: 578 };
    const nvw = 278 + GAP + 130 + MARGIN;
    const asked = [];
    const q = place(Object.assign({}, base, { a: nl, vw: nvw, panel: { left: 0, right: nvw, top: 213, bottom: 591 },
      avoid: [{ left: 0, right: nvw, top: 480, bottom: 548, warn: true }], measure: (wd) => { asked.push(wd); return measure(wd); } }));
    ok(q.side !== 'left' && q.side !== 'right' && asked.every(wd => wd >= SIDE_MIN), `SIDE_MIN: no side under ${SIDE_MIN} px (${q.side}; measured ${asked.join(',') || 'none'})`);
  }

  // A top bar: the panel hangs below the pill, so the first choice is below the element.
  const tPill = { left: 0, right: vw, top: 14, bottom: 62 };
  const tPanel = { left: 675, right: 1035, top: 69, bottom: 447 };
  const tLink = { left: 847, right: 985, top: 250, bottom: 272 };
  p = place({ a: tLink, w: W, h: H, vw, vh, edge: 'top', pill: tPill, inPill: false, vis: { top: 0, bottom: tPanel.bottom }, canAsk: false, panel: tPanel, avoid: [], measure });
  ok(p.side === 'below' && Math.abs(p.y - (tLink.bottom + GAP)) < 0.01, `top bar panel: below the element first (${p.side} y ${p.y})`);

  // A full-width row in a list (the quick-settings sound view's device rows, overlap audit
  // qs-sound/dark, 2026-10-17): every spot above or below it is on the next row's words, and its own
  // side spots would straddle the panel's edge. Wholly beside the panel, covering nothing, wins over
  // covering a neighbour inside it; never straddling the edge, never on the pill.
  {
    const lp = { left: 790, right: 1136, top: 260, bottom: 591 };
    const rows = [0, 1, 2, 3].map((k) => ({ left: 802, right: 1124, top: 310 + k * 32, bottom: 341 + k * 32 }));
    const names = rows.map((r) => ({ left: r.left + 31, right: r.left + 200, top: r.top + 9, bottom: r.top + 22, warn: false }));
    const header = { left: 803, right: 888, top: 452, bottom: 464, warn: false };
    const lvis = { top: lp.top, bottom: vh };
    for (let k = 0; k < rows.length; k++) {
      const others = names.filter((_, j) => j !== k).concat([header]);
      const q = place({ a: rows[k], w: 300, h: 49, vw: 1280, vh, edge: 'bottom', pill: { left: 0, right: 1280, top: 598, bottom: 646 }, inPill: false, vis: lvis, canAsk: false, panel: lp, avoid: others, measure });
      const qb = { left: q.x, right: q.x + q.w, top: q.y, bottom: q.y + q.h };
      const straddles = qb.left < lp.left && qb.right > lp.left || qb.left < lp.right && qb.right > lp.right;
      ok(q.covers && q.covers.text === 0 && q.covers.warn === 0, `full-width row ${k + 1}: the tip covers no other row's words (${q.side} ${q.x},${q.y} covers ${JSON.stringify(q.covers)})`);
      ok(!straddles && (qb.right <= lp.left - GAP + 0.01 || qb.left >= lp.right + GAP - 0.01), `full-width row ${k + 1}: wholly beside the panel, a gap from its edge (${qb.left}..${qb.right})`);
      ok(qb.bottom <= 597 + 0.01 && qb.top >= lvis.top && qb.left >= MARGIN - 0.01, `full-width row ${k + 1}: inside the band, off the pill`);
    }
  }

  // Too big to fit anywhere: the old clamp takes over (inside what is visible, never an ask).
  p = place(Object.assign({}, base, { w: 1100, h: 500, avoid: warn, measure: () => 500 }));
  ok(p.need === 0 && (p.side === 'over' || p.side === 'out' || p.side === 'in'), `panel, a tip bigger than the room: clamped as before (${p.side})`);

  // Sweep: anchors all over the panel, random text and warnings. Whatever is chosen stays in the
  // window, off the pill, off the element, never asks, and covers a warning only when every spot
  // tried does (checked by trying the same scene with the warnings demoted to plain text).
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let i = 0; i < 400; i++) {
    const ax = panel.left + 12 + rnd() * (panel.right - panel.left - 160), ay = panel.top + 12 + rnd() * (panel.bottom - panel.top - 40);
    const a = { left: ax, right: ax + 30 + rnd() * 110, top: ay, bottom: ay + 22 };
    const avoid = [];
    for (let k = 0; k < 8; k++) {
      const x = panel.left + 12 + rnd() * 300, y = panel.top + 12 + rnd() * 340;
      const r = { left: x, right: x + 40 + rnd() * 200, top: y, bottom: y + 17, warn: rnd() < 0.3 };
      if (!(Math.min(r.right, a.right) > Math.max(r.left, a.left) && Math.min(r.bottom, a.bottom) > Math.max(r.top, a.top))) avoid.push(r);
    }
    const w = 100 + Math.round(rnd() * 220), h = measure(w);
    const q = place({ a, w, h, vw, vh, edge: 'bottom', pill, inPill: false, vis, canAsk: false, panel, avoid, measure });
    const qw = q.w || w, qh = q.h || h;
    const box = { left: q.x, right: q.x + qw, top: q.y, bottom: q.y + qh };
    const offA = !(Math.min(box.right, a.right) - Math.max(box.left, a.left) > 0.5 && Math.min(box.bottom, a.bottom) - Math.max(box.top, a.top) > 0.5);
    ok(q.need === 0 && box.left >= MARGIN - 0.01 && box.right <= vw - MARGIN + 0.01 && box.bottom <= pill.top - 0.99 && box.top >= vis.top && (offA || q.side === 'over'),
      `sweep ${i}: in the window, off the pill and the element (${q.side} ${Math.round(box.left)},${Math.round(box.top)} ${qw}x${qh})`);
    // The candidates do not depend on the words, only the choice does: so if the choice made with the
    // warnings left out lands clear of every warning, a warning-free spot existed and must have won.
    const plain = place({ a, w, h, vw, vh, edge: 'bottom', pill, inPill: false, vis, canAsk: false, panel, avoid: avoid.filter(r => !r.warn), measure });
    const pb = { left: plain.x, right: plain.x + (plain.w || w), top: plain.y, bottom: plain.y + (plain.h || h) };
    const clear = !avoid.some(r => r.warn && Math.min(pb.right, r.right) - Math.max(pb.left, r.left) > 0.5 && Math.min(pb.bottom, r.bottom) - Math.max(pb.top, r.top) > 0.5);
    if (clear && plain.covers) ok(q.covers && q.covers.warn === 0, `sweep ${i}: a warning is covered only when every spot next to the element covers one (${q.side}, ${JSON.stringify(q.covers)})`);
  }
}

/* The surface and the wrap are CSS (tips.css): opaque, one theme, never an ellipsis. */
{
  const css = require('fs').readFileSync(require('path').join(__dirname, 'tips.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = (css.match(/\.mtip\s*\{([^}]*)\}/) || [])[1] || '';
  ok(/background-color:\s*var\(--lg-ground\)/.test(rule) && /background-image:\s*linear-gradient\(var\(--lg-fill-strong\),\s*var\(--lg-fill-strong\)\)/.test(rule),
    'tips.css: the frost is laid on an opaque ground (--lg-ground), so nothing behind shows through');
  const colours = (rule.match(/(#[0-9a-f]{3,8}\b|rgba?\(|hsla?\()/gi) || []);
  ok(colours.length === 0, `tips.css: every colour is a --lg-* token (${colours.join(' ') || 'none raw'})`);
  ok(!/text-overflow\s*:\s*ellipsis/.test(css) && !/white-space\s*:\s*nowrap/.test(css) && /white-space:\s*pre-line/.test(rule) && /overflow-wrap:\s*anywhere/.test(rule),
    'tips.css: wraps in whole lines (pre-line, overflow-wrap), never an ellipsis');
}

console.log(`tips: ${passed} passed, ${failed} failed`);
for (const f of failures.slice(0, 20)) console.log('  FAIL ' + f);
process.exit(failed ? 1 : 0);
