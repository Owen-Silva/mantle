'use strict';
/*
 * helm-badge.js - a count on an app's bar icon, read from a small JSON file the app writes
 * (lane badge, 2026-10-09). First user: Helm writes <%APPDATA%\Helm>\badge.json
 *   { v: 1, count, waiting, errors, pid, updatedAt }
 * = sessions waiting on Owen + sessions that stopped on an error he has not opened yet.
 *
 * Generic: a SOURCE is { exe, file, label }. `exe` matches a bar item by its exe (a full path, or a bare
 * file name like "helm.exe" that matches any folder); `file` is the JSON to watch. Sources live in the
 * feature's settings (features/helmbadge.json, key "sources"); the default is Helm's. Any app can join
 * by writing the same shape and adding a source.
 *
 * Reading rules (no silent failure: every hidden badge has a reason the bar can put in the tooltip):
 *  - count 0, a missing file, or a file whose `pid` is no longer running (the app crashed) = no badge;
 *  - a file that cannot be parsed = no badge, reason "its badge file could not be read".
 * Watching: fs.watch on the FOLDER (the app replaces the file by rename, which a file watch loses),
 * reads coalesced 120 ms; while a count shows, the pid is re-checked every 30 s (a crash leaves the
 * last count behind). A missing folder is retried every 30 s. No other polling.
 *
 * The feature (exports.feature) broadcasts `helmbadge.state` = { badges: [{ exe, label, count, waiting,
 * errors, reason }] } (replayed on subscribe) for ui/bar/helmbadge.js. To install it, Mantle's features
 * folder needs lib/features/helmbadge.js = `module.exports = require('../helm-badge').feature;`.
 * MANTLE_HELM_BADGE_FILE (test runs) points the default source at another file.
 */
const fs = require('fs');
const path = require('path');

function defaultSources(env = process.env) {
  const appData = env.APPDATA || path.join(env.USERPROFILE || '', 'AppData', 'Roaming');
  const file = env.MANTLE_HELM_BADGE_FILE || path.join(appData, 'Helm', 'badge.json');
  return [{ exe: 'helm.exe', file, label: 'Helm' }];
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; }
}

function n0(v) { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0; }

/** Pure: a file's text (null = missing) -> { count, waiting, errors, reason }. */
function parseBadge(text, { alive = pidAlive } = {}) {
  if (text == null) return { count: 0, waiting: 0, errors: 0, reason: 'not running' };
  let v;
  try { v = JSON.parse(text); } catch { return { count: 0, waiting: 0, errors: 0, reason: 'its badge file could not be read' }; }
  if (!v || typeof v !== 'object') return { count: 0, waiting: 0, errors: 0, reason: 'its badge file could not be read' };
  const waiting = n0(v.waiting);
  const errors = n0(v.errors);
  const count = n0(v.count) || waiting + errors;
  if (!count) return { count: 0, waiting, errors, reason: '' };
  if (v.pid != null && !alive(v.pid)) return { count: 0, waiting: 0, errors: 0, reason: 'not running' };
  return { count, waiting, errors, reason: '' };
}

/** Does a source's exe match a bar item? Full path = equal (case-insensitive); bare name = the item's file name. */
function matches(source, item) {
  if (!source || !item || !item.exe) return false;
  const want = String(source.exe || '').toLowerCase();
  if (!want) return false;
  const have = String(item.exe).toLowerCase().replace(/\//g, '\\');
  if (/[\\/]/.test(want)) return have === want.replace(/\//g, '\\');
  return have === want || have.endsWith(`\\${want}`);
}

/** Tooltip line: "2 need you: 1 waiting, 1 stopped on an error". */
function describe(b) {
  if (!b || !b.count) return '';
  const parts = [];
  if (b.waiting) parts.push(`${b.waiting} waiting`);
  if (b.errors) parts.push(`${b.errors} stopped on an error`);
  return `${b.count} ${b.count === 1 ? 'needs' : 'need'} you${parts.length ? `: ${parts.join(', ')}` : ''}`;
}

/**
 * Watch one file. createWatcher({ file, onChange(state), fsApi?, alive?, timers?, settleMs?, recheckMs? })
 * -> { state(), read(), close() }
 */
function createWatcher({ file, onChange = () => {}, fsApi = fs, alive = pidAlive, timers = { setTimeout, clearTimeout }, settleMs = 120, recheckMs = 30000 }) {
  const dir = path.dirname(file);
  const base = path.basename(file).toLowerCase();
  let cur = null;
  let watcher = null;
  let settle = null;
  let recheck = null;
  let closed = false;

  function read() {
    if (closed) return cur;
    let text = null;
    try { text = fsApi.readFileSync(file, 'utf8'); } catch (e) { text = e && e.code === 'ENOENT' ? null : '\u0000'; }
    const next = parseBadge(text, { alive });
    const changed = !cur || cur.count !== next.count || cur.waiting !== next.waiting || cur.errors !== next.errors || cur.reason !== next.reason;
    cur = next;
    arm();
    if (changed) onChange(next);
    return next;
  }

  function soon() {
    if (closed || settle) return;
    settle = timers.setTimeout(() => { settle = null; read(); }, settleMs);
    if (settle && settle.unref) settle.unref();
  }

  // the slow re-check: only while a count shows (pid may die) or while the folder cannot be watched
  function arm() {
    if (recheck) { timers.clearTimeout(recheck); recheck = null; }
    if (closed || !((cur && cur.count) || !watcher)) return;
    recheck = timers.setTimeout(() => { recheck = null; if (!watcher) watch(); read(); }, recheckMs);
    if (recheck && recheck.unref) recheck.unref();
  }

  function watch() {
    if (closed || watcher) return;
    try {
      watcher = fsApi.watch(dir, { persistent: false }, (_ev, name) => {
        if (!name || String(name).toLowerCase() === base || String(name).toLowerCase() === `${base}.tmp`) soon();
      });
      watcher.on('error', () => { try { watcher.close(); } catch {} watcher = null; arm(); });
    } catch { watcher = null; }
  }

  watch();
  read();
  return {
    state: () => cur,
    read,
    close() {
      closed = true;
      if (settle) timers.clearTimeout(settle);
      if (recheck) timers.clearTimeout(recheck);
      settle = recheck = null;
      if (watcher) { try { watcher.close(); } catch {} watcher = null; }
    },
  };
}

function cleanSources(list) {
  const out = [];
  for (const s of Array.isArray(list) ? list : []) {
    if (s && typeof s.exe === 'string' && s.exe.trim() && typeof s.file === 'string' && path.isAbsolute(s.file)) {
      out.push({ exe: s.exe.trim(), file: s.file, label: typeof s.label === 'string' && s.label.trim() ? s.label.trim() : path.basename(s.exe, '.exe') });
    }
  }
  return out;
}

const feature = {
  name: 'helmbadge',
  label: 'App counts on the bar (Helm: chats that need you)',
  defaultOn: true,
  install(ctx) {
    const custom = ctx.settings.get('sources', null);
    const sources = custom ? cleanSources(custom) : defaultSources();
    const watchers = [];
    let on = ctx.enabled();

    function state() {
      const badges = [];
      sources.forEach((s, i) => {
        const st = (watchers[i] && watchers[i].state()) || { count: 0, waiting: 0, errors: 0, reason: '' };
        badges.push({ exe: s.exe, label: s.label, count: on ? st.count : 0, waiting: st.waiting, errors: st.errors, reason: on ? st.reason : 'turned off', tip: on ? describe(st) : '' });
      });
      return { badges };
    }
    const publish = () => ctx.broadcast('helmbadge.state', state());

    sources.forEach((s, i) => {
      watchers.push(createWatcher({
        file: s.file,
        // the log names the source by its place, never the app (privacy rule, 10-01)
        onChange: (st) => { ctx.log(`source ${i + 1}: count ${st.count}${st.reason ? ` (${st.reason})` : ''}`); if (watchers.length === sources.length) publish(); },
      }));
    });
    ctx.replay('helmbadge.state', state);
    ctx.onEnabled((v) => { on = !!v; publish(); });
    if (custom && !sources.length) ctx.health(false, 'its sources setting has no usable entry (exe + absolute file)');
    else ctx.health(true);
    publish();
    return { stop() { for (const w of watchers) w.close(); } };
  },
};

module.exports = { parseBadge, matches, describe, createWatcher, defaultSources, cleanSources, pidAlive, feature };
