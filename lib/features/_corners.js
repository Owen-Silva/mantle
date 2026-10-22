'use strict';
/*
 * _corners.js - HOT CORNERS, the pure part (lane corners, 2026-09-27).
 *
 * Push the cursor into a screen corner and an action runs: macOS's hot corners, which Windows never
 * had. It also fills a hole Mantle made: Mantle hides the Windows taskbar, so its bottom-right "show
 * desktop" sliver is gone. Defaults: top-left = Task view (Mantle's Win+Tab), bottom-right = Show
 * desktop (Windows' own minimise-all / restore-all toggle), the other two off. Each corner can be
 * Off, Task view, Show desktop, Launcher (Mantle's Start), Quick settings or Lock screen, picked in
 * the quick-settings panel (ui/bar/corners.js).
 *
 * HOW IT FIRES. The cursor has to REST in a CORNER_ZONE_DIP square for CORNER_DWELL_MS; then it
 * fires ONCE, and re-arms only after the cursor has left the square. A mouse button held in the
 * corner, or pressed there during the dwell (a click on the Mantle menu, a window dragged into the
 * corner to snap), disarms it until the cursor leaves. A new watch starts DISARMED, so Mantle
 * starting (or the corner being switched on) with the cursor already parked in a corner does not
 * fire on its own.
 *
 * NEVER FIRES while Mantle rests for a game (the feature is `rest: true`, so no poll runs at all),
 * while a known game runs or is in front, while a full-screen window or the lock screen is in front
 * (fireBlocker, asked of the sidecar only at the moment of firing), or with a mouse button held.
 *
 * WHO ELSE READS THE ZONES. The top bar's peek (lib/features/_topbar-peek.js via topbar.js) and the
 * bottom bar's edge reveal (main.js hoverTick) both watch an edge that ends in two corners. An
 * ACTIVE corner takes its square from both (claims()), so a corner and a peek / a bar reveal never
 * both happen: the corner wins inside its 6x6 DIP square, the edge keeps the other ~1500 DIP. An
 * Off corner takes nothing. The live claim table is set by corners.js and cleared whenever it stops,
 * rests or is switched off, so a Mantle without corners reveals exactly as before.
 *
 * lib/features/corners.js owns the poll, the actions and the log; lib/features/corners.test.js
 * drives step() with fake time and a fake cursor.
 */

/* 6 DIP square. The cursor flung into a corner is clamped by the screen to its last pixel, so the
 * square only has to catch that pixel plus rounding. At the BOTTOM, main.js's edge clip confines the
 * cursor 2 px short of the bottom row (ClipCursor 0,0,W,H-2: the lowest row it can reach is H-3 px),
 * which is H - 3/scale DIP: 3 DIP at 100%, 2.4 at 125%, 1.5 at 200%. A band of 6 DIP holds that row
 * at every scale with 3 DIP to spare, and it still holds when the clip is off (H-1). Small enough
 * that the top bar's Mantle menu and the bottom bar's end items are still clicked normally. */
const CORNER_ZONE_DIP = 6;
/* 250 ms at rest in the square. A flick through a corner on the way somewhere else is well under
 * that; a push into the corner to use it reads as instant. Measured from the first poll that sees
 * the cursor there, so the real wait is 250-350 ms. Shorter than the top bar peek's 500 ms: the
 * peek's band is the whole top edge (the user's browser tabs live there), a corner is 6x6 DIP. */
const CORNER_DWELL_MS = 250;
/* One cursor read (GetCursorPos inside Electron, no sidecar round trip) every 100 ms, like the top
 * bar's peek; none at all while every corner is Off, the feature is off, or Mantle rests. The mouse
 * buttons are read only while the cursor is IN a corner square. */
const CORNER_POLL_MS = 100;

const CORNERS = ['tl', 'tr', 'bl', 'br'];
const CORNER_NAMES = { tl: 'top-left', tr: 'top-right', bl: 'bottom-left', br: 'bottom-right' };
const ACTIONS = ['off', 'taskview', 'desktop', 'launcher', 'qs', 'lock'];
const ACTION_NAMES = { off: 'Off', taskview: 'Task view', desktop: 'Show desktop', launcher: 'Launcher', qs: 'Quick settings', lock: 'Lock screen' };
const DEFAULTS = Object.freeze({ tl: 'taskview', tr: 'off', bl: 'off', br: 'desktop' });
// The lock and sign-in screens (lib/features/topbar.js LOCK_EXES): nothing fires over them.
const LOCK_EXES = ['lockapp.exe', 'logonui.exe'];

/** Pure: a saved table -> a complete, valid one (unknown corners dropped, unknown actions -> default). */
function normalize(saved) {
  const out = {};
  for (const c of CORNERS) {
    const a = saved && typeof saved === 'object' ? saved[c] : undefined;
    out[c] = ACTIONS.includes(a) ? a : DEFAULTS[c];
  }
  return out;
}

/** Pure: is any corner set to something? */
function anyOn(actions) { return !!actions && CORNERS.some((c) => actions[c] && actions[c] !== 'off'); }

/** Pure: which corner square of the display b (DIP) the point is in, or null. */
function cornerAt(pt, b, zone) {
  const z = zone || CORNER_ZONE_DIP;
  if (!pt || !b || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) return null;
  // <= on the far sides: at a fractional scale (175%: 1920 px = 1097.1 DIP) the last pixel can round
  // to x = width, one DIP past the display's rounded width; it is still this display's corner
  if (pt.x < b.x || pt.x > b.x + b.width || pt.y < b.y || pt.y > b.y + b.height) return null;
  const left = pt.x < b.x + z, right = pt.x >= b.x + b.width - z;
  const top = pt.y < b.y + z, bottom = pt.y >= b.y + b.height - z;
  if (top && left) return 'tl';
  if (top && right) return 'tr';
  if (bottom && left) return 'bl';
  if (bottom && right) return 'br';
  return null;
}

/* MULTI-MONITOR (quality pass 2026-09-29). Until now only the PRIMARY display had corners, so a
 * second screen had none, and a primary corner that touches another screen fired when the cursor
 * paused there on its way across. macOS's rule, kept here: a corner is hot only where the cursor
 * STOPS - on any display, but only an OUTER corner, one with no other display beyond it on either
 * side (the pixel just past it horizontally and the one just past it vertically are on no display). */
function onAny(p, displays, skip) {
  for (const d of displays) {
    if (d === skip || !d) continue;
    if (p.x >= d.x && p.x < d.x + d.width && p.y >= d.y && p.y < d.y + d.height) return true;
  }
  return false;
}
/** Pure: the OUTER corner square the point is in, on whichever display holds it, or null. */
function cornerOnScreens(pt, displays, zone) {
  if (!Array.isArray(displays) || !displays.length) return null;
  for (const b of displays) {
    const c = cornerAt(pt, b, zone);
    if (!c) continue;
    const L = b.x, R = b.x + b.width - 1, T = b.y, Bt = b.y + b.height - 1;
    const x = c[1] === 'l' ? L : R, y = c[0] === 't' ? T : Bt;
    const across = { x: c[1] === 'l' ? L - 1 : R + 1, y };
    const beyond = { x, y: c[0] === 't' ? T - 1 : Bt + 1 };
    return onAny(across, displays, b) || onAny(beyond, displays, b) ? null : c;
  }
  return null;
}
/** Pure: where the corners are read: every display when the caller has them, else one display. */
function cornerIn(pt, i) {
  return Array.isArray(i.displays) && i.displays.length ? cornerOnScreens(pt, i.displays) : cornerAt(pt, i.bounds);
}

function initial() { return { phase: 'idle', corner: null, since: null, why: null }; }
/** A new watch: disarmed until the cursor is outside every corner (a start with the cursor parked in one). */
function startState() {
  return Object.assign(initial(), { phase: 'disarmed', why: 'the corners were just switched on (or Mantle started) with the cursor in a corner; it has to leave first' });
}

/**
 * Pure: one poll. st = the last state (startState() to begin); i = {
 *   now, pt: {x, y} | null, cursorWhy (why pt is null), bounds: the display (DIP),
 *   displays: every display's bounds (DIP; optional: then only OUTER corners, on any display),
 *   actions: {tl, tr, bl, br}, guard: a reason nothing may fire right now, or null,
 *   buttons: () => {ok, held, pressed, reason}   (called ONLY while the cursor is in an active corner)
 * } -> { st, act: 'fire' | null, corner, action, why, blocked }.
 * Phases: idle -> dwell (in an active corner, nothing against it) -> fired; disarmed = something
 * was against it while the cursor was in the corner (a button, a guard, a fresh start). Both fired
 * and disarmed end ONLY when the cursor leaves the corner (or its corner is switched Off).
 */
function step(st, i) {
  const s = Object.assign(initial(), st || {});
  const out = (act, why, blocked) => ({ st: s, act: act || null, corner: act ? s.corner : null, action: act ? i.actions[s.corner] : null, why: why || null, blocked: blocked || null });
  const reset = (phase, why, corner) => { s.phase = phase || 'idle'; s.corner = corner || null; s.since = null; s.why = why || null; };

  if (!i.pt) { if (s.phase === 'dwell') reset(); return out(null, null, `the cursor could not be read (${i.cursorWhy || 'no reason'})`); }
  const c = cornerIn(i.pt, i);
  const on = !!c && !!i.actions && !!i.actions[c] && i.actions[c] !== 'off';
  if (!on) { reset(); return out(); }                                 // outside every active corner: armed again
  if (s.corner && s.corner !== c) reset();                            // another corner (not reachable without leaving, but cheap)
  if (s.phase === 'fired') return out();                              // once per arrival
  if (s.phase === 'disarmed') { s.corner = c; return out(null, null, s.why); }
  const where = CORNER_NAMES[c];
  if (i.guard) { reset('disarmed', i.guard, c); return out(null, null, s.why); }
  let b;
  try { b = typeof i.buttons === 'function' ? i.buttons() : { ok: false, reason: 'there is no mouse button reader' }; } catch (e) { b = { ok: false, reason: `the reader threw: ${e.message}` }; }
  if (!b || !b.ok) {
    reset();
    return out(null, null, `the mouse buttons cannot be read (${(b && b.reason) || 'no reason'}), so a corner could fire in the middle of a drag`);
  }
  if (b.held || (s.phase === 'dwell' && b.pressed)) {
    reset('disarmed', `a mouse button went down in the ${where} corner (a click, or a window dragged there); the cursor has to leave the corner first`, c);
    return out(null, null, s.why);
  }
  if (s.phase !== 'dwell') { s.phase = 'dwell'; s.corner = c; s.since = i.now; return out(); }
  const rested = i.now - s.since;
  if (rested >= CORNER_DWELL_MS) {
    s.phase = 'fired'; s.since = i.now;
    return out('fire', `the cursor rested in the ${where} corner for ${rested} ms`);
  }
  return out();
}

/**
 * Pure: the reason a corner must not fire, from the sidecar's gamemode.scan {procs:true} answer
 * ({fg: {exe, title, fullscreen}, procs}) read at the moment of firing, or null. P = the game plan
 * (lib/features/_gamemode-plan.js: runningGames, detectGame, gameLabel); o = {seen, extra} for
 * runningGames. A scan that did not come back refuses (the window in front could be a game).
 */
function fireBlocker(scan, P, o) {
  if (!scan || scan.ok === false) return `the window in front could not be checked for a game or full screen (${(scan && scan.reason) || 'no answer'}), so nothing fired`;
  const fg = scan.fg || null;
  const exe = fg && fg.exe ? String(fg.exe).split(/[\\/]/).pop() : '';
  if (exe && LOCK_EXES.includes(exe.toLowerCase())) return `${exe} is in front (the lock or sign-in screen)`;
  const run = P && P.runningGames ? P.runningGames(scan, o || {}) : [];
  if (run.length) return `${P.gameLabel ? P.gameLabel(run.map((g) => g.file)) : run[0].file} is running (a known game)`;
  if (fg && P && P.detectGame) {   // a known game in front even WINDOWED (valofix), or Game Bar's list / exclusive D3D
    const d = P.detectGame(fg, Array.isArray(scan.procs) ? scan.procs : []);
    if (d && d.game) return `${d.file || exe || 'a game'} is in front (${d.how === 'known' ? 'a known game' : d.why})`;
  }
  if (fg && fg.fullscreen === true) return `${exe || fg.title || 'a window'} is full screen in front`;
  return null;
}

/* ---- the live claim table: which corner squares are taken right now (main.js, topbar.js) ---- */
const LIVE = { actions: null, displays: null };
/** corners.js: the active table while the watch runs, null when it stops / rests / is switched off. */
function setClaims(actions, displays) {
  LIVE.actions = actions && anyOn(actions) ? Object.assign({}, actions) : null;
  if (displays !== undefined) LIVE.displays = Array.isArray(displays) && displays.length ? displays.slice() : null;
}
/** The ACTIVE corner the point is in (display b, DIP), or null: that square is the corner's, not the edge's. */
function claims(pt, b) {
  if (!LIVE.actions) return null;
  // an INNER corner (another display beyond it) is not a hot corner, so the edge keeps it
  const c = LIVE.displays ? cornerOnScreens(pt, LIVE.displays) : cornerAt(pt, b);
  return c && LIVE.actions[c] && LIVE.actions[c] !== 'off' ? c : null;
}

module.exports = {
  CORNER_ZONE_DIP, CORNER_DWELL_MS, CORNER_POLL_MS, CORNERS, CORNER_NAMES, ACTIONS, ACTION_NAMES, DEFAULTS, LOCK_EXES,
  normalize, anyOn, cornerAt, cornerOnScreens, initial, startState, step, fireBlocker, setClaims, claims,
};
