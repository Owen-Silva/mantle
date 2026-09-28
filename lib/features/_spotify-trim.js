'use strict';
/* _spotify-trim.js - keeps the hidden Spotify's RAM low (sptrim lane, 2026-09-26). Owen: "could you
 * just set it to when spotify creeps up to a specific ram usage instead of doing time?"
 *
 * While the Spotify MANTLE started runs hidden, its memory is read every 30 s (one `spotify.mem` to
 * the sidecar: Task Manager's "Memory" number, the private working set, summed over its processes;
 * a few ms, no PowerShell). Over the line (TRIM_ABOVE_MB, or the feature setting trimAboveMB) it is
 * trimmed with `spotify.trim`: EmptyWorkingSet, which hands idle pages to Windows' standby list.
 * sidecar/SpotifyMem.cs holds the guard (only that Spotify.exe tree, only at %APPDATA%\Spotify).
 *
 * THE AUDIO. The process that owns an ACTIVE audio session on the default output (`audio sessions`,
 * the same read game mode makes) is never trimmed: measured 2026-09-26, that is Spotify's main
 * process (the root), and trimming the other six while music played kept the Windows media session
 * reading Playing with its position advancing. If which process plays cannot be read, nothing is
 * trimmed that tick (said on the card). The ROOT is left alone as well, always: an active session
 * on another output device is not seen by that read, and the root is where the audio was.
 *
 * THE LINE (2026-09-26): 400 MB, not 300. While music plays the renderer refills to a steady
 * ~355-366 MB within 30 s of every trim (3 real trims), so a 300 MB line only bought ~30 s each
 * time and settled into a trim every 10 min for nothing. 400 sits above that steady state: a trim
 * happens when Spotify really creeps up, as Owen asked.
 *
 * THE LIMITS. At most one trim per MIN_GAP_MS. If memory is back over the line within REFILL_MS of a
 * trim, FAST_IN_A_ROW trims in a row, the gap doubles (up to MAX_GAP_MS): trimming something that
 * refills at once only costs page faults. After CALM_MS under the line the gap goes back to
 * MIN_GAP_MS. A trim is skipped when the processes it may touch hold under MIN_GAIN_MB.
 *
 * THE LOG gets one line per trim (before -> after), one per back-off change, and one on start and
 * stop. A quiet 30 s tick writes nothing; a failing read is logged once per distinct reason.
 *
 * step() is PURE (the decisions, unit-tested with a fake clock); createTrimWatch() is the timer and
 * the calls, with every I/O injected.
 */

const TRIM_ABOVE_MB = 400;             // Task Manager "Memory" of the whole hidden Spotify tree (see THE LINE)
const TICK_MS = 30 * 1000;
const MIN_GAP_MS = 2 * 60 * 1000;      // at most one trim per 2 min
const MAX_GAP_MS = 10 * 60 * 1000;     // the back-off never waits longer than this
const REFILL_MS = 60 * 1000;           // back over the line this soon after a trim = a fast refill
const FAST_IN_A_ROW = 2;               // fast refills in a row before the gap doubles
const CALM_MS = 10 * 60 * 1000;        // this long under the line and the gap is reset
const MIN_GAIN_MB = 20;                // what the trimmable processes must hold to be worth a trim

const DEFAULTS = { aboveMB: TRIM_ABOVE_MB, tickMs: TICK_MS, firstDelayMs: 8000, minGapMs: MIN_GAP_MS, maxGapMs: MAX_GAP_MS,
  refillMs: REFILL_MS, fastInARow: FAST_IN_A_ROW, calmMs: CALM_MS, minGainMB: MIN_GAIN_MB };

function mins(ms) { const m = ms / 60000; return `${Number.isInteger(m) ? m : m.toFixed(1)} min`; }
function fresh(cfg) { return { gapMs: cfg.minGapMs, lastTrimAt: null, pending: false, fast: 0, calmSince: null, trims: 0 }; }

/* PURE. One reading -> what to do.
     s    the state (fresh(cfg) to begin), never mutated
     r    {mb, procs: [{pid, mb}], audioPids: [pid] | null (unknown), audioReason}
   -> {s, trim, skip: [pid], why: under|gap|audio|nothing|over, gainMB, nextAt, notes: [log line]} */
function step(s0, r, now, cfg) {
  const c = Object.assign({}, DEFAULTS, cfg || {});
  const s = Object.assign({}, s0);
  const notes = [];
  const over = r.mb > c.aboveMB;

  // How fast did the last trim refill? Decided by the first reading that tells.
  if (s.pending) {
    const since = now - s.lastTrimAt;
    if (over && since <= c.refillMs) {
      s.pending = false;
      s.fast += 1;
      if (s.fast >= c.fastInARow) {
        s.fast = 0;
        const g = Math.min(s.gapMs * 2, c.maxGapMs);
        if (g !== s.gapMs) {
          notes.push(`back-off: Spotify was back over ${c.aboveMB} MB within ${Math.round(c.refillMs / 1000)} s of ${c.fastInARow} trims in a row, so trims now wait at least ${mins(g)} (was ${mins(s.gapMs)})`);
          s.gapMs = g;
        }
      }
    } else if (since > c.refillMs) { s.pending = false; s.fast = 0; }
  }

  if (!over) {
    if (s.calmSince == null) s.calmSince = now;
    if (s.gapMs > c.minGapMs && now - s.calmSince >= c.calmMs) {
      notes.push(`back-off reset: under ${c.aboveMB} MB for ${mins(c.calmMs)}, so trims may run every ${mins(c.minGapMs)} again (was ${mins(s.gapMs)})`);
      s.gapMs = c.minGapMs;
      s.fast = 0;
    }
    return { s, trim: false, skip: [], why: 'under', notes };
  }
  s.calmSince = null;
  if (s.lastTrimAt != null && now - s.lastTrimAt < s.gapMs) return { s, trim: false, skip: [], why: 'gap', nextAt: s.lastTrimAt + s.gapMs, notes };
  if (!Array.isArray(r.audioPids)) return { s, trim: false, skip: [], why: 'audio', notes };
  const skip = (r.procs || []).filter((p) => r.audioPids.includes(p.pid) || (r.root && p.pid === r.root)).map((p) => p.pid);
  const gainMB = (r.procs || []).filter((p) => !skip.includes(p.pid)).reduce((a, p) => a + (p.mb || 0), 0);
  if (gainMB < c.minGainMB) return { s, trim: false, skip, why: 'nothing', gainMB, notes };
  return { s, trim: true, skip, why: 'over', gainMB, notes };
}
/* PURE. The state after a trim was made (or tried: a failed one still counts, so nothing hammers). */
function afterTrim(s0, now) { return Object.assign({}, s0, { lastTrimAt: now, pending: true, trims: s0.trims + 1 }); }

/* The watch. opts:
     read(root, created) -> {running, why, created, visible, mb, procs: [{pid, mb}]}   (throws; e.code 'old' =
                            the sidecar has no spotify.mem)
     audio() -> {pids: [pid] | null, reason}      the pids with an ACTIVE audio session (any process)
     trim(root, created, skip) -> {trimmed, beforeMB, afterMB, results, refused}
     log(line), onChange(view), onShown(), onUnavailable(reason),
     onExit({root, why, exit}) (spotdeath lane: the watched Spotify EXITED; exit = {code, at} when the sidecar knows)
     aboveMB: number or () => number (read every tick: the feature setting)
     now, setTimeout, clearTimeout (tests) */
function createTrimWatch(opts) {
  const o = Object.assign({ log: () => {}, onChange: () => {}, onShown: () => {}, onUnavailable: () => {}, onExit: () => {},
    now: () => Date.now(), setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (t) => clearTimeout(t) }, DEFAULTS, opts || {});
  let s = null, timer = null, root = 0, created = null, busy = false, gen = 0;
  let v = { state: 'off', reason: null, root: 0, mb: null, at: null, aboveMB: null, gapMs: o.minGapMs, trims: 0, lastTrim: null, note: null, error: null };
  let lastErr = '', lastAudioErr = '';

  const above = () => {
    const n = Number(typeof o.aboveMB === 'function' ? o.aboveMB() : o.aboveMB);
    return Number.isFinite(n) && n >= 50 ? Math.round(n) : TRIM_ABOVE_MB;
  };
  const cfg = () => ({ aboveMB: above(), minGapMs: o.minGapMs, maxGapMs: o.maxGapMs, refillMs: o.refillMs, fastInARow: o.fastInARow, calmMs: o.calmMs, minGainMB: o.minGainMB });
  function set(p, changed) { v = Object.assign({}, v, p); if (changed) { try { o.onChange(view()); } catch (_) { /* the card is gone */ } } }
  function view() { return Object.assign({}, v); }
  /* What the card needs pushed: everything but the 30 s number. */
  function sig() { return [v.state, v.reason, v.trims, v.lastTrim && v.lastTrim.at, v.gapMs, v.note, v.error, v.aboveMB].join('\u0001'); }

  function schedule(ms, g) {
    if (timer) o.clearTimeout(timer);
    timer = o.setTimeout(() => { timer = null; if (g === gen) tick(g).catch((e) => o.log(`the memory watch threw: ${(e && e.stack) || e}`)); }, ms);
    if (timer && timer.unref) timer.unref();
  }

  /* createdAt: the root's start time as the sidecar reports it (a FILETIME string), when the caller
     already knows it (spadopt lane: a Spotify taken over after a Mantle restart). Otherwise the first
     read supplies it. Every read and trim then passes it, so a reused pid is refused. */
  function start(pid, why, createdAt) {
    pid = Number(pid) || 0;
    if (!pid) return false;
    if (v.state === 'watching' && root === pid) return true;
    gen += 1; root = pid; created = createdAt ? String(createdAt) : null; s = fresh(cfg()); lastErr = ''; lastAudioErr = '';
    set({ state: 'watching', reason: null, root: pid, mb: null, at: null, aboveMB: above(), gapMs: s.gapMs, trims: 0, lastTrim: null, note: null, error: null }, true);
    o.log(`watching the hidden Spotify’s memory (pid ${pid}${why ? `, ${why}` : ''}): trimmed when over ${above()} MB, checked every ${Math.round(o.tickMs / 1000)} s, at most once per ${mins(o.minGapMs)}`);
    schedule(o.firstDelayMs, gen);
    return true;
  }
  function stop(why) {
    gen += 1;
    if (timer) { o.clearTimeout(timer); timer = null; }
    if (v.state !== 'watching') return;
    o.log(`stopped watching the hidden Spotify’s memory: ${why || 'asked to'}`);
    set({ state: 'stopped', reason: why || null }, true);
  }

  async function tick(g) {
    if (busy || g !== gen) return;
    busy = true;
    try {
      let r;
      try { r = await o.read(root, created); } catch (e) {
        if (g !== gen) return;
        if (e && e.code === 'old') {
          const why = `Mantle’s helper (the sidecar) is older than this Mantle and cannot read Spotify’s memory, so it is not watched; restart Mantle to update the helper (${e.message})`;
          o.log(why);
          gen += 1;
          set({ state: 'unavailable', reason: why }, true);
          try { o.onUnavailable(why); } catch (_) { /* said above */ }
          return;
        }
        const msg = `could not read the hidden Spotify’s memory: ${(e && e.message) || e}`;
        if (msg !== lastErr) { lastErr = msg; o.log(msg); }
        set({ error: msg }, true);
        schedule(o.tickMs, g);
        return;
      }
      if (g !== gen) return;
      if (lastErr) { lastErr = ''; set({ error: null }, true); }
      if (!r.running) {
        const was = root;
        stop(r.why || 'Spotify is not running');
        // Gone (not a read that was refused): the owner decides what the card says and what happens next.
        if (/has exited/.test(r.why || '')) { try { o.onExit({ root: was, why: r.why, exit: r.exit || null }); } catch (e) { o.log(`the exit handler threw: ${(e && e.stack) || e}`); } }
        return;
      }
      if (!created && r.created) created = r.created;
      if (r.visible > 0) { stop('Spotify’s window is showing'); try { o.onShown(); } catch (_) { /* said */ } return; }

      // Who plays the audio is only asked when a trim could follow: a quiet tick is ONE sidecar call.
      const c = cfg();
      let au = { pids: [], reason: null };
      if (r.mb > c.aboveMB) {
        try { au = await o.audio(); } catch (e) { au = { pids: null, reason: (e && e.message) || String(e) }; }
        if (g !== gen) return;
      }
      const reading = { mb: r.mb, procs: r.procs || [], audioPids: au && Array.isArray(au.pids) ? au.pids : null, root };
      const now = o.now();
      const d = step(s, reading, now, c);
      s = d.s;
      for (const n of d.notes) o.log(n);
      let note = null;
      if (d.why === 'audio') {
        note = `over ${c.aboveMB} MB but not trimmed: which process plays the audio could not be read (${(au && au.reason) || 'no answer'})`;
        if (note !== lastAudioErr) { lastAudioErr = note; o.log(note); }
      } else lastAudioErr = '';
      if (d.why === 'nothing') note = `over ${c.aboveMB} MB, but ${r.mb - d.gainMB} MB of it is the process playing the audio, which is never trimmed while music plays`;
      set({ mb: r.mb, at: now, aboveMB: c.aboveMB, gapMs: s.gapMs, note }, d.notes.length > 0 || note !== v.note || c.aboveMB !== v.aboveMB);

      if (d.trim) {
        s = afterTrim(s, now);
        let t = null, err = null;
        try { t = await o.trim(root, created, d.skip); } catch (e) { err = (e && e.message) || String(e); }
        if (g !== gen) return;
        const skipTxt = d.skip.length ? `; left alone: pid ${d.skip.join(', ')} (Spotify's main process and whatever plays the audio)` : '';
        if (err || !t || !t.trimmed) {
          const why = err || (t && t.refused && t.refused.length ? t.refused.map((x) => `${x.pid} (${x.why})`).join(', ') : 'nothing was trimmed');
          o.log(`the memory trim failed at ${r.mb} MB: ${why}`);
          set({ trims: s.trims, lastTrim: { at: now, ok: false, beforeMB: r.mb, text: `The memory trim failed: ${why}` } }, true);
        } else {
          const text = `trimmed the hidden Spotify: ${t.beforeMB} MB → ${t.afterMB} MB of RAM (${t.trimmed} process${t.trimmed === 1 ? '' : 'es'}${skipTxt})`;
          o.log(text);
          set({ trims: s.trims, mb: t.afterMB, lastTrim: { at: now, ok: true, beforeMB: t.beforeMB, afterMB: t.afterMB, n: t.trimmed, skipped: d.skip, text: text[0].toUpperCase() + text.slice(1) } }, true);
        }
      }
      schedule(o.tickMs, g);
    } finally { busy = false; }
  }

  return { start, stop, view, sig, tickNow: () => tick(gen), get root() { return root; }, get created() { return created; } };
}

module.exports = { createTrimWatch, step, afterTrim, fresh, DEFAULTS, TRIM_ABOVE_MB, TICK_MS, MIN_GAP_MS, MAX_GAP_MS, REFILL_MS, FAST_IN_A_ROW, CALM_MS, MIN_GAIN_MB };
