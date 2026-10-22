'use strict';
/*
 * lib/bar-follow.js - WHAT GLIDES WITH THE BAR (lane mantle-corner-follow, 2026-10-17). The mechanism is lane
 * mantle-corner's (built for the notification banners, 2026-10-16), moved here whole so every surface that
 * sits where the bar's pill comes up shares ONE clock, ONE window-shape rule and ONE page transition
 * (ui/shared/bar-follow.js + .css). Users: the banners (lib/features/toasts.js), the screenshot card, the
 * volume / brightness pop-up and the Clips record panel.
 *
 * The user, of a banner sitting a bar-height up while the bar was hidden: "this and anything else that comes up
 * here needs to go in the corner not up like this ... just have them smoothly move up if the taskbar comes
 * up". And the standing rule: no overlapping UI anywhere. So a follower's WINDOW is placed as if the bar were
 * not there (low), and its page slides the surface up by `lift` DIP (a CSS transform) while the bar is up,
 * then back down when it goes. The bar never moves the window.
 *
 * THE CLOCK (lane mantle-corner3, measured in run 2: a follower on the bar's own clock dipped 12 DIP into the
 * pill a frame early). The pill's top only travels .75 x 48 + 6 % of 48 = 38.9 DIP between its poses
 * (ui/bar/bar.css), a follower 62, so on the SAME clock the follower would cross the pill's top at the end of
 * every exit. So a follower is never on the bar's clock exactly:
 *   UP:   told FIRST (main.js barMotion runs before the bar's page is told) and rises on the bar's spring
 *         (--m-spring) in UP_RATE of the bar's reveal time (560 -> 336 ms): always ahead of the pill.
 *   DOWN: told after the bar's page and takes DOWN_TRAIL_MS longer than what the bar's page really runs for
 *         its exit (max(140, min(ms, 240)), ui/bar/bar.js OUT_MAX) on the bar's accelerate (--m-accel):
 *         240 -> 300 ms, always behind it.
 *   A move that is not the bar's (a pop-up, the card, the screen): GLIDE_POP_MS on the accelerate.
 * THE SHAPE: the window is set from main, never per frame, so while a glide runs its region is the union of
 * every place the surface can be (`span` lo..hi: the lifts since it last stood still, so a reversal half-way is
 * covered too) and narrows to the target SETTLE_PAD_MS after the glide is over, never before.
 * NOTHING ON SCREEN: no glide (nothing to see); the page simply stands at the target for the next show.
 * A SURFACE THAT COMES UP WHILE THE BAR IS GOING (nothing was on screen to glide): catchUp() starts it where
 * the bar's top was and takes it down over what is left of the exit, so it never lands on the leaving pill.
 * NO SHAPE (the region would not stick): the window is the surface, so it cannot glide inside itself; the
 * page's lift stays 0 and the surface's own placement puts the window at the target (o.flat()).
 *   node lib/bar-follow.test.js
 */

const GLIDE_IN_MS = 560, GLIDE_OUT_MAX = 240, GLIDE_OUT_MIN = 140, GLIDE_POP_MS = 240, SETTLE_PAD_MS = 60;
const UP_RATE = 0.6, DOWN_TRAIL_MS = 60;

/** A follower's glide time for a bar motion of `ms` (up: the bar's reveal; down: what its page runs). */
function stackMs(up, ms) { return up ? Math.round(ms * UP_RATE) : ms + DOWN_TRAIL_MS; }

/** main's { up, ms } (barMotion) -> the follower's { up, kind, ms }. */
function motionPlan(m) {
  const up = !!(m && m.up);
  const n = Number(m && m.ms);
  const bar = up ? (n > 0 ? n : GLIDE_IN_MS) : Math.max(GLIDE_OUT_MIN, Math.min(n > 0 ? n : GLIDE_OUT_MAX, GLIDE_OUT_MAX));
  return { up, kind: up ? 'up' : 'down', ms: stackMs(up, bar) };
}

/**
 * How far a thing placed as if there were no bar (`rect`, screen DIP, its window) must rise to stand clear
 * above the bar's RESTING shape (`bar`, ctx.host.barRect(): the pill plus any open pop-up). 0 when the bar is
 * not under it: not across it, a top-edge bar (its middle in the upper half of `work`), or already clear.
 */
function reachOver(rect, bar, work) {
  if (!rect || !bar || !(bar.width > 0 && bar.height > 0) || !(rect.width > 0 && rect.height > 0)) return 0;
  const across = bar.x < rect.x + rect.width && bar.x + bar.width > rect.x;
  if (!across) return 0;
  if (work && bar.y + bar.height / 2 < work.y + work.height / 2) return 0;
  return Math.max(0, Math.round(rect.y + rect.height - bar.y));
}

/*
 * THE HIDDEN PILL: WHERE A FOLLOWER RESTS WITH THE BAR HIDDEN (lane mantle-corner4 for the banners, moved here
 * by lane mantle-corner-follow2 so every follower rests by this ONE rule). Hidden, the pill is not gone:
 * ui/bar/bar.css parks it at its down pose, translateY(.75 x --bar-h) scale(.94) from its bottom (pill shape),
 * so its top sits .75 + .06 = .81 of its height below where it rests, and it fades in from there when the bar
 * comes. A follower resting in the corner below that top (run r1: the card's bottom 853, the volume pop-up's
 * 846, the hidden pill's top 841) is clear of the pill only if it starts rising no later than the bar does, and
 * the pill's first faint frames landed on it (8 frames a run). So a follower RESTS with its window's bottom on
 * the hidden pill's top, the way it stands with its window's bottom on the resting bar's top: the same gap its
 * own margin leaves in both. A late start then has the pill's whole rise to that gap to catch up in. The edge
 * shape drops its whole height (below the screen: nothing to clear); a top-edge bar is nowhere near the bottom.
 * PILL_HIDE_DROP must match bar.css (lib/bar-follow.test.js reads it).
 *   pill = { x, y, width, height, shape: 'pill' | 'edge', edge: 'bottom' | 'top' }   (DIP, at rest; main.js
 *   barPillRest via ctx.host.bar.pill())
 */
const PILL_HIDE_DROP = Object.freeze({ pill: 0.75 + (1 - 0.94), edge: 1 });
function hiddenPillTop(pill) {
  if (!pill || pill.edge === 'top' || !(pill.height > 0) || !Number.isFinite(pill.y)) return null;
  const k = PILL_HIDE_DROP[pill.shape] !== undefined ? PILL_HIDE_DROP[pill.shape] : PILL_HIDE_DROP.pill;
  return pill.y + k * pill.height;
}
/**
 * How far UP from its low spot a follower rests with the bar HIDDEN: its window (`rect`, placed as if there were
 * no bar) with its bottom on the hidden pill's top. Never more than `reach` (what the bar itself lifts it; 0 = the
 * pill does not come under it at all, so neither does its hidden pose). 0 when it is already clear, or no pill.
 */
function restOver(rect, pill, reach) {
  const r = Math.max(0, Math.round(Number(reach) || 0));
  if (!r || !rect || !(rect.height > 0)) return 0;
  const ht = hiddenPillTop(pill);
  if (ht === null) return 0;
  return Math.max(0, Math.min(r, Math.ceil(rect.y + rect.height - ht)));
}
/** The bar's pill at rest from the host's bar hook ({ pill() }), or null (no hook, an old host, it threw). */
function pillOf(bar) {
  if (!bar || typeof bar.pill !== 'function') return null;
  try { return bar.pill() || null; } catch (_) { return null; }
}
/**
 * BOTH lifts of a follower, by the one rule: `reach` (bar up: its window's bottom on the bar's resting top,
 * reachOver) and `rest` (bar hidden: its window's bottom on the hidden pill's top, restOver). `cap` (optional)
 * bounds the reach (the room above it on the screen). target(up) = up ? reach : rest.
 */
function liftsOver(rect, bar, work, pill, cap) {
  let reach = reachOver(rect, bar, work);
  if (Number.isFinite(cap)) reach = Math.max(0, Math.min(reach, Math.round(cap)));
  return { reach, rest: restOver(rect, pill, reach) };
}

/* The SHAPE while it glides. span = { lo, hi, to } (DIP up from the low spot). */
function spanTo(span, to) {
  if (!span) return { lo: to, hi: to, to };
  return { lo: Math.min(span.lo, span.to, to), hi: Math.max(span.hi, span.to, to), to };
}
function spanSettle(span) { const to = span ? span.to : 0; return { lo: to, hi: to, to }; }
/** The window region (window-relative DIP) for a surface `h` tall at the bottom of a window `full` tall and
    `w` wide, lifted anywhere in the span. */
function rectFor(span, h, full, w) {
  const s = span || { lo: 0, hi: 0 };
  const y = Math.max(0, Math.round(full - h - s.hi));
  const bottom = Math.min(full, Math.round(full - s.lo));
  return { x: 0, y, width: w, height: Math.max(1, bottom - y) };
}

/**
 * One surface's follower (main side). o = {
 *   bar:      ctx.host.bar ({ up(), pill(), onMotion(fn) }) or null. No hook (an old host): the bar counts as up.
 *   target(up): DIP up from the low spot the surface rests at with the bar up (true) / hidden (false):
 *             liftsOver's reach / rest (the follower's pill() is the bar's, for restOver).
 *   shown():  something is on screen to glide (else it just stands at the target for the next show).
 *   flat():   (optional) it cannot glide inside its window (no shape): the page's lift stays 0.
 *   send(p):  tell the page { px, kind, ms } (ui/shared/bar-follow.js glide).
 *   settled(): (optional) the glide is over: re-place the window (the shape narrows to the span's target).
 *   moved(plan): (optional) the bar started moving; the surface re-places itself (default: retarget).
 * }
 * Every timer it sets is its own; stop() drops them and the bar hook.
 */
function createFollower(o) {
  const flat = () => !!(o.flat && o.flat());
  const hostUp = () => {
    if (!o.bar || typeof o.bar.up !== 'function') return true;
    try { return !!o.bar.up(); } catch (_) { return true; }
  };
  const F = { barUp: hostUp(), span: null, glide: null, last: null, glides: 0, settleT: null, off: null, stopped: false };
  const send = (p) => { if (!F.stopped) o.send(p); };
  function settleIn(ms) {
    clearTimeout(F.settleT);
    F.settleT = setTimeout(() => {
      F.settleT = null; F.glide = null; F.span = spanSettle(F.span);
      if (!F.stopped && o.settled) o.settled();
    }, ms + SETTLE_PAD_MS);
  }
  /** Aim at `to` DIP up. With something on screen it glides and the span covers the way; with nothing,
      it simply stands there. false = it was already there (or already on its way there). */
  function aim(to, kind, ms) {
    if (F.stopped) return false;
    to = Math.max(0, Math.round(Number(to) || 0));
    const from = F.span ? F.span.to : to;
    if (F.span && to === from) return false;
    const moving = !!(ms > 0 && !flat() && o.shown());
    F.span = moving ? spanTo(F.span, to) : spanSettle({ to });
    clearTimeout(F.settleT); F.settleT = null;
    F.glide = moving ? { kind, from, to, ms, at: Date.now() } : null;
    F.last = ms > 0 ? { kind, from, to, ms, at: Date.now() } : null;   // the motion, seen or not (catchUp)
    if (moving) { F.glides++; settleIn(ms); }
    send({ px: flat() ? 0 : to, kind, ms: moving ? ms : 0 });
    return true;
  }
  /** Aim at where it rests now (the bar's state as last told); kind/ms default to a pop-up's move. */
  function retarget(kind, ms) {
    const to = Math.max(0, Math.round(Number(o.target(F.barUp)) || 0));
    const from = F.span ? F.span.to : to;
    return aim(to, kind || (to > from ? 'up' : 'down'), kind ? ms : GLIDE_POP_MS);
  }
  /** It came on screen while the bar is still GOING and nothing was up to glide: start where the bar's top
      was and go down with it over what is left of the exit. Call it AFTER the page has the surface.
      `was` = something was already on screen. true = it caught up (the page was told). */
  function catchUp(was) {
    const g = F.last;
    if (!g || g.kind !== 'down' || flat() || F.glide || was) return false;
    const left = Math.round(g.at + g.ms - Date.now());
    if (left <= 20 || g.from <= g.to) return false;
    send({ px: g.from, kind: 'down', ms: 0 });
    send({ px: g.to, kind: 'down', ms: left });
    F.span = spanTo(spanSettle({ to: g.from }), g.to);
    F.glide = { kind: 'down', from: g.from, to: g.to, ms: left, at: Date.now(), caughtUp: true };
    F.glides++;
    settleIn(left);
    return true;
  }
  /** Tell the page where it stands, no travel (a page that just loaded); the span's target, else o.target. */
  function stand() {
    const to = F.span ? F.span.to : Math.max(0, Math.round(Number(o.target(F.barUp)) || 0));
    if (!F.span) F.span = spanSettle({ to });
    send({ px: flat() ? 0 : to, kind: 'up', ms: 0 });
    return to;
  }
  /** The span, made on first use: a fresh window stands where the surface rests. */
  function span() {
    if (!F.span) F.span = spanSettle({ to: Math.max(0, Math.round(Number(o.target(F.barUp)) || 0)) });
    return F.span;
  }
  /** A new window (or none): forget the glide; it stands where it rests next time. */
  function reset() { clearTimeout(F.settleT); F.settleT = null; F.span = null; F.glide = null; F.last = null; }
  function onBarMotion(m) {
    if (F.stopped || !m) return;
    const plan = motionPlan(m);
    F.barUp = plan.up;
    if (o.moved) o.moved(plan); else retarget(plan.kind, plan.ms);
  }
  if (o.bar && typeof o.bar.onMotion === 'function') F.off = o.bar.onMotion(onBarMotion);
  return {
    barUp: () => F.barUp,
    pill: () => pillOf(o.bar),
    span, stand, aim, retarget, catchUp, reset,
    gliding: () => !!F.glide,
    state: () => ({ barUp: F.barUp, span: F.span, glide: F.glide, last: F.last, glides: F.glides }),
    stop() {
      F.stopped = true; reset();
      if (typeof F.off === 'function') { try { F.off(); } catch (_) { /* gone */ } }
      F.off = null;
    },
  };
}

module.exports = {
  createFollower, motionPlan, stackMs, reachOver, restOver, liftsOver, hiddenPillTop, pillOf, PILL_HIDE_DROP,
  spanTo, spanSettle, rectFor, GLIDE_IN_MS, GLIDE_OUT_MAX, GLIDE_OUT_MIN, GLIDE_POP_MS, SETTLE_PAD_MS, UP_RATE, DOWN_TRAIL_MS,
};
