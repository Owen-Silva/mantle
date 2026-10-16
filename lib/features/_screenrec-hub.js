'use strict';
/*
 * _screenrec-hub.js - the in-process link between Win+Shift+S (lib/features/screenshot.js, which owns the
 * chord and the overlay) and screen recording (lib/features/screenrec.js, which owns the recorder). Lane
 * screenrec, 2026-10-15; the same pattern as _tools-hub.js. One module instance per Mantle (require cache).
 *
 *   screenrec.js, install():  hub.set({ active, stop, startFrom })   stop():  hub.set(null)
 *   screenshot.js:  the chord while a recording runs -> hub.stop('Win+Shift+S') (the same chord stops it);
 *                   a commit with record:true -> hub.startFrom(commitArgs) instead of a screenshot.
 * Every call is safe with no recorder installed (screen recording off, resting, or an older Mantle).
 */
let impl = null;
const hub = {
  set(x) { impl = x || null; },
  /** Is a recording starting or running right now? */
  active() { try { return !!(impl && impl.active()); } catch (e) { return false; } },
  /** Stop the recording (the chord again). -> true if one was stopped. */
  stop(via) { try { return !!(impl && impl.stop(via)); } catch (e) { return false; } },
  /** Start one from the overlay's commit. -> Promise<{ ok, reason? }> */
  startFrom(a) {
    if (!impl) return Promise.resolve({ ok: false, reason: 'screen recording is switched off in the tray (Mantle Settings > Mantle)' });
    try { return Promise.resolve(impl.startFrom(a)); } catch (e) { return Promise.resolve({ ok: false, reason: e.message }); }
  },
  /** Is screen recording there at all (for the overlay's Record button)? */
  available() { return !!impl; },
};
module.exports = hub;
