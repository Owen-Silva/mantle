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
 *     released: ["<app id>", ...] }
 * WRITE-AHEAD: an app's original goes into the record and the record is SAVED before its value is
 * changed, so a crash between the two leaves the original on disk, never only in memory.
 * NEVER CLOBBERED TWICE: an app already in `owned` keeps the original it was taken with. Its value in
 * the registry is Mantle's 0 now, and reading that back as "the original" would lose Owen's real one.
 * EVERY EXIT PUTS IT BACK: restore() here (the feature's off switch and stop(): quit, "Restore Windows
 * taskbar", the tray's put-back); the sidecar on any exit of its own (ToastBanners.RestoreForExit);
 * tools/restore-banners.ps1 with no Mantle at all (restore-windows.ps1, the supervisor's crash-loop
 * give-up, `npm run autostart:remove`). Every one of them writes an original back ONLY where the value
 * is still Mantle's 0, so a change Owen made himself in Windows' Settings is never overwritten.
 *
 * Owen's own choices win: an app whose notifications are off (Enabled 0) or whose banner he already
 * turned off (ShowBanner 0) is never taken (Mantle shows no banner for it either); an app whose value
 * he changes while Mantle has it is let go and listed in `released`, so it is not taken again until he
 * turns "Show notifications in Mantle's style" off and on.
 *
 * Pure: the registry and the record file come in as `reg` and `store`, so _toasts-owner.test.js drives
 * every path with fakes.
 *   reg.read()            -> Promise<{ ok, reason, apps: [{ aumid, banner, enabled, odd }] }>
 *   reg.write(set)        -> Promise<{ ok, reason, results: [{ aumid, ok, now, reason }] }>, set = [{ aumid, value: 0|1|null }]
 *   store.load()          -> record or null (no file); THROWS when the file is there but unreadable
 *   store.save(record)    -> THROWS when it cannot write
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

function emptyRecord() { return { v: 1, owned: {}, released: [] }; }
function keyOf(obj, aumid) {
  const low = String(aumid).toLowerCase();
  for (const k of Object.keys(obj)) if (k.toLowerCase() === low) return k;
  return null;
}
const has = (list, aumid) => list.some((x) => String(x).toLowerCase() === String(aumid).toLowerCase());
const plainFirst = (s) => String(s || '').split('\n')[0].slice(0, 300);

function createOwner(o) {
  const reg = o.reg;
  const store = o.store;
  const log = o.log || (() => {});
  const test = !!o.test;
  let rec = null;           // the record as last loaded or saved
  let recWhy = null;        // why the record could not be read (nothing is taken while this is set)
  let chain = Promise.resolve();

  function load() {
    try {
      const r = store.load();
      recWhy = null;
      if (!r) return emptyRecord();
      const owned = r.owned && typeof r.owned === 'object' && !Array.isArray(r.owned) ? r.owned : {};
      for (const k of Object.keys(owned)) if (!(owned[k] === null || owned[k] === 1)) delete owned[k];
      return { v: 1, owned, released: Array.isArray(r.released) ? r.released.filter((x) => typeof x === 'string') : [] };
    } catch (err) {
      recWhy = `Mantle could not read its record of Windows' original pop-up settings (${plainFirst(err.message)})`;
      return null;
    }
  }
  function save(r) { store.save(r); rec = r; }
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
   * opts.fresh (the switch turned on by Owen): forget `released`, every app is offered again.
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
      const set = [];
      const took = [], retook = [], released = [];
      // 1. what Mantle already owns: still Mantle's 0, put back by someone (take it again), or Owen's now
      for (const k of Object.keys(r.owned)) {
        const a = byId.get(k.toLowerCase());
        if (!a) continue;                      // gone from Windows' list: kept, restore skips it
        if (a.banner === 0 && !a.odd) continue;
        if (!a.odd && a.banner === r.owned[k]) { set.push({ aumid: a.aumid, value: 0 }); retook.push(a.aumid); continue; }
        delete r.owned[k];
        if (!has(r.released, k)) r.released.push(k);
        released.push(k);
        dirty = true;
        log(`Owen changed an app's Windows pop-up setting himself, so Mantle let that app go (${released.length} so far this pass)`);
      }
      // 2. apps not owned yet
      for (const a of now.apps) {
        const id = String(a.aumid || '');
        if (!id || keyOf(r.owned, id) || has(r.released, id)) continue;
        if (leftToWindows(id, test)) continue;
        if (a.odd || a.enabled === 0 || a.banner === 0) continue;
        if (!(a.banner === null || a.banner === undefined || a.banner === 1)) continue;
        r.owned[id] = a.banner === 1 ? 1 : null;
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
          if (took.includes(s.aumid) && !(x && x.now === 0)) { const k = keyOf(r.owned, s.aumid); if (k) { delete r.owned[k]; undo = true; } }
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
   * -> { ok, reason, restored, left, failed: [{aumid, reason}] }
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
      const set = [];
      let left = 0;
      for (const k of ids) {
        const a = byId.get(k.toLowerCase());
        if (a && a.banner === 0 && !a.odd) set.push({ aumid: a.aumid, value: r.owned[k], key: k });
        else { delete r.owned[k]; left++; }   // gone, or Owen's own value: nothing of Mantle's to undo
      }
      const failed = [];
      if (set.length) {
        const w = await writeReg(set.map((s) => ({ aumid: s.aumid, value: s.value })));
        const res = new Map(w.results.map((x) => [String(x.aumid).toLowerCase(), x]));
        for (const s of set) {
          const x = res.get(s.aumid.toLowerCase());
          if (x && x.ok) delete r.owned[s.key];
          else failed.push({ aumid: s.aumid, reason: (x && x.reason) || w.reason || 'Windows did not answer' });
        }
      }
      if (!(opts && opts.keepReleased)) r.released = [];
      let saveWhy = null;
      try { save(r); } catch (err) { saveWhy = plainFirst(err.message); rec = r; }
      const restored = set.length - failed.length;
      log(`banners put back (${why}): ${restored} app(s) back to Windows' own pop-up${left ? `, ${left} left as Owen set them` : ''}${failed.length ? `, ${failed.length} FAILED` : ''}`);
      const reason = failed.length ? `Windows did not take the change back for ${failed.length} app(s); tools\\restore-banners.ps1 puts them back`
        : saveWhy ? `they are back, but the record could not be updated (${saveWhy})` : null;
      return { ok: failed.length === 0, reason, restored, left, failed };
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

module.exports = { createOwner, leftToWindows, TEST_RE, LEFT };
