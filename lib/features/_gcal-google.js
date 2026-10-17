'use strict';
/*
 * _gcal-google.js - every request Mantle makes to Google, through ONE injected fetch (lane mantle-gcal).
 *
 * Hosts (privacy.html claim 5): oauth2.googleapis.com/token and /revoke, www.googleapis.com/calendar/v3.
 * `go()` refuses any other host, so nothing in this file can talk to anyone else. The unit tests pass
 * a fake fetch and never reach the network. Tokens are never logged or put in an error message.
 */
const C = require('./_gcal-core');

const TIMEOUT_MS = 20000;
const MAX_PAGES = 20;                 // 20 x 2500 events: far past any real month window

function createGoogle({ fetch, timeoutMs }) {
  if (typeof fetch !== 'function') throw new Error('createGoogle needs fetch');

  async function go(url, opts) {
    const u = new URL(url);
    if (u.protocol !== 'https:' || C.HOSTS.indexOf(u.hostname) < 0) throw Object.assign(new Error('refused: not a Google address'), { kind: 'other', reason: 'Mantle only talks to Google' });
    const ac = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ac ? setTimeout(() => ac.abort(), timeoutMs || TIMEOUT_MS) : null;
    let res;
    try {
      res = await fetch(url, Object.assign({}, opts, ac ? { signal: ac.signal } : {}));
    } catch (e) {
      const err = new Error(ac && ac.signal.aborted ? 'timed out' : String((e && e.message) || 'fetch failed'));
      err.cause = e && e.cause; err.code = e && e.code;
      throw err;
    } finally { if (timer) clearTimeout(timer); }
    let body = null;
    const text = await res.text().catch(() => '');
    try { body = text ? JSON.parse(text) : null; } catch (e) { body = null; }
    if (!res.ok) {
      const err = new Error('HTTP ' + res.status);
      err.status = res.status;
      err.body = body;
      err.retryAfter = res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : undefined;
      throw err;
    }
    return body || {};
  }

  const form = (o) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o).toString() });

  /* The code from the loopback answer -> tokens. The PKCE verifier proves we started this sign-in. */
  async function exchange({ client, code, verifier, redirectUri }) {
    const j = await go(C.TOKEN_URL, form({ code, client_id: client.clientId, client_secret: client.clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: verifier }));
    return tokenOf(j, null);
  }

  async function refresh({ client, refreshToken }) {
    const j = await go(C.TOKEN_URL, form({ client_id: client.clientId, client_secret: client.clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }));
    return tokenOf(j, refreshToken);
  }

  function tokenOf(j, oldRefresh) {
    if (!j || typeof j.access_token !== 'string') throw Object.assign(new Error('no access token'), { kind: 'other', reason: 'Google did not send a sign-in token' });
    const scopes = typeof j.scope === 'string' ? j.scope.split(/\s+/) : [C.SCOPE];
    return {
      access: j.access_token,
      refresh: typeof j.refresh_token === 'string' && j.refresh_token ? j.refresh_token : oldRefresh,
      expiresAt: Date.now() + Math.max(60, Number(j.expires_in) || 3600) * 1000,
      scopes,
    };
  }

  /* Revoking the refresh token ends the grant (and every access token from it) at Google. */
  async function revoke(token) {
    await go(C.REVOKE_URL, form({ token }));
    return true;
  }

  async function pages(url, access, key) {
    const out = [];
    let pageToken = null;
    for (let i = 0; i < MAX_PAGES; i++) {
      const u = new URL(url);
      if (pageToken) u.searchParams.set('pageToken', pageToken);
      const j = await go(u.toString(), { headers: { authorization: 'Bearer ' + access, accept: 'application/json' } });
      if (Array.isArray(j[key])) out.push(...j[key]);
      pageToken = typeof j.nextPageToken === 'string' && j.nextPageToken ? j.nextPageToken : null;
      if (!pageToken) return { items: out, timeZone: j.timeZone || null };
    }
    return { items: out, timeZone: null, truncated: true };
  }

  async function calendarList(access) {
    const u = C.API + '/users/me/calendarList?minAccessRole=reader&maxResults=250&fields=' +
      encodeURIComponent('nextPageToken,items(id,summary,summaryOverride,backgroundColor,primary,selected,deleted,timeZone)');
    return (await pages(u, access, 'items')).items;
  }

  async function events(access, calId, from, to) {
    const u = C.API + '/calendars/' + encodeURIComponent(calId) + '/events?' + new URLSearchParams({
      singleEvents: 'true',
      orderBy: 'startTime',
      timeMin: new Date(from).toISOString(),
      timeMax: new Date(to).toISOString(),
      maxResults: '2500',
      showDeleted: 'false',
      fields: 'nextPageToken,timeZone,items(id,status,summary,start,end,htmlLink,attendees(self,responseStatus))',
    }).toString();
    return pages(u, access, 'items');
  }

  return { exchange, refresh, revoke, calendarList, events, go };
}

module.exports = { createGoogle };
