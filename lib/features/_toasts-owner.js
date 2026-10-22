'use strict';
/*
 * lib/features/_toasts-owner.js -- WHICH APPS' WINDOWS BANNERS MANTLE HAS TURNED OFF, WHAT EACH ONE WAS
 * BEFORE, AND PUTTING EVERY ONE OF THEM BACK (lane mantle-toasts, 2026-10-15).
 *
 * Mantle draws its own banner for a toast (lib/features/toasts.js), so for the apps it covers Windows'
 * own banner is turned off with the one per-app switch Windows has for it: Notifications\Settings\<app id>
 * ShowBanner = 0 (sidecar/ToastBanners.cs). The toast still goes to Windows' notification centre.
 *
 * THE RECORD (<userData>\notif-banners.json, written by this module ONLY):
 *   { v: 1, owned: { "<app id>": <the ShowBanner value before Mantle: 1, or null = no value> },
 *     taken: { "<app id, keyed exactly as in owned>": <stamp> }, released: ["<app id>", ...] }
 * WRITE-AHEAD: an app's original goes into the record and the record is SAVED before its value is
 * changed, so a crash between the two leaves the original on disk, never only in memory. The same for
 * its stamp: a fresh integer per take AND per retake (stampFor), saved before the registry 0 is written.
 *
 * PUT-BACK MARKERS (lane mantle-notif-owner2, 2026-10-17). A put-back out of Mantle's process (the
 * sidecar's exit, the crash supervisor, tools/restore-banners.ps1) leaves the record listing the app
 * under `owned`. Without more, a 0 the user then sets themselves in Windows' Settings while Mantle is down reads
 * as Mantle's own: Mantle draws banners for an app they silenced and the next quit turns Windows' back on
 * over their choice. So each of those writers lists what it put back in its own file next to the record
 * (BACK_FILES; main never writes them): { v: 1, back: { "<app id>": { at, took: <the record's
 * taken[app id] at the put-back, or null> } } }. An owned app reading 0 is THE USER'S when any marker entry
 * for it (case-blind) has took === the record's current stamp (missing = null on both sides): it is let
 * go like any other change of theirs (never written, never restored). Equality, not time order: a retake
 * stamps a new value, so a marker from before it can never match however late it lands, and no clock
 * jump can make Mantle's own 0 "the user's" (that would leave their banners silently off with Mantle not
 * drawing them). A record from before stamps + a marker with took null = a match (a put-back after the
 * last take). A stamp is also above every took a marker names for that app, so a clock set back onto an
 * old stamp cannot recreate it either.
 * NEVER CLOBBERED TWICE: an app already in `owned` keeps the original it was taken with. Its value in
 * the registry is Mantle's 0 now, and reading that back as "the original" would lose the user's real one.
 * EVERY EXIT PUTS IT BACK: restore() here (the feature's off switch and stop(): quit, "Restore Windows
 * taskbar", the tray's put-back); the sidecar on any exit of its own (ToastBanners.RestoreForExit);
 * tools/restore-banners.ps1 with no Mantle at all (restore-windows.ps1, the supervisor's crash-loop
 * give-up, `npm run autostart:remove`). Every one of them writes an original back ONLY where the value
 * is still Mantle's 0, so a change the user made themselves in Windows' Settings is never overwritten.
 *
 * The user's own choices win: an app whose notifications are off (Enabled 0) or whose banner they already
 * turned off (ShowBanner 0) is never taken (Mantle shows no banner for it either); an app whose value
 * they change while Mantle has it is let go and listed in `released`, so it is not taken again until they
 * turn "Show notifications in Mantle's style" off and on.
 *
 * Pure: the registry and the record file come in as `reg` and `store`, so _toasts-owner.test.js drives
 * every path with fakes.
 *   reg.read()            -> Promise<{ ok, reason, apps: [{ aumid, banner, enabled, odd }] }>
 *   reg.write(set)        -> Promise<{ ok, reason, results: [{ aumid, ok, now, reason }] }>, set = [{ aumid, value: 0|1|null }]
 *   store.load()          -> record or null (no file); THROWS when the file is there but unreadable
 *   store.save(record)    -> THROWS when it cannot write
 *   store.loadBack()      -> [{ aumid, at, took }] from the marker files (readBackFiles); optional; a
 *                            throw = no entries (a 0 stays Mantle's, said in the log)
 *   o.now()               -> epoch ms for the stamps (tests pass a fake clock)
 */

/* Left to Windows, with the reason Settings shows. Their pop-ups carry buttons only Windows can run
 * (the listener Mantle reads toasts through cannot press a toast's buttons or answer a call). */
const LEFT = [
  { re: /^Windows\.SystemToast\./i, why: 'Windows\' own system messages (AutoPlay, Bluetooth pairing, ...), whose buttons only work in Windows\' pop-up' },
  { re: /^Windows\.ActionCenter\./i, why: 'Windows\' own suggestions, whose buttons only work in Windows\' pop-up' },
  { re: /^NotifyIconGeneratedAumid_/i, why: 'notification-area icon balloons: a click only reaches their app through Windows' },
  { re: /^(Microsoft\.YourPhone_|Microsoft\.WindowsAlarms_|MSTeams_|MicrosoftTeams|Microsoft\.SkypeApp_|com\.squirrel\.Teams\.)/i,
    why: 'calls and alarms, which are answered or snoozed with buttons only Windows\' pop-up has' },
];
/** The app ids a test registers; a --test Mantle manages ONLY these (and a live one never does). */
const TEST_RE = /^Mantle\.ToastTest/i;

function leftToWindows(aumid, test) {
  const a = String(aumid || '');
  if (!a) return 'Windows did not say which app it is';
  if (test) return TEST_RE.test(a) ? null : 'a test copy of Mantle never changes a real app\'s Windows setting';
  if (TEST_RE.test(a)) return 'a test app id';
  for (const l of LEFT) if (l.re.test(a)) return l.why;
  return null;
}

function emptyRecord() { return { v: 1, owned: {}, taken: {}, released: [] }; }

/** The put-back markers, one per writer, in the record's folder (never written by main). */
const BACK_FILES = ['notif-banners-back.sidecar.json', 'notif-banners-back.supervisor.json', 'notif-banners-back.script.json'];
const isPlain = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
/**
 * Every marker entry in `dir` -> [{ aumid, at, took, from }]. A file that is missing, torn, of another
 * version or not the format gives no entries; never throws. `.unreadable` lists the files that were
 * there but could not be read (for the log).
 */
function readBackFiles(dir, fsx) {
  const out = [];
  out.unreadable = [];
  let f, join;
  try { f = fsx || require('fs'); join = require('path').join; } catch (_) { return out; }
  for (const name of BACK_FILES) {
    let raw;
    try { raw = f.readFileSync(join(String(dir || '.'), name), 'utf8'); } catch (err) {
      if (!(err && err.code === 'ENOENT') && !(err && err.code === 'ENOTDIR')) out.unreadable.push(`${name}: ${plainFirst(err && err.message)}`);
      continue;
    }
    try {
      const j = JSON.parse(String(raw).replace(/^﻿/, ''));
      if (!isPlain(j) || j.v !== 1 || !isPlain(j.back)) { out.unreadable.push(`${name}: not a v1 put-back list`); continue; }
      for (const k of Object.keys(j.back)) {
        const e = j.back[k];
        if (!k || !isPlain(e)) continue;
        out.push({ aumid: k, at: e.at, took: e.took === undefined ? null : e.took, from: name });
      }
    } catch (err) { out.unreadable.push(`${name}: ${plainFirst(err && err.message)}`); }
  }
  return out;
}
/** A stamp as the rule compares it: missing / undefined = null; anything else as it is (=== only). */
const stampOf = (v) => (v === undefined || v === null ? null : v);

function keyOf(obj, aumid) {
  const low = String(aumid).toLowerCase();
  for (const k of Object.keys(obj)) if (k.toLowerCase() === low) return k;
  return null;
}
const has = (list, aumid) => list.some((x) => String(x).toLowerCase() === String(aumid).toLowerCase());
function plainFirst(s) { return String(s || '').split('\n')[0].slice(0, 300); }

function createOwner(o) {
  const reg = o.reg;
  const store = o.store;
  const log = o.log || (() => {});
  const test = !!o.test;
  const clock = typeof o.now === 'function' ? o.now : Date.now;
  let rec = null;           // the record as last loaded or saved
  let recWhy = null;        // why the record could not be read (nothing is taken while this is set)
  let backWhy = null;       // the last thing said about unreadable marker files (said once per change)
  let chain = Promise.resolve();

  function load() {
    try {
      const r = store.load();
      recWhy = null;
      if (!r) return emptyRecord();
      const owned = isPlain(r.owned) ? r.owned : {};
      for (const k of Object.keys(owned)) if (!(owned[k] === null || owned[k] === 1)) delete owned[k];
      // stamps: finite numbers only, only for apps still owned (keyed exactly as in owned)
      const taken = {};
      if (isPlain(r.taken)) {
        for (const k of Object.keys(r.taken)) {
          if (Object.prototype.hasOwnProperty.call(owned, k) && typeof r.taken[k] === 'number' && Number.isFinite(r.taken[k])) taken[k] = r.taken[k];
        }
      }
      return { v: 1, owned, taken, released: Array.isArray(r.released) ? r.released.filter((x) => typeof x === 'string') : [] };
    } catch (err) {
      recWhy = `Mantle could not read its record of Windows' original pop-up settings (${plainFirst(err.message)})`;
      return null;
    }
  }
  function save(r) { store.save(r); rec = r; }
  /** An app leaves the record: its original and its stamp go together. */
  function drop(r, k) { delete r.owned[k]; delete r.taken[k]; }

  /** The put-back markers -> [{ aumid, took }]. Never throws: unreadable = no entries, said once. */
  function backEntries() {
    if (!store || typeof store.loadBack !== 'function') return [];
    let b;
    try { b = store.loadBack(); } catch (err) { noteBack(`the put-back marker files could not be read (${plainFirst(err && err.message)})`); return []; }
    const out = [];
    const add = (aumid, e) => { if (aumid && isPlain(e)) out.push({ aumid: String(aumid), took: stampOf(e.took) }); };
    if (Array.isArray(b)) for (const e of b) { if (isPlain(e)) add(e.aumid, e); }
    else if (isPlain(b)) for (const k of Object.keys(b)) { const v = b[k]; if (Array.isArray(v)) v.forEach((e) => add(k, e)); else add(k, v); }
    const bad = b && Array.isArray(b.unreadable) && b.unreadable.length ? `a put-back marker file could not be read (${plainFirst(b.unreadable.join('; '))})` : null;
    noteBack(bad);
    return out;
  }
  function noteBack(why) {
    if (why === backWhy) return;
    backWhy = why;
    if (why) log(`${why}; what it lists is ignored, so an app reading 0 stays Mantle's own and is put back at the quit`);
  }
  /** The user's own 0: a writer put this app back after its current take (its stamp matches). */
  function putBackSince(back, k, r) {
    const low = String(k).toLowerCase();
    const mine = stampOf(r.taken[k]);
    return back.some((e) => e.aumid.toLowerCase() === low && e.took === mine);
  }
  /**
   * A fresh stamp for a take or a retake of r.owned[k]: an integer, the clock's, but always above this
   * app's previous stamp AND above every stamp a marker names for it, so it can never equal one a writer
   * already copied (a clock that stands still or jumps back included).
   */
  function stampFor(r, k, back) {
    const t = Number(clock());
    let s = Number.isFinite(t) ? Math.floor(t) : 0;
    const prev = r.taken[k];
    if (typeof prev === 'number' && Number.isFinite(prev)) s = Math.max(s, Math.floor(prev) + 1);
    const low = String(k).toLowerCase();
    for (const e of back) if (e.aumid.toLowerCase() === low && typeof e.took === 'number' && Number.isFinite(e.took)) s = Math.max(s, Math.floor(e.took) + 1);
    return s;
  }
  /** One operation at a time: an apply never interleaves with a restore. */
  function serial(fn) {
    const p = chain.then(fn, fn);
    chain = p.catch(() => {});
    return p;
  }
  async function readReg() {
    let r;
    try { r = await reg.read(); } catch (err) { return { ok: false, reason: `Windows' notification settings could not be read (${plainFirst(err.message)})` }; }
    if (!r || r.ok === false || !Array.isArray(r.apps)) return { ok: false, reason: (r && r.reason) || 'Windows\' notification settings could not be read' };
    return r;
  }
  async function writeReg(set) {
    try {
      const w = await reg.write(set);
      return w && Array.isArray(w.results) ? w : { ok: false, reason: (w && w.reason) || 'no answer', results: [] };
    } catch (err) { return { ok: false, reason: plainFirst(err.message), results: [] }; }
  }

  /**
   * Take every app Mantle should cover and make sure each owned one is still off.
   * opts.fresh (the switch turned on by the user): forget `released`, every app is offered again.
   * -> { ok, reason, owned, took: [], retook: [], released: [], failed: [{aumid, reason}] }
   */
  function apply(why, opts) {
    return serial(async () => {
      const r0 = load();
      if (!r0) return { ok: false, reason: recWhy, owned: 0, took: [], retook: [], released: [], failed: [] };
      const r = r0;
      let dirty = false;
      if (opts && opts.fresh && r.released.length) { r.released = []; dirty = true; }
      const now = await readReg();
      if (!now.ok) { rec = r; return { ok: false, reason: now.reason, owned: Object.keys(r.owned).length, took: [], retook: [], released: [], failed: [] }; }
      const byId = new Map(now.apps.map((a) => [String(a.aumid).toLowerCase(), a]));
      const back = backEntries();
      const set = [];
      const took = [], retook = [], released = [];
      let changedByUser = 0;
      const offAfterPutBack = [];
      // 1. what Mantle already owns: still Mantle's 0, put back by someone (take it again), or the user's now
      for (const k of Object.keys(r.owned)) {
        const a = byId.get(k.toLowerCase());
        if (!a) continue;                      // gone from Windows' list: kept, restore skips it
        if (a.banner === 0 && !a.odd) {
          if (!putBackSince(back, k, r)) continue;   // still Mantle's own 0
          // put back out of Mantle's process after this take, and 0 again since: the user's own choice
          drop(r, k);
          if (!has(r.released, k)) r.released.push(k);
          released.push(k);
          offAfterPutBack.push(k);
          dirty = true;
          continue;
        }
        if (!a.odd && a.banner === r.owned[k]) {
          r.taken[k] = stampFor(r, k, back);    // a NEW stamp, saved before the 0 is written (write-ahead)
          set.push({ aumid: a.aumid, value: 0 });
          retook.push(a.aumid);
          dirty = true;
          continue;
        }
        drop(r, k);
        if (!has(r.released, k)) r.released.push(k);
        released.push(k);
        dirty = true;
        changedByUser++;
        log(`You changed an app's Windows pop-up setting yourself, so Mantle let that app go (${changedByUser} so far this pass)`);
      }
      if (offAfterPutBack.length) {
        log(`banners (${why}): Mantle let ${offAfterPutBack.length} app(s) go: their Windows pop-ups were put back while Mantle was not running and you have turned them off yourself since, so Mantle draws no banner for them and never turns Windows' back on`);
      }
      // 2. apps not owned yet
      for (const a of now.apps) {
        const id = String(a.aumid || '');
        if (!id || keyOf(r.owned, id) || has(r.released, id)) continue;
        if (leftToWindows(id, test)) continue;
        if (a.odd || a.enabled === 0 || a.banner === 0) continue;
        if (!(a.banner === null || a.banner === undefined || a.banner === 1)) continue;
        r.owned[id] = a.banner === 1 ? 1 : null;
        r.taken[id] = stampFor(r, id, back);    // saved with the original, before the 0 (write-ahead)
        set.push({ aumid: id, value: 0 });
        took.push(id);
        dirty = true;
      }
      if (dirty) {
        try { save(r); } catch (err) {
          // nothing was written yet, so nothing needs undoing; the originals were never at risk
          return { ok: false, reason: `Mantle could not save its record of Windows' original pop-up settings, so it changed nothing (${plainFirst(err.message)})`,
            owned: 0, took: [], retook: [], released, failed: [] };
        }
      } else rec = r;
      const failed = [];
      if (set.length) {
        const w = await writeReg(set);
        const res = new Map(w.results.map((x) => [String(x.aumid).toLowerCase(), x]));
        let undo = false;
        for (const s of set) {
          const x = res.get(s.aumid.toLowerCase());
          if (x && x.ok) continue;
          failed.push({ aumid: s.aumid, reason: (x && x.reason) || w.reason || 'Windows did not answer' });
          // a NEW take whose value did not change is not Mantle's: drop it so the record mirrors the registry
          if (took.includes(s.aumid) && !(x && x.now === 0)) { const k = keyOf(r.owned, s.aumid); if (k) { drop(r, k); undo = true; } }
        }
        if (undo) { try { save(r); } catch (err) { log(`the record could not be saved after a failed write (${plainFirst(err.message)}); restore() skips apps that are not 0`); } }
      }
      const owned = Object.keys(r.owned).length;
      if (took.length || retook.length || failed.length) log(`banners (${why}): ${owned} app(s) covered by Mantle; took ${took.length}, took back ${retook.length}${failed.length ? `, ${failed.length} FAILED` : ''}`);
      return { ok: failed.length === 0, reason: failed.length ? `Windows did not take the change for ${failed.length} app(s)` : null, owned, took, retook, released, failed };
    });
  }

  /**
   * Every owned app back to its original, where the value is still Mantle's 0. An entry is kept only
   * when its write failed (a later restore, the sidecar or the script finishes it).
   * opts.keepReleased: leave `released` as it is (a quit); the switch going off forgets it.
   * An app reading 0 that a put-back marker names with its current stamp is the user's 0: let go, unwritten.
   * -> { ok, reason, restored, left, failed: [{aumid, reason}], released: [those let go that way] }
   */
  function restore(why, opts) {
    return serial(async () => {
      const r = load();
      if (!r) return { ok: false, reason: `${recWhy}; Windows' pop-ups were left as they are`, restored: 0, left: 0, failed: [] };
      const ids = Object.keys(r.owned);
      if (!ids.length) {
        if (!(opts && opts.keepReleased) && r.released.length) { r.released = []; try { save(r); } catch (_) { /* nothing owned: harmless */ } }
        rec = r;
        return { ok: true, reason: null, restored: 0, left: 0, failed: [] };
      }
      const now = await readReg();
      if (!now.ok) { rec = r; return { ok: false, reason: `${now.reason}; Mantle will put them back next time it can`, restored: 0, left: 0, failed: [] }; }
      const byId = new Map(now.apps.map((a) => [String(a.aumid).toLowerCase(), a]));
      const back = backEntries();
      const set = [];
      const offAfterPutBack = [];
      let left = 0;
      for (const k of ids) {
        const a = byId.get(k.toLowerCase());
        if (a && a.banner === 0 && !a.odd) {
          if (putBackSince(back, k, r)) {
            // put back after this take and 0 again since: the user's own choice, never written back
            drop(r, k);
            if (!has(r.released, k)) r.released.push(k);
            offAfterPutBack.push(k);
            left++;
            continue;
          }
          set.push({ aumid: a.aumid, value: r.owned[k], key: k });
        } else { drop(r, k); left++; }   // gone, or the user's own value: nothing of Mantle's to undo
      }
      if (offAfterPutBack.length) {
        log(`banners put back (${why}): Mantle let ${offAfterPutBack.length} app(s) go without writing them: their Windows pop-ups were put back while Mantle was not running and you have turned them off yourself since, so they stay off as they set them`);
      }
      const failed = [];
      if (set.length) {
        const w = await writeReg(set.map((s) => ({ aumid: s.aumid, value: s.value })));
        const res = new Map(w.results.map((x) => [String(x.aumid).toLowerCase(), x]));
        for (const s of set) {
          const x = res.get(s.aumid.toLowerCase());
          if (x && x.ok) drop(r, s.key);
          else failed.push({ aumid: s.aumid, reason: (x && x.reason) || w.reason || 'Windows did not answer' });
        }
      }
      if (!(opts && opts.keepReleased)) r.released = [];
      let saveWhy = null;
      try { save(r); } catch (err) { saveWhy = plainFirst(err.message); rec = r; }
      const restored = set.length - failed.length;
      log(`banners put back (${why}): ${restored} app(s) back to Windows' own pop-up${left ? `, ${left} left as you set them` : ''}${failed.length ? `, ${failed.length} FAILED` : ''}`);
      const reason = failed.length ? `Windows did not take the change back for ${failed.length} app(s); tools\\restore-banners.ps1 puts them back`
        : saveWhy ? `they are back, but the record could not be updated (${saveWhy})` : null;
      return { ok: failed.length === 0, reason, restored, left, failed, released: offAfterPutBack };
    });
  }

  /** Does Mantle cover this app right now (its Windows banner is off because of Mantle)? */
  function owns(aumid) { return !!(rec && aumid && keyOf(rec.owned, aumid)); }
  function released(aumid) { return !!(rec && aumid && has(rec.released, aumid)); }
  function counts() { return { owned: rec ? Object.keys(rec.owned).length : 0, released: rec ? rec.released.length : 0, recordWhy: recWhy }; }
  /** Load the record without touching the registry (the feature's first look). */
  function peek() { const r = load(); if (r) rec = r; return counts(); }

  return { apply, restore, owns, released, counts, peek };
}

module.exports = { createOwner, leftToWindows, readBackFiles, BACK_FILES, TEST_RE, LEFT };
