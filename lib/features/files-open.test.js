'use strict';
/*
 * files-open.test.js - how Mantle Files OPENS (lane mantle-files, 2026-10-15), in node: no Electron,
 * the same fake ctx / windows / sidecar idea as files.test.js.
 *
 *   node lib/features/files-open.test.js      -> "FILES OPEN: n passed, m failed" (exit 1 on a failure)
 *
 * Proves:
 *   1. THE LAST-FOLDER BUG: features/files.json lastFolder held a FILE path, so 3 of 6 live opens
 *      showed "listing failed". A saved file now opens its folder with the file selected; a folder that
 *      is gone opens the nearest folder above it (plain note), else Home; files.tabs saves only a FOLDER
 *      (a file's folder for a file, nothing for a path that does not exist).
 *   2. COLD (default, keepReady off): NO window exists until Win+E (Owen: RAM first); the open builds one,
 *      the last folder's cached first rows ride on the boot answer, the cache is written to disk from
 *      the finished listing; one R7 line "opened (cold) via Win+E: shown, painted, interactive ...",
 *      written only after the page said "painted" and Windows was asked (judge).
 *   3. keepReady ON: one hidden spare (its page boots and waits), Win+E takes it (no new window, shown at
 *      once, "opened (warm)"), a new spare after the last close, none while a game rests, none once off.
 * Writes only under %TEMP%\mantle-files-open-unit.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('./_files-core.js');
const F = require('./files.js');

let passed = 0;
const failures = [];
function check(name, ok, detail) { if (ok) passed++; else failures.push(name + (detail !== undefined ? ' -- ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROOT = path.join(os.tmpdir(), 'mantle-files-open-unit');

function world(o) {
  const logs = [], pushes = [], sent = [], commands = {}, chords = {}, handlers = {}, options = {}, rests = [], krFns = [];
  const store = Object.assign({}, o.store || {});
  const ctx = {
    name: 'files', flags: Object.freeze({ test: false, live: true }),
    log: (t) => logs.push(t),
    sidecar: {
      send: async (cmd, args) => { sent.push({ cmd, args }); if (cmd === 'files.list') return { ok: true, result: { job: args.job, started: true } }; if (cmd === 'files.roots') return { ok: true, result: { known: [], drives: [], network: [] } }; return { ok: true, result: {} }; },
      on: (ev, fn) => { (handlers[ev] = handlers[ev] || []).push(fn); return () => {}; },
      onReady: (fn) => { fn(); return () => {}; }, get ready() { return true; },
    },
    command: (verb, fn) => { commands[verb] = fn; return 'files.' + verb; },
    onChord: (c, fn) => { chords[c] = fn; }, onKey: () => {},
    health: () => {}, enabled: () => true, onEnabled: () => {},
    onOption: (k, fn) => { (options[k] = options[k] || []).push(fn); },
    onRest: (fn) => rests.push(fn),
    page: (f) => path.join(__dirname, '..', '..', 'ui', 'files', f || 'index.html'),
    preload: 'preload.js',
    push: (win, ev, payload) => { pushes.push({ key: win.key, ev, payload }); return true; },
    settings: { get: (k, d) => (k in store ? JSON.parse(JSON.stringify(store[k])) : d), set: (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); }, file: path.join(ROOT, 'settings', 'files.json') },
  };
  const made = [];
  class FakeWin {
    constructor(op) { this.op = op; this.destroyed = false; this.shown = false; this.events = {}; made.push(this);
      this.webContents = { on: () => {}, setWindowOpenHandler: () => {}, executeJavaScript: async () => 'baked' }; }
    loadFile(f, q) { this.key = q.query.w; }
    on(e, f) { this.events[e] = f; } once(e, f) { (this.events['once:' + e] = this.events['once:' + e] || []).push(f); }
    fireOnce(e) { const l = this.events['once:' + e] || []; delete this.events['once:' + e]; for (const f of l) f(); }
    isDestroyed() { return this.destroyed; } destroy() { if (this.destroyed) return; this.destroyed = true; if (this.events.closed) this.events.closed(); }
    show() { this.shown = true; } showInactive() { this.shown = 'inactive'; } focus() {}
    getNativeWindowHandle() { const b = Buffer.alloc(8); b.writeBigUInt64LE(77n); return b; }
    setAppDetails() {} isMaximized() { return false; } isMinimized() { return false; } setBounds(b) { this.bounds = b; }
  }
  const deps = {
    BrowserWindow: FakeWin,
    screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }), getAllDisplays: () => [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }] },
    app: { on() {}, removeListener() {} },
    thumbDir: path.join(ROOT, 'thumbs'), home: ROOT, watch: () => ({ on() {}, close() {} }),
    judge: () => ({ onTop: true, why: 'on top' }),
    lastFile: o.lastFile || path.join(ROOT, `last-${Math.random().toString(36).slice(2)}.json`),
    spareIdleMs: 0,
    // lib/keep-ready.js stand-in: 'files' follows store.keepReady (the switch Mantle Settings writes)
    keepReady: { get: (sf) => sf === 'files' && store.keepReady === true, onChange: (fn) => { krFns.push(fn); return () => {}; } },
  };
  const emit = (ev, msg) => { for (const fn of handlers[ev] || []) fn(msg); };
  return { ctx, deps, logs, pushes, sent, commands, chords, made, store, emit, options, rests, krFns };
}

function coreTests() {
  const kinds = { 'c:\\a': 'dir', 'c:\\a\\b.txt': 'file', 'c:\\a\\sub': 'dir', 'c:\\': 'dir' };
  const kind = (p) => kinds[String(p).toLowerCase()] || null;
  const s1 = C.startFolder('C:\\a\\b.txt', kind);
  check('startFolder: a saved FILE opens its folder, the file selected, no note', s1.path === 'C:\\a' && s1.select && s1.select[0] === 'b.txt' && !s1.note, s1);
  const s2 = C.startFolder('C:\\a\\sub', kind);
  check('startFolder: a folder opens itself', s2.path === 'C:\\a\\sub' && !s2.select && !s2.note, s2);
  const s3 = C.startFolder('C:\\a\\gone\\deeper', kind);
  check('startFolder: a gone folder opens the nearest folder above it, with a plain note (no path in it)', s3.path === 'C:\\a' && /gone/.test(s3.note) && !/C:/.test(s3.note), s3);
  const s4 = C.startFolder('Q:\\nothing\\here', () => null);
  check('startFolder: nothing left at all opens Home with a note', s4.path === 'mantle:home' && /Home/.test(s4.note), s4);
  check('startFolder: nothing saved opens Home quietly', C.startFolder(null, kind).path === 'mantle:home' && !C.startFolder(null, kind).note);
  check('startFolder: a virtual place opens itself', C.startFolder('mantle:thispc', kind).path === 'mantle:thispc');
  check('startFolder: junk opens Home with a note', C.startFolder('???', kind).path === 'mantle:home');
  check('folderToSave: a file saves its folder', C.folderToSave('C:\\a\\b.txt', kind) === 'C:\\a');
  check('folderToSave: a folder saves itself', C.folderToSave('C:\\a\\sub', kind) === 'C:\\a\\sub');
  check('folderToSave: a path that does not exist saves nothing', C.folderToSave('C:\\a\\gone', kind) === null);
  check('folderToSave: Home is kept', C.folderToSave('mantle:home', kind) === 'mantle:home');
}

async function bugTests() {
  const dir = path.join(ROOT, 'lf');
  const file = path.join(dir, 'note.txt');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, 'x');

  // the live bug: lastFolder holds a FILE
  let w = world({ store: { lastFolder: file } });
  let inst = F._install(w.ctx, w.deps);
  w.chords['Win+E']();
  let win = w.made[0];
  let b = await w.commands.boot({ w: win.key });
  check('bug: a saved FILE path opens its FOLDER (no "listing failed")', b.ok && C.normPath(b.path) === C.normPath(dir), b.path);
  check('bug: ...with that file selected', b.select === 'note.txt', b.select);
  const l = await w.commands.list({ w: win.key, tab: 1, path: b.path });
  const listed = w.sent.filter((s) => s.cmd === 'files.list').map((s) => s.args.path);
  check('bug: the sidecar is asked to list the folder, never the file', l.ok && listed.length === 1 && C.normPath(listed[0]) === C.normPath(dir), listed);

  // files.tabs: a file path saves its folder, a missing path saves nothing
  await w.commands.tabs({ w: win.key, tabs: [{ tab: 1, path: file }], active: 0 });
  await inst.stop('test');
  check('bug: a tab reporting a FILE saves its folder as the last folder', C.normPath(w.store.lastFolder) === C.normPath(dir), w.store.lastFolder);
  w = world({ store: { lastFolder: dir } });
  inst = F._install(w.ctx, w.deps);
  w.chords['Win+E']();
  win = w.made[0];
  await w.commands.boot({ w: win.key });
  await w.commands.tabs({ w: win.key, tabs: [{ tab: 1, path: path.join(ROOT, 'does-not-exist') }], active: 0 });
  await inst.stop('test');
  check('bug: a tab reporting a path that does not exist leaves the last folder alone', C.normPath(w.store.lastFolder) === C.normPath(dir), w.store.lastFolder);

  // gone: the nearest folder above it, said in plain words
  w = world({ store: { lastFolder: path.join(dir, 'gone', 'deeper') } });
  inst = F._install(w.ctx, w.deps);
  w.chords['Win+E']();
  b = await w.commands.boot({ w: w.made[0].key });
  await inst.stop('test');
  check('gone: opens the nearest folder above it', C.normPath(b.path) === C.normPath(dir), b.path);
  check('gone: the window says so in plain words', /last folder is gone/.test(b.notice || ''), b.notice);
  check('privacy: no path in any log line', !w.logs.some((t) => t.includes(ROOT) || /note\.txt/.test(t)), w.logs.join(' | '));
}

async function coldTests() {
  const dir = path.join(ROOT, 'cold');
  fs.mkdirSync(dir, { recursive: true });
  const lastFile = path.join(ROOT, 'cold-last.json');
  try { fs.unlinkSync(lastFile); } catch (_) { /* none */ }
  const w = world({ store: { lastFolder: dir }, lastFile });
  const inst = F._install(w.ctx, w.deps);
  await sleep(30);
  check('cold: keepReady is OFF by default and NO window exists before Win+E', w.made.length === 0 && F.options.some((x) => x.key === 'keepReady' && x.default === false && x.type === 'bool'), w.made.length);
  w.chords['Win+E']();
  const win = w.made[0];
  check('cold: Win+E builds a window, shown only once its page painted (ready-to-show)', !!win && win.shown === false);
  win.fireOnce('ready-to-show');
  await sleep(5);
  check('cold: shown at ready-to-show (light: no wallpaper hold)', win.shown === true);
  const b = await w.commands.boot({ w: win.key });
  check('cold: no cache yet on the very first open', b.ok && !b.cache);
  const l = await w.commands.list({ w: win.key, tab: 1, path: b.path });
  const items = Array.from({ length: 450 }, (_, i) => ({ n: `f${i}.txt`, d: 0, s: i, m: 0, c: 0, a: 32 }));
  w.emit('files.items', { job: l.job, items: items.slice(0, 200), done: false });
  w.emit('files.items', { job: l.job, items: items.slice(200), done: true, count: 450 });
  await w.commands.painted({ w: win.key, stage: 'painted', cached: false });
  check('cold: no R7 line before "interactive"', !w.logs.some((t) => /^opened \(/.test(t)), w.logs.join(' | '));
  await w.commands.painted({ w: win.key, stage: 'interactive' });
  const line = w.logs.find((t) => /^opened \(/.test(t)) || '';
  check('R7: one line "opened (cold) via Win+E: shown X, painted Y, interactive Z ms ... on screen"',
    /^opened \(cold\) via Win\+E: shown \d+ ms, painted \d+ ms, interactive \d+ ms; live listing asked \d+ ms.*all \d+ ms \(450 items\); on screen$/.test(line), line);
  check('R7: the old "open #n (warm)" label is gone', !w.logs.some((t) => /open #\d/.test(t)));
  await w.commands.tabs({ w: win.key, tabs: [{ tab: 1, path: dir }], active: 0 });
  await sleep(1300);
  let disk = null;
  try { disk = JSON.parse(fs.readFileSync(lastFile, 'utf8')); } catch (_) { /* not written */ }
  check('cache: the last folder\'s first 400 items are written to disk (small, bounded)', disk && C.normPath(disk.path) === C.normPath(dir) && disk.items.length === 400 && disk.count === 450, disk && { n: disk.items.length, count: disk.count });
  w.chords['Win+E']();
  const win2 = w.made[1];
  const b2 = await w.commands.boot({ w: win2.key });
  check('cache: the next cold window gets the cached rows on its boot answer (no listing waited for)', b2.cache && b2.cache.items.length === 400 && C.normPath(b2.cache.path) === C.normPath(dir), b2.cache && b2.cache.items.length);
  await inst.stop('test');

  // a fresh Mantle reads the cache file at start (off the open path) and hands it to the first window
  const w3 = world({ store: { lastFolder: dir }, lastFile });
  const inst3 = F._install(w3.ctx, w3.deps);
  await sleep(50);
  w3.chords['Win+E']();
  const b3 = await w3.commands.boot({ w: w3.made[0].key });
  check('cache: after a restart the first cold window still draws the cached rows', b3.cache && b3.cache.items.length === 400, b3.cache && b3.cache.items.length);
  check('cache: the open itself never waited on the sidecar (only taskmgr.frame / list after boot)', !w3.sent.some((s) => s.cmd === 'files.list'), w3.sent.map((s) => s.cmd).join(','));
  await inst3.stop('test');
}

async function warmTests() {
  const dir = path.join(ROOT, 'warm');
  fs.mkdirSync(dir, { recursive: true });
  const w = world({ store: { lastFolder: dir, keepReady: true } });
  const inst = F._install(w.ctx, w.deps);
  await sleep(20);
  check('keepReady: one hidden spare is made', w.made.length === 1 && w.made[0].shown === false && inst._S.spare, w.made.length);
  const spare = w.made[0];
  spare.fireOnce('ready-to-show');
  const sb = await w.commands.boot({ w: spare.key });
  check('keepReady: the spare\'s page is told to wait (spare: true), no listing asked', sb.ok && sb.spare === true && !w.sent.some((s) => s.cmd === 'files.list'), sb);
  w.chords['Win+E']();
  check('keepReady: Win+E takes the spare (no new window) and shows it at once', w.made.length === 1 && spare.shown === true && !inst._S.spare);
  const start = w.pushes.find((p) => p.ev === 'files.start');
  check('keepReady: the spare is told its start folder (files.start)', start && C.normPath(start.payload.path) === C.normPath(dir) && start.key === spare.key, start && start.payload.path);
  await w.commands.list({ w: spare.key, tab: 1, path: dir });
  const job = w.sent.filter((s) => s.cmd === 'files.list').pop().args.job;
  w.emit('files.items', { job, items: [{ n: 'a', d: 0 }], done: true, count: 1 });
  await w.commands.painted({ w: spare.key, stage: 'painted' });
  await w.commands.painted({ w: spare.key, stage: 'interactive' });
  check('R7: the spare\'s open is logged warm', w.logs.some((t) => /^opened \(warm\) via Win\+E: shown \d+ ms/.test(t)), w.logs.filter((t) => /opened/.test(t)).join(' | '));
  await sleep(20);
  check('keepReady: no second hidden window while one is open', w.made.length === 1, w.made.length);
  await w.commands.win({ w: spare.key, op: 'close' });
  await sleep(20);
  check('keepReady: after the last close a fresh spare is made', w.made.length === 2 && inst._S.spare && inst._S.spare.win === w.made[1]);
  for (const fn of w.rests) fn({ on: true, why: 'a game' });
  check('keepReady: a game rest destroys the spare (its RAM back)', !inst._S.spare && w.made[1].destroyed === true);
  await sleep(20);
  check('keepReady: no spare while resting', w.made.length === 2, w.made.length);
  for (const fn of w.rests) fn({ on: false });
  await sleep(20);
  check('keepReady: the game ended: the spare comes back', w.made.length === 3 && inst._S.spare);
  w.store.keepReady = false;
  for (const fn of w.krFns) fn('settings', true);          // another surface's switch: Files ignores it
  check('keepReady: another surface\'s switch does not touch Files\' spare', !!inst._S.spare);
  for (const fn of w.krFns) fn('files', false);
  check('keepReady off: the spare is destroyed at once', !inst._S.spare && w.made[2].destroyed === true);
  await sleep(20);
  check('keepReady off: no new spare after that', w.made.length === 3, w.made.length);
  await inst.stop('test');
}

(async () => {
  fs.mkdirSync(ROOT, { recursive: true });
  try { coreTests(); } catch (e) { failures.push('core tests threw: ' + e.stack); }
  try { await bugTests(); } catch (e) { failures.push('bug tests threw: ' + e.stack); }
  try { await coldTests(); } catch (e) { failures.push('cold tests threw: ' + e.stack); }
  try { await warmTests(); } catch (e) { failures.push('warm tests threw: ' + e.stack); }
  for (const f of failures) console.log('FAIL ' + f);
  console.log(`FILES OPEN: ${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();
