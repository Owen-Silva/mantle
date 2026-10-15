'use strict';
/*
 * lib/keep-ready.js -- "KEEP READY IN THE BACKGROUND", one switch per app window (lane settingsfast,
 * 2026-10-15).
 *
 * WHY. Owen, 2026-10-15: "no i dont want these open in the backround i need to save ram ... there can be
 * an option to have them open backround though". So by DEFAULT Mantle keeps NO hidden Settings, Task
 * Manager or Files window: they open fast COLD (a light first paint, the last data from a cache, nothing
 * on the open path waiting on the helper). This file is the opt-in: one config key per surface, all off
 * unless Owen turns one on in Mantle Settings > Mantle > Keep ready in the background. A surface whose
 * key is on keeps ONE hidden window made after start, destroyed while a game runs and made again after
 * (notes/mantle-replace-windows.md P3), and pays the memory said on its row.
 *
 * WHERE. <userData>/keep-ready.json (live %APPDATA%\mantle, a test copy %TEMP%\mantle-test-<profile>):
 *   { "keepReady.settings": false, "keepReady.taskmgr": false, "keepReady.files": false }
 * Missing keys are false. A file that cannot be read is moved aside to keep-ready.json.unreadable and
 * SAID (reason()); every key is then false until Owen sets one again.
 *
 * WHO READS IT. lib/features/settings.js (keepReady.settings), lib/features/taskmgr.js
 * (keepReady.taskmgr), lib/features/files.js (keepReady.files, lane mantle-files):
 *     const KR = require('../keep-ready.js');
 *     KR.get('files')                   -> true | false
 *     const off = KR.onChange((surface, on) => { ... });   // call off() in stop()
 * Mantle Settings writes it (settings.keepReady); nothing else does.
 */
const fs = require('fs');
const path = require('path');

const FILE_NAME = 'keep-ready.json';
/* The rows Mantle Settings draws, in plain words, with what each one costs. Memory measured on this
   i3 with a hidden window after start (lane settingsfast, see the commit); "private" is what Windows'
   own Task Manager calls "Memory". */
const SURFACES = {
  settings: { label: 'Mantle Settings', keys: 'Win+I', mb: 45 },
  taskmgr: { label: 'Task Manager', keys: 'Ctrl+Shift+Esc', mb: 50 },
  files: { label: 'Files', keys: 'Win+E', mb: 35 },
};
const KEYS = Object.keys(SURFACES);
const keyOf = (s) => `keepReady.${s}`;

/** The words on a surface's row. PURE. */
function words(s) {
  const o = SURFACES[s];
  if (!o) return null;
  return {
    label: `Keep ${o.label} ready`,
    help: `On: ${o.keys} opens it instantly, but it holds about ${o.mb} MB of memory all the time (let go while a game runs). ` +
      'Off: it opens fresh in well under a second and uses no memory while closed.',
  };
}

function create(o) {
  const file = o && o.file;
  const log = (o && o.log) || (() => {});
  let cache = null;
  let problem = null;                    // why the file could not be used, or null
  const fns = new Set();
  function load() {
    if (cache) return cache;
    cache = {};
    if (!file) { problem = 'Mantle has no folder to keep this switch in, so every surface opens fresh'; return cache; }
    let txt = null;
    try { txt = fs.readFileSync(file, 'utf8'); } catch (e) {
      if (e.code !== 'ENOENT') problem = `${FILE_NAME} could not be read (${e.code || e.message}), so every surface opens fresh`;
      return cache;
    }
    let v;
    try { v = JSON.parse(txt); } catch (_) { v = undefined; }
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      problem = `${FILE_NAME} did not hold these switches, so every surface opens fresh`;
      try { fs.renameSync(file, file + '.unreadable'); problem += ` (the old file was kept as ${FILE_NAME}.unreadable)`; } catch (_) { /* said either way */ }
      log(`keep ready: ${problem}`);
      return cache;
    }
    for (const s of KEYS) if (v[keyOf(s)] === true) cache[keyOf(s)] = true;
    return cache;
  }
  function get(s) { return KEYS.includes(s) ? load()[keyOf(s)] === true : false; }
  function all() { const c = load(); const out = {}; for (const s of KEYS) out[keyOf(s)] = c[keyOf(s)] === true; return out; }
  /** -> {ok, reason, on}. Never throws. */
  function set(s, on) {
    if (!KEYS.includes(s)) return { ok: false, reason: `"${String(s).slice(0, 40)}" is not a window Mantle can keep ready (${KEYS.join(', ')})`, on: false };
    const want = on === true;
    const before = get(s);
    if (!file) return { ok: false, reason: problem || 'Mantle has no folder to keep this switch in', on: before };
    const next = Object.assign(all(), { [keyOf(s)]: want });
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
      fs.renameSync(tmp, file);
    } catch (e) {
      return { ok: false, reason: `the switch could not be saved (${e.code || e.message}), so it stays ${before ? 'on' : 'off'}`, on: before };
    }
    cache = {};
    for (const k of KEYS) if (next[keyOf(k)]) cache[keyOf(k)] = true;
    problem = null;
    if (before !== want) {
      log(`keep ready: ${SURFACES[s].label} ${want ? 'kept ready in the background' : 'opens fresh (nothing kept)'}`);
      for (const fn of Array.from(fns)) { try { fn(s, want); } catch (e) { log(`keep ready: a listener threw (${e && e.message})`); } }
    }
    return { ok: true, reason: null, on: want };
  }
  function onChange(fn) {
    if (typeof fn !== 'function') throw new Error('keep-ready onChange needs a function');
    fns.add(fn);
    return () => fns.delete(fn);
  }
  /** What Mantle Settings draws: one row per surface. */
  function view() {
    return { ok: true, reason: problem, rows: KEYS.map((s) => Object.assign({ surface: s, key: keyOf(s), on: get(s), mb: SURFACES[s].mb }, words(s))) };
  }
  return { get, all, set, onChange, view, reason: () => { load(); return problem; }, file };
}

/* One store per process, at <userData>/keep-ready.json, made on first use (after main.js has set
   userData for a test profile). */
let one = null;
function shared() {
  if (one) return one;
  let file = null;
  // plain node (a unit test): never require('electron') (it can start its installer); no file = all off
  if (process.versions.electron) { try { file = path.join(require('electron').app.getPath('userData'), FILE_NAME); } catch (_) { file = null; } }
  one = create({ file, log: (m) => { try { process.stdout.write(`mantle: ${m}\n`); } catch (_) { /* no stdout */ } } });
  return one;
}

module.exports = {
  SURFACES, KEYS, FILE_NAME, keyOf, words, create,
  get: (s) => shared().get(s),
  set: (s, on) => shared().set(s, on),
  all: () => shared().all(),
  view: () => shared().view(),
  onChange: (fn) => shared().onChange(fn),
  /** tests: use this store instead of <userData>/keep-ready.json */
  _use(store) { one = store; },
};
