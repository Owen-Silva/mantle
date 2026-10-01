'use strict';
/* _autopause-attrib.js - who is making the sound (r5-autopause lane, 2026-09-30). PURE.
 *
 * In: Windows' media sessions (main's NOW PLAYING read: [{ aumid, app:{name}, status, timeline }]) and
 * the sidecar's `autopause.peaks` (every audio session: pid, peak, and its process chain [{pid, exe,
 * pkg}], leaf first, up to 8 ancestors). Out: the sources the rules in ./_autopause-core.js judge,
 * [{ key, kind: media|browser|app, label, status, positionMs, peak }], peak -1 when no audio session
 * could be tied to the media session.
 *
 * Matching a media session to audio (the bridge's Get-ProcIdsForAumid + Get-PeakForAumid, made exact):
 *   - a Store app's AUMID is "<package family>!<app>": a process in the chain with that package family
 *     (LessonPlayer: LessonPlayerApp.exe -> msedgewebview2.exe -> msedgewebview2.exe; the sound is the
 *     grandchild's, the package is the root's, so the WHOLE chain is searched);
 *   - "<name>.exe" AUMIDs match that exe;
 *   - classic AUMIDs ("Chrome", "MSEdge", "Opera GX Stable", Firefox's hash) match by a short table,
 *     then by name: the AUMID squeezed to letters/digits contains the exe stem or the other way round
 *     (4+ letters). WebView2 hosts never match by name: every Store app's web view is one.
 * Never counted: Spotify's own tree (it is what we pause), Mantle's own processes, Windows' system
 * sounds.
 */

const BROWSERS = new Set(['chrome.exe', 'msedge.exe', 'opera.exe', 'opera_gx.exe', 'brave.exe', 'firefox.exe', 'vivaldi.exe',
  'arc.exe', 'chromium.exe', 'iexplore.exe', 'waterfox.exe', 'librewolf.exe', 'thorium.exe', 'floorp.exe', 'zen.exe']);
const AUMID_EXE = { '308046b0af4a39cb': 'firefox.exe', 'msedge': 'msedge.exe', 'chrome': 'chrome.exe', 'brave': 'brave.exe' };
const AUMID_BROWSER = /chrome|msedge|\bedge\b|opera|firefox|308046b0af4a39cb|brave|vivaldi|chromium|quartz/i;
const NEVER_BY_NAME = new Set(['msedgewebview2.exe', 'applicationframehost.exe', 'runtimebroker.exe', 'svchost.exe', 'explorer.exe', 'conhost.exe']);

function squeeze(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
function stem(exe) { return squeeze(String(exe || '').replace(/\.exe$/i, '')); }
function isSpotifyAumid(a) { return /spotify/i.test(String(a || '')); }

/** A matcher for one media session's AUMID: (chainEntry) -> bool. */
function matcherFor(aumid) {
  const a = String(aumid || '');
  const bang = a.indexOf('!');
  if (bang > 0) {
    const fam = a.slice(0, bang).toLowerCase();
    return (e) => !!e.pkg && String(e.pkg).toLowerCase() === fam;
  }
  if (/\.exe$/i.test(a)) {
    const base = a.replace(/^.*[\\/]/, '').toLowerCase();
    return (e) => String(e.exe || '').toLowerCase() === base;
  }
  const sq = squeeze(a);
  const known = AUMID_EXE[sq];
  if (known) return (e) => String(e.exe || '').toLowerCase() === known;
  if (sq.length < 4) return () => false;
  return (e) => {
    const exe = String(e.exe || '').toLowerCase();
    if (!exe || NEVER_BY_NAME.has(exe)) return false;
    const st = stem(exe);
    return st.length >= 4 && (sq.includes(st) || st.includes(sq));
  };
}

function chainHas(row, fn) { return Array.isArray(row.chain) && row.chain.some((e) => e && fn(e)); }
function isSpotifyRow(row) { return chainHas(row, (e) => String(e.exe || '').toLowerCase() === 'spotify.exe'); }
function isMantleRow(row, mantlePids) { return chainHas(row, (e) => mantlePids.has(Number(e.pid))); }

function browserish(aumid, rows) {
  if (AUMID_BROWSER.test(String(aumid || ''))) return true;
  return rows.some((r) => chainHas(r, (e) => BROWSERS.has(String(e.exe || '').toLowerCase())));
}

function appLabel(exe) {
  const s = String(exe || '').replace(/\.exe$/i, '');
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : 'An app';
}

/**
 * sources({ media, peaks, mode, mantlePids }) -> { sources, spotify, counts }
 *   media: main's read ({ ok, sessions }) or null; peaks: the sidecar result ({ ok, sessions }) or null;
 *   mode: 'media' (default) | 'any'; mantlePids: Set of Mantle's own pids (its main process at least).
 *   spotify: { found, aumid, state } from the media sessions.
 */
function sources(input) {
  const i = input || {};
  const mode = i.mode === 'any' ? 'any' : 'media';
  const mantle = i.mantlePids instanceof Set ? i.mantlePids : new Set();
  const sessions = i.media && Array.isArray(i.media.sessions) ? i.media.sessions : [];
  const rowsAll = i.peaks && i.peaks.ok !== false && Array.isArray(i.peaks.sessions) ? i.peaks.sessions : null;
  const rows = (rowsAll || []).filter((r) => r && !r.sys && !isSpotifyRow(r) && !isMantleRow(r, mantle));
  const used = new Set();
  const out = [];
  let spotify = { found: false, aumid: null, state: 'none' };
  // One source per AUMID: two tabs of one browser are one browser.
  const byAumid = new Map();
  for (const s of sessions) {
    if (!s || !s.aumid) continue;
    if (isSpotifyAumid(s.aumid)) {
      const state = String(s.status || 'unknown').toLowerCase();
      if (!spotify.found || state === 'playing') spotify = { found: true, aumid: s.aumid, state };
      continue;
    }
    const g = byAumid.get(s.aumid);
    if (!g) byAumid.set(s.aumid, { s, playing: s.status === 'playing' || s.playing === true });
    else if (!g.playing && (s.status === 'playing' || s.playing === true)) byAumid.set(s.aumid, { s, playing: true });
  }
  for (const [aumid, g] of byAumid) {
    const s = g.s;
    const match = matcherFor(aumid);
    const mine = rows.filter((r) => chainHas(r, match));
    let peak = -1;
    if (rowsAll && mine.length) { peak = 0; for (const r of mine) { used.add(r); if (r.peak > peak) peak = Number(r.peak) || 0; } }
    const tl = s.timeline && s.timeline.available !== false ? s.timeline : null;
    const kind = browserish(aumid, mine) ? 'browser' : 'media';
    out.push({ key: `smtc:${aumid}`, kind, label: (s.app && s.app.name) || 'An app', status: g.playing ? 'playing' : String(s.status || 'unknown'),
      positionMs: tl && typeof tl.positionMs === 'number' ? tl.positionMs : null, peak });
  }
  if (mode === 'any' && rowsAll) {
    const apps = new Map();
    for (const r of rows) {
      if (used.has(r) || !Array.isArray(r.chain) || !r.chain.length) continue;
      const exe = String(r.chain[0].exe || '').toLowerCase();
      if (!exe) continue;
      const a = apps.get(exe) || { peak: 0 };
      if ((Number(r.peak) || 0) > a.peak) a.peak = Number(r.peak) || 0;
      apps.set(exe, a);
    }
    for (const [exe, a] of apps) out.push({ key: `app:${exe}`, kind: 'app', label: appLabel(exe), status: 'unknown', positionMs: null, peak: a.peak });
  }
  return { sources: out, spotify, counts: { media: byAumid.size, audio: (rowsAll || []).length, counted: rows.length } };
}

module.exports = { sources, matcherFor, isSpotifyAumid, BROWSERS };
