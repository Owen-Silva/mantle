'use strict';
/*
 * _screenrec-hub.js - the in-process link between Win+Shift+S (lib/features/screenshot.js, which owns the
 * chord and the overlay) and screen recording (lib/features/screenrec.js, which owns the recorder). Lane
 * screenrec, 2026-10-15; the same pattern as _tools-hub.js. One module instance per Mantle (require cache).
 *
 *   screenrec.js, install():  hub.set({ active, stop, startFrom, available?, why? })   stop():  hub.set(null)
 *                 resting for a game:  hub.set({ available: () => false, why: () => words, ... })
 *   screenshot.js, install(): hub.setPicker(fn)   fn(via) opens the overlay with Record on -> { ok, reason? }
 *   screenshot.js:  the chord while a recording runs -> hub.stop('Win+Shift+S') (the same chord stops it);
 *                   a commit with record:true -> hub.startFrom(commitArgs) instead of a screenshot;
 *                   every overlay frame -> hub.available() / hub.why() for the Record button.
 *   screenrec.js:   screenrec.start with no target (the Win+G panel's row) -> hub.pick(via).
 * Every call is safe with no recorder installed (screen recording off, resting, or an older Mantle).
 */
const OFF = 'screen recording is switched off in the tray (Mantle Settings > Mantle)';
let impl = null;
let picker = null;
const hub = {
  set(x) { impl = x || null; },
  setPicker(fn) { picker = typeof fn === 'function' ? fn : null; },
  /** Is a recording starting or running right now? */
  active() { try { return !!(impl && impl.active()); } catch (e) { return false; } },
  /** Stop the recording (the chord again). -> true if one was stopped. */
  stop(via) { try { return !!(impl && impl.stop(via)); } catch (e) { return false; } },
  /** Start one from the overlay's commit. -> Promise<{ ok, reason? }> */
  startFrom(a) {
    if (!impl) return Promise.resolve({ ok: false, reason: OFF });
    try { return Promise.resolve(impl.startFrom(a)); } catch (e) { return Promise.resolve({ ok: false, reason: e.message }); }
  },
  /** Can the overlay's Record button record right now? */
  available() {
    if (!impl) return false;
    try { return typeof impl.available === 'function' ? !!impl.available() : true; } catch (e) { return false; }
  },
  /** Why not, in plain words (null when it can). */
  why() {
    if (!impl) return OFF;
    try { return hub.available() ? null : String((typeof impl.why === 'function' && impl.why()) || 'no reason was given'); } catch (e) { return e.message; }
  },
  /** Open Win+Shift+S's overlay with Record on, to pick what to record. -> { ok, reason? } */
  pick(via) {
    if (!picker) return { ok: false, reason: 'Win+Shift+S is not Mantle\'s right now (Screenshots is off in the tray), so there is no overlay to pick an area or a window in' };
    try { return picker(via) || { ok: false, reason: 'the overlay did not say whether it opened' }; } catch (e) { return { ok: false, reason: e.message }; }
  },
  hasPicker() { return !!picker; },
};
module.exports = hub;
