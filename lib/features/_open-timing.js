'use strict';
/*
 * _open-timing.js - ONE TRUTHFUL LOG LINE PER OPEN of an app window (lane settingsfast, 2026-10-15;
 * design notes: mantle-replace-windows R7). Used by lib/features/settings.js and taskmgr.js.
 *
 *   <surface>: opened (cold|warm) via <trigger>: shown X, painted Y, interactive Z ms
 *
 * All three are ms from the trigger as main saw it (the chord's handler, the launcher's or a page's call):
 *   shown        the window's 'show' event;
 *   painted      the page's second requestAnimationFrame after that show (a frame really drawn);
 *   interactive  the page's first rows drawn (from its cache or fresh): the page sets window.__mantleRows
 *                {at} and fires 'mantle-rows' (ui/settings/settings.js, ui/taskmgr/taskmgr.js); never
 *                earlier than painted. "rows not drawn within 3 s" when they were not.
 * cold = a window made on this open; warm = a hidden window Mantle already had (keep ready).
 * The line is written only AFTER the visibility check (the window visible and not minimised once the
 * frame is drawn); a window that is not on screen by then gets a line that says so instead.
 * A --test run never shows these windows (unless MANTLE_TEST_SHOW_SURFACES=1, where lib/test-quiet.js
 * keeps them invisible): its line is "(test: not shown): ready N ms", N = the trigger to the first paint.
 */

const PAINT_JS = 'new Promise(function (res) { requestAnimationFrame(function () { requestAnimationFrame(function () {' +
  ' var t = Date.now(), r = window.__mantleRows, done = false;' +
  ' if (r && r.at) return res({ at: t, rows: r.at });' +
  ' function f() { if (done) return; done = true; res({ at: t, rows: Date.now() }); }' +
  ' window.addEventListener("mantle-rows", f, { once: true });' +
  ' setTimeout(function () { if (!done) { done = true; res({ at: t, rows: null }); } }, 3000); }); }); })';
const PAINT_CAP_MS = 5000;

/* --test copies only: MANTLE_TEST_SHOW_SURFACES=1 lets a test copy really show (invisibly, lib/test-quiet.js)
   the windows that a --test run otherwise never shows, so the open budget can be measured end to end. */
function testShows(env) { return (env || process.env).MANTLE_TEST_SHOW_SURFACES === '1'; }

function create(ctx, o) {
  const now = (o && o.now) || Date.now;
  let cur = null;
  /** A new open: the trigger time is now. kind 'cold' | 'warm'. -> the record. */
  function start(kind, via, where) {
    cur = { t0: now(), kind, via: via || 'a page', where: where || '', shownAt: null, logged: false };
    return cur;
  }
  const head = (r) => `opened (${r.kind}) via ${r.via}${r.where}`;
  /** The window's 'show' fired: time it, wait for the drawn frame, check it is on screen, log once. */
  function shown(w) {
    const r = cur;
    if (!r || r.shownAt !== null) return Promise.resolve(null);
    r.shownAt = now();
    const shownMs = r.shownAt - r.t0;
    const wc = w && w.webContents;
    let asked;
    try { asked = wc && typeof wc.executeJavaScript === 'function' ? Promise.resolve(wc.executeJavaScript(PAINT_JS, true)) : Promise.resolve(null); } catch (_) { asked = Promise.resolve(null); }
    let timer = null;
    const capped = new Promise((res) => { timer = setTimeout(() => res({ late: true }), PAINT_CAP_MS); if (timer.unref) timer.unref(); });
    return Promise.race([asked.catch((e) => ({ err: (e && e.message) || String(e) })), capped]).then((p) => {
      clearTimeout(timer);
      if (r.logged) return null;
      r.logged = true;
      let visible = true;
      try { visible = !w.isDestroyed() && (typeof w.isVisible !== 'function' || w.isVisible()) && !(typeof w.isMinimized === 'function' && w.isMinimized()); } catch (_) { visible = false; }
      if (!visible) {
        const line = `${head(r)}, but it is NOT on screen (hidden, minimised or closed before its first frame): shown ${shownMs} ms`;
        ctx.log(line);
        return { line, visible: false, shown: shownMs };
      }
      if (!p || p.err || p.late || typeof p.at !== 'number') {
        const why = !p ? 'the page cannot be asked' : p.err ? `the page could not be asked (${p.err})` : p.late ? `no frame within ${PAINT_CAP_MS} ms` : 'the page gave no time';
        const line = `${head(r)}: shown ${shownMs} ms, painted unknown (${why})`;
        ctx.log(line);
        return { line, visible: true, shown: shownMs };
      }
      const painted = Math.max(shownMs, p.at - r.t0);
      const inter = typeof p.rows === 'number' ? Math.max(painted, p.rows - r.t0) : null;
      const line = `${head(r)}: shown ${shownMs}, painted ${painted}, interactive ${inter === null ? 'unknown (rows not drawn within 3 s)' : inter} ms`;
      ctx.log(line);
      return { line, visible: true, shown: shownMs, painted, interactive: inter };
    });
  }
  /** A --test run that does not show the window: log the trigger -> first paint (ready-to-show). */
  function testReady() {
    const r = cur;
    if (!r || r.logged) return null;
    r.logged = true;
    const line = `${head(r)} (test: not shown): ready ${now() - r.t0} ms`;
    ctx.log(line);
    return line;
  }
  return { start, shown, testReady, current: () => cur };
}

module.exports = { create, testShows, PAINT_JS, PAINT_CAP_MS };
