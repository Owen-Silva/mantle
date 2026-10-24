'use strict';
/*
 * _unfold-core.js - what the Unfold feature decides, with everything outside injected (Electron, the
 * sidecar through ctx, timers, the bus) so lib/features/unfold.test.js drives it with fakes
 * (lane unfold-unlock, 2026-10-23). lib/features/unfold.js is the thin module around it.
 *
 * THE UNFOLD ON UNLOCK / WAKE. Two steps, so the first thing seen when the screen comes back is the
 * screen opening, never the desktop flashing and THEN the effect:
 *   ARM  while nobody can see the screen (it was locked, it turned off, the PC went to sleep while
 *        dark or locked), the overlay goes up on every display as the unlit display: opaque black.
 *   GO   when the screen is seen again (unlocked; or on / lid open / woke while not locked), the
 *        picture of each display is taken WITH the overlay up (it is excluded from capture, so the
 *        picture is the desktop under it, Mantle's video wallpaper included), and each page plays
 *        the unfold over its picture and dissolves into the live screen. ~0.7 s, then hidden.
 * One play per lock or dark spell (the next needs a new ARM), and a play is never started twice in
 * 3 s (unlock, display on and resume all arrive for the same wake).
 *
 * THE SCREEN IS NEVER LEFT BLACK. Every road out of ARMED ends with the overlay gone:
 *   - unlock / display on / lid open / resume while unlocked = GO;
 *   - any key or mouse input while armed and the session is NOT locked = GO (a missed event);
 *   - armed, unlocked and the display on for 1.2 s = GO (whatever was missed);
 *   - the picture does not come within 0.9 s, or comes back black = the black fades out in 0.16 s,
 *     the effect is skipped and the reason logged (3 in a row = the feature's health says why);
 *   - a play that has not ended by its time + 1.5 s is hidden by hand, and the page ends its own
 *     timelines on timers too (ui/unfold/unfold-page.js);
 *   - the page dying = its window hidden at once, made again 1.5 s later;
 *   - the tray switch off, a game rest, stop() = hidden.
 * Locked or not is asked of Windows at the moment (powerMonitor.getSystemIdleState) in a live run,
 * so a missed unlock event cannot keep the black up behind a session that is in fact unlocked.
 *
 * INPUT. While the overlay is up and it matters, the sidecar watches GetLastInputInfo (unfold.input,
 * sidecar/Unfold.cs; 100 ms while armed, 16 ms while playing or covered; nothing at all otherwise).
 * Input in the first 0.28 s of a play does not count (the Enter that finished the PIN, the hand
 * already on the mouse); after that any key or mouse input finishes the unfold at once (a 90 ms fade).
 *
 * THE SCREEN COVER (lib/features/_unfold-bus.js) is provided for as long as the feature is installed,
 * tray switch on or off: cover() pictures the live screen, shows it sharp (the first frame IS the
 * screen) and folds it into blur over --unfold-fold-ms; reveal() unfolds it back into focus and
 * dissolves into the live screen in ~0.2 s. Any input while covered reveals at once and tells the
 * bus. A cover can never outlive 15 minutes (revealed, logged). Let go in stop() and on a game rest.
 *
 * PRIVACY: the pictures go from the sidecar to the overlay page and nowhere else: never logged, never
 * written to disk, dropped from the page when it parks. Log lines say what happened and why, never
 * what was on the screen.
 */
const { createPool } = require('./_unfold-windows.js');

const T = {
  CAPTURE_MAX_MS: 900,      // the picture must come by then, or the effect is skipped (the black fades)
  FULL_MS: 700,             // --unfold-full-ms (the page times itself from the token; this is only for the deadline)
  PLAY_PAD_MS: 1500,        // a play not ended by FULL_MS + this is hidden by hand
  GRACE_MS: 280,            // input this soon after GO does not cut the unfold
  ARMED_ON_MS: 1200,        // armed, unlocked and the display on this long = GO
  LOCKED_RELOOK_MS: 1000,   // input while armed and locked: watch again this much later
  COVER_MAX_MS: 15 * 60 * 1000,
  FOLD_MS: 420,             // --unfold-fold-ms (deadline only)
  REVEAL_MS: 200,           // the look-back
  DEBOUNCE_MS: 3000,
  FAILS_FOR_HEALTH: 3,
  REMAKE_MS: 1500,
  ARMED_POLL_MS: 100,
  LIVE_POLL_MS: 16,
  ARMED_WATCH_MS: 30 * 60 * 1000,
  STRIP_CHARS: 3 * 1024 * 1024,   // one strip's worst-case answer stays under lib/sidecar.js's 4 MB line cap
  MAX_STRIPS: 8,
};

function plain(e) { return String((e && e.message) || e || 'no reason given').split('\n')[0]; }

function createUnfold(ctx, deps) {
  const E = deps.electron;
  const bus = deps.bus || require('./_unfold-bus.js');
  const setT = deps.setTimeout || setTimeout, clearT = deps.clearTimeout || clearTimeout;
  const now = deps.now || Date.now;
  const test = !!(ctx.flags && ctx.flags.test);
  const pool = deps.pool || createPool(ctx, { electron: E, raise: deps.raise, setTimeout: setT, clearTimeout: clearT });
  const S = {
    phase: 'idle',                 // idle | armed | capturing | playing | covering | covered | revealing
    armedWhy: null, armedAt: 0, by: null, locked: false, display: null, lid: null,
    lastGoAt: 0, token: 0, inputToken: 0, inputFor: null, nextInput: 1000 + Math.floor(Math.random() * 1000),
    fails: 0, healthBad: null, last: null, plays: 0, skips: 0, finishes: 0, covers: 0,
    timers: new Map(), stopped: false, watch: null, watchReason: null,
    coverWait: null, revealWait: null, realInput: deps.realInput !== undefined ? !!deps.realInput : !test,
    tech: 'gl', history: [], finishedBy: null,   // the page's technique: gl (shipped; it falls back to layers by itself and says why), layers, css
    drawnBy: null,                 // the technique the pages last drew with, and the reason when it was the fallback
    strips: new Map(),             // display id + pixel size -> strips: a screen whose picture went over the line cap
    forceStrips: 0,                // --test only (unfold.test {op:'strips'}): every picture in this many strips
  };
  const offs = [];

  /* ---- small things ---- */
  function timer(name, ms, fn) { untimer(name); const t = setT(() => { S.timers.delete(name); fn(); }, ms); if (t && t.unref) t.unref(); S.timers.set(name, t); }
  function untimer(name) { const t = S.timers.get(name); if (t) { clearT(t); S.timers.delete(name); } }
  function note(what) { S.history.push({ at: now(), what }); if (S.history.length > 30) S.history.shift(); }
  function mode() { const m = ctx.settings.get('when', 'unlock'); return m === 'wake' ? 'wake' : 'unlock'; }
  function changed() { try { bus.changed(); } catch (_) { /* an asker's bug is theirs */ } }
  function healthy() { if (S.healthBad) { S.healthBad = null; ctx.health(true); } }
  function unhealthy(why) { if (S.healthBad !== why) { S.healthBad = why; ctx.health(false, why); } }

  function locked() {
    if (!test) {
      try {
        const s = E.powerMonitor.getSystemIdleState(1);
        if (s === 'locked') return true;
        if (s === 'active' || s === 'idle') return false;
      } catch (_) { /* fall back to the events */ }
    }
    return S.locked;
  }
  function reducedMotion() {
    if (deps.reducedMotion) return !!deps.reducedMotion();
    try { const a = E.systemPreferences && E.systemPreferences.getAnimationSettings && E.systemPreferences.getAnimationSettings(); return !!(a && a.prefersReducedMotion); } catch (_) { return false; }
  }

  /* ---- the sidecar's input watch ---- */
  async function startInput(forWhat, pollMs, maxMs) {
    stopInput();
    if (!S.realInput) { S.inputToken = S.nextInput++; S.inputFor = forWhat; return; }   // --test: the e2e sends input on purpose
    const token = S.nextInput++;
    S.inputToken = token; S.inputFor = forWhat;
    const r = await ctx.sidecar.send('unfold.input', { on: true, token, pollMs, maxMs });
    if (!r.ok && S.inputToken === token) {
      S.inputToken = 0;
      ctx.log(`input cannot end the ${forWhat} early: the input watch did not start (${r.error})`);
    }
  }
  function stopInput() {
    if (!S.inputToken) return;
    S.inputToken = 0; S.inputFor = null;
    if (S.realInput) ctx.sidecar.send('unfold.input', { on: false }).catch(() => {});
  }
  function onInputEvent(ev) {
    if (!ev || !S.inputToken || ev.token !== S.inputToken) return;
    const forWhat = S.inputFor;
    S.inputToken = 0; S.inputFor = null;
    if (ev.what === 'inputEnd') {
      if (S.phase === 'armed') timer('relook', 0, () => { if (S.phase === 'armed') startInput('armed', T.ARMED_POLL_MS, T.ARMED_WATCH_MS); });
      else if (ev.why === 'error') ctx.log(`the input watch stopped: ${ev.reason || 'no reason given'}`);
      return;
    }
    note(`input during ${forWhat}`);
    if (S.phase === 'armed') {
      if (!locked()) go('input while the screen was dark');
      else timer('relook', T.LOCKED_RELOOK_MS, () => { if (S.phase === 'armed' && !S.inputToken) startInput('armed', T.ARMED_POLL_MS, T.ARMED_WATCH_MS); });
    } else if (S.phase === 'playing' || S.phase === 'capturing') {
      finishPlay('input');
    } else if (S.phase === 'covering' || S.phase === 'covered') {
      reveal({ from: 'input' });
    }
  }

  /* ---- ARM / GO ---- */
  function arm(why) {
    if (S.stopped || !ctx.enabled()) return false;
    if (S.phase === 'armed') return true;
    if (S.phase === 'covering' || S.phase === 'covered' || S.phase === 'revealing') dropCover('the screen turned off or was locked');
    if (S.phase === 'capturing' || S.phase === 'playing') endPlay('the screen turned off or was locked again', null);
    pool.sync();
    if (!pool.count()) { ctx.log(`not armed (${why}): no overlay window is ready`); return false; }
    S.phase = 'armed'; S.armedWhy = why; S.armedAt = now();
    note(`armed: ${why}`);
    pool.send('arm', {}, 1500).then((r) => { if (r.missing.length && S.phase === 'armed') ctx.log(`${r.missing.length} overlay page(s) did not answer the arm`); });
    const problems = pool.show();
    if (problems.length) ctx.log(`the overlay may not be on top: ${problems[0]}`);
    startInput('armed', T.ARMED_POLL_MS, T.ARMED_WATCH_MS);
    lookArmed();
    return true;
  }

  /** armed, unlocked and the display on: GO after 1.2 s whatever else was missed */
  function lookArmed() {
    untimer('armedOn');
    if (S.phase !== 'armed' || S.display === 'off' || locked()) return;
    timer('armedOn', T.ARMED_ON_MS, () => { if (S.phase === 'armed' && S.display !== 'off' && !locked()) go('the screen was on and unlocked'); });
  }

  function disarm(why) {
    if (S.phase !== 'armed') return;
    untimer('armedOn'); untimer('relook'); stopInput();
    S.phase = 'idle'; S.armedWhy = null;
    pool.hide();
    note(`disarmed: ${why}`);
  }

  /*
   * THE PICTURE. One full-screen PNG (the sidecar's backdrop at scale 1) is the common case. Its answer
   * crosses the sidecar's stdout as ONE line, and lib/sidecar.js drops a line over 4 MB: a busy screen
   * (a photo, a video frame) at 1920x1080 measured 4.2 to 5.2 MB in the e2e (10-23), so the effect and
   * the cover silently failed on exactly those screens. Then that display is pictured in horizontal
   * strips (each under the cap even for a screen of pure noise), stitched here with nativeImage
   * (decode + copy ~15-20 ms for 1920x1080) and handed to the page as one PNG (IPC has no line cap).
   * The over-cap answer is retried as strips at once, inside the same 0.9 s, and the display is
   * remembered (id + size) so the next picture of it goes straight to strips.
   */
  function stripsFor(r) {
    return Math.max(2, Math.min(T.MAX_STRIPS, Math.ceil((r.width * r.height * 4 * 4 / 3) / T.STRIP_CHARS)));
  }
  async function grab(r, n, t0) {
    const left = () => Math.max(50, T.CAPTURE_MAX_MS - (now() - t0));
    const tooLong = () => `the picture of the screen took longer than ${T.CAPTURE_MAX_MS} ms`;
    const fail = (res) => ({ why: /timed? ?out|timeout/i.test(String(res.error)) ? tooLong() : `the picture of the screen failed (${res.error})`, overCap: /line cap/i.test(String(res.error)) });
    const empty = (res) => !res.result || typeof res.result.png !== 'string' || !/^data:image\//.test(res.result.png);
    if (n <= 1) {
      const res = await ctx.sidecar.send('backdrop', { x: r.x, y: r.y, w: r.width, h: r.height, scale: 1 }, { timeoutMs: left() });
      if (!res.ok) return fail(res);
      if (empty(res)) return { why: 'the picture of the screen came back empty' };
      return { png: res.result.png };
    }
    const rows = Math.ceil(r.height / n), parts = [];
    for (let y0 = 0; y0 < r.height; y0 += rows) parts.push({ y0, h: Math.min(rows, r.height - y0) });
    const answers = await Promise.all(parts.map((p) => ctx.sidecar.send('backdrop', { x: r.x, y: r.y + p.y0, w: r.width, h: p.h, scale: 1 }, { timeoutMs: left() })));
    const bad = answers.find((a) => !a.ok);
    if (bad) return fail(bad);
    if (answers.some(empty)) return { why: 'the picture of the screen came back empty' };
    const NI = E.nativeImage;
    if (!NI) return { why: 'the strips of the picture could not be joined (no nativeImage)' };
    try {
      const W = r.width, dst = Buffer.alloc(W * r.height * 4);
      for (let k = 0; k < parts.length; k++) {
        const img = NI.createFromDataURL(answers[k].result.png);
        const sz = img.getSize();
        if (sz.width !== W || sz.height !== parts[k].h) return { why: `a strip of the picture came back ${sz.width}x${sz.height}, not ${W}x${parts[k].h}` };
        img.toBitmap().copy(dst, parts[k].y0 * W * 4);
      }
      return { png: NI.createFromBitmap(dst, { width: W, height: r.height }).toDataURL() };
    } catch (e) { return { why: `the strips of the picture could not be joined (${plain(e)})` }; }
  }

  async function capture(list) {
    const stills = {}, why = [], ms = [];
    await Promise.all(list.map(async (d) => {
      let r;
      try { r = E.screen.dipToScreenRect(null, d.bounds); } catch (e) { why.push(`the display's pixels could not be worked out (${plain(e)})`); return; }
      const key = `${d.id}:${r.width}x${r.height}`;
      const t0 = now();
      let got = await grab(r, S.forceStrips || S.strips.get(key) || 1, t0);
      if (got.overCap && !S.strips.has(key)) {
        const n = stripsFor(r);
        S.strips.set(key, n);
        ctx.log(`the picture of a ${r.width}x${r.height} display was too big for one sidecar answer, so it is taken in ${n} strips from now on`);
        got = await grab(r, n, t0);
      }
      const took = now() - t0;
      if (!got.png) { why.push(took > T.CAPTURE_MAX_MS && !/longer than/.test(got.why) ? `the picture of the screen took longer than ${T.CAPTURE_MAX_MS} ms (${got.why})` : got.why); return; }
      if (took > T.CAPTURE_MAX_MS + 100) { why.push(`the picture of the screen took longer than ${T.CAPTURE_MAX_MS} ms`); return; }
      stills[d.id] = got.png;
      ms.push(took);
    }));
    return { stills, why, ms: ms.length ? Math.max(...ms) : null };
  }

  async function go(why) {
    if (S.phase !== 'armed') return false;
    if (now() - S.lastGoAt < T.DEBOUNCE_MS) { disarm('a second wake within 3 s'); return false; }
    untimer('armedOn'); untimer('relook'); stopInput();
    const token = ++S.token;
    S.phase = 'capturing'; S.lastGoAt = now(); S.finishedBy = null;
    note(`go: ${why}`);
    const t0 = now();
    const list = pool.list();
    let shot = { stills: {}, why: [], ms: null };
    const reduced = reducedMotion();
    if (!reduced) shot = await capture(list);
    if (S.token !== token || S.phase !== 'capturing') return false;
    const got = Object.keys(shot.stills).length;
    S.phase = 'playing';
    timer('playHard', T.FULL_MS + T.PLAY_PAD_MS, () => { if (S.token === token) endPlay('the unfold ran past its time and was hidden by hand', null); });
    timer('grace', T.GRACE_MS, () => { if (S.token === token && S.phase === 'playing') startInput('play', T.LIVE_POLL_MS, T.FULL_MS + T.PLAY_PAD_MS); });
    const res = await pool.send('play', { size: 'full', tech: S.tech }, T.FULL_MS + T.PLAY_PAD_MS, (id) => ({ still: shot.stills[id] || null }));
    if (S.token !== token) return true;
    const answers = res.answers;
    const played = answers.filter((a) => a.event === 'played' && a.technique !== 'fade');
    const pageErr = answers.map((a) => a.error).filter(Boolean);
    const skipped = reduced ? null : (!got ? (shot.why[0] || 'no picture of the screen came') : (pageErr[0] || (played.length ? null : 'the overlay did not play')));
    const stats = played.length ? played[0].stats : null;
    endPlay(null, {
      why, reduced, captureMs: shot.ms, totalMs: now() - t0, displays: list.length, played: played.length,
      skipped, stats, prepMs: played.length ? played[0].prepMs : null, timedOut: res.timedOut, missing: res.missing.length,
      // input cut it short: the page answers the play as it fades, so this road (not finishPlay's) records it
      finishedBy: S.finishedBy || undefined,
      stillPx: played.length && Array.isArray(played[0].still) ? played[0].still : null,   // the picture's size as the page drew it
      technique: played.length ? played[0].technique || null : null,
      fallback: (played.find((a) => a.fallback) || {}).fallback || undefined,   // gl could not draw: the simpler unfold played, and why
    });
    return true;
  }

  function endPlay(forced, rec) {
    untimer('playHard'); untimer('grace'); stopInput();
    const wasPlaying = S.phase === 'playing' || S.phase === 'capturing';
    S.token++;
    S.phase = 'idle'; S.armedWhy = null;
    pool.hide();
    pool.send('park', {}, 1000);
    if (!wasPlaying) return;
    const r = rec || { skipped: forced };
    if (forced) r.skipped = forced;
    r.at = now();
    S.last = r;
    if (r.skipped) {
      S.skips++; S.fails++;
      ctx.log(`the unfold was skipped: ${r.skipped}`);
      if (S.fails >= T.FAILS_FOR_HEALTH) unhealthy(`the unfold was skipped ${S.fails} times in a row: ${r.skipped}`);
    } else {
      S.plays++; S.fails = 0; healthy();
      const st = r.stats;
      ctx.log(`unfolded after "${r.why}"${r.reduced ? ' (a short fade: Windows animation effects are off)' : ''}: picture ${r.captureMs == null ? '-' : r.captureMs + ' ms'}, ` +
        `${r.displays} display(s)${st ? `, ${st.frames} frames, p95 ${st.p95} ms, dropped ${st.dropped}` : ''}${r.finishedBy ? `, ended early by ${r.finishedBy}` : ''}`);
      drawn(r.technique, r.fallback);
    }
  }

  function finishPlay(why) {
    if (S.phase !== 'playing' && S.phase !== 'capturing') return;
    const token = S.token;
    S.finishes++; S.finishedBy = why;
    note(`finished by ${why}`);
    if (S.phase === 'capturing') { endPlay(null, { why, finishedBy: why, skipped: null }); return; }
    pool.send('finish', {}, 400).then(() => { if (S.token === token) endPlay(null, Object.assign({ why: S.armedWhy || 'unlock', finishedBy: why, displays: pool.count() }, {})); });
  }

  /* ---- the cover (the bus) ---- */
  function dropCover(why) {
    untimer('coverMax'); stopInput();
    S.token++;
    const was = S.phase;
    S.phase = 'idle'; S.by = null;
    pool.hide();
    pool.send('park', {}, 1000);
    note(`cover dropped: ${why}`);
    if (was === 'covering' || was === 'covered' || was === 'revealing') changed();
  }

  function cover(args) {
    const from = (args && args.from) || null;
    if (S.stopped) return Promise.resolve({ ok: false, reason: 'the screen cover is stopped' });
    if (S.phase === 'covered') return Promise.resolve({ ok: true, already: true });
    if (S.phase === 'covering' && S.coverWait) return S.coverWait;
    if (S.phase === 'armed') return Promise.resolve({ ok: false, reason: 'the screen is off or locked, so there is nothing to cover' });
    if (S.phase === 'capturing' || S.phase === 'playing') endPlay(null, { why: 'cover', finishedBy: 'a cover', displays: pool.count() });
    S.phase = 'covering'; S.by = from; S.covers++;
    const token = ++S.token;
    note(`cover by ${from || 'someone'}`);
    changed();
    S.coverWait = (async () => {
      pool.sync();
      const list = pool.list();
      if (!list.length) { if (S.token === token) dropCover('no overlay window'); return { ok: false, reason: 'the screen cover has no window to show (the overlay is being made again)' }; }
      const shot = await capture(list);
      if (S.token !== token) return { ok: false, reason: 'it was revealed before it sat blurred (any key or mouse input reveals it)' };
      if (!Object.keys(shot.stills).length) {
        dropCover('no picture');
        const why = shot.why[0] || 'no picture of the screen came';
        ctx.log(`the screen cover was not shown: ${why}`);
        return { ok: false, reason: `the screen could not be covered: ${why}` };
      }
      const problems = pool.show();
      if (problems.length) ctx.log(`the screen cover may not be on top: ${problems[0]}`);
      startInput('cover', T.LIVE_POLL_MS, T.COVER_MAX_MS);
      timer('coverMax', T.COVER_MAX_MS, () => { ctx.log('the screen cover was up for 15 minutes and was revealed'); reveal({ from: 'timeout' }); });
      const res = await pool.send('cover', {}, T.FOLD_MS + T.PLAY_PAD_MS, (id) => (shot.stills[id] ? { still: shot.stills[id] } : null));
      if (S.token !== token) return { ok: false, reason: 'it was revealed before it sat blurred (any key or mouse input reveals it)' };
      const bad = res.answers.filter((a) => a.ok === false || a.event === 'gone');
      if (bad.length === res.answers.length) {
        dropCover('the pages failed');
        return { ok: false, reason: `the screen could not be covered: ${bad[0] ? bad[0].error : 'the overlay did not answer'}` };
      }
      S.phase = 'covered';
      const fb = res.answers.find((a) => a.ok !== false && a.fallback);
      drawn(fb ? fb.technique : ((res.answers.find((a) => a.ok !== false) || {}).technique || null), fb ? fb.fallback : null);
      const partial = list.length - (res.answers.length - bad.length);
      return partial > 0 ? { ok: true, partial: `${partial} of ${list.length} displays could not be covered` } : { ok: true };
    })();
    return S.coverWait;
  }

  function reveal(args) {
    const from = (args && args.from) || null;
    if (S.phase === 'revealing' && S.revealWait) return S.revealWait;
    if (S.phase !== 'covering' && S.phase !== 'covered') return Promise.resolve({ ok: true, already: true });
    untimer('coverMax'); stopInput();
    const token = ++S.token;
    S.phase = 'revealing';
    note(`reveal by ${from || 'someone'}`);
    changed();
    S.revealWait = pool.send('reveal', {}, T.REVEAL_MS + 800).then((res) => {
      if (S.token === token) {
        S.phase = 'idle'; S.by = null;
        pool.hide();
        pool.send('park', {}, 1000);
      }
      return res.timedOut ? { ok: true, by: from, note: 'the overlay did not answer in time and was hidden' } : { ok: true, by: from };
    });
    return S.revealWait;
  }

  const provider = {
    cover, reveal,
    state() {
      const covered = S.phase === 'covering' || S.phase === 'covered';
      return { covered, by: covered ? S.by : null };
    },
  };

  /* ---- events ---- */
  function onLock() { S.locked = true; note('lock'); stopInput(); if (mode() === 'unlock') arm('the screen was locked'); else if (S.phase === 'armed') startInput('armed', T.ARMED_POLL_MS, T.ARMED_WATCH_MS); }
  function onUnlock() { S.locked = false; note('unlock'); if (S.phase === 'armed') go('the screen was unlocked'); }
  function onDisplay(st, initial) {
    S.display = st;
    if (initial) return;
    note(`display ${st}`);
    if (st === 'off') arm('the screen turned off');
    else if (st === 'on' && S.phase === 'armed') { if (!locked()) go('the screen turned on'); }
    lookArmed();
  }
  function onLid(open, initial) {
    S.lid = open ? 'open' : 'closed';
    if (initial) return;
    note(`lid ${S.lid}`);
    if (open && S.phase === 'armed' && !locked()) go('the lid was opened');
  }
  function onSuspend() { note('suspend'); if (locked() || S.display === 'off') arm('the PC went to sleep'); }
  function onResume() { note('resume'); if (S.phase === 'armed' && !locked()) go('the PC woke up'); }

  function onSidecar(ev) {
    switch (ev && ev.what) {
      case 'display': return onDisplay(ev.state, !!ev.initial);
      case 'lid': return onLid(!!ev.open, !!ev.initial);
      case 'suspend': return onSuspend();
      case 'resume': return onResume();
      case 'input': case 'inputEnd': return onInputEvent(ev);
      default: return undefined;
    }
  }

  async function startWatch() {
    const r = await ctx.sidecar.send('unfold.watch', { on: true });
    if (!r.ok) {
      S.watchReason = `the screen-off, lid and sleep signals are not available (${r.error}), so only unlocks play it`;
      ctx.log(S.watchReason);
      return;
    }
    S.watch = r.result || null;
    if (S.watch && S.watch.display) S.display = S.watch.display;
    if (S.watch && S.watch.lid) S.lid = S.watch.lid;
    const reason = S.watch && S.watch.reason;
    if (reason !== S.watchReason) { S.watchReason = reason || null; if (reason) ctx.log(reason); }
  }

  /* ---- wiring ---- */
  function onDisplaysChanged() { timer('sync', 400, () => { if (S.phase === 'idle') pool.sync(); }); }

  pool.onGone((why) => {
    const was = S.phase;
    ctx.log(why);
    unhealthy(why);
    if (was === 'armed') disarm('the overlay page died');
    else if (was === 'capturing' || was === 'playing') endPlay(why, null);
    else if (was === 'covering' || was === 'covered' || was === 'revealing') dropCover(why);
    timer('remake', T.REMAKE_MS, () => { if (!S.stopped) pool.sync(); });
  });

  function start() {
    pool.sync();
    offs.push(ctx.sidecar.on('unfold', onSidecar));
    offs.push(ctx.sidecar.onReady(() => { startWatch(); }));
    const pm = E.powerMonitor;
    const pmOn = (ev, fn) => { try { pm.on(ev, fn); offs.push(() => { try { pm.removeListener(ev, fn); } catch (_) { /* gone */ } }); } catch (_) { /* no powerMonitor */ } };
    pmOn('lock-screen', onLock);
    pmOn('unlock-screen', onUnlock);
    pmOn('suspend', onSuspend);
    pmOn('resume', onResume);
    const sc = E.screen;
    for (const ev of ['display-added', 'display-removed', 'display-metrics-changed']) {
      try { sc.on(ev, onDisplaysChanged); offs.push(() => { try { sc.removeListener(ev, onDisplaysChanged); } catch (_) { /* gone */ } }); } catch (_) { /* no screen events */ }
    }
    offs.push(bus.provide(provider));
  }

  function onEnabled(on) {
    if (on) return;
    if (S.phase === 'armed') disarm('switched off');
    else if (S.phase === 'capturing' || S.phase === 'playing') endPlay('switched off', null);
  }

  /** which technique drew, said once each time it changes (a fallback is never silent: its reason is
   * logged and kept in status().drawnBy for Settings and the tests) */
  function drawn(technique, fallback) {
    if (!technique) return;
    const was = S.drawnBy;
    S.drawnBy = fallback ? { technique, fallback } : { technique };
    if (fallback && (!was || was.fallback !== fallback)) ctx.log(`the unfold is drawn the simpler way: ${fallback}`);
    else if (!fallback && was && was.fallback) ctx.log('the full unfold is drawn again');
  }

  /** a page's answer (the unfold.page command) */
  function page(msg) {
    const known = pool.answer(msg);
    if (msg && msg.event === 'ready' && S.healthBad && /overlay/.test(S.healthBad)) { ctx.log('the unfold overlay is back'); healthy(); }
    if (msg && msg.event === 'ready' && msg.fallback) drawn(msg.technique || 'layers', msg.fallback);
    return { ok: known };
  }

  function status() {
    return {
      phase: S.phase, on: ctx.enabled(), when: mode(), locked: locked(), display: S.display, lid: S.lid,
      plays: S.plays, skips: S.skips, finishes: S.finishes, covers: S.covers, last: S.last, drawnBy: S.drawnBy,
      watchReason: S.watchReason, windows: pool.count(), bus: bus.state(),
    };
  }

  function stop(why) {
    S.stopped = true;
    for (const t of S.timers.values()) clearT(t);
    S.timers.clear();
    const wasCovered = S.phase === 'covering' || S.phase === 'covered' || S.phase === 'revealing';
    S.phase = 'idle'; S.token++;
    stopInput();
    for (const off of offs.splice(0)) { try { off(); } catch (_) { /* gone */ } }
    try { ctx.sidecar.send('unfold.watch', { on: false }).catch(() => {}); } catch (_) { /* the sidecar is going too */ }
    pool.hide();
    pool.destroy();
    if (wasCovered) changed();
    note(`stopped: ${why || 'stop'}`);
  }

  /* ---- test hooks (lib/features/unfold.js registers them only in --test) ---- */
  const testApi = {
    fire(what, a) {
      switch (what) {
        case 'lock': onLock(); break;
        case 'unlock': onUnlock(); break;
        case 'display-off': onDisplay('off', false); break;
        case 'display-on': onDisplay('on', false); break;
        case 'lid-open': onLid(true, false); break;
        case 'lid-closed': onLid(false, false); break;
        case 'suspend': onSuspend(); break;
        case 'resume': onResume(); break;
        case 'input': onInputEvent({ what: 'input', token: S.inputToken, simulated: true }); break;
        case 'sidecar-input':   // through the REAL sidecar: unfold.simulate ends the running watch like real input
          return ctx.sidecar.send('unfold.simulate', { what: 'input', token: (a && a.token) || S.inputToken });
        default: return { ok: false, reason: `unknown event ${what}` };
      }
      return { ok: true, phase: S.phase };
    },
    realInput(on) { S.realInput = !!on; return S.realInput; },
    tech(t) { S.tech = t === 'css' || t === 'layers' ? t : 'gl'; return S.tech; },
    strips(n) { S.forceStrips = Math.max(0, Math.min(T.MAX_STRIPS, Math.floor(Number(n) || 0))); return S.forceStrips; },
    state() { return Object.assign(status(), { inputToken: S.inputToken, inputFor: S.inputFor, history: S.history.slice(), realInput: S.realInput, tech: S.tech, list: pool.list(), visible: pool.visible() }); },
    timing: T,
  };

  return { start, stop, onEnabled, page, status, provider, testApi, cover, reveal, _S: S, _pool: pool };
}

module.exports = { createUnfold, TIMING: T };
