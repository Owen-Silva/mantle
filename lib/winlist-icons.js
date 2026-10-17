'use strict';

/*
 * THE WINDOW LIST'S ICONS, PUT BACK (idlefix-winlist, 2026-10-17).
 *
 * The sidecar's `ev windows` used to carry every window's icon data-URL on every change, and a
 * terminal with a spinner in its title changes ~4 times a second. It now sends `iconDiff: true`
 * and leaves the "icon" key OUT of an entry whose icon is the one it last sent for that hwnd
 * (sidecar/Windows.cs, WithoutSentIcons). This puts it back, so every listener of the sidecar's
 * 'windows' event (main's lastWindows and broadcast, Task View's icon map, clips) receives exactly
 * the list it did before: same entries, same fields in the same order, same icons.
 *
 * The cache mirrors the sidecar's own: it is updated ONLY from iconDiff lists (the ones the sidecar
 * records as sent), and holds exactly the last such list's hwnds, so a closed window's icon is
 * dropped with it. A full list (main's own `windows` call, re-emitted) passes through untouched.
 * An entry with no icon key and nothing kept for its hwnd should never happen (it would mean a
 * list was lost on the way, e.g. a line over the size cap); it gets icon null and is counted in
 * `missed`, so the caller can fetch a full list and say so (lib/sidecar.js).
 */
class WindowIconCache {
  constructor() { this.icons = new Map(); }

  /** Forget everything: a new sidecar process has sent nothing yet. */
  reset() { this.icons = new Map(); }

  /**
   * @param {object[]} list an iconDiff list as the sidecar sent it
   * @returns {{ list: object[], missed: string[] }} the full list, and the hwnds it had no icon for
   */
  take(list) {
    const next = new Map();
    const missed = [];
    const out = new Array(Array.isArray(list) ? list.length : 0);
    for (let i = 0; i < out.length; i++) {
      const w = list[i];
      if (!w || typeof w !== 'object') { out[i] = w; continue; }
      const h = String(w.hwnd);
      if (Object.prototype.hasOwnProperty.call(w, 'icon')) {
        next.set(h, w.icon === undefined ? null : w.icon);
        out[i] = w;
        continue;
      }
      let icon = null;
      if (this.icons.has(h)) icon = this.icons.get(h);
      else missed.push(h);
      next.set(h, icon);
      out[i] = withIcon(w, icon);
    }
    this.icons = next;
    return { list: out, missed };
  }

  /** Fill hwnds this has no icon for from a full list (the repair after a miss). */
  fill(fullList, hwnds) {
    const want = new Set(hwnds.map(String));
    for (const w of Array.isArray(fullList) ? fullList : []) {
      if (!w || typeof w !== 'object') continue;
      const h = String(w.hwnd);
      if (want.has(h) && this.icons.has(h) && this.icons.get(h) === null) this.icons.set(h, w.icon === undefined ? null : w.icon);
    }
  }
}

/** A copy of `w` with `icon` where the sidecar puts it: just before iconFrom (else last). */
function withIcon(w, icon) {
  const o = {};
  let placed = false;
  for (const k of Object.keys(w)) {
    if (!placed && k === 'iconFrom') { o.icon = icon; placed = true; }
    o[k] = w[k];
  }
  if (!placed) o.icon = icon;
  return o;
}

module.exports = { WindowIconCache, withIcon };
