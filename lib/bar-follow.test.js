'use strict';
/* node lib/bar-follow.test.js - the shared "glides with the bar" mechanism (lane mantle-corner-follow). */
const BF = require('./bar-follow');
const C = require('./features/_toasts-core');

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(name + (detail === undefined ? '' : ' -- ' + JSON.stringify(detail)));
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // ---- the clock (lane mantle-corner3's numbers, unchanged by the move)
  check('up: 0.6 of the bar\'s 560 ms reveal = 336 (always ahead of the pill)', JSON.stringify(BF.motionPlan({ up: true, ms: 560 })) === JSON.stringify({ up: true, kind: 'up', ms: 336 }));
  check('down: main says 320, the bar\'s page runs 240 (OUT_MAX), + 60 = 300 (always behind it)', BF.motionPlan({ up: false, ms: 320 }).ms === 300 && BF.motionPlan({ up: false, ms: 320 }).kind === 'down');
  check('down: a short exit is clamped up to 140 + 60', BF.motionPlan({ up: false, ms: 50 }).ms === 200);
  check('no ms: the bar\'s defaults (560 up, 240 down)', BF.motionPlan({ up: true }).ms === 336 && BF.motionPlan({ up: false }).ms === 300);
  check('the toasts\' names are still there (re-exported by _toasts-core)', C.spanTo === BF.spanTo && C.spanSettle === BF.spanSettle && C.rectFor === BF.rectFor);

  // ---- reachOver: Owen's screen, 1536 x 864 DIP, the pill's resting shape { 208, 802, 1120, 62 }
  const work = { x: 0, y: 0, width: 1536, height: 864 };
  const bar = { x: 208, y: 802, width: 1120, height: 62 };
  check('a window at the bottom right that the pill reaches: rises 62 (to stand on the bar\'s top)', BF.reachOver({ x: 1160, y: 600, width: 376, height: 264 }, bar, work) === 62);
  check('bottom centre (the volume pop-up, its window\'s bottom on the screen\'s): 62', BF.reachOver({ x: 606, y: 782, width: 324, height: 82 }, bar, work) === 62);
  check('a window 6 DIP above the corner: 56', BF.reachOver({ x: 1154, y: 600, width: 376, height: 258 }, bar, work) === 56);
  check('a wide screen, the pill not across the corner: 0', BF.reachOver({ x: 1540, y: 800, width: 376, height: 280 }, { x: 400, y: 1018, width: 1120, height: 62 }, { x: 0, y: 0, width: 1920, height: 1080 }) === 0);
  check('already clear above the bar: 0', BF.reachOver({ x: 1160, y: 500, width: 376, height: 200 }, bar, work) === 0);
  check('a top-edge bar is never under it: 0', BF.reachOver({ x: 606, y: 782, width: 324, height: 82 }, { x: 208, y: 0, width: 1120, height: 62 }, work) === 0);
  check('no bar / an empty one: 0', BF.reachOver({ x: 0, y: 0, width: 10, height: 10 }, null, work) === 0 && BF.reachOver({ x: 0, y: 0, width: 10, height: 10 }, { x: 0, y: 0, width: 0, height: 0 }, work) === 0);
  check('a bar pop-up open (the resting shape is taller): it rises above the pop-up', BF.reachOver({ x: 606, y: 782, width: 324, height: 82 }, { x: 208, y: 502, width: 1120, height: 362 }, work) === 362);

  // ---- rectFor: a 100-tall surface at the bottom of a 162-tall window
  check('rectFor standing at 0: the bottom 100', JSON.stringify(BF.rectFor(BF.spanSettle({ to: 0 }), 100, 162, 300)) === JSON.stringify({ x: 0, y: 62, width: 300, height: 100 }));
  check('rectFor standing at 62: the top 100', JSON.stringify(BF.rectFor(BF.spanSettle({ to: 62 }), 100, 162, 300)) === JSON.stringify({ x: 0, y: 0, width: 300, height: 100 }));
  check('rectFor gliding 0..62: all 162', JSON.stringify(BF.rectFor(BF.spanTo(BF.spanSettle({ to: 0 }), 62), 100, 162, 300)) === JSON.stringify({ x: 0, y: 0, width: 300, height: 162 }));

  // ---- cornerSpots: a thing that lifts with the bar (the card, the record panel) carries the banners with it
  const card = { key: 'the screenshot card', x: 1536 - 324, y: 864 - 160, width: 324, height: 160 };
  const still = C.cornerSpots({ work, bar, others: [card], w: 392, top: 8, barUp: true });
  check('a card that does NOT glide (no lift) and is taller than the bar: the banners stand above it either way (reach 0)', still.reach === 0, still);
  const glides = C.cornerSpots({ work, bar, others: [Object.assign({ lift: 62 }, card)], w: 392, top: 8, barUp: true });
  check('a card that glides 62 with the bar: the banners rise 62 with it (above where it is then)', glides.reach === 62 && glides.lift === 62 && glides.low.y + glides.low.height === 704 && glides.high.y + glides.high.height === 642, glides);
  const hidden = C.cornerSpots({ work, bar, others: [Object.assign({ lift: 62 }, card)], w: 392, top: 8, barUp: false });
  check('... the bar hidden: they stand on the card in the corner (lift 0)', hidden.lift === 0 && hidden.low.y + hidden.low.height === 704, hidden);

  // ---- createFollower: a fake bar hook and a page
  let up = false, motionFn = null, unhooked = 0;
  const fakeBar = { up: () => up, onMotion: (fn) => { motionFn = fn; return () => { unhooked++; motionFn = null; }; } };
  const sent = [];
  let shown = true, flat = false, settles = 0;
  const reach = 62;
  const F = BF.createFollower({ bar: fakeBar, target: (u) => (u ? reach : 0), shown: () => shown, flat: () => flat, send: (p) => sent.push(p), settled: () => settles++ });
  check('made with the bar hidden: barUp false, it subscribed', F.barUp() === false && typeof motionFn === 'function');
  check('span() on first use: stands where it rests (0)', JSON.stringify(F.span()) === JSON.stringify({ lo: 0, hi: 0, to: 0 }));
  up = true; motionFn({ up: true, ms: 560 });
  check('the bar comes up: told to lift 62 on the spring over 336', JSON.stringify(sent.pop()) === JSON.stringify({ px: 62, kind: 'up', ms: 336 }) && F.barUp() === true);
  check('... the span covers the whole way while it glides', JSON.stringify(F.span()) === JSON.stringify({ lo: 0, hi: 62, to: 62 }) && F.gliding());
  await wait(336 + 60 + 30);
  check('... settled after 336 + 60: span narrowed, settled() called once', JSON.stringify(F.span()) === JSON.stringify({ lo: 62, hi: 62, to: 62 }) && settles === 1 && !F.gliding(), { span: F.span(), settles });
  up = false; motionFn({ up: false, ms: 320 });
  check('the bar goes: down to 0 on the exit over 300', JSON.stringify(sent.pop()) === JSON.stringify({ px: 0, kind: 'down', ms: 300 }));
  await wait(60);
  // rapid reversal: up again mid-way down
  up = true; motionFn({ up: true, ms: 560 });
  check('a reversal half-way: aimed back up, the span still covers 0..62', JSON.stringify(sent.pop()) === JSON.stringify({ px: 62, kind: 'up', ms: 336 }) && F.span().lo === 0 && F.span().hi === 62);
  await wait(200);
  check('... not narrowed before the LAST glide is over (the down\'s timer was replaced)', settles === 1 && F.span().lo === 0, { settles, span: F.span() });
  await wait(336 - 200 + 60 + 30);
  check('... narrowed after it', settles === 2 && F.span().lo === 62, { settles, span: F.span() });
  // nothing on screen: no glide, it just stands there
  shown = false; up = false; motionFn({ up: false, ms: 320 });
  check('nothing on screen while the bar goes: stands at 0 at once (ms 0), no settle timer', JSON.stringify(sent.pop()) === JSON.stringify({ px: 0, kind: 'down', ms: 0 }) && !F.gliding() && F.span().lo === 0 && F.span().hi === 0);
  // it comes on screen while the bar is still going: catches up from the bar's top
  shown = true;
  const n0 = sent.length;
  const caught = F.catchUp(false);
  const two = sent.slice(n0);
  check('came on screen mid-exit: starts at 62 (ms 0), then down over what is left (< 300)', caught === true && two.length === 2 && two[0].px === 62 && two[0].ms === 0 && two[1].px === 0 && two[1].kind === 'down' && two[1].ms > 200 && two[1].ms <= 300, two);
  check('... the span covers 0..62 for it', F.span().lo === 0 && F.span().hi === 62);
  check('... a second catchUp while it glides: no', F.catchUp(false) === false);
  await wait(360);
  check('... catchUp after the exit is over: no (nothing to catch)', F.catchUp(false) === false);
  check('catchUp when something was already on screen: no (it glided with the bar)', (() => { motionFn({ up: false, ms: 320 }); return F.catchUp(true) === false; })());
  await wait(360);
  // no shape: the page's lift stays 0 (the window goes to the target itself)
  flat = true; up = true; motionFn({ up: true, ms: 560 });
  check('flat (no shape): the page is told px 0, no travel (the window is moved by its owner)', JSON.stringify(sent.pop()) === JSON.stringify({ px: 0, kind: 'up', ms: 0 }) && !F.gliding());
  flat = false;
  // stand(): a page that just loaded is told where it stands, no travel
  check('stand(): the span\'s target, ms 0', F.stand() === 62 && JSON.stringify(sent.pop()) === JSON.stringify({ px: 62, kind: 'up', ms: 0 }));
  F.reset();
  check('reset(): no span, no glide; next span() stands at the target for the bar\'s state', JSON.stringify(F.span()) === JSON.stringify({ lo: 62, hi: 62, to: 62 }));
  // retarget: a pop-up moves the target (not the bar): GLIDE_POP_MS
  const G = BF.createFollower({ bar: null, target: () => 40, shown: () => true, send: (p) => sent.push(p) });
  check('no bar hook: counts as up (the old place)', G.barUp() === true);
  G.span();
  G.reset(); G.aim(0, 'down', 0);
  G.retarget();
  check('retarget with no kind: a pop-up\'s move, up over GLIDE_POP_MS', JSON.stringify(sent.pop()) === JSON.stringify({ px: 40, kind: 'up', ms: BF.GLIDE_POP_MS }));
  check('... aimed at the same place again: nothing sent (false)', G.retarget() === false);
  G.stop();
  F.stop();
  check('stop(): unhooked from the bar, a late motion does nothing', unhooked === 1 && motionFn === null);
  const before = sent.length;
  F.aim(10, 'up', 100);
  check('... and a stopped follower sends nothing', sent.length === before);

  console.log(`BAR FOLLOW TEST: ${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log('  FAIL ' + f);
  process.exit(failures.length ? 1 : 0);
})();
