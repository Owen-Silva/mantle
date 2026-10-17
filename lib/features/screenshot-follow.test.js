// screenshot-follow.test.js - the screenshot card IN THE CORNER, GLIDING WITH THE BAR (lane corner-follow-card,
// 2026-10-17). Owen, of the banners: "this and anything else that comes up here needs to go in the corner not up
// like this ... just have them smoothly move up if the taskbar comes up". The card used to sit above the bar's
// RESTING shape (barRect(), even while the bar is hidden): 62 DIP up from the corner with nothing there.
// Now the window is placed as if the bar were not there, the reach above the card; the page lifts the card on
// the bar's clock (lib/bar-follow.js, the banners' follower) and the window's shape is wherever the card is.
//
//   node lib/features/screenshot-follow.test.js   -> "SCREENSHOT FOLLOW TEST: n passed, m failed"
//
// No Electron, no window, no screen: the real cardPlan / reachOver / createFollower / cornerSpots, Owen's numbers.
'use strict';
const path = require('path');
const fs = require('fs');
const T = require('./screenshot.js')._test;
const BF = require('../bar-follow');
const C = require('./_toasts-core');

let passed = 0; const failures = [];
function check(name, ok, detail) { if (ok) passed++; else failures.push(`${name}${detail !== undefined ? ` (${JSON.stringify(detail).slice(0, 400)})` : ''}`); }
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Owen's screen: 1920x1080 at 125 % = work {0,0,1536,864} DIP; the pill's resting shape {208,802,1120,62}
const work = { x: 0, y: 0, width: 1536, height: 864 };
const pill = { x: 208, y: 802, width: 1120, height: 62 };
const M = T.CARD_MARGIN;
const size = { w: 264, h: 98 };          // a copied capture: the picture + "Screenshot copied" + Save
const h = size.h + 2 * M, w = size.w + 2 * M;
const visBottom = (p) => p.win.y + p.win.height - M - p.lift;   // the card's own bottom edge on screen

/* ---- placement: low with the bar hidden, above the pill with it up, the reach between ---------------------- */
{
  const before = T.cardSpot(size, work, pill);
  check('STEP 1 (what it did): above the resting pill even with the bar hidden: 62 DIP of nothing under the card',
    before.y + before.height === 802 && 864 - (before.y + before.height - M) === 74, before);
  const low = T.cardPlan(size, work, pill, BF.spanSettle({ to: 0 }), false);
  check('bar hidden: the card is in the corner (its bottom 12 DIP above the screen\'s, as Windows\' own)',
    low.low.y + low.low.height === 864 && visBottom(low) === 852 && low.lift === 0, low);
  check('the reach is the pill\'s height: 62 DIP (lib/bar-follow.js reachOver against the RESTING shape)', low.reach === 62, low.reach);
  check('the window is the card plus the reach ABOVE it, its bottom at the corner', eq(low.win, { x: 1536 - w, y: 864 - h - 62, width: w, height: h + 62 }), low.win);
  check('bar hidden: the shape is the card at the window\'s bottom (the reach band is not there: no click eaten)',
    eq(low.shape, { x: 0, y: 62, width: w, height: h }), low.shape);
  const up = T.cardPlan(size, work, pill, BF.spanSettle({ to: 62 }), false);
  check('bar up: the window does not move (no re-layout, no stale frame)', eq(up.win, low.win), { low: low.win, up: up.win });
  check('bar up: the card stands 12 DIP above the pill, never on it', visBottom(up) === 790 && pill.y - visBottom(up) === 12, visBottom(up));
  check('bar up: the shape is the card, 62 up (the band under it, over the pill, passes clicks to the bar)',
    eq(up.shape, { x: 0, y: 0, width: w, height: h }), up.shape);
  const mid = T.cardPlan(size, work, pill, BF.spanTo(BF.spanSettle({ to: 0 }), 62), false);
  check('while it glides the shape spans every place it passes (low .. high)', eq(mid.shape, { x: 0, y: 0, width: w, height: h + 62 }), mid.shape);
  const settled = T.cardPlan(size, work, pill, BF.spanSettle(BF.spanTo(BF.spanSettle({ to: 0 }), 62)), false);
  check('after the glide the shape narrows to where it stands', eq(settled.shape, up.shape), settled.shape);
  const wide = T.cardPlan({ w: 372, h: 130 }, work, pill, BF.spanSettle({ to: 0 }), false);
  check('a wide card (after Save): same corner, same reach', wide.reach === 62 && wide.low.x + wide.low.width === 1536 && wide.low.y + wide.low.height === 864, wide);
}

/* ---- no reach: docked, a top-edge bar, a bar not under the card, no bar ------------------------------------ */
{
  const docked = { x: 0, y: 864, width: 1536, height: 48 };   // --dock: the pinned bar outside the work area
  const top = { x: 208, y: 0, width: 1120, height: 62 };
  const narrow = { x: 400, y: 802, width: 600, height: 62 };   // ends left of the card's columns
  for (const [name, bar] of [['docked (--dock)', docked], ['a top-edge bar', top], ['a bar that ends left of the card', narrow], ['no bar', null]]) {
    const p = T.cardPlan(size, work, bar, BF.spanSettle({ to: 0 }), false);
    check(`${name}: reach 0, the window is the card in the corner, nothing moves`, p.reach === 0 && p.win.height === h && p.win.y === 864 - h && eq(p.shape, { x: 0, y: 0, width: w, height: h }), p);
  }
  const open = { x: 1100, y: 600, width: 436, height: 264 };   // the bar with a pop-up open over the corner
  const p = T.cardPlan(size, work, open, BF.spanSettle({ to: 0 }), false);
  check('a bar pop-up open over the corner: the reach is to above it', p.reach === 864 - 600, p.reach);
}

/* ---- flat: the shape would not stick -> the window is the card, straight at where it rests -------------- */
{
  const f0 = T.cardPlan(size, work, pill, BF.spanSettle({ to: 0 }), true);
  const f1 = T.cardPlan(size, work, pill, BF.spanSettle({ to: 62 }), true);
  check('flat, bar hidden: the window is the card, in the corner (no glass above it)', eq(f0.win, { x: 1536 - w, y: 864 - h, width: w, height: h }) && f0.shape === null, f0);
  check('flat, bar up: the window is the card, 62 up (no glide, never on the pill)', eq(f1.win, { x: 1536 - w, y: 864 - h - 62, width: w, height: h }) && f1.win.y + f1.win.height - M === 790, f1);
}

/* ---- the follower as placeCard drives it (lib/bar-follow.js createFollower, the card's o.*) -------------- */
function rig(opts) {
  const sent = [];
  const fns = new Set();
  const bar = { isUp: !!(opts && opts.up), up() { return this.isUp; }, onMotion(fn) { fns.add(fn); return () => fns.delete(fn); } };
  const S = { shown: !!(opts && opts.shown), flat: false, placed: 0 };
  const F = BF.createFollower({
    bar, target: (up) => (up ? T.cardPlan(size, work, pill, null, false).reach : 0),
    shown: () => S.shown, flat: () => S.flat, send: (p) => sent.push(p), settled: () => { S.placed++; },
    moved: (plan) => { F.retarget(plan.kind, plan.ms); S.placed++; },
  });
  const move = (up, ms) => { bar.isUp = up; for (const fn of fns) fn({ up, ms }); };
  return { F, S, sent, move, bar };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  {
    const R = rig({ shown: true });
    R.F.span();
    R.move(true, 560);
    const g = R.sent[R.sent.length - 1];
    check('the bar comes up with the card on screen: it glides 62 up on the spring in 0.6 x 560 = 336 ms', g && g.px === 62 && g.kind === 'up' && g.ms === 336, R.sent);
    const span = R.F.state().span;
    const p = T.cardPlan(size, work, pill, span, false);
    check('the shape set at that tick spans the whole glide', eq(p.shape, { x: 0, y: 0, width: w, height: h + 62 }), p.shape);
    await sleep(336 + BF.SETTLE_PAD_MS + 40);
    const after = T.cardPlan(size, work, pill, R.F.state().span, false);
    check('the glide over, the window is re-placed (settled) and the shape narrows to the card', R.S.placed >= 2 && eq(after.shape, { x: 0, y: 0, width: w, height: h }), { placed: R.S.placed, shape: after.shape });
    R.move(false, 240);
    const d = R.sent[R.sent.length - 1];
    check('the bar goes: down on the exit, 60 ms behind the bar (240 + 60)', d && d.px === 0 && d.kind === 'down' && d.ms === 300, d);
    R.F.stop();
  }
  {
    const R = rig({ shown: false });
    R.move(true, 560);
    const g = R.sent[R.sent.length - 1];
    check('nothing on screen: no glide, the page simply stands at the target for the next card', g && g.px === 62 && g.ms === 0 && R.F.state().glides === 0, R.sent);
    R.F.stop();
  }
  {
    // a card that comes up while the bar is still GOING: it starts where the bar's top was and goes down with it
    const R = rig({ shown: false, up: true });
    R.F.span();
    R.move(false, 240);
    await sleep(80);
    R.S.shown = true;
    const n = R.sent.length;
    const caught = R.F.catchUp(false);
    const a = R.sent[n], b = R.sent[n + 1];
    check('catchUp mid-hide: starts at the bar\'s top (62, no travel), then down over what is left of the exit', caught && a && a.px === 62 && a.ms === 0 && b && b.px === 0 && b.kind === 'down' && b.ms > 150 && b.ms < 300, { caught, a, b });
    const p = T.cardPlan(size, work, pill, R.F.state().span, false);
    check('catchUp: the shape spans 62 .. 0 while it goes', eq(p.shape, { x: 0, y: 0, width: w, height: h + 62 }), p.shape);
    check('a card already on screen never catches up (it was already gliding)', !R.F.catchUp(true));
    R.F.stop();
  }
  {
    const R = rig({ shown: true });
    R.F.span();
    R.S.flat = true;
    R.move(true, 560);
    const g = R.sent[R.sent.length - 1];
    check('flat: the page\'s lift stays 0 and nothing glides; main re-places the window (moved)', g && g.px === 0 && g.ms === 0 && R.F.state().glides === 0 && R.S.placed === 1, { g, st: R.F.state(), placed: R.S.placed });
    const p = T.cardPlan(size, work, pill, R.F.state().span, true);
    check('flat: the window jumps to 62 up (the span\'s target), sized to the card', p.win.y === 864 - h - 62 && p.win.height === h, p.win);
    R.F.stop();
  }
  {
    // the banners stack above the card and rise WITH it (lib/corner.js lift -> _toasts-core.js cornerSpots)
    const p = T.cardPlan(size, work, pill, BF.spanSettle({ to: 0 }), false);
    const others = [{ key: 'the screenshot card', x: p.low.x, y: p.low.y, width: p.low.width, height: p.low.height, lift: p.reach }];
    const cs = C.cornerSpots({ work, bar: pill, others, w: 392, top: 8, barUp: true });
    const csDown = C.cornerSpots({ work, bar: pill, others, w: 392, top: 8, barUp: false });
    check('banners, bar hidden: they stand on the card\'s low top', csDown.low.y + csDown.low.height === p.low.y && csDown.lift === 0, csDown.low);
    check('banners, bar up: they rise exactly the card\'s reach, onto its lifted top', cs.reach === p.reach && cs.high.y + cs.high.height === p.low.y - p.reach && cs.lift === 62, { reach: cs.reach, high: cs.high });
    const card = rig({ shown: true }), banners = rig({ shown: true });
    card.F.span(); banners.F.span();
    card.move(true, 560); banners.move(true, 560);
    const a = card.sent[card.sent.length - 1], b = banners.sent[banners.sent.length - 1];
    check('the card and the banners glide on the same clock (motionPlan): same kind, same ms', a.kind === b.kind && a.ms === b.ms, { a, b });
    card.F.stop(); banners.F.stop();
  }

  /* ---- the wiring (source pins: placeCard needs a live window) ---------------------------------------------- */
  const src = fs.readFileSync(path.join(__dirname, 'screenshot.js'), 'utf8');
  check('wiring: placeCard places from cardPlan with the follower\'s span, never from the resting bar directly',
    /const p = cardPlan\(c\.size, d\.workArea, ctx\.host\.barRect\(\), cardF\.span\(\), c\.shapeOk === false\);/.test(src) && !/cardSpot\(\{ w: a\.w, h: a\.h \}, d\.workArea, ctx\.host\.barRect\(\)\)/.test(src));
  check('wiring: the shape is set BEFORE the window moves on screen, and the first one is read back',
    src.indexOf('barShape.apply(c.win, p.shape)') > 0 && src.indexOf('barShape.apply(c.win, p.shape)') < src.indexOf("place(card, { x: phys.x, y: phys.y, w: phys.width, h: phys.height }, true)") &&
    /barShape\.verify\(c\.hwnd, p\.shape, d\.scaleFactor \|\| 1\)/.test(src));
  check('wiring: the corner gets the card\'s LOW rect and its reach as lift', /corner\.set\(CORNER_KEY, p\.low, \{ lift: p\.reach \}\)/.test(src));
  check('wiring: the follower sends screenshot.lift, re-places on settle and on the bar\'s motion',
    /ctx\.push\(card\.win, 'screenshot\.lift', p\)/.test(src) && /settled: \(\) => placeCard\(\)/.test(src) && /moved: \(plan\) => \{ cardF\.retarget\(plan\.kind, plan\.ms\); placeCard\(\); \}/.test(src));
  check('wiring: cardShown catches up first (the bar going), else retargets, then places',
    /if \(!cardF\.catchUp\(card\.onScreen\)\) cardF\.retarget\(\);\r?\n\s*placeCard\(\);/.test(src));
  check('wiring: the page stands where the card rests before it is shown', /if \(!card\.onScreen\) \{ card\.size = null; cardF\.stand\(\); \}\r?\n\s*ctx\.push\(card\.win, 'screenshot\.card', card\.info\);/.test(src));
  check('wiring: --test places only the trace\'s card; testCard / cardState exist only in --test',
    /if \(test && !\(c\.info && c\.info\.trace\)\) return false;/.test(src) && /if \(test\) \{\r?\n\s*\/\* TEST ONLY \(lane corner-follow-card\)[\s\S]{0,700}ctx\.command\('testCard'/.test(src) && (src.match(/ctx\.command\('testCard'/g) || []).length === 1);
  check('wiring: the follower and the corner hook die with the feature', /cardF\.stop\(\);\r?\n\s*offCorner\(\);/.test(src));
  check('wiring: a new card window resets the follower', /cardF\.reset\(\);/.test(src));
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'ui', 'screenshot', 'card.html'), 'utf8');
  check('page: bar-follow.css after card.css, bar-follow.js before card.js, #card inside #lift',
    html.indexOf('bar-follow.css') > html.indexOf('card.css') && html.indexOf('bar-follow.js') < html.indexOf('src="card.js"') && /<div id="lift">\s*<div id="card" hidden>/.test(html));

  console.log(`SCREENSHOT FOLLOW TEST: ${passed} passed, ${failures.length} failed`);
  failures.forEach((f) => console.log(`  FAIL ${f}`));
  process.exit(failures.length ? 1 : 0);
})();
