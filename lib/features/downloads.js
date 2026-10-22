'use strict';
/*
 * downloads.js - the Downloads shelf in the bottom bar, like macOS's Downloads stack (lane downloads,
 * 2026-09-27). The control is ui/bar/downloads.js (a button in the bar's right group and its panel);
 * the folder read is sidecar/Downloads.cs; the shelf's policy (what is skipped, the order) is
 * ./_downloads-list.js.
 *
 * WHAT IT DOES
 *   - the newest 12 items of the user's REAL Downloads folder (FOLDERID_Downloads, so a Downloads moved
 *     into OneDrive is followed), newest arrival first, partial downloads and hidden/system files skipped
 *   - a dot on the button when something finished downloading since they last opened the shelf; the
 *     time they last opened it is remembered (settings seenAt), so a restart does not re-flag anything
 *   - open (the default app, through lib/open-target.js like the launcher), Show in folder (Explorer
 *     with it selected), drag out (webContents.startDrag), Open Downloads folder
 *
 * WATCHING, and what it costs: ONE fs.watch on the folder (ReadDirectoryChangesW: no CPU while nothing
 * changes). An event re-reads the folder after 700 ms of quiet, at most every 4 s while events keep
 * coming; a browser writing into its .crdownload/.part is ignored outright (those 'change' events
 * cannot change what the shelf shows). A re-read is one sidecar directory walk (FindFirstFile, no stat
 * per file). The panel's open re-reads once more (cheap, and right even if the watch missed
 * something). No poll: the only timer is a 2-minute retry while the folder is MISSING. rest:true,
 * so a game gets the watch closed and nothing else.
 *
 * Commands (window.mantle.call('downloads.<verb>')): list {cached?}, seen, open {item}, reveal {item},
 * folder, drag {item}. Rows are addressed by an opaque `item` token, never by path, because a
 * command that fails is written to mantle.log WITH its arguments (lib/call-log.js).
 * Push: 'downloads.state' {on, ok, state, reason, count, newCount, partial, watching, rev} (replayed).
 *
 * PRIVACY: file NAMES are the user's. The log gets counts only ("12 items, 1 new"); no reason, log line,
 * health text or command argument carries a name or a path. The panel shows names (it is their screen).
 *
 * --test (ctx.flags.test): open / reveal / folder are DRY RUNS (nothing appears in front of the user), and
 * MANTLE_DOWNLOADS_DIR points the shelf at a temp folder (ignored, with a log line, in a live run).
 */
const fs = require('fs');
const path = require('path');
const L = require('./_downloads-list.js');

const OFF = 'the Downloads shelf is off in Mantle’s tray menu';
const SHELF = 12;           // rows in the panel
const FETCH = 60;           // entries asked of the sidecar (partials are dropped after)
const DEBOUNCE_MS = 700;    // quiet time after the last folder event before a re-read
const MAX_WAIT_MS = 4000;   // ... but never longer than this while events keep coming
const RETRY_MS = 120000;    // a broken watch (folder missing) is tried again this often, never faster
/* What a stopped watch means to them (the cause, with its code, is in the log). */
const WATCH_WORDS = 'new downloads show up when you open this panel, not the moment they finish';

function electron() {
  if (!process.versions.electron) return null;
  try { return require('electron'); } catch (_) { return null; }
}

function install(ctx, inject) {
  const inj = inject || {};
  const test = !!(ctx.flags && ctx.flags.test);
  const now = inj.now || (() => Date.now());
  let override = inj.folder || null;
  if (!override && process.env.MANTLE_DOWNLOADS_DIR) {
    if (test) override = process.env.MANTLE_DOWNLOADS_DIR;
    else ctx.log('MANTLE_DOWNLOADS_DIR is ignored outside --test');
  }
  const el = inj.electron !== undefined ? inj.electron : electron();
  const watchFn = inj.watch || ((dir, o, fn) => fs.watch(dir, o, fn));
  const openFn = inj.open || ((p) => require('../open-target').openTarget(p));
  const dry = inj.dryRun !== undefined ? !!inj.dryRun : test;
  const retryMs = inj.retryMs || RETRY_MS;   // downloads.test.js shortens it; 2 minutes otherwise

  let stopped = false;
  let watcher = null, watched = null, watchWhy = null;
  let watchCalmUntil = 0;   // after a watch error: no re-watch before this (the retry timer re-arms it)
  let debounce = null, firstEventAt = 0, retry = null, bootTimer = null;
  let reading = null, again = false;
  let last = null;            // the last read, see read()
  let rev = 0;                // bumped whenever what the shelf shows changes
  let lastSig = '';
  let lastPushed = '';
  let lastLogged = '';
  let seenNote = null;
  let cur = new Map(), prev = new Map();   // item token -> absolute path (this listing, the one before)
  let seq = 0;

  /* ------------------------------------------------------------ seen */
  let seenAt = Number(ctx.settings.get('seenAt', 0)) || 0;
  /* A saved time that is not a real past moment (a corrupt or hand-edited settings file: 1e308, a
     negative) would hide every new download, or flag every old one, until they opened the shelf. */
  if (seenAt && !(Number.isFinite(seenAt) && seenAt > 0 && seenAt <= now() + 86400000)) {
    ctx.log('the saved seenAt was not a usable time (in the future, negative or not a number); reset to now');
    seenAt = 0;
  }
  function saveSeen() {
    try { ctx.settings.set('seenAt', seenAt); seenNote = null; }
    catch (e) {
      seenNote = 'Mantle could not save when you last looked here, so the new-download dot may come back after a restart.';
      ctx.log('could not save seenAt (' + ((e && e.code) || 'write failed') + ')');
    }
  }
  if (!seenAt) { seenAt = now(); saveSeen(); }   // the first run: what is already there is not "new"

  /* ------------------------------------------------------------ reasons without names */
  const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  function clean(text, abs) {
    let t = String(text || '');
    const cuts = [];
    if (abs) cuts.push([abs, 'it'], [path.basename(abs), 'it']);
    if (last && last.folder) cuts.push([last.folder, 'the Downloads folder']);
    if (override) cuts.push([override, 'the Downloads folder']);
    for (const [s, w] of cuts) if (s && s.length > 1) t = t.replace(new RegExp(esc(s), 'gi'), w);
    return t;
  }

  /* ------------------------------------------------------------ the read */
  function plainFolder() {
    if (override) return override;
    try { return el && el.app ? el.app.getPath('downloads') : null; } catch (_) { return null; }
  }

  async function readOnce() {
    const args = { max: FETCH };
    if (override) args.folder = override;
    let r = null, detail = null, helperWhy = null;
    const s = ctx.sidecar.ready
      ? await ctx.sidecar.send('downloads.list', args, { timeoutMs: 6000 })
      : { ok: false, error: 'it is not running' };
    if (s && s.ok && s.result && typeof s.result === 'object') {
      r = s.result;
    } else {
      /* The sidecar's own words go to the LOG (clean(): no names); the screen gets plain words. */
      helperWhy = clean((s && s.error) || 'no reason was given');
      const f = plainFolder();
      if (!f) r = { ok: false, state: 'unresolved', reason: 'Windows did not say where your Downloads folder is' };
      else {
        r = await L.listFolder(f, { max: FETCH });
        detail = 'Showing a simpler list for now, so hidden files may appear.';
      }
    }
    const sh = r.ok ? L.shelf(r.items, { max: SHELF, seenAt }) : null;
    /* Names stored with a broken UTF-16 character (a lone surrogate) are left out by both reads: they
       come back as U+FFFD, a path that does not exist or names a DIFFERENT file. Said, never a row. */
    const odd = r.ok ? Math.max(0, Math.floor(Number(r.unspellable) || 0)) : 0;
    if (odd) {
      detail = (detail ? detail + ' ' : '') + (odd === 1
        ? '1 item is not shown: its name has a broken character, so Mantle cannot open it; open the Downloads folder to see it.'
        : odd + ' items are not shown: their names have a broken character, so Mantle cannot open them; open the Downloads folder to see them.');
    }
    return {
      ok: !!r.ok,
      state: r.ok ? 'ok' : (r.state || 'error'),
      reason: r.ok ? null : clean(r.reason || 'the Downloads folder could not be read and no reason was given'),
      folder: r.folder || null,
      via: r.via || null,
      total: r.ok ? Math.max(0, (Number(r.total) || 0) - sh.partial - sh.skipped) : 0,
      items: sh ? sh.items : [],
      newCount: sh ? sh.newCount : 0,
      partial: sh ? sh.partial : 0,
      detail,
      code: r.ok ? null : clean(r.code || '') || null,   // for the log line only, never the screen
      helperWhy,                                          // the log's: why the plain read was used
      at: now(),
    };
  }

  /* One read at a time; a request during a read runs one more read after it. Never throws. */
  function read(why) {
    if (stopped) return Promise.resolve(last);
    if (reading) { again = true; return reading; }
    reading = (async () => {
      do {
        again = false;
        let r;
        try { r = await readOnce(); }
        catch (e) { r = { ok: false, state: 'error', reason: 'reading the Downloads folder failed inside Mantle: ' + clean((e && e.message) || e), items: [], newCount: 0, partial: 0, total: 0, at: now() }; }
        if (stopped) break;
        took(r, why);
      } while (again && !stopped);
      reading = null;
      return last;
    })();
    return reading;
  }

  function took(r, why) {
    last = r;
    const sig = JSON.stringify([r.state, r.reason, r.folder, r.newCount, r.partial, r.items.map((i) => [i.name, i.size, i.at])]);
    if (sig !== lastSig) { lastSig = sig; rev++; }
    if (r.ok) { ensureWatch(r.folder); ctx.health(true); }
    else {
      closeWatch();
      watchWhy = r.reason;
      schedRetry();
      ctx.health(false, r.reason);
    }
    const plain = r.helperWhy ? ` (plain read: the sidecar could not answer: ${r.helperWhy})` : '';
    const line = r.ok ? `${r.items.length} items, ${r.newCount} new${r.partial ? `, ${r.partial} downloading` : ''}${plain}`
      : `${r.state}: ${r.reason}${r.code ? ` (${r.code})` : ''}${plain}`;
    if (line !== lastLogged) { lastLogged = line; ctx.log(line + (why ? ` [${why}]` : '')); }
    push();
  }

  /* ------------------------------------------------------------ the watch */
  function ensureWatch(dir) {
    if (stopped || !ctx.enabled() || !dir) return;
    if (watcher && watched === dir) return;
    /* A watch that just failed is not re-armed by the read its failure asked for: read -> watch ->
       error -> read would spin as fast as the disk answers (a flaky network drive, an AV filter).
       The retry timer (schedRetry) re-arms it. */
    if (!watcher && now() < watchCalmUntil) { schedRetry(); return; }
    closeWatch();
    try {
      watcher = watchFn(dir, { persistent: false }, onEvent);
      watched = dir;
      watchWhy = null;
      if (watcher && typeof watcher.on === 'function') {
        watcher.on('error', (e) => {
          const code = (e && e.code) || 'error';
          ctx.log(`the folder watch stopped (${code})`);
          closeWatch();
          watchWhy = WATCH_WORDS;
          watchCalmUntil = now() + retryMs;
          schedRetry();
          push();
          /* The usual cause is the folder itself going away (moved, renamed, deleted): read now, so
             the button and the panel say so at once instead of showing the old rows for 2 minutes. */
          read('watch stopped');
        });
      }
      if (retry) { clearTimeout(retry); retry = null; }
    } catch (e) {
      const code = (e && e.code) || 'error';
      watcher = null; watched = null;
      watchWhy = WATCH_WORDS;
      ctx.log(`the folder cannot be watched (${code})`);
      schedRetry();
    }
  }
  function closeWatch() {
    if (watcher) { try { watcher.close(); } catch (_) { /* already closed */ } }
    watcher = null; watched = null;
    if (debounce) { clearTimeout(debounce); debounce = null; }
  }
  function schedRetry() {
    if (retry || stopped) return;
    retry = setTimeout(() => { retry = null; if (!stopped && ctx.enabled()) read('retry'); }, retryMs);
    if (retry.unref) retry.unref();
  }
  function onEvent(type, name) {
    if (stopped) return;
    /* A browser writing its partial file: the shelf cannot change from that. Its creation and its
       rename to the real name are 'rename' events, which do count. */
    if (type === 'change' && name && L.skipReason(String(name)) === 'partial') return;
    const t = now();
    if (debounce) clearTimeout(debounce); else firstEventAt = t;
    const wait = Math.max(0, Math.min(DEBOUNCE_MS, firstEventAt + MAX_WAIT_MS - t));
    debounce = setTimeout(() => { debounce = null; read('watch'); }, wait);
    if (debounce.unref) debounce.unref();
  }

  /* ------------------------------------------------------------ state push */
  function stateOf() {
    if (!ctx.enabled()) return { on: false, ok: true, state: 'off', reason: OFF, count: 0, newCount: 0, partial: 0, watching: false, rev };
    if (!last) return { on: true, ok: true, state: 'reading', reason: null, count: 0, newCount: 0, partial: 0, watching: !!watcher, rev };
    return {
      on: true, ok: last.ok, state: last.state, reason: last.reason,
      count: last.items.length, newCount: last.newCount, partial: last.partial,
      watching: !!watcher, watchReason: watcher ? null : watchWhy, rev,
    };
  }
  function push() {
    const st = stateOf();
    const sig = JSON.stringify(st);
    if (sig === lastPushed) return;
    lastPushed = sig;
    try { ctx.broadcast('downloads.state', st); } catch (e) { ctx.log(`the state push failed: ${(e && e.message) || e}`); }
  }
  ctx.replay('downloads.state', stateOf);

  /* ------------------------------------------------------------ the panel's view */
  function tokenOf(abs) {
    for (const [t, p] of cur) if (p === abs) return t;
    for (const [t, p] of prev) if (p === abs) return t;
    return 'd' + (++seq);
  }
  async function view() {
    const r = last;
    if (!r) return { ok: false, state: 'reading', reason: 'the Downloads folder has not been read yet', items: [] };
    const next = new Map();
    const items = [];
    for (const i of r.items) {
      const abs = path.join(r.folder, i.name);
      const item = tokenOf(abs);
      next.set(item, abs);
      /* No icon: the bar draws the type's glyph from ONE family (ui/bar/downloads.js kindOf) rather
         than Windows' per-app icons, which clash (and cost a getFileIcon + a data URL per type). */
      items.push({ item, name: i.name, dir: i.dir, size: i.size, at: i.at, fresh: i.fresh });
    }
    prev = cur; cur = next;
    return {
      ok: r.ok, state: r.state, reason: r.reason, folder: r.folder, via: r.via,
      items, total: r.total || 0, newCount: r.newCount, partial: r.partial, detail: r.detail || null,
      watching: !!watcher, watchReason: watcher ? null : watchWhy, seenNote, rev, at: r.at, test,
      retryMs: r.ok ? null : retryMs,   // a missing or unreadable folder is looked for again this often
    };
  }
  function pathOf(item) {
    const k = String(item || '');
    return cur.get(k) || prev.get(k) || null;
  }
  const gone = { ok: false, reason: 'that row is out of date (the list changed); it has been refreshed' };
  /* Async on purpose: a Downloads folder on a share that went away blocked main 21 s in one
     fs.statSync (\\10.255.255.1, measured 2026-09-27). */
  async function exists(abs) { try { await fs.promises.stat(abs); return true; } catch (_) { return false; } }

  /* ------------------------------------------------------------ commands */
  const guard = (verb, fn) => async (a) => {
    if (!ctx.enabled()) return { ok: false, state: 'off', reason: OFF };
    try { return await fn(a || {}); } catch (e) {
      ctx.log(`${verb} threw (${(e && e.name) || 'error'})`);
      return { ok: false, reason: `${verb} failed inside Mantle: ${clean((e && e.message) || e)}` };
    }
  };

  ctx.command('list', guard('list', async (a) => {
    if (!(a.cached && last)) await read('panel');
    return view();
  }));

  ctx.command('seen', guard('seen', async () => {
    const newest = last && last.items.length ? last.items[0].at : 0;
    seenAt = Math.max(now(), newest);
    saveSeen();
    if (last) {
      last.newCount = 0;
      last.items = last.items.map((i) => Object.assign({}, i, { fresh: false }));
    }
    push();
    return { ok: true, seenAt, note: seenNote };
  }));

  /* Windows' own open errors, in words that say what to do next (the bar shows "Could not open <name>: "
     and then this). Anything else passes through, minus a trailing error code. */
  function openWhy(t) {
    if (/no application is associated/i.test(t)) return 'Windows has no app set for this kind of file. Use Show in folder, then right-click it and choose Open with';
    if (/access is denied|EACCES|EPERM/i.test(t)) return 'Windows did not let Mantle open it (access denied)';
    if (/cannot find the (file|path)|ENOENT/i.test(t)) return 'it is no longer in Downloads (moved or deleted)';
    return t.replace(/\s*\((?:0x[0-9a-f]+|E[A-Z]{3,}|HRESULT[^)]*)\)/gi, '');
  }
  ctx.command('open', guard('open', async (a) => {
    const abs = pathOf(a.item);
    if (!abs) { read('stale row'); return gone; }
    if (!(await exists(abs))) { read('gone'); return { ok: false, reason: 'it is no longer in Downloads (moved or deleted); the list has been refreshed' }; }
    if (dry) return { ok: true, dryRun: true, reason: 'test run: would open it with its default app' };
    const r = await openFn(abs);
    // the bar says "Could not open <name>: ", so the reason is the cause alone (open-target.js starts with "could not open <path>: ")
    if (r && r.ok === false) return { ok: false, reason: openWhy(clean(r.reason || 'Windows did not open it and gave no reason', abs).replace(/^could not open it:\s*/i, '')) };
    return { ok: true, note: r && r.reason ? clean(r.reason, abs) : null };
  }));

  ctx.command('reveal', guard('reveal', async (a) => {
    const abs = pathOf(a.item);
    if (!abs) { read('stale row'); return gone; }
    if (!(await exists(abs))) { read('gone'); return { ok: false, reason: 'it is no longer in Downloads (moved or deleted); the list has been refreshed' }; }
    if (dry) return { ok: true, dryRun: true, reason: 'test run: would show it selected in Explorer' };
    if (!el || !el.shell) return { ok: false, reason: 'Show in folder is not available in this copy of Mantle' };
    el.shell.showItemInFolder(abs);
    return { ok: true };
  }));

  ctx.command('folder', guard('folder', async () => {
    const f = (last && last.folder) || plainFolder();
    if (!f) return { ok: false, reason: 'the Downloads folder is not known yet: ' + ((last && last.reason) || 'it has not been read') };
    if (!(await exists(f))) return { ok: false, reason: 'the Downloads folder does not exist (it was moved, renamed or deleted)' };
    if (dry) return { ok: true, dryRun: true, reason: 'test run: would open the Downloads folder' };
    const r = await openFn(f);
    if (r && r.ok === false) return { ok: false, reason: clean(r.reason || 'Windows did not open the Downloads folder and gave no reason') };
    return { ok: true };
  }));

  /* Drag out: the bar's row cancels its HTML drag and asks for this; Electron then runs the real
     Windows drag of the FILE (drop it on a browser upload, a chat, the desktop). The bar is found by
     its page: a command is not told which window called it (see the report: a main.js seam). */
  ctx.command('drag', guard('drag', async (a) => {
    const abs = pathOf(a.item);
    if (!abs) { read('stale row'); return gone; }
    if (!(await exists(abs))) { read('gone'); return { ok: false, reason: 'it is no longer in Downloads (moved or deleted); the list has been refreshed' }; }
    if (!el || !el.webContents) return { ok: false, reason: 'dragging files out is not available in this copy of Mantle' };
    const wc = (inj.barContents || (() => el.webContents.getAllWebContents()
      .find((w) => !w.isDestroyed() && /[\\/]ui[\\/]bar[\\/]index\.html$/i.test(decodeURIComponent(String(w.getURL() || '').split(/[?#]/)[0])))))();
    if (!wc) return { ok: false, reason: 'the drag could not start: Mantle could not find the bar' };
    let icon = null;
    try { icon = await el.app.getFileIcon(abs, { size: 'normal' }); } catch (_) { icon = null; }
    if (!icon || icon.isEmpty()) icon = dragFallback(el);
    wc.startDrag({ file: abs, icon });
    return { ok: true };
  }));

  /* ------------------------------------------------------------ on / off, sidecar, start */
  ctx.onEnabled((on) => {
    if (!on) { closeWatch(); if (retry) { clearTimeout(retry); retry = null; } ctx.health(true); push(); }
    else read('turned on');
  });
  ctx.sidecar.onReady(() => { if (ctx.enabled()) read('sidecar ready'); });
  /* The sidecar may be slow to come up (or down): the shelf still reads, plainly, after 10 s. */
  bootTimer = setTimeout(() => { bootTimer = null; if (!last && !stopped && ctx.enabled()) read('start'); }, 10000);
  if (bootTimer.unref) bootTimer.unref();
  if (!ctx.enabled()) push();

  return {
    stop(why, opts) {
      stopped = true;
      closeWatch();
      if (retry) { clearTimeout(retry); retry = null; }
      if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; }
      const rest = !!(opts && opts.rest);
      try {
        ctx.broadcast('downloads.state', {
          on: ctx.enabled(), ok: true, state: rest ? 'resting' : 'stopped',
          reason: rest ? `the Downloads shelf is ${why || 'resting'}; it is back when the game exits` : `the Downloads shelf is stopped (${why || 'Mantle put Windows back'})`,
          count: 0, newCount: 0, partial: 0, watching: false, rev: rev + 1,
        });
      } catch (_) { /* no pages left to tell */ }
    },
    _read: read, _state: stateOf, _view: view, _event: onEvent, _seenAt: () => seenAt,
  };
}

/* A plain 16x16 grey tile for a drag whose file gave no icon (Electron wants a non-empty image). */
function dragFallback(el) {
  const px = Buffer.alloc(16 * 16 * 4);
  for (let i = 0; i < px.length; i += 4) { px[i] = 0x80; px[i + 1] = 0x80; px[i + 2] = 0x80; px[i + 3] = 0xc0; }   // BGRA
  return el.nativeImage.createFromBitmap(px, { width: 16, height: 16 });
}

module.exports = {
  name: 'downloads',
  label: 'Downloads shelf (bar)',
  defaultOn: true,
  chords: [],
  observe: [],
  rest: true,
  install(ctx) { return install(ctx, null); },
  _install: install,          // downloads.test.js: the same install against a fake ctx, sidecar and fs.watch
  SHELF, FETCH, DEBOUNCE_MS, MAX_WAIT_MS,
};
