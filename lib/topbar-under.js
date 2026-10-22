'use strict';
/*
 * topbar-under.js -- the top bar takes the colour of the window right under it (lane
 * mantle-topbar-under, 2026-10-11). DARK ONLY.
 *
 * The user, 2026-10-11: "you know how on the home page for quartz and helm theres this darker at the top
 * but the mantle top bar still stays the same can we make it so that the top bar changes based on what
 * color is on below it?" His screenshot: the bar ~(38,61,67) over a maximized Quartz whose top rows are
 * ~(25,38,41), a visible step at the bar's bottom edge. He asked for EVERY app, and for a bright window
 * (a white page) to turn the bar light with dark ink. Light theme: untouched, nothing here runs.
 *
 * WHAT IS READ. Live, the bar is a reserved app bar, so no window is ever under it; the window the eye
 * joins it to is the one right BELOW its bottom edge. Each tick reads ONE physical row of the screen
 * directly under the bar, full bar width, through the sidecar's existing `backdrop` capture (BitBlt +
 * CAPTUREBLT, Backdrop.cs; no new sidecar code), at scale 1 so no resampling touches a pixel, and
 * averages it into columns of ~8 physical px (columnsOf). Which parts of that row belong to a WINDOW,
 * and which to the desktop, comes from the sidecar's existing `widgethide.check` (WidgetCover.cs): the
 * same z-ordered list, DWM frame rects and filter the desktop widgets use (minimised, cloaked,
 * click-through, shell furniture, Mantle's own bar / pop-ups / desktop layer are not windows; anything
 * behind Progman is behind the desktop). Columns no window covers are "nothing under": the page keeps
 * today's look there (the wallpaper strip + the shared desktop.guard).
 *
 * WHEN. A tick every FAST_MS (2 Hz: a page switching tabs changes colour without any window event), SLOW_MS
 * (1 Hz) once the row has been still for IDLE_READS reads,
 * plus at once on a kick (the foreground changed, a window went full / zoomed, the bar was shown, a menu
 * closed, the theme or a display changed). The window list is re-read on a kick, when the row's colours
 * moved (at most every CHECK_MIN_MS) and every CHECK_IDLE_MS as a safety net; a still row costs one
 * capture and nothing else. Nothing is sent to the page unless the colours or the cover moved.
 *
 * STOPPED (want): light; the bar hidden (stepped aside for a game or video, hidden by hand); a peek;
 * a full-screen window under the bar; the lock screen in front; the session locked or the screen off
 * (the sidecar's own stats pause says so); a menu of the bar open (its dropdown would be in the row);
 * the page not loaded. None of those is a failure; each says why in topbar.status.
 *
 * PROTECTED WINDOWS. A window that refuses screen capture (DRM video, WDA_MONITOR) reads as solid
 * black. A covered run of columns whose every column (BLACK_SHARE) is at most BLACK_MAX in every channel
 * is treated as "unknown", not as black: those columns fall back to today's look, and the reason is
 * said (topbar.status, the Mantle menu). Why fall back rather than paint black: a protected window could
 * be showing anything (a white page) and a black bar over it is the wrong answer, while a window that
 * really is pure #000 at its top edge gets today's dark glass, which is what it had before this lane.
 * (A window excluded from capture instead, WDA_EXCLUDEFROMCAPTURE, reads as whatever is behind it; that
 * cannot be told from the pixels and is not handled.)
 *
 * NO SILENT FAILURES. A capture or window list that fails MAX_FAILS times in a row puts the page back on
 * today's look WITH the reason (Mantle menu row + strip note), logs once, and retries every RETRY_MS.
 */
const zlib = require('zlib');

// THE RATE. The user: "can we make it so that it changes colors faster like imediatly? so theres no delay?"
// One read (the sidecar's `underrow`: one row, columns averaged there, + this IPC) measured 0.68 ms of CPU
// (tbunder/bench3.js, 30 Hz over an idle sidecar; the old backdrop PNG path 0.99 ms). Events read at once
// (a focus, geometry or TITLE change: a tab switch), at most one read per MIN_GAP_MS; the poll catches what
// fires no event (a page scrolling, loading) at FAST_MS while the row changes, SLOW_MS once it is still.
const FAST_MS = 66;           // the poll: 15 Hz while the row is changing...
const SLOW_MS = 125;          // ...8 Hz once it has been still for IDLE_READS reads (1 s)
const IDLE_READS = 15;
const MIN_GAP_MS = 16;        // events: at most one read per frame
// THE PAINT CAP. A paint (the page planning + putting the frame + the compositor) measured ~5.7 ms of CPU
// (tbunder/probe3.js: 15 paints/s took a test instance from ~3.7% to 12.3% of one core). A row that KEEPS
// changing (a window dragged under the bar, an animation in its top row) would cost ~8% at 15 Hz, so after
// SUSTAIN_READS changing reads in a row the poll drops to BUSY_MS (<= 3.3 paints/s, ~2%). Any event, and
// the row going still, puts it back at the fast rate; a single change is always caught at the fast rate.
const SUSTAIN_READS = 8;
const BUSY_MS = 300;
// THE FRAME WATCH (lane mantle-topbar-instant, 2026-10-11). The user: "can you still make it faster? ... there
// is still a delay that i can see". Measured: a focus or title event fires BEFORE the new window has
// repainted, so the read it set off saw the OLD colour and the new one waited for the next poll (66-125 ms;
// the sidecar's title events are also held up to 250 ms). Now the sidecar watches the screen itself
// (`underwatch`, sidecar/UnderDup.cs: DXGI Desktop Duplication) and pushes the row on the frame it changes
// (frame(ev) below), so there is no poll to wait for. Its pushes are spaced, because each paint costs the
// bar ~5 ms of CPU: the first change after a still spell at once, then at most one per PUSH_MIN_MS, and
// per PUSH_BUSY_MS once the row has kept changing for PUSH_SUSTAIN_MS; the last state always lands.
// While it runs the poll drops to SAFE_MS (the safety read, and the keep-alive the watch stops without).
// When the sidecar cannot watch (the lock screen, a mode change, an old sidecar), it says why and the
// poll above takes over, with FOLLOW_MS reads for FOLLOW_FOR_MS after any event.
const SAFE_MS = 1000;
const PUSH_MIN_MS = 33;
const PUSH_BUSY_MS = 100;
const PUSH_SUSTAIN_MS = 500;
const FOLLOW_MS = 33;
// THE NATIVE LAYER (lane mantle-topbar-zero, 2026-10-11). The user: "there is still a tiny delay. is there a way
// to make it so there is literally no delay?" Measured: the row reached the sidecar ~6 ms after Windows
// presented it, then main -> the page -> Chromium's compositor -> its GPU process -> DWM took 2-3 more
// refreshes. Now, while the frame watch runs, the sidecar paints the colour ITSELF (sidecar/UnderPaint.cs: a
// click-through native window right under the bar, painted on the frame duplication sees the change) and the
// page only masks its glass there and keeps the words, ink and scrim (native: true in its payload). The
// sidecar also paints a window switch from Quartz's / Helm's top-row hints (lib/toprow-hints.js) and from its
// own per-window cache on the frame of the switch. The layer is asked for with the watch's keep-alive and
// stops itself without it; main tells the page native:false the moment the layer is not painting.
const LAYER_LOG_MS = 10 * 60 * 1000;   // the layer's prediction / correction counts are logged at most this often
const FOLLOW_FOR_MS = 150;
const WATCH_ASK_MS = 900;     // the keep-alive at most this often (the sidecar stops after 3 s without one)
const SAY_POLL_AFTER_MS = 2000;   // a fallback that lasts this long is said on the Mantle menu row
const CHECK_MIN_MS = 1000;    // the window list at most this often when the row's colours move (part desktop: a window may be moving in)
const CHECK_IDLE_MS = 5000;   // ...and this often regardless (a window with the wallpaper's colour)
const COL_PX = 8;             // physical px per column
const MAX_COLS = 480;
const SAME_LEVELS = 1;        // a column that moved by <= this in every channel has not changed
const MAX_FAILS = 3;
const RETRY_MS = 5000;
/** Windows' secure desktop (the lock screen's PIN box, a UAC prompt) has the screen: no read can work there, and
 * that is a state, not a failure (lane truthlog, 2026-10-15: each lock logged "could not be duplicated", then
 * "BitBlt failed (Win32 error 5)", then "reads again after a failure"). Those two refusals are how it shows. */
const LOCKED_RE = /Windows refused it \(a secure desktop|BitBlt failed \(Win32 error 5\)/;
const LOCKED_WHY = "locked: the lock screen or a UAC prompt has the screen (Windows' secure desktop), so the bar keeps today's look until it is gone";
const BLACK_MAX = 2;          // "solid black": every channel at most this
const BLACK_SHARE = 0.98;     // ...in this share of a covered run's columns
const MIN_COVER_SPAN_PX = 2;  // a window must cover at least this much of the row to count

/** Pure: should the sampler run now? c = {dark, visible, pageOk, peek, cover, lock, quiet, menuOpen,
 * stopped} -> {on, why, keep}. keep: the page may hold what it shows (only paused, nothing changed under). */
function want(c) {
  if (!c || c.stopped) return { on: false, why: 'the top bar is stopping', keep: false };
  if (!c.dark) return { on: false, why: 'light: the top bar keeps its light frost, nothing is read', keep: false };
  if (!c.visible) return { on: false, why: 'the top bar is not on screen', keep: false };
  if (c.pageOk === false) return { on: false, why: 'the top bar\'s page is not loaded', keep: false };
  if (c.peek) return { on: false, why: 'peeking over a window with the strip let go', keep: false };
  if (c.cover) return { on: false, why: 'a full-screen window is under the top bar', keep: false };
  if (c.lock) return { on: false, why: 'the lock screen is in front', keep: false };
  if (c.quiet) return { on: false, why: `paused: ${c.quiet}`, keep: true };
  if (c.menuOpen) return { on: false, why: 'a menu of the top bar is open over the row it reads', keep: true, hold: true };
  return { on: true, why: 'matching the window under the top bar', keep: false };
}

/** Pure: how many columns a strip this many physical px wide is cut into. */
function colCount(physW) {
  const w = Math.max(1, Math.round(Number(physW) || 0));
  return Math.max(1, Math.min(MAX_COLS, Math.round(w / COL_PX)));
}

/** Pure: the physical row right under the bar. bar = the bar's physical rect {x, y, width, height};
 * display = its display's physical bounds. -> {x, y, w, h: 1} or null (no room under the bar). */
function stripRect(bar, display) {
  if (!bar || !(bar.width > 0) || !(bar.height > 0)) return null;
  const y = Math.round(bar.y + bar.height);
  if (display && y >= Math.round(display.y + display.height)) return null;
  let x = Math.round(bar.x), w = Math.round(bar.width);
  if (display) {
    const l = Math.max(x, Math.round(display.x)), r = Math.min(x + w, Math.round(display.x + display.width));
    x = l; w = r - l;
  }
  return w > 0 ? { x, y, w, h: 1 } : null;
}

/**
 * Pure: average a pixel buffer into n columns of [r, g, b]. order 'rgba' | 'bgra' | 'rgb'; rows are
 * averaged too. -> Uint8Array(n * 3)
 */
function columnsOf(buf, w, h, n, order) {
  const bpp = order === 'rgb' ? 3 : 4;
  const ri = order === 'bgra' ? 2 : 0, bi = order === 'bgra' ? 0 : 2;
  const out = new Uint8Array(n * 3);
  if (!buf || !(w > 0) || !(h > 0) || !(n > 0)) return out;
  for (let c = 0; c < n; c++) {
    const x0 = Math.floor(c * w / n), x1 = Math.max(x0 + 1, Math.floor((c + 1) * w / n));
    let r = 0, g = 0, b = 0, k = 0;
    for (let y = 0; y < h; y++) {
      for (let x = x0; x < x1 && x < w; x++) {
        const i = (y * w + x) * bpp;
        r += buf[i + ri]; g += buf[i + 1]; b += buf[i + bi]; k++;
      }
    }
    if (k) { out[c * 3] = Math.round(r / k); out[c * 3 + 1] = Math.round(g / k); out[c * 3 + 2] = Math.round(b / k); }
  }
  return out;
}

/** Pure: the sidecar's `underrow` answer (base64 of n*3 bytes, or an array) -> Uint8Array(n*3) | null. */
function colsOf(src, n) {
  let b = null;
  if (typeof src === 'string') b = Buffer.from(src, 'base64');
  else if (Array.isArray(src) || ArrayBuffer.isView(src)) b = Uint8Array.from(src);
  if (!b || b.length !== n * 3) return null;
  return new Uint8Array(b.buffer, b.byteOffset, b.length);
}

/** Pure: two column sets the same within `levels` in every channel. */
function sameCols(a, b, levels) {
  if (!a || !b || a.length !== b.length) return false;
  const lv = levels == null ? SAME_LEVELS : levels;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > lv) return false;
  return true;
}
function sameCover(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 0.005) return false;
  return true;
}

/**
 * Pure: the parts of the row that windows cover, from widgethide.check's `windows` list (each
 * {cls, title, rect: [l, t, r, b], ignored, covers}). Only windows the sidecar did NOT ignore and that
 * overlap the row count; the desktop, Mantle's own surfaces and everything behind the desktop do not.
 * strip = {x, y, w, h}. -> [{l, r, by}] merged, left to right, physical px.
 */
function spansOf(windows, strip) {
  if (!Array.isArray(windows) || !strip) return [];
  const L = strip.x, R = strip.x + strip.w, T = strip.y, B = strip.y + Math.max(1, strip.h);
  const raw = [];
  for (const w of windows) {
    if (!w || w.ignored || !Array.isArray(w.rect) || w.rect.length < 4) continue;
    const [wl, wt, wr, wb] = w.rect.map(Number);
    if (!(wb > T) || !(wt < B)) continue;   // not across the row
    const l = Math.max(wl, L), r = Math.min(wr, R);
    if (r - l < MIN_COVER_SPAN_PX) continue;
    raw.push({ l, r, by: String(w.title || w.cls || 'a window') });
  }
  raw.sort((a, b) => a.l - b.l);
  const out = [];
  for (const s of raw) {
    const last = out[out.length - 1];
    if (last && s.l <= last.r) { if (s.r > last.r) last.r = s.r; } else out.push(Object.assign({}, s));
  }
  return out;
}

/** Pure: the share of each column's physical bucket that the spans cover, 0..1. -> Float32Array(n) */
function coverOf(spans, x0, w, n) {
  const out = new Float32Array(n);
  if (!(w > 0) || !(n > 0)) return out;
  for (let c = 0; c < n; c++) {
    const a = x0 + Math.floor(c * w / n), b = x0 + Math.max(Math.floor(c * w / n) + 1, Math.floor((c + 1) * w / n));
    let got = 0;
    for (const s of spans || []) { const l = Math.max(a, s.l), r = Math.min(b, s.r); if (r > l) got += r - l; }
    out[c] = Math.min(1, got / (b - a));
  }
  return out;
}

/**
 * Pure: covered runs of columns that read as solid black (a capture-protected window) are taken out of
 * the cover. cols = Uint8Array(n*3), cover = Float32Array(n) (changed in place).
 * -> {cover, blocked: number of columns taken out}
 */
function protectedBlack(cols, cover, n) {
  let blocked = 0;
  let c = 0;
  while (c < n) {
    if (!(cover[c] >= 0.5)) { c++; continue; }
    let e = c, black = 0;
    while (e < n && cover[e] >= 0.5) {
      const i = e * 3;
      if (cols[i] <= BLACK_MAX && cols[i + 1] <= BLACK_MAX && cols[i + 2] <= BLACK_MAX) black++;
      e++;
    }
    if (black / (e - c) >= BLACK_SHARE) { for (let k = c; k < e; k++) cover[k] = 0; blocked += e - c; }
    c = e;
  }
  return { cover, blocked };
}

/**
 * Pure: a PNG (data URL or Buffer) of 8-bit RGB or RGBA, non-interlaced, to pixels. The sidecar's
 * GDI+ encoder writes exactly that. -> {ok, buf, w, h, order} | {ok:false, reason}
 */
function decodePng(src) {
  try {
    let bytes = src;
    if (typeof src === 'string') {
      const comma = src.indexOf(',');
      if (src.slice(0, 5) !== 'data:' || comma < 0) return { ok: false, reason: 'the capture is not a data URL' };
      bytes = Buffer.from(src.slice(comma + 1), 'base64');
    }
    if (!Buffer.isBuffer(bytes) || bytes.length < 33 || bytes.readUInt32BE(0) !== 0x89504e47) return { ok: false, reason: 'the capture is not a PNG' };
    let p = 8, w = 0, h = 0, depth = 0, type = 0, inter = 0;
    const idat = [];
    while (p + 8 <= bytes.length) {
      const len = bytes.readUInt32BE(p), kind = bytes.toString('latin1', p + 4, p + 8);
      const d = bytes.subarray(p + 8, p + 8 + len);
      if (kind === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); depth = d[8]; type = d[9]; inter = d[12]; }
      else if (kind === 'IDAT') idat.push(d);
      else if (kind === 'IEND') break;
      p += 12 + len;
    }
    if (depth !== 8 || (type !== 2 && type !== 6) || inter !== 0) return { ok: false, reason: `the capture is a PNG this reader does not take (depth ${depth}, colour type ${type}, interlace ${inter})` };
    const bpp = type === 6 ? 4 : 3, stride = w * bpp;
    const raw = zlib.inflateSync(Buffer.concat(idat));
    if (raw.length < h * (stride + 1)) return { ok: false, reason: 'the capture PNG is short' };
    const out = Buffer.alloc(h * stride);
    for (let y = 0; y < h; y++) {
      const f = raw[y * (stride + 1)], row = y * (stride + 1) + 1, o = y * stride;
      for (let x = 0; x < stride; x++) {
        const v = raw[row + x];
        const a = x >= bpp ? out[o + x - bpp] : 0;
        const b = y > 0 ? out[o - stride + x] : 0;
        const c = x >= bpp && y > 0 ? out[o - stride + x - bpp] : 0;
        let pred = 0;
        if (f === 1) pred = a;
        else if (f === 2) pred = b;
        else if (f === 3) pred = (a + b) >> 1;
        else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
        out[o + x] = (v + pred) & 255;
      }
    }
    return { ok: true, buf: out, w, h, order: bpp === 4 ? 'rgba' : 'rgb' };
  } catch (e) {
    return { ok: false, reason: `the capture PNG could not be read: ${e && e.message ? e.message : e}` };
  }
}

/**
 * o.strip()           -> the physical row {x, y, w, h} under the bar, or null
 * o.capture(rect, n)  -> Promise<{ok, cols} | {ok, png} | {ok:false, reason}>   (sidecar `underrow`: n*3 bytes
 *                        base64; or `backdrop` at scale 1 on a sidecar without it)
 * o.windows(rect)     -> Promise<{ok, windows} | {ok:false, reason}> (sidecar `widgethide.check`)
 * o.cond()            -> the want() input, read fresh each time
 * o.push(payload)     -> the page: {cols:[r,g,b,...], cover:[0..1], n, blocked, why} | {off, why, failure, keep}
 * o.onFull(full)      -> a window covers the whole row now / no longer (the glass pauses under it)
 * o.log(line), o.later(ms, fn) -> handle, o.cancel(handle), o.now()
 */
function makeUnder(o) {
  const now = o.now || Date.now;
  const G = {
    on: false, t: null, busy: false, again: false, stopped: false, dirty: true, force: false,
    cols: null, cover: null, spans: [], lastCheck: -Infinity, sentKey: null, lastRead: -Infinity, kicks: 0,
    fails: 0, failing: null, offWhy: null, frames: 0, sent: 0, checks: 0, ms: null, n: 0,
    full: false, blocked: 0, blockedWhy: null, covered: 0,
    // the frame watch: src 'frames' (the sidecar pushes) | 'poll'; srcWhy = why it is polling
    src: 'poll', srcWhy: null, srcSince: 0, watching: false, watchKey: null, watchAskAt: -Infinity, watchGone: false,
    frameSeq: 0, framesIn: 0, followUntil: -Infinity, saidPoll: null,
    locked: false,   // the secure desktop has the screen (said once, as a state)
    // the native layer: painting = asked for; native = the sidecar says it paints (the page masks its glass)
    painting: false, native: false, nativeWhy: null, paintGone: false, layer: null, lastPayload: null, layerLogAt: 0, layerLogKey: null,
  };

  // the poll: SAFE_MS while the sidecar pushes frames; else fast while the row changes (and just after an
  // event), slow once still, BUSY_MS while it has kept changing (the paint cap)
  function rate() {
    if (G.src === 'frames') return SAFE_MS;
    if (now() < G.followUntil) return FOLLOW_MS;
    return G.idle >= IDLE_READS ? SLOW_MS : (G.moving || 0) >= SUSTAIN_READS ? BUSY_MS : FAST_MS;
  }
  /** the fallback's note for the page: only once it has lasted SAY_POLL_AFTER_MS */
  function pollNote() {
    return G.src === 'poll' && G.srcWhy && now() - G.srcSince >= SAY_POLL_AFTER_MS
      ? `it is read 8-15 times a second instead of on every frame, because ${G.srcWhy}` : null;
  }
  function lockedOn() { if (!G.locked) { G.locked = true; o.log(`under: ${LOCKED_WHY}`); } }
  function lockedOff() { if (G.locked) { G.locked = false; o.log('under: unlocked: the secure desktop is gone, the row is read again'); } }
  function srcState(mode, reason) {
    const src = mode === 'frames' ? 'frames' : 'poll';
    const why = mode === 'poll' ? String(reason || 'the frame watch is not running') : null;
    if (src === G.src && why === G.srcWhy) return;
    const was = G.src;
    G.src = src; G.srcWhy = why; G.srcSince = now();
    if (mode === 'off') G.watching = false;   // the sidecar let it go (no keep-alive): the next tick asks again
    if (src !== 'frames') paintOff();         // polling: the layer would have no rows to paint, the page paints again
    if (src === 'frames' && was !== 'frames') { G.saidPoll = null; if (!G.failing) lockedOff(); o.log('under: the sidecar pushes the row on every frame it changes'); }
    if (why && G.saidPoll !== why) { G.saidPoll = why; if (LOCKED_RE.test(why)) lockedOn(); else o.log(`under: polling the row: ${why}`); }
    if (G.on && !G.stopped && !G.failing) schedule(src === 'frames' ? SAFE_MS : gap());
  }
  function watchOn(rect, n) {
    if (!o.watch || G.watchGone) return;
    const key = `${rect.x},${rect.y},${rect.w},${n}`;
    if (G.watching && key === G.watchKey && now() - G.watchAskAt < WATCH_ASK_MS) return;
    G.watching = true; G.watchKey = key; G.watchAskAt = now();
    Promise.resolve(o.watch({ on: true, x: rect.x, y: rect.y, w: rect.w, n, minMs: PUSH_MIN_MS, busyMs: PUSH_BUSY_MS, sustainMs: PUSH_SUSTAIN_MS }))
      .then((r) => {
        if (G.stopped || !G.watching) return;
        if (r && r.ok) { if (r.mode === 'frames' || r.mode === 'poll') srcState(r.mode, r.reason); return; }
        const reason = (r && r.reason) || 'no reason given';
        if (/unknown command/i.test(reason)) { G.watchGone = true; G.watching = false; srcState('poll', 'this sidecar has no frame watch (it is older than Mantle)'); return; }
        G.watching = false;
        srcState('poll', `the frame watch could not start: ${reason}`);
      }, (e) => { G.watching = false; srcState('poll', `the frame watch could not start: ${e && e.message ? e.message : e}`); });
  }
  function paintOn(rect, n) {
    if (!o.paint || G.paintGone || G.src !== 'frames') return;
    const L = o.layer ? o.layer(rect) : null;
    if (!L) { paintState('off', 'the top bar\'s window is not ready'); return; }
    G.painting = true;
    Promise.resolve(o.paint({ on: true, bar: L.bar, x: L.x, y: L.y, w: L.w, h: L.h, rowX: rect.x, rowY: rect.y, rowW: rect.w, n,
      hz: L.hz, visible: !!L.visible, wash: L.wash || null }))
      .then((r) => {
        if (G.stopped || !G.painting) return;
        if (r && r.ok) { G.layer = r; if (r.mode) paintState(r.mode, r.reason); layerLog(r); return; }
        const reason = (r && r.reason) || 'no reason given';
        if (/unknown command/i.test(reason)) { G.paintGone = true; G.painting = false; paintState('off', 'this sidecar has no colour layer (it is older than Mantle)'); return; }
        paintState('failed', `the colour layer could not start: ${reason}`);
      }, (e) => paintState('failed', `the colour layer could not start: ${e && e.message ? e.message : e}`));
  }
  function paintOff() {
    const was = G.painting;
    G.painting = false;
    if (G.native) { G.native = false; G.nativeWhy = null; republish(); }
    if (was && o.paint) Promise.resolve(o.paint({ on: false })).catch(() => { /* it stops itself without a keep-alive */ });
  }
  /** The sidecar's word on its layer: mode native (painting under the bar) | off | failed, with the reason. */
  function paintState(mode, reason) {
    const nat = mode === 'native' && G.painting;
    const why = nat ? null : (reason || null);
    if (nat === G.native && why === G.nativeWhy) return;
    const was = G.native;
    G.native = nat; G.nativeWhy = why;
    if (nat && !was) o.log('under: the sidecar paints the colour itself, under the bar (the page keeps the words)');
    else if (!nat && was) o.log(`under: the page paints the colour again${why ? `: ${why}` : ''}`);
    else if (mode === 'failed' && why) o.log(`under: ${why}`);
    if (nat !== was) republish();
  }
  /** The page's last colours again, with the layer's flag as it is now (the layer came up or went away). */
  function republish() {
    if (!G.lastPayload) return;
    G.lastPayload = Object.assign({}, G.lastPayload, { native: G.native });
    o.push(G.lastPayload);
  }
  function layerLog(r) {
    const key = `${r.confirmed}|${r.corrected}`;
    if (key === G.layerLogKey || now() - G.layerLogAt < LAYER_LOG_MS) return;
    if (!(r.confirmed + r.corrected > 0)) return;
    G.layerLogAt = now(); G.layerLogKey = key;
    o.log(`under: the colour layer predicted ${r.confirmed + r.corrected} switches (${r.confirmed} confirmed by the screen, ${r.corrected} corrected = ${Math.round((r.correctionRate || 0) * 1000) / 10}%), cache ${r.cache} windows, ${r.hints} hints`);
  }
  function watchOff() {
    if (!G.watching) return;
    G.watching = false; G.watchKey = null; G.src = 'poll'; G.srcWhy = null;
    if (o.watch) Promise.resolve(o.watch({ on: false })).catch(() => { /* the sidecar stops it itself without a keep-alive */ });
  }
  // what is left of MIN_GAP_MS since the last read began
  function gap() { return Math.max(0, MIN_GAP_MS - (now() - G.lastRead)); }
  function schedule(ms) {
    if (G.stopped) return;
    if (G.busy) { G.again = true; return; }
    if (G.t) o.cancel(G.t);
    G.t = o.later(ms, () => { G.t = null; tick().catch((e) => o.log(`under: a read threw: ${e && e.message}`)); });
  }
  function setFull(f) {
    if (f === G.full) return;
    G.full = f;
    try { if (o.onFull) o.onFull(f); } catch (_) { /* the glass's business */ }
  }
  function off(w, failure) {
    if (G.t) { o.cancel(G.t); G.t = null; }
    if (!w.hold) watchOff();   // a menu open: the watch idles (main ignores its pushes) and stops itself after 3 s
    const was = G.on;
    G.on = false;
    if (!w.keep) { G.cols = null; G.cover = null; G.sentKey = null; setFull(false); }
    const key = `${failure ? 'F' : ''}${w.why}`;
    if (G.offWhy === key) return;
    G.offWhy = key;
    G.lastPayload = null;
    o.push({ off: true, why: w.why, failure: !!failure, keep: !!w.keep });
    if (!w.hold) paintOff();   // a menu open: the layer keeps the last colour (it stops itself after 3 s without asks)
    if (was && !failure && !w.keep && !w.locked) o.log(`under: off after ${G.frames} read${G.frames === 1 ? '' : 's'}: ${w.why}`);
  }
  function fail(why) {
    G.fails++;
    if (G.fails < MAX_FAILS) return FAST_MS;
    const lock = LOCKED_RE.test(why);
    if (lock) lockedOn();
    else if (G.failing !== why) o.log(`under: today's look: ${why}`);
    G.failing = why;
    off(lock ? { why: LOCKED_WHY, keep: false, locked: true } : { why, keep: false }, !lock);
    G.on = true;   // still wanted: keep trying, slowly
    G.dirty = true;
    return RETRY_MS;
  }


  /** The row's columns (a read or a pushed frame) -> the cover, the protected-black check, and the page
   * (only when something changed). readWall: when the pixels were taken (ms, wall), for the page's lag. */
  function publish(cols, rect, readWall) {
    const cover = coverOf(G.spans, rect.x, rect.w, G.n);
    const pb = protectedBlack(cols, cover, G.n);
    G.blocked = pb.blocked;
    G.blockedWhy = pb.blocked ? 'a window under the top bar reads as solid black, which is how a window that blocks screen capture looks, so the bar keeps its own look there' : null;
    let any = 0, all = G.n > 0;
    for (let i = 0; i < G.n; i++) { if (cover[i] > 0) any++; if (cover[i] < 0.999) all = false; }
    G.covered = G.n ? any / G.n : 0;
    if (!any) {
      G.cols = cols; G.cover = cover; setFull(false);
      const nk = G.blockedWhy ? `F-${G.blockedWhy}` : 'desktop';
      if (G.sentKey !== nk || G.offWhy !== null) {
        G.sentKey = nk; G.offWhy = null;
        G.lastPayload = null;
        o.push({ off: true, why: G.blockedWhy || 'only the desktop is under the top bar', failure: false, blocked: G.blocked, keep: false });
      }
    } else {
      const note = G.blockedWhy || pollNote() || (o.hintNote ? o.hintNote() : null);
      const changed = !sameCols(cols, G.cols, 0) || !sameCover(cover, G.cover) || G.sentKey !== 'cols' || G.offWhy !== null || note !== G.note;
      G.cols = cols; G.cover = cover; G.note = note;
      if (changed) {
        G.sentKey = 'cols'; G.offWhy = null; G.sent++;
        G.lastPayload = { cols: Array.from(cols), cover: Array.from(cover, (v) => Math.round(v * 100) / 100), n: G.n, blocked: G.blocked, why: note, t: readWall, native: G.native };
        o.push(G.lastPayload);
      }
      setFull(all);
    }
  }

  async function tick() {
    if (G.stopped) return;
    const w = want(o.cond());
    if (!w.on) { off(w, false); return; }
    const rect = o.strip();
    let next = FAST_MS;
    if (!rect) {
      next = fail('there is no room under the top bar to read (it sits at the bottom of its screen)');
    } else {
      watchOn(rect, colCount(rect.w));
      paintOn(rect, colCount(rect.w));
      G.busy = true;
      const t0 = now();
      const seq0 = G.frameSeq;
      let r, cols = null, list = null, why = null;
      try {
        const n = colCount(rect.w);
        G.lastRead = t0;
        G.readWall = Date.now();   // sent with the columns: the page measures read -> painted
        r = await o.capture(rect, n);
        if (!r || !r.ok) why = `the screen under the top bar could not be read: ${(r && r.reason) || 'no reason given'}`;
        else if (r.cols != null) {
          // the sidecar's `underrow`: the columns already averaged (the same buckets as columnsOf)
          const c = colsOf(r.cols, n);
          if (c && G.frameSeq !== seq0 && G.cols && G.cols.length === c.length) { G.n = n; cols = G.cols; }   // a frame pushed during the read is newer
          else if (!c) why = `the sidecar's row read came back as ${r.cols && r.cols.length != null ? r.cols.length : 'nothing'}, not ${n * 3} bytes`;
          else { G.n = n; cols = c; }
        } else {
          const d = decodePng(r.png);
          if (!d.ok) why = d.reason;
          else { G.n = n; cols = columnsOf(d.buf, d.w, d.h, G.n, d.order); }
        }
        if (!why) {
          // the window list: on a kick, first thing, when the colours moved (rate-limited), and as a safety net
          const moved = !sameCols(cols, G.cols);
          const since = now() - G.lastCheck;
          // a window filling the row whose page changed colour is not a window moving: no list for that
          const check = G.force || since >= CHECK_IDLE_MS || ((G.dirty || (moved && !G.full)) && since >= CHECK_MIN_MS);
          G.idle = moved ? 0 : (G.idle || 0) + 1;
          G.moving = moved ? (G.moving || 0) + 1 : 0;
          // (moved under a window that fills the row is a page changing, not a window moving: not dirty)
          if (!check) { if (moved && !G.full) G.dirty = true; }
          else {
            list = await o.windows(rect);
            if (!list || !list.ok) why = `the windows under the top bar could not be listed: ${(list && list.reason) || 'no reason given'}`;
            else { G.spans = spansOf(list.windows, rect); G.lastCheck = now(); G.dirty = false; G.force = false; G.checks++; }
          }
        }
      } catch (e) {
        why = `the read threw: ${e && e.message ? e.message : e}`;
      }
      G.busy = false;
      if (G.stopped) return;
      const w2 = want(o.cond());
      if (!w2.on) { off(w2, false); return; }
      if (why) next = fail(why);
      else {
        G.fails = 0;
        if (G.failing) { if (!LOCKED_RE.test(G.failing)) o.log(`under: reads again after a failure (${G.failing})`); G.failing = null; G.offWhy = null; }
        lockedOff();
        G.frames++;
        G.ms = now() - t0;
        next = rate();
        publish(cols, rect, G.readWall);
        if (G.frames === 1) o.log(`under: on, first read of the row under the top bar in ${G.ms} ms (${G.n} columns, ${Math.round(G.covered * 100)}% under a window)`);
      }
    }
    if (G.again) { G.again = false; next = gap(); }
    schedule(next);
  }

  return {
    /** Something changed under or around the bar: read now, and re-list the windows. */
    /** Something changed under or around the bar: read now (at most one read per MIN_GAP_MS), back at the
     * full rate. colour: only the colours can have changed (a title: a tab switch), so no window list. */
    kick(why, colour) {
      if (G.stopped) return;
      const w = want(o.cond());
      if (!w.on) { off(w, false); return; }
      if (!colour) G.force = true;
      G.idle = 0;
      G.moving = 0;
      G.kicks++;
      G.followUntil = now() + FOLLOW_FOR_MS;   // polling: the window may repaint after its event, so read again soon
      if (!G.on) { G.on = true; G.fails = 0; G.frames = 0; G.lastCheck = -Infinity; schedule(0); }
      else schedule(gap());
    },
    /** A push from the sidecar's frame watch: {kind:'cols', cols, n, at, presentAt} or {kind:'state', mode, reason}. */
    frame(ev) {
      if (G.stopped || !ev) return;
      if (ev.kind === 'state') { if (G.watching || ev.mode !== 'off') srcState(ev.mode, ev.reason); return; }
      if (ev.kind === 'paint') { if (G.painting || ev.mode !== 'native') paintState(ev.mode, ev.reason); return; }
      if (ev.kind === 'hint') { try { if (o.onHint) o.onHint(ev); } catch (_) { /* the hints' business */ } return; }
      if (ev.kind !== 'cols' || !G.on || G.failing || !G.watching) return;
      const rect = o.strip();
      if (!rect) return;
      const n = colCount(rect.w);
      if ((ev.n | 0) !== n) return;   // an older watch's row
      const c = colsOf(ev.cols, n);
      if (!c) return;
      const w = want(o.cond());
      if (!w.on) { off(w, false); return; }
      if (G.src !== 'frames') srcState('frames', null);
      G.frameSeq++; G.framesIn++; G.n = n;
      // colours moving under a part-desktop row: a window may be moving in, so list the windows (rate-limited)
      if (!sameCols(c, G.cols) && !G.full) { G.dirty = true; if (now() - G.lastCheck >= CHECK_MIN_MS) schedule(gap()); }
      publish(c, rect, Number(ev.presentAt) || Number(ev.at) || Date.now());
    },
    /** The sidecar restarted: its watch is gone; ask again. */
    sidecarRestarted() {
      G.watching = false; G.watchKey = null; G.watchGone = false;
      G.painting = false; G.paintGone = false;
      if (G.native) { G.native = false; G.nativeWhy = 'the sidecar restarted'; republish(); }
      if (G.src === 'frames') { G.src = 'poll'; G.srcWhy = null; }
      if (G.on && !G.stopped) schedule(0);
    },
    stop() { paintOff(); G.stopped = true; watchOff(); if (G.t) { o.cancel(G.t); G.t = null; } },
    /** a window covers the whole row (the glass can rest) */
    full: () => G.on && G.full && !G.failing,
    view() {
      return {
        on: G.on && !G.failing, frames: G.frames, sent: G.sent, checks: G.checks, kicks: G.kicks, ms: G.ms, n: G.n,
        covered: Math.round(G.covered * 100) / 100, full: G.full, blocked: G.blocked,
        fps: G.on && !G.failing ? 1000 / rate() : 0,
        src: G.on && !G.failing ? G.src : 'off', srcWhy: G.srcWhy, framesIn: G.framesIn,
        native: G.native, nativeWhy: G.nativeWhy,
        layer: G.layer ? { mode: G.layer.mode, layer: G.layer.layer, paints: G.layer.paints, predictions: G.layer.predictions, confirmed: G.layer.confirmed,
          corrected: G.layer.corrected, correctionRate: G.layer.correctionRate, cache: G.layer.cache, hints: G.layer.hints, held: G.layer.held,
          predLagMedianMs: G.layer.predLagMedianMs, predLagP95Ms: G.layer.predLagP95Ms } : null,
        why: G.failing && G.locked ? LOCKED_WHY : G.failing || (G.offWhy ? G.offWhy.replace(/^F/, '') : G.blockedWhy || pollNote()),
        failure: !!G.failing && !G.locked, locked: G.locked,
      };
    },
    peek: () => G,
  };
}

module.exports = {
  LAYER_LOG_MS, SAFE_MS, PUSH_MIN_MS, PUSH_BUSY_MS, PUSH_SUSTAIN_MS, FOLLOW_MS, FOLLOW_FOR_MS, WATCH_ASK_MS, SAY_POLL_AFTER_MS,
  FAST_MS, SLOW_MS, IDLE_READS, MIN_GAP_MS, SUSTAIN_READS, BUSY_MS, CHECK_MIN_MS, CHECK_IDLE_MS, COL_PX, MAX_COLS, MAX_FAILS, RETRY_MS, LOCKED_RE, LOCKED_WHY, BLACK_MAX, BLACK_SHARE,
  want, colCount, stripRect, columnsOf, colsOf, sameCols, spansOf, coverOf, protectedBlack, decodePng, makeUnder,
};
