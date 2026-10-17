'use strict';
/*
 * _toasts-core.test.js - which toast gets a banner, what it says, when Mantle stays quiet, where a click
 * goes (lib/features/_toasts-core.js). Pure node.
 *   node lib/features/_toasts-core.test.js   -> "TOASTS CORE TEST: n passed, m failed"
 */
const C = require('./_toasts-core');

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(name + (detail !== undefined ? ' -- ' + JSON.stringify(detail).slice(0, 300) : ''));
}
const NOW = 1760500000000;
const t = (id, extra) => Object.assign({ id, aumid: 'com.owensilva.helm', app: 'Helm', title: `T${id}`, body: 'b', timeMs: NOW - 1000 }, extra || {});

// ---- the picker
{
  const p = C.createPicker();
  check('the first list is only the baseline', p.next({ ok: true, toasts: [t(1), t(2)] }, NOW).length === 0);
  const n = p.next({ ok: true, toasts: [t(3), t(1), t(2)] }, NOW);
  check('a new id is new', n.length === 1 && n[0].id === 3, n);
  check('the same list again: nothing', p.next({ ok: true, toasts: [t(3), t(1), t(2)] }, NOW).length === 0);
  check('a failed read changes nothing', p.next({ ok: false, toasts: [] }, NOW).length === 0);
  const after = p.next({ ok: true, toasts: [t(3), t(1), t(2)] }, NOW);
  check('no burst after a failed read', after.length === 0, after);
  check('a removed toast that comes back is not new... unless it was gone from a good read',
    p.next({ ok: true, toasts: [t(3)] }, NOW).length === 0 && p.next({ ok: true, toasts: [t(3), t(1)] }, NOW).length === 1);
  const old = p.next({ ok: true, toasts: [t(3), t(1), t(9, { timeMs: NOW - C.FRESH_MS - 5000 })] }, NOW);
  check('a toast older than FRESH_MS is never bannered', old.length === 0, old);
  const notime = p.next({ ok: true, toasts: [t(3), t(1), t(10, { timeMs: 0 })] }, NOW);
  check('a toast with no time is bannered', notime.length === 1 && notime[0].id === 10);
  p.reset();
  check('after reset the next list is a baseline again', p.next({ ok: true, toasts: [t(3), t(1), t(11)] }, NOW).length === 0);
}

// ---- the banner
{
  const b = C.bannerOf({ id: 5, aumid: 'x', app: '  Helm  ', icon: 'data:image/png;base64,AA', logo: 'javascript:alert(1)', title: 'Done   in 14s',
    body: 'line one\nline two', hero: 'data:image/png;base64,BB', scenario: 'reminder', opens: 'protocol' }, NOW);
  check('banner: app trimmed', b.app === 'Helm');
  check('banner: text collapsed to one line of spaces', b.title === 'Done in 14s' && b.body === 'line one line two', b);
  check('banner: a non-picture url is dropped', b.logo === null);
  check('banner: hero stands in for image', b.image === 'data:image/png;base64,BB');
  check('banner: reminder is sticky', b.sticky === true);
  check('banner: protocol kept', b.opens === 'protocol');
  check('banner: no app name -> "An app"', C.bannerOf({ id: 1 }, NOW).app === 'An app');
  check('banner: incomingCall sticky, plain not', C.bannerOf({ id: 1, scenario: 'incomingCall' }).sticky && !C.bannerOf({ id: 1 }).sticky);
}

// ---- quiet
check('quiet: DND priority', C.quietWhy({ ok: true, dnd: 1, quns: 5 }) === 'Do not disturb is on');
check('quiet: DND alarms', /alarms/.test(C.quietWhy({ ok: true, dnd: 2, quns: 5 })));
check('quiet: a full-screen game', /game/.test(C.quietWhy({ ok: true, dnd: 0, quns: 3 })));
check('quiet: the lock screen', /locked/.test(C.quietWhy({ ok: true, dnd: 0, quns: 1 })));
check('quiet: accepts = not quiet', C.quietWhy({ ok: true, dnd: 0, quns: 5 }) === null);
check('quiet: unknown reads are not quiet', C.quietWhy({ ok: true, dnd: null, quns: null }) === null && C.quietWhy(null) === null);

// ---- click
check('click: a link toast opens its link', C.clickPlan({ opens: 'protocol' }, { hwnd: '9' }).act === 'link');
check('click: an app with a window -> that window', C.clickPlan({ opens: 'app' }, { hwnd: 123 }).act === 'window' && C.clickPlan({ opens: 'app' }, { hwnd: 123 }).hwnd === '123');
check('click: no window -> the list', C.clickPlan({ opens: 'app' }, null).act === 'list' && C.clickPlan({ opens: 'none' }, null).act === 'list');

// ---- where (bottom right, lane mantle-toasts3): a column at the right of the work area, down to the corner
const WORK = { x: 0, y: 32, width: 1536, height: 832 };   // 1920x1080 at 1.25x under a 32 DIP top bar
const S0 = C.bannerSpot({ work: WORK, bar: null, others: [], w: 392, top: 8 });
check('where: no bar = bottom right of the work area, 392 wide, from 8 under its top to its bottom',
  S0.x === 1536 - 392 && S0.y === 40 && S0.height === 864 - 40 && S0.width === 392 && !S0.hide && S0.under.length === 0, S0);
// the pill at rest: 1120 wide, centred, 48 + 14 air, its top 62 above the screen bottom
const PILL = { x: 208, y: 802, width: 1120, height: 62 };
const S1 = C.bannerSpot({ work: WORK, bar: PILL, others: [], w: 392, top: 8 });
check('where: a pill that reaches the corner column lifts the banners above its RESTING top (hidden or not)', S1.y + S1.height === 802 && S1.under.join() === 'the bar', S1);
const WIDE = { x: 0, y: 32, width: 2048, height: 1120 };
const S2 = C.bannerSpot({ work: WIDE, bar: { x: 464, y: 1090, width: 1120, height: 62 }, others: [], w: 392, top: 8 });
check('where: a pill that does not reach the corner (wide screen) leaves them at the screen\'s corner', S2.y + S2.height === 1152 && S2.under.length === 0, S2);
const POP = { x: 208, y: 802 - 420, width: 1120, height: 62 + 420 };   // the bell's panel open: the shape grows up
const S3 = C.bannerSpot({ work: WORK, bar: POP, others: [], w: 392, top: 8 });
check('where: an open bar pop-up there lifts them above the pop-up', S3.y + S3.height === 382 && !S3.hide, S3);
const CARD = { key: 'the screenshot card', x: 1536 - 312, y: 802 - 122, width: 312, height: 122 };   // cardSpot: above the bar
const S4 = C.bannerSpot({ work: WORK, bar: PILL, others: [CARD], w: 392, top: 8 });
check('where: the screenshot card up = above the card, at its real bounds (bar first, then the card)', S4.y + S4.height === 680 && S4.under.join() === 'the bar,the screenshot card', S4);
const S5 = C.bannerSpot({ work: WORK, bar: null, others: [Object.assign({}, CARD, { y: 864 - 98, height: 98 })], w: 392, top: 8 });
check('where: ... and a shorter card lifts them less (no hard-coded height)', S5.y + S5.height === 766, S5);
const S6 = C.bannerSpot({ work: WORK, bar: { x: 208, y: 802 - 640, width: 1120, height: 702 }, others: [], w: 392, top: 8 });
check('where: less than MIN_ROOM left above a tall pop-up = held back, with the reason', S6.hide === true && /DIP left above the bar/.test(S6.why), S6);
const S7 = C.bannerSpot({ work: WORK, bar: { x: 208, y: 32, width: 1120, height: 62 }, others: [], w: 392, top: 8 });
check('where: a top-edge bar is not under the corner', S7.y + S7.height === 864 && !S7.hide, S7);
const S8 = C.bannerSpot({ work: WORK, bar: null, others: [{ key: 'left', x: 0, y: 700, width: 300, height: 164 }], w: 392, top: 8 });
check('where: something in another column does not move them', S8.y + S8.height === 864, S8);

{
// ---- IN THE CORNER, GLIDING WITH THE BAR (lane mantle-corner, 2026-10-16)
// Owen's laptop: 1920x1080 at 125% = 1536x864 DIP, the Windows taskbar on auto-hide (the work area is the screen)
const LAPTOP = { x: 0, y: 0, width: 1536, height: 864 };
const BAR_REST = { x: 208, y: 802, width: 1120, height: 62 };   // the bar's resting window: pill + its 14 DIP of air
const H0 = C.cornerSpots({ work: LAPTOP, bar: BAR_REST, others: [], w: 392, top: 8, barUp: false });
check('corner: bar hidden = the stack in the corner itself (the column ends at the screen bottom, 864)', H0.low.y + H0.low.height === 864 && H0.lift === 0 && !H0.hide, H0);
check('corner: ...and how far the bar would lift it is known up front (864 - 802 = 62)', H0.reach === 62, H0.reach);
const U0 = C.cornerSpots({ work: LAPTOP, bar: BAR_REST, others: [], w: 392, top: 8, barUp: true });
check('corner: bar up = lifted 62, resting exactly where the old spot was (above the bar\'s top)', U0.lift === 62 && U0.low.y + U0.low.height - U0.lift === 802 && U0.high.y + U0.high.height === 802, U0);
check('corner: the WINDOW spot is the same up or down (the bar never moves the window)', JSON.stringify(U0.low) === JSON.stringify(H0.low));
const WIDE = C.cornerSpots({ work: { x: 0, y: 0, width: 3440, height: 1440 }, bar: { x: 1160, y: 1378, width: 1120, height: 62 }, others: [], w: 392, top: 8, barUp: true });
check('corner: a pill that does not reach the corner (ultrawide): no lift even with the bar up', WIDE.lift === 0 && WIDE.reach === 0, WIDE);
const POP = C.cornerSpots({ work: LAPTOP, bar: { x: 208, y: 802 - 300, width: 1120, height: 362 }, others: [], w: 392, top: 8, barUp: true });
check('corner: an open bar pop-up there lifts it above the pop-up (864 - 502 = 362)', POP.lift === 362 && !POP.hide, POP);
const TALL = C.cornerSpots({ work: LAPTOP, bar: { x: 208, y: 802 - 700, width: 1120, height: 762 }, others: [], w: 392, top: 8, barUp: true });
check('corner: a pop-up leaving too little room holds them back only while the bar is up', TALL.hide && /the bar/.test(TALL.why || '')
  && !C.cornerSpots({ work: LAPTOP, bar: TALL.high && { x: 208, y: 102, width: 1120, height: 762 }, others: [], w: 392, top: 8, barUp: false }).hide, TALL);
const CARD = C.cornerSpots({ work: LAPTOP, bar: BAR_REST, others: [{ key: 'the screenshot card', x: 1236, y: 864 - 110, width: 300, height: 110 }], w: 392, top: 8, barUp: true });
check('corner: the screenshot card (taller than the bar) holds the window up and the bar adds no lift', CARD.low.y + CARD.low.height === 754 && CARD.lift === 0, CARD);
const SHORT = C.cornerSpots({ work: LAPTOP, bar: BAR_REST, others: [{ key: 'a low card', x: 1236, y: 864 - 30, width: 300, height: 30 }], w: 392, top: 8, barUp: true });
check('corner: a card lower than the bar: the window sits above the card, the bar lifts the rest of the way', SHORT.low.y + SHORT.low.height === 834 && SHORT.lift === 32, SHORT);
// a second monitor up and to the left (negative DIP), its own bar: the math is the same in its own coordinates
const MON2 = { x: -1920, y: -312, width: 1920, height: 1080 };
const M2 = C.cornerSpots({ work: MON2, bar: { x: -1920 + 800, y: -312 + 1018, width: 1120, height: 62 }, others: [], w: 392, top: 8, barUp: true });
check('corner: a monitor at negative coordinates: column at its right edge, bottom at its own bottom, lifted by its own bar', M2.low.x === -392 && M2.low.y + M2.low.height === 768 && M2.lift === 62, M2);
// fractional DIP (a 125% bar rect read back from physical pixels): the lift is whole pixels
const F = C.cornerSpots({ work: LAPTOP, bar: { x: 208.4, y: 801.6, width: 1120, height: 62.4 }, others: [], w: 392, top: 8, barUp: true });
check('corner: 125% fractions round to a whole-pixel lift', Number.isInteger(F.lift) && F.lift === 62, F.lift);
// the shape during a glide
const full = 856, h = 120;
let sp = C.spanSettle({ to: 0 });
check('shape: resting in the corner = the stack at the bottom', JSON.stringify(C.rectFor(sp, h, full, 392)) === JSON.stringify({ x: 0, y: full - h, width: 392, height: h }), C.rectFor(sp, h, full, 392));
sp = C.spanTo(sp, 62);
check('shape: gliding up = both places and everything between', JSON.stringify(C.rectFor(sp, h, full, 392)) === JSON.stringify({ x: 0, y: full - h - 62, width: 392, height: h + 62 }), C.rectFor(sp, h, full, 392));
sp = C.spanTo(sp, 0); sp = C.spanTo(sp, 62);
check('shape: rapid toggles keep the whole span, aimed at the last', sp.lo === 0 && sp.hi === 62 && sp.to === 62, sp);
sp = C.spanTo(C.spanSettle({ to: 62 }), 364);
check('shape: a pop-up lifting it further while up spans 62..364', sp.lo === 62 && sp.hi === 364, sp);
sp = C.spanSettle(sp);
check('shape: settled = the stack where it rests', JSON.stringify(C.rectFor(sp, h, full, 392)) === JSON.stringify({ x: 0, y: full - h - 364, width: 392, height: h }), C.rectFor(sp, h, full, 392));
check('shape: never above the window top', C.rectFor({ lo: 0, hi: 2000, to: 2000 }, h, full, 392).y === 0);

}

console.log(`TOASTS CORE TEST: ${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log('  FAIL ' + f);
process.exit(failures.length ? 1 : 0);
