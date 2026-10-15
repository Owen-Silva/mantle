'use strict';
/*
 * lib/features/_toasts-core.js -- WHICH TOAST GETS A MANTLE BANNER, AND WHAT THE BANNER SAYS (lane
 * mantle-toasts, 2026-10-15). Pure, so _toasts-core.test.js drives it with plain objects.
 *
 * NEW = an id that was not in the list the last time main read it. The FIRST list after the feature
 * starts (Mantle starting, waking after a game, the switch turned on) is only remembered: what is
 * already in the centre was announced before, and a restart must not replay it. A toast older than
 * FRESH_MS (by its own time) is never bannered either: the listener can re-list an old toast after a
 * hiccup, and a banner for something from an hour ago is noise.
 *
 * QUIET = Windows itself would not pop anything up now, so neither does Mantle (the toast is in the
 * list, as Windows' would be in its centre):
 *   Do not disturb (its ACTIVE profile, automatic rules included: priority only or alarms only), and
 *   SHQueryUserNotificationState: anything but QUNS_ACCEPTS_NOTIFICATIONS (5) -- a full-screen app or
 *   game, presentation mode, the lock screen or screen saver, Windows' quiet first hour.
 * A read that failed is not quiet (the reason is logged): a lost banner is worse than one shown.
 */

const FRESH_MS = 120000;
const STICKY = /^(alarm|reminder|incomingCall|urgent)$/i;   // Windows keeps these up until answered
const QUNS = {
  1: 'the screen is locked or the screen saver is on',
  2: 'a full-screen app is in front',
  3: 'a full-screen game is running',
  4: 'presentation mode is on',
  6: 'Windows is in its quiet first hour after setup',
  7: 'a full-screen app is in front',
};

function createPicker() {
  let known = null;   // ids in the last list; null = nothing read yet (the next list is the baseline)
  return {
    /** -> the toasts in `payload` that are new since the last call (none on the first). */
    next(payload, nowMs) {
      const toasts = payload && Array.isArray(payload.toasts) ? payload.toasts : null;
      if (!toasts || payload.ok === false) return [];   // a failed read changes nothing: no burst after it
      const ids = new Set(toasts.map((t) => t && t.id).filter((id) => id !== undefined && id !== null));
      const first = known === null;
      const prev = known;
      known = ids;
      if (first) return [];
      const now = Number(nowMs) || Date.now();
      return toasts.filter((t) => t && !prev.has(t.id) && !(Number(t.timeMs) > 0 && now - Number(t.timeMs) > FRESH_MS));
    },
    ids() { return known ? Array.from(known) : []; },
    reset() { known = null; },
  };
}

/** The banner the page draws: only what it needs, and only strings it can show as text. */
function bannerOf(t, nowMs) {
  const s = (v, max) => (typeof v === 'string' && v.trim() ? v.replace(/\s+/g, ' ').trim().slice(0, max) : null);
  const pic = (v) => (typeof v === 'string' && /^(data:image\/|file:)/i.test(v) ? v : null);
  return {
    id: t.id,
    aumid: s(t.aumid, 512),
    app: s(t.app, 120) || 'An app',
    icon: pic(t.icon),
    // the sender's own picture (a person, a channel) stands in front of the app's icon, as in Windows
    logo: pic(t.logo),
    logoCircle: !!t.logoCircle,
    title: s(t.title, 300),
    body: s(t.body, 1200),
    attribution: s(t.attribution, 200),
    image: pic(t.image) || pic(t.hero),
    sticky: STICKY.test(String(t.scenario || '')),
    opens: t.opens === 'protocol' ? 'protocol' : t.opens === 'none' ? 'none' : 'app',
    at: Number(nowMs) || Date.now(),
  };
}

/** Why no banner may show now, in words, or null. q = toasts.quiet's answer. */
function quietWhy(q) {
  if (!q || q.ok === false) return null;
  if (q.dnd === 1) return 'Do not disturb is on';
  if (q.dnd === 2) return 'Do not disturb is on (alarms only)';
  if (typeof q.quns === 'number' && q.quns !== 5 && QUNS[q.quns]) return QUNS[q.quns];
  return null;
}

/**
 * Where a click goes, in the order of what is honest:
 *   a link toast   -> Windows opens its link on a click, and so does Mantle (notifs.open, the same as
 *                     the list): the one case where Mantle does exactly what Windows does
 *   an app with a window -> that window comes to the front (the toast's own message cannot be opened:
 *                     Windows gives no other app a way to activate it)
 *   anything else  -> Mantle's notification list opens, with the toast in it
 */
function clickPlan(b, target) {
  if (b && b.opens === 'protocol') return { act: 'link' };
  if (target && target.hwnd) return { act: 'window', hwnd: String(target.hwnd) };
  return { act: 'list' };
}

module.exports = { createPicker, bannerOf, quietWhy, clickPlan, FRESH_MS, STICKY };
