'use strict';
/*
 * _gcal-sync.js - the Google Calendar engine: sign-in state, the background sync, the cache, backoff
 * (lane mantle-gcal, 2026-10-16). Everything it touches is injected (store, google, signIn, clock,
 * timers, isOnline, publish), so lib/features/gcal.test.js drives it with fakes: no network, no token.
 *
 * WHEN IT SYNCS (never on the flyout's open path; the bar draws from what was last published):
 *   - a few seconds after Mantle starts (when signed in), then every 10 minutes;
 *   - on resume from sleep (resume()), and when the network comes back after an offline failure (a
 *     local isOnline() check every 30 s while offline; no request is made to find out);
 *   - after the flyout opened, when the last good sync is older than 2 minutes (opened());
 *   - when the flyout shows a month outside what is cached (want()): that month +-1 is fetched and merged.
 * FAILURES: 1, 2, 4 ... 30 min backoff with jitter; Google's Retry-After is obeyed; during a rate-limit
 * backoff nothing (open, resume, month change) makes it ask early. The cache stays on screen with
 * "Last synced N min ago · <reason>".
 */
const C = require('./_gcal-core');

const PERIOD_MS = 10 * 60 * 1000;
const STALE_MS = 2 * 60 * 1000;
const FIRST_MS = 4000;
const RESUME_MS = 8000;
const ONLINE_POLL_MS = 30000;
const MAX_EVENTS = 5000;

function createEngine(d) {
  const now = d.now || Date.now;
  const setT = d.setTimeout || setTimeout, clearT = d.clearTimeout || clearTimeout;
  const log = d.log || (() => {});
  const S = {
    client: null, clientBroken: null,
    token: null,                  // { access, refresh, expiresAt, scopes }
    account: null,
    calendars: [],
    events: [],
    spans: [],                    // [{ from, to }] the windows the events cover
    syncedAt: 0,
    syncing: false,
    error: null,                  // { kind, reason, at }
    needsSignIn: false,           // the refresh token died (invalid_grant)
    failures: 0,
    nextAt: 0,
    signingIn: false,
    stopped: false,
  };
  let timer = null, onlineTimer = null, inflight = null, again = null, eventsVer = 0;
  /* Bumped by Sign out and by a new sign-in. A sync begun under an older sign-in is dropped when it
     answers: it makes no more requests and writes nothing to memory, the bar or disk (privacy claim 6). */
  let gen = 0;
  const STALE = { kind: 'stale', reason: 'signed out while syncing' };
  const live = (g) => { if (g !== gen) throw STALE; };

  /* ---------------------------------------------------------------- what the pages see */

  function status() {
    return {
      enabled: true,
      client: !!S.client,
      clientReason: S.clientBroken,
      connected: !!S.token && !S.needsSignIn,
      signedIn: !!S.token,
      needsSignIn: S.needsSignIn,
      signingIn: S.signingIn,
      account: S.account,
      calendars: S.calendars.map((c) => ({ id: c.id, name: c.name, color: c.color, primary: c.primary, on: c.on })),
      syncedAt: S.syncedAt || 0,
      syncing: S.syncing,
      error: S.error ? { kind: S.error.kind, reason: S.error.reason, at: S.error.at } : null,
      nextAt: S.error ? S.nextAt : 0,
      canEncrypt: d.store.canEncrypt(),
      ver: eventsVer,
    };
  }

  /* The rows for the bar: no links (a row is opened by its key, main looks the link up). */
  function eventsPayload() {
    const colors = {};
    for (const c of S.calendars) colors[c.id] = c.color;
    return {
      ver: eventsVer,
      spans: S.spans.slice(),
      calendars: S.calendars.filter((c) => c.on).map((c) => ({ id: c.id, color: c.color, name: c.name })),
      events: S.events.map((e) => ({ k: e.k, cal: e.cal, title: e.title, allDay: e.allDay, s: e.s, e: e.e })),
    };
  }

  function publish(withEvents) {
    if (S.stopped) return;
    if (withEvents) eventsVer++;
    try { d.publish(status(), withEvents ? eventsPayload() : null); } catch (e) { log('publish failed: ' + e.message); }
  }

  /* ---------------------------------------------------------------- start */

  function start() {
    S.stopped = false;
    const cl = d.store.getClient();
    if (cl && cl.broken) { S.clientBroken = 'the saved Google client could not be read: ' + cl.broken + '; choose the client file again'; S.client = null; }
    else S.client = cl && cl.clientId ? cl : null;
    const tok = d.store.getToken();
    if (tok && tok.broken) {
      S.token = null; S.needsSignIn = true;
      S.error = { kind: 'auth', reason: 'the saved Google sign-in could not be read: ' + tok.broken + '; sign in again', at: now() };
    } else S.token = tok && tok.refresh ? tok : null;
    if (S.token) {
      S.account = S.token.account || null;
      const c = d.store.getCache();
      if (c) {
        S.calendars = Array.isArray(c.calendars) ? c.calendars : [];
        S.events = c.events.slice(0, MAX_EVENTS);
        S.spans = Array.isArray(c.spans) ? c.spans : [];
        S.syncedAt = Number(c.syncedAt) || 0;
        if (c.account) S.account = c.account;
      }
      plan(FIRST_MS);
    } else {
      // no sign-in: no events may stay on this PC (privacy.html claim 6, a sign-out cut short)
      try { d.store.deleteCache(); } catch (e) { log('could not delete a leftover cache: ' + e.code); }
    }
    publish(true);
  }

  function stop() {
    S.stopped = true;
    if (timer) clearT(timer); timer = null;
    if (onlineTimer) clearT(onlineTimer); onlineTimer = null;
  }

  /* ---------------------------------------------------------------- timers */

  function plan(ms) {
    if (S.stopped) return;
    if (timer) clearT(timer);
    timer = setT(() => { timer = null; syncNow('timer'); }, Math.max(0, ms));
  }

  function watchOnline(on) {
    if (onlineTimer) { clearT(onlineTimer); onlineTimer = null; }
    if (!on || !d.isOnline || S.stopped) return;
    onlineTimer = setT(function poll() {
      onlineTimer = null;
      if (S.stopped || !S.error || S.error.kind !== 'offline') return;
      let up = false;
      try { up = !!d.isOnline(); } catch (e) { up = false; }
      if (up) { log('the network is back: syncing'); syncNow('online', { force: true }); }
      else onlineTimer = setT(poll, ONLINE_POLL_MS);
    }, ONLINE_POLL_MS);
  }

  /* May a sync start now? During a backoff only a forced reason (the network came back after an
     OFFLINE failure, a new sign-in, a calendar ticked) may go early, and never during a rate limit. */
  function mayGo(force) {
    if (!S.token || S.needsSignIn || S.stopped) return false;
    if (!S.error || now() >= S.nextAt) return true;
    if (S.error.kind === 'rate') return false;
    return !!force;
  }

  /* ---------------------------------------------------------------- the access token */

  async function access(g) {
    live(g);
    if (S.token.access && S.token.expiresAt - 60000 > now()) return S.token.access;
    if (!S.client) throw { kind: 'denied', reason: 'the Google client file is missing; choose it again in Settings' };
    let t;
    try { t = await d.google.refresh({ client: S.client, refreshToken: S.token.refresh }); }
    catch (e) {
      live(g);
      const c = C.classify(e);
      if (c.kind === 'auth' || (e && e.body && e.body.error === 'invalid_grant')) S.needsSignIn = true;
      throw c;
    }
    live(g);
    S.token = Object.assign({}, S.token, t, { account: S.token.account || S.account });
    try { d.store.putToken(S.token); } catch (e) { log('could not save the refreshed sign-in: ' + (e.reason || e.message)); }
    return S.token.access;
  }

  /* ---------------------------------------------------------------- the sync */

  function overlaps(ev, w) {
    const s = ev.allDay ? localMidnight(ev.s) : ev.s;
    const e = ev.allDay ? localMidnight(ev.e) : Math.max(ev.e, ev.s + 1);
    return s < w.to && e > w.from;
  }
  function localMidnight(ymd) { const [y, m, dd] = ymd.split('-').map(Number); return new Date(y, m - 1, dd).getTime(); }

  async function fetchWindow(w, retried, g) {
    const tok = await access(g);
    let list;
    try { list = await d.google.calendarList(tok); }
    catch (e) {
      live(g);
      if (e && e.status === 401 && !retried) { S.token.expiresAt = 0; return fetchWindow(w, true, g); }
      throw C.classify(e);
    }
    live(g);
    const cals = C.pickCalendars(list, d.choices());
    const account = C.accountOf(list);
    const tzOf = {};
    for (const c of list) if (c && c.id) tzOf[c.id] = c.timeZone || null;
    const evs = [];
    const notes = [];
    let okCals = 0;
    for (const cal of cals.filter((c) => c.on)) {
      try {
        const r = await d.google.events(tok, cal.id, w.from, w.to);
        live(g);
        for (const it of r.items) { const n = C.normalizeEvent(it, cal.id, (id) => tzOf[id] || r.timeZone); if (n) evs.push(n); }
        if (r.truncated) notes.push(cal.name + ' has more events than Mantle reads');
        okCals++;
      } catch (e) {
        live(g);
        if (e && e.status === 401 && !retried) { S.token.expiresAt = 0; return fetchWindow(w, true, g); }
        const c = C.classify(e);
        if (c.kind === 'rate' || c.kind === 'offline' || c.kind === 'auth') throw c;
        notes.push('"' + cal.name + '" could not be read (' + c.reason + ')');
      }
    }
    // the reason names the calendar (it is shown to Owen); the log line gets one without names
    if (!okCals && cals.some((c) => c.on)) throw { kind: 'other', reason: notes[0] || 'no calendar could be read', logReason: 'no calendar could be read' };
    return { cals, account, evs, notes };
  }

  function syncNow(why, opts) {
    const o = opts || {};
    if (!mayGo(o.force)) return Promise.resolve(status());
    if (inflight) { if (o.window || o.again) again = again || { why, w: o.window || null }; return inflight; }
    const base = C.windowAround(now());
    const w = o.window || base;
    const isBase = !o.window || (o.window.from === base.from && o.window.to === base.to);
    const g = gen;
    S.syncing = true; publish(false);
    const p = fetchWindow(w, false, g).then((r) => {
      if (g !== gen) return;
      S.calendars = r.cals;
      if (r.account) S.account = r.account;
      if (S.token && r.account && S.token.account !== r.account) { S.token.account = r.account; try { d.store.putToken(S.token); } catch (e) { /* the next refresh saves it */ } }
      if (isBase) { S.events = r.evs; S.spans = [{ from: w.from, to: w.to }]; }
      else {
        S.events = S.events.filter((e) => !overlaps(e, w)).concat(r.evs);
        S.spans = S.spans.filter((s) => !(s.from === w.from && s.to === w.to)).concat([{ from: w.from, to: w.to }]).slice(-3);
      }
      S.events = C.sortEvents(S.events).slice(0, MAX_EVENTS);
      S.syncedAt = now();
      S.error = r.notes.length ? { kind: 'partial', reason: r.notes.join('; '), at: now() } : null;
      S.failures = 0; S.nextAt = 0;
      try { d.store.putCache({ account: S.account, calendars: S.calendars, events: S.events, spans: S.spans, syncedAt: S.syncedAt }); }
      catch (e) { S.error = { kind: 'other', reason: 'the events could not be saved on this PC (' + (e.code || e.message) + ')', at: now() }; }
      log('synced (' + why + '): ' + S.events.length + ' events from ' + r.cals.filter((c) => c.on).length + ' calendars');
      watchOnline(false);
      plan(PERIOD_MS);
    }, (e) => {
      if (g !== gen) return;
      const c = C.classify(e);
      S.failures++;
      if (c.kind === 'auth') S.needsSignIn = true;
      S.error = { kind: c.kind, reason: c.reason, at: now() };
      S.nextAt = now() + C.backoffMs(S.failures, c.retryAfterMs, d.random);
      log('sync failed (' + why + '): ' + c.kind + ': ' + (c.logReason || c.reason) + '; next try in ' + Math.round((S.nextAt - now()) / 1000) + ' s');
      if (S.needsSignIn) { if (timer) clearT(timer); timer = null; }
      else plan(S.nextAt - now());
      watchOnline(c.kind === 'offline');
    }).then(() => {
      if (inflight === p) inflight = null;
      if (g !== gen) return status();
      S.syncing = false;
      publish(true);
      const a = again; again = null;
      if (a) return syncNow(a.why, { window: a.w });
      return status();
    });
    inflight = p;
    return p;
  }

  /* A new sign-in or a sign-out: whatever sync is still out belongs to the old one and is dropped. */
  function newGeneration() { gen++; inflight = null; again = null; S.syncing = false; }

  /* ---------------------------------------------------------------- what pages and main ask */

  function covered(w) { return S.spans.some((s) => s.from <= w.from && s.to >= w.to); }

  const api = {
    start, stop, status, eventsPayload,
    syncNow: (why) => syncNow(why || 'asked', { force: true }),
    /* the flyout opened: a background refresh when the last good sync is older than 2 minutes */
    opened() {
      if (!S.token || S.needsSignIn || S.syncing) return { ok: true, synced: false };
      if (now() - S.syncedAt < STALE_MS) return { ok: true, synced: false };
      if (!mayGo(false)) return { ok: true, synced: false, reason: S.error ? S.error.reason : null };
      syncNow('opened');
      return { ok: true, synced: true };
    },
    /* the flyout shows a month the cache does not cover: fetch it +-1 month */
    want(year, month) {
      if (!Number.isInteger(year) || !Number.isInteger(month) || month < 0 || month > 11 || year < 1970 || year > 2200) return { ok: false, reason: 'that is not a month' };
      const m = C.monthWindow(year, month);
      const inner = { from: new Date(year, month, 1).getTime(), to: new Date(year, month + 1, 1).getTime() };
      if (covered(inner)) return { ok: true, covered: true };
      if (!mayGo(false)) return { ok: true, covered: false, reason: S.error ? S.error.reason : 'not signed in' };
      syncNow('month', { window: m });
      return { ok: true, covered: false, loading: true };
    },
    resume() { if (S.token && !S.needsSignIn) plan(RESUME_MS); },
    online() { if (S.error && S.error.kind === 'offline') syncNow('online', { force: true }); },

    async setClient(text) {
      let c;
      try { c = C.parseClientFile(text); } catch (e) { return { ok: false, reason: e.message }; }
      try { d.store.putClient(c); } catch (e) { return { ok: false, reason: e.reason || ('it could not be saved (' + e.message + ')') }; }
      S.client = c; S.clientBroken = null;
      publish(false);
      return { ok: true, project: c.project };
    },

    async signIn() {
      if (S.signingIn) return { ok: false, reason: 'a sign-in is already open in your browser' };
      if (!S.client) return { ok: false, reason: S.clientBroken || 'choose your Google client file first' };
      if (!d.store.canEncrypt()) return { ok: false, reason: 'Windows encryption (DPAPI) is not available, so Mantle will not store a Google sign-in' };
      S.signingIn = true; publish(false);
      try {
        const tok = await d.signIn(S.client);
        S.token = Object.assign({}, tok, { account: null });
        d.store.putToken(S.token);
        newGeneration();
        S.needsSignIn = false; S.error = null; S.failures = 0; S.nextAt = 0;
        log('signed in');
      } catch (e) {
        S.signingIn = false; publish(false);
        return { ok: false, reason: (e && (e.reason || e.message)) || 'the sign-in did not finish' };
      }
      S.signingIn = false;
      await syncNow('signed in', { force: true });
      return { ok: true, account: S.account };
    },

    /* privacy.html claim 6: revoke at Google, delete the token AND the cached events from this PC. */
    async signOut() {
      const tok = S.token;
      newGeneration();
      // no sync may start while Google is being told (S.token gone, no timers)
      S.token = null;
      if (timer) clearT(timer); timer = null; watchOnline(false);
      let revoked = false, why = null;
      if (tok && (tok.refresh || tok.access)) {
        try { await d.google.revoke(tok.refresh || tok.access); revoked = true; }
        catch (e) {
          const c = C.classify(e);
          // 400 invalid_token: Google had already ended it, which is what revoking is for
          if (e && e.status === 400) revoked = true;
          else why = c.reason;
        }
      }
      let deleted = true, delWhy = null;
      try { d.store.deleteToken(); } catch (e) { deleted = false; delWhy = 'the sign-in file could not be deleted (' + e.code + ')'; }
      try { d.store.deleteCache(); } catch (e) { deleted = false; delWhy = (delWhy ? delWhy + '; ' : '') + 'the cached events could not be deleted (' + e.code + ')'; }
      if (timer) clearT(timer); timer = null; watchOnline(false);
      Object.assign(S, { token: null, account: null, calendars: [], events: [], spans: [], syncedAt: 0, error: null, needsSignIn: false, failures: 0, nextAt: 0 });
      log('signed out' + (revoked ? '' : ' (not revoked at Google)'));
      publish(true);
      if (!deleted) return { ok: false, reason: delWhy };
      if (!revoked && tok) return { ok: true, revoked: false, reason: 'Signed out on this PC, but Google could not be reached to end Mantle\'s access (' + why + '). Remove Mantle at myaccount.google.com/permissions' };
      return { ok: true, revoked: !!tok };
    },

    setCalendar(calId, on) {
      if (typeof calId !== 'string' || !S.calendars.some((c) => c.id === calId)) return { ok: false, reason: 'that calendar is not in your list' };
      const ch = Object.assign({}, d.choices()); ch[calId] = !!on;
      d.saveChoices(ch);
      S.calendars = S.calendars.map((c) => (c.id === calId ? Object.assign({}, c, { on: !!on }) : c));
      if (!on) S.events = S.events.filter((e) => e.cal !== calId);
      publish(true);
      if (on) syncNow('calendar ticked', { force: true, again: true });
      return { ok: true, value: !!on };
    },

    linkOf(k) {
      const e = S.events.find((x) => x.k === k);
      return e ? e.link : undefined;
    },
    _state: S,
  };
  return api;
}

module.exports = { createEngine, PERIOD_MS, STALE_MS, ONLINE_POLL_MS, FIRST_MS, RESUME_MS };
