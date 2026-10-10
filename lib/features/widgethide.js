'use strict';
/*
 * widgethide.js - the desktop widgets step aside while a window sits over them (lane widgethide,
 * 2026-10-10).
 *
 * Owen: the widgets on the wallpaper (the clock + date, SYSTEM, MISSION CONTROL, NEEDS ATTENTION)
 * should be hidden "when you arent actually on the wallpaper". His pick: each widget fades out
 * while any open window sits over it, and comes back when that window is minimised, moved away,
 * or on Win+D. Apps may become see-through to the desktop later, and a widget must never show
 * through a window that covers it.
 *
 * THE LOOP, no new poll:
 *   ui/desktop/desktop.js  measures its panes (CSS px in its own window) and calls
 *                          widgethide.rects {panes:[{key, x, y, w, h}]} on load and on every resize.
 *   here                   turns them into PHYSICAL screen pixels (the desktop window's origin +
 *                          Electron's dipToScreenRect, the same conversion main.js toPhys uses) and
 *                          hands them to the sidecar: widgethide.watch {on, areas}.
 *   sidecar/WidgetCover.cs answers at once, then rides the window list's own WinEvent hooks and
 *                          pushes 'widgethide' {covered:{key:bool}, by:{key:title}} on each CHANGE.
 *   here                   broadcasts 'widgethide.cover' {on, covered, by, reason}; the page puts
 *                          .covered on those panes (fade out, no clicks, no layout shift).
 *
 * FAILS OPEN: whenever the answer is unknown (switched off, the helper is down or too old, the check
 * failed), every widget is shown and the feature's health says why in plain words, which puts a row
 * in the widgets' own NEEDS ATTENTION strip, the tray and Mantle Settings. A widget is only ever
 * hidden on a real "a window covers it" answer.
 *
 * The switch is the feature's own: "Hide desktop widgets under windows" in the tray and in
 * Mantle Settings > Mantle (default on).
 */

const MAX_PANES = 16;
const KEY = /^[a-z0-9-]{1,40}$/;
const OLD_HELPER = 'Mantle\'s helper is out of date, so the desktop widgets stay up even under a window. Restarting Mantle after an update fixes this';

/** PURE: validate the page's panes. Returns the cleaned list or throws in plain words. */
function readPanes(a) {
  const panes = a && a.panes;
  if (!Array.isArray(panes)) throw new Error('widgethide.rects needs panes: [{key, x, y, w, h}] in CSS pixels');
  if (panes.length > MAX_PANES) throw new Error(`widgethide.rects takes at most ${MAX_PANES} panes, got ${panes.length}`);
  return panes.map((p, i) => {
    if (!p || typeof p !== 'object' || !KEY.test(String(p.key || ''))) throw new Error(`pane ${i} needs a short key (a-z, 0-9, -)`);
    const n = ['x', 'y', 'w', 'h'].map((k) => Number(p[k]));
    if (n.some((v) => !Number.isFinite(v) || Math.abs(v) > 100000)) throw new Error(`pane "${p.key}" has a position or size that is not a number`);
    return { key: p.key, x: n[0], y: n[1], w: n[2], h: n[3] };
  });
}

/**
 * PURE: panes (CSS px inside the desktop window) -> areas in physical screen pixels.
 * `origin` is the desktop window's top-left in DIP; `toScreen(dipRect)` is Electron's
 * screen.dipToScreenRect(null, rect) (or a stand-in in tests). Panes with no size (a hidden strip)
 * are left out: nothing can cover what is not there.
 */
function toAreas(panes, origin, toScreen) {
  const out = [];
  for (const p of panes) {
    if (p.w < 1 || p.h < 1) continue;
    const r = toScreen({ x: Math.round(origin.x + p.x), y: Math.round(origin.y + p.y), width: Math.round(p.w), height: Math.round(p.h) });
    if (!r || !(r.width > 0) || !(r.height > 0)) continue;
    out.push({ key: p.key, l: r.x, t: r.y, r: r.x + r.width, b: r.y + r.height });
  }
  return out;
}

/** PURE: the payload the page draws from. Unknown = nothing covered (fail open). */
function answer(on, covered, by, reason) {
  const c = {};
  const b = {};
  if (on && covered && typeof covered === 'object') {
    for (const k of Object.keys(covered)) { c[k] = covered[k] === true; b[k] = by && typeof by[k] === 'string' ? by[k] : null; }
  }
  return { on: !!on, covered: c, by: b, reason: reason || null };
}

/** The desktop layer's window: the one showing ui/desktop/index.html. */
function desktopOrigin() {
  const { BrowserWindow } = require('electron');
  const win = BrowserWindow.getAllWindows().find((w) => {
    try { return !w.isDestroyed() && /[\\/]ui[\\/]desktop[\\/]index\.html$/i.test(decodeURIComponent(new URL(w.webContents.getURL()).pathname)); } catch (_) { return false; }
  });
  if (!win) return null;
  const b = win.getBounds();
  return { x: b.x, y: b.y };
}

function electronToScreen(rect) {
  const { screen } = require('electron');
  return screen.dipToScreenRect(null, rect);
}

module.exports = {
  name: 'widgethide',
  label: 'Hide desktop widgets under windows',
  defaultOn: true,
  readPanes, toAreas, answer,

  install(ctx, deps) {
    const d = Object.assign({ origin: desktopOrigin, toScreen: electronToScreen }, deps || {});
    let panes = null;            // the page's last report
    let last = answer(ctx.enabled(), {}, {}, null);
    let gen = 0;                 // a newer apply() wins over an older one still waiting on the sidecar
    let stopped = false;

    const publish = (p) => {
      last = p;
      try { ctx.broadcast('widgethide.cover', p); } catch (err) { ctx.log(`the widgets could not be told (${err.message})`); }
    };
    ctx.replay('widgethide.cover', () => last);

    async function apply(why) {
      if (stopped) return last;
      const my = ++gen;
      if (!ctx.enabled()) {
        if (ctx.sidecar.ready) ctx.sidecar.send('widgethide.watch', { on: false }).catch(() => {});
        ctx.health(true);
        publish(answer(false, {}, {}, 'switched off, so the widgets always show'));
        return last;
      }
      if (!panes) { publish(answer(true, {}, {}, 'waiting for the desktop page to say where its widgets are')); return last; }
      const origin = d.origin();
      if (!origin) {
        ctx.health(false, 'the desktop layer is not open, so there are no widgets to hide');
        publish(answer(true, {}, {}, 'the desktop layer is not open'));
        return last;
      }
      const areas = toAreas(panes, origin, d.toScreen);
      if (!ctx.sidecar.ready) {
        publish(answer(true, {}, {}, 'waiting for Mantle\'s helper, so the widgets show for now'));
        return last;
      }
      const r = await ctx.sidecar.send('widgethide.watch', { on: true, areas });
      if (my !== gen || stopped) return last;
      if (!r.ok) {
        const err = String(r.error || 'no reason given');
        const reason = /unknown command/i.test(err) ? OLD_HELPER : `the desktop widgets stay up under windows because the helper could not watch them: ${err}`;
        ctx.health(false, reason);
        publish(answer(true, {}, {}, reason));
        return last;
      }
      ctx.health(true);
      publish(answer(true, r.result && r.result.covered, r.result && r.result.by, null));
      ctx.log(`watching ${areas.length} widget${areas.length === 1 ? '' : 's'} (${why})`);
      return last;
    }

    ctx.sidecar.on('widgethide', (ev) => {
      if (stopped || !ctx.enabled()) return;
      if (ev && ev.error) {
        const reason = `the desktop widgets stay up under windows: ${ev.error}`;
        ctx.health(false, reason);
        publish(answer(true, {}, {}, reason));
        return;
      }
      ctx.health(true);
      publish(answer(true, ev && ev.covered, ev && ev.by, null));
    });

    ctx.command('rects', async (a) => {
      panes = readPanes(a);
      return apply(a && typeof a.why === 'string' ? a.why.slice(0, 80) : 'the widgets moved');
    });
    ctx.command('get', async () => last);
    ctx.onEnabled((on) => { apply(on ? 'switched on' : 'switched off'); });
    ctx.sidecar.onReady(() => { apply('the helper is ready'); });

    return {
      stop() {
        stopped = true;
        gen++;
        if (ctx.sidecar.ready) ctx.sidecar.send('widgethide.watch', { on: false }).catch(() => {});
        publish(answer(false, {}, {}, 'stopped, so the widgets always show'));
      },
    };
  },
};
