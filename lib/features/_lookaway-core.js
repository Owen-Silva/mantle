'use strict';
/*
 * _lookaway-core.js - when is Owen looking away, and when is he back? (lane lookaway, 2026-10-23)
 *
 * PURE: no camera, no timers, no Electron. Every call takes `now` (ms), so the tests drive it with
 * synthetic sequences (lib/features/lookaway.test.js). The feature (lookaway.js) feeds it the
 * hidden page's observations and the last keyboard/mouse input time, asks tick(now) what to do,
 * and tells it what the screen cover did.
 *
 * The rules (Umbra covers ~0.7 s after you look away and uncovers ~0.15 s after you look back;
 * QuietGlass compares the head with the user's own calibrated pose and filters brief glances):
 *   AWAY      a frame with no face, a face much smaller than his usual one (someone behind him),
 *             or his head turned or tilted past a threshold FROM HIS OWN USUAL POSE.
 *   USUAL POSE  the median of recent frames where he was looking (or using the keyboard/mouse);
 *             until there is one, only "no face" counts as away.
 *   COVER     away held for `delayMs` with nothing else in between (a glance shorter than that
 *             never covers), AND no keyboard/mouse input for `quietMs` (input = he is here: the
 *             away clock also restarts at every input), AND the newest frame is fresh.
 *   REVEAL    the first frame where he is looking again (no delay), or any pause.
 *   FRESH     if something else took the cover down (input does: the provider reveals on any key
 *             or mouse move), no new cover until he has been seen looking and then looked away again.
 *   WARM-UP   the first `warmupMs` after the camera starts are ignored (a camera's first frames
 *             are dark while its exposure settles; dark = no face = a false away).
 */

const DEFAULTS = Object.freeze({
  delayMs: 1500,       // away this long before the blur (the Settings option, 0.5-10 s)
  quietMs: 3000,       // never cover within this long of keyboard/mouse input
  warmupMs: 1200,      // frames this soon after the camera started are not trusted
  staleMs: 1600,       // a newest frame older than this decides nothing
  turn: 'normal',      // how far a head turn counts as away: 'small' | 'normal' | 'never'
  minSize: 0.5,        // a face smaller than this share of his usual size is not him
  keep: 40,            // looking frames kept for the usual pose
  minKeep: 4,          // frames needed before turns count
});

const TURN = Object.freeze({
  small: { yaw: 18, pitch: 15 },
  normal: { yaw: 25, pitch: 20 },
  never: null,
});

/** Wrap-safe difference of two angles in degrees (-180..180]. */
function angleDiff(a, b) {
  let d = ((a - b) % 360 + 540) % 360 - 180;
  if (d === -180) d = 180;
  return d;
}

function median(xs) {
  if (!xs.length) return null;
  const a = xs.slice().sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function createLookaway(opts) {
  const o = Object.assign({}, DEFAULTS, opts || {});
  const S = {
    paused: 'not started',  // a reason while paused (camera off), '' while watching
    startedAt: null,        // camera start (warm-up clock)
    lastInputAt: -Infinity,
    last: null,             // newest trusted observation { t, verdict }
    awaySince: null,        // first away frame of the current streak
    covered: false,         // the cover is up because WE asked
    needFresh: false,       // something else revealed: wait for a look, then a new away streak
    ring: [],               // looking frames: { yaw, pitch, size }
    recal: [],              // frames while he works after an input reveal (see see())
  };

  function limits() { return TURN[o.turn] === undefined ? TURN.normal : TURN[o.turn]; }

  function usual() {
    if (S.ring.length < o.minKeep) return null;
    const ys = S.ring.filter((r) => typeof r.yaw === 'number');
    const ps = S.ring.filter((r) => typeof r.pitch === 'number');
    return { yaw: median(ys.map((r) => r.yaw)), pitch: median(ps.map((r) => r.pitch)), size: median(S.ring.map((r) => r.size || 0)), n: S.ring.length };
  }

  /** A run of poses close to their own median (within half the limits). */
  function steady(rs) {
    const lim = limits() || TURN.normal;
    const my = median(rs.map((r) => r.yaw)), mp = median(rs.map((r) => r.pitch));
    return rs.every((r) => Math.abs(angleDiff(r.yaw, my)) <= lim.yaw / 2 && Math.abs(angleDiff(r.pitch, mp)) <= lim.pitch / 2);
  }

  function remember(obs) {
    S.ring.push({ yaw: obs.yaw, pitch: obs.pitch, size: obs.size });
    if (S.ring.length > o.keep) S.ring.shift();
  }

  /** 'away' | 'looking' | 'between' (the hysteresis band: neither starts nor ends a streak). */
  function judge(obs) {
    if (!obs.face) return { verdict: 'away', why: 'no face' };
    const u = usual();
    if (u && u.size > 0 && obs.size > 0 && obs.size < u.size * o.minSize) return { verdict: 'away', why: 'a face too small to be him' };
    const lim = limits();
    if (!u || !lim || typeof obs.yaw !== 'number' || typeof obs.pitch !== 'number' || u.yaw === null || u.pitch === null) return { verdict: 'looking', why: u ? 'face' : 'face (not calibrated yet)' };
    const dy = Math.abs(angleDiff(obs.yaw, u.yaw)), dp = Math.abs(angleDiff(obs.pitch, u.pitch));
    if (dy > lim.yaw) return { verdict: 'away', why: 'head turned', dy, dp };
    if (dp > lim.pitch) return { verdict: 'away', why: 'head tilted', dy, dp };
    if (dy <= lim.yaw * 0.75 && dp <= lim.pitch * 0.75) return { verdict: 'looking', why: 'face', dy, dp };
    return { verdict: 'between', why: 'near the edge', dy, dp };
  }

  const api = {
    options: o,
    set(patch) { Object.assign(o, patch || {}); },

    /** The camera started (or started again after a pause). */
    start(now) { S.paused = ''; S.startedAt = now; S.last = null; S.awaySince = null; },

    /** Camera off with a reason. The caller reveals if covered (see tick: want 'reveal'). */
    pause(reason, now) { S.paused = reason || 'paused'; S.startedAt = null; S.last = null; S.awaySince = null; void now; },

    /** Keyboard or mouse input happened at `at` (ms). */
    input(at) {
      if (!(at > S.lastInputAt)) return;
      S.lastInputAt = at;
      if (S.awaySince !== null && S.awaySince < at) S.awaySince = at;   // input = here: the away clock restarts
    },

    /** One observation from the page: { t, face, yaw, pitch, size }. Returns the verdict. */
    see(obs, now) {
      if (S.paused || S.startedAt === null) return { verdict: 'ignored', why: 'paused' };
      if (now - S.startedAt < o.warmupMs) return { verdict: 'ignored', why: 'camera warming up' };
      let j = judge(obs);
      const usingPc = now - S.lastInputAt < o.quietMs;
      if (S.needFresh && usingPc && obs.face && j.why !== 'a face too small to be him' && typeof obs.yaw === 'number' && typeof obs.pitch === 'number') {
        // He took the cover down and keeps working in this pose: if it holds steady, it IS his usual
        // pose now (he sat back, moved the laptop). Looking at a keyboard while typing never gets
        // here: only after something else took a cover down.
        S.recal.push({ yaw: obs.yaw, pitch: obs.pitch, size: obs.size });
        if (S.recal.length > 8) S.recal.shift();
        if (S.recal.length >= 5 && steady(S.recal)) { S.ring = S.recal.slice(); S.recal = []; j = judge(obs); j.why += ' (his usual pose was learned again)'; }
      }
      S.last = { t: now, verdict: j.verdict, why: j.why };
      if (j.verdict === 'looking') { remember(obs); S.awaySince = null; S.needFresh = false; S.recal = []; }
      else if (j.verdict === 'away' && S.awaySince === null) S.awaySince = Math.max(now, S.lastInputAt);
      return j;
    },

    /** The cover changed: by us (`mine`) or by someone else / on its own. */
    coverChanged(covered, mine) {
      if (covered) { S.covered = !!mine; return; }
      if (S.covered && !mine) { S.needFresh = true; S.awaySince = null; }
      S.covered = false;
    },

    /** What to do now: { want: 'cover' | 'reveal' | null, why }. */
    tick(now) {
      if (S.paused) return S.covered ? { want: 'reveal', why: 'paused: ' + S.paused } : { want: null, why: 'paused: ' + S.paused };
      const fresh = S.last && now - S.last.t <= o.staleMs;
      if (S.covered) {
        if (fresh && S.last.verdict === 'looking') return { want: 'reveal', why: 'he looked back' };
        return { want: null, why: 'covered, waiting for him to look back' };
      }
      if (!fresh) return { want: null, why: S.startedAt !== null && now - S.startedAt < o.warmupMs ? 'camera warming up' : 'no fresh frame' };
      if (S.needFresh) return { want: null, why: 'shown again by input: waiting for a look, then a new look away' };
      if (S.last.verdict !== 'away' || S.awaySince === null) return { want: null, why: 'looking' };
      if (now - S.lastInputAt < o.quietMs) return { want: null, why: 'keyboard or mouse in use' };
      if (now - S.awaySince < o.delayMs) return { want: null, why: 'away for ' + (now - S.awaySince) + ' ms (' + S.last.why + ')' };
      return { want: 'cover', why: 'away for ' + (now - S.awaySince) + ' ms (' + S.last.why + ')' };
    },

    /** Frames a second worth looking at now: fast while it matters, slow while he types. */
    rate(now) {
      if (S.paused) return 0;
      if (S.covered) return 5;                               // looking back must reveal at once
      if (now - S.lastInputAt < o.quietMs) return 1;         // cannot cover anyway: keep the usual pose fresh
      if (S.awaySince !== null) return 4;                    // a streak is running: time it well
      return 3;
    },

    status() {
      const u = usual();
      return {
        paused: S.paused, covered: S.covered, needFresh: S.needFresh,
        calibrated: !!u, usual: u && { yaw: round(u.yaw), pitch: round(u.pitch), size: round(u.size), n: u.n },
        last: S.last && { verdict: S.last.verdict, why: S.last.why }, awaySince: S.awaySince,
      };
    },
  };
  return api;
}

function round(x) { return typeof x === 'number' ? Math.round(x * 100) / 100 : x; }

module.exports = { createLookaway, DEFAULTS, TURN, angleDiff, median };
