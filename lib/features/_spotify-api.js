'use strict';
/* _spotify-api.js - the Spotify half of the now-playing card's "Up next" queue (spotq lane,
 * 2026-09-25). No Electron in here: lib/features/spotify.js hands in the vault (safeStorage), the
 * browser opener and the settings, and lib/features/spotify.test.js hands in a fake Spotify.
 *
 * WHY THE WEB API. Windows' media session (SMTC, sidecar/Media.cs) has no queue at all. The only
 * clean source is Spotify's Web API, signed in with Authorization Code + PKCE (no client secret),
 * on Owen's OWN developer app (his Client ID; nobody else's may be used). Rules as read on
 * developer.spotify.com on 2026-09-25:
 *   - development mode: the app OWNER must have Premium, one dev Client ID per developer, at most
 *     5 users (web-api/concepts/quota-modes, tutorials/february-2026-migration-guide)
 *   - redirect: an explicit loopback literal over http (http://127.0.0.1:PORT/...); "localhost" is
 *     refused (web-api/concepts/redirect_uri)
 *   - GET /me/player/queue: user-read-playback-state; POST /me/player/queue and POST
 *     /me/player/next: user-modify-playback-state AND Premium; search limit is now at most 10
 *   - there is NO endpoint to remove or reorder a queue item. The card says so; nothing is faked.
 *
 * Every failure comes back as { ok:false, state, reason } in plain words, never a throw and never
 * a silent empty list. The refresh token is never logged and never written unencrypted (the vault
 * refuses when encryption is unavailable).
 */
const crypto = require('crypto');
const http = require('http');

const PORT = 47291;
const CALLBACK_PATH = '/callback';
const SCOPES = ['user-read-playback-state', 'user-modify-playback-state'];
const MAX_SKIP = 20;           // the queue endpoint lists about 20; a play further down is refused
const QUEUE_MAX = 20;
const SEARCH_LIMIT = 8;        // Spotify's cap is 10 since February 2026
const ART_MAX_BYTES = 256 * 1024;
const ART_CACHE_MAX = 200;
const URI_RE = /^spotify:(track|episode):[A-Za-z0-9]{22}$/;
const CLIENT_ID_RE = /^[0-9a-f]{32}$/i;

function b64url(buf) { return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function pkcePair() {
  const verifier = b64url(crypto.randomBytes(64));                       // 86 chars, in RFC 7636's alphabet
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}
function delay(ms) { return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve(); }

/* An error that already knows which state the card should show. */
function spErr(state, reason, extra) { const e = new Error(reason); e.spState = state; if (extra) Object.assign(e, extra); return e; }
function fail(e) {
  return { ok: false, state: (e && e.spState) || 'error', reason: (e && e.message) || String(e), ...(e && e.skipped != null ? { skipped: e.skipped } : {}) };
}
function netWhy(e) {
  const c = (e && e.cause && (e.cause.code || e.cause.message)) || (e && (e.code || e.name)) || '';
  if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) return 'it did not answer in time';
  return String(c || (e && e.message) || e);
}

function createSpotify(opts) {
  const o = Object.assign({
    accountsBase: 'https://accounts.spotify.com',
    apiBase: 'https://api.spotify.com/v1',
    port: PORT,
    timeoutMs: 8000,
    consentTimeoutMs: 5 * 60 * 1000,
    stepDelayMs: 250,          // between the skips of a "play this one"
    verifyDelayMs: 700,        // before reading back what is playing after them
    fetch: (...a) => fetch(...a),
    log: () => {},
    onStatus: () => {},
    openExternal: async () => { throw new Error('no browser opener was given'); },
  }, opts || {});
  const vault = o.vault, settings = o.settings;
  const redirectUri = `http://127.0.0.1:${o.port}${CALLBACK_PATH}`;

  let tok = null;              // { access, exp } - memory only
  let refreshing = null;       // one refresh in flight, shared
  let pending = null;          // the open consent: { server, verifier, state, timer, since }
  let lastReason = '';         // why the last sign-in ended or was dropped, said by status()
  let expired = false;
  let playing = false;         // one "play this one" at a time
  const art = new Map();       // image url -> { data } | { why }

  function clientId() { return String(settings.get('clientId', '') || ''); }
  function saved() {
    try { return vault.load(); } catch (e) { lastReason = `the saved sign-in could not be read (${e.message})`; return null; }
  }
  function connected() { const s = saved(); return !!(s && s.refreshToken && s.clientId === clientId()); }

  function status() {
    const enc = (() => { try { return !!vault.available(); } catch (e) { return false; } })();
    const id = clientId();
    let state;
    if (pending) state = 'connecting';
    else if (id && connected()) state = 'connected';
    else if (expired) state = 'expired';
    else state = 'setup';
    return {
      ok: true, state, clientId: id || null, redirectUri, scopes: SCOPES.slice(), encryption: enc,
      reason: state === 'connected' ? null : (lastReason || null),
      since: pending ? pending.since : null,
    };
  }
  function announce() { try { o.onStatus(status()); } catch (e) { o.log(`status push failed: ${e.message}`); } }

  /* ---------------------------------------------------------------- the token endpoint */
  async function tokenPost(form) {
    let res;
    try {
      res = await o.fetch(`${o.accountsBase}/api/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form).toString(),
        signal: AbortSignal.timeout(o.timeoutMs),
      });
    } catch (e) { throw spErr('offline', `could not reach Spotify's sign-in server (${netWhy(e)})`); }
    let j = null;
    try { j = await res.json(); } catch (e) { j = null; }
    if (!res.ok || !j || !j.access_token) {
      const code = (j && j.error) || `HTTP ${res.status}`;
      const why = (j && j.error_description) ? `${code}: ${j.error_description}` : code;
      throw spErr(res.status === 400 || res.status === 401 ? 'expired' : 'http', why, { httpStatus: res.status });
    }
    return j;
  }

  async function accessToken(force) {
    if (!force && tok && tok.exp - 60000 > Date.now()) return tok.access;
    if (refreshing) return refreshing;
    const s = saved();
    if (!s || !s.refreshToken) throw spErr(expired ? 'expired' : 'setup', lastReason || 'Mantle is not connected to Spotify yet');
    if (s.clientId !== clientId()) throw spErr('setup', 'the saved sign-in belongs to a different Client ID: connect again');
    refreshing = (async () => {
      try {
        const j = await tokenPost({ grant_type: 'refresh_token', refresh_token: s.refreshToken, client_id: s.clientId });
        tok = { access: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
        if (j.refresh_token && j.refresh_token !== s.refreshToken) {
          try { vault.save(Object.assign({}, s, { refreshToken: j.refresh_token, savedAt: Date.now() })); }
          catch (e) { o.log(`the new refresh token could not be saved (${e.message}); the old one stays`); }
        }
        return tok.access;
      } catch (e) {
        if (e.spState === 'expired') {
          // Spotify refused the saved sign-in itself (revoked, or the app changed): it is useless now.
          try { vault.clear(); } catch (x) { o.log(`the refused sign-in could not be deleted (${x.message})`); }
          tok = null;
          expired = true;
          lastReason = `Spotify refused the saved sign-in (${e.message}), so it was deleted: connect again`;
          o.log('refresh refused; saved sign-in deleted');
          announce();
          throw spErr('expired', lastReason);
        }
        throw spErr(e.spState || 'error', `the sign-in could not be renewed: ${e.message}`);
      } finally { refreshing = null; }
    })();
    return refreshing;
  }

  /* ---------------------------------------------------------------- the Web API */
  async function api(method, path, query, retried) {
    const t = await accessToken(false);
    const qs = query ? `?${new URLSearchParams(query).toString()}` : '';
    let res;
    try {
      res = await o.fetch(`${o.apiBase}${path}${qs}`, {
        method, headers: { Authorization: `Bearer ${t}` }, signal: AbortSignal.timeout(o.timeoutMs),
      });
    } catch (e) { throw spErr('offline', `could not reach Spotify (${netWhy(e)})`); }
    if (res.status === 401 && !retried) { tok = null; await accessToken(true); return api(method, path, query, true); }
    const text = await res.text().catch(() => '');
    let j = null;
    if (text) { try { j = JSON.parse(text); } catch (e) { j = null; } }
    if (res.ok) return res.status === 204 || !text ? null : j;
    const er = (j && j.error) || {};
    const msg = typeof er === 'string' ? er : (er.message || '');
    const why = er.reason || '';
    if (res.status === 403 && /PREMIUM_REQUIRED/i.test(why + ' ' + msg))
      throw spErr('premium', `Spotify Premium is required for this (Spotify: ${String(msg || why).replace(/^Player command failed: /i, '')})`);
    if (res.status === 403)
      throw spErr('forbidden', `Spotify refused it (403${msg ? `: ${msg}` : ''}). In development mode your Spotify account must be listed under User Management in your app on developer.spotify.com`);
    if (res.status === 404 && /NO_ACTIVE_DEVICE|device/i.test(`${why} ${msg}`))
      throw spErr('nodevice', `Spotify has no active player right now (${msg || why}): start playing something in Spotify first`);
    if (res.status === 429) {
      const ra = res.headers.get('retry-after');
      throw spErr('http', `Spotify says too many requests${ra ? `: try again in ${ra} s` : ''}`);
    }
    if (res.status === 401) throw spErr('expired', `Spotify refused a fresh sign-in (401${msg ? `: ${msg}` : ''})`);
    throw spErr('http', `Spotify answered HTTP ${res.status}${msg ? `: ${msg}` : ''}`);
  }

  /* ---------------------------------------------------------------- items + art */
  function pickImage(images) {
    const list = (Array.isArray(images) ? images : []).filter((i) => i && i.url);
    if (!list.length) return null;
    const sized = list.filter((i) => Number(i.width) >= 48).sort((a, b) => Number(a.width) - Number(b.width));
    return (sized[0] || list[list.length - 1]).url;
  }
  function norm(t) {
    if (!t || !t.uri) return null;
    const ep = t.type === 'episode';
    return {
      uri: t.uri,
      kind: ep ? 'episode' : 'track',
      name: t.name || '(no title)',
      artists: ep ? ((t.show && t.show.name) || '') : (Array.isArray(t.artists) ? t.artists.map((a) => a && a.name).filter(Boolean).join(', ') : ''),
      album: ep ? null : ((t.album && t.album.name) || null),
      durationMs: Number(t.duration_ms) || null,
      imageUrl: pickImage(ep ? (t.images || (t.show && t.show.images)) : (t.album && t.album.images)),
    };
  }
  async function artOf(url) {
    if (!url) return { why: 'Spotify gave no artwork for it' };
    if (art.has(url)) return art.get(url);
    let got;
    try {
      if (!/^https?:\/\//i.test(url)) throw new Error('not a web address');
      const res = await o.fetch(url, { signal: AbortSignal.timeout(5000) });
      const type = String(res.headers.get('content-type') || '').split(';')[0].trim();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (!/^image\//.test(type)) throw new Error(`not an image (${type || 'no type'})`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > ART_MAX_BYTES) throw new Error(`too big (${buf.length} bytes)`);
      // The bar's page allows only file: and data: images (its CSP), so the art travels as data.
      got = { data: `data:${type};base64,${buf.toString('base64')}` };
    } catch (e) { got = { why: `the artwork did not load (${netWhy(e)})` }; }
    art.set(url, got);
    if (art.size > ART_CACHE_MAX) art.delete(art.keys().next().value);
    return got;
  }
  async function withArt(items) {
    await Promise.all(items.map(async (it) => {
      const a = await artOf(it.imageUrl);
      it.image = a.data || null;
      if (!a.data) it.imageReason = a.why;
      delete it.imageUrl;
    }));
    return items;
  }

  /* ---------------------------------------------------------------- commands */
  async function queue() {
    try {
      const j = await api('GET', '/me/player/queue');
      if (!j) return { ok: true, state: 'connected', currently: null, items: [], noPlayer: true, reason: 'Spotify has no active player right now', at: Date.now() };
      const items = (Array.isArray(j.queue) ? j.queue : []).map(norm).filter(Boolean).slice(0, QUEUE_MAX);
      const cur = norm(j.currently_playing);
      await withArt(items);
      return { ok: true, state: 'connected', currently: cur ? { uri: cur.uri, name: cur.name, artists: cur.artists } : null, items, at: Date.now() };
    } catch (e) { return fail(e); }
  }

  async function add(a) {
    const uri = String((a && a.uri) || '');
    if (!URI_RE.test(uri)) return { ok: false, state: 'error', reason: `"${uri.slice(0, 60)}" is not a Spotify track or episode address` };
    try {
      await api('POST', '/me/player/queue', { uri });
      o.log(`added ${uri} to the queue`);
      return { ok: true, uri };
    } catch (e) { return fail(e); }
  }

  /* "Play this one" = skip forward until it is the current track, which is what Spotify's own
     queue does when an item is clicked (the ones before it are used up). The list is re-read
     first, so a click on a list that has since changed never skips to the wrong song. */
  async function play(a) {
    const uri = String((a && a.uri) || '');
    const want = Number(a && a.index);
    if (!URI_RE.test(uri)) return { ok: false, state: 'error', reason: `"${uri.slice(0, 60)}" is not a Spotify track or episode address` };
    if (playing) return { ok: false, state: 'busy', reason: 'still skipping to the last song you picked' };
    playing = true;
    try {
      const j = await api('GET', '/me/player/queue');
      const list = (j && Array.isArray(j.queue)) ? j.queue.map((t) => t && t.uri) : [];
      let pos = Number.isInteger(want) && list[want] === uri ? want : list.indexOf(uri);
      if (pos < 0) return { ok: false, state: 'moved', reason: 'that song is not in the queue any more (it changed since the list was drawn)' };
      const n = pos + 1;
      if (n > MAX_SKIP) return { ok: false, state: 'error', reason: `it is ${n} songs away; Mantle skips at most ${MAX_SKIP} at once` };
      for (let i = 0; i < n; i++) {
        try { await api('POST', '/me/player/next'); }
        catch (e) { throw spErr(e.spState || 'error', i ? `stopped after ${i} of ${n} skips: ${e.message}` : e.message, { skipped: i }); }
        if (i < n - 1) await delay(o.stepDelayMs);
      }
      await delay(o.verifyDelayMs);
      let now = null;
      try { const v = await api('GET', '/me/player/queue'); now = v && v.currently_playing ? norm(v.currently_playing) : null; } catch (e) { now = null; }
      const verified = !!(now && now.uri === uri);
      o.log(`play-from-queue: ${n} skip(s) to ${uri}; ${verified ? 'now playing it' : `now playing ${now ? now.uri : 'unknown'}`}`);
      return {
        ok: true, uri, skipped: n, verified,
        reason: verified ? null : `Spotify took the ${n} skip${n > 1 ? 's' : ''} but ${now ? `is playing "${now.name}"` : 'did not say what is playing'}, not that song`,
      };
    } catch (e) { return fail(e); } finally { playing = false; }
  }

  async function search(a) {
    const q = String((a && a.q) || '').trim();
    if (!q) return { ok: true, items: [], q };
    if (q.length > 100) return { ok: false, state: 'error', reason: 'that search is longer than 100 characters' };
    try {
      const j = await api('GET', '/search', { q, type: 'track', limit: String(SEARCH_LIMIT) });
      const items = ((j && j.tracks && j.tracks.items) || []).map(norm).filter(Boolean);
      await withArt(items);
      return { ok: true, items, q };
    } catch (e) { return fail(e); }
  }

  function setClientId(a) {
    const id = String((a && a.clientId) || '').trim();
    if (!CLIENT_ID_RE.test(id)) {
      return { ok: false, state: 'setup', reason: `a Spotify Client ID is 32 letters and digits (0-9, a-f); that was ${id.length} character${id.length === 1 ? '' : 's'}` };
    }
    const was = clientId();
    if (was.toLowerCase() !== id.toLowerCase()) {
      closePending('the Client ID changed');
      try { vault.clear(); } catch (e) { o.log(`the old sign-in could not be deleted (${e.message})`); }
      tok = null;
    }
    try { settings.set('clientId', id.toLowerCase()); } catch (e) { return { ok: false, state: 'setup', reason: e.message }; }
    expired = false; lastReason = '';
    announce();
    return status();
  }

  /* ---------------------------------------------------------------- sign-in (loopback) */
  function closePending(why) {
    if (!pending) return;
    const p = pending;
    pending = null;
    clearTimeout(p.timer);
    try { p.server.close(); } catch (e) { /* already closed */ }
    if (why) { lastReason = why; o.log(`sign-in ended: ${why}`); }
  }

  function page(title, body) {
    return `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
      '<body style="font:15px Segoe UI,sans-serif;background:#1d1f23;color:#e8e8ea;display:grid;place-items:center;height:90vh;margin:0">' +
      `<div style="max-width:440px;line-height:1.5"><h2 style="font-weight:600;margin:0 0 8px">${title}</h2><div>${body}</div></div>`;
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  async function onCallback(req, res) {
    const u = new URL(req.url, redirectUri);
    const reply = (code, title, body) => {
      res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'close' });
      res.end(page(esc(title), esc(body)));
    };
    if (req.method !== 'GET' || u.pathname !== CALLBACK_PATH) { reply(404, 'Not here', 'This is Mantle\'s Spotify sign-in catcher; it only answers at ' + CALLBACK_PATH + '.'); return; }
    const p = pending;
    if (!p) { reply(410, 'Nothing is waiting', 'Mantle is not waiting for a Spotify sign-in any more. Start again from the card.'); return; }
    if (u.searchParams.get('state') !== p.state) {
      reply(400, 'Not for this sign-in', 'This answer does not match the sign-in Mantle started (its state is different), so it was ignored.');
      return;
    }
    const err = u.searchParams.get('error');
    if (err) {
      const why = err === 'access_denied' ? 'you chose Cancel on Spotify\'s page' : `Spotify said: ${err}`;
      reply(200, 'Not connected', `Mantle was not connected: ${why}. You can close this tab.`);
      closePending(`not connected: ${why}`);
      announce();
      return;
    }
    const code = u.searchParams.get('code');
    if (!code) { reply(400, 'No code', 'Spotify sent no sign-in code, so nothing was saved.'); closePending('Spotify sent back no sign-in code'); announce(); return; }
    const id = clientId();
    try {
      const j = await tokenPost({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: id, code_verifier: p.verifier });
      if (!j.refresh_token) throw new Error('Spotify gave no refresh token');
      vault.save({ refreshToken: j.refresh_token, clientId: id, scope: j.scope || '', savedAt: Date.now() });
      tok = { access: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
      expired = false;
      closePending(null);
      lastReason = '';
      o.log(`connected (scope: ${j.scope || 'none said'})`);
      reply(200, 'Mantle is connected to Spotify', 'You can close this tab. The queue is in the now-playing card.');
    } catch (e) {
      closePending(`the sign-in did not finish: ${e.message}`);
      reply(200, 'Not connected', `The sign-in did not finish: ${e.message}. You can close this tab and try again from the card.`);
    }
    announce();
  }

  async function connect() {
    const id = clientId();
    if (!id) return { ok: false, state: 'setup', reason: 'paste your Client ID first' };
    let enc = false;
    try { enc = !!vault.available(); } catch (e) { enc = false; }
    if (!enc) return { ok: false, state: 'setup', reason: 'Windows encryption (Electron safeStorage) is not available, and the sign-in is never saved unencrypted' };
    closePending(null);
    const pair = pkcePair();
    const state = b64url(crypto.randomBytes(16));
    const server = http.createServer((req, res) => { onCallback(req, res).catch((e) => { try { res.writeHead(500); res.end(); } catch (x) { /* gone */ } o.log(`callback failed: ${e.message}`); }); });
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(o.port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); }); });
    } catch (e) {
      const why = e && e.code === 'EADDRINUSE'
        ? `port ${o.port} on 127.0.0.1 is taken by another program, so Spotify's answer cannot be caught (close that program and try again)`
        : `the sign-in catcher could not start (${e && e.message})`;
      lastReason = why;
      return { ok: false, state: 'setup', reason: why };
    }
    server.on('error', (e) => o.log(`sign-in catcher error: ${e.message}`));
    pending = { server, verifier: pair.verifier, state, since: Date.now(), timer: null };
    pending.timer = setTimeout(() => { closePending('the sign-in timed out (no answer from the browser in 5 minutes)'); announce(); }, o.consentTimeoutMs);
    if (pending.timer.unref) pending.timer.unref();
    const url = `${o.accountsBase}/authorize?${new URLSearchParams({
      client_id: id, response_type: 'code', redirect_uri: redirectUri, state, scope: SCOPES.join(' '),
      code_challenge_method: 'S256', code_challenge: pair.challenge,
    }).toString()}`;
    let opened;
    try { opened = await o.openExternal(url); } catch (e) {
      closePending(`the browser could not be opened (${e.message})`);
      announce();
      return { ok: false, state: 'setup', reason: lastReason };
    }
    lastReason = '';
    announce();
    return Object.assign({ ok: true, state: 'connecting', redirectUri }, opened && opened.dryRun ? { dryRun: true, url } : {});
  }

  function cancel() { closePending('you cancelled the sign-in'); announce(); return status(); }

  function disconnect(a) {
    closePending(null);
    try { vault.clear(); } catch (e) { return { ok: false, state: 'connected', reason: `the saved sign-in could not be deleted (${e.message})` }; }
    tok = null; expired = false;
    lastReason = '';
    if (a && a.forgetClient) { try { settings.set('clientId', ''); } catch (e) { return { ok: false, state: 'setup', reason: e.message }; } }
    o.log(`disconnected${a && a.forgetClient ? ' and forgot the Client ID' : ''}`);
    announce();
    return status();
  }

  function stop() { closePending(null); tok = null; }

  return { status, setClientId, connect, cancel, disconnect, queue, add, play, search, stop, redirectUri,
    _test: { pending: () => pending, token: () => tok } };
}

/* The real vault: the refresh token encrypted by Electron safeStorage (DPAPI on Windows, tied to
   Owen's Windows account) in one file. Never plain text: no encryption = no save, said in words. */
function fileVault(file, safeStorage) {
  const fs = require('fs');
  const path = require('path');
  return {
    file,
    available() { return !!(safeStorage && safeStorage.isEncryptionAvailable()); },
    load() {
      if (!fs.existsSync(file)) return null;
      if (!this.available()) throw new Error('Windows encryption is not available to read it');
      return JSON.parse(safeStorage.decryptString(fs.readFileSync(file)));
    },
    save(obj) {
      if (!this.available()) throw new Error('Windows encryption (Electron safeStorage) is not available, and the sign-in is never saved unencrypted');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, safeStorage.encryptString(JSON.stringify(obj)));
      fs.renameSync(tmp, file);
    },
    clear() { if (fs.existsSync(file)) fs.unlinkSync(file); },
  };
}

module.exports = { createSpotify, fileVault, pkcePair, PORT, CALLBACK_PATH, SCOPES, MAX_SKIP };
