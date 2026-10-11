'use strict';
/*
 * _topbar-glass.js -- the top bar's frosted backdrop in DARK (lane see-topbar, 2026-10-09).
 *
 * Owen, on dark Mantle: "mantle needs to be more see through everything". The top bar was one flat
 * --lg-fill-fb with nothing blurred under it, so it read as a black strip, and a thinner flat tint
 * would only have shown the wallpaper sharp through it. Now, in dark, the page gets a small picture
 * of what is under the bar (the desktop layer's top strip: lib/topbar-strip.js, no screen capture),
 * blurs it with the theme's own --lg-blur and lays the tint over it. Light is untouched: no picture is
 * read and the page keeps its light frost exactly as it was.
 *
 * WHEN THE BAR GETS A PICTURE (want): dark, on screen, and over the desktop's strip. Not while it
 *   peeks (hidden by hand: the strip is let go and a maximised window is under it), not while it
 *   stays over a full-screen window (S.cover: that window is under it, not the wallpaper), not
 *   before the live strip is reserved (a window may still be there). Each of those is the honest
 *   fallback tint, said in words; none of them is a failure.
 *
 * HOW OFTEN (pace). A still wallpaper does not change, so after IDLE_FRAMES identical pictures the
 *   reads slow to one every SLOW_MS (a new wallpaper shows within that); a moving one (a video) keeps
 *   FAST_MS, the bottom bar's 4 fps. An identical picture is never sent to the page.
 *
 * NO SILENT FAILURES. A read that fails MAX_FAILS times in a row (not a transient miss) puts the page
 *   on its fallback tint WITH the reason (the page shows it in the Mantle menu and on the strip), the
 *   feature logs it once, and topbar.status carries it; reads go on every RETRY_MS so it recovers.
 */

const FAST_MS = 250;
const SLOW_MS = 2000;
const IDLE_FRAMES = 8;
const RETRY_MS = 5000;
const MAX_FAILS = 3;

/** Pure: should the bar have a picture now? c = {dark, visible, pageOk, live, reserved, peek, cover,
 * under, stopped} -> {on, why, keep}. keep: the page may hold its last picture (off because hidden, or
 * because a window's colour covers it all). */
function want(c) {
  if (!c || c.stopped) return { on: false, why: 'the top bar is stopping', keep: false };
  if (!c.dark) return { on: false, why: 'light: the bar keeps its light frost, no picture is read', keep: false };
  if (!c.visible) return { on: false, why: 'the top bar is not on screen', keep: true };
  if (c.pageOk === false) return { on: false, why: 'the top bar\'s page is not loaded', keep: false };
  if (c.peek) return { on: false, why: 'peeking over the screen with the strip let go, so a window, not the wallpaper, is under it', keep: false };
  if (c.cover) return { on: false, why: 'over a full-screen window, which is not the wallpaper', keep: false };
  if (c.live && !c.reserved) return { on: false, why: 'the strip is not reserved yet, so a window may be under the bar', keep: false };
  // the colour under (lib/topbar-under.js): a window fills the whole row under the bar, so the page paints its
  // colour over the full width and this picture is hidden; it rests, kept, until the desktop shows again
  if (c.under) return { on: false, why: 'a window fills the row under the bar, so its colour is painted over the glass', keep: true };
  return { on: true, why: 'over the desktop\'s strip', keep: false };
}

/** Pure: the next period after a frame. st = {period, idle}; same = this picture equals the last. */
function pace(st, same) {
  const idle = same ? (st && st.idle || 0) + 1 : 0;
  return { idle, period: idle >= IDLE_FRAMES ? SLOW_MS : FAST_MS };
}

/**
 * o.read()        -> Promise<{ok, png, under, ms} | {ok:false, transient?, reason}> (ctx.host.desktopStrip)
 * o.cond()        -> the want() input, read fresh each time
 * o.push(payload) -> the page: {png, under, ms} | {off: true, why, failure, keep}
 * o.log(line)
 * o.later(ms, fn) -> handle;  o.cancel(handle)
 */
function makeGlass(o) {
  const G = {
    on: false, t: null, busy: false, again: false, st: { period: FAST_MS, idle: 0 },
    last: null, lastUnder: null, fails: 0, frames: 0, sent: 0, failing: null, offWhy: null, ms: null, stopped: false,
  };

  function schedule(ms) {
    if (G.stopped) return;
    if (G.busy) { G.again = true; return; }
    if (G.t) o.cancel(G.t);
    G.t = o.later(ms, () => { G.t = null; tick().catch((e) => o.log(`glass: a read threw: ${e && e.message}`)); });
  }

  function off(w, failure) {
    if (G.t) { o.cancel(G.t); G.t = null; }
    const was = G.on;
    G.on = false;
    if (!w.keep) { G.last = null; G.lastUnder = null; }
    const key = `${failure ? 'F' : ''}${w.why}`;
    if (G.offWhy === key) return;
    G.offWhy = key;
    o.push({ off: true, why: w.why, failure: !!failure, keep: !!w.keep });
    if (was && !w.keep && !failure) o.log(`glass: off after ${G.frames} picture${G.frames === 1 ? '' : 's'}: ${w.why}`);
  }

  async function tick() {
    if (G.stopped) return;
    const w = want(o.cond());
    if (!w.on) { off(w, false); return; }
    G.busy = true;
    let r;
    try { r = await o.read(); } catch (e) { r = { ok: false, reason: `the read threw: ${e && e.message ? e.message : e}` }; }
    G.busy = false;
    if (G.stopped) return;
    const w2 = want(o.cond());
    if (!w2.on) { off(w2, false); return; }
    let next;
    if (r && r.ok) {
      G.fails = 0;
      G.frames++;
      G.ms = r.ms;
      const same = r.png === G.last && (r.under || null) === G.lastUnder;
      G.st = pace(G.st, same);
      if (!same || G.offWhy !== null) {
        G.last = r.png; G.lastUnder = r.under || null;
        G.sent++;
        o.push({ png: r.png, under: r.under || null, ms: r.ms });
      }
      if (G.failing) { o.log(`glass: the desktop strip reads again after a failure (${G.failing})`); G.failing = null; }
      if (G.frames === 1) o.log(`glass: on, first picture of the desktop's strip in ${r.ms} ms`);
      G.offWhy = null;
      next = G.st.period;
    } else if (r && r.transient) {
      next = G.st.period;
    } else {
      G.fails++;
      const why = (r && r.reason) || 'the read failed and gave no reason';
      if (G.fails >= MAX_FAILS) {
        if (G.failing !== why) { o.log(`glass: flat tint: ${why}`); G.failing = why; }
        off({ why, keep: false }, true);
        G.on = true;   // still wanted: keep trying, slowly
        next = RETRY_MS;
      } else next = FAST_MS;
    }
    if (G.again) { G.again = false; next = 0; }
    schedule(next);
  }

  return {
    /** Something changed (shown, hidden, placed, cover, peek, reserve, theme). fresh: the scene may
     * have changed (a display change, a page load): read now at full pace and resend. */
    kick(why, fresh) {
      if (G.stopped) return;
      const w = want(o.cond());
      if (!w.on) { off(w, false); return; }
      if (fresh) { G.last = null; G.lastUnder = null; G.st = { period: FAST_MS, idle: 0 }; }
      if (!G.on) {
        G.on = true; G.fails = 0; G.frames = 0; G.st = { period: FAST_MS, idle: 0 };
        schedule(0);
      } else if (fresh) schedule(0);
    },
    stop() {
      G.stopped = true;
      if (G.t) { o.cancel(G.t); G.t = null; }
    },
    /** For topbar.status: {on, fps, frames, sent, ms, why, failure}. */
    view() {
      return {
        on: G.on && !G.failing, frames: G.frames, sent: G.sent, ms: G.ms,
        fps: G.on && !G.failing ? Math.round(1000 / G.st.period * 10) / 10 : 0,
        why: G.failing || (G.offWhy ? G.offWhy.replace(/^F/, '') : null), failure: !!G.failing,
      };
    },
    peek: () => G,
  };
}

/*
 * THE SHARED TOP-BAND DARKENING (lane guard-mantle, 2026-10-10; lib/look-guard.js, CONTRACT.md desktop.guard).
 * Owen saw Quartz's strip ~.52 under Mantle's .50 top bar: each ran the same rule over its own patch of
 * the photo. Now Mantle publishes ONE alpha for the band all three apps' top surfaces sit in, and in dark
 * with look sync on the bar's tint alpha IS that value (the page skips its own solve). No guard, a stale
 * one, or one that could not be worked out: the page keeps its own guard and says why (a failure only).
 * The bottom bar is not next to any app strip and keeps its own guard; nothing here reaches it.
 *
 * makeLookGuard(o): o.get() -> lib/look-guard.js use() answer (ctx.host.lookGuard.get), o.push(g) -> the
 * page ('topbar.guard'), o.log(line). -> { sync(force) -> pushed?, view() }
 */
function makeLookGuard(o) {
  let last = null, cur = null, logged = null;
  function read() {
    try { return (o.get && o.get()) || { use: false, why: 'this Mantle hands the top bar no shared darkening, so it works out its own', failure: true }; } catch (e) {
      return { use: false, why: `the shared darkening could not be read (${e && e.message ? e.message : e}), so the top bar works out its own`, failure: true };
    }
  }
  return {
    sync(force) {
      const g = read();
      const k = JSON.stringify(g);
      if (!force && k === last) return false;
      last = k; cur = g;
      o.push(g);
      if (g.failure && g.why !== logged) { o.log(`glass: own darkening: ${g.why}`); logged = g.why; }
      if (!g.failure && logged) { o.log(g.use ? `glass: the shared darkening (${g.alpha}) is back` : `glass: own darkening: ${g.why}`); logged = null; }
      return true;
    },
    view: () => cur,
  };
}

module.exports = { FAST_MS, SLOW_MS, IDLE_FRAMES, RETRY_MS, MAX_FAILS, want, pace, makeGlass, makeLookGuard };
