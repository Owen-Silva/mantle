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
 * Nothing here runs on its own: no timer, no poll. The card asks while its list is open; a start or
 * restart waits (bounded) for the port to come up.
 */
const http = require('http');
const cp = require('child_process');
const fs = require('fs');
const path = require('path');

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

function delay(ms) { return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve(); }
function clip(s, n) { s = s == null ? '' : String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

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
      if (!root) return { missing: 'Spotify’s page has no React root yet (still loading?)' };
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
      if (!pl) return { missing: (platform ? 'the Platform object was found but it gave no PlayerAPI' : 'no Platform object in ' + seen + ' React nodes') };
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
    if (c.missing) return { ok: false, code: 'internals', reason: c.missing, version: cut(navigator.userAgent.match(/Spotify\/[\d.]+/), 40) };
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
  return {
    exists(exe) { try { return fs.statSync(exe).isFile(); } catch (e) { return false; } },
    async running() {
      const r = await run('tasklist.exe', ['/FI', 'IMAGENAME eq Spotify.exe', '/FO', 'CSV', '/NH'], 6000);
      if (r.err && !r.out) throw new Error(`tasklist failed (${r.err.message})`);
      return rows(r.out).map((c) => Number(c[1])).filter((n) => n > 0);
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
    /* WM_CLOSE to Spotify's windows (taskkill WITHOUT /F), the way Windows asks an app to quit */
    async close() { const r = await run('taskkill.exe', ['/IM', 'Spotify.exe'], 8000); return { out: r.out.trim(), err: r.err ? r.err.message : null }; },
    async kill() { const r = await run('taskkill.exe', ['/F', '/T', '/IM', 'Spotify.exe'], 8000); return { out: r.out.trim(), err: r.err ? r.err.message : null }; },
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
  }, opts || {});
  const proc = o.proc || realProc(o);
  let last = { ok: true, state: 'checking', reason: 'checking Spotify…', port: o.port };
  let ws = null, wsUrl = '', nextId = 1, starting = false, playing = false;
  const pending = new Map();
  const art = new Map();
  let lastSig = '';

  function publish(st) {
    last = Object.assign({ port: o.port }, st);
    const sig = last.state + '\u0001' + (last.reason || '');
    if (sig !== lastSig) { lastSig = sig; o.log(`status ${last.state}${last.reason ? ': ' + last.reason : ''}`); try { o.onStatus(last); } catch (e) { /* page gone */ } }
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
    const t = pages.find((x) => /^https:\/\/xpui\.app\.spotify\.com\//.test(x.url)) || pages.find((x) => /spotify/i.test(x.url));
    if (!t) return { busy: `port ${o.port} is a debugging port, but none of its ${list.length} page(s) is Spotify’s` };
    const m = /^ws:\/\/(?:127\.0\.0\.1|localhost):(\d+)(\/devtools\/page\/[A-Za-z0-9._-]{1,80})$/.exec(t.webSocketDebuggerUrl);
    if (!m || Number(m[1]) !== o.port) return { busy: `Spotify’s page gave an unexpected socket address (${clip(t.webSocketDebuggerUrl, 80)})` };
    return { url: `ws://${o.host}:${o.port}${m[2]}` };
  }

  function dropSocket(why) {
    const w = ws;
    ws = null; wsUrl = '';
    for (const [, p] of pending) { clearTimeout(p.timer); p.reject(Object.assign(new Error(why), { code: 'ECLOSED' })); }
    pending.clear();
    if (w) { try { w.close(); } catch (e) { /* already */ } }
  }
  function open(url) {
    if (ws && wsUrl === url && ws.readyState === 1) return Promise.resolve(ws);
    if (ws) dropSocket('Spotify’s page changed');
    if (!o.WebSocket) return Promise.reject(new Error('this Node has no built-in WebSocket'));
    return new Promise((resolve, reject) => {
      let done = false;
      const s = new o.WebSocket(url);
      const timer = setTimeout(() => { if (done) return; done = true; try { s.close(); } catch (e) { /* */ } reject(new Error(`Spotify’s page did not accept the connection within ${o.openTimeoutMs} ms`)); }, o.openTimeoutMs);
      s.addEventListener('open', () => { if (done) return; done = true; clearTimeout(timer); ws = s; wsUrl = url; resolve(s); });
      s.addEventListener('error', () => { if (!done) { done = true; clearTimeout(timer); reject(new Error('Spotify’s page refused the connection')); } });
      s.addEventListener('close', () => { if (ws === s) dropSocket('Spotify closed the connection (it quit or reloaded)'); });
      s.addEventListener('message', (ev) => {
        let m; try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')); } catch (e) { return; }
        const p = m && pending.get(m.id);
        if (!p) return;
        pending.delete(m.id); clearTimeout(p.timer);
        if (m.error) p.reject(new Error(`Spotify’s debugger said: ${clip(m.error.message || JSON.stringify(m.error), 160)}`));
        else p.resolve(m.result || {});
      });
    });
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
  async function page(op, arg, ms, quiet) {
    if (starting && !quiet) return { ok: false, state: 'starting', reason: last.reason || 'Spotify is starting', env: true };
    const fail = (state, reason) => { if (!quiet) publish({ ok: false, state, reason }); return { ok: false, state, reason, env: true }; };
    const t = await findTarget();
    if (t.closed) {
      if (quiet) return { ok: false, state: 'noport', reason: t.closed, env: true };
      const s = await statusFromClosed();
      return { ok: false, state: s.state, reason: s.reason, env: true };
    }
    if (t.busy) return fail('portbusy', t.busy);
    try { await open(t.url); } catch (e) { return fail('error', e.message); }
    const expression = '(' + PAGE_SRC + ')(' + JSON.stringify(op) + ',' + JSON.stringify(arg || {}) + ')';
    let r;
    try { r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, silent: true }, ms || o.evalTimeoutMs); }
    catch (e) { return { ok: false, state: 'error', reason: e.message, transport: true }; }
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      return { ok: false, state: 'error', reason: `Spotify’s page threw: ${clip((d.exception && d.exception.description) || d.text || 'no detail', 200)}` };
    }
    const v = r.result && r.result.value;
    if (!v || typeof v !== 'object') return { ok: false, state: 'error', reason: 'Spotify’s page gave no answer' };
    if (v.code === 'internals') return fail('internals', `Spotify is reachable, but its queue functions were not found: ${v.reason}${v.version ? ` (${v.version})` : ''}. A Spotify update probably moved them`);
    if (!quiet && v.ok && last.state !== 'connected') publish({ ok: true, state: 'connected', reason: null, via: v.via || last.via, caps: v.caps || last.caps, version: v.version || last.version });
    return v;
  }

  async function statusFromClosed() {
    if (!proc.exists(o.exe)) {
      return publish({ ok: false, state: 'noinstall', reason: `Mantle starts Spotify from ${o.exe}, and it is not there (the Microsoft Store Spotify cannot be started with a debugging port)` });
    }
    let pids;
    try { pids = await proc.running(); } catch (e) { return publish({ ok: false, state: 'error', reason: `could not tell whether Spotify is running (${e.message})` }); }
    if (!pids.length) return publish({ ok: false, state: 'notrunning', reason: 'Spotify is not running' });
    return publish({ ok: false, state: 'noport', reason: 'Spotify is running, but it was not started by Mantle, so Up next cannot reach it' });
  }

  /* ---------------------------------------------------------------- artwork (the bar's CSP takes data: only) */
  function artUrl(u) {
    const s = String(u || '');
    let m = /^spotify:image:([0-9a-f]{16,64})$/i.exec(s);
    if (m) return `https://i.scdn.co/image/${m[1]}`;
    try {
      const x = new URL(s);
      if (x.protocol === 'https:' && /(^|\.)scdn\.co$|(^|\.)spotifycdn\.com$/i.test(x.hostname)) return x.href;
    } catch (e) { /* not a URL */ }
    return null;
  }
  async function artOf(u) {
    const url = artUrl(u);
    if (!url) return { why: u ? 'the artwork address is not Spotify’s image server' : 'Spotify gave no artwork for it' };
    if (art.has(url)) return art.get(url);
    let got;
    try {
      if (!o.fetch) throw new Error('no fetch');
      const res = await o.fetch(url, { signal: AbortSignal.timeout(5000) });
      const type = String(res.headers.get('content-type') || '').split(';')[0].trim();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (!/^image\//.test(type)) throw new Error(`not an image (${type || 'no type'})`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > ART_MAX_BYTES) throw new Error(`too big (${buf.length} bytes)`);
      got = { data: `data:${type};base64,${buf.toString('base64')}` };
    } catch (e) { got = { why: `the artwork did not load (${(e && e.message) || e})` }; }
    art.set(url, got);
    if (art.size > ART_CACHE_MAX) art.delete(art.keys().next().value);
    return got;
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
    return { uri: x.uri, uid: UID_RE.test(x.uid || '') ? x.uid : '', name: x.name || '(no title)', artists: x.artists || '',
      kind: /^spotify:episode:/.test(x.uri) ? 'episode' : /^spotify:local:/.test(x.uri) ? 'local' : 'track', where, provider: x.provider || '', image: x.image || '' };
  }

  /* ---------------------------------------------------------------- commands */
  async function status() {
    if (starting) return last;
    const v = await page('probe', {});
    if (v.ok) return publish({ ok: true, state: 'connected', reason: null, via: v.via, caps: v.caps, version: v.version });
    if (v.env) return last;
    return publish({ ok: false, state: 'error', reason: v.reason });
  }

  async function readQueue() {
    const v = await page('queue', { queuedMax: QUEUED_MAX, nextUpMax: NEXTUP_MAX });
    if (!v.ok) return v;
    return {
      ok: true, caps: v.caps || {}, current: v.current && ROW_URI_RE.test(v.current.uri) ? row(v.current, 'current') : null,
      queued: (v.queued || []).map((x) => row(x, 'queued')).filter(Boolean),
      nextUp: (v.nextUp || []).map((x) => row(x, 'next')).filter(Boolean),
      totalQueued: v.totalQueued || 0, totalNextUp: v.totalNextUp || 0,
    };
  }

  async function queue() {
    const q = await readQueue();
    if (!q.ok) return Object.assign({ state: q.state || 'error' }, q, { reason: q.reason || 'the queue could not be read' });
    await withArt(q.queued.concat(q.nextUp));
    return Object.assign(q, { state: 'connected', at: Date.now() });
  }

  function checkRow(a, what) {
    const uri = String((a && a.uri) || '');
    const uid = String((a && a.uid) || '');
    if (!ROW_URI_RE.test(uri)) return { ok: false, state: 'error', reason: `"${clip(uri, 60)}" is not a Spotify song address, so it was not ${what}` };
    if (uid && !UID_RE.test(uid)) return { ok: false, state: 'error', reason: `that queue entry id is malformed, so it was not ${what}` };
    return null;
  }
  const refused = (r) => Object.assign({ state: 'error' }, r, { reason: r.env || r.transport ? r.reason : `Spotify refused: ${r.reason}` });
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
        if ((again.current ? again.current.uri : null) !== before) return { ok: false, state: 'error', reason: `Spotify’s skipTo failed (${r.reason}) and the song changed anyway` };
        const p2 = again.queued.concat(again.nextUp).findIndex((x) => same(x, want));
        if (p2 < 0) return { ok: false, state: 'moved', reason: 'that song left the queue while Mantle was jumping to it' };
        const n = p2 + 1;
        if (n > MAX_SKIP) return { ok: false, state: 'error', reason: `Spotify’s skipTo failed (${r.reason}), and it is ${n} songs away (Mantle skips at most ${MAX_SKIP})` };
        for (let i = 0; i < n; i++) {
          const s = await page('next', {});
          if (!s.ok) return { ok: false, state: s.state || 'error', reason: `stopped after ${i} of ${n} skips: ${s.reason}` };
          if (i < n - 1) await delay(o.stepDelayMs);
        }
        how = 'next'; note = `skipTo failed (${r.reason}), so Mantle skipped ${n} time${n > 1 ? 's' : ''}`;
      }
      await delay(o.verifyDelayMs);
      const v = await readQueue();
      const now = v.ok ? v.current : null;
      const verified = !!(now && now.uri === want.uri);
      o.log(`play ${want.uri} via ${how}: ${verified ? 'now playing it' : `now playing ${now ? now.uri : 'unknown'}`}`);
      return { ok: true, uri: want.uri, via: how, note, verified,
        reason: verified ? null : `Spotify took the jump but ${now ? `is playing “${now.name}”` : 'did not say what is playing'}, not “${name}”` };
    } finally { playing = false; }
  }

  async function add(a) {
    const uri = String((a && a.uri) || '');
    if (!URI_RE.test(uri)) return { ok: false, state: 'error', reason: `"${clip(uri, 60)}" is not a Spotify song or episode address, so nothing was added` };
    const before = await readQueue();
    if (!before.ok) return before;
    const r = await page('add', { uris: [uri] });
    if (!r.ok) return refused(r);
    const after = await readQueue();
    const count = (q) => q.queued.filter((x) => x.uri === uri).length;
    const verified = after.ok && (count(after) > count(before) || after.totalQueued > before.totalQueued);
    o.log(`added ${uri}${verified ? '' : ' (not seen in the queue afterwards)'}`);
    return { ok: true, uri, verified, reason: verified ? null : 'Spotify accepted it, but it does not show in the queue yet' };
  }

  async function remove(a) {
    const bad = checkRow(a, 'removed'); if (bad) return bad;
    const want = { uri: String(a.uri), uid: String(a.uid || '') };
    const before = await readQueue();
    if (!before.ok) return before;
    const all = (q) => q.queued.concat(q.nextUp);
    if (!all(before).some((x) => same(x, want))) return { ok: false, state: 'moved', reason: 'that song is not in the queue any more' };
    if (before.caps && before.caps.remove === false) return { ok: false, state: 'error', reason: 'this Spotify has no removeFromQueue(), so songs cannot be removed from Mantle' };
    const r = await page('remove', want);
    if (!r.ok) return refused(r);
    const after = await readQueue();
    const n = (q) => all(q).filter((x) => same(x, want)).length;
    const verified = after.ok && n(after) < n(before);
    o.log(`removed ${want.uri}${verified ? '' : ' (still listed afterwards)'}`);
    return { ok: true, uri: want.uri, verified, reason: verified ? null : 'Spotify accepted it, but the song is still listed' };
  }

  async function move(a) {
    const bad = checkRow(a, 'moved'); if (bad) return bad;
    const dir = a && a.dir;
    if (dir !== 'up' && dir !== 'down') return { ok: false, state: 'error', reason: 'a move is "up" or "down"' };
    const want = { uri: String(a.uri), uid: String(a.uid || '') };
    const q = await readQueue();
    if (!q.ok) return q;
    if (q.caps && q.caps.move === false) return { ok: false, state: 'error', reason: 'this Spotify has no reorderQueue(), so the queue cannot be reordered from Mantle' };
    const i = q.queued.findIndex((x) => same(x, want));
    if (i < 0) return { ok: false, state: 'moved', reason: 'only songs you queued can be moved, and that one is not in your queue any more' };
    const j = dir === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= q.queued.length) return { ok: false, state: 'error', reason: `it is already ${dir === 'up' ? 'first' : 'last'} in your queue` };
    const other = q.queued[j];
    const item = { uri: want.uri, uid: want.uid };
    const ref = { uri: other.uri, uid: other.uid };
    const r = await page('move', dir === 'up' ? { item, before: ref } : { item, after: ref });
    if (!r.ok) return refused(r);
    const after = await readQueue();
    const k = after.ok ? after.queued.findIndex((x) => same(x, want)) : -1;
    const verified = k === j;
    o.log(`moved ${want.uri} ${dir}: ${verified ? 'done' : `now at ${k}`}`);
    return { ok: true, uri: want.uri, verified, reason: verified ? null : 'Spotify accepted the move, but the order did not change' };
  }

  async function search(a) {
    const q = String((a && a.q) || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
    if (!q) return { ok: true, items: [], q };
    if (q.length > 100) return { ok: false, state: 'error', reason: 'that search is longer than 100 characters' };
    const v = await page('search', { q, limit: SEARCH_LIMIT, fallbackHash: SEARCH_HASH_1_3_0_277 }, o.searchTimeoutMs);
    if (!v.ok) return Object.assign({ state: 'error' }, v, { q, reason: v.code === 'searchshape' || v.code === 'nosearch' ? `Search is unavailable: ${v.reason}` : v.reason });
    const items = (v.items || []).filter((x) => x && URI_RE.test(x.uri)).map((x) => ({ uri: x.uri, name: x.name || '(no title)', artists: x.artists || '', kind: /^spotify:episode:/.test(x.uri) ? 'episode' : 'track', image: x.image || '' }));
    await withArt(items);
    return { ok: true, items, q, via: v.via };
  }

  /* ---------------------------------------------------------------- starting Spotify with the port */
  async function waitForPort() {
    const until = Date.now() + o.startWaitMs;
    let why = 'the debugging port never opened';
    while (Date.now() < until) {
      await delay(o.pollMs);
      const t = await findTarget();
      if (t.busy) { why = t.busy; continue; }
      if (t.closed) continue;
      const v = await page('probe', {}, o.evalTimeoutMs, true);
      if (v.ok) return { ok: true, via: v.via, caps: v.caps, version: v.version };
      why = v.reason || why;
    }
    return { ok: false, reason: why };
  }
  async function startWithPort(extraArgs, verb) {
    publish({ ok: false, state: 'starting', reason: `${verb} Spotify with Up next’s port…` });
    const l = await proc.launch(o.exe, [FLAG].concat(extraArgs || []));
    if (!l.ok) { starting = false; return statusAfter(`Spotify did not start: ${l.reason}`); }
    const w = await waitForPort();
    starting = false;
    if (w.ok) { publish({ ok: true, state: 'connected', reason: null, via: w.via, caps: w.caps, version: w.version }); return { ok: true }; }
    return statusAfter(`Spotify started, but Up next could not reach it within ${Math.round(o.startWaitMs / 1000)} s: ${w.reason}. This Spotify build may ignore --remote-debugging-port`);
  }
  async function statusAfter(reason) {
    await status().catch(() => null);
    if (last.state !== 'connected') publish(Object.assign({}, last, { reason: `${reason}${last.reason && last.reason !== reason ? ` (now: ${last.reason})` : ''}` }));
    return { ok: false, state: last.state, reason };
  }

  async function start() {
    if (starting) return { ok: false, state: 'starting', reason: 'Spotify is already being started' };
    if (!proc.exists(o.exe)) return statusFromClosed().then((s) => ({ ok: false, state: s.state, reason: s.reason }));
    const pids = await proc.running().catch((e) => { throw new Error(`could not tell whether Spotify is running (${e.message})`); });
    if (pids.length) return { ok: false, state: 'noport', reason: 'Spotify is already running: use Restart instead (a second start only wakes the running one)' };
    if (o.dryRun) return { ok: true, dryRun: true, reason: `dry run: would start ${o.exe} ${FLAG}` };
    starting = true;
    return startWithPort([], 'Starting');
  }

  /* Close the running Spotify politely (WM_CLOSE), and only if it refuses, end it; then start it with
     the port, minimized when it was minimized before. Playback stops: the card says so first. */
  async function restart() {
    if (starting) return { ok: false, state: 'starting', reason: 'Spotify is already being restarted' };
    if (!proc.exists(o.exe)) return statusFromClosed().then((s) => ({ ok: false, state: s.state, reason: s.reason }));
    if (o.dryRun) return { ok: true, dryRun: true, reason: `dry run: would close Spotify (WM_CLOSE, force only if it refuses) and start ${o.exe} ${FLAG}` };
    starting = true;
    let forced = false, closeNote = '';
    try {
      const wasVisible = await proc.visible().catch(() => true);
      publish({ ok: false, state: 'starting', reason: 'Closing Spotify…' });
      const c = await proc.close();
      let until = Date.now() + o.closeWaitMs, pids = [1];
      while (Date.now() < until) { await delay(300); pids = await proc.running().catch(() => [1]); if (!pids.length) break; }
      if (pids.length) {
        await proc.kill();
        forced = true;
        closeNote = `Spotify did not quit when asked (${clip(c.err || c.out || 'no answer', 120)}; its close button probably minimizes it to the tray), so Mantle ended it`;
        o.log(closeNote);
        until = Date.now() + 5000;
        while (Date.now() < until) { await delay(300); pids = await proc.running().catch(() => [1]); if (!pids.length) break; }
        if (pids.length) { starting = false; return statusAfter('Spotify would not close, even when ended (taskkill /F)'); }
      }
      await delay(400);
      const r = await startWithPort(wasVisible ? [] : ['--minimized'], 'Restarting');
      return Object.assign(r, { forced, note: closeNote || null });
    } catch (e) {
      starting = false;
      return statusAfter(`the restart failed: ${e.message}`);
    }
  }

  function stop() { dropSocket('Mantle stopped the Spotify queue'); art.clear(); }

  return { status, queue, play, add, remove, move, search, start, restart, stop, last: () => last, port: o.port, flag: FLAG };
}

module.exports = { createSpotifyApp, realProc, defaultExe, PAGE, PAGE_SRC, PORT, FLAG, URI_RE, ROW_URI_RE, UID_RE, SEARCH_HASH_1_3_0_277 };
