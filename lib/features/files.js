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
 * give their RAM back. By default Mantle Files keeps NO hidden window: a window exists only while
 * Owen has it open (destroyed on close), so resting would free nothing, would close folders he opened
 * on purpose, and could cut an in-flight copy's window off from its result. Win+E still goes back to
 * Explorer if the feature is off or unhealthy. The opt-in keepReady spare (one hidden window) is the
 * exception: ctx.onRest destroys it for the game and makes it again after.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('./_files-core.js');
const Z = require('./_files-zip.js');
const G = require('./_files-grep.js');
const WW = require('./_wall-window.js');

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
const THUMB_PRUNE_EVERY = 500;           // new thumbnails written between two prunes (Mantle runs for days)
const SEARCH_MAX = 5000;
/* RENDERER ABUSE LIMITS (lane files-main, 2026-09-29). A page can send anything, so every argument is
   checked here before it reaches the sidecar, the shell or the disk. The limits sit far above what a
   person does (a Ctrl+A of a 100k-item folder still copies) and far below what hangs main. */
const MAX_ITEMS = 100000;                // items in one op / paste / drop / zip
const MAX_SHELL_ITEMS = 1000;            // items handed to the shell at once (a context menu, a drag)
const MAX_WINS = 40;                     // open Mantle Files windows
const MAX_TABS = 100;                    // tabs one window reports
const MAX_PINS = 100;
const QUERY_MAX = 260;                   // a search's text
const CACHE_MAX = 4000;                  // icons / file types kept in memory
/* FAST COLD OPEN (lane mantle-files, 2026-10-15; Owen: no hidden windows by default, "i need to save ram").
   The last folder's first LAST_KEEP items live in a small file (features/files-last.json) and in memory,
   so a cold window draws them at once and the live listing replaces them. */
const LAST_FILE = 'files-last.json';
const LAST_KEEP = 400;                   // items kept for the cached first view (~40 KB on disk)
const LAST_LISTS = 3;                    // recent listings remembered in memory to write the cache from
const COLD_HOLD_MS = 50;                 // plan R3: the dark wallpaper may hold a cold show this long, no more
const SPARE_IDLE_MS = 4000;              // keepReady: a spare is made this long after start / a close, if still wanted
const CONFLICTS = ['ask', 'replace', 'keepboth', 'skip'];
const GONE = 'This Mantle Files window has closed; open a new one with Win+E';
const NOT_PATH = 'one of the items is not a file or folder Mantle Files can use';
const TOO_MANY = (n) => `that is too many items at once (${n.toLocaleString('en-US')} at most); select fewer and try again`;
const OPS = ['copy', 'move', 'recycle', 'delete', 'rename', 'newfolder', 'newfile', 'restore', 'purge'];
const OPT_KEYS = ['showHidden', 'showExtensions', 'defaultView', 'startIn', 'searchContents', 'compact', 'checkboxes'];
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
  const TH = { keep: d.thumbKeep || THUMB_KEEP, at: d.thumbPruneAt || THUMB_PRUNE_AT, every: d.thumbPruneEvery || THUMB_PRUNE_EVERY };
  const showInTest = process.env.MANTLE_FILES_TEST_SHOW === '1';
  // TEST ONLY: the end-to-end self-drive (lib/features/_files-e2e.js); never loaded by a live Mantle.
  const E2E = test && process.env.MANTLE_FILES_SELFTEST === '1' && sandbox && sandbox.root ? require('./_files-e2e') : null;

  const S = {
    wins: new Map(), nextWin: 1, opens: 0, jobs: new Map(), nextJob: 1,
    // ONE undo history and ONE redo history for every Mantle Files window, as Explorer has: Ctrl+Z in
    // any window undoes the last thing done in any of them, and every window shows the same label.
    undo: C.createUndoStack(), redo: C.createUndoStack(), clip: { paths: [], cut: false },
    icons: new Map(), types: new Map(), thumbMiss: new Map(), thumbQ: [], thumbBusy: 0, thumbDisk: true, thumbWrites: 0, pruning: false,
    watchers: new Map(), names: {}, roots: null, rootsAt: 0,
    stopped: false, crashed: null, sidecarWhy: null, saveTimer: null, pending: {},
    hashes: new Map(),                   // window key -> the checksum read stream still running
    last: null,                          // { path, items, count, at }: the cached first view of the last folder
    lists: new Map(),                    // path (lower) -> { path, items, count, at }: recent complete listings, LAST_LISTS
    spare: null,                         // keepReady: { key, win, ready } a hidden window waiting for the next open
    spareTimer: null, resting: false,
  };
  if (test) ctx.log(`test mode: writes ${sandbox && sandbox.root ? 'only inside the files sandbox' : `refused (${sandbox.why})`}`);

  try { fs.mkdirSync(thumbDir, { recursive: true }); } catch (e) { S.thumbDisk = false; ctx.log(`thumbnail cache folder unavailable (${e.code}); thumbnails are kept in memory only`); }

  /* ---- settings ------------------------------------------------------------------------------ */
  const get = (k, dflt) => { try { return ctx.settings.get(k, dflt); } catch (_) { return dflt; } };
  const opts = () => ({
    showHidden: !!get('showHidden', false), showExtensions: get('showExtensions', true) !== false,
    defaultView: ['details', 'list', 'grid'].includes(get('defaultView', 'details')) ? get('defaultView', 'details') : 'details',
    startIn: get('startIn', 'last') === 'home' ? 'home' : 'last',
    searchContents: !!get('searchContents', false), compact: !!get('compact', false), checkboxes: !!get('checkboxes', false),
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
      // the code only: a settings error's message names the settings file's path
      try { ctx.settings.set(k, p[k]); } catch (e) { ctx.log(`settings: "${k}" not saved (${(e && e.code) || 'error'})`); }
    }
  }
  /* ---- the last folder and its cached first view (lane mantle-files) --------------------------- */
  /** 'dir' | 'file' | null, never throws. Only a path on a KNOWN local drive is stat'ed on the open path
      (C.statMayBlock): a UNC path, a mapped / network drive letter, or a letter the drive list has not
      named yet is taken as a folder, because an unreachable share blocks a sync stat (and so the bar and
      every window) for the SMB timeout. verifyStart then checks it off the main thread (review2 #4). */
  const statKind = d.statKind || ((p) => { try { return fs.statSync(p).isDirectory() ? 'dir' : 'file'; } catch (_) { return null; } });
  const sysDrive = d.sysDrive !== undefined ? d.sysDrive : (process.env.SystemDrive || 'C:');
  const mayBlock = (p) => C.statMayBlock(p, S.roots && S.roots.drives, sysDrive);
  const kindNow = (p) => (mayBlock(p) ? 'dir' : statKind(p));
  /** async: 'dir' | 'file' | null (gone) | 'unreachable' (any other error: offline drive, no access). */
  const kindLater = d.statKindAsync || ((p) => fs.promises.stat(p).then((st) => (st.isDirectory() ? 'dir' : 'file'),
    (e) => (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR') ? null : 'unreachable')));
  const VERIFY_MS = d.verifyMs || 3000;
  const lastFile = path.join(settingsDir, LAST_FILE);
  const sameP = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
  /** Read once at start, off the open path: the open itself only ever reads S.last. */
  function loadLast() {
    fs.promises.readFile(d.lastFile || lastFile, 'utf8').then((txt) => {
      const j = JSON.parse(txt);
      if (j && typeof j.path === 'string' && Array.isArray(j.items) && !S.last) S.last = { path: j.path, items: j.items.slice(0, LAST_KEEP), count: j.count | 0, at: j.at || 0 };
    }).catch((e) => { if (e && e.code !== 'ENOENT') ctx.log(`the cached last folder was not read (${e.code || e.name || 'error'}); the next open lists it fresh`); });
  }
  let lastWriteT = null;
  function writeLastSoon() {
    clearTimeout(lastWriteT);
    lastWriteT = setTimeout(() => {
      const L = S.last;
      if (!L) return;
      const file = d.lastFile || lastFile;
      const tmp = `${file}.${process.pid}.tmp`;
      fs.promises.writeFile(tmp, JSON.stringify({ v: 1, path: L.path, at: L.at, count: L.count, items: L.items }))
        .then(() => fs.promises.rename(tmp, file))
        .catch((e) => { ctx.log(`the cached last folder was not saved (${(e && e.code) || 'error'}); a cold open lists it fresh`); fs.promises.unlink(tmp).catch(() => {}); });
    }, 1000);
    if (lastWriteT.unref) lastWriteT.unref();
  }
  /** The last folder changed, or a listing of it finished: the cache follows the saved last folder. */
  function cacheLast(folder) {
    const L = folder && S.lists.get(folder.toLowerCase());
    if (!L || (S.last && sameP(S.last.path, L.path) && S.last.at === L.at)) return;
    S.last = L;
    writeLastSoon();
  }
  const lastSaved = () => (S.pending.lastFolder !== undefined ? S.pending.lastFolder : get('lastFolder', null));

  const pins = () => (get('pins', null) || defaultPins()).filter((p) => typeof p === 'string');
  function defaultPins() {
    return ['Desktop', 'Downloads', 'Documents', 'Pictures'].map((n) => path.join(home, n)).filter((p) => exists(p));
  }
  // every boot answer carries these: a pin on a drive that may not answer is not stat'ed (review2 #4),
  // so it is never marked missing; opening it lists it, and the listing says why if it fails
  const pinRows = () => pins().map((p) => ({ path: p, label: labelOf(p), d: 1, missing: mayBlock(p) ? false : !exists(p) }));
  function labelOf(p) {
    const n = C.normPath(p);
    return (n && S.names[n.toLowerCase()]) || path.win32.basename(n || '') || n;
  }

  /* ---- windows ------------------------------------------------------------------------------- */
  /* A window's key is unguessable ("w3-" + 72 random bits), not a small number: every files.* call
     names its window, and a page that could guess another window's key could close it, cancel its
     jobs or read through it. The page learns its own key from its URL and nothing else does. */
  const rec = (w) => ((typeof w === 'string' || typeof w === 'number') && S.wins.get(String(w))) || null;
  const newKey = () => `w${S.nextWin++}-${require('crypto').randomBytes(9).toString('hex')}`;
  /** A tab id the page chose: a short string or a number, else null. */
  const tabId = (t) => ((typeof t === 'string' && t.length <= 64) || (typeof t === 'number' && Number.isFinite(t)) ? t : null);
  /** One real (not virtual) path, or null. */
  const onePath = (v) => { const p = C.normPath(v); return p && !C.isVirtual(p) ? p : null; };
  /** Every entry a real path (else the reason), at most `max`. */
  function pathsArg(v, max) {
    if (!Array.isArray(v) || !v.length) return { reason: 'nothing selected' };
    if (v.length > max) return { reason: TOO_MANY(max) };
    const out = [];
    for (const x of v) { const p = onePath(x); if (!p) return { reason: NOT_PATH }; out.push(p); }
    return { paths: out };
  }
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

  /** -> { path, select, note }: the saved last folder, made a FOLDER (C.startFolder), or Home. */
  function startPath() {
    if (opts().startIn === 'home') return { path: 'mantle:home', select: null, note: null };
    const saved = lastSaved();
    const s = C.startFolder(saved, kindNow);
    // not stat'ed now (a drive that may not answer): opened as saved, checked later by verifyStart
    if (!s.note && !s.select && !C.isVirtual(s.path) && mayBlock(s.path)) return Object.assign(s, { later: saved });
    if (s.note) ctx.log(`start folder: ${s.path === 'mantle:home' ? 'Home' : 'a folder above it'} (the saved last folder ${s.select ? 'was a file' : 'is gone'})`);
    else if (s.select) ctx.log('start folder: the saved last folder was a file; opened the folder it is in');
    return s;
  }

  /**
   * The saved last folder was on a drive the open path does not stat (startPath `later`): check it OFF
   * the main thread, every level at once, capped at VERIFY_MS. Then, as C.startFolder would have:
   *   - it is a folder: nothing (the window already shows it);
   *   - a file / gone: the folder above it, else Home, with startFolder's plain note;
   *   - the drive did not answer in time, or could not be reached: the window stays where it is and
   *     says so (no silent failure); the saved folder is kept for when the drive is back.
   * Before the page has booted, its start is changed in place; after, it is sent files.nav, but only
   * while the tab still shows the folder it opened at (Owen may have moved on already).
   */
  async function verifyStart(r, saved) {
    const opened = r.start;
    const chain = C.startChain(saved);
    if (!chain.length) return;
    // one level at a time, in startFolder's order, stopping at the first folder: an offline drive ties up
    // ONE libuv thread, not one per level, and a drive that answers is quick for every level
    const deadline = Date.now() + VERIFY_MS, LATE = {};
    const k = new Map();
    let late = false, unreachable = false;
    for (const p of chain) {
      const left = deadline - Date.now();
      let timer = null;
      const v = left <= 0 ? LATE : await Promise.race([
        Promise.resolve().then(() => kindLater(p)).catch(() => 'unreachable'),
        new Promise((res) => { timer = setTimeout(() => res(LATE), left); if (timer.unref) timer.unref(); }),
      ]);
      clearTimeout(timer);
      if (v === LATE) { late = true; break; }
      if (p === chain[0] && v === 'unreachable') { unreachable = true; break; }
      k.set(p.toLowerCase(), v === 'unreachable' ? null : v);
      if (v === 'dir') break;
    }
    if (S.stopped || S.wins.get(r.key) !== r || !r.win || r.win.isDestroyed()) return;
    const secs = VERIFY_MS / 1000;
    let text = null, s = null;
    if (late) text = `Your last folder's drive did not answer within ${secs} s, so Mantle Files could not check that folder; if the list stays empty, the drive is offline.`;
    else if (unreachable) text = "Your last folder's drive could not be reached, so Mantle Files could not open that folder; the drive may be offline.";
    else {
      s = C.startFolder(saved, (p) => (k.has(String(p).toLowerCase()) ? k.get(String(p).toLowerCase()) : null));
      if (sameP(s.path, opened) && !s.select) return;                 // it is there: nothing to say
    }
    const tabNow = Array.isArray(r.tabs) ? r.tabs[r.active || 0] : null;
    if (s && !r.started) {                                            // the page has not asked for its start yet
      r.start = s.path; r.select = s.select ? s.select[0] : null; r.tabs = [s.path]; r.active = 0;
      if (s.note) r.notice = [s.note, r.notice].filter(Boolean).join(' ');
    } else if (s) {
      if (!sameP(tabNow, opened)) { ctx.log('start folder: checked late, but the window had already moved on; left as it is'); return; }
      push(r.key, 'files.nav', { path: s.path });
      if (s.note) push(r.key, 'files.notice', { text: s.note });
    } else if (!r.started) r.notice = [text, r.notice].filter(Boolean).join(' ');
    else push(r.key, 'files.notice', { text });
    ctx.log(`start folder: the saved last folder (on a drive not checked on the open path) ${late ? `did not answer in ${secs} s; left as opened` : (unreachable ?'could not be reached; left as opened' : `was ${s.select ? 'a file' : 'gone'}; opened ${s.path === 'mantle:home' ? 'Home' : 'a folder above it'}`)}`);
  }

  function offscreen(width, height) {
    const screen = d.screen || E.screen;
    let minX = 0;
    try { for (const s of screen.getAllDisplays()) minX = Math.min(minX, s.bounds.x); } catch (_) { /* one display */ }
    return { x: minX - width - 400, y: 0, width, height };
  }

  /* lane helm-wall-apps (2026-10-09): in DARK the window is opaque and the page paints the desktop wallpaper
     under its tint, as Helm does (lib/features/_wall-window.js, ui/shared/wall-bdrop.js). Light: unchanged. */
  const wall = WW.feed(ctx, { event: 'files.wall', pos: 'files.wallpos', light: { material: 'acrylic', color: '#00000000' } });

  /** Where the next window goes: the saved size and place, cascaded past the windows already open. */
  function placeFor() {
    const screen = d.screen || E.screen;
    let b = get('bounds', null);
    const wa = (() => { try { return screen.getPrimaryDisplay().workArea; } catch (_) { return { x: 0, y: 0, width: 1920, height: 1040 }; } })();
    if (!b || !(b.width >= MIN_W) || !(b.height >= MIN_H)) b = { width: W0, height: H0, x: Math.round(wa.x + (wa.width - W0) / 2), y: Math.round(wa.y + (wa.height - H0) / 2) };
    const open = S.wins.size;
    if (open) b = Object.assign({}, b, { x: b.x + 28 * open, y: b.y + 28 * open });       // cascade, as Explorer does
    if (test) b = offscreen(b.width, b.height);
    return b;
  }

  function createWindow(key) {
    const t0 = Date.now();                                           // Win+E -> first paint (self-test timing)
    const BrowserWindow = d.BrowserWindow || E.BrowserWindow;
    const b = placeFor();
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
    wall.attach(w);
    const wc = w.webContents;
    w.on('page-title-updated', (e) => e.preventDefault());           // the bar and Alt+Tab know it by its exact title
    wc.on('will-navigate', (e) => e.preventDefault());
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('render-process-gone', (_e, det) => {
      if (S.spare && S.spare.key === key) { dropSpare(`its page crashed (${det && det.reason})`); return; }
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
    w.on('closed', () => {
      clearTimeout(bt);
      if (S.spare && S.spare.key === key) { S.spare = null; spareSoon('the spare window closed'); }
      forget(key);
    });
    w.once('ready-to-show', () => lightFrame(w));
    w.loadFile(ctx.page('index.html'), { query: { w: String(key) } });
    return { w, hasIcon };
  }

  /* Windows' app mode tints DWM's acrylic, whatever Mantle's page is: ask for a frame in MANTLE'S
     appearance on this window (sidecar/TaskMgr.cs taskmgr.frame, the call Settings and the task manager
     make; it refuses any window that is not this Electron's). Only the shade of the blur rides on it:
     the page's own tint (ui/files/files.css) keeps the window its theme either way, so a refusal is one
     log line, not a broken window. */
  /* lane dm-core (2026-10-08): the frame is MANTLE'S appearance (ctx.host.theme), light or dark, and
     follows it live: every open window is asked again when it changes. */
  const themeNow = () => (ctx.host && ctx.host.theme ? ctx.host.theme.get() : 'light');
  if (ctx.host && ctx.host.theme && typeof ctx.host.theme.onChange === 'function') {
    ctx.host.theme.onChange(() => { for (const rec of S.wins.values()) lightFrame(rec.win); });
  }
  function lightFrame(w) {
    if (!w || w.isDestroyed() || typeof w.getNativeWindowHandle !== 'function') return;
    const want = themeNow() === 'dark' ? 'dark' : 'light';
    let hwnd;
    try {
      const buf = w.getNativeWindowHandle();
      hwnd = buf.length >= 8 ? Number(buf.readBigUInt64LE(0)) : buf.readUInt32LE(0);
    } catch (e) { ctx.log(`the ${want} window frame was not asked for: the window handle could not be read (${e.message})`); return; }
    Promise.resolve(ctx.sidecar.send('taskmgr.frame', { hwnd, light: want === 'light' }, { timeoutMs: 6000 })).then((r) => {
      if (r && !r.ok) ctx.log(`the ${want} window frame was not set (${r.error}); the page keeps its own ${want} tint`);
    }, (e) => ctx.log(`the ${want} window frame was not set (${e && e.message}); the page keeps its own ${want} tint`));
  }

  /* R7 (plan mantle-replace-windows.md): ONE truthful line per open, ms from the open request only (never
     a path), written only once the page said its first rows are on screen (two frames after they were
     drawn: a hidden window draws no frames) AND Windows was asked whether it really shows the window.
     cold = a new window was built for this open; warm = the keepReady spare took it. */
  function openTimeline(tl, why, force) {
    if (!tl || tl.logged) return;
    if (why) tl.why = why;
    if (!force && (tl.painted === null || tl.interactive === null || tl.done === null)) return;     // the other half logs it
    tl.logged = true;
    why = tl.why || null;
    const f = (v) => (v === null ? '-' : `${v} ms`);
    const live = `live listing asked ${f(tl.list)}${tl.rootsWait ? ` (waited ${tl.rootsWait} ms for the drives)` : ''}, first items ${f(tl.first)}, all ${f(tl.done)}${tl.count ? ` (${tl.count} items)` : ''}`;
    ctx.log(`opened (${tl.warm ? 'warm' : 'cold'}) via ${tl.via}: shown ${f(tl.shown)}, painted ${f(tl.painted)}${tl.cached ? ' from the cache' : ''}, interactive ${f(tl.interactive)}; ${live}; ${tl.screen || 'not seen on screen'}${why ? `; ${why}` : ''}`);
  }

  /** Is the window really there? Windows is asked (lib/raise.js judge: visible, not cloaked, nothing in
      front of its centre). A --test copy never shows a window in front of Owen, so it says so instead. */
  function screenWords(win) {
    if (test) return showInTest ? 'off screen: test mode' : 'hidden: test mode';
    let j;
    try { j = (d.judge || require('../raise.js').judge)(win); } catch (e) { j = { onTop: null, why: `the check failed (${e && e.message})` }; }
    if (j.onTop === true) return 'on screen';
    if (j.onTop === false) return `NOT on screen: ${j.why}`;
    return `shown (not checked: ${j.why})`;
  }

  /** What a page gets at boot (and a spare at the open that takes it): its start folder and, when the
      cache holds that folder, its first rows to draw at once. */
  function bootReply(r) {
    const top = S.undo.peek(), re = S.redo.peek();
    const out = { ok: true, w: r.key, path: r.start, select: r.select || null, options: opts(), test, sandbox: sandbox ? sandbox.root || null : null,
      home, pins: pinRows(), undo: top ? { label: top.label } : null, redo: re ? { label: re.label } : null, sep: '\\', notice: r.notice || S.sidecarWhy || null, names: S.names };
    if (!r.cacheSent && S.last && sameP(S.last.path, r.start)) {
      r.cacheSent = true;
      out.cache = { path: S.last.path, items: S.last.items, count: S.last.count, at: S.last.at, view: C.getView(get('views', {}), r.start) };
    }
    return out;
  }

  /* ---- keepReady (opt-in, default OFF): ONE hidden spare window ------------------------------------
     Owen 2026-10-15: "no i dont want these open in the backround i need to save ram ... there can be an
     option to have them open backround though". Off: no window exists unless one is open. On: one hidden
     window with its page loaded and waiting (no listing, no timers: a hidden page draws no frames); Win+E
     takes it and shows it at once, and a fresh spare is made SPARE_IDLE_MS after the last close. A game
     rest destroys it (its RAM back), the end of the rest makes it again. */
  /* WHERE THE SWITCH LIVES: ONLY lib/keep-ready.js 'files' (lane settingsfast: <userData>/keep-ready.json
     "keepReady.files", the "Keep Files ready" row in Mantle Settings > Keep ready in the background).
     Files has no option row of its own (lane integrate2: one switch, not two). If keep-ready.js cannot
     be loaded the spare stays off. deps.keepReady: a test's stand-in ({ get(surface), onChange(fn) }). */
  const KR = d.keepReady !== undefined ? d.keepReady : (() => { try { return require('../keep-ready.js'); } catch (_) { return null; } })();
  const keepReady = () => { if (KR) { try { return !!KR.get('files'); } catch (_) { return false; } } return false; };
  function spareSoon(why) {
    clearTimeout(S.spareTimer);
    S.spareTimer = null;
    if (!keepReady() || S.stopped || S.resting || S.spare || !ctx.enabled()) return;
    S.spareTimer = setTimeout(() => { S.spareTimer = null; makeSpare(why); }, d.spareIdleMs !== undefined ? d.spareIdleMs : SPARE_IDLE_MS);
    if (S.spareTimer.unref) S.spareTimer.unref();
  }
  function makeSpare(why) {
    if (!keepReady() || S.stopped || S.resting || S.spare || !ctx.enabled()) return;
    if (S.wins.size) { spareSoon(why); return; }        // one hidden window while none is open, never one more beside an open one
    const key = newKey();
    const made = createWindow(key);
    S.spare = { key, win: made.w, hasIcon: made.hasIcon, booted: false, painted: false };
    made.w.once('ready-to-show', () => { if (S.spare && S.spare.key === key) S.spare.painted = true; });
    ctx.log(`keep ready: a hidden Mantle Files window is waiting (${why || 'keep ready is on'})`);
  }
  function dropSpare(why) {
    clearTimeout(S.spareTimer);
    S.spareTimer = null;
    const sp = S.spare;
    if (!sp) return;
    S.spare = null;
    if (sp.win && !sp.win.isDestroyed()) sp.win.destroy();
    ctx.log(`keep ready: the hidden Mantle Files window was closed (${why})`);
  }
  /** The spare, if one is alive: it leaves S.spare and becomes an open window. */
  function takeSpare() {
    const sp = S.spare;
    if (!sp) return null;
    S.spare = null;
    clearTimeout(S.spareTimer);
    if (!sp.win || sp.win.isDestroyed()) return null;
    return sp;
  }

  function openWindow(a) {
    const t0 = Date.now();
    const o = a || {};
    if (S.stopped) return { ok: false, reason: 'Mantle Files is stopped' };
    if (!ctx.enabled()) return { ok: false, reason: 'Mantle Files is switched off in the tray menu; File Explorer still works (Win+E)' };
    if (S.wins.size >= MAX_WINS) return { ok: false, reason: `${MAX_WINS} Mantle Files windows are already open; close some, or use a new tab (Ctrl+T)` };
    let start = o.path ? C.normPath(o.path) : null;
    if (o.path && !start) return { ok: false, reason: 'that is not a folder path Mantle Files can open' };
    let select = o.select || null;
    let note = null;
    if (start && !C.isVirtual(start)) {
      if (kindNow(start) === 'file') { select = path.win32.basename(start); start = C.parentOf(start); }     // "show in folder" of a file
    }
    let later = null;
    if (!start) { const s = startPath(); start = s.path; select = s.select; note = s.note; later = s.later || null; }
    if (Array.isArray(select)) select = select[0] || null;            // the page selects ONE name (files.js S.select)
    const sp = takeSpare();
    const key = sp ? sp.key : newKey();
    const made = sp ? { w: sp.win, hasIcon: sp.hasIcon } : createWindow(key);
    const w = made.w;
    // tl: this open's timeline (lane barfiles 2026-09-29; R7 lane mantle-files), logged once as ms only (openTimeline)
    const tl = { t0, n: ++S.opens, via: o.via || 'an open request', warm: !!(sp && sp.booted), shown: null, painted: null, interactive: null, cached: false, screen: null,
      boot: null, list: null, rootsWait: 0, job: null, first: null, done: null, count: 0, logged: false };
    const r = { key, win: w, start, select, tabs: [start], active: 0, tl,
      notice: [note, made.hasIcon ? null : 'The Mantle Files icon (assets/icons/mantle-files.ico) is missing, so the bar shows the default one.'].filter(Boolean).join(' ') || null };
    S.wins.set(key, r);
    if (later) verifyStart(r, later).catch((e) => ctx.log(`start folder: the late check failed (${(e && e.code) || 'error'}); left as opened`));
    const show = () => {
      if (w.isDestroyed() || tl.shown !== null) return;
      if (!test) { w.show(); w.focus(); } else if (showInTest) w.showInactive(); else return;
      tl.shown = Date.now() - t0;
    };
    // dark: the page bakes the wallpaper first, held at most COLD_HOLD_MS (plan R3: decoration never gates a show)
    const showSoon = () => { if (!test) wall.hold(w, show, COLD_HOLD_MS); else show(); };
    if (sp) {
      try { w.setBounds(placeFor()); } catch (_) { /* it opens where it was made */ }
      if (sp.booted) { ctx.push(w, 'files.start', bootReply(r)); r.started = true; }       // a page still loading asks files.boot itself
      if (sp.painted) showSoon(); else w.once('ready-to-show', showSoon);
    } else {
      w.once('ready-to-show', showSoon);
    }
    setTimeout(() => openTimeline(tl, tl.painted === null ? 'the window did not paint its first view within 20 s' : (tl.done === null ? 'the live listing did not finish within 20 s' : null), true), 20000).unref();
    if (!sp) ctx.log(`window opened (${S.wins.size} open)${test ? (showInTest ? ' off screen, inactive: test mode' : ' hidden: test mode') : ''}`);
    else ctx.log(`window opened from the keep-ready spare (${S.wins.size} open)${test ? ' test mode' : ''}`);
    return { ok: true, w: key, shown: !test, warm: tl.warm };
  }

  function forget(key) {
    const r = S.wins.get(key);
    if (!r) return;
    S.wins.delete(key);
    for (const [k, wt] of S.watchers) if (k.startsWith(key + '|')) { try { wt.watcher.close(); } catch (_) { /* gone */ } clearTimeout(wt.timer); S.watchers.delete(k); }
    for (const [job, j] of S.jobs) {
      if (j.w !== key) continue;
      if (j.js && j.kind === 'search') { j.cancel = true; S.jobs.delete(job); }
      else if (j.kind === 'list' || j.kind === 'search' || j.kind === 'size') { ctx.sidecar.send('files.cancel', { job }); S.jobs.delete(job); }
      // ops keep running: their result still lands in the undo stack and the other windows refresh
    }
    // a checksum still reading for this window: its file handle is freed now, not when it ends
    const hs = S.hashes.get(key);
    if (hs) { S.hashes.delete(key); try { hs.destroy(); } catch (_) { /* gone */ } }
    if (!S.wins.size) spareSoon('the last Mantle Files window closed');
  }
  function closeWindow(key, why) {
    const r = rec(key);
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
        push(w, 'files.notice', { tab, text: 'This folder stopped refreshing by itself; press F5 to refresh it.' });
      });
      S.watchers.set(k, rec0);
      const mine = [...S.watchers.keys()].filter((x) => x.startsWith(w + '|'));
      if (mine.length > 16) { const drop = S.watchers.get(mine[0]); try { drop.watcher.close(); } catch (_) { /* gone */ } S.watchers.delete(mine[0]); }
      return { watch: true };
    } catch (e) {
      return { watch: false, watchWhy: 'this folder does not refresh by itself; press F5 to see changes' };
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
    if (j.tl && j.tl.first === null) j.tl.first = Date.now() - j.tl.t0;
    j.count += Array.isArray(m.items) ? m.items.length : 0;
    if (j.keep && Array.isArray(m.items) && j.keep.length < LAST_KEEP) for (const it of m.items) { if (j.keep.length >= LAST_KEEP) break; j.keep.push(it); }
    if (m.done && j.keep && !m.error) rememberList(j);
    push(j.w, 'files.items', { tab: j.tab, job: j.job, items: m.items || [], done: !!m.done, count: m.count, ms: m.ms, error: m.error || null });
    if (m.done) {
      S.jobs.delete(j.job);
      if (j.tl) { j.tl.done = Date.now() - j.tl.t0; j.tl.count = j.count; openTimeline(j.tl, m.error ? 'the listing failed' : null); }
      const total = Date.now() - j.at;
      if (j.count >= 1000 || total >= 1000 || m.error) ctx.log(`list: ${j.count} items, first batch ${j.first} ms, all in ${total} ms (sidecar ${m.ms} ms)${m.error ? '; failed: ' + m.error : ''}`);
    }
  });
  /** A finished listing: remembered (LAST_LISTS), and cached on disk when it is the saved last folder. */
  function rememberList(j) {
    const k = j.path.toLowerCase();
    S.lists.delete(k);
    S.lists.set(k, { path: j.path, items: j.keep, count: j.count, at: Date.now() });
    while (S.lists.size > LAST_LISTS) S.lists.delete(S.lists.keys().next().value);
    j.keep = null;
    if (sameP(lastSaved(), j.path)) cacheLast(j.path);
  }
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
    if (j.undo || j.redo) {
      // An undo finished: what it did becomes redoable (a redo: undoable again). When NOTHING was
      // done (every item failed), the step stays where it was, so Ctrl+Z / Ctrl+Y can be tried again.
      const from = j.undo ? S.undo : S.redo, to = j.undo ? S.redo : S.undo;
      const inv = okN > 0 && j.from ? C.inverseOf({ op: j.op, results }) : null;
      if (inv) { relabel(inv, j.undo ? 'Redo' : 'Undo', j.from.what); to.putBack(inv); if (j.redo) undo = inv; }
      else if (okN === 0 && j.from) from.putBack(j.from);
    } else {
      undo = S.undo.push({ op: j.op, results });
      if (undo) relabel(undo, 'Undo', C.WHAT[j.op]);
      if (okN > 0) S.redo.clear();                      // a NEW change: what was undone can no longer be redone
    }
    push(j.w, 'files.opdone', { job: j.job, op: j.op, ok: m.ok !== false && failN === 0 && !m.aborted, hr: m.hr || 0, reason: m.reason || null,
      aborted: !!m.aborted, results, undoable: !!undo, undoLabel: undo ? undo.label : null, wasUndo: !!j.undo, wasRedo: !!j.redo });
    history();
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
    ctx.log(`${j.undo ? 'undo ' : j.redo ? 'redo ' : ''}${j.op}: ${okN} ok, ${failN} failed${m.aborted ? ', cancelled' : ''} in ${Date.now() - j.at} ms${hr}${undo ? '; undoable' : ''}`);
  }
  /** An undo / redo step's name-free label from the op the user did ("Undo copy (2 items)", "Redo rename"). */
  function relabel(inv, verb, what) {
    inv.what = what || 'change';
    inv.label = C.historyLabel(verb, inv.what, (inv.items || inv.keys || []).length);
    return inv;
  }
  /** Every window's Undo / Redo labels (files.undo: { label, redo }; `redo` is additive, lane files-main). */
  function history() {
    const u = S.undo.peek(), r = S.redo.peek();
    toAll('files.undo', { label: u ? u.label : null, redo: r ? r.label : null });
  }

  /* A sidecar restart loses every job it was running: say so in the windows instead of spinning. */
  let firstReady = true;
  ctx.sidecar.onReady(() => {
    if (!firstReady) {
      for (const j of [...S.jobs.values()]) {
        if (j.js) continue;
        if (j.kind === 'op') opDone(j, { ok: false, aborted: true, reason: "Mantle's Windows helper restarted in the middle of it; check the folder to see what finished", results: [] });
        else {
          S.jobs.delete(j.job);
          const ev = j.kind === 'search' ? 'files.found' : j.kind === 'size' ? 'files.size' : 'files.items';
          push(j.w, ev, { tab: j.tab, job: j.job, items: [], done: true, error: "Mantle's Windows helper restarted; press F5 to try again" });
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
      S.sidecarWhy = "Mantle's Windows helper is an older version without Mantle Files; update Mantle, then restart it";
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
      else if (it && typeof it === 'object') {
        out.push(it.src);
        if (it.dest) out.push(path.win32.join(it.dest, it.name || path.win32.basename(String(it.src || ''))));
        else if (spec.op === 'rename' && it.name) out.push(path.win32.join(path.win32.dirname(String(it.src || '')), it.name));   // rename many
      }
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
  /**
   * A page's op request, checked and rebuilt from known fields only: every path normalised and real,
   * every name one Windows accepts, the clash choice one of four, at most MAX_ITEMS items. Object
   * items are {src, name} for rename-many from a page, and {src, dest, name} only from undo / redo
   * (`internal`). -> { spec } | { reason }
   */
  function cleanSpec(s, internal) {
    const op = s.op;
    if (!OPS.includes(op)) return { reason: 'unknown file operation' };
    const out = { op, w: s.w, confirmed: s.confirmed === true, conflict: 'ask', undo: !!(internal && s.undo), redo: !!(internal && s.redo), from: internal ? s.from : null };
    if (s.conflict !== undefined && s.conflict !== null) {
      if (!CONFLICTS.includes(s.conflict)) return { reason: 'that is not a choice for a name clash (replace, keep both, skip or ask)' };
      out.conflict = s.conflict;
    }
    if (s.name !== undefined && s.name !== null) {
      const bad = typeof s.name === 'string' ? C.badName(s.name) : 'a name must be text';
      if (bad) return { reason: bad };
      out.name = s.name;
    }
    if (s.dest !== undefined && s.dest !== null && s.dest !== '') {
      out.dest = onePath(s.dest);
      if (!out.dest) return { reason: 'the destination is not a folder Mantle Files can use' };
    }
    if (op === 'restore' || op === 'purge') {
      if (!Array.isArray(s.keys) || !s.keys.length) return { reason: 'no Recycle Bin items given' };
      if (s.keys.length > MAX_ITEMS) return { reason: TOO_MANY(MAX_ITEMS) };
      if (!s.keys.every((k) => typeof k === 'string' && k.length > 0 && k.length <= 1024)) return { reason: 'those Recycle Bin items are not valid; press F5 and try again' };
      out.keys = s.keys.slice();
      return { spec: out };
    }
    if (op === 'newfolder' || op === 'newfile') {
      if (!out.dest) return { reason: 'a new item needs a folder to go in' };
      if (!out.name) return { reason: 'a name cannot be empty' };
      return { spec: out };
    }
    if (!Array.isArray(s.items) || !s.items.length) return { reason: 'nothing selected' };
    if (s.items.length > MAX_ITEMS) return { reason: TOO_MANY(MAX_ITEMS) };
    const many = op === 'rename' && s.items.every((x) => x && typeof x === 'object');
    out.items = [];
    for (const it of s.items) {
      if (typeof it === 'string') { const p = onePath(it); if (!p) return { reason: NOT_PATH }; out.items.push(p); continue; }
      if (!it || typeof it !== 'object' || Array.isArray(it) || !(many || internal)) return { reason: NOT_PATH };
      const o = { src: onePath(it.src) };
      if (!o.src) return { reason: NOT_PATH };
      if (it.name !== undefined) {
        const bad = typeof it.name === 'string' ? C.badName(it.name) : 'a name must be text';
        if (bad) return { reason: bad };
        o.name = it.name;
      }
      if (it.dest !== undefined) {
        if (!internal) return { reason: NOT_PATH };
        o.dest = onePath(it.dest);
        if (!o.dest) return { reason: 'the destination is not a folder Mantle Files can use' };
      }
      if (many && !o.name) return { reason: 'a name cannot be empty' };
      out.items.push(o);
    }
    if (op === 'rename' && !many) {
      if (!out.name) return { reason: 'a name cannot be empty' };
      if (out.items.length !== 1) return { reason: 'rename one item at a time, or give each item its own new name' };
    }
    if ((op === 'copy' || op === 'move') && !out.dest && !out.items.every((x) => typeof x === 'object' && x.dest)) return { reason: 'a copy or move needs a folder to go to' };
    return { spec: out };
  }

  async function startOp(w, raw, internal) {
    const c = cleanSpec(raw || {}, !!internal);
    if (!c.spec) return { ok: false, reason: c.reason };
    const spec = c.spec;
    const op = spec.op;
    if ((op === 'delete' || op === 'purge') && !spec.confirmed) return { ok: false, reason: 'a permanent delete needs the confirm first' };
    if (op === 'rename' && typeof spec.items[0] === 'object') {
      // rename many: [{src, name}] in one job (one undo); no two the same
      const seen = new Set();
      for (const it of spec.items) {
        const k = path.win32.join(path.win32.dirname(it.src), it.name).toLowerCase();
        if (seen.has(k)) return { ok: false, reason: 'two items would get the same name' };
        seen.add(k);
      }
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
    const j = { job, kind: 'op', w: String(spec.w), op, undo: spec.undo, redo: spec.redo, from: spec.from, at: Date.now(), count: 0,
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
    const j = { job, kind: 'op', js: true, w: String(w), op, at: Date.now(), count: 0, cancel: false, dirs };
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
        const why = cancelled ? 'cancelled' : C.codeWords(e && e.code);
        opDone(j, { ok: false, aborted: cancelled, reason: cancelled ? 'cancelled' : `the ${LABEL[op]} did not finish: ${why}`, results: (j.src || []).map((s) => ({ src: s, ok: false, why })) });
      });
    return j;
  }

  async function zipCmd(a) {
    const pa = pathsArg(a.items, MAX_ITEMS);
    if (!pa.paths) return { ok: false, reason: pa.reason === 'nothing selected' ? 'nothing selected to compress' : pa.reason };
    const items = pa.paths;
    let dest = a.dest ? onePath(a.dest) : null;
    if (a.dest && !dest) return { ok: false, reason: 'that is not a place a ZIP file can be saved' };
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
    const zipPath = onePath(a.path);
    if (!zipPath) return { ok: false, reason: 'no zip file given' };
    let dest = a.dest ? onePath(a.dest) : null;
    if (a.dest && !dest) return { ok: false, reason: 'that is not a folder Mantle Files can extract into' };
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
    const d0 = onePath(dest);
    if (!d0) return { ok: false, reason: 'files can only go into a real folder' };
    if (!Array.isArray(paths)) return { ok: false, reason: 'nothing to paste' };
    if (paths.length > MAX_ITEMS) return { ok: false, reason: TOO_MANY(MAX_ITEMS) };
    // what another app put on the clipboard or dropped may hold a path Mantle cannot use: those are left out
    const items = paths.map(onePath).filter(Boolean);
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
              // the cache stays bounded while Mantle runs for days, not only at the prune after start
              if (++S.thumbWrites >= TH.every) { S.thumbWrites = 0; pruneThumbs(); }
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
      const key = C.thumbKey(p, Number(it.m) || 0, Number(it.s) || 0, px, mode);
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
    if (!S.thumbDisk || S.pruning) return;
    S.pruning = true;
    try {
      const names = await fs.promises.readdir(thumbDir);
      if (names.length < TH.at) return;
      const st = [];
      for (const n of names) { try { st.push({ n, t: (await fs.promises.stat(path.join(thumbDir, n))).mtimeMs }); } catch (_) { /* gone */ } }
      st.sort((x, y) => y.t - x.t);
      let gone = 0;
      for (const x of st.slice(TH.keep)) { try { await fs.promises.unlink(path.join(thumbDir, x.n)); gone++; } catch (_) { /* in use */ } }
      ctx.log(`thumbnail cache: ${gone} old thumbnails removed, ${Math.min(st.length, TH.keep)} kept`);
    } catch (e) { ctx.log(`thumbnail cache prune failed (${e.code || 'error'})`); } finally { S.pruning = false; }
  }
  const pruneTimer = setTimeout(pruneThumbs, 60 * 1000);
  if (pruneTimer.unref) pruneTimer.unref();

  /* ---- previews ------------------------------------------------------------------------------- */
  async function preview(a) {
    const p = C.normPath(a.path);
    if (!p || C.isVirtual(p)) return { kind: 'none', why: 'nothing to preview' };
    let st;
    try { st = await fs.promises.stat(p); } catch (e) { return { kind: 'none', why: `it cannot be read: ${C.codeWords(e.code)}` }; }
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
      return { kind: 'none', why: `it cannot be read: ${C.codeWords(e.code)}` };
    } finally { if (fh) await fh.close().catch(() => {}); }
  }

  /* ---- commands ------------------------------------------------------------------------------- */
  /**
   * Every files.* command: it must name an OPEN Mantle Files window (`w`, unguessable), except
   * files.open without one (the launcher / bar / jump list asking for a window). A throw never
   * reaches the page as a stack or a code: it gets one plain sentence, and the log the error's class.
   */
  function cmd(verb, fn, anyone) {
    ctx.command(verb, async (a) => {
      const r = rec(a.w);
      if (!r && !anyone) return { ok: false, reason: GONE };
      try { return await fn(a, r); } catch (e) {
        ctx.log(`${verb}: failed (${(e && (e.code || e.name)) || 'error'})`);
        return { ok: false, reason: `Mantle Files could not do that: ${C.codeWords(e && e.code)}` };
      }
    });
  }

  cmd('boot', async (a, r) => {
    if (!r) {
      // keepReady's hidden spare: its page waits for 'files.start' (bootReply) from the open that takes it
      if (S.spare && a && a.w === S.spare.key) { S.spare.booted = true; return { ok: true, spare: true, w: S.spare.key }; }
      return { ok: false, reason: GONE };
    }
    if (r.tl && r.tl.boot === null) r.tl.boot = Date.now() - r.tl.t0;
    r.started = true;
    return bootReply(r);
  }, true);
  // R7: the page's first rows are on screen ('painted') and the keyboard is in the list ('interactive')
  cmd('painted', async (a, r) => {
    const tl = r.tl;
    if (!tl || tl.logged) return { ok: true };
    const ms = Date.now() - tl.t0;
    if (a.stage === 'painted' && tl.painted === null) { tl.painted = ms; tl.cached = !!a.cached; tl.screen = screenWords(r.win); }
    if (a.stage === 'interactive' && tl.interactive === null) {
      tl.interactive = ms;
      if (tl.painted === null) { tl.painted = ms; tl.cached = !!a.cached; tl.screen = screenWords(r.win); }
    }
    openTimeline(tl);
    return { ok: true };
  });
  cmd('open', async (a) => {
    if (a.w !== undefined) {                                       // files.open from a page: the default app
      if (!rec(a.w)) return { ok: false, reason: GONE };
      const p = onePath(a.path);
      if (!p) return { ok: false, reason: 'nothing to open' };
      if (test) return { ok: true, dryRun: true, reason: 'test mode: would open it in its app' };
      const shell = d.shell || E.shell;
      const err = await shell.openPath(p);
      if (err) return { ok: false, reason: `Windows could not open it (${String(err).split(p).join('it').split(path.win32.basename(p)).join('it')})` };
      const recent = (get('recent', []) || []).filter((x) => x && String(x.path).toLowerCase() !== p.toLowerCase());
      recent.unshift({ path: p, n: path.win32.basename(p), d: 0, m: Date.now() });
      saveLater('recent', recent.slice(0, 50));
      return { ok: true };
    }
    return openWindow({ path: typeof a.path === 'string' ? a.path : undefined, via: 'files.open' });   // files.open {path?} from elsewhere: a window
  }, true);
  cmd('newwindow', async (a) => openWindow({ path: typeof a.path === 'string' ? a.path : undefined, via: 'New window' }));
  // Open in Terminal: Windows Terminal when it is installed, else PowerShell, started IN that folder
  // (the folder is the child's working directory, never on its command line: C.terminalSpawn).
  cmd('terminal', async (a) => {
    const p = onePath(a.path);
    if (!p) return { ok: false, reason: 'a terminal opens in a real folder' };
    let st = null;
    try { st = fs.statSync(p); } catch (e) { return { ok: false, reason: `that folder cannot be opened: ${C.codeWords(e.code)}` }; }
    if (!st.isDirectory()) return { ok: false, reason: 'that is not a folder' };
    const wt = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'wt.exe');
    const useWt = !!process.env.LOCALAPPDATA && fs.existsSync(wt);
    const app = useWt ? 'Windows Terminal' : 'PowerShell';
    const how = C.terminalSpawn(useWt ? wt : null, p);
    if (test) return { ok: true, dryRun: true, app, reason: `test mode: would open ${app} in this folder` };
    try {
      const spawn = d.spawn || require('child_process').spawn;
      const child = spawn(how.file, how.args, how.opts);
      child.on('error', (e) => ctx.log(`terminal did not start (${e.code || 'error'})`));
      child.unref();
      return { ok: true, app };
    } catch (e) {
      return { ok: false, reason: `${app} did not start: ${C.codeWords(e.code)}` };
    }
  });
  // Properties > checksum: SHA-256 (or SHA-1 / SHA-512 / MD5) of one file, read in a stream. One at a
  // time per window: asking again (another file, another algorithm) drops the one still running.
  const HASHES = ['sha256', 'sha1', 'sha512', 'md5'];
  cmd('hash', async (a, r) => {
    const p = onePath(a.path);
    const algo = typeof a.algo === 'string' ? a.algo.toLowerCase() : a.algo == null ? 'sha256' : '';
    if (!HASHES.includes(algo)) return { ok: false, reason: 'the checksum must be SHA-256, SHA-1, SHA-512 or MD5' };
    if (!p) return { ok: false, reason: 'no file given' };
    const key = r.key;
    const prev = S.hashes.get(key);
    if (prev) prev.destroy();
    return new Promise((resolve) => {
      let st;
      try { st = fs.statSync(p); } catch (e) { resolve({ ok: false, reason: `the file cannot be read: ${C.codeWords(e.code)}` }); return; }
      if (st.isDirectory()) { resolve({ ok: false, reason: 'a folder has no checksum: pick a file' }); return; }
      const t0 = Date.now();
      const h = require('crypto').createHash(algo);
      const rs = fs.createReadStream(p, { highWaterMark: 1 << 20 });
      S.hashes.set(key, rs);
      let bytes = 0;
      let settled = false;
      const end = (res) => { if (settled) return; settled = true; if (S.hashes.get(key) === rs) S.hashes.delete(key); resolve(res); };
      rs.on('data', (b) => { bytes += b.length; h.update(b); });
      rs.on('error', (e) => end({ ok: false, reason: `the file could not be read: ${C.codeWords(e.code)}` }));
      rs.on('end', () => end({ ok: true, algo, hex: h.digest('hex'), bytes, ms: Date.now() - t0 }));
      // stopped before its end (another checksum asked for, the window closed, Mantle stopping): the
      // promise still answers, whatever byte it was on
      rs.on('close', () => setImmediate(() => end({ ok: false, cancelled: true, reason: 'the checksum was stopped' })));
    });
  });
  cmd('win', async (a) => {
    const win = winOf(a.w);
    if (!win) return { ok: false, reason: GONE };
    if (!['close', 'min', 'max'].includes(a.op)) return { ok: false, reason: 'unknown window button' };
    if (a.op === 'close') { closeWindow(a.w, 'closed by its button'); return { ok: true }; }
    if (test) return { ok: true, dryRun: true, reason: `test mode: would ${a.op} the window` };
    if (a.op === 'min') win.minimize();
    else if (win.isMaximized()) win.unmaximize(); else win.maximize();
    return { ok: true, maximized: win.isMaximized() };
  });
  cmd('roots', async (a) => {
    const r = await roots(!!(a && a.fresh));
    if (!r.ok) return { ok: false, reason: `drives and folders could not be read: ${r.error}`, pins: pinRows() };
    return Object.assign({ ok: true }, r.result, { pins: pinRows() });
  });
  cmd('home', async (a, hr) => {
    const r = await ctx.sidecar.send('files.recent', { max: 40 }, { timeoutMs: 6000 });
    if (hr && hr.tl && hr.tl.home && hr.tl.done === null) { hr.tl.done = Date.now() - hr.tl.t0; hr.tl.first = hr.tl.done; openTimeline(hr.tl, 'Home'); }
    const win = r.ok && r.result && Array.isArray(r.result.items) ? r.result.items : [];
    return { ok: true, pins: pinRows(), recent: C.mergeRecent([get('recent', []), win], 40), recentWhy: r.ok ? null : `Windows' recent files could not be read: ${r.error}` };
  });
  cmd('list', async (a0, wr) => {
    const a = Object.assign({}, a0, { w: wr.key, tab: tabId(a0.tab) });
    const p = C.normPath(a.path);
    if (!p) return { ok: false, reason: 'that is not a folder path (try C:\\ or \\\\server\\share)' };
    const tl = wr && wr.tl && wr.tl.list === null ? wr.tl : null;          // this window's first listing
    if (tl) tl.list = Date.now() - tl.t0;
    // the drives' friendly names (crumbs) are worth at most 150 ms: a listing never queues behind them (R3)
    if (!S.roots) { const tr = Date.now(); await Promise.race([roots(false).catch(() => null), new Promise((res) => setTimeout(res, 150))]); if (tl) tl.rootsWait = Date.now() - tr; }
    const base = { ok: true, path: p, parent: C.parentOf(p), crumbs: C.crumbs(p, S.names), view: C.getView(get('views', {}), p) };
    if (p === 'mantle:thispc' || p === 'mantle:network') {
      const r = await roots(true);
      if (!r.ok) return { ok: false, reason: `drives could not be read: ${r.error}` };
      watch(a.w, a.tab, null);
      if (tl) { tl.done = Date.now() - tl.t0; openTimeline(tl, 'This PC'); }
      return Object.assign(base, { drives: r.result.drives || [], known: r.result.known || [], network: r.result.network || [] });
    }
    if (p === 'mantle:recycle') {
      const r = await ctx.sidecar.send('files.recycle.list', {}, { timeoutMs: 15000 });
      if (!r.ok) return { ok: false, reason: `the Recycle Bin could not be read: ${r.error}` };
      watch(a.w, a.tab, null);
      if (tl) { tl.done = Date.now() - tl.t0; openTimeline(tl, 'the Recycle Bin'); }
      return Object.assign(base, { recycle: r.result.items || [], count: r.result.count, bytes: r.result.bytes });
    }
    if (p === 'mantle:home') { watch(a.w, a.tab, null); if (tl) tl.home = true; return base; }
    const job = newJob('list');
    if (tl) tl.job = job;
    S.jobs.set(job, { job, kind: 'list', w: wr.key, tab: a.tab, at: Date.now(), count: 0, tl, path: p, keep: [] });
    const r = await ctx.sidecar.send('files.list', { path: p, job }, { timeoutMs: 6000 });
    if (!r.ok) { S.jobs.delete(job); return { ok: false, reason: `the folder could not be read: ${r.error}` }; }
    return Object.assign(base, { job }, watch(a.w, a.tab, p));
  });
  // A window cancels only its OWN work; a job that is not running any more has nothing to cancel.
  cmd('cancel', async (a, wr) => {
    const j = typeof a.job === 'string' ? S.jobs.get(a.job) : null;
    if (!j) return { ok: true, cancelled: false, reason: 'it had already finished' };
    if (j.w !== wr.key) return { ok: false, reason: 'that is running in another Mantle Files window; cancel it there' };
    if (j.js) { j.cancel = true; return { ok: true, cancelled: true }; }
    const r = await ctx.sidecar.send('files.cancel', { job: j.job }, { timeoutMs: 3000 });
    return r.ok ? Object.assign({ ok: true }, r.result) : { ok: false, reason: `it could not be cancelled: ${r.error}` };
  });
  cmd('search', async (a, wr) => {
    const p = onePath(a.path);
    const q = typeof a.query === 'string' ? a.query.trim() : '';
    if (!p) return { ok: false, reason: 'search works inside a real folder' };
    if (!q) return { ok: false, reason: 'type something to search for' };
    if (q.length > QUERY_MAX || /[\x00-\x1f]/.test(q)) return { ok: false, reason: `search for something shorter (${QUERY_MAX} characters at most)` };
    const job = newJob('search');
    const tab = tabId(a.tab);
    if (a.contents) {
      // names AND the text inside files: main reads them itself (_files-grep.js), no Windows index
      const j = { job, kind: 'search', js: true, cancel: false, w: wr.key, tab, at: Date.now(), count: 0 };
      S.jobs.set(job, j);
      const found = (items, extra) => push(j.w, 'files.found', Object.assign({ tab: j.tab, job, items, done: false }, extra || {}));
      G.search(p, q, { max: SEARCH_MAX, onBatch: (items) => { j.count += items.length; found(items); }, isCancelled: () => j.cancel || !S.jobs.has(job) }).then(
        (st) => { S.jobs.delete(job); if (!st.cancelled) found([], { done: true, count: st.count, ms: st.ms, capped: st.capped, denied: st.denied, skipped: st.skipped, read: st.read, contents: true }); },
        (e) => { S.jobs.delete(job); found([], { done: true, count: j.count, ms: Date.now() - j.at, error: `the search stopped: ${C.codeWords(e && e.code)}`, contents: true }); });
      return { ok: true, job, contents: true };
    }
    S.jobs.set(job, { job, kind: 'search', w: wr.key, tab, at: Date.now(), count: 0 });
    const r = await ctx.sidecar.send('files.search', { path: p, query: q, job, max: SEARCH_MAX }, { timeoutMs: 6000 });
    if (!r.ok) { S.jobs.delete(job); return { ok: false, reason: `the search did not start: ${r.error}` }; }
    return { ok: true, job };
  });
  cmd('size', async (a, wr) => {
    const p = onePath(a.path);
    if (!p) return { ok: false, reason: 'no folder given' };
    const job = newJob('size');
    S.jobs.set(job, { job, kind: 'size', w: wr.key, at: Date.now(), count: 0 });
    const r = await ctx.sidecar.send('files.size', { path: p, job }, { timeoutMs: 6000 });
    if (!r.ok) { S.jobs.delete(job); return { ok: false, reason: `the size could not be counted: ${r.error}` }; }
    return { ok: true, job };
  });
  cmd('stat', async (a) => {
    const p = onePath(a.path);
    if (!p) return { ok: false, reason: 'no file given' };
    const r = await ctx.sidecar.send('files.stat', { path: p }, { timeoutMs: 6000 });
    return r.ok ? Object.assign({ ok: true, location: C.parentOf(p) }, r.result) : { ok: false, reason: `its properties could not be read: ${r.error}` };
  });
  /** A file-type key the page asks icons / type names for: "folder", ".txt", "" (no extension). */
  const EXT_RE = /^(folder|\.?[^\\/:*?"<>|\x00-\x1f]{0,64})$/;
  const extList = (v) => (Array.isArray(v) ? v.slice(0, 200).filter((e) => typeof e === 'string' && EXT_RE.test(e)).map((e) => e.toLowerCase()) : []);
  cmd('icons', async (a) => {
    const px = [16, 32, 48, 256].includes(Number(a.px)) ? Number(a.px) : 32;
    const exts = extList(a.exts);
    if (S.icons.size > CACHE_MAX) S.icons.clear();            // bounded: a page cannot grow it for ever
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
  cmd('types', async (a) => {
    const exts = extList(a.exts);
    if (S.types.size > CACHE_MAX) S.types.clear();
    const types = {};
    const missing = exts.filter((e) => { if (S.types.has(e)) { types[e] = S.types.get(e); return false; } return true; });
    if (missing.length) {
      const r = await ctx.sidecar.send('files.types', { exts: missing }, { timeoutMs: 6000 });
      if (r.ok) for (const e of missing) { const t = r.result && r.result.types && r.result.types[e]; if (t) { S.types.set(e, t); types[e] = t; } }
    }
    return { ok: true, types };
  });
  cmd('thumbs', thumbs);
  cmd('preview', preview);
  cmd('op', async (a, wr) => startOp(wr.key, Object.assign({}, a, { w: wr.key })));
  cmd('conflicts', async (a) => {
    const dest = onePath(a.dest);
    if (!dest) return { ok: false, reason: 'the destination is not a folder Mantle Files can use' };
    const pa = pathsArg(a.items, MAX_ITEMS);
    if (!pa.paths) return { ok: false, reason: pa.reason };
    const r = await ctx.sidecar.send('files.conflicts', { items: pa.paths, dest }, { timeoutMs: 6000 });
    return r.ok ? Object.assign({ ok: true }, r.result) : { ok: false, reason: `the destination could not be checked: ${r.error}` };
  });
  /* Undo and redo (Ctrl+Z / Ctrl+Y): one history for every window (see S.undo). Undoing a step makes
     its inverse redoable; redoing it makes it undoable again; any new change clears the redo side. */
  async function step(wr, kind) {
    const stack = kind === 'undo' ? S.undo : S.redo;
    const top = stack.pop();
    if (!top) return { ok: false, reason: kind === 'undo' ? 'nothing to undo' : 'nothing to redo' };
    const spec = top.op === 'restore'
      ? { w: wr.key, op: 'restore', keys: top.keys }
      : { w: wr.key, op: top.op, items: top.items, name: top.name, dest: top.dest, conflict: top.op === 'move' ? 'ask' : undefined };
    spec[kind] = true;
    spec.from = top;
    const r = await startOp(wr.key, spec, true);
    if (!r.ok) stack.putBack(top);                                // it did not start: still there to try again
    history();
    return r.ok ? { ok: true, job: r.job, label: top.label } : { ok: false, reason: `${top.label} did not work: ${r.reason}` };
  }
  cmd('undo', async (a, wr) => step(wr, 'undo'));
  cmd('redo', async (a, wr) => step(wr, 'redo'));
  cmd('clip', async (a) => {
    const pa = pathsArg(a.paths, MAX_ITEMS);
    if (!pa.paths) return { ok: false, reason: pa.reason };
    const paths = pa.paths;
    const cut = a.op === 'cut';
    S.clip = { paths, cut };
    toAll('files.clip', { count: paths.length, cut, paths });
    if (test) return { ok: true, count: paths.length, cut, internal: true };
    const r = await ctx.sidecar.send('files.clip.set', { paths, cut }, { timeoutMs: 4000 });
    if (!r.ok) return { ok: true, count: paths.length, cut, internal: true, note: `Windows' clipboard was not written (${r.error}); paste works inside Mantle Files only` };
    return { ok: true, count: paths.length, cut };
  });
  cmd('clipinfo', async () => {
    const c = await clipGet();
    return { ok: true, count: c.paths.length, cut: c.cut, from: c.from };
  });
  cmd('paste', async (a, wr) => {
    const c = await clipGet();
    if (!c.paths.length) return { ok: false, reason: 'the clipboard has no files' };
    const r = await transfer(wr.key, c.paths, a.dest, c.cut ? 'move' : 'copy', a.conflict);
    if (r.ok && r.job && c.cut) { S.clip = { paths: [], cut: false }; toAll('files.clip', { count: 0, cut: false, paths: [] }); }
    return r;
  });
  cmd('drop', async (a, wr) => {
    const paths = Array.isArray(a.paths) ? a.paths : [];
    if (!paths.length) return { ok: false, reason: 'only files and folders can be dropped here' };
    if (paths.length > MAX_ITEMS) return { ok: false, reason: TOO_MANY(MAX_ITEMS) };
    return transfer(wr.key, paths, a.dest, C.dropEffect(a.effect, paths.map(onePath), onePath(a.dest)), a.conflict);
  });
  // An OS drag of files that EXIST (Electron's startDrag with a missing file is undefined behaviour),
  // at most MAX_SHELL_ITEMS of them.
  cmd('drag', async (a) => {
    const win = winOf(a.w);
    const pa = pathsArg(a.paths, MAX_SHELL_ITEMS);
    if (!win || !pa.paths) return { ok: false, reason: pa.reason === 'nothing selected' ? 'nothing to drag' : pa.reason };
    const paths = pa.paths;
    if (!paths.every((p) => exists(p))) return { ok: false, reason: 'an item is no longer there; press F5 to refresh' };
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
    } catch (e) { return { ok: false, reason: 'the drag did not start; try again' }; }
  });
  /* Open with and the shell's own menu: the sidecar only ever runs an app REGISTERED for that file
     type (files.handlers names them) or a command of the menu it built itself (a token it issued,
     60 s) -- a page cannot name an arbitrary program. Here: a real path, a short handler name, a
     token and a whole number, or the call never reaches the sidecar. */
  cmd('handlers', async (a) => {
    const p = onePath(a.path);
    if (!p) return { ok: false, reason: 'no file given' };
    const r = await ctx.sidecar.send('files.handlers', { path: p }, { timeoutMs: 6000 });
    return r.ok ? Object.assign({ ok: true }, r.result) : { ok: false, reason: `the apps for it could not be read: ${r.error}` };
  });
  cmd('openwith', async (a) => {
    const p = onePath(a.path);
    if (!p) return { ok: false, reason: 'no file given' };
    if (typeof a.handler !== 'string' || !a.handler || a.handler.length > 512) return { ok: false, reason: 'pick an app from the list' };
    if (test) return { ok: true, dryRun: true, reason: 'test mode: would open it with that app' };
    const r = await ctx.sidecar.send('files.openwith', { path: p, handler: a.handler, owner: hwnd(a.w) }, { timeoutMs: 8000 });
    return r.ok ? { ok: true } : { ok: false, reason: `that app did not open it: ${r.error}` };
  });
  cmd('openwithdialog', async (a) => {
    const p = onePath(a.path);
    if (!p) return { ok: false, reason: 'no file given' };
    if (test) return { ok: true, dryRun: true, reason: "test mode: would show Windows' Open with dialog" };
    const r = await ctx.sidecar.send('files.openwithdialog', { path: p, owner: hwnd(a.w) }, { timeoutMs: 8000 });
    return r.ok ? { ok: true } : { ok: false, reason: `the Open with dialog did not open: ${r.error}` };
  });
  cmd('verbs', async (a) => {
    const pa = pathsArg(a.paths, MAX_SHELL_ITEMS);
    if (!pa.paths) return { ok: false, reason: pa.reason };
    const r = await ctx.sidecar.send('files.verbs', { paths: pa.paths }, { timeoutMs: 10000 });
    return r.ok ? Object.assign({ ok: true }, r.result) : { ok: false, reason: `the other apps' commands could not be read: ${r.error}` };
  });
  cmd('verb', async (a) => {
    if (typeof a.token !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(a.token) || !Number.isInteger(a.cmd)) return { ok: false, reason: 'that command is no longer available; right-click the item again' };
    if (test) return { ok: true, dryRun: true, reason: "test mode: would run that app's command" };
    const r = await ctx.sidecar.send('files.verb', { token: a.token, cmd: a.cmd, owner: hwnd(a.w) }, { timeoutMs: 15000 });
    return r.ok ? { ok: true } : { ok: false, reason: `that command did not run: ${r.error}` };
  });
  cmd('copypath', async (a) => {
    const pa = pathsArg(a.paths, MAX_ITEMS);
    if (!pa.paths) return { ok: false, reason: pa.reason };
    const text = C.quotePaths(pa.paths);
    if (test) return { ok: true, text, dryRun: true };
    try { (d.clipboard || E.clipboard).writeText(text); return { ok: true, text }; } catch (e) { return { ok: false, reason: `the clipboard could not be written (${e.message})` }; }
  });
  cmd('zip', async (a, wr) => zipCmd(Object.assign({}, a, { w: wr.key })));
  cmd('unzip', async (a, wr) => unzipCmd(Object.assign({}, a, { w: wr.key })));
  cmd('recycle', async (a, wr) => {
    if (a.op === 'restore') return startOp(wr.key, { w: wr.key, op: 'restore', keys: a.keys });
    if (a.op === 'purge') return startOp(wr.key, { w: wr.key, op: 'purge', keys: a.keys, confirmed: a.confirmed === true });
    if (a.op === 'empty') {
      if (test) return { ok: false, reason: 'test mode: emptying the Recycle Bin is never allowed', refused: true };
      if (a.confirmed !== true) return { ok: false, reason: 'emptying the Recycle Bin needs the confirm first' };
      // The sidecar answers {job, started} and finishes with 'files.opdone' like any other op.
      const job = newJob('op');
      S.jobs.set(job, { job, kind: 'op', w: wr.key, op: 'empty', at: Date.now(), count: 0, dirs: ['mantle:recycle'] });
      const r = await ctx.sidecar.send('files.recycle.empty', { owner: hwnd(a.w), confirmed: true, job }, { timeoutMs: 8000 });
      if (!r.ok) { S.jobs.delete(job); return { ok: false, reason: `the Recycle Bin was not emptied: ${r.error}` }; }
      return { ok: true, job };
    }
    return { ok: false, reason: 'unknown Recycle Bin action' };
  });
  cmd('pin', async (a) => {
    const p = onePath(a.path);
    if (!p) return { ok: false, reason: 'only a folder can be pinned' };
    let list = pins().filter((x) => String(x).toLowerCase() !== p.toLowerCase());
    if (a.on !== false) {
      if (list.length >= MAX_PINS) return { ok: false, reason: `${MAX_PINS} folders are pinned already; unpin one first` };
      list = list.concat([p]);
    }
    try { ctx.settings.set('pins', list); } catch (e) { return { ok: false, reason: `the pin was not saved: ${C.codeWords(e && e.code)}` }; }
    const rows = pinRows();
    toAll('files.pins', { pins: rows });
    return { ok: true, pins: rows };
  });
  cmd('setview', async (a) => {
    const p = C.normPath(a.path);
    if (!p) return { ok: false, reason: 'no folder given' };
    const views = C.putView(S.pending.views || get('views', {}), p, a);
    saveLater('views', views);
    return { ok: true };
  });
  cmd('setopt', async (a) => {
    if (!OPT_KEYS.includes(a.key)) return { ok: false, reason: 'unknown Mantle Files option' };
    let v = a.value;
    if (a.key === 'defaultView' && !['details', 'list', 'grid'].includes(v)) return { ok: false, reason: 'the view must be details, list or grid' };
    if (a.key === 'startIn' && !['last', 'home'].includes(v)) return { ok: false, reason: 'start in must be last or home' };
    if (['showHidden', 'showExtensions', 'searchContents', 'compact', 'checkboxes'].includes(a.key)) v = !!v;
    try { ctx.settings.set(a.key, v); } catch (e) { return { ok: false, reason: `the setting was not saved: ${C.codeWords(e && e.code)}` }; }
    toAll('files.opts', { options: opts() });
    return { ok: true, options: opts() };
  });
  cmd('tabs', async (a, r) => {
    const tabs = Array.isArray(a.tabs) ? a.tabs.slice(0, MAX_TABS) : [];
    r.tabs = tabs.map((t) => (t && typeof t === 'object' ? t.path : t)).filter((p) => typeof p === 'string' && p.length <= C.PATH_MAX);
    r.active = Math.max(0, Math.min(r.tabs.length - 1, Number(a.active) || 0));
    const ids = new Set(tabs.filter((t) => t && typeof t === 'object' && t.tab !== undefined).map((t) => `${r.key}|${t.tab}`));
    if (ids.size) for (const k of [...S.watchers.keys()]) if (k.startsWith(r.key + '|') && !ids.has(k)) { const wt = S.watchers.get(k); try { wt.watcher.close(); } catch (_) { /* gone */ } clearTimeout(wt.timer); S.watchers.delete(k); }
    // The last folder is saved only as a FOLDER (lane mantle-files): a tab reports its path before its
    // listing says what it is, so a typed file path was once saved and broke 3 of 6 opens.
    const cur = C.normPath(r.tabs[r.active]);
    // review2: the save waits on a stat, and an older report's stat (a slow or sleeping drive) can land
    // after a newer one's: only this window's LATEST report may save, or Win+E opens a folder Owen left.
    const mine = r.tabsSeq = (r.tabsSeq || 0) + 1;
    if (cur) {
      const kinds = new Map();
      if (!C.isVirtual(cur)) { kinds.set(cur.toLowerCase(), await kindLater(cur)); const up = C.parentOf(cur); if (up && kinds.get(cur.toLowerCase()) === 'file') kinds.set(up.toLowerCase(), await kindLater(up)); }
      if (r.tabsSeq !== mine) return { ok: true };
      const keep = C.folderToSave(cur, (p) => kinds.get(p.toLowerCase()) || null);
      if (keep && !sameP(keep, lastSaved())) saveLater('lastFolder', keep);
      if (keep) cacheLast(keep);
    }
    return { ok: true };
  });

  if (typeof ctx.onOption === 'function') ctx.onOption('*', () => toAll('files.opts', { options: opts() }));
  if (HAS_CHORD) ctx.onChord(CHORD, () => { const r = openWindow({ via: 'Win+E' }); if (!r.ok) ctx.log(`Win+E: ${r.reason}`); });

  /* The launcher's "Mantle Files" row and the top bar: 'mantle-open' with 'files' (or 'files:<path>')
     on the shared event, or 'mantle-open:files' (path) on our own, listened to ONLY while on, so a
     caller that checks app.listenerCount('mantle-open:files') can say "switched off" instead of
     doing nothing (the shared event always has lib/wallpaper.js listening). */
  const onShared = (target) => { const t = String(target || ''); if (t === 'files' || t.startsWith('files:')) openWindow({ path: t.slice(6) || undefined, via: 'an open request' }); };
  /* p: a folder path, or { path?, via?, reply? } from main.js's bar (lane barfiles, 2026-09-29): `reply`
     gets openWindow's own answer, so a bar click that could not open says why instead of nothing. */
  const onOwn = (p) => {
    const o = p && typeof p === 'object' ? p : { path: p };
    const r = openWindow({ path: typeof o.path === 'string' && o.path ? o.path : undefined, via: typeof o.via === 'string' && /^[a-z +-]{1,24}$/i.test(o.via) ? o.via : 'the bar' });
    if (o.reply && typeof o.reply === 'object') { o.reply.handled = true; o.reply.ok = !!r.ok; o.reply.reason = r.ok ? null : r.reason; }
  };
  const listen = (on) => {
    if (!app || typeof app.on !== 'function') return;
    app.removeListener('mantle-open', onShared);
    app.removeListener('mantle-open:files', onOwn);
    if (on) { app.on('mantle-open', onShared); app.on('mantle-open:files', onOwn); }
  };
  listen(ctx.enabled());
  ctx.onEnabled((on) => {
    listen(on);
    if (!on) { dropSpare('switched off in the tray'); for (const k of [...S.wins.keys()]) closeWindow(k, 'switched off in the tray'); } else spareSoon('switched on');
  });
  const keepReadyChanged = () => { if (keepReady()) spareSoon('keep ready was turned on'); else dropSpare('keep ready was turned off'); };
  let krOff = null;
  if (KR && typeof KR.onChange === 'function') { try { krOff = KR.onChange((surface) => { if (surface === 'files') keepReadyChanged(); }); } catch (e) { ctx.log(`keep ready: its switch cannot be followed (${e && e.message}); it is read at each start`); } }
  // a game rest gives the spare's RAM back; open windows stay (Files never rests: see the header)
  if (typeof ctx.onRest === 'function') ctx.onRest(({ on }) => { S.resting = !!on; if (on) dropSpare('Mantle rests for a game'); else spareSoon('the game ended'); });

  loadLast();
  spareSoon('Mantle started');
  ctx.health(true);
  return {
    async stop(why) {
      S.stopped = true;
      dropSpare(why || 'stopped');
      if (typeof krOff === 'function') { try { krOff(); } catch (_) { /* gone */ } }
      clearTimeout(lastWriteT);
      wall.stop();
      for (const rs of S.hashes.values()) { try { rs.destroy(); } catch (_) { /* gone */ } }
      listen(false);
      clearTimeout(pruneTimer);
      flushSaves();
      for (const k of [...S.wins.keys()]) closeWindow(k, why || 'stopped');
      for (const [job, j] of S.jobs) { if (j.js) j.cancel = true; else if (j.kind !== 'op') ctx.sidecar.send('files.cancel', { job }); }
    },
    // files.test.js
    _S: S, _open: openWindow, _spareSoon: spareSoon, _makeSpare: makeSpare, _startPath: startPath, _opDone: opDone, _sandbox: sandbox, _thumbDir: thumbDir,
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
    // Keep ready (one hidden spare window, OFF by default: Owen, RAM first) has NO row here: its one
    // switch is "Keep Files ready" in Settings > Keep ready in the background (lib/keep-ready.js 'files').
    // (lane files-main, 2026-09-29) "Open Mantle Files instead of Explorer" (replaceExplorer) is gone:
    // nothing ever read it ("Phase 2 ... nothing is registered with Windows yet"), and a setting that
    // does nothing breaks "minimal, obvious". Win+E already opens Mantle Files.
  ],
  install: (ctx) => install(ctx),
  _install: install,             // files.test.js: the same install against a fake ctx, windows and sidecar
  TITLE, CHORD, HAS_CHORD, APP_ID, ICON,
};
