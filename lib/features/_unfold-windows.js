'use strict';
/*
 * _unfold-windows.js - the Unfold overlay's windows: ONE per display (lane unfold-unlock, 2026-10-23).
 *
 * WHY ONE PER DISPLAY. A single window across monitors with different scale factors is drawn at one
 * scale and blurs the other monitor's picture; one window per display keeps each picture at its own
 * screen's pixels. Every display plays the unfold (or wears the cover) at the same moment, each over
 * its own picture. A display that is added or removed is matched at the next sync() (main's display
 * events and every play/cover call sync(), so a window is never placed for a screen that is gone).
 *
 * EACH WINDOW: pre-created at install and PARKED (hidden, its pictures dropped: nothing ticks, the
 * renderer holds no frame), full-screen on its display, frameless and transparent, click-through
 * (setIgnoreMouseEvents), never focusable (focusable:false: it can never take the keyboard), out of
 * the taskbar, and EXCLUDED FROM CAPTURE (setContentProtection = WDA_EXCLUDEFROMCAPTURE) for its whole
 * life: the picture of the screen is taken WITH the overlay up and it is not in it, and no screenshot
 * or recording the user makes ever contains it. Shown with showInactive() and raised over everything,
 * Mantle's bar and top bar included (lib/raise.js, level screen-saver), in a live run only.
 *
 * TALKING TO A PAGE: send(op, args) pushes `unfold.cmd` {op, seq, ...} to every page and resolves when
 * each has answered that seq through the `unfold.page` command (or after `waitMs`, with the missing
 * displays named). A page that dies (render-process-gone, unresponsive, failed load) is reported to
 * onGone(reason) at once, hidden, and made again at the next sync().
 */
function plain(e) { return String((e && e.message) || e || 'no reason given').split('\n')[0]; }

function createPool(ctx, deps) {
  const { BrowserWindow, screen } = deps.electron;
  const raise = deps.raise || null;                    // lib/raise.js (live only)
  const live = !(ctx.flags && ctx.flags.test);
  const setT = deps.setTimeout || setTimeout, clearT = deps.clearTimeout || clearTimeout;
  const wins = new Map();                              // display id -> { id, win, ready, bounds, scale, gone }
  const pending = new Map();                           // seq -> { want:Set, got:Map, resolve, timer }
  let seq = 0;
  let goneFn = null;
  let destroyed = false;

  function displays() {
    try { return screen.getAllDisplays(); } catch (_) { return []; }
  }

  function make(d) {
    const b = d.bounds;
    const win = new BrowserWindow({
      x: b.x, y: b.y, width: b.width, height: b.height,
      show: false, frame: false, transparent: true, resizable: false, movable: false, thickFrame: false,
      skipTaskbar: true, focusable: false, hasShadow: false, fullscreenable: false, minimizable: false, maximizable: false,
      alwaysOnTop: live, title: 'Mantle unfold', backgroundColor: '#00000000', enableLargerThanScreen: true,
      webPreferences: { preload: ctx.preload, contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false,
        // ready the moment a lock ends: a throttled page would start the unfold late
        backgroundThrottling: false },
    });
    const rec = { id: String(d.id), win, ready: false, bounds: Object.assign({}, b), scale: d.scaleFactor || 1, gone: null };
    try { win.setIgnoreMouseEvents(true); } catch (_) { /* click-through is also the page's pointer-events:none */ }
    try { win.setContentProtection(true); } catch (e) { ctx.log(`the overlay could not be excluded from capture (${plain(e)}): the picture of the screen may contain it`); }
    try { if (typeof win.setSkipTaskbar === 'function') win.setSkipTaskbar(true); } catch (_) { /* skipTaskbar was set at creation */ }
    const wc = win.webContents;
    wc.on('will-navigate', (e) => e.preventDefault());
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    const down = (why) => {
      if (rec.gone) return;
      rec.gone = why;
      rec.ready = false;
      try { if (!win.isDestroyed()) win.hide(); } catch (_) { /* going */ }
      for (const p of pending.values()) if (p.want.has(rec.id) && !p.got.has(rec.id)) answer({ seq: p.seq, display: rec.id, event: 'gone', error: why });
      if (goneFn) { try { goneFn(why, rec.id); } catch (_) { /* the core's handler logs its own */ } }
    };
    wc.on('render-process-gone', (_e, det) => down(`the unfold overlay's page died (${(det && det.reason) || 'no reason given'})`));
    wc.on('unresponsive', () => down('the unfold overlay\'s page stopped responding'));
    wc.on('did-fail-load', (_e, code, desc, _u, isMain) => { if (isMain && code !== -3) down(`the unfold overlay's page did not load (${desc}, ${code})`); });
    win.on('closed', () => { if (wins.get(rec.id) === rec) wins.delete(rec.id); });
    win.loadFile(ctx.page('index.html'), { query: { display: rec.id } }).catch((e) => down(`the unfold overlay's page did not load (${plain(e)})`));
    return rec;
  }

  /** one window per display, at its bounds; windows for displays that are gone are destroyed */
  function sync() {
    if (destroyed) return [];
    const ds = displays();
    const seen = new Set();
    for (const d of ds) {
      const id = String(d.id);
      seen.add(id);
      let rec = wins.get(id);
      if (rec && (rec.gone || rec.win.isDestroyed())) { try { if (!rec.win.isDestroyed()) rec.win.destroy(); } catch (_) { /* gone */ } wins.delete(id); rec = null; }
      if (!rec) { wins.set(id, make(d)); continue; }
      const b = d.bounds;
      if (rec.bounds.x !== b.x || rec.bounds.y !== b.y || rec.bounds.width !== b.width || rec.bounds.height !== b.height) {
        try { rec.win.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height }); rec.bounds = Object.assign({}, b); } catch (_) { /* placed at the next sync */ }
      }
      rec.scale = d.scaleFactor || 1;
    }
    for (const [id, rec] of wins) {
      if (!seen.has(id)) { try { if (!rec.win.isDestroyed()) rec.win.destroy(); } catch (_) { /* gone */ } wins.delete(id); }
    }
    return list();
  }

  function list() {
    return [...wins.values()].filter((r) => !r.gone && !r.win.isDestroyed()).map((r) => ({ id: r.id, bounds: r.bounds, scale: r.scale, ready: r.ready }));
  }

  function show() {
    const problems = [];
    for (const r of wins.values()) {
      if (r.gone || r.win.isDestroyed()) continue;
      try {
        r.win.setBounds({ x: r.bounds.x, y: r.bounds.y, width: r.bounds.width, height: r.bounds.height });
        if (!r.win.isVisible()) r.win.showInactive();
        if (live && raise) { const why = raise.raise(r.win, 'screen-saver'); if (why) problems.push(why); }
      } catch (e) { problems.push(plain(e)); }
    }
    return problems;
  }

  function hide() {
    for (const r of wins.values()) { try { if (!r.win.isDestroyed() && r.win.isVisible()) r.win.hide(); } catch (_) { /* gone */ } }
  }

  function visible() {
    for (const r of wins.values()) { try { if (!r.win.isDestroyed() && r.win.isVisible()) return true; } catch (_) { /* gone */ } }
    return false;
  }

  function answer(msg) {
    if (!msg) return false;
    const id = String(msg.display);
    const r = wins.get(id);
    if (msg.event === 'ready' && r) { r.ready = true; return true; }
    const p = pending.get(msg.seq);
    if (!p || !p.want.has(id) || p.got.has(id)) return false;
    p.got.set(id, msg);
    if (p.got.size >= p.want.size) finish(p, false);
    return true;
  }

  function finish(p, timedOut) {
    if (!pending.has(p.seq)) return;
    pending.delete(p.seq);
    clearT(p.timer);
    const missing = [...p.want].filter((id) => !p.got.has(id));
    p.resolve({ seq: p.seq, answers: [...p.got.values()], missing, timedOut: !!timedOut });
  }

  /** push one op to every live page (perDisplay(id) -> extra args, or null to leave that page out) */
  function send(op, args, waitMs, perDisplay) {
    const s = ++seq;
    const want = new Set();
    return new Promise((resolve) => {
      const p = { seq: s, want, got: new Map(), resolve, timer: null };
      pending.set(s, p);
      for (const r of wins.values()) {
        if (r.gone || r.win.isDestroyed()) continue;
        const extra = perDisplay ? perDisplay(r.id) : {};
        if (extra === null) continue;
        want.add(r.id);
        const ok = ctx.push(r.win, 'unfold.cmd', Object.assign({ op, seq: s }, args || {}, extra));
        if (!ok) p.got.set(r.id, { seq: s, display: r.id, event: 'gone', error: 'the overlay window is gone' });
      }
      if (!want.size || p.got.size >= want.size) return finish(p, false);
      p.timer = setT(() => finish(p, true), waitMs || 2000);
    });
  }

  function destroy() {
    destroyed = true;
    for (const p of [...pending.values()]) finish(p, true);
    for (const r of wins.values()) { try { if (!r.win.isDestroyed()) r.win.destroy(); } catch (_) { /* gone */ } }
    wins.clear();
  }

  /** the overlay pages' renderer process ids (for the priority step a play takes) */
  function pids() {
    const out = [];
    for (const r of wins.values()) { try { if (!r.gone && !r.win.isDestroyed()) { const p = r.win.webContents.getOSProcessId(); if (p > 0) out.push(p); } } catch (_) { /* gone */ } }
    return out;
  }

  return {
    sync, list, show, hide, visible, send, answer, destroy, pids,
    onGone(fn) { goneFn = fn; },
    count: () => list().length,
    _wins: wins,
  };
}

module.exports = { createPool };
