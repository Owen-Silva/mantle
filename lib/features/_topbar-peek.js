'use strict';
/*
 * _topbar-peek.js - PEEK at a top bar that is hidden by hand (lane tbpeek, 2026-09-27).
 *
 * The user: "make it so that i can bring the topbar back after i manually hide it by putting my mouse to
 * the top of the screen". It works like the bottom bar's edge reveal (main.js hoverTick): rest the
 * cursor on the top edge and the bar comes out; leave it and the bar goes again. But it is a PEEK:
 *   - it only exists while the bar is HIDDEN BY HAND (Win+Alt+T, "Hide top bar", quick settings);
 *   - the bar shows as an OVERLAY: the app-bar strip stays let go, so no maximised window re-lays;
 *   - the manual setting never changes. Win+Alt+T / Show top bar still bring it back for good.
 *
 * WHY A DWELL. With the bar hidden, a maximised browser's tabs and every title bar reach the top
 * edge, and the user flicks up there to click them. A bar that popped on contact would land on the tab
 * he was about to click. So the cursor has to REST on the edge for PEEK_DWELL_MS, and a button
 * pressed there (a tab click, a window dragged up to snap / maximise) disarms the peek until the
 * cursor has left the edge.
 *
 * NEVER A PEEK while a known game runs, the top bar rests or is switched off, the lock screen or a
 * full-screen window (the sidecar's verdict: YouTube full screen, a game) is in front, or a mouse
 * button is held. The buttons are READ with GetAsyncKeyState (koffi, in this process; nothing is
 * ever injected). A reader that cannot read them refuses every peek and says why: a peek landing
 * mid-drag would fight Windows' own snap.
 *
 * This file is the pure part (step) plus the default button reader; lib/features/topbar.js owns the
 * poll, the window and the log. lib/features/topbar-peek.test.js drives step() with fake time.
 */

/* The top 2 DIP of the bar's display: the row Windows parks the cursor on when it is flung up, plus
 * one for a scale factor that rounds (main.js REVEAL_BAND_DIP explains the rounding). No edge clip
 * applies at the top (that one is 2 px short of the BOTTOM edge only), so 2 is reachable. */
const PEEK_BAND_DIP = 2;
/* 500 ms: longer than a flick up to a tab (well under 300 ms from arrival to click) and short enough
 * to read as "I pointed at it and it came". Measured from the first poll that sees the cursor there,
 * so the real wait is 500-600 ms. */
const PEEK_DWELL_MS = 500;
/* 600 ms outside the bar before it goes: the bottom bar's 180 ms is for a bar the user summoned on
 * purpose and leaves on purpose; a peek is often a glance at the clock or the stats followed by a
 * drift of the cursor, and a bar that vanished under a slightly-missed menu title would be worse. */
const PEEK_GRACE_MS = 600;
/* One cursor read (GetCursorPos inside Electron, no sidecar round trip) every 100 ms, ONLY while the
 * bar is hidden by hand; the buttons are read only while the cursor is on the edge. */
const PEEK_POLL_MS = 100;

// VK_LBUTTON, VK_RBUTTON, VK_MBUTTON, VK_XBUTTON1, VK_XBUTTON2. All five: GetAsyncKeyState reads the
// PHYSICAL buttons, so a left-handed (swapped) mouse is covered by reading both of the main ones.
const VK_MOUSE = [0x01, 0x02, 0x04, 0x05, 0x06];

const inRect = (p, r) => !!p && !!r && p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height;

/** Pure: is the point on the top edge of the display b (DIP), within its width? */
function inBand(pt, b, band) {
  return !!pt && !!b && pt.x >= b.x && pt.x < b.x + b.width && pt.y >= b.y && pt.y < b.y + (band || PEEK_BAND_DIP);
}

/**
 * Pure: the reason the bar must not peek right now (the buttons aside: step() reads those only on
 * the edge), or null. g = {hidden, enabled, stopped, run, lock, game, fullscreen}; run / lock / game
 * / fullscreen are names (truthy) or null.
 */
function blocker(g) {
  if (!g || !g.hidden) return 'the top bar is not hidden by hand';
  if (g.stopped) return 'the top bar is stopped (Mantle is resting while a game runs, or putting Windows back)';
  if (g.enabled === false) return 'the top bar is switched off in the tray';
  if (g.run) return `${g.run} is running (a known game)`;
  if (g.lock) return `${g.lock} is in front (the lock or sign-in screen)`;
  if (g.game) return `a full-screen game is in front (${g.game})`;
  if (g.fullscreen) return `${g.fullscreen} is full screen`;
  return null;
}

function initial() { return { phase: 'idle', since: null, leftAt: null, why: null }; }
/** The state a new watch starts in: disarmed, so hiding the bar (Win+Alt+T) with the cursor resting
 * on the edge does not peek it straight back; the first poll off the edge makes it idle. */
function startState() { return Object.assign(initial(), { phase: 'disarmed', why: 'the bar was just hidden (or Mantle started) with the cursor on the edge; it has to leave the edge first' }); }

/**
 * Pure: one poll. st = the last state (initial() to start); i = {
 *   now, pt: {x, y} | null, cursorWhy (why pt is null), bounds: the bar's display (DIP),
 *   bar: the bar's rect with any open menu (DIP), menuOpen, guard: blocker(...),
 *   claimed: the point is in an active hot corner (it counts as OFF the edge while not shown),
 *   buttons: () => {ok, held, pressed, reason}   (called ONLY while the cursor is on the edge)
 * } -> { st, act: 'show' | 'hide' | null, why, blocked }.
 * Phases: idle -> dwell (on the edge, nothing against it) -> shown; disarmed = a button went down on
 * the edge, cleared only by leaving it. `pressed` (GetAsyncKeyState's "pressed since the last read")
 * is honoured during the dwell only: on the first read it can be a click from anywhere, long ago.
 */
function step(st, i) {
  const s = Object.assign(initial(), st || {});
  const out = (act, why, blocked) => ({ st: s, act: act || null, why: why || null, blocked: blocked || null });
  const reset = (phase, why) => { s.phase = phase || 'idle'; s.since = null; s.leftAt = null; s.why = why || null; };

  if (s.phase === 'shown') {
    if (i.guard) { reset(); return out('hide', i.guard); }
    if (!i.pt) { reset(); return out('hide', `the cursor could not be read (${i.cursorWhy || 'no reason'})`); }
    // over the bar, over an open menu of it, or still on the edge (the bar covers it): the user is using it
    if (i.menuOpen || inRect(i.pt, i.bar) || inBand(i.pt, i.bounds)) { s.leftAt = null; return out(); }
    if (s.leftAt === null) { s.leftAt = i.now; return out(); }
    const away = i.now - s.leftAt;
    if (away >= PEEK_GRACE_MS) {
      reset();   // idle: coming back to the edge needs a fresh dwell
      return out('hide', `the cursor left the bar ${away} ms ago`);
    }
    return out();
  }

  if (!i.pt) { reset(); return out(null, null, `the cursor could not be read (${i.cursorWhy || 'no reason'})`); }
  // i.claimed: the point is in an ACTIVE hot corner's square (lib/features/_corners.js claims), which
  // is the corner's and not the edge's, so a corner and a peek never both fire (lane corners)
  if (!inBand(i.pt, i.bounds) || i.claimed) { reset(); return out(); }
  if (s.phase === 'disarmed') return out(null, null, s.why);
  if (i.guard) { reset(); return out(null, null, i.guard); }
  let b;
  try { b = typeof i.buttons === 'function' ? i.buttons() : { ok: false, reason: 'there is no mouse button reader' }; } catch (e) { b = { ok: false, reason: `the reader threw: ${e.message}` }; }
  if (!b || !b.ok) {
    reset();
    return out(null, null, `the mouse buttons cannot be read (${(b && b.reason) || 'no reason'}), so a peek could land in the middle of a drag`);
  }
  if (b.held || (s.phase === 'dwell' && b.pressed)) {
    reset('disarmed', 'a mouse button went down on the top edge (a tab click, or a window dragged up to snap or maximise); the cursor has to leave the edge first');
    return out(null, null, s.why);
  }
  if (s.phase !== 'dwell') { s.phase = 'dwell'; s.since = i.now; return out(); }
  const rested = i.now - s.since;
  if (rested >= PEEK_DWELL_MS) {
    s.phase = 'shown'; s.since = i.now; s.leftAt = null;
    return out('show', `the cursor rested on the top edge for ${rested} ms`);
  }
  return out();
}

/** The real button reader: GetAsyncKeyState through koffi (bound on first use; READ only). */
function nativeButtons() {
  let fn = null;
  let why = null;
  return function buttons() {
    if (!fn && !why) {
      try {
        const koffi = require('koffi');
        fn = koffi.load('user32.dll').func('short __stdcall GetAsyncKeyState(int vKey)');
      } catch (e) {
        why = `koffi could not bind GetAsyncKeyState (${String(e && e.message).split('\n')[0]})`;
      }
    }
    if (!fn) return { ok: false, reason: why };
    try {
      let held = false;
      let pressed = false;
      for (const vk of VK_MOUSE) {
        const r = fn(vk);
        if (r & 0x8000) held = true;
        if (r & 1) pressed = true;
      }
      return { ok: true, held, pressed };
    } catch (e) {
      return { ok: false, reason: `GetAsyncKeyState threw: ${e.message}` };
    }
  };
}

module.exports = { PEEK_BAND_DIP, PEEK_DWELL_MS, PEEK_GRACE_MS, PEEK_POLL_MS, VK_MOUSE, inBand, inRect, blocker, initial, startState, step, nativeButtons };
