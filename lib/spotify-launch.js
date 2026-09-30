'use strict';
/*
 * lib/spotify-launch.js - Mantle's OWN ways of starting Spotify start it with Up next's port.
 *
 * The now-playing card's "Up next" drives the Spotify desktop app over CDP, which only works when
 * Spotify.exe was started with --remote-debugging-port=47292 (lib/features/_spotify-app.js). The
 * card's own Start/Restart does that; the PINNED bar icon and the launcher's Spotify row used to
 * open the shortcut the normal way, so Up next said "Needs restart" (2026-09-25).
 *
 * This file decides, for one thing about to be opened, whether it is the Win32 Spotify.exe and
 * whether to start it with the port instead. It starts it through _spotify-app.js's own realProc()
 * launch (same exe, same flag, same cleaned env, same cwd) rather than a second copy of that code.
 *
 * WHAT COUNTS AS SPOTIFY (compared case-insensitively against the exe the card starts,
 * %APPDATA%\Spotify\Spotify.exe):
 *   - an already-resolved exe or target path (a pin: lib/pinned.js resolved its .lnk),
 *   - a .lnk whose target is that exe (a launcher row; resolved here unless the caller says it tried),
 *   - a path that IS that exe,
 *   - an app id: the exe path itself (what Get-StartApps gives the Win32 Spotify on Owen's machine),
 *     its known-folder form "{RoamingAppData GUID}\Spotify\Spotify.exe", or the bare "Spotify.exe"
 *     the media session reports.
 * The Microsoft Store build (SpotifyAB.SpotifyMusic_...!Spotify) is NOT matched: it lives elsewhere,
 * and starting %APPDATA%'s exe for it would open a different Spotify from the one that was pinned.
 * A shortcut with its own arguments is not matched either, so its arguments are never dropped.
 *
 * WHEN IT DOES NOTHING ({handled:false}), the caller opens the item exactly as before:
 *   - not Spotify, or the Spotify queue is off (the caller passes enabled:false),
 *   - Spotify is ALREADY running: the normal open only brings it forward, and a pin click must never
 *     restart it (tasklist is read; nothing is closed),
 *   - the exe is missing, tasklist failed, or the flagged start failed: `why` says which, and
 *     `quiet` is false so the caller can show it.
 *
 * HIDDEN (spothide lane, 2026-09-26): the start is Spotify's own --minimized plus HIDDEN_ARGS, and the
 * pid is announced on launchBus() ('launched'), where the Spotify feature waits for its page and hides
 * the window with Spotify's own window-state service, as the card's Start does. `hide` in the answer
 * says whether anything was listening (nothing is when the feature is not loaded: the window then
 * stays minimized, and the caller logs why).
 *
 * ONE START PER BURST (media-be lane, 2026-09-29): a double-click on the pin used to run two flagged
 * starts (both read "not running" before either had launched). While a start runs (and HOLD_MS after
 * it; 0: a later click sees Spotify running and only brings it forward, as before), another click is
 * answered as handled with action 'already-starting' and starts nothing. `why` never carries the exe path (main.js logs it).
 *
 * Never throws: every answer is { handled, spotify, ... }.
 */
const path = require('path');
const { realProc, defaultExe, launchBus, FLAG, HIDDEN_ARGS } = require('./features/_spotify-app.js');

const HOLD_MS = 0;             // after a start: 0 = only while the start itself runs (see ONE START PER BURST)
const starting = new Map();       // norm(exe) -> { pid, at, done } while a flagged start runs or was just made

/* FOLDERID_RoamingAppData: shell:AppsFolder names an unpackaged app under %APPDATA% "{guid}\rest". */
const KNOWN_FOLDERS = {
  '{3EB685DB-65F9-4CF6-A03A-E3EF65729F3D}': () => process.env.APPDATA,
};

function expandVars(s) {
  return String(s).replace(/%([^%\\/]+)%/g, (whole, name) => {
    const v = process.env[name];
    return v === undefined ? whole : v;
  });
}

/** An absolute Windows path, expanded and lowercased for comparing; '' for anything else. */
function norm(p) {
  if (p === undefined || p === null) return '';
  let s = String(p).trim().replace(/^"(.*)"$/, '$1').trim();
  if (!s) return '';
  s = expandVars(s);
  s = s.replace(/^\{[0-9A-Fa-f-]{36}\}(?=[\\/])/, (g) => {
    const base = KNOWN_FOLDERS[g.toUpperCase()];
    return base && base() ? base() : g;
  });
  if (!/^[a-z]:[\\/]/i.test(s) && !/^\\\\/.test(s)) return '';
  return path.win32.normalize(s).toLowerCase();
}

function isSpotifyAumid(aumid, exe) {
  const a = String(aumid || '').trim();
  if (!a) return false;
  if (/^spotify\.exe$/i.test(a)) return true;
  const want = norm(exe);
  return !!want && norm(a) === want;
}

/** The default .lnk reader: lib/pinned.js's own parser, pure node. -> { target, args } or null. */
function readLnk(lnk) {
  const p = require('./pinned.js')._internals;
  const r = p.parseLnkFile(lnk);
  return r ? { target: r.target ? p.expandVars(String(r.target)) : null, args: r.args ? String(r.args) : '' } : null;
}

/*
 * t: { exe?, target?, args?, lnkPath?, path?, aumid? }. `target` present (even null) means the
 * caller already resolved the shortcut, so it is not read again.
 * opts: { exe (the Spotify.exe to match), resolveLnk(lnk) -> string | {target, args} | null }.
 * -> { match: bool, via?: 'exe'|'target'|'path'|'lnk'|'aumid' }
 */
function matchSpotify(t, opts) {
  const o = Object.assign({ exe: defaultExe(), resolveLnk: readLnk }, opts || {});
  const want = norm(o.exe);
  if (!t || typeof t !== 'object' || !want) return { match: false };
  const hasArgs = (a) => !!(a && String(a).trim());

  if (t.exe && norm(t.exe) === want) return hasArgs(t.args) ? { match: false } : { match: true, via: 'exe' };
  if (t.target && norm(t.target) === want) return hasArgs(t.args) ? { match: false } : { match: true, via: 'target' };

  const tried = Object.prototype.hasOwnProperty.call(t, 'target');
  for (const lnk of [t.lnkPath, t.path]) {
    if (!lnk) continue;
    if (norm(lnk) === want) return { match: true, via: 'path' };
    if (tried || !/\.lnk$/i.test(String(lnk))) continue;
    let r = null;
    try { r = o.resolveLnk(String(lnk)); } catch (_) { r = null; }
    const target = r && typeof r === 'object' ? r.target : r;
    const args = r && typeof r === 'object' ? r.args : '';
    if (target && norm(target) === want && !hasArgs(args)) return { match: true, via: 'lnk' };
  }

  if (t.aumid && isSpotifyAumid(t.aumid, o.exe)) return { match: true, via: 'aumid' };
  return { match: false };
}

/*
 * opts: { exe, resolveLnk, proc (realProc-shaped: exists/running/launch), dryRun, enabled (default true) }
 * -> { handled:false, spotify:false }                          not Spotify: open it as before
 *    { handled:false, spotify:true, quiet, why }               Spotify, but open it as before (why says why)
 *    { handled:true, ok:true, dryRun:true, reason, action:'dry-run', command }
 *    { handled:true, ok:true, reason:null, action:'launched', path, args, pid, via }
 */
async function launchSpotifyWithPort(t, opts) {
  const o = Object.assign({ exe: defaultExe(), resolveLnk: readLnk, proc: null, dryRun: false, enabled: true, bus: null, source: null, holdMs: HOLD_MS }, opts || {});
  let m;
  try { m = matchSpotify(t, o); } catch (e) { return { handled: false, spotify: false, why: `the Spotify check failed: ${e.message}` }; }
  if (!m.match) return { handled: false, spotify: false };
  if (!o.enabled) return { handled: false, spotify: true, quiet: true, why: 'the Spotify queue is off in Mantle’s tray menu, so Spotify opens the normal way' };

  const key = norm(o.exe);
  const args = [FLAG].concat(HIDDEN_ARGS);
  const held = starting.get(key);
  if (held && (!held.done || Date.now() - held.done < o.holdMs)) {
    return { handled: true, ok: true, reason: null, action: 'already-starting', path: o.exe, args, pid: held.pid || null, via: m.via,
      hide: 'a click a moment ago is still starting Spotify, so this one started nothing' };
  }
  const mark = { pid: null, at: Date.now(), done: 0 };
  starting.set(key, mark);
  const release = (keep) => { if (starting.get(key) !== mark) return; if (keep) mark.done = Date.now(); else starting.delete(key); };
  try {
    const proc = o.proc || realProc({});
    if (!proc.exists(o.exe)) { release(false); return { handled: false, spotify: true, quiet: false, why: 'Spotify isn’t installed where Mantle starts it from (Spotify.exe in your AppData folder), so it opens the normal way, without Up next' }; }
    let pids;
    try { pids = await proc.running(); } catch (e) {
      release(false);
      return { handled: false, spotify: true, quiet: false, why: `could not tell whether Spotify is running (${String(e.message).slice(0, 120)}), so it opens the normal way, without Up next` };
    }
    if (pids && pids.length) {
      release(false);
      // spotfix lane: said on the bus, so the Spotify feature stops hiding a window Owen asked to see
      try { (o.bus || launchBus()).emit('opening', { source: o.source || 'Mantle' }); } catch (_) { /* nothing listens */ }
      return { handled: false, spotify: true, quiet: true, running: true, why: 'Spotify is already running, so opening it only brings it forward' };
    }

    const command = `"${o.exe}" ${args.join(' ')}`;
    if (o.dryRun) { release(false); return { handled: true, ok: true, dryRun: true, action: 'dry-run', command, via: m.via, reason: `dry run: would start Spotify.exe ${args.join(' ')}` }; }
    const l = await proc.launch(o.exe, args);
    if (!l || !l.ok) { release(false); return { handled: false, spotify: true, quiet: false, why: 'Spotify would not start with Up next, so it opens the normal way', detail: String((l && l.reason) || 'no answer').replace(/[A-Za-z]:\\[^\s]*/g, '<path>').slice(0, 120) }; }
    mark.pid = l.pid || null;
    release(true);
    let heard = false;
    try { heard = (o.bus || launchBus()).emit('launched', { pid: l.pid, source: o.source || 'Mantle' }); } catch (_) { heard = false; }
    return { handled: true, ok: true, reason: null, action: 'launched', path: o.exe, args, pid: l.pid, via: m.via,
      hide: heard ? 'the Spotify feature hides its window once its page is up' : 'nothing was listening to hide the window, so Spotify stays minimized' };
  } catch (e) {
    release(false);
    return { handled: false, spotify: true, quiet: false, why: `starting Spotify with Up next failed (${String(e.message).slice(0, 120)}), so it opens the normal way` };
  }
}

module.exports = { matchSpotify, launchSpotifyWithPort, isSpotifyAumid, HOLD_MS, _internals: { norm, readLnk, KNOWN_FOLDERS, starting } };
