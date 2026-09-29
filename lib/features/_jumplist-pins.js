'use strict';
/* _jumplist-pins.js - Mantle's OWN "Pin to taskbar" / "Unpin from taskbar" (lane jumplist,
 * 2026-09-24). Loaded by lib/features/jumplist.js (which writes it) and by main.js buildPinned
 * (which applies it). The leading underscore keeps the feature loader from treating it as a feature.
 *
 * WHY an overlay and not Windows' pins: the bar's pinned list (lib/pinned.js) is READ from Windows'
 * own taskbar pins (the User Pinned\TaskBar folder plus the Taskband blob), and Mantle never writes
 * those: "Put Windows back" must hand Owen the taskbar he had. So a Mantle pin is an ADD, a Mantle
 * unpin of a Windows pin is a HIDE, both kept in <userData>/features/jumplist.json under "pins"
 * (the feature's ctx.settings file), and Windows' own pins are never touched.
 *
 *   { "pins": { "hide": [{ id, name, exe, aumid }], "add": [{ id, name, exe, aumid, shortcut }] } }
 *
 * Pure functions over plain objects, so lib/features/jumplist.test.js proves them without Electron.
 */
const fs = require('fs');
const path = require('path');

function empty() { return { hide: [], add: [] }; }

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
  const a = o.add.findIndex((x) => x.id === item.id || sameApp(x, item));
  if (a >= 0) { o.add.splice(a, 1); return { overlay: o, did: 'removed' }; }
  if (o.hide.some((x) => x.id === item.id)) return { overlay: o, did: 'already' };
  o.hide.push({ id: String(item.id), name: String(item.name || item.id), exe: item.exe || null, aumid: item.aumid || null, shortcut: null });
  return { overlay: o, did: 'hid' };
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
  return out;
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
    throw new Error(`Mantle's own pin list is not valid JSON (${fileFor(userData)})`);
  }
}

module.exports = { empty, norm, pin, unpin, apply, read, fileFor, sameApp, isPackaged };
