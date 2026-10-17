'use strict';
/*
 * player.js - MANTLE PLAYER, Mantle's replacement for Windows' Media Player (Microsoft.ZuneMusic)
 * (lane mantle-player, 2026-10-17; Owen: "also we need to replace media player with a custom manlte version").
 *
 * ONE WINDOW, MADE ON DEMAND (RAM rule, 2026-10-15: nothing pre-loaded): the first open builds it, closing it
 * destroys it. Opened from the launcher / Win+S ("Mantle Player", and Windows' "Media Player" row stands in),
 * a bar pin of Media Player, Mantle Files' "Open with", drag and drop onto the window, and a command line:
 *   electron <mantle> --open=player "--play=C:\path\file.mp4"     (the running Mantle plays it; lib/args.js)
 * which is also what Windows runs once Owen picks Mantle Player in Default apps (lib/features/_player-assoc.js).
 *
 * The page (ui/player) never touches the disk: everything is a player.<verb> call here.
 *   boot                      start state: settings, the saved queue, pending opens, options, test flag
 *   open {paths, via, add}    play these (one file also queues the rest of its folder, option folderQueue)
 *   prepare {path}            what the file is (probe), its subtitles (.srt/.vtt next to it), where it was left,
 *                             its tags + cover for music, and its file:// URL
 *   resume {path, t, d}       remember where playback is (per file; flushed every 15 s and on pause/close)
 *   state {...}               volume, mute, speed, shuffle, repeat, view, subtitles on
 *   queue {items, index}      the play queue, saved
 *   playlists / plsave / pldelete
 *   library {q} / rescan      Music + Videos (lib/features/_player-library.js), scanned only while the window is open
 *   thumbs {paths}            video thumbnails (Windows' own, through the sidecar's files.thumbs), cached on disk
 *   window {op}               min | max | close | full | unfull | mini | unmini
 *   reveal {path} / openwith {path}   the ways out for a file that cannot play
 *   defaults {op}             status | use | undo (Settings > Apps > Default apps; dry run in --test)
 *
 * --test: the window is quiet (lib/test-quiet.js), its audio is MUTED at the WebContents (setAudioMuted) and
 * every media element is muted by the page; Windows' media controls never see it (main.js turns Chromium's
 * HardwareMediaKeyHandling off in --test); fullscreen and the mini player's always-on-top are recorded, never
 * applied to a real window; default-app writes and Open with are dry runs; the library reads only the
 * MANTLE_PLAYER_TEST_ROOTS folders, never Owen's.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const P = require('./_player-probe.js');
const T = require('./_player-tags.js');
const { createLibrary } = require('./_player-library.js');
const A = require('./_player-assoc.js');

const TITLE = 'Mantle Player';
const APP_ID = 'Mantle.Player';
const ICON = path.join(__dirname, '..', '..', 'assets', 'icons', 'mantle-player.ico');
const W0 = 980, H0 = 640, MIN_W = 420, MIN_H = 300;
const MINI = { video: [400, 260], audio: [380, 112] };
const HEAD = 512 * 1024, TAIL = 4 * 1024 * 1024, SUB_MAX = 2 * 1024 * 1024;
const RESUME_MAX = 400, RESUME_FLUSH_MS = 15000, STALE_MS = 10 * 60 * 1000;
const FOLDER_MAX = 500;

module.exports = {
  name: 'player',
  label: 'Mantle Player',
  defaultOn: true,
  chords: [],
  rest: false,          // a game starting must never stop a film; the window only exists while it is open
  options: [
    { key: 'folderQueue', label: 'Opening one file queues the rest of its folder', help: 'Next plays the next episode or song in the same folder', type: 'bool', default: true },
    { key: 'resume', label: 'Resume videos where you left off', help: 'Per file; music always starts at the beginning', type: 'bool', default: true },
  ],
  install(ctx) {
    const E = require('electron');
    const { app } = E;
    const test = !!ctx.flags.test;
    const userData = app.getPath('userData');
    const get = (k, d) => { try { const v = ctx.settings.get(k, d); return v === undefined ? d : v; } catch (_) { return d; } };
    const set = (k, v) => { try { ctx.settings.set(k, v); return true; } catch (e) { ctx.log(`${k} was not saved (${e.message})`); return false; } };
    const opt = (k) => { const d = module.exports.options.find((o) => o.key === k); const v = get(k, undefined); return v === undefined || v === null ? d.default : v; };

    function roots() {
      if (test) {
        // never Owen's folders in a test: only what the test names, "music=<dir>;videos=<dir>"
        return String(process.env.MANTLE_PLAYER_TEST_ROOTS || '').split(';').map((s) => { const m = /^(music|videos)=(.+)$/.exec(s.trim()); return m ? { kind: m[1], dir: m[2], label: m[1] === 'music' ? 'Music' : 'Videos' } : null; }).filter(Boolean);
      }
      const out = [];
      try { out.push({ kind: 'music', dir: app.getPath('music'), label: 'Music' }); } catch (_) { /* no Music folder */ }
      try { out.push({ kind: 'videos', dir: app.getPath('videos'), label: 'Videos' }); } catch (_) { /* no Videos folder */ }
      return out;
    }
    const lib = createLibrary({ roots: roots(), cacheFile: path.join(userData, 'player-library.json'), coverDir: path.join(userData, 'player-covers') });
    let libLoaded = null;
    const thumbDir = path.join(userData, 'player-thumbs');

    const S = { win: null, booted: false, pending: [], opens: 0, full: false, mini: false, onTop: false, normal: null, kind: 'video', stopped: false, resume: get('resume', {}) || {}, resumeDirty: false, flushT: null, scanAt: 0 };
    const url = (p) => pathToFileURL(p).href;
    const words = (e) => (e && (e.code || e.message)) || String(e);

    /* ---- the window ------------------------------------------------------------------------- */
    function offscreen(w, h) {
      let minX = 0; try { for (const s of E.screen.getAllDisplays()) minX = Math.min(minX, s.bounds.x); } catch (_) { /* one display */ }
      return { x: minX - w - 400, y: 0, width: w, height: h };
    }
    function place() {
      let b = get('bounds', null);
      const wa = (() => { try { return E.screen.getPrimaryDisplay().workArea; } catch (_) { return { x: 0, y: 0, width: 1920, height: 1040 }; } })();
      if (!b || !(b.width >= MIN_W) || !(b.height >= MIN_H)) b = { width: W0, height: H0, x: Math.round(wa.x + (wa.width - W0) / 2), y: Math.round(wa.y + (wa.height - H0) / 2) };
      return test ? offscreen(b.width, b.height) : b;
    }
    function hwnd(w) { try { const buf = w.getNativeWindowHandle(); return buf.length >= 8 ? Number(buf.readBigUInt64LE(0)) : buf.readUInt32LE(0); } catch (_) { return 0; } }
    const themeNow = () => (ctx.host && ctx.host.theme ? ctx.host.theme.get() : 'light');
    function frame(w) {
      if (!w || w.isDestroyed()) return;
      const h = hwnd(w); if (!h) return;
      Promise.resolve(ctx.sidecar.send('taskmgr.frame', { hwnd: h, light: themeNow() !== 'dark' }, { timeoutMs: 6000 })).then((r) => { if (r && !r.ok) ctx.log(`the window frame was not set (${r.error}); the page keeps its own tint`); }, () => {});
    }
    if (ctx.host && ctx.host.theme && typeof ctx.host.theme.onChange === 'function') ctx.host.theme.onChange(() => { if (S.win) frame(S.win); });

    function create() {
      const b = place();
      const w = new E.BrowserWindow({
        show: false, frame: false, title: TITLE, backgroundMaterial: 'acrylic', backgroundColor: '#00000000',
        icon: fs.existsSync(ICON) ? ICON : undefined, resizable: true, movable: true, minimizable: true, maximizable: true, fullscreenable: !test,
        width: b.width, height: b.height, x: b.x, y: b.y, minWidth: 300, minHeight: 100, skipTaskbar: test,
        webPreferences: { preload: ctx.preload, contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false, enableBlinkFeatures: 'AudioVideoTracks', autoplayPolicy: 'no-user-gesture-required' },
      });
      if (fs.existsSync(ICON) && typeof w.setAppDetails === 'function') { try { w.setAppDetails({ appId: APP_ID, appIconPath: ICON, appIconIndex: 0, relaunchDisplayName: TITLE }); } catch (e) { ctx.log(`the window's app details were not set (${e.message})`); } }
      const wc = w.webContents;
      if (test) wc.setAudioMuted(true);                                         // SILENT in every test, whatever the page does
      w.on('page-title-updated', (e) => e.preventDefault());
      wc.on('will-navigate', (e) => e.preventDefault());                        // a dropped file is ours to play, never a navigation
      wc.setWindowOpenHandler(() => ({ action: 'deny' }));
      wc.on('render-process-gone', (_e, d) => { ctx.health(false, `Mantle Player's page crashed (${d && d.reason}); it opens fresh next time`); try { w.destroy(); } catch (_) { /* gone */ } });
      wc.on('did-fail-load', (_e, code, desc, _u, main) => { if (main !== false) ctx.health(false, `Mantle Player's page did not load (${desc || code})`); });
      wc.on('did-finish-load', () => ctx.health(true));
      let bt = null;
      const later = () => { clearTimeout(bt); bt = setTimeout(() => { try { if (!test && !w.isDestroyed() && !w.isMaximized() && !w.isMinimized() && !w.isFullScreen() && !S.mini) set('bounds', w.getBounds()); } catch (_) { /* only the size is lost */ } }, 700); };
      w.on('resize', later); w.on('move', later);
      const pushWin = () => ctx.push(w, 'player.window', winState());
      w.on('enter-full-screen', () => { S.full = true; pushWin(); });
      w.on('leave-full-screen', () => { S.full = false; pushWin(); });
      w.on('maximize', pushWin); w.on('unmaximize', pushWin);
      w.on('focus', () => ctx.push(w, 'player.focus', { on: true }));
      w.on('blur', () => ctx.push(w, 'player.focus', { on: false }));
      w.on('closed', () => { clearTimeout(bt); if (S.win === w) { S.win = null; S.booted = false; S.full = false; S.mini = false; S.onTop = false; } flushResume(); });
      w.once('ready-to-show', () => frame(w));
      w.loadFile(ctx.page('index.html'));
      S.win = w; S.booted = false;
      return w;
    }
    function winState() { const w = S.win; return { full: S.full, mini: S.mini, onTop: S.onTop, max: !!(w && !w.isDestroyed() && w.isMaximized()), test }; }
    function show(w) {
      if (test) { w.showInactive(); return; }                                  // quiet anyway (lib/test-quiet.js)
      if (w.isMinimized()) w.restore();
      w.show(); w.focus();
    }

    /* ---- opening files ------------------------------------------------------------------------ */
    function realFile(p) {
      if (typeof p !== 'string' || !p || p.length > 1024 || !path.win32.isAbsolute(p) || /[\0]/.test(p)) return null;
      try { const st = fs.statSync(p); return st.isFile() ? path.win32.normalize(p) : null; } catch (_) { return null; }
    }
    function siblings(p) {
      const kind = P.kindOf(p);
      if (kind !== 'video' && kind !== 'audio') return [p];
      let names;
      try { names = fs.readdirSync(path.dirname(p)); } catch (_) { return [p]; }
      const me = path.basename(p).toLowerCase();
      const list = names.filter((n) => P.kindOf(n) === kind && (n.toLowerCase() === me || !P.LIB_SKIP.has(P.extOf(n)))).sort(P.natural).slice(0, FOLDER_MAX);
      const out = list.map((n) => path.join(path.dirname(p), n));
      return out.some((x) => x.toLowerCase() === p.toLowerCase()) ? out : [p];
    }
    function open(a) {
      const o = a && typeof a === 'object' ? a : {};
      const raw = Array.isArray(o.paths) ? o.paths : typeof o.path === 'string' ? [o.path] : [];
      const files = raw.map(realFile).filter(Boolean).slice(0, 5000);
      if (raw.length && !files.length) return { ok: false, reason: raw.length === 1 ? 'that file is not there any more (or it is a folder)' : 'none of those files are there any more' };
      let items = files, index = 0;
      if (files.length === 1 && !o.add && opt('folderQueue')) { items = siblings(files[0]); index = Math.max(0, items.findIndex((x) => x.toLowerCase() === files[0].toLowerCase())); }
      const via = typeof o.via === 'string' && /^[a-z0-9 +'-]{1,32}$/i.test(o.via) ? o.via : 'Mantle';
      const w = S.win && !S.win.isDestroyed() ? S.win : create();
      S.opens++;
      if (items.length) {
        const load = { items, index, add: !!o.add, via, at: Date.now() };
        if (S.booted) ctx.push(w, 'player.load', load); else S.pending.push(load);
      }
      show(w);
      ctx.log(`opened via ${via}: ${items.length} item(s)${test ? ' (test mode: hidden, muted)' : ''}`);
      return { ok: true, count: items.length };
    }

    function decodeSub(buf) {
      if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
      if (buf[0] === 0xfe && buf[1] === 0xff) { const b = Buffer.from(buf.subarray(2)); b.swap16(); return b.toString('utf16le'); }
      const u = buf.toString('utf8');
      return u.includes('\uFFFD') ? buf.toString('latin1') : u;
    }
    function subsFor(p) {
      const dir = path.dirname(p), base = path.basename(p).replace(/\.[^.]+$/, '');
      let names = [];
      try { names = fs.readdirSync(dir); } catch (_) { return { subs: [], reason: 'its folder could not be read for subtitles' }; }
      const subs = [];
      for (const n of names) {
        const l = P.subLabel(base, n); if (!l) continue;
        try {
          const f = path.join(dir, n); const st = fs.statSync(f);
          if (st.size > SUB_MAX) { subs.push({ label: l.label, lang: l.lang, vtt: null, reason: 'the subtitle file is over 2 MB' }); continue; }
          subs.push({ label: l.label, lang: l.lang, vtt: P.srtToVtt(decodeSub(fs.readFileSync(f))), reason: null });
        } catch (e) { subs.push({ label: l.label, lang: l.lang, vtt: null, reason: `it could not be read (${words(e)})` }); }
      }
      return { subs, reason: null };
    }
    const rkey = (p) => crypto.createHash('sha1').update(String(p).toLowerCase()).digest('hex').slice(0, 16);
    async function readParts(p, size) {
      const fh = await fs.promises.open(p, 'r');
      try {
        const n = Math.min(size, HEAD); const head = Buffer.alloc(n); await fh.read(head, 0, n, 0);
        const tn = size > HEAD ? Math.min(size - HEAD, TAIL) : 0; const tail = Buffer.alloc(tn); if (tn) await fh.read(tail, 0, tn, size - tn);
        return { head, tail };
      } finally { await fh.close(); }
    }
    async function prepare(a) {
      const p = realFile(a && a.path);
      if (!p) return { ok: false, reason: 'the file is not there any more' };
      const st = fs.statSync(p);
      let pr = null, tags = null;
      try {
        const { head, tail } = await readParts(p, st.size);
        pr = P.probe(head, tail, st.size);
        if (P.kindOf(p) === 'audio' || (pr.tracks.length && !pr.tracks.some((t) => t.type === 'video'))) {
          const t = T.read(head, tail.subarray(Math.max(0, tail.length - 4096)), P.extOf(p));
          let cover = null;
          if (t.cover) {
            const dir = path.join(userData, 'player-covers');
            const f = path.join(dir, crypto.createHash('sha1').update(t.cover.data).digest('hex').slice(0, 20) + (t.cover.mime === 'image/png' ? '.png' : '.jpg'));
            try { if (!fs.existsSync(f)) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(f, t.cover.data); } cover = url(f); } catch (_) { cover = null; }
          }
          tags = { title: t.title, artist: t.artist, album: t.album, track: t.track, year: t.year, cover };
        }
      } catch (e) { pr = { container: 'unknown', label: 'an unreadable file', tracks: [], note: `it could not be read (${words(e)})` }; }
      const r = S.resume[rkey(p)];
      const resume = opt('resume') && r && r.size === st.size && r.t > 10 ? { t: r.t, d: r.d } : null;
      const sub = P.kindOf(p) === 'audio' ? { subs: [], reason: null } : subsFor(p);
      return { ok: true, path: p, name: path.basename(p), folder: path.basename(path.dirname(p)), kind: P.kindOf(p) || (pr.tracks.some((t) => t.type === 'video') ? 'video' : 'audio'), size: st.size, url: url(p), probe: pr, subs: sub.subs, subsReason: sub.reason, resume, tags };
    }

    function flushResume() {
      clearTimeout(S.flushT); S.flushT = null;
      if (!S.resumeDirty) return;
      const keys = Object.keys(S.resume);
      if (keys.length > RESUME_MAX) keys.sort((x, y) => S.resume[x].at - S.resume[y].at).slice(0, keys.length - RESUME_MAX).forEach((k) => delete S.resume[k]);
      if (set('resume', S.resume)) S.resumeDirty = false;
    }
    function resumeSet(a) {
      const p = realFile(a && a.path); if (!p) return { ok: false, reason: 'the file is not there any more' };
      const t = Number(a.t), d = Number(a.d);
      if (!(t >= 0) || !(d > 0)) return { ok: false, reason: 'no position given' };
      const k = rkey(p);
      // finished (or nearly), or barely started: forget, so it starts at the top next time
      if (t < 10 || t > d - 15 || P.kindOf(p) === 'audio') delete S.resume[k];
      else S.resume[k] = { t: Math.round(t * 10) / 10, d: Math.round(d), size: fs.statSync(p).size, at: Date.now() };
      S.resumeDirty = true;
      if (a.now) flushResume(); else if (!S.flushT) { S.flushT = setTimeout(flushResume, RESUME_FLUSH_MS); if (S.flushT.unref) S.flushT.unref(); }
      return { ok: true };
    }

    /* ---- library ---------------------------------------------------------------------------- */
    function withUrls(v) {
      const c = (x) => (x && x.cover ? Object.assign({}, x, { cover: url(x.cover) }) : x);
      return Object.assign({}, v, { songs: v.songs.map(c), albums: v.albums.map(c), artists: v.artists.map(c), roots: roots().map((r) => r.label) });
    }
    async function library(a) {
      if (!libLoaded) libLoaded = lib.load();
      await libLoaded;
      const force = !!(a && a.rescan);
      if (force || !lib.scanning && Date.now() - S.scanAt > STALE_MS) {
        S.scanAt = Date.now();
        const t0 = Date.now();
        lib.scan({ force: !!(a && a.full) }).then((r) => {
          ctx.log(`library ${force ? 'rescan' : 'scan'}: ${r.ok ? `${r.added} new, ${r.changed} changed, ${r.removed} gone, ${r.kept} unchanged in ${Date.now() - t0} ms` : `failed: ${r.reason}`}`);
          if (S.win && !S.win.isDestroyed()) ctx.push(S.win, 'player.library', { changed: true, last: r });
        });
      }
      return Object.assign({ ok: true }, withUrls(a && a.q ? lib.search(a.q) : lib.view()), { scanning: lib.scanning });
    }
    async function thumbs(a) {
      const want = (Array.isArray(a && a.paths) ? a.paths : []).map(realFile).filter(Boolean).slice(0, 24);
      const out = {}, need = [];
      for (const p of want) {
        let st; try { st = fs.statSync(p); } catch (_) { continue; }
        const f = path.join(thumbDir, rkey(p + '|' + Math.round(st.mtimeMs)) + '.png');
        if (fs.existsSync(f)) out[p] = url(f); else need.push({ p, f });
      }
      if (need.length) {
        const r = await ctx.sidecar.send('files.thumbs', { items: need.map((x) => ({ path: x.p })), px: 320, mode: 'thumb' }, { timeoutMs: 20000 });
        const res = r.ok && r.result && Array.isArray(r.result.results) ? r.result.results : [];
        try { fs.mkdirSync(thumbDir, { recursive: true }); } catch (_) { /* written below or not at all */ }
        need.forEach((x, i) => { const one = res[i]; if (one && one.png && one.kind !== 'icon') { try { fs.writeFileSync(x.f, Buffer.from(one.png, 'base64')); out[x.p] = url(x.f); } catch (_) { out[x.p] = 'data:image/png;base64,' + one.png; } } else out[x.p] = null; });
        if (!r.ok) return { ok: true, thumbs: out, reason: `Windows did not make the thumbnails (${r.error})` };
      }
      return { ok: true, thumbs: out };
    }

    /* ---- window ops ------------------------------------------------------------------------- */
    function mini(on, kind) {
      const w = S.win; if (!w || w.isDestroyed()) return { ok: false, reason: 'Mantle Player is not open' };
      if (on === S.mini) return Object.assign({ ok: true }, winState());
      if (on) {
        if (S.full) { if (!test) w.setFullScreen(false); S.full = false; }
        S.normal = w.getBounds();
        const [mw, mh] = MINI[kind === 'audio' ? 'audio' : 'video'];
        let b;
        if (test) b = offscreen(mw, mh);
        else { const wa = E.screen.getDisplayMatching(S.normal).workArea; b = { x: wa.x + wa.width - mw - 16, y: wa.y + wa.height - mh - 16, width: mw, height: mh }; }
        S.mini = true; w.setBounds(b);
        S.onTop = true; if (!test) w.setAlwaysOnTop(true, 'floating');           // test: recorded, never applied
      } else {
        S.mini = false; S.onTop = false; if (!test) w.setAlwaysOnTop(false);
        if (S.normal) w.setBounds(S.normal);
      }
      return Object.assign({ ok: true, dryRun: test && on ? true : undefined }, winState());
    }
    function windowOp(a) {
      const w = S.win; const op = String((a && a.op) || '');
      if (!w || w.isDestroyed()) return { ok: false, reason: 'Mantle Player is not open' };
      if (op === 'min') { if (!test) w.minimize(); return { ok: true }; }
      if (op === 'max') { if (!test) { if (w.isMaximized()) w.unmaximize(); else w.maximize(); } return Object.assign({ ok: true }, winState()); }
      if (op === 'close') { setImmediate(() => { if (!w.isDestroyed()) w.close(); }); return { ok: true }; }
      if (op === 'full' || op === 'unfull') {
        const on = op === 'full';
        if (on && S.mini) mini(false);
        if (test) { S.full = on; ctx.push(w, 'player.window', winState()); return Object.assign({ ok: true, dryRun: true }, winState()); }   // never a real full-screen window in a test
        w.setFullScreen(on); return Object.assign({ ok: true }, winState(), { full: on });
      }
      if (op === 'mini' || op === 'unmini') { const r = mini(op === 'mini', a.kind); ctx.push(w, 'player.window', winState()); return r; }
      return { ok: false, reason: `Mantle Player has no window action "${op.slice(0, 20)}"` };
    }

    /* ---- the ways out ----------------------------------------------------------------------- */
    async function reveal(a) {
      const p = realFile(a && a.path); if (!p) return { ok: false, reason: 'the file is not there any more' };
      if (test) return { ok: true, dryRun: true, reason: 'Test run: would show it in Mantle Files' };
      if (app.listenerCount('mantle-open:files') > 0) { const reply = {}; app.emit('mantle-open:files', { path: path.dirname(p), via: 'Mantle Player', reply }); if (!reply.handled || reply.ok) return { ok: true }; }
      E.shell.showItemInFolder(p); return { ok: true, reason: 'opened in File Explorer: Mantle Files is off' };
    }
    async function openWith(a) {
      const p = realFile(a && a.path); if (!p) return { ok: false, reason: 'the file is not there any more' };
      if (test) return { ok: true, dryRun: true, reason: "Test run: would show Windows' Open with" };
      const r = await ctx.sidecar.send('files.openwithdialog', { path: p, owner: S.win ? hwnd(S.win) : 0 }, { timeoutMs: 8000 });
      return r.ok ? { ok: true } : { ok: false, reason: `Windows' Open with did not open (${r.error})` };
    }

    /* ---- default apps (Settings) ------------------------------------------------------------ */
    const reg = A.regRunner(require('child_process').execFile);
    const assocOpts = () => ({ exe: process.execPath, appDir: app.getAppPath(), icon: ICON, dryRun: test, reg, record: { get: () => get('assoc', null), set: (v) => set('assoc', v) } });
    async function defaults(a) {
      const op = String((a && a.op) || 'status');
      if (op === 'status') return A.status(assocOpts());
      if (op === 'undo') { const r = await A.undo(assocOpts()); if (r.ok && !r.dryRun && !r.nothing) ctx.log('default apps: Mantle Player taken out of Windows\' list'); return r; }
      if (op === 'use') {
        const r = await A.use(assocOpts());
        if (!r.ok || r.dryRun) return r;
        ctx.log('default apps: Mantle Player is in Windows\' list; opening Default apps for the pick');
        try { await E.shell.openExternal(A.SETTINGS_URI); } catch (e) { return { ok: true, note: `Mantle Player is ready to pick, but Windows' Default apps did not open (${words(e)}): open Settings > Apps > Default apps` }; }
        return { ok: true, note: 'Pick Mantle Player in the Default apps window that just opened' };
      }
      return { ok: false, reason: `no such default-apps step "${op.slice(0, 20)}"` };
    }

    /* ---- commands ----------------------------------------------------------------------------- */
    ctx.command('boot', async () => {
      S.booted = true;
      const pending = S.pending.splice(0);
      return { ok: true, test, state: get('state', {}) || {}, queue: get('queue', null), playlists: (get('playlists', []) || []).map((x) => ({ id: x.id, name: x.name, count: (x.items || []).length })), pending, options: { folderQueue: opt('folderQueue'), resume: opt('resume') }, window: winState(), roots: roots().map((r) => r.label) };
    });
    ctx.command('open', async (a) => open(a));
    ctx.command('prepare', async (a) => prepare(a));
    ctx.command('resume', async (a) => resumeSet(a));
    ctx.command('state', async (a) => {
      const s = Object.assign({}, get('state', {}) || {});
      for (const k of ['volume', 'speed']) if (typeof a[k] === 'number' && isFinite(a[k])) s[k] = Math.max(0, Math.min(k === 'speed' ? 4 : 1, a[k]));
      for (const k of ['muted', 'shuffle', 'subs']) if (typeof a[k] === 'boolean') s[k] = a[k];
      if (a.repeat === 'off' || a.repeat === 'all' || a.repeat === 'one') s.repeat = a.repeat;
      if (typeof a.view === 'string' && /^[a-z]{1,12}$/.test(a.view)) s.view = a.view;
      return set('state', s) ? { ok: true, state: s } : { ok: false, reason: 'the player settings could not be saved' };
    });
    ctx.command('queue', async (a) => {
      const items = (Array.isArray(a && a.items) ? a.items : []).filter((x) => typeof x === 'string' && path.win32.isAbsolute(x)).slice(0, 5000);
      return set('queue', { items, index: Math.max(0, Math.min(items.length - 1, Number(a.index) || 0)) }) ? { ok: true } : { ok: false, reason: 'the queue could not be saved' };
    });
    ctx.command('playlists', async () => ({ ok: true, playlists: (get('playlists', []) || []).map((x) => ({ id: x.id, name: x.name, count: (x.items || []).length, at: x.at })) }));
    ctx.command('playlist', async (a) => { const pl = (get('playlists', []) || []).find((x) => x.id === (a && a.id)); return pl ? { ok: true, playlist: pl } : { ok: false, reason: 'that playlist is gone' }; });
    ctx.command('plsave', async (a) => {
      const name = String((a && a.name) || '').trim().slice(0, 80);
      if (!name) return { ok: false, reason: 'give the playlist a name' };
      const items = (Array.isArray(a.items) ? a.items : []).filter((x) => typeof x === 'string' && path.win32.isAbsolute(x)).slice(0, 5000);
      const all = (get('playlists', []) || []).slice();
      const i = a.id ? all.findIndex((x) => x.id === a.id) : -1;
      const pl = { id: i >= 0 ? all[i].id : crypto.randomBytes(6).toString('hex'), name, items, at: Date.now() };
      if (i >= 0) all[i] = pl; else all.push(pl);
      return set('playlists', all.slice(-200)) ? { ok: true, playlist: { id: pl.id, name: pl.name, count: items.length } } : { ok: false, reason: 'the playlist could not be saved' };
    });
    ctx.command('pldelete', async (a) => {
      const all = get('playlists', []) || []; const gone = all.find((x) => x.id === (a && a.id));
      if (!gone) return { ok: false, reason: 'that playlist is already gone' };
      return set('playlists', all.filter((x) => x !== gone)) ? { ok: true, undo: gone } : { ok: false, reason: 'the playlist could not be removed' };
    });
    ctx.command('plrestore', async (a) => {
      const pl = a && a.playlist; if (!pl || typeof pl.id !== 'string' || typeof pl.name !== 'string' || !Array.isArray(pl.items)) return { ok: false, reason: 'nothing to put back' };
      const all = (get('playlists', []) || []).filter((x) => x.id !== pl.id); all.push({ id: pl.id, name: pl.name.slice(0, 80), items: pl.items.filter((x) => typeof x === 'string').slice(0, 5000), at: Date.now() });
      return set('playlists', all) ? { ok: true } : { ok: false, reason: 'the playlist could not be put back' };
    });
    ctx.command('library', async (a) => library(a || {}));
    ctx.command('rescan', async (a) => library({ rescan: true, full: !!(a && a.full) }));
    ctx.command('thumbs', async (a) => thumbs(a));
    ctx.command('window', async (a) => windowOp(a || {}));
    ctx.command('reveal', async (a) => reveal(a));
    ctx.command('openwith', async (a) => openWith(a));
    ctx.command('defaults', async (a) => defaults(a));
    if (test) {
      ctx.command('teststate', async () => {
        const w = S.win && !S.win.isDestroyed() ? S.win : null;
        return { ok: true, hasWindow: !!w, booted: S.booted, opens: S.opens, pending: S.pending.length, full: S.full, mini: S.mini, onTop: S.onTop, nativeOnTop: w ? w.isAlwaysOnTop() : null, nativeFull: w ? w.isFullScreen() : null,
          bounds: w ? w.getBounds() : null, audioMuted: w ? w.webContents.isAudioMuted() : null, audible: w ? w.webContents.isCurrentlyAudible() : null, resumeKeys: Object.keys(S.resume).length, libraryRoots: roots().length };
      });
      ctx.command('testclose', async () => { if (S.win && !S.win.isDestroyed()) S.win.destroy(); return { ok: true }; });
    }

    /* ---- who can open it: the launcher, the bar's pin, Files, the command line (main.js) ----- */
    const onOwn = (p) => {
      const o = p && typeof p === 'object' ? p : {};
      let r;
      try { r = open({ paths: Array.isArray(o.paths) ? o.paths : typeof o.path === 'string' ? [o.path] : [], add: !!o.add, via: o.via || 'the bar' }); } catch (e) { r = { ok: false, reason: e.message }; }
      if (o.reply && typeof o.reply === 'object') { o.reply.handled = true; o.reply.ok = !!r.ok; o.reply.reason = r.ok ? null : r.reason; o.reply.count = r.count; }
    };
    const listen = (on) => { app.removeListener('mantle-open:player', onOwn); if (on) app.on('mantle-open:player', onOwn); };
    listen(ctx.enabled());
    ctx.onEnabled((on) => { listen(on); if (!on && S.win && !S.win.isDestroyed()) S.win.close(); });
    ctx.health(true);
    return {
      stop() {
        S.stopped = true; listen(false); flushResume();
        if (S.win && !S.win.isDestroyed()) S.win.destroy();
        S.win = null;
      },
    };
  },
};
