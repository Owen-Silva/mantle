/*
 * bar-intent.test.js -- lib/bar-intent.js, the band above the pill that keeps the bar up (lane mn-pop,
 * 2026-10-12, audit #6), driven by made-up cursor traces through a copy of main.js hoverTick's
 * reveal/keep/hide loop (60 ms ticks shown, 80 ms hidden, 180 ms grace, a 350 ms slide-away during
 * which a return is a "chase"). Every trace runs twice: the OLD keep zone (the pill, the reveal
 * band, the strip under the pill) and the NEW one (the same plus lib/bar-intent.js's band).
 * Geometry is the user's screen: 1536x864 DIP, a 1120-wide pill 14 DIP above the bottom edge.
 *
 *   node lib/bar-intent.test.js            (--verbose prints every trace's numbers)
 * One summary line: "BAR INTENT TEST: n passed, m failed".
 */
'use strict';
const I = require('./bar-intent');

let passed = 0;
const failures = [];
function ok(cond, what, detail) {
  if (cond) passed++;
  else failures.push(what + (detail !== undefined ? ' -- ' + JSON.stringify(detail).slice(0, 300) : ''));
}
const VERBOSE = process.argv.includes('--verbose');

const SCREEN = { x: 0, y: 0, width: 1536, height: 864 };
const PILL = { x: 208, y: 864 - 14 - 48, width: 1120, height: 48 };   // rest rect, DIP
const BAND_DIP = 4, GRACE = 180, SHOWN_MS = 60, HIDDEN_MS = 80, SLIDE_MS = 350;
const inR = (r, p) => p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height;
const inBand = (p) => p.y >= SCREEN.height - BAND_DIP && p.y < SCREEN.height;
// main.js inHotZone in pill mode: the band, the pill, the strip under the pill
const hot = (p) => inBand(p) || inR(PILL, p) || inR({ x: PILL.x, y: PILL.y + PILL.height, width: PILL.width, height: SCREEN.height - PILL.y - PILL.height }, p);
const OLD = (p) => hot(p);
// the 10-12 rule (lane mn-pop): the same plus 28 DIP up / 12 DIP to the sides, held for as long as the cursor stays
const MID = (p) => hot(p) || inR({ x: PILL.x - 12, y: PILL.y - 28, width: PILL.width + 24, height: PILL.height + 28 }, p);
// the 10-17 rule (lane mantle-barhover): lib/bar-intent.js zone() as main.js hoverTick calls it (rest = the pill and
// its 14 DIP of air, the shaped window = that rest rect while no pop-up is open), stepped by shownStep()
const REST = { x: PILL.x, y: PILL.y, width: PILL.width, height: SCREEN.height - PILL.y };
const NEW = (p) => I.zone(p, { rest: REST, win: REST, screen: SCREEN, edge: 'bottom', pill: true, inBand: inBand(p) });

/** Run trace(t) -> {x, y} for `ms` through the hover loop with keep zone `keep`. */
function simulate(trace, ms, keep) {
  let t = 0, shown = false, leftAt = null, outAt = null, hidingAt = null, revealAt = null;
  const out = { reveals: 0, chases: 0, hides: 0, quickHides: 0, revealLag: [], hideStarts: [] };
  let firstBandAt = null;
  while (t <= ms) {
    const p = trace(t);
    if (hidingAt !== null && t - hidingAt >= SLIDE_MS) { hidingAt = null; shown = false; leftAt = null; outAt = null; }
    if (!shown) {
      if (inBand(p) && firstBandAt === null) firstBandAt = t;
      if (inBand(p)) { shown = true; out.reveals++; revealAt = t; out.revealLag.push(t - firstBandAt); firstBandAt = null; }
      t += HIDDEN_MS;
      continue;
    }
    const k = keep(p);
    const zoned = typeof k === 'string';   // NEW answers 'in' | 'overshoot' | 'out'; only 'in' pulls a sliding bar back
    if (zoned ? k === 'in' : k) {
      leftAt = null; outAt = null;
      if (hidingAt !== null) { hidingAt = null; out.chases++; revealAt = t; }
    } else if (hidingAt === null) {
      const s = zoned ? I.shownStep({ leftAt, outAt }, t, k, GRACE) : I.shownTick(leftAt, t, false, GRACE);
      leftAt = s.leftAt; outAt = zoned ? s.outAt : null;
      if (s.hide) { hidingAt = t; out.hides++; out.hideStarts.push(t); if (t - revealAt < 1000) out.quickHides++; }
    }
    t += SHOWN_MS;
  }
  return out;
}

// a small seeded RNG: the traces are made up, but the same every run
let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const lerp = (a, b, f) => a + (b - a) * Math.max(0, Math.min(1, f));
/** A path through waypoints [[t, x, y], ...], straight lines between them. */
const path = (pts) => (t) => {
  if (t <= pts[0][0]) return { x: pts[0][1], y: pts[0][2] };
  for (let i = 1; i < pts.length; i++) {
    if (t <= pts[i][0]) { const f = (t - pts[i - 1][0]) / (pts[i][0] - pts[i - 1][0]); return { x: lerp(pts[i - 1][1], pts[i][1], f), y: lerp(pts[i - 1][2], pts[i][2], f) }; }
  }
  const l = pts[pts.length - 1];
  return { x: l[1], y: l[2] };
};

function main() {
  // ---- the band itself
  const b = I.band(PILL, 'bottom');
  ok(b.y === PILL.y - I.KEEP_ABOVE_DIP && b.height === PILL.height + I.KEEP_ABOVE_DIP, 'bottom bar: the band grows UP by KEEP_ABOVE_DIP', b);
  ok(b.x === PILL.x - I.KEEP_SIDE_DIP && b.width === PILL.width + 2 * I.KEEP_SIDE_DIP, 'and KEEP_SIDE_DIP past each end', b);
  const top = I.band({ x: 10, y: 14, width: 100, height: 48 }, 'top');
  ok(top.y === 14 && top.height === 48 + I.KEEP_ABOVE_DIP, 'top bar: the band grows DOWN instead', top);
  ok(I.holds({ x: 700, y: PILL.y - 1 }, PILL, 'bottom') && I.holds({ x: 700, y: PILL.y - I.KEEP_ABOVE_DIP }, PILL, 'bottom'), 'a cursor 1..KEEP_ABOVE_DIP above the pill is held');
  ok(!I.holds({ x: 700, y: PILL.y - I.KEEP_ABOVE_DIP - 1 }, PILL, 'bottom'), 'one DIP further up is not');
  ok(!I.holds({ x: PILL.x - I.KEEP_SIDE_DIP - 1, y: PILL.y }, PILL, 'bottom'), 'nor is a cursor past the side margin');
  ok(!I.holds({ x: 700, y: 700 }, null, 'bottom') && I.band(null) === null, 'no rest rect: nothing is held (and nothing throws)');
  ok(I.OVERSHOOT_ABOVE_DIP >= 24 && I.OVERSHOOT_ABOVE_DIP <= 32, 'the overshoot band is the audit\'s 24-32 DIP', I.OVERSHOOT_ABOVE_DIP);
  ok(I.KEEP_ABOVE_DIP <= 10 && I.KEEP_SIDE_DIP <= 10, 'the rest band is a small margin (<= 10 DIP up and to the sides; the user, 10-17)', [I.KEEP_ABOVE_DIP, I.KEEP_SIDE_DIP]);

  // ---- shownTick: the grace rule main.js always had
  let s = I.shownTick(null, 1000, false, GRACE);
  ok(s.leftAt === 1000 && !s.hide, 'shownTick: the first tick outside starts the clock');
  s = I.shownTick(1000, 1179, false, GRACE);
  ok(!s.hide, 'shownTick: 179 ms out is still inside the grace');
  s = I.shownTick(1000, 1180, false, GRACE);
  ok(s.hide, 'shownTick: 180 ms out hides');
  s = I.shownTick(1000, 1100, true, GRACE);
  ok(s.leftAt === null && !s.hide, 'shownTick: coming back resets the clock');

  // ---- traces
  const sum = (rule, traces) => traces.reduce((a, [tr, ms]) => {
    const r = simulate(tr, ms, rule);
    a.reveals += r.reveals; a.chases += r.chases; a.hides += r.hides; a.quickHides += r.quickHides;
    a.lag = Math.max(a.lag, ...r.revealLag, 0);
    return a;
  }, { reveals: 0, chases: 0, hides: 0, quickHides: 0, lag: 0 });

  // A. reach and wander: down to the edge, up to an icon row, then drift 2..24 DIP above the pill
  //    top for ~1.5 s (reading a tooltip, aiming between icons), back in, then away up.
  const wander = [];
  for (let i = 0; i < 40; i++) {
    const x = 300 + rnd() * 900;
    const pts = [[0, x, 600], [200, x, 863], [320, x, 863], [480, x, PILL.y + 20]];
    let t = 480;
    for (let j = 0; j < 6; j++) { t += 120 + rnd() * 200; pts.push([t, x + (rnd() - 0.5) * 120, PILL.y - 2 - rnd() * 22]); t += 80 + rnd() * 120; pts.push([t, x + (rnd() - 0.5) * 120, PILL.y + 10]); }
    pts.push([t + 300, x, PILL.y + 20], [t + 500, x, 300]);
    wander.push([path(pts), t + 1500]);
  }
  // D. aim at an icon from above and overshoot past its top by 4..26 DIP for 100..300 ms
  const overshoot = [];
  for (let i = 0; i < 40; i++) {
    const x = 300 + rnd() * 900;
    const over = 4 + rnd() * 22, hold = 100 + rnd() * 200;
    overshoot.push([path([[0, x, 500], [180, x, 863], [300, x, 863], [380, x, PILL.y + 24], [480, x, PILL.y - over], [480 + hold, x, PILL.y - over], [580 + hold, x, PILL.y + 24], [1500 + hold, x, PILL.y + 24], [1700 + hold, x, 200]]), 2600 + hold]);
  }
  const oA = sum(OLD, wander), nA = sum(NEW, wander), oD = sum(OLD, overshoot), nD = sum(NEW, overshoot);
  console.log(`  wander (40 traces):    old ${oA.chases} chases and ${oA.quickHides} hides within 1 s of coming up (${oA.reveals} reveals); new ${nA.chases} and ${nA.quickHides} (${nA.reveals})`);
  console.log(`  overshoot (40 traces): old ${oD.chases} chases and ${oD.quickHides} hides within 1 s of coming up (${oD.reveals} reveals); new ${nD.chases} and ${nD.quickHides} (${nD.reveals})`);
  ok(oA.chases > 0 && oD.chases + oD.quickHides > 0, 'the old keep zone shows the fault (chases / quick hides) on these traces', { oA, oD });
  ok(nA.chases === 0 && nA.quickHides === 0, 'wander: the new band keeps the bar up the whole time (no chase, no quick hide)', nA);
  ok(nD.chases === 0 && nD.quickHides === 0, 'overshoot: the new band holds through every overshoot of up to 26 DIP', nD);

  // B. a deliberate exit straight up at 600..1500 DIP/s: how long after leaving the pill the hide starts
  let worst = 0;
  for (let i = 0; i < 30; i++) {
    const v = 600 + rnd() * 900;   // DIP/s
    const x = 300 + rnd() * 900;
    const leave = 1000;
    const tr = (t) => (t < leave ? (t < 200 ? { x, y: 863 } : { x, y: PILL.y + 20 }) : { x, y: PILL.y - (t - leave) * v / 1000 });
    const o = simulate(tr, 3000, OLD), n = simulate(tr, 3000, NEW);
    const d = (n.hideStarts[0] || 0) - (o.hideStarts[0] || 0);
    worst = Math.max(worst, d);
    if (VERBOSE) console.log(`    exit at ${Math.round(v)} DIP/s: hide starts ${o.hideStarts[0] - leave} ms (old) / ${n.hideStarts[0] - leave} ms (new) after leaving the pill`);
  }
  console.log(`  deliberate exit (30 traces, 600-1500 DIP/s): the hide starts at most ${worst} ms later than before`);
  ok(worst <= SHOWN_MS, 'a deliberate exit hides at most one 60 ms tick later than before (the band is crossed in ~20-50 ms)', worst);

  // C. reveals stay instant: the first hidden tick in the band reveals, old and new
  const pushes = [];
  for (let i = 0; i < 30; i++) { const x = 100 + rnd() * 1300; pushes.push([path([[0, x, 700], [100 + rnd() * 300, x, 863], [2000, x, 863]]), 1200]); }
  const oC = sum(OLD, pushes), nC = sum(NEW, pushes);
  ok(nC.reveals === 30 && nC.lag === 0 && oC.lag === 0, 'the reveal is still instant: the first tick in the edge band reveals (no dwell)', { oC, nC });
  // and a cursor merely ABOVE where the pill would be never reveals it (hysteresis: reaching the edge reveals, the band only keeps)
  const hover = path([[0, 700, PILL.y - 10], [3000, 900, PILL.y + 10]]);
  ok(simulate(hover, 3000, NEW).reveals === 0, 'a hidden bar is not revealed by the band, only by the edge');

  // E. THE HOVER BAND (lane mantle-barhover, 10-17; the user: "i can hold my mouse a lot of pixels above it without it
  //    going away"). Reveal at the edge, settle in the pill, then REST the cursor `off` DIP above the pill's top
  //    (or past its end) for 3 s. The band = the furthest rest that never starts a hide. The 10-12 rule (MID,
  //    what live ran) kept 28 DIP up and 12 to the side for ever; the new one keeps the rest band only.
  const restAt = (x, y) => path([[0, 760, 700], [150, 760, 863], [300, 760, PILL.y + 24], [600, 760, PILL.y + 24], [650, x, y], [3650, x, y]]);
  const firstHide = (rule, tr) => { const r = simulate(tr, 3650, rule); if (r.hideStarts.some((t) => t < 650)) return -1; const h = r.hideStarts.find((t) => t >= 650); return h === undefined ? null : h - 650; };
  const bandOf = (rule, mk) => { let best = -1; for (let off = 0; off <= 120; off++) { if (firstHide(rule, mk(off)) === null) best = off; else break; } return best; };
  const upMid = bandOf(MID, (off) => restAt(760, PILL.y - off)), upNew = bandOf(NEW, (off) => restAt(760, PILL.y - off));
  const sideMid = bandOf(MID, (off) => restAt(PILL.x - off, PILL.y + 20)), sideNew = bandOf(NEW, (off) => restAt(PILL.x - off, PILL.y + 20));
  console.log(`  hover band (cursor resting 3 s): 10-12 rule ${upMid} DIP above / ${sideMid} DIP to the side; now ${upNew} / ${sideNew}`);
  ok(upMid === 28 && sideMid === 12, 'the 10-12 rule (live until now) keeps a cursor resting 28 DIP above / 12 DIP beside the pill for ever', { upMid, sideMid });
  ok(upNew === I.KEEP_ABOVE_DIP && sideNew === I.KEEP_SIDE_DIP, 'the hover band is the pill plus the small margin: a cursor resting 1 DIP further up or out starts the hide', { upNew, sideNew });
  // how soon a resting cursor starts the hide, by where it rests
  const t9 = firstHide(NEW, restAt(760, PILL.y - (I.KEEP_ABOVE_DIP + 1))), t28 = firstHide(NEW, restAt(760, PILL.y - I.OVERSHOOT_ABOVE_DIP));
  const t29 = firstHide(NEW, restAt(760, PILL.y - (I.OVERSHOOT_ABOVE_DIP + 1))), t200 = firstHide(NEW, restAt(760, PILL.y - 200));
  console.log(`  resting ${I.KEEP_ABOVE_DIP + 1} / ${I.OVERSHOOT_ABOVE_DIP} DIP above: the hide starts after ${t9} / ${t28} ms; ${I.OVERSHOOT_ABOVE_DIP + 1} / 200 DIP above: ${t29} / ${t200} ms`);
  ok(t9 !== null && t28 !== null && t9 >= I.OVERSHOOT_MS && t9 <= I.OVERSHOOT_MS + SHOWN_MS && t28 >= I.OVERSHOOT_MS && t28 <= I.OVERSHOOT_MS + SHOWN_MS,
    'resting in the overshoot band starts the hide after OVERSHOOT_MS (one tick at most later)', { t9, t28 });
  ok(t29 !== null && t200 !== null && t29 >= GRACE && t29 <= GRACE + SHOWN_MS && t200 >= GRACE && t200 <= GRACE + SHOWN_MS,
    'past the overshoot band (and far above) the hide starts after the 180 ms grace, as before', { t29, t200 });
  // the slide-away is never pulled back by a cursor resting in the overshoot band (no bounce), only by the rest band
  const r20 = simulate(restAt(760, PILL.y - 20), 3650, NEW);
  ok(r20.chases === 0 && r20.hides === 1, 'resting 20 DIP above: one hide, no chase back (the overshoot band never bounces a sliding bar)', r20);
  const back = path([[0, 760, 700], [150, 760, 863], [300, 760, PILL.y + 24], [600, 760, PILL.y + 24], [650, 760, PILL.y - 60], [900, 760, PILL.y - 60], [930, 760, PILL.y + 10], [3000, 760, PILL.y + 10]]);
  const rb = simulate(back, 3000, NEW);
  ok(rb.chases === 1, 'coming back INTO the pill mid-slide still pulls the bar back up', rb);
  // the 4 DIP reveal band and the air under the pill keep it, at any rest
  ok(NEW({ x: 20, y: 862 }) === 'in' && NEW({ x: 760, y: 860 }) === 'in' && NEW({ x: 760, y: PILL.y - 9 }) === 'overshoot' && NEW({ x: 760, y: PILL.y - 29 }) === 'out',
    'zone(): the reveal band and the air under the pill are in; 9 DIP above is overshoot, 29 DIP above is out');
  // a pop-up's room (main passes the SHAPED rect as win: rest plus the room) keeps the bar while the cursor is in it
  const room = { x: REST.x, y: REST.y - 192, width: REST.width, height: REST.height + 192 };
  ok(I.zone({ x: 760, y: PILL.y - 150 }, { rest: REST, win: room, screen: SCREEN, edge: 'bottom', pill: true, inBand: false }) === 'in'
    && I.zone({ x: 760, y: PILL.y - 260 }, { rest: REST, win: room, screen: SCREEN, edge: 'bottom', pill: true, inBand: false }) === 'out',
    'zone(): with a pop-up\'s room shaped in, the room is in; above it is out');
  ok(/y 794 \(the pill and 8 DIP\)/.test(I.describe(REST, 'bottom')) && /y 774 \(28 DIP\)/.test(I.describe(REST, 'bottom')), 'describe(): the log names both bands in DIP', I.describe(REST, 'bottom'));

  for (const f of failures) console.log('  FAIL ' + f);
  console.log(`BAR INTENT TEST: ${passed} passed, ${failures.length} failed`);
  process.exitCode = failures.length ? 1 : 0;
}

main();
