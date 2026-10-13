'use strict';
/*
 * Batch the tray menu's rebuilds (lane mn-state, 2026-10-12).
 *
 * WHY: main.js rebuilt the tray menu synchronously inside EVERY State change. A start, a wake or a
 * game starting moves State dozens of times in a second (backdrop fps, sidecar, each feature's
 * health), and each rebuild listed every feature and Alt+Tab switch and measured the menu again,
 * all on the main process, where it delays whatever click or key is being handled at that moment.
 *
 * So a State change only ASKS for a rebuild:
 *   - at most one rebuild per `ms` (250): the first ask after a quiet spell runs on the next tick
 *     (it never runs inside the set() that asked), asks inside the window wait for its end, and
 *     however many came in, one rebuild runs then. The tray is never more than `ms` behind State.
 *   - a rebuild is skipped when the menu's own inputs did not move: `key()` returns a short array
 *     of exactly what the menu and its tooltip show (State pieces compared by identity, which
 *     lib/state.js keeps for every piece that did not change, plus a few plain values). A backdrop
 *     frame-rate tick or a wallpaper playback change no longer touches the tray at all.
 * `force()` rebuilds now, whatever the key says: for the callers whose input is not in State
 * (the tray icon just made, "Put Windows back" ran).
 *
 * A rebuild that throws is reported through onError and NOT remembered as done, so the next ask
 * tries again rather than leaving a stale menu that thinks it is current.
 */

function sameKey(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function createTrayBatch(o) {
  const ms = Number.isFinite(o.ms) ? o.ms : 250;
  const now = o.now || Date.now;
  const setT = o.setTimeout || setTimeout;
  const clearT = o.clearTimeout || clearTimeout;
  const onError = o.onError || (() => {});
  const stats = { requests: 0, runs: 0, skipped: 0, errors: 0 };
  let timer = null;
  let lastRun = -Infinity;
  let lastKey = null;

  function readKey() {
    try { return o.key(); } catch (err) { onError(err, 'key'); return null; }
  }
  function build(k) {
    try {
      o.run();
      lastKey = k;
      stats.runs++;
    } catch (err) {
      lastKey = null;
      stats.errors++;
      onError(err, 'run');
    }
  }
  function fire() {
    timer = null;
    lastRun = now();
    const k = readKey();
    if (k && sameKey(k, lastKey)) { stats.skipped++; return; }
    build(k);
  }
  /** A State change: rebuild within `ms`, at most once per `ms`, only if the menu's inputs moved. */
  function request() {
    stats.requests++;
    if (timer) return;
    const wait = Math.max(0, ms - (now() - lastRun));
    timer = setT(fire, wait);
  }
  /** Rebuild now, whatever the key says (the pending batched one, if any, is folded into it). */
  function force() {
    if (timer) { clearT(timer); timer = null; }
    lastRun = now();
    build(readKey());
  }
  function cancel() {
    if (timer) { clearT(timer); timer = null; }
  }
  return { request, force, cancel, stats, pending: () => timer !== null };
}

module.exports = { createTrayBatch, sameKey };
