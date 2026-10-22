'use strict';
/*
 * lib/features/_toasts-core.js -- WHICH TOAST GETS A MANTLE BANNER, AND WHAT THE BANNER SAYS (lane
 * mantle-toasts, 2026-10-15). Pure, so _toasts-core.test.js drives it with plain objects.
 *
 * NEW = an id that was not in the list the last time main read it. The FIRST list after the feature
 * starts (Mantle starting, waking after a game, the switch turned on) is only remembered: what is
 * already in the centre was announced before, and a restart must not replay it. A toast older than
 * FRESH_MS (by its own time) is never bannered either: the listener can re-list an old toast after a
 * hiccup, and a banner for something from an hour ago is noise.
 *
 * QUIET = Windows itself would not pop anything up now, so neither does Mantle (the toast is in the
 * list, as Windows' would be in its centre):
 *   Do not disturb (its ACTIVE profile, automatic rules included: priority only or alarms only), and
 *   SHQueryUserNotificationState: anything but QUNS_ACCEPTS_NOTIFICATIONS (5) -- a full-screen app or
 *   game, presentation mode, the lock screen or screen saver, Windows' quiet first hour.
 * A read that failed is not quiet (the reason is logged): a lost banner is worse than one shown.
 */

const FRESH_MS = 120000;
const STICKY = /^(alarm|reminder|incomingCall|urgent)$/i;   // Windows keeps these up until answered
const QUNS = {
  1: 'the screen is locked or the screen saver is on',
  2: 'a full-screen app is in front',
  3: 'a full-screen game is running',
  4: 'presentation mode is on',
  6: 'Windows is in its quiet first hour after setup',
  7: 'a full-screen app is in front',
};

function createPicker() {
  let known = null;   // ids in the last list; null = nothing read yet (the next list is the baseline)
  return {
    /** -> the toasts in `payload` that are new since the last call (none on the first). */
    next(payload, nowMs) {
      const toasts = payload && Array.isArray(payload.toasts) ? payload.toasts : null;
      if (!toasts || payload.ok === false) return [];   // a failed read changes nothing: no burst after it
      const ids = new Set(toasts.map((t) => t && t.id).filter((id) => id !== undefined && id !== null));
      const first = known === null;
      const prev = known;
      known = ids;
      if (first) return [];
      const now = Number(nowMs) || Date.now();
      return toasts.filter((t) => t && !prev.has(t.id) && !(Number(t.timeMs) > 0 && now - Number(t.timeMs) > FRESH_MS));
    },
    ids() { return known ? Array.from(known) : []; },
    reset() { known = null; },
  };
}

/** The banner the page draws: only what it needs, and only strings it can show as text. */
function bannerOf(t, nowMs) {
  const s = (v, max) => (typeof v === 'string' && v.trim() ? v.replace(/\s+/g, ' ').trim().slice(0, max) : null);
  const pic = (v) => (typeof v === 'string' && /^(data:image\/|file:)/i.test(v) ? v : null);
  return {
    id: t.id,
    aumid: s(t.aumid, 512),
    app: s(t.app, 120) || 'An app',
    icon: pic(t.icon),
    // the sender's own picture (a person, a channel) stands in front of the app's icon, as in Windows
    logo: pic(t.logo),
    logoCircle: !!t.logoCircle,
    title: s(t.title, 300),
    body: s(t.body, 1200),
    attribution: s(t.attribution, 200),
    image: pic(t.image) || pic(t.hero),
    sticky: STICKY.test(String(t.scenario || '')),
    opens: t.opens === 'protocol' ? 'protocol' : t.opens === 'none' ? 'none' : 'app',
    at: Number(nowMs) || Date.now(),
  };
}

/** Why no banner may show now, in words, or null. q = toasts.quiet's answer. */
function quietWhy(q) {
  if (!q || q.ok === false) return null;
  if (q.dnd === 1) return 'Do not disturb is on';
  if (q.dnd === 2) return 'Do not disturb is on (alarms only)';
  if (typeof q.quns === 'number' && q.quns !== 5 && QUNS[q.quns]) return QUNS[q.quns];
  return null;
}

/**
 * Where a click goes, in the order of what is honest:
 *   a link toast   -> Windows opens its link on a click, and so does Mantle (notifs.open, the same as
 *                     the list): the one case where Mantle does exactly what Windows does
 *   an app with a window -> that window comes to the front (the toast's own message cannot be opened:
 *                     Windows gives no other app a way to activate it)
 *   anything else  -> Mantle's notification list opens, with the toast in it
 */
function clickPlan(b, target) {
  if (b && b.opens === 'protocol') return { act: 'link' };
  if (target && target.hwnd) return { act: 'window', hwnd: String(target.hwnd) };
  return { act: 'list' };
}

/*
 * WHERE THE BANNERS GO (lane mantle-toasts3, 2026-10-15). The user: "i want it to still show up in the
 * bottom right". The window is a COLUMN at the right edge of the work area of the bar's monitor: from
 * `top` DIP under the work area's top down to the corner, and the page stacks the banners at its bottom
 * (newest nearest the corner, older ones above). Main shapes the window to the stack, so the rest of the
 * column is not there (nothing drawn, clicks pass through).
 *
 * The column's bottom is the work area's bottom, raised above anything in the corner that overlaps it:
 *   - the bar's RESTING shape (ctx.host.barRect: its pill plus any open pop-up). The resting shape, not
 *     where the pill is now, so a hidden bar sliding in never moves a banner, and a banner never covers
 *     the bell or the clock when it does. A pill that does not reach the corner (a wide screen) leaves
 *     the banners at the corner itself; an open pop-up there lifts them above it;
 *   - the screenshot card (lib/corner.js), at its real bounds, whatever size it is now.
 * Only a thing whose middle is in the lower half of the work area counts (a top-edge bar is not under
 * the corner; a bottom bar with a tall pop-up open is).
 * Less than MIN_ROOM left above them (a tall pop-up on a short screen): `hide`, with the reason, and the
 * banners come back when the pop-up closes (they are in the list either way).
 *   spot = { x, y, width, height, under: [names that lifted it], hide, why }
 */
const MIN_ROOM = 150;
function bannerSpot(o) {
  const work = o.work, w = o.w, top = o.top || 0;
  const right = work.x + work.width, left = right - w;
  const half = work.y + work.height / 2;
  const things = [];
  if (o.bar) things.push(Object.assign({ key: 'the bar' }, o.bar));
  (o.others || []).forEach((r) => { if (r) things.push(r); });
  let bottom = work.y + work.height;
  const under = [];
  for (let moved = true; moved;) {
    moved = false;
    for (const r of things) {
      if (!(r.width > 0 && r.height > 0) || under.indexOf(r.key) >= 0) continue;
      const across = r.x < right && r.x + r.width > left;
      if (across && r.y + r.height / 2 >= half && r.y < bottom && r.y + r.height > bottom - MIN_ROOM) {
        bottom = r.y; under.push(r.key || 'something'); moved = true;
      }
    }
  }
  const y = Math.round(work.y + top);
  const height = Math.round(bottom - y);
  // full: the column's height with nothing in the corner. The window keeps it and MOVES up when something
  // lifts the banners (its top may go above the work area: only the shape at its bottom is there).
  const full = Math.max(1, Math.round(work.y + work.height - y));
  const spot = { x: Math.round(left), y, width: w, height: Math.max(1, height), full, under, hide: false, why: null };
  if (height < MIN_ROOM) { spot.hide = true; spot.why = `only ${Math.max(0, height)} DIP left above ${under.join(' and ') || 'the corner'}`; }
  return spot;
}

/*
 * IN THE CORNER, GLIDING WITH THE BAR (lane mantle-corner, 2026-10-16). The user, of a banner sitting a
 * bar-height up from the corner while the bar was hidden: "this and anything else that comes up here
 * needs to go in the corner not up like this ... just have them smoothly move up if the taskbar comes
 * up". So the bar no longer moves the WINDOW: the column is placed as if the bar were not there (`low`,
 * the screenshot card and the rest of lib/corner.js still lift it, as before), and the page slides the
 * stack up by `lift` DIP (a transform, the bar's own spring) while the bar is up, and back down to the
 * corner with the bar's own exit when it goes. `reach` is how far the bar lifts the stack when it is
 * up (0 when the pill does not reach the corner, or a pop-up / the card already holds it higher).
 *   o = { work, bar, pill (ctx.host.bar.pill(): the pill at rest), others, w, top, barUp }
 *   -> { low (the window's spot), high (where the stack rests with the bar up), reach, rest, lift, hide, why, under }
 * hide/why are the CURRENT target's: a tall pop-up leaving too little room holds the banners back only
 * while the bar is up; with the bar hidden there is the whole column.
 */
/*
 * THE HIDDEN PILL (lane mantle-corner4; the user's rule: no overlapping UI anywhere). Hidden, the pill sits at
 * bar.css's down pose, its top .81 of its height below where it rests, and fades in from there when the bar
 * comes; a stack resting in the corner below that top (run 3: 848 vs 841) was clear only if it started rising
 * no later than the bar. So the stack RESTS with its window's bottom on the hidden pill's top (`rest`, DIP up
 * from the corner), the same gap its own inset leaves above the resting bar. Since lane mantle-corner-follow2
 * that rule (hiddenPillTop, PILL_HIDE_DROP, restOver) lives in lib/bar-follow.js, ONE rule for every follower
 * (the banners, the screenshot card, the volume pop-up, the Clips record panel), re-exported here by the same
 * names. A follower in the corner rests `rest` up with the bar hidden (lib/corner.js opts.rest) as it stands
 * `lift` up with the bar up, so the banners stack above where IT is in both.
 *   pill = { x, y, width, height, shape: 'pill' | 'edge', edge: 'bottom' | 'top' }   (DIP, at rest)
 */
function cornerSpots(o) {
  const base = { work: o.work, others: o.others, w: o.w, top: o.top };
  // lane mantle-corner-follow: a thing in the corner that glides with the bar (lib/corner.js set opts.lift /
  // opts.rest: the screenshot card, the Clips record panel) stands `lift` higher while the bar is up and `rest`
  // higher while it is hidden, so the banners stack above where IT is, and move with it on the same clock
  const shifted = (k) => (o.others || []).map((r) => (r && r[k] > 0 ? Object.assign({}, r, { y: r.y - r[k] }) : r));
  const low = bannerSpot(Object.assign({}, base, { others: shifted('rest') }));
  const high = o.bar ? bannerSpot(Object.assign({}, base, { bar: o.bar, others: shifted('lift') })) : low;
  const reach = Math.max(0, Math.round((low.y + low.height) - (high.y + high.height)));
  // with the bar hidden: the window's bottom on the hidden pill's top, never more than the bar itself lifts
  // it (`reach` 0 = the pill does not reach the corner at all, so neither does its hidden pose)
  const rest = restOver(low, o.pill, reach);
  const up = !!o.barUp;
  const at = up ? high : low;
  return { low, high, reach, rest, lift: up ? reach : rest, hide: at.hide, why: at.why, under: at.under };
}

/*
 * The SHAPE while the stack glides (lane mantle-corner): spanTo / spanSettle / rectFor moved to
 * lib/bar-follow.js (lane mantle-corner-follow: every surface that glides with the bar shares them),
 * re-exported here by the same names.
 *   span = { lo, hi, to }   rectFor(span, h, full) -> the region, window-relative DIP
 */
const { spanTo, spanSettle, rectFor, hiddenPillTop, PILL_HIDE_DROP, restOver } = require('../bar-follow');

module.exports = { createPicker, bannerOf, quietWhy, clickPlan, bannerSpot, cornerSpots, hiddenPillTop, PILL_HIDE_DROP, spanTo, spanSettle, rectFor, MIN_ROOM, FRESH_MS, STICKY };
