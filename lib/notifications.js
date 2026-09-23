'use strict';
/*
 * lib/notifications.js -- main's half of Mantle's notification centre (Owen said yes, 2026-09-22):
 * Mantle's own panel instead of Windows' (Win+N). The bar's bell opens it (ui/bar/notifications.js);
 * the toasts come from the sidecar's `notifications` command (sidecar/Notifications.cs, which has
 * the measurements: the WinRT listener for WHICH toasts exist, Windows' own notification database,
 * read-only, for the cheap change signal and the rest of each toast).
 *
 * THE FLOW: the sidecar polls (a 0.06 ms database signature every 400 ms) and emits
 * {ev:"notifications", rev} only when the set of toasts changes; main then asks for the list once
 * and broadcasts it to the bar as 'notifications'. Nothing runs per frame and nothing is pushed
 * while nothing changes. If the watch cannot be armed, main polls the list every POLL_MS instead
 * and the payload says so.
 *
 * WHAT THE BAR MAY DO, and main checks it here rather than trusting the page: dismiss, dismiss
 * all, clear all and open act ONLY on ids that are in the list main last showed. "Clear all" is
 * those ids, one dismissal each -- never Windows' ClearNotifications(), which would also clear a
 * toast that arrived after the panel was drawn (and was never exercised: see Notifications.cs).
 *
 * UNREAD: Windows 11's bell counts what arrived since the centre was last opened. Same here:
 * opening the panel marks every toast in it seen; seen ids live in userData/notifications-seen.json
 * so a restart does not re-badge old toasts. A file that cannot be written is said in the payload
 * (the badge may come back after a restart), never swallowed.
 */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { Sidecar } = require('./sidecar');

const POLL_MS = 10000;     // only when the sidecar's own watch could not be armed
const CALL_MS = 8000;      // list/remove: the sidecar answers within its own 3.5 s per step
const OPEN_MS = 12000;     // open = find + launch + dismiss, three steps

const S = {
  started: false,
  ctx: null,
  last: null,              // the last payload broadcast
  reading: null,           // the in-flight read, so a burst of triggers makes one read
  again: false,
  watching: false,
  watchReason: null,       // why the sidecar's watch is not armed (null = it is)
  pollTimer: null,
  seen: new Set(),
  seenFile: null,
  seenNote: null,          // why seen state is not being kept (null = fine)
  raw: null,               // the sidecar's last good list, for re-shaping when the seen set moves
};

function log(line) { process.stdout.write(`mantle: notifications: ${line}\n`); }

function loadSeen() {
  try {
    const raw = JSON.parse(fs.readFileSync(S.seenFile, 'utf8'));
    if (raw && Array.isArray(raw.ids)) raw.ids.forEach((id) => { if (Number.isInteger(id)) S.seen.add(id); });
  } catch (err) {
    if (err.code !== 'ENOENT') {
      S.seenNote = `the list of notifications already seen could not be read (${err.message}), so older ones may show as new`;
      log(S.seenNote);
    }
  }
}

function saveSeen() {
  try {
    fs.writeFileSync(S.seenFile, JSON.stringify({ ids: Array.from(S.seen) }));
    S.seenNote = null;
  } catch (err) {
    S.seenNote = `the list of notifications already seen could not be saved (${err.message}), so after a restart they may show as new again`;
    log(S.seenNote);
  }
}

/** The bar's payload: the sidecar's list, plus unread flags and main's own notes. */
function shape(raw, failReason) {
  if (failReason) {
    return { ok: false, available: false, reason: failReason, toasts: [], unread: 0, count: 0, detail: null, seenNote: S.seenNote };
  }
  const toasts = Array.isArray(raw.toasts) ? raw.toasts : [];
  // Seen ids that are no longer listed are dropped, so the file never grows past the live list.
  const live = new Set(toasts.map((t) => t.id));
  let pruned = false;
  for (const id of Array.from(S.seen)) if (!live.has(id)) { S.seen.delete(id); pruned = true; }
  if (pruned) saveSeen();
  let unread = 0;
  for (const t of toasts) { t.unread = !S.seen.has(t.id); if (t.unread) unread++; }
  const detail = [raw.detail, S.watchReason ? `updates every ${POLL_MS / 1000} s: ${S.watchReason}` : null].filter(Boolean).join('; ') || null;
  return {
    ok: raw.ok !== false,
    available: raw.available !== false,
    reason: raw.reason || null,
    access: raw.access || null,
    via: raw.via || null,
    rev: raw.rev,
    count: toasts.length,
    unread,
    toasts,
    detail,
    seenNote: S.seenNote,
  };
}

function publish(payload) {
  S.last = payload;
  S.ctx.broadcast('notifications', payload);
  S.ctx.state.set('notifications', {
    status: payload.ok ? 'ok' : 'down',
    count: payload.count,
    unread: payload.unread,
    reason: payload.ok ? `${payload.count} notification${payload.count === 1 ? '' : 's'}, ${payload.unread} unread (${payload.via || 'no source'})` : payload.reason,
  });
}

async function read() {
  let raw;
  try {
    raw = await S.ctx.sidecar.call('notifications', { op: 'list' }, CALL_MS);
  } catch (err) {
    return shape(null, Sidecar.isOldExeError(err)
      ? 'this sidecar exe has no "notifications" command yet (run npm run build:sidecar)'
      : `Mantle could not read your notifications: ${err.message}`);
  }
  if (!raw || typeof raw !== 'object') return shape(null, 'the sidecar answered "notifications" with nothing');
  if (raw.ok === false && (!Array.isArray(raw.toasts) || raw.available === false)) {
    return shape(null, raw.reason || 'the sidecar answered "notifications" with ok:false and gave no reason');
  }
  S.raw = raw;
  return shape(raw, null);
}

/** Read once and broadcast; a trigger that lands mid-read gets one more read after it. */
function push(why) {
  if (S.reading) { S.again = true; return S.reading; }
  S.reading = (async () => {
    try {
      do {
        S.again = false;
        publish(await read());
      } while (S.again);
    } catch (err) {
      process.stderr.write(`mantle: the notifications push (${why}) threw: ${err && err.stack ? err.stack : err}\n`);
    } finally {
      S.reading = null;
    }
    return S.last;
  })();
  return S.reading;
}

function pollArm() {
  if (S.pollTimer) { clearInterval(S.pollTimer); S.pollTimer = null; }
  if (S.watching) return;
  S.pollTimer = setInterval(() => push('the fallback poll'), POLL_MS);
  if (S.pollTimer.unref) S.pollTimer.unref();
}

/** Armed on EVERY sidecar start: a restarted sidecar has forgotten the watch. */
async function arm() {
  try {
    const r = await S.ctx.sidecar.call('notifications', { op: 'watch', on: true }, CALL_MS);
    S.watching = !!(r && r.watching);
    S.watchReason = S.watching ? null : ((r && r.reason) || 'the sidecar did not start its watch and gave no reason');
    if (r && r.detail) log(`watch armed without the fast change signal: ${r.detail}`);
  } catch (err) {
    S.watching = false;
    S.watchReason = Sidecar.isOldExeError(err) ? null : `the sidecar's watch could not start (${err.message})`;
    if (Sidecar.isOldExeError(err)) { push('the sidecar is ready (no notifications command)'); return; }
  }
  if (S.watchReason) log(`not watching: ${S.watchReason}; polling every ${POLL_MS / 1000} s`);
  pollArm();
  push('the sidecar is ready');
}

// ------------------------------------------------------------------ the bar's commands

/** Only ids main last showed may be acted on: a page is not the guard. */
function knownIds(list) {
  const shown = new Set(((S.last && S.last.toasts) || []).map((t) => t.id));
  const ids = [];
  for (const x of Array.isArray(list) ? list : []) {
    const id = Number(x);
    if (Number.isInteger(id) && shown.has(id) && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

async function removeIds(ids, what) {
  if (!ids.length) return { ok: false, reason: `nothing to ${what}: none of those notifications is in the list Mantle is showing` };
  let r;
  try {
    r = await S.ctx.sidecar.call('notifications', { op: 'remove', ids }, CALL_MS);
  } catch (err) {
    push(`${what} failed`);
    return { ok: false, reason: `could not ${what}: ${err.message}` };
  }
  await push(what);
  return Object.assign({ ok: r.ok !== false, reason: r.reason || null }, { removed: r.removed || [], missing: r.missing || [], failed: r.failed || [] });
}

const COMMANDS = {
  'notifs.get': async () => S.last || push('the bar asked'),

  /* The panel opened: everything in it is now seen. Unknown ids are ignored, not stored. */
  'notifs.seen': async (a) => {
    const ids = knownIds(a && a.ids);
    let changed = false;
    for (const id of ids) if (!S.seen.has(id)) { S.seen.add(id); changed = true; }
    if (changed) {
      saveSeen();
      // Re-shaped from the sidecar's last answer, so the badge drops without another read.
      if (S.raw) publish(shape(S.raw, null));
    }
    return { ok: true, reason: null, unread: S.last ? S.last.unread : 0 };
  },

  'notifs.remove': async (a) => removeIds(knownIds(a && a.ids), 'dismiss'),

  /* Clear all, or one app's: the ids the panel showed, never "whatever Windows has now". */
  'notifs.clear': async (a) => {
    const aumid = a && typeof a.aumid === 'string' && a.aumid ? a.aumid : null;
    const ids = ((S.last && S.last.toasts) || [])
      .filter((t) => !aumid || String(t.aumid).toLowerCase() === aumid.toLowerCase())
      .map((t) => t.id);
    return removeIds(ids, aumid ? 'dismiss that app\'s notifications' : 'clear all');
  },

  'notifs.open': async (a) => {
    const [id] = knownIds([a && a.id]);
    if (!id) return { ok: false, reason: 'that notification is not in the list Mantle is showing (it may have just gone)' };
    let r;
    try {
      // `toast`, never `id`: `id` is the sidecar protocol's own request id.
      r = await S.ctx.sidecar.call('notifications', { op: 'open', toast: id }, OPEN_MS);
    } catch (err) {
      push('open failed');
      return { ok: false, reason: `could not open it: ${err.message}` };
    }
    push('opened');
    return { ok: r.ok !== false, via: r.via || null, note: r.note || null, dismissed: !!r.dismissed, reason: r.reason || null };
  },
};

/**
 * Called by main.js once, after app 'ready'.
 *   ctx: { test, state, sidecar, commands, broadcast }
 */
function start(ctx) {
  if (S.started) return;
  S.started = true;
  S.ctx = ctx;
  S.seenFile = path.join(app.getPath('userData'), 'notifications-seen.json');
  loadSeen();
  Object.assign(ctx.commands, COMMANDS);
  ctx.sidecar.on('ready', () => { arm(); });
  ctx.sidecar.on('notifications', (ev) => {
    if (S.last && ev && ev.rev !== undefined && ev.rev === S.last.rev) return;
    push(`the list changed (rev ${ev && ev.rev})`);
  });
  if (ctx.sidecar.status === 'ok') arm();
}

/** mantle.on('notifications') replay: the bar's first frame is never a blank bell. */
function replay(name) {
  if (name === 'notifications') return S.last ? { has: true, payload: S.last } : { has: false };
  return { has: false };
}

module.exports = { start, replay };
