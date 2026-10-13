/*
 * bar-intent.test.js -- lib/bar-intent.js, the band above the pill that keeps the bar up (lane mn-pop,
 * 2026-10-12, audit #6), driven by made-up cursor traces through a copy of main.js hoverTick's
 * reveal/keep/hide loop (60 ms ticks shown, 80 ms hidden, 180 ms grace, a 350 ms slide-away during
 * which a return is a "chase"). Every trace runs twice: the OLD keep zone (the pill, the reveal
 * band, the strip under the pill) and the NEW one (the same plus lib/bar-intent.js's band).
 * Geometry is Owen's screen: 1536x864 DIP, a 1120-wide pill 14 DIP above the bottom edge.
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
const NEW = (p) => hot(p) || I.holds(p, PILL, 'bottom');

/** Run trace(t) -> {x, y} for `ms` through the hover loop with keep zone `keep`. */
function simulate(trace, ms, keep) {
  let t = 0, shown = false, leftAt = null, hidingAt = null, revealAt = null;
  const out = { reveals: 0, chases: 0, hides: 0, quickHides: 0, revealLag: [], hideStarts: [] };
  let firstBandAt = null;
  while (t <= ms) {
    const p = trace(t);
    if (hidingAt !== null && t - hidingAt >= SLIDE_MS) { hidingAt = null; shown = false; leftAt = null; }
    if (!shown) {
      if (inBand(p) && firstBandAt === null) firstBandAt = t;
      if (inBand(p)) { shown = true; out.reveals++; revealAt = t; out.revealLag.push(t - firstBandAt); firstBandAt = null; }
      t += HIDDEN_MS;
      continue;
    }
    const k = keep(p);
    if (k) {
      leftAt = null;
      if (hidingAt !== null) { hidingAt = null; out.chases++; revealAt = t; }
    } else if (hidingAt === null) {
      const s = I.shownTick(leftAt, t, false, GRACE);
      leftAt = s.leftAt;
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
  ok(I.KEEP_ABOVE_DIP >= 24 && I.KEEP_ABOVE_DIP <= 32, 'the band is the audit\'s 24-32 DIP', I.KEEP_ABOVE_DIP);

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

  for (const f of failures) console.log('  FAIL ' + f);
  console.log(`BAR INTENT TEST: ${passed} passed, ${failures.length} failed`);
  process.exitCode = failures.length ? 1 : 0;
}

main();
