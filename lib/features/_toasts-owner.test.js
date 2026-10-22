'use strict';
/*
 * _toasts-owner.test.js - the ShowBanner bookkeeping (lib/features/_toasts-owner.js) against a FAKE
 * registry and a FAKE record file: originals saved before any write, put back on every exit path, never
 * clobbered twice, the user's own changes never overwritten, failures said. Pure node, no Windows.
 *   node lib/features/_toasts-owner.test.js   -> "TOASTS OWNER TEST: n passed, m failed"
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const OWNER = require('./_toasts-owner');
const { createOwner, leftToWindows } = OWNER;

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(name + (detail !== undefined ? ' -- ' + JSON.stringify(detail).slice(0, 400) : ''));
}

/** Windows' Notifications\Settings, one entry per app: { banner, enabled, odd }. Records every write. */
function fakeReg(apps) {
  const R = { apps: JSON.parse(JSON.stringify(apps)), writes: [], failFor: new Set(), stickFor: new Set(), readFails: false, onWrite: null };
  R.read = async () => {
    if (R.readFails) return { ok: false, reason: 'the registry said no', apps: [] };
    return { ok: true, reason: null, apps: Object.keys(R.apps).map((aumid) => Object.assign({ aumid }, R.apps[aumid])) };
  };
  R.write = async (set) => {
    if (R.onWrite) R.onWrite(set);
    const results = set.map((s) => {
      R.writes.push({ aumid: s.aumid, value: s.value });
      const a = R.apps[s.aumid];
      if (!a) return { aumid: s.aumid, ok: false, reason: 'not in the list' };
      if (R.failFor.has(s.aumid)) return { aumid: s.aumid, ok: false, now: a.banner, reason: 'access denied' };
      if (!R.stickFor.has(s.aumid)) a.banner = s.value;
      return { aumid: s.aumid, ok: a.banner === s.value, now: a.banner, reason: a.banner === s.value ? null : 'kept a different value' };
    });
    return { ok: results.every((x) => x.ok), results };
  };
  return R;
}
function fakeStore(initial) {
  const S = { file: initial === undefined ? null : JSON.stringify(initial), saves: 0, failSave: false, failLoad: false, back: [], failBack: false };
  S.load = () => { if (S.failLoad) throw new Error('unexpected token in JSON'); return S.file ? JSON.parse(S.file) : null; };
  S.save = (r) => { if (S.failSave) throw new Error('EPERM: the disk said no'); S.file = JSON.stringify(r); S.saves++; };
  S.rec = () => (S.file ? JSON.parse(S.file) : null);
  // the put-back marker files (notif-banners-back.<writer>.json), merged: [{ aumid, at, took, from }]
  S.loadBack = () => { if (S.failBack) throw new Error('EBUSY: the marker file is locked'); return JSON.parse(JSON.stringify(S.back)); };
  return S;
}
/** An out-of-process put-back (the sidecar's exit, the crash supervisor, restore-banners.ps1): every owned
 *  app whose value is still 0 gets its original back, and the writer lists it with the record's stamp. */
function putBack(reg, store, from) {
  const rec = store.rec();
  for (const k of Object.keys(rec.owned)) {
    const a = reg.apps[k];
    if (!a || a.banner !== 0) continue;
    a.banner = rec.owned[k];
    store.back.push({ aumid: k, at: Date.now(), took: rec.taken && Object.prototype.hasOwnProperty.call(rec.taken, k) ? rec.taken[k] : null, from: from || 'sidecar' });
  }
}
const D = 'com.squirrel.Discord.Discord';
const H = 'com.owensilva.helm';
const takenOf = (store, k) => { const r = store.rec(); return r && r.taken ? r.taken[k] : undefined; };
const APPS = () => ({
  'com.owensilva.helm': { banner: null, enabled: null },        // never touched: Windows' default (on)
  'com.squirrel.Discord.Discord': { banner: 1, enabled: null }, // banner explicitly on
  'electron.app.Munder Difflin': { banner: 0, enabled: null },  // the user already turned its banner off
  'OperaSoftware.OperaGXWebBrowser.1751952444': { banner: null, enabled: 0 },   // notifications off
  'Windows.SystemToast.AutoPlay': { banner: null, enabled: null },
  'NotifyIconGeneratedAumid_1234': { banner: null, enabled: null },
  'Microsoft.YourPhone_8wekyb3d8bbwe!App': { banner: null, enabled: null },
  'Weird.App': { banner: null, enabled: null, odd: true },     // a string ShowBanner: never Mantle's
});

(async () => {
  // ---- leftToWindows
  check('system toasts stay Windows\'', !!leftToWindows('Windows.SystemToast.BthQuickPair'));
  check('tray balloons stay Windows\'', !!leftToWindows('NotifyIconGeneratedAumid_99'));
  check('calls stay Windows\'', !!leftToWindows('Microsoft.YourPhone_8wekyb3d8bbwe!App'));
  check('an ordinary app is Mantle\'s', leftToWindows('com.owensilva.helm') === null);
  check('a test copy never takes a real app', !!leftToWindows('com.owensilva.helm', true));
  check('a test copy takes its own test app', leftToWindows('Mantle.ToastTest.e2e', true) === null);
  check('a live copy never takes a test app', !!leftToWindows('Mantle.ToastTest.e2e', false));

  // ---- 1. first apply: write-ahead, the right apps, the right originals
  {
    const reg = fakeReg(APPS());
    const store = fakeStore();
    let recAtWrite = null;
    reg.onWrite = () => { recAtWrite = store.rec(); };
    const o = createOwner({ reg, store });
    const r = await o.apply('start');
    check('1 apply ok', r.ok === true, r);
    check('1 took exactly helm and discord', r.took.slice().sort().join('|') === 'com.owensilva.helm|com.squirrel.Discord.Discord', r.took);
    check('1 the record was SAVED before the first registry write', !!recAtWrite && Object.keys(recAtWrite.owned).length === 2, recAtWrite);
    const rec = store.rec();
    check('1 helm original = no value (null)', rec.owned['com.owensilva.helm'] === null, rec);
    check('1 discord original = 1', rec.owned['com.squirrel.Discord.Discord'] === 1, rec);
    check('1 both are 0 in Windows now', reg.apps['com.owensilva.helm'].banner === 0 && reg.apps['com.squirrel.Discord.Discord'].banner === 0);
    check('1 the user\'s own banner-off app untouched and not owned', reg.apps['electron.app.Munder Difflin'].banner === 0 && !o.owns('electron.app.Munder Difflin'));
    check('1 notifications-off app untouched', reg.apps['OperaSoftware.OperaGXWebBrowser.1751952444'].banner === null && !o.owns('OperaSoftware.OperaGXWebBrowser.1751952444'));
    check('1 system / balloon / call / odd apps untouched', ['Windows.SystemToast.AutoPlay', 'NotifyIconGeneratedAumid_1234', 'Microsoft.YourPhone_8wekyb3d8bbwe!App', 'Weird.App']
      .every((a) => !reg.writes.some((w) => w.aumid === a)), reg.writes);
    check('1 owns() is case-blind', o.owns('COM.OWENSILVA.HELM') && o.owns('com.squirrel.discord.discord'));

    // ---- 2. a second apply changes nothing and never re-reads 0 as an original
    const before = reg.writes.length;
    const r2 = await o.apply('again');
    check('2 second apply writes nothing', reg.writes.length === before && r2.took.length === 0, r2);
    check('2 originals unchanged (never clobbered twice)', store.rec().owned['com.owensilva.helm'] === null && store.rec().owned['com.squirrel.Discord.Discord'] === 1, store.rec());

    // ---- 3. a CRASH (no restore), then a new Mantle: the originals still come from the record
    const o2 = createOwner({ reg, store });
    const r3 = await o2.apply('after a crash');
    check('3 after a crash: nothing re-taken, originals from the record', r3.took.length === 0 && store.rec().owned['com.squirrel.Discord.Discord'] === 1 && store.rec().owned['com.owensilva.helm'] === null, { r3, rec: store.rec() });

    // ---- 4. the quit: every original back, record emptied
    const q = await o2.restore('quit', { keepReleased: true });
    check('4 restore ok, 2 back', q.ok && q.restored === 2, q);
    check('4 helm back to NO value (deleted, Windows default)', reg.apps['com.owensilva.helm'].banner === null, reg.apps['com.owensilva.helm']);
    check('4 discord back to 1', reg.apps['com.squirrel.Discord.Discord'].banner === 1);
    check('4 record owns nothing now', Object.keys(store.rec().owned).length === 0, store.rec());
    check('4 the user\'s own 0 still 0', reg.apps['electron.app.Munder Difflin'].banner === 0);
    const q2 = await o2.restore('quit again');
    check('4 a second restore is a no-op', q2.ok && q2.restored === 0 && reg.writes.filter((w) => w.aumid === 'com.owensilva.helm').length === 2, { q2, writes: reg.writes });
  }

  // ---- 5. put back by someone else (the sidecar's exit, the script): the next apply takes it again
  {
    const reg = fakeReg(APPS());
    const store = fakeStore();
    const o = createOwner({ reg, store });
    await o.apply('start');
    reg.apps['com.squirrel.Discord.Discord'].banner = 1;     // the sidecar's SafetyRestore wrote the original back
    reg.apps['com.owensilva.helm'].banner = null;
    const r = await o.apply('sidecar came back');
    check('5 both taken back', r.retook.length === 2 && reg.apps['com.squirrel.Discord.Discord'].banner === 0 && reg.apps['com.owensilva.helm'].banner === 0, r);
    check('5 originals kept', store.rec().owned['com.squirrel.Discord.Discord'] === 1 && store.rec().owned['com.owensilva.helm'] === null);
  }

  // ---- 6. The user changes an owned app themselves: let go, never overwritten, not taken again until a fresh on
  {
    const reg = fakeReg(APPS());
    const store = fakeStore();
    const o = createOwner({ reg, store });
    await o.apply('start');
    reg.apps['com.owensilva.helm'].banner = 1;               // original was null; 1 is the user's own choice
    const r = await o.apply('periodic');
    check('6 helm let go', r.released.includes('com.owensilva.helm') && !o.owns('com.owensilva.helm') && o.released('com.owensilva.helm'), r);
    check('6 their value stays', reg.apps['com.owensilva.helm'].banner === 1);
    const r2 = await o.apply('periodic again');
    check('6 not taken again on its own', !r2.took.includes('com.owensilva.helm') && reg.apps['com.owensilva.helm'].banner === 1, r2);
    const q = await o.restore('quit', { keepReleased: true });
    check('6 restore leaves their value alone', reg.apps['com.owensilva.helm'].banner === 1 && q.ok, q);
    check('6 quit keeps released', store.rec().released.includes('com.owensilva.helm'));
    const r3 = await o.apply('switch turned on', { fresh: true });
    check('6 a fresh on offers it again (original = their 1)', r3.took.includes('com.owensilva.helm') && store.rec().owned['com.owensilva.helm'] === 1, { r3, rec: store.rec() });
  }

  // ---- 7. failures are said and never leave a lie in the record
  {
    const reg = fakeReg(APPS());
    const store = fakeStore();
    reg.failFor.add('com.squirrel.Discord.Discord');
    const o = createOwner({ reg, store });
    const r = await o.apply('start');
    check('7 a refused write is reported', r.ok === false && r.failed.length === 1 && /access denied/.test(r.failed[0].reason), r);
    check('7 a refused NEW take is dropped from the record', !('com.squirrel.Discord.Discord' in store.rec().owned) && store.rec().owned['com.owensilva.helm'] === null, store.rec());
    reg.failFor.clear();
    reg.failFor.add('com.owensilva.helm');
    const q = await o.restore('quit');
    check('7 a refused restore keeps that app in the record', q.ok === false && store.rec().owned['com.owensilva.helm'] === null && /restore-banners/.test(q.reason), { q, rec: store.rec() });
    reg.failFor.clear();
    const q2 = await o.restore('retry');
    check('7 the retry finishes it', q2.ok && q2.restored === 1 && reg.apps['com.owensilva.helm'].banner === null && Object.keys(store.rec().owned).length === 0, q2);
  }
  {
    const reg = fakeReg(APPS());
    const store = fakeStore();
    store.failSave = true;
    const o = createOwner({ reg, store });
    const r = await o.apply('start');
    check('8 a record that cannot be saved: NOTHING is written', r.ok === false && reg.writes.length === 0 && /changed nothing/.test(r.reason), r);
  }
  {
    const reg = fakeReg(APPS());
    const store = fakeStore({ v: 1, owned: { 'com.owensilva.helm': null }, released: [] });
    store.failLoad = true;
    const o = createOwner({ reg, store });
    const r = await o.apply('start');
    check('9 an unreadable record: nothing taken, said', r.ok === false && reg.writes.length === 0 && /could not read/.test(r.reason), r);
    const q = await o.restore('quit');
    check('9 an unreadable record: restore says so and writes nothing', q.ok === false && reg.writes.length === 0 && /left as they are/.test(q.reason), q);
  }
  {
    const reg = fakeReg(APPS());
    const store = fakeStore();
    const o = createOwner({ reg, store });
    await o.apply('start');
    reg.readFails = true;
    const q = await o.restore('quit');
    check('10 a registry that cannot be read: restore keeps the record for later', q.ok === false && Object.keys(store.rec().owned).length === 2, { q, rec: store.rec() });
  }

  // ---- 11. a new app arrives later (Windows made its key on its first toast): taken on the next apply
  {
    const reg = fakeReg({ 'com.owensilva.helm': { banner: null } });
    const store = fakeStore();
    const o = createOwner({ reg, store });
    await o.apply('start');
    reg.apps['Anysphere.Cursor'] = { banner: null, enabled: null };
    const r = await o.apply('a new app notified');
    check('11 the new app is taken', r.took.length === 1 && r.took[0] === 'Anysphere.Cursor' && reg.apps['Anysphere.Cursor'].banner === 0, r);
  }

  // ---- 12. operations never interleave (an apply and a restore at once)
  {
    const reg = fakeReg(APPS());
    const store = fakeStore();
    const o = createOwner({ reg, store });
    const [a, b] = await Promise.all([o.apply('start'), o.restore('quit at once')]);
    check('12 serial: apply then restore, ends with nothing owned and Windows as it was',
      a.took.length === 2 && b.restored === 2 && reg.apps['com.owensilva.helm'].banner === null && reg.apps['com.squirrel.Discord.Discord'].banner === 1, { a, b });
  }

  // ---- 13. a --test owner touches only test ids
  {
    const reg = fakeReg(Object.assign(APPS(), { 'Mantle.ToastTest.e2e': { banner: null } }));
    const store = fakeStore();
    const o = createOwner({ reg, store, test: true });
    const r = await o.apply('test start');
    check('13 a test owner takes only the test app', r.took.length === 1 && r.took[0] === 'Mantle.ToastTest.e2e' && reg.writes.every((w) => w.aumid === 'Mantle.ToastTest.e2e'), r);
  }

  // ======== FINDING 3: a put-back out of Mantle's process, then the user's own 0 (lane mantle-notif-owner2)
  // ---- 14. put back, then the user turns the banner off themselves: let go, never restored, never retaken
  {
    const reg = fakeReg(APPS());
    const store = fakeStore();
    const logs = [];
    const o = createOwner({ reg, store, log: (l) => logs.push(l) });
    await o.apply('start');
    putBack(reg, store, 'sidecar');                  // the helper's exit put Discord (1) and helm (null) back
    reg.apps[D].banner = 0;                          // Mantle is down; the user turns Discord's banners OFF in Settings
    const w0 = reg.writes.length;
    const r = await o.apply('the helper came back');
    check('14a the user\'s 0 after a put-back: Discord let go (released, not owned)', r.released.includes(D) && !o.owns(D) && o.released(D), r);
    check('14a ...its owned entry and its stamp are both dropped', !(D in store.rec().owned) && !(D in (store.rec().taken || {})) && store.rec().released.includes(D), store.rec());
    check('14a ...and it is never written', !reg.writes.slice(w0).some((x) => x.aumid === D) && reg.apps[D].banner === 0, reg.writes.slice(w0));
    check('14a helm (back to its original, no 0) is taken again as before', r.retook.includes(H) && reg.apps[H].banner === 0 && o.owns(H), r);
    check('14a one log line says how many and why', logs.filter((l) => /let 1 app\(s\) go/.test(l) && /put back while Mantle was not running/.test(l)).length === 1, logs);
    const q = await o.restore('quit', { keepReleased: true });
    check('14a the quit leaves their 0 alone and puts helm back', q.ok && reg.apps[D].banner === 0 && reg.apps[H].banner === null, { q, apps: reg.apps });
    const r2 = await o.apply('next start');
    check('14a the next start does not take it again', !r2.took.includes(D) && !r2.retook.includes(D) && reg.apps[D].banner === 0 && !o.owns(D), r2);
  }
  {
    // the same through restore(): a quit straight after the put-back and the user's 0
    const reg = fakeReg(APPS());
    const store = fakeStore();
    const logs = [];
    const o = createOwner({ reg, store, log: (l) => logs.push(l) });
    await o.apply('start');
    reg.apps[H].banner = 0;                          // helm stays Mantle's 0 (no put-back reached it)
    const rec = store.rec();
    reg.apps[D].banner = rec.owned[D];               // only Discord was put back (the script, by hand)
    store.back.push({ aumid: D, at: Date.now(), took: rec.taken ? rec.taken[D] : null, from: 'script' });
    reg.apps[D].banner = 0;                          // ...then the user turned it off themselves
    const w0 = reg.writes.length;
    const q = await o.restore('quit', { keepReleased: true });
    check('14b restore(): the user\'s 0 after a put-back is never written back', !reg.writes.slice(w0).some((x) => x.aumid === D) && reg.apps[D].banner === 0, reg.writes.slice(w0));
    check('14b restore(): ...let go (released, stamp dropped), and said', store.rec().released.includes(D) && !(D in store.rec().owned) && !(D in (store.rec().taken || {})) && logs.some((l) => /let 1 app\(s\) go/.test(l)), { rec: store.rec(), logs });
    check('14b restore(): Mantle\'s own 0 (helm) still goes back', reg.apps[H].banner === null && q.restored === 1, q);
  }

  // ---- 15. put back, and the value is still the original: taken again with a NEW stamp; a later 0
  //          with that old marker is Mantle's own (kept, put back at the quit)
  {
    let t = 1000;
    const reg = fakeReg(APPS());
    const store = fakeStore();
    const o = createOwner({ reg, store, now: () => t });
    await o.apply('start');
    const s1 = takenOf(store, D);
    check('15 a take is stamped with the clock', s1 === 1000 && takenOf(store, H) === 1000, store.rec());
    putBack(reg, store, 'supervisor');
    const r = await o.apply('Mantle came back at once (same clock)');
    const s2 = takenOf(store, D);
    check('15b back to its original: taken again', r.retook.includes(D) && reg.apps[D].banner === 0 && o.owns(D), r);
    check('15b ...with a NEW stamp even though the clock did not move', Number.isInteger(s2) && s2 !== s1 && s2 > s1, { s1, s2 });
    const w0 = reg.writes.length;
    const r2 = await o.apply('periodic');
    check('15b the old marker never makes Mantle\'s new 0 the user\'s: still owned, nothing written', o.owns(D) && !r2.released.includes(D) && reg.writes.length === w0, r2);
    t = 500;                                         // the clock jumps BACK; a second put-back and retake
    putBack(reg, store, 'sidecar');
    await o.apply('after a clock jump');
    const s3 = takenOf(store, D);
    check('15b a retake after a clock jump back still gets a fresh, larger stamp', Number.isInteger(s3) && s3 > s2, { s2, s3 });
    const q = await o.restore('quit', { keepReleased: true });
    check('15b ...and the quit puts Mantle\'s 0 back to the original', q.ok && q.restored === 2 && reg.apps[D].banner === 1 && reg.apps[H].banner === null, q);
  }

  // ---- 16. WRITE-AHEAD for the stamp: saved before the registry 0, on the take AND the retake road
  {
    let t = 5000;
    const reg = fakeReg(APPS());
    const store = fakeStore();
    const seen = [];
    reg.onWrite = (set) => { const rec = store.rec() || {}; seen.push({ ids: set.map((s) => s.aumid), taken: rec.taken || {} }); };
    const o = createOwner({ reg, store, now: () => t });
    await o.apply('start');
    check('16c take: the record on disk carries both stamps when the 0 is written', seen.length === 1 && seen[0].taken[D] === 5000 && seen[0].taken[H] === 5000, seen);
    putBack(reg, store, 'sidecar');
    t = 6000;
    await o.apply('retake');
    check('16c retake: the NEW stamp is on disk before the 0 is written', seen.length === 2 && seen[1].taken[D] === 6000 && seen[1].taken[H] === 6000 && takenOf(store, D) === 6000, seen);
    const reg2 = fakeReg(APPS());
    const store2 = fakeStore();
    store2.failSave = true;
    const o2 = createOwner({ reg: reg2, store: store2, now: () => t });
    const r = await o2.apply('start');
    check('16c a stamp that cannot be saved: nothing is written', r.ok === false && reg2.writes.length === 0, r);
    // a refused NEW take: dropped with its stamp
    const reg3 = fakeReg(APPS());
    const store3 = fakeStore();
    reg3.failFor.add(D);
    await createOwner({ reg: reg3, store: store3, now: () => t }).apply('start');
    check('16c a refused new take drops its stamp too', !(D in store3.rec().owned) && !(D in (store3.rec().taken || {})) && takenOf(store3, H) === 6000, store3.rec());
  }

  // ---- 17. an OLD record (no `taken`): a marker with took null = a put-back after the last take
  {
    const L = (x) => `Legacy.App${x}`;
    const reg = fakeReg({ [L('A')]: { banner: 0 }, [L('B')]: { banner: 0 }, [L('C')]: { banner: 1 }, [L('D')]: { banner: 0 } });
    const store = fakeStore({ v: 1, owned: { [L('A')]: 1, [L('B')]: null, [L('C')]: 1, [L('D')]: 1 }, released: [] });
    store.back = [
      { aumid: L('A').toLowerCase(), at: 1 },                      // no took at all = null; case-blind match
      { aumid: L('D'), at: 2, took: 1234 },                         // names a stamp the old record never had
    ];
    const o = createOwner({ reg, store, now: () => 7000 });
    const r = await o.apply('first start after the update');
    check('17d legacy: A (marker, took null) is the user\'s 0: let go', r.released.includes(L('A')) && !o.owns(L('A')), r);
    check('17d legacy: B (no marker) and D (a stamp that does not match) are still Mantle\'s', o.owns(L('B')) && o.owns(L('D')) && !r.released.includes(L('B')) && !r.released.includes(L('D')), r);
    check('17d legacy: C (back to its original) is taken again with a fresh stamp', r.retook.includes(L('C')) && takenOf(store, L('C')) === 7000 && reg.apps[L('C')].banner === 0, { r, rec: store.rec() });
    const q = await o.restore('quit', { keepReleased: true });
    check('17d legacy: the quit puts B, C and D back and leaves A at the user\'s 0', q.restored === 3 && reg.apps[L('A')].banner === 0 && reg.apps[L('B')].banner === null && reg.apps[L('C')].banner === 1 && reg.apps[L('D')].banner === 1, { q, apps: reg.apps });
  }
  {
    // load() keeps only finite-number stamps, only for apps still in owned
    const reg = fakeReg({ 'Odd.Stamp': { banner: 0 }, 'New.App': { banner: null } });
    const store = fakeStore({ v: 1, owned: { 'Odd.Stamp': 1 }, taken: { 'Odd.Stamp': '1000', 'Gone.App': 99 }, released: [] });
    store.back = [{ aumid: 'Odd.Stamp', at: 1, took: '1000' }];
    const o = createOwner({ reg, store, now: () => 8000 });
    await o.apply('start');
    const rec = store.rec();
    check('17d load(): a non-number stamp is dropped, and a marker naming it never matches', o.owns('Odd.Stamp') && !(rec.taken && 'Odd.Stamp' in rec.taken), rec);
    check('17d load(): a stamp for an app no longer owned is dropped', !(rec.taken && 'Gone.App' in rec.taken) && rec.taken && rec.taken['New.App'] === 8000, rec);
  }

  // ---- 18. a marker naming an OLD stamp never releases (it landed late, or it is from before a retake)
  {
    let t = 1000;
    const reg = fakeReg(APPS());
    const store = fakeStore();
    const o = createOwner({ reg, store, now: () => t });
    await o.apply('start');
    putBack(reg, store, 'sidecar');                  // took 1000
    t = 2000;
    await o.apply('retake');                         // stamp 2000, values 0 again (Mantle's)
    check('18e the retake stamped 2000', takenOf(store, D) === 2000, store.rec());
    store.back.push({ aumid: D, at: Date.now() + 60000, took: 1000, from: 'supervisor' });   // a late file, the OLD stamp
    store.back.push({ aumid: D, at: Date.now() + 60000, took: null, from: 'script' });       // no stamp
    store.back.push({ aumid: D, at: Date.now() + 60000, took: '2000', from: 'script' });     // not a number
    const r = await o.apply('periodic');
    check('18e old / null / string stamps never turn Mantle\'s 0 into the user\'s', o.owns(D) && !r.released.includes(D), r);
    const q = await o.restore('quit', { keepReleased: true });
    check('18e ...so the quit puts it back', q.restored === 2 && reg.apps[D].banner === 1, q);
  }

  // ---- 19. an unreadable marker is ignored (never throws), and said
  {
    const reg = fakeReg(APPS());
    const store = fakeStore();
    const logs = [];
    const o = createOwner({ reg, store, log: (l) => logs.push(l) });
    await o.apply('start');
    store.failBack = true;
    const r = await o.apply('periodic');
    check('19f loadBack() throwing: apply still works, nothing let go', r.ok && r.released.length === 0 && o.owns(D) && o.owns(H), r);
    check('19f ...and the log says the markers could not be read', logs.some((l) => /put-back marker/.test(l) && /could not be read/.test(l)), logs);
    const q = await o.restore('quit', { keepReleased: true });
    check('19f ...and the quit puts Mantle\'s 0s back', q.ok && q.restored === 2, q);
  }
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-owner-back-'));
    try {
      const rb = OWNER.readBackFiles;
      check('19f readBackFiles and the three marker names are exported', typeof rb === 'function' && Array.isArray(OWNER.BACK_FILES)
        && OWNER.BACK_FILES.join('|') === 'notif-banners-back.sidecar.json|notif-banners-back.supervisor.json|notif-banners-back.script.json', OWNER.BACK_FILES);
      if (typeof rb === 'function') {
        check('19f no files at all: no entries', Array.isArray(rb(dir)) && rb(dir).length === 0);
        check('19f a folder that is not there: no entries, no throw', (() => { try { return rb(path.join(dir, 'nope')).length === 0; } catch (_) { return false; } })());
        fs.writeFileSync(path.join(dir, 'notif-banners-back.sidecar.json'), '﻿' + JSON.stringify({ v: 1, back: { 'X.App': { at: 5, took: 7 }, 'Y.App': 3 } }));
        fs.writeFileSync(path.join(dir, 'notif-banners-back.supervisor.json'), '{"v":1,"back":{"X.App":{"at":');
        fs.writeFileSync(path.join(dir, 'notif-banners-back.script.json'), JSON.stringify({ v: 2, back: { 'X.App': { at: 9, took: 7 } } }));
        const e = rb(dir);
        check('19f a BOM file is read; a torn file, an unknown version and a non-object entry give no entries', e.length === 1 && e[0].aumid === 'X.App' && e[0].took === 7 && e[0].at === 5, e);
        // the owner with a real folder: the torn file is ignored, the good one still counts
        const reg = fakeReg({ 'X.App': { banner: 0 } });
        const store = fakeStore({ v: 1, owned: { 'X.App': 1 }, taken: { 'X.App': 7 }, released: [] });
        store.loadBack = () => rb(dir);
        const o = createOwner({ reg, store });
        const r = await o.apply('start');
        check('19f with a torn sibling file, a good marker naming the stamp still lets the app go', r.released.includes('X.App') && reg.writes.length === 0, r);
      }
    } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* temp */ } }
  }

  // ---- 20. a clock jump back onto an OLD marker's stamp never makes Mantle's own 0 "the user's"
  {
    let t = 1000;
    const reg = fakeReg({ [D]: { banner: 1 } });
    const store = fakeStore();
    const o = createOwner({ reg, store, now: () => t });
    await o.apply('start');                          // stamp 1000
    putBack(reg, store, 'supervisor');               // marker took 1000; value back to 1
    await o.restore('quit', { keepReleased: true }); // not 0: dropped with its stamp
    check('20 the quit dropped the app and its stamp', !(D in store.rec().owned) && !(D in (store.rec().taken || {})), store.rec());
    t = 1000;                                        // the clock is back on exactly the old stamp
    const r = await o.apply('next start');
    const s = takenOf(store, D);
    check('20 a new take never reuses a stamp a marker names', r.took.includes(D) && Number.isInteger(s) && s !== 1000, { r, s });
    const r2 = await o.apply('periodic');
    check('20 ...so Mantle\'s own 0 stays Mantle\'s (never left silently off)', o.owns(D) && !r2.released.includes(D), r2);
    const q = await o.restore('quit', { keepReleased: true });
    check('20 ...and is put back at the quit', q.restored === 1 && reg.apps[D].banner === 1, q);
  }

  // ---- 21. the record file keeps `taken` keyed exactly as `owned`
  {
    const reg = fakeReg({ 'Case.App': { banner: null } });
    const store = fakeStore();
    const o = createOwner({ reg, store, now: () => 4242.9 });
    await o.apply('start');
    const rec = store.rec();
    check('21 taken is keyed exactly as owned, and an integer', rec.taken && Object.keys(rec.taken).join('|') === Object.keys(rec.owned).join('|') && rec.taken['Case.App'] === 4242, rec);
  }

  console.log(`TOASTS OWNER TEST: ${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log('  FAIL ' + f);
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.log('TOASTS OWNER TEST: crashed: ' + (e && e.stack)); process.exit(1); });
