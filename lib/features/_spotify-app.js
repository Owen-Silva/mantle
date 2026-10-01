'use strict';
/* _spotify-app.js - the Spotify DESKTOP APP as the "Up next" source (spotapp lane, 2026-09-25).
 *
 * Why: the Web API needs Spotify Premium (developer.spotify.com says "Upgrade to Spotify Premium to
 * access the Web API"), and Owen has none. The desktop app edits its own queue for free users, so
 * this drives THE APP: Spotify is started with Chromium's --remote-debugging-port, and Mantle speaks
 * the Chrome DevTools Protocol to its page (the Spicetify approach, without patching any file).
 * Owen accepted the costs knowingly: Spotify must be started by Mantle, any local program could use
 * the port while it is open, it is against Spotify's terms, and a Spotify update can break it.
 *
 * HOW IT FINDS THE QUEUE (read from Spotify 1.3.0.277's own bundle, 2026-09-25):
 *   - the page is https://xpui.app.spotify.com/..., listed by GET 127.0.0.1:<port>/json/list;
 *   - the app's Platform object is a React context value (the bundle's usePlatform() hook reads it),
 *     so PAGE() walks the React fiber tree from the page's root for an object with getRegistry();
 *   - PlayerAPI = platform.getRegistry().resolve(Symbol.for("PlayerAPI")) (the bundle registers its
 *     APIs under Symbol.for("<Name>API")); its queue methods, as the app's own queue panel calls
 *     them: getQueue() -> {current, queued, nextUp}; addToQueue([{uri,uid}]);
 *     removeFromQueue([{uri,uid}]); reorderQueue([{uri,uid}], {before|after:{uri,uid}}); skipTo;
 *     skipToNext;
 *   - search = platform.getGraphQLLoader() with the app's own persisted "searchTracks" query (its
 *     hash read from the loaded bundle when the search page's module is loaded, else the hash baked
 *     below from 1.3.0.277).
 *
 * SAFETY: PAGE() is a FIXED function; each call sends PAGE's source plus JSON.stringify(op, args),
 * and every value in args is validated here first (URIs and UIDs by regex, search text by length and
 * character class). Nothing reads, logs or returns Spotify's tokens or cookies: the only data coming
 * back is queue rows (uri, uid, title, artists, artwork URL) and search rows. The debugging port is
 * bound by Chromium to 127.0.0.1, and Mantle passes NO --remote-allow-origins, so a web page (which
 * always sends an Origin header) can never open the socket; only a local program can.
 *
 * Nothing here runs on its own, with ONE exception: while the Spotify Mantle started runs hidden, a
 * memory watch (./_spotify-trim.js, sptrim lane) reads its RAM every 30 s through the sidecar and
 * trims it when it goes over the line. No poll of the page, no port opened by Mantle. The card asks
 * while its list is open; a start or restart waits (bounded) for the port to come up. On feature start
 * (and when Spotify comes up on the port) takeOver() READS the process list once, to take over the
 * hidden Spotify an earlier Mantle started (spadopt lane, see pickMantleSpotify).
 */
const http = require('http');
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const { createTrimWatch } = require('./_spotify-trim.js');
const { createRevive, fileTimeMs: ftMs, CLOSE_TOGGLE } = require('./_spotify-revive.js');
const GP = require('./_gamemode-plan.js');

const PORT = 47292;                 // Mantle's 4729x block; NOT 9222 (Chrome/Edge/Playwright/Spicetify) or 9229 (Node)
const HOST = '127.0.0.1';
const FLAG = `--remote-debugging-port=${PORT}`;
/* The Win32 Spotify the card starts, and the one lib/spotify-launch.js starts from a pin or launcher row. */
function defaultExe() { return path.join(process.env.APPDATA || '', 'Spotify', 'Spotify.exe'); }
const URI_RE = /^spotify:(track|episode):[A-Za-z0-9]{22}$/;                       // what may be ADDED
const ROW_URI_RE = /^spotify:(track|episode|local):[A-Za-z0-9%+._:~!*'()-]{1,300}$/;  // what may be played / removed / moved
const UID_RE = /^[A-Za-z0-9:_-]{1,80}$/;
const QUEUED_MAX = 50;
const NEXTUP_MAX = 20;
const SEARCH_LIMIT = 8;
const MAX_SKIP = 20;
const ART_MAX_BYTES = 256 * 1024;
const ART_CACHE_MAX = 300;
// Spotify 1.3.0.277's "searchTracks" persisted query (xpui-routes-search.js). Used only when the app
// has not loaded its search page's module this session; a newer hash in the live bundle wins.
const SEARCH_HASH_1_3_0_277 = '59ee4a659c32e9ad894a71308207594a65ba67bb6b632b183abe97303a51fa55';
// ...and its "searchDesktop" (songs, artists, albums and playlists in one answer), same file, same rule.
const SEARCH_ALL_HASH_1_3_0_277 = 'db61238974d27839a136c9dc02bfdbe3fab7635f21cf85976ebff9a1ee281345';

/* spothide lane (2026-09-26): what may be PLAYED as a context (a tap on a library or search row), and
   Spotify's own Liked Songs address (its bundle's "spotify:collection:tracks"). */
const CTX_URI_RE = /^spotify:(track|episode|album|artist|playlist|show):[A-Za-z0-9]{22}$/;
const LIKED_URI = 'spotify:collection:tracks';
const LIBRARY_MAX = 60;
const SEARCH_ALL_LIMIT = 5;
/* How Mantle starts Spotify HIDDEN. --minimized is Spotify's own autostart flag: the window starts
   minimized (never flashes up or takes focus) and is then hidden by Spotify's own window-state
   service once its page is up. --disable-gpu is Chromium's: Spotify's GPU process stays small
   (measured in the spothide lane; audio never touches the GPU, and an opened window still draws). */
const HIDDEN_ARGS = ['--minimized', '--disable-gpu'];

/* Mantle's other ways of starting Spotify (lib/spotify-launch.js: a pin, a launcher row) announce
   the pid here, and the feature's bridge hides that Spotify the same way the card's Start does. On
   `process` under a Symbol.for key, so a re-required module still meets the same bus. */
const BUS_KEY = Symbol.for('mantle.spotify-launch-bus');
function launchBus() {
  if (!process[BUS_KEY]) Object.defineProperty(process, BUS_KEY, { value: new (require('events').EventEmitter)(), configurable: true });
  return process[BUS_KEY];
}

function delay(ms) { return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve(); }
function clip(s, n) { s = s == null ? '' : String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
/* secreview-sp lane (2026-09-27): what the page answers is bounded HERE too. PAGE() cuts its strings,
   but a page that is not running PAGE() honestly (a Spotify gone wrong) answers whatever it likes. */
function str(v, n) { return typeof v === 'string' ? clip(v, n) : ''; }
function num(v) { return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0; }
function capList(v, n) { return (Array.isArray(v) ? v : []).slice(0, n); }
/* The log says which KIND of thing was played, never which one: a local file's address carries its
   artist, album and title, and the rest is what Owen listens to. */
function kindWords(uri) {
  const k = /^spotify:([a-z]+):/.exec(String(uri || ''));
  return (k && { track: 'a song', episode: 'an episode', local: 'a local file', album: 'an album', artist: 'an artist',
    playlist: 'a playlist', show: 'a show', collection: 'Liked Songs' }[k[1]]) || 'an item';
}
/* media-be lane (2026-09-29): what goes to the LOG from an error or from Spotify's page is scrubbed:
   no Spotify address (a local file's carries its tags; the rest is what Owen listens to) and no
   Windows path (it carries his user name). */
function scrub(s, n) {
  return clip(String(s == null ? '' : s)
    .replace(/spotify:([a-z]+):[^\s"'`),;\]]+/gi, 'spotify:$1:…')
    .replace(/(?:[A-Za-z]:|\\\\[^\\\s]+)\\[^\s"'`)\]]*/g, '<path>'), n || 240);
}
/* ...and what goes to the CARD never names Spotify's internals, codes or process ids: the words below
   are the only ones a failed page op or a lost connection shows (the detail goes to the log). */
const WORDS = {
  connect: 'Mantle couldn’t connect to Spotify. Try again, or restart Spotify from here',
  closed: 'Spotify closed the connection. Try again in a moment',
  slow: (s) => `Spotify didn’t answer within ${Math.max(1, s)} s. Try again; if it keeps happening, restart Spotify from here`,
  loading: 'Spotify is still loading. Up next works once it has loaded',
  busy: 'Another program is using the connection Mantle uses for Spotify, so Up next can’t reach it. Close that program, then restart Spotify from here',
  unsure: 'Mantle couldn’t check whether Spotify is running. Try again in a moment',
  noinstall: 'Spotify isn’t installed where Mantle starts it from (Spotify.exe in your AppData folder). Mantle needs the Spotify from spotify.com: the Microsoft Store Spotify can’t be started by Mantle',
  internals: (ver) => `This version of Spotify${ver ? ` (${ver})` : ''} works differently from what Mantle knows, so Up next can’t reach it. A Spotify update probably changed it`,
};
/* How the window was hidden or opened (the card's tooltip says "Hidden by <how>"). */
const HOW = { asked: 'Spotify itself, when Mantle asked', late: 'Spotify itself (its answer came late)', card: 'Spotify itself, from the card' };

/* ====================================================================== the page side
   Runs INSIDE Spotify's page (Runtime.evaluate). Never called in Node; its source is sent. It must
   stay self-contained: no closures over this module. */
/* eslint-disable */
async function PAGE(op, arg) {
  const KEY = Symbol.for('mantle.spotify-queue');
  const g = globalThis;
  const cut = (s, n) => (s == null ? '' : String(s)).slice(0, n || 200);
  const isPlayer = (v) => !!v && typeof v === 'object' && typeof v.getQueue === 'function' && typeof v.addToQueue === 'function';
  const isPlatform = (v) => !!v && typeof v === 'object' && (typeof v.getRegistry === 'function' || typeof v.getPlayerAPI === 'function');
  function playerOf(p) {
    try {
      if (typeof p.getRegistry === 'function') {
        const r = p.getRegistry();
        const pl = r && typeof r.resolve === 'function' ? r.resolve(Symbol.for('PlayerAPI')) : null;
        if (isPlayer(pl)) return pl;
      }
    } catch (e) { /* next way */ }
    try { if (typeof p.getPlayerAPI === 'function') { const pl = p.getPlayerAPI(); if (isPlayer(pl)) return pl; } } catch (e) { /* none */ }
    return null;
  }
  function rootFiber() {
    const els = [document.getElementById('main'), document.getElementById('root')].concat(Array.from((document.body && document.body.children) || []));
    for (const el of els) {
      if (!el) continue;
      for (const k of Object.keys(el)) if (k.indexOf('__reactContainer$') === 0) return el[k];
    }
    const any = document.querySelectorAll('body div');
    for (let i = 0; i < any.length && i < 400; i++) {
      const k = Object.keys(any[i]).find((x) => x.indexOf('__reactFiber$') === 0);
      if (k) { let f = any[i][k], n = 0; while (f && f.return && n++ < 10000) f = f.return; return f; }
    }
    return null;
  }
  function find() {
    const c = g[KEY];
    if (c && isPlayer(c.player)) return c;
    let found = null;
    const sp = g.Spicetify && g.Spicetify.Platform;
    if (sp && isPlayer(sp.PlayerAPI)) found = { player: sp.PlayerAPI, platform: g.Spicetify._platform || null, via: 'Spicetify.Platform' };
    if (!found) {
      const root = rootFiber();
      if (!root) return { missing: 'Spotify’s page has no React root yet (still loading?)', loading: true };
      const stack = [root];
      let seen = 0, platform = null, player = null;
      while (stack.length && seen < 80000 && !platform) {
        const f = stack.pop(); seen++;
        const props = f && f.memoizedProps;
        if (props && typeof props === 'object') {
          for (const k in props) {
            let v; try { v = props[k]; } catch (e) { continue; }
            if (!v || typeof v !== 'object') continue;
            if (!platform && isPlatform(v)) platform = v;
            if (!player && isPlayer(v)) player = v;
          }
        }
        if (f && f.sibling) stack.push(f.sibling);
        if (f && f.child) stack.push(f.child);
      }
      const pl = (platform && playerOf(platform)) || player;
      // spotdeath lane: a root with next to no nodes is a page still loading (seen 2026-09-27: 1 node for
      // minutes after a start), not a Spotify whose internals moved (that walks thousands of nodes).
      if (!pl) return { missing: (platform ? 'the Platform object was found but it gave no PlayerAPI' : 'no Platform object in ' + seen + ' React nodes'), loading: !platform && seen < 4 };
      found = { player: pl, platform: platform, via: platform ? 'React context -> Registry(PlayerAPI)' : 'React props (PlayerAPI)' };
    }
    try { Object.defineProperty(g, KEY, { value: found, configurable: true, writable: true, enumerable: false }); } catch (e) { /* uncached */ }
    return found;
  }
  function art(it, md) {
    const imgs = Array.isArray(it && it.images) ? it.images : [];
    let best = '';
    for (const im of imgs) if (im && typeof im.url === 'string' && (im.label === 'small' || (!best && im.label === 'standard'))) best = im.url;
    if (!best && imgs[0] && typeof imgs[0].url === 'string') best = imgs[0].url;
    return cut(best || md.image_small_url || md.image_url || md.image_large_url || '', 300);
  }
  function norm(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const t = raw.contextTrack && typeof raw.contextTrack === 'object' ? raw.contextTrack : raw;
    const md = (t.metadata && typeof t.metadata === 'object') ? t.metadata : ((raw.metadata && typeof raw.metadata === 'object') ? raw.metadata : {});
    let artists = '';
    const al = Array.isArray(raw.artists) ? raw.artists : Array.isArray(t.artists) ? t.artists : null;
    if (al) artists = al.map((a) => a && a.name).filter(Boolean).join(', ');
    if (!artists) { const n = []; for (let i = 0; i < 8; i++) { const a = md[i ? 'artist_name:' + i : 'artist_name']; if (!a) break; n.push(a); } artists = n.join(', '); }
    return {
      uri: cut(t.uri || raw.uri, 320), uid: cut(t.uid || raw.uid || '', 80),
      name: cut(raw.name || t.name || md.title || md.name, 200), artists: cut(artists, 200),
      image: art(raw, md) || art(t, md), provider: cut(raw.provider || t.provider || md.provider || '', 24),
    };
  }
  try {
    const c = find();
    if (c.missing) return { ok: false, code: 'internals', reason: c.missing, loading: !!c.loading, version: cut(navigator.userAgent.match(/Spotify\/[\d.]+/), 40) };
    const P = c.player;
    const has = (m) => typeof P[m] === 'function';
    const caps = { skipTo: has('skipTo'), next: has('skipToNext'), remove: has('removeFromQueue'), move: has('reorderQueue'),
      search: !!(c.platform && typeof c.platform.getGraphQLLoader === 'function') };
    if (op === 'probe') return { ok: true, via: c.via, caps: caps, version: cut((c.platform && c.platform.version) || (navigator.userAgent.match(/Spotify\/([\d.]+)/) || [])[1], 40) };
    if (op === 'queue') {
      let q = await P.getQueue();
      if (!q || typeof q !== 'object' || (!Array.isArray(q.queued) && !Array.isArray(q.nextUp))) {
        return { ok: false, code: 'shape', reason: 'getQueue() gave ' + (q && typeof q === 'object' ? '{' + Object.keys(q).slice(0, 10).join(', ') + '}' : typeof q) };
      }
      const qd = Array.isArray(q.queued) ? q.queued : [], nu = Array.isArray(q.nextUp) ? q.nextUp : [];
      return { ok: true, caps: caps, current: norm(q.current), queued: qd.slice(0, arg.queuedMax).map(norm).filter(Boolean),
        nextUp: nu.slice(0, arg.nextUpMax).map(norm).filter(Boolean), totalQueued: qd.length, totalNextUp: nu.length };
    }
    const ref = (x) => ({ uri: x.uri, uid: x.uid || null });
    if (op === 'skipTo') { if (!caps.skipTo) return { ok: false, code: 'nomethod', reason: 'Spotify has no skipTo()' }; await P.skipTo(ref(arg)); return { ok: true }; }
    if (op === 'next') { if (!caps.next) return { ok: false, code: 'nomethod', reason: 'Spotify has no skipToNext()' }; await P.skipToNext(); return { ok: true }; }
    if (op === 'add') { await P.addToQueue(arg.uris.map((u) => ({ uri: u, uid: null }))); return { ok: true }; }
    if (op === 'remove') { if (!caps.remove) return { ok: false, code: 'nomethod', reason: 'Spotify has no removeFromQueue()' }; await P.removeFromQueue([ref(arg)]); return { ok: true }; }
    if (op === 'move') {
      if (!caps.move) return { ok: false, code: 'nomethod', reason: 'Spotify has no reorderQueue()' };
      await P.reorderQueue([ref(arg.item)], arg.before ? { before: ref(arg.before) } : { after: ref(arg.after) });
      return { ok: true };
    }
    if (op === 'search') {
      if (!caps.search) return { ok: false, code: 'nosearch', reason: 'Spotify’s search loader (getGraphQLLoader) was not found' };
      let hash = arg.fallbackHash, via = 'baked-in hash from Spotify 1.3.0.277';
      if (c.searchHash) { hash = c.searchHash; via = 'Spotify’s bundle'; }
      else {
        try {
          const qq = g.rspackChunk || g.rspackChunkclient_web || g.webpackChunkclient_web;
          if (!c.req && qq && typeof qq.push === 'function') qq.push([[Symbol('mantle')], {}, (r) => { c.req = r; }]);
          const m = c.req && c.req.m;
          const n = m ? Object.keys(m).length : 0;
          if (m && n !== c.scanned) {
            c.scanned = n;
            for (const id in m) {
              let s; try { s = Function.prototype.toString.call(m[id]); } catch (e) { continue; }
              const i = s.indexOf('"searchTracks","query","');
              if (i < 0) continue;
              const h = s.slice(i + 24, i + 88);
              if (/^[0-9a-f]{64}$/.test(h)) { c.searchHash = hash = h; via = 'Spotify’s bundle'; break; }
            }
          }
        } catch (e) { /* the baked hash */ }
      }
      const load = c.platform.getGraphQLLoader();
      const res = await load({ name: 'searchTracks', operation: 'query', sha256Hash: hash, value: null },
        { searchTerm: arg.q, offset: 0, limit: arg.limit, numberOfTopResults: 5, includeAudiobooks: false, includePreReleases: false, includeAlbumPreReleases: false, includeAuthors: false });
      const tv = res && res.data && res.data.searchV2 && res.data.searchV2.tracksV2;
      if (!tv) return { ok: false, code: 'searchshape', via: via, reason: 'Spotify’s search answered without songs' + (res && res.errors ? ' (' + cut(res.errors.map((e) => e && e.message).join('; '), 160) + ')' : '') };
      const items = (Array.isArray(tv.items) ? tv.items : []).slice(0, arg.limit).map((x) => {
        const d = (x && x.item && x.item.data) || (x && x.data) || x || {};
        const arts = (d.artists && Array.isArray(d.artists.items)) ? d.artists.items.map((a) => a && a.profile && a.profile.name).filter(Boolean).join(', ') : '';
        const src = d.albumOfTrack && d.albumOfTrack.coverArt && Array.isArray(d.albumOfTrack.coverArt.sources) ? d.albumOfTrack.coverArt.sources : [];
        let img = ''; for (const s of src) if (s && typeof s.url === 'string' && (!img || (s.width && s.width <= 300))) img = s.url;
        return { uri: cut(d.uri, 120), name: cut(d.name, 200), artists: cut(arts, 200), image: cut(img, 300) };
      });
      return { ok: true, via: via, items: items };
    }
    /* ---- spothide lane (2026-09-26): the window, the player's own controls, his library, search of
       every kind. Each resolves one of Spotify's own registered APIs; no credential is ever read. */
    const reg = c.platform && typeof c.platform.getRegistry === 'function' ? c.platform.getRegistry() : null;
    const api = (name) => { try { return reg && typeof reg.resolve === 'function' ? reg.resolve(Symbol.for(name)) : null; } catch (e) { return null; } };
    const winClient = () => { const f = api('FocusMainWindowAPI'); return f && f._windowStateClient && typeof f._windowStateClient.setWindowState === 'function' ? f._windowStateClient : null; };
    // the window service can leave a call unanswered while the window is minimized (seen live, 2026-09-26): never wait on it for long
    const within = (p, ms, dflt) => Promise.race([Promise.resolve(p), new Promise((r) => setTimeout(() => r(dflt), ms))]);
    const wstate = async (w) => { try { const s = await within(w.getWindowState({}), 800, null); return s && typeof s.state === 'number' ? s.state : null; } catch (e) { return null; } };
    const pstate = () => {
      const s = typeof P.getState === 'function' ? P.getState() : null;
      if (!s || typeof s !== 'object') return null;
      const r = s.restrictions || {};
      return { paused: !!s.isPaused, shuffle: !!s.shuffle, repeat: typeof s.repeat === 'number' ? s.repeat : 0,
        context: cut(s.context && s.context.uri, 200), item: cut(s.item && s.item.uri, 200), hasItem: !!s.item,
        canShuffle: r.canToggleShuffle !== false, canRepeat: r.canToggleRepeatContext !== false, canRepeatTrack: r.canToggleRepeatTrack !== false };
    };
    if (op === 'state') return { ok: true, player: pstate() };
    if (op === 'window') {
      // Spotify's own window service (WINDOW_STATE_NORMAL 1, MAXIMIZED 2, MINIMIZED 3, HIDDEN 4)
      const w = winClient();
      if (arg.to === 'show') {
        const f = api('FocusMainWindowAPI');
        if (!f || typeof f.focusMainWindow !== 'function') return { ok: false, code: 'nowindowapi', reason: 'Spotify’s FocusMainWindowAPI was not found' };
        const before = w ? await wstate(w) : null;
        await within(f.focusMainWindow(), 1500, null);
        if (w && (await wstate(w)) === 4) await within(w.setWindowState({ state: 1 }), 1500, null);
        return { ok: true, via: 'FocusMainWindowAPI.focusMainWindow', before: before, after: w ? await wstate(w) : null };
      }
      if (!w) return { ok: false, code: 'nowindowapi', reason: 'Spotify’s window-state service (FocusMainWindowAPI._windowStateClient) was not found' };
      const before = await wstate(w);
      const answered = await within(w.setWindowState({ state: 4 }).then(() => true), 1500, false);
      return { ok: true, via: 'window-state service SetWindowState(HIDDEN)', answered: answered, before: before, after: await wstate(w) };
    }
    if (op === 'quit') {
      const l = api('LifecycleAPI');
      if (!l || typeof l.shutdown !== 'function') return { ok: false, code: 'nolifecycle', reason: 'Spotify’s LifecycleAPI.shutdown was not found' };
      setTimeout(() => { try { l.shutdown(); } catch (e) { /* the process is going */ } }, 60);   // answer first, then quit
      return { ok: true, via: 'LifecycleAPI.shutdown' };
    }
    if (op === 'shuffle' || op === 'repeat') {
      const m = op === 'shuffle' ? 'setShuffle' : 'setRepeat';
      if (!has(m)) return { ok: false, code: 'nomethod', reason: 'Spotify has no ' + m + '()' };
      await P[m](op === 'shuffle' ? !!arg.on : arg.mode);
      await new Promise((r) => setTimeout(r, arg.settleMs || 0));
      return { ok: true, player: pstate() };
    }
    if (op === 'playctx') {
      if (!has('play')) return { ok: false, code: 'nomethod', reason: 'Spotify has no play()' };
      const before = pstate();
      await P.play({ uri: arg.uri }, {}, {});
      const until = Date.now() + (arg.verifyMs || 0);
      let now = pstate();
      while (Date.now() < until && now && (now.paused || (now.context === (before && before.context) && now.item === (before && before.item)))) {
        await new Promise((r) => setTimeout(r, 150)); now = pstate();
      }
      return { ok: true, before: before, player: now };
    }
    if (op === 'library') {
      const L = api('LibraryAPI');
      if (!L || typeof L.getContents !== 'function') return { ok: false, code: 'nolibrary', reason: 'Spotify’s LibraryAPI was not found' };
      const res = await L.getContents({ limit: arg.limit, offset: 0 });
      const list = res && Array.isArray(res.items) ? res.items : [];
      const imgOf = (it) => { const im = Array.isArray(it.images) ? it.images : []; let u = ''; for (const x of im) if (x && typeof x.url === 'string' && (!u || (x.width && x.width <= 300))) u = x.url; return cut(u, 300); };
      const items = list.slice(0, arg.limit).map((it) => ({ uri: cut(it && it.uri, 120), kind: cut(it && it.type, 20), name: cut(it && it.name, 200),
        owner: cut(it && ((it.owner && (it.owner.name || it.owner.displayName)) || (Array.isArray(it.artists) ? it.artists.map((a) => a && a.name).filter(Boolean).join(', ') : '') || it.publisher || ''), 120),
        image: imgOf(it || {}) }));
      return { ok: true, items: items, total: (res && res.totalLength) || list.length, liked: 'spotify:collection:tracks' };
    }
    /* media-be lane (2026-09-29): Liked Songs (the card's heart), through Spotify's own LibraryAPI:
       contains(...uris) -> Promise<boolean[]>, add({uris}), remove({uris}). Every call is bounded by
       arg.waitMs, so a Spotify that never answers gives code 'hung' and the socket stays usable. */
    if (op === 'liked' || op === 'like') {
      const L = api('LibraryAPI');
      if (!L || typeof L.contains !== 'function' || typeof L.add !== 'function' || typeof L.remove !== 'function') return { ok: false, code: 'nolike', reason: 'Spotify’s LibraryAPI has no add/remove/contains' };
      const HUNG = { hung: true }, wait = arg.waitMs || 3000;
      const read = async (uris) => {
        const r = await within(L.contains.apply(L, uris), wait, HUNG);
        if (r === HUNG) return HUNG;
        return Array.isArray(r) && r.length === uris.length ? r.map((x) => x === true) : null;
      };
      const hung = (m) => ({ ok: false, code: 'hung', reason: 'LibraryAPI.' + m + '() did not answer within ' + wait + ' ms' });
      if (op === 'liked') {
        const l = await read(arg.uris);
        if (l === HUNG) return hung('contains');
        if (!l) return { ok: false, code: 'shape', reason: 'LibraryAPI.contains() gave no list of booleans' };
        return { ok: true, liked: l };
      }
      const m = arg.on ? 'add' : 'remove';
      const w = await within(Promise.resolve(L[m]({ uris: [arg.uri] })).then(() => 1), wait, HUNG);
      if (w === HUNG) return hung(m);
      let l = await read([arg.uri]);
      if (l !== HUNG && l && l[0] !== !!arg.on && arg.settleMs) { await new Promise((r) => setTimeout(r, arg.settleMs)); l = await read([arg.uri]); }
      if (l === HUNG) return Object.assign(hung('contains'), { reread: true });
      return { ok: true, liked: l ? l[0] : null };
    }
    if (op === 'searchall') {
      if (!caps.search) return { ok: false, code: 'nosearch', reason: 'Spotify’s search loader (getGraphQLLoader) was not found' };
      let hash = arg.fallbackHash, via = 'baked-in hash from Spotify 1.3.0.277';
      if (c.searchAllHash) { hash = c.searchAllHash; via = 'Spotify’s bundle'; }
      else {
        try {
          const qq = g.rspackChunk || g.rspackChunkclient_web || g.webpackChunkclient_web;
          if (!c.req && qq && typeof qq.push === 'function') qq.push([[Symbol('mantle')], {}, (r) => { c.req = r; }]);
          const m = c.req && c.req.m;
          const n = m ? Object.keys(m).length : 0;
          if (m && n !== c.scannedAll) {
            c.scannedAll = n;
            for (const id in m) {
              let s; try { s = Function.prototype.toString.call(m[id]); } catch (e) { continue; }
              const i = s.indexOf('"searchDesktop","query","');
              if (i < 0) continue;
              const h = s.slice(i + 25, i + 89);
              if (/^[0-9a-f]{64}$/.test(h)) { c.searchAllHash = hash = h; via = 'Spotify’s bundle'; break; }
            }
          }
        } catch (e) { /* the baked hash */ }
      }
      const load = c.platform.getGraphQLLoader();
      const res = await load({ name: 'searchDesktop', operation: 'query', sha256Hash: hash, value: null },
        { searchTerm: arg.q, offset: 0, limit: arg.limit, numberOfTopResults: 5, includeAudiobooks: false, includeArtistHasConcertsField: false,
          includePreReleases: false, includeLocalConcertsField: false, includeAuthors: false });
      const s = res && res.data && res.data.searchV2;
      if (!s) return { ok: false, code: 'searchshape', via: via, reason: 'Spotify’s search answered without results' + (res && res.errors ? ' (' + cut(res.errors.map((e) => e && e.message).join('; '), 160) + ')' : '') };
      const pick = (srcs) => { let u = ''; for (const x of (Array.isArray(srcs) ? srcs : [])) if (x && typeof x.url === 'string' && (!u || (x.width && x.width <= 300))) u = x.url; return cut(u, 300); };
      const names = (a) => (a && Array.isArray(a.items) ? a.items.map((x) => x && x.profile && x.profile.name).filter(Boolean).join(', ') : '');
      const rows = (k) => (s[k] && Array.isArray(s[k].items) ? s[k].items : []).slice(0, arg.limit).map((x) => (x && x.item && x.item.data) || (x && x.data) || x || {});
      return { ok: true, via: via,
        tracks: rows('tracksV2').map((d) => ({ uri: cut(d.uri, 120), name: cut(d.name, 200), sub: cut(names(d.artists), 200), image: pick(d.albumOfTrack && d.albumOfTrack.coverArt && d.albumOfTrack.coverArt.sources) })),
        artists: rows('artists').map((d) => ({ uri: cut(d.uri, 120), name: cut(d.profile && d.profile.name, 200), sub: '', image: pick(d.visuals && d.visuals.avatarImage && d.visuals.avatarImage.sources) })),
        albums: rows('albumsV2').map((d) => ({ uri: cut(d.uri, 120), name: cut(d.name, 200), sub: cut(names(d.artists), 200), image: pick(d.coverArt && d.coverArt.sources) })),
        playlists: rows('playlists').map((d) => ({ uri: cut(d.uri, 120), name: cut(d.name, 200), sub: cut(d.ownerV2 && d.ownerV2.data && d.ownerV2.data.name, 120), image: pick(d.images && Array.isArray(d.images.items) && d.images.items[0] && d.images.items[0].sources) })) };
    }
    return { ok: false, code: 'op', reason: 'unknown op ' + cut(op, 20) };
  } catch (e) {
    return { ok: false, code: 'threw', reason: cut((e && e.message) || e, 300) };
  }
}
/* eslint-enable */
const PAGE_SRC = PAGE.toString();

/* ====================================================================== Spotify.exe itself */
function realProc(o) {
  function run(file, args, ms) {
    return new Promise((resolve) => {
      cp.execFile(file, args, { windowsHide: true, timeout: ms || 8000, encoding: 'utf8' }, (err, out) => resolve({ err, out: String(out || '') }));
    });
  }
  function rows(out) {
    return out.split(/\r?\n/).filter((l) => /^"Spotify\.exe"/i.test(l)).map((l) => l.slice(1, -1).split('","'));
  }
  /* The sidecar (o.sidecar(cmd, args, ms) -> {ok, result, error}, from spotify.js). An error says
     code 'old' when that sidecar predates the command (it answers "unknown command"). */
  async function sc(cmd, args, ms) {
    if (typeof o.sidecar !== 'function') { const e = new Error('Mantle’s helper (the sidecar) is not connected here'); e.code = 'nosidecar'; throw e; }
    const r = await o.sidecar(cmd, args || {}, ms || 5000);
    if (!r || !r.ok) {
      const e = new Error((r && r.error) || `${cmd} gave no answer`);
      if (/unknown command/i.test(e.message)) e.code = 'old';
      throw e;
    }
    return r.result;
  }
  const MB = (b) => (b == null || b < 0 ? null : Math.round(Number(b) / 1048576));
  /* spotdeath lane: the sidecar gives the exit code and time ONCE, to whichever call first sees the exit;
     a trim that saw it hands it to the next read. */
  let seenExit = null;
  const exitOf = (r, root) => {
    if (r.running) return null;
    if (r.exitCode != null) return { code: Number(r.exitCode), at: ftMs(r.exitedAt) };
    return seenExit && seenExit.root === root ? { code: seenExit.code, at: seenExit.at } : null;
  };
  return {
    /* sptrim lane: the memory watch's three reads/writes, all through the sidecar (a few ms each,
       no PowerShell). sidecar/SpotifyMem.cs refuses anything but the tree of `root` at o.exe. */
    async mem(root, created) {
      const r = await sc('spotify.mem', { root, created: created || '', exe: o.exe }, 5000);
      const procs = (r.procs || []).map((p) => ({ pid: p.pid, mb: MB(p.pws != null && p.pws >= 0 ? p.pws : p.ws) || 0, wsMB: MB(p.ws) }));
      const exit = exitOf(r, root);   // spotdeath lane
      if (exit) seenExit = null;
      return { running: !!r.running, why: r.why || null, exit, created: r.created || null, visible: r.visible || 0, n: r.n || 0,
        mb: MB(r.pws != null ? r.pws : r.ws) || 0, wsMB: MB(r.ws), privMB: MB(r.priv), procs, ms: r.ms };
    },
    async trimTree(root, created, skip) {
      const r = await sc('spotify.trim', { root, created: created || '', exe: o.exe, skip: skip || [] }, 15000);
      if (!r.running) {
        if (r.exitCode != null) seenExit = { root, code: Number(r.exitCode), at: ftMs(r.exitedAt) };
        return { trimmed: 0, refused: [{ pid: root, why: r.why || 'Spotify is not running' }], beforeMB: 0, afterMB: 0 };
      }
      const why = (x) => ({ pid: x.pid, why: x.why });
      return { trimmed: r.trimmed || 0, beforeMB: MB(r.before) || 0, afterMB: MB(r.after) || 0,
        refused: (r.results || []).filter((x) => !x.ok && !x.skipped).map(why), results: r.results || [] };
    },
    /* The pids with an ACTIVE audio session on the default output (the sound view's own read). */
    async audio() {
      const a = await sc('audio', { op: 'sessions' }, 4000);
      if (a && a.ok === false) return { pids: null, reason: a.reason || 'the audio sessions could not be read' };
      return { pids: ((a && a.sessions) || []).filter((x) => x.active && x.pid).map((x) => x.pid), reason: null };
    },
    /* spotdeath lane: the known games running now ([{pid, file}]), from the same names-only process list
       game mode reads (sidecar gamemode.scan, a few ms, no handles) and game mode's own list of games. */
    async games() {
      let scan = null, why = '';
      try { scan = await sc('gamemode.scan', { procs: true }, 10000); } catch (e) { why = e.message; }
      if (!scan || !Array.isArray(scan.procs)) {
        // The sidecar answered late during Valorant (its ui lane): Windows' own list, names only, instead.
        const r = await run('tasklist.exe', ['/FO', 'CSV', '/NH'], 8000);
        const procs = r.out.split(/\r?\n/).map((l) => /^"([^"]+)","(\d+)"/.exec(l)).filter(Boolean).map((m) => ({ pid: Number(m[2]), file: m[1] }));
        if (!procs.length) throw new Error(`the process list could not be read (${why || 'the sidecar gave none'}${r.err ? `; tasklist: ${clip(r.err.message, 120)}` : ''})`);
        scan = { procs };
      }
      return GP.runningGames(scan, {});
    },
    exists(exe) { try { return fs.statSync(exe).isFile(); } catch (e) { return false; } },
    async running() {
      const r = await run('tasklist.exe', ['/FI', 'IMAGENAME eq Spotify.exe', '/FO', 'CSV', '/NH'], 6000);
      if (r.err && !r.out) throw new Error(`tasklist failed (${r.err.message})`);
      return rows(r.out).map((c) => Number(c[1])).filter((n) => n > 0);
    },
    /* spadopt lane: every Spotify.exe with its parent, image path, command line and start time, so a
       new Mantle can find the hidden Spotify an earlier one started. ONE CIM read and nothing else: no
       handle is opened, nothing is changed. -> [{pid, ppid, exe, cmd, createdMs}] (exe or cmd null
       when Windows would not say). */
    async list() {
      const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        '$r=@(Get-CimInstance Win32_Process -Filter "Name=\'Spotify.exe\'" -ErrorAction Stop|ForEach-Object{[pscustomobject]@{pid=[int]$_.ProcessId;ppid=[int]$_.ParentProcessId;exe=$_.ExecutablePath;cmd=$_.CommandLine;' +
        'createdMs=$(if($_.CreationDate){([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()}else{$null})}});ConvertTo-Json -Compress -Depth 3 -InputObject $r'], 15000);
      let j; try { j = JSON.parse(r.out.trim()); } catch (e) { throw new Error(`Spotify’s processes could not be listed (${r.err ? clip(r.err.message, 160) : 'no answer'})`); }
      return (Array.isArray(j) ? j : j ? [j] : []).map((p) => ({ pid: Number(p.pid) || 0, ppid: Number(p.ppid) || 0, exe: p.exe || null, cmd: p.cmd == null ? null : String(p.cmd),
        createdMs: Number.isFinite(Number(p.createdMs)) && p.createdMs != null ? Number(p.createdMs) : null })).filter((p) => p.pid > 0);
    },
    /* true when Spotify has a visible main window (on screen or minimized), false when it sits in the
       tray. Not tasklist /V: its title column shows the hidden "OleMainThreadWndName" window for a
       tray-only Spotify (seen live, 2026-09-25). .NET's MainWindowHandle is 0 unless a visible
       top-level window exists. */
    async visible() {
      const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        '@(Get-Process Spotify -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }).Count'], 10000);
      const n = parseInt(r.out.trim(), 10);
      if (!Number.isFinite(n)) throw new Error(`could not tell whether Spotify's window is showing (${r.err ? r.err.message : 'no answer'})`);
      return n > 0;
    },
    /* One read of the whole Spotify.exe tree (spothide lane): process count, working set, private
       bytes (commit), private working set (what Task Manager's Memory column shows), and how many
       top-level windows are showing. -> {n, wsMB, privateMB, privateWsMB|null, visible} */
    async snapshot() {
      const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        '$p=@(Get-Process Spotify -ErrorAction SilentlyContinue);' +
        '$pws=$null;if($p.Count){try{$pws=(Get-CimInstance Win32_PerfFormattedData_PerfProc_Process -Filter "Name LIKE \'Spotify%\'" -ErrorAction Stop|Measure-Object WorkingSetPrivate -Sum).Sum}catch{}};' +
        '[pscustomobject]@{n=$p.Count;ws=[double]($p|Measure-Object WorkingSet64 -Sum).Sum;priv=[double]($p|Measure-Object PrivateMemorySize64 -Sum).Sum;pws=$pws;vis=@($p|Where-Object{$_.MainWindowHandle -ne 0}).Count}|ConvertTo-Json -Compress'], 15000);
      let j; try { j = JSON.parse(r.out.trim()); } catch (e) { throw new Error(`could not read Spotify's memory (${r.err ? r.err.message : 'no answer'})`); }
      const mb = (b) => (b == null ? null : Math.round(Number(b) / 1048576));
      return { n: j.n || 0, wsMB: mb(j.ws), privateMB: mb(j.priv), privateWsMB: j.pws == null ? null : mb(j.pws), visible: j.vis || 0 };
    },
    /* FALLBACK ONLY since the sptrim lane (the watch uses trimTree above): used once, when the sidecar
       is too old to have spotify.trim.
       EmptyWorkingSet, ONCE, on the Spotify tree Mantle itself started (spothide lane). As strict as
       game mode's own trim, and separate from it (gamemode.trim still takes Mantle's processes only):
       only Spotify.exe processes whose image IS `exe`, and only the root pid Mantle launched plus the
       processes whose parent chain reaches it. Anything else is refused by name in the answer.
       Pages go to Windows' standby list (commit is unchanged); nothing is suspended or throttled.
       -> {trimmed:[pid], refused:[{pid, why}], beforeMB, afterMB} */
    async trim(rootPid, exe) {
      const env = Object.assign({}, process.env, { MANTLE_SPOTIFY_ROOT: String(Number(rootPid) || 0), MANTLE_SPOTIFY_EXE: String(exe || '') });
      const script = [
        'Add-Type -Namespace MantleSpotify -Name Psapi -MemberDefinition \'[DllImport("psapi.dll")] public static extern bool EmptyWorkingSet(IntPtr h); [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint a, bool i, uint p); [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);\'',
        '$root=[int]$env:MANTLE_SPOTIFY_ROOT; $exe=$env:MANTLE_SPOTIFY_EXE',
        '$all=@(Get-CimInstance Win32_Process -Filter "Name=\'Spotify.exe\'")',
        '$by=@{}; foreach($x in $all){ $by[[int]$x.ProcessId]=$x }',
        '$out=@{trimmed=@();refused=@();before=0;after=0}',
        'if(-not $by.ContainsKey($root) -or -not $by[$root].ExecutablePath -or $by[$root].ExecutablePath -ne $exe){ $out.refused+=@{pid=$root;why="the process Mantle started is not Spotify.exe at $exe any more"}; $out|ConvertTo-Json -Compress -Depth 4; exit }',
        'foreach($x in $all){ $id=[int]$x.ProcessId; $ok=$false; $cur=$x; for($i=0;$i -lt 6 -and $cur;$i++){ if([int]$cur.ProcessId -eq $root){$ok=$true;break}; $cur=$by[[int]$cur.ParentProcessId] }',
        '  if(-not $ok){ $out.refused+=@{pid=$id;why="not started by the Spotify Mantle launched"}; continue }',
        '  if($x.ExecutablePath -ne $exe){ $out.refused+=@{pid=$id;why="a different Spotify.exe"}; continue }',
        '  $p=Get-Process -Id $id -ErrorAction SilentlyContinue; if(-not $p){continue}; $out.before+=$p.WorkingSet64',
        '  $h=[MantleSpotify.Psapi]::OpenProcess(0x1100,$false,[uint32]$id); if($h -eq [IntPtr]::Zero){ $out.refused+=@{pid=$id;why="Windows refused access"}; continue }',
        '  if([MantleSpotify.Psapi]::EmptyWorkingSet($h)){ $out.trimmed+=$id } else { $out.refused+=@{pid=$id;why="EmptyWorkingSet failed"} }; [void][MantleSpotify.Psapi]::CloseHandle($h)',
        '  $p.Refresh(); $out.after+=$p.WorkingSet64 }',
        '$out|ConvertTo-Json -Compress -Depth 4',
      ].join('\n');
      const r = await new Promise((resolve) => {
        cp.execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 20000, encoding: 'utf8', env }, (err, out) => resolve({ err, out: String(out || '') }));
      });
      let j; try { j = JSON.parse(r.out.trim().split(/\r?\n/).pop()); } catch (e) { throw new Error(`the trim gave no answer (${r.err ? clip(r.err.message, 160) : 'empty'})`); }
      const arr = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
      return { trimmed: arr(j.trimmed), refused: arr(j.refused), beforeMB: Math.round((j.before || 0) / 1048576), afterMB: Math.round((j.after || 0) / 1048576) };
    },
    /* spotgame lane: WM_CLOSE to ONE Spotify tree, by its root pid (taskkill /PID /T, WITHOUT /F), the
       way Windows asks an app to quit. Never by image name: only the tree of that pid is asked.
       (spotpid lane, 2026-09-28: the by-image-name close() and kill() are GONE; the card's Quit and
       Restart use this and killPid below, on the main pid only.) */
    async closePid(pid) {
      const n = Number(pid);
      if (!Number.isInteger(n) || n <= 0) return { out: '', err: `not a process id (${clip(String(pid), 20)})` };
      const r = await run('taskkill.exe', ['/PID', String(n), '/T'], 8000);
      return { out: r.out.trim(), err: r.err ? r.err.message : null };
    },
    /* spotpid lane: the LAST step of the card's Quit and Restart, only after closePid was ignored:
       taskkill /PID /T /F on that same tree. Still never by image name. */
    async killPid(pid) {
      const n = Number(pid);
      if (!Number.isInteger(n) || n <= 0) return { out: '', err: `not a process id (${clip(String(pid), 20)})` };
      const r = await run('taskkill.exe', ['/PID', String(n), '/T', '/F'], 8000);
      return { out: r.out.trim(), err: r.err ? r.err.message : null };
    },
    launch(exe, args) {
      return new Promise((resolve) => {
        const env = {};
        for (const [k, v] of Object.entries(process.env)) if (!/^(ELECTRON_|NODE_OPTIONS$)/i.test(k)) env[k] = v;
        let child;
        try { child = cp.spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false, env, cwd: path.dirname(exe) }); }
        catch (e) { resolve({ ok: false, reason: e.message }); return; }
        child.once('error', (e) => resolve({ ok: false, reason: e.message }));
        child.once('spawn', () => { child.unref(); resolve({ ok: true, pid: child.pid }); });
      });
    },
  };
}

/* ====================================================================== taking over (spadopt lane), pure
   A new Mantle takes over the hidden Spotify an EARLIER Mantle started only when the process proves it
   itself: a ROOT Spotify.exe (no Spotify.exe parent older than it, no Chromium --type=) whose image is
   exactly the expected exe and whose command line carries EVERY argument of Mantle's hidden launch
   (SIGNATURE, each as an exact token). The card's Start and lib/spotify-launch.js both launch with
   exactly these. A Spotify Owen opens carries none of them, Spotify's own autostart passes
   --autostart --minimized but never the port, and Mantle's Restart passes the port without
   --disable-gpu (it does not hide). No marker file: the command line is set at launch and cannot
   change, and the sidecar then pins the exact start time, so a reused pid is refused. */
const SIGNATURE = [FLAG].concat(HIDDEN_ARGS);
const ADOPTED = 'adopted after a Mantle restart';
function cmdTokens(cmd) {
  const out = [];
  let cur = '', q = false, any = false;
  for (const ch of String(cmd || '')) {
    if (ch === '"') { q = !q; any = true; continue; }
    if (!q && /\s/.test(ch)) { if (any) { out.push(cur); cur = ''; any = false; } continue; }
    cur += ch; any = true;
  }
  if (any) out.push(cur);
  return out;
}
function samePath(a, b) { return !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase(); }
/* The MAIN Spotify.exe processes in realProc.list()'s rows (roots: no Spotify.exe parent older than
   it, and no Chromium --type=, which every renderer, GPU and crashpad helper carries), and each root's
   tree (the root plus every row whose parent chain reaches it). Shared by the takeover below and the
   card's Quit/Restart (spotpid lane). -> {roots: [row], tree(rootPid) -> [pid]} */
function spotifyTree(list) {
  const rows = (Array.isArray(list) ? list : []).filter((p) => p && p.pid > 0);
  const byPid = new Map(rows.map((p) => [p.pid, p]));
  const parentOf = (p) => {
    const par = byPid.get(p.ppid);
    return par && par.pid !== p.pid && (par.createdMs == null || p.createdMs == null || par.createdMs <= p.createdMs) ? par : null;
  };
  const roots = rows.filter((p) => !parentOf(p) && !cmdTokens(p.cmd).some((t) => /^--type=/.test(t)));
  const tree = (root) => rows.filter((p) => { let cur = p; for (let i = 0; i < 8 && cur; i++) { if (cur.pid === root) return true; cur = parentOf(cur); } return false; }).map((p) => p.pid);
  return { roots, tree };
}
/* list: realProc.list()'s rows. -> {match: row | null, several: [row], seen: [{pid, why}]} (seen: each
   root Spotify.exe that is NOT Mantle's hidden one, and why). */
function pickMantleSpotify(list, exe) {
  const seen = [], ok = [];
  for (const p of spotifyTree(list).roots) {
    if (!p.exe) { seen.push({ pid: p.pid, why: 'Windows would not say which file it runs' }); continue; }
    if (!samePath(p.exe, exe)) { seen.push({ pid: p.pid, why: 'it runs a different Spotify.exe' }); continue; }
    if (p.cmd == null) { seen.push({ pid: p.pid, why: 'its command line could not be read' }); continue; }
    const t = cmdTokens(p.cmd);
    const missing = SIGNATURE.filter((a) => !t.includes(a));
    if (missing.length) { seen.push({ pid: p.pid, why: `it was not started hidden by Mantle (no ${missing.join(', ')})` }); continue; }
    ok.push(p);
  }
  return { match: ok.length === 1 ? ok[0] : null, several: ok.length > 1 ? ok : [], seen };
}
/* The sidecar's start time (a FILETIME: 100 ns ticks since 1601, as a string) -> ms since 1970. */
function fileTimeMs(ft) {
  if (!/^\d{1,20}$/.test(String(ft || ''))) return null;
  const ms = Number(BigInt(ft) / 10000n - 11644473600000n);
  return ms > 0 ? ms : null;
}
function span(ms) {
  const m = Math.floor(Math.max(0, ms) / 60000);
  return m < 1 ? 'under a minute' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}
/* spotpid lane: "5 s" (tenths under a second), and "pid 4242" / "pids 1, 2" for the card's words. */
function secs(ms) { const n = Math.max(0, Number(ms) || 0); return n < 1000 ? `${(n / 1000).toFixed(1)} s` : `${Math.round(n / 1000)} s`; }
function pidWords(pids) { return pids.length === 1 ? `pid ${pids[0]}` : `pids ${pids.join(', ')}`; }

/* ====================================================================== the bridge */
function createSpotifyApp(opts) {
  const o = Object.assign({
    port: PORT, host: HOST, log: () => {}, onStatus: () => {},
    fetch: typeof fetch === 'function' ? fetch : null,
    WebSocket: typeof WebSocket === 'function' ? WebSocket : null,
    exe: defaultExe(),
    proc: null, dryRun: false,
    httpTimeoutMs: 1500, openTimeoutMs: 2500, evalTimeoutMs: 6000, searchTimeoutMs: 9000,
    startWaitMs: 30000, pollMs: 700, closeWaitMs: 8000, verifyDelayMs: 650, stepDelayMs: 350,
    hideVerifyMs: 900, trim: true, trimDelayMs: 8000, playVerifyMs: 2500, windowVerifyMs: 700,
    sidecar: null, trimAboveMB: null, watchOpts: null,
    loadWaitMs: 180000, loadPollMs: 2000, reviveOn: () => true, reviveOpts: null,
    /* spotgame lane: "Close Spotify while I game" (on unless Owen turns it off), and the media
       session's word on whether Spotify plays (true | false | null = unknown), from main.js. */
    closeForGames: () => true, mediaPlaying: null,
    /* spotpid lane: the card's Quit/Restart wait this long after WM_CLOSE to its main pid before they
       force that tree (taskkill /PID /T /F), then this long for the forced tree to go. */
    forceAfterMs: 5000, forceWaitMs: 5000,
    /* spotfix lane: the hide's own wait for Spotify's answer (longer than evalTimeoutMs, and longer on
       each try, up to hideEvalMaxMs), when a failed hide is tried again (hideRetryMs, then every
       hideRetryEveryMs, at most hideRetryMax more tries), and how long after a start's hide Spotify
       showing its window again is taken as Spotify's own doing and hidden once more. */
    hideEvalMs: 10000, hideEvalMaxMs: 30000, hideRetryMs: [2000, 5000, 15000, 30000], hideRetryEveryMs: 60000, hideRetryMax: 12,
    rehideSettleMs: 60000,
    /* media-be lane: artwork fetches (a failed one is tried again after artRetryMs), and the heart's
       own wait for Spotify's LibraryAPI (inside the page, so a hung call never holds the socket). */
    artTimeoutMs: 5000, artRetryMs: 60000, likeWaitMs: 3000, likeSettleMs: 300, idleCheckMs: 60000, pingMs: 1500,
  }, opts || {});
  const proc = o.proc || realProc(o);
  const closeOn = () => { try { return o.closeForGames() !== false; } catch (_) { return true; } };
  let last ={ ok: true, state: 'checking', reason: 'checking Spotify…', port: o.port };
  let ws = null, wsUrl = '', nextId = 1, starting = false, playing = false;
  /* The window of the Spotify Mantle started: {state: hidden|shown|hiding|failed, how, reason, pid,
     source, at, trim?}. null when Mantle has not started one (a Spotify Owen opened is never hidden).
     hiding (spotfix lane): a hide failed for a reason that can pass and is tried again: tries,
     retryAt, retryWhy (the card's words), trying (a try runs now), lastReason. failed: own (Mantle's
     Spotify, so the card offers "Hide now"), gaveUp, handover (a Spotify Mantle did not start). */
  let win = null, trimTimer = null, quitting = false, hideTimer = null;
  let taking = false, epoch = 0, lastTakeLog = '';     // spadopt lane: the takeover after a Mantle restart
  const pending = new Map();
  const art = new Map();
  let lastSig = '', lastLogSig = '';

  /* The memory watch (sptrim lane): only while the Spotify Mantle started is hidden. */
  const watch = createTrimWatch(Object.assign({
    firstDelayMs: o.trimDelayMs,
    aboveMB: typeof o.trimAboveMB === 'function' ? o.trimAboveMB : o.trimAboveMB != null ? o.trimAboveMB : undefined,
    read: (root, created) => proc.mem(root, created),
    audio: () => proc.audio(),
    trim: (root, created, skip) => proc.trimTree(root, created, skip),
    log: (t) => o.log(t),
    onChange: () => publish(Object.assign({}, last)),
    onShown: () => { shownWhileHidden('the memory watch'); },
    /* A sidecar without spotify.mem: say so (the watch view carries it to the card) and fall back to
       the old one-time PowerShell trim, once, for the Spotify it would have watched. */
    onUnavailable: () => { const pid = win && win.pid; if (pid && typeof proc.trim === 'function') trimOnce(pid).catch((e) => { detail('the one-time trim threw', e.message); setTrim({ ok: false, text: 'The memory trim didn’t work this time' }); }); },
    onExit: (e) => watchedExit(e),
  }, o.watchOpts || {}));

  /* spotdeath lane: the hidden Spotify closed on its own (during a game: started again after it). */
  const revive = createRevive(Object.assign({
    games: () => (typeof proc.games === 'function' ? proc.games() : Promise.reject(new Error('this Mantle cannot list the games running'))),
    running: () => proc.running(),
    relaunch: (why) => relaunchHidden(why),
    enabled: () => { try { return o.reviveOn() !== false; } catch (_) { return true; } },
    closeEnabled: () => closeOn(),
    log: (t) => o.log(t),
    onChange: () => publish(Object.assign({}, last)),
  }, o.reviveOpts || {}));
  function watchedExit(e) {
    if (quitting || starting) return;                 // Mantle itself is closing or restarting it
    if (!win || win.state !== 'hidden' || (e && e.root && win.pid && e.root !== win.pid)) return;
    const pid = win.pid;
    win = null;
    dropSocket('the hidden Spotify exited');
    if (trimTimer) { clearTimeout(trimTimer); trimTimer = null; }
    publish({ ok: false, state: 'notrunning', reason: 'Spotify is not running: it closed without being asked' });
    revive.died({ pid, why: e && e.why, exit: e && e.exit }).then(() => {
      const v = revive.view();
      if (last.state === 'notrunning' && v.text) publish(Object.assign({}, last, { reason: `${v.text} ${v.plan}`.trim() }));
    }).catch((err) => o.log(`the Spotify exit handler threw: ${(err && err.stack) || err}`));
  }
  const canWatch = () => o.trim && typeof proc.mem === 'function' && typeof proc.trimTree === 'function';
  function watchStart(pid, why, created) {
    if (!pid) return;
    if (canWatch()) { watch.start(pid, why, created); return; }
    scheduleTrim(pid);           // a proc without the sidecar reads (never in a live run): the old one-time trim
  }
  const winView = () => (win ? Object.assign({}, win, { watch: watch.view() }) : null);

  function publish(st) {
    const was = last.state;
    last = Object.assign({ port: o.port }, st, { window: winView(), revive: revive.view() });
    if (last.state === 'connected' && was !== 'connected') revive.seen();
    /* spadopt lane: Spotify came up on the port while Mantle holds no window state for it: it may be
       the hidden one an earlier Mantle started. */
    if (last.state === 'connected' && was !== 'connected' && (!win || win.takeOverFailed) && !starting && !taking) {
      Promise.resolve().then(() => takeOver('Spotify came up on the port')).catch((e) => o.log(`the Spotify takeover threw: ${(e && e.stack) || e}`));
    }
    const logSig = last.state + '\u0001' + (last.reason || '') + '\u0001' + (win ? win.state + (win.reason || '') : '');
    const sig = logSig + '\u0001' + (win && win.trim ? win.trim.text : '') + '\u0001' + (win ? watch.sig() : '') + '\u0001' + revive.sig()
      + '\u0001' + (win && win.state === 'hiding' ? `${win.tries},${win.retryAt},${win.trying ? 1 : 0},${win.retryWhy}` : '');
    if (logSig !== lastLogSig) { lastLogSig = logSig; o.log(`status ${last.state}${last.reason ? ': ' + last.reason : ''}`); }
    if (sig !== lastSig) { lastSig = sig; try { o.onStatus(last); } catch (e) { /* page gone */ } }
    return last;
  }

  /* ---------------------------------------------------------------- the port */
  function getJson(p) {
    return new Promise((resolve, reject) => {
      const req = http.get({ host: o.host, port: o.port, path: p, timeout: o.httpTimeoutMs, headers: { Host: `${o.host}:${o.port}` } }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; if (body.length > 2e6) req.destroy(new Error('answer too big')); });
        res.on('end', () => {
          if (res.statusCode !== 200) { reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { code: 'EHTTP' })); return; }
          try { resolve(JSON.parse(body)); } catch (e) { reject(Object.assign(new Error('not JSON'), { code: 'ENOTCDP' })); }
        });
      });
      req.on('timeout', () => req.destroy(Object.assign(new Error(`no answer within ${o.httpTimeoutMs} ms`), { code: 'ETIMEDOUT' })));
      req.on('error', reject);
    });
  }
  /* -> { url } | { closed: reason } | { busy: reason } */
  async function findTarget() {
    let list;
    try { list = await getJson('/json/list'); } catch (e) {
      if (e.code === 'ECONNREFUSED' || e.code === 'ECONNRESET') return { closed: 'nothing listens on the port' };
      if (e.code === 'ETIMEDOUT') return { closed: e.message };
      return { busy: `port ${o.port} answers, but not like a Chromium debugging port (${e.message})` };
    }
    if (!Array.isArray(list)) return { busy: `port ${o.port} answers, but not with a list of pages` };
    const pages = list.filter((t) => t && t.type === 'page' && typeof t.url === 'string' && typeof t.webSocketDebuggerUrl === 'string');
    // secreview-sp lane: ONLY the desktop app's page. A page that merely mentions spotify (a browser
    // tab on this port) would get the search text and the play commands, and fill the card.
    const t = pages.find((x) => /^https:\/\/xpui\.app\.spotify\.com\//.test(x.url));
    if (!t) return { busy: `port ${o.port} is a debugging port, but none of its ${list.length} page(s) is Spotify’s` };
    const m = /^ws:\/\/(?:127\.0\.0\.1|localhost):(\d+)(\/devtools\/page\/[A-Za-z0-9._-]{1,80})$/.exec(t.webSocketDebuggerUrl);
    if (!m || Number(m[1]) !== o.port) return { busy: `Spotify’s page gave an unexpected socket address (${clip(t.webSocketDebuggerUrl, 80)})` };
    return { url: `ws://${o.host}:${o.port}${m[2]}` };
  }

  /* media-be lane (2026-09-29): sockGen counts drops; a connection still opening when the socket is
     dropped (stop(), a quit) is closed when it lands instead of becoming the live one. connecting: two
     calls at once (a double click, the card's reads) share ONE new socket; before, each opened its
     own and the first was never closed. lastRx: when Spotify last answered (the idle check in page()). */
  let sockGen = 0, connecting = null, lastRx = 0;
  function dropSocket(why) {
    const w = ws;
    ws = null; wsUrl = ''; sockGen += 1; connecting = null;
    for (const [, p] of pending) { clearTimeout(p.timer); p.reject(Object.assign(new Error(why), { code: 'ECLOSED' })); }
    pending.clear();
    if (w) { try { w.close(); } catch (e) { /* already */ } }
  }
  function open(url) {
    if (ws && wsUrl === url && ws.readyState === 1) return Promise.resolve(ws);
    if (connecting && connecting.url === url) return connecting.p;
    if (ws) dropSocket('Spotify’s page changed');
    if (!o.WebSocket) return Promise.reject(new Error('this Node has no built-in WebSocket'));
    const gen = sockGen;
    const p = new Promise((resolve, reject) => {
      let done = false;
      const s = new o.WebSocket(url);
      const timer = setTimeout(() => { if (done) return; done = true; try { s.close(); } catch (e) { /* */ } reject(new Error(`Spotify’s page did not accept the connection within ${o.openTimeoutMs} ms`)); }, o.openTimeoutMs);
      s.addEventListener('open', () => {
        if (done) return; done = true; clearTimeout(timer);
        if (gen !== sockGen) { try { s.close(); } catch (e) { /* */ } reject(Object.assign(new Error('the connection was dropped while it opened'), { code: 'ECLOSED' })); return; }
        ws = s; wsUrl = url; lastRx = Date.now(); resolve(s);
      });
      s.addEventListener('error', () => { if (!done) { done = true; clearTimeout(timer); reject(new Error('Spotify’s page refused the connection')); } });
      s.addEventListener('close', () => {
        if (ws !== s) return;
        dropSocket('Spotify closed the connection (it quit or reloaded)');
        if (win && win.state === 'hidden' && !quitting && !starting) { const t = setTimeout(() => { watch.tickNow().catch(() => {}); }, 1500); if (t.unref) t.unref(); }
      });
      s.addEventListener('message', (ev) => {
        if (ws === s) lastRx = Date.now();
        let m; try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')); } catch (e) { return; }
        const p = m && pending.get(m.id);
        if (!p) return;
        pending.delete(m.id); clearTimeout(p.timer);
        if (m.error) p.reject(Object.assign(new Error(`Spotify’s debugger said: ${clip(m.error.message || JSON.stringify(m.error), 160)}`), { code: 'ECDP' }));
        else p.resolve(m.result || {});
      });
    });
    const c = { url, p };
    connecting = c;
    const done = () => { if (connecting === c) connecting = null; };
    p.then(done, done);
    return p;
  }
  function send(method, params, ms) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        dropSocket('timed out');            // a stuck page: the next call reconnects from scratch
        reject(Object.assign(new Error(`Spotify did not answer within ${Math.round(ms / 1000)} s`), { code: 'ETIMEDOUT' }));
      }, ms);
      pending.set(id, { resolve, reject, timer });
      try { if (!ws) throw new Error('Spotify closed the connection'); ws.send(JSON.stringify({ id, method, params })); } catch (e) { pending.delete(id); clearTimeout(timer); reject(e); }
    });
  }

  /* One op in the page. Returns PAGE()'s value, or { ok:false, state, reason, env|transport } when
     Spotify itself could not be reached. env: a state the card shows in the list's place (published,
     unless quiet: the start/restart wait polls a page that is still loading). */
  /* media-be lane: the detail behind a plain reason goes to the log, scrubbed, once per distinct line
     (a card that asks every few seconds does not fill the log with the same line). */
  let lastDetail = '';
  function detail(what, text) {
    const line = `${what}: ${scrub(text)}`;
    if (line !== lastDetail) { lastDetail = line; o.log(line); }
  }
  /* A refused or failed page op -> the card's words. what: the action ("save it to Liked Songs"). */
  function plainOf(code, what) {
    const c = String(code || '');
    if (/^no(?!answer)/.test(c)) return `This version of Spotify can’t ${what} from Mantle`;
    if (c === 'hung') return `Spotify didn’t answer in time, so Mantle couldn’t ${what}. Try again`;
    return `Spotify couldn’t ${what} just now. Try again`;
  }
  /* v: page()'s failed answer. Lost connections and closed ports keep page()'s own plain words. */
  function plainFail(v, what) {
    if (v.env || v.transport) return Object.assign({ state: 'error' }, v);
    return Object.assign({ state: 'error' }, v, { reason: plainOf(v.code, what) });
  }
  async function page(op, arg, ms, quiet) {
    if (starting && !quiet) return { ok: false, state: 'starting', reason: last.reason || 'Spotify is starting', env: true };
    const fail = (state, reason) => { if (!quiet) publish({ ok: false, state, reason }); return { ok: false, state, reason, env: true }; };
    const ep = epoch;
    const t = await findTarget();
    /* r3-media lane: stop() landed while the page address was being read: open nothing (the socket
       used to open after stop() and stay open, since open()'s own check only covers a socket already opening). */
    if (ep !== epoch) return { ok: false, state: 'off', stopped: true, env: true, reason: 'The Spotify queue was turned off' };
    if (t.closed) {
      if (quiet) return { ok: false, state: 'noport', reason: t.closed, env: true };
      const s = await statusFromClosed();
      return { ok: false, state: s.state, reason: s.reason, env: true };
    }
    if (t.busy) { detail('the port is taken', t.busy); return fail('portbusy', WORDS.busy); }
    try { await open(t.url); } catch (e) { detail('the connection failed', e.message); return fail('error', WORDS.connect); }
    /* media-be lane: a connection idle for idleCheckMs may be dead without knowing it (the PC slept,
       Spotify's page was swapped): one cheap question first, and a fresh connection if it goes
       unanswered, instead of failing the click with "Spotify didn't answer". */
    if (ws && Date.now() - lastRx > o.idleCheckMs) {
      try { await send('Runtime.evaluate', { expression: '1', returnByValue: true }, o.pingMs); } catch (e) {
        detail('an idle connection to Spotify did not answer; reconnecting', e.message);
        try { await open(t.url); } catch (e2) { detail('the connection failed', e2.message); return fail('error', WORDS.connect); }
      }
    }
    const expression = '(' + PAGE_SRC + ')(' + JSON.stringify(op) + ',' + JSON.stringify(arg || {}) + ')';
    let r;
    try { r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, silent: true }, ms || o.evalTimeoutMs); }
    catch (e) {
      detail(`${op} got no answer`, e.message);
      if (e.code === 'ECDP') return { ok: false, state: 'error', code: 'threw', reason: plainOf('threw', 'do that') };
      return { ok: false, state: 'error', reason: e.code === 'ETIMEDOUT' ? WORDS.slow(Math.round((ms || o.evalTimeoutMs) / 1000)) : WORDS.closed, transport: true, code: e.code === 'ETIMEDOUT' ? 'hung' : 'closed' };
    }
    let v;
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      v = { ok: false, code: 'threw', reason: `Spotify’s page threw: ${clip((d.exception && d.exception.description) || d.text || 'no detail', 200)}` };
    } else {
      v = r.result && r.result.value;
      if (!v || typeof v !== 'object') v = { ok: false, code: 'noanswer', reason: 'Spotify’s page gave no answer' };
    }
    if (v.code === 'internals' && v.loading) { detail('Spotify’s page is loading', v.reason); return Object.assign(fail('loading', WORDS.loading), { loading: true }); }
    if (v.code === 'internals') { detail('Spotify’s internals were not found', `${v.reason}${v.version ? ` (${v.version})` : ''}`); return fail('internals', WORDS.internals(str(v.version, 40).replace(/^Spotify\//, ''))); }
    /* media-be lane: Spotify refused or failed the op itself. The card gets plain words by code
       (plainFail below makes them specific to the verb); PAGE's own words go to the log only. */
    if (!v.ok) {
      detail(`Spotify refused “${op}” (${str(v.code, 20) || 'no code'})`, v.reason);
      return Object.assign({}, v, { ok: false, state: 'error', code: str(v.code, 20) || 'refused', reason: plainOf(v.code, 'do that'), detail: str(v.reason, 300) });
    }
    if (!quiet && v.ok && last.state !== 'connected') publish({ ok: true, state: 'connected', reason: null, via: v.via || last.via, caps: v.caps || last.caps, version: v.version || last.version });
    return v;
  }

  async function statusFromClosed() {
    if (!proc.exists(o.exe)) return publish({ ok: false, state: 'noinstall', reason: WORDS.noinstall });
    let pids;
    try { pids = await proc.running(); } catch (e) { detail('the process list failed', e.message); return publish({ ok: false, state: 'error', reason: WORDS.unsure }); }
    if (!pids.length) return publish({ ok: false, state: 'notrunning', reason: 'Spotify is not running' });
    return publish({ ok: false, state: 'noport', reason: 'Spotify is running, but it was not started by Mantle, so Up next cannot reach it' });
  }

  /* ---------------------------------------------------------------- artwork (the bar's CSP takes data: only) */
  function artUrl(u) {
    const s = String(u || '');
    let m = /^spotify:image:([0-9a-f]{16,64})$/i.exec(s);
    if (m) return `https://i.scdn.co/image/${m[1]}`;
    m = /^spotify:mosaic:([0-9a-f]{16,64})(?::|$)/i.exec(s);        // a playlist's 2x2 cover: its first tile
    if (m) return `https://i.scdn.co/image/${m[1]}`;
    try {
      const x = new URL(s);
      if (x.protocol === 'https:' && /(^|\.)scdn\.co$|(^|\.)spotifycdn\.com$/i.test(x.hostname)) return x.href;
    } catch (e) { /* not a URL */ }
    return null;
  }
  /* media-be lane (2026-09-29): a failed fetch (network loss, a slow CDN) is remembered for
     artRetryMs only, so the artwork comes back once the network does (it used to stay broken for the
     session); one address is fetched once at a time; and every fetch is bounded by artTimeoutMs even
     when the fetch ignores its abort signal. */
  const timeoutAfter = (ms) => new Promise((_, rej) => { const t = setTimeout(() => rej(new Error('timed out')), ms); if (t.unref) t.unref(); });
  function artOf(u) {
    const url = artUrl(u);
    if (!url) return Promise.resolve({ why: u ? 'This artwork isn’t from Spotify, so Mantle didn’t load it' : 'Spotify has no artwork for it' });
    const had = art.get(url);
    if (had && (had.data || had.p || Date.now() - had.at < o.artRetryMs)) return had.p || Promise.resolve(had);
    const entry = {};
    art.set(url, entry);
    entry.p = (async () => {
      await null;                       // entry is in the map before anything below runs
      let got;
      try {
        if (!o.fetch) throw new Error('no fetch');
        const res = await Promise.race([o.fetch(url, { signal: AbortSignal.timeout(o.artTimeoutMs) }), timeoutAfter(o.artTimeoutMs)]);
        const type = String(res.headers.get('content-type') || '').split(';')[0].trim();
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        if (!/^image\//.test(type)) throw new Error(`not an image (${type || 'no type'})`);
        const buf = Buffer.from(await Promise.race([res.arrayBuffer(), timeoutAfter(o.artTimeoutMs)]));
        if (buf.length > ART_MAX_BYTES) throw new Error(`too big (${buf.length} bytes)`);
        got = { data: `data:${type};base64,${buf.toString('base64')}` };
      } catch (e) { got = { why: 'The artwork didn’t load', at: Date.now() }; }
      if (art.get(url) === entry) art.set(url, got);
      if (art.size > ART_CACHE_MAX) art.delete(art.keys().next().value);
      return got;
    })();
    return entry.p;
  }
  async function withArt(items) {
    await Promise.all(items.map(async (it) => {
      const a = await artOf(it.image);
      it.image = a.data || null;
      if (!a.data) it.imageReason = a.why;
    }));
    return items;
  }
  function row(x, where) {
    if (!x || !ROW_URI_RE.test(x.uri) || x.uri === 'spotify:delimiter') return null;
    return { uri: x.uri, uid: UID_RE.test(x.uid || '') ? x.uid : '', name: str(x.name, 200) || '(no title)', artists: str(x.artists, 200),
      kind: /^spotify:episode:/.test(x.uri) ? 'episode' : /^spotify:local:/.test(x.uri) ? 'local' : 'track', where, provider: str(x.provider, 24), image: str(x.image, 300) };
  }

  /* ---------------------------------------------------------------- commands */
  async function status() {
    if (starting) return last;
    const v = await page('probe', {});
    if (v.ok) return publish({ ok: true, state: 'connected', reason: null, via: v.via, caps: v.caps, version: v.version });
    if (v.env) return last;
    return publish({ ok: false, state: 'error', reason: plainOf(v.code, 'answer Mantle') });
  }

  async function readQueue() {
    const v = await page('queue', { queuedMax: QUEUED_MAX, nextUpMax: NEXTUP_MAX });
    if (!v.ok) return v;
    return {
      ok: true, caps: v.caps || {}, current: v.current && ROW_URI_RE.test(v.current.uri) ? Object.assign(row(v.current, 'current'), { image: '' }) : null,
      queued: capList(v.queued, QUEUED_MAX).map((x) => row(x, 'queued')).filter(Boolean),
      nextUp: capList(v.nextUp, NEXTUP_MAX).map((x) => row(x, 'next')).filter(Boolean),
      totalQueued: num(v.totalQueued), totalNextUp: num(v.totalNextUp),
      // the playing song's cover ADDRESS: only queue() reads it, as data: art; never returned as is
      currentImage: v.current && ROW_URI_RE.test(v.current.uri) ? str(v.current.image, 300) : '',
    };
  }

  async function queue() {
    const q = await readQueue();
    if (!q.ok) return plainFail(q, 'read Up next');
    /* r6-art lane (2026-09-30): the PLAYING song's cover too, fetched like the rows' (data: only).
       Spotify publishes no Windows thumbnail for some songs (measured: one played 3 min 50 s with
       none), so the card had only a note glyph; the bar uses this cover when Windows has no art. */
    const cur = q.current ? [Object.assign({}, q.current, { image: q.currentImage })] : [];
    await withArt(q.queued.concat(q.nextUp, cur));
    if (q.current) {
      q.current.image = cur[0].image || null;
      if (!cur[0].image) q.current.imageReason = cur[0].imageReason;
    }
    delete q.currentImage;
    return Object.assign(q, { state: 'connected', at: Date.now() });
  }

  function checkRow(a, what) {
    const uri = String((a && a.uri) || '');
    const uid = String((a && a.uid) || '');
    if (!ROW_URI_RE.test(uri)) return { ok: false, state: 'error', reason: `That isn’t a song in Up next, so it wasn’t ${what}` };
    if (uid && !UID_RE.test(uid)) return { ok: false, state: 'error', reason: `That entry in Up next isn’t valid, so it wasn’t ${what}` };
    return null;
  }
  /* what: the action in plain words, for the card when Spotify refuses it (plainFail). */
  const refused = (r, what) => plainFail(r, what || 'do that');
  const same = (x, a) => !!x && (a.uid ? x.uid === a.uid : x.uri === a.uri);

  async function play(a) {
    const bad = checkRow(a, 'played'); if (bad) return bad;
    if (playing) return { ok: false, state: 'busy', reason: 'still jumping to the last song you picked' };
    playing = true;
    try {
      const want = { uri: String(a.uri), uid: String(a.uid || '') };
      const q = await readQueue();
      if (!q.ok) return q;
      const list = q.queued.concat(q.nextUp);
      const pos = list.findIndex((x) => same(x, want));
      if (pos < 0) return { ok: false, state: 'moved', reason: 'that song is not in the queue any more (it changed since the list was drawn)' };
      const name = list[pos].name;
      const before = q.current ? q.current.uri : null;
      let how = 'skipTo', note = null;
      const r = await page('skipTo', want);
      if (!r.ok) {
        if (r.transport || r.env) return r;
        // skipTo refused or is missing: if nothing changed, fall back to N x next (Spotify's own queue uses up the songs before it)
        const again = await readQueue();
        if (!again.ok) return again;
        if ((again.current ? again.current.uri : null) !== before) return { ok: false, state: 'error', reason: 'Spotify couldn’t jump straight to that song, and the song changed anyway' };
        const p2 = again.queued.concat(again.nextUp).findIndex((x) => same(x, want));
        if (p2 < 0) return { ok: false, state: 'moved', reason: 'that song left the queue while Mantle was jumping to it' };
        const n = p2 + 1;
        if (n > MAX_SKIP) return { ok: false, state: 'error', reason: `Spotify couldn’t jump straight to that song, and it is ${n} songs away (Mantle skips ahead at most ${MAX_SKIP})` };
        for (let i = 0; i < n; i++) {
          const s = await page('next', {});
          if (!s.ok) return { ok: false, state: s.state || 'error', reason: `Mantle stopped after skipping ${i} of ${n} songs: ${refused(s, 'skip ahead').reason}` };
          if (i < n - 1) await delay(o.stepDelayMs);
        }
        how = 'next'; note = `Spotify couldn’t jump straight to it, so Mantle skipped ahead ${n} time${n > 1 ? 's' : ''}`;
      }
      await delay(o.verifyDelayMs);
      const v = await readQueue();
      const now = v.ok ? v.current : null;
      const verified = !!(now && now.uri === want.uri);
      o.log(`play ${kindWords(want.uri)} via ${how}: ${verified ? 'now playing it' : `now playing ${now ? `${kindWords(now.uri)} (not it)` : 'unknown'}`}`);
      return { ok: true, uri: want.uri, via: how, note, verified,
        reason: verified ? null : `Spotify took the jump but ${now ? `is playing “${now.name}”` : 'did not say what is playing'}, not “${name}”` };
    } finally { playing = false; }
  }

  async function add(a) {
    const uri = String((a && a.uri) || '');
    if (!URI_RE.test(uri)) return { ok: false, state: 'error', reason: 'That isn’t a Spotify song or episode, so nothing was added' };
    const before = await readQueue();
    if (!before.ok) return before;
    const r = await page('add', { uris: [uri] });
    if (!r.ok) return refused(r, 'add it to Up next');
    const after = await readQueue();
    const count = (q) => q.queued.filter((x) => x.uri === uri).length;
    const verified = after.ok && (count(after) > count(before) || after.totalQueued > before.totalQueued);
    o.log(`added ${kindWords(uri)}${verified ? '' : ' (not seen in the queue afterwards)'}`);
    return { ok: true, uri, verified, reason: verified ? null : 'Spotify accepted it, but it does not show in the queue yet' };
  }

  async function remove(a) {
    const bad = checkRow(a, 'removed'); if (bad) return bad;
    const want = { uri: String(a.uri), uid: String(a.uid || '') };
    const before = await readQueue();
    if (!before.ok) return before;
    const all = (q) => q.queued.concat(q.nextUp);
    if (!all(before).some((x) => same(x, want))) return { ok: false, state: 'moved', reason: 'that song is not in the queue any more' };
    if (before.caps && before.caps.remove === false) return { ok: false, state: 'error', reason: 'This version of Spotify can’t remove songs from Up next from Mantle' };
    const r = await page('remove', want);
    if (!r.ok) return refused(r, 'remove it from Up next');
    const after = await readQueue();
    const n = (q) => all(q).filter((x) => same(x, want)).length;
    const verified = after.ok && n(after) < n(before);
    o.log(`removed ${kindWords(want.uri)}${verified ? '' : ' (still listed afterwards)'}`);
    return { ok: true, uri: want.uri, verified, reason: verified ? null : 'Spotify accepted it, but the song is still listed' };
  }

  async function move(a) {
    const bad = checkRow(a, 'moved'); if (bad) return bad;
    const dir = a && a.dir;
    if (dir !== 'up' && dir !== 'down') return { ok: false, state: 'error', reason: 'a move is "up" or "down"' };
    const want = { uri: String(a.uri), uid: String(a.uid || '') };
    const q = await readQueue();
    if (!q.ok) return q;
    if (q.caps && q.caps.move === false) return { ok: false, state: 'error', reason: 'This version of Spotify can’t reorder Up next from Mantle' };
    const i = q.queued.findIndex((x) => same(x, want));
    if (i < 0) return { ok: false, state: 'moved', reason: 'only songs you queued can be moved, and that one is not in your queue any more' };
    const j = dir === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= q.queued.length) return { ok: false, state: 'error', reason: `it is already ${dir === 'up' ? 'first' : 'last'} in your queue` };
    const other = q.queued[j];
    const item = { uri: want.uri, uid: want.uid };
    const ref = { uri: other.uri, uid: other.uid };
    const r = await page('move', dir === 'up' ? { item, before: ref } : { item, after: ref });
    if (!r.ok) return refused(r, 'move it');
    const after = await readQueue();
    const k = after.ok ? after.queued.findIndex((x) => same(x, want)) : -1;
    const verified = k === j;
    o.log(`moved ${kindWords(want.uri)} ${dir}: ${verified ? 'done' : `now at ${k}`}`);
    return { ok: true, uri: want.uri, verified, reason: verified ? null : 'Spotify accepted the move, but the order did not change' };
  }

  async function search(a) {
    const q = String((a && a.q) || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
    if (!q) return { ok: true, items: [], q };
    if (q.length > 100) return { ok: false, state: 'error', reason: 'that search is longer than 100 characters' };
    const v = await page('search', { q, limit: SEARCH_LIMIT, fallbackHash: SEARCH_HASH_1_3_0_277 }, o.searchTimeoutMs);
    if (!v.ok) return Object.assign(refused(v, 'search'), { q }, v.code === 'nosearch' ? { reason: 'Search isn’t available in this version of Spotify' } : v.code === 'searchshape' ? { reason: 'Spotify’s search didn’t answer. Try again in a moment' } : {});
    const items = capList(v.items, SEARCH_LIMIT).filter((x) => x && URI_RE.test(x.uri)).map((x) => ({ uri: x.uri, name: str(x.name, 200) || '(no title)', artists: str(x.artists, 200), kind: /^spotify:episode:/.test(x.uri) ? 'episode' : 'track', image: str(x.image, 300) }));
    await withArt(items);
    return { ok: true, items, q, via: v.via };
  }

  /* ---------------------------------------------------------------- starting Spotify with the port */
  async function waitForPort(ep) {
    const until = Date.now() + o.startWaitMs;
    let why = 'the debugging port never opened', loading = false;
    while (Date.now() < until) {
      await delay(o.pollMs);
      if (ep != null && ep !== epoch) return { ok: false, stopped: true, reason: 'the Spotify feature stopped' };
      const t = await findTarget();
      if (t.busy) { why = t.busy; continue; }
      if (t.closed) continue;
      const v = await page('probe', {}, o.evalTimeoutMs, true);
      if (v.ok) return { ok: true, via: v.via, caps: v.caps, version: v.version };
      why = v.reason || why;
      loading = !!v.loading;
    }
    return { ok: false, reason: why, loading };
  }
  /* spotdeath lane: Spotify answered, but its page was still loading after startWaitMs (2026-09-27: one
     React node for ~3 min after a start; Mantle gave up, said "a Spotify update probably moved them",
     and never hid the window). Keep looking, quietly, up to loadWaitMs; then hide it and connect. */
  async function finishLoading(pid, hide, source, why) {
    const ep = epoch;
    const until = Date.now() + Math.max(0, o.loadWaitMs - o.startWaitMs);
    let reason = why;
    try {
      while (Date.now() < until) {
        await delay(o.loadPollMs);
        if (ep !== epoch) { starting = false; return null; }
        const v = await page('probe', {}, o.evalTimeoutMs, true);
        if (v.ok) {
          o.log(`Spotify’s page finished loading (pid ${pid || '?'}, from ${source})`);
          const hid = hide ? await hideLaunched(pid, source) : null;
          starting = false;
          publish({ ok: true, state: 'connected', reason: null, via: v.via, caps: v.caps, version: v.version });
          return hid;
        }
        if (!v.loading) { reason = v.reason || reason; break; }
        reason = v.reason || reason;
      }
      starting = false;
      o.log(`Spotify’s page did not finish loading within ${Math.round(o.loadWaitMs / 1000)} s (${reason})`);
      await statusAfter(`Spotify started, but it didn’t finish loading within ${Math.round(o.loadWaitMs / 1000)} s. Open its window to see what it shows`);
    } catch (e) { starting = false; o.log(`waiting for Spotify’s page threw: ${(e && e.stack) || e}`); }
    return null;
  }
  /* hide: start it HIDDEN (HIDDEN_ARGS, then Spotify's own window-state service hides the window). */
  async function startWithPort(extraArgs, verb, hide, source) {
    publish({ ok: false, state: 'starting', reason: hide ? `${verb} Spotify hidden…` : `${verb} Spotify with Up next’s port…` });
    const l = await proc.launch(o.exe, [FLAG].concat(hide ? HIDDEN_ARGS : (extraArgs || [])));
    if (!l.ok) { starting = false; detail('Spotify.exe did not start', l.reason); return statusAfter('Windows couldn’t start Spotify. Try again; if it keeps happening, reinstall Spotify from spotify.com'); }
    return afterLaunch(l.pid, hide, source || 'the Spotify card');
  }
  async function afterLaunch(pid, hide, source) {
    const ep = epoch;
    const w = await waitForPort(ep);
    /* media-be lane: the feature was turned off (or Mantle stopped it) while Spotify started: nothing
       more happens here (no hide, no retry timer, no memory watch left running after stop()). */
    const off = () => { starting = false; o.log(`Spotify was started from ${source}, but the Spotify queue stopped meanwhile, so Mantle did not hide or watch it`); return { ok: false, state: 'off', reason: 'The Spotify queue was turned off while Spotify started' }; };
    if (w.stopped || ep !== epoch) return off();
    if (!w.ok && w.loading) {
      const text = `Spotify is still loading. Mantle ${hide ? 'hides it and ' : ''}connects once it has loaded`;
      o.log(`${text} (pid ${pid || '?'}, from ${source}; waiting up to ${Math.round(o.loadWaitMs / 1000)} s)`);
      publish({ ok: false, state: 'loading', reason: text });
      finishLoading(pid, hide, source, w.reason).catch(() => {});
      return { ok: true, loading: true, note: text };
    }
    if (!w.ok) {
      starting = false;
      detail('Spotify started but its page never answered', w.reason);
      return statusAfter(`Spotify started, but Mantle couldn’t connect to it within ${Math.round(o.startWaitMs / 1000)} s. Try Restart Spotify; if it keeps happening, this version of Spotify may not allow it`);
    }
    const hid = hide ? await hideLaunched(pid, source) : null;
    if (ep !== epoch) { clearHideRetry(); watch.stop('the Spotify feature stopped'); return off(); }
    starting = false;
    publish({ ok: true, state: 'connected', reason: null, via: w.via, caps: w.caps, version: w.version });
    return hid ? { ok: true, hidden: hid.ok, hiding: !!hid.hiding, how: hid.how || null, reason: hid.ok ? null : hid.reason } : { ok: true };
  }

  /* ---------------------------------------------------------------- the hidden window (spothide lane)
     Only ever the Spotify MANTLE just launched: its pid must still be running (a start that only
     woke a Spotify already running hands over and exits, and that Spotify is left alone). */
  async function hideLaunched(pid, source) {
    let pids = null;
    try { pids = await proc.running(); } catch (e) { /* said below */ }
    if (pids && pid && !pids.includes(pid)) {
      win = { state: 'failed', handover: true, pid, source, at: Date.now(), reason: 'Spotify’s window was left alone: the start handed over to a Spotify that was already running' };
      o.log(win.reason);
      return { ok: false, reason: win.reason };
    }
    return hideNow(pid, source);
  }
  async function hideNow(pid, source) {
    clearHideRetry();
    const since = Date.now();
    let r = await hideTry(0);
    if (!r.ok && r.showing) { r = await hideTry(0); if (r.ok) r.note = ' (second try: it came back once)'; }
    if (r.ok) return hid(pid, source, r.how, r.note || '', true);
    return hideFailed(pid, source, r, 1, since, true);
  }

  /* spotfix lane (2026-09-28). Live at 17:56 the PC sat at 100% CPU: the start's hide waited 6 s for
     Spotify's page, failed once, and was never tried again, so the card kept "Could not hide Spotify’s
     window: Spotify did not answer within 6 s" (next to "Running hidden", read later: the hide had
     landed after Mantle stopped waiting). Now a hide that fails for a reason that can pass (Spotify
     slow to answer, its page still loading, its window still showing) is tried again after
     hideRetryMs, then every hideRetryEveryMs, while the Spotify Mantle started runs and nobody opened
     it; each try LOOKS first (a hide that timed out often lands late) and waits longer for Spotify
     than the last. After hideRetryMax more tries, or at once for a reason that cannot pass (the window
     service missing), it is 'failed' with the reason, and the card offers "Hide now". */
  const hideWaitMs = (n) => Math.min(o.hideEvalMaxMs, Math.round(o.hideEvalMs * (1 + Math.max(0, n) / 2)));
  const mine = () => !!(win && win.pid && !win.takeOverFailed && !win.handover);
  function clearHideRetry() { if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; } }
  /* A failed page('window') or check -> the card's words for it, and whether trying again can help. */
  function hideTrouble(h, fallback) {
    const reason = !h ? (fallback || 'Spotify gave no answer') : h.transport ? (h.code === 'hung' ? 'Spotify was too slow to answer' : 'Spotify closed the connection') : h.env ? h.reason : h.code === 'nowindowapi' ? 'This version of Spotify can’t hide its window from Mantle' : plainOf(h.code, 'hide its window');
    if (h && (h.code === 'nowindowapi' || h.state === 'internals' || h.state === 'portbusy')) return { ok: false, reason, final: true };
    if (h && h.state === 'loading') return { ok: false, reason, why: 'Spotify is still loading' };
    return { ok: false, reason, why: 'Spotify is slow to answer' };
  }
  /* One hide: Spotify's own window service, then a look. n: the try (0 = first), for the wait. */
  async function hideTry(n) {
    const h = await page('window', { to: 'hidden' }, hideWaitMs(n), true);
    if (!h.ok) return hideTrouble(h);
    await delay(o.hideVerifyMs);
    let vis = null;
    try { vis = await proc.visible(); } catch (e) { detail('the window check failed', e.message); return { ok: false, reason: 'Mantle couldn’t check Spotify’s window', why: 'Mantle could not check its window' }; }
    if (!vis) return { ok: true, how: HOW.asked };
    return { ok: false, showing: true, why: 'its window is still showing', reason: 'Spotify took the hide, but its window is still showing' };
  }
  /* Is the window of THAT Spotify showing? The sidecar's read of its tree (one cheap call), else the
     process list and the PowerShell look. -> {visible} | {gone} | {err} */
  async function windowSeen(pid) {
    if (typeof proc.mem === 'function') {
      try { const r = await proc.mem(pid, ''); return r.running ? { visible: (r.visible || 0) > 0 } : { gone: true }; } catch (e) {
        if (e.code !== 'old' && e.code !== 'nosidecar') return { err: e.message };
      }
    }
    try { const pids = await proc.running(); if (!pids.includes(pid)) return { gone: true }; } catch (e) { /* the look below says */ }
    try { return { visible: await proc.visible() }; } catch (e) { return { err: e.message }; }
  }
  /* settle: a start's hide (not the card's): Spotify showing its window again within rehideSettleMs
     is taken as its own doing (it re-shows when its page finishes loading) and hidden once more. */
  function hid(pid, source, how, note, settle) {
    clearHideRetry();
    const now = Date.now();
    win = { state: 'hidden', how, pid, source, at: now, reason: null, settleUntil: settle ? now + o.rehideSettleMs : 0 };
    o.log(`hid the Spotify window Mantle started (pid ${pid || '?'}, from ${source}): ${how}${note}`);
    watchStart(pid, `hidden from ${source}`);
    publish(Object.assign({}, last));
    return { ok: true, how };
  }
  /* tries: the tries made so far; fromStart: carried to hid() (settle). */
  function hideFailed(pid, source, r, tries, since, fromStart) {
    clearHideRetry();
    const now = Date.now();
    if (r.final || tries > o.hideRetryMax || !pid) {
      const over = tries > 1 ? `. Mantle tried ${tries} times over ${now - since < 60000 ? secs(now - since) : span(now - since)}, then stopped` : '';
      win = { state: 'failed', own: true, gaveUp: tries > 1, pid, source, at: now, since, tries, reason: `Could not hide Spotify’s window: ${r.reason}${over}` };
      o.log(win.reason);
      publish(Object.assign({}, last));
      return { ok: false, reason: win.reason };
    }
    const ms = o.hideRetryMs[tries - 1] != null ? o.hideRetryMs[tries - 1] : o.hideRetryEveryMs;
    win = { state: 'hiding', own: true, pid, source, at: now, since, tries, retryAt: now + ms, retryWhy: r.why || 'Spotify is slow to answer', lastReason: r.reason, trying: false, fromStart: !!fromStart, reason: null };
    o.log(`Spotify’s window is not hidden yet (pid ${pid}, try ${tries}: ${r.reason}); trying again in ${secs(ms)}`);
    armHide(pid, ms);
    publish(Object.assign({}, last));
    return { ok: false, hiding: true, reason: `Its window is not hidden yet (${win.retryWhy}); Mantle keeps trying` };
  }
  function armHide(pid, ms) {
    clearHideRetry();
    hideTimer = setTimeout(() => { hideTimer = null; hideAgain(pid).catch((e) => o.log(`hiding Spotify again threw: ${(e && e.stack) || e}`)); }, Math.max(0, ms));
    if (hideTimer.unref) hideTimer.unref();
  }
  async function hideAgain(pid) {
    const ep = epoch;
    if (!(win && win.state === 'hiding' && win.pid === pid)) return;   // opened, hidden, quit or restarted meanwhile
    if (starting || quitting) { armHide(pid, o.hideRetryMs[0] || 2000); return; }
    const { source, since, fromStart } = win, tries = win.tries;
    win = Object.assign({}, win, { trying: true });
    const me = win;                     // any change meanwhile (the card, a read, a quit) replaces win
    const still = () => ep === epoch && win === me;
    publish(Object.assign({}, last));
    const seen = await windowSeen(pid);
    if (!still()) return;
    if (seen.gone) {
      o.log(`stopped hiding Spotify’s window: the Spotify Mantle started (pid ${pid}) is not running any more`);
      win = null;
      await status().catch(() => null);
      publish(Object.assign({}, last));
      return;
    }
    if (seen.visible === false) return hid(pid, source, HOW.late, ` on try ${tries + 1}`, fromStart);
    const r = await hideTry(tries);
    if (!still()) return;
    if (r.ok) return hid(pid, source, r.how, ` on try ${tries + 1}, ${secs(Date.now() - since)} after the first`, fromStart);
    return hideFailed(pid, source, r, tries + 1, since, fromStart);
  }
  /* The window of the Spotify Mantle hid is showing (the memory watch or the card's read saw it): soon
     after a start's hide, Spotify did it (hide it again, once); else Owen opened it (left open). */
  function shownWhileHidden(via) {
    if (!win || win.state !== 'hidden') return;
    const now = Date.now();
    watch.stop('Spotify’s window is showing');
    if (win.pid && win.settleUntil && now < win.settleUntil) {
      const pid = win.pid;
      o.log(`Spotify’s window came back ${secs(now - win.at)} after Mantle hid it (pid ${pid}, seen by ${via}); hiding it again`);
      win = { state: 'hiding', own: true, pid, source: win.source, at: now, since: now, tries: 0, retryAt: now, retryWhy: 'its window came back', trying: false, fromStart: false, reason: null };
      armHide(pid, 0);
    } else win = Object.assign({}, win, { state: 'shown', how: 'opened outside the card', reason: null, settleUntil: 0 });
    publish(Object.assign({}, last));
  }
  /* A pin or launcher row brought the running Spotify forward (lib/spotify-launch.js): Owen wants it
     seen, so it is neither hidden again nor retried. */
  function opening(e) {
    if (!win || !mine()) return;
    const src = String((e && e.source) || 'Mantle');
    if (win.state === 'hiding') {
      clearHideRetry();
      o.log(`stopped hiding Spotify’s window: it was brought forward from ${src}`);
      win = Object.assign({}, win, { state: 'shown', how: `brought forward from ${src}`, reason: null, trying: false, retryAt: 0 });
      watch.stop(`Spotify was brought forward from ${src}`);
      publish(Object.assign({}, last));
    } else if (win.settleUntil) win = Object.assign({}, win, { settleUntil: 0 });
  }

  /* FALLBACK since the sptrim lane (the memory watch above does this, audio-aware, every time it is
     needed): used only when proc has no sidecar reads, or once when the sidecar is too old.
     ONE working-set trim, a few seconds after the hidden start settles, and never while music plays
     or the window shows (measured: the idle hidden tree drops from ~0.9 GB to ~0.2 GB of RAM; see the
     spothide lane report). Never EcoQoS or a lower priority: that would reach the audio. */
  function scheduleTrim(pid) {
    if (!o.trim || typeof proc.trim !== 'function' || !pid) return;
    if (trimTimer) clearTimeout(trimTimer);
    trimTimer = setTimeout(() => {
      trimTimer = null;
      trimOnce(pid).catch((e) => { detail('the one-time trim threw', e.message); setTrim({ ok: false, text: 'The memory trim didn’t work this time' }); });
    }, o.trimDelayMs);
    if (trimTimer.unref) trimTimer.unref();
  }
  function setTrim(t) {
    if (!win) return;
    win = Object.assign({}, win, { trim: Object.assign({ at: Date.now() }, t) });
    o.log(t.text);
    publish(Object.assign({}, last));
  }
  async function trimOnce(pid) {
    if (!win || win.state !== 'hidden' || win.pid !== pid) return;
    const st = await page('state', {}, o.evalTimeoutMs, true);
    if (st.ok && st.player && !st.player.paused) { setTrim({ ok: false, skipped: true, text: 'The memory trim was skipped: music was already playing' }); return; }
    if (await proc.visible().catch(() => true)) { setTrim({ ok: false, skipped: true, text: 'The memory trim was skipped: Spotify’s window is showing' }); return; }
    const r = await proc.trim(pid, o.exe);
    if (r.refused.length) o.log(`the one-time trim left ${r.refused.length} process${r.refused.length === 1 ? '' : 'es'} alone: ${r.refused.map((x) => `${x.pid} (${scrub(x.why, 80)})`).join(', ')}`);
    if (!r.trimmed.length) { setTrim({ ok: false, text: `The memory trim did nothing` }); return; }
    setTrim({ ok: true, n: r.trimmed.length, beforeMB: r.beforeMB, afterMB: r.afterMB,
      text: `Trimmed the hidden Spotify’s memory once: ${r.beforeMB} MB → ${r.afterMB} MB of RAM across ${r.trimmed.length} process${r.trimmed.length === 1 ? '' : 'es'}` });
  }

  /* A Spotify started by a pin or the launcher (lib/spotify-launch.js, via launchBus()). */
  async function adopt(e) {
    const pid = Number(e && e.pid) || 0;
    const source = String((e && e.source) || 'Mantle');
    if (starting) { o.log(`a Spotify started from ${source} was not hidden here: one is already being started`); return { ok: false, state: 'starting', reason: 'Spotify is already being started' }; }
    starting = true;
    revive.cancel(`Spotify was started from ${source}`);
    publish({ ok: false, state: 'starting', reason: 'Starting Spotify hidden…' });
    try { return await afterLaunch(pid, true, source); } catch (err) { starting = false; detail(`hiding the Spotify started from ${source} threw`, err.message); return statusAfter('Mantle couldn’t hide the Spotify it just started. Use Hide window'); }
  }

  /* ---------------------------------------------------------------- the takeover (spadopt lane)
     Owen: "yeah do the spotify takeover thing". A new Mantle (go-live, Restart Mantle, logon) finds
     the hidden Spotify an EARLIER Mantle started (pickMantleSpotify: its own command line proves it)
     and takes it over as if it had just started it: the window state, the memory watch, Open / Hide /
     Quit. Run when the feature starts or is turned back on, and when Spotify comes up on the port
     while Mantle holds no window state. READS ONLY here: the process list (one CIM read), then the
     sidecar's spotify.mem for the exact start time and whether its window shows. Nothing is hidden,
     shown, trimmed or restarted; the watch trims later, over the line, as for a fresh start.
     --test (dryRun): found and said, never taken over (its watch would trim the real Spotify). */
  function takeFailed(m, reason) {
    const text = `Could not take over the hidden Spotify an earlier Mantle started${m ? ` (pid ${m.pid})` : ''}: ${scrub(reason, 200)}. Its memory is not watched`;
    if (text !== lastTakeLog) { lastTakeLog = text; o.log(text); }
    // media-be lane: the card gets plain words and what to do; the log keeps the pid and the why
    const plain = 'Mantle couldn’t take over the hidden Spotify it started before it restarted, so its memory isn’t watched. Quit Spotify and start it from here to fix this';
    win = { state: 'failed', takeOverFailed: true, pid: null, source: 'an earlier Mantle', at: Date.now(), reason: plain };
    publish(Object.assign({}, last));
    return { ok: false, adopted: false, reason: plain, detail: text };
  }
  async function takeOver(why) {
    const skip = (reason) => ({ ok: true, adopted: false, reason });
    if (win && !win.takeOverFailed) return skip('Mantle already holds a Spotify window state');
    if (starting || quitting || taking) return skip('Spotify is being started, quit or checked');
    if (typeof proc.list !== 'function') return skip('this Mantle cannot list Spotify’s processes');
    taking = true;
    const ep = epoch;
    try {
      let list;
      try { list = await proc.list(); } catch (e) {
        const pids = await proc.running().catch(() => null);
        if (pids && !pids.length) return skip('Spotify is not running');
        return takeFailed(null, `Mantle could not check whether the running Spotify is that one (${scrub(e.message, 160)})`);
      }
      const pick = pickMantleSpotify(list, o.exe);
      if (pick.several.length) return takeFailed(null, `${pick.several.length} Spotify processes look like it (pid ${pick.several.map((p) => p.pid).join(', ')}), so none was taken over`);
      const m = pick.match;
      if (!m) {
        const text = pick.seen.length ? `not taking over Spotify (${why}): ${pick.seen.map((x) => `pid ${x.pid}: ${x.why}`).join('; ')}. It is left alone` : '';
        if (text && text !== lastTakeLog) { lastTakeLog = text; o.log(text); }
        if (win && win.takeOverFailed) { win = null; publish(Object.assign({}, last)); }
        return skip(text || 'Spotify is not running');
      }
      // Its exact start time (the watch passes it on every read and trim) and its window: read only.
      let created = null, visible = null;
      if (typeof proc.mem === 'function') {
        try {
          const r = await proc.mem(m.pid, '');
          if (!r.running) return takeFailed(m, `the helper would not read it (${r.why || 'it is not running'})`);
          created = r.created || null;
          visible = (r.visible || 0) > 0;
          const ms = fileTimeMs(created);
          if (ms != null && m.createdMs != null && Math.abs(ms - m.createdMs) > 2000) return takeFailed(m, `pid ${m.pid} is not the same process it was a moment ago (its start time changed)`);
        } catch (e) { if (e.code !== 'old' && e.code !== 'nosidecar') return takeFailed(m, `its memory and window could not be read (${e.message})`); }
      }
      if (visible == null) { try { visible = await proc.visible(); } catch (e) { return takeFailed(m, e.message); } }
      if (ep !== epoch || starting || quitting || (win && !win.takeOverFailed)) return skip('the Spotify feature stopped, or Spotify was started or quit meanwhile');
      const since = m.createdMs != null ? m.createdMs : fileTimeMs(created);
      const age = since != null ? `, running for ${span(Date.now() - since)}` : '';
      if (o.dryRun) {
        const t = `dry run: would take over the Spotify an earlier Mantle started hidden (pid ${m.pid}${age}, window ${visible ? 'showing' : 'hidden'}); not taken over in a test run`;
        if (t !== lastTakeLog) { lastTakeLog = t; o.log(t); }
        return { ok: true, adopted: false, dryRun: true, pid: m.pid, visible, created, reason: t };
      }
      lastTakeLog = '';
      win = { state: visible ? 'shown' : 'hidden', how: ADOPTED, adopted: true, pid: m.pid, created, since, source: 'an earlier Mantle', at: Date.now(), reason: null };
      if (visible) o.log(`took over the Spotify an earlier Mantle started hidden (pid ${m.pid}${age}); its window is showing, so its memory is watched again once it is hidden`);
      else if (!canWatch()) o.log(`took over the hidden Spotify an earlier Mantle started (pid ${m.pid}${age}); this Mantle cannot watch its memory`);
      else {
        watch.start(m.pid, 'taken over after a Mantle restart', created);
        o.log(`took over the hidden Spotify an earlier Mantle started (pid ${m.pid}${age}); trimming it over ${watch.view().aboveMB} MB`);
      }
      publish(Object.assign({}, last));
      return { ok: true, adopted: true, pid: m.pid, state: win.state, created };
    } finally { taking = false; }
  }

  /* What the card's status line says: running, hidden or showing, memory, and the player's shuffle
     and repeat. The memory read is one PowerShell call, made only when the card asks. */
  async function info() {
    let mem = null, memReason = null;
    if (typeof proc.snapshot === 'function') { try { mem = await proc.snapshot(); } catch (e) { detail('the memory read failed', e.message); memReason = 'Mantle couldn’t read Spotify’s memory just now'; } }
    else memReason = 'this Mantle cannot read Spotify’s memory';
    if (mem && win && win.state === 'hidden' && mem.visible > 0) shownWhileHidden('the card’s read');
    /* spotfix lane: a hide that was still being tried, or given up on, may have landed late: this read
       is the truth, so the card never says "Not hidden" over a window that is hidden. */
    else if (mem && mine() && mem.n > 0 && mem.visible === 0 && (win.state === 'hiding' || (win.state === 'failed' && win.own))) {
      hid(win.pid, win.source, HOW.late, `, seen by the card’s read after ${win.tries || 1} tr${(win.tries || 1) === 1 ? 'y' : 'ies'}`, win.fromStart);
    }
    let player = null, playerReason = null;
    if (last.state === 'connected') {
      const v = await page('state', {});
      if (v.ok) player = v.player; else playerReason = refused(v, 'say what is playing').reason;
    }
    /* media-be lane: the heart. liked: true | false | null (null = nothing that can be liked plays, or
       it could not be read); likedUri: the item it is about (the card ignores it once the song moved on). */
    const lk = await likedOf(player);
    return { ok: true, state: last.state, window: winView(), running: mem ? mem.n > 0 : null, visible: mem ? mem.visible > 0 : null,
      memory: mem, memoryReason: memReason, player, playerReason, liked: lk.liked, likedUri: lk.uri, likedReason: lk.reason };
  }

  /* ---------------------------------------------------------------- Liked Songs (media-be lane, 2026-09-29)
     The one Spotify action Owen does most that the card could not do. Spotify's own LibraryAPI (PAGE
     'liked' / 'like'), bounded inside the page by likeWaitMs. A like is verified by a re-read. Clicks
     are applied in order (a double-click likes then unlikes, as clicked); at most one more waits while
     one runs, and a third is refused as busy rather than piling up behind a Spotify that hangs. */
  async function likedOf(player) {
    const uri = player && typeof player.item === 'string' ? player.item : '';
    if (!uri || !URI_RE.test(uri)) return { liked: null, uri: uri && ROW_URI_RE.test(uri) ? uri : null, reason: uri ? 'Only Spotify songs and episodes can be saved to Liked Songs' : null };
    let v;
    try { v = await page('liked', { uris: [uri], waitMs: o.likeWaitMs }); } catch (e) { v = { ok: false, code: 'threw', reason: String(e && e.message) }; }
    if (v.ok && Array.isArray(v.liked) && typeof v.liked[0] === 'boolean') return { liked: v.liked[0], uri, reason: null };
    return { liked: null, uri, reason: v.ok ? 'Spotify didn’t say whether it is in Liked Songs' : refused(v, 'check Liked Songs').reason };
  }
  let likeChain = Promise.resolve(), likeWaiting = 0;
  function like(a) {
    const on = a && a.on;
    if (typeof on !== 'boolean') return Promise.resolve({ ok: false, state: 'error', liked: null, uri: null, reason: 'Mantle didn’t get whether to save or remove it, so nothing changed' });
    const given = a && a.uri != null && a.uri !== '' ? String(a.uri) : null;
    if (given !== null && !URI_RE.test(given)) return Promise.resolve({ ok: false, state: 'error', liked: null, uri: null, reason: 'That isn’t a Spotify song or episode, so nothing changed in Liked Songs' });
    // --test against the REAL port (no MANTLE_SPOTIFY_APP_PORT): never change Owen's Liked Songs
    if (o.dryRun && o.port === PORT) return Promise.resolve({ ok: true, dryRun: true, liked: on, uri: given, reason: 'dry run: Liked Songs was not changed in a test run' });
    if (likeWaiting >= 2) return Promise.resolve({ ok: false, state: 'busy', liked: null, uri: given, reason: 'Still saving your last change to Liked Songs' });
    likeWaiting += 1;
    const ep = epoch;
    /* r3-media lane: the count drops INSIDE the run, before its answer is handed back; it used to drop
       a few microtasks after, so a click made right after an answer was refused as busy with nothing running. */
    const run = likeChain.then(async () => {
      try { return ep === epoch ? await likeNow(on, given) : { ok: false, state: 'off', liked: null, uri: given, reason: 'The Spotify queue was turned off, so nothing changed' }; }
      finally { likeWaiting -= 1; }
    });
    likeChain = run.catch(() => null);
    return run;
  }
  async function likeNow(on, given) {
    let uri = given;
    if (!uri) {
      const st = await page('state', {});
      if (!st.ok) return Object.assign(refused(st, 'see what is playing'), { liked: null, uri: null });
      const item = st.player && typeof st.player.item === 'string' ? st.player.item : '';
      if (!item) return { ok: false, state: 'error', liked: null, uri: null, reason: 'Nothing is playing, so there is no song to save' };
      if (!URI_RE.test(item)) return { ok: false, state: 'error', liked: null, uri: null, reason: 'Only Spotify songs and episodes can be saved to Liked Songs' };
      uri = item;
    }
    const v = await page('like', { uri, on, waitMs: o.likeWaitMs, settleMs: o.likeSettleMs });
    const what = on ? 'save it to Liked Songs' : 'remove it from Liked Songs';
    if (!v.ok) {
      const r = v.code === 'nolike' ? Object.assign({ state: 'error' }, v, { reason: 'This version of Spotify doesn’t let Mantle change Liked Songs' }) : refused(v, what);
      o.log(`${on ? 'like' : 'unlike'} ${kindWords(uri)}: not done (${str(v.code, 20) || v.state || 'no code'})`);
      return Object.assign(r, { liked: null, uri });
    }
    const liked = typeof v.liked === 'boolean' ? v.liked : null;
    const verified = liked === on;
    o.log(`${on ? 'like' : 'unlike'} ${kindWords(uri)}: ${verified ? 'done' : liked == null ? 'not confirmed (no re-read)' : 'Spotify did not change it'}`);
    if (verified) return { ok: true, liked, uri, reason: null };
    return { ok: false, state: 'error', liked, uri,
      reason: liked == null ? `Spotify took it, but didn’t say whether it is in Liked Songs now` : `Spotify took it, but the song is ${on ? 'still not' : 'still'} in Liked Songs` };
  }

  async function windowTo(to) {
    if (o.dryRun) return { ok: true, dryRun: true, reason: `dry run: would ${to === 'show' ? 'open' : 'hide'} Spotify’s window` };
    const hide = to !== 'show';
    // spotfix lane: the hide waits for Spotify as long as a start's first hide does (hideWaitMs)
    const v = await page('window', { to }, hide ? hideWaitMs(0) : undefined);
    if (!v.ok) {
      // "Hide now" (or Hide window) on Mantle's own Spotify that is slow to answer: tried again, and said
      if (hide && mine() && v.state !== 'starting') {
        const r = hideFailed(win.pid, 'the card', hideTrouble(v), 1, Date.now(), false);
        return Object.assign(refused(v), { hiding: !!r.hiding, reason: r.reason, window: winView() });
      }
      return refused(v);
    }
    clearHideRetry();
    await delay(o.windowVerifyMs);
    let vis = null, why = null;
    try { vis = await proc.visible(); } catch (e) { why = e.message; }
    const verified = to === 'show' ? vis === true : vis === false;
    const created = win && win.created;         // spadopt lane: a taken-over Spotify keeps its pinned start time
    if (to === 'show') win = { state: 'shown', how: HOW.card, pid: win && win.pid, created, source: 'the card', at: Date.now(), reason: null };
    else if (verified) win = { state: 'hidden', how: HOW.card, pid: win && win.pid, created, source: 'the card', at: Date.now(), reason: null };
    if (to === 'show') watch.stop('Spotify’s window was opened from the card');
    else if (verified && win.pid) watchStart(win.pid, 'hidden again from the card', win.created);
    o.log(`${to === 'show' ? 'opened' : 'hid'} Spotify’s window from the card via ${v.via}: ${verified ? 'done' : `not confirmed (${why || (vis ? 'still showing' : 'not showing')})`}`);
    if (why) detail('the window check failed', why);
    const reason = verified ? null : why ? 'Spotify took it, but Mantle couldn’t check its window' : to === 'show' ? 'Spotify took it, but its window is not showing' : 'Spotify took it, but its window is still showing';
    // spotfix lane: Mantle's own Spotify that took the hide but still shows: tried again (said by the card)
    if (hide && !verified && mine()) {
      const r = hideFailed(win.pid, 'the card', why ? { ok: false, reason, why: 'Mantle could not check its window' } : { ok: false, showing: true, reason, why: 'its window is still showing' }, 1, Date.now(), false);
      return { ok: true, verified, via: v.via, hiding: !!r.hiding, reason: r.hiding ? `${reason}. ${r.reason}` : r.reason, window: winView() };
    }
    publish(Object.assign({}, last));
    return { ok: true, verified, via: v.via, reason, window: winView() };
  }
  const openWindow = () => windowTo('show');
  const hideWindow = () => windowTo('hidden');

  /* spotpid lane (2026-09-28): the card's Quit and Restart close ONE Spotify tree, by its MAIN pid, the
     way the game close does, and NEVER by image name. The pid: the Spotify Mantle started or took over
     (win.pid) while it still runs; else the main Spotify.exe from one process list (spotifyTree: the
     root, the parent of the others). -> {roots, tree, who} | {none} (no Spotify.exe) | {reason} */
  async function mainSpotify() {
    let pids;
    try { pids = await proc.running(); } catch (e) { return { reason: `Mantle could not list Spotify’s processes (${clip(e.message, 120)})` }; }
    if (!pids.length) return { none: true };
    if (win && win.pid && pids.includes(win.pid)) return { roots: [win.pid], tree: [win.pid], who: `the Spotify Mantle ${win.adopted ? 'took over' : 'started'}` };
    if (win && win.pid) o.log(`the Spotify Mantle started (pid ${win.pid}) is not running any more; looking for the main Spotify process instead`);
    let rows;
    try { rows = await proc.list(); } catch (e) { return { reason: `Mantle could not find its main process (${clip(e.message, 160)})` }; }
    const t = spotifyTree(rows);
    const roots = t.roots.map((p) => p.pid);
    if (!roots.length) return { reason: `Mantle could not find its main process among ${pidWords(pids.slice(0, 8))}` };
    return { roots, tree: [...new Set(roots.flatMap((r) => t.tree(r)))], who: roots.length === 1 ? 'the main Spotify process' : `the ${roots.length} main Spotify processes` };
  }
  /* Steps: Spotify's own LifecycleAPI.shutdown (what its File > Quit does); WM_CLOSE to the main pid's
     tree (taskkill /PID /T WITHOUT /F); and only if that tree is still running forceAfterMs later,
     taskkill /PID /T /F on that same tree. With no main pid found, nothing is closed by process id.
     -> {ok, none?, forced, pids, via, waitedMs?} | {ok: false, forced, pids, via, reason} */
  async function closeByPid() {
    const t0 = Date.now();
    const m = await mainSpotify();
    if (m.none) return { ok: true, none: true, forced: false, pids: [], via: 'Spotify was not running' };
    const pids = m.roots || [];
    // still running? its tree when the main pid is known, else any Spotify.exe (null: could not tell)
    const alive = async () => { const p = await proc.running().catch(() => null); return p == null ? null : pids.length ? p.some((x) => m.tree.includes(x)) : p.length > 0; };
    const gone = async (ms) => { const until = Date.now() + ms; while (Date.now() < until) { await delay(Math.min(300, o.pollMs)); if ((await alive()) === false) return true; } return false; };
    const v = await page('quit', {}, o.evalTimeoutMs, true);
    const own = v.ok ? 'Spotify’s own LifecycleAPI.shutdown' : `Spotify’s own quit was unavailable (${clip(v.reason || 'no answer', 100)})`;
    if (v.ok && await gone(o.closeWaitMs)) return { ok: true, forced: false, pids, via: `${own}${pids.length ? ` (${pidWords(pids)})` : ''}` };
    if (!pids.length) {
      return { ok: false, forced: false, pids, via: own,
        detail: `${v.ok ? `it did not quit by itself in ${secs(Date.now() - t0)}` : own}, and ${m.reason}, so Mantle closed nothing by process id`,
        reason: 'Spotify didn’t quit, and Mantle couldn’t tell which program to close. Quit it from its own window' };
    }
    const errs = [];
    for (const pid of pids) { const c = await proc.closePid(pid); if (c.err) errs.push(`${pidWords([pid])}: ${clip(c.err, 100)}`); }
    const asked = `${v.ok ? 'Spotify did not quit by itself, so ' : `${own}, so `}Windows asked ${m.who} (${pidWords(pids)}) to close (taskkill /PID /T without /F${errs.length ? `: ${errs.join('; ')}` : ''})`;
    if (await gone(o.forceAfterMs)) return { ok: true, forced: false, pids, via: asked };
    const waitedMs = Date.now() - t0;
    const kerrs = [];
    for (const pid of pids) { const k = await proc.killPid(pid); if (k.err) kerrs.push(`${pidWords([pid])}: ${clip(k.err, 100)}`); }
    const via = `${asked}; it was still running ${secs(waitedMs)} after the first ask, so Mantle forced that tree closed (taskkill /PID /T /F${kerrs.length ? `: ${kerrs.join('; ')}` : ''})`;
    if (!(await gone(o.forceWaitMs))) {
      return { ok: false, forced: true, pids, via, waitedMs,
        detail: `still running after taskkill /PID /T /F on ${pidWords(pids)}${kerrs.length ? `: ${kerrs.join('; ')}` : ''}`,
        reason: 'Spotify is still running even after Mantle forced it to close. Try again, or end it in Task Manager' };
    }
    return { ok: true, forced: true, pids, via, waitedMs };
  }
  /* The tree Mantle knew is gone: no socket, trim, watch or window record is left pointing at it. */
  function closedTree(why) {
    dropSocket(why);
    if (trimTimer) { clearTimeout(trimTimer); trimTimer = null; }
    clearHideRetry();
    watch.stop(why);
    win = null;
  }

  /* Quit: closeByPid above. Forced only after its own quit and a close request were both ignored, and
     then the card says so (note). A refusal or failure is said. */
  async function quit() {
    if (o.dryRun) return { ok: true, dryRun: true, reason: `dry run: would quit Spotify (its own LifecycleAPI.shutdown, then taskkill /PID <its main pid> /T without /F, forced only if it is still running ${secs(o.forceAfterMs)} later)` };
    if (quitting) return { ok: false, state: 'busy', reason: 'Spotify is already being quit' };
    quitting = true;
    revive.cancel('Spotify was quit from the card');
    try {
      const c = await closeByPid();
      o.log(`quit Spotify: ${c.none ? 'it was not running' : c.ok ? `it is closed${c.forced ? ' (FORCED)' : ''}` : 'it is STILL running'} (${c.via})`);
      if (!c.ok) { if (c.detail) o.log(`quit Spotify: ${scrub(c.detail)}`); dropSocket('Spotify did not quit'); await status().catch(() => null); return { ok: false, state: 'error', forced: c.forced, reason: c.reason }; }
      closedTree('Spotify was quit from the card');
      publish({ ok: false, state: 'notrunning', reason: 'Spotify is not running' });
      return { ok: true, via: c.via, forced: c.forced,
        note: c.forced ? `Spotify didn’t quit on its own within ${secs(c.waitedMs)}, so Mantle closed it. Spotify is closed.` : null };
    } finally { quitting = false; }
  }

  function kindOf(uri) { const m = /^spotify:([a-z]+):/.exec(uri); return m ? m[1] : 'other'; }
  async function library() {
    const v = await page('library', { limit: LIBRARY_MAX });
    if (!v.ok) return refused(v, 'read your library');
    const raw = capList(v.items, LIBRARY_MAX);
    const items = raw.filter((x) => x && CTX_URI_RE.test(x.uri)).map((x) => ({ uri: x.uri, kind: kindOf(x.uri), name: str(x.name, 200) || '(no name)', owner: str(x.owner, 200), image: str(x.image, 300) }));
    await withArt(items);
    return { ok: true, liked: { uri: LIKED_URI, name: 'Liked Songs' }, items, total: num(v.total) || raw.length, skipped: raw.length - items.length, at: Date.now() };
  }

  async function searchAll(a) {
    const q = String((a && a.q) || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
    const none = { ok: true, q, tracks: [], artists: [], albums: [], playlists: [] };
    if (!q) return none;
    if (q.length > 100) return { ok: false, state: 'error', reason: 'that search is longer than 100 characters' };
    const v = await page('searchall', { q, limit: SEARCH_ALL_LIMIT, fallbackHash: SEARCH_ALL_HASH_1_3_0_277 }, o.searchTimeoutMs);
    if (!v.ok) return Object.assign(refused(v, 'search'), { q }, v.code === 'nosearch' ? { reason: 'Search isn’t available in this version of Spotify' } : v.code === 'searchshape' ? { reason: 'Spotify’s search didn’t answer. Try again in a moment' } : {});
    const keep = (arr, kind) => capList(arr, SEARCH_ALL_LIMIT).filter((x) => x && CTX_URI_RE.test(x.uri) && kindOf(x.uri) === kind)
      .map((x) => ({ uri: x.uri, kind, name: str(x.name, 200) || '(no title)', sub: str(x.sub, 200), image: str(x.image, 300) }));
    const out = Object.assign({}, none, { via: v.via, tracks: keep(v.tracks, 'track'), artists: keep(v.artists, 'artist'), albums: keep(v.albums, 'album'), playlists: keep(v.playlists, 'playlist') });
    await withArt(out.tracks.concat(out.artists, out.albums, out.playlists));
    return out;
  }

  /* Play a song, album, artist, playlist or Liked Songs as the new context (Spotify's own play()),
     then check that it is playing it. */
  async function playUri(a) {
    const uri = String((a && a.uri) || '');
    if (uri !== LIKED_URI && !CTX_URI_RE.test(uri)) return { ok: false, state: 'error', reason: 'That isn’t something Spotify can play from Mantle, so nothing was played' };
    if (playing) return { ok: false, state: 'busy', reason: 'still starting the last thing you picked' };
    playing = true;
    try {
      const v = await page('playctx', { uri, verifyMs: o.playVerifyMs });
      if (!v.ok) return refused(v, 'play it');
      const p = v.player, b = v.before;
      const moved = !!p && (!b || p.context !== b.context || p.item !== b.item);
      const verified = !!p && !p.paused && (p.context === uri || p.item === uri || (uri === LIKED_URI && moved));
      o.log(`play ${kindWords(uri)}: ${verified ? 'playing it' : `not confirmed (${p ? (p.paused ? 'paused' : `context ${p.context ? kindWords(p.context) : 'none'}`) : 'no state'})`}`);
      return { ok: true, uri, verified, player: p,
        reason: verified ? null : !p ? 'Spotify took it but did not say what is playing' : p.paused ? 'Spotify took it, but it is paused' : 'Spotify took it, but it is playing something else' };
    } finally { playing = false; }
  }

  async function shuffle(a) {
    const on = !!(a && a.on);
    const v = await page('shuffle', { on, settleMs: 300 });
    if (!v.ok) return refused(v, 'change Shuffle');
    const verified = !!v.player && v.player.shuffle === on;
    o.log(`shuffle ${on ? 'on' : 'off'}: ${verified ? 'done' : 'not confirmed'}`);
    return { ok: true, verified, player: v.player, reason: verified ? null : `Spotify took it, but shuffle is still ${on ? 'off' : 'on'}` };
  }
  async function repeat(a) {
    const mode = Number(a && a.mode);
    if (mode !== 0 && mode !== 1 && mode !== 2) return { ok: false, state: 'error', reason: 'Repeat is off, all or this song, so nothing changed' };
    const v = await page('repeat', { mode, settleMs: 300 });
    if (!v.ok) return refused(v, 'change Repeat');
    const verified = !!v.player && v.player.repeat === mode;
    o.log(`repeat ${mode}: ${verified ? 'done' : 'not confirmed'}`);
    return { ok: true, verified, player: v.player, reason: verified ? null : 'Spotify took it, but its repeat did not change' };
  }
  async function statusAfter(reason) {
    await status().catch(() => null);
    if (last.state !== 'connected') publish(Object.assign({}, last, { reason: `${reason}${last.reason && last.reason !== reason ? ` (now: ${last.reason})` : ''}` }));
    return { ok: false, state: last.state, reason };
  }

  async function start() {
    if (starting) return { ok: false, state: 'starting', reason: 'Spotify is already being started' };
    if (!proc.exists(o.exe)) return statusFromClosed().then((s) => ({ ok: false, state: s.state, reason: s.reason }));
    let pids;
    try { pids = await proc.running(); } catch (e) { detail('the process list failed', e.message); return { ok: false, state: 'error', reason: WORDS.unsure }; }
    if (pids.length) return { ok: false, state: 'noport', reason: 'Spotify is already running: use Restart instead (a second start only wakes the running one)' };
    if (o.dryRun) return { ok: true, dryRun: true, reason: `dry run: would start ${o.exe} ${FLAG} ${HIDDEN_ARGS.join(' ')} and hide its window` };
    revive.cancel('Spotify was started from the card');
    starting = true;
    return startWithPort([], 'Starting', true);
  }
  /* spotdeath lane: the one start that is not a click: after a game, for a hidden Spotify that closed
     during it (./_spotify-revive.js decides). Hidden, and NOT playing: Owen presses play. */
  async function relaunchHidden(why) {
    if (starting) return { ok: false, reason: 'Spotify is already being started' };
    if (!proc.exists(o.exe)) return { ok: false, reason: 'Spotify isn’t installed where Mantle starts it from' };
    const pids = await proc.running().catch(() => null);
    if (pids && pids.length) return { ok: false, reason: 'Spotify is already running' };
    if (o.dryRun) return { ok: true, dryRun: true, reason: `dry run: would start ${o.exe} ${FLAG} ${HIDDEN_ARGS.join(' ')} ${why}` };
    starting = true;
    const r = await startWithPort([], 'Starting', true, why);
    return r && r.ok ? r : { ok: false, reason: (r && r.reason) || last.reason || 'no reason given' };
  }

  /* ---------------------------------------------------------------- closed for a game (spotgame lane)
     Owen: "for the spotify thing i closed it myself to save ram" (~300 MB, in Valorant). When Mantle
     starts resting for a known game (lib/features.js onRest: game mode's own watch, not a second one)
     and the card's "Close Spotify while I game" is on, Mantle's OWN Spotify (started or taken over by
     it; hidden, or showing) is closed if NOTHING plays, the clean way the card's Quit does (Spotify's own
     LifecycleAPI.shutdown; then WM_CLOSE to ITS pid tree, never /F, never by image name), and started
     again hidden and not playing after the game (./_spotify-revive.js). Kept open, and said, when
     music plays (Spotify's own player state, or the media session), when that cannot be read, or when
     the Spotify is not Mantle's. Once per game session. Log lines: pids, states, game names only. */
  let gameBusy = false;
  function mediaSays() {
    if (typeof o.mediaPlaying !== 'function') return null;
    try { const m = o.mediaPlaying(); return m === true ? true : m === false ? false : null; } catch (_) { return null; }
  }
  async function gameRest(e) {
    const on = !!(e && e.on), why = String((e && e.why) || (on ? 'a game runs' : 'the game exited'));
    if (!on) { revive.gameOver(why); return { ok: true, action: 'wake' }; }
    if (!closeOn()) { o.log(`a game started (${why}): “${CLOSE_TOGGLE}” is off, so Spotify is left alone`); return { ok: true, action: 'off' }; }
    if (gameBusy) return { ok: true, action: 'busy' };
    gameBusy = true;
    try { return await closeForGame(why, Date.now()); } finally { gameBusy = false; }
  }
  async function closeForGame(why, t0) {
    let list;
    try { list = await proc.games(); } catch (err) {
      o.log(`a game started (${why}), but Mantle could not tell which (${err.message}); Spotify is left alone`);
      return { ok: false, action: 'noscan', reason: err.message };
    }
    if (!list.length) return { ok: true, action: 'nogame' };          // game mode on by hand, no known game
    const s = revive.session(list);
    const game = s.game || 'the game';
    if (!s.first) return { ok: true, action: 'same', game };          // once per game session
    const keep = (reason, logWhy) => {
      revive.kept(game, reason);
      o.log(`Spotify was kept open for ${game}: ${logWhy || reason}`);
      return { ok: true, action: 'kept', game, reason, ms: Date.now() - t0 };
    };
    // spotfix lane: a Spotify Mantle is still hiding, or gave up hiding, is Mantle's too
    const pid = mine() && (win.state === 'hidden' || win.state === 'shown' || win.state === 'hiding' || (win.state === 'failed' && win.own)) ? win.pid : 0;
    if (!pid) {
      let pids = null;
      try { pids = await proc.running(); } catch (err) { return keep('Mantle couldn’t tell whether Spotify was running', `the process list failed (${scrub(err.message, 160)})`); }
      if (!pids.length) { o.log(`${game} started: Spotify is not running, so there is nothing to close`); return { ok: true, action: 'notrunning', game }; }
      return keep(`this Spotify was not started by Mantle, so Mantle leaves it alone while ${game} runs`, `${pids.length} Spotify process${pids.length === 1 ? '' : 'es'}, none started by Mantle`);
    }
    if (starting || quitting) return keep(`Spotify was being started or quit when ${game} started`);
    const st = await page('state', {}, o.evalTimeoutMs, true);
    const media = mediaSays();
    const cdp = st.ok && st.player ? (!!st.player.hasItem && !st.player.paused) : null;
    const said = (x) => (x == null ? 'unknown' : x ? 'playing' : 'not playing');
    if (cdp === true || media === true) return keep(`music was playing when ${game} started`, `music was playing (Spotify: ${said(cdp)}, media session: ${said(media)})`);
    if (cdp == null) {
      const r = clip(st.reason || 'Spotify gave no answer', 160);
      return keep(`Mantle couldn’t tell whether music was playing when ${game} started`, `whether music plays is unknown (Spotify: ${scrub(st.detail || r, 160)}; media session: ${said(media)})`);
    }
    revive.closing(game);
    const r = await closeMine(pid, game);
    const ms = Date.now() - t0;
    if (!r.ok) {
      revive.closeFailed(game, r.short || r.reason);
      o.log(`Spotify (pid ${pid}) could NOT be closed for ${game} (${ms} ms): ${r.reason}`);
      return { ok: false, action: 'failed', game, reason: r.reason, ms };
    }
    revive.closed({ pid, game, key: s.key, dryRun: !!r.dryRun });
    o.log(`closed the ${r.shown ? 'showing' : 'hidden'} Spotify (pid ${pid}) for ${game} in ${ms} ms${r.dryRun ? ' [dry run]' : ''}: nothing was playing (Spotify: not playing, media session: ${said(media)}); via ${r.via}; it is started again, hidden and not playing, when the game exits`);
    return { ok: true, action: 'closed', game, ms, dryRun: !!r.dryRun };
  }
  /* The game close, for ONE pid: Spotify's own shutdown, then WM_CLOSE to that pid's tree. Never forced
     (only a click on the card's Quit or Restart may force, see closeByPid). */
  async function closeMine(pid, game) {
    const shown = !!(win && win.state === 'shown');
    if (o.dryRun) return { ok: true, dryRun: true, shown, via: `dry run: would quit Spotify (its own LifecycleAPI.shutdown, then taskkill /PID ${pid} /T without /F)` };
    quitting = true;
    try {
      const alive = async () => { const p = await proc.running().catch(() => null); return p == null ? null : p.includes(pid); };
      const gone = async (ms) => { const until = Date.now() + ms; while (Date.now() < until) { await delay(Math.min(150, o.pollMs)); if ((await alive()) === false) return true; } return false; };
      const v = await page('quit', {}, o.evalTimeoutMs, true);
      let how = v.ok ? 'Spotify’s own LifecycleAPI.shutdown' : null;
      let done = v.ok ? await gone(o.closeWaitMs) : false;
      if (!done) {
        const c = typeof proc.closePid === 'function' ? await proc.closePid(pid) : { err: 'this Mantle cannot close one Spotify by its process id' };
        how = `${v.ok ? 'Spotify did not quit by itself, so ' : `Spotify’s own quit was unavailable (${clip(v.reason || 'no answer', 100)}), so `}Windows asked pid ${pid} to close (taskkill /PID /T without /F${c.err ? `: ${clip(c.err, 100)}` : ''})`;
        done = await gone(o.closeWaitMs);
      }
      if (!done) {
        await status().catch(() => null);
        // the card gets the short why; the log gets every step
        return { ok: false, reason: `it is still running after ${how}, and Mantle does not force it closed`,
          short: v.ok ? 'it ignored its own quit and a close request' : 'its own quit was unavailable and it ignored a close request' };
      }
      dropSocket(`Spotify was closed for ${game}`);
      if (trimTimer) { clearTimeout(trimTimer); trimTimer = null; }
      clearHideRetry();
      watch.stop(`Spotify was closed for ${game}`);
      win = null;
      publish({ ok: false, state: 'notrunning', reason: `Spotify is not running: Mantle closed it for ${game} to save memory` });
      return { ok: true, shown, via: how };
    } finally { quitting = false; }
  }

  /* Close the running Spotify by its main pid (closeByPid: its own quit, then WM_CLOSE to that tree,
     forced on that tree only if it is still running forceAfterMs later, and then SAID in the note);
     then start it with the port, minimized when it was minimized before. Playback stops: the card
     says so first. */
  async function restart() {
    if (starting) return { ok: false, state: 'starting', reason: 'Spotify is already being restarted' };
    if (!proc.exists(o.exe)) return statusFromClosed().then((s) => ({ ok: false, state: s.state, reason: s.reason }));
    if (o.dryRun) return { ok: true, dryRun: true, reason: `dry run: would close Spotify by its main pid (its own quit, then taskkill /PID /T without /F, forced only if it is still running ${secs(o.forceAfterMs)} later) and start ${o.exe} ${FLAG}` };
    if (quitting) return { ok: false, state: 'busy', reason: 'Spotify is being quit right now, so it was not restarted' };
    revive.cancel('Spotify was restarted from the card');
    starting = true;
    try {
      const wasVisible = await proc.visible().catch(() => true);
      publish({ ok: false, state: 'starting', reason: 'Closing Spotify…' });
      const c = await closeByPid();
      o.log(`restart Spotify: ${c.none ? 'it was not running' : c.ok ? `it is closed${c.forced ? ' (FORCED)' : ''}` : 'it is STILL running, so it was not started again'} (${c.via})`);
      if (!c.ok) { if (c.detail) o.log(`restart Spotify: ${scrub(c.detail)}`); starting = false; return Object.assign(await statusAfter(c.reason), { forced: c.forced }); }
      if (!c.none) closedTree('Spotify was restarted from the card');
      const closeNote = c.forced ? `Spotify didn’t close on its own within ${secs(c.waitedMs)}, so Mantle closed it before starting it again` : '';
      await delay(400);
      const r = await startWithPort(wasVisible ? [] : ['--minimized'], 'Restarting');
      if (!r.ok && closeNote) r.reason = `${r.reason}. Before that: ${closeNote}`;
      return Object.assign(r, { forced: c.forced, note: [closeNote, r.note].filter(Boolean).join('. ') || null });
    } catch (e) {
      starting = false;
      detail('the restart threw', e.message);
      return statusAfter('Mantle couldn’t restart Spotify. Try again');
    }
  }

  function stop(why) { epoch += 1; dropSocket('Mantle stopped the Spotify queue'); art.clear(); if (trimTimer) { clearTimeout(trimTimer); trimTimer = null; } clearHideRetry(); watch.stop(why || 'the Spotify feature stopped'); revive.stop(); }
  /* The feature came back on: watch again if the Spotify Mantle started is still hidden, or look for
     one an earlier Mantle started (spadopt lane); a hide still being tried goes on (spotfix lane). */
  function resume() {
    if (win && win.state === 'hiding' && win.pid) { win = Object.assign({}, win, { trying: false, retryAt: Date.now() + (o.hideRetryMs[0] || 2000) }); armHide(win.pid, o.hideRetryMs[0] || 2000); }
    else if (win && win.state === 'hidden' && win.pid) watchStart(win.pid, 'the Spotify feature is on again', win.created);
    else if (!win || win.takeOverFailed) takeOver('the Spotify feature is on again').catch((e) => o.log(`the Spotify takeover threw: ${(e && e.stack) || e}`));
  }

  return { status, queue, play, add, remove, move, search, start, restart, stop, last: () => last, port: o.port, flag: FLAG,
    info, library, searchAll, playUri, shuffle, repeat, like, openWindow, hideWindow, quit, adopt, takeOver, resume, opening, window: () => winView(), watch,
    revive, reviveToggled: () => revive.toggled(), gameRest, closeToggled: () => revive.toggled() };
}

module.exports = { createSpotifyApp, realProc, defaultExe, launchBus, PAGE, PAGE_SRC, PORT, FLAG, HIDDEN_ARGS, URI_RE, ROW_URI_RE, UID_RE, CTX_URI_RE, LIKED_URI,
  SEARCH_HASH_1_3_0_277, SEARCH_ALL_HASH_1_3_0_277, SIGNATURE, ADOPTED, cmdTokens, pickMantleSpotify, fileTimeMs };
