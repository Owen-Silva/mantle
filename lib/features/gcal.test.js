'use strict';
/*
 * gcal.test.js - Google Calendar, every part that runs without Electron (lane mantle-gcal, 2026-10-16).
 *
 * MOCKED GOOGLE ONLY: every Google answer is a fake fetch / fake engine dependency; nothing here reaches
 * the internet and no real token or client file is ever read. The sign-in listener test uses a real HTTP
 * server on 127.0.0.1 (this PC only) with a fake browser that answers it.
 *   node lib/features/gcal.test.js     ->  "GCAL UNIT TEST: n passed, m failed"
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const C = require('./_gcal-core');
const { createGoogle } = require('./_gcal-google');
const { createStore } = require('./_gcal-store');
const { createEngine, PERIOD_MS, STALE_MS, ONLINE_POLL_MS } = require('./_gcal-sync');
const auth = require('./_gcal-auth');
const Days = require('../../ui/bar/gcal-days.js');

let passed = 0; const fails = [];
function check(name, ok, detail) { if (ok) passed++; else fails.push(name + (detail !== undefined ? ' (' + String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 300) + ')' : '')); }
const flush = async (n) => { for (let i = 0; i < (n || 8); i++) await new Promise((r) => setImmediate(r)); };
const FAKE_TOKEN = 'fake-access-' + crypto.randomBytes(4).toString('hex');
const FAKE_REFRESH = 'fake-refresh-' + crypto.randomBytes(4).toString('hex');
const CLIENT_JSON = JSON.stringify({ installed: { client_id: '123-abc.apps.googleusercontent.com', client_secret: 'fake-secret', project_id: 'made-up' } });

/* ------------------------------------------------------------------ PKCE, state, consent URL */
function testAuthUrl() {
  let n = 0; const rb = (len) => Buffer.alloc(len, ++n);
  const p = C.pkce(rb);
  check('pkce: verifier is 43 unreserved chars', /^[A-Za-z0-9_-]{43}$/.test(p.verifier), p.verifier);
  check('pkce: S256 challenge = b64url(sha256(verifier))', p.challenge === C.b64url(crypto.createHash('sha256').update(p.verifier).digest()) && p.method === 'S256');
  check('pkce: two verifiers differ', C.pkce().verifier !== C.pkce().verifier);
  const st = C.newState();
  check('state: random, url-safe', /^[A-Za-z0-9_-]{32}$/.test(st) && st !== C.newState());
  check('state: exact match only', C.stateMatches(st, st) && !C.stateMatches(st, st.slice(0, -1) + 'x') && !C.stateMatches(st, '') && !C.stateMatches('', ''));
  const u = new URL(C.authUrl({ clientId: 'id.apps.googleusercontent.com', redirectUri: 'http://127.0.0.1:53111/', challenge: p.challenge, state: st }));
  check('auth url: Google\'s consent page', u.origin === 'https://accounts.google.com' && u.pathname === '/o/oauth2/v2/auth');
  check('auth url: the ONLY scope is calendar.readonly', u.searchParams.get('scope') === 'https://www.googleapis.com/auth/calendar.readonly', u.searchParams.get('scope'));
  check('auth url: PKCE S256 + state + code + offline', u.searchParams.get('code_challenge') === p.challenge && u.searchParams.get('code_challenge_method') === 'S256' &&
    u.searchParams.get('state') === st && u.searchParams.get('response_type') === 'code' && u.searchParams.get('access_type') === 'offline');
  check('auth url: loopback redirect', u.searchParams.get('redirect_uri') === 'http://127.0.0.1:53111/');
  let threw = false; try { C.authUrl({ clientId: 'x', redirectUri: 'https://evil.example/', challenge: 'c', state: 's' }); } catch (e) { threw = true; }
  check('auth url: a non-loopback redirect is refused', threw);
}

/* ------------------------------------------------------------------ the client file */
function testClientFile() {
  const c = C.parseClientFile(CLIENT_JSON);
  check('client: Desktop app file parsed', c.clientId === '123-abc.apps.googleusercontent.com' && c.clientSecret === 'fake-secret' && c.project === 'made-up');
  check('client: a BOM is fine', C.parseClientFile('﻿' + CLIENT_JSON).clientId === c.clientId);
  const bad = (t) => { try { C.parseClientFile(t); return null; } catch (e) { return e.message; } };
  check('client: a Web client is refused in words', /Desktop app/.test(bad(JSON.stringify({ web: { client_id: 'x.apps.googleusercontent.com', client_secret: 's' } })) || ''));
  check('client: not JSON is refused', /not JSON/.test(bad('hello') || ''));
  check('client: no secret is refused', /secret/.test(bad(JSON.stringify({ installed: { client_id: 'x.apps.googleusercontent.com' } })) || ''));
  check('client: a bad id is refused', /client ID/.test(bad(JSON.stringify({ installed: { client_id: 'nope', client_secret: 's' } })) || ''));
}

/* ------------------------------------------------------------------ the loopback sign-in */
function getUrl(u) {
  return new Promise((res) => {
    http.get(u, (r) => { let b = ''; r.on('data', (d) => { b += d; }); r.on('end', () => res({ status: r.statusCode, body: b })); }).on('error', (e) => res({ status: 0, body: String(e) }));
  });
}
async function testLoopback() {
  const client = { clientId: '123-abc.apps.googleusercontent.com', clientSecret: 'fake-secret' };
  // 1. the happy path: the fake browser comes back with the right state
  let opened = null, page = null, exchanged = null;
  const google = { exchange: async (a) => { exchanged = a; return { access: FAKE_TOKEN, refresh: FAKE_REFRESH, expiresAt: Date.now() + 3600e3, scopes: [C.SCOPE] }; } };
  const tok = await auth.signIn({ client, google, openExternal: async (url) => {
    opened = new URL(url);
    const back = new URL(opened.searchParams.get('redirect_uri'));
    back.searchParams.set('code', 'fake-code'); back.searchParams.set('state', opened.searchParams.get('state'));
    setTimeout(async () => { page = await getUrl(back.toString()); }, 10);
  } });
  await new Promise((r) => setTimeout(r, 80));
  check('sign-in: the system browser was asked to open Google\'s page', opened && opened.hostname === 'accounts.google.com');
  check('sign-in: redirect is 127.0.0.1 on a random port', opened && /^http:\/\/127\.0\.0\.1:\d+\/$/.test(opened.searchParams.get('redirect_uri')) && !/:80\/$/.test(opened.searchParams.get('redirect_uri')));
  check('sign-in: token came back', tok && tok.refresh === FAKE_REFRESH);
  check('sign-in: code + PKCE verifier exchanged on the same redirect', exchanged && exchanged.code === 'fake-code' && /^[A-Za-z0-9_-]{43}$/.test(exchanged.verifier) &&
    C.b64url(crypto.createHash('sha256').update(exchanged.verifier).digest()) === opened.searchParams.get('code_challenge') && exchanged.redirectUri === opened.searchParams.get('redirect_uri'));
  check('sign-in: the browser tab says connected', page && page.status === 200 && /Mantle is connected/.test(page.body), page);
  const port = new URL(opened.searchParams.get('redirect_uri')).port;
  const after = await getUrl('http://127.0.0.1:' + port + '/?code=x&state=y');
  check('sign-in: the listener is closed afterwards', after.status === 0, after.status);

  // 2. a wrong state is refused
  let reason = null, page2 = null;
  await auth.signIn({ client, google, openExternal: async (url) => {
    const o = new URL(url); const back = new URL(o.searchParams.get('redirect_uri'));
    back.searchParams.set('code', 'fake-code'); back.searchParams.set('state', 'forged');
    setTimeout(async () => { page2 = await getUrl(back.toString()); }, 10);
  } }).catch((e) => { reason = e.reason; });
  await new Promise((r) => setTimeout(r, 60));
  check('sign-in: a forged state is refused', /did not match/.test(reason || ''), reason);
  check('sign-in: ...and the tab says so (400)', page2 && page2.status === 400, page2 && page2.status);

  // 3. the user said no
  reason = null;
  await auth.signIn({ client, google, openExternal: async (url) => {
    const o = new URL(url); const back = new URL(o.searchParams.get('redirect_uri'));
    back.searchParams.set('error', 'access_denied'); back.searchParams.set('state', o.searchParams.get('state'));
    setTimeout(() => getUrl(back.toString()), 10);
  } }).catch((e) => { reason = e.reason; });
  check('sign-in: "no" on Google\'s page is said', /said no/.test(reason || ''), reason);

  // 4. the calendar box unticked (granular consent): refused
  reason = null;
  const g2 = { exchange: async () => ({ access: 'a', refresh: 'r', expiresAt: 0, scopes: ['openid'] }) };
  await auth.signIn({ client, google: g2, openExternal: async (url) => {
    const o = new URL(url); const back = new URL(o.searchParams.get('redirect_uri'));
    back.searchParams.set('code', 'c'); back.searchParams.set('state', o.searchParams.get('state'));
    setTimeout(() => getUrl(back.toString()), 10);
  } }).catch((e) => { reason = e.reason; });
  check('sign-in: without the calendar scope it is refused', /read access/.test(reason || ''), reason);

  // 5. never finished
  reason = null;
  await auth.signIn({ client, google, waitMs: 50, openExternal: async () => {} }).catch((e) => { reason = e.reason; });
  check('sign-in: times out in words', /5 minutes/.test(reason || ''), reason);

  // 6. no client
  reason = null;
  await auth.signIn({ client: null, google, openExternal: async () => {} }).catch((e) => { reason = e.reason; });
  check('sign-in: no client file is said', /client file/.test(reason || ''), reason);
}

/* ------------------------------------------------------------------ the Google client (fake fetch) */
function fakeFetch(routes, log) {
  return async (url, opts) => {
    log.push({ url, opts });
    for (const r of routes) {
      if (r.match(url, opts)) {
        const a = typeof r.answer === 'function' ? r.answer(url, opts) : r.answer;
        if (a.throw) throw a.throw;
        return { ok: a.status >= 200 && a.status < 300, status: a.status, headers: { get: (h) => (a.headers || {})[h.toLowerCase()] }, text: async () => (a.body === undefined ? '' : JSON.stringify(a.body)) };
      }
    }
    return { ok: false, status: 404, headers: { get: () => null }, text: async () => '{}' };
  };
}
async function testGoogle() {
  const log = [];
  const g = createGoogle({ fetch: fakeFetch([
    { match: (u) => u.startsWith(C.TOKEN_URL), answer: { status: 200, body: { access_token: 'new-access', expires_in: 3599, scope: C.SCOPE } } },
    { match: (u) => u.includes('/events') && !u.includes('pageToken'), answer: { status: 200, body: { items: [{ id: 'a' }], nextPageToken: 'p2', timeZone: 'America/New_York' } } },
    { match: (u) => u.includes('/events') && u.includes('pageToken=p2'), answer: { status: 200, body: { items: [{ id: 'b' }] } } },
    { match: (u) => u.includes('calendarList'), answer: { status: 429, headers: { 'retry-after': '120' }, body: { error: { errors: [{ reason: 'rateLimitExceeded' }] } } } },
  ], log) });
  const client = { clientId: 'id', clientSecret: 'sec' };
  const t = await g.refresh({ client, refreshToken: FAKE_REFRESH });
  const body = new URLSearchParams(log[0].opts.body);
  check('refresh: POST to Google\'s token endpoint, grant_type=refresh_token', log[0].url === 'https://oauth2.googleapis.com/token' && log[0].opts.method === 'POST' && body.get('grant_type') === 'refresh_token' && body.get('refresh_token') === FAKE_REFRESH);
  check('refresh: keeps the old refresh token when Google sends none', t.access === 'new-access' && t.refresh === FAKE_REFRESH && t.expiresAt > Date.now() + 3000e3);
  const ev = await g.events('acc', 'owen@example.com', Date.UTC(2026, 8, 1), Date.UTC(2026, 11, 1));
  check('events: pages followed', ev.items.length === 2 && ev.items[1].id === 'b');
  const q = new URL(log[1].url).searchParams;
  check('events: singleEvents + orderBy=startTime + the window', q.get('singleEvents') === 'true' && q.get('orderBy') === 'startTime' && q.get('timeMin') === '2026-09-01T00:00:00.000Z' && q.get('timeMax') === '2026-12-01T00:00:00.000Z');
  check('events: bearer token in the header, not the URL', log[1].opts.headers.authorization === 'Bearer acc' && !log[1].url.includes('acc&'));
  let err = null; try { await g.calendarList('acc'); } catch (e) { err = e; }
  check('http error: status, body and Retry-After kept', err && err.status === 429 && err.retryAfter === '120' && err.body.error.errors[0].reason === 'rateLimitExceeded');
  let refused = null; try { await g.go('https://example.com/steal', {}); } catch (e) { refused = e; }
  check('host guard: only Google hosts', refused && /Google/.test(refused.reason || ''));
  check('host guard: no request went out for it', !log.some((l) => new URL(l.url).hostname === 'example.com'));
  check('host guard: redirects are refused, never followed (every request)', log.length > 0 && log.every((l) => l.opts && l.opts.redirect === 'error'));
  const g2 = createGoogle({ fetch: fakeFetch([{ match: () => true, answer: { status: 200, body: {} } }], log) });
  check('revoke: posts to oauth2.googleapis.com/revoke', (await g2.revoke('tok')) === true && log[log.length - 1].url === 'https://oauth2.googleapis.com/revoke' && new URLSearchParams(log[log.length - 1].opts.body).get('token') === 'tok');
}

/* ------------------------------------------------------------------ events: all-day, multi-day, zones, declined, cancelled */
function testNormalize() {
  const n = (ev, tz) => C.normalizeEvent(Object.assign({ id: 'e1', summary: 'X', htmlLink: 'https://www.google.com/calendar/event?eid=abc' }, ev), 'cal@x', () => tz || null);
  const a = n({ start: { date: '2026-10-16' }, end: { date: '2026-10-17' } });
  check('all-day: date strings, end exclusive', a.allDay === true && a.s === '2026-10-16' && a.e === '2026-10-17');
  const a2 = n({ start: { date: '2026-10-31' } });
  check('all-day: a missing end is the next day (across a month)', a2.e === '2026-11-01');
  const m = n({ start: { date: '2026-10-16' }, end: { date: '2026-10-19' } });
  check('multi-day all-day: covers 3 days', Days.daysOf(m).join() === '2026-10-16,2026-10-17,2026-10-18', Days.daysOf(m));
  const t = n({ start: { dateTime: '2026-10-16T09:00:00-04:00' }, end: { dateTime: '2026-10-16T10:30:00-04:00' } });
  check('timed: an offset is an absolute instant', t.allDay === false && t.s === Date.UTC(2026, 9, 16, 13, 0) && t.e === Date.UTC(2026, 9, 16, 14, 30));
  const z = n({ start: { dateTime: '2026-10-16T09:00:00', timeZone: 'America/New_York' }, end: { dateTime: '2026-10-16T10:00:00', timeZone: 'America/New_York' } });
  check('timed: no offset is read in the EVENT\'s zone', z.s === Date.UTC(2026, 9, 16, 13, 0), new Date(z.s).toISOString());
  const z2 = n({ start: { dateTime: '2026-01-16T09:00:00', timeZone: 'Europe/London' }, end: { dateTime: '2026-01-16T10:00:00' } });
  check('timed: winter zone (no DST) too', z2.s === Date.UTC(2026, 0, 16, 9, 0), new Date(z2.s).toISOString());
  const zc = n({ start: { dateTime: '2026-10-16T09:00:00' }, end: { dateTime: '2026-10-16T10:00:00' } }, 'Asia/Tokyo');
  check('timed: no offset, no event zone: the CALENDAR\'s zone', zc.s === Date.UTC(2026, 9, 16, 0, 0), new Date(zc.s).toISOString());
  check('declined by me: left out', n({ start: { date: '2026-10-16' }, attendees: [{ self: true, responseStatus: 'declined' }] }) === null);
  check('declined by someone else: kept', !!n({ start: { date: '2026-10-16' }, attendees: [{ email: 'a', responseStatus: 'declined' }, { self: true, responseStatus: 'accepted' }] }));
  check('cancelled instance: left out', n({ status: 'cancelled', start: { date: '2026-10-16' } }) === null);
  check('no title: "(No title)"', n({ summary: '  ', start: { date: '2026-10-16' } }).title === '(No title)');
  check('link: Google\'s page kept', a.link === 'https://www.google.com/calendar/event?eid=abc');
  check('link: anything else dropped', n({ htmlLink: 'http://www.google.com/x', start: { date: '2026-10-16' } }).link === null && n({ htmlLink: 'https://evil.example/', start: { date: '2026-10-16' } }).link === null);
  const back = n({ start: { dateTime: '2026-10-16T10:00:00Z' }, end: { dateTime: '2026-10-16T09:00:00Z' } });
  check('timed: an end before the start is clamped', back.e === back.s);
  const sorted = C.sortEvents([t, a, z].map((x, i) => Object.assign({}, x, { title: 'T' + i })));
  check('sort: all-day first, then by start', sorted[0].allDay === true);
  const cals = C.pickCalendars([{ id: 'me@x.com', summary: 'Me', primary: true, backgroundColor: '#039BE5' }, { id: 'b', summary: 'B', selected: true }, { id: 'c', summary: 'C' }, { id: 'd', summary: 'D', deleted: true }], { b: false });
  check('calendars: primary + selected by default, Owen\'s choice wins, deleted gone', cals.length === 3 && cals[0].id === 'me@x.com' && cals[0].on && cals[0].color === '#039be5' && !cals.find((c) => c.id === 'b').on && !cals.find((c) => c.id === 'c').on);
  check('account: the primary calendar\'s id', C.accountOf([{ id: 'x' }, { id: 'me@x.com', primary: true }]) === 'me@x.com');
}

/* ------------------------------------------------------------------ the bar's day index */
function testDays() {
  const at = (d, h, m) => new Date(2026, 9, d, h, m || 0).getTime();
  const evs = [
    { k: '1', cal: 'a', title: 'Standup', allDay: false, s: at(16, 7), e: at(16, 8) },
    { k: '2', cal: 'a', title: 'Trip', allDay: true, s: '2026-10-16', e: '2026-10-18' },
    { k: '3', cal: 'b', title: 'Overnight', allDay: false, s: at(17, 22), e: at(18, 6) },
    { k: '4', cal: 'b', title: 'Ends at midnight', allDay: false, s: at(19, 22), e: at(20, 0) },
    { k: '5', cal: 'gone', title: 'Unticked', allDay: true, s: '2026-10-21', e: '2026-10-22' },
  ];
  const idx = Days.index({ ver: 3, spans: [{ from: new Date(2026, 8, 1).getTime(), to: new Date(2026, 11, 1).getTime() }], calendars: [{ id: 'a', color: '#33b679' }, { id: 'b', color: '#8e24aa' }], events: evs });
  check('days: all-day first on its day', idx.days.get('2026-10-16').map((e) => e.k).join() === '2,1');
  check('days: an overnight event is on both days', idx.days.get('2026-10-17').some((e) => e.k === '3') && idx.days.get('2026-10-18').some((e) => e.k === '3'));
  check('days: ending exactly at midnight stays on its day', !idx.days.has('2026-10-20'));
  check('days: an unticked calendar\'s events are not drawn', !idx.days.has('2026-10-21'));
  check('dot: one calendar -> its colour', Days.dotOf(idx, '2026-10-16').color === '#33b679');
  check('dot: several calendars -> neutral', Days.dotOf(idx, '2026-10-17').color === null && Days.dotOf(idx, '2026-10-17').many);
  check('dot: no events -> none', Days.dotOf(idx, '2026-10-25') === null);
  check('time: start time, 12-hour', Days.timeOf(evs[0], '2026-10-16') === '7:00 AM');
  check('time: all-day', Days.timeOf(evs[1], '2026-10-17') === 'All day');
  check('time: the next morning says Until', Days.timeOf(evs[2], '2026-10-18') === 'Until 6:00 AM');
  check('covers: the cached months', Days.covers(idx, 2026, 9) && Days.covers(idx, 2026, 10) && !Days.covers(idx, 2026, 11));
  check('ago: words', Days.ago(Date.now() - 12 * 60000) === '12 min ago' && Days.ago(Date.now()) === 'just now');
}

/* ------------------------------------------------------------------ errors and backoff */
function testErrors() {
  const net = Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } });
  check('classify: no network -> offline', C.classify(net).kind === 'offline' && C.classify(net).reason === 'no internet connection');
  check('classify: 401 -> sign in again', C.classify({ status: 401 }).kind === 'auth');
  check('classify: invalid_grant -> sign in again', C.classify({ status: 400, body: { error: 'invalid_grant' } }).kind === 'auth');
  const r429 = C.classify({ status: 429, retryAfter: '90' });
  check('classify: 429 -> rate, Retry-After read', r429.kind === 'rate' && r429.retryAfterMs === 90000);
  check('classify: 403 rateLimitExceeded -> rate', C.classify({ status: 403, body: { error: { errors: [{ reason: 'userRateLimitExceeded' }] } } }).kind === 'rate');
  check('classify: 403 API off -> denied, says turn it on', /not turned on/.test(C.classify({ status: 403, body: { error: { errors: [{ reason: 'accessNotConfigured' }] } } }).reason));
  check('classify: 503 -> server', C.classify({ status: 503 }).kind === 'server');
  const mid = () => 0.5;
  check('backoff: 1, 2, 4 min', C.backoffMs(1, 0, mid) === 60000 && C.backoffMs(2, 0, mid) === 120000 && C.backoffMs(3, 0, mid) === 240000);
  check('backoff: capped at 30 min', C.backoffMs(20, 0, mid) === 30 * 60000);
  check('backoff: jitter stays within 20%', C.backoffMs(1, 0, () => 0) === 48000 && C.backoffMs(1, 0, () => 1) === 72000);
  check('backoff: a longer Retry-After wins', C.backoffMs(1, 600000, mid) === 600000);
}

/* ------------------------------------------------------------------ the store (fake safeStorage) */
function fakeSafe(on) {
  return {
    isEncryptionAvailable: () => on,
    encryptString: (s) => Buffer.concat([Buffer.from('DPAPI'), Buffer.from(s, 'utf8').map((b) => b ^ 0x5a)]),
    decryptString: (b) => { if (b.slice(0, 5).toString() !== 'DPAPI') throw new Error('bad'); return Buffer.from(b.slice(5).map((x) => x ^ 0x5a)).toString('utf8'); },
  };
}
function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-gcal-test-')); }
function testStore() {
  const dir = tmpDir();
  const s = createStore({ dir, safeStorage: fakeSafe(true) });
  s.putToken({ access: FAKE_TOKEN, refresh: FAKE_REFRESH });
  const raw = fs.readFileSync(path.join(dir, 'token.bin'));
  check('store: the token file is encrypted (no token text in it)', !raw.includes(FAKE_REFRESH) && !raw.includes(FAKE_TOKEN));
  check('store: the token reads back', s.getToken().refresh === FAKE_REFRESH);
  s.putCache({ events: [{ k: '1' }], syncedAt: 5 });
  check('store: the cache reads back', s.getCache().events.length === 1 && s.getCache().v === 1);
  check('store: no temp files left', fs.readdirSync(dir).every((f) => !f.endsWith('.tmp')));
  s.deleteToken(); s.deleteCache();
  check('store: delete removes both files', !fs.existsSync(path.join(dir, 'token.bin')) && !fs.existsSync(path.join(dir, 'cache.json')));
  check('store: deleting twice is fine', s.deleteToken() === true && s.deleteCache() === true);
  const off = createStore({ dir, safeStorage: fakeSafe(false) });
  let why = null; try { off.putToken({ refresh: 'x' }); } catch (e) { why = e.reason; }
  check('store: no DPAPI = never stored in plain text', /DPAPI/.test(why || '') && !fs.existsSync(path.join(dir, 'token.bin')));
  fs.writeFileSync(path.join(dir, 'token.bin'), 'garbage');
  check('store: an unreadable token is "broken" with a reason', /decrypted/.test((s.getToken() || {}).broken || ''));
  fs.rmSync(dir, { recursive: true, force: true });
}

/* ------------------------------------------------------------------ the engine */
function rig(opts) {
  const o = opts || {};
  const dir = tmpDir();
  const store = createStore({ dir, safeStorage: fakeSafe(true) });
  let clock = o.now || new Date(2026, 9, 16, 12, 0).getTime();
  const timers = [];
  const calls = { refresh: 0, list: 0, events: [], revoke: [] };
  const google = {
    refresh: async () => { calls.refresh++; if (o.refreshFail) throw o.refreshFail; return { access: 'acc' + calls.refresh, refresh: FAKE_REFRESH, expiresAt: clock + 3600e3, scopes: [C.SCOPE] }; },
    calendarList: async (acc) => {
      calls.list++; calls.lastAcc = acc;
      if (o.hold) { const h = o.hold(); if (h) await h; }
      if (o.listFail) { const f = o.listFail.shift ? o.listFail.shift() : o.listFail; if (f) throw f; }
      if (o.emptyList) return [];
      return [{ id: 'owen@example.com', summary: 'Owen', primary: true, backgroundColor: '#039be5', timeZone: 'America/New_York' }, { id: 'club', summary: 'Club', selected: true, backgroundColor: '#33b679' }, { id: 'other', summary: 'Other' }];
    },
    events: async (acc, cal, from, to) => {
      calls.events.push({ cal, from, to });
      if (o.eventsFail && o.eventsFail[cal]) throw o.eventsFail[cal];
      const d = new Date(from); const mid = new Date(d.getFullYear(), d.getMonth() + 1, 16, 9).getTime();
      return { items: [
        { id: cal + '-1', summary: cal + ' thing', start: { dateTime: new Date(mid).toISOString() }, end: { dateTime: new Date(mid + 3600e3).toISOString() }, htmlLink: 'https://www.google.com/calendar/event?eid=' + cal },
        { id: cal + '-x', status: 'cancelled', start: { date: '2026-10-16' } },
      ] };
    },
    revoke: async (t) => { calls.revoke.push(t); if (o.revokeFail) throw o.revokeFail; return true; },
  };
  const pubs = [];
  let choices = {};
  let online = o.online === undefined ? true : o.online;
  const eng = createEngine({
    store, google, now: () => clock, random: () => 0.5,
    setTimeout: (fn, ms) => { const t = { fn, ms, at: clock + ms, live: true }; timers.push(t); return t; },
    clearTimeout: (t) => { if (t) t.live = false; },
    isOnline: () => online,
    signIn: o.signIn || (async () => ({ access: 'acc0', refresh: FAKE_REFRESH, expiresAt: clock + 3600e3, scopes: [C.SCOPE] })),
    choices: () => choices, saveChoices: (v) => { choices = v; },
    log: (line) => { if (o.logs) o.logs.push(line); },
    publish: (s, e) => pubs.push({ s, e }),
  });
  return {
    dir, store, eng, calls, pubs, timers,
    get clock() { return clock; }, advance(ms) { clock += ms; },
    setOnline(v) { online = v; },
    live: () => timers.filter((t) => t.live),
    async fire() { const t = timers.filter((x) => x.live).sort((a, b) => a.at - b.at)[0]; if (!t) return false; t.live = false; if (t.at > clock) clock = t.at; t.fn(); await flush(); return true; },
    choices: () => choices,
    done() { eng.stop(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

async function testEngine() {
  // a leftover cache with no sign-in is deleted on start (privacy claim 6)
  let r = rig();
  r.store.putCache({ events: [{ k: 'old' }] });
  r.eng.start();
  check('start: no sign-in -> a leftover cache is deleted', !fs.existsSync(path.join(r.dir, 'cache.json')));
  check('start: not connected is published', r.pubs.length === 1 && r.pubs[0].s.signedIn === false && r.pubs[0].e.events.length === 0);
  const no = await r.eng.signIn();
  check('sign in: refused without a client file', no.ok === false && /client file/.test(no.reason));
  const bad = await r.eng.setClient('{"web":{}}');
  check('client: a wrong file is refused in words', bad.ok === false && /Desktop app/.test(bad.reason));
  const good = await r.eng.setClient(CLIENT_JSON);
  check('client: saved encrypted', good.ok && fs.existsSync(path.join(r.dir, 'client.bin')) && !fs.readFileSync(path.join(r.dir, 'client.bin')).includes('fake-secret'));
  const si = await r.eng.signIn();
  await flush();
  check('sign in: ok, account from the primary calendar', si.ok && si.account === 'owen@example.com', si);
  check('sign in: the token is on disk, encrypted', fs.existsSync(path.join(r.dir, 'token.bin')) && !fs.readFileSync(path.join(r.dir, 'token.bin')).includes(FAKE_REFRESH));
  const st = r.eng.status();
  check('sync: primary + selected calendars read, the rest not', r.calls.events.map((e) => e.cal).sort().join() === 'club,owen@example.com');
  const w = C.windowAround(r.clock);
  check('sync: the window is this month +-1', r.calls.events[0].from === w.from && r.calls.events[0].to === w.to && new Date(w.from).getMonth() === 8 && new Date(w.to).getMonth() === 11);
  check('sync: cancelled instances dropped', r.eng.eventsPayload().events.length === 2);
  check('sync: the bar gets no links', r.eng.eventsPayload().events.every((e) => !('link' in e)));
  check('sync: cached to disk', r.store.getCache().events.length === 2 && r.store.getCache().syncedAt === r.clock);
  check('sync: status says when', st.syncedAt === r.clock && st.error === null && st.connected);
  check('sync: next one in 10 min', r.live().length === 1 && r.live()[0].ms === PERIOD_MS);
  check('open: the link is looked up by key', /eid=club$/.test(r.eng.linkOf(r.eng.eventsPayload().events.find((e) => e.cal === 'club').k)));

  // opened(): fresh -> nothing; stale -> a background sync
  const before = r.calls.list;
  check('opened: under 2 min old -> no sync', r.eng.opened().synced === false && r.calls.list === before);
  r.advance(STALE_MS + 1000);
  check('opened: over 2 min old -> background sync', r.eng.opened().synced === true);
  await flush();
  check('opened: ...it ran', r.calls.list === before + 1);

  // the access token expires: refreshed once, then used
  r.advance(3700e3);
  const refreshes = r.calls.refresh;
  await r.eng.syncNow('test');
  check('token: refreshed when expired, the new one used', r.calls.refresh === refreshes + 1 && r.calls.lastAcc === 'acc' + r.calls.refresh);
  check('token: the refreshed token is saved', r.store.getToken().access === 'acc' + r.calls.refresh && r.store.getToken().refresh === FAKE_REFRESH);

  // want(): a month outside the cache is fetched and merged
  const nEv = r.eng.eventsPayload().events.length;
  const wr = r.eng.want(2027, 2);
  await flush();
  check('want: a far month is fetched', wr.loading === true && r.calls.events.slice(-1)[0].from === new Date(2027, 1, 1).getTime());
  check('want: merged, the base kept', r.eng.eventsPayload().events.length === nEv + 2 && r.eng.eventsPayload().spans.length === 2);
  check('want: a covered month asks nothing', r.eng.want(2026, 9).covered === true);

  // setCalendar
  const sc = r.eng.setCalendar('club', false);
  check('calendar off: saved, its events gone at once', sc.ok && r.choices().club === false && r.eng.eventsPayload().events.every((e) => e.cal !== 'club'));
  check('calendar: an unknown id is refused', r.eng.setCalendar('nope', true).ok === false);

  // sign out: revoke + delete token AND cache
  const so = await r.eng.signOut();
  check('sign out: revoked at Google with the refresh token', so.ok && so.revoked && r.calls.revoke[0] === FAKE_REFRESH);
  check('sign out: token AND cache deleted from disk', !fs.existsSync(path.join(r.dir, 'token.bin')) && !fs.existsSync(path.join(r.dir, 'cache.json')));
  check('sign out: nothing left in memory or on the bar', r.eng.eventsPayload().events.length === 0 && r.eng.status().signedIn === false && r.eng.status().account === null && r.pubs.slice(-1)[0].e.events.length === 0);
  check('sign out: no sync timer left', r.live().length === 0);
  check('sign out: the client file stays (not his data)', fs.existsSync(path.join(r.dir, 'client.bin')));
  r.done();

  // sign out while offline: still deleted, and it says Google was not told
  r = rig({ revokeFail: Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } }) });
  await r.eng.setClient(CLIENT_JSON); r.eng.start(); await r.eng.signIn(); await flush();
  const so2 = await r.eng.signOut();
  check('sign out offline: deleted anyway', !fs.existsSync(path.join(r.dir, 'token.bin')) && !fs.existsSync(path.join(r.dir, 'cache.json')));
  check('sign out offline: says Google could not be told, and where to remove it', so2.ok && so2.revoked === false && /myaccount\.google\.com\/permissions/.test(so2.reason));
  r.done();

  // sign out while a sync is in flight: its late answer is dropped; nothing is written back (claim 6)
  {
    let release = null, holdOn = false;
    r = rig({ hold: () => (holdOn ? new Promise((res) => { release = res; }) : null) });
    await r.eng.setClient(CLIENT_JSON); r.eng.start(); await r.eng.signIn(); await flush();
    holdOn = true;
    const p = r.eng.syncNow('asked'); await flush();
    const evCalls = r.calls.events.length;
    const so3 = await r.eng.signOut();
    holdOn = false; if (release) release(); await p; await flush();
    check('sign out mid-sync: a sync really was in flight', typeof release === 'function');
    check('sign out mid-sync: the late answer writes no cache and no token', so3.ok && !fs.existsSync(path.join(r.dir, 'cache.json')) && !fs.existsSync(path.join(r.dir, 'token.bin')));
    check('sign out mid-sync: no events request after sign out', r.calls.events.length === evCalls, r.calls.events.length - evCalls);
    const st = r.eng.status();
    check('sign out mid-sync: nothing back in memory or on the bar', r.eng.eventsPayload().events.length === 0 && st.signedIn === false && st.syncing === false && st.error === null && st.account === null && r.pubs.slice(-1)[0].s.signedIn === false);
    check('sign out mid-sync: no timer re-armed', r.live().length === 0);
    const si = await r.eng.signIn(); await flush();
    check('sign in again after it: a fresh sync runs (not the dropped one)', si.ok && r.eng.eventsPayload().events.length > 0 && fs.existsSync(path.join(r.dir, 'cache.json')));
    r.done();
  }

  // a timer firing while the revoke is out cannot start a sync
  {
    r = rig();
    await r.eng.setClient(CLIENT_JSON); r.eng.start(); await r.eng.signIn(); await flush();
    const lists = r.calls.list;
    const so4p = r.eng.signOut();            // now awaiting the revoke
    const during = await r.eng.syncNow('timer');
    await so4p; await flush();
    check('sign out: a sync asked while the revoke is out does not run', r.calls.list === lists && during.signedIn === false && !fs.existsSync(path.join(r.dir, 'cache.json')));
    r.done();
  }

  // an empty calendar list (a brand-new account): no throw, 0 events, connected, a clean status
  r = rig({ emptyList: true });
  await r.eng.setClient(CLIENT_JSON); r.eng.start();
  let siE = null, thrown = null;
  try { siE = await r.eng.signIn(); await flush(); } catch (e) { thrown = e; }
  const sE = r.eng.status();
  check('empty calendar list: no throw, signed in, connected', !thrown && siE && siE.ok && sE.connected === true, thrown && thrown.message);
  check('empty calendar list: 0 calendars, 0 events, no error', sE.calendars.length === 0 && r.eng.eventsPayload().events.length === 0 && sE.error === null, sE.error);
  check('empty calendar list: no events request, the cache says so', r.calls.events.length === 0 && r.store.getCache() && r.store.getCache().events.length === 0);
  r.done();

  // every ticked calendar fails: Owen is told which one; Mantle's log line names none
  {
    const logs = [];
    const gone = { status: 404, body: { error: { errors: [{ reason: 'notFound' }] } } };
    r = rig({ logs, eventsFail: { 'owen@example.com': gone, club: gone } });
    await r.eng.setClient(CLIENT_JSON); r.eng.start(); await r.eng.signIn(); await flush();
    const sF = r.eng.status();
    check('all calendars fail: said in words, naming the calendar', sF.error && /"(Owen|Club)" could not be read/.test(sF.error.reason), sF.error);
    check('all calendars fail: no calendar name or address in the log', logs.some((l) => /sync failed/.test(l)) && !logs.some((l) => /Owen|Club|owen@example/.test(l)), logs);
    r.done();
  }

  // deleting also removes a half-written temp file a crash left behind (claim 6)
  r = rig();
  fs.mkdirSync(r.dir, { recursive: true });
  r.store.putCache({ events: [] });
  fs.writeFileSync(path.join(r.dir, 'cache.json.4242.tmp'), '{"v":1,"events":[{"title":"leftover"}]}');
  fs.writeFileSync(path.join(r.dir, 'token.bin.4242.tmp'), 'x');
  r.store.deleteCache(); r.store.deleteToken();
  check('delete: leftover cache/token temp files go too', fs.readdirSync(r.dir).filter((n) => /^(cache\.json|token\.bin)/.test(n)).length === 0, fs.readdirSync(r.dir));
  r.done();

  // a restart opens from the cache, then syncs in the background a few seconds later
  r = rig();
  await r.eng.setClient(CLIENT_JSON); r.eng.start(); await r.eng.signIn(); await flush();
  const dir = r.dir;
  const r2 = createEngine({ store: createStore({ dir, safeStorage: fakeSafe(true) }), google: { calendarList: async () => { throw new Error('should not be called on start'); } },
    now: () => r.clock, setTimeout: (fn, ms) => ({ fn, ms }), clearTimeout: () => {}, choices: () => ({}), saveChoices: () => {}, publish: () => {} });
  r2.start();
  check('restart: events from the cache with no request', r2.eventsPayload().events.length === 2 && r2.status().account === 'owen@example.com');
  r2.stop(); r.done();

  // offline: cache kept, backoff, the network coming back syncs
  const offline = Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } });
  r = rig({ listFail: [null, offline, offline] });
  await r.eng.setClient(CLIENT_JSON); r.eng.start(); await r.eng.signIn(); await flush();
  r.advance(PERIOD_MS); await r.eng.syncNow('t'); await flush();
  let s = r.eng.status();
  check('offline: error said, cache kept', s.error && s.error.kind === 'offline' && r.eng.eventsPayload().events.length === 2);
  check('offline: next try after the 1-min backoff', s.nextAt - r.clock === 60000, s.nextAt - r.clock);
  check('offline: a 30 s isOnline poll is armed', r.live().some((t) => t.ms === ONLINE_POLL_MS));
  r.setOnline(false);
  const poll = r.live().find((t) => t.ms === ONLINE_POLL_MS); poll.live = false; poll.fn(); await flush();
  check('offline: still offline -> no request, poll again', r.calls.list === 2 && r.live().some((t) => t.ms === ONLINE_POLL_MS));
  r.setOnline(true);
  const poll2 = r.live().find((t) => t.ms === ONLINE_POLL_MS); poll2.live = false; poll2.fn(); await flush();
  check('offline: network back -> sync at once', r.calls.list === 3);
  r.done();

  // 429: Retry-After obeyed; opening, a month change and resume do not ask early
  r = rig({ listFail: [null, { status: 429, retryAfter: '900' }] });
  await r.eng.setClient(CLIENT_JSON); r.eng.start(); await r.eng.signIn(); await flush();
  r.advance(PERIOD_MS); await r.eng.syncNow('t'); await flush();
  s = r.eng.status();
  check('429: rate error said, Retry-After 15 min obeyed', s.error.kind === 'rate' && s.nextAt - r.clock === 900000, s.nextAt - r.clock);
  const n429 = r.calls.list;
  r.advance(STALE_MS * 2);
  r.eng.opened(); r.eng.want(2027, 5); await r.eng.syncNow('forced'); await flush();
  check('429: nothing asks Google early (open, month, even a forced sync)', r.calls.list === n429);
  r.done();

  // the refresh token died: sign in again, cache shown, no more tries
  r = rig({ refreshFail: { status: 400, body: { error: 'invalid_grant' } } });
  await r.eng.setClient(CLIENT_JSON); r.eng.start(); await r.eng.signIn(); await flush();
  r.advance(3700e3); await r.eng.syncNow('t'); await flush();
  s = r.eng.status();
  check('invalid_grant: needs sign-in, said in words', s.needsSignIn && s.connected === false && /sign in again/.test(s.error.reason));
  check('invalid_grant: cached events still shown', r.eng.eventsPayload().events.length === 2);
  check('invalid_grant: no more timers', r.live().length === 0);
  r.done();

  // a 401 on the API: refreshed and retried once
  r = rig({ listFail: [null, { status: 401 }] });
  await r.eng.setClient(CLIENT_JSON); r.eng.start(); await r.eng.signIn(); await flush();
  const rf = r.calls.refresh;
  await r.eng.syncNow('t'); await flush();
  check('401: one refresh, one retry, then fine', r.calls.refresh === rf + 1 && r.eng.status().error === null);
  r.done();

  // one calendar failing: the rest shown, the failure named
  r = rig({ eventsFail: { club: { status: 404 } } });
  await r.eng.setClient(CLIENT_JSON); r.eng.start(); await r.eng.signIn(); await flush();
  s = r.eng.status();
  check('one calendar fails: the others shown, the failure named', r.eng.eventsPayload().events.length === 1 && s.error && s.error.kind === 'partial' && /Club/.test(s.error.reason));
  r.done();

  // resume from sleep: a sync a few seconds later
  r = rig();
  await r.eng.setClient(CLIENT_JSON); r.eng.start(); await r.eng.signIn(); await flush();
  r.eng.resume();
  const lc = r.calls.list;
  await r.fire();
  check('resume: syncs a few seconds after waking', r.calls.list === lc + 1);
  r.done();
}

/* ------------------------------------------------------------------ the feature module + privacy */
function testFeatureAndPrivacy() {
  const feature = require('./gcal.js');
  const { validate } = require('../features.js');
  check('feature: passes the features contract', validate(feature, 'gcal') === null, validate(feature, 'gcal'));
  const files = ['_gcal-core.js', '_gcal-google.js', '_gcal-auth.js', '_gcal-store.js', '_gcal-sync.js', 'gcal.js'].map((f) => path.join(__dirname, f))
    .concat([path.join(__dirname, '../../ui/bar/gcal.js'), path.join(__dirname, '../../ui/bar/gcal-days.js')]);
  const urls = [];
  for (const f of files) for (const m of fs.readFileSync(f, 'utf8').matchAll(/https?:\/\/[a-z0-9.-]+/gi)) urls.push(m[0]);
  const allowed = /^(https:\/\/(accounts\.google\.com|oauth2\.googleapis\.com|www\.googleapis\.com|www\.google\.com|calendar\.google\.com|owen-silva\.github\.io)|http:\/\/127\.0\.0\.1)$/;
  const strange = urls.filter((u) => !allowed.test(u));
  check('privacy: the gcal code names only Google hosts (and this PC)', strange.length === 0, strange);
  const scopes = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n').match(/https:\/\/www\.googleapis\.com\/auth\/[a-z.]+/g) || [];
  check('privacy: the only scope anywhere is calendar.readonly', scopes.length > 0 && scopes.every((s) => s === C.SCOPE), scopes);
  const src = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  check('privacy: no token, title or address is ever logged', !/log\([^)]*(access|refresh|title|summary|account|clientSecret)\b/.test(src.replace(/log\('(signed in|signed out[^']*)'/g, '')));
}

(async () => {
  try {
    testAuthUrl(); testClientFile(); await testLoopback(); await testGoogle(); testNormalize(); testDays(); testErrors(); testStore(); await testEngine(); testFeatureAndPrivacy();
  } catch (e) { fails.push('threw: ' + (e && e.stack || e)); }
  for (const f of fails) console.log('  FAIL ' + f);
  console.log('GCAL UNIT TEST: ' + passed + ' passed, ' + fails.length + ' failed');
  process.exitCode = fails.length ? 1 : 0;
})();
