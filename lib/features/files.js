'use strict';
/*
 * files.js - Mantle Files, the File Explorer replacement (lane files, 2026-09-28).
 *
 * WHY: Owen, "the point of this is to fully replace windows basically ... and not ever rely on
 * any old windows feature", then "also start work on replacing files too". Win+E, the launcher's
 * "Mantle Files" row and the top bar open an app window of Mantle's own: tabs, a navigation pane,
 * a breadcrumb you can type into, details / list / grid with real shell thumbnails, and the file
 * operations, all drawn by ui/files/ in the island theme.
 *
 * THE THREE PARTS (the contract is the header of each):
 *   sidecar/Files*.cs  the Windows half: streamed enumeration (FindFirstFileEx), thumbnails
 *                      (IShellItemImageFactory), IFileOperation for copy / move / recycle / delete /
 *                      rename / new (Windows' conflict and elevation semantics kept), the Recycle
 *                      Bin, the shell's own context-menu verbs, Open with, the file clipboard.
 *   this file          windows and tabs, job routing (a sidecar event names its job; the job names
 *                      its window), undo, the thumbnail disk cache, zip (lib/features/_files-zip.js),
 *                      settings, and the TEST GUARD. Pure logic is in _files-core.js.
 *   ui/files/          the page. It never touches the disk: everything is a files.* call.
 *
 * BIG FOLDERS: the sidecar streams a folder in batches (the first after <=100 items or 16 ms) and
 * this file forwards each batch to the one window that asked, untouched; the page virtualises.
 * Main never holds a listing, so a 100k-item folder costs main nothing.
 *
 * THE RULES (Owen's):
 *   - --test: every write is refused outside MANTLE_FILES_SANDBOX (checked here AND by the passive
 *     sidecar), opening in an app / shell verbs / the clipboard / dragging are dry runs, and the
 *     windows are never shown (MANTLE_FILES_TEST_SHOW=1 shows them OFF every screen, inactive, for
 *     a capture; they are never in front of Owen).
 *   - Privacy: mantle.log gets counts, ms and codes. Never a file name or path: a command's
 *     `reason` is logged by main's call-log, so reasons here are name-free and per-item detail
 *     travels in `results[i].why`, which only the window shows.
 *   - Nothing fails silently: every failure is a reason the window shows.
 *   - Recycle, never destroy, unless Owen pressed Shift+Del and confirmed (`confirmed`).
 *
 * NOT RESTING (rest: false). A resting feature is stopped while a game runs so its hidden windows
 * give their RAM back. Mantle Files keeps NO hidden window: a window exists only while Owen has it
 * open (destroyed on close), so resting would free nothing, would close folders he opened on
 * purpose, and could cut an in-flight copy's window off from its result. Win+E still goes back to
 * Explorer if the feature is off or unhealthy.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('./_files-core.js');
const Z = require('./_files-zip.js');

let CHORDS = [];
try { CHORDS = require('../features.js').CHORDS || []; } catch (_) { /* a harness without lib/features.js */ }
const CHORD = 'Win+E';
/* Listed only while lib/features.js (and sidecar/AltTab.cs) know it: an unknown chord would fail
   the whole feature's validation. Both list it since lane files (2026-09-28). */
const HAS_CHORD = CHORDS.includes(CHORD);

const TITLE = 'Mantle Files';            // exact: main.js MANTLE_APP_TITLES and AltTab.cs MantleAppTitles list it
const APP_ID = 'Mantle.Files';
const ICON = path.join(__dirname, '..', '..', 'assets', 'icons', 'mantle-files.ico');
const W0 = 1100, H0 = 700, MIN_W = 560, MIN_H = 380;
const THUMB_BATCH = 24;                  // the sidecar's cap per files.thumbs call
const THUMB_PAR = 2;                     // its two STA workers
const THUMB_QUEUE_MAX = 12;              // batches waiting; older ones are dropped (scrolled away)
const THUMB_KEEP = 4000, THUMB_PRUNE_AT = 6000;
const SEARCH_MAX = 5000;
const OPS = ['copy', 'move', 'recycle', 'delete', 'rename', 'newfolder', 'newfile', 'restore', 'purge'];
const OPT_KEYS = ['showHidden', 'showExtensions', 'defaultView', 'startIn', 'replaceExplorer'];
const LABEL = { copy: 'copy', move: 'move', recycle: 'delete', delete: 'permanent delete', rename: 'rename', newfolder: 'new folder',
  newfile: 'new file', restore: 'restore', purge: 'permanent delete', zip: 'compress', unzip: 'extract', empty: 'empty Recycle Bin' };

function electron() { return require('electron'); }

function install(ctx, deps) {
  const d = deps || {};
  const E = d.electron || (() => { try { return electron(); } catch (_) { return {}; } })();
  const app = d.app || E.app || null;
  const test = !!(ctx.flags && ctx.flags.test);
  const exists = d.exists || ((p) => { try { fs.accessSync(p); return true; } catch (_) { return false; } });
  const realpath = d.realpath || ((p) => fs.realpathSync.native(p));
  const sandbox = test ? C.sandboxRoot(d.sandboxEnv !== undefined ? d.sandboxEnv : process.env.MANTLE_FILES_SANDBOX, d.tmpdir || os.tmpdir(), exists) : null;
  const home = d.home || os.homedir();
  const settingsDir = ctx.settings && ctx.settings.file ? path.dirname(ctx.settings.file) : path.join(os.tmpdir(), 'mantle-files');
  const thumbDir = d.thumbDir || path.join(settingsDir, 'files-thumbs');
  const showInTest = process.env.MANTLE_FILES_TEST_SHOW === '1';
  // TEST ONLY: the end-to-end self-drive (lib/features/_files-e2e.js); never loaded by a live Mantle.
  const E2E = test && process.env.MANTLE_FILES_SELFTEST === '1' && sandbox && sandbox.root ? require('./_files-e2e') : null;

  const S = {
    wins: new Map(), nextWin: 1, jobs: new Map(), nextJob: 1,
    undo: C.createUndoStack(), clip: { paths: [], cut: false },
    icons: new Map(), types: new Map(), thumbMiss: new Map(), thumbQ: [], thumbBusy: 0, thumbDisk: true,
    watchers: new Map(), names: {}, roots: null, rootsAt: 0,
    stopped: false, crashed: null, sidecarWhy: null, saveTimer: null, pending: {},
  };
  if (test) ctx.log(`test mode: writes ${sandbox && sandbox.root ? 'only inside the files sandbox' : `refused (${sandbox.why})`}`);

  try { fs.mkdirSync(thumbDir, { recursive: true }); } catch (e) { S.thumbDisk = false; ctx.log(`thumbnail cache folder unavailable (${e.code}); thumbnails are kept in memory only`); }

  /* ---- settings ------------------------------------------------------------------------------ */
  const get = (k, dflt) => { try { return ctx.settings.get(k, dflt); } catch (_) { return dflt; } };
  const opts = () => ({
    showHidden: !!get('showHidden', false), showExtensions: get('showExtensions', true) !== false,
    defaultView: ['details', 'list', 'grid'].includes(get('defaultView', 'details')) ? get('defaultView', 'details') : 'details',
    startIn: get('startIn', 'last') === 'home' ? 'home' : 'last', replaceExplorer: !!get('replaceExplorer', false),
  });
  /** Batched writes: navigating writes the last folder, a view change the view map. */
  function saveLater(key, value) {
    S.pending[key] = value;
    clearTimeout(S.saveTimer);
    S.saveTimer = setTimeout(flushSaves, 800);
  }
  function flushSaves() {
    clearTimeout(S.saveTimer);
    S.saveTimer = null;
    const p = S.pending;
    S.pending = {};
    for (const k of Object.keys(p)) {
      try { ctx.settings.set(k, p[k]); } catch (e) { ctx.log(`settings: "${k}" not saved (${e.message})`); }
    }
  }
  const pins = () => (get('pins', null) || defaultPins()).filter((p) => typeof p === 'string');
  function defaultPins() {
    return ['Desktop', 'Downloads', 'Documents', 'Pictures'].map((n) => path.join(home, n)).filter((p) => exists(p));
  }
  const pinRows = () => pins().map((p) => ({ path: p, label: labelOf(p), d: 1, missing: !exists(p) }));
  function labelOf(p) {
    const n = C.normPath(p);
    return (n && S.names[n.toLowerCase()]) || path.win32.basename(n || '') || n;
  }

  /* ---- windows ------------------------------------------------------------------------------- */
  const rec = (w) => S.wins.get(Number(w)) || null;
  const winOf = (w) => { const r = rec(w); return r && r.win && !r.win.isDestroyed() ? r.win : null; };
  function push(w, ev, payload) { const win = winOf(w); return win ? ctx.push(win, ev, payload) : false; }
  function toAll(ev, payload) { for (const r of S.wins.values()) if (r.win && !r.win.isDestroyed()) ctx.push(r.win, ev, payload); }
  function hwnd(w) {
    const win = winOf(w);
    try {
      const b = win && win.getNativeWindowHandle ? win.getNativeWindowHandle() : null;
      if (!b || !b.length) return '0';
      return String(b.length >= 8 ? b.readBigUInt64LE(0) : b.readUInt32LE(0));
    } catch (_) { return '0'; }
  }

  function startPath() {
    if (opts().startIn === 'home') return 'mantle:home';
    const last = get('lastFolder', null);
    const n = last ? C.normPath(last) : null;
    if (n && (C.isVirtual(n) || exists(n))) return n;
    return 'mantle:home';
  }

  function offscreen(width, height) {
    const screen = d.screen || E.screen;
    let minX = 0;
    try { for (const s of screen.getAllDisplays()) minX = Math.min(minX, s.bounds.x); } catch (_) { /* one display */ }
    return { x: minX - width - 400, y: 0, width, height };
  }

  function createWindow(key) {
    const t0 = Date.now();                                           // Win+E -> first paint (self-test timing)
    const BrowserWindow = d.BrowserWindow || E.BrowserWindow;
    const screen = d.screen || E.screen;
    let b = get('bounds', null);
    const wa = (() => { try { return screen.getPrimaryDisplay().workArea; } catch (_) { return { x: 0, y: 0, width: 1920, height: 1040 }; } })();
    if (!b || !(b.width >= MIN_W) || !(b.height >= MIN_H)) b = { width: W0, height: H0, x: Math.round(wa.x + (wa.width - W0) / 2), y: Math.round(wa.y + (wa.height - H0) / 2) };
    const open = S.wins.size;
    if (open) b = Object.assign({}, b, { x: b.x + 28 * open, y: b.y + 28 * open });       // cascade, as Explorer does
    if (test) b = offscreen(b.width, b.height);
    const hasIcon = exists(ICON);
    const w = new BrowserWindow({
      show: false, frame: false, title: TITLE,
      // Acrylic is DWM's, and DWM draws it only on the ACTIVE window (sidecar/Glass.cs's header):
      // an app window takes focus, so unlike the bar it can use it. Inactive, DWM paints a flat
      // colour and the page's own ground (ui/files/files.css) keeps the text readable.
      backgroundMaterial: 'acrylic', backgroundColor: '#00000000',
      icon: hasIcon ? ICON : undefined,
      resizable: true, movable: true, minimizable: true, maximizable: true, fullscreenable: false, skipTaskbar: test,
      width: b.width, height: b.height, x: b.x, y: b.y, minWidth: MIN_W, minHeight: MIN_H,
      webPreferences: { preload: ctx.preload, contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false, plugins: true },
    });
    if (hasIcon && typeof w.setAppDetails === 'function') {
      try { w.setAppDetails({ appId: APP_ID, appIconPath: ICON, appIconIndex: 0, relaunchDisplayName: TITLE }); } catch (e) { ctx.log(`the window's app details were not set (${e.message})`); }
    }
    const wc = w.webContents;
    w.on('page-title-updated', (e) => e.preventDefault());           // the bar and Alt+Tab know it by its exact title
    wc.on('will-navigate', (e) => e.preventDefault());
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('render-process-gone', (_e, det) => {
      S.crashed = `a Mantle Files window's page crashed (${det && det.reason}); Win+E opens File Explorer until the next Mantle Files window loads`;
      ctx.health(false, S.crashed);
      closeWindow(key, 'page crashed');
    });
    wc.on('did-fail-load', (_e, code, desc, _u, isMain) => {
      if (isMain === false) return;
      ctx.health(false, `a Mantle Files window did not load (${desc || code})`);
    });
    wc.on('did-finish-load', () => {
      if (S.crashed) { S.crashed = null; ctx.health(true); }
      if (E2E) E2E.loaded({ win: w, t0, title: TITLE, hasIcon, sandbox: sandbox.root, log: ctx.log, close: () => closeWindow(key, 'self-test done') });
    });
    let bt = null;
    const later = () => { clearTimeout(bt); bt = setTimeout(() => { try { if (!test && !w.isDestroyed() && !w.isMaximized() && !w.isMinimized()) ctx.settings.set('bounds', w.getBounds()); } catch (_) { /* only the size is lost */ } }, 700); };
    w.on('resize', later);
    w.on('move', later);
    w.on('closed', () => forget(key));
    w.loadFile(ctx.page('index.html'), { query: { w: String(key) } });
    return { w, hasIcon };
  }

  function openWindow(a) {
    const o = a || {};
    if (S.stopped) return { ok: false, reason: 'Mantle Files is stopped' };
    if (!ctx.enabled()) return { ok: false, reason: 'Mantle Files is switched off in the tray menu; File Explorer still works (Win+E)' };
    let start = o.path ? C.normPath(o.path) : null;
    if (o.path && !start) return { ok: false, reason: 'that is not a folder path Mantle Files can open' };
    let select = o.select || null;
    if (start && !C.isVirtual(start)) {
      let st = null;
      try { st = fs.statSync(start); } catch (_) { st = null; }
      if (st && !st.isDirectory()) { select = path.win32.basename(start); start = C.parentOf(start); }     // "show in folder" of a file
    }
    if (!start) start = startPath();
    const key = S.nextWin++;
    const made = createWindow(key);
    S.wins.set(key, { key, win: made.w, start, select, tabs: [start], active: 0, notice: made.hasIcon ? null : 'The Mantle Files icon (assets/icons/mantle-files.ico) is missing, so the bar shows the default one.' });
    if (!test) made.w.once('ready-to-show', () => { if (!made.w.isDestroyed()) { made.w.show(); made.w.focus(); } });
    else if (showInTest) made.w.once('ready-to-show', () => { if (!made.w.isDestroyed()) made.w.showInactive(); });
    ctx.log(`window opened (${S.wins.size} open)${test ? (showInTest ? ' off screen, inactive: test mode' : ' hidden: test mode') : ''}`);
    return { ok: true, w: key, shown: !test };
  }

  function forget(key) {
    const r = S.wins.get(key);
    if (!r) return;
    S.wins.delete(key);
    for (const [k, wt] of S.watchers) if (k.startsWith(key + '|')) { try { wt.watcher.close(); } catch (_) { /* gone */ } clearTimeout(wt.timer); S.watchers.delete(k); }
    for (const [job, j] of S.jobs) {
      if (j.w !== key) continue;
      if (j.kind === 'list' || j.kind === 'search' || j.kind === 'size') { ctx.sidecar.send('files.cancel', { job }); S.jobs.delete(job); }
      // ops keep running: their result still lands in the undo stack and the other windows refresh
    }
  }
  function closeWindow(key, why) {
    const r = S.wins.get(Number(key));
    if (!r) return;
    forget(r.key);
    if (r.win && !r.win.isDestroyed()) r.win.destroy();
    ctx.log(`window closed (${why}; ${S.wins.size} open)`);
  }

  /* ---- live refresh: fs.watch per open tab (ReadDirectoryChangesW underneath) ----------------- */
  function watch(w, tab, p) {
    const k = `${w}|${tab}`;
    const old = S.watchers.get(k);
    if (old) { try { old.watcher.close(); } catch (_) { /* gone */ } clearTimeout(old.timer); S.watchers.delete(k); }
    if (!p || C.isVirtual(p)) return { watch: false };
    const fsw = d.watch || fs.watch;
    try {
      const rec0 = { watcher: null, timer: null, path: p };
      rec0.watcher = fsw(p, { persistent: false }, () => {
        clearTimeout(rec0.timer);
        rec0.timer = setTimeout(() => push(w, 'files.changed', { dirs: [p], tab, live: true }), 250);
      });
      rec0.watcher.on('error', (e) => {
        try { rec0.watcher.close(); } catch (_) { /* gone */ }
        S.watchers.delete(k);
        push(w, 'files.notice', { tab, text: `This folder stopped refreshing by itself (${e.code || 'error'}); press F5 to refresh it.` });
      });
      S.watchers.set(k, rec0);
      const mine = [...S.watchers.keys()].filter((x) => x.startsWith(w + '|'));
      if (mine.length > 16) { const drop = S.watchers.get(mine[0]); try { drop.watcher.close(); } catch (_) { /* gone */ } S.watchers.delete(mine[0]); }
      return { watch: true };
    } catch (e) {
      return { watch: false, watchWhy: `this folder does not refresh by itself (${e.code || 'no change notifications'}); press F5` };
    }
  }

  /* ---- sidecar events -> the window that asked ------------------------------------------------ */
  const newJob = (kind) => `f${kind[0]}${S.nextJob++}`;
  function route(ev, fn) {
    ctx.sidecar.on(ev, (msg) => {
      const j = msg && S.jobs.get(msg.job);
      if (j) fn(j, msg);
    });
  }
  route('files.items', (j, m) => {
    if (!j.first) j.first = Date.now() - j.at;
    j.count += Array.isArray(m.items) ? m.items.length : 0;
    push(j.w, 'files.items', { tab: j.tab, job: j.job, items: m.items || [], done: !!m.done, count: m.count, ms: m.ms, error: m.error || null });
    if (m.done) {
      S.jobs.delete(j.job);
      const total = Date.now() - j.at;
      if (j.count >= 1000 || total >= 1000 || m.error) ctx.log(`list: ${j.count} items, first batch ${j.first} ms, all in ${total} ms (sidecar ${m.ms} ms)${m.error ? '; failed: ' + m.error : ''}`);
    }
  });
  route('files.found', (j, m) => {
    j.count += Array.isArray(m.items) ? m.items.length : 0;
    push(j.w, 'files.found', { tab: j.tab, job: j.job, items: m.items || [], done: !!m.done, count: m.count, ms: m.ms, capped: !!m.capped, denied: m.denied || 0, error: m.error || null });
    if (m.done) { S.jobs.delete(j.job); ctx.log(`search: ${j.count} found in ${Date.now() - j.at} ms${m.capped ? ' (capped)' : ''}`); }
  });
  route('files.size', (j, m) => {
    push(j.w, 'files.size', { job: j.job, bytes: m.bytes, files: m.files, dirs: m.dirs, denied: m.denied || 0, done: !!m.done, ms: m.ms, error: m.error || null });
    if (m.done) S.jobs.delete(j.job);
  });
  route('files.progress', (j, m) => {
    push(j.w, 'files.progress', { job: j.job, op: j.op, done: m.done, total: m.total, items: m.items, itemsTotal: m.itemsTotal, item: m.item || null });
  });
  route('files.opdone', (j, m) => opDone(j, m));

  function opDone(j, m) {
    if (!S.jobs.has(j.job)) return;
    S.jobs.delete(j.job);
    const results = Array.isArray(m.results) ? m.results : [];
    const okN = results.filter((r) => r && r.ok !== false && !r.skipped).length;
    const failN = results.filter((r) => r && r.ok === false).length;
    let undo = null;
    if (!j.undo) undo = S.undo.push({ op: j.op, results });
    const top = S.undo.peek();
    push(j.w, 'files.opdone', { job: j.job, op: j.op, ok: m.ok !== false && failN === 0 && !m.aborted, hr: m.hr || 0, reason: m.reason || null,
      aborted: !!m.aborted, results, undoable: !!undo, undoLabel: undo ? undo.label : null, wasUndo: !!j.undo });
    toAll('files.undo', { label: top ? top.label : null });
    const dirs = new Set(j.dirs || []);
    for (const r of results) {
      for (const p of [r && r.src, r && r.dst]) {
        const up = p && typeof p === 'string' ? C.parentOf(p) : null;
        if (up) dirs.add(up);
      }
    }
    if (j.op === 'recycle' || j.op === 'restore' || j.op === 'purge' || j.op === 'delete') dirs.add('mantle:recycle');
    toAll('files.changed', { dirs: [...dirs] });
    const hr = m.hr ? ` (hr 0x${(m.hr >>> 0).toString(16)})` : '';
    ctx.log(`${j.undo ? 'undo ' : ''}${j.op}: ${okN} ok, ${failN} failed${m.aborted ? ', cancelled' : ''} in ${Date.now() - j.at} ms${hr}${undo ? '; undoable' : ''}`);
  }

  /* A sidecar restart loses every job it was running: say so in the windows instead of spinning. */
  let firstReady = true;
  ctx.sidecar.onReady(() => {
    if (!firstReady) {
      for (const j of [...S.jobs.values()]) {
        if (j.js) continue;
        if (j.kind === 'op') opDone(j, { ok: false, aborted: true, reason: 'the sidecar restarted in the middle of it; check the folder to see what finished', results: [] });
        else {
          S.jobs.delete(j.job);
          const ev = j.kind === 'search' ? 'files.found' : j.kind === 'size' ? 'files.size' : 'files.items';
          push(j.w, ev, { tab: j.tab, job: j.job, items: [], done: true, error: 'the sidecar restarted; press F5' });
        }
      }
    }
    firstReady = false;
    probe();
  });
  /* Is this sidecar new enough to have files.* at all? An older exe would leave every window empty. */
  async function probe() {
    const r = await ctx.sidecar.send('files.roots', {}, { timeoutMs: 8000 });
    if (!r.ok && /unknown command/i.test(r.error || '')) {
      S.sidecarWhy = 'the running sidecar is an older build without the files.* commands; rebuild it (sidecar/build.ps1)';
      ctx.health(false, S.sidecarWhy);
      return;
    }
    if (S.sidecarWhy) { S.sidecarWhy = null; ctx.health(true); }
    if (r.ok) takeRoots(r.result);
  }
  function takeRoots(res) {
    S.roots = res || {};
    S.rootsAt = Date.now();
    const names = {};
    for (const k of res && Array.isArray(res.known) ? res.known : []) if (k && k.path) names[String(C.normPath(k.path)).toLowerCase()] = C.KNOWN_LABELS[k.key] || k.key;
    for (const dr of res && Array.isArray(res.drives) ? res.drives : []) {
      if (dr && dr.path) names[String(C.normPath(dr.path)).toLowerCase()] = dr.label ? `${dr.label} (${String(dr.path).slice(0, 2)})` : String(dr.path).slice(0, 2);
    }
    names[String(C.normPath(home)).toLowerCase()] = names[String(C.normPath(home)).toLowerCase()] || path.win32.basename(home);
    S.names = names;
  }
  async function roots(fresh) {
    if (!fresh && S.roots && Date.now() - S.rootsAt < 3000) return { ok: true, result: S.roots };
    const r = await ctx.sidecar.send('files.roots', {}, { timeoutMs: 8000 });
    if (r.ok) takeRoots(r.result);
    return r;
  }

  /* ---- the write guard ------------------------------------------------------------------------ */
  function touched(spec) {
    const out = [];
    for (const it of spec.items || []) {
      if (typeof it === 'string') out.push(it);
      else if (it && typeof it === 'object') { out.push(it.src); if (it.dest) out.push(path.win32.join(it.dest, it.name || path.win32.basename(String(it.src || '')))); }
    }
    if (spec.dest) out.push(spec.dest);
    if (spec.dest && spec.name) out.push(path.win32.join(spec.dest, spec.name));
    if (spec.op === 'rename' && spec.items && typeof spec.items[0] === 'string' && spec.name) out.push(path.win32.join(path.win32.dirname(spec.items[0]), spec.name));
    return out;
  }
  const guard = (paths) => C.guardWrite(test, sandbox, paths, realpath);

  /** Restore / purge in a test: the bin keys are not sandbox paths, so check where each came FROM. */
  async function guardKeys(keys) {
    if (!test) return { ok: true };
    const r = await ctx.sidecar.send('files.recycle.list', {}, { timeoutMs: 10000 });
    if (!r.ok) return { ok: false, reason: `test mode: the Recycle Bin could not be read to check those items (${r.error})` };
    const byKey = new Map((r.result.items || []).map((x) => [String(x.key), x]));
    const paths = [];
    for (const k of keys) {
      const it = byKey.get(String(k));
      if (!it) return { ok: false, reason: 'test mode: an item is not in the Recycle Bin, refused' };
      paths.push(path.win32.join(String(it.orig || ''), String(it.n || '')));
    }
    return guard(paths);
  }

  /* ---- operations ----------------------------------------------------------------------------- */
  async function startOp(w, spec) {
    const op = spec.op;
    if (!OPS.includes(op)) return { ok: false, reason: 'unknown file operation' };
    if ((op === 'delete' || op === 'purge') && !spec.confirmed) return { ok: false, reason: 'a permanent delete needs the confirm first' };
    if (op === 'rename' || op === 'newfolder' || op === 'newfile') {
      const bad = C.badName(spec.name);
      if (bad) return { ok: false, reason: bad };
    }
    if ((op === 'restore' || op === 'purge')) {
      if (!Array.isArray(spec.keys) || !spec.keys.length) return { ok: false, reason: 'no Recycle Bin items given' };
      const g = await guardKeys(spec.keys);
      if (!g.ok) return { ok: false, reason: g.reason, refused: true };
    } else {
      if (op !== 'newfolder' && op !== 'newfile' && (!Array.isArray(spec.items) || !spec.items.length)) return { ok: false, reason: 'nothing selected' };
      const g = guard(touched(spec));
      if (!g.ok) return { ok: false, reason: g.reason, refused: true };
    }
    const job = newJob('op');
    const j = { job, kind: 'op', w: Number(spec.w), op, undo: !!spec.undo, at: Date.now(), count: 0,
      dirs: [spec.dest ? C.normPath(spec.dest) : null].concat((spec.items || []).map((x) => C.parentOf(typeof x === 'string' ? x : x && x.src))).filter(Boolean) };
    S.jobs.set(job, j);
    const owner = hwnd(spec.w);
    const r = op === 'restore' || op === 'purge'
      ? await ctx.sidecar.send(op === 'restore' ? 'files.recycle.restore' : 'files.recycle.purge', { keys: spec.keys, owner, job, confirmed: !!spec.confirmed }, { timeoutMs: 8000 })
      : await ctx.sidecar.send('files.op', { op, items: spec.items, dest: spec.dest || null, name: spec.name || null, conflict: spec.conflict || 'ask', owner, job, confirmed: !!spec.confirmed }, { timeoutMs: 8000 });
    if (!r.ok) {
      S.jobs.delete(job);
      return { ok: false, reason: `the ${LABEL[op]} did not start: ${r.error}` };
    }
    return { ok: true, job, op };
  }

  /** zip / unzip run here in main (lib/features/_files-zip.js) but look like any other job. */
  function jsJob(w, op, dirs, run) {
    const job = newJob('op');
    const j = { job, kind: 'op', js: true, w: Number(w), op, at: Date.now(), count: 0, cancel: false, dirs };
    S.jobs.set(job, j);
    let last = 0;
    const onProgress = (p) => {
      const now = Date.now();
      if (now - last < 100) return;
      last = now;
      push(j.w, 'files.progress', Object.assign({ job, op }, p));
    };
    Promise.resolve().then(() => run(onProgress, () => j.cancel)).then(
      (m) => opDone(j, m),
      (e) => {
        const cancelled = /cancelled/.test(e && e.message);
        opDone(j, { ok: false, aborted: cancelled, reason: cancelled ? 'cancelled' : `the ${LABEL[op]} failed (${(e && e.code) || 'error'})`, results: (j.src || []).map((s) => ({ src: s, ok: false, why: e && e.message })) });
      });
    return j;
  }

  async function zipCmd(a) {
    const items = (a.items || []).map(C.normPath).filter((p) => p && !C.isVirtual(p));
    if (!items.length) return { ok: false, reason: 'nothing selected to compress' };
    let dest = a.dest ? C.normPath(a.dest) : null;
    if (!dest) {
      const dir = C.parentOf(items[0]);
      let base = 'Archive';
      if (items.length === 1) { base = path.win32.basename(items[0]); try { if (!fs.statSync(items[0]).isDirectory()) base = base.replace(/\.[^.]+$/, '') || base; } catch (_) { /* keep it */ } }
      dest = path.win32.join(dir, C.uniqueName(dir, base + '.zip', exists));
    } else if (exists(dest)) return { ok: false, reason: 'a file with that name is already there' };
    const g = guard(items.concat([dest]));
    if (!g.ok) return { ok: false, reason: g.reason, refused: true };
    const j = jsJob(a.w, 'zip', [C.parentOf(dest)], async (onProgress, isCancelled) => {
      const r = await Z.zip({ items, dest, onProgress, isCancelled });
      return { ok: true, results: [{ src: items[0], dst: dest, ok: true }], stats: r };
    });
    j.src = items;
    return { ok: true, job: j.job, dest };
  }

  async function unzipCmd(a) {
    const zipPath = C.normPath(a.path);
    if (!zipPath || C.isVirtual(zipPath)) return { ok: false, reason: 'no zip file given' };
    let dest = a.dest ? C.normPath(a.dest) : null;
    if (!dest) {
      const dir = C.parentOf(zipPath);
      dest = path.win32.join(dir, C.uniqueName(dir, path.win32.basename(zipPath).replace(/\.zip$/i, '') || 'Extracted', exists, true));
    } else if (exists(dest)) return { ok: false, reason: 'the destination folder already exists; extract into a new folder' };
    const g = guard([zipPath, dest]);
    if (!g.ok) return { ok: false, reason: g.reason, refused: true };
    const j = jsJob(a.w, 'unzip', [C.parentOf(dest)], async (onProgress, isCancelled) => {
      const r = await Z.unzip({ zipPath, dest, onProgress, isCancelled });
      const results = [{ src: zipPath, dst: dest, ok: true }].concat(r.failed.map((f) => ({ src: zipPath, ok: false, why: `${f.name}: ${f.why}` })));
      return { ok: r.failed.length === 0, reason: r.failed.length ? `${r.failed.length} of ${r.files + r.failed.length} entries could not be extracted` : null, results, stats: r };
    });
    j.src = [zipPath];
    return { ok: true, job: j.job, dest };
  }

  /* ---- clipboard: Windows' (CF_HDROP via the sidecar) live, Mantle's own in a test ---------- */
  async function clipGet() {
    if (!test) {
      const r = await ctx.sidecar.send('files.clip.get', {}, { timeoutMs: 4000 });
      if (r.ok && r.result && Array.isArray(r.result.paths) && r.result.paths.length) return { paths: r.result.paths, cut: !!r.result.cut, from: 'windows' };
    }
    return { paths: S.clip.paths.slice(), cut: S.clip.cut, from: 'mantle' };
  }

  /** Paste and drop: conflicts are asked of the page first (Mantle's own dialog), then the op runs. */
  async function transfer(w, paths, dest, op, conflict) {
    const d0 = C.normPath(dest);
    if (!d0 || C.isVirtual(d0)) return { ok: false, reason: 'files can only go into a real folder' };
    const items = paths.map(C.normPath).filter((p) => p && !C.isVirtual(p));
    if (!items.length) return { ok: false, reason: 'nothing to paste' };
    if (C.intoItself(items, d0)) return { ok: false, reason: 'a folder cannot be moved or copied into itself' };
    const same = items.every((p) => (C.parentOf(p) || '').toLowerCase() === d0.toLowerCase());
    if (same && op === 'move') return { ok: true, started: false, reason: 'they are already in this folder' };
    let c = conflict;
    if (!c && same) c = 'keepboth';                            // a copy into its own folder: "name (2)"
    if (!c) {
      const r = await ctx.sidecar.send('files.conflicts', { items, dest: d0 }, { timeoutMs: 6000 });
      if (r.ok && r.result && Array.isArray(r.result.conflicts) && r.result.conflicts.length) {
        return { ok: true, started: false, needConflict: true, conflicts: r.result.conflicts, op, items, dest: d0 };
      }
      c = 'ask';
    }
    const r = await startOp(w, { w, op, items, dest: d0, conflict: c });
    return r && r.ok && r.job ? Object.assign({ count: items.length }, r) : r;   // count: the page's "Copying N items"
  }

  /* ---- thumbnails: disk cache first, then the sidecar, newest request first ------------------ */
  function thumbFile(key, kind) { return path.join(thumbDir, `${key}.${kind}.png`); }
  function pumpThumbs() {
    while (S.thumbBusy < THUMB_PAR && S.thumbQ.length) {
      const b = S.thumbQ.pop();                                 // newest first: what is on screen NOW
      S.thumbBusy++;
      ctx.sidecar.send('files.thumbs', { items: b.need.map((x) => ({ path: x.p })), px: b.px, mode: b.mode }, { timeoutMs: 20000 }).then(async (r) => {
        const res = r.ok && r.result && Array.isArray(r.result.results) ? r.result.results : [];
        await Promise.all(b.need.map(async (x, i) => {
          const one = res[i];
          if (!r.ok || !one) { x.done({ path: x.path, url: null, why: r.ok ? 'no answer for it' : r.error }); return; }
          if (!one.png) {
            if (S.thumbMiss.size > 5000) S.thumbMiss.clear();
            S.thumbMiss.set(x.key, one.why || 'no thumbnail');
            x.done({ path: x.path, url: null, kind: null, why: one.why || 'no thumbnail' });
            return;
          }
          const kind = one.kind === 'icon' ? 'i' : 't';
          if (S.thumbDisk) {
            try {
              const f = thumbFile(x.key, kind);
              await fs.promises.writeFile(f, Buffer.from(one.png, 'base64'));
              x.done({ path: x.path, url: C.fileUrl(f), kind: one.kind || 'thumb', w: one.w, h: one.h });
              return;
            } catch (_) { /* fall through to a data URL */ }
          }
          x.done({ path: x.path, url: 'data:image/png;base64,' + one.png, kind: one.kind || 'thumb', w: one.w, h: one.h });
        }));
      }).catch(() => { for (const x of b.need) x.done({ path: x.path, url: null, why: 'the thumbnail request failed' }); })
        .finally(() => { S.thumbBusy--; pumpThumbs(); });
    }
  }
  async function thumbs(a) {
    const px = Math.max(16, Math.min(512, Number(a.px) || 96));
    const mode = a.mode === 'icon' ? 'icon' : 'thumb';
    const items = Array.isArray(a.items) ? a.items.slice(0, 240) : [];
    const results = new Array(items.length);
    const need = [];
    items.forEach((it, i) => {
      const p = C.normPath(it && it.path);
      if (!p || C.isVirtual(p)) { results[i] = { path: it && it.path, url: null, why: 'not a file' }; return; }
      const key = C.thumbKey(p, it.m, it.s, px, mode);
      if (S.thumbMiss.has(key)) { results[i] = { path: it.path, url: null, kind: null, why: S.thumbMiss.get(key) }; return; }
      if (S.thumbDisk) {
        for (const k of ['t', 'i']) {
          const f = thumbFile(key, k);
          if (exists(f)) { results[i] = { path: it.path, url: C.fileUrl(f), kind: k === 't' ? 'thumb' : 'icon' }; return; }
        }
      }
      need.push({ i, p, key, path: it.path });
    });
    const waits = [];
    for (let s = 0; s < need.length; s += THUMB_BATCH) {
      const chunk = need.slice(s, s + THUMB_BATCH);
      waits.push(new Promise((resolve) => {
        let left = chunk.length;
        for (const x of chunk) x.done = (r) => { results[x.i] = r; if (--left === 0) resolve(); };
        S.thumbQ.push({ need: chunk, px, mode });
      }));
    }
    while (S.thumbQ.length > THUMB_QUEUE_MAX) {
      const old = S.thumbQ.shift();
      for (const x of old.need) x.done({ path: x.path, url: null, skipped: true, why: 'skipped: scrolled away' });
    }
    pumpThumbs();
    await Promise.all(waits);
    return { results };
  }
  async function pruneThumbs() {
    if (!S.thumbDisk) return;
    try {
      const names = await fs.promises.readdir(thumbDir);
      if (names.length < THUMB_PRUNE_AT) return;
      const st = [];
      for (const n of names) { try { st.push({ n, t: (await fs.promises.stat(path.join(thumbDir, n))).atimeMs }); } catch (_) { /* gone */ } }
      st.sort((x, y) => y.t - x.t);
      let gone = 0;
      for (const x of st.slice(THUMB_KEEP)) { try { await fs.promises.unlink(path.join(thumbDir, x.n)); gone++; } catch (_) { /* in use */ } }
      ctx.log(`thumbnail cache: ${gone} old thumbnails removed, ${Math.min(st.length, THUMB_KEEP)} kept`);
    } catch (e) { ctx.log(`thumbnail cache prune failed (${e.code || e.message})`); }
  }
  const pruneTimer = setTimeout(pruneThumbs, 60 * 1000);
  if (pruneTimer.unref) pruneTimer.unref();

  /* ---- previews ------------------------------------------------------------------------------- */
  async function preview(a) {
    const p = C.normPath(a.path);
    if (!p || C.isVirtual(p)) return { kind: 'none', why: 'nothing to preview' };
    let st;
    try { st = await fs.promises.stat(p); } catch (e) { return { kind: 'none', why: `it cannot be read (${e.code || 'error'})` }; }
    if (st.isDirectory()) return { kind: 'none', why: 'Folders have no preview; Properties (Alt+Enter) shows what is inside', folder: true };
    const k = C.previewKind(p);
    if (k === 'image' || k === 'video' || k === 'audio' || k === 'pdf') return { kind: k, url: C.fileUrl(p), size: st.size };
    if (k === 'none') return { kind: 'none', why: C.noPreviewWhy(p) };
    if (k === 'sniff' && st.size > 8 * 1024 * 1024) return { kind: 'none', why: 'no preview for this kind of file' };
    let fh;
    try {
      fh = await fs.promises.open(p, 'r');
      const n = Math.min(st.size, C.TEXT_MAX);
      const buf = Buffer.alloc(n);
      await fh.read(buf, 0, n, 0);
      const dec = C.decodeText(buf);
      if (dec.binary) return { kind: 'none', why: 'a binary file: no text to show' };
      return { kind: 'text', text: dec.text, encoding: dec.encoding, truncated: st.size > C.TEXT_MAX, size: st.size };
    } catch (e) {
      return { kind: 'none', why: `it cannot be read (${e.code || 'error'})` };
    } finally { if (fh) await fh.close().catch(() => {}); }
  }

  /* ---- commands ------------------------------------------------------------------------------- */
  const need = (w) => { if (!rec(w)) throw new Error('that Mantle Files window is gone'); };

  ctx.command('boot', async (a) => {
    const r = rec(a.w);
    if (!r) return { ok: false, reason: 'that Mantle Files window is gone' };
    const top = S.undo.peek();
    return { ok: true, w: r.key, path: r.start, select: r.select || null, options: opts(), test, sandbox: sandbox ? sandbox.root || null : null,
      home, pins: pinRows(), undo: top ? { label: top.label } : null, sep: '\\', notice: r.notice || S.sidecarWhy || null, names: S.names };
  });
  ctx.command('open', async (a) => {
    if (a && a.w !== undefined && a.path !== undefined) {           // files.open from a page: the default app
      const p = C.normPath(a.path);
      if (!p || C.isVirtual(p)) return { ok: false, reason: 'nothing to open' };
      if (test) return { ok: true, dryRun: true, reason: 'test mode: would open it in its app' };
      const shell = d.shell || E.shell;
      const err = await shell.openPath(p);
      if (err) return { ok: false, reason: `Windows could not open it (${String(err).split(p).join('it').split(path.win32.basename(p)).join('it')})` };
      const recent = (get('recent', []) || []).filter((x) => x && String(x.path).toLowerCase() !== p.toLowerCase());
      recent.unshift({ path: p, n: path.win32.basename(p), d: 0, m: Date.now() });
      saveLater('recent', recent.slice(0, 50));
      return { ok: true };
    }
    return openWindow(a);                                          // files.open {path?} from elsewhere: a window
  });
  ctx.command('newwindow', async (a) => openWindow({ path: a.path }));
  ctx.command('win', async (a) => {
    const win = winOf(a.w);
    if (!win) return { ok: false, reason: 'the window is not open' };
    if (a.op === 'close') { closeWindow(a.w, 'closed by its button'); return { ok: true }; }
    if (test) return { ok: true, dryRun: true, reason: `test mode: would ${a.op} the window` };
    if (a.op === 'min') win.minimize();
    else if (a.op === 'max') { if (win.isMaximized()) win.unmaximize(); else win.maximize(); }
    else return { ok: false, reason: 'unknown window button' };
    return { ok: true, maximized: win.isMaximized() };
  });
  ctx.command('roots', async (a) => {
    const r = await roots(!!(a && a.fresh));
    if (!r.ok) return { ok: false, reason: `drives and folders could not be read: ${r.error}`, pins: pinRows() };
    return Object.assign({ ok: true }, r.result, { pins: pinRows() });
  });
  ctx.command('home', async () => {
    const r = await ctx.sidecar.send('files.recent', { max: 40 }, { timeoutMs: 6000 });
    const win = r.ok && r.result && Array.isArray(r.result.items) ? r.result.items : [];
    return { ok: true, pins: pinRows(), recent: C.mergeRecent([get('recent', []), win], 40), recentWhy: r.ok ? null : `Windows' recent files could not be read: ${r.error}` };
  });
  ctx.command('list', async (a) => {
    need(a.w);
    const p = C.normPath(a.path);
    if (!p) return { ok: false, reason: 'that is not a folder path (try C:\\ or \\\\server\\share)' };
    if (!S.roots) await roots(false);
    const base = { ok: true, path: p, parent: C.parentOf(p), crumbs: C.crumbs(p, S.names), view: C.getView(get('views', {}), p) };
    if (p === 'mantle:thispc' || p === 'mantle:network') {
      const r = await roots(true);
      if (!r.ok) return { ok: false, reason: `drives could not be read: ${r.error}` };
      watch(a.w, a.tab, null);
      return Object.assign(base, { drives: r.result.drives || [], known: r.result.known || [], network: r.result.network || [] });
    }
    if (p === 'mantle:recycle') {
      const r = await ctx.sidecar.send('files.recycle.list', {}, { timeoutMs: 15000 });
      if (!r.ok) return { ok: false, reason: `the Recycle Bin could not be read: ${r.error}` };
      watch(a.w, a.tab, null);
      return Object.assign(base, { recycle: r.result.items || [], count: r.result.count, bytes: r.result.bytes });
    }
    if (p === 'mantle:home') { watch(a.w, a.tab, null); return base; }
    const job = newJob('list');
    S.jobs.set(job, { job, kind: 'list', w: Number(a.w), tab: a.tab, at: Date.now(), count: 0 });
    const r = await ctx.sidecar.send('files.list', { path: p, job }, { timeoutMs: 6000 });
    if (!r.ok) { S.jobs.delete(job); return { ok: false, reason: `the folder could not be read: ${r.error}` }; }
    return Object.assign(base, { job }, watch(a.w, a.tab, p));
  });
  ctx.command('cancel', async (a) => {
    const j = S.jobs.get(a.job);
    if (j && j.js) { j.cancel = true; return { ok: true, cancelled: true }; }
    const r = await ctx.sidecar.send('files.cancel', { job: a.job }, { timeoutMs: 3000 });
    return r.ok ? Object.assign({ ok: true }, r.result) : { ok: false, reason: `not cancelled: ${r.error}` };
  });
  ctx.command('search', async (a) => {
    need(a.w);
    const p = C.normPath(a.path);
    const q = String(a.query || '').trim();
    if (!p || C.isVirtual(p)) return { ok: false, reason: 'search works inside a real folder' };
    if (!q) return { ok: false, reason: 'type something to search for' };
    const job = newJob('search');
    S.jobs.set(job, { job, kind: 'search', w: Number(a.w), tab: a.tab, at: Date.now(), count: 0 });
    const r = await ctx.sidecar.send('files.search', { path: p, query: q, job, max: SEARCH_MAX }, { timeoutMs: 6000 });
    if (!r.ok) { S.jobs.delete(job); return { ok: false, reason: `the search did not start: ${r.error}` }; }
    return { ok: true, job };
  });
  ctx.command('size', async (a) => {
    const p = C.normPath(a.path);
    if (!p || C.isVirtual(p)) return { ok: false, reason: 'no folder given' };
    const job = newJob('size');
    S.jobs.set(job, { job, kind: 'size', w: Number(a.w), at: Date.now(), count: 0 });
    const r = await ctx.sidecar.send('files.size', { path: p, job }, { timeoutMs: 6000 });
    if (!r.ok) { S.jobs.delete(job); return { ok: false, reason: `the size could not be counted: ${r.error}` }; }
    return { ok: true, job };
  });
  ctx.command('stat', async (a) => {
    const p = C.normPath(a.path);
    if (!p || C.isVirtual(p)) return { ok: false, reason: 'no file given' };
    const r = await ctx.sidecar.send('files.stat', { path: p }, { timeoutMs: 6000 });
    return r.ok ? Object.assign({ ok: true, location: C.parentOf(p) }, r.result) : { ok: false, reason: `its properties could not be read: ${r.error}` };
  });
  ctx.command('icons', async (a) => {
    const px = [16, 32, 48, 256].includes(Number(a.px)) ? Number(a.px) : 32;
    const exts = Array.isArray(a.exts) ? a.exts.slice(0, 200).map((e) => String(e).toLowerCase()) : [];
    const icons = {};
    const missing = [];
    for (const e of exts) { const hit = S.icons.get(`${e}|${px}`); if (hit !== undefined) { if (hit) icons[e] = hit; } else missing.push(e); }
    if (missing.length) {
      const r = await ctx.sidecar.send('files.icons', { exts: missing, px }, { timeoutMs: 8000 });
      if (!r.ok) return { ok: true, icons, why: `some icons could not be read: ${r.error}` };
      const got = (r.result && r.result.icons) || {};
      for (const e of missing) { const url = got[e] ? 'data:image/png;base64,' + got[e] : null; S.icons.set(`${e}|${px}`, url); if (url) icons[e] = url; }
    }
    return { ok: true, icons };
  });
  ctx.command('types', async (a) => {
    const exts = Array.isArray(a.exts) ? a.exts.slice(0, 200).map((e) => String(e).toLowerCase()) : [];
    const types = {};
    const missing = exts.filter((e) => { if (S.types.has(e)) { types[e] = S.types.get(e); return false; } return true; });
    if (missing.length) {
      const r = await ctx.sidecar.send('files.types', { exts: missing }, { timeoutMs: 6000 });
      if (r.ok) for (const e of missing) { const t = r.result && r.result.types && r.result.types[e]; if (t) { S.types.set(e, t); types[e] = t; } }
    }
    return { ok: true, types };
  });
  ctx.command('thumbs', thumbs);
  ctx.command('preview', preview);
  ctx.command('op', async (a) => { need(a.w); return startOp(a.w, Object.assign({}, a, { undo: false })); });
  ctx.command('conflicts', async (a) => {
    const r = await ctx.sidecar.send('files.conflicts', { items: a.items || [], dest: C.normPath(a.dest) }, { timeoutMs: 6000 });
    return r.ok ? Object.assign({ ok: true }, r.result) : { ok: false, reason: `the destination could not be checked: ${r.error}` };
  });
  ctx.command('undo', async (a) => {
    need(a.w);
    const top = S.undo.pop();
    if (!top) return { ok: false, reason: 'nothing to undo' };
    const r = top.op === 'restore'
      ? await startOp(a.w, { w: a.w, op: 'restore', keys: top.keys, undo: true })
      : await startOp(a.w, { w: a.w, op: top.op, items: top.items, name: top.name, dest: top.dest, conflict: top.op === 'move' ? 'ask' : undefined, undo: true });
    if (!r.ok) S.undo.putBack(top);                               // it did not start: still undoable
    const next = S.undo.peek();
    toAll('files.undo', { label: next ? next.label : null });
    return r.ok ? { ok: true, job: r.job, label: top.label } : { ok: false, reason: `${top.label} failed: ${r.reason}` };
  });
  ctx.command('clip', async (a) => {
    const paths = (a.paths || []).map(C.normPath).filter((p) => p && !C.isVirtual(p));
    if (!paths.length) return { ok: false, reason: 'nothing selected' };
    const cut = a.op === 'cut';
    S.clip = { paths, cut };
    toAll('files.clip', { count: paths.length, cut, paths });
    if (test) return { ok: true, count: paths.length, cut, internal: true };
    const r = await ctx.sidecar.send('files.clip.set', { paths, cut }, { timeoutMs: 4000 });
    if (!r.ok) return { ok: true, count: paths.length, cut, internal: true, note: `Windows' clipboard was not written (${r.error}); paste works inside Mantle Files only` };
    return { ok: true, count: paths.length, cut };
  });
  ctx.command('clipinfo', async () => {
    const c = await clipGet();
    return { ok: true, count: c.paths.length, cut: c.cut, from: c.from };
  });
  ctx.command('paste', async (a) => {
    need(a.w);
    const c = await clipGet();
    if (!c.paths.length) return { ok: false, reason: 'the clipboard has no files' };
    const r = await transfer(a.w, c.paths, a.dest, c.cut ? 'move' : 'copy', a.conflict);
    if (r.ok && r.job && c.cut) { S.clip = { paths: [], cut: false }; toAll('files.clip', { count: 0, cut: false, paths: [] }); }
    return r;
  });
  ctx.command('drop', async (a) => {
    need(a.w);
    const paths = Array.isArray(a.paths) ? a.paths : [];
    if (!paths.length) return { ok: false, reason: 'only files and folders can be dropped here' };
    return transfer(a.w, paths, a.dest, C.dropEffect(a.effect, paths, a.dest), a.conflict);
  });
  ctx.command('drag', async (a) => {
    const win = winOf(a.w);
    const paths = (a.paths || []).map(C.normPath).filter((p) => p && !C.isVirtual(p));
    if (!win || !paths.length) return { ok: false, reason: 'nothing to drag' };
    if (test) return { ok: true, dryRun: true, reason: 'test mode: an OS drag would start here' };
    const nativeImage = d.nativeImage || E.nativeImage;
    let icon = null;
    try {
      const e = C.extOf(paths[0]);
      const hit = S.icons.get(`.${e}|32`) || S.icons.get('folder|32');
      if (hit) icon = nativeImage.createFromDataURL(hit);
      if ((!icon || icon.isEmpty()) && exists(ICON.replace(/\.ico$/, '.png'))) icon = nativeImage.createFromPath(ICON.replace(/\.ico$/, '.png'));
      if (!icon || icon.isEmpty()) icon = nativeImage.createFromBitmap(Buffer.alloc(32 * 32 * 4, 0x88), { width: 32, height: 32 });
      win.webContents.startDrag({ file: paths[0], files: paths, icon });
      return { ok: true, count: paths.length };
    } catch (e) { return { ok: false, reason: `the drag did not start (${e.message})` }; }
  });
  ctx.command('handlers', async (a) => {
    const r = await ctx.sidecar.send('files.handlers', { path: C.normPath(a.path) }, { timeoutMs: 6000 });
    return r.ok ? Object.assign({ ok: true }, r.result) : { ok: false, reason: `the apps for it could not be read: ${r.error}` };
  });
  ctx.command('openwith', async (a) => {
    if (test) return { ok: true, dryRun: true, reason: 'test mode: would open it with that app' };
    const r = await ctx.sidecar.send('files.openwith', { path: C.normPath(a.path), handler: a.handler, owner: hwnd(a.w) }, { timeoutMs: 8000 });
    return r.ok ? { ok: true } : { ok: false, reason: `that app did not open it: ${r.error}` };
  });
  ctx.command('openwithdialog', async (a) => {
    if (test) return { ok: true, dryRun: true, reason: "test mode: would show Windows' Open with dialog" };
    const r = await ctx.sidecar.send('files.openwithdialog', { path: C.normPath(a.path), owner: hwnd(a.w) }, { timeoutMs: 8000 });
    return r.ok ? { ok: true } : { ok: false, reason: `the Open with dialog did not open: ${r.error}` };
  });
  ctx.command('verbs', async (a) => {
    const paths = (a.paths || []).map(C.normPath).filter((p) => p && !C.isVirtual(p));
    if (!paths.length) return { ok: false, reason: 'nothing selected' };
    const r = await ctx.sidecar.send('files.verbs', { paths }, { timeoutMs: 10000 });
    return r.ok ? Object.assign({ ok: true }, r.result) : { ok: false, reason: `the other apps' commands could not be read: ${r.error}` };
  });
  ctx.command('verb', async (a) => {
    if (test) return { ok: true, dryRun: true, reason: "test mode: would run that app's command" };
    const r = await ctx.sidecar.send('files.verb', { token: a.token, cmd: a.cmd, owner: hwnd(a.w) }, { timeoutMs: 15000 });
    return r.ok ? { ok: true } : { ok: false, reason: `that command did not run: ${r.error}` };
  });
  ctx.command('copypath', async (a) => {
    const text = C.quotePaths((a.paths || []).map(C.normPath).filter(Boolean));
    if (!text) return { ok: false, reason: 'nothing selected' };
    if (test) return { ok: true, text, dryRun: true };
    try { (d.clipboard || E.clipboard).writeText(text); return { ok: true, text }; } catch (e) { return { ok: false, reason: `the clipboard could not be written (${e.message})` }; }
  });
  ctx.command('zip', zipCmd);
  ctx.command('unzip', unzipCmd);
  ctx.command('recycle', async (a) => {
    need(a.w);
    if (a.op === 'restore') return startOp(a.w, { w: a.w, op: 'restore', keys: a.keys });
    if (a.op === 'purge') return startOp(a.w, { w: a.w, op: 'purge', keys: a.keys, confirmed: !!a.confirmed });
    if (a.op === 'empty') {
      if (test) return { ok: false, reason: 'test mode: emptying the Recycle Bin is never allowed', refused: true };
      if (!a.confirmed) return { ok: false, reason: 'emptying the Recycle Bin needs the confirm first' };
      // The sidecar answers {job, started} and finishes with 'files.opdone' like any other op.
      const job = newJob('op');
      S.jobs.set(job, { job, kind: 'op', w: Number(a.w), op: 'empty', at: Date.now(), count: 0, dirs: ['mantle:recycle'] });
      const r = await ctx.sidecar.send('files.recycle.empty', { owner: hwnd(a.w), confirmed: true, job }, { timeoutMs: 8000 });
      if (!r.ok) { S.jobs.delete(job); return { ok: false, reason: `the Recycle Bin was not emptied: ${r.error}` }; }
      return { ok: true, job };
    }
    return { ok: false, reason: 'unknown Recycle Bin action' };
  });
  ctx.command('pin', async (a) => {
    const p = C.normPath(a.path);
    if (!p || C.isVirtual(p)) return { ok: false, reason: 'only a folder can be pinned' };
    let list = pins().filter((x) => String(x).toLowerCase() !== p.toLowerCase());
    if (a.on !== false) list = list.concat([p]);
    try { ctx.settings.set('pins', list); } catch (e) { return { ok: false, reason: `the pin was not saved (${e.message})` }; }
    const rows = pinRows();
    toAll('files.pins', { pins: rows });
    return { ok: true, pins: rows };
  });
  ctx.command('setview', async (a) => {
    const p = C.normPath(a.path);
    if (!p) return { ok: false, reason: 'no folder given' };
    const views = C.putView(S.pending.views || get('views', {}), p, a);
    saveLater('views', views);
    return { ok: true };
  });
  ctx.command('setopt', async (a) => {
    if (!OPT_KEYS.includes(a.key)) return { ok: false, reason: 'unknown Mantle Files option' };
    let v = a.value;
    if (a.key === 'defaultView' && !['details', 'list', 'grid'].includes(v)) return { ok: false, reason: 'the view must be details, list or grid' };
    if (a.key === 'startIn' && !['last', 'home'].includes(v)) return { ok: false, reason: 'start in must be last or home' };
    if (['showHidden', 'showExtensions', 'replaceExplorer'].includes(a.key)) v = !!v;
    try { ctx.settings.set(a.key, v); } catch (e) { return { ok: false, reason: `not saved (${e.message})` }; }
    toAll('files.opts', { options: opts() });
    return { ok: true, options: opts() };
  });
  ctx.command('tabs', async (a) => {
    const r = rec(a.w);
    if (!r) return { ok: false, reason: 'that Mantle Files window is gone' };
    const tabs = Array.isArray(a.tabs) ? a.tabs : [];
    r.tabs = tabs.map((t) => (t && typeof t === 'object' ? t.path : t)).filter(Boolean);
    r.active = Math.max(0, Math.min(r.tabs.length - 1, Number(a.active) || 0));
    const ids = new Set(tabs.filter((t) => t && typeof t === 'object' && t.tab !== undefined).map((t) => `${r.key}|${t.tab}`));
    if (ids.size) for (const k of [...S.watchers.keys()]) if (k.startsWith(r.key + '|') && !ids.has(k)) { const wt = S.watchers.get(k); try { wt.watcher.close(); } catch (_) { /* gone */ } clearTimeout(wt.timer); S.watchers.delete(k); }
    const cur = C.normPath(r.tabs[r.active]);
    if (cur) saveLater('lastFolder', cur);
    return { ok: true };
  });

  if (typeof ctx.onOption === 'function') ctx.onOption('*', () => toAll('files.opts', { options: opts() }));
  if (HAS_CHORD) ctx.onChord(CHORD, () => { const r = openWindow({}); if (!r.ok) ctx.log(`Win+E: ${r.reason}`); });

  /* The launcher's "Mantle Files" row and the top bar: 'mantle-open' with 'files' (or 'files:<path>')
     on the shared event, or 'mantle-open:files' (path) on our own, listened to ONLY while on, so a
     caller that checks app.listenerCount('mantle-open:files') can say "switched off" instead of
     doing nothing (the shared event always has lib/wallpaper.js listening). */
  const onShared = (target) => { const t = String(target || ''); if (t === 'files' || t.startsWith('files:')) openWindow({ path: t.slice(6) || undefined }); };
  const onOwn = (p) => { openWindow({ path: typeof p === 'string' && p ? p : undefined }); };
  const listen = (on) => {
    if (!app || typeof app.on !== 'function') return;
    app.removeListener('mantle-open', onShared);
    app.removeListener('mantle-open:files', onOwn);
    if (on) { app.on('mantle-open', onShared); app.on('mantle-open:files', onOwn); }
  };
  listen(ctx.enabled());
  ctx.onEnabled((on) => {
    listen(on);
    if (!on) for (const k of [...S.wins.keys()]) closeWindow(k, 'switched off in the tray');
  });

  ctx.health(true);
  return {
    async stop(why) {
      S.stopped = true;
      listen(false);
      clearTimeout(pruneTimer);
      flushSaves();
      for (const k of [...S.wins.keys()]) closeWindow(k, why || 'stopped');
      for (const [job, j] of S.jobs) { if (j.js) j.cancel = true; else if (j.kind !== 'op') ctx.sidecar.send('files.cancel', { job }); }
    },
    // files.test.js
    _S: S, _open: openWindow, _opDone: opDone, _sandbox: sandbox, _thumbDir: thumbDir,
  };
}

module.exports = {
  name: 'files',
  label: 'Mantle Files (Win+E)',
  defaultOn: true,
  chords: HAS_CHORD ? [CHORD] : [],
  observe: [],
  rest: false,          // see "NOT RESTING" in the header
  options: [
    { key: 'showHidden', label: 'Show hidden files and folders', type: 'bool', default: false },
    { key: 'showExtensions', label: 'Show file name extensions', type: 'bool', default: true },
    { key: 'defaultView', label: 'View for folders you have not set', type: 'choice',
      choices: [{ value: 'details', label: 'Details' }, { value: 'list', label: 'List' }, { value: 'grid', label: 'Grid' }], default: 'details' },
    { key: 'startIn', label: 'Win+E opens', type: 'choice', choices: [{ value: 'last', label: 'The last folder' }, { value: 'home', label: 'Home' }], default: 'last' },
    { key: 'replaceExplorer', label: 'Open Mantle Files instead of Explorer',
      help: 'Phase 2, off by default: nothing is registered with Windows yet. When it ships, other apps\' "open folder" will come here, with File Explorer as the fallback whenever Mantle is not running.',
      type: 'bool', default: false },
  ],
  install: (ctx) => install(ctx),
  _install: install,             // files.test.js: the same install against a fake ctx, windows and sidecar
  TITLE, CHORD, HAS_CHORD, APP_ID, ICON,
};
