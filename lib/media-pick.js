'use strict';
/*
 * lib/media-pick.js - which media session the now-playing chip shows, and the pick Owen made in
 * the card's source switcher, kept STICKY (lane mediapick, 2026-09-25).
 *
 * Owen: "i press spotify but it keeps switching to accelus or automatic or something even
 * though i set it to spotify". main.js dropped the pick the instant the picked session was
 * missing from ONE snapshot of the sessions, and whenever only an LessonPlayer lesson was left. A
 * session that blinks out for a moment (Windows re-publishes an app's session around track
 * changes and app restarts) therefore put the card back on automatic for good, and automatic is
 * whatever Windows calls current, often the lesson.
 *
 * Now a picked session that is absent is HELD for PICK_GRACE_MS of CONTINUOUS absence. Meanwhile
 * the card shows the automatic choice and says why (by 'waiting'), and the pick applies again the
 * moment the session is back. Only after the grace does the pick drop, and the result says so.
 * KEPT: a pick of the LessonPlayer lesson does not outlive the player (Owen's call, 2026-09-22). With
 * the LessonPlayer rule on and nothing but LessonPlayer left, a lesson pick drops at once.
 *
 * Pure: no clock, no I/O. main.js owns the pick and passes `now`; lib/media-pick.test.js drives it.
 */

const PICK_GRACE_MS = 60000;

function sameAumid(a, b) { return !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase(); }

function nameOf(pick) { return (pick && (pick.name || pick.aumid)) || 'the picked app'; }

/**
 * A new pick, or null for automatic. `session`: the row Owen clicked as main last saw it, for
 * its app name and whether it is the LessonPlayer lesson. A fresh pick starts a fresh grace.
 */
function makePick(aumid, session, now) {
  if (!aumid) return null;
  return {
    aumid: String(aumid),
    name: (session && session.app && session.app.name) || null,
    lessonplayer: !!(session && session.lessonplayer),
    at: now,
    goneSince: null,
  };
}

function waitingOf(pick, now, grace) {
  const goneMs = Math.max(0, now - pick.goneSince);
  const secs = Math.round(grace / 1000);
  return {
    aumid: pick.aumid,
    name: pick.name || null,
    goneMs,
    graceMs: grace,
    leftMs: Math.max(0, grace - goneMs),
    reason: `${nameOf(pick)}'s media session is missing, so the card shows the automatic choice until it's back (your pick is kept for up to ${secs} s)`,
  };
}

/**
 * Decide. In:
 *   pick      the held pick (makePick's shape) or null
 *   sessions  every session, each with { aumid, playing, lessonplayer, app: { name } }
 *   current   Windows' current session with `.lessonplayer` set, or null
 *   guardOn   the LessonPlayer rule (main's mediaGuardOn())
 *   now       ms clock
 *   graceMs   optional, PICK_GRACE_MS by default
 * Out:
 *   pick         the pick to hold from now on (a copy; null = automatic)
 *   lessonplayerOnly  true: nothing but the lesson, so no chip at all (the LessonPlayer rule)
 *   want         the AUMID to show, or null for Windows' current session
 *   by           'you' | 'waiting' | 'current' | 'lessonplayer-rule' | 'first' | 'lessonplayer-only'
 *   auto         when by is 'waiting': which automatic rule chose what is shown
 *   waiting      { aumid, name, goneMs, graceMs, leftMs, reason } while an absent pick is held
 *   dropped      { aumid, name, reason } on the call that dropped a pick
 */
function choose(o) {
  const sessions = Array.isArray(o.sessions) ? o.sessions : [];
  const guardOn = !!o.guardOn;
  const now = Number(o.now) || 0;
  const grace = o.graceMs == null ? PICK_GRACE_MS : Number(o.graceMs);
  let pick = o.pick ? Object.assign({}, o.pick) : null;
  let dropped = null;

  const here = pick ? sessions.find((s) => sameAumid(s.aumid, pick.aumid)) || null : null;
  if (here) {
    pick.goneSince = null;                      // back (or never gone): the grace starts over next time
    pick.lessonplayer = !!here.lessonplayer;
    if (here.app && here.app.name) pick.name = here.app.name;
  } else if (pick) {
    if (pick.goneSince == null) pick.goneSince = now;
    if (now - pick.goneSince >= grace) {
      dropped = {
        aumid: pick.aumid,
        name: pick.name || null,
        reason: `${nameOf(pick)}'s media session was gone for ${Math.round((now - pick.goneSince) / 1000)} s, so the card went back to automatic`,
      };
      pick = null;
    }
  }

  // LESSONPLAYER ALONE = NO CHIP, and a pick of the lesson does not outlive the player.
  if (guardOn && sessions.length && sessions.every((s) => s.lessonplayer)) {
    if (pick && pick.lessonplayer) {
      dropped = {
        aumid: pick.aumid,
        name: pick.name || null,
        reason: 'the LessonPlayer lesson was picked, and a pick of the lesson does not outlive the other player (the LessonPlayer rule)',
      };
      pick = null;
    }
    return { pick, lessonplayerOnly: true, want: null, by: 'lessonplayer-only', auto: null, waiting: pick ? waitingOf(pick, now, grace) : null, dropped };
  }

  if (here) return { pick, lessonplayerOnly: false, want: pick.aumid, by: 'you', auto: null, waiting: null, dropped };

  // Automatic: Windows' current session, except that under the LessonPlayer rule anything but LessonPlayer
  // wins, a playing one first. An absent pick is still held (by 'waiting') while this shows.
  const cur = o.current || null;
  const others = sessions.filter((s) => !s.lessonplayer);
  let want = null;
  let by = null;
  if (cur && !(guardOn && cur.lessonplayer)) {
    by = 'current';
  } else if (guardOn && others.length) {
    want = (others.find((s) => s.playing) || others[0]).aumid; by = 'lessonplayer-rule';
  } else if (cur) {
    by = 'current';
  } else if (sessions.length) {
    want = sessions[0].aumid; by = 'first';   // Windows has not picked one; show the first rather than nothing
  }
  if (pick) return { pick, lessonplayerOnly: false, want, by: 'waiting', auto: by, waiting: waitingOf(pick, now, grace), dropped };
  return { pick: null, lessonplayerOnly: false, want, by, auto: null, waiting: null, dropped };
}

module.exports = { PICK_GRACE_MS, sameAumid, makePick, choose };
