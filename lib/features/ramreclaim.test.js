'use strict';
/* ramreclaim.test.js — "Windows pieces Mantle replaces" (lane mantle-ramreclaim, 2026-10-15).
 *
 * PART 1 (core, fake registry + the real file journal in a temp folder): recorded BEFORE applied, never
 * applied twice (also across a crash), a value Windows already had is neither recorded nor undone, undo
 * on the switch / feature off / quit / restore, Windows ending the session keeps the sign-in pieces, a
 * value changed outside Mantle is left alone, Windows refusing a write, a journal that cannot be written
 * changes nothing, the allowlist, a failed undo kept for the next try, reg.exe's arguments and answers,
 * memory measured over a process tree.
 * PART 2 (the feature on a fake ctx): defaults, the list / set commands, the tray switch, stop() on quit
 * and on session end, a test run writes nothing, the feature contract (lib/features.js validate).
 * PART 3 (tools/ramreclaim-undo.ps1, the no-Mantle road): run on a scratch key HKCU\Software\MantleTest\
 * ramreclaim-<pid> (deleted after), with -AllowTestKeys; and without it, the same entry is left alone.
 * Never touches a real Windows setting.
 *
 *   node lib/features/ramreclaim.test.js        Prints "RAMRECLAIM TEST: n passed, m failed".
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const core = require('./_ramreclaim-core');

let passed = 0;
const failures = [];
const check = (name, ok, detail) => { if (ok) passed++; else failures.push(detail != null ? `${name} (${String(detail).slice(0, 300)})` : name); return ok; };
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ramreclaim-test-'));
let nTmp = 0;
const journalPath = () => path.join(tmpRoot, `j${++nTmp}`, 'ramreclaim-journal.json');

const W = core.pieceById('widgets-prelaunch'), S = core.pieceById('search-highlights'), L = core.pieceById('lockscreen-widgets');
const K = (p) => `${p.hive}\\${p.key}|${p.name}`.toLowerCase();

/* A fake registry: values by hive\key|name; every write logged; a hook can see the journal at write time. */
function fakeReg(init) {
  const vals = new Map(Object.entries(init || {}));
  const r = {
    vals, writes: [], fail: {}, failRead: {}, onWrite: null,
    async read(hive, key, name) {
      const k = `${hive}\\${key}|${name}`.toLowerCase();
      if (r.failRead[k]) return { ok: false, reason: r.failRead[k] };
      return vals.has(k) ? { ok: true, exists: true, data: vals.get(k) } : { ok: true, exists: false, data: null };
    },
    async write(hive, key, name, type, data) {
      const k = `${hive}\\${key}|${name}`.toLowerCase();
      if (r.onWrite) r.onWrite(k, data);
      r.writes.push({ op: 'write', k, data });
      if (r.fail[k]) return { ok: false, reason: r.fail[k] };
      vals.set(k, Number(data)); return { ok: true };
    },
    async remove(hive, key, name) {
      const k = `${hive}\\${key}|${name}`.toLowerCase();
      r.writes.push({ op: 'remove', k });
      if (r.fail[k]) return { ok: false, reason: r.fail[k] };
      vals.delete(k); return { ok: true };
    },
  };
  return r;
}
const mk = (reg, file) => core.createReclaim({ reg, store: core.fileStore(file, fs), now: () => Date.parse('2026-10-15T20:00:00Z') });
const readJ = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; } };
const both = new Set(['widgets-prelaunch', 'search-highlights']);

async function part1() {
  // record BEFORE apply, then apply
  {
    const file = journalPath();
    const reg = fakeReg({ [K(W)]: 1 });   // search highlights: not set (Windows' default)
    let seenAtWrite = null;
    reg.onWrite = (k) => { if (k === K(W) && !seenAtWrite) seenAtWrite = readJ(file); };
    const R = mk(reg, file);
    const out = await R.sync(both);
    check('core: the journal held the entry BEFORE the registry write', seenAtWrite && seenAtWrite.entries['widgets-prelaunch'] && seenAtWrite.entries['widgets-prelaunch'].data === 1 && seenAtWrite.entries['widgets-prelaunch'].existed === true, JSON.stringify(seenAtWrite));
    check('core: both default pieces applied', out['widgets-prelaunch'].state === 'applied' && out['search-highlights'].state === 'applied' && reg.vals.get(K(W)) === 0 && reg.vals.get(K(S)) === 0, JSON.stringify(out));
    check('core: a value that did not exist is recorded as not existing', readJ(file).entries['search-highlights'].existed === false);
    check('core: the lock screen piece (default off) untouched', !reg.vals.has(K(L)) && !readJ(file).entries['lockscreen-widgets']);
    // never twice: a second sync writes nothing and keeps the ORIGINAL
    const n0 = reg.writes.length;
    await R.sync(both);
    check('core: a second sync writes nothing', reg.writes.length === n0, JSON.stringify(reg.writes.slice(n0)));
    // a crash: a fresh engine over the same journal and the same (changed) registry
    const R2 = mk(reg, file);
    await R2.sync(both);
    check('core: after a crash, nothing applied twice', reg.writes.length === n0);
    check('core: after a crash, the original is still Windows’ (1), not Mantle’s (0)', readJ(file).entries['widgets-prelaunch'].data === 1);
    // quit: everything back
    const q = await R2.undoAll({});
    check('core: quit puts both back', q.ok && reg.vals.get(K(W)) === 1 && !reg.vals.has(K(S)), JSON.stringify([...reg.vals]));
    check('core: quit empties the journal', Object.keys(readJ(file).entries).length === 0);
    const n1 = reg.writes.length;
    await R2.undoAll({});
    check('core: a second quit writes nothing', reg.writes.length === n1);
  }
  // Windows already had it off: not recorded, not undone
  {
    const file = journalPath();
    const reg = fakeReg({ [K(W)]: 0 });
    const R = mk(reg, file);
    const out = await R.sync(new Set(['widgets-prelaunch']));
    check('core: already off = nothing written, nothing recorded', out['widgets-prelaunch'].state === 'already' && reg.writes.length === 0 && !(readJ(file) || { entries: {} }).entries['widgets-prelaunch']);
    await R.undoAll({});
    check('core: ...and nothing undone', reg.writes.length === 0 && reg.vals.get(K(W)) === 0);
  }
  // the switch off, then on again; the feature off (empty set)
  {
    const file = journalPath();
    const reg = fakeReg({ [K(W)]: 1, [K(L)]: 1 });
    const R = mk(reg, file);
    await R.sync(new Set(['widgets-prelaunch', 'lockscreen-widgets']));
    const off = await R.set('lockscreen-widgets', false);
    check('core: switch off puts it back', off.state === 'off' && reg.vals.get(K(L)) === 1 && !readJ(file).entries['lockscreen-widgets']);
    const on = await R.set('lockscreen-widgets', true);
    check('core: switch on again records and applies', on.state === 'applied' && reg.vals.get(K(L)) === 0 && readJ(file).entries['lockscreen-widgets'].data === 1);
    await R.sync(new Set());
    check('core: feature off = everything back', reg.vals.get(K(W)) === 1 && reg.vals.get(K(L)) === 1 && Object.keys(readJ(file).entries).length === 0);
    const bad = await R.set('search-window', true);
    check('core: a listed piece cannot be switched', bad.state === 'error' && reg.writes.every((w) => !/policies/i.test(w.k)));
  }
  // Windows ending the session keeps the sign-in pieces; the next start keeps them without writing
  {
    const file = journalPath();
    const reg = fakeReg({ [K(W)]: 1 });
    const R = mk(reg, file);
    await R.sync(both);
    const r = await R.undoAll({ keepSignOut: true });
    check('core: session end keeps the sign-in pieces off', r.ok && reg.vals.get(K(W)) === 0 && reg.vals.get(K(S)) === 0);
    check('core: ...recorded as kept, still in the journal', readJ(file).entries['widgets-prelaunch'].keptForSignOut && readJ(file).entries['search-highlights'].keptForSignOut);
    const n = reg.writes.length;
    const R2 = mk(reg, file);
    const out = await R2.sync(both);
    check('core: next start: still off, no write, original kept', reg.writes.length === n && out['widgets-prelaunch'].state === 'applied' && readJ(file).entries['widgets-prelaunch'].data === 1);
    check('core: next start clears the kept mark', !readJ(file).entries['widgets-prelaunch'].keptForSignOut);
    const R3 = mk(reg, file);
    await R3.sync(new Set(['search-highlights']));   // Owen turned one off while Mantle was down
    check('core: next start puts back what is no longer wanted', reg.vals.get(K(W)) === 1 && reg.vals.get(K(S)) === 0);
  }
  // changed outside Mantle: left alone, said
  {
    const file = journalPath();
    const reg = fakeReg({ [K(W)]: 1 });
    const R = mk(reg, file);
    await R.sync(new Set(['widgets-prelaunch']));
    reg.vals.set(K(W), 5);
    const st = await R.status(new Set(['widgets-prelaunch']), true);
    check('core: status shows Windows turned it back on (drift), no write', st.rows.find((x) => x.id === 'widgets-prelaunch').state === 'drift');
    const n = reg.writes.length;
    const u = await R.set('widgets-prelaunch', false);
    check('core: undo leaves a value changed outside Mantle', reg.writes.length === n && reg.vals.get(K(W)) === 5 && /outside Mantle/.test(u.reason || '') && !readJ(file).entries['widgets-prelaunch'], JSON.stringify(u));
    // drift fixed at the next sync without recording again
    await R.set('widgets-prelaunch', true);   // records 5 as the original now (Windows' value at that time)
    reg.vals.set(K(W), 1);
    const again = await R.sync(new Set(['widgets-prelaunch']));
    check('core: drift re-applied at sync, the record untouched', reg.vals.get(K(W)) === 0 && readJ(file).entries['widgets-prelaunch'].data === 5 && /turned this back on/.test(again['widgets-prelaunch'].reason || ''));
  }
  // Windows refuses the write; the journal cannot be written; a read fails
  {
    const file = journalPath();
    const reg = fakeReg({ [K(W)]: 1 });
    reg.fail[K(W)] = 'Windows refused the change (Access is denied.)';
    const R = mk(reg, file);
    const out = await R.sync(new Set(['widgets-prelaunch']));
    check('core: a refused write says why', out['widgets-prelaunch'].state === 'error' && /Access is denied/.test(out['widgets-prelaunch'].reason));
    check('core: ...and leaves no record (Windows still has its value)', !readJ(file).entries['widgets-prelaunch'] && reg.vals.get(K(W)) === 1);
    const st = await R.status(new Set(['widgets-prelaunch']), true);
    check('core: status shows the error with its reason', st.rows.find((x) => x.id === 'widgets-prelaunch').state === 'error');
  }
  {
    const reg = fakeReg({ [K(W)]: 1 });
    const R = core.createReclaim({ reg, store: { load: () => ({ v: 1, entries: {} }), save() { throw new Error('the disk is full'); } } });
    const out = await R.sync(new Set(['widgets-prelaunch']));
    check('core: no undo record = no change', out['widgets-prelaunch'].state === 'error' && reg.writes.length === 0 && /could not write its undo record/.test(out['widgets-prelaunch'].reason));
  }
  {
    const file = journalPath();
    const reg = fakeReg({ [K(W)]: 1 });
    reg.failRead[K(W)] = 'Windows would not say what it is set to (x)';
    const R = mk(reg, file);
    const out = await R.sync(new Set(['widgets-prelaunch']));
    check('core: an unreadable value is not changed', out['widgets-prelaunch'].state === 'error' && reg.writes.length === 0);
  }
  // a failed undo stays for the next try
  {
    const file = journalPath();
    const reg = fakeReg({ [K(W)]: 1 });
    const R = mk(reg, file);
    await R.sync(new Set(['widgets-prelaunch']));
    reg.fail[K(W)] = 'Windows refused the change (busy)';
    const q = await R.undoAll({});
    check('core: a failed undo is reported', !q.ok && /busy/.test(q.reason || ''));
    check('core: ...and kept in the journal', !!readJ(file).entries['widgets-prelaunch']);
    delete reg.fail[K(W)];
    const q2 = await R.undoAll({});
    check('core: the next try puts it back', q2.ok && reg.vals.get(K(W)) === 1 && !readJ(file).entries['widgets-prelaunch']);
  }
  // the allowlist: an entry naming something else is never written
  {
    const file = journalPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ v: 1, entries: {
      evil: { hive: 'HKCU', key: 'Software\\Microsoft\\Windows\\CurrentVersion\\Run', name: 'Bad', type: 'REG_DWORD', existed: true, data: 1, target: 0 },
      'widgets-prelaunch': { hive: 'HKLM', key: W.key, name: W.name, type: 'REG_DWORD', existed: true, data: 1, target: 0 },
    } }));
    const reg = fakeReg({ ['hkcu\\software\\microsoft\\windows\\currentversion\\run|bad']: 0, [K(W)]: 0 });
    const R = mk(reg, file);
    await R.sync(new Set());
    await R.undoAll({});
    check('core: allowlist: nothing outside it is ever written', reg.writes.length === 0, JSON.stringify(reg.writes));
    check('core: allowlist: unknown entries are kept, not acted on', !!readJ(file).entries.evil);
    check('core: allowed() refuses HKLM and other keys', !core.allowed({ hive: 'HKLM', key: W.key, name: W.name, type: 'REG_DWORD' }) && core.allowed({ hive: 'HKCU', key: W.key, name: W.name, type: 'REG_DWORD' }));
  }
  // every switch piece is HKCU + DWORD, the listed ones carry a reason, the .ps1 allowlist matches
  {
    check('table: switches are HKCU number values only', core.switches().every((p) => p.hive === 'HKCU' && p.type === 'REG_DWORD' && Number.isInteger(p.target)));
    check('table: default ON only for switches', core.PIECES.every((p) => !p.defaultOn || p.kind === 'switch'));
    check('table: every listed / kept piece says why', core.PIECES.filter((p) => p.kind !== 'switch').every((p) => (p.why || p.help)));
    const ps1 = fs.readFileSync(path.join(__dirname, '..', '..', 'tools', 'ramreclaim-undo.ps1'), 'utf8').toLowerCase();
    check('table: tools/ramreclaim-undo.ps1 allows exactly the switch values', core.switches().every((p) => ps1.includes(`'${(p.key + '|' + p.name).toLowerCase()}'`)) && (ps1.match(/^\s+'software\\[^']+\|[^']+'/gm) || []).length === core.switches().length);
  }
  // reg.exe: arguments and answers (a fake execFile; nothing runs)
  {
    const calls = [];
    let answer = { err: null, out: '', errText: '' };
    const fakeExec = (cmd, args, opts, cb) => { calls.push({ cmd, args, opts }); const e = answer.err; setImmediate(() => cb(e, answer.out, answer.errText)); };
    const real = core.realRegistry(fakeExec);
    answer = { err: null, out: '\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Dsh\r\n    IsPrelaunchEnabled    REG_DWORD    0x1\r\n\r\n', errText: '' };
    let r = await real.read('HKCU', W.key, W.name);
    check('reg.exe: query args', calls[0].cmd === 'reg.exe' && calls[0].args.join(' ') === `query HKCU\\${W.key} /v IsPrelaunchEnabled` && calls[0].opts.windowsHide === true);
    check('reg.exe: a DWORD is read', r.ok && r.exists && r.data === 1, JSON.stringify(r));
    answer = { err: Object.assign(new Error('exit 1'), { code: 1 }), out: '', errText: 'ERROR: The system was unable to find the specified registry key or value.\r\n' };
    r = await real.read('HKCU', L.key, L.name);
    check('reg.exe: missing = not existing', r.ok && r.exists === false);
    check('reg.exe: a key with a space is one argument', calls[1].args[1] === 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lock Screen');
    answer = { err: Object.assign(new Error('exit 1'), { code: 1 }), out: '', errText: 'ERROR: Access is denied.\r\n' };
    r = await real.read('HKCU', W.key, W.name);
    check('reg.exe: access denied is NOT "missing"', !r.ok && /Access is denied/.test(r.reason));
    answer = { err: null, out: 'The operation completed successfully.', errText: '' };
    await real.write('HKCU', W.key, W.name, 'REG_DWORD', 0);
    check('reg.exe: add args', calls[3].args.join(' ') === `add HKCU\\${W.key} /v IsPrelaunchEnabled /t REG_DWORD /d 0 /f`);
    await real.remove('HKCU', S.key, S.name);
    check('reg.exe: delete args', calls[4].args.join(' ') === `delete HKCU\\${S.key} /v IsDynamicSearchBoxEnabled /f`);
    const n = calls.length;
    const h = await real.write('HKLM', W.key, W.name, 'REG_DWORD', 0);
    const t = await real.write('HKCU', W.key, W.name, 'REG_SZ', 0);
    check('reg.exe: HKLM and non-number values refused before anything runs', !h.ok && !t.ok && calls.length === n);
  }
  // the dry-run registry never writes through
  {
    const inner = fakeReg({ [K(W)]: 1 });
    const dry = core.dryRunRegistry(inner);
    const file = journalPath();
    const R = mk(dry, file);
    await R.sync(both);
    const st = await R.status(both, true);
    check('dry run: shows applied, writes nothing real', inner.writes.length === 0 && dry.writes.length === 2 && st.rows.find((x) => x.id === 'widgets-prelaunch').state === 'applied');
  }
  // memory over a process tree
  {
    const procs = [
      { pid: 10, ppid: 4, file: 'SearchHost.exe', pws: 30 * 1048576, created: 100 },
      { pid: 11, ppid: 10, file: 'msedgewebview2.exe', pws: 40 * 1048576, created: 101 },
      { pid: 12, ppid: 11, file: 'msedgewebview2.exe', pws: 20 * 1048576, created: 102 },
      { pid: 13, ppid: 10, file: 'stale.exe', pws: 500 * 1048576, created: 50 },   // older than its "parent": a reused pid
      { pid: 20, ppid: 4, file: 'Widgets.exe', pws: 3 * 1048576, created: 100 },
    ];
    const m = core.measure(procs, core.pieceById('search-window'));
    check('measure: the host and its web view children, not a reused pid', m.running && m.count === 3 && m.mb === 90, JSON.stringify(m));
    const none = core.measure(procs.filter((p) => p.file !== 'Widgets.exe'), W);
    check('measure: not running = 0', none && !none.running && none.mb === 0);
  }
}

/* PART 2: the feature on a fake ctx */
function fakeCtx(o) {
  const dir = path.join(tmpRoot, `ctx${++nTmp}`, 'features');
  fs.mkdirSync(dir, { recursive: true });
  const store = {};
  const cmds = {};
  const c = {
    name: 'ramreclaim', flags: Object.freeze({ test: !!o.test, live: !o.test }), logs: [], healthy: [],
    log: (t) => c.logs.push(t),
    settings: { file: path.join(dir, 'ramreclaim.json'), get: (k, d) => (k in store ? JSON.parse(JSON.stringify(store[k])) : d), set: (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); } },
    _on: o.on !== false, _enabledFns: [],
    enabled: () => c._on, onEnabled: (fn) => c._enabledFns.push(fn),
    flip: (on) => { c._on = on; c._enabledFns.forEach((fn) => fn(on)); },
    health: (ok, reason) => c.healthy.push({ ok, reason }),
    command: (verb, fn) => { cmds[verb] = fn; return 'ramreclaim.' + verb; },
    call: (verb, a) => cmds[verb](a || {}),
    sidecar: { send: async (cmd) => (cmd === 'taskmgr.snapshot' ? { ok: true, result: { procs: [
      { pid: 7, ppid: 1, file: 'SearchHost.exe', pws: 34 * 1048576, created: 1 }, { pid: 8, ppid: 7, file: 'msedgewebview2.exe', pws: 10 * 1048576, created: 2 },
      { pid: 9, ppid: 1, file: 'Widgets.exe', pws: 3 * 1048576, created: 1 }] } } : { ok: false, error: 'unknown' }) },
    journal: path.join(dir, 'ramreclaim-journal.json'),
  };
  return c;
}
const settle = () => new Promise((r) => setTimeout(r, 30));

async function part2() {
  const mod = require('./ramreclaim');
  const { validate } = require('../features');
  check('feature: passes the feature contract', validate(mod, 'ramreclaim') == null, validate(mod, 'ramreclaim'));
  check('feature: not resting for games (the memory matters most then)', !mod.rest && mod.defaultOn === true);
  const reg = fakeReg({ [K(W)]: 1, [K(L)]: 1 });
  mod._registry = () => reg;
  try {
    const ctx = fakeCtx({});
    const h = mod.install(ctx);
    await settle();
    check('feature: start applies the default pieces only', reg.vals.get(K(W)) === 0 && reg.vals.get(K(S)) === 0 && reg.vals.get(K(L)) === 1, JSON.stringify([...reg.vals]));
    check('feature: the journal is next to its settings file', fs.existsSync(ctx.journal));
    let l = await ctx.call('list');
    const row = (id) => l.pieces.find((p) => p.id === id);
    check('feature: list has every piece', l.ok && l.pieces.length === core.PIECES.length && row('widgets-prelaunch').state === 'applied' && row('lockscreen-widgets').state === 'off');
    check('feature: list shows memory per piece (tree)', row('search-window').ram.mb === 44 && row('widgets-prelaunch').ram.mb === 3 && row('lockscreen-widgets').ram.running === false, JSON.stringify(row('search-window').ram));
    check('feature: listed pieces say why', row('search-window').kind === 'listed' && row('search-window').admin && /administrator/.test(row('search-window').why));
    let r = await ctx.call('set', { id: 'lockscreen-widgets', on: true });
    check('feature: set on applies', r.ok && r.value === true && reg.vals.get(K(L)) === 0);
    r = await ctx.call('set', { id: 'lockscreen-widgets', on: false });
    check('feature: set off puts back', r.ok && r.value === false && reg.vals.get(K(L)) === 1);
    r = await ctx.call('set', { id: 'search-window', on: true });
    check('feature: a listed piece is refused with its reason', !r.ok && /administrator/.test(r.reason));
    r = await ctx.call('set', { id: 'nope', on: true });
    check('feature: an unknown piece is refused', !r.ok);
    reg.fail[K(L)] = 'Windows refused the change (Access is denied.)';
    r = await ctx.call('set', { id: 'lockscreen-widgets', on: true });
    check('feature: a refused change springs back with the reason', !r.ok && /Access is denied/.test(r.reason) && reg.vals.get(K(L)) === 1);
    check('feature: ...and the saved choice is back to off', ctx.settings.get('pieces', {})['lockscreen-widgets'] === false);
    delete reg.fail[K(L)];
    ctx.flip(false);
    await settle();
    check('feature: tray switch off puts everything back', reg.vals.get(K(W)) === 1 && !reg.vals.has(K(S)));
    l = await ctx.call('list');
    check('feature: off = wanted pieces show paused', l.on === false && row('widgets-prelaunch').state === 'paused');
    ctx.flip(true);
    await settle();
    check('feature: switch on again applies', reg.vals.get(K(W)) === 0 && reg.vals.get(K(S)) === 0);
    const s = await h.stop('a window asked Mantle to quit');
    check('feature: quit puts everything back', s.ok && reg.vals.get(K(W)) === 1 && !reg.vals.has(K(S)));
    // session end
    const ctx2 = fakeCtx({});
    const h2 = mod.install(ctx2);
    await settle();
    await h2.stop('Windows is ending the session (logoff)');
    check('feature: session end keeps the sign-in pieces off', reg.vals.get(K(W)) === 0 && reg.vals.get(K(S)) === 0);
    const ctx3 = Object.assign(fakeCtx({}), {});
    ctx3.settings.file = ctx2.settings.file;   // the same Mantle, signed in again
    const n = reg.writes.length;
    const h3 = mod.install(ctx3);
    await settle();
    check('feature: next sign-in: nothing written twice', reg.writes.length === n);
    await h3.stop('Mantle is quitting');
    check('feature: then quit puts them back', reg.vals.get(K(W)) === 1 && !reg.vals.has(K(S)));
  } finally { mod._registry = null; }
  // a test run: the dry-run registry over a fake "real" one writes nothing through
  {
    const inner = fakeReg({ [K(W)]: 1 });
    mod._registry = (ctx) => (ctx.flags.test ? core.dryRunRegistry(inner) : inner);
    try {
      const ctx = fakeCtx({ test: true });
      const h = mod.install(ctx);
      await settle();
      const l = await ctx.call('list');
      check('test run: list says test, shows applied', l.test === true && l.pieces.find((p) => p.id === 'widgets-prelaunch').state === 'applied');
      await h.stop('test quit');
      check('test run: nothing reached the registry', inner.writes.length === 0 && inner.vals.get(K(W)) === 1);
    } finally { mod._registry = null; }
  }
}

/* PART 3: tools/ramreclaim-undo.ps1 on a scratch HKCU key */
function part3() {
  const ps1 = path.join(__dirname, '..', '..', 'tools', 'ramreclaim-undo.ps1');
  const sub = `Software\\MantleTest\\ramreclaim-${process.pid}`;
  const regKey = 'HKCU\\' + sub;
  const reg = (args) => spawnSync('reg.exe', args, { windowsHide: true, encoding: 'utf8' });
  const q = (name) => { const r = reg(['query', regKey, '/v', name]); const m = /REG_DWORD\s+0x([0-9a-f]+)/i.exec(r.stdout || ''); return m ? parseInt(m[1], 16) : null; };
  const run = (journal, extra) => spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-Journal', journal].concat(extra || []), { windowsHide: true, encoding: 'utf8', timeout: 60000 });
  try {
    reg(['add', regKey, '/v', 'A', '/t', 'REG_DWORD', '/d', '0', '/f']);   // Mantle's value: put back to 1
    reg(['add', regKey, '/v', 'B', '/t', 'REG_DWORD', '/d', '0', '/f']);   // Mantle's value, did not exist: removed
    reg(['add', regKey, '/v', 'C', '/t', 'REG_DWORD', '/d', '7', '/f']);   // changed outside Mantle: left
    const dir = path.join(tmpRoot, 'ps1');
    fs.mkdirSync(dir, { recursive: true });
    const journal = path.join(dir, 'ramreclaim-journal.json');
    const entries = {
      a: { hive: 'HKCU', key: sub, name: 'A', type: 'REG_DWORD', existed: true, data: 1, target: 0 },
      b: { hive: 'HKCU', key: sub, name: 'B', type: 'REG_DWORD', existed: false, data: null, target: 0 },
      c: { hive: 'HKCU', key: sub, name: 'C', type: 'REG_DWORD', existed: true, data: 1, target: 0 },
    };
    fs.writeFileSync(journal, JSON.stringify({ v: 1, entries }));
    let r = run(journal);
    check('ps1: without -AllowTestKeys, a key off the allowlist is left alone', r.status === 0 && q('A') === 0 && /not a value Mantle changes/.test(r.stdout), (r.stdout || '') + (r.stderr || ''));
    r = run(journal, ['-AllowTestKeys']);
    check('ps1: exit 0', r.status === 0, (r.stdout || '') + (r.stderr || ''));
    check('ps1: Mantle’s value put back', q('A') === 1);
    check('ps1: a value that did not exist is removed', q('B') === null);
    check('ps1: a value changed outside Mantle is left', q('C') === 7 && /changed outside Mantle/.test(r.stdout));
    const j = JSON.parse(fs.readFileSync(journal, 'utf8').replace(/^﻿/, ''));
    check('ps1: the journal is emptied (and still readable by the core)', j.v === 1 && Object.keys(j.entries).length === 0 && core.fileStore(journal, fs).load().entries && true);
    r = run(path.join(dir, 'none.json'));
    check('ps1: no journal = nothing to do, exit 0', r.status === 0 && /nothing to put back/.test(r.stdout));
    const rs = fs.readFileSync(path.join(__dirname, '..', '..', 'tools', 'restore-windows.ps1'), 'utf8');
    check('restore-windows.ps1 runs the undo from the state file’s folder', /ramreclaim-undo\.ps1/.test(rs) && /features\\ramreclaim-journal\.json/.test(rs));
    const ia = fs.readFileSync(path.join(__dirname, '..', '..', 'tools', 'install-autostart.ps1'), 'utf8');
    check('install-autostart.ps1 -Uninstall runs the undo', /ramreclaim-undo\.ps1/.test(ia.slice(ia.indexOf('if ($Uninstall)'), ia.indexOf('exit 0'))));
  } finally {
    reg(['delete', regKey, '/f']);
    const left = reg(['query', 'HKCU\\Software\\MantleTest']);
    if (left.status === 0 && !/HKEY_CURRENT_USER\\Software\\MantleTest\\/i.test(left.stdout || '') && !/REG_/i.test(left.stdout || '')) reg(['delete', 'HKCU\\Software\\MantleTest', '/f']);
  }
}

(async () => {
  try { await part1(); } catch (e) { failures.push('part 1 threw: ' + (e && e.stack || e)); }
  try { await part2(); } catch (e) { failures.push('part 2 threw: ' + (e && e.stack || e)); }
  if (process.platform === 'win32' && process.env.RAMRECLAIM_NO_PS !== '1') { try { part3(); } catch (e) { failures.push('part 3 threw: ' + (e && e.stack || e)); } }
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) { /* temp */ }
  failures.forEach((f) => console.log('FAIL ' + f));
  console.log(`RAMRECLAIM TEST: ${passed} passed, ${failures.length} failed`);
  process.exitCode = failures.length ? 1 : 0;
})();
