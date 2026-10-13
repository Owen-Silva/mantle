'use strict';
/*
 * lib/raise.js -- A MANTLE POP-UP IS ON TOP OF EVERYTHING, EVERY TIME IT SHOWS (lane r7-ontop, 2026-10-01).
 *
 * WHY. Owen: "the volume thing is now getting hidden to for sme reason ... all that type of stuff should
 * always be opened on top of everything". A read-only watch of his desktop (lane r7-mixer) found the
 * volume pop-up shown, visible, not cloaked, still WS_EX_TOPMOST -- and at z 22, under the bar and three
 * maximised, non-topmost app windows. Windows had let it sink while it was hidden, and Electron's
 * showInactive()/show() never change the z-order, so it came back exactly there: shown, and covered.
 * alwaysOnTop is a flag set once at creation; it is not a promise of being in front at the next show.
 *
 * WHAT. raise(win, level): on EVERY show (and every update of a pop-up already up) put the window at the
 * very top again -- setAlwaysOnTop(true, level), which is SetWindowPos(HWND_TOPMOST), then moveTop(),
 * which is SetWindowPos(HWND_TOP) inside the topmost band. Both in-process, both SWP_NOACTIVATE: a
 * pop-up meant to stay inactive does not take the keyboard. The pattern the bar's reveal, the switcher,
 * snap, task view and the screenshot overlay already used; this is the one copy of it.
 * check(win, ...): a moment later, ASK Windows whether it worked -- the window visible, not cloaked, and
 * what a click at its centre would hit (WindowFromPoint), or, for a click-through pop-up that a click
 * goes straight through, the first visible window above it in the z-order that covers its centre.
 * Covered: raised once more and asked again. Still covered: ONE plain log line with the reason (never a
 * title or an app name). Nothing fails silently; nothing logs when all is well.
 *
 * MEASURED (lib/raise.test.js --electron, real windows): a pop-up sunk under a maximised window stays
 * covered after showInactive() alone, and is what WindowFromPoint hits after raise().
 *
 * Callers raise only in a live run: a --test instance never puts a window in front of Owen.
 * The desktop layer (main.js desktopWin) is NEVER raised: it is the thing everything sits in front of.
 */

const DEFAULT_LEVEL = 'screen-saver';
const CHECK_MS = 60;           // the check runs this long after the show: the window is placed and drawn
const WS_EX_TRANSPARENT = 0x20;
const WS_EX_LAYERED = 0x80000;
const GWL_EXSTYLE = -20;
const GA_ROOT = 2;
const GW_HWNDPREV = 3;
const DWMWA_CLOAKED = 14;
const WALK_MAX = 2048;         // z-order steps before the walk gives up (a desktop has a few hundred windows)

function words(err) { return String((err && err.message) || err || 'no reason given').split('\n')[0]; }

/** Put the window at the very top. -> null, or the reason it could not be (in plain words). */
function raise(win, level) {
  if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return 'the window is gone';
  try {
    win.setAlwaysOnTop(true, level || DEFAULT_LEVEL);
    win.moveTop();
    return null;
  } catch (err) {
    return `Windows would not put it on top (${words(err)})`;
  }
}

/* ---- the read side: user32 through koffi, bound once (as lib/switcher.js and screenshot.js do).
 * Buffers, not koffi structs: struct names are process-global in koffi and lib/thumbs.js owns its own. */
let nat;
let natReason = null;
function native() {
  if (nat !== undefined) return nat;
  nat = null;
  if (process.platform !== 'win32') { natReason = 'this is not Windows'; return null; }
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const n = {
      isWindow: user32.func('int __stdcall IsWindow(intptr_t hwnd)'),
      isVisible: user32.func('int __stdcall IsWindowVisible(intptr_t hwnd)'),
      getRect: user32.func('int __stdcall GetWindowRect(intptr_t hwnd, void *rect)'),
      rgnBox: user32.func('int __stdcall GetWindowRgnBox(intptr_t hwnd, void *rect)'),
      // POINT by value is one 64-bit register on x64: (y << 32) | (x & 0xFFFFFFFF).
      fromPoint: user32.func('intptr_t __stdcall WindowFromPoint(int64 pt)'),
      ancestor: user32.func('intptr_t __stdcall GetAncestor(intptr_t hwnd, uint32 flags)'),
      exStyle: user32.func('intptr_t __stdcall GetWindowLongPtrW(intptr_t hwnd, int index)'),
      prev: user32.func('intptr_t __stdcall GetWindow(intptr_t hwnd, uint32 cmd)'),
      pidOf: user32.func('uint32 __stdcall GetWindowThreadProcessId(intptr_t hwnd, void *pid)'),
      fg: user32.func('intptr_t __stdcall GetForegroundWindow()'),
      // lib/popwatch.js's fallback (lane mn-pop): the mouse buttons and Esc, when the sidecar cannot watch
      asyncKey: user32.func('int16 __stdcall GetAsyncKeyState(int vk)'),
      dwmAttr: null,
    };
    try {
      const dwm = koffi.load('dwmapi.dll');
      n.dwmAttr = dwm.func('int32 __stdcall DwmGetWindowAttribute(intptr_t hwnd, uint32 attr, void *out, uint32 size)');
    } catch (_) { n.dwmAttr = null; /* cloaking unreadable: judged as not cloaked */ }
    nat = n;
  } catch (err) {
    natReason = `Windows' window functions could not be loaded (${words(err)})`;
  }
  return nat;
}

function hwndOf(win) {
  const b = win.getNativeWindowHandle();
  return b.length >= 8 ? Number(b.readBigUInt64LE(0)) : b.readUInt32LE(0);
}

function rectOf(n, h) {
  const buf = Buffer.alloc(16);
  if (!n.getRect(h, buf)) return null;
  return { l: buf.readInt32LE(0), t: buf.readInt32LE(4), r: buf.readInt32LE(8), b: buf.readInt32LE(12) };
}

function cloaked(n, h) {
  if (!n.dwmAttr) return false;
  const buf = Buffer.alloc(4);
  try { return n.dwmAttr(h, DWMWA_CLOAKED, buf, 4) === 0 && buf.readUInt32LE(0) !== 0; } catch (_) { return false; }
}

// A shaped window (the bar reaches far past its pill, with a region) only covers inside its region.
function covers(n, h, pt) {
  const r = rectOf(n, h);
  if (!r || r.r <= r.l || r.b <= r.t) return false;
  if (pt.x < r.l || pt.x >= r.r || pt.y < r.t || pt.y >= r.b) return false;
  const box = Buffer.alloc(16);
  const kind = n.rgnBox(h, box);
  if (kind === 2 || kind === 3) {   // SIMPLEREGION, COMPLEXREGION: the box is in window coordinates
    const x = pt.x - r.l, y = pt.y - r.t;
    if (x < box.readInt32LE(0) || x >= box.readInt32LE(8) || y < box.readInt32LE(4) || y >= box.readInt32LE(12)) return false;
  }
  return true;
}

function whose(n, h) {
  const buf = Buffer.alloc(4);
  try { n.pidOf(h, buf); } catch (_) { return 'another window'; }
  const pid = buf.readUInt32LE(0);
  return pid === process.pid ? 'another Mantle window' : `another app's window (pid ${pid})`;
}

/**
 * Is the window really in front, where a person looks? -> { onTop: true|false|null, why }.
 * null = it could not be checked (said why), never counted as on top.
 * opts.seeThrough: the window is transparent:true (Task View, the screenshot overlay), see below.
 */
function judge(win, opts) {
  const o = opts || {};
  if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return { onTop: false, why: 'the window is gone' };
  if (typeof win.getNativeWindowHandle !== 'function') return { onTop: null, why: 'not a real window' };
  const n = native();
  if (!n) return { onTop: null, why: natReason || 'the check could not run' };
  try {
    const h = hwndOf(win);
    if (!h || !n.isWindow(h)) return { onTop: false, why: 'the window no longer exists' };
    if (!n.isVisible(h)) return { onTop: false, why: 'Windows did not show it' };
    if (cloaked(n, h)) return { onTop: false, why: 'Windows is hiding it (cloaked)' };
    const r = rectOf(n, h);
    if (!r || r.r <= r.l || r.b <= r.t) return { onTop: null, why: 'its size could not be read' };
    const pt = { x: Math.floor((r.l + r.r) / 2), y: Math.floor((r.t + r.b) / 2) };
    const ex = Number(n.exStyle(h, GWL_EXSTYLE));
    if (!(ex & WS_EX_TRANSPARENT)) {
      // It takes clicks: what a click at its centre would hit IS the answer...
      const hit = Number(n.fromPoint((BigInt(pt.y) << 32n) | BigInt(pt.x >>> 0)));
      const root = hit ? Number(n.ancestor(hit, GA_ROOT)) || hit : 0;
      if (root === h) return { onTop: true, why: 'on top' };
      // ...except for a SEE-THROUGH window (transparent: true, or layered): where its pixels are clear
      // a click goes on to the window behind, so WindowFromPoint can name that window with nothing in
      // front (lane mn-raise, 2026-10-12: a source of Task View's "shown but NOT on top" lines). For
      // those the z-order above it decides, as for a toast.
      if (!(o.seeThrough || (ex & WS_EX_LAYERED))) {
        if (!root) return { onTop: false, why: 'nothing answers a click at its centre' };
        return { onTop: false, why: `${whose(n, root)} is in front of it at its centre` };
      }
    }
    // Click-through (a toast) or see-through: walk up the z-order instead.
    const above = coveredBy(n, h, pt);
    return above ? { onTop: false, why: `${whose(n, above)} is in front of it at its centre` } : { onTop: true, why: 'on top' };
  } catch (err) {
    return { onTop: null, why: `the check failed (${words(err)})` };
  }
}

/** The first visible window above `h` in the z-order that covers `pt` (click-through ones skipped), or 0. */
function coveredBy(n, h, pt) {
  let w = Number(n.prev(h, GW_HWNDPREV));
  for (let i = 0; w && i < WALK_MAX; i++, w = Number(n.prev(w, GW_HWNDPREV))) {
    if (!n.isVisible(w) || cloaked(n, w)) continue;
    if (Number(n.exStyle(w, GWL_EXSTYLE)) & WS_EX_TRANSPARENT) continue;   // see-through to clicks: a toast like ours
    if (covers(n, w, pt)) return w;
  }
  return 0;
}

/**
 * Who has the keyboard right now: { hwnd, mine, pid, rect } for the foreground window's root window,
 * { hwnd: 0 } when nothing has it, null when it cannot be read. Never a title or a name.
 */
function foreground() {
  const n = native();
  if (!n) return null;
  try {
    const f = Number(n.fg());
    if (!f) return { hwnd: 0, mine: false, pid: 0, rect: null };
    const h = Number(n.ancestor(f, GA_ROOT)) || f;
    const buf = Buffer.alloc(4);
    n.pidOf(h, buf);
    const pid = buf.readUInt32LE(0);
    return { hwnd: h, mine: pid === process.pid, pid, rect: rectOf(n, h) };
  } catch (_) { return null; }
}

/** Is `win` the foreground window, by Windows' own answer? true / false; null = it cannot be read. */
function hasKeyboard(win) {
  if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return false;
  if (typeof win.getNativeWindowHandle !== 'function') return null;
  const f = foreground();
  if (!f) return null;
  try { return f.hwnd !== 0 && f.hwnd === hwndOf(win); } catch (_) { return null; }
}

/**
 * GIVE A MANTLE WINDOW THE KEYBOARD the way the focus lane does (lane mn-raise, 2026-10-12).
 * Electron's focus() is a plain SetForegroundWindow, which Windows refuses a process that did not get
 * the last input: a hot corner gives Mantle no input at all, and a chord the sidecar's hook ate never
 * reached this process. So:
 *   1. this process holds the foreground already (the bar or a pop-up had the keyboard): focus()
 *      in-process, which Windows allows;
 *   2. otherwise hand whatever foreground right this process has to the sidecar (lib/fg-grant.js;
 *      harmless when it has none) and let the sidecar's ladder (sidecar/Windows.cs FocusLadder:
 *      direct, attach, the Alt nudge, switch) take it. Its report names the rung that won.
 * Call it BEFORE the window comes on screen (it may be parked off screen), so it is in front with the
 * keyboard the moment it is seen, instead of seen first and losing the keyboard after.
 * o: { sidecar, sidecarPid, hwnd, timeoutMs, grant (tests), holds (tests: () -> bool) }.
 * -> Promise<{ ok, how, words }>, never rejects. `words` is plain, for the log: no names, no titles.
 */
async function keyboard(win, o) {
  const opt = o || {};
  const gone = () => !win || (typeof win.isDestroyed === 'function' && win.isDestroyed());
  if (gone()) return { ok: false, how: null, words: 'the window is gone' };
  const fgGrant = require('./fg-grant');
  const holds = typeof opt.holds === 'function' ? opt.holds : () => { const k = hasKeyboard(win); return k === null ? !!win.isFocused() : k; };
  if (holds()) return { ok: true, how: 'already', words: 'it already had the keyboard' };
  const f = typeof opt.foreground === 'function' ? opt.foreground() : foreground();
  if (f && f.mine) {
    try { win.focus(); } catch (_) { /* the ladder below */ }
    if (holds()) return { ok: true, how: 'in-process', words: 'Mantle held the foreground, so it moved the keyboard in-process' };
  }
  if (!opt.sidecar || typeof opt.sidecar.send !== 'function') return { ok: false, how: null, words: 'there is no sidecar to take the keyboard with' };
  // The right is only handed on when the caller knows the sidecar's pid (features pass
  // ctx.sidecar.pid, lib/features.js; null while it is down): with none there is nothing to log.
  const g = opt.sidecarPid ? (typeof opt.grant === 'function' ? opt.grant : fgGrant.grant)(opt.sidecarPid) : null;
  const right = g ? `; right ${fgGrant.words(g)}` : '';
  let r;
  try { r = await opt.sidecar.send('focus', { hwnd: String(opt.hwnd) }, { timeoutMs: opt.timeoutMs || 1500 }); } catch (err) { r = { ok: false, error: words(err) }; }
  if (gone()) return { ok: false, how: null, words: 'the window is gone' };
  if (r && r.ok) {
    if (holds()) return { ok: true, how: (r.result && r.result.how) || 'ladder', words: `the sidecar's ladder: ${fgGrant.howWords(r.result)}${right}` };
    return { ok: false, how: null, words: `the sidecar's ladder said ${fgGrant.howWords(r.result)}, but another window has the keyboard${right}` };
  }
  const e = fgGrant.splitTried(r && r.error);
  return { ok: false, how: null, words: `${e.shown || 'the sidecar did not answer'}${e.tried ? ` (${e.tried})` : ''}${right}` };
}

const saidOnce = new Set();
/**
 * A moment after a show: judged; covered -> raised once more and judged again; still not on top ->
 * one log line. -> Promise<{ onTop, why }>. `what` names the pop-up in the line ("the clipboard panel");
 * `wanted()` says whether it should still be up (closed meanwhile: no check, no line).
 */
function check(win, opts) {
  const o = opts || {};
  const log = typeof o.log === 'function' ? o.log : (line) => process.stdout.write(`mantle: ${line}\n`);
  const what = o.what || 'a pop-up';
  return new Promise((resolve) => {
    const run = () => {
      // Closed again (Esc, a click away, a toast's end) before the check: nothing to judge, nothing to say.
      const gone = !win || (typeof win.isDestroyed === 'function' && win.isDestroyed());
      if (gone || (typeof o.wanted === 'function' && !o.wanted())) { resolve({ onTop: null, why: 'closed again before it could be checked' }); return; }
      const judgeOf = typeof o.judge === 'function' ? o.judge : judge;   // a test may stand in for Windows
      let j = judgeOf(win, o);
      if (j.onTop === false) {
        const err = raise(win, o.level);
        const again = judgeOf(win, o);
        j = again.onTop ? { onTop: true, why: 'on top after a second raise' } : (err ? { onTop: false, why: `${again.why}; ${err}` } : again);
      }
      if (j.onTop === false) log(`${what}: shown but NOT on top: ${j.why}`);
      else if (j.onTop === null && j.why !== 'not a real window' && !saidOnce.has(j.why)) {
        saidOnce.add(j.why);   // once per reason: the same "could not check" on every show is noise
        log(`${what}: shown, but whether it is on top could not be checked: ${j.why}`);
      }
      resolve(j);
    };
    const t = setTimeout(run, o.delayMs === undefined ? CHECK_MS : o.delayMs);
    if (t && t.unref) t.unref();
  });
}

/** raise() now, check() a moment later. A raise that throws is logged at once. -> the check's promise. */
function up(win, opts) {
  const o = opts || {};
  const err = raise(win, o.level);
  if (err) {
    const log = typeof o.log === 'function' ? o.log : (line) => process.stdout.write(`mantle: ${line}\n`);
    log(`${o.what || 'a pop-up'}: could not be put on top: ${err}`);
  }
  return check(win, o);
}

/** GetAsyncKeyState for each named virtual key ({name: vk}) -> {name: its 16 bits}, or null when
    user32 could not be bound. A binding only: lib/popwatch.js decides what a press is. */
function keyStates(vks) {
  const n = native();
  if (!n || !n.asyncKey) return null;
  const out = {};
  for (const k of Object.keys(vks || {})) {
    try { out[k] = n.asyncKey(vks[k]) & 0xFFFF; } catch (_) { return null; }
  }
  return out;
}

module.exports = { raise, judge, check, up, foreground, hasKeyboard, keyboard, keyStates, DEFAULT_LEVEL, _native: native };
