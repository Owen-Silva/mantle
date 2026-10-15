'use strict';
/*
 * _toasts-owner.test.js - the ShowBanner bookkeeping (lib/features/_toasts-owner.js) against a FAKE
 * registry and a FAKE record file: originals saved before any write, put back on every exit path, never
 * clobbered twice, Owen's own changes never overwritten, failures said. Pure node, no Windows.
 *   node lib/features/_toasts-owner.test.js   -> "TOASTS OWNER TEST: n passed, m failed"
 */
const { createOwner, leftToWindows } = require('./_toasts-owner');

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
  const S = { file: initial === undefined ? null : JSON.stringify(initial), saves: 0, failSave: false, failLoad: false };
  S.load = () => { if (S.failLoad) throw new Error('unexpected token in JSON'); return S.file ? JSON.parse(S.file) : null; };
  S.save = (r) => { if (S.failSave) throw new Error('EPERM: the disk said no'); S.file = JSON.stringify(r); S.saves++; };
  S.rec = () => (S.file ? JSON.parse(S.file) : null);
  return S;
}
const APPS = () => ({
  'com.owensilva.helm': { banner: null, enabled: null },        // never touched: Windows' default (on)
  'com.squirrel.Discord.Discord': { banner: 1, enabled: null }, // banner explicitly on
  'electron.app.Munder Difflin': { banner: 0, enabled: null },  // Owen already turned its banner off
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
    check('1 Owen\'s own banner-off app untouched and not owned', reg.apps['electron.app.Munder Difflin'].banner === 0 && !o.owns('electron.app.Munder Difflin'));
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
    check('4 Owen\'s own 0 still 0', reg.apps['electron.app.Munder Difflin'].banner === 0);
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

  // ---- 6. Owen changes an owned app himself: let go, never overwritten, not taken again until a fresh on
  {
    const reg = fakeReg(APPS());
    const store = fakeStore();
    const o = createOwner({ reg, store });
    await o.apply('start');
    reg.apps['com.owensilva.helm'].banner = 1;               // original was null; 1 is Owen's own choice
    const r = await o.apply('periodic');
    check('6 helm let go', r.released.includes('com.owensilva.helm') && !o.owns('com.owensilva.helm') && o.released('com.owensilva.helm'), r);
    check('6 his value stays', reg.apps['com.owensilva.helm'].banner === 1);
    const r2 = await o.apply('periodic again');
    check('6 not taken again on its own', !r2.took.includes('com.owensilva.helm') && reg.apps['com.owensilva.helm'].banner === 1, r2);
    const q = await o.restore('quit', { keepReleased: true });
    check('6 restore leaves his value alone', reg.apps['com.owensilva.helm'].banner === 1 && q.ok, q);
    check('6 quit keeps released', store.rec().released.includes('com.owensilva.helm'));
    const r3 = await o.apply('switch turned on', { fresh: true });
    check('6 a fresh on offers it again (original = his 1)', r3.took.includes('com.owensilva.helm') && store.rec().owned['com.owensilva.helm'] === 1, { r3, rec: store.rec() });
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

  console.log(`TOASTS OWNER TEST: ${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log('  FAIL ' + f);
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.log('TOASTS OWNER TEST: crashed: ' + (e && e.stack)); process.exit(1); });
