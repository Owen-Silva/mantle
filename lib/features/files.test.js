'use strict';
/*
 * files.test.js - Mantle Files' main-process half in node: no Electron, a FAKE sidecar (lane files,
 * 2026-09-28).
 *
 *   node lib/features/files.test.js
 *
 * Proves _files-core.js (paths, crumbs, the sandbox rule, the write guard incl. a link that points
 * out of the sandbox, undo plans for every op, views, previews, drop rules, names), _files-zip.js
 * (a round trip byte for byte, read back by Windows' own bsdtar as an independent reader, cancel
 * leaves no partial archive, zip-slip names refused), and files.js against a fake ctx: windows
 * (title, acrylic, never shown in --test), job routing to the window that asked, THE GUARD (a write
 * outside the sandbox never reaches the sidecar), permanent delete needs its confirm, undo, the
 * clipboard, paste/drop conflicts, dry runs for everything that would start an app, thumbnails
 * from the disk cache, previews, zip jobs, settings, a sidecar restart mid-op, an old sidecar, and
 * PRIVACY: no file name or path in any log line.
 *
 * WRITES: only inside MANTLE_FILES_SANDBOX\unit (the lane's scratch sandbox under %TEMP%).
 * Prints "FILES: n passed, m failed"; exits 1 if anything failed.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const C = require('./_files-core.js');
const Z = require('./_files-zip.js');
const F = require('./files.js');
const { validate } = require('../features.js');

let passed = 0;
const failures = [];
function check(name, ok, detail) { if (ok) passed++; else failures.push(name + (detail !== undefined ? ' -- ' + detail : '')); }
const show = (x) => JSON.stringify(x);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SANDBOX = process.env.MANTLE_FILES_SANDBOX ||
  path.join(os.tmpdir(), 'claude', 'C--Users-owens', 'fe6c395c-2ffc-4958-a961-d5833371924e', 'scratchpad', 'lanes', 'files', 'sandbox');
const UNIT = path.join(SANDBOX, 'unit');

function core() {
  const n = C.normPath;
  check('normPath: slashes, dots, drive letter', n('c:/Users//a/./b/../c/') === 'C:\\Users\\a\\c', n('c:/Users//a/./b/../c/'));
  check('normPath: bare drive is its root', n('D:') === 'D:\\');
  check('normPath: quoted', n('"C:\\x y"') === 'C:\\x y');
  check('normPath: UNC keeps its prefix', n('\\\\srv\\share\\a\\') === '\\\\srv\\share\\a', n('\\\\srv\\share\\a\\'));
  check('normPath: relative / server-only refused', n('a\\b') === null && n('\\\\srv') === null && n('') === null);
  check('normPath: virtual kept', n('mantle:home') === 'mantle:home');
  check('isRoot', C.isRoot('C:\\') && C.isRoot('\\\\s\\sh') && !C.isRoot('C:\\a'));
  check('parentOf', C.parentOf('C:\\a\\b') === 'C:\\a' && C.parentOf('C:\\a') === 'C:\\' && C.parentOf('C:\\') === null && C.parentOf('\\\\s\\sh\\x') === '\\\\s\\sh');
  check('isInside: boundary', C.isInside('C:\\a', 'C:\\a\\b') && C.isInside('c:\\A', 'C:\\a') && !C.isInside('C:\\a', 'C:\\ab') && !C.isInside('C:\\a\\b', 'C:\\a'));
  const cr = C.crumbs('C:\\Users\\me\\Downloads', { 'c:\\': 'Local Disk (C:)', 'c:\\users\\me\\downloads': 'Downloads' });
  check('crumbs: This PC > drive label > ... > known name', show(cr.map((c) => c.label)) === show(['This PC', 'Local Disk (C:)', 'Users', 'me', 'Downloads']) && cr[4].path === 'C:\\Users\\me\\Downloads', show(cr));
  check('crumbs: UNC', show(C.crumbs('\\\\srv\\sh\\a').map((c) => c.label)) === show(['Network', 'srv\\sh', 'a']));

  const tmp = 'C:\\Users\\x\\AppData\\Local\\Temp';
  const yes = () => true;
  check('sandbox: unset refuses', C.sandboxRoot('', tmp, yes).root === null);
  check('sandbox: outside temp refuses', C.sandboxRoot('C:\\Users\\x\\sandbox', tmp, yes).root === null);
  check('sandbox: temp itself refuses', C.sandboxRoot(tmp, tmp, yes).root === null);
  check('sandbox: needs a "sandbox" segment', C.sandboxRoot(tmp + '\\lane\\box', tmp, yes).root === null);
  check('sandbox: must exist', C.sandboxRoot(tmp + '\\lane\\sandbox', tmp, () => false).root === null);
  const sb = C.sandboxRoot(tmp + '\\lane\\sandbox', tmp, yes);
  check('sandbox: a good one', sb.root === tmp + '\\lane\\sandbox', show(sb));
  check('guard: live allows anything', C.guardWrite(false, null, ['C:\\Windows\\x']).ok);
  check('guard: test without sandbox refuses', !C.guardWrite(true, { root: null, why: 'x' }, [sb.root + '\\a']).ok);
  check('guard: inside ok', C.guardWrite(true, sb, [sb.root + '\\a\\b.txt', sb.root]).ok);
  check('guard: outside refused', !C.guardWrite(true, sb, [sb.root + '\\a', 'C:\\Users\\x\\Desktop\\a']).ok);
  check('guard: .. escape refused', !C.guardWrite(true, sb, [sb.root + '\\..\\evil']).ok);
  check('guard: sibling prefix refused', !C.guardWrite(true, sb, [sb.root + 'x\\a']).ok);
  check('guard: virtual refused', !C.guardWrite(true, sb, ['mantle:recycle']).ok);
  const fakeReal = (p) => { if (p.toLowerCase().startsWith((sb.root + '\\j').toLowerCase())) return 'C:\\Users\\x\\Documents' + p.slice((sb.root + '\\j').length); if (p.toLowerCase().startsWith(sb.root.toLowerCase())) return p; throw new Error('ENOENT'); };
  check('guard: a junction pointing out is refused', !C.guardWrite(true, sb, [sb.root + '\\j\\new.txt'], fakeReal).ok);
  check('guard: a real sandbox path passes the link check', C.guardWrite(true, sb, [sb.root + '\\k\\new.txt'], fakeReal).ok);
  check('guard: reasons are name-free', !/Users|sandbox\\/.test(C.guardWrite(true, sb, ['C:\\Users\\x\\Desktop\\secret.txt']).reason));

  const inv = C.inverseOf;
  check('undo copy = recycle the copies', show(inv({ op: 'copy', results: [{ src: 'C:\\a\\x', dst: 'C:\\b\\x', ok: true }, { src: 'C:\\a\\y', ok: false }] })) === show({ op: 'recycle', items: ['C:\\b\\x'], label: 'Undo copy (1 item)' }));
  const mv = inv({ op: 'move', results: [{ src: 'C:\\a\\x.txt', dst: 'C:\\b\\x (2).txt', ok: true }] });
  check('undo move = move back under the old name', mv.op === 'move' && show(mv.items) === show([{ src: 'C:\\b\\x (2).txt', dest: 'C:\\a', name: 'x.txt' }]), show(mv));
  const rn = inv({ op: 'rename', results: [{ src: 'C:\\a\\old.txt', dst: 'C:\\a\\new.txt', ok: true }] });
  check('undo rename', rn.op === 'rename' && rn.items[0] === 'C:\\a\\new.txt' && rn.name === 'old.txt');
  check('undo new folder = recycle it', inv({ op: 'newfolder', results: [{ dst: 'C:\\a\\New folder', ok: true }] }).op === 'recycle');
  check('undo recycle = restore by key', show(inv({ op: 'recycle', results: [{ src: 'C:\\a', key: 'K1', ok: true }, { src: 'C:\\b', ok: true }] })) === show({ op: 'restore', keys: ['K1'], label: 'Undo delete (1 item)' }));
  check('permanent delete is not undoable', inv({ op: 'delete', results: [{ src: 'C:\\a', ok: true }] }) === null && inv({ op: 'purge', results: [{ ok: true }] }) === null);
  check('undo labels are name-free', !/x\.txt|old|new/.test(mv.label + rn.label));
  const st = C.createUndoStack(3);
  for (let i = 0; i < 5; i++) st.push({ op: 'newfile', results: [{ dst: 'C:\\f' + i, ok: true }] });
  check('undo stack is capped, newest on top', st.size === 3 && st.peek().items[0] === 'C:\\f4');

  let views = {};
  for (let i = 0; i < C.VIEWS_MAX + 5; i++) views = C.putView(views, 'C:\\d' + i, { view: 'grid', bogus: 1 });
  check('views: capped, oldest dropped', Object.keys(views).length === C.VIEWS_MAX && !views['c:\\d0'] && !!views['c:\\d' + (C.VIEWS_MAX + 4)]);
  check('views: cleaned and case-insensitive', show(C.getView(C.putView({}, 'C:\\A', { view: 'list', sort: 'size', dir: 'desc', group: 'type', evil: '<x>' }), 'c:\\a')) === show({ view: 'list', sort: 'size', dir: 'desc', group: 'type' }));

  check('previewKind', C.previewKind('a.PNG') === 'image' && C.previewKind('a.mp4') === 'video' && C.previewKind('a.flac') === 'audio' && C.previewKind('a.pdf') === 'pdf' && C.previewKind('a.cs') === 'text' && C.previewKind('Makefile') === 'sniff' && C.previewKind('a.avi') === 'none');
  check('decodeText: utf8 BOM', C.decodeText(Buffer.from([0xEF, 0xBB, 0xBF, 0x68, 0x69])).text === 'hi');
  check('decodeText: utf16le', C.decodeText(Buffer.from([0xFF, 0xFE, 0x68, 0, 0x69, 0])).text === 'hi');
  check('decodeText: binary', C.decodeText(Buffer.from([1, 2, 0, 3])).binary === true);
  check('dropEffect: same volume moves, across copies', C.dropEffect('auto', ['C:\\a'], 'C:\\b') === 'move' && C.dropEffect('auto', ['D:\\a'], 'C:\\b') === 'copy' && C.dropEffect('copy', ['C:\\a'], 'C:\\b') === 'copy');
  check('intoItself', C.intoItself(['C:\\a'], 'C:\\a\\b') && !C.intoItself(['C:\\a'], 'C:\\ab'));
  check('badName', C.badName('a:b') && C.badName('con.txt') && C.badName('x.') && C.badName('  ') && C.badName('ok.txt') === null);
  const taken = new Set(['c:\\d\\a.txt', 'c:\\d\\a (2).txt', 'c:\\d\\new folder']);
  const ex = (p) => taken.has(p.toLowerCase());
  check('uniqueName', C.uniqueName('C:\\d', 'a.txt', ex) === 'a (3).txt' && C.uniqueName('C:\\d', 'b.txt', ex) === 'b.txt' && C.uniqueName('C:\\d', 'New folder', ex, true) === 'New folder (2)');
  check('quotePaths', C.quotePaths(['C:\\a b', 'C:\\c']) === '"C:\\a b"\r\n"C:\\c"');
  check('mergeRecent: newest first, deduped', show(C.mergeRecent([[{ path: 'C:\\a', m: 1 }], [{ path: 'c:\\A', m: 3 }, { path: 'C:\\b', m: 2 }]], 5).map((x) => x.m)) === show([3, 2]));
}

async function zipTests() {
  const src = path.join(UNIT, 'zipsrc');
  const out = path.join(UNIT, 'zipout');
  fs.rmSync(path.join(UNIT, 'zipsrc'), { recursive: true, force: true });
  fs.rmSync(out, { recursive: true, force: true });
  fs.rmSync(path.join(UNIT, 'a.zip'), { force: true });
  fs.mkdirSync(path.join(src, 'Sub dir', 'deeper'), { recursive: true });
  const files = {
    'hello.txt': Buffer.from('hello zip\r\n'.repeat(500)),
    'rand.bin': require('crypto').randomBytes(300 * 1024),
    'empty.txt': Buffer.alloc(0),
    'photo.jpg': require('crypto').randomBytes(4096),
    'Sub dir\\notes é ü 日本.md': Buffer.from('# unicode name\n'),
    'Sub dir\\deeper\\x.json': Buffer.from('{"a":1}'),
  };
  for (const [k, v] of Object.entries(files)) fs.writeFileSync(path.join(src, k), v);
  const zipPath = path.join(UNIT, 'a.zip');
  let prog = 0;
  const r = await Z.zip({ items: [src], dest: zipPath, onProgress: () => { prog++; } });
  check('zip: counts', r.files === 6 && r.dirs === 3, show(r));
  check('zip: progress reported', prog > 0);
  // An INDEPENDENT reader: .NET's ZipFile (what Windows apps use). Names come back as base64 UTF-8 so
  // the console code page cannot garble them. (Not bsdtar: MEASURED, tar.exe converts names to the
  // console's code page and calls a CJK name "unreadable", whatever the zip says.)
  const ps = 'Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[IO.Compression.ZipFile]::OpenRead($env:ZIPF); ' +
    '$z.Entries | ForEach-Object { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($_.FullName)) + " " + $_.Length }; $z.Dispose()';
  const t = cp.spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', env: Object.assign({}, process.env, { ZIPF: zipPath }) });
  const listed = String(t.stdout || '').split(/\r?\n/).filter(Boolean).map((l) => { const [b, n] = l.split(' '); return { name: Buffer.from(b, 'base64').toString('utf8'), len: Number(n) }; });
  const uni = listed.find((x) => x.name === 'zipsrc/Sub dir/notes é ü 日本.md');
  check(".NET's ZipFile reads it: 9 entries, the unicode name exact, sizes right", t.status === 0 && listed.length === 9 && uni && uni.len === files['Sub dir\\notes é ü 日本.md'].length &&
    listed.find((x) => x.name === 'zipsrc/rand.bin').len === 300 * 1024, `status ${t.status}, ${listed.length} entries ${String(t.stderr || '').slice(0, 200)}`);
  let failedExisting = false;
  const sizeBefore = fs.statSync(zipPath).size;
  try { await Z.zip({ items: [src], dest: zipPath }); } catch (e) { failedExisting = e.code === 'EEXIST'; }
  check('zip: never overwrites (or deletes) an existing archive', failedExisting && fs.existsSync(zipPath) && fs.statSync(zipPath).size === sizeBefore);
  const u = await Z.unzip({ zipPath, dest: out });
  check('unzip: counts, nothing failed', u.files === 6 && u.failed.length === 0, show(u));
  let same = true;
  for (const [k, v] of Object.entries(files)) {
    const back = fs.readFileSync(path.join(out, 'zipsrc', k));
    if (!back.equals(v)) { same = false; failures.push('unzip: bytes differ for one entry'); }
  }
  check('unzip: every file byte for byte (incl. a unicode name and an empty file)', same);
  let refused = false;
  try { await Z.unzip({ zipPath, dest: out }); } catch (e) { refused = e.code === 'EEXIST'; }
  check('unzip: refuses an existing destination (nothing overwritten)', refused);
  const cancelDest = path.join(UNIT, 'cancel.zip');
  fs.rmSync(cancelDest, { force: true });
  let cancelled = false;
  try { await Z.zip({ items: [src], dest: cancelDest, isCancelled: () => true }); } catch (e) { cancelled = /cancelled/.test(e.message); }
  check('zip: cancel rejects and leaves no partial archive', cancelled && !fs.existsSync(cancelDest));
  const d = 'C:\\x\\out';
  check('zip slip: .. refused', Z.safeTarget(d, '../evil.txt') === null && Z.safeTarget(d, 'a/../../evil') === null);
  check('zip slip: absolute / drive / ADS refused', Z.safeTarget(d, '/etc/x') === null && Z.safeTarget(d, 'C:/x') === null && Z.safeTarget(d, 'a.txt:stream') === null);
  check('zip slip: a normal nested name lands inside', Z.safeTarget(d, 'a/b\\c.txt') === 'C:\\x\\out\\a\\b\\c.txt');
}

/* ---- files.js against a fake ctx ------------------------------------------------------------- */
function fakeWorld(opts) {
  const o = opts || {};
  const logs = [], pushes = [], sent = [], commands = {}, chords = {}, handlers = {}, readyFns = [];
  const store = {};
  let health = { ok: null };
  const answers = o.answers || {};
  const sidecar = {
    send: async (cmd, args) => {
      sent.push({ cmd, args });
      const a = answers[cmd];
      if (typeof a === 'function') return a(args);
      if (a) return a;
      return { ok: true, result: {} };
    },
    on: (ev, fn) => { (handlers[ev] = handlers[ev] || []).push(fn); return () => {}; },
    onReady: (fn) => { readyFns.push(fn); fn(); return () => {}; },
    get ready() { return true; },
  };
  const ctx = {
    name: 'files', flags: Object.freeze({ test: o.test !== false, live: false }),
    log: (t) => logs.push(t), sidecar,
    command: (verb, fn) => { commands[verb] = fn; return 'files.' + verb; },
    onChord: (c, fn) => { chords[c] = fn; }, onKey: () => {},
    health: (ok, why) => { health = { ok, why }; },
    enabled: () => true, onEnabled: () => {}, onOption: () => {},
    page: (f) => path.join(__dirname, '..', '..', 'ui', 'files', f || 'index.html'),
    preload: 'preload.js',
    push: (win, ev, payload) => { pushes.push({ win: win.key, ev, payload }); return true; },
    settings: { get: (k, dflt) => (k in store ? JSON.parse(JSON.stringify(store[k])) : dflt), set: (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); }, file: path.join(UNIT, 'settings', 'files.json') },
  };
  const made = [];
  class FakeWin {
    constructor(op) { this.op = op; this.key = null; this.destroyed = false; this.shown = false; this.events = {}; this.wcEvents = {}; made.push(this);
      this.webContents = { on: (e, f) => { this.wcEvents[e] = f; }, setWindowOpenHandler: () => {}, startDrag: (x) => { this.dragged = x; } }; }
    loadFile(f, q) { this.file = f; this.query = q && q.query; this.key = Number(this.query.w); }
    on(e, f) { this.events[e] = f; } once(e, f) { this.events['once:' + e] = f; }
    isDestroyed() { return this.destroyed; } destroy() { this.destroyed = true; if (this.events.closed) this.events.closed(); }
    show() { this.shown = true; } showInactive() { this.shown = 'inactive'; } focus() {}
    getNativeWindowHandle() { const b = Buffer.alloc(8); b.writeBigUInt64LE(4242n); return b; }
    setAppDetails(x) { this.appDetails = x; }
    isMaximized() { return false; } isMinimized() { return false; }
  }
  const deps = {
    BrowserWindow: FakeWin,
    screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }), getAllDisplays: () => [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }] },
    app: { on() {}, removeListener() {} },
    shell: { openPath: async () => { throw new Error('a test must never open a file'); } },
    clipboard: { writeText: () => { throw new Error('a test must never write the clipboard'); } },
    nativeImage: { createFromDataURL: () => ({ isEmpty: () => false }) },
    sandboxEnv: o.sandboxEnv !== undefined ? o.sandboxEnv : SANDBOX,
    thumbDir: path.join(UNIT, 'thumbs'),
    home: 'C:\\Users\\tester',
    watch: () => ({ on() {}, close() {} }),
  };
  const emit = (ev, msg) => { for (const fn of handlers[ev] || []) fn(Object.assign({ ev }, msg)); };
  return { ctx, deps, logs, pushes, sent, commands, chords, made, store, emit, readyFns, get health() { return health; } };
}

async function mainTests() {
  check('the module passes lib/features.js validate()', validate(F, 'files') === null || validate(F, 'files') === undefined, String(validate(F, 'files')));
  check('Win+E is listed (CHORDS knows it)', F.HAS_CHORD && show(F.chords) === show(['Win+E']));
  check('the exact window title', F.TITLE === 'Mantle Files');
  const inSb = (...p) => path.join(UNIT, ...p);
  const outside = 'C:\\Users\\tester\\Documents\\victim.txt';
  const world = fakeWorld({
    answers: {
      'files.roots': { ok: true, result: { known: [{ key: 'downloads', path: 'C:\\Users\\tester\\Downloads' }], drives: [{ path: 'C:\\', label: 'Local Disk' }], network: [] } },
      'files.list': { ok: true, result: { job: 'x', started: true } },
      'files.op': (a) => ({ ok: true, result: { job: a.job, started: true } }),
      'files.recycle.restore': (a) => ({ ok: true, result: { job: a.job, started: true } }),
      'files.recycle.list': { ok: true, result: { items: [{ key: 'KIN', n: 'a.txt', orig: UNIT }, { key: 'KOUT', n: 'victim.txt', orig: 'C:\\Users\\tester\\Documents' }], count: 2 } },
      'files.conflicts': (a) => ({ ok: true, result: { conflicts: a.items.filter((p) => /clash/.test(p)).map((p) => ({ src: p })) } }),
      'files.thumbs': (a) => ({ ok: true, result: { results: a.items.map(() => ({ png: Buffer.from('89504e470d0a1a0a', 'hex').toString('base64'), w: 96, h: 96, kind: 'thumb' })) } }),
    },
  });
  const inst = F._install(world.ctx, world.deps);
  const cmd = world.commands;
  check('installed healthy', world.health.ok === true, show(world.health));
  check('every contract command is registered', ['boot', 'roots', 'home', 'list', 'cancel', 'search', 'icons', 'thumbs', 'types', 'op', 'conflicts', 'undo', 'clip', 'clipinfo', 'paste', 'drag', 'drop', 'open', 'handlers', 'openwith', 'openwithdialog', 'verbs', 'verb', 'copypath', 'stat', 'size', 'preview', 'zip', 'unzip', 'recycle', 'pin', 'setview', 'setopt', 'tabs', 'newwindow', 'win'].every((v) => typeof cmd[v] === 'function'), Object.keys(cmd).join(','));

  world.chords['Win+E']();
  const win = world.made[0];
  check('Win+E opens a window', !!win && win.query && win.query.w === '1');
  check('window: exact title, acrylic, frameless, resizable', win.op.title === 'Mantle Files' && win.op.backgroundMaterial === 'acrylic' && win.op.frame === false && win.op.resizable === true && win.op.webPreferences.sandbox === true && win.op.webPreferences.contextIsolation === true);
  check('window: never shown in --test, placed off every screen', win.shown === false && win.op.x + win.op.width < 0 && win.op.skipTaskbar === true);
  const boot = await cmd.boot({ w: 1 });
  check('boot: start path, options, test flag, sandbox', boot.ok && boot.path === 'mantle:home' && boot.test === true && boot.sandbox && boot.options.showExtensions === true, show(boot).slice(0, 200));

  const l = await cmd.list({ w: 1, tab: 't1', path: 'c:/Users/tester/Downloads/' });
  const listSent = world.sent.find((s) => s.cmd === 'files.list');
  check('list: normalised, crumbs with names, job sent', l.ok && l.path === 'C:\\Users\\tester\\Downloads' && l.crumbs[1].label === 'Local Disk (C:)' && l.crumbs[l.crumbs.length - 1].label === 'Downloads' && listSent && listSent.args.job === l.job, show(l).slice(0, 300));
  world.emit('files.items', { job: l.job, items: [{ n: 'a', d: 0 }], done: false });
  world.emit('files.items', { job: l.job, items: [{ n: 'b', d: 1 }], done: true, count: 2, ms: 3 });
  world.emit('files.items', { job: 'someone-else', items: [{ n: 'z' }], done: true });
  const itemPushes = world.pushes.filter((p) => p.ev === 'files.items');
  check('list: batches go to the window that asked, with its tab; strangers dropped', itemPushes.length === 2 && itemPushes.every((p) => p.win === 1 && p.payload.tab === 't1') && itemPushes[1].payload.done === true);

  const before = world.sent.length;
  const bad = await cmd.op({ w: 1, op: 'copy', items: [inSb('a.txt')], dest: 'C:\\Users\\tester\\Documents' });
  const bad2 = await cmd.op({ w: 1, op: 'recycle', items: [outside] });
  const bad3 = await cmd.op({ w: 1, op: 'rename', items: [inSb('a.txt')], name: '..\\..\\evil.txt' });
  check('GUARD: writes outside the sandbox refused BEFORE the sidecar', !bad.ok && bad.refused && !bad2.ok && bad2.refused && !bad3.ok && world.sent.length === before, show([bad, bad2, bad3]));
  const noConfirm = await cmd.op({ w: 1, op: 'delete', items: [inSb('a.txt')] });
  check('permanent delete needs its confirm', !noConfirm.ok && /confirm/.test(noConfirm.reason));
  const good = await cmd.op({ w: 1, op: 'copy', items: [inSb('a.txt')], dest: inSb('dest') });
  const opSent = world.sent.find((s) => s.cmd === 'files.op');
  check('op inside the sandbox reaches the sidecar with owner hwnd + job', good.ok && opSent && opSent.args.owner === '4242' && opSent.args.job === good.job && opSent.args.conflict === 'ask', show(opSent));
  world.emit('files.progress', { job: good.job, done: 5, total: 10, item: 'a.txt' });
  world.emit('files.opdone', { job: good.job, ok: true, results: [{ src: inSb('a.txt'), dst: inSb('dest', 'a.txt'), ok: true }] });
  const done = world.pushes.find((p) => p.ev === 'files.opdone');
  check('opdone: pushed with its undo label', done && done.payload.undoable && done.payload.undoLabel === 'Undo copy (1 item)', show(done && done.payload));
  check('opdone: every window told to refresh the touched folders', world.pushes.some((p) => p.ev === 'files.changed' && p.payload.dirs.includes(C.normPath(inSb('dest')))));
  const u = await cmd.undo({ w: 1 });
  const undoSent = world.sent.filter((s) => s.cmd === 'files.op').pop();
  check('undo runs the inverse (recycle the copy)', u.ok && undoSent.args.op === 'recycle' && undoSent.args.items[0] === inSb('dest', 'a.txt'), show(undoSent.args));
  world.emit('files.opdone', { job: u.job, ok: true, results: [{ src: inSb('dest', 'a.txt'), ok: true, key: 'K9' }] });
  check('an undo does not stack another undo', inst._S.undo.size === 0);
  const nothing = await cmd.undo({ w: 1 });
  check('undo with nothing left says so', !nothing.ok && /nothing to undo/.test(nothing.reason));

  const rOut = await cmd.recycle({ w: 1, op: 'restore', keys: ['KOUT'] });
  const rIn = await cmd.recycle({ w: 1, op: 'restore', keys: ['KIN'] });
  check('GUARD: restore of a bin item from outside the sandbox refused, inside allowed', !rOut.ok && rOut.refused && rIn.ok, show([rOut, rIn]));
  const empty = await cmd.recycle({ w: 1, op: 'empty', confirmed: true });
  check('emptying the Recycle Bin is never allowed in a test', !empty.ok && !world.sent.some((s) => s.cmd === 'files.recycle.empty'));

  const dry = await Promise.all([cmd.open({ w: 1, path: inSb('a.txt') }), cmd.verb({ w: 1, token: 't', cmd: 3 }), cmd.openwith({ w: 1, path: inSb('a.txt'), handler: 'h' }),
    cmd.openwithdialog({ w: 1, path: inSb('a.txt') }), cmd.copypath({ paths: [inSb('a b.txt')] }), cmd.drag({ w: 1, paths: [inSb('a.txt')] })]);
  check('test: open / verb / open with / dialog / copy path / drag are dry runs', dry.every((r) => r.ok && r.dryRun), show(dry).slice(0, 300));
  check('copy path text is quoted', dry[4].text === `"${inSb('a b.txt')}"`);
  check('no shell verb / open-with / clipboard write reached the sidecar', !world.sent.some((s) => /files\.(verb|openwith|openwithdialog|clip\.set)$/.test(s.cmd)));

  const clip = await cmd.clip({ op: 'cut', paths: [inSb('clash.txt'), inSb('b.txt')] });
  check('clip in a test is Mantle\'s own', clip.ok && clip.internal && clip.cut);
  const info = await cmd.clipinfo({});
  check('clipinfo', info.count === 2 && info.cut === true && info.from === 'mantle');
  const p1 = await cmd.paste({ w: 1, dest: inSb('dest') });
  check('paste: a clash asks the page first (Mantle\'s dialog)', p1.ok && p1.started === false && p1.needConflict && p1.conflicts.length === 1 && p1.op === 'move', show(p1));
  const p2 = await cmd.paste({ w: 1, dest: inSb('dest'), conflict: 'keepboth' });
  check('paste with a choice starts the move', p2.ok && p2.job && world.sent.filter((s) => s.cmd === 'files.op').pop().args.conflict === 'keepboth');
  check('a cut is used up by its paste', (await cmd.clipinfo({})).count === 0);
  const into = await cmd.drop({ w: 1, paths: [inSb('dir')], dest: inSb('dir', 'sub') });
  check('drop: a folder into itself refused', !into.ok && /itself/.test(into.reason));
  const here = await cmd.drop({ w: 1, paths: [inSb('dest', 'x.txt')], dest: inSb('dest'), effect: 'move' });
  check('drop: moving onto its own folder does nothing', here.ok && here.started === false);
  const cpSame = await cmd.drop({ w: 1, paths: [inSb('dest', 'x.txt')], dest: inSb('dest'), effect: 'copy' });
  check('drop: a copy into its own folder keeps both', cpSame.ok && world.sent.filter((s) => s.cmd === 'files.op').pop().args.conflict === 'keepboth');

  fs.mkdirSync(path.join(UNIT, 'thumbs'), { recursive: true });
  for (const f of fs.readdirSync(path.join(UNIT, 'thumbs'))) fs.unlinkSync(path.join(UNIT, 'thumbs', f));
  const t1 = await cmd.thumbs({ items: [{ path: inSb('p.png'), m: 1, s: 2 }, { path: inSb('q.png'), m: 1, s: 2 }], px: 96 });
  const calls1 = world.sent.filter((s) => s.cmd === 'files.thumbs').length;
  const t2 = await cmd.thumbs({ items: [{ path: inSb('p.png'), m: 1, s: 2 }], px: 96 });
  const calls2 = world.sent.filter((s) => s.cmd === 'files.thumbs').length;
  check('thumbs: fetched once, written to the disk cache as file URLs', t1.results.every((r) => /^file:/.test(r.url)) && calls1 === 1, show(t1).slice(0, 200));
  check('thumbs: the second ask is served from disk (no sidecar call)', calls2 === 1 && /^file:/.test(t2.results[0].url));
  const t3 = await cmd.thumbs({ items: [{ path: inSb('p.png'), m: 2, s: 2 }], px: 96 });
  check('thumbs: a changed file is fetched again', world.sent.filter((s) => s.cmd === 'files.thumbs').length === 2 && !!t3.results[0].url);

  fs.writeFileSync(inSb('note.md'), '# hi\nthere');
  fs.writeFileSync(inSb('blob.dat'), Buffer.from([1, 2, 0, 4]));
  fs.writeFileSync(inSb('p.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  const pv = await Promise.all([cmd.preview({ path: inSb('note.md') }), cmd.preview({ path: inSb('p.png') }), cmd.preview({ path: inSb('blob.dat') }), cmd.preview({ path: UNIT })]);
  check('preview: text / image url / binary / folder', pv[0].kind === 'text' && pv[0].text.startsWith('# hi') && pv[1].kind === 'image' && /^file:/.test(pv[1].url) && pv[2].kind === 'none' && pv[3].kind === 'none', show(pv.map((x) => x.kind)));

  fs.rmSync(inSb('z'), { recursive: true, force: true });
  fs.mkdirSync(inSb('z', 'in'), { recursive: true });
  fs.writeFileSync(inSb('z', 'in', 'one.txt'), 'one');
  const zr = await cmd.zip({ w: 1, items: [inSb('z', 'in')] });
  for (let i = 0; i < 100 && inst._S.jobs.has(zr.job); i++) await sleep(20);
  const zdone = world.pushes.filter((p) => p.ev === 'files.opdone').pop();
  check('zip job: archive made next to it, opdone + undo label', zr.ok && fs.existsSync(inSb('z', 'in.zip')) && zdone.payload.job === zr.job && zdone.payload.ok && zdone.payload.undoLabel === 'Undo compress', show(zdone && zdone.payload).slice(0, 200));
  const uz = await cmd.unzip({ w: 1, path: inSb('z', 'in.zip') });
  for (let i = 0; i < 100 && inst._S.jobs.has(uz.job); i++) await sleep(20);
  check('unzip job: into a NEW folder beside it (in (2), since "in" exists)', uz.ok && /in \(2\)$/.test(uz.dest) && fs.readFileSync(path.join(uz.dest, 'in', 'one.txt'), 'utf8') === 'one', show(uz));
  const zout = await cmd.zip({ w: 1, items: [inSb('z', 'in')], dest: 'C:\\Users\\tester\\Documents\\x.zip' });
  check('GUARD: zip to outside the sandbox refused', !zout.ok && zout.refused);

  await cmd.setview({ path: inSb('dest'), view: 'grid', sort: 'size' });
  await cmd.pin({ path: inSb('dest'), on: true });
  const so = await cmd.setopt({ key: 'showHidden', value: 1 });
  const soBad = await cmd.setopt({ key: 'evil', value: 1 });
  await cmd.tabs({ w: 1, tabs: [{ tab: 't1', path: inSb('dest') }], active: 0 });
  await inst.stop('test over');
  check('settings: view, pin, option, last folder saved', world.store.views && world.store.views[C.normPath(inSb('dest')).toLowerCase()].view === 'grid' && world.store.pins.includes(C.normPath(inSb('dest'))) && world.store.showHidden === true && world.store.lastFolder === C.normPath(inSb('dest')) && so.ok && !soBad.ok, show(Object.keys(world.store)));
  check('stop closes every window', win.destroyed === true && inst._S.wins.size === 0);

  const w2 = fakeWorld({ answers: { 'files.op': (a) => ({ ok: true, result: { job: a.job } }) } });
  const i2 = F._install(w2.ctx, w2.deps);
  i2._open({});
  const j2 = await w2.commands.op({ w: 1, op: 'newfolder', dest: UNIT, name: 'New folder' });
  w2.readyFns[0]();                                             // the sidecar came back after a crash
  const lost = w2.pushes.find((p) => p.ev === 'files.opdone');
  check('a sidecar restart mid-op tells the window instead of spinning', j2.ok && lost && lost.payload.aborted && /restarted/.test(lost.payload.reason));
  await i2.stop('x');

  const w3 = fakeWorld({ answers: { 'files.roots': { ok: false, error: 'unknown command: files.roots' } } });
  const i3 = F._install(w3.ctx, w3.deps);
  await sleep(10);
  check('an old sidecar without files.* marks the feature down, with the reason', w3.health.ok === false && /older build/.test(w3.health.why), show(w3.health));
  await i3.stop('x');

  const w4 = fakeWorld({ sandboxEnv: '' });
  const i4 = F._install(w4.ctx, w4.deps);
  i4._open({});
  const r4 = await w4.commands.op({ w: 1, op: 'newfolder', dest: UNIT, name: 'x' });
  check('GUARD: a test with no sandbox set refuses every write', !r4.ok && r4.refused && !w4.sent.some((s) => s.cmd === 'files.op'));
  await i4.stop('x');

  const allLogs = [].concat(world.logs, w2.logs, w3.logs, w4.logs);
  const leaks = allLogs.filter((t) => /[A-Za-z]:\\|a\.txt|clash|victim|note\.md|p\.png|zipsrc|one\.txt|\\\\/.test(t));
  check('PRIVACY: no path or file name in any log line', leaks.length === 0, show(leaks.slice(0, 3)));
}

/* lane files2 (2026-09-29): search inside files, rename many, Open in Terminal, checksum, options */
async function files2Tests() {
  const G = require('./_files-grep.js');
  const crypto = require('crypto');
  const box = path.join(UNIT, 'grep');
  fs.rmSync(box, { recursive: true, force: true });
  fs.mkdirSync(path.join(box, 'sub'), { recursive: true });
  fs.mkdirSync(path.join(box, 'docsrc', 'word'), { recursive: true });
  fs.writeFileSync(path.join(box, 'a.txt'), 'first line\nthe Needle is here\nlast');
  fs.writeFileSync(path.join(box, 'b.md'), 'nothing to see');
  fs.writeFileSync(path.join(box, 'c.dat2'), Buffer.from([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0, 1, 2]));      // "needle" then NULs: binary
  fs.writeFileSync(path.join(box, 'sub', 'd.txt'), Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from('utf16 NEEDLE text', 'utf16le')]));
  fs.writeFileSync(path.join(box, 'needle-name.log'), 'x');
  fs.writeFileSync(path.join(box, 'docsrc', 'word', 'document.xml'), '<w:document><w:body><w:p><w:r><w:t>Quarterly needle report &amp; more</w:t></w:r></w:p></w:body></w:document>');
  await Z.zip({ items: [path.join(box, 'docsrc', 'word')], dest: path.join(box, 'e.docx'), onProgress: () => {}, isCancelled: () => false });
  fs.rmSync(path.join(box, 'docsrc'), { recursive: true, force: true });
  const got = [];
  const st = await G.search(box, 'needle', { max: 100, onBatch: (b) => got.push(...b), isCancelled: () => false });
  const byName = Object.fromEntries(got.map((x) => [x.n, x]));
  check('grep: name hit, text hit, UTF-16 hit, docx hit; binary and non-matching skipped',
    byName['needle-name.log'] && byName['needle-name.log'].hit === 'name' && byName['a.txt'] && byName['a.txt'].hit === 'content' &&
    byName['d.txt'] && byName['e.docx'] && byName['e.docx'].hit === 'content' && !byName['b.md'] && !byName['c.dat2'] && st.count === 4, show(Object.keys(byName)));
  check('grep: a snippet around the match, one line', byName['a.txt'] && /the Needle is here/.test(byName['a.txt'].snip) && !/\n/.test(byName['a.txt'].snip));
  check('grep: docx text decoded (entities)', byName['e.docx'] && /needle report & more/.test(byName['e.docx'].snip), byName['e.docx'] && byName['e.docx'].snip);
  check('grep: full paths and the item shape', got.every((x) => x.p && path.isAbsolute(x.p) && typeof x.s === 'number' && (x.d === 0 || x.d === 1)));
  const capped = await G.search(box, 'needle', { max: 2, onBatch: () => {} });
  check('grep: stops at max and says capped', capped.count === 2 && capped.capped === true);
  const stopped = await G.search(box, 'needle', { max: 100, onBatch: () => {}, isCancelled: () => true });
  check('grep: cancel stops at once', stopped.cancelled === true && stopped.count === 0);
  const wild = [];
  await G.search(box, '*.txt', { onBatch: (b) => wild.push(...b) });
  check('grep: a wildcard query is names only', wild.length === 2 && wild.every((x) => x.hit === 'name'));

  const world = fakeWorld({ answers: { 'files.op': (a) => ({ ok: true, result: { job: a.job, started: true } }) } });
  F._install(world.ctx, world.deps);
  const cmd = world.commands;
  world.chords['Win+E']();
  check('files2: the new commands are registered', ['terminal', 'hash'].every((k) => typeof cmd[k] === 'function'));
  // search inside files through main: a JS job, events to the window that asked
  const sr = await cmd.search({ w: 1, tab: 't9', path: box, query: 'needle', contents: true });
  check('search contents: a job, no sidecar search', sr.ok && sr.job && sr.contents === true && !world.sent.some((s) => s.cmd === 'files.search'), show(sr));
  for (let i = 0; i < 100 && !world.pushes.some((p) => p.ev === 'files.found' && p.payload.done); i++) await sleep(20);
  const fp = world.pushes.filter((p) => p.ev === 'files.found' && p.payload.job === sr.job);
  const last = fp[fp.length - 1];
  check('search contents: hits stream to window 1 / its tab, then done with counts', fp.length >= 1 && fp.every((p) => p.win === 1 && p.payload.tab === 't9') && last.payload.done && last.payload.count === 4 && last.payload.contents === true, show(last && last.payload).slice(0, 200));
  // rename many: one job, every name checked, the guard on every target
  const r1 = path.join(UNIT, 'r1.txt'), r2 = path.join(UNIT, 'r2.txt');
  const many = await cmd.op({ w: 1, op: 'rename', items: [{ src: r1, name: 'Trip (1).txt' }, { src: r2, name: 'Trip (2).txt' }] });
  const sentMany = world.sent.filter((s) => s.cmd === 'files.op').pop();
  check('rename many: one sidecar op with {src, name} items', many.ok && sentMany && sentMany.args.op === 'rename' && sentMany.args.items.length === 2 && sentMany.args.items[1].name === 'Trip (2).txt', show(many));
  const n0 = world.sent.length;
  const dupe = await cmd.op({ w: 1, op: 'rename', items: [{ src: r1, name: 'Same.txt' }, { src: r2, name: 'same.txt' }] });
  const badN = await cmd.op({ w: 1, op: 'rename', items: [{ src: r1, name: 'a:b.txt' }] });
  const out = await cmd.op({ w: 1, op: 'rename', items: [{ src: r1, name: 'ok.txt' }, { src: 'C:\\Users\\tester\\Documents\\victim.txt', name: 'x.txt' }] });
  check('rename many: two items onto one name refused', dupe.ok === false && /same name/.test(dupe.reason));
  check('rename many: a bad name refused', badN.ok === false);
  check('rename many: THE GUARD: one target outside the sandbox refuses the lot', out.ok === false && out.refused === true);
  check('rename many: refused ones never reach the sidecar', world.sent.length === n0);
  world.emit('files.opdone', { job: many.job, ok: true, results: [{ src: r1, dst: path.join(UNIT, 'Trip (1).txt'), ok: true }, { src: r2, dst: path.join(UNIT, 'Trip (2).txt'), ok: true }] });
  const un = await cmd.undo({ w: 1 });
  const sentUndo = world.sent.filter((s) => s.cmd === 'files.op').pop();
  check('rename many: Ctrl+Z renames every one back in one job', un.ok && sentUndo.args.op === 'rename' && sentUndo.args.items.length === 2 && sentUndo.args.items[0].name === 'r1.txt' && sentUndo.args.items[0].src === path.join(UNIT, 'Trip (1).txt'), show(sentUndo && sentUndo.args).slice(0, 200));
  // terminal: a dry run in --test, and only for a real folder
  const term = await cmd.terminal({ w: 1, path: box });
  check('terminal: test mode is a dry run that names the app', term.ok && term.dryRun === true && /would open (Windows Terminal|PowerShell)/.test(term.reason), show(term));
  check('terminal: a file or a virtual place is refused', (await cmd.terminal({ path: path.join(box, 'a.txt') })).ok === false && (await cmd.terminal({ path: 'mantle:home' })).ok === false);
  // checksum
  const want = crypto.createHash('sha256').update(fs.readFileSync(path.join(box, 'a.txt'))).digest('hex');
  const h = await cmd.hash({ w: 1, path: path.join(box, 'a.txt') });
  check('hash: SHA-256 equals node crypto', h.ok && h.hex === want && h.bytes === fs.statSync(path.join(box, 'a.txt')).size, show(h));
  const h5 = await cmd.hash({ w: 1, path: path.join(box, 'a.txt'), algo: 'MD5' });
  check('hash: MD5 too', h5.ok && h5.hex === crypto.createHash('md5').update(fs.readFileSync(path.join(box, 'a.txt'))).digest('hex'));
  check('hash: a folder, a missing file and an unknown algorithm say why', !(await cmd.hash({ w: 1, path: box })).ok && /cannot be read/.test((await cmd.hash({ w: 1, path: path.join(box, 'nope.bin') })).reason) && /SHA-256/.test((await cmd.hash({ w: 1, path: path.join(box, 'a.txt'), algo: 'crc9' })).reason));
  // options
  const so = await cmd.setopt({ key: 'compact', value: 1 });
  const sc = await cmd.setopt({ key: 'searchContents', value: true });
  check('options: compact / searchContents / checkboxes saved as booleans', so.ok && so.options.compact === true && sc.options.searchContents === true && sc.options.checkboxes === false);
  const leaks = world.logs.filter((t) => /[A-Za-z]:\\|needle|a\.txt|Trip|victim/i.test(t));
  check('files2 PRIVACY: no path, name or query in any log line', leaks.length === 0, show(leaks.slice(0, 3)));
}

(async () => {
  fs.mkdirSync(UNIT, { recursive: true });
  try { await files2Tests(); } catch (e) { failures.push('files2 tests threw: ' + e.stack); }
  core();
  try { await zipTests(); } catch (e) { failures.push('zip tests threw: ' + e.stack); }
  try { await mainTests(); } catch (e) { failures.push('main tests threw: ' + e.stack); }
  for (const f of failures) console.log('FAIL ' + f);
  console.log(`FILES: ${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();
