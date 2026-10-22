'use strict';
/* _jumplist-pins.js - Mantle's OWN "Pin to taskbar" / "Unpin from taskbar" (lane jumplist,
 * 2026-09-24). Loaded by lib/features/jumplist.js (which writes it) and by main.js buildPinned
 * (which applies it). The leading underscore keeps the feature loader from treating it as a feature.
 *
 * WHY an overlay and not Windows' pins: the bar's pinned list (lib/pinned.js) is READ from Windows'
 * own taskbar pins (the User Pinned\TaskBar folder plus the Taskband blob), and Mantle never writes
 * those: "Put Windows back" must hand the user the taskbar they had. So a Mantle pin is an ADD, a Mantle
 * unpin of a Windows pin is a HIDE, both kept in <userData>/features/jumplist.json under "pins"
 * (the feature's ctx.settings file), and Windows' own pins are never touched.
 *
 *   { "pins": { "hide": [{ id, name, exe, aumid }], "add": [{ id, name, exe, aumid, shortcut }],
 *               "order": [pin id, ...] } }
 *
 * ORDER (lane bardrag, 2026-09-29; the user: "i also need to be able to drag apps on the taskbar to
 * move then into a differetn order"): the pinned apps in the order the user dragged them to, by the
 * pin id main.js buildPinned gives each item. Kept here, beside hide/add, so a pin or unpin and a
 * reorder can never overwrite each other, and Windows' own pin order (the Taskband blob) is never
 * written. A pin the list does not name yet (pinned since) goes at the END, the way Windows adds a
 * new pin; a pin that is gone is simply not shown. Running apps that are not pinned keep their
 * dragged order for the SESSION only (setRunning / orderRunning, in memory, never saved).
 *
 * Pure functions over plain objects, so lib/features/jumplist.test.js proves them without Electron.
 */
const fs = require('fs');
const path = require('path');

function empty() { return { hide: [], add: [], order: [] }; }

const ORDER_MAX = 400;   // ids; a hand-edited or runaway list is cut here, never a reason to fail

/** Unique non-empty strings, in order, at most ORDER_MAX of them. Anything else is dropped. */
function cleanIds(list) {
  const out = [];
  const seen = new Set();
  if (!Array.isArray(list)) return out;
  for (const v of list) {
    if (typeof v !== 'string' || !v || v.length > 1024 || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= ORDER_MAX) break;
  }
  return out;
}

/** `list` sorted by `order` (ids, via keyOf); ids it does not name keep their own order, after it. */
function byOrder(list, order, keyOf) {
  const rank = new Map();
  (order || []).forEach((k, i) => { if (!rank.has(k)) rank.set(k, i); });
  const n = rank.size;
  return (Array.isArray(list) ? list : [])
    .map((v, i) => { const k = keyOf(v); return { v, r: rank.has(k) ? rank.get(k) : n + i }; })
    .sort((a, b) => a.r - b.r)
    .map((x) => x.v);
}

/**
 * The order to keep after a drag: `shown` (the bar's pinned ids, in their new order) plus every id
 * the old list had that is not on the bar right now (a pin a partial read left out), each put back
 * right after the id it followed, so a drag made while one pin was missing does not lose its place.
 */
function mergeOrder(stored, shown) {
  const s = cleanIds(shown);
  const inShown = new Set(s);
  const out = s.slice();
  let prev = null;
  for (const k of cleanIds(stored)) {
    if (inShown.has(k)) { prev = k; continue; }
    out.splice(prev === null ? 0 : out.indexOf(prev) + 1, 0, k);
    prev = k;
  }
  for (let i = out.length - 1; out.length > ORDER_MAX && i >= 0; i--) if (!inShown.has(out[i])) out.splice(i, 1);
  return out.slice(0, ORDER_MAX);
}

/** The overlay with its pinned order set from a drag (`ids` = the bar's pinned ids, new order). */
function setOrder(overlay, ids) {
  const o = norm(overlay);
  o.order = mergeOrder(o.order, ids);
  return o;
}

/* ---- running apps that are not pinned: this session's order, in memory only ---- */
let runningOrder = [];

function setRunning(ids) { runningOrder = cleanIds(ids); return runningOrder.slice(); }
function getRunning() { return runningOrder.slice(); }

/**
 * main.js buildPinned's items with the running-only ones (kind 'running') in this session's
 * dragged order; pinned items keep their places. opts.prune (the running list was read cleanly)
 * forgets apps that stopped, so one that starts again comes back at the end, as on Windows.
 * opts.order overrides the session list (tests).
 */
function orderRunning(items, opts) {
  const list = Array.isArray(items) ? items : [];
  const isRun = (it) => !!(it && it.kind === 'running');
  const run = list.filter(isRun);
  const order = opts && Array.isArray(opts.order) ? opts.order : runningOrder;
  if (opts && opts.prune && !opts.order) {
    const here = new Set(run.map((it) => String(it.id)));
    runningOrder = runningOrder.filter((k) => here.has(k));
  }
  if (run.length < 2 || !order.length) return list.slice();
  const sorted = byOrder(run, order, (it) => String(it.id));
  let k = 0;
  return list.map((it) => (isRun(it) ? sorted[k++] : it));
}

function clean(e) {
  if (!e || typeof e !== 'object' || !e.id) return null;
  const s = (v) => (typeof v === 'string' && v ? v : null);
  return { id: String(e.id), name: s(e.name) || String(e.id), exe: s(e.exe), aumid: s(e.aumid), shortcut: s(e.shortcut) };
}

/** A copy, with anything malformed dropped (a hand-edited file must not break the bar). */
function norm(o) {
  const out = empty();
  if (!o || typeof o !== 'object') return out;
  for (const k of ['hide', 'add']) if (Array.isArray(o[k])) for (const e of o[k]) { const c = clean(e); if (c) out[k].push(c); }
  out.order = cleanIds(o.order);
  return out;
}

const low = (v) => (v ? String(v).toLowerCase() : '');

/** The same app, by AUMID first and exe second, the way main.js groups windows under pins. */
function sameApp(a, b) {
  if (!a || !b) return false;
  /* Two DIFFERENT AUMIDs are two apps even on one exe (lane barfiles, 2026-09-29): every Mantle app
     window is electron.exe, so with a pinned Mantle Files, pinning Mantle Task Manager said
     "already" and unpinning one could drop the other. The exe decides only when an AUMID is missing. */
  if (a.aumid && b.aumid) return low(a.aumid) === low(b.aumid);
  return !!(a.exe && b.exe && low(a.exe) === low(b.exe));
}

/** Store (packaged) apps start from their AUMID; their exe under WindowsApps cannot be run. */
function isPackaged(e) { return !!(e && e.aumid && String(e.aumid).indexOf('!') > 0); }

/**
 * Pin `item` (a bar item: { id, name, kind, exe, aumid }, plus `shortcut` from the sidecar).
 * Returns { overlay, did } with did = 'unhid' | 'added' | 'already'.
 */
function pin(overlay, item) {
  const o = norm(overlay);
  const h = o.hide.findIndex((x) => x.id === item.id || sameApp(x, item));
  if (h >= 0) { o.hide.splice(h, 1); return { overlay: o, did: 'unhid' }; }
  if (o.add.some((x) => x.id === item.id || sameApp(x, item))) return { overlay: o, did: 'already' };
  if (!item.exe && !item.aumid && !item.shortcut) throw new Error(`${item.name || 'this app'} cannot be pinned: Mantle does not know what program it is`);
  const key = low(item.aumid) || low(item.exe) || low(item.shortcut);
  o.add.push({ id: 'mantle:' + key, name: String(item.name || key), exe: item.exe || null, aumid: item.aumid || null, shortcut: item.shortcut || null });
  return { overlay: o, did: 'added' };
}

/** Unpin `item`: a Mantle pin is dropped, a Windows pin is hidden. did = 'removed' | 'hid' | 'already'. */
function unpin(overlay, item) {
  const o = norm(overlay);
  // an unpinned app leaves the dragged order too: pinned again later, it goes at the end (as on Windows)
  const drop = (id) => { o.order = o.order.filter((k) => k !== String(id)); };
  drop(item.id);
  const a = o.add.findIndex((x) => x.id === item.id || sameApp(x, item));
  if (a >= 0) { drop(o.add[a].id); o.add.splice(a, 1); return { overlay: o, did: 'removed' }; }
  if (o.hide.some((x) => x.id === item.id)) return { overlay: o, did: 'already' };
  o.hide.push({ id: String(item.id), name: String(item.name || item.id), exe: item.exe || null, aumid: item.aumid || null, shortcut: null });
  return { overlay: o, did: 'hid' };
}

/**
 * UNDO an unpin (the right-click menu's "Undo", quality pass 2026-09-29). Unpinning drops the app from
 * the dragged order, so pinning it again put it at the END: one slip of the mouse lost the place the user
 * had dragged it to. `before` is the overlay just before that unpin; the app comes back exactly where
 * it was (a Mantle pin at its old place among Mantle's pins, a hidden Windows pin shown again, its id
 * back in the dragged order right after the id it followed), and anything changed SINCE the unpin
 * (another pin, a drag) is kept. did = 'restored'.
 */
function undoUnpin(current, before, item) {
  const o = norm(current);
  const b = norm(before);
  const match = (x) => x.id === String(item.id) || sameApp(x, item);
  const ids = new Set([String(item.id)]);
  const ba = b.add.findIndex(match);
  if (ba >= 0) {
    ids.add(b.add[ba].id);
    if (!o.add.some(match)) o.add.splice(Math.min(ba, o.add.length), 0, b.add[ba]);
  }
  // a Windows pin the unpin hid is shown again (one that was hidden BEFORE it stays hidden)
  if (!b.hide.some((x) => x.id === String(item.id))) o.hide = o.hide.filter((x) => x.id !== String(item.id));
  let prev = null;
  for (const k of b.order) {
    if (o.order.includes(k)) { prev = k; continue; }
    if (!ids.has(k)) continue;
    o.order.splice(prev === null ? 0 : o.order.indexOf(prev) + 1, 0, k);
    prev = k;
  }
  o.order = o.order.slice(0, ORDER_MAX);
  return { overlay: o, did: 'restored' };
}

/**
 * Windows' pins (lib/pinned.js items, already in order) with the overlay applied: hidden ones gone,
 * Mantle's own appended in the order they were pinned, never twice for an app Windows already pins.
 * The id test matches main.js buildPinned's own: String(pin.id || pin.lnkPath || pin.name).
 */
function apply(pins, overlay) {
  const o = norm(overlay);
  const hidden = new Set(o.hide.map((x) => x.id));
  const out = (Array.isArray(pins) ? pins : []).filter((p) => p && !hidden.has(String(p.id || p.lnkPath || p.name)));
  let order = out.reduce((m, p) => Math.max(m, Number(p.order) || 0), -1) + 1;
  for (const a of o.add) {
    if (out.some((p) => sameApp({ exe: p.exe, aumid: p.aumid }, a))) continue;
    const packaged = isPackaged(a);
    out.push({
      id: a.id, name: a.name, kind: 'mantle',
      lnkPath: packaged ? null : a.shortcut,
      target: packaged ? null : (a.shortcut || a.exe),
      args: '', exe: a.exe ? low(a.exe) : null, aumid: a.aumid || null,
      iconPath: packaged ? null : (a.exe || a.shortcut), iconIndex: 0, iconPng: null,
      order: order++, reason: null,
    });
  }
  // The user's dragged order last (the pin objects themselves are never changed: main caches them)
  return o.order.length ? byOrder(out, o.order, (p) => String(p.id || p.lnkPath || p.name)) : out;
}

function fileFor(userData) { return path.join(userData, 'features', 'jumplist.json'); }

/** The overlay on disk. A missing file is an empty overlay; an unreadable one THROWS its reason. */
function read(userData) {
  let text;
  try { text = fs.readFileSync(fileFor(userData), 'utf8'); } catch (err) {
    if (err.code === 'ENOENT') return empty();
    throw new Error(`Mantle's own pin list could not be read (${err.code || err.message})`);
  }
  try { return norm((JSON.parse(text) || {}).pins); } catch (err) {
    // the file's own name only: this sentence reaches the log, and the full path names the user's profile
    throw new Error(`Mantle's own pin list is not valid JSON (features\\jumplist.json)`);
  }
}

module.exports = {
  empty, norm, pin, unpin, undoUnpin, apply, read, fileFor, sameApp, isPackaged,
  cleanIds, byOrder, mergeOrder, setOrder, setRunning, getRunning, orderRunning, ORDER_MAX,
};
