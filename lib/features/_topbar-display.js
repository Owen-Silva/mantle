'use strict';
/* _topbar-display.js - the top bar's display-change handling, pure (lane mn-topbar, 2026-10-12).
 *
 * A 125% -> 150% scale change fires Electron's display-metrics-changed 3-6 times, and every
 * re-reserve of the app bar moves the work area, which fires it AGAIN (changedMetrics ['workArea']).
 * The top bar used to answer each one with a fresh reserve, so a maximised window jumped down
 * several times on one scale change. Now:
 *   - makeBurst: the first change runs at once (the bar never waits), the rest of the burst become
 *     ONE more run when it is over. The same leading + trailing coalescing as main.js's bottom bar
 *     (main.js <mainrel:burst>; the same rules, and here a combined reason is not repeated).
 *   - displayVerdict: a work-area-only change Mantle caused itself (inside SELF_MS of its own
 *     reserve or release), or one that leaves the work area starting at the bar's bottom, needs
 *     nothing: the bar's place, its guard rect and its glass all depend on the screen's bounds and
 *     scale, never on the work area. A work area that moved off the bar's bottom (Explorer
 *     restarted, another app bar) still re-reserves.
 * No Electron, no clock of its own: lib/features/topbar.test.js drives both with a fake clock. */

const SELF_MS = 2000;   // a work-area change this soon after Mantle's own reserve/release is Mantle's

function makeBurst(run, o) {
  const quiet = (o && o.quietMs) || 400;
  let timer = null;
  let pending = [];
  let hot = false;
  function settle() {
    timer = null;
    if (pending.length) {
      // each reason once, even inside a combined one ("the scale changed, the resolution changed")
      const parts = Array.from(new Set(pending.flatMap((p) => String(p).split(', '))));
      const why = pending.length === 1 ? pending[0] : `${pending.length} changes: ${parts.join(', ')}`;
      pending = [];
      try { run(why); } catch (_) { /* the next event tries again */ }
      timer = o.setTimeout(settle, quiet);         // stay hot until a full quiet gap with nothing new
      return;
    }
    hot = false;
  }
  return function fire(why) {
    if (!hot) {
      hot = true;
      try { run(why); } catch (_) { /* the trailing run tries again */ }
      timer = o.setTimeout(settle, quiet);
      return 'now';
    }
    pending.push(why);
    if (timer) o.clearTimeout(timer);
    timer = o.setTimeout(settle, quiet);
    return 'later';
  };
}

const METRIC_WORDS = { bounds: 'the resolution changed', workArea: 'the work area moved', scaleFactor: 'the scale changed', rotation: 'the screen turned' };

/**
 * One Electron display event -> { run, why }. o: { kind: 'metrics'|'added'|'removed', changed (the
 * changedMetrics array), primary (the event's display is the primary one), workOk (the primary's
 * work area starts at the bar's bottom), ownAt (ms of Mantle's last reserve/release), now }.
 * `why` is plain words for the log, with no names in it.
 */
function displayVerdict(o) {
  const x = o || {};
  if (x.kind === 'added') return { run: true, why: 'a display was connected' };
  if (x.kind === 'removed') return { run: true, why: 'a display was disconnected' };
  const ch = Array.isArray(x.changed) ? x.changed.map(String) : [];
  if (!ch.length) return { run: true, why: 'the display changed' };
  const words = Array.from(new Set(ch.map((m) => METRIC_WORDS[m] || `the display's ${m} changed`))).join(', ');
  if (!ch.every((m) => m === 'workArea')) return { run: true, why: words };
  if (x.primary === false) return { run: false, why: 'the work area moved on another screen (the bar is on the main one)' };
  if (Number.isFinite(x.ownAt) && Number.isFinite(x.now) && x.now - x.ownAt >= 0 && x.now - x.ownAt < SELF_MS) {
    return { run: false, why: 'Mantle moved the work area itself (its own app bar)' };
  }
  if (x.workOk) return { run: false, why: 'the work area moved, but still starts at the bar\'s bottom' };
  return { run: true, why: 'the work area moved off the bar\'s bottom' };
}

module.exports = { SELF_MS, makeBurst, displayVerdict };
