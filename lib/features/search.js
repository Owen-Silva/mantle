/* lib/features/search.js — Win+S: Mantle's launcher, opened in search mode, searching everything.
 *
 * The user, 2026-09-24: replace Windows Search. Win+S opens the launcher with {mode:'search'} (the
 * page shows the search placeholder); the launcher's box - also when he just taps Win and types -
 * searches apps, commands, ~100 Settings pages, arithmetic, files in the Windows Search index,
 * and ends with "Search the web for …". The page side is ui/launcher/* (calc.js, groups.js).
 *
 * OFF (the tray checkbox) = Win+S goes back to Windows. The launcher keeps its search either way:
 * it is Mantle's own window, and these commands only do what its rows already ask for.
 *
 * What it adds to the launcher that main.js did not already give it (the page is ui/launcher/*):
 *   search.files     file rows through sidecar/SearchIndex.cs (`search.files`: prefix > word >
 *                    contains, newest first, hidden/system files dropped), ranked here, files you
 *                    OPENED recently first; same shape as main's launcher.files (+ `recent`)
 *   search.openFile  open / show-in-folder for a file row, a DRY RUN in --test
 *   search.copy      the calculator row's Enter: copy the answer (worked out again here), DRY RUN in --test
 *   search.web       "Search the web for …", DRY RUN in --test
 *   search.status    the Windows Search service / index report (sidecar `search.status`)
 * and the Win+S chord, which opens the launcher with {mode:'search'}.
 *
 * CHECKED, NOT TRUSTED (2026-09-29 quality pass). Every argument comes from a page. openFile opens
 * only a path that one of THIS feature's own file answers offered in the last half hour - so a page
 * cannot ask it to run an arbitrary program in the profile - and only a plain drive path inside the
 * profile that is still on disk. web and copy take text of a bounded length; the URL is built from
 * the text and the copied number is worked out again (lib/launcher-index.js), never taken as given.
 *
 * PLAIN WORDS. A failure reaches the page as a sentence a person can act on; anything that reads
 * like an internal (the sidecar, OLE DB, HRESULTs, exception names) is replaced by one. mantle.log
 * gets the failure's KIND only: never a query, a file name or a path.
 *
 * RECENT FILES (new, 2026-09-29). Spotlight and Windows' own search rank what you opened lately
 * first; Mantle ranked by name and modified date only. Windows keeps a shortcut per recently opened
 * file in %APPDATA%\Microsoft\Windows\Recent, named after the file: a row whose name has a shortcut
 * there, and whose shortcut really points at that row's path (Electron's readShortcutLink; outside
 * Electron nothing is boosted), gets a nudge within its tier and `recent: true`. The folder listing
 * is read lazily on a query and kept 60 s: nothing polls at rest.
 *
 * HEALTH. Win+S is only taken from Windows while this is healthy. A stopped WSearch service or an
 * unindexed profile does NOT make it unhealthy: apps, Settings, the calculator and the web row all
 * still work, and the Files group says why it has nothing. Unhealthy = the launcher itself cannot
 * be opened, which is the one thing Win+S is for.
 */
'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const index = require('../launcher-index.js');

const FILE_LIMIT = 8;              // rows the page shows
const FILE_FETCH = 24;             // rows asked of the index, so ranking here has room to work
const FILE_MIN_CHARS = 2;          // one letter matches half the disk: MEASURED 1.3 s for "a"
const QUERY_MAX = 200;             // the sidecar's own limit
const WEB_MAX = 500;
const EXPR_MAX = 200;
const OFFER_TTL_MS = 30 * 60 * 1000;
const OFFER_CAP = 400;
const RECENT_TTL_MS = 60 * 1000;
const RECENT_BOOST = 60;           // lifts a recently opened row over its tier's others, not over a better tier's best
const PERSONAL = /^(desktop|documents|downloads|onedrive[^\\]*|pictures|videos|music)(\\|$)/i;
const JARGON = /sidecar|ole ?db|hresult|0x[0-9a-f]{6,}|exception|collatordso|\bprovider\b|\bundefined\b|\bnull\b|\bNaN\b|\[object|\bstack\b|\bE[A-Z]{3,}\b|\.cs\b|\bipc\b|\bdry ?run\b/i;

const WORDS = {
  generic: 'File search isn\'t working right now. Try again in a moment.',
  slow: 'Windows Search took too long to answer. Try again.',
  starting: 'File search is starting up. Try again in a moment.',
  old: 'File search needs Mantle to be restarted after its last update.',
  long: 'That\'s too long to be a file name.',
  notText: 'Type the name of a file to search for it.',
  notOffered: 'Mantle only opens files from its own search results. Search for the file again.',
  badPath: 'That isn\'t a file Mantle can open.',
  outside: 'Mantle only opens files inside your user folder.',
  gone: 'That file isn\'t there any more. It may have been moved or deleted.',
  noOpen: 'Windows couldn\'t open this file.',
  noReveal: 'Windows couldn\'t show this file in its folder.',
  webLong: 'That\'s too long to search the web for (over ' + WEB_MAX + ' characters).',
  webNothing: 'There\'s nothing typed to search the web for.',
  webFail: 'Your browser didn\'t open. Try again.',
  webDefault: 'Opened in your default browser.',
  copyFail: 'Mantle couldn\'t copy the answer.',
  statusFail: 'Mantle couldn\'t check Windows Search right now.',
};

/* A failure reason for the page: kept when it is already plain words, replaced when it is not. */
function plain(reason, fallback) {
  const s = String(reason == null ? '' : reason).trim();
  return !s || JARGON.test(s) ? fallback : s;
}

/* The sidecar call failed (not "the index said no"): what the person sees, and a kind for the log. */
function explainCallError(msg) {
  const m = String(msg || '');
  if (/^cancelled$/i.test(m)) return { superseded: true };
  if (/unknown command|no command called/i.test(m)) return { reason: WORDS.old, kind: 'old-sidecar' };
  if (/^expired\b/i.test(m)) return { reason: WORDS.slow, kind: 'expired' };
  if (/time[sd]? ?out/i.test(m)) return { reason: WORDS.slow, kind: 'timeout' };
  if (/not running|restart|starting|exited|gone/i.test(m)) return { reason: WORDS.starting, kind: 'sidecar-down' };
  return { reason: WORDS.generic, kind: 'call-failed' };
}

function stableId(kind, key) {        // the same ids lib/launcher-index.js gives file rows
  return kind + ':' + crypto.createHash('sha1').update(String(key).toLowerCase()).digest('hex').slice(0, 12);
}

function tildePath(folder, home) {
  if (folder && folder.toLowerCase().startsWith(home.toLowerCase())) return '~' + folder.slice(home.length);
  return folder || '';
}

/* exact name > name starts with q > a word in the name starts with q > name contains q > the
   index's own rule (a CONTAINS word match across terms). Shorter names first inside a tier. */
function fileScore(name, q) {
  const lower = String(name || '').toLowerCase();
  const stem = lower.replace(/\.[^.\\]{1,8}$/, '');
  const extra = Math.min(80, Math.max(0, stem.length - q.length));
  if (lower === q || stem === q) return 1000;
  if (lower.startsWith(q)) return 900 - extra;
  const words = lower.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const terms = q.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (words.some(w => w.startsWith(q))) return 800 - extra;
  if (lower.includes(q)) return 700 - extra;
  if (terms.length > 1 && terms.every(t => words.some(w => w.startsWith(t)))) return 650 - extra;
  return 600 - extra;
}

/* Windows' Recent folder: name (lower, no .lnk) -> the .lnk's full path. Read on demand, 60 s. */
function makeRecent({ dir, readLink, now = Date.now } = {}) {
  let cache = null, at = 0;
  function names() {
    if (!dir) return null;
    if (cache && now() - at < RECENT_TTL_MS) return cache;
    const m = new Map();
    try {
      for (const f of fs.readdirSync(dir)) {
        if (/\.lnk$/i.test(f)) m.set(f.slice(0, -4).toLowerCase(), path.join(dir, f));
      }
    } catch (_) { /* no Recent folder (or not readable): nothing is boosted */ }
    cache = m; at = now();
    return m;
  }
  /* true when a shortcut in Recent is named like this row AND points at this row's path */
  return function isRecent(row) {
    if (typeof readLink !== 'function') return false;
    const m = names();
    if (!m || !m.size) return false;
    const lnk = m.get(String(row.name || '').toLowerCase());
    if (!lnk) return false;
    try {
      const target = readLink(lnk);
      return !!target && path.normalize(String(target)).toLowerCase() === path.normalize(String(row.path)).toLowerCase();
    } catch (_) { return false; }
  };
}

/* Everything the commands need, injectable for search.test.js. */
function makeCommands({ sidecar, dryRun, clipboard, home, log, recent, now = Date.now, exists = fs.existsSync, openFileImpl = index.openFile, openWebImpl = index.openWeb, copyImpl = index.copyCalc }) {
  const offered = new Map();         // lower-cased path -> when a files answer offered it
  const say = typeof log === 'function' ? log : () => {};
  const homeLower = home.toLowerCase();

  function offer(p) {
    offered.delete(p.toLowerCase());
    offered.set(p.toLowerCase(), now());
    while (offered.size > OFFER_CAP) offered.delete(offered.keys().next().value);
  }
  function wasOffered(p) {
    const t = offered.get(p.toLowerCase());
    return t != null && now() - t < OFFER_TTL_MS;
  }

  async function files(a) {
    const raw = a && a.q;
    if (raw != null && typeof raw !== 'string') return { ok: false, q: '', items: [], reason: WORDS.notText };
    const q = String(raw || '').trim();
    if (q.length < FILE_MIN_CHARS) return { ok: true, q, items: [], reason: '' };
    if (q.length > QUERY_MAX) return { ok: true, q, items: [], reason: WORDS.long };
    let res;
    try {
      res = await sidecar('search.files', { q, max: FILE_FETCH, scope: home, ttl: 5000 }, 6000);
    } catch (err) {
      const e = explainCallError((err && err.message) || err);
      if (e.superseded) return { ok: true, q, superseded: true, items: [] };
      say('file search failed: ' + e.kind);
      return { ok: false, q, items: [], reason: e.reason };
    }
    if (!res || res.ok !== true) {
      say('file search: the index could not answer (' + String((res && res.detail) || 'no detail').replace(/[^\w.-]/g, '') + ')');
      return { ok: false, q, items: [], reason: plain(res && res.reason, WORDS.generic) };
    }

    const lower = q.toLowerCase();
    const scored = (Array.isArray(res.items) ? res.items : []).filter(f => f && typeof f.path === 'string' && f.path).map((f, i) => {
      const folder = String(f.folder || '');
      const rel = folder.toLowerCase().startsWith(homeLower + '\\') ? folder.slice(home.length + 1) : '';
      const name = String(f.name || path.basename(f.path));
      const isRecent = !!(recent && recent({ name, path: f.path }));
      return { f, i, name, isRecent, s: fileScore(name, lower) + (isRecent ? RECENT_BOOST : 0), personal: PERSONAL.test(rel) || rel === '' ? 1 : 0 };
    });
    scored.sort((x, y) => y.s - x.s || y.personal - x.personal || x.i - y.i);
    const items = scored.slice(0, FILE_LIMIT).map(({ f, s, name, isRecent }) => {
      offer(String(f.path));
      return {
        id: stableId('file', f.path),
        kind: 'file',
        name,
        subtitle: tildePath(String(f.folder || ''), home),
        path: String(f.path),
        icon: null,
        glyph: f.isDir ? 'folder' : 'file',
        isDir: !!f.isDir,
        modified: f.modified || null,
        recent: isRecent,
        score: s,
      };
    });
    return { ok: true, q, items, ms: res.ms, reason: plain(res.reason, '') };
  }

  async function openFile(a) {
    const p = a && a.path;
    const reveal = !!(a && a.reveal);
    if (typeof p !== 'string' || !p || p.length > 32767 || p.indexOf('\0') >= 0) return { ok: false, reason: WORDS.badPath };
    // a plain drive path only: no share (\\server), no device path (\\?\ \\.\), nothing relative
    if (!/^[A-Za-z]:[\\/]/.test(p)) return { ok: false, reason: WORDS.badPath };
    const norm = path.win32.normalize(p);
    if (!norm.toLowerCase().startsWith(homeLower + '\\')) return { ok: false, reason: WORDS.outside };
    if (!wasOffered(norm)) return { ok: false, reason: WORDS.notOffered };
    if (!exists(norm)) return { ok: false, reason: WORDS.gone };
    let res;
    try { res = await openFileImpl({ path: norm, reveal }, { dryRun }); } catch (err) { res = { ok: false }; }
    if (res && res.ok) return res;
    say('open file failed (' + (reveal ? 'show in folder' : 'open') + ')');
    return { ok: false, reason: /gone from disk/i.test(String(res && res.reason)) ? WORDS.gone : (reveal ? WORDS.noReveal : WORDS.noOpen) };
  }

  async function web(a) {
    const raw = a && a.q;
    if (raw != null && typeof raw !== 'string') return { ok: false, reason: WORDS.webNothing };
    const q = String(raw || '').trim();
    if (!q) return { ok: false, reason: WORDS.webNothing };
    if (q.length > WEB_MAX) return { ok: false, reason: WORDS.webLong };
    let res;
    try { res = await openWebImpl({ q }, { dryRun }); } catch (err) { res = { ok: false }; }
    if (res && res.ok) {
      // live, opened by Windows' default browser because the user's is not installed: say where, not the path
      if (!res.dryRun && /default browser/i.test(String(res.reason || ''))) return Object.assign({}, res, { reason: WORDS.webDefault });
      if (!res.dryRun && res.reason) return Object.assign({}, res, { reason: plain(res.reason, '') || undefined });
      return res;
    }
    say('web search did not open');
    return { ok: false, reason: WORDS.webFail };
  }

  async function copy(a) {
    const raw = a && a.expr;
    if (typeof raw !== 'string' || !raw.trim()) return { ok: false, reason: 'There\'s no calculation to copy.' };
    if (raw.length > EXPR_MAX) return { ok: false, reason: 'That calculation is too long to copy.' };
    let res;
    try { res = copyImpl({ expr: raw }, { dryRun, clipboard }); } catch (err) { res = { ok: false }; }
    if (res && res.ok) return res;
    return { ok: false, reason: plain(res && res.reason, WORDS.copyFail) };
  }

  return { files, openFile, web, copy, _offered: offered };
}

module.exports = {
  name: 'search',
  label: 'Search (Win+S)',
  defaultOn: true,
  rest: true,                         // Win+S opens the launcher, which closes while a game runs: back to Windows then
  chords: ['Win+S'],
  observe: [],
  install(ctx) {
    const dryRun = !!ctx.flags.test;          // a test instance never opens, launches or copies
    let electron = null;
    try { electron = require('electron'); } catch (_) { /* outside Electron: copy says so, nothing is boosted */ }
    const clipboard = electron && electron.clipboard ? electron.clipboard : null;
    const shell = electron && electron.shell ? electron.shell : null;

    // (cmd, args, ms) -> result, throwing the sidecar's own words (explainCallError turns them into plain ones)
    const sidecar = (cmd, args, ms) => ctx.sidecar.send(cmd, args, { timeoutMs: ms }).then((r) => {
      if (!r.ok) throw new Error(r.error || 'no reason');
      return r.result;
    });
    const recentDir = process.env.APPDATA ? path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Recent') : null;
    const recent = makeRecent({
      dir: recentDir,
      readLink: shell && typeof shell.readShortcutLink === 'function' ? (p) => shell.readShortcutLink(p).target : null,
    });
    const cmds = makeCommands({ sidecar, dryRun, clipboard, home: os.homedir(), log: (t) => ctx.log(t), recent });

    ctx.command('files', cmds.files);
    ctx.command('openFile', cmds.openFile);
    ctx.command('copy', cmds.copy);
    ctx.command('web', cmds.web);
    ctx.command('status', async (a) => {
      let r;
      try { r = await ctx.sidecar.send('search.status', { fresh: !!(a && a.fresh) }, { timeoutMs: 4000 }); } catch (_) { r = { ok: false }; }
      if (r && r.ok && r.result) return Object.assign({}, r.result, { reason: plain(r.result.reason, r.result.reason ? WORDS.statusFail : null) });
      return { ok: false, reason: WORDS.statusFail };
    });

    ctx.onChord('Win+S', () => {
      try {
        ctx.host.openLauncher({ mode: 'search' });
      } catch (err) {
        ctx.health(false, 'Win+S cannot open the launcher: ' + ((err && err.message) || err));
        return;
      }
      // TEST ONLY, and only when asked for: drive the opened launcher page through a scripted
      // search (dry runs only) and log counts and timings. Never loaded in a live run.
      if (ctx.test && process.env.MANTLE_SEARCH_SELFTEST === '1') {
        require('./_search-selftest.js').run(ctx).catch((err) => ctx.log('selftest crashed: ' + ((err && err.stack) || err)));
      }
    });

    // The index's state, once per sidecar start, into mantle.log: states only, never the reason
    // text (it is for the screen) and never a path.
    ctx.sidecar.onReady(async () => {
      let r;
      try { r = await ctx.sidecar.send('search.status', {}, { timeoutMs: 4000 }); } catch (_) { r = { ok: false }; }
      if (!r || !r.ok) { ctx.log('Windows Search status unavailable'); return; }
      const s = r.result || {};
      ctx.log('Windows Search: service ' + String(s.service).replace(/[^\w ()-]/g, '') + ', profile indexed ' + s.scopeIndexed);
    });
    ctx.health(true, 'Win+S opens the launcher in search mode');

    return { stop() { /* nothing in Windows was changed: the chord goes back via the seam; nothing polls */ } };
  },
  _internals: { makeCommands, makeRecent, fileScore, plain, explainCallError, WORDS, JARGON },
};
