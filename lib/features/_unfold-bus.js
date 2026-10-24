'use strict';
// _unfold-bus.js - how a feature asks for the full-screen unfold cover without knowing who draws it
// (wave unfold, 2026-10-23). Not a feature: files starting with _ are never loaded as features.
//
// PROVIDER: lib/features/unfold.js (lane unfold-unlock) owns the full-screen overlay and calls
//   provide({ cover, reveal, state }) in install(), even while its own tray switch is OFF (that
//   switch only gates the unlock/wake effect), and lets go in stop() (also on a game rest).
// ASKERS: lib/features/lookaway.js (lane lookaway) and anything later.
//
//   await bus.cover({ from: 'lookaway' })   -> { ok, reason? }  resolves when the screen sits blurred
//   await bus.reveal({ from: 'lookaway' })  -> { ok, reason? }  resolves when it has unfolded back
//   bus.state()  -> { available, covered, by, reason? }
//   bus.onChange(fn) -> unsubscribe; fn(state) on every covered/uncovered change, including the
//     provider revealing on its own (any key or mouse input while covered reveals at once: a blur
//     that will not go away is the worst bug this feature can have).
//
// No provider = { ok:false, reason } in plain words, never a throw: the asker shows that reason
// (no silent failures).

const NONE = 'the screen cover is not running (the Unfold feature is down or resting)';

let provider = null;
const listeners = new Set();

function plain(e) { return (e && e.message) || String(e); }

module.exports = {
  provide(p) {
    if (!p || typeof p.cover !== 'function' || typeof p.reveal !== 'function') {
      throw new Error('unfold bus: a provider needs cover() and reveal()');
    }
    provider = p;
    module.exports.changed();
    return () => {
      if (provider !== p) return;
      provider = null;
      module.exports.changed();
    };
  },
  available() { return !!provider; },
  async cover(args) {
    if (!provider) return { ok: false, reason: NONE };
    try { return await provider.cover(args || {}); } catch (e) { return { ok: false, reason: 'the screen cover failed: ' + plain(e) }; }
  },
  async reveal(args) {
    if (!provider) return { ok: false, reason: NONE };
    try { return await provider.reveal(args || {}); } catch (e) { return { ok: false, reason: 'the screen reveal failed: ' + plain(e) }; }
  },
  state() {
    if (!provider) return { available: false, covered: false, by: null, reason: NONE };
    const s = typeof provider.state === 'function' ? provider.state() : {};
    return { available: true, covered: !!s.covered, by: s.by || null, reason: s.reason };
  },
  onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  // the provider calls this on every covered/uncovered change
  changed() {
    const s = module.exports.state();
    for (const fn of [...listeners]) { try { fn(s); } catch (_) { /* an asker's bug must not break the cover */ } }
  },
};
