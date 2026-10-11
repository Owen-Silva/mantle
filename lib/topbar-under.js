'use strict';
/*
 * topbar-under.js -- the top bar takes the colour of the window right under it (lane
 * mantle-topbar-under, 2026-10-11). DARK ONLY.
 *
 * Owen, 2026-10-11: "you know how on the home page for quartz and helm theres this darker at the top
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

// THE RATE. Owen: "can we make it so that it changes colors faster like imediatly? so theres no delay?"
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
const CHECK_MIN_MS = 1000;    // the window list at most this often when the row's colours move (part desktop: a window may be moving in)
const CHECK_IDLE_MS = 5000;   // ...and this often regardless (a window with the wallpaper's colour)
const COL_PX = 8;             // physical px per column
const MAX_COLS = 480;
const SAME_LEVELS = 1;        // a column that moved by <= this in every channel has not changed
const MAX_FAILS = 3;
const RETRY_MS = 5000;
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
  if (c.menuOpen) return { on: false, why: 'a menu of the top bar is open over the row it reads', keep: true };
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
  };

  // the poll: fast while the row changes, slow once still, BUSY_MS while it has kept changing (the paint cap)
  function rate() { return G.idle >= IDLE_READS ? SLOW_MS : (G.moving || 0) >= SUSTAIN_READS ? BUSY_MS : FAST_MS; }
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
    const was = G.on;
    G.on = false;
    if (!w.keep) { G.cols = null; G.cover = null; G.sentKey = null; setFull(false); }
    const key = `${failure ? 'F' : ''}${w.why}`;
    if (G.offWhy === key) return;
    G.offWhy = key;
    o.push({ off: true, why: w.why, failure: !!failure, keep: !!w.keep });
    if (was && !failure && !w.keep) o.log(`under: off after ${G.frames} read${G.frames === 1 ? '' : 's'}: ${w.why}`);
  }
  function fail(why) {
    G.fails++;
    if (G.fails < MAX_FAILS) return FAST_MS;
    if (G.failing !== why) { o.log(`under: today's look: ${why}`); G.failing = why; }
    off({ why, keep: false }, true);
    G.on = true;   // still wanted: keep trying, slowly
    G.dirty = true;
    return RETRY_MS;
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
      G.busy = true;
      const t0 = now();
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
          if (!c) why = `the sidecar's row read came back as ${r.cols && r.cols.length != null ? r.cols.length : 'nothing'}, not ${n * 3} bytes`;
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
        if (G.failing) { o.log(`under: reads again after a failure (${G.failing})`); G.failing = null; G.offWhy = null; }
        G.frames++;
        G.ms = now() - t0;
        next = rate();
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
            o.push({ off: true, why: G.blockedWhy || 'only the desktop is under the top bar', failure: false, blocked: G.blocked, keep: false });
          }
        } else {
          const changed = !sameCols(cols, G.cols, 0) || !sameCover(cover, G.cover) || G.sentKey !== 'cols' || G.offWhy !== null;
          G.cols = cols; G.cover = cover;
          if (changed) {
            G.sentKey = 'cols'; G.offWhy = null; G.sent++;
            o.push({ cols: Array.from(cols), cover: Array.from(cover, (v) => Math.round(v * 100) / 100), n: G.n, blocked: G.blocked, why: G.blockedWhy, t: G.readWall });
          }
          setFull(all);
        }
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
      if (!G.on) { G.on = true; G.fails = 0; G.frames = 0; G.lastCheck = -Infinity; schedule(0); }
      else schedule(gap());
    },
    stop() { G.stopped = true; if (G.t) { o.cancel(G.t); G.t = null; } },
    /** a window covers the whole row (the glass can rest) */
    full: () => G.on && G.full && !G.failing,
    view() {
      return {
        on: G.on && !G.failing, frames: G.frames, sent: G.sent, checks: G.checks, kicks: G.kicks, ms: G.ms, n: G.n,
        covered: Math.round(G.covered * 100) / 100, full: G.full, blocked: G.blocked,
        fps: G.on && !G.failing ? 1000 / rate() : 0,
        why: G.failing || (G.offWhy ? G.offWhy.replace(/^F/, '') : G.blockedWhy), failure: !!G.failing,
      };
    },
    peek: () => G,
  };
}

module.exports = {
  FAST_MS, SLOW_MS, IDLE_READS, MIN_GAP_MS, SUSTAIN_READS, BUSY_MS, CHECK_MIN_MS, CHECK_IDLE_MS, COL_PX, MAX_COLS, MAX_FAILS, RETRY_MS, BLACK_MAX, BLACK_SHARE,
  want, colCount, stripRect, columnsOf, colsOf, sameCols, spansOf, coverOf, protectedBlack, decodePng, makeUnder,
};
