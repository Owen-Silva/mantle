'use strict';
/*
 * lib/own-banners.js -- MANTLE'S OWN MESSAGES ON THE BANNER SURFACE.
 *
 * The notification banners (lib/features/toasts.js, ui/toasts/) draw what APPS post. This is the other
 * door: Mantle itself posts a banner there (the updater: "Mantle v0.2.0 is out [Update] [Later]", then
 * "Downloading... / Installing... / Restarting...", then "Update failed: <reason>"), with buttons, a
 * progress line and a block of detail text the user can copy.
 *
 * One banner per KEY (a short string such as 'updates'). Posting the same key again UPDATES the card that
 * is up (same card, same place, no exit or enter animation); drop(key) takes it away. Each key keeps one
 * stable negative id for the life of the process (-1, -2, ...), so it can never collide with a Windows
 * toast id (those are positive) and a re-post of a dropped key comes back under the same id.
 *
 *   createOwnBanners({ log }) -> {
 *     post(key, banner, onAction)  shows it, or updates the one already up for key. Returns its id.
 *     drop(key)                    the card leaves. true if one was up.
 *     list()                       the banners up now, as the page gets them (copies).
 *     onChange(fn)                 fn({ type: 'post'|'drop', banner, id, update }); returns unsubscribe.
 *     act(id, action)              Promise<{ ok, keep, reason }>: runs the poster's onAction. Never throws.
 *   }
 *
 * banner: { app: 'Mantle', title, body, detail?, progress?: { text, pct: 0-100 | null }, tone?: 'info'|'ok'|'error',
 *           actions?: [{ id, label, primary? }], sticky: true }. Every string is plain text (the page
 *           writes textContent, never HTML). pct null = indeterminate. 'close' is the X, never a button id.
 *
 * onAction(action) gets a button's id, or 'close' when the X is pressed. It may return (or resolve to)
 * { keep: true|false }. Default: a button keeps the card (the poster usually re-posts it with progress);
 * the X takes it away. keep:false drops the key here, so list() never offers it again. While one action
 * of a banner runs, the same action is refused (a double click cannot start two updates).
 *
 * NOTHING FAILS SILENTLY: an unknown id, a missing handler, a handler that throws or rejects all answer
 * { ok:false, reason } in words (the page shows the reason on the card) and the log gets the line.
 */

const TONES = new Set(['info', 'ok', 'error']);
const MAX = { app: 40, title: 200, body: 600, detail: 4000, progress: 160, label: 40, actionId: 40, actions: 3 };

function words(err) { return err && err.message ? err.message : String(err); }
function str(v, max) {
  if (v === undefined || v === null) return '';
  const s = String(v);
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** The banner as the page gets it: only the known fields, strings capped, pct clamped, bad buttons left out
    (and named in `dropped`). Throws a TypeError for something that is not a banner at all. */
function clean(b, id) {
  if (!b || typeof b !== 'object') throw new TypeError('a banner must be an object');
  const dropped = [];
  let progress = null;
  if (b.progress && typeof b.progress === 'object') {
    const raw = b.progress.pct;
    const n = raw === null || raw === undefined || raw === '' ? NaN : Number(raw);
    progress = { text: str(b.progress.text, MAX.progress), pct: Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null };
  }
  const actions = [];
  const seen = new Set();
  for (const a of Array.isArray(b.actions) ? b.actions : []) {
    const aid = a && a.id !== undefined && a.id !== null ? str(a.id, MAX.actionId) : '';
    const label = a ? str(a.label, MAX.label) : '';
    if (!aid || !label) { dropped.push(`a button with no ${aid ? 'label' : 'id'}`); continue; }
    if (aid === 'close') { dropped.push('a button with the id "close" (that is the X)'); continue; }
    if (seen.has(aid)) { dropped.push(`a second "${aid}" button`); continue; }
    if (actions.length >= MAX.actions) { dropped.push(`"${aid}" (at most ${MAX.actions} buttons)`); continue; }
    seen.add(aid);
    actions.push({ id: aid, label, primary: !!a.primary });
  }
  const out = {
    id, own: true,
    app: str(b.app, MAX.app) || 'Mantle',
    title: str(b.title, MAX.title),
    body: str(b.body, MAX.body),
    detail: str(b.detail, MAX.detail) || null,
    progress,
    tone: TONES.has(b.tone) ? b.tone : 'info',
    actions,
    sticky: true,
    icon: null,
    opens: 'none',
  };
  return { banner: out, dropped };
}
function copyOf(b) {
  return Object.assign({}, b, { progress: b.progress ? Object.assign({}, b.progress) : null, actions: b.actions.map((a) => Object.assign({}, a)) });
}

function createOwnBanners(opts) {
  const log = opts && typeof opts.log === 'function' ? opts.log : () => {};
  const ids = new Map();      // key -> its stable id (kept after a drop)
  const up = new Map();       // key -> { id, banner, onAction, running: Set<action> }   (insertion order = post order)
  const subs = new Set();
  let next = -1;

  function emit(ev) {
    for (const fn of Array.from(subs)) {
      try { fn(ev); } catch (err) { log(`a listener for Mantle's own banners threw (${words(err)})`); }
    }
  }
  function keyOf(id) {
    for (const [k, e] of up) if (e.id === id) return k;
    return null;
  }

  function post(key, banner, onAction) {
    if (typeof key !== 'string' || !key) throw new TypeError('post(key, banner): key must be a non-empty string');
    if (!banner || typeof banner !== 'object') throw new TypeError(`post("${key}", banner): a banner must be an object`);
    if (!ids.has(key)) ids.set(key, next--);
    const id = ids.get(key);
    const c = clean(banner, id);
    if (c.dropped.length) log(`banner "${key}": left out ${c.dropped.join(', ')}`);
    const was = up.get(key);
    // an update in place keeps its place in the order and what is running
    up.set(key, { id, banner: c.banner, onAction: typeof onAction === 'function' ? onAction : null, running: was ? was.running : new Set() });
    emit({ type: 'post', banner: copyOf(c.banner), id, update: !!was });
    return id;
  }

  function drop(key) {
    const e = up.get(key);
    if (!e) return false;
    up.delete(key);
    emit({ type: 'drop', banner: copyOf(e.banner), id: e.id, update: false });
    return true;
  }

  function list() { return Array.from(up.values()).map((e) => copyOf(e.banner)); }

  function onChange(fn) {
    if (typeof fn !== 'function') throw new TypeError('onChange(fn): fn must be a function');
    subs.add(fn);
    return () => { subs.delete(fn); };
  }

  async function act(id, action) {
    const n = Number(id);
    const what = String(action === undefined || action === null ? '' : action);
    const key = Number.isInteger(n) ? keyOf(n) : null;
    if (key === null) return { ok: false, keep: false, reason: `Mantle has no banner ${id} up any more` };
    const e = up.get(key);
    const close = what === 'close';
    if (!close && !e.banner.actions.some((a) => a.id === what)) {
      return { ok: false, keep: true, reason: `this banner has no "${what || '(nothing)'}" button` };
    }
    if (e.running.has(what)) return { ok: false, keep: true, reason: 'that is already running' };
    if (!e.onAction) {
      if (close) { drop(key); return { ok: true, keep: false, reason: null }; }
      log(`banner "${key}": the "${what}" button has nothing behind it`);
      return { ok: false, keep: true, reason: 'nothing is set up to answer that button' };
    }
    e.running.add(what);
    let r;
    try {
      r = await e.onAction(what);
    } catch (err) {
      log(`banner "${key}": "${what}" failed: ${words(err)}`);
      // the X still takes the card away (the user asked for it gone); a button keeps it so the reason shows
      if (close) drop(key);
      return { ok: false, keep: !close, reason: words(err) };
    } finally {
      e.running.delete(what);   // the same Set an update in place carried over (post)
    }
    const keep = r && typeof r.keep === 'boolean' ? r.keep : !close;
    if (!keep) drop(key);   // also when the poster updated it meanwhile: keep:false is its last word
    const ok = !(r && r.ok === false);
    return { ok, keep, reason: ok ? null : str(r.reason, MAX.body) || 'it did not work, and no reason came back' };
  }

  return { post, drop, list, onChange, act };
}

module.exports = { createOwnBanners, clean };
