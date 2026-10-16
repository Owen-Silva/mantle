'use strict';
/*
 * _tools-hub.js - the in-process link between the top bar's two small tools (lane tbtools,
 * 2026-09-27): lib/features/topbar.js (rest: true), lib/features/timer.js (never rests) and
 * lib/features/notes.js (rest: true). One module instance per Mantle (Node's require cache).
 *
 * WHY IT EXISTS. A timer must still fire while Mantle rests for a game, so timer.js does not rest.
 * But ctx has no "is Mantle resting" signal for a feature that stays up (lib/features.js restAll
 * only stops the rest:true ones). The top bar IS a rest:true feature: restAll stops it with
 * stop(why, { rest: true }) and wakeAll installs it again, at the same moments as every other
 * resting feature. So topbar.js reports those two moments here and timer.js listens.
 *   known     false until the top bar has installed once: then "resting" cannot be told, and
 *             timer.js says so in its state instead of guessing.
 *   resting   null = awake, else the words restAll was given ("VALORANT.exe runs").
 *
 * TEST HOOKS: in a --test instance only, timer.js and notes.js put their hooks on hub.test
 * (hub.test.timer / hub.test.notes) for the top bar's self-test (_topbar-selftest.js). A live run
 * never sets them.
 */
const subs = new Set();
const hub = {
  known: false,
  resting: null,
  since: null,
  /** topbar.js: install() -> setResting(null); stop(why, { rest: true }) -> setResting(why). */
  setResting(why) {
    const was = hub.resting;
    hub.known = true;
    hub.resting = why ? String(why) : null;
    if (hub.resting !== was) hub.since = Date.now();
    if ((was || null) === hub.resting) return;
    for (const fn of Array.from(subs)) {
      try { fn(hub.resting, was); } catch (e) { process.stdout.write(`mantle: tools-hub: a rest listener threw: ${e && e.message}\n`); }
    }
  },
  /** fn(resting, was) on every change; returns the unsubscribe. */
  onResting(fn) { subs.add(fn); return () => subs.delete(fn); },
  /** timer.js while installed: { start(ms, label), cancel(), view() } (lane qstiles: the Focus tile). */
  timer: null,
  timerSubs: new Set(),
  /** timer.js: every state change. */
  timerChanged(v) {
    for (const fn of Array.from(hub.timerSubs)) {
      try { fn(v); } catch (e) { process.stdout.write(`mantle: tools-hub: a timer listener threw: ${e && e.message}\n`); }
    }
  },
  /** fn(view) on every timer change; returns the unsubscribe. */
  onTimer(fn) { hub.timerSubs.add(fn); return () => hub.timerSubs.delete(fn); },
  test: {},
};
module.exports = hub;
