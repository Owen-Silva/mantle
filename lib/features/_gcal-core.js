'use strict';
/*
 * _gcal-core.js - the pure half of Google Calendar in the clock's calendar (lane mantle-gcal, 2026-10-16).
 *
 * No Electron, no network, no disk: PKCE, the consent URL, the client file, the sync window, turning
 * Google's events into the small rows the bar draws, plain-words errors and the backoff. Everything here
 * is unit-tested with made-up data (lib/features/gcal.test.js).
 *
 * PRIVACY (https://owen-silva.github.io/mantle/privacy.html, every claim must be true in code):
 *   - the ONLY scope is calendar.readonly (SCOPE below; the consent URL carries nothing else);
 *   - the only hosts are Google's: accounts.google.com (consent page, opened in the user's own browser),
 *     oauth2.googleapis.com (token + revoke) and www.googleapis.com/calendar/v3 (the Calendar API).
 */
const crypto = require('crypto');

const SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const API = 'https://www.googleapis.com/calendar/v3';
const HOSTS = ['accounts.google.com', 'oauth2.googleapis.com', 'www.googleapis.com'];

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/* RFC 7636: a 43-128 character verifier from the unreserved set, S256 challenge. */
function pkce(randomBytes) {
  const rb = randomBytes || crypto.randomBytes;
  const verifier = b64url(rb(32));                       // 43 chars
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge, method: 'S256' };
}

function newState(randomBytes) { return b64url((randomBytes || crypto.randomBytes)(24)); }

/* Constant-time state comparison: the loopback answer must carry the exact state we sent. */
function stateMatches(sent, got) {
  if (typeof sent !== 'string' || typeof got !== 'string' || !sent || sent.length !== got.length) return false;
  return crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(got));
}

/* The consent page URL. access_type=offline + prompt=consent so Google gives a refresh token every time. */
function authUrl({ clientId, redirectUri, challenge, state }) {
  if (!clientId || !redirectUri || !challenge || !state) throw new Error('the sign-in link is missing a part');
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}\/$/.test(redirectUri)) throw new Error('the sign-in answer must come back to this PC (127.0.0.1)');
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    access_type: 'offline',
    prompt: 'consent',
  });
  return AUTH_URL + '?' + q.toString();
}

/* The JSON Google Cloud hands out for a "Desktop app" client: { installed: { client_id, client_secret, ... } }.
   A "Web application" client ({ web: ... }) cannot use a loopback answer on a random port, so it is refused
   in words. Nothing from the file is ever logged. */
function parseClientFile(text) {
  let j;
  try { j = JSON.parse(String(text || '').replace(/^﻿/, '')); } catch (e) { throw new Error('that file is not a Google client file (it is not JSON)'); }
  if (!j || typeof j !== 'object') throw new Error('that file is not a Google client file');
  if (j.web && !j.installed) throw new Error('that is a "Web application" client; Mantle needs a "Desktop app" client (Google Cloud > Clients > Create client > Desktop app)');
  const c = j.installed;
  if (!c || typeof c !== 'object') throw new Error('that file is not a Google "Desktop app" client file (it has no "installed" part)');
  const id = typeof c.client_id === 'string' ? c.client_id.trim() : '';
  const secret = typeof c.client_secret === 'string' ? c.client_secret.trim() : '';
  if (!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(id)) throw new Error('the client file has no valid client ID');
  if (!secret) throw new Error('the client file has no client secret');
  return { clientId: id, clientSecret: secret, project: typeof c.project_id === 'string' ? c.project_id.slice(0, 80) : null };
}

/* ------------------------------------------------------------------ the sync window */

/* The displayed month +-1 month: [1st of month-1, 1st of month+2), local time. */
function monthWindow(year, month) {
  const from = new Date(year, month - 1, 1);
  const to = new Date(year, month + 2, 1);
  return { from: from.getTime(), to: to.getTime(), key: year + '-' + String(month + 1).padStart(2, '0') };
}

function windowAround(now) {
  const d = new Date(now);
  return monthWindow(d.getFullYear(), d.getMonth());
}

/* ------------------------------------------------------------------ calendars and events */

const HEX = /^#[0-9a-f]{6}$/i;

/* Which calendars are read: the user's own choice per calendar (Settings) wins; with no choice, the primary
   calendar plus those Google marks selected (the ones ticked in Google Calendar's own sidebar). */
function pickCalendars(items, choices) {
  const ch = choices && typeof choices === 'object' ? choices : {};
  return (Array.isArray(items) ? items : [])
    .filter((c) => c && typeof c.id === 'string' && !c.deleted)
    .map((c) => {
      const auto = !!c.primary || !!c.selected;
      const on = Object.prototype.hasOwnProperty.call(ch, c.id) ? !!ch[c.id] : auto;
      return {
        id: c.id,
        name: String(c.summaryOverride || c.summary || c.id).slice(0, 120),
        color: HEX.test(c.backgroundColor || '') ? c.backgroundColor.toLowerCase() : null,
        primary: !!c.primary,
        on,
      };
    })
    .sort((a, b) => (b.primary - a.primary) || a.name.localeCompare(b.name));
}

/* The account's address: the primary calendar's id IS the Google account's email. This is how Mantle
   shows "signed in as" with the calendar.readonly scope alone (no email/profile scope is asked for). */
function accountOf(items) {
  const p = (Array.isArray(items) ? items : []).find((c) => c && c.primary);
  return p && typeof p.id === 'string' && p.id.indexOf('@') > 0 ? p.id : null;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/* Did the signed-in person decline it? Google marks their own attendee entry with self:true. */
function declined(ev) {
  return Array.isArray(ev.attendees) && ev.attendees.some((a) => a && a.self && a.responseStatus === 'declined');
}

/* One Google event -> the row the bar draws, or null to leave it out.
     { k, cal, title, allDay, s, e, link }
   all-day: s/e are 'YYYY-MM-DD' calendar dates, e EXCLUSIVE (Google's own convention), no time zone:
            an all-day event is the same days wherever the PC is.
   timed:   s/e are epoch ms (absolute instants: Google's dateTime carries its offset); the bar places
            them on the PC's local days and shows the PC's local time. The event's own timeZone only
            matters when dateTime has no offset, which Google does not send for single instances. */
function normalizeEvent(ev, calId, tzOf) {
  if (!ev || typeof ev !== 'object' || typeof ev.id !== 'string') return null;
  if (ev.status === 'cancelled') return null;             // a cancelled instance of a recurring event
  if (declined(ev)) return null;
  const st = ev.start || {}, en = ev.end || {};
  const out = { k: calId.length + ':' + calId + ev.id, cal: calId, title: typeof ev.summary === 'string' && ev.summary.trim() ? ev.summary.trim().slice(0, 200) : '(No title)' };
  if (typeof st.date === 'string' && DATE.test(st.date)) {
    out.allDay = true;
    out.s = st.date;
    out.e = typeof en.date === 'string' && DATE.test(en.date) && en.date > st.date ? en.date : nextDate(st.date);
  } else if (typeof st.dateTime === 'string') {
    const s = parseDateTime(st.dateTime, st.timeZone || (tzOf && tzOf(calId)));
    let e = typeof en.dateTime === 'string' ? parseDateTime(en.dateTime, en.timeZone || st.timeZone || (tzOf && tzOf(calId))) : s;
    if (!Number.isFinite(s)) return null;
    if (!Number.isFinite(e) || e < s) e = s;
    out.allDay = false; out.s = s; out.e = e;
  } else return null;
  out.link = safeLink(ev.htmlLink);
  return out;
}

function nextDate(d) {
  const [y, m, day] = d.split('-').map(Number);
  const n = new Date(Date.UTC(y, m - 1, day + 1));
  return n.toISOString().slice(0, 10);
}

/* RFC 3339 with an offset is an absolute instant. Without one (never seen from Google for single events,
   but the field allows it) the wall time is read in the event's time zone. */
function parseDateTime(s, tz) {
  if (/[zZ]$|[+-]\d{2}:\d{2}$/.test(s)) return Date.parse(s);
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(s);
  if (!m) return NaN;
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  if (!tz) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)).getTime();   // the PC's zone
  return wall - zoneOffsetMs(tz, wall);
}

/* The offset of time zone `tz` at (about) the instant `utcMs`, through Intl. Two passes settle DST edges. */
function zoneOffsetMs(tz, utcMs) {
  try {
    const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const at = (ms) => {
      const p = {}; for (const x of f.formatToParts(new Date(ms))) p[x.type] = x.value;
      return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
    };
    const o1 = at(utcMs);
    return at(utcMs - o1);
  } catch (e) { return 0; }
}

/* Only Google Calendar's own event pages are ever opened from a row. */
function safeLink(u) {
  if (typeof u !== 'string' || u.length > 2000) return null;
  try {
    const x = new URL(u);
    if (x.protocol !== 'https:') return null;
    if (x.hostname !== 'www.google.com' && x.hostname !== 'calendar.google.com') return null;
    return x.toString();
  } catch (e) { return null; }
}

/* Sorted the way the agenda reads: all-day first, then by start, then by title. */
function sortEvents(list) {
  return list.sort((a, b) => (b.allDay - a.allDay) ||
    (a.allDay ? (a.s < b.s ? -1 : a.s > b.s ? 1 : 0) : a.s - b.s) || a.title.localeCompare(b.title));
}

/* ------------------------------------------------------------------ errors in plain words */

/* An HTTP answer or a thrown fetch -> { kind, reason, retryAfterMs }.
   kind: offline | auth (sign in again) | denied (a setup problem) | rate (slow down) | server | other */
function classify(err) {
  if (!err) return { kind: 'other', reason: 'something went wrong and no reason came back' };
  if (err.kind) return err;
  const status = err.status || 0;
  const reasons = (err.body && err.body.error && Array.isArray(err.body.error.errors) ? err.body.error.errors : []).map((x) => x && x.reason).filter(Boolean);
  const gerr = err.body && typeof err.body.error === 'string' ? err.body.error : '';
  const ra = retryAfter(err.retryAfter);
  if (!status) {
    const code = String((err.cause && err.cause.code) || err.code || '');
    if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ENETUNREACH|EHOSTUNREACH|ETIMEDOUT|UND_ERR|ABORT/i.test(code) || /fetch failed|network|timed out|aborted/i.test(String(err.message || '')))
      return { kind: 'offline', reason: 'no internet connection' };
    return { kind: 'other', reason: 'Google could not be reached (' + String(err.message || 'no reason').slice(0, 80) + ')' };
  }
  if (gerr === 'invalid_grant') return { kind: 'auth', reason: 'Google ended Mantle\'s sign-in; sign in again in Settings' };
  if (gerr === 'invalid_client' || gerr === 'unauthorized_client') return { kind: 'denied', reason: 'Google did not accept the client file; choose it again in Settings' };
  if (status === 401) return { kind: 'auth', reason: 'Google refused Mantle\'s sign-in; sign in again in Settings' };
  if (status === 429 || reasons.some((r) => /rateLimitExceeded|userRateLimitExceeded|quotaExceeded/.test(r)))
    return { kind: 'rate', reason: 'Google asked Mantle to slow down; it will try again later', retryAfterMs: ra };
  if (status === 403 && reasons.some((r) => /accessNotConfigured|SERVICE_DISABLED/i.test(r)))
    return { kind: 'denied', reason: 'the Google Calendar API is not turned on in your Google Cloud project' };
  if (status === 403 && reasons.some((r) => /insufficientPermissions|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(r)))
    return { kind: 'auth', reason: 'Mantle does not have read access to your calendar; sign in again and tick the calendar box' };
  if (status === 403) return { kind: 'denied', reason: 'Google refused the request (error 403)' };
  if (status >= 500) return { kind: 'server', reason: 'Google Calendar had a problem (error ' + status + ')', retryAfterMs: ra };
  return { kind: 'other', reason: 'Google answered with error ' + status };
}

function retryAfter(v) {
  if (v === undefined || v === null || v === '') return 0;
  const n = Number(v);
  if (Number.isFinite(n)) return Math.max(0, Math.min(n, 3600)) * 1000;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? Math.max(0, Math.min(t - Date.now(), 3600000)) : 0;
}

/* The wait before try n (1-based) after a failure: 1, 2, 4, 8 ... minutes, capped at 30, with +-20%
   jitter; a Retry-After from Google is obeyed when it is longer. */
const BACKOFF_BASE_MS = 60 * 1000;
const BACKOFF_MAX_MS = 30 * 60 * 1000;
function backoffMs(n, retryAfterMs, rand) {
  const r = typeof rand === 'function' ? rand() : Math.random();
  const exp = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * Math.pow(2, Math.max(0, (n | 0) - 1)));
  const jit = Math.round(exp * (0.8 + 0.4 * r));
  return Math.max(jit, retryAfterMs || 0);
}

/* "12 min ago" for the status line (also used by the bar, which has its own copy in gcal-days.js). */
function ago(ms, now) {
  const s = Math.max(0, Math.round(((now || Date.now()) - ms) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return m + ' min ago';
  const h = Math.round(m / 60);
  if (h < 48) return h + ' h ago';
  return Math.round(h / 24) + ' days ago';
}

module.exports = {
  SCOPE, AUTH_URL, TOKEN_URL, REVOKE_URL, API, HOSTS,
  pkce, newState, stateMatches, authUrl, parseClientFile,
  monthWindow, windowAround, pickCalendars, accountOf, normalizeEvent, sortEvents, parseDateTime, zoneOffsetMs, safeLink, nextDate,
  classify, retryAfter, backoffMs, BACKOFF_BASE_MS, BACKOFF_MAX_MS, ago, b64url,
};
