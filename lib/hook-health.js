'use strict';
// HOOK HEALTH, main's half (lane mn-hook, 2026-10-12; audit #15). The sidecar notices when Windows
// silently drops its keyboard hook and re-installs it (sidecar/HookHealth.cs). This file:
//   rearm(why)  asks it to re-install both kinds of hook on every wake and unlock (main.js calls it
//               from the wake re-reader), because that is exactly when Windows drops them;
//   onHook(m)   turns a re-install that FAILED into the Win key's state piece, with the reason, and
//               puts the normal words back once a later re-install works (no silent failures).
// The sidecar says it in {ev:'switcher', op:'hook', healthy, health, winTap}.

function makeHookHealth({ state, call, log }) {
  let broken = false;

  function onHook(m) {
    if (!m || m.op !== 'hook' || typeof m.healthy !== 'boolean') return;
    if (!m.healthy) {
      broken = true;
      state.set('hotkey', { winTap: false, reason: String(m.health || 'Windows dropped the keyboard hook and Mantle could not put it back') });
      return;
    }
    if (!broken) return;
    broken = false;
    state.set('hotkey', m.winTap
      ? { winTap: true, reason: 'a tap of the Win key opens the Mantle launcher (the keyboard hook was put back)' }
      : { winTap: false, reason: "the keyboard hook is back, but the Win key tap is off, so the Win key opens Windows' Start" });
  }

  function rearm(why) {
    let p;
    try { p = call('hotkey', { op: 'rearm', why: String(why || 'main asked').slice(0, 80) }, 2000); } catch (err) { p = Promise.reject(err); }
    return Promise.resolve(p).then((r) => r, (err) => {
      if (log) log(`hook health: could not ask the sidecar to re-install its hooks (${why}): ${err && err.message ? err.message : err}`);
      return null;
    });
  }

  return { onHook, rearm, isBroken: () => broken };
}

module.exports = { makeHookHealth };
