'use strict';
/* lib/notifications.test.js - main's half of the notification centre (lib/notifications.js), in node,
 * with a FAKE sidecar and a temp userData: no toast of the user's is read or touched.
 *
 *   node lib/notifications.test.js
 *
 * Covers what the bar may ask (notifs.get / seen / remove / clear / open), main's guard (only ids it
 * last showed), the plain words every on-screen reason must be, and replies the sidecar should never
 * send but might (null, a throw, an ok:false with a code in it). Quality pass 2026-09-29 (bar-ntf).
 * Prints "NOTIFICATIONS LIB TEST: n passed, m failed". */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-ntf-test-'));
// electron is not here in node: the one thing the module takes from it is app.getPath('userData')
const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === 'electron') return { app: { getPath: () => TMP } };
  return origLoad.apply(this, arguments);
};

let passed = 0; const fails = [];
const check = (name, ok, detail) => { if (ok) passed++; else fails.push(name + (detail !== undefined ? ' (' + JSON.stringify(detail).slice(0, 300) + ')' : '')); };
const JARGON = /sidecar|\bipc\b|hwnd|aumid|0x[0-9a-f]{4,}|\bE[A-Z]{4,}\b|undefined|\bnull\b|NaN|\[object|npm |exception/i;

const logs = [];
const origWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (s) => { if (String(s).startsWith('mantle: notifications:')) { logs.push(String(s)); return true; } return origWrite(s); };

function fakeSidecar() {
  const on = {};
  const sc = {
    status: 'idle', calls: [], answer: {},
    on: (ev, fn) => { (on[ev] = on[ev] || []).push(fn); },
    emit: (ev, p) => (on[ev] || []).forEach((fn) => fn(p)),
    call: async (cmd, args) => {
      sc.calls.push({ cmd, args });
      const a = sc.answer[args.op];
      if (typeof a === 'function') return a(args);
      return a;
    },
  };
  return sc;
}

const TOASTS = () => [
  { id: 11, aumid: 'App.A', app: 'A', title: 't1' },
  { id: 12, aumid: 'App.A', app: 'A', title: 't2' },
  { id: 13, aumid: 'App.B', app: 'B', title: 't3' },
];

(async () => {
  const N = require('./notifications.js');
  const T = N._test;
  const sc = fakeSidecar();
  const pushes = [];
  const ctx = { test: true, sidecar: sc, commands: {}, broadcast: (ch, p) => { if (ch === 'notifications') pushes.push(p); }, state: { set: () => {} } };
  sc.answer.list = () => ({ ok: true, available: true, via: 'listener+database', rev: 1, toasts: TOASTS() });
  sc.answer.watch = { ok: true, watching: true };
  N.start(ctx);
  const C = ctx.commands;
  check('start: the five bar commands are registered', ['notifs.get', 'notifs.seen', 'notifs.remove', 'notifs.clear', 'notifs.open'].every((k) => typeof C[k] === 'function'));

  // the sidecar comes up: watch + first read
  sc.emit('ready');
  await new Promise((r) => setTimeout(r, 20));
  const first = await C['notifs.get']();
  check('read: three toasts, all unread on a fresh profile', first.ok && first.count === 3 && first.unread === 3, first);
  check('replay: the bar\'s first frame gets the last list', N.replay('notifications').has === true && N.replay('other').has === false);

  // seen
  const s1 = await C['notifs.seen']({ ids: [11, 12, 999, 'x', 1.5] });
  check('seen: only listed ids count; the badge drops to 1', s1.ok && s1.unread === 1, s1);
  const file = JSON.parse(fs.readFileSync(path.join(TMP, 'notifications-seen.json'), 'utf8'));
  check('seen: stored in userData with no stranger ids', JSON.stringify(file.ids.sort()) === '[11,12]', file);

  // knownIds guard
  const big = Array.from({ length: 5000 }, (_, i) => (i % 3) + 11);
  check('guard: a huge id list is capped and de-duplicated', JSON.stringify(T.knownIds(big)) === '[11,12,13]' && T.knownIds(Array.from({ length: 600 }, () => 999)).length === 0);
  check('guard: non-arrays and non-integers are nothing', T.knownIds('11').length === 0 && T.knownIds([11.5, '12', null]).length === 1, T.knownIds([11.5, '12', null]));

  // remove: a NULL answer (was a TypeError: Cannot read properties of null)
  sc.answer.remove = null;
  let r, threw = null;
  try { r = await C['notifs.remove']({ ids: [11] }); } catch (e) { threw = e.message; }
  check('remove: a null sidecar answer is a plain failure, not a throw', !threw && r && r.ok === false && !JARGON.test(r.reason) && r.failed.length === 1 && r.failed[0].id === 11, threw || r);
  // remove: the sidecar throws
  sc.answer.remove = () => { throw new Error('sidecar request timed out (EPIPE)'); };
  r = await C['notifs.remove']({ ids: [11] });
  check('remove: a timeout says to try again, no code on screen', r.ok === false && !JARGON.test(r.reason) && /Try again/.test(r.reason), r);
  check('remove: the cause is in the log', logs.some((l) => /dismiss failed: sidecar request timed out/.test(l)));
  // remove: Windows kept one, with a code in its reason
  sc.answer.remove = { ok: false, removed: [], missing: [], failed: [{ id: 11, reason: 'Windows refused to dismiss it (0x80070005)' }], reason: '1 of 1 could not be dismissed: Windows refused to dismiss it (0x80070005)' };
  r = await C['notifs.remove']({ ids: [11] });
  check('remove: a refusal keeps its id, and no code reaches the screen', r.ok === false && r.failed[0].id === 11 && !JARGON.test(r.failed[0].reason) && !JARGON.test(r.reason), r);
  // remove: ids main never showed
  const callsBefore = sc.calls.length;
  r = await C['notifs.remove']({ ids: [424242] });
  check('remove: ids main never showed are refused without asking the sidecar', r.ok === false && sc.calls.length === callsBefore && !JARGON.test(r.reason), r);
  // remove: success passes through
  sc.answer.remove = (a) => ({ ok: true, removed: a.ids, missing: [], failed: [], reason: null });
  r = await C['notifs.remove']({ ids: [13, 11] });
  check('remove: success lists what went', r.ok === true && JSON.stringify(r.removed) === '[13,11]', r);

  // clear: one app, then all, only listed ids
  sc.calls.length = 0;
  await C['notifs.clear']({ aumid: 'app.a' });
  const clr = sc.calls.find((c) => c.args.op === 'remove');
  check('clear app: exactly that app\'s ids (case-insensitive), never Windows\' clear-everything', clr && JSON.stringify(clr.args.ids) === '[11,12]' && !sc.calls.some((c) => c.args.op === 'clear'), sc.calls);
  sc.calls.length = 0;
  await C['notifs.clear']({});
  const all = sc.calls.find((c) => c.args.op === 'remove');
  check('clear all: the ids main showed', all && all.args.ids.length === 3, sc.calls);

  // open
  sc.answer.open = null;
  r = await C['notifs.open']({ id: 12 });
  check('open: a null sidecar answer is a plain failure, not a throw', r && r.ok === false && !JARGON.test(r.reason), r);
  sc.answer.open = (a) => ({ ok: true, via: 'app', dismissed: true, note: 'x', reason: null, echo: a.toast });
  sc.calls.length = 0;
  r = await C['notifs.open']({ id: 12 });
  check('open: sent as `toast`, never `id` (the protocol\'s own request id)', sc.calls[0] && sc.calls[0].args.toast === 12 && sc.calls[0].args.id === undefined && r.ok === true, sc.calls[0]);
  sc.answer.open = { ok: false, reason: 'Apps.Launch failed: HRESULT 0x80004005' };
  r = await C['notifs.open']({ id: 12 });
  check('open: a technical refusal becomes plain words', r.ok === false && !JARGON.test(r.reason), r);
  r = await C['notifs.open']({ id: 'nope' });
  check('open: an id main never showed is refused', r.ok === false && !JARGON.test(r.reason), r);

  // read failures: the payload the bell and the panel show
  sc.answer.list = () => { throw new Error('sidecar exited (EPIPE)'); };
  logs.length = 0;
  const bad = await C['notifs.get']();
  await new Promise((res) => setTimeout(res, 5));
  pushes.length = 0;
  sc.emit('notifications', { rev: 99 });
  await new Promise((res) => setTimeout(res, 20));
  const bad2 = pushes[pushes.length - 1];
  check('read fails: ok:false with a plain reason', bad2 && bad2.ok === false && !JARGON.test(bad2.reason), bad2);
  sc.emit('notifications', { rev: 100 });
  await new Promise((res) => setTimeout(res, 20));
  check('read fails: the same failure is logged once, not every poll', logs.filter((l) => /could not be read: sidecar exited/.test(l)).length === 1, logs);
  sc.answer.list = () => { throw new Error('unknown command: notifications'); };
  sc.emit('notifications', { rev: 101 });
  await new Promise((res) => setTimeout(res, 20));
  check('old exe: says Mantle needs updating, not "npm run build:sidecar"', pushes[pushes.length - 1].reason === T.SAY.oldExe);
  sc.answer.list = () => ({ ok: false, available: false, access: 'Denied', reason: 'Windows is not letting apps read your notifications (Settings > Privacy & security > Notifications)', toasts: [] });
  sc.emit('notifications', { rev: 102 });
  await new Promise((res) => setTimeout(res, 20));
  check('denied: a plain sidecar reason is kept as is (it names the fix)', /Privacy & security/.test(pushes[pushes.length - 1].reason));
  sc.answer.list = () => ({ ok: true, available: true, rev: 5, detail: 'wpndatabase.db could not be opened (SQLITE_CANTOPEN 0x0000000E)', toasts: TOASTS() });
  sc.emit('notifications', { rev: 103 });
  await new Promise((res) => setTimeout(res, 20));
  const plainP = pushes[pushes.length - 1];
  check('plainer source: the detail is one plain sentence, the cause is logged', plainP.detail === T.SAY.plainSource && logs.some((l) => /plainer source: wpndatabase/.test(l)), plainP.detail);
  check('shape: payload reason null when fine', plainP.ok === true && plainP.reason === null);

  // the seen file: written whole through a .tmp and a rename (mn-recover); a crash mid-write keeps the old list
  {
    const S = T.S;
    const keepFile = S.seenFile, keepSeen = Array.from(S.seen), keepNote = S.seenNote;
    const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-ntf-seen-'));
    const F = path.join(DIR, 'notifications-seen.json');
    S.seenFile = F;
    const realWrite = fs.writeFileSync, realRename = fs.renameSync;
    const writes = [], renames = [];
    fs.writeFileSync = function (p) { writes.push(path.basename(String(p))); return realWrite.apply(fs, arguments); };
    fs.renameSync = function (a, b) { renames.push([path.basename(String(a)), path.basename(String(b))]); return realRename.apply(fs, arguments); };
    S.seen.clear(); [21, 22].forEach((id) => S.seen.add(id));
    T.saveSeen();
    check('seen save: written to a .tmp, then renamed over the file', writes.join() === 'notifications-seen.json.tmp' &&
      JSON.stringify(renames) === '[["notifications-seen.json.tmp","notifications-seen.json"]]', { writes, renames });
    check('seen save: the file is whole JSON, and no .tmp is left', JSON.stringify(JSON.parse(fs.readFileSync(F, 'utf8')).ids) === '[21,22]' && !fs.existsSync(F + '.tmp'));
    // a crash mid-write: half of the new list lands in the .tmp, then the write throws
    fs.writeFileSync = function (p, data) { realWrite.call(fs, p, String(data).slice(0, 5)); const e = new Error('crash mid-write'); e.code = 'EIO'; throw e; };
    S.seen.add(23); logs.length = 0;
    T.saveSeen();
    check('a write that fails half way: the previous file is intact', fs.readFileSync(F, 'utf8') === '{"ids":[21,22]}', fs.readFileSync(F, 'utf8'));
    check('a write that fails half way: said in plain words, the code logged', S.seenNote === T.SAY.seenSave && logs.some((l) => /could not be saved \(EIO\)/.test(l)), logs);
    fs.writeFileSync = realWrite;
    // the rename refused (Windows: the file held open): the previous file is intact, said the same way
    fs.renameSync = function () { const e = new Error('operation not permitted'); e.code = 'EPERM'; throw e; };
    logs.length = 0;
    T.saveSeen();
    check('a rename that fails: the previous file is intact and it is said', fs.readFileSync(F, 'utf8') === '{"ids":[21,22]}' && S.seenNote === T.SAY.seenSave && logs.some((l) => /could not be saved \(EPERM\)/.test(l)), logs);
    fs.renameSync = realRename;
    // the stale half .tmp left behind is harmless: load ignores it, the next save replaces it
    S.seen.clear(); S.seenNote = null;
    T.loadSeen();
    check('a stale .tmp from a crash is never read: the last whole list loads', fs.existsSync(F + '.tmp') && JSON.stringify(Array.from(S.seen).sort()) === '[21,22]' && S.seenNote === null, Array.from(S.seen));
    S.seen.add(23); T.saveSeen();
    check('...and the next save replaces it', JSON.stringify(JSON.parse(fs.readFileSync(F, 'utf8')).ids) === '[21,22,23]' && !fs.existsSync(F + '.tmp') && S.seenNote === null);
    // a corrupt or half main file (written by an older Mantle that wrote in place) loads as an empty list, with a reason
    for (const [what, body] of [['half', '{"ids":[21,2'], ['not the shape', '{"seen":5}']]) {
      fs.writeFileSync(F, body);
      S.seen.clear(); S.seenNote = null; logs.length = 0;
      let threw = null; try { T.loadSeen(); } catch (e) { threw = e.message; }
      check(`a ${what} seen file: loads as nothing seen, said in plain words, a reason logged`, !threw && S.seen.size === 0 && S.seenNote === T.SAY.seenRead &&
        logs.length === 1 && /seen list (could not be read \(it is not whole JSON\)|was not in the expected shape)/.test(logs[0]) && !logs[0].includes(DIR), { threw, logs });
    }
    fs.rmSync(DIR, { recursive: true, force: true });
    S.seenFile = keepFile; S.seen.clear(); keepSeen.forEach((id) => S.seen.add(id)); S.seenNote = keepNote;
  }

  // seen file cannot be written
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.writeFileSync(TMP, 'a file where the folder was');   // userData is now a file: every write fails
  sc.answer.list = () => ({ ok: true, available: true, rev: 6, toasts: TOASTS().concat([{ id: 14, aumid: 'App.C', app: 'C' }]) });
  sc.emit('notifications', { rev: 104 });
  await new Promise((res) => setTimeout(res, 20));
  await C['notifs.seen']({ ids: [14] });
  const last = pushes[pushes.length - 1];
  check('seen not saved: said in plain words on the payload', last.seenNote === T.SAY.seenSave && !JARGON.test(last.seenNote), last.seenNote);
  fs.rmSync(TMP, { force: true });

  process.stdout.write = origWrite;
  for (const f of fails) console.log('  FAIL ' + f);
  console.log(`NOTIFICATIONS LIB TEST: ${passed} passed, ${fails.length} failed`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { process.stdout.write = origWrite; console.log('NOTIFICATIONS LIB TEST: 0 passed, 1 failed'); console.log('  FAIL the test threw: ' + (e.stack || e.message)); process.exit(1); });
