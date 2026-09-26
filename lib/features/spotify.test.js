/* spotify.test.js - lib/features/spotify.js + _spotify-api.js against a FAKE Spotify on 127.0.0.1.
 * Nothing here reaches spotify.com, opens a browser, plays or skips anything real, or writes the
 * clipboard: the accounts and API bases point at the local fake below, the browser opener is a
 * recorder, and the "browser" is this test following Spotify's redirect with http.get.
 *   node lib/features/spotify.test.js
 */
'use strict';
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const feature = require('./spotify.js');
const { pkcePair, fileVault, createSpotify } = require('./_spotify-api.js');

let pass = 0, fail = 0;
const failures = [];
function ok(c, what) { if (c) pass++; else { fail++; failures.push(what); } }
const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const CLIENT = '0123456789abcdef0123456789abcdef';
const uri = (n) => 'spotify:track:' + String(n).padStart(22, 'A').slice(-22);

/* ------------------------------------------------------------------ the fake Spotify */
function fakeSpotify() {
  const F = {
    calls: [], challenge: null, codes: {}, access: new Set(), refresh: 'R1', rotate: null,
    refreshFail: null, queueStatus: 200, premium: false, nextFail: null, rateLimit: false,
    current: { uri: uri(1), name: 'Can’t Hold Us', type: 'track', artists: [{ name: 'Macklemore' }], album: { name: 'The Heist', images: [] }, duration_ms: 258000 },
    queue: [],
  };
  const track = (n, img) => ({ uri: uri(n), name: 'Song ' + n, type: 'track', duration_ms: 200000 + n,
    artists: [{ name: 'Artist ' + n }, { name: 'Feat ' + n }],
    album: { name: 'Album ' + n, images: img === false ? [] : [{ url: `${F.base}/img/${img || n}.jpg`, width: 640, height: 640 }, { url: `${F.base}/img/${img || n}-64.jpg`, width: 64, height: 64 }] } });
  F.track = track;
  F.server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      F.calls.push({ method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), body, auth: req.headers.authorization || null });
      const json = (code, obj, headers) => { res.writeHead(code, Object.assign({ 'Content-Type': 'application/json' }, headers || {})); res.end(obj == null ? '' : JSON.stringify(obj)); };
      // accounts
      if (u.pathname === '/authorize') {
        F.challenge = u.searchParams.get('code_challenge');
        F.authorize = Object.fromEntries(u.searchParams);
        const back = new URL(u.searchParams.get('redirect_uri'));
        if (F.deny) back.searchParams.set('error', 'access_denied');
        else { const code = 'CODE' + Math.random().toString(36).slice(2); F.codes[code] = true; back.searchParams.set('code', code); }
        back.searchParams.set('state', F.wrongState ? 'not-it' : u.searchParams.get('state'));
        res.writeHead(302, { Location: back.toString() }); res.end(); return;
      }
      if (u.pathname === '/api/token') {
        const p = new URLSearchParams(body);
        if (req.headers['content-type'] !== 'application/x-www-form-urlencoded') return json(400, { error: 'invalid_request', error_description: 'bad content type' });
        if (p.get('client_id') !== CLIENT) return json(400, { error: 'invalid_client' });
        if (p.get('grant_type') === 'authorization_code') {
          const want = b64url(crypto.createHash('sha256').update(p.get('code_verifier') || '').digest());
          if (!F.codes[p.get('code')]) return json(400, { error: 'invalid_grant', error_description: 'unknown code' });
          if (want !== F.challenge) return json(400, { error: 'invalid_grant', error_description: 'code_verifier was incorrect' });
          if (p.get('redirect_uri') !== F.authorize.redirect_uri) return json(400, { error: 'invalid_grant', error_description: 'Invalid redirect URI' });
          delete F.codes[p.get('code')];
          const a = 'A' + Math.random().toString(36).slice(2); F.access.add(a);
          return json(200, { access_token: a, token_type: 'Bearer', expires_in: 3600, refresh_token: F.refresh, scope: F.authorize.scope });
        }
        if (p.get('grant_type') === 'refresh_token') {
          if (F.refreshFail === 'grant') return json(400, { error: 'invalid_grant', error_description: 'Refresh token revoked' });
          if (p.get('refresh_token') !== F.refresh) return json(400, { error: 'invalid_grant', error_description: 'Invalid refresh token' });
          if (req.headers.authorization) return json(400, { error: 'invalid_client', error_description: 'PKCE refresh sends no secret' });
          const a = 'A' + Math.random().toString(36).slice(2); F.access.add(a);
          const out = { access_token: a, token_type: 'Bearer', expires_in: 3600 };
          if (F.rotate) { out.refresh_token = F.rotate; F.refresh = F.rotate; F.rotate = null; }
          return json(200, out);
        }
        return json(400, { error: 'unsupported_grant_type' });
      }
      if (u.pathname.startsWith('/img/')) {
        if (u.pathname.includes('missing')) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'Content-Type': 'image/jpeg' }); res.end(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])); return;
      }
      // api
      const tokOk = req.headers.authorization && F.access.has(req.headers.authorization.replace(/^Bearer /, ''));
      if (!tokOk) return json(401, { error: { status: 401, message: 'The access token expired' } });
      if (F.rateLimit) return json(429, { error: { status: 429, message: 'API rate limit exceeded' } }, { 'Retry-After': '7' });
      if (u.pathname === '/v1/me/player/queue' && req.method === 'GET') {
        if (F.queueStatus === 204) { res.writeHead(204); res.end(); return; }
        if (F.queueStatus === 403) return json(403, { error: { status: 403, message: 'User not registered in the Developer Dashboard' } });
        return json(200, { currently_playing: F.current, queue: F.queue });
      }
      if (u.pathname === '/v1/me/player/queue' && req.method === 'POST') {
        if (F.premium) return json(403, { error: { status: 403, message: 'Player command failed: Premium required', reason: 'PREMIUM_REQUIRED' } });
        F.queue.push(track(99)); F.queue[F.queue.length - 1].uri = u.searchParams.get('uri');
        res.writeHead(204); res.end(); return;
      }
      if (u.pathname === '/v1/me/player/next' && req.method === 'POST') {
        if (F.premium) return json(403, { error: { status: 403, message: 'Player command failed: Premium required', reason: 'PREMIUM_REQUIRED' } });
        if (F.nextFail === 'nodevice') return json(404, { error: { status: 404, message: 'Player command failed: No active device found', reason: 'NO_ACTIVE_DEVICE' } });
        if (typeof F.nextFail === 'number' && F.calls.filter((c) => c.path === '/v1/me/player/next').length > F.nextFail) return json(502, { error: { status: 502, message: 'Bad gateway' } });
        F.current = F.queue.shift() || null;
        res.writeHead(204); res.end(); return;
      }
      if (u.pathname === '/v1/search') {
        const n = Number(u.searchParams.get('limit'));
        return json(200, { tracks: { items: [track(40), track(41)].slice(0, n) } });
      }
      json(404, { error: { status: 404, message: 'Service not found' } });
    });
  });
  return new Promise((r) => F.server.listen(0, '127.0.0.1', () => { F.base = `http://127.0.0.1:${F.server.address().port}`; F.queue = [track(2), track(3), track(4, 'missing'), track(5, false)]; r(F); }));
}

/* A vault that keeps the token "encrypted" (xor) in memory, so the test can prove what is stored
   is never the plain token. */
function fakeVault() {
  const v = { blob: null, saves: 0, enc: true,
    available() { return v.enc; },
    load() { return v.blob ? JSON.parse(Buffer.from(v.blob.map((b) => b ^ 0x5a)).toString()) : null; },
    save(o) { if (!v.enc) throw new Error('no encryption'); v.saves++; v.blob = [...Buffer.from(JSON.stringify(o))].map((b) => b ^ 0x5a); },
    clear() { v.blob = null; },
  };
  return v;
}

function fakeCtx({ test = true } = {}) {
  const store = {};
  const c = {
    commands: {}, logs: [], healths: [], pushes: [], replays: {}, on: true,
    flags: Object.freeze({ test, live: !test }),
    log(t) { c.logs.push(t); },
    command(verb, fn) { c.commands[verb] = fn; return 'spotify.' + verb; },
    health(okv, why) { c.healths.push([okv, why]); },
    broadcast(ev, p) { c.pushes.push([ev, p]); },
    replay(ev, fn) { c.replays[ev] = fn; },
    enabled() { return c.on; },
    onEnabled(fn) { c.flip = fn; },
    settings: { file: path.join(os.tmpdir(), 'spq-none', 'features', 'spotify.json'), get(k, d) { return k in store ? store[k] : d; }, set(k, v) { store[k] = JSON.parse(JSON.stringify(v)); } },
  };
  return c;
}

function freePort() { return new Promise((r) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); }); }
function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b })); }).on('error', reject);
  });
}
/* the browser: open the consent URL at the fake accounts server, follow its redirect to Mantle */
async function consent(url) {
  const r = await get(url);
  if (r.status !== 302) throw new Error('fake /authorize did not redirect: ' + r.status);
  return get(r.headers.location);
}

(async () => {
  // ---------------------------------------------------------------- PKCE
  const pk = pkcePair();
  ok(pk.verifier.length >= 43 && pk.verifier.length <= 128 && /^[A-Za-z0-9._~-]+$/.test(pk.verifier), 'PKCE verifier: 43-128 chars of the RFC 7636 alphabet');
  ok(pk.challenge === b64url(crypto.createHash('sha256').update(pk.verifier).digest()), 'PKCE challenge = base64url(sha256(verifier))');
  ok(pkcePair().verifier !== pk.verifier, 'PKCE verifier is random each time');

  // ---------------------------------------------------------------- module
  ok(feature.name === 'spotify' && feature.defaultOn === true && feature.chords.length === 0 && feature.observe.length === 0, 'module: spotify, on by default, no chords');

  const F = await fakeSpotify();
  const port = await freePort();
  const opened = [];
  const vault = fakeVault();
  const c = fakeCtx();
  const handle = feature._install(c, {
    vault, openExternal: async (u) => { opened.push(u); return { dryRun: true }; },
    options: { accountsBase: F.base, apiBase: F.base + '/v1', port, stepDelayMs: 0, verifyDelayMs: 0, timeoutMs: 3000 },
  });
  ok(handle && typeof handle.stop === 'function', 'install returns stop()');
  ok(['status', 'setClient', 'connect', 'cancel', 'disconnect', 'queue', 'add', 'play', 'search', 'copyRedirect', 'openDashboard'].every((v) => typeof c.commands[v] === 'function'), 'registers every command');
  ok(c.healths.length && c.healths[c.healths.length - 1][0] === true, 'healthy after install');
  ok(typeof c.replays['spotify.status'] === 'function' && c.replays['spotify.status']().state === 'setup', 'replays spotify.status (setup)');

  let s = await c.commands.status();
  ok(s.state === 'setup' && s.clientId === null && s.redirectUri === `http://127.0.0.1:${port}/callback`, 'status: setup, no Client ID, the loopback redirect');
  let r = await c.commands.connect();
  ok(r.ok === false && /Client ID/.test(r.reason), 'connect without a Client ID: refused in words');
  r = await c.commands.queue();
  ok(r.ok === false && r.state === 'setup' && r.reason, 'queue before connecting: state setup with a reason');
  r = await c.commands.setClient({ clientId: 'nope' });
  ok(r.ok === false && /32 letters/.test(r.reason), 'setClient: a bad Client ID is refused in words');
  r = await c.commands.setClient({ clientId: '  ' + CLIENT.toUpperCase() + ' ' });
  ok(r.ok && r.clientId === CLIENT, 'setClient: trimmed, lower-cased, kept');

  // copy / dashboard are dry runs in --test
  r = await c.commands.copyRedirect();
  ok(r.ok && r.dryRun && r.text === `http://127.0.0.1:${port}/callback`, 'copyRedirect: a dry run in --test (clipboard untouched)');
  r = await c.commands.openDashboard();
  ok(r.ok && r.dryRun && /developer\.spotify\.com\/dashboard/.test(r.url), 'openDashboard: a dry run in --test');

  // ---------------------------------------------------------------- consent: denied, wrong state, then good
  F.deny = true;
  r = await c.commands.connect();
  ok(r.ok && r.state === 'connecting' && opened.length === 1, 'connect: listener up, the (fake) browser opener got the URL');
  ok((await c.commands.status()).state === 'connecting', 'status: connecting');
  let page = await consent(opened[0]);
  ok(page.status === 200 && /Cancel/.test(page.body), 'denied: the tab says so');
  s = await c.commands.status();
  ok(s.state === 'setup' && /Cancel/.test(s.reason), 'denied: status back to setup, with the reason');
  F.deny = false;

  F.wrongState = true;
  await c.commands.connect();
  page = await consent(opened[opened.length - 1]);
  ok(page.status === 400 && (await c.commands.status()).state === 'connecting', 'a mismatched state is refused and the sign-in keeps waiting');
  F.wrongState = false;
  await c.commands.cancel();
  s = await c.commands.status();
  ok(s.state === 'setup' && /cancelled/.test(s.reason), 'cancel: back to setup, said');
  let refused = await get(`http://127.0.0.1:${port}/callback?code=x&state=y`).then(() => false, () => true);
  ok(refused, 'cancel: the loopback port is closed again');

  r = await c.commands.connect();
  const au = new URL(opened[opened.length - 1]);
  ok(au.origin + au.pathname === F.base + '/authorize', 'authorize URL at the (injected) accounts base');
  ok(au.searchParams.get('client_id') === CLIENT && au.searchParams.get('response_type') === 'code' && au.searchParams.get('code_challenge_method') === 'S256', 'authorize: client_id, code, S256');
  ok(au.searchParams.get('redirect_uri') === `http://127.0.0.1:${port}/callback`, 'authorize: the 127.0.0.1 redirect (never localhost)');
  ok(au.searchParams.get('scope') === 'user-read-playback-state user-modify-playback-state', 'authorize: the two playback scopes');
  ok((au.searchParams.get('state') || '').length >= 16, 'authorize: a random state');
  page = await consent(au.toString());
  ok(page.status === 200 && /connected/i.test(page.body), 'callback: code exchanged with the PKCE verifier; the tab says connected');
  s = await c.commands.status();
  ok(s.state === 'connected' && s.reason === null, 'status: connected');
  ok(c.pushes.some(([e, p]) => e === 'spotify.status' && p.state === 'connected'), 'spotify.status pushed on connect');
  ok(vault.saves === 1 && vault.load().refreshToken === 'R1' && vault.load().clientId === CLIENT, 'the refresh token went to the vault, bound to the Client ID');
  ok(!Buffer.from(vault.blob).toString().includes('R1'), 'the vault holds no plain token');
  refused = await get(`http://127.0.0.1:${port}/callback`).then(() => false, () => true);
  ok(refused, 'after the callback the loopback port is closed');
  const tokCall = F.calls.filter((x) => x.path === '/api/token').pop();
  ok(tokCall && /grant_type=authorization_code/.test(tokCall.body) && /code_verifier=/.test(tokCall.body) && !tokCall.auth, 'token exchange: authorization_code + code_verifier, no client secret');

  // ---------------------------------------------------------------- queue
  r = await c.commands.queue();
  ok(r.ok && r.items.length === 4 && r.currently && r.currently.uri === uri(1), 'queue: 4 items + what is playing');
  ok(r.items[0].name === 'Song 2' && r.items[0].artists === 'Artist 2, Feat 2', 'queue: title and artists');
  ok(/^data:image\/jpeg;base64,/.test(r.items[0].image || ''), 'queue: art comes back as a data: URL (the bar CSP allows no https images)');
  ok(F.calls.some((x) => x.path === '/img/2-64.jpg') && !F.calls.some((x) => x.path === '/img/2.jpg'), 'queue: the small (64 px) image is the one fetched');
  ok(r.items[2].image === null && /did not load/.test(r.items[2].imageReason), 'queue: a broken image is said, not blank');
  ok(r.items[3].image === null && /no artwork/.test(r.items[3].imageReason), 'queue: no image at all is said');
  const imgCalls = F.calls.filter((x) => x.path.startsWith('/img/')).length;
  await c.commands.queue();
  ok(F.calls.filter((x) => x.path.startsWith('/img/')).length === imgCalls, 'queue: art is cached (no refetch on the 8 s refresh)');

  F.queue = [];
  r = await c.commands.queue();
  ok(r.ok && r.items.length === 0 && !r.noPlayer, 'queue: an empty queue is ok with no items');
  F.queueStatus = 204;
  r = await c.commands.queue();
  ok(r.ok && r.noPlayer && /no active player/.test(r.reason), 'queue: 204 = no active player, said');
  F.queueStatus = 403;
  r = await c.commands.queue();
  ok(!r.ok && r.state === 'forbidden' && /User Management/.test(r.reason), 'queue: a plain 403 names the dashboard allow-list');
  F.queueStatus = 200;
  F.rateLimit = true;
  r = await c.commands.queue();
  ok(!r.ok && r.state === 'http' && /7 s/.test(r.reason), 'queue: 429 says when to retry');
  F.rateLimit = false;

  // ---------------------------------------------------------------- add
  let before = F.calls.length;
  r = await c.commands.add({ uri: 'spotify:track:bad' });
  ok(!r.ok && F.calls.length === before, 'add: a bad uri is refused before any call');
  r = await c.commands.add({ uri: uri(40) });
  const addCall = F.calls.filter((x) => x.method === 'POST' && x.path === '/v1/me/player/queue').pop();
  ok(r.ok && addCall && addCall.query.uri === uri(40), 'add: POST /me/player/queue?uri=');
  ok(F.queue.length === 1 && F.queue[0].uri === uri(40), 'add: it is at the end of the (fake) queue');

  // ---------------------------------------------------------------- play = N x next
  F.queue = [F.track(2), F.track(3), F.track(4), F.track(5)];
  F.current = F.track(1);
  let nextsBefore = F.calls.filter((x) => x.path === '/v1/me/player/next').length;
  r = await c.commands.play({ uri: uri(4), index: 2 });
  let nexts = F.calls.filter((x) => x.path === '/v1/me/player/next').length - nextsBefore;
  ok(r.ok && r.skipped === 3 && nexts === 3, 'play item 3: exactly 3 x next');
  ok(r.verified === true && F.current.uri === uri(4) && F.queue.length === 1, 'play: it is now playing, the ones before it are used up (as Spotify does)');
  F.queue = [F.track(6), F.track(7)];
  nextsBefore = F.calls.filter((x) => x.path === '/v1/me/player/next').length;
  r = await c.commands.play({ uri: uri(7), index: 5 });
  nexts = F.calls.filter((x) => x.path === '/v1/me/player/next').length - nextsBefore;
  ok(r.ok && r.skipped === 2 && nexts === 2, 'play: a stale index is re-found by uri in the fresh queue');
  r = await c.commands.play({ uri: uri(33), index: 0 });
  ok(!r.ok && r.state === 'moved' && F.calls.filter((x) => x.path === '/v1/me/player/next').length - nextsBefore === 2, 'play: a song no longer queued is refused, nothing skipped');
  F.queue = [F.track(8), F.track(9), F.track(10)];
  F.nextFail = F.calls.filter((x) => x.path === '/v1/me/player/next').length + 1;
  r = await c.commands.play({ uri: uri(10), index: 2 });
  ok(!r.ok && r.skipped === 1 && /stopped after 1 of 3/.test(r.reason), 'play: a failure mid-way says how far it got');
  F.nextFail = 'nodevice';
  F.queue = [F.track(11)];
  r = await c.commands.play({ uri: uri(11), index: 0 });
  ok(!r.ok && r.state === 'nodevice' && /no active player/.test(r.reason), 'play: 404 NO_ACTIVE_DEVICE is said');
  F.nextFail = null;

  // ---------------------------------------------------------------- premium
  F.premium = true;
  r = await c.commands.add({ uri: uri(41) });
  ok(!r.ok && r.state === 'premium' && /Premium/.test(r.reason), 'add: 403 PREMIUM_REQUIRED = state premium');
  F.queue = [F.track(12)];
  r = await c.commands.play({ uri: uri(12), index: 0 });
  ok(!r.ok && r.state === 'premium', 'play: 403 PREMIUM_REQUIRED = state premium');
  F.premium = false;

  // ---------------------------------------------------------------- search
  r = await c.commands.search({ q: 'macklemore' });
  const sc = F.calls.filter((x) => x.path === '/v1/search').pop();
  ok(r.ok && r.items.length === 2 && sc.query.type === 'track' && sc.query.q === 'macklemore' && Number(sc.query.limit) <= 10, 'search: type=track, limit within Spotify\'s 10');
  ok(r.items[0].uri === uri(40) && /^data:image/.test(r.items[0].image), 'search: results carry uri + art');
  r = await c.commands.search({ q: '   ' });
  ok(r.ok && r.items.length === 0, 'search: blank = no call, no results');

  // ---------------------------------------------------------------- 401 -> refresh (rotated) -> retry
  F.access.clear();
  F.rotate = 'R2';
  before = F.calls.filter((x) => x.path === '/api/token').length;
  r = await c.commands.queue();
  const refreshCall = F.calls.filter((x) => x.path === '/api/token').pop();
  ok(r.ok && F.calls.filter((x) => x.path === '/api/token').length === before + 1, '401: one refresh, then the retry succeeds');
  ok(/grant_type=refresh_token/.test(refreshCall.body) && /client_id=/.test(refreshCall.body) && !refreshCall.auth, 'refresh: refresh_token + client_id, no secret');
  ok(vault.load().refreshToken === 'R2', 'refresh: a rotated refresh token replaces the saved one');

  // concurrent calls share one refresh
  F.access.clear();
  before = F.calls.filter((x) => x.path === '/api/token').length;
  const both = await Promise.all([c.commands.queue(), c.commands.search({ q: 'x' })]);
  ok(both.every((x) => x.ok) && F.calls.filter((x) => x.path === '/api/token').length - before <= 2, 'two calls on an expired token do not stampede the token endpoint');

  // ---------------------------------------------------------------- network error
  const deadPort = await freePort();
  const c2 = fakeCtx();
  const v2 = fakeVault();
  v2.save({ refreshToken: 'R2', clientId: CLIENT });
  c2.settings.set('clientId', CLIENT);
  feature._install(c2, { vault: v2, openExternal: async () => ({ dryRun: true }), options: { accountsBase: `http://127.0.0.1:${deadPort}`, apiBase: `http://127.0.0.1:${deadPort}/v1`, port: await freePort(), timeoutMs: 2000 } });
  r = await c2.commands.queue();
  ok(!r.ok && r.state === 'offline' && /could not reach Spotify/.test(r.reason) && /ECONNREFUSED/.test(r.reason), 'offline: state offline, with the reason (ECONNREFUSED)');
  ok(v2.load() && v2.load().refreshToken === 'R2', 'offline: the saved sign-in is kept');

  // ---------------------------------------------------------------- refresh refused -> expired
  F.access.clear();
  F.refreshFail = 'grant';
  r = await c.commands.queue();
  ok(!r.ok && r.state === 'expired' && /Refresh token revoked/.test(r.reason), 'refresh refused: state expired, Spotify\'s words');
  ok(vault.load() === null, 'refresh refused: the dead sign-in is deleted');
  s = await c.commands.status();
  ok(s.state === 'expired' && /connect again/.test(s.reason), 'status: expired, with what to do');
  ok(c.pushes.some(([e, p]) => e === 'spotify.status' && p.state === 'expired'), 'spotify.status pushed on expiry');
  F.refreshFail = null;

  // ---------------------------------------------------------------- reconnect, disconnect
  F.refresh = 'R3';
  await c.commands.connect();
  page = await consent(opened[opened.length - 1]);
  ok((await c.commands.status()).state === 'connected', 'reconnect after expiry works');
  r = await c.commands.disconnect();
  ok(r.state === 'setup' && vault.load() === null && r.clientId === CLIENT, 'disconnect: token deleted, Client ID kept');
  r = await c.commands.queue();
  ok(!r.ok && r.state === 'setup', 'after disconnect the queue asks to connect');
  r = await c.commands.disconnect({ forgetClient: true });
  ok(r.state === 'setup' && r.clientId === null, 'disconnect {forgetClient}: Client ID forgotten too');
  await c.commands.setClient({ clientId: CLIENT });

  // ---------------------------------------------------------------- the port is taken
  const blocker = http.createServer();
  const blockPort = await freePort();
  await new Promise((res) => blocker.listen(blockPort, '127.0.0.1', res));
  const c3 = fakeCtx();
  c3.settings.set('clientId', CLIENT);
  feature._install(c3, { vault: fakeVault(), openExternal: async () => { throw new Error('must not open'); }, options: { accountsBase: F.base, apiBase: F.base + '/v1', port: blockPort } });
  r = await c3.commands.connect();
  ok(!r.ok && new RegExp(`port ${blockPort}`).test(r.reason) && /taken/.test(r.reason), 'a taken port: refused, the port named, the browser never opened');
  blocker.close();

  // encryption unavailable: never connects, never saves plain
  const c4 = fakeCtx();
  c4.settings.set('clientId', CLIENT);
  const v4 = fakeVault(); v4.enc = false;
  feature._install(c4, { vault: v4, openExternal: async () => ({ dryRun: true }), options: { accountsBase: F.base, apiBase: F.base + '/v1', port: await freePort() } });
  r = await c4.commands.connect();
  ok(!r.ok && /never saved unencrypted/.test(r.reason) && (await c4.commands.status()).encryption === false, 'no encryption: connect refused, said');

  // ---------------------------------------------------------------- off
  c.on = false;
  r = await c.commands.queue();
  ok(!r.ok && r.state === 'off' && /tray/.test(r.reason), 'off in the tray: every command says so');
  c.flip(false);
  ok(c.pushes[c.pushes.length - 1][1].state === 'off', 'off: pushed');
  c.on = true;

  // env overrides only in --test
  process.env.MANTLE_SPOTIFY_API = 'http://127.0.0.1:1/v1';
  const c5 = fakeCtx({ test: false });
  feature._install(c5, { vault: fakeVault(), openExternal: async () => ({}) });
  ok(c5.logs.some((l) => /MANTLE_SPOTIFY_API is ignored outside --test/.test(l)), 'MANTLE_SPOTIFY_* ignored (and said) in a live run');
  delete process.env.MANTLE_SPOTIFY_API;

  // ---------------------------------------------------------------- stop
  await c.commands.connect();
  handle.stop();
  refused = await get(`http://127.0.0.1:${port}/callback`).then(() => false, () => true);
  ok(refused, 'stop(): the sign-in catcher is closed');

  // ---------------------------------------------------------------- no secrets in the log
  const all = [c, c2, c3, c4, c5].map((x) => x.logs.join('\n')).join('\n');
  ok(!/\bR[123]\b/.test(all) && ![...F.access].some((a) => all.includes(a)) && !/CODE[a-z0-9]{4}/.test(all), 'no token or code ever reaches the log');

  // ---------------------------------------------------------------- the real file vault (fake safeStorage)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spq-vault-'));
  const fakeSafe = { isEncryptionAvailable: () => true,
    encryptString: (t) => Buffer.from(Buffer.from(t).map((b) => b ^ 0x33)),
    decryptString: (b) => Buffer.from(Buffer.from(b).map((x) => x ^ 0x33)).toString() };
  const fv = fileVault(path.join(dir, 'spotify-token.bin'), fakeSafe);
  fv.save({ refreshToken: 'SECRET-REFRESH-123', clientId: CLIENT });
  ok(!fs.readFileSync(fv.file).toString('latin1').includes('SECRET-REFRESH-123'), 'fileVault: the file never holds the token in plain text');
  ok(fv.load().refreshToken === 'SECRET-REFRESH-123', 'fileVault: reads it back');
  fv.clear();
  ok(!fs.existsSync(fv.file) && fv.load() === null, 'fileVault: clear deletes the file');
  const noEnc = fileVault(path.join(dir, 'x.bin'), { isEncryptionAvailable: () => false });
  let threw = false;
  try { noEnc.save({ refreshToken: 't' }); } catch (e) { threw = /never saved unencrypted/.test(e.message); }
  ok(threw && !fs.existsSync(path.join(dir, 'x.bin')), 'fileVault: no encryption = no file at all');
  fs.rmSync(dir, { recursive: true, force: true });

  // createSpotify defaults point at the real hosts (and are never called here)
  const dflt = createSpotify({ vault: fakeVault(), settings: { get: () => '', set() {} } });
  ok(dflt.redirectUri === 'http://127.0.0.1:47291/callback', 'default redirect URI is http://127.0.0.1:47291/callback');

  F.server.close();
  console.log(failures.length ? 'FAILED:\n  ' + failures.join('\n  ') : '');
  console.log(`SPOTIFY ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e && e.stack || e); console.log(`SPOTIFY ${pass} passed, ${fail + 1} failed`); process.exit(1); });
