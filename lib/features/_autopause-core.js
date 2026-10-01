'use strict';
/* _autopause-core.js - Spotify auto-pause: the RULES, pure and clock-injected (r5-autopause lane,
 * 2026-09-30). The feature (./autopause.js) feeds it what Windows says each tick; this file decides
 * when Spotify is held paused and when it is handed back. Ported from Owen's standalone bridge
 * (~/spotify-autopause/bridge/spotify-bridge.ps1 1.5.3: Update-TrackFromSession, Invoke-WatcherTick,
 * Invoke-RepauseCheck, Add/Remove-SpotifyHold, Invoke-HoldTtlCheck) with its MEASURED constants.
 *
 * What the bridge learned the hard way, and this keeps:
 *   - LessonPlayer LIES about its playback status in both directions (Playing while idle, Paused mid-lesson
 *     with audio coming out), so audio PEAK is ground truth: RealPlaying = peakRecent OR (Playing AND
 *     posRecent), where posRecent needs 2+ position changes inside the window (one catch-up jump once
 *     caused a false hold).
 *   - Instant on audio (holdMinPlayingMs 0, Owen chose latency over blip-avoidance, measured 8400 ->
 *     114 ms); position-only evidence still needs an 8 s run (4 of 6 position-only flips were silent
 *     navigation bursts of 3.2-4.2 s).
 *   - minHoldMs 6000: a stray click costs ONE ~7.5 s gap, never an on-off-on-off.
 *   - resumeDelayMs 4000 sits BELOW the smallest inter-blip gap (6708 ms) so separate blips do not chain.
 *   - Only resume what WE paused. Spotify already paused by Owen stays paused.
 *   - Re-pause a Spotify started during a hold, but give up after 2 per episode and leave it alone for
 *     5 min (the counter reset during churn, so the guard needs a wall clock).
 *   - Every hold has an expiry: a watched app's hold ends with its audio (or its session); a hold
 *     taken over HTTP (a browser) ends after 180 s without a refresh. A stranded hold (Spotify pinned
 *     paused with nobody left to release it) is the recurring failure class.
 *
 * Two kinds of source on top of the bridge's one (it watched LessonPlayer only):
 *   media    an app with a Windows media session that is not a browser (LessonPlayer, a video player):
 *            the bridge's rule exactly.
 *   browser  a browser's media session: its status is honest (Chromium), so Playing is required, and
 *            when its audio can be measured the audio must be there too. A MUTED video therefore
 *            hands the music back, which is how Owen does it on purpose.
 *   app      ("Any sound from any app" only) an app with sound and no media session: audio only, and
 *            it must run anyMinRunMs first so a notification ping is not a pause. NOT measured; the
 *            bridge never watched such apps. Off by default for that reason.
 */

const DEFAULTS = Object.freeze({
  pollMs: 250,
  livenessWindowMs: 3000,
  resumeDelayMs: 4000,
  peakThreshold: 0.0008,
  holdMinPlayingMs: 0,
  holdMinPosOnlyMs: 8000,
  minHoldMs: 6000,
  repauseWhileHeld: true,
  repauseGiveUpAfter: 2,
  repauseGiveUpCooldownMs: 300000,
  repauseCheckEveryMs: 1000,
  resumeGraceMs: 1500,       // no re-pause within this of our own resume (the bridge's 1500)
  httpHoldTtlMs: 180000,     // the bridge's browserHoldTtlMs
  anyMinRunMs: 2000,         // 'app' kind only; not measured (see above)
});

function nz(v, d) { return typeof v === 'number' && Number.isFinite(v) ? v : d; }

function newTrack(key) {
  return {
    key, kind: 'media', label: '', hasPos: false, lastPos: -1, posChanges: 0, lastPosChangeMs: -1, prevPosChangeMs: -1,
    lastPeak: -1, lastPeakOkMs: -1, status: 'unknown', posRecent: false, peakRecent: false, realPlaying: false,
    lastRealMs: -1, runStart: -1, firstPeakMs: -1, runHadAudio: false, runMs: -1, held: false, holdStartMs: -1, seen: -1,
  };
}

/** One source's verdict for this tick (Update-TrackFromSession). `s` = { status, positionMs|null, peak (-1 = unknown) }. */
function updateTrack(t, s, now, cfg) {
  t.seen = now;
  t.status = String(s.status || 'unknown').toLowerCase();
  const pos = typeof s.positionMs === 'number' && Number.isFinite(s.positionMs) && s.positionMs >= 0 ? s.positionMs : -1;
  if (pos >= 0) {
    if (t.hasPos) {
      if (Math.abs(pos - t.lastPos) > 50) {       // the bridge's 0.05 s
        t.posChanges += 1;
        t.prevPosChangeMs = t.lastPosChangeMs;
        t.lastPosChangeMs = now;
      }
    } else t.hasPos = true;
    t.lastPos = pos;
  }
  const peak = typeof s.peak === 'number' && Number.isFinite(s.peak) ? s.peak : -1;
  t.lastPeak = peak;
  if (peak >= 0 && peak > cfg.peakThreshold) t.lastPeakOkMs = now;
  const win = cfg.livenessWindowMs;
  t.posRecent = t.posChanges >= 2 && t.lastPosChangeMs >= 0 && now - t.lastPosChangeMs <= win &&
    t.prevPosChangeMs >= 0 && t.lastPosChangeMs - t.prevPosChangeMs <= win;
  t.peakRecent = t.lastPeakOkMs >= 0 && now - t.lastPeakOkMs <= win;
  const playing = t.status === 'playing';
  if (t.kind === 'browser') t.realPlaying = playing && (peak >= 0 || t.lastPeakOkMs >= 0 ? t.peakRecent : true);
  else if (t.kind === 'app') t.realPlaying = t.peakRecent;
  else t.realPlaying = t.peakRecent || (playing && t.posRecent);
  return t;
}

/**
 * createEngine({ spotify, log, config }) -> engine
 *   spotify: { state(): 'playing' | 'paused' | 'stopped' | 'none', pause(): Promise<{ok, reason}>,
 *              play(): Promise<{ok, reason}> }  (the feature's adapter; dryRun lives there)
 *   log(text): counts and states only, never a title or an app name.
 * engine.tick(now, sources) where sources = [{ key, kind, label, status, positionMs, peak }]
 */
function createEngine(opts) {
  const o = opts || {};
  const cfg = Object.assign({}, DEFAULTS, o.config || {});
  const log = typeof o.log === 'function' ? o.log : () => {};
  const sp = o.spotify;
  const tracks = new Map();         // key -> track
  const holds = new Map();          // key -> { at, native, label, since }
  const st = { wePaused: false, episodeRepauses: 0, suppressedUntil: -1, lastResumeMs: -100000, lastRepauseCheck: -1,
    backoffLogged: false, lastError: '', lastAction: '', busy: Promise.resolve() };

  /* Every Spotify action goes through one queue: a release can never overtake the pause before it. */
  function serial(fn) {
    const p = st.busy.then(fn, fn);
    st.busy = p.catch(() => {});
    return p;
  }

  async function addHold(key, meta, now) {
    const m = meta || {};
    const refresh = holds.has(key);
    const rec = holds.get(key) || { since: now };
    rec.at = now; rec.native = !!m.native; rec.label = m.label || rec.label || ''; rec.kind = m.kind || rec.kind || '';
    const wasEmpty = holds.size === 0;
    holds.set(key, rec);
    if (wasEmpty) { st.episodeRepauses = 0; st.backoffLogged = false; }
    if (refresh) return { action: 'refreshed' };
    return serial(async () => {
      const state = sp.state();
      if (state === 'none') return { action: 'no-spotify' };
      if (state !== 'playing') return { action: 'already-paused' };
      const r = await sp.pause();
      if (r && r.ok) { st.wePaused = true; st.lastError = ''; st.lastAction = 'paused'; log(`hold taken (${holds.size} held): Spotify paused`); return { action: 'paused' }; }
      st.lastError = (r && r.reason) || 'Spotify did not answer';
      log(`hold taken (${holds.size} held) but the pause failed`);
      return { action: 'error', reason: st.lastError };
    });
  }

  async function removeHold(key, why) {
    holds.delete(key);
    if (holds.size === 0) { st.episodeRepauses = 0; st.backoffLogged = false; }
    return serial(async () => {
      if (!st.wePaused) return { action: 'skipped', reason: 'not-held' };
      if (holds.size > 0) return { action: 'skipped', reason: 'other-holds' };
      const state = sp.state();
      if (state === 'none') { st.wePaused = false; return { action: 'no-spotify' }; }
      if (state === 'playing') { st.wePaused = false; return { action: 'skipped', reason: 'user-resumed' }; }
      const r = await sp.play();
      if (r && r.ok) {
        st.wePaused = false; st.lastResumeMs = o.now ? o.now() : Date.now(); st.lastError = ''; st.lastAction = 'resumed';
        log(`hold released (${why || 'done'}): Spotify resumed`);
        return { action: 'resumed' };
      }
      st.lastError = (r && r.reason) || 'Spotify did not answer';
      log(`hold released (${why || 'done'}) but the resume failed`);
      return { action: 'error', reason: st.lastError };
    });
  }

  function verdicts(now, sources) {
    const seen = new Set();
    for (const s of sources || []) {
      if (!s || !s.key) continue;
      seen.add(s.key);
      let t = tracks.get(s.key);
      if (!t) { t = newTrack(s.key); tracks.set(s.key, t); }
      t.kind = s.kind === 'browser' || s.kind === 'app' ? s.kind : 'media';
      t.label = s.label || t.label;
      updateTrack(t, s, now, cfg);
    }
    return seen;
  }

  /** One watcher tick (Invoke-WatcherTick + Invoke-HoldTtlCheck + Invoke-RepauseCheck). */
  async function tick(now, sources) {
    const seen = verdicts(now, sources);
    const jobs = [];
    for (const [key, t] of tracks) {
      const hk = `native:${key}`;
      if (!seen.has(key)) {             // the session is gone: its hold goes with it
        if (t.held) jobs.push(removeHold(hk, 'its source closed'));
        tracks.delete(key);
        continue;
      }
      if (t.realPlaying) {
        t.lastRealMs = now;
        if (t.runStart < 0) { t.runStart = now; t.runHadAudio = false; t.firstPeakMs = -1; }
        if (t.peakRecent) t.runHadAudio = true;
        if (t.lastPeakOkMs === now && t.firstPeakMs < 0) t.firstPeakMs = now;
      } else if (t.runStart >= 0 && (t.lastRealMs < 0 || now - t.lastRealMs > cfg.resumeDelayMs)) {
        t.runStart = -1; t.runHadAudio = false; t.firstPeakMs = -1;
      }
      t.runMs = t.runStart >= 0 ? now - t.runStart : -1;
      if (t.runStart >= 0) {
        const gate = t.runHadAudio ? cfg.holdMinPlayingMs : cfg.holdMinPosOnlyMs;
        // 'app': AUDIBLE time, not the run (which carries 3 s of liveness after a 500 ms ping).
        const due = t.kind === 'app' ? t.firstPeakMs >= 0 && t.lastPeakOkMs - t.firstPeakMs >= cfg.anyMinRunMs : t.runMs >= gate;
        if (!t.held && due) {
          t.held = true; t.holdStartMs = now;
          jobs.push(addHold(hk, { native: true, label: t.label, kind: t.kind }, now));
        } else if (t.held && holds.has(hk)) holds.get(hk).at = now;
      } else if (t.held) {
        const heldFor = t.holdStartMs >= 0 ? now - t.holdStartMs : -1;
        if (!(cfg.minHoldMs > 0 && heldFor >= 0 && heldFor < cfg.minHoldMs)) {
          t.held = false; t.holdStartMs = -1;
          jobs.push(removeHold(hk, 'its sound stopped'));
        }
      }
    }
    // HTTP holds (a browser over the bridge-compatible API) expire without a refresh.
    if (cfg.httpHoldTtlMs > 0) {
      for (const [key, rec] of holds) {
        if (!rec.native && now - rec.at >= cfg.httpHoldTtlMs) jobs.push(removeHold(key, 'its browser stopped refreshing it'));
      }
    }
    await Promise.all(jobs);
    await repauseCheck(now);
  }

  async function repauseCheck(now) {
    if (!cfg.repauseWhileHeld || holds.size === 0) return;
    if (st.lastRepauseCheck >= 0 && now - st.lastRepauseCheck < cfg.repauseCheckEveryMs) return;
    st.lastRepauseCheck = now;
    if (now - st.lastResumeMs < cfg.resumeGraceMs) return;
    if (st.suppressedUntil >= 0 && now < st.suppressedUntil) return;
    if (st.episodeRepauses >= cfg.repauseGiveUpAfter) {
      st.suppressedUntil = now + cfg.repauseGiveUpCooldownMs;
      if (!st.backoffLogged) { st.backoffLogged = true; log(`Owen pressed play ${st.episodeRepauses} times during a hold: leaving Spotify alone for ${Math.round(cfg.repauseGiveUpCooldownMs / 60000)} min`); }
      return;
    }
    await serial(async () => {
      if (holds.size === 0 || sp.state() !== 'playing') return;
      const r = await sp.pause();
      if (r && r.ok) { st.wePaused = true; st.episodeRepauses += 1; st.lastAction = 'repaused'; log(`Spotify started during a hold: paused again (${st.episodeRepauses}/${cfg.repauseGiveUpAfter})`); }
      else { st.lastError = (r && r.reason) || 'Spotify did not answer'; log('Spotify started during a hold and the re-pause failed'); }
    });
  }

  /** Hand everything back (feature off, rest, quit, the standalone helper came back). */
  async function releaseAll(why) {
    for (const t of tracks.values()) { t.held = false; t.holdStartMs = -1; t.runStart = -1; }
    const keys = [...holds.keys()];
    holds.clear();
    st.episodeRepauses = 0; st.suppressedUntil = -1;
    if (keys.length === 0 && !st.wePaused) return { action: 'nothing' };
    return removeHold('\u0000all', why);
  }

  function snapshot(now) {
    const n = typeof now === 'number' ? now : Date.now();
    const list = [...holds.entries()].map(([key, r]) => ({ key, native: r.native, label: r.label, kind: r.kind, ageMs: n - r.at, sinceMs: n - r.since }));
    return {
      holds: list, wePaused: st.wePaused, episodeRepauses: st.episodeRepauses,
      suppressed: st.suppressedUntil >= 0 && n < st.suppressedUntil, suppressedForMs: st.suppressedUntil >= 0 ? Math.max(0, st.suppressedUntil - n) : 0,
      lastError: st.lastError, lastAction: st.lastAction,
      tracks: [...tracks.values()].map((t) => ({ key: t.key, kind: t.kind, real: t.realPlaying, held: t.held, peak: t.lastPeak, status: t.status, runMs: t.runMs })),
    };
  }

  return { tick, addHold: (k, m, now) => addHold(k, m, nz(now, Date.now())), removeHold, releaseAll, snapshot, config: cfg, idle: () => st.busy, _tracks: tracks };
}

module.exports = { DEFAULTS, createEngine, updateTrack, newTrack };
