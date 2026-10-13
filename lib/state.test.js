'use strict';
/*
 * state.test.js -- lib/state.js's snapshot (lane mn-state, 2026-10-12).
 *
 * get() hands out ONE deep-frozen snapshot, rebuilt copy-on-write by set(), instead of a fresh deep
 * copy per read. What must still hold, and is proved here against the REAL ShellState:
 *   - no caller can change State through what get() or a 'change' event gave it (every level is
 *     frozen: a write throws in strict code and does nothing in sloppy code);
 *   - an object passed to set() and changed afterwards does not reach State;
 *   - what get() returns is exactly what the old JSON deep copy returned, for a long run of sets
 *     (a reference model replays the old merge rules, the taskbar `hidden` mirror included);
 *   - an unchanged piece keeps its identity across a set (the tray compares pieces that way), a
 *     moved one gets a new object, and an old snapshot never changes under its holder;
 *   - set() of nothing new returns false, emits nothing and keeps the same snapshot;
 *   - a read is cheap (timed against the old deep copy; printed, and bounded loosely).
 *
 *   node lib/state.test.js
 */
const vm = require('vm');
const { ShellState, initialState } = require('./state');

let passed = 0;
const failures = [];
function check(name, ok, detail) { if (ok) passed++; else failures.push(name + (detail !== undefined ? ' -- ' + JSON.stringify(detail) : '')); }
function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
function throws(fn) { try { fn(); return null; } catch (err) { return err; } }
function frozenAll(v, path, bad) {
  if (v && typeof v === 'object') {
    if (!Object.isFrozen(v)) bad.push(path || '(top)');
    for (const k of Object.keys(v)) frozenAll(v[k], `${path}.${k}`, bad);
  }
  return bad;
}

/* ---- frozen, and the same object until something changes ------------------------------------ */
{
  const s = new ShellState('test', 'bottom');
  const a = s.get();
  check('get: the same object twice when nothing changed', a === s.get());
  check('get: every level is frozen at start', frozenAll(a, '', []).length === 0, frozenAll(a, '', []));
  check('get: the start shape is initialState exactly', JSON.stringify(a) === JSON.stringify(initialState('test', 'bottom')));

  const before = JSON.stringify(a);
  const e1 = throws(() => { a.sidecar.status = 'ok'; });
  const e2 = throws(() => { a.backdrop.bar.fps = 99; });
  const e3 = throws(() => { a.brandNew = 1; });
  const e4 = throws(() => { delete a.mode; });
  const e5 = throws(() => { a.sidecar = { status: 'ok' }; });
  check('strict write to a piece field throws', e1 instanceof TypeError, String(e1));
  check('strict write two levels down throws', e2 instanceof TypeError, String(e2));
  check('strict add of a top-level key throws', e3 instanceof TypeError, String(e3));
  check('strict delete of a top-level key throws', e4 instanceof TypeError, String(e4));
  check('strict replace of a whole piece throws', e5 instanceof TypeError, String(e5));
  check('after every refused write State is unchanged', JSON.stringify(s.get()) === before);

  // Sloppy code (a vm script without 'use strict'): the writes do nothing, and say nothing.
  const sloppy = vm.runInNewContext('snap.sidecar.status = "ok"; snap.extra = 1; snap.backdrop.bar.fps = 3; delete snap.mode; "done"', { snap: a });
  check('sloppy writes run without throwing', sloppy === 'done');
  check('sloppy writes leave State unchanged', JSON.stringify(s.get()) === before && s.get().sidecar.status === 'starting');
  check('problems() still reads the frozen State', s.problems().some((p) => p.piece === 'sidecar'), s.problems().map((p) => p.piece));
}

/* ---- set(): copy-on-write, identity, events ------------------------------------------------- */
{
  const s = new ShellState('live', 'top');
  const events = [];
  s.on('change', (snap) => events.push(snap));
  const a = s.get();
  check('set: a real change returns true', s.set('sidecar', { status: 'ok', reason: 'answering' }) === true);
  const b = s.get();
  check('set: one change event, carrying the new snapshot', events.length === 1 && events[0] === b);
  check('set: the event snapshot is frozen', frozenAll(events[0], '', []).length === 0);
  check('set: a new top-level object', a !== b);
  check('set: the moved piece is a new object', a.sidecar !== b.sidecar && b.sidecar.status === 'ok');
  check('set: unmoved pieces keep their identity', a.taskbar === b.taskbar && a.backdrop === b.backdrop && a.features === b.features);
  check('set: the OLD snapshot never changes under its holder', a.sidecar.status === 'starting' && Object.isFrozen(a));

  check('set: the same patch again returns false', s.set('sidecar', { status: 'ok' }) === false);
  check('set: ...emits nothing', events.length === 1);
  check('set: ...and keeps the same snapshot', s.get() === b);

  // An object handed to set() and changed afterwards must not reach State.
  const mine = { bar: { on: true, ok: true, fps: 4, ms: 12, reason: 'running' } };
  s.set('backdrop', mine);
  mine.bar.fps = 60;
  mine.bar.reason = 'changed behind State';
  mine.extra = { x: 1 };
  check('set: a caller changing its own patch later does not reach State', s.get().backdrop.bar.fps === 4 && s.get().backdrop.bar.reason === 'running' && !s.get().backdrop.extra, s.get().backdrop.bar);
  check('set: the new nested piece is frozen too', Object.isFrozen(s.get().backdrop.bar));
  check('set: the caller\'s own object is NOT frozen (only State\'s copy is)', !Object.isFrozen(mine.bar));

  // A piece that did not exist before (features, notifications) comes in frozen.
  s.set('features', { vol: { label: 'Volume', on: true, ok: true, reason: 'working' } });
  check('set: a new piece arrives frozen', Object.isFrozen(s.get().features) && Object.isFrozen(s.get().features.vol));

  // The taskbar mirror still holds.
  s.set('taskbar', { autohide: true, reason: 'auto-hide on' });
  check('taskbar: hidden mirrors autohide (true)', s.get().taskbar.hidden === true);
  s.set('taskbar', { autohide: false, hidden: true });
  check('taskbar: hidden mirrors autohide (false, whatever the patch said)', s.get().taskbar.hidden === false);

  // A listener that tries to scribble on the event snapshot is refused and State stays right.
  const s2 = new ShellState('test', 'bottom');
  let refused = null;
  s2.on('change', (snap) => { refused = throws(() => { snap.glass.material = 'scribbled'; }); });
  s2.set('glass', { material: 'acrylic-blur-behind', reason: 'on' });
  check('a change listener cannot change State through its snapshot', refused instanceof TypeError && s2.get().glass.material === 'acrylic-blur-behind');
}

/* ---- the same answers as the old deep copy, for a long run of sets -------------------------- */
{
  const s = new ShellState('test', 'bottom');
  const ref = JSON.parse(JSON.stringify(initialState('test', 'bottom')));   // the old model: merge, then copy on read
  const refSet = (piece, patch) => {
    const before = JSON.stringify(ref[piece]);
    ref[piece] = Object.assign({}, ref[piece], patch);
    if (piece === 'taskbar') ref[piece].hidden = ref[piece].autohide === true;
    return JSON.stringify(ref[piece]) !== before;
  };
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const pieces = ['sidecar', 'taskbar', 'backdrop', 'features', 'switcher', 'glass', 'shortcuts', 'notifications'];
  let mismatch = null, retMismatch = 0;
  for (let i = 0; i < 3000 && !mismatch; i++) {
    const piece = pieces[rnd(pieces.length)];
    const patch = {};
    const k = ['status', 'reason', 'on', 'autohide', 'fps', 'list', 'nested', 'gone'][rnd(8)];
    const v = [true, false, 'ok', 'down', rnd(5), undefined, null, [1, rnd(3)], { a: rnd(3), b: { c: rnd(2) } }][rnd(9)];
    patch[k] = v;
    const r1 = s.set(piece, patch);
    const r2 = refSet(piece, patch);
    if (r1 !== r2) retMismatch++;
    // Compared with sorted keys: a key set to undefined drops out of the frozen copy, so when it comes
    // back it is listed last. Key ORDER is the one thing that may differ; no reader depends on it.
    if (canon(s.get()) !== canon(JSON.parse(JSON.stringify(ref)))) mismatch = { i, piece, patch };
  }
  check('3000 random sets: get() equals the old deep copy every time', mismatch === null, mismatch);
  check('3000 random sets: set() says "changed" exactly when the old one did', retMismatch === 0, retMismatch);
  check('3000 random sets: still frozen all the way down', frozenAll(s.get(), '', []).length === 0);
}

/* ---- a read is cheap ------------------------------------------------------------------------ */
{
  const s = new ShellState('test', 'bottom');
  // A State about the size of the live one (~8 KB: mn-speed measured 8.3 KB): twenty features.
  const feats = {};
  for (let i = 0; i < 20; i++) feats[`f${i}`] = { label: `Feature ${i}`, on: true, ok: true, reason: 'working, and saying so in a full sentence', keys: true, keysReason: 'Win+Alt+N, Win+V: Mantle\'s', broken: null, stopped: false };
  s.set('features', feats);
  const N = 20000;
  let t = process.hrtime.bigint();
  let sink = 0;
  for (let i = 0; i < N; i++) sink += JSON.parse(JSON.stringify(s.data)).features.f3.on ? 1 : 0;
  const oldMs = Number(process.hrtime.bigint() - t) / 1e6;
  t = process.hrtime.bigint();
  for (let i = 0; i < N; i++) sink += s.get().features.f3.on ? 1 : 0;
  const newMs = Number(process.hrtime.bigint() - t) / 1e6;
  console.log(`  read cost: ${N} reads of a ${JSON.stringify(s.get()).length}-byte State: old deep copy ${oldMs.toFixed(1)} ms, snapshot ${newMs.toFixed(2)} ms`);
  check('read: the snapshot is at least 50x cheaper than the old deep copy', newMs * 50 < oldMs, { oldMs, newMs, sink });
}

console.log(`STATE TEST: ${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log('  FAIL ' + f);
process.exit(failures.length ? 1 : 0);
