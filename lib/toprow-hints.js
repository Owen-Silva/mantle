'use strict';
/*
 * toprow-hints.js -- Mantle's RECEIVER of look-sync top-row hints (lane zero-pipe, 2026-10-11;
 * spec ~/look-sync/CONTRACT.md, section "Top-row hints (v1)").
 *
 * Quartz and Helm tell Mantle, over the named pipe \\.\pipe\look-sync-toprow, what their windows' top
 * pixel row looks like, in the same JS task that changes it. The top bar can then paint the colour of
 * the window under it the moment the window under it changes, instead of a capture later. Desktop
 * Duplication stays the truth: the parent compares capture against the hint and calls mismatch().
 *
 * One JSON object per line, UTF-8, at most 8 KB per line:
 *   {"v":1,"app":"quartz"|"helm","hwnd":"<decimal>","seq":<int>,"t":<ms>,"top":TOP}
 *   TOP = {"kind":"wash","rgb":[r,g,b],"alpha":a} | {"kind":"flat","rgb":[r,g,b]}
 *       | {"kind":"cols","cols":[[r,g,b],...]}   | {"kind":"none"}
 *
 * makeHints(o) -> { start, stop, view, forget, mismatch, confirmed, resendAll }
 *   o.pipeName  '\\.\pipe\look-sync-toprow' (default). A bare name gets the \\.\pipe\ prefix. A --test
 *               Mantle passes its own (look-sync-toprow-test-<profile>) so it never collides with live.
 *   o.procOf    async (hwndStr) -> {ok:true, pid, path} | {ok:false, reason}  (sidecar `winproc`)
 *   o.dark      () -> bool. Light theme: nothing new is kept or forwarded (forgets still forward null).
 *   o.forward   (hwndStr, app, top|null, meta) -> void. top is normalised (see normaliseTop); null =
 *               forget this hwnd. meta = {seq, t, recvAt}.
 *   o.log       (msg) -> void
 *   o.now       () -> ms (default Date.now)
 *   o.netImpl   (tests) default require('net')
 *   o.home      (tests) the user folder the worktree rule is under; default os.homedir()
 *   o.retryMs   (tests) how often a busy pipe is retried; default 10000
 *
 * washRow(pixels, mapping, n, blurPx) -> Uint8Array(n*3)   PURE, see below.
 * washRowFor({stillPath, display, strip, n, blurPx, dpr}) -> Promise<{ok, cols} | {ok:false, reason}>
 *
 * Never throws out of a socket handler: every handler body is wrapped, and a bug there is logged once.
 */
const os = require('os');
const path = require('path');

const DEFAULT_PIPE = '\\\\.\\pipe\\look-sync-toprow';
const MAX_LINE = 8192;              // bytes per line, excluding the newline (and a CR before it)
const MAX_COLS_IN = 4096;           // cols entries accepted
const MAX_COLS_OUT = 480;           // cols entries forwarded (averaged down)
const RECHECK_MS = 30000;           // a failed window check is retried after this; an ok one re-verified
const RETRY_LISTEN_MS = 10000;      // a pipe that would not listen is retried this often
const LOG_EVERY_MS = 60000;         // an ignore reason is logged at most this often
const MAX_CLIENTS = 32;
const MAX_HWNDS_PER_CLIENT = 64;
const APPS = Object.freeze(['quartz', 'helm']);

const words = (e) => (e && e.message ? e.message : String(e));

/** '\\.\pipe\x' stays; a bare name 'x' becomes '\\.\pipe\x'. */
function pipePath(name) {
  if (typeof name !== 'string' || !name) return DEFAULT_PIPE;
  return name.startsWith('\\\\') ? name : '\\\\.\\pipe\\' + name;
}

function isByte(v) { return Number.isInteger(v) && v >= 0 && v <= 255; }
function isRgb(a) { return Array.isArray(a) && a.length === 3 && isByte(a[0]) && isByte(a[1]) && isByte(a[2]); }

/** Pure: cols [[r,g,b] x N] -> a flat [r,g,b,...] of at most MAX_COLS_OUT entries, averaged by area. */
function resampleCols(cols, max) {
  const lim = max > 0 ? max : MAX_COLS_OUT;
  const N = cols.length;
  if (N <= lim) { const out = new Array(N * 3); for (let i = 0; i < N; i++) { out[i * 3] = cols[i][0]; out[i * 3 + 1] = cols[i][1]; out[i * 3 + 2] = cols[i][2]; } return out; }
  const out = new Array(lim * 3);
  const step = N / lim;
  for (let i = 0; i < lim; i++) {
    const a = i * step, b = (i + 1) * step;
    let r = 0, g = 0, bl = 0, wsum = 0;
    for (let j = Math.floor(a); j < Math.ceil(b) && j < N; j++) {
      const w = Math.min(b, j + 1) - Math.max(a, j);
      if (w <= 0) continue;
      r += cols[j][0] * w; g += cols[j][1] * w; bl += cols[j][2] * w; wsum += w;
    }
    out[i * 3] = Math.round(r / wsum); out[i * 3 + 1] = Math.round(g / wsum); out[i * 3 + 2] = Math.round(bl / wsum);
  }
  return out;
}

/** Pure: a TOP -> {top} normalised, or {bad: reason}. kind none -> {top: {kind: 'none'}}. */
function normaliseTop(top) {
  if (!top || typeof top !== 'object' || Array.isArray(top)) return { bad: 'bad top' };
  switch (top.kind) {
    case 'wash':
      if (!isRgb(top.rgb) || typeof top.alpha !== 'number' || !(top.alpha >= 0 && top.alpha <= 1)) return { bad: 'bad top (wash)' };
      return { top: { kind: 'wash', rgb: [top.rgb[0], top.rgb[1], top.rgb[2]], alpha: top.alpha } };
    case 'flat':
      if (!isRgb(top.rgb)) return { bad: 'bad top (flat)' };
      return { top: { kind: 'flat', rgb: [top.rgb[0], top.rgb[1], top.rgb[2]] } };
    case 'cols': {
      const c = top.cols;
      if (!Array.isArray(c) || c.length < 1 || c.length > MAX_COLS_IN) return { bad: 'bad top (cols)' };
      for (let i = 0; i < c.length; i++) if (!isRgb(c[i])) return { bad: 'bad top (cols)' };
      return { top: { kind: 'cols', cols: resampleCols(c, MAX_COLS_OUT) } };
    }
    case 'none':
      return { top: { kind: 'none' } };
    default:
      return { bad: 'bad top' };
  }
}

/** Pure: a parsed message -> {msg: {app, hwnd, seq, t, top}} or {bad: reason}. Seq order is checked by the caller. */
function checkMessage(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return { bad: 'not valid JSON' };
  if (m.v !== 1) return { bad: 'not protocol v1' };
  if (!APPS.includes(m.app)) return { bad: 'unknown app' };
  if (typeof m.hwnd !== 'string' || !/^[1-9][0-9]{0,19}$/.test(m.hwnd)) return { bad: 'bad hwnd' };
  if (!Number.isSafeInteger(m.seq) || m.seq < 0) return { bad: 'bad seq' };
  if (typeof m.t !== 'number' || !Number.isFinite(m.t)) return { bad: 'bad t' };
  const n = normaliseTop(m.top);
  if (n.bad) return { bad: n.bad };
  return { msg: { app: m.app, hwnd: m.hwnd, seq: m.seq, t: m.t, top: n.top } };
}

/**
 * Pure: does exe `p` belong to `app`? Quartz = Quartz.exe, or electron.exe under <home>\browser\ or a
 * worktree <home>\browser-*\ ; Helm = Helm.exe, or electron.exe under <home>\helm\ or <home>\helm-*\ .
 */
function appOwns(app, p, home) {
  if (typeof p !== 'string' || !p) return false;
  const norm = p.replace(/\//g, '\\').toLowerCase();
  const base = norm.slice(norm.lastIndexOf('\\') + 1);
  const exe = app === 'quartz' ? 'quartz.exe' : app === 'helm' ? 'helm.exe' : null;
  if (!exe) return false;
  if (base === exe) return true;
  if (base !== 'electron.exe') return false;
  const h = String(home || os.homedir()).replace(/\//g, '\\').toLowerCase().replace(/\\+$/, '') + '\\';
  if (!norm.startsWith(h)) return false;
  const top = norm.slice(h.length).split('\\')[0];
  const dir = app === 'quartz' ? 'browser' : 'helm';
  return top === dir || (top.startsWith(dir + '-') && top.length > dir.length + 1);
}

function makeHints(o) {
  o = o || {};
  const pipe = pipePath(o.pipeName || DEFAULT_PIPE);
  const net = o.netImpl || require('net');
  const now = typeof o.now === 'function' ? o.now : Date.now;
  const log = typeof o.log === 'function' ? o.log : () => {};
  const procOf = typeof o.procOf === 'function' ? o.procOf : async () => ({ ok: false, reason: 'no window check was given' });
  const isDark = () => { try { return typeof o.dark === 'function' ? !!o.dark() : true; } catch (_) { return false; } };
  const home = o.home || os.homedir();
  const retryMs = o.retryMs > 0 ? o.retryMs : RETRY_LISTEN_MS;

  let server = null, listening = false, reason = 'not started', stopped = false, retryT = null, startP = null;
  const sockets = new Set();
  const hints = new Map();      // hwnd -> {app, top, meta, sock}
  const seqs = new Map();       // hwnd -> {sock, seq}
  const checks = new Map();     // app|hwnd -> {state: 'pending'|'ok'|'fail', at, pid, why, latest, bg}
  const ignored = Object.create(null);
  const lastLogged = Object.create(null);
  const apps = { quartz: { mismatch: null, since: null }, helm: { mismatch: null, since: null } };
  const mismatchLogged = new Set();
  let bugLogged = false;

  function say(m) { try { log(`top-row hints: ${m}`); } catch (_) { /* a log must never break us */ } }
  function bug(where, e) { if (!bugLogged) { bugLogged = true; say(`a bug in ${where} was caught (${words(e)}); further ones are not logged`); } }
  function count(why, app) {
    ignored[why] = (ignored[why] || 0) + 1;
    const t = now();
    if (lastLogged[why] === undefined || t - lastLogged[why] >= LOG_EVERY_MS) {
      lastLogged[why] = t;
      say(`ignored a message${app ? ` from ${app}` : ''}: ${why} (${ignored[why]} so far; logged at most once a minute)`);
    }
  }
  function fwd(hwnd, app, top, meta) { try { o.forward && o.forward(hwnd, app, top, meta); } catch (e) { bug('forward', e); } }

  function drop(hwnd, why) {
    const h = hints.get(hwnd);
    if (!h) return false;
    hints.delete(hwnd);
    fwd(hwnd, h.app, null, { why });
    return true;
  }

  /* ---- the window check: once per (app, hwnd), cached ------------------------------------------- */
  function runCheck(key, app, hwnd, c) {
    let p;
    try { p = Promise.resolve(procOf(hwnd)); } catch (e) { p = Promise.resolve({ ok: false, reason: words(e) }); }
    return p.then((r) => r, (e) => ({ ok: false, reason: words(e) })).then((r) => {
      try {
        if (checks.get(key) !== c) return;   // forgotten meanwhile
        const prevPid = c.pid;
        c.at = now(); c.bg = false;
        if (!r || !r.ok) { c.state = 'fail'; c.why = 'window check failed'; c.detail = r && r.reason ? String(r.reason) : 'no answer'; }
        else if (!appOwns(app, r.path, home)) { c.state = 'fail'; c.why = 'window is not that app\'s'; c.detail = String(r.path); c.pid = r.pid; }
        else { c.state = 'ok'; c.pid = r.pid; c.why = null; }
        if (c.state === 'fail') {
          const h = hints.get(hwnd);
          if (h && h.app === app) drop(hwnd, c.why);
          count(c.why, app);
        } else if (prevPid !== undefined && prevPid !== c.pid) {
          say(`window ${hwnd} of ${app} now belongs to process ${c.pid} (was ${prevPid}); still ${app}'s`);
        }
        const l = c.latest; c.latest = null;
        if (l && c.state === 'ok') accept(l);
      } catch (e) { bug('the window check', e); }
    });
  }

  function accept(l) {
    const { msg, sock, recvAt } = l;
    if (sock.destroyed || !sockets.has(sock.__th)) return;
    if (!isDark()) { count('light theme', msg.app); return; }
    const st = sock.__th;
    if (!st.hwnds.has(msg.hwnd) && st.hwnds.size >= MAX_HWNDS_PER_CLIENT) { count('too many windows on one client', msg.app); return; }
    st.hwnds.add(msg.hwnd);
    const meta = { seq: msg.seq, t: msg.t, recvAt };
    hints.set(msg.hwnd, { app: msg.app, top: msg.top, meta, sock: st });
    fwd(msg.hwnd, msg.app, msg.top, meta);
  }

  function handleLine(buf, st, sock) {
    const recvAt = now();
    const s = buf.toString('utf8').trim();
    if (!s) return;
    let m;
    try { m = JSON.parse(s); } catch (_) { count('not valid JSON'); return; }
    const r = checkMessage(m);
    if (r.bad) { count(r.bad, m && APPS.includes(m.app) ? m.app : null); return; }
    const msg = r.msg;
    const sq = seqs.get(msg.hwnd);
    if (sq && sq.sock === st && msg.seq <= sq.seq) { count('seq not increasing', msg.app); return; }
    seqs.set(msg.hwnd, { sock: st, seq: msg.seq });
    st.seen.add(msg.hwnd);

    if (msg.top.kind === 'none') {
      const h = hints.get(msg.hwnd);
      if (h && h.sock === st) drop(msg.hwnd, 'the app said none');
      const c = checks.get(msg.app + '|' + msg.hwnd);
      if (c && c.latest) c.latest = null;
      return;
    }
    if (!isDark()) {
      // light theme: keep nothing new; a kept hint for this window is now stale, so it goes
      const h = hints.get(msg.hwnd);
      if (h && h.sock === st) drop(msg.hwnd, 'light theme');
      count('light theme', msg.app);
      return;
    }
    const key = msg.app + '|' + msg.hwnd;
    const l = { msg, sock, recvAt };
    let c = checks.get(key);
    if (c && c.state === 'ok') {
      accept(l);
      if (!c.bg && now() - c.at >= RECHECK_MS) { c.bg = true; runCheck(key, msg.app, msg.hwnd, c); }
      return;
    }
    if (c && c.state === 'pending') { c.latest = l; return; }
    if (c && c.state === 'fail' && now() - c.at < RECHECK_MS) { count(c.why, msg.app); return; }
    c = { state: 'pending', at: now(), latest: l, bg: false, pid: c ? c.pid : undefined };
    checks.set(key, c);
    runCheck(key, msg.app, msg.hwnd, c);
  }

  /* ---- line framing, 8 KB cap -------------------------------------------------------------------- */
  function feed(st, sock, chunk) {
    let start = 0;
    for (;;) {
      const idx = chunk.indexOf(10, start);
      if (idx < 0) {
        if (st.discard) return;
        const rest = chunk.subarray(start);
        if (!rest.length) return;
        if (st.len + rest.length > MAX_LINE + 1) { // +1: room for a CR that ends up before the newline
          st.parts = []; st.len = 0; st.discard = true;
          count('line over 8 KB');
          return;
        }
        st.parts.push(rest); st.len += rest.length;
        return;
      }
      const piece = chunk.subarray(start, idx);
      start = idx + 1;
      if (st.discard) { st.discard = false; continue; }  // the end of an over-long line
      let line = st.len ? Buffer.concat(st.parts.concat([piece]), st.len + piece.length) : piece;
      st.parts = []; st.len = 0;
      if (line.length && line[line.length - 1] === 13) line = line.subarray(0, line.length - 1);
      if (line.length > MAX_LINE) { count('line over 8 KB'); continue; }
      try { handleLine(line, st, sock); } catch (e) { bug('a message', e); }
    }
  }

  function onConnection(sock) {
    try {
      if (stopped || sockets.size >= MAX_CLIENTS) {
        if (!stopped) count('too many clients');
        try { sock.destroy(); } catch (_) { /* gone */ }
        return;
      }
      const st = { parts: [], len: 0, discard: false, hwnds: new Set(), seen: new Set(), sock };
      sock.__th = st;
      sockets.add(st);
      sock.on('data', (chunk) => { try { feed(st, sock, Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8')); } catch (e) { bug('the pipe reader', e); } });
      sock.on('error', () => { /* a client vanishing is normal; close follows */ });
      sock.on('close', () => {
        try {
          if (!sockets.delete(st)) return;
          for (const hw of st.hwnds) { const h = hints.get(hw); if (h && h.sock === st) drop(hw, 'the app disconnected'); }
          for (const hw of st.seen) {
            const sq = seqs.get(hw); if (sq && sq.sock === st) seqs.delete(hw);
            for (const a of APPS) { const c = checks.get(a + '|' + hw); if (c && (c.state !== 'pending' || (c.latest && c.latest.sock === sock))) checks.delete(a + '|' + hw); }
          }
          st.parts = []; st.len = 0;
        } catch (e) { bug('a disconnect', e); }
      });
    } catch (e) { bug('a new connection', e); }
  }

  /* ---- listening ----------------------------------------------------------------------------------- */
  function listenOnce() {
    return new Promise((resolve) => {
      let srv, settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };
      try { srv = net.createServer(onConnection); } catch (e) { done({ ok: false, reason: `the pipe server could not be made (${words(e)})` }); return; }
      srv.on('error', (e) => {
        const why = e && e.code === 'EADDRINUSE'
          ? `another program (most likely another Mantle) is already listening on ${pipe}, so this Mantle cannot take the top-row hints; trying again every ${retryMs / 1000} s`
          : `the pipe ${pipe} could not listen (${e && e.code ? e.code + ': ' : ''}${words(e)}); trying again every ${retryMs / 1000} s`;
        if (!settled) { try { srv.close(); } catch (_) { /* not open */ } done({ ok: false, reason: why }); return; }
        // it broke after it was listening
        if (server === srv) { server = null; listening = false; reason = why; say(`the pipe stopped listening: ${why}`); try { srv.close(); } catch (_) { /* gone */ } scheduleRetry(); }
      });
      try { srv.listen(pipe, () => { server = srv; done({ ok: true, reason: null }); }); } catch (e) { done({ ok: false, reason: `the pipe ${pipe} could not listen (${words(e)})` }); }
    });
  }
  function scheduleRetry() {
    if (stopped || retryT) return;
    retryT = setTimeout(async () => {
      retryT = null;
      if (stopped || listening) return;
      const r = await listenOnce();
      if (stopped) { if (r.ok && server) { try { server.close(); } catch (_) { /* gone */ } server = null; } return; }
      if (r.ok) { listening = true; reason = null; say(`listening on ${pipe} (it was busy before)`); }
      else { reason = r.reason; scheduleRetry(); }
    }, retryMs);
    if (retryT.unref) retryT.unref();
  }

  async function start() {
    if (startP) return startP;
    stopped = false;
    startP = (async () => {
      const r = await listenOnce();
      if (stopped) { if (r.ok && server) { try { server.close(); } catch (_) { /* gone */ } server = null; } return { ok: false, reason: 'stopped' }; }
      if (r.ok) { listening = true; reason = null; say(`listening on ${pipe}`); return { ok: true, reason: null }; }
      listening = false; reason = r.reason; say(r.reason); scheduleRetry();
      return { ok: false, reason: r.reason };
    })();
    return startP;
  }

  function stop() {
    stopped = true;
    if (retryT) { clearTimeout(retryT); retryT = null; }
    for (const hw of Array.from(hints.keys())) drop(hw, 'Mantle stopped listening');
    for (const st of Array.from(sockets)) { try { st.sock.destroy(); } catch (_) { /* gone */ } }
    sockets.clear(); seqs.clear(); checks.clear();
    if (server) { try { server.close(); } catch (_) { /* gone */ } server = null; }
    listening = false; reason = 'stopped'; startP = null;
  }

  function view() {
    const hc = { quartz: 0, helm: 0 };
    for (const h of hints.values()) hc[h.app]++;
    return {
      listening, reason, pipe, clients: sockets.size, hints: hc,
      ignored: Object.assign({}, ignored),
      apps: { quartz: Object.assign({}, apps.quartz), helm: Object.assign({}, apps.helm) },
    };
  }

  /** The parent forgets a window (destroyed, say). Does NOT call forward: the parent asked. */
  function forget(hwnd) {
    const k = String(hwnd);
    hints.delete(k);
    for (const a of APPS) checks.delete(a + '|' + k);
  }

  /** Capture disagreed with the hint (> 6 levels for > 3 frames). Logged once per app per reason. */
  function mismatch(app, hwnd, why) {
    if (!apps[app]) return;
    const w = String(why || 'capture disagreed with the hint');
    if (apps[app].mismatch !== w) { apps[app].mismatch = w; apps[app].since = now(); }
    const k = app + '|' + w;
    if (!mismatchLogged.has(k)) { mismatchLogged.add(k); say(`${app}'s hint for window ${hwnd} disagreed with the capture, so the capture wins: ${w} (logged once)`); }
  }
  function confirmed(app) { if (apps[app]) { apps[app].mismatch = null; apps[app].since = null; } }

  function resendAll() { for (const [hw, h] of Array.from(hints.entries())) fwd(hw, h.app, h.top, h.meta); }

  return { start, stop, view, forget, mismatch, confirmed, resendAll };
}

/* ======================================================================================================
 * washRow: the look-sync desktop still as Quartz and Helm draw it behind their glass (CONTRACT.md, "The user's
 * render decision": cover-fit, centred, on the monitor, lined up with the screen; blurred with a gaussian of
 * glass.dark.blurPx CSS px, i.e. sigma = blurPx * dpr physical px; the same gaussian with mirrored edges
 * as ui/shared/glass-adapt.js glassPixels, which lib/look-guard.js uses for desktop.guard), sampled along
 * ONE physical screen row and averaged into n columns over the strip's width.
 *
 * pixels  {w, h, data RGBA} -- the still, or a crop of it (then mapping.full/crop say where it sits)
 * mapping {display: {x, y, w, h} physical px of the monitor the still covers,
 *          strip: {x, y, w} physical px: y = the row to sample (the first row under the top bar),
 *          dpr: physical px per DIP (default 1),
 *          full?: {w, h} the whole still's size in `pixels` units (default pixels.w/h),
 *          crop?: {x, y} where `pixels` starts inside the whole still, same units (default 0, 0)}
 * n       columns out; blurPx the glass blur in DIP (CSS px).
 * -> Uint8Array(n*3) [r,g,b, ...] left to right.
 * ==================================================================================================== */
function mirror(p, len) { if (len === 1) return 0; const per = 2 * (len - 1); p = ((p % per) + per) % per; return p < len ? p : per - p; }

function washRow(pixels, mapping, n, blurPx) {
  n = Math.max(1, Math.floor(n) || 1);
  const out = new Uint8Array(n * 3);
  const W = pixels.w, H = pixels.h, D = pixels.data;
  if (!(W > 0 && H > 0) || !D || D.length < W * H * 4) return out;
  const d = mapping.display, st = mapping.strip;
  const dpr = mapping.dpr > 0 ? mapping.dpr : 1;
  const full = mapping.full || { w: W, h: H };
  const cr = mapping.crop || { x: 0, y: 0 };
  const s = Math.max(d.w / full.w, d.h / full.h);               // physical px per still px (cover)
  const ox = (full.w * s - d.w) / 2, oy = (full.h * s - d.h) / 2; // centred
  const sig = Math.max(0, blurPx || 0) * dpr / s;                 // sigma in still px
  // the row's centre in `pixels` index space (pixel centres at i + 0.5)
  const vy = (st.y + 0.5 - d.y + oy) / s - 0.5 - cr.y;

  // vertical weights around vy
  const rows = [], rw = [];
  if (sig > 0.3) {
    const rad = Math.ceil(3 * sig);
    const c0 = Math.round(vy);
    let sum = 0;
    for (let j = c0 - rad; j <= c0 + rad; j++) { const w = Math.exp(-((j - vy) * (j - vy)) / (2 * sig * sig)); rows.push(mirror(j, H)); rw.push(w); sum += w; }
    for (let k = 0; k < rw.length; k++) rw[k] /= sum;
  } else {
    const y = Math.min(H - 1, Math.max(0, vy));
    const j0 = Math.floor(y), f = y - j0;
    rows.push(j0); rw.push(1 - f);
    if (f > 0 && j0 + 1 < H) { rows.push(j0 + 1); rw.push(f); }
  }
  // the strip's span in index-edge space
  const ua = (st.x - d.x + ox) / s - cr.x, ub = (st.x + st.w - d.x + ox) / s - cr.x;
  const hrad = sig > 0.3 ? Math.ceil(3 * sig) : 0;
  const xa = Math.max(0, Math.floor(Math.min(ua, ub)) - 1), xb = Math.min(W - 1, Math.ceil(Math.max(ua, ub)) + 1);
  const ra = xa - hrad, rb = xb + hrad;                          // R needed over [ra, rb] (mirrored)
  const RL = rb - ra + 1;
  const R = new Float32Array(RL * 3);
  for (let i = 0; i < RL; i++) {
    const x = mirror(ra + i, W);
    let r = 0, g = 0, b = 0;
    for (let k = 0; k < rows.length; k++) {
      const p = (rows[k] * W + x) * 4, w = rw[k];
      const al = D[p + 3] / 255;                                  // a transparent pixel counts as white, like glass-adapt
      r += w * (D[p] * al + 255 * (1 - al)); g += w * (D[p + 1] * al + 255 * (1 - al)); b += w * (D[p + 2] * al + 255 * (1 - al));
    }
    R[i * 3] = r; R[i * 3 + 1] = g; R[i * 3 + 2] = b;
  }
  // horizontal gaussian over [xa, xb]
  const BL = xb - xa + 1;
  const B = new Float32Array(BL * 3);
  if (hrad > 0) {
    const ker = []; let sum = 0;
    for (let k = -hrad; k <= hrad; k++) { const v = Math.exp(-(k * k) / (2 * sig * sig)); ker.push(v); sum += v; }
    for (let k = 0; k < ker.length; k++) ker[k] /= sum;
    for (let x = xa; x <= xb; x++) {
      let r = 0, g = 0, b = 0;
      for (let k = -hrad; k <= hrad; k++) {
        // R[i] already holds column mirror(ra + i), so the picture's edges are mirrored here too
        const qi = x + k - ra;
        const w = ker[k + hrad];
        r += w * R[qi * 3]; g += w * R[qi * 3 + 1]; b += w * R[qi * 3 + 2];
      }
      const o2 = (x - xa) * 3; B[o2] = r; B[o2 + 1] = g; B[o2 + 2] = b;
    }
  } else {
    for (let x = xa; x <= xb; x++) { const q = (x - ra) * 3, o2 = (x - xa) * 3; B[o2] = R[q]; B[o2 + 1] = R[q + 1]; B[o2 + 2] = R[q + 2]; }
  }
  // average n columns: each column's span, pixels taken as constant over [x, x+1), area-weighted
  for (let i = 0; i < n; i++) {
    let a = ua + (ub - ua) * i / n, b = ua + (ub - ua) * (i + 1) / n;
    if (a > b) { const t = a; a = b; b = t; }
    let r = 0, g = 0, bl = 0, wsum = 0;
    if (b - a < 1e-9) {
      const x = Math.min(xb, Math.max(xa, Math.floor(a))) - xa;
      r = B[x * 3]; g = B[x * 3 + 1]; bl = B[x * 3 + 2]; wsum = 1;
    } else {
      for (let x = Math.floor(a); x < Math.ceil(b); x++) {
        const w = Math.min(b, x + 1) - Math.max(a, x);
        if (w <= 0) continue;
        const xi = Math.min(xb, Math.max(xa, x)) - xa;
        r += w * B[xi * 3]; g += w * B[xi * 3 + 1]; bl += w * B[xi * 3 + 2]; wsum += w;
      }
    }
    const k3 = i * 3;
    out[k3] = Math.max(0, Math.min(255, Math.round(r / wsum)));
    out[k3 + 1] = Math.max(0, Math.min(255, Math.round(g / wsum)));
    out[k3 + 2] = Math.max(0, Math.min(255, Math.round(bl / wsum)));
  }
  return out;
}

/** Pure: which part of the still washRowFor decodes, and how small. iw x ih still px. -> plan or null. */
function washPlan(iw, ih, display, strip, blurPx, dpr) {
  if (!(iw > 0 && ih > 0 && display && display.w > 0 && display.h > 0 && strip && strip.w > 0)) return null;
  const sc = dpr > 0 ? dpr : 1;
  const s = Math.max(display.w / iw, display.h / ih);
  const ox = (iw * s - display.w) / 2, oy = (ih * s - display.h) / 2;
  const sig = Math.max(0, blurPx || 0) * sc / s;                 // still px
  let f = Math.min(1, s);                                         // never finer than the screen's pixels
  if (sig * f > 8) f = 8 / sig;                                   // a big blur works on a smaller picture (cost), sigma 8 px
  const m = Math.ceil(3 * sig) + 2;
  const vy = (strip.y + 0.5 - display.y + oy) / s - 0.5;
  const ua = (strip.x - display.x + ox) / s, ub = (strip.x + strip.w - display.x + ox) / s;
  const x0 = Math.max(0, Math.floor(ua - m)), x1 = Math.min(iw, Math.ceil(ub + m));
  const y0 = Math.max(0, Math.floor(vy - m)), y1 = Math.min(ih, Math.ceil(vy + m) + 1);
  if (!(x1 > x0 && y1 > y0)) return null;
  return { src: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, out: { w: Math.max(1, Math.round((x1 - x0) * f)), h: Math.max(1, Math.round((y1 - y0) * f)) }, f };
}

let stillCache = { file: null, img: null };
/**
 * Loads the still (cached: one decoded still, by path; stills are named by rev so a new one is a new
 * path), cuts the band around the row, scales it down, and runs washRow. Electron main process only.
 * a = {stillPath, display: {x,y,w,h} physical, strip: {x,y,w} physical (y = the row), n, blurPx, dpr}
 */
async function washRowFor(a) {
  try {
    a = a || {};
    if (!a.stillPath || typeof a.stillPath !== 'string') return { ok: false, reason: 'there is no still to sample' };
    const n = Math.floor(a.n);
    if (!(n >= 1 && n <= 4096)) return { ok: false, reason: 'the column count is not usable' };
    if (!(typeof a.blurPx === 'number' && a.blurPx >= 0 && a.blurPx <= 200)) return { ok: false, reason: 'the glass blur is not usable' };
    const { nativeImage } = require('electron');
    let img = stillCache.file === a.stillPath ? stillCache.img : null;
    if (!img) {
      img = nativeImage.createFromPath(a.stillPath);
      if (!img || img.isEmpty()) return { ok: false, reason: `the still ${path.basename(a.stillPath)} could not be read` };
      stillCache = { file: a.stillPath, img };
    }
    const sz = img.getSize();
    const plan = washPlan(sz.width, sz.height, a.display, a.strip, a.blurPx, a.dpr);
    if (!plan) return { ok: false, reason: 'the strip does not fall on the still' };
    let band = img.crop(plan.src);
    if (plan.out.w !== plan.src.width || plan.out.h !== plan.src.height) band = band.resize({ width: plan.out.w, height: plan.out.h, quality: 'best' });
    const bs = band.getSize();
    const bmp = band.toBitmap();
    if (!bmp || bmp.length < bs.width * bs.height * 4) return { ok: false, reason: 'the still\'s band could not be read as pixels' };
    const data = new Uint8ClampedArray(bs.width * bs.height * 4);
    for (let i = 0; i < data.length; i += 4) { data[i] = bmp[i + 2]; data[i + 1] = bmp[i + 1]; data[i + 2] = bmp[i]; data[i + 3] = bmp[i + 3]; } // BGRA -> RGBA
    const fx = bs.width / plan.src.width, fy = bs.height / plan.src.height;
    const cols = washRow({ w: bs.width, h: bs.height, data }, {
      display: a.display, strip: a.strip, dpr: a.dpr,
      full: { w: sz.width * fx, h: sz.height * fy }, crop: { x: plan.src.x * fx, y: plan.src.y * fy },
    }, n, a.blurPx);
    return { ok: true, cols };
  } catch (e) {
    return { ok: false, reason: `the still could not be sampled (${words(e)})` };
  }
}

module.exports = {
  makeHints, washRow, washRowFor, washPlan, normaliseTop, checkMessage, appOwns, resampleCols, pipePath,
  DEFAULT_PIPE, MAX_LINE, MAX_COLS_IN, MAX_COLS_OUT, RECHECK_MS, RETRY_LISTEN_MS,
};
