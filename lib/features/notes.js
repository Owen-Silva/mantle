'use strict';
/*
 * notes.js - QUICK NOTES that drop down from the top bar (lane tbnotes, 2026-09-27).
 *
 * Owen (videos, notes, code) wanted somewhere to throw a line down without opening an app:
 *   Win+Alt+N                  opens / closes the pad (the caret lands in the text)
 *   the top bar's notes icon   the same (lib/features/topbar.js calls notes.toggle {x, app, via, wasOpen})
 *   Esc                        closes and gives the keyboard back to the app he was in
 *   a click anywhere else      closes (the click went somewhere, so no refocus)
 * The pad is ui/notes/ (tabs, a plain textarea, a footer that says saved / not saved and why).
 *
 * THE FILE is %USERPROFILE%\Documents\Mantle Notes\notes.md (literally USERPROFILE: here
 * app.getPath('documents') is OneDrive\Documents and Owen keeps his files in C:\Users\user\Documents).
 * Format, atomic saves, outside changes and deleted.md: lib/features/_notes-store.js.
 * --test NEVER touches it: MANTLE_NOTES_DIR (honoured in --test only) else <settings folder>\notes,
 * and a test folder under %USERPROFILE%\Documents is refused.
 *
 * PRIVACY (hard): note text never goes into ANY log, counts only ("saved 3 notes, 1204 characters").
 * main.js's call log writes a command's ARGS to mantle.log whenever it answers ok:false or throws
 * (and after stop() every command throws), so text NEVER travels as mantle.call args. It is PULLED:
 * the page calls notes.dirty {rev} (no text) 400 ms after typing stops and on close; main then reads
 * the text set with executeJavaScript('window.__notesTake()') and writes it. Text reaches the page
 * only in command RESULTS (notes.load) and pushed events, which are never logged. notes.dirty always
 * answers ok:true (a failed save is in its `saved`), so a disk that stays full is logged ONCE per
 * reason by this file, not once per keystroke by the call log.
 *
 * NEVER LOSE TEXT: a failed save keeps the text in the pad, says so there with the reason and the
 * path, and is tried again on the next keystroke and every 5 s. The pad's window is not destroyed
 * while its text is unsaved. A rest (game) keeps unsaved notes in module scope (`carry`) and retries
 * them at wake; a quit that cannot save writes them to "notes-rescue <time>.md" beside the settings.
 *
 * THE WINDOW: made on first open, hidden (parked) on close, destroyed after 10 min closed. Focusable
 * (it takes typing), never opened or focused by anything but the chord or a click. --test: never
 * shown, never focused (Owen's desktop); `open` is tracked logically and the page still runs.
 */
const os = require('os');
const path = require('path');
const S = require('./_notes-store');
const hub = require('./_tools-hub');
const raiseWin = require('../raise');

const CHORD = 'Win+Alt+N';
const BAR_H = 28;               // the top bar's height (DIP)
const GAP = 2;
const PAD_W = 380, PAD_H = 340; // the pad (ui/notes/notes.css .pad)
const SIDE = 16, BOTTOM = 24;   // room in the window for the pad's shadow
const WIN_W = PAD_W + 2 * SIDE, WIN_H = PAD_H + BOTTOM;
const IDLE_MS = 10 * 60 * 1000;
const RETRY_MS = 5000;
const TAKE_MS = 1500;
const BLUR_GRACE_MS = 400;      // a top bar icon press blurs the pad first: its toggle then must not reopen it
const HEALTHY = 'Win+Alt+N or the notes icon on the top bar opens the pad';
const TAKE = 'window.__notesTake && window.__notesTake()';
const TAKE_PRUNE = 'window.__notesTake && window.__notesTake({ prune: true })';

let carry = null;               // module scope ON PURPOSE: unsaved notes outlive stop(rest) -> install()

const liveDir = () => path.join(process.env.USERPROFILE || os.homedir(), 'Documents', 'Mantle Notes');
const docsRoot = () => path.join(process.env.USERPROFILE || os.homedir(), 'Documents');
const inside = (p, root) => { const a = path.resolve(p).toLowerCase(), b = path.resolve(root).toLowerCase(); return a === b || a.startsWith(b + path.sep); };

/** Where the notes live. -> { dir, note } (note = a plain-words line when a test folder was refused) */
function notesDir(ctx) {
  if (!(ctx.flags && ctx.flags.test)) return { dir: liveDir(), note: null };
  const fallback = ctx.settings && ctx.settings.file ? path.join(path.dirname(ctx.settings.file), 'notes') : path.join(os.tmpdir(), 'mantle-notes-test');
  const env = process.env.MANTLE_NOTES_DIR && String(process.env.MANTLE_NOTES_DIR).trim();
  let dir = env ? path.resolve(env) : fallback;
  let note = null;
  if (inside(dir, docsRoot())) {
    note = `--test refused the notes folder ${dir} (under Documents: Owen's real files); using ${fallback}`;
    dir = fallback;
  }
  if (inside(dir, docsRoot())) dir = path.join(os.tmpdir(), 'mantle-notes-test');
  return { dir, note };
}

const withTimeout = (p, ms, words) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(words)), ms);
  Promise.resolve(p).then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
});
const charsOf = (texts) => texts.reduce((a, t) => a + String(t).length, 0);

function install(ctx, deps) {
  const d = deps || {};
  const test = !!(ctx.flags && ctx.flags.test);
  const live = !test;
  const electron = () => d.electron || require('electron');
  const where = notesDir(ctx);
  const store = S.createStore({ dir: where.dir });
  const rescueDir = ctx.settings && ctx.settings.file ? path.dirname(ctx.settings.file) : where.dir;
  /* NO FILE NAMES OR PATHS IN THE LOG (lane r7-names, 2026-10-01; BRIEF privacy rule: no file names,
     paths or user names in ANY log line). The pad shows where the notes live; the store's reasons name
     the file ("could not read C:\Users\<you>\...\notes.md: ..."), so every line of this feature goes
     through log(), which says "the notes file" / "the notes folder" / "a note file" instead. */
  const esc = (p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const known = [[store.file, 'the notes file'], [store.dir, 'the notes folder'], [where.dir, 'the notes folder'], [rescueDir, "Mantle's settings folder"]]
    .filter(([p]) => typeof p === 'string' && p.length > 3).sort((a, b) => b[0].length - a[0].length)
    .map(([p, say]) => [new RegExp(`${esc(p)}([\\\\/][^\\s"'<>|?*;,()]*)?`, 'gi'), say]);
  const log = (t) => {
    let s = String(t);
    for (const [re, say] of known) s = s.replace(re, (m, rest) => (rest && rest.length > 1 ? 'a note file' : say));
    ctx.log(s.replace(/\b[A-Za-z]:[\\/][^\s"'<>|?*;,()]*/g, 'a note file'));
  };
  if (where.note) log(where.note);

  let stopped = false;
  let win = null, loaded = false, winErr = null, hung = false;
  let open = false;
  let refocus = null;            // the hwnd to give the keyboard back to
  let blurClosedAt = 0;
  let idleTimer = null, retryTimer = null;
  let saved = { ok: true, at: null, reason: null, rev: 0 };
  let outside = null;            // { copy, name, at }: the last version changed outside Mantle, kept aside
  let loadError = null;
  let count = 0, chars = 0;
  let lastFail = '';
  let rescued = [];
  let lastPlace = null;
  let lastActive = -1;
  let seq = 0;
  let quitting = false;
  const queue = [];              // pushes waiting for the page to finish loading

  ctx.health(true, HEALTHY);

  const state = () => ({
    open, count, file: store.file, folder: store.dir,
    saved: { ok: saved.ok, at: saved.at, reason: saved.reason, rev: saved.rev },
    outside: outside ? { copy: outside.copy, name: outside.name, at: outside.at } : null,
    loadError, rescued: rescued.slice(-3), windowUp: !!(win && !win.isDestroyed()), test,
  });
  const broadcast = () => { if (!stopped) ctx.broadcast('notes.state', state()); };
  ctx.replay('notes.state', state);

  /* ---- the pad's window ---- */
  const app = (() => { try { return electron().app || null; } catch (_) { return null; } })();
  const onQuit = () => { quitting = true; };
  if (app && app.on) app.on('before-quit', onQuit);

  function pushToPad(ev, payload) {
    if (!win || win.isDestroyed()) return;
    if (loaded) ctx.push(win, ev, payload);
    else queue.push([ev, payload]);
  }

  function broke(why) {
    winErr = why;
    ctx.health(false, `${why}; it is made again on the next open`);
    log(`${why}; notes typed since the last save may be lost, the pad is made again on the next open`);
    const w = win;
    win = null; loaded = false; open = false; queue.length = 0;
    try { if (w && !w.isDestroyed()) w.destroy(); } catch (_) { /* gone */ }
    broadcast();
  }

  function ensureWin() {
    if (win && !win.isDestroyed()) return win;
    const BrowserWindow = d.BrowserWindow || electron().BrowserWindow;
    loaded = false;
    queue.length = 0;
    const w = new BrowserWindow({
      show: false, frame: false, transparent: true, skipTaskbar: true, hasShadow: false, focusable: true,
      resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
      alwaysOnTop: live, width: WIN_W, height: WIN_H, x: -32000, y: -32000, title: 'Mantle quick notes',
      backgroundColor: '#00000000',
      webPreferences: { preload: ctx.preload, contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: true },
    });
    if (live) w.setAlwaysOnTop(true, 'pop-up-menu');     // drops over the app Owen is in
    const wc = w.webContents;
    wc.on('will-navigate', (e) => e.preventDefault());
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('render-process-gone', (_e, det) => { if (win === w) broke(`the notes pad's page crashed (${det && det.reason})`); });
    wc.on('did-fail-load', (_e, code, desc, _url, isMain) => { if (isMain !== false && win === w) broke(`the notes pad's page did not load (${desc || code})`); });
    wc.on('did-finish-load', () => {
      if (win !== w) return;
      loaded = true;
      for (const [ev, p] of queue.splice(0)) ctx.push(w, ev, p);
    });
    w.on('unresponsive', () => { if (win === w) { hung = true; ctx.health(false, 'the notes pad stopped responding'); log('the notes pad stopped responding'); } });
    w.on('responsive', () => { if (win === w && hung) { hung = false; ctx.health(true, HEALTHY); log('the notes pad responds again'); } });
    w.on('blur', () => {
      if (win !== w || !open) return;
      blurClosedAt = Date.now();
      closePad({ refocus: false }, 'click-away');
    });
    // Alt+F4 in the OPEN pad: close it like Esc (flush first). Never in Mantle's own quit, and never
    // for the hidden pad (a Windows shutdown's close must not be held up by a window nobody sees).
    w.on('close', (e) => {
      if (stopped || quitting || win !== w || !open) return;
      e.preventDefault();
      closePad({ refocus: true }, 'Alt+F4');
    });
    w.on('closed', () => {
      if (win !== w) return;
      win = null; loaded = false;
      if (!stopped) { log('the notes pad\'s window was closed by Windows; it is made again on the next open'); broadcast(); }
    });
    w.loadFile(ctx.page('index.html'));
    win = w;
    log('the notes pad made its page (a renderer; it goes after 10 min closed)');
    return w;
  }

  function place(w, x) {
    const scr = d.screen || electron().screen;
    const b = scr.getPrimaryDisplay().bounds;
    const nx = x === null || x === undefined || x === '' ? NaN : Number(x);
    const right = Number.isFinite(nx) ? nx : b.x + b.width - 8;             // the pad's RIGHT edge
    let left = Math.round(right - PAD_W - SIDE);                            // the window's left
    left = Math.max(b.x + 4 - SIDE, Math.min(left, b.x + b.width - 4 - SIDE - PAD_W));
    const r = { x: left, y: Math.round(b.y + BAR_H + GAP), width: WIN_W, height: WIN_H };
    if (live) w.setBounds(r);                                               // --test: stays parked, never on screen
    lastPlace = r;
    return r;
  }

  function park() {
    if (!win || win.isDestroyed()) return;
    if (live) {
      try { win.hide(); win.setBounds({ x: -32000, y: -32000, width: WIN_W, height: WIN_H }); } catch (_) { /* gone */ }
    }
  }

  // Live only: Electron's focus() can lose to Windows' foreground lock; the sidecar can hand it over.
  function ensureFocus(w) {
    const t = setTimeout(async () => {
      if (!open || win !== w || w.isDestroyed() || w.isFocused()) return;
      try {
        const buf = w.getNativeWindowHandle();
        const hwnd = buf.length >= 8 ? buf.readBigUInt64LE(0).toString() : String(buf.readUInt32LE(0));
        const r = await ctx.sidecar.send('focus', { hwnd });
        if (!r.ok) log(`the pad could not take the keyboard (${r.error}); click in it to type`);
      } catch (e) { log(`the pad could not take the keyboard (${e && e.message}); click in it to type`); }
    }, 80);
    if (t.unref) t.unref();
  }

  function armIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(idleDestroy, IDLE_MS);
    if (idleTimer.unref) idleTimer.unref();
  }
  async function idleDestroy() {
    idleTimer = null;
    if (stopped || open || !win || win.isDestroyed()) return;
    await flush('idle');
    if (!saved.ok) { log('kept the notes pad\'s page after 10 min closed: its notes are not saved yet'); armIdle(); return; }
    if (open) return;
    const w = win;
    win = null; loaded = false;
    try { w.destroy(); } catch (_) { /* gone */ }
    if (hung) { hung = false; ctx.health(true, HEALTHY); }
    log('the notes pad\'s page was closed after 10 min unused (its renderer is gone; it comes back on the next open)');
    broadcast();
  }

  /* ---- the pull: page text -> main -> notes.md ---- */
  function clean(r) {
    if (!r || typeof r !== 'object' || !Array.isArray(r.notes) || !r.notes.length) return null;
    const notes = r.notes.filter((n) => n && typeof n.text === 'string').map((n) => ({ id: String(n.id || ''), text: n.text }));
    if (!notes.length) return null;
    const ai = notes.findIndex((n) => n.id === String(r.active));
    return { rev: Number(r.rev) || 0, notes, active: String(r.active || ''), activeIndex: ai < 0 ? 0 : ai };
  }
  async function take(prune) {
    if (!win || win.isDestroyed()) return null;      // a page still loading answers null (no __notesTake yet)
    try {
      return clean(await withTimeout(win.webContents.executeJavaScript(prune ? TAKE_PRUNE : TAKE, false), TAKE_MS,
        `the pad did not hand over its text within ${TAKE_MS} ms`));
    } catch (e) {
      return { error: `could not read the pad's text (${e && e.message ? String(e.message).slice(0, 160) : 'no answer'})` };
    }
  }

  function startRetry() {
    if (retryTimer || stopped) return;
    retryTimer = setInterval(() => { flush('retry'); }, RETRY_MS);
    if (retryTimer.unref) retryTimer.unref();
  }
  function stopRetry() { if (retryTimer) { clearInterval(retryTimer); retryTimer = null; } }

  function rememberActive(i) {
    if (i === lastActive) return;
    lastActive = i;
    try { ctx.settings.set('active', i); } catch (_) { /* a convenience only */ }
  }

  function noteSaved(r, texts, activeIndex, rev) {
    if (r.ok) {
      const was = saved.ok;
      saved = { ok: true, at: r.at, reason: null, rev: Math.max(saved.rev, rev) };
      count = texts.length; chars = charsOf(texts);
      carry = null;
      lastFail = '';
      stopRetry();
      if (r.outside) {
        outside = { copy: r.outside, name: path.basename(r.outside), at: r.at };
        log(`notes.md had changed outside Mantle: that version was kept as a copy (a note file next to it) before saving ${count} notes, ${chars} characters`);
      }
      if (!was) log(`saved again after a failure: ${count} notes, ${chars} characters`);
    } else {
      saved = { ok: false, at: saved.at, reason: r.reason, rev: saved.rev };
      carry = { texts: texts.slice(), active: activeIndex, reason: r.reason };
      if (r.reason !== lastFail) {
        log(`could not save ${texts.length} notes, ${charsOf(texts)} characters: ${r.reason}; the text is kept in the pad and tried again every 5 s`);
        lastFail = r.reason;
      }
      startRetry();
    }
  }

  async function flushOnce(why, prune) {
    const t = await take(prune);
    if (!t) return { ok: true, skipped: 'no pad text' };
    if (t.error) {
      if (t.error !== lastFail) { log(`${why}: ${t.error}`); lastFail = t.error; }
      return { ok: false, reason: t.error };
    }
    rememberActive(t.activeIndex);
    if (t.rev <= saved.rev && saved.ok) return { ok: true, skipped: 'nothing new', rev: t.rev };
    const texts = t.notes.map((n) => n.text);
    const r = await store.save(texts);
    noteSaved(r, texts, t.activeIndex, t.rev);
    broadcast();
    return { ok: r.ok, rev: t.rev, reason: r.reason || null };
  }

  // One flush at a time; one asked for while another runs runs once more after it (the latest text wins).
  let flushP = null, again = false, againPrune = false;
  function flush(why, prune) {
    if (flushP) { again = true; againPrune = againPrune || !!prune; return flushP; }
    flushP = (async () => {
      let r = await flushOnce(why, prune);
      while (again) { const p = againPrune; again = false; againPrune = false; r = await flushOnce(why, p); }
      return r;
    })().finally(() => { flushP = null; });
    return flushP;
  }

  /* ---- open / close ---- */
  function toNotes(texts) {
    return (texts.length ? texts : ['']).map((text) => ({ id: `n${++seq}`, text }));
  }

  async function maybeReload() {
    const t = await take(false);
    if (!t || t.error) return null;
    if (t.rev > saved.rev || !saved.ok) return null;       // unsaved text in the pad wins; a save keeps the outside version aside
    if (!(await store.changedOnDisk())) return null;
    const l = await store.load();
    if (!l.ok) { loadError = l.reason; log(`notes.md changed outside Mantle but could not be read again: ${l.reason}`); return null; }
    loadError = null;
    const notes = toNotes(l.texts);
    count = notes.length; chars = charsOf(l.texts);
    const ai = Math.min(Math.max(0, t.activeIndex), notes.length - 1);
    log(`notes.md changed outside Mantle; the pad reloaded it (${count} notes, ${chars} characters)`);
    return { notes, active: notes[ai].id, rev: saved.rev };
  }

  async function openPad(a, via) {
    if (stopped) return { ok: false, reason: 'quick notes is stopped' };
    if (!ctx.enabled()) return { ok: false, reason: 'quick notes is switched off in the tray' };
    if (open) { pushToPad('notes.open', { focus: true, reload: null, via }); return { ok: true, open: true, already: true }; }
    if (a.app) refocus = String(a.app);
    else {
      const f = await ctx.sidecar.send('foreground', {});                  // read-only: who gets the keyboard back
      const h = f && f.ok && f.result && f.result.hwnd;
      refocus = h && String(h) !== '0' ? String(h) : null;
    }
    let w;
    try { w = ensureWin(); } catch (e) {
      const r = `the notes pad could not be made (${e && e.message})`;
      ctx.health(false, r);
      log(r);
      return { ok: false, reason: r };
    }
    clearTimeout(idleTimer); idleTimer = null;
    place(w, a.x);
    const reload = loaded ? await maybeReload() : null;
    if (stopped || win !== w) return { ok: false, reason: 'the notes pad closed while opening' };
    open = true;
    pushToPad('notes.open', { focus: true, reload, via });
    if (live) {
      w.show(); w.focus();
      // On top EVERY time (r7-ontop): show() and focus() never lift a window Windows has let sink.
      raiseWin.up(w, { level: 'pop-up-menu', what: 'the notes pad', log: ctx.log, wanted: () => open && win === w && !w.isDestroyed() });
      ensureFocus(w);
    }
    if (winErr) { winErr = null; ctx.health(true, HEALTHY); }
    broadcast();
    return { ok: true, open: true };
  }

  async function closePad(a, via) {
    if (!open) return { ok: true, open: false };
    open = false;
    park();
    if (a.refocus && live && refocus) {
      const f = await ctx.sidecar.send('focus', { hwnd: refocus });
      if (!f.ok) log(`could not give the keyboard back to the app (${f.error})`);
    }
    broadcast();
    const r = await flush('close', true);          // an empty extra note is dropped here (never the last one)
    armIdle();
    log(`closed (${via}): ${count} notes, ${chars} characters, ${saved.ok ? 'saved' : 'NOT saved (' + saved.reason + ')'}`);
    broadcast();
    return { ok: true, open: false, saved: state().saved, flushed: r && r.ok !== false };
  }

  async function toggle(a, via) {
    if (a.wasOpen && !open) return { ok: true, open: false, why: 'already closed by the click that pressed the icon' };
    if (!open && via !== 'chord' && Date.now() - blurClosedAt < BLUR_GRACE_MS) return { ok: true, open: false, why: 'closed by the same click' };
    if (open) { if (a.app) refocus = String(a.app); return closePad({ refocus: true }, via); }
    return openPad(a, via);
  }

  /* ---- a rest (game) left unsaved notes: try them again now ---- */
  async function retryCarry() {
    if (!carry) return;
    const c = carry;
    const l = await store.load();                  // what is on disk now (so an outside change is still kept aside)
    if (!l.ok) { saved = { ok: false, at: null, reason: c.reason, rev: 0 }; broadcast(); return; }
    const r = await store.save(c.texts);
    if (r.ok) { carry = null; count = c.texts.length; chars = charsOf(c.texts); saved = { ok: true, at: r.at, reason: null, rev: 0 }; log(`saved the notes left unsaved before the rest: ${count} notes, ${chars} characters`); }
    else { saved = { ok: false, at: null, reason: r.reason, rev: 0 }; log(`the notes left unsaved before the rest still cannot be saved: ${r.reason}; they wait in the pad`); }
    broadcast();
  }
  if (carry) retryCarry();

  /* ---- commands (no text in any argument) ---- */
  ctx.command('load', async () => {
    const l = await store.load();
    loadError = l.ok ? null : l.reason;
    if (!l.ok) log(`could not read the notes file: ${l.reason}`);
    let texts = l.texts, dirty = false, ai = Number(ctx.settings.get('active', 0)) || 0;
    if (carry) { texts = carry.texts; dirty = true; ai = carry.active; saved = { ok: false, at: saved.at, reason: carry.reason, rev: 0 }; startRetry(); }
    else saved = Object.assign({}, saved, { rev: 0 });                     // a (new) page counts from 0
    const notes = toNotes(texts);
    count = notes.length; chars = charsOf(texts);
    ai = Math.min(Math.max(0, ai), notes.length - 1);
    lastActive = ai;
    rescued = await S.listRescue(rescueDir);
    log(`loaded ${count} notes, ${chars} characters${l.missing ? ' (no notes file yet: it is made on the first save)' : ''}${dirty ? ' (unsaved notes from before a rest)' : ''}`);
    broadcast();
    return { ok: true, notes, active: notes[ai].id, file: store.file, folder: store.dir, saved: state().saved, outside, loadError, dirty, rescued: rescued.slice(-3) };
  });
  ctx.command('dirty', async () => {
    const r = await flush('typing');
    return { ok: true, rev: r && r.rev, saved: state().saved, outside: state().outside };
  });
  ctx.command('toggle', async (a) => toggle(a || {}, (a && a.via) || 'the top bar'));
  ctx.command('open', async (a) => openPad(a || {}, (a && a.via) || 'open'));
  ctx.command('close', async (a) => closePad(a || {}, (a && a.via) || (a && a.refocus ? 'Esc' : 'close')));
  ctx.command('state', async () => Object.assign({ ok: true }, state()));
  ctx.command('new', async (a) => {
    const r = open ? { ok: true, open: true } : await openPad(a || {}, 'new note');
    if (r.ok) pushToPad('notes.new', {});
    return r;
  });
  ctx.command('delete', async (a) => {
    const id = a && a.id ? String(a.id) : '';
    if (!id) return { ok: false, reason: 'notes.delete needs the note (id)' };
    const t = await take(false);
    if (!t) return { ok: false, reason: 'the notes pad is not up' };
    if (t.error) return { ok: false, reason: t.error };
    const i = t.notes.findIndex((n) => n.id === id);
    if (i < 0) return { ok: false, reason: 'that note is not in the pad any more' };
    const len = t.notes[i].text.length;
    // A blank note has nothing to keep: deleted.md is not grown by empty entries (quality pass 2026-09-29).
    const blank = t.notes[i].text.trim() === '';
    const k = blank ? { ok: true, file: null } : await store.appendDeleted(t.notes[i].text);
    if (!k.ok) { log(`a delete was refused: ${k.reason}`); return { ok: false, reason: `not deleted: ${k.reason}` }; }
    const left = t.notes.filter((_, j) => j !== i).map((n) => n.text);
    const r = await store.save(left.length ? left : ['']);
    noteSaved(r, left.length ? left : [''], 0, saved.rev);   // the page drops it and saves again (same text: no write)
    log(`deleted a note (${len} characters)${blank ? ' (blank, nothing kept)' : ' into deleted.md'}; ${left.length || 1} notes left`);
    broadcast();
    return { ok: true, deleted: id, keptIn: k.file, saved: state().saved };
  });

  ctx.onChord(CHORD, async () => {
    if (!ctx.enabled()) return;
    await toggle({}, 'chord');
  });
  ctx.onEnabled((on) => { if (!on && open) closePad({ refocus: false }, 'switched off in the tray'); });

  /* ---- test hooks: --test ONLY ---- */
  const hooks = test ? {
    dir: store.dir,
    open: (o) => openPad(o || {}, 'test'),
    close: (o) => closePad(o || {}, 'test'),
    state: () => Object.assign(state(), { place: lastPlace, refocus }),
    win: () => win,
    take: () => take(false),
    flush: () => flush('test'),
  } : null;
  if (hooks) hub.test.notes = hooks;

  return {
    async stop(why, how) {
      const rest = !!(how && how.rest);
      clearTimeout(idleTimer); idleTimer = null;
      stopRetry();
      if (app && app.removeListener) app.removeListener('before-quit', onQuit);
      if (win && !win.isDestroyed()) {
        if (open) park();
        await flush('stop');                       // take + write BEFORE the renderer goes
      }
      if (!saved.ok && carry && !rest) {
        const r = await S.writeRescue(rescueDir, carry.texts);
        log(r.ok ? `notes could not be saved (${saved.reason}); a rescue copy was written (a note file; the pad lists it)`
          : `notes could not be saved (${saved.reason}) and no rescue copy could be written (${r.reason})`);
        if (r.ok) carry = null;
      }
      open = false;
      stopped = true;
      const w = win;
      win = null;
      try { if (w && !w.isDestroyed()) w.destroy(); } catch (_) { /* gone */ }
      if (hooks && hub.test.notes === hooks) delete hub.test.notes;
      log(`stopped (${why}${rest ? ', resting' : ''}): ${count} notes, ${chars} characters, ${saved.ok ? 'saved' : 'NOT saved (' + saved.reason + ')' + (rest && carry ? ', kept for after the rest' : '')}`);
    },
    // for notes.test.js
    _state: state,
    _flush: (p) => flush('test', p),
  };
}

module.exports = {
  name: 'notes',
  label: 'Quick notes (Win+Alt+N)',
  defaultOn: true,
  chords: [CHORD],
  observe: [],
  rest: true,
  install: (ctx) => install(ctx),
  _install: install,           // notes.test.js: the same install against a fake ctx, window and screen
  _notesDir: notesDir,
  _resetCarry: () => { carry = null; },
  _carry: () => carry,
  PAD_W, PAD_H, WIN_W, WIN_H, SIDE,
};
