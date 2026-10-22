'use strict';
/* _wall-window.js - main's half of Helm's see-through for the APP windows (Files, Task Manager, Settings,
 * Task view), DARK ONLY (lane helm-wall-apps, 2026-10-09). The page's half is ui/shared/wall-bdrop.js.
 *
 * The user: "you need to get the see through to look just like helm". Helm paints its own blurred photo under
 * its tint; it never asks Windows for acrylic. So in dark these windows are OPAQUE (no backgroundMaterial,
 * the dark ground as the window colour) and the page paints the desktop wallpaper itself, lined up with the
 * real one. This file:
 *   - setLook(win, dark, light): dark = setBackgroundMaterial('none') + the dark ground; light = EXACTLY what
 *     the window was made with ({material, color}), so light is the window as it always was. Electron 44 has
 *     win.setBackgroundMaterial, so a live window switches both ways with no rebuild.
 *   - feed(ctx, {event, pos, light}): asks main for the still (ctx.host.wall.full(), dark only) when a window
 *     is attached, the theme turns dark, or the wallpaper changes; pushes it to every attached window as
 *     `event` and replays it on subscribe; pushes each window's content origin (DIP) as `pos` on move /
 *     resize / show, so the page can keep the picture where the wallpaper is. No timers, nothing in light.
 * No still (no provider, main said why): the page keeps its v1 face and says the reason (no silent failure).
 */

const GROUND_DARK = '#131415';          // --lg-ground in dark (ui/shared/glass-light.css)
const NO_PROVIDER = 'this Mantle has no wallpaper picture provider';
const HOLD_MS = 250;                     // a first show waits at most this long for the baked picture (lane helm-wall)
/* A COLD open (a window made on the open path) waits at most this long, then shows on its solid ground and the
   picture swaps in when it lands (lane settingsfast, plan P3 / R3: glass and wallpaper never gate a show). */
const COLD_HOLD_MS = 50;

/** The window's look for the theme. null, or why it could not be set. */
function setLook(win, dark, light) {
  if (!win || win.isDestroyed()) return 'the window is gone';
  try {
    if (dark) {
      if (typeof win.setBackgroundMaterial === 'function') win.setBackgroundMaterial('none');
      win.setBackgroundColor(GROUND_DARK);
    } else if (light) {
      win.setBackgroundColor(light.color);
      if (light.material && typeof win.setBackgroundMaterial === 'function') win.setBackgroundMaterial(light.material);
    }
    return null;
  } catch (e) { return (e && e.message) || String(e); }
}

const pct = (a, q) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return Math.round(s[Math.min(s.length - 1, Math.floor(q * s.length))] * 1000) / 1000; };

function feed(ctx, o) {
  const host = ctx.host || {};
  const wall = host.wall && typeof host.wall.full === 'function' ? host.wall : null;
  const dark = () => !!(host.theme && typeof host.theme.get === 'function' && host.theme.get() === 'dark');
  const wins = new Map();               // win -> { follow, send }
  const offs = [];
  let last = null, gen = 0;
  // asks: host.wall.full() calls; moves: origin pushes; cost: one push (bounds read + send), ms
  const stats = { asks: 0, pushes: 0, moves: 0, cost: { n: 0, sum: 0, max: 0 }, lookWhy: null, last: [], bounds: [] };

  function sendAll(p) { for (const w of wins.keys()) if (ctx.push(w, o.event, p)) stats.pushes++; }

  async function refresh(why) {
    const mine = ++gen;
    if (!dark()) { last = null; return null; }
    if (!wins.size) { last = null; return null; }        // nobody to show it to: asked again on the next window
    if (!wall) { last = { ok: false, reason: NO_PROVIDER }; sendAll(last); return last; }
    stats.asks++;
    let r;
    try { r = await wall.full(); } catch (e) { r = { ok: false, reason: `asking for the wallpaper picture failed (${e && e.message})` }; }
    if (mine !== gen) return last;      // a newer ask (a theme flip, another wallpaper) decides
    if (!dark()) { last = null; return null; }
    if (!r || r.ok !== true) r = { ok: false, reason: (r && r.reason) || 'main gave no wallpaper picture and no reason' };
    last = r;
    if (!r.ok) ctx.log(`no wallpaper picture (${r.reason}${why ? `; asked because ${why}` : ''}): the window keeps its solid face`);
    sendAll(r);
    return r;
  }

  function sendPos(win) {
    if (!dark() || !win || win.isDestroyed()) return;
    const t0 = process.hrtime.bigint();
    let b;
    try { b = win.getContentBounds(); } catch (_) { return; }
    const tb = Number(process.hrtime.bigint() - t0) / 1e6;
    if (!ctx.push(win, o.pos, { x: b.x, y: b.y, t: Date.now() })) return;
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    stats.moves++; stats.cost.n++; stats.cost.sum += ms; if (ms > stats.cost.max) stats.cost.max = ms;
    stats.last.push(ms); stats.bounds.push(tb);           // the last 120, for the median (one bad frame skews a mean)
    if (stats.last.length > 120) { stats.last.shift(); stats.bounds.shift(); }
  }

  function look(win) {
    if (!o.light) return;
    const why = setLook(win, dark(), o.light);
    if (why !== stats.lookWhy) {
      stats.lookWhy = why;
      if (why) ctx.log(`the ${dark() ? 'opaque dark' : 'light glass'} window could not be set (${why})`);
    }
  }

  /** Track a window: its look follows the theme, its origin is pushed while it moves (follow, default on). */
  function attach(win, opt) {
    if (!win || wins.has(win)) return;
    const follow = !opt || opt.follow !== false;
    const send = () => sendPos(win);
    wins.set(win, { follow, send });
    if (dark()) look(win);              // light: the window is exactly as it was made
    if (follow) {
      win.on('move', send);
      win.on('resize', send);
      win.on('show', send);
      if (win.webContents && typeof win.webContents.on === 'function') win.webContents.on('did-finish-load', send);
    }
    win.once('closed', () => { wins.delete(win); if (!wins.size) { gen++; last = null; } });
    if (dark() && !last) refresh('a window opened').catch(() => {});
  }

  if (o.event && typeof ctx.replay === 'function') ctx.replay(o.event, () => (dark() ? last : null));
  if (host.theme && typeof host.theme.onChange === 'function') {
    const off = host.theme.onChange(() => {
      for (const [w, r] of wins) { look(w); if (r.follow) r.send(); }
      if (dark()) refresh('the theme turned dark').catch(() => {});
      else { gen++; last = null; sendAll({ ok: false, light: true, reason: 'light theme' }); }
    });
    if (typeof off === 'function') offs.push(off);
  }
  if (wall && typeof wall.onChange === 'function') {
    const off = wall.onChange((why) => { if (dark() && wins.size) refresh(`the wallpaper changed (${why || 'no reason given'})`).catch(() => {}); else last = null; });
    if (typeof off === 'function') offs.push(off);
  }

  /**
   * Before a window's FIRST show (lane helm-wall): wait until its page has baked the wallpaper picture
   * (ui/shared/wall-bdrop.js announces 'mantle-wall' {state:'on'}), at most `cap` ms (HOLD_MS), so the
   * window does not open on its solid face and swap to the picture a moment later, then calls show().
   * No wait (show() runs at once, synchronously) in light, without a provider, or when main already said
   * there is no picture. Resolves {why, ms}; never rejects.
   */
  function hold(win, show, cap) {
    const t0 = Date.now();
    const ms = cap > 0 ? cap : HOLD_MS;
    const run = () => { if (typeof show === 'function') { try { show(); } catch (e) { ctx.log(`showing the window threw: ${e && e.message}`); } } };
    const done = (why) => { stats.hold = { why, ms: Date.now() - t0 }; run(); return stats.hold; };
    if (!dark() || !wall || (last && !last.ok) || !win || win.isDestroyed()) return Promise.resolve(done('no wait'));
    const js = 'new Promise(function (res) { var a = window.MantleWallBdrop; if (!a) return res("no wall-bdrop helper"); if (a.state === "on") return res("baked");' +
      ' window.addEventListener("mantle-wall", function f(e) { if (e && e.detail && e.detail.state === "on") { window.removeEventListener("mantle-wall", f); res("baked"); } }); })';
    let timer = null;
    const capped = new Promise((res) => { timer = setTimeout(() => res(`not baked within ${ms} ms`), ms); });
    let asked;
    try { asked = win.webContents.executeJavaScript(js).catch((e) => `the page could not be asked (${e && e.message})`); } catch (e) { asked = Promise.resolve(`the page could not be asked (${e && e.message})`); }
    return Promise.race([asked, capped]).then((why) => { clearTimeout(timer); return done(why); });
  }

  return {
    attach, refresh, dark, hold,
    last: () => last,
    /** for status views and tests: no picture data, only what and why */
    state: () => ({
      dark: dark(), provider: !!wall, windows: wins.size,
      still: last ? (last.ok ? { ok: true, source: last.source || null, key: last.key || null, ms: last.ms, w: last.w, h: last.h, display: last.display } : { ok: false, reason: last.reason }) : null,
      asks: stats.asks, pushes: stats.pushes, moves: stats.moves, lookWhy: stats.lookWhy, hold: stats.hold || null,
      moveCost: stats.cost.n ? { n: stats.cost.n, avg: Math.round((stats.cost.sum / stats.cost.n) * 1000) / 1000, max: Math.round(stats.cost.max * 1000) / 1000,
        p50: pct(stats.last, 0.5), p95: pct(stats.last, 0.95), boundsP50: pct(stats.bounds, 0.5) } : null,
    }),
    stop() { while (offs.length) { try { offs.pop()(); } catch (_) { /* gone */ } } wins.clear(); gen++; last = null; },
  };
}

module.exports = { feed, setLook, GROUND_DARK, NO_PROVIDER, HOLD_MS, COLD_HOLD_MS };
