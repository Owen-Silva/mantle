'use strict';
/*
 * screenshot.js - Win+Shift+S and PrintScreen: Mantle's own Snipping Tool overlay (wave 3, 2026-09-24).
 *
 * THE ROUTE, and what it cost, measured on Owen's machine (one 1920x1080 panel at 125%, 2026-09-24):
 *   chord -> sidecar `shot.grab` (sidecar/Screenshot.cs): ONE BitBlt of the whole virtual screen, so
 *            every monitor is frozen at the same instant, and each monitor's part written to
 *            %TEMP%\mantle-shot as a BMP (the DIB's own bytes: no encode). 32 ms median (BitBlt 26,
 *            BMP write 6). The existing `backdrop` command at full resolution was the alternative:
 *            a PNG in base64 over stdout, 150-220 ms round trip, so it was not reused as is.
 *        -> one pre-created overlay window PER MONITOR (so each page has one DPI scale and a
 *           mixed-DPI desktop is just several single-DPI pages) gets `screenshot.frame`, decodes
 *           the BMP while still parked off screen (30-46 ms for 1080p in Chromium) and says ready;
 *        -> the windows are moved onto their monitors with SetWindowPos at the monitor's exact
 *           PHYSICAL rect, and the one under the pointer takes the keyboard.
 *        -> VERIFIED, not assumed (2026-09-24: capture #1 of the first live day logged "on screen
 *           105 ms after the chord", Owen never saw it, and the next 14 presses were swallowed as
 *           "still open"): every 100 ms for up to 800 ms the overlay is MEASURED - visible, not
 *           cloaked, on its monitor's exact rect, the window a click at its centre lands on, the
 *           foreground - and a 3-pixel canary it paints is read back off the screen (GetPixel). Not
 *           all true by 800 ms: the capture is cancelled, Windows' own snip (ms-screenclip:) opens,
 *           and the card says why; two of those in a row and the chords go back to Windows
 *           (health false) until the tray switch is flipped. A second chord never waits behind an
 *           open capture (it is brought forward if verified, else replaced), losing the keyboard
 *           ends a capture, and none lives past 60 s.
 *   selection -> sidecar `shot.save` crops from the SAME frozen frame (not a second grab) and writes
 *            "Screenshot YYYY-MM-DD HHMMSS.png" into the Screenshots known folder (80 ms PNG encode
 *            for a full 1080p screen); main puts that PNG on the clipboard, releases the frame (its
 *            BMPs are deleted), and shows the card bottom right for ~5 s.
 *
 * NO SILENT FAILURES: a grab that fails shows the card with the reason; a save that fails still
 * copies (and the card says "Not saved: <why>"); a clipboard that refuses says "Not copied: <why>";
 * a sidecar without the shot.* commands takes the feature DOWN (health false: the chords go back
 * to Windows and the strip says why).
 *
 * TESTS (--test): windows stay HIDDEN (never in front of Owen, never focused); the clipboard is a
 * sink that records sizes only; saves go to a %TEMP% folder (the passive sidecar refuses anything
 * else anyway). MANTLE_SHOT_TEST (read ONLY in --test) is a JSON list of steps, one per chord, that
 * the feature plays INSIDE the overlay page (synthetic pointer/key events), e.g.
 *   [{"synthetic":true,"drag":[100,80,500,300]},{"synthetic":true,"mode":"window","click":[10,10]},{"key":"Escape"}]
 * and MANTLE_SHOT_TEST_DIR is where its saves go. lib/features/screenshot.test.js --electron uses both.
 * More steps: {"hold":true} leaves the capture open (the stuck case), {"blur":true} fires the
 * window's own 'blur', {"probe":"corner"} runs the REAL reveal (SetWindowPos TOPMOST, full size)
 * with only ONE pixel on the monitor (its top-right corner) and no focus asked for, measures it,
 * and so ends in the real fallback path (Windows' snip is never opened by a test).
 * MANTLE_SHOT_TEST_TIMEOUT_MS shortens the 60 s hard timeout (test only).
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const G = require('../../ui/screenshot/geometry.js');

const FRAME_DIR = path.join(os.tmpdir(), 'mantle-shot');
const READY_TIMEOUT_MS = 2500;     // then the pages that ARE ready go up; none ready = a failure card (the first,
                                   // cold capture of a --test start took 2.2 s to grab, 2026-09-24)
const VERIFY_MS = 800;             // moved on screen -> measured in front AND holding the keyboard, or Windows' snip
const VERIFY_STEP_MS = 100;
const REFOCUS_AT_MS = 300;         // not foreground by now: the sidecar's focus ladder once more
const BLUR_GRACE_MS = 150;         // focus hopping between two monitors' overlays is not a loss
const EARLY_BLUR_MS = 1500;       // the keyboard taken away sooner than this = could not come forward (fallback)
const HARD_TIMEOUT_MS = 60000;     // no capture stays open longer than this, whatever happened
const FALLBACK_URI = 'ms-screenclip:';   // Windows' own Snipping overlay (what Win+Shift+S does without Mantle)
const FALLBACKS_BEFORE_DOWN = 2;   // this many in a row: the chords go back to Windows (health false)
const CARD_LIFE_MS = 5000;
const CARD_BACKSTOP_MS = CARD_LIFE_MS + 25000;
const CARD_MARGIN = 12;            // the card page's own margin around the card (card.css)
const MODES = ['rect', 'window', 'full'];

const HWND_TOPMOST = -1;
const SWP_NOSIZE = 0x0001;
const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;
const SWP_SHOWWINDOW = 0x0040;
const SWP_NOOWNERZORDER = 0x0200;

/* ---- pure helpers (lib/features/screenshot.test.js) ------------------------------------------ */

/** A file:// URL for a Windows path (spaces, #, % and non-ASCII escaped). */
function fileUrl(p) {
  return 'file:///' + String(p).replace(/\\/g, '/').split('/').map((s, i) => (i === 0 && /^[A-Za-z]:$/.test(s) ? s : encodeURIComponent(s))).join('/');
}

/**
 * Where to park a w x h window so it is on NO display but Windows counts it as on `mon` (the
 * nearest monitor sets a window's DPI): above it, else below, left, right. The switcher's rule.
 */
function parkSpot(mon, w, h, displays) {
  const GAP = 64;
  const hit = (x, y) => displays.some((d) => x < d.x + d.w && x + w > d.x && y < d.y + d.h && y + h > d.y);
  const c = [
    { x: mon.x, y: mon.y - h - GAP }, { x: mon.x, y: mon.y + mon.h + GAP },
    { x: mon.x - w - GAP, y: mon.y }, { x: mon.x + mon.w + GAP, y: mon.y },
  ];
  for (const s of c) if (!hit(s.x, s.y)) return s;
  return { x: -32000, y: -32000 };
}

/**
 * The card window's bounds (DIP): bottom-right of the work area, above the bar when the bar
 * overlaps that corner (Mantle's bar is an overlay, so the work area can include it).
 */
function cardSpot(size, work, bar) {
  const w = Math.ceil(size.w + 2 * CARD_MARGIN);
  const h = Math.ceil(size.h + 2 * CARD_MARGIN);
  let bottom = work.y + work.height;
  if (bar && bar.y < bottom && bar.y + bar.height > bottom - h &&
      bar.x < work.x + work.width && bar.x + bar.width > work.x + work.width - w) bottom = bar.y;
  return { x: Math.round(work.x + work.width - w), y: Math.round(bottom - h), width: w, height: h };
}

/** Where saves go: a test folder in --test (must be under %TEMP%), else the setting, else Windows'. */
function saveDirFor(test, testDir, setting, folder, tmp) {
  if (test) {
    const d = testDir || path.join(tmp, 'mantle-shot-test-out');
    const t = path.resolve(tmp).toLowerCase() + path.sep;
    return path.resolve(d).toLowerCase().startsWith(t) ? { dir: path.resolve(d), why: 'test mode' }
      : { dir: null, why: `test mode only saves under ${tmp}, not ${d}` };
  }
  if (setting) return { dir: setting, why: 'the saveDir setting' };
  if (folder && folder.path) return { dir: folder.path, why: folder.source === 'known folder' ? 'Windows\' Screenshots folder' : `Pictures\\Screenshots (${folder.reason || 'no known folder'})` };
  return { dir: null, why: 'the Screenshots folder is not known yet' };
}

/** True when a sidecar error means the exe predates the shot.* commands (a rebuild, not a retry). */
function missingCommand(err) { return /unknown command|not a command|no such command/i.test(String(err || '')); }

/** A session's one-line summary for mantle.log: sizes and timings only, never a pixel or a title. */
function summary(s) {
  const mons = (s.monitors || []).map((m) => `${m.w}x${m.h}@${m.scale}`).join(' + ');
  // "moved on screen", not "on screen": this line is what the code ASKED for. Whether Owen can see
  // it is the separate "verified" / "could not come forward" line, from measured window facts.
  return `#${s.seq} ${s.chord}: froze ${mons || 'nothing'} (${s.windows || 0} windows) - grab ${s.grabMs} ms ` +
    `(BitBlt ${s.bltMs}, BMP ${s.writeMs}), decode ${s.decodeMs} ms, moved on screen ${s.shownMs} ms after the chord (${s.how})`;
}

/**
 * Is an overlay REALLY in front of Owen, judged from measured Win32 facts, never from having asked
 * (2026-09-24: capture #1 logged "on screen 105 ms after the chord" and Owen never saw it; every
 * later press was then swallowed as "still open"). `m` is what measure() read:
 *   { exists, visible, cloaked, rect:{x,y,w,h}, hit, hitCls, fg, fgCls }  (hwnds as strings)
 * `want` = { hwnd, rect, keyboard }: keyboard=true for the overlay that must hold the foreground.
 * Returns { ok, front, keyboard, why }: `front` = visible, uncloaked, on its monitor's exact rect and
 * the window a click at its centre lands on; `ok` = front, plus the keyboard where it is wanted.
 */
function judgeShown(m, want) {
  if (!m || !m.exists) return { ok: false, front: false, keyboard: false, why: 'the overlay window no longer exists' };
  const why = [];
  if (!m.visible) why.push('Windows says the overlay window is not visible');
  if (m.cloaked) why.push(`Windows has cloaked the overlay window (DWM cloak ${m.cloaked})`);
  const r = m.rect;
  const w = want.rect;
  const rectOk = !!r && Math.abs(r.x - w.x) <= 1 && Math.abs(r.y - w.y) <= 1 && Math.abs(r.w - w.w) <= 1 && Math.abs(r.h - w.h) <= 1;
  if (!rectOk) why.push(r ? `it is at ${r.x},${r.y} ${r.w}x${r.h}, not on its monitor (${w.x},${w.y} ${w.w}x${w.h})` : 'its rect could not be read');
  const hitUs = !!m.hit && String(m.hit) === String(want.hwnd);
  if (!hitUs) why.push(m.hit && m.hit !== '0' ? `another window is in front of it at its centre (class ${m.hitCls || '?'})` : 'nothing answers a click at its centre');
  const keyboard = !!m.fg && String(m.fg) === String(want.hwnd);
  if (want.keyboard && !keyboard) why.push(`Windows did not give it the keyboard (the foreground is class ${m.fgCls || '?'})`);
  const front = m.visible && !m.cloaked && rectOk && hitUs;
  return { ok: front && (!want.keyboard || keyboard), front, keyboard, why: why.join('; ') };
}

/** A verified overlay lost the keyboard `ms` after it came up: 'fallback' (something took the
 *  foreground back: Windows' snip opens instead) or 'end' (Owen moved on: the capture just ends). */
function blurVerdict(ms) { return ms < EARLY_BLUR_MS ? 'fallback' : 'end'; }

/**
 * A Win+Shift+S / PrintScreen while capture `s` is still open (NEVER "ignored" again). `now` is the
 * measured judgement of its overlays right now (null when it is not on screen yet). Returns
 * { act: 'raise' | 'restart', why }: 'raise' only for a capture that was verified in front and
 * still is (Windows' own snip does nothing visible on a second press either); anything else is
 * cancelled and a fresh capture starts, which verifies itself or falls back to Windows' snip.
 */
function secondChord(s, now) {
  if (!s.shown) return { act: 'restart', why: `capture #${s.seq} had not come on screen yet (${Date.now() - s.t0} ms)` };
  if (s.verified && now && now.ok) return { act: 'raise', why: `capture #${s.seq} is open and verified in front` };
  const w = now ? now.why : 'it could not be measured';
  return { act: 'restart', why: `capture #${s.seq} was open but not in front (${s.verified ? 'verified earlier, now: ' : ''}${w || 'unknown'})` };
}

/* ---- the feature --------------------------------------------------------------------------------- */

module.exports = {
  name: 'screenshot',
  label: 'Screenshots (Win+Shift+S, PrintScreen)',
  defaultOn: true,
  rest: true,                         // its window(s) close while a game runs (lib/features.js restAll)
  chords: ['Win+Shift+S', 'PrintScreen'],
  observe: [],
  _test: { fileUrl, parkSpot, cardSpot, saveDirFor, missingCommand, summary, judgeShown, secondChord, blurVerdict, FRAME_DIR, EARLY_BLUR_MS, VERIFY_MS, HARD_TIMEOUT_MS, FALLBACK_URI },

  install(ctx) {
    const { BrowserWindow, screen, clipboard, nativeImage, shell } = require('electron');
    const test = !!ctx.flags.test;
    const overlays = new Map();        // display id -> { win, hwnd, loaded, displayId, park }
    let card = null;                   // { win, hwnd, loaded, shown, info, backstop }
    let sess = null;
    let seqN = 0;
    let stopped = false;
    let folder = null;
    let problem = null;                // why the feature is down, or null
    let downWhy = null;                // down because the overlay could not come forward FALLBACKS_BEFORE_DOWN times in a row
    let fallbacksInARow = 0;
    let rebuildTimer = null;
    let steps = [];
    let testDir = null;
    const sink = { image: null, text: null };   // --test: what WOULD have gone on the clipboard

    /* THE CLIPBOARD WRITE (fixed 2026-09-24 after Owen's first live captures logged "NOT copied
       (clipboard.writeImage is not a function)"). Electron 44 dropped the synchronous writeImage;
       its clipboard is now the W3C-style async write([ClipboardItem]) with an 'image/png' Blob.
       The test sink hid it: --test never calls the real clipboard, so clipboardImageApi() is what
       a test can check instead ("which call WOULD run here, and does it exist?"). */
    function clipboardImageApi() {
      if (typeof clipboard.writeImage === 'function') return 'writeImage';
      if (typeof clipboard.write === 'function' && typeof require('electron').ClipboardItem === 'function' && typeof Blob === 'function') return 'write';
      return null;
    }
    async function writeClipboardPng(img) {
      const api = clipboardImageApi();
      if (api === 'writeImage') { clipboard.writeImage(img); return; }
      if (api !== 'write') throw new Error('this Electron has neither clipboard.writeImage nor clipboard.write with ClipboardItem');
      const { ClipboardItem } = require('electron');
      await clipboard.write([new ClipboardItem({ 'image/png': new Blob([img.toPNG()], { type: 'image/png' }) })]);
    }

    if (test) {
      try { steps = JSON.parse(process.env.MANTLE_SHOT_TEST || '[]'); } catch (err) { ctx.log(`MANTLE_SHOT_TEST is not JSON (${err.message}); no scripted steps`); }
      if (!Array.isArray(steps)) steps = [];
      testDir = process.env.MANTLE_SHOT_TEST_DIR || null;
    }
    // MANTLE_SHOT_TEST_TIMEOUT_MS (read ONLY in --test) shortens the hard timeout so a test can see it fire.
    const hardTimeoutMs = (test && Number(process.env.MANTLE_SHOT_TEST_TIMEOUT_MS) > 0) ? Number(process.env.MANTLE_SHOT_TEST_TIMEOUT_MS) : HARD_TIMEOUT_MS;

    /* -- native placement (koffi, like lib/switcher.js), with Electron's setBounds as the fallback -- */
    let nat;
    let natReason = null;
    function native() {
      if (nat !== undefined) return nat;
      nat = null;
      try {
        const koffi = require('koffi');
        const user32 = koffi.load('user32.dll');
        nat = { setWindowPos: user32.func('int __stdcall SetWindowPos(intptr_t hwnd, intptr_t after, int x, int y, int cx, int cy, uint32 flags)') };
        // The READ side (verify(): what Windows says, not what we asked for). Buffers, not koffi
        // structs: struct names are process-global in koffi and lib/thumbs.js owns MANTLE_RECT.
        nat.isWindow = user32.func('int __stdcall IsWindow(intptr_t hwnd)');
        nat.isVisible = user32.func('int __stdcall IsWindowVisible(intptr_t hwnd)');
        nat.getRect = user32.func('int __stdcall GetWindowRect(intptr_t hwnd, void *rect)');
        nat.foreground = user32.func('intptr_t __stdcall GetForegroundWindow()');
        // POINT by value is one 64-bit register on x64: (y << 32) | (x & 0xFFFFFFFF).
        nat.fromPoint = user32.func('intptr_t __stdcall WindowFromPoint(int64 pt)');
        nat.ancestor = user32.func('intptr_t __stdcall GetAncestor(intptr_t hwnd, uint32 flags)');
        nat.className = user32.func('int __stdcall GetClassNameW(intptr_t hwnd, void *buf, int max)');
        try {
          const dwm = koffi.load('dwmapi.dll');
          nat.dwmAttr = dwm.func('int32 __stdcall DwmGetWindowAttribute(intptr_t hwnd, uint32 attr, void *out, uint32 size)');
        } catch (_) { nat.dwmAttr = null; /* cloaking unreadable: judged as not cloaked */ }
        // The canary's pixel read (canary()): one pixel, compared in memory, never logged.
        const gdi = koffi.load('gdi32.dll');
        nat.getDC = user32.func('intptr_t __stdcall GetDC(intptr_t hwnd)');
        nat.releaseDC = user32.func('int __stdcall ReleaseDC(intptr_t hwnd, intptr_t dc)');
        nat.getPixel = gdi.func('uint32 __stdcall GetPixel(intptr_t dc, int x, int y)');
      } catch (err) {
        natReason = `koffi could not bind user32.dll (${String(err && err.message).split('\n')[0]})`;
      }
      return nat;
    }
    function hwndOf(win) {
      try {
        const b = win.getNativeWindowHandle();
        return b.length >= 8 ? b.readBigUInt64LE(0).toString() : String(b.readUInt32LE(0));
      } catch (_) { return null; }
    }
    /** Physical rect -> the window, optionally topmost and shown. Never activates. */
    function place(o, r, top) {
      if (!o || o.win.isDestroyed()) return false;
      const n = native();
      if (n && o.hwnd) {
        let flags = SWP_NOACTIVATE | SWP_NOOWNERZORDER | (top ? SWP_SHOWWINDOW : SWP_NOZORDER);
        if (!(r.w > 0 && r.h > 0)) flags |= SWP_NOSIZE;
        try {
          if (n.setWindowPos(Number(o.hwnd), top ? HWND_TOPMOST : 0, r.x, r.y, r.w || 0, r.h || 0, flags) !== 0) return true;
        } catch (_) { /* Electron below */ }
      }
      try {
        if (r.w > 0 && r.h > 0) o.win.setBounds(screen.screenToDipRect(null, { x: r.x, y: r.y, width: r.w, height: r.h }));
        else { const p = screen.screenToDipPoint({ x: r.x, y: r.y }); o.win.setPosition(Math.round(p.x), Math.round(p.y)); }
        if (top) { o.win.setAlwaysOnTop(true, 'screen-saver'); o.win.moveTop(); }
        return true;
      } catch (err) {
        ctx.log(`a window could not be placed: ${err.message}${natReason ? ` (${natReason})` : ''}`);
        return false;
      }
    }

    /**
     * MEASURE one overlay: what Windows says about it right now (judgeShown() turns it into a
     * verdict). `at` is the physical point to hit-test (default: the centre of `o.monitor`). Class
     * names only, never a title. null when the Win32 read side is unavailable.
     */
    function measure(o, at) {
      const n = native();
      if (!n || !n.isWindow || !o || !o.hwnd) return null;
      const h = Number(o.hwnd);
      const m = { exists: !!n.isWindow(h), visible: false, cloaked: 0, rect: null, hit: '0', hitCls: '', fg: '0', fgCls: '' };
      const cls = (hw) => {
        if (!hw) return '';
        const b = Buffer.alloc(512);
        const len = n.className(hw, b, 256);
        return len > 0 ? b.toString('utf16le', 0, len * 2) : '';
      };
      try {
        if (!m.exists) return m;
        m.visible = !!n.isVisible(h);
        const r = Buffer.alloc(16);
        if (n.getRect(h, r)) {
          const l = r.readInt32LE(0), t = r.readInt32LE(4);
          m.rect = { x: l, y: t, w: r.readInt32LE(8) - l, h: r.readInt32LE(12) - t };
        }
        if (n.dwmAttr) {
          const c = Buffer.alloc(4);
          if (n.dwmAttr(h, 14 /* DWMWA_CLOAKED */, c, 4) === 0) m.cloaked = c.readUInt32LE(0);
        }
        const mon = o.monitor || o.park;
        const p = at || { x: Math.floor(mon.x + mon.w / 2), y: Math.floor(mon.y + mon.h / 2) };
        const hit = n.fromPoint((BigInt(p.y) << 32n) | BigInt(p.x >>> 0));
        const root = hit ? n.ancestor(hit, 2 /* GA_ROOT */) || hit : 0;
        m.hit = String(root || 0);
        if (root && root !== h) m.hitCls = cls(root);
        const fg = n.foreground();
        m.fg = String(fg || 0);
        if (fg && fg !== h) m.fgCls = cls(fg);
        m.at = p;
      } catch (err) {
        m.error = String(err && err.message).split('\n')[0];
      }
      return m;
    }

    /** Every shown overlay of `s` judged now: { ok, front, keyboard, why, facts }. */
    function judgeSession(s, opts) {
      const shown = s.used.filter((o) => o.onScreen);
      if (!shown.length) return { ok: false, front: false, keyboard: false, why: 'no overlay was moved on screen', facts: [] };
      const facts = [];
      const why = [];
      let front = true;
      let keyboard = false;
      for (const o of shown) {
        const m = measure(o, opts && opts.at);
        if (!m) return { ok: false, front: false, keyboard: false, why: `the window checks are unavailable (${natReason || 'no koffi'})`, facts };
        const want = { hwnd: o.hwnd, rect: (opts && opts.rect) || o.monitor, keyboard: false };
        const j = judgeShown(m, want);
        facts.push({ monitor: o.monitor.index, visible: m.visible, cloaked: m.cloaked, rect: m.rect, hitUs: m.hit === String(o.hwnd), hitCls: m.hitCls || undefined, fgUs: m.fg === String(o.hwnd), error: m.error });
        if (!j.front) { front = false; why.push(`monitor ${o.monitor.index}: ${j.why}`); }
        if (j.keyboard) keyboard = true;
        s.fgCls = m.fgCls;
      }
      if (!keyboard) why.push(`Windows did not give any overlay the keyboard (the foreground is class ${s.fgCls || '?'})`);
      return { ok: front && keyboard, front, keyboard, why: why.join('; '), facts };
    }

    function displaysPhys() {
      return screen.getAllDisplays().map((d) => {
        let r;
        try { r = screen.dipToScreenRect(null, d.bounds); } catch (_) { r = d.bounds; }
        return { id: d.id, x: r.x, y: r.y, w: r.width, h: r.height, dip: d.bounds, workArea: d.workArea, scaleFactor: d.scaleFactor };
      });
    }

    function health() {
      if (problem || downWhy) ctx.health(false, problem || downWhy);
      else ctx.health(true);
    }

    /* -- windows ------------------------------------------------------------------------------------ */

    function baseWindow(extra) {
      const win = new BrowserWindow(Object.assign({
        show: false, frame: false, transparent: true, skipTaskbar: true, hasShadow: false,
        resizable: true, thickFrame: false, fullscreenable: false, minimizable: false, maximizable: false,
        backgroundColor: '#00000000',
        // WS_EX_TOOLWINDOW: never in Alt+Tab, even while parked and "shown".
        type: 'toolbar',
        webPreferences: {
          preload: ctx.preload, contextIsolation: true, sandbox: true, nodeIntegration: false,
          spellcheck: false, backgroundThrottling: false,
        },
      }, extra));
      win.webContents.on('will-navigate', (e) => e.preventDefault());
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      // NOT content-protected (it was until 2026-09-24): a WDA_EXCLUDEFROMCAPTURE window is invisible to
      // GetPixel and every other capture, so the overlay could never PROVE its pixels were on the screen
      // (canary()), and protection was the one part of the recipe no test could see. Windows' own snip
      // overlay is not protected either.
      return win;
    }

    function watchPage(win, what, onGone) {
      win.webContents.on('render-process-gone', (_e, d) => {
        problem = `the ${what} page crashed (${d && d.reason}); Win+Shift+S is Windows' own until Mantle restarts it`;
        health();
        onGone();
      });
      win.webContents.on('did-fail-load', (_e, code, desc) => {
        problem = `the ${what} page did not load (${desc || code})`;
        health();
      });
      win.webContents.on('unresponsive', () => ctx.log(`the ${what} page is not responding`));
    }

    function createOverlay(d, all) {
      const park = parkSpot(d, d.w, d.h, all);
      const dipPark = screen.screenToDipPoint({ x: park.x, y: park.y });
      const win = baseWindow({
        x: Math.round(dipPark.x), y: Math.round(dipPark.y), width: d.dip.width, height: d.dip.height,
        alwaysOnTop: !test, focusable: true, title: 'Mantle Screenshot',
      });
      const o = { win, hwnd: hwndOf(win), loaded: false, displayId: d.id, park: { x: park.x, y: park.y, w: d.w, h: d.h }, phys: d };
      win.webContents.on('did-finish-load', () => { o.loaded = true; });
      win.on('blur', () => onBlur(o));
      watchPage(win, 'screenshot overlay', () => { if (sess) endSession('its page crashed'); rebuildSoon('a page crashed'); });
      // The EXACT physical size of its monitor, already while parked: a window built from DIP
      // bounds came out 1536x867 CSS on a 1920x1080 panel at 125% (measured 2026-09-24, --test),
      // and a page that decodes and paints at one size and is revealed at another shows a
      // stretched first frame. SetWindowPos without SWP_SHOWWINDOW leaves a hidden window hidden.
      place(o, o.park, false);
      win.loadFile(ctx.page('index.html'));
      if (!test) {
        // Parked, not hidden: a parked window keeps painting, so the frame is drawn BEFORE it
        // moves on screen (lib/switcher.js learned this; hidden windows get no frames).
        win.once('ready-to-show', () => { if (!win.isDestroyed()) { place(o, o.park, false); win.showInactive(); } });
      }
      return o;
    }

    function buildOverlays(why) {
      for (const o of overlays.values()) { try { if (!o.win.isDestroyed()) o.win.destroy(); } catch (_) { /* gone */ } }
      overlays.clear();
      const all = displaysPhys();
      for (const d of all) overlays.set(d.id, createOverlay(d, all));
      ctx.log(`${overlays.size} overlay window${overlays.size === 1 ? '' : 's'} ready (${why}): ${all.map((d) => `${d.w}x${d.h}@${d.scaleFactor}`).join(' + ')}`);
    }

    function rebuildSoon(why) {
      clearTimeout(rebuildTimer);
      rebuildTimer = setTimeout(() => {
        if (stopped) return;
        if (sess) { rebuildSoon(why); return; }     // never under an open capture
        buildOverlays(why);
      }, 600);
    }

    function createCard() {
      const all = displaysPhys();
      const prim = all.find((d) => d.dip.x === screen.getPrimaryDisplay().bounds.x && d.dip.y === screen.getPrimaryDisplay().bounds.y) || all[0];
      const park = parkSpot(prim, 420, 200, all);
      const dp = screen.screenToDipPoint({ x: park.x, y: park.y });
      const win = baseWindow({ x: Math.round(dp.x), y: Math.round(dp.y), width: 400, height: 150, alwaysOnTop: !test, focusable: true, title: 'Mantle Screenshot saved' });
      const c = { win, hwnd: hwndOf(win), loaded: false, shown: false, info: null, backstop: null, park };
      win.webContents.on('did-finish-load', () => { c.loaded = true; });
      watchPage(win, 'screenshot card', () => { card = null; setTimeout(() => { if (!stopped) card = createCard(); }, 1000); });
      win.loadFile(ctx.page('card.html'));
      if (!test) win.once('ready-to-show', () => { if (!win.isDestroyed()) { place(c, park, false); win.showInactive(); } });
      return c;
    }

    function parkCard(why) {
      if (!card || !card.shown) return;
      card.shown = false;
      clearTimeout(card.backstop);
      ctx.push(card.win, 'screenshot.cardClear', { why });
      if (!test) place(card, card.park, false);
    }

    function showCard(info) {
      if (!card || card.win.isDestroyed()) { ctx.log(`no card window to show: ${info.note || info.saveError || info.copyError || info.name}`); return; }
      card.info = Object.assign({ lifeMs: CARD_LIFE_MS }, info);
      card.shown = true;
      clearTimeout(card.backstop);
      card.backstop = setTimeout(() => parkCard('backstop: the card never said it was dismissed'), CARD_BACKSTOP_MS);
      ctx.push(card.win, 'screenshot.card', card.info);
    }

    /* -- the capture ------------------------------------------------------------------------------- */

    function allHwnds() {
      const out = [];
      for (const o of overlays.values()) if (o.hwnd) out.push(o.hwnd);
      if (card && card.hwnd) out.push(card.hwnd);
      return out;
    }

    function cursorPhys() {
      try { return screen.dipToScreenPoint(screen.getCursorScreenPoint()); } catch (_) { return null; }
    }

    async function start(chord) {
      if (stopped || !ctx.enabled()) return;
      if (problem || downWhy) { ctx.log(`${chord} while down: ${problem || downWhy}`); return; }
      if (sess) {
        // NEVER "ignored" (2026-09-24: 14 presses were dropped behind a capture nobody could see).
        const s0 = sess;
        const d = secondChord(s0, s0.shown ? judgeSession(s0) : null);
        if (d.act === 'raise') {
          ctx.log(`${chord}: ${d.why}; brought it forward again`);
          for (const o of s0.used) if (o.onScreen) place(o, o.monitor, true);
          if (s0.focusOn) takeKeyboard(s0, s0.focusOn);
          return;
        }
        ctx.log(`${chord}: ${d.why}; cancelled it and started a new capture`);
        if (test) ctx.log(`TESTSHOT #${s0.seq} replaced ${JSON.stringify({ why: d.why })}`);
        endSession(`replaced by a new ${chord}`);
        // grab 0 = its shot.grab is still in flight: that start() sees sess !== s and stops, and
        // the new grab replaces its frame (a release of grab 0 would free the NEW one).
        if (s0.grab) release(s0);
      }
      const step = test ? (steps.shift() || null) : null;
      const s = sess = { seq: ++seqN, chord, t0: Date.now(), step, ready: new Map(), used: [], grab: 0, shown: false, prevFg: null };
      // Whatever happens below, no capture outlives this (the page's Esc and click are not the only way out).
      s.hardTimer = setTimeout(() => {
        if (sess !== s) return;
        const why = `nothing was selected within ${Math.round(hardTimeoutMs / 1000)} s`;
        ctx.log(`#${s.seq}: ended: ${why}`);
        if (test) ctx.log(`TESTSHOT #${s.seq} timed out ${JSON.stringify({ why })}`);
        endSession(why);
        release(s);
      }, hardTimeoutMs);
      parkCard('a new capture');
      const [g, fg] = await Promise.all([
        ctx.sidecar.send('shot.grab', { dir: FRAME_DIR, exclude: allHwnds(), synthetic: !!(step && step.synthetic) }, { timeoutMs: 5000 }),
        test ? Promise.resolve(null) : ctx.sidecar.send('foreground', {}, { timeoutMs: 1000 }),
      ]);
      if (sess !== s) return;
      if (fg && fg.ok && fg.result && fg.result.hwnd) s.prevFg = fg.result.hwnd;      // the hwnd only: never its title
      if (!g.ok) {
        if (missingCommand(g.error)) {
          problem = 'the sidecar has no shot.grab command (an older build): rebuild it with npm run build:sidecar';
          health();
        }
        const why = `the screen could not be captured: ${g.error}`;
        ctx.log(`#${s.seq} ${chord}: ${why}`);
        clearTimeout(s.hardTimer);
        sess = null;
        showCard({ seq: s.seq, saveError: why, copyError: 'nothing was captured' });
        return;
      }
      const r = g.result;
      s.grab = r.grab;
      s.stats = { seq: s.seq, chord, monitors: r.monitors, windows: r.windows.length, grabMs: r.ms.total, bltMs: r.ms.blt, writeMs: r.ms.write };
      const disp = displaysPhys();
      const pairs = G.matchDisplays(r.monitors, disp);
      const cursor = cursorPhys();
      const mode = MODES.includes(step && step.mode) ? step.mode : (MODES.includes(ctx.settings.get('mode', 'rect')) ? ctx.settings.get('mode', 'rect') : 'rect');
      for (const p of pairs) {
        const m = p.monitor;
        if (!p.display) { ctx.log(`#${s.seq}: monitor ${m.index} (${m.w}x${m.h}) matches no Electron display, so it gets no overlay`); continue; }
        let o = overlays.get(p.display.id);
        if (!o || o.win.isDestroyed()) { o = createOverlay(p.display, disp); overlays.set(p.display.id, o); }
        o.monitor = m;
        s.used.push(o);
        ctx.push(o.win, 'screenshot.frame', {
          seq: s.seq, grab: r.grab, mode, cursor,
          src: m.file ? fileUrl(m.file) : null,
          monitor: { index: m.index, x: m.x, y: m.y, w: m.w, h: m.h, scale: m.scale, primary: m.primary },
          windows: r.windows,
          problem: m.file ? null : 'Windows reported this monitor outside the desktop, so there is no frozen frame for it',
        });
      }
      if (!s.used.length) {
        endSession('no overlay');
        showCard({ seq: s.seq, saveError: 'none of the captured monitors matched a display Mantle can draw on', copyError: 'nothing was captured' });
        return;
      }
      s.readyTimer = setTimeout(() => reveal(s, `${READY_TIMEOUT_MS} ms passed without every page saying ready`), READY_TIMEOUT_MS);
    }

    /**
     * On screen with the pages that have PAINTED their frame, and only those: a page that never
     * got its frame would be a transparent, click-eating window that nothing dismisses. None ready
     * at all is a failure with its reason on the card; a page that is late comes up when it is ready.
     */
    function reveal(s, how) {
      if (sess !== s || s.shown) return;
      clearTimeout(s.readyTimer);
      const ready = s.used.filter((o) => s.ready.has(o.monitor.index));
      if (!ready.length) {
        const why = `no overlay page drew its frozen frame within ${READY_TIMEOUT_MS} ms`;
        ctx.log(`#${s.seq} ${s.chord}: ${why}`);
        endSession('not drawn in time');
        release(s);
        showCard({ seq: s.seq, saveError: why, copyError: 'nothing was captured' });
        return;
      }
      s.shown = true;
      s.shownAt = Date.now();
      s.stats.decodeMs = Math.max(0, ...[...s.ready.values()].map((v) => v.decodeMs || v.ms || 0));
      s.stats.shownMs = Date.now() - s.t0;
      s.stats.how = how;
      ctx.log(summary(s.stats));
      if (test) {
        ctx.log(`TESTSHOT #${s.seq} ready ${JSON.stringify({ monitors: s.used.length, grabMs: s.stats.grabMs, decodeMs: s.stats.decodeMs, shownMs: s.stats.shownMs, how, ready: [...s.ready.values()].map((v) => ({ natural: v.natural, view: v.view, dpr: v.dpr, decodeMs: v.decodeMs, how: v.how })) })}`);
        if (s.step && s.step.probe) probeCorner(s);
        else if (s.step && s.step.blur) {
          // Through the REAL handler: the window's own 'blur' event (no test window is ever focused).
          const o = s.used[0];
          s.focusOn = o;
          // Later than EARLY_BLUR_MS: Owen moving on (an early loss is the fallback, unit-tested).
          setTimeout(() => { if (sess === s && !o.win.isDestroyed()) o.win.emit('blur'); }, EARLY_BLUR_MS + 200);
        } else if (s.step && !s.step.hold) playStep(s);
        return;
      }
      const cur = cursorPhys();
      let focusOn = ready[0];
      for (const o of ready) {
        place(o, o.monitor, true);
        o.onScreen = true;
        if (cur && cur.x >= o.monitor.x && cur.x < o.monitor.x + o.monitor.w && cur.y >= o.monitor.y && cur.y < o.monitor.y + o.monitor.h) focusOn = o;
      }
      s.focusOn = focusOn;
      takeKeyboard(s, focusOn);
      verifyShown(s, { keyboard: true });
    }

    /**
     * The keyboard (Esc, the arrows): Electron's focus first; then the sidecar's focus ladder
     * (AttachThreadInput, then the Alt nudge) when Windows refused Electron. Never in --test.
     */
    function takeKeyboard(s, o) {
      if (test || !o || o.win.isDestroyed()) return;
      try { o.win.focus(); } catch (_) { /* the ladder below */ }
      setTimeout(() => {
        if (sess !== s || o.win.isDestroyed() || o.win.isFocused()) return;
        ctx.sidecar.send('focus', { hwnd: o.hwnd }, { timeoutMs: 1500 }).then((f) => {
          if (!f.ok) { s.focusError = f.error; ctx.log(`#${s.seq}: the overlay could not take the keyboard (${f.error})`); }
        });
      }, 60);
    }

    /**
     * THE CANARY: proof that the overlay's PIXELS are on the glass, which no window flag can give
     * (2026-09-24, live: every flag the code set said "on screen" and Owen saw nothing). The page
     * paints a 3-device-pixel magenta dot at `at` (physical), says when it has painted, and the
     * screen's pixel there is read with GetPixel. Only "seen / not seen" leaves this function:
     * never a pixel value (if the overlay is NOT there, that pixel is Owen's screen).
     * The overlay is not content-protected any more for exactly this reason: GetPixel (like every
     * capture) cannot see a WDA_EXCLUDEFROMCAPTURE window, so a protected overlay is unverifiable.
     */
    function canary(s, o, at, winRect) {
      const n = native();
      if (!n || !n.getPixel) return Promise.resolve({ seen: false, why: `the pixel check is unavailable (${natReason || 'gdi32 not bound'})` });
      const view = (s.ready.get(o.monitor.index) || {}).view;
      if (!view || !view.w) return Promise.resolve({ seen: false, why: 'the page never said how big it is' });
      const r = winRect || o.monitor;
      const k = view.w / r.w;                       // CSS px per physical px on this page
      const css = { x: (at.x - r.x + 0.5) * k, y: (at.y - r.y + 0.5) * k, size: 3 * k };
      return new Promise((resolve) => {
        const done = (res) => {
          clearTimeout(s.canaryTimer);
          s.canaryWait = null;
          ctx.push(o.win, 'screenshot.canary', { seq: s.seq, on: false });
          resolve(res);
        };
        s.canaryWait = (a) => {
          let seen = false;
          try {
            const dc = n.getDC(0);
            const v = n.getPixel(dc, at.x, at.y) >>> 0;
            n.releaseDC(0, dc);
            // COLORREF 0x00BBGGRR. A tolerance, not an exact match: HDR / advanced colour may move
            // pure magenta by a few steps on the way through the compositor.
            seen = v !== 0xFFFFFFFF && (v & 0xFF) >= 200 && ((v >> 8) & 0xFF) <= 70 && ((v >> 16) & 0xFF) >= 200;
          } catch (err) {
            done({ seen: false, why: `the pixel could not be read (${String(err && err.message).split('\n')[0]})`, page: a });
            return;
          }
          done({ seen, why: seen ? null : 'its pixels are not on the screen: by every window measure it is in front, but what the screen shows there is not the overlay', page: a });
        };
        s.canaryTimer = setTimeout(() => done({ seen: false, why: 'its page did not paint the check dot within 300 ms (it is not drawing on screen)' }), 300);
        if (!ctx.push(o.win, 'screenshot.canary', { seq: s.seq, on: true, x: css.x, y: css.y, size: css.size })) done({ seen: false, why: 'its page is gone' });
      });
    }

    /**
     * MEASURE, don't claim: every VERIFY_STEP_MS until VERIFY_MS, judge the overlays from Win32
     * facts (visible, uncloaked, on the monitor's rect, a click at the centre lands on it, it holds
     * the keyboard), then the canary. Verified -> logged with the facts. Not by VERIFY_MS -> the
     * capture is cancelled and Windows' own snip opens (fallback()).
     * opts: { keyboard: bool, rect, at, probe } (the --test probe passes its 1-pixel spot).
     */
    async function verifyShown(s, opts) {
      const t0 = Date.now();
      let last = null;
      let refocused = false;
      while (sess === s) {
        await new Promise((r) => { s.verifyTimer = setTimeout(r, VERIFY_STEP_MS); });
        if (sess !== s) return;
        const elapsed = Date.now() - t0;
        let j = judgeSession(s, opts);
        if (!opts.keyboard) j = Object.assign({}, j, { ok: j.front });
        if (j.front && !s.pixelsSeen) {
          // The canary once the window flags say "in front" (with or without the keyboard): the
          // pixels are the one fact no flag can give. Seen once is enough.
          const o = opts.probe || s.focusOn || s.used.find((x) => x.onScreen);
          const at = opts.at || { x: Math.floor(o.monitor.x + o.monitor.w / 2), y: Math.floor(o.monitor.y + o.monitor.h / 2) };
          const px = await canary(s, o, at, opts.rect);
          if (sess !== s) return;
          s.pixelsSeen = px.seen;
          s.pixelPage = px.page || null;
          if (!px.seen) j = { ok: false, front: false, keyboard: j.keyboard, why: px.why, facts: j.facts };
        }
        if (j.ok && s.pixelsSeen) {
          s.verified = true;
          fallbacksInARow = 0;
          const f = j.facts[0] || {};
          ctx.log(`#${s.seq}: verified in front ${Date.now() - t0} ms after moving on screen: visible, not cloaked, at ${f.rect ? `${f.rect.x},${f.rect.y} ${f.rect.w}x${f.rect.h}` : '?'}, ` +
            `a click at its centre lands on it${opts.keyboard ? ', it has the keyboard' : ''}, and its check pixel is on the screen`);
          if (test) ctx.log(`TESTSHOT #${s.seq} verified ${JSON.stringify({ facts: j.facts, page: s.pixelPage })}`);
          return;
        }
        last = j;
        if (!test && opts.keyboard && !refocused && !j.keyboard && elapsed >= REFOCUS_AT_MS && s.focusOn) {
          refocused = true;
          // Once more, straight to the sidecar's ladder (Electron's focus() already had its turn).
          ctx.sidecar.send('focus', { hwnd: s.focusOn.hwnd }, { timeoutMs: 1500 }).then((f) => {
            if (!f.ok && sess === s) s.focusError = f.error;
          });
        }
        if (elapsed >= VERIFY_MS) break;
      }
      if (sess !== s) return;
      const why = (last && last.why) || 'it could not be measured';
      fallback(s, s.focusError ? `${why} (the sidecar's focus said: ${s.focusError})` : why, last && last.facts, { pixelsSeen: !!s.pixelsSeen, page: s.pixelPage || null });
    }

    /**
     * Mantle's overlay could not come forward: cancel the capture, open Windows' own snip, and
     * say so on the card and in the log. FALLBACKS_BEFORE_DOWN in a row take the feature down,
     * so Win+Shift+S and PrintScreen go straight to Windows until the tray switch is flipped.
     */
    function fallback(s, why, facts, pixels) {
      if (sess !== s) return;
      fallbacksInARow++;
      const cardWhy = `Mantle's screenshot overlay could not come forward: ${why}`;
      ctx.log(`#${s.seq} ${s.chord}: the overlay could not come forward within ${VERIFY_MS} ms (${why}); cancelled it and ${test ? 'would open' : 'opened'} Windows' Snipping Tool instead`);
      if (test) ctx.log(`TESTSHOT #${s.seq} fallback ${JSON.stringify({ why, facts, pixels, inARow: fallbacksInARow })}`);
      endSession('could not come forward', { giveBack: false });
      release(s);
      const card = { seq: s.seq, title: 'Windows\' Snipping Tool opened instead', note: cardWhy, copied: false };
      if (test) {
        showCard(card);
      } else {
        shell.openExternal(FALLBACK_URI).then(() => showCard(card), (err) => {
          const e = String(err && err.message).split('\n')[0];
          ctx.log(`#${s.seq}: Windows' Snipping Tool (${FALLBACK_URI}) could not be opened either: ${e}`);
          showCard({ seq: s.seq, title: 'Screenshot not taken', note: `${cardWhy}; Windows' Snipping Tool could not be opened either (${e})` });
        });
      }
      if (fallbacksInARow >= FALLBACKS_BEFORE_DOWN && !downWhy) {
        downWhy = `Mantle's screenshot overlay could not come forward ${fallbacksInARow} times in a row (last: ${why}), ` +
          'so Win+Shift+S and PrintScreen are Windows\' own again until the tray switch is turned off and on';
        ctx.log(downWhy);
        health();
      }
    }

    /**
     * --test only: the REAL reveal, measured, without ever covering Owen's screen. The overlay goes
     * up exactly as live (SetWindowPos TOPMOST | SHOWWINDOW | NOACTIVATE, full size) but so that
     * only its bottom-left PIXEL is on the monitor, at the monitor's top-right corner; no focus is
     * ever asked for. The verdict is therefore "not verified: no keyboard", which drives the real
     * fallback path (Windows' snip is NOT opened in a test), and the facts are logged.
     */
    function probeCorner(s) {
      const o = s.used.find((x) => x.monitor && x.monitor.primary) || s.used[0];
      const m = o.monitor;
      const rect = { x: m.x + m.w - 1, y: m.y - m.h + 1, w: m.w, h: m.h };
      const at = { x: m.x + m.w - 1, y: m.y };
      s.focusOn = o;
      o.probe = true;
      // As live: shown (inactive) while PARKED off every monitor first, then one SetWindowPos.
      place(o, o.park, false);
      try { o.win.showInactive(); } catch (_) { /* judged below */ }
      setTimeout(() => {
        if (sess !== s) return;
        o.onScreen = place(o, rect, true);
        verifyShown(s, { keyboard: true, rect, at, probe: o });
      }, 150);
    }

    /** Puts every overlay away and forgets the session; the frame is released by the caller.
     *  opts.giveBack=false: the keyboard is NOT handed back (another window took it, or Windows'
     *  snip is about to). Otherwise it goes back to the window that had it, but only while an
     *  overlay still holds it: never taken from whoever Owen has moved on to. */
    function endSession(why, opts) {
      const s = sess;
      if (!s) return null;
      sess = null;
      clearTimeout(s.readyTimer);
      clearTimeout(s.hardTimer);
      clearTimeout(s.verifyTimer);
      clearTimeout(s.canaryTimer);
      s.canaryWait = null;
      const n = native();
      const fg = n && n.foreground ? String(n.foreground() || 0) : null;
      const oursHadIt = fg !== null && s.used.some((o) => String(o.hwnd) === fg);
      for (const o of s.used) {
        ctx.push(o.win, 'screenshot.clear', { why });
        if (o.probe) {
          // The --test probe showed a window that a test run otherwise keeps hidden.
          place(o, o.park, false);
          try { o.win.hide(); } catch (_) { /* destroyed */ }
          o.probe = false;
        } else if (!test && s.shown) place(o, o.park, false);
        o.onScreen = false;
      }
      const giveBack = !(opts && opts.giveBack === false);
      if (!test && s.shown && s.prevFg && giveBack && oursHadIt) {
        ctx.sidecar.send('focus', { hwnd: s.prevFg }, { timeoutMs: 1500 }).then((f) => {
          if (!f.ok) ctx.log(`#${s.seq}: the keyboard could not go back to the window that had it (${f.error})`);
        });
      }
      return s;
    }

    /** An overlay lost the keyboard. Focus moving between two monitors' overlays is not a loss. */
    function onBlur(o) {
      const s = sess;
      if (!s || !s.used.includes(o)) return;
      if (!s.verified && !(test && s.step && s.step.blur)) return;   // verifyShown() owns the unverified case
      setTimeout(() => {
        if (sess !== s) return;
        if (s.used.some((x) => !x.win.isDestroyed() && x.win.isFocused())) return;
        const m = measure(o) || {};
        const why = `the overlay lost the keyboard to another window (class ${m.fgCls || (m.fg && m.fg !== '0' ? '?' : 'none: nothing has it now')})`;
        const since = Date.now() - (s.shownAt || 0);
        if (blurVerdict(since) === 'fallback') {
          // Taken away right after it came up: not Owen moving on, a window grabbing the foreground
          // back (the live log of 2026-09-24 is consistent with exactly that). He still gets a snip.
          fallback(s, `${why}, ${since} ms after it came up`, null, { pixelsSeen: !!s.pixelsSeen });
          return;
        }
        ctx.log(`#${s.seq}: ended: ${why}`);
        if (test) ctx.log(`TESTSHOT #${s.seq} lost keyboard ${JSON.stringify({ why })}`);
        endSession(why, { giveBack: false });
        release(s);
      }, BLUR_GRACE_MS);
    }

    async function release(s) {
      const rel = await ctx.sidecar.send('shot.release', { grab: s.grab }, { timeoutMs: 3000 });
      if (!rel.ok) ctx.log(`#${s.seq}: the frozen frame could not be released (${rel.error}); the next capture replaces it`);
    }

    async function commit(a) {
      const s = sess;
      if (!s || !a || a.seq !== s.seq) return { ok: false, reason: 'that capture is no longer open' };
      const rect = a.rect || {};
      if (!(rect.w >= G.MIN_SIDE && rect.h >= G.MIN_SIDE)) return { ok: false, reason: 'the selection is empty' };
      endSession('captured');
      if (MODES.includes(a.mode)) { try { ctx.settings.set('mode', a.mode); } catch (err) { ctx.log(`the mode could not be remembered: ${err.message}`); } }
      const name = G.screenshotName(new Date());
      const target = saveDirFor(test, testDir, ctx.settings.get('saveDir', null), folder, os.tmpdir());
      const t0 = Date.now();
      let saved = null;
      let saveError = null;
      if (target.dir) {
        const sv = await ctx.sidecar.send('shot.save', { grab: s.grab, x: rect.x, y: rect.y, w: rect.w, h: rect.h, dir: target.dir, name }, { timeoutMs: 10000 });
        if (sv.ok) saved = sv.result; else saveError = sv.error;
      } else {
        saveError = target.why;
      }
      // The clipboard needs a PNG even when the real folder refused one: a temp copy then.
      let clipFile = saved ? saved.path : null;
      let tempClip = null;
      if (!clipFile) {
        const sv2 = await ctx.sidecar.send('shot.save', { grab: s.grab, x: rect.x, y: rect.y, w: rect.w, h: rect.h, dir: FRAME_DIR, name: `clip-${s.seq}` }, { timeoutMs: 10000 });
        if (sv2.ok) { clipFile = tempClip = sv2.result.path; } else if (!saveError) saveError = sv2.error;
      }
      await release(s);
      let copied = false;
      let copyError = null;
      if (clipFile) {
        try {
          const img = nativeImage.createFromPath(clipFile);
          if (img.isEmpty()) throw new Error('the saved PNG could not be read back');
          if (test) { const sz = img.getSize(); sink.image = { w: sz.width, h: sz.height, via: clipboardImageApi() }; }
          else await writeClipboardPng(img);
          copied = true;
        } catch (err) { copyError = err.message; }
      } else {
        copyError = 'there was no picture to copy';
      }
      if (tempClip) { try { fs.unlinkSync(tempClip); } catch (_) { /* temp */ } }
      const w = saved ? saved.w : rect.w;
      const h = saved ? saved.h : rect.h;
      const ms = Date.now() - t0;
      ctx.log(`#${s.seq}: ${saved ? `saved ${w}x${h} (${Math.round(saved.bytes / 1024)} KB, encode ${saved.ms.encode} ms) to ${target.why}` : `NOT saved (${saveError})`}; ` +
        `${copied ? 'copied' : `NOT copied (${copyError})`}; ${ms} ms after the selection (${a.mode}, ${a.via})`);
      if (test) ctx.log(`TESTSHOT #${s.seq} saved ${JSON.stringify({ path: saved && saved.path, name: saved && saved.name, w, h, x: saved && saved.x, y: saved && saved.y, bytes: saved && saved.bytes, saveMs: saved && saved.ms, copied, clip: sink.image, saveError, copyError, mode: a.mode, kind: a.kind, via: a.via, rect })}`);
      showCard({ seq: s.seq, path: saved && saved.path, name: saved && saved.name, folder: target.dir, url: saved ? fileUrl(saved.path) : null, w, h, copied, copyError, saveError });
      return { ok: true };
    }

    /** --test only: play one scripted step INSIDE the overlay page, through its own event handlers. */
    function playStep(s) {
      const o = s.used.find((x) => x.monitor && x.monitor.primary) || s.used[0];
      const step = s.step;
      const script = `(${function drive(st) {
        const fire = (type, x, y) => document.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 1, bubbles: true }));
        const key = (k, shift) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, shiftKey: !!shift, bubbles: true }));
        if (st.drag) {
          const [x0, y0, x1, y1] = st.drag;
          fire('pointermove', x0, y0); fire('pointerdown', x0, y0);
          fire('pointermove', (x0 + x1) / 2, (y0 + y1) / 2); fire('pointermove', x1, y1); fire('pointerup', x1, y1);
        }
        if (st.click) { const [x, y] = st.click; fire('pointermove', x, y); fire('pointerdown', x, y); fire('pointerup', x, y); }
        (st.keys || []).forEach((k) => key(k.key || k, k.shift));
        if (st.key) key(st.key);
        const S = window.__shot;
        return { mode: S.mode, done: S.done, anchor: S.anchor, ptr: S.ptr, view: S.view };
      }})(${JSON.stringify(step)})`;
      o.win.webContents.executeJavaScript(script).then(
        (res) => ctx.log(`TESTSHOT #${s.seq} played ${JSON.stringify(res)}`),
        (err) => ctx.log(`TESTSHOT #${s.seq} step failed: ${err.message}`));
    }

    /* -- commands (the pages) ------------------------------------------------------------------------- */

    ctx.command('loaded', async () => ({ ok: true }));
    ctx.command('ready', async (a) => {
      const s = sess;
      if (!s || !a || a.seq !== s.seq) return { ok: false, stale: true };
      s.ready.set(a.monitor, a);
      if (a.problem) ctx.log(`#${s.seq}: monitor ${a.monitor}: ${a.problem}`);
      if (s.shown) {
        // Late (after the timeout revealed the others): this monitor comes up now.
        const o = s.used.find((x) => x.monitor.index === a.monitor);
        ctx.log(`#${s.seq}: monitor ${a.monitor} was ready ${Date.now() - s.t0} ms after the chord, late`);
        if (o && !o.onScreen && !test) { place(o, o.monitor, true); o.onScreen = true; }
      } else if (s.used.every((o) => s.ready.has(o.monitor.index))) reveal(s, 'every page painted its frame');
      return { ok: true };
    });
    ctx.command('commit', commit);
    ctx.command('canary', async (a) => {
      const s = sess;
      if (!s || !a || a.seq !== s.seq || !s.canaryWait) return { ok: false, stale: true };
      s.canaryWait(a);
      return { ok: true };
    });
    ctx.command('cancel', async (a) => {
      const s = sess;
      if (!s || !a || a.seq !== s.seq) return { ok: false, reason: 'that capture is no longer open' };
      endSession(`cancelled (${a.why})`);
      await release(s);
      ctx.log(`#${s.seq}: cancelled (${a.why})`);
      if (test) ctx.log(`TESTSHOT #${s.seq} cancelled ${JSON.stringify({ why: a.why })}`);
      return { ok: true };
    });
    ctx.command('mode', async (a) => {
      if (!sess || !a || !MODES.includes(a.mode)) return { ok: false };
      for (const o of sess.used) ctx.push(o.win, 'screenshot.mode', { mode: a.mode });
      return { ok: true };
    });
    ctx.command('cardLoaded', async () => ({ ok: true }));
    ctx.command('cardShown', async (a) => {
      if (!card || !card.shown || !a || !card.info || a.seq !== card.info.seq) return { ok: false };
      if (test) { ctx.log(`TESTSHOT card shown ${JSON.stringify({ w: a.w, h: a.h, saved: !!card.info.path, copied: card.info.copied })}`); return { ok: true }; }
      const d = ctx.host.display() || screen.getPrimaryDisplay();
      const spot = cardSpot({ w: a.w, h: a.h }, d.workArea, ctx.host.barRect());
      const phys = screen.dipToScreenRect(null, spot);
      place(card, { x: phys.x, y: phys.y, w: phys.width, h: phys.height }, true);
      return { ok: true };
    });
    ctx.command('cardDismiss', async (a) => {
      if (card && card.info && a && a.seq === card.info.seq) parkCard(a.why || 'dismissed');
      return { ok: true };
    });
    ctx.command('cardOpen', async () => {
      const p = card && card.info && card.info.path;
      if (!p) return { ok: false, reason: 'nothing was saved' };
      if (test) { ctx.log('TESTSHOT card open (test: not opened)'); return { ok: true }; }
      const err = await shell.openPath(p);
      if (err) ctx.log(`the screenshot could not be opened: ${err}`);
      return { ok: !err, reason: err || null };
    });
    ctx.command('cardFolder', async () => {
      const p = card && card.info && card.info.path;
      if (!p) return { ok: false, reason: 'nothing was saved' };
      if (test) { ctx.log('TESTSHOT card folder (test: not opened)'); return { ok: true }; }
      shell.showItemInFolder(p);
      return { ok: true };
    });
    ctx.command('cardCopyPath', async () => {
      const p = card && card.info && card.info.path;
      if (!p) return { ok: false, reason: 'nothing was saved' };
      if (test) { sink.text = { length: p.length }; ctx.log('TESTSHOT card copy path (test sink)'); return { ok: true }; }
      try { await clipboard.writeText(p); return { ok: true }; } catch (err) { return { ok: false, reason: err.message }; }
    });

    /* -- start-up ---------------------------------------------------------------------------------------- */

    ctx.onChord('Win+Shift+S', start);
    ctx.onChord('PrintScreen', start);
    ctx.onEnabled((on) => {
      if (on) {
        // The tray switch turned back on: the owner's word that the overlay should be tried again.
        if (downWhy) { downWhy = null; fallbacksInARow = 0; health(); ctx.log('switched back on: the overlay gets another try'); }
        return;
      }
      if (sess) { const s = endSession('switched off'); if (s) release(s); }
      parkCard('switched off');
    });
    const offReady = ctx.sidecar.onReady(async () => {
      const f = await ctx.sidecar.send('shot.folder', {}, { timeoutMs: 4000 });
      if (!f.ok) {
        problem = missingCommand(f.error)
          ? 'the sidecar has no shot.* commands (an older build): rebuild it with npm run build:sidecar'
          : null;
        if (!problem) ctx.log(`the Screenshots folder could not be read (${f.error}); saves will say so`);
      } else {
        folder = f.result;
        problem = null;
        ctx.log(`saves go to ${test ? 'a %TEMP% test folder' : (f.result.source === 'known folder' ? 'Windows\' Screenshots folder' : `Pictures\\Screenshots (${f.result.reason})`)}`);
      }
      health();
    });
    screen.on('display-added', onDisplays);
    screen.on('display-removed', onDisplays);
    screen.on('display-metrics-changed', onDisplays);
    function onDisplays() { rebuildSoon('the displays changed'); }
    /** Frames are pictures of the screen: delete every one in FRAME_DIR. Returns how many. */
    function cleanFrames() {
      let n = 0;
      try {
        for (const f of fs.readdirSync(FRAME_DIR)) {
          if (!/^(mantle-shot-.*\.bmp|clip-\d+.*\.png)$/.test(f)) continue;
          try { fs.unlinkSync(path.join(FRAME_DIR, f)); n++; } catch (_) { /* in use: the next grab deletes it */ }
        }
      } catch (_) { /* no folder yet */ }
      return n;
    }

    try { fs.mkdirSync(FRAME_DIR, { recursive: true }); } catch (err) { ctx.log(`the frame folder could not be made (${err.message})`); }
    const stale = cleanFrames();
    if (stale) ctx.log(`deleted ${stale} frozen frame file${stale === 1 ? '' : 's'} a previous run left behind (a crash skipped its stop)`);
    buildOverlays('install');
    card = createCard();

    return {
      stop(why) {
        stopped = true;
        clearTimeout(rebuildTimer);
        try { offReady(); } catch (_) { /* gone */ }
        screen.removeListener('display-added', onDisplays);
        screen.removeListener('display-removed', onDisplays);
        screen.removeListener('display-metrics-changed', onDisplays);
        const s = endSession(`Mantle is stopping (${why})`);
        if (s) ctx.sidecar.send('shot.release', { grab: s.grab }, { timeoutMs: 1500 });
        else ctx.sidecar.send('shot.release', {}, { timeoutMs: 1500 });
        for (const o of overlays.values()) { try { if (!o.win.isDestroyed()) o.win.destroy(); } catch (_) { /* gone */ } }
        overlays.clear();
        if (card) { clearTimeout(card.backstop); try { if (!card.win.isDestroyed()) card.win.destroy(); } catch (_) { /* gone */ } }
        card = null;
        // Frames are pictures of the screen: none may outlive Mantle (the sidecar also deletes
        // leftovers at its next grab, and install() at the next start, for the crash case).
        cleanFrames();
      },
    };
  },
};
