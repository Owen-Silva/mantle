'use strict';
/*
 * display-fit.js - after a resolution or scale change, the desktop layer fills the main display again
 * and the launcher opens centred on it (lane mn-display, 2026-10-12; audit "Resolution or scale change").
 *
 * WHY. Both windows were placed ONCE, from the display Mantle started on: lib/windows.js createDesktop
 * sized the layer to the primary display's bounds, the sidecar's Desktop.cs Attach parks it with
 * SWP_NOSIZE, and createLauncher centred the launcher at creation. Nothing in main.js set either
 * window's bounds again, so a resolution change left the layer at its old size (a strip of Windows'
 * wallpaper along two edges) and the launcher off-centre. macOS reflows everything at once.
 *
 * WHAT.
 *   centredRect / recentre   the launcher (and any pop-up centred on the main display) is centred
 *                            from the display AS IT IS NOW on every open, never from a cached one.
 *   desktopFitVerdict        whether the layer may be sized now: never while it is held hidden
 *                            waiting to go under the icons (it is sized right after it gets there),
 *                            never in a test run (its layer is an ordinary small window), never
 *                            while Windows is put back.
 *   makeDesktopFit           sizes the layer through the sidecar's `desktop {fit:true}` (Desktop.cs
 *                            Fit: the main monitor's PHYSICAL rect, mapped into the parent window
 *                            the layer is a child of), then asks the page what it now sees and says
 *                            so when the page does not fill the display. Nothing is ever shown here:
 *                            the layer's visibility stays the start/wake lane's (hidden until attached).
 *
 * Every function takes its screen, window and sidecar as arguments, so lib/display-fit.test.js runs
 * them against a FAKE screen whose metrics it changes. Nothing here can change the real display.
 */

/** The DIP rectangle of size w x h centred in bounds {x, y, width, height}. */
function centredRect(bounds, w, h) {
  return {
    x: Math.round(bounds.x + (bounds.width - w) / 2),
    y: Math.round(bounds.y + (bounds.height - h) / 2),
    width: w,
    height: h,
  };
}

function sameRect(a, b) {
  return !!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/**
 * Centre `win` (keeping its size) on the screen's MAIN display as it is now.
 * -> {moved, rect, from, reason}. A window that is gone, or a display that reports no size, is left.
 */
function recentre(win, screen, what) {
  const name = what || 'the window';
  if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return { moved: false, rect: null, from: null, reason: `${name} is not there` };
  let d;
  try { d = screen.getPrimaryDisplay(); } catch (err) { return { moved: false, rect: null, from: null, reason: `the main display could not be read (${err.message}), so ${name} opens where it was` }; }
  const b = d && d.bounds;
  if (!b || !(b.width > 0) || !(b.height > 0)) return { moved: false, rect: null, from: null, reason: `the main display reported no size, so ${name} opens where it was` };
  const from = win.getBounds();
  const want = centredRect(b, from.width, from.height);
  if (sameRect(from, want)) return { moved: false, rect: want, from, reason: `${name} is already centred on the main display (${b.width}x${b.height})` };
  win.setBounds(want);
  return { moved: true, rect: want, from, reason: `${name} was centred on the main display as it is now (${b.width}x${b.height} at scale ${d.scaleFactor || 1}): ${from.x},${from.y} -> ${want.x},${want.y}` };
}

/**
 * May the desktop layer be sized now? o = {alive, test, held, paused}
 * -> {act: 'fit' | 'later' | 'skip', reason}
 *   later: it is held hidden on its way under the icons; it is sized as soon as it gets there.
 */
function desktopFitVerdict(o) {
  const v = o || {};
  if (!v.alive) return { act: 'skip', reason: 'there is no desktop layer' };
  if (v.test) return { act: 'skip', reason: 'a test run: its desktop layer is an ordinary small window, not one that covers the display' };
  if (v.paused) return { act: 'skip', reason: 'Windows is put back, so the desktop layer is left alone' };
  if (v.held) return { act: 'later', reason: 'the desktop layer is waiting, hidden, to go under the icons; it is sized to the display as soon as it is there' };
  return { act: 'fit', reason: 'the desktop layer is sized to the main display as it is now' };
}

/**
 * Does the page fill the display? page = {w, h, dpr} (innerWidth, innerHeight, devicePixelRatio);
 * display = {bounds: {width, height}, scaleFactor}. One DIP of rounding either way is a fill.
 * -> {ok, reason}
 */
function pageFillVerdict(page, display) {
  if (!page || !(page.w > 0) || !(page.h > 0)) return { ok: null, reason: 'the desktop page did not say how big it is' };
  const b = display && display.bounds;
  if (!b) return { ok: null, reason: 'the main display reported no size' };
  const sf = (display && display.scaleFactor) || 1;
  const fills = Math.abs(page.w - b.width) <= 1 && Math.abs(page.h - b.height) <= 1;
  const scaled = !page.dpr || Math.abs(page.dpr - sf) < 0.01;
  if (fills && scaled) return { ok: true, reason: `the desktop page fills the main display (${b.width}x${b.height} at scale ${sf})` };
  return {
    ok: false,
    reason: `the desktop page is ${page.w}x${page.h} at scale ${page.dpr || '?'} but the main display is ${b.width}x${b.height} at scale ${sf}${fills ? ' (it fills the screen but draws at the old scale)' : ''}`,
  };
}

/**
 * The desktop layer's fitter. d = {
 *   win() -> the layer or null, held(win) -> bool, test: bool, paused() -> bool,
 *   hwndOf(win) -> string, sidecar: {call(cmd, args, ms)}, screen (Electron's or a fake),
 *   page(win) -> Promise<{w, h, dpr}> (optional), log(line), setState(patch) (optional)
 * }
 * -> { run(why) -> Promise<result>, afterAttach() -> Promise<result|null>, pending() -> why|null }
 * A run while the layer is held hidden is kept, and afterAttach (called once the layer is under the
 * icons and BEFORE it is shown, so it is never seen at the old size) runs it. Runs never overlap: a burst that lands while one is working queues one more.
 */
const PAGE_WAIT_MS = 2000;
function makeDesktopFit(d) {
  let pendingWhy = null;
  let chain = Promise.resolve();
  const say = (t) => { try { d.log(t); } catch (_) { /* logging never breaks a fit */ } };
  const setState = (p) => { try { if (d.setState) d.setState(p); } catch (_) { /* the log has it */ } };

  async function fitNow(why, attached) {
    const win = d.win();
    const v = desktopFitVerdict({
      alive: !!win && !win.isDestroyed(),
      test: !!(typeof d.test === 'function' ? d.test() : d.test),
      paused: !!(d.paused && d.paused()),
      held: !attached && !!(win && d.held && d.held(win)),   // attached: it has just gone under the icons
    });
    if (v.act === 'later') { pendingWhy = why; say(`not sized yet (${why}): ${v.reason}`); return { act: 'later', reason: v.reason }; }
    if (v.act === 'skip') return { act: 'skip', reason: v.reason };
    pendingWhy = null;
    let r;
    try {
      r = await d.sidecar.call('desktop', { hwnd: d.hwndOf(win), fit: true }, 4000);
    } catch (err) {
      const reason = `the desktop layer could not be sized to the main display (${why}): ${err.message}`;
      say(reason);
      setState({ fit: reason });
      return { act: 'failed', reason };
    }
    const rect = (r && r.rect) || [];
    const size = rect.length === 4 ? `${rect[2] - rect[0]}x${rect[3] - rect[1]} px` : 'size not reported';
    let fill = { ok: null, reason: 'the page was not asked' };
    if (d.page && !win.isDestroyed()) {
      // capped: a busy renderer must not hold the picture retake (and every later fit) behind it
      const asked = Promise.race([d.page(win), new Promise((_, no) => setTimeout(() => no(new Error('no answer in 2 s')), PAGE_WAIT_MS))]);
      try { fill = pageFillVerdict(await asked, d.screen.getPrimaryDisplay()); } catch (err) { fill = { ok: null, reason: `the desktop page did not answer (${err.message})` }; }
    }
    const reason = r && r.changed
      ? `sized to the main display (${why}): now ${size}${r.child ? ', inside the desktop' : ''}; ${fill.reason}`
      : `already the main display's size (${why}): ${size}; ${fill.reason}`;
    say(reason);
    setState({ fit: fill.ok === false ? `the desktop layer was sized to the display, but ${fill.reason}` : null });
    return { act: r && r.changed ? 'fitted' : 'same', reason, fill: fill.ok };
  }

  function queue(why, attached) {
    const p = chain.then(() => fitNow(why, attached));
    chain = p.catch(() => {});
    return p;
  }

  return {
    run: (why) => queue(why),
    afterAttach: () => (pendingWhy ? queue(`${pendingWhy}, now that it is under the icons`, true) : Promise.resolve(null)),
    pending: () => pendingWhy,
  };
}

module.exports = { centredRect, recentre, desktopFitVerdict, pageFillVerdict, makeDesktopFit };
