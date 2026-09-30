'use strict';
/*
 * _idle-unload.js - a hidden window that is RARELY used goes after IDLE_UNLOAD_MS unused, and is
 * made again on its next use (lane ramdiet, 2026-09-27).
 *
 * WHY. Owen's laptop has 11.7 GB and RAM is his pain point. Every hidden BrowserWindow is a whole
 * renderer process, ~27-30 MB private and ~95-105 MB working set each, measured in a --test instance
 * (log line "mantle: memory"). A window he opens once an evening does not need to hold that all
 * evening.
 *
 * WHAT GOES (measured 2026-09-27, --test, one window made alone):
 *   the screenshot card     only ever shown after a capture; made the moment the overlay is up, so
 *                           it loads (80-250 ms) while Owen drags his box: nothing waits for it.
 * WHAT STAYS WARM: every window that answers a key with no warning and would open slower than
 * ~150 ms cold. MEASURED: the clipboard panel made again opened in 136-246 ms (its page alone
 * 99-194 ms) against ~25 ms warm, and once main.js trims Mantle's working set an idle panel holds
 * only ~12 MB of RAM, so it stays. Not unloaded for the same reason, by the same page-load cost:
 * the switcher (Alt+Tab), the OSD (volume/brightness), the launcher (Win), Task view (Win+Tab),
 * the snap window (Win+Z, Snap Assist) and the screenshot overlays (a cold overlay page took
 * 204-322 ms to load, before any capture work). The bar, the desktop layer, the top bar and the
 * wallpaper are on screen, not idle. The ontop pop-up was already made on demand.
 *
 * THE SAME PATH. unload() destroys the window exactly as stop(rest) does for a game, and the next
 * use calls the feature's own create function, the one install() (and so the wake after a game)
 * calls. Nothing else about the feature changes: its chords, commands and sidecar state stay.
 *
 * TEST. MANTLE_IDLE_UNLOAD_MS shortens the wait, --test only; `electron . --test
 * --profile-name=<x> --test-unload` (main.js) unloads every idle-unloadable window NOW.
 */
const IDLE_UNLOAD_MS = 10 * 60 * 1000;

const watches = new Set();

function idleMs(test) {
  const env = Number(process.env.MANTLE_IDLE_UNLOAD_MS);
  return test && env > 0 ? env : IDLE_UNLOAD_MS;
}

/**
 * o: { what, log(line), test, busy(): bool, unload(why): bool (true = there was a window to destroy) }
 * -> { touch(), stop(), unloadNow(why) }. touch() after every use (and after it is made) restarts
 * the wait; while busy() says so, the wait starts again instead of unloading.
 */
function watchIdle(o) {
  const ms = idleMs(o.test);
  let timer = null;
  let stopped = false;
  const say = (line) => { try { o.log(line); } catch (_) { /* a log that throws must not break the watch */ } };
  // core-lib (2026-09-29): busy() or unload() throwing inside the timer was an uncaught exception
  // (main shuts Mantle down on one). A busy() that throws counts as busy: nothing is destroyed on a
  // guess. An unload() that throws is said, and the wait starts again.
  const isBusy = () => {
    if (!o.busy) return false;
    try { return !!o.busy(); } catch (err) { say(`${o.what}: could not tell whether it is in use (${err && err.message}); kept`); return true; }
  };
  const h = {
    what: o.what,
    touch() {
      if (stopped) return;   // a late use after stop() must not arm a timer for a stopped feature
      clearTimeout(timer);
      timer = setTimeout(fire, ms);
      if (timer.unref) timer.unref();
    },
    stop() { stopped = true; clearTimeout(timer); timer = null; watches.delete(h); },
    unloadNow(why) {
      if (stopped || isBusy()) return false;
      clearTimeout(timer);
      timer = null;
      let went;
      try { went = o.unload(why); } catch (err) {
        say(`${o.what}: could not be unloaded (${err && err.message}); it stays, and is tried again after the next wait`);
        h.touch();
        return false;
      }
      if (!went) return false;
      say(`${o.what}: unloaded (${why}); it is made again on its next use`);
      return true;
    },
  };
  function fire() {
    timer = null;
    if (stopped) return;
    if (isBusy()) { h.touch(); return; }
    h.unloadNow(`unused for ${ms >= 60000 ? `${Math.round(ms / 60000)} min` : `${ms} ms`}`);
  }
  watches.add(h);
  return h;
}

/** Every idle-unloadable window, now (the --test-unload hook). -> the names that went. */
function unloadAll(why) {
  const out = [];
  for (const h of Array.from(watches)) if (h.unloadNow(why)) out.push(h.what);
  return out;
}

module.exports = { IDLE_UNLOAD_MS, idleMs, watchIdle, unloadAll };
