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
 *           (health false). A second chord never waits behind an
 *           open capture (it is brought forward if verified, else replaced), losing the keyboard
 *           ends a capture, and none lives past 60 s.
 *        -> SELF-HEALING (lane shotfix, 2026-09-28: live, two failures under 100% CPU at 18:00-18:01
 *           took the keys away and they NEVER came back, because while they are Windows' Mantle never
 *           sees a press that could prove anything). Down, the feature takes its keys back BY ITSELF
 *           after 30 s, then 2 min, then every 10 min (retakeDelay), on trial: the next press proves
 *           the overlay can come forward (a verified capture ends the trial and resets the backoff);
 *           one failure on trial sends them back at once with the next delay. An invisible test
 *           bring-forward was ruled out: the keyboard half can only be proved by taking the foreground
 *           from Owen's window. The strip, tray and log say when the next try is.
 *        -> WINDOWS' OWN SHELL UI is not Mantle failing (same day: the second "failure" was Windows'
 *           snip, ScreenClippingHost.exe, which the FIRST failure's fallback had opened and which
 *           came up 3.5 s late on the loaded machine, over the next capture). A window in front is
 *           named by the sidecar (`shot.owner`: process file name and class, never a title): Start,
 *           Search, the notification centre, quick settings, Task view get up to SHELL_WAIT_MS to go,
 *           then the overlay is brought forward again; still there = the fallback, NOT counted
 *           towards "in a row". Windows' snip in front = cancelled at once, not opened twice, and the
 *           card says whether it was Mantle's own late fallback or the press reaching Windows too
 *           (sidecar `keylate`: the keyboard hook got the key past LowLevelHooksTimeout).
 *   selection -> sidecar `shot.copy` puts a CF_DIB cut from the SAME frozen frame (not a second grab)
 *            on the clipboard: no PNG in between (lane shotspeed, 2026-09-27: "copied" was 863 ms
 *            p50 after the selection while main decoded and re-encoded the saved PNG; see commit()).
 *            THAT IS ALL BY DEFAULT (lane shot-save, 2026-10-14; Owen: "screenshots shouldnt all get
 *            saved to my computer automatically only if i press a button in the popup that says
 *            save. they should just be copied to clipboard"). The card comes up bottom right for
 *            ~7 s (paused while the pointer or the keyboard is on it) saying "Screenshot copied",
 *            with a Save button; the frozen frame is HELD (the sidecar's one DIB + its BMPs) while
 *            the card is up, so Save sends `shot.save` for the very box that was copied: it crops
 *            the same frame and writes "Screenshot YYYY-MM-DD HHMMSS.png" (the selection's time,
 *            as Windows names it) into the save folder (80-150 ms PNG encode for a full 1080p
 *            screen), and the card says "Saved to Screenshots" with Show in folder. The card going
 *            (timeout, close, Esc, a new capture, the backstop) releases the frame (dropHeld):
 *            nothing is kept past the card. The card's picture is drawn from the frame's BMPs
 *            (thumbPieces), so no PNG is made for it either. The option "Also save every
 *            screenshot automatically" (autoSave, default OFF) brings back the old behaviour:
 *            shot.save right behind shot.copy, and the card says where it went.
 *
 * NO SILENT FAILURES: a grab that fails shows the card with the reason; a save that fails (the
 * Save button, or autoSave) says "Not saved: <why>" and the card stays with Save to try again; a
 * clipboard that refuses says "Not copied: <why>" and offers Save (a sidecar without shot.copy too);
 * a sidecar without the shot.* commands takes the feature DOWN (health false: the chords go back
 * to Windows and the strip says why).
 *
 * TESTS (--test): windows stay HIDDEN (never in front of Owen, never focused); the clipboard is a
 * sink that records sizes only (shot.copy runs as a dryRun: its memory block is built, dumped to the
 * test folder as a BMP, and freed, never handed to Windows); saves go to a %TEMP% folder (the passive sidecar refuses anything
 * else anyway). MANTLE_SHOT_TEST (read ONLY in --test) is a JSON list of steps, one per chord, that
 * the feature plays INSIDE the overlay page (synthetic pointer/key events), e.g.
 *   [{"synthetic":true,"drag":[100,80,500,300]},{"synthetic":true,"mode":"window","click":[10,10]},{"key":"Escape"}]
 * and MANTLE_SHOT_TEST_DIR is where its saves go. lib/features/screenshot.test.js --electron uses both.
 * More steps: {"move":[x,y]} rests the pointer there (CSS px) before the keys, {"hold":true} leaves the capture open (the stuck case), {"blur":true} fires the
 * window's own 'blur', {"probe":"corner"} runs the REAL reveal (SetWindowPos TOPMOST, full size)
 * with only ONE pixel on the monitor (its top-right corner) and no focus asked for, measures it,
 * and so ends in the real fallback path (Windows' snip is never opened by a test).
 * MANTLE_SHOT_TEST_TIMEOUT_MS shortens the 60 s hard timeout (test only).
 *
 * COPY TEXT (ocr lane, 2026-09-27): a fourth mode on the overlay's bar (T). The drag is a
 * Rectangle's, but commitText() asks the sidecar for `shot.ocr` - Windows' own OCR
 * (Windows.Media.Ocr, local, offline) over the SAME frozen frame, cropped in memory - and puts the
 * shaped text (_ocr-text.js) on the clipboard as plain text; the card says "Copied 3 lines" with
 * the first ~40 characters, or "No text found in that area" and copies nothing. THE ROUTE, measured
 * on Owen's machine: in-process WinRT in the sidecar (sidecar/Ocr.cs, the split-winmd build) reads
 * a 3-line crop in 10-25 ms (68 ms for a 1158x288 one) at 2x; powershell.exe loading the same WinRT
 * types took 420-450 ms wall per recognition AND needed the crop as a PNG on disk, so it was not
 * used. Languages: whatever Windows has an OCR pack for (en-US here); none, or a sidecar without
 * `ocr.status`, and the Copy text button is disabled with that reason (NO SILENT FAILURES). Never
 * remembered as the next capture's mode. PRIVACY: the text and pixels never reach the log (counts
 * and timings only, X.logLine) or any file; --test is a DRY RUN (no clipboard) whose TESTSHOT line
 * has counts and, given MANTLE_SHOT_TEST_EXPECT, a similarity score - never the text. Steps may
 * carry {"text":[...],"textAt":{x,y},"textPx":n,"textPad":n} to draw known text into the synthetic frame.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const G = require('../../ui/screenshot/geometry.js');
const X = require('./_ocr-text.js');
const IDLE = require('./_idle-unload.js');
const raiseWin = require('../raise');

const FRAME_DIR = path.join(os.tmpdir(), 'mantle-shot');
const READY_TIMEOUT_MS = 2500;     // then the pages that ARE ready go up; none ready = a failure card (the first,
                                   // cold capture of a --test start took 2.2 s to grab, 2026-09-24)
const VERIFY_MS = 800;             // moved on screen -> measured in front AND holding the keyboard, or Windows' snip
const VERIFY_STEP_MS = 100;
const KB_FIRST_MS = 250;           // the parked overlay takes the keyboard first; on screen by now regardless
const PIXEL_SETTLE_MS = 200;       // the canary's pixel is read again for this long after the page painted it
const PIXEL_STEP_MS = 16;
const REFOCUS_AT_MS = 300;         // not foreground by now: the sidecar's focus ladder once more
const BLUR_GRACE_MS = 150;         // focus hopping between two monitors' overlays is not a loss
const EARLY_BLUR_MS = 1500;       // the keyboard taken away sooner than this = could not come forward (fallback)
const HARD_TIMEOUT_MS = 60000;     // no capture stays open longer than this, whatever happened
const FALLBACK_URI = 'ms-screenclip:';   // Windows' own Snipping overlay (what Win+Shift+S does without Mantle)
const FALLBACKS_BEFORE_DOWN = 2;   // this many in a row: the chords go back to Windows (health false)
const RETAKE_MS = [30000, 120000, 600000];   // down: the keys are taken back after these, then every 10 min
const SHELL_WAIT_MS = 1000;        // Windows' own shell UI in front (Start, Search, ...): this long for it to go
const OWN_SNIP_MS = 20000;         // Windows' snip in front this soon after Mantle opened it = Mantle's own, late
const LATE_KEY_MS = 5000;          // a `keylate` from the hook this recent explains Windows' snip in front
const CARD_LIFE_MS = 5000;         // a card with nothing to act on (Copy text, Windows' snip stood in, a failure)
const CARD_SAVE_LIFE_MS = 7000;    // a picture card: long enough to reach Save (paused while hovered or focused)
const CARD_BACKSTOP_GRACE_MS = 25000;   // the card page never said it went: main parks it this long after its life
const CARD_HOLD_MS = 10 * 60000;   // held (pointer or keyboard on it): the backstop waits this long, the frame with it
const CARD_MARGIN = 12;            // the card page's own margin around the card (card.css)
const MODES = ['rect', 'window', 'full'];      // remembered for the next capture (settings 'mode')
const ALL_MODES = MODES.concat('text');     // + Copy text, which never is: Win+Shift+S always opens as a screenshot
const OCR_TIMEOUT_MS = 20000;              // shot.ocr: 10-70 ms measured (Ocr.cs), so this is only a backstop
const OCR_RECHECK_MS = 30000;              // Copy text unavailable: asked again at the next capture, at most this often

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

/* Windows' own shell hosts (process file names, lower case): their windows are transient UI that
   sits in a band above every TOPMOST window, so one in front of the overlay is not Mantle failing. */
const SHELL_HOSTS = {
  'screenclippinghost.exe': 'Windows\' own Snipping overlay',
  'startmenuexperiencehost.exe': 'Start',
  'searchhost.exe': 'Windows Search', 'searchapp.exe': 'Windows Search', 'searchui.exe': 'Windows Search',
  'shellexperiencehost.exe': 'the notification centre',
  'shellhost.exe': 'Quick settings',
  'textinputhost.exe': 'the touch keyboard / emoji panel',
  'lockapp.exe': 'the lock screen',
};
const EXPLORER_UI = { XamlExplorerHostIslandWindow: 'Task view / Alt+Tab', MultitaskingViewFrame: 'Task view' };
const CORE_WINDOW = 'Windows.UI.Core.CoreWindow';

/**
 * Is the window in front of the overlay Windows' own shell UI? `exe` = the process file name
 * (sidecar `shot.owner`; '' when it could not be read), `cls` = its root class. A CoreWindow whose
 * process is unknown is still the shell's (a top-level CoreWindow is Start, Search, the notification
 * centre or the snip; a UWP app's sits inside an ApplicationFrameWindow). -> { exe, what, snip } | null.
 */
function shellHost(exe, cls) {
  const e = String(exe || '').toLowerCase();
  if (SHELL_HOSTS[e]) return { exe: String(exe), what: SHELL_HOSTS[e], snip: e === 'screenclippinghost.exe' };
  if (e === 'explorer.exe' && EXPLORER_UI[cls]) return { exe: String(exe), what: EXPLORER_UI[cls], snip: false };
  if (!e && cls === CORE_WINDOW) return { exe: null, what: 'a Windows shell window (Start, Search, the notification centre or Windows\' snip; its process could not be named)', snip: false };
  return null;
}

/** The delay before the keys are taken back, after `n` earlier tries this outage (30 s, 2 min, 10 min, 10 min...). */
function retakeDelay(n) { return RETAKE_MS[Math.max(0, Math.min(n | 0, RETAKE_MS.length - 1))]; }

function clockAt(t) { const d = new Date(t); return [d.getHours(), d.getMinutes(), d.getSeconds()].map((x) => String(x).padStart(2, '0')).join(':'); }
function span(ms) { return ms >= 60000 ? `${Math.round(ms / 60000)} min` : `${Math.round(ms / 1000)} s`; }

/** The strip / tray / log words while down: why, and when Mantle takes the keys back by itself. */
function downWords(base, n, at, delay) {
  return `${base}, so Win+Shift+S and PrintScreen are Windows' own for now. Mantle takes them back by itself at ${clockAt(at)} ` +
    `(in ${span(delay)}, try ${n + 1}); the next press then proves the overlay can come forward. Turning the switch off and on takes them back now`;
}

/**
 * Why Windows' own snip (ScreenClippingHost.exe) is in front of Mantle's overlay. `own` = the
 * fallback snip Mantle itself opened ({seq, ago} ms), `late` = the keyboard hook's last `keylate`
 * ({words, ago}), each only when recent enough to explain it.
 */
function snipWords(own, late) {
  if (late && late.ago <= LATE_KEY_MS) return `Windows' own Snipping overlay is in front: the press reached Windows too (${late.words})`;
  if (own && own.ago <= OWN_SNIP_MS) return `Windows' own Snipping overlay is in front: the one Mantle opened ${(own.ago / 1000).toFixed(1)} s earlier, ` +
    `when capture #${own.seq}'s overlay could not come forward, came up late over this capture`;
  return 'Windows\' own Snipping overlay is in front: the press reached Windows too (a key leaked past Mantle\'s keyboard hook), so Windows opened its own snip for it';
}

/* ---- plain words (lane capture-shot, 2026-09-29) ---------------------------------------------------
   The card and the overlay are read by someone who is not Owen: no command names, exception types,
   error codes, window classes or paths on screen ("Not saved: shot.save: the folder C:\... could not be
   made (UnauthorizedAccessException: ...)" was the card before). Each failure still says WHY and what
   to do next, in words; the log keeps the exact reason, minus paths (noPaths). */

/** `s` with every Windows path taken out: mantle.log never carries a folder or a file name. */
function noPaths(s) {
  return String(s == null ? '' : s)
    .replace(/'[^'\r\n]*[\\/][^'\r\n]*'/g, 'a path')       // .NET: "Access to the path 'C:\...' is denied."
    .replace(/"[^"\r\n]*[\\/][^"\r\n]*"/g, 'a path')
    // Unquoted: folders may hold spaces ("C:\My Shots\x.png"), the last part may not (the words after it stay).
    .replace(/(^|[\s(])[A-Za-z]:[\\/](?:[^\\/\r\n,;)]+[\\/])*[^\\/\s,;)]*/g, '$1a path')
    .replace(/(^|[\s(])\\\\(?:[^\\/\r\n,;)]+[\\/])*[^\\/\s,;)]*/g, '$1a path')   // UNC
    .replace(/[^\s'"(]*\\[^\s'",;)]*/g, 'a path')                 // anything else with a backslash in it
    .replace(/a path( a path)+/g, 'a path');
}

/* Most specific first; the first match wins. */
const PLAIN = [
  [/older build|build:sidecar|no shot\.\w+ command|no ocr\.status command|unknown command/i, 'part of Mantle is out of date: restart Mantle to update it'],
  [/not been checked yet|still starting|sidecar (is )?(down|not running)|sidecar process/i, 'part of Mantle is still starting: try again in a few seconds'],
  [/no OCR language/i, 'Windows has no text recognition installed: add a language in Windows Settings > Time & language > Language & region'],
  [/built without WinRT/i, 'Windows\' text recognition cannot be reached by this copy of Mantle'],
  [/OCR/i, 'Windows could not read the text in that area: try again'],
  [/is gone|was released|replaced it/i, 'the capture had already closed: take it again'],
  [/UnauthorizedAccess|access (to [^,;]*)?(is )?denied|0x80070005|read-only/i, 'Windows did not let Mantle save there: pick another folder in Mantle Settings > Screenshots'],
  [/disk is full|not enough space|0x80070070|0x80070027/i, 'the disk is full: free some space and take it again'],
  [/DirectoryNotFound|could not find a part of the path|could not be made|not a usable path|PathTooLong|network name|network path/i, 'the screenshots folder could not be reached: pick another one in Mantle Settings > Screenshots'],
  [/999 (files named|screenshots with this name)/i, 'that folder already has 999 screenshots taken in the same second'],
  [/holding the clipboard|clipboard could not be reached|clipboard did not answer|clipboard thread/i, 'another app was using the clipboard: take it again'],
  [/timed out|timeout|did not answer within/i, 'Mantle took too long to answer: take it again'],
  [/no memory|could not be allocated|OutOfMemory/i, 'there was not enough memory for a picture this big'],
  [/outside the capture/i, 'the selection was off the screen'],
  [/too small/i, 'the selection was too small'],
  [/BitBlt|screen DC|virtual screen|listed no monitors|frame folder|memory DC|could not be captured/i, 'Windows did not let Mantle read the screen: try again'],
];

/** A failure's reason for the card, in plain words (the raw one goes to the log). Never empty. */
function plainError(err) {
  const e = String(err == null ? '' : err).trim();
  if (!e) return 'no reason was given';
  for (const [re, words] of PLAIN) if (re.test(e)) return words;
  // Not one we know: the words themselves, without a command prefix, exception type, code or path.
  const t = noPaths(e).replace(/^shot\.\w+:\s*/, '').replace(/\b[A-Z]\w*Exception:\s*/g, '')
    .replace(/\s*\((HRESULT |Win32 error |error )?0x[0-9A-F]{8}\)/gi, '').replace(/\s*\(?(HRESULT |Win32 error )0x?[0-9A-F]+\)?:?/gi, '')
    .replace(/\s+/g, ' ').trim();
  return t || 'no reason was given';
}

/** "the notification centre" -> "The notification centre" (a card line starts a sentence). */
function cap(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }

/**
 * The card when Windows' own snip stood in for Mantle's overlay (fallback()), in one short line:
 * `host` = shellHost() of the window in front (null: Mantle could not come forward by itself),
 * `snipUp` = Windows' snip itself is the one in front. The long reason is the log's.
 */
function fallbackCard(host, snipUp) {
  if (snipUp) return { title: 'Windows\' Snipping Tool is open', note: 'It was already in front, so Mantle\'s capture stepped aside' };
  const who = host ? (host.exe ? cap(host.what) : 'A Windows panel') : 'Another window';
  return { title: 'Windows\' Snipping Tool opened instead', note: `${who} stayed in front of Mantle's capture` };
}

/** Ask Windows' OCR again? Only while it is unavailable for a reason that can pass (not "none
 *  installed" forever: a language can be added any time), at most every OCR_RECHECK_MS. */
function ocrRecheck(ocr, lastAt, now) {
  return !!ocr && !ocr.available && !/built without WinRT/i.test(String(ocr.why || '')) && (now - (lastAt || 0)) >= OCR_RECHECK_MS;
}

/**
 * The card's picture of a selection, without encoding anything: the parts of the frozen frame's
 * per-monitor BMPs (sidecar shot.grab `monitors[].file`, each covering `frame`, physical virtual-
 * screen px) that the selection `rect` covers. Each piece: draw (sx, sy, sw, sh) of its file at
 * (dx, dy) in a canvas of rect's size (card.js). A selection across two monitors is two pieces.
 */
/**
 * RAW PIXELS: a frame BMP's bytes -> { w, h, data } where data (a view, no copy) is exactly an
 * ImageData's RGBA bytes (sidecar Screenshot.cs RAW PIXELS). A file of the wrong size gives
 * { error } instead, so the page decodes the BMP the old way rather than drawing garbage.
 */
function rawPixels(buf, meta) {
  const w = meta && Number(meta.w), h = meta && Number(meta.h), off = meta && Number(meta.offset);
  if (!(w > 0 && h > 0 && off >= 0)) return { error: 'the sidecar did not say the size of the frame' };
  const n = w * h * 4;
  if (!buf || buf.length < off + n) return { error: `the frame file is ${buf ? buf.length : 0} bytes, not ${off + n}` };
  return { w, h, data: new Uint8Array(buf.buffer, buf.byteOffset + off, n) };
}

function thumbPieces(rect, monitors, toUrl) {
  const out = [];
  if (!rect || !(rect.w > 0 && rect.h > 0)) return out;
  for (const m of monitors || []) {
    const f = m && m.frame;
    if (!m.file || !f || !(f.w > 0 && f.h > 0)) continue;
    const l = Math.max(rect.x, f.x), t = Math.max(rect.y, f.y);
    const r = Math.min(rect.x + rect.w, f.x + f.w), b = Math.min(rect.y + rect.h, f.y + f.h);
    if (r <= l || b <= t) continue;
    out.push({ url: toUrl(m.file), sx: l - f.x, sy: t - f.y, sw: r - l, sh: b - t, dx: l - rect.x, dy: t - rect.y });
  }
  return out;
}

/** The card's life: a picture card holds a Save button, so it stays longer (MANTLE_SHOT_TEST_CARD_MS: tests only). */
function cardLife(info, testMs) {
  if (testMs > 0) return testMs;
  return info && info.canSave ? CARD_SAVE_LIFE_MS : CARD_LIFE_MS;
}

/* ---- the feature --------------------------------------------------------------------------------- */

module.exports = {
  name: 'screenshot',
  label: 'Screenshots (Win+Shift+S, PrintScreen)',
  defaultOn: true,
  rest: true,                         // its window(s) close while a game runs (lib/features.js restAll)
  chords: ['Win+Shift+S', 'PrintScreen'],
  observe: [],
  // Mantle Settings > Mantle (lane settings, 2026-09-28). Both were read at each capture already
  // (commit / the overlay's first mode); saveDir had no way in before but hand-editing the file.
  options: [
    { key: 'mode', label: 'Start in', help: 'The mode Win+Shift+S opens in; the last one picked is remembered', type: 'choice',
      choices: [{ value: 'rect', label: 'Rectangle' }, { value: 'window', label: 'Window' }, { value: 'full', label: 'Full screen' }], default: 'rect' },
    // lane shot-save (2026-10-14): a capture is only COPIED unless Owen presses Save on the card; this
    // brings back saving every one (default off: the default never got worse for anyone).
    { key: 'autoSave', label: 'Also save every screenshot automatically', help: 'Off: a screenshot is copied, and the card\'s Save button saves it. On: every screenshot is also saved as a PNG', type: 'bool', default: false },
    { key: 'saveDir', label: 'Save screenshots to', help: 'Where the card\'s Save button (and saving automatically) puts the PNG', type: 'folder', default: null, defaultLabel: 'Windows\' Screenshots folder' },
  ],
  _test: { fileUrl, parkSpot, cardSpot, saveDirFor, missingCommand, summary, judgeShown, secondChord, blurVerdict, shellHost, retakeDelay, downWords, snipWords, clockAt,
    noPaths, plainError, fallbackCard, ocrRecheck, OCR_RECHECK_MS, thumbPieces, rawPixels, cardLife, CARD_LIFE_MS, CARD_SAVE_LIFE_MS, CARD_HOLD_MS,
    FRAME_DIR, EARLY_BLUR_MS, VERIFY_MS, HARD_TIMEOUT_MS, FALLBACK_URI, MODES, ALL_MODES, RETAKE_MS, SHELL_WAIT_MS, OWN_SNIP_MS, LATE_KEY_MS },

  install(ctx) {
    const { BrowserWindow, screen, clipboard, shell } = require('electron');
    const W = require('../windows');   // noDragHandles / hitZones (lane tbdrift)
    const test = !!ctx.flags.test;
    const overlays = new Map();        // display id -> { win, hwnd, loaded, displayId, park }
    let card = null;                   // { win, hwnd, loaded, shown, info, backstop }
    // The capture on the card, kept for its Save button: { seq, grab, box, name, w, h, saving }. Its
    // frozen frame stays in the sidecar until the card goes (dropHeld), never longer.
    let held = null;
    let sess = null;
    let seqN = 0;
    let stopped = false;
    let folder = null;
    let problem = null;                // why the feature is down, or null
    let downWhy = null;                // down because the overlay could not come forward FALLBACKS_BEFORE_DOWN times in a row
    let fallbacksInARow = 0;
    let retakes = 0;                   // keys taken back by themselves this outage (retakeDelay); a verified capture resets it
    let retakeTimer = null;
    let trial = null;                  // taken back on trial ({ base }): one failure sends them back at once
    let ownSnip = null;                // the Windows snip Mantle opened last: { seq, at } (snipWords)
    let lastLate = null;               // the keyboard hook's last `keylate` event: { words, at }
    let ownerMissingSaid = false;      // "the sidecar has no shot.owner" is logged once
    let rebuildTimer = null;
    let steps = [];
    let testDir = null;
    const sink = { image: null, text: null, ocr: null };   // --test: what WOULD have gone on the clipboard
    // Copy text: can Windows' OCR be reached (sidecar `ocr.status`, asked when the sidecar is ready)?
    // Unavailable is never silent: the overlay's Copy text button carries this `why`.
    let ocr = { available: false, why: 'Windows’ OCR has not been checked yet (the sidecar is still starting)' };
    let ocrAskedAt = 0;                // checkOcr(): when it last asked, and the answer in flight
    let ocrAsking = null;

    /* THE PICTURE'S CLIPBOARD WRITE is the sidecar's (shot.copy, in commit()): Electron 44 has no
       synchronous writeImage (the live bug of 2026-09-24), and its async write([ClipboardItem])
       wanted an image/png Blob, which cost a PNG decode + re-encode on this thread (lane shotspeed). */

    if (test) {
      try { steps = JSON.parse(process.env.MANTLE_SHOT_TEST || '[]'); } catch (err) { ctx.log(`MANTLE_SHOT_TEST is not JSON (${err.message}); no scripted steps`); }
      if (!Array.isArray(steps)) steps = [];
      testDir = process.env.MANTLE_SHOT_TEST_DIR || null;
    }
    // MANTLE_SHOT_TEST_CARD_MS (read ONLY in --test): the card's life, so a test can see it time out.
    const testCardMs = test ? Number(process.env.MANTLE_SHOT_TEST_CARD_MS) || 0 : 0;
    // MANTLE_SHOT_TEST_TIMEOUT_MS (read ONLY in --test) shortens the hard timeout so a test can see it fire.
    const hardTimeoutMs = (test && Number(process.env.MANTLE_SHOT_TEST_TIMEOUT_MS) > 0) ? Number(process.env.MANTLE_SHOT_TEST_TIMEOUT_MS) : HARD_TIMEOUT_MS;
    // MANTLE_SHOT_TEST_RETAKE_MS (read ONLY in --test): "1500,3000" replaces 30 s / 2 min / 10 min.
    const testRetake = test ? String(process.env.MANTLE_SHOT_TEST_RETAKE_MS || '').split(',').map(Number).filter((n) => n > 0) : [];
    const retakeMs = (n) => (testRetake.length ? testRetake[Math.min(n, testRetake.length - 1)] : retakeDelay(n));

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
      const blockers = [];               // foreign windows at the centre or holding the keyboard: { hwnd, cls }
      const ours = new Set(allHwnds().map(String));
      const block = (hw, cls) => { if (hw && hw !== '0' && !ours.has(hw) && !blockers.some((b) => b.hwnd === hw)) blockers.push({ hwnd: hw, cls: cls || '' }); };
      let front = true;
      let keyboard = false;
      for (const o of shown) {
        const m = measure(o, opts && opts.at);
        if (!m) return { ok: false, front: false, keyboard: false, why: `the window checks are unavailable (${natReason || 'no koffi'})`, facts, blockers };
        block(m.hit, m.hitCls);
        block(m.fg, m.fgCls);
        const want = { hwnd: o.hwnd, rect: (opts && opts.rect) || o.monitor, keyboard: false };
        const j = judgeShown(m, want);
        facts.push({ monitor: o.monitor.index, visible: m.visible, cloaked: m.cloaked, rect: m.rect, hitUs: m.hit === String(o.hwnd), hitCls: m.hitCls || undefined, fgUs: m.fg === String(o.hwnd), error: m.error });
        if (!j.front) { front = false; why.push(`monitor ${o.monitor.index}: ${j.why}`); }
        if (j.keyboard) keyboard = true;
        s.fgCls = m.fgCls;
      }
      if (!keyboard) why.push(`Windows did not give any overlay the keyboard (the foreground is class ${s.fgCls || '?'})`);
      return { ok: front && keyboard, front, keyboard, why: why.join('; '), facts, blockers };
    }

    /**
     * Name the processes behind windows in front of the overlay (sidecar `shot.owner`), once per
     * window per capture, into s.owners (hwnd -> { exe, cls }). Asynchronous: the verify loop reads
     * what has arrived. A sidecar without the command (an older build) or a timeout leaves exe ''
     * with the reason, so shellHost() judges by class alone.
     */
    function lookOwners(s, blockers) {
      if (!s.owners) s.owners = new Map();
      const fresh = (blockers || []).filter((b) => !s.owners.has(b.hwnd));
      if (!fresh.length) return Promise.resolve();
      for (const b of fresh) s.owners.set(b.hwnd, null);
      return ctx.sidecar.send('shot.owner', { windows: fresh.map((b) => b.hwnd) }, { timeoutMs: 1000 }).then((r) => {
        const rows = r.ok && r.result && Array.isArray(r.result.owners) ? r.result.owners : [];
        if (!r.ok && missingCommand(r.error) && !ownerMissingSaid) {
          ownerMissingSaid = true;
          ctx.log('the sidecar has no shot.owner command (an older build: npm run build:sidecar), so a window in front of the overlay is judged by its class alone (a top-level CoreWindow counts as Windows\' shell UI; Windows\' snip cannot be told apart)');
        }
        for (const b of fresh) {
          const row = rows.find((x) => String(x.window) === b.hwnd);
          s.owners.set(b.hwnd, row && row.exists !== false
            ? { exe: row.exe || '', cls: row.cls || b.cls, why: row.why || null }
            : { exe: '', cls: b.cls, why: r.ok ? 'the window was gone' : `shot.owner: ${r.error}` });
        }
      });
    }
    /** The first blocker that is Windows' own shell UI, from what lookOwners() has named so far. */
    function shellOf(s, blockers) {
      for (const b of blockers || []) {
        const o = s.owners && s.owners.get(b.hwnd);
        if (!o) continue;
        const h = shellHost(o.exe, o.cls || b.cls);
        if (h) return h;
      }
      return null;
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
      else if (trial) ctx.health(true, `Win+Shift+S and PrintScreen were taken back from Windows by themselves (try ${retakes}) after: ${trial.base}; the next press proves the overlay can come forward`);
      else ctx.health(true);
    }

    /**
     * SELF-HEALING: the keys go back to Windows with WHEN Mantle takes them back said in words, and
     * a timer that does it (while they are Windows', no press ever reaches Mantle to trigger it).
     */
    function goDown(base) {
      const delay = retakeMs(retakes);
      downWhy = downWords(base, retakes, Date.now() + delay, delay);
      trial = null;
      ctx.log(downWhy);
      if (test) ctx.log(`TESTSHOT down ${JSON.stringify({ tries: retakes, retakeMs: delay })}`);
      health();
      clearTimeout(retakeTimer);
      retakeTimer = setTimeout(() => retake(base, delay), delay);
    }
    function retake(base, after) {
      retakeTimer = null;
      if (stopped || !downWhy || !ctx.enabled()) return;   // switched off: switching on clears it (clearDown)
      retakes++;
      trial = { base };
      downWhy = null;
      fallbacksInARow = 0;
      ctx.log(`took Win+Shift+S and PrintScreen back from Windows by itself, ${span(after)} after they went back (try ${retakes}): ` +
        `the next press proves the overlay can come forward; if it cannot, they go back to Windows at once and Mantle tries again in ${span(retakeMs(retakes))}`);
      if (test) ctx.log(`TESTSHOT retake ${JSON.stringify({ tries: retakes })}`);
      health();
    }
    function clearDown(why) {
      clearTimeout(retakeTimer);
      retakeTimer = null;
      const was = downWhy || trial;
      downWhy = null;
      trial = null;
      retakes = 0;
      fallbacksInARow = 0;
      health();
      if (was) ctx.log(why);
    }

    /* -- windows ------------------------------------------------------------------------------------ */

    function baseWindow(extra) {
      const win = new BrowserWindow(Object.assign({
        show: false, frame: false, transparent: true, skipTaskbar: true, hasShadow: false,
        // NOT resizable (2026-09-27, lane tbdrift): a resizable frameless window answers the hit test
        // with resize codes on the 5 DIP inside every edge and corner (lib/windows.js noDragHandles),
        // so a selection dragged from a screen corner or edge started a WINDOW resize instead of
        // reaching the page. It is sized by a raw SetWindowPos (place()), so noDragHandles(rawSized)
        // below lifts the min = max pin Electron puts on a non-resizable window.
        resizable: false, thickFrame: false, fullscreenable: false, minimizable: false, maximizable: false,
        backgroundColor: '#00000000',
        // WS_EX_TOOLWINDOW: never in Alt+Tab, even while parked and "shown".
        type: 'toolbar',
        webPreferences: {
          preload: ctx.preload, contextIsolation: true, sandbox: true, nodeIntegration: false,
          spellcheck: false, backgroundThrottling: false,
        },
      }, extra));
      W.noDragHandles(win, { rawSized: true });
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
      // --test: what the hit test answers at each overlay's edges and corners (a question to our own
      // windows, nothing moves); "none" = a drag from a screen corner or edge reaches the page
      if (test) {
        const says = [...overlays.values()].map((o) => { try { return W.dragHandles(W.hitZones(o.win)) || 'none'; } catch (e) { return `not measured (${e.message})`; } });
        ctx.log(`overlay drag handles at the edges and corners: ${says.join(' | ')}`);
      }
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
      const win = baseWindow({ x: Math.round(dp.x), y: Math.round(dp.y), width: 400, height: 150, alwaysOnTop: !test, focusable: true, title: 'Mantle Screenshot' });
      const c = { win, hwnd: hwndOf(win), loaded: false, shown: false, info: null, backstop: null, park, made: Date.now(), pending: null, parked: test };
      // A card made on demand (lane ramdiet) takes its first info only once its page listens AND
      // (live) it has been parked and shown there, or ready-to-show would park it after cardShown.
      const flush = () => {
        if (!c.loaded || !c.parked || win.isDestroyed()) return;
        if (c.made) { ctx.log(`the card window was made in ${Date.now() - c.made} ms (page loaded${test ? '' : ', parked'})`); c.made = 0; }
        if (c.pending) { const info = c.pending; c.pending = null; if (card === c) showCard(info); }
      };
      win.webContents.on('did-finish-load', () => { c.loaded = true; flush(); });
      watchPage(win, 'screenshot card', () => { card = null; setTimeout(() => { if (!stopped && !card) card = createCard(); }, 1000); });
      win.loadFile(ctx.page('card.html'));
      if (!test) win.once('ready-to-show', () => { if (!win.isDestroyed()) { place(c, park, false); win.showInactive(); c.parked = true; flush(); } });
      cardIdle.touch();
      return c;
    }

    /* The card is made on demand and goes after IDLE.IDLE_UNLOAD_MS unused (lane ramdiet): it is only
     * ever shown after a capture, and start() makes it the moment the overlay is up, so its page
     * loads while Owen drags his box. A failure card before that waits for its page (flush above). */
    function ensureCard() {
      if (stopped) return null;
      if (!card || card.win.isDestroyed()) card = createCard();
      return card;
    }
    const cardIdle = IDLE.watchIdle({
      what: 'the screenshot card', log: ctx.log, test,
      busy: () => !!sess || !!(card && (card.shown || card.pending)),
      unload: () => {
        if (!card) return false;
        const c = card;
        card = null;
        clearTimeout(c.backstop);
        try { if (!c.win.isDestroyed()) c.win.destroy(); } catch (_) { /* gone */ }
        return true;
      },
    });

    function parkCard(why) {
      dropHeld(why);                       // whatever the card's state: its frame never outlives it
      if (!card || !card.shown) return;
      card.shown = false;
      clearTimeout(card.backstop);
      ctx.push(card.win, 'screenshot.cardClear', { why });
      if (!test) place(card, card.park, false);
      cardIdle.touch();
    }

    /** The card's capture is let go: its frozen frame (the sidecar's DIB and BMPs) is released. The
     *  release names its grab, so it can never throw away a newer capture's frame. */
    function dropHeld(why) {
      const h = held;
      if (!h) return;
      held = null;
      ctx.sidecar.send('shot.release', { grab: h.grab }, { timeoutMs: 3000 }).then((rel) => {
        if (!rel.ok) ctx.log(`#${h.seq}: the frozen frame could not be released (${rel.error}); the next capture replaces it`);
        if (test) ctx.log(`TESTSHOT card released ${JSON.stringify({ seq: h.seq, why: String(why || ''), released: !!(rel.ok && rel.result && rel.result.released), filesDeleted: rel.ok && rel.result ? rel.result.filesDeleted : null, saved: !!h.saved })}`);
      });
    }

    /** The backstop: the page owns the card's timer, this only parks a card whose page never said it went. */
    function armBackstop(ms) {
      if (!card) return;
      clearTimeout(card.backstop);
      card.backstop = setTimeout(() => parkCard('backstop: the card never said it was dismissed'), ms);
    }

    function showCard(info) {
      if (held && held.seq !== info.seq) dropHeld('another card replaced it');
      ensureCard();
      if (!card || card.win.isDestroyed()) { ctx.log(`no card window to show: ${info.note || info.saveError || info.copyError || info.name}`); dropHeld('no card window'); return; }
      if (!card.loaded || !card.parked) { card.pending = info; return; }
      cardIdle.touch();
      card.info = Object.assign({ lifeMs: cardLife(info, testCardMs) }, info);
      card.shown = true;
      armBackstop(card.info.lifeMs + CARD_BACKSTOP_GRACE_MS);
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
        ctx.sidecar.send('shot.grab', Object.assign({ dir: FRAME_DIR, exclude: allHwnds(), synthetic: !!(step && step.synthetic) },
          // --test only: known text drawn into the SYNTHETIC frame, for the Copy text round trip.
          step && step.synthetic && Array.isArray(step.text) ? { text: step.text, textAt: step.textAt, textPx: step.textPx, textPad: step.textPad } : {},
          // --test only: a screen-like picture (under %TEMP%) tiled over the SYNTHETIC frame, for copy timings.
          step && step.synthetic && step.fill ? { fill: step.fill } : {}), { timeoutMs: 5000 }),
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
        ctx.log(`#${s.seq} ${chord}: ${noPaths(why)}`);
        clearTimeout(s.hardTimer);
        sess = null;
        showCard({ seq: s.seq, title: 'Screenshot not taken', note: cap(plainError(why)), copied: false });
        return;
      }
      const r = g.result;
      s.grab = r.grab;
      const fgExe = fg && fg.ok && fg.result ? path.win32.basename(String(fg.result.exe || '')) : '';
      const fgHost = shellHost(fgExe, '');
      if (fgHost && fgHost.snip) {
        // Windows' own snip is ALREADY in front (it sits above every TOPMOST window): Mantle's
        // overlay would come up under it, so it does not, and nothing is counted.
        const why = snipWords(ownSnip && { seq: ownSnip.seq, ago: Date.now() - ownSnip.at }, lastLate && { words: lastLate.words, ago: Date.now() - lastLate.at });
        ctx.log(`#${s.seq} ${chord}: ${why}; Mantle's overlay did not open under it (not counted as a failure)`);
        endSession('Windows\' snip is in front', { giveBack: false });
        release(s);
        showCard(Object.assign({ seq: s.seq, copied: false }, fallbackCard(fgHost, true)));
        return;
      }
      s.stats = { seq: s.seq, chord, monitors: r.monitors, windows: r.windows.length, grabMs: r.ms.total, bltMs: r.ms.blt, writeMs: r.ms.write };
      // RAW PIXELS (lane speeddebt): each frame's bytes, read here (the OS still has them cached: the
      // sidecar wrote them a moment ago) and handed to its page as an ImageData's bytes, so no browser
      // BMP decode sits on the path (46 ms median, 112 p95 live). A read that fails falls back to the
      // <img> of the same file, with the reason in the log.
      const r0 = Date.now();
      const pix = await Promise.all(r.monitors.map((m) => (m.file && m.pixels && m.pixels.format === 'rgba'
        ? fs.promises.readFile(m.file).then((buf) => rawPixels(buf, m.pixels), (err) => ({ error: err.code || err.message }))
        : Promise.resolve(null))));
      if (sess !== s) return;
      s.stats.readMs = Date.now() - r0;
      pix.forEach((p, i) => { if (p && p.error) ctx.log(`#${s.seq}: monitor ${r.monitors[i].index}'s raw pixels could not be read (${noPaths(p.error)}); its page decodes the picture instead`); });
      const disp = displaysPhys();
      const pairs = G.matchDisplays(r.monitors, disp);
      const cursor = cursorPhys();
      const mode = ALL_MODES.includes(step && step.mode) ? step.mode : (MODES.includes(ctx.settings.get('mode', 'rect')) ? ctx.settings.get('mode', 'rect') : 'rect');
      const ocrNow = ocrForPage();
      if (ocrRecheck(ocr, ocrAskedAt, Date.now())) checkOcr();     // not awaited: the overlay hears it (screenshot.ocr)
      for (const p of pairs) {
        const m = p.monitor;
        const px = pix[r.monitors.findIndex((x) => x.index === m.index)];
        if (!p.display) { ctx.log(`#${s.seq}: monitor ${m.index} (${m.w}x${m.h}) matches no Electron display, so it gets no overlay`); continue; }
        let o = overlays.get(p.display.id);
        if (!o || o.win.isDestroyed()) { o = createOverlay(p.display, disp); overlays.set(p.display.id, o); }
        if (!o.frames) s.cold = true;                 // R7: this page draws its first frame now
        o.frames = (o.frames || 0) + 1;
        o.monitor = m;
        s.used.push(o);
        ctx.push(o.win, 'screenshot.frame', {
          seq: s.seq, grab: r.grab, mode, cursor, ocr: ocrNow,
          src: m.file ? fileUrl(m.file) : null,
          pixels: px && !px.error ? px : null,
          monitor: { index: m.index, x: m.x, y: m.y, w: m.w, h: m.h, scale: m.scale, primary: m.primary },
          windows: r.windows,
          problem: m.file ? null : 'Windows did not give Mantle a picture of this screen, so it cannot be captured here. Use another screen, or press Esc.',
        });
      }
      if (!s.used.length) {
        endSession('no overlay');
        showCard({ seq: s.seq, title: 'Screenshot not taken', note: 'Mantle could not match your screens to the capture: take it again', copied: false });
        return;
      }
      s.readyTimer = setTimeout(() => reveal(s, `${READY_TIMEOUT_MS} ms passed without every page saying ready`), READY_TIMEOUT_MS);
    }

    /**
     * On screen with the pages that have PAINTED their frame, and only those: a page that never
     * got its frame would be a transparent, click-eating window that nothing dismisses. None ready
     * at all is a failure with its reason on the card; a page that is late comes up when it is ready.
     */
    /** R7: one line per capture, written only once it is VERIFIED in front (the check above). */
    function openLine(s) {
      if (s.r7) return;
      s.r7 = true;
      const rd = [...s.ready.values()];
      const painted = rd.length ? Math.max(...rd.map((v) => v.at || 0)) - s.t0 : null;
      const paths = [...new Set(rd.map((v) => v.path || 'BMP decode'))].join(' + ');
      ctx.log(`opened (${s.cold ? 'cold' : 'warm'}) via ${s.chord}: shown ${s.stats ? s.stats.shownMs : '-'}, painted ${painted === null ? '-' : painted}, ` +
        `interactive ${Date.now() - s.t0} ms (grab ${s.stats ? s.stats.grabMs : '-'}, pixels read ${s.stats && s.stats.readMs !== undefined ? s.stats.readMs : '-'}, ` +
        `page ${s.stats ? s.stats.decodeMs : '-'} ms by ${paths})`);
    }

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
      // The card's page loads while Owen selects (lane ramdiet): made now, after the overlay is up.
      setTimeout(() => { if (!stopped) ensureCard(); }, 0);
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
        if (cur && cur.x >= o.monitor.x && cur.x < o.monitor.x + o.monitor.w && cur.y >= o.monitor.y && cur.y < o.monitor.y + o.monitor.h) focusOn = o;
      }
      s.focusOn = focusOn;
      /* THE KEYBOARD FIRST, THEN THE SCREEN (lane mn-raise, 2026-10-12, audit #13). The overlay used to
       * move on screen and only then ask for the foreground (Electron's focus(), which Windows refuses
       * Mantle: the chord was eaten by the sidecar's hook, so this process got no input), so it sat
       * on screen without the keyboard until the ladder at 60 ms and again at 300 ms; "verified" came
       * 450-650 ms after the move, close to VERIFY_MS. Now the PARKED overlay takes the keyboard
       * through raise.keyboard() (the sidecar's ladder) and the overlays move on screen when it has
       * it, or at KB_FIRST_MS: on screen already in front and already taking Esc. */
      const t = Date.now();
      let placed = false;
      const placeAll = () => {
        if (placed || sess !== s) return;
        placed = true;
        clearTimeout(s.kbTimer);
        for (const o of ready) { place(o, o.monitor, true); o.onScreen = true; }
        if (s.kb) ctx.log(`#${s.seq}: keyboard before the move: ${s.kb.ok ? `${s.kb.how}, ${s.kb.ms} ms` : `not yet (${s.kb.words})`}`);
        else ctx.log(`#${s.seq}: moved on screen ${KB_FIRST_MS} ms into taking the keyboard (the ladder goes on)`);
        if (!(s.kb && s.kb.ok)) takeKeyboard(s, focusOn);
        verifyShown(s, { keyboard: true });
      };
      s.kbTimer = setTimeout(placeAll, KB_FIRST_MS);
      raiseWin.keyboard(focusOn.win, { sidecar: ctx.sidecar, hwnd: focusOn.hwnd, timeoutMs: 1500, sidecarPid: ctx.sidecar.pid }).then((k) => {
        if (sess === s && !placed) s.kb = Object.assign({ ms: Date.now() - t }, k);
        placeAll();
      });
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
          clearTimeout(s.canaryPoll);
          s.canaryWait = null;
          ctx.push(o.win, 'screenshot.canary', { seq: s.seq, on: false });
          resolve(res);
        };
        s.canaryWait = (a) => {
          // The page answers two animation frames after painting the dot, but the compositor can
          // put that frame on the glass a frame or more later (under GPU load, more). ONE read at
          // the answer raced that: 11 of the 19 live fallbacks since 10-04 were "its pixels are not
          // on the screen" with every window fact saying in front (lane mn-raise, 2026-10-12). So
          // the dot stays up and the pixel is read again every PIXEL_STEP_MS, for PIXEL_SETTLE_MS.
          clearTimeout(s.canaryTimer);
          s.canaryWait = null;
          const t0 = Date.now();
          const poll = () => {
            if (sess !== s) { done({ seen: false, why: 'the capture closed during the pixel check', page: a }); return; }
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
            const ms = Date.now() - t0;
            if (seen) { done({ seen, why: null, page: a, settleMs: ms }); return; }
            if (ms >= PIXEL_SETTLE_MS) {
              done({ seen, why: `its pixels are not on the screen: by every window measure it is in front, but what the screen shows there is not the overlay (read for ${ms} ms)`, page: a });
              return;
            }
            s.canaryPoll = setTimeout(poll, PIXEL_STEP_MS);
          };
          poll();
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
      let limit = VERIFY_MS;             // + up to SHELL_WAIT_MS while Windows' own shell UI is in front
      let shellSeen = null;              // { h: shellHost(), at } the first time it was named in front
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
          if (!px.seen) j = { ok: false, front: false, keyboard: j.keyboard, why: px.why, facts: j.facts, blockers: j.blockers };
        }
        if (j.ok && s.pixelsSeen) {
          s.verified = true;
          fallbacksInARow = 0;
          if (trial || retakes) clearDown(`#${s.seq} came forward, so taking the keys back worked: Win+Shift+S and PrintScreen are Mantle's again for good`);
          const f = j.facts[0] || {};
          ctx.log(`#${s.seq}: verified in front ${Date.now() - t0} ms after moving on screen: visible, not cloaked, at ${f.rect ? `${f.rect.x},${f.rect.y} ${f.rect.w}x${f.rect.h}` : '?'}, ` +
            `a click at its centre lands on it${opts.keyboard ? ', it has the keyboard' : ''}, and its check pixel is on the screen`);
          openLine(s);
          if (test) ctx.log(`TESTSHOT #${s.seq} verified ${JSON.stringify({ facts: j.facts, page: s.pixelPage })}`);
          return;
        }
        last = j;
        // Windows' own shell UI in front (Start, Search, the snip...): named by the sidecar, never counted.
        lookOwners(s, j.blockers);
        const shell = shellOf(s, j.blockers);
        if (shell && shell.snip) {
          // Windows' snip is up and waiting for Owen: Mantle's overlay steps aside at once, and the
          // snip is not opened a second time.
          fallback(s, j.why, j.facts, { pixelsSeen: !!s.pixelsSeen, page: s.pixelPage || null }, { shell });
          return;
        }
        if (shell && !shellSeen) {
          shellSeen = { h: shell, at: elapsed };
          limit = Math.max(limit, elapsed + SHELL_WAIT_MS);
          ctx.log(`#${s.seq}: ${shell.what}${shell.exe ? ` (${shell.exe})` : ''} is in front of the overlay; waiting up to ${SHELL_WAIT_MS} ms for it to go`);
        } else if (!shell && shellSeen && !shellSeen.goneAt && (j.blockers || []).every((b) => s.owners.get(b.hwnd))) {
          // It went (every window in front now is named, and none is the shell's): bring the overlay
          // forward again (TOPMOST, the keyboard), and give that time to verify.
          shellSeen.goneAt = elapsed;
          limit = Math.max(limit, elapsed + VERIFY_MS / 2);
          ctx.log(`#${s.seq}: ${shellSeen.h.what} went away ${elapsed - shellSeen.at} ms later; brought the overlay forward again`);
          if (!test) {
            for (const o of s.used) if (o.onScreen) place(o, o.monitor, true);
            if (s.focusOn) takeKeyboard(s, s.focusOn);
          }
        }
        if (!test && opts.keyboard && !refocused && !j.keyboard && elapsed >= REFOCUS_AT_MS && s.focusOn) {
          refocused = true;
          // Once more, straight to the sidecar's ladder (Electron's focus() already had its turn).
          ctx.sidecar.send('focus', { hwnd: s.focusOn.hwnd }, { timeoutMs: 1500 }).then((f) => {
            if (!f.ok && sess === s) s.focusError = f.error;
          });
        }
        if (elapsed >= limit) break;
      }
      if (sess !== s) return;
      const why = (last && last.why) || 'it could not be measured';
      // Still Windows' shell UI in front at the end: not counted. Gone and still not forward: counted.
      const shell = shellOf(s, last && last.blockers);
      fallback(s, s.focusError ? `${why} (the sidecar's focus said: ${s.focusError})` : why, last && last.facts, { pixelsSeen: !!s.pixelsSeen, page: s.pixelPage || null }, { shell, waited: shellSeen ? SHELL_WAIT_MS : 0 });
    }

    /**
     * Mantle's overlay could not come forward: cancel the capture, open Windows' own snip, and
     * say so on the card and in the log. FALLBACKS_BEFORE_DOWN in a row (ONE while on trial) take
     * the feature down, so Win+Shift+S and PrintScreen go to Windows until goDown()'s timer takes
     * them back. opt.shell = Windows' own shell UI was in front (shellHost()): NOT counted; when it
     * is Windows' snip, that snip is already up, so it is not opened again.
     */
    function fallback(s, why, facts, pixels, opt) {
      if (sess !== s) return;
      const host = (opt && opt.shell) || null;
      if (!host) fallbacksInARow++;
      const snipUp = !!(host && host.snip);
      const snipWhy = snipUp ? snipWords(ownSnip && { seq: ownSnip.seq, ago: Date.now() - ownSnip.at }, lastLate && { words: lastLate.words, ago: Date.now() - lastLate.at }) : null;
      const counted = host ? `not counted as a failure (Windows' own ${host.snip ? 'snip' : 'shell UI'}; ${fallbacksInARow} in a row)` : `${fallbacksInARow} in a row${trial ? ', on trial' : ''}`;
      ctx.log(`#${s.seq} ${s.chord}: the overlay could not come forward within ${VERIFY_MS}${opt && opt.waited ? ` + ${opt.waited}` : ''} ms (${snipWhy || why}); ${counted}; cancelled it and ` +
        (snipUp ? 'did NOT open Windows\' Snipping Tool again (it is the one in front)' : `${test ? 'would open' : 'opened'} Windows' Snipping Tool instead`));
      if (test) ctx.log(`TESTSHOT #${s.seq} fallback ${JSON.stringify({ why, facts, pixels, inARow: fallbacksInARow, shell: host, counted: !host, trial: !!trial })}`);
      endSession('could not come forward', { giveBack: false });
      release(s);
      // The card: one plain line (fallbackCard); the reason above, with its window classes, is the log's.
      const card = Object.assign({ seq: s.seq, copied: false }, fallbackCard(host, snipUp));
      if (test || snipUp) {
        showCard(card);
      } else {
        ownSnip = { seq: s.seq, at: Date.now() };
        shell.openExternal(FALLBACK_URI).then(() => showCard(card), (err) => {
          const e = String(err && err.message).split('\n')[0];
          ctx.log(`#${s.seq}: Windows' Snipping Tool (${FALLBACK_URI}) could not be opened either: ${e}`);
          showCard({ seq: s.seq, title: 'Screenshot not taken', copied: false,
            note: `${fallbackCard(host, false).note}, and Windows' Snipping Tool did not open either: press Win+Shift+S again` });
        });
      }
      if (host || downWhy) return;
      if (trial) goDown(`Mantle's screenshot overlay still could not come forward after the keys were taken back (try ${retakes}; last: ${why})`);
      else if (fallbacksInARow >= FALLBACKS_BEFORE_DOWN) goDown(`Mantle's screenshot overlay could not come forward ${fallbacksInARow} times in a row (last: ${why})`);
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
      clearTimeout(s.canaryPoll);
      clearTimeout(s.kbTimer);
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
      setTimeout(async () => {
        if (sess !== s) return;
        if (s.used.some((x) => !x.win.isDestroyed() && x.win.isFocused())) return;
        const m = measure(o) || {};
        const why = `the overlay lost the keyboard to another window (class ${m.fgCls || (m.fg && m.fg !== '0' ? '?' : 'none: nothing has it now')})`;
        const since = Date.now() - (s.shownAt || 0);
        if (blurVerdict(since) === 'fallback') {
          // Taken away right after it came up: not Owen moving on, a window grabbing the foreground
          // back (the live log of 2026-09-24 is consistent with exactly that). He still gets a snip.
          // Windows' own shell UI taking it (Start from a leaked Win key, a late snip) is not counted.
          const fgWin = m.fg && m.fg !== '0' ? [{ hwnd: m.fg, cls: m.fgCls || '' }] : [];
          // ...but first the keyboard is taken back ONCE (lane mn-raise): the overlay is still in
          // front with his frozen screen on it, so a window that opened by itself should not cost him
          // the capture. Windows' own shell UI is left alone (that is the fallback's case below).
          await lookOwners(s, fgWin);
          if (sess !== s) return;
          if (!test && !s.retook && !shellOf(s, fgWin)) {
            s.retook = true;
            const k = await raiseWin.keyboard(o.win, { sidecar: ctx.sidecar, hwnd: o.hwnd, timeoutMs: 1500, sidecarPid: ctx.sidecar.pid });
            if (sess !== s) return;
            if (k.ok) { ctx.log(`#${s.seq}: ${why}, ${since} ms after it came up; took it back (${k.words})`); return; }
            ctx.log(`#${s.seq}: ${why}; could not take it back (${k.words})`);
          }
          await lookOwners(s, fgWin);
          if (sess !== s) return;
          fallback(s, `${why}, ${since} ms after it came up`, null, { pixelsSeen: !!s.pixelsSeen }, { shell: shellOf(s, fgWin) });
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
      if (a.mode === 'text') return commitText(s, a, rect);
      endSession('captured');
      if (MODES.includes(a.mode)) { try { ctx.settings.set('mode', a.mode); } catch (err) { ctx.log(`the mode could not be remembered: ${err.message}`); } }
      const name = G.screenshotName(new Date());
      // --test only: a step may switch the REAL setting (the test profile's) before this capture reads it.
      if (test && s.step && typeof s.step.autoSave === 'boolean') ctx.settings.set('autoSave', s.step.autoSave);
      const autoSave = ctx.settings.get('autoSave', false) === true;
      const target = autoSave ? saveTarget(s.step) : null;
      const t0 = Date.now();
      /* THE COPY COMES FIRST, AND WITHOUT A PNG (lane shotspeed, 2026-09-27). The live log had
         "copied" 863 ms (p50) after the selection: the copy waited for the sidecar's PNG encode,
         then this process decoded that PNG (nativeImage.createFromPath) and re-encoded it (toPNG)
         for clipboard.write, all on the main thread. Now the sidecar puts a CF_DIB cut straight
         from the frozen frame on the clipboard (shot.copy: a row copy, no encode), and the save
         queues behind it on the same capture lane, so both go out at once and the clipboard is
         never behind the file. --test sends dryRun: the same memory block is built and freed,
         never handed to Windows (Owen's clipboard is never touched by a test). */
      const box = { grab: s.grab, x: rect.x, y: rect.y, w: rect.w, h: rect.h };
      const copyP = ctx.sidecar.send('shot.copy', Object.assign({}, box, test ? { dryRun: true, dump: (s.step && s.step.dumpClip && testDir) || undefined } : {}), { timeoutMs: 5000 });
      // Saved only when Owen asked for every capture to be (autoSave); otherwise the card's Save does it.
      const saveP = target && target.dir ? ctx.sidecar.send('shot.save', Object.assign({}, box, { dir: target.dir, name }), { timeoutMs: 10000 }) : null;
      const cp = await copyP;
      const copyMs = Date.now() - t0;
      let copied = false;
      let copyError = null;
      if (cp.ok) {
        copied = true;
        if (test) sink.image = { w: cp.result.w, h: cp.result.h, via: 'shot.copy', format: cp.result.format, bytes: cp.result.bytes, dumped: cp.result.dumped || null };
      } else {
        copyError = missingCommand(cp.error) ? 'the sidecar has no shot.copy command (an older build): rebuild it with npm run build:sidecar' : cp.error;
      }
      let saved = null;
      let saveError = null;
      if (saveP) {
        const sv = await saveP;
        if (sv.ok) saved = sv.result; else saveError = sv.error;
      } else if (target) {
        saveError = target.why;              // saving automatically, but no folder is known: said, never silent
      }
      const saveMs = Date.now() - t0;
      const w = saved ? saved.w : (cp.ok ? cp.result.w : rect.w);
      const h = saved ? saved.h : (cp.ok ? cp.result.h : rect.h);
      /* THE FRAME IS HELD while the card is up (lane shot-save): its Save button crops the SAME frozen
         frame for the SAME box that went on the clipboard. dropHeld() releases it when the card goes. */
      dropHeld('a new capture');
      held = { seq: s.seq, grab: s.grab, box, name, w, h, saved: saved ? saved.path : null, saving: null, step: test ? s.step : null };
      const at = saved || (cp.ok ? cp.result : rect);      // the cut's top-left, as the sidecar clamped it
      const steps = `copy ${cp.ok ? cp.result.ms.total : '-'} ms in the sidecar${saved ? `, save ${saved.ms.total}` : ''}`;
      const saveWords = saved ? `saved ${w}x${h} (${Math.round(saved.bytes / 1024)} KB, encode ${saved.ms.encode} ms) to ${target.why}`
        : target ? `NOT saved (${noPaths(saveError)})` : 'not saved (only copied; the card offers Save)';
      ctx.log(`#${s.seq}: ${saveWords}; ` +
        `${copied ? 'copied' : `NOT copied (${noPaths(copyError)})`}; ${copyMs} ms after the selection (${a.mode}, ${a.via}); card ${saveMs} ms (${steps})`);
      if (test) ctx.log(`TESTSHOT #${s.seq} saved ${JSON.stringify({ path: saved && saved.path, name: saved && saved.name, w, h, x: saved && saved.x, y: saved && saved.y, bytes: saved && saved.bytes, saveMs: saved && saved.ms, copied, autoSave, clip: sink.image, T: { copied: copyMs, card: saveMs, copyMs: cp.ok ? cp.result.ms : null }, saveError, copyError, mode: a.mode, kind: a.kind, via: a.via, rect })}`);
      const dir = saved ? path.win32.dirname(saved.path) : null;
      showCard({ seq: s.seq, selAt: t0, path: saved && saved.path, name: saved && saved.name, folder: dir,
        folderName: dir ? folderWordsFor(dir) : null,
        url: saved ? fileUrl(saved.path) : null, w, h, copied, canSave: !saved,
        thumb: { w, h, pieces: thumbPieces({ x: at.x, y: at.y, w, h }, s.stats && s.stats.monitors, fileUrl) },
        copyError: copyError && plainError(copyError), saveError: saveError && plainError(saveError) });
      return { ok: true };
    }

    /** Where a Save goes: the saveDir setting, else Windows' Screenshots folder (--test: its %TEMP%
     *  folder; a step's `saveDir` under it lets a test make the folder unwritable). */
    function saveTarget(step) {
      if (test && step && typeof step.saveDir === 'string' && testDir && step.saveDir.toLowerCase().startsWith(testDir.toLowerCase())) {
        return { dir: step.saveDir, why: 'the test step\'s folder' };
      }
      return saveDirFor(test, testDir, ctx.settings.get('saveDir', null), folder, os.tmpdir());
    }

    /** "Screenshots", or the saveDir folder's own name, for "Saved to <it>". */
    function folderWordsFor(dir) { return path.win32.basename(dir) || dir; }

    /** The card's Save: the held box of the held frame into the save folder, once (a double press
     *  shares the first one's answer). Answers in plain words either way: the card shows them. */
    function saveHeld(h, via) {
      if (h.saving) return h.saving;
      h.saving = (async () => {
        try { return await saveOnce(h, via); } catch (err) {
          ctx.log(`#${h.seq}: Save (${via}) failed: ${noPaths(err && err.message)}`);
          return { ok: false, reason: plainError(err && err.message) };
        }
      })();
      h.saving.then((r) => { if (!r.ok && held === h) h.saving = null; });   // failed: Save can be pressed again
      return h.saving;
    }
    async function saveOnce(h, via) {
      const target = saveTarget(test ? h.step : null);
      if (!target.dir) return { ok: false, reason: plainError(target.why) };
      const t0 = Date.now();
      const sv = await ctx.sidecar.send('shot.save', Object.assign({}, h.box, { dir: target.dir, name: h.name }), { timeoutMs: 10000 });
      if (!sv.ok) {
        ctx.log(`#${h.seq}: Save (${via}): NOT saved (${noPaths(sv.error)})`);
        if (test) ctx.log(`TESTSHOT card not saved ${JSON.stringify({ seq: h.seq, reason: plainError(sv.error) })}`);
        return { ok: false, reason: plainError(sv.error) };
      }
      const r = sv.result;
      h.saved = r.path;
      ctx.log(`#${h.seq}: Save (${via}): saved ${r.w}x${r.h} (${Math.round(r.bytes / 1024)} KB, encode ${r.ms.encode} ms) to ${target.why}, ${Date.now() - t0} ms`);
      if (test) ctx.log(`TESTSHOT card saved ${JSON.stringify({ seq: h.seq, path: r.path, name: r.name, w: r.w, h: r.h, x: r.x, y: r.y, bytes: r.bytes, box: h.box })}`);
      const dir = path.win32.dirname(r.path);
      const out = { ok: true, path: r.path, name: r.name, folder: dir, folderName: folderWordsFor(dir), url: fileUrl(r.path), w: r.w, h: r.h };
      if (card && card.info && card.info.seq === h.seq) Object.assign(card.info, { path: r.path, name: r.name, folder: dir, folderName: out.folderName, url: out.url, canSave: false, saveError: null });
      return out;
    }

    /**
     * COPY TEXT: the selection's text, read by Windows' OCR out of the SAME frozen frame (sidecar
     * `shot.ocr`, in memory: no second grab, no file), shaped (_ocr-text.js) and put on the
     * clipboard as plain text; the card says "Copied 3 lines" and shows the first ~40 characters.
     * Nothing recognised: "No text found in that area" and the clipboard is left alone.
     * PRIVACY: the text goes to the clipboard and the card, and nowhere else. The log gets
     * X.logLine() (counts and timings); --test gets a DRY RUN whose TESTSHOT line carries counts
     * and, when the test named the text it drew (MANTLE_SHOT_TEST_EXPECT), how close the result
     * came to it - never the text itself.
     */
    async function commitText(s, a, rect) {
      endSession('captured (Copy text)');
      sink.ocr = null;
      const t0 = Date.now();
      let shaped = null;
      let textError = null;
      let rec = null;
      if (!ocr.available) {
        textError = ocr.why;
      } else {
        const r = await ctx.sidecar.send('shot.ocr', { grab: s.grab, x: rect.x, y: rect.y, w: rect.w, h: rect.h }, { timeoutMs: OCR_TIMEOUT_MS });
        if (r.ok) { rec = r.result; shaped = X.shape(rec.lines); } else textError = String(r.error || 'no reason was given').replace(/^shot\.ocr: /, '');
      }
      await release(s);
      let copied = false;
      let copyError = null;
      if (shaped && shaped.lines) {
        try {
          if (test) {
            const want = process.env.MANTLE_SHOT_TEST_EXPECT;
            sink.ocr = { lines: shaped.lines, chars: shaped.chars, via: typeof clipboard.writeText === 'function' ? 'writeText' : null,
              similarity: typeof want === 'string' ? Math.round(X.similarity(shaped.text.replace(/\r\n/g, '\n'), want) * 1000) / 1000 : null,
              exact: typeof want === 'string' ? shaped.text.replace(/\r\n/g, '\n') === want : null };
          } else {
            if (typeof clipboard.writeText !== 'function') throw new Error('this Electron has no clipboard.writeText');
            await clipboard.writeText(shaped.text);
          }
          copied = true;
        } catch (err) { copyError = err.message; }
      }
      const ms = Date.now() - t0;
      const how = rec ? `ocr ${Math.round(rec.ms.ocr)} ms at ${rec.scale}x, ${rec.lang}; ${rect.w}x${rect.h}, ${a.via}` : `${rect.w}x${rect.h}, ${a.via}`;
      ctx.log(`#${s.seq}: ${textError ? `text NOT read (${noPaths(textError)})` : X.logLine(shaped, ms, how)}; ${copied ? 'copied' : copyError ? `NOT copied (${noPaths(copyError)})` : 'nothing copied'}`);
      if (test) ctx.log(`TESTSHOT #${s.seq} text ${JSON.stringify({ lines: shaped ? shaped.lines : 0, chars: shaped ? shaped.chars : 0, copied, textError, copyError, ms, ocrMs: rec && rec.ms.ocr, scale: rec && rec.scale, lang: rec && rec.lang, clip: sink.ocr, via: a.via, rect })}`);
      showCard({ seq: s.seq, kind: 'text', copied, copyError: copyError && plainError(copyError), textError: textError && plainError(textError),
        note: textError ? 'the text could not be read' : X.headline(shaped),   // what a missing card's log line would say: counts only
        text: shaped && shaped.lines ? { lines: shaped.lines, chars: shaped.chars, headline: X.headline(shaped), preview: X.preview(shaped.text) } : { lines: 0, chars: 0 } });
      return { ok: true };
    }

    /** --test only: play one scripted step INSIDE the overlay page, through its own event handlers. */
    function playStep(s) {
      const o = s.used.find((x) => x.monitor && x.monitor.primary) || s.used[0];
      const step = s.step;
      const script = `(${function drive(st) {
        const fire = (type, x, y) => document.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 1, bubbles: true }));
        const key = (k, shift) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, shiftKey: !!shift, bubbles: true }));
        // move: the pointer rests here first (a move, no button), so a keyboard selection starts at a
        // known point and not wherever the REAL cursor happened to be when the chord fired.
        if (st.move) document.dispatchEvent(new PointerEvent('pointermove', { clientX: st.move[0], clientY: st.move[1], button: -1, buttons: 0, pointerId: 1, bubbles: true }));
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
      s.ready.set(a.monitor, Object.assign({ at: Date.now() }, a));
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
      if (!sess || !a || !ALL_MODES.includes(a.mode)) return { ok: false };
      for (const o of sess.used) ctx.push(o.win, 'screenshot.mode', { mode: a.mode });
      return { ok: true };
    });
    ctx.command('cardLoaded', async () => ({ ok: true }));
    function placeCard(a) {
      const d = ctx.host.display() || screen.getPrimaryDisplay();
      const spot = cardSpot({ w: a.w, h: a.h }, d.workArea, ctx.host.barRect());
      const phys = screen.dipToScreenRect(null, spot);
      place(card, { x: phys.x, y: phys.y, w: phys.width, h: phys.height }, true);
    }
    ctx.command('cardShown', async (a) => {
      if (!card || !card.shown || !a || !card.info || a.seq !== card.info.seq) return { ok: false };
      if (test) {
        ctx.log(`TESTSHOT card shown ${JSON.stringify({ w: a.w, h: a.h, saved: !!card.info.path, copied: card.info.copied, canSave: !!card.info.canSave, lifeMs: card.info.lifeMs })}${card.info.selAt ? ` (${Date.now() - card.info.selAt} ms after the selection)` : ''}`);
        if (held && held.seq === a.seq && held.step && Array.isArray(held.step.card)) playCard(a.seq, held.step.card);
        return { ok: true };
      }
      placeCard(a);
      return { ok: true };
    });
    // The card grew or shrank (Saved, a warn line): its window follows, still bottom right.
    ctx.command('cardSize', async (a) => {
      if (!card || !card.shown || !a || !card.info || a.seq !== card.info.seq) return { ok: false };
      if (!test) placeCard(a);
      return { ok: true };
    });
    ctx.command('cardDismiss', async (a) => {
      if (card && card.info && a && a.seq === card.info.seq) parkCard(a.why || 'dismissed');
      return { ok: true };
    });
    // The pointer or the keyboard is on the card (its timer rests): the backstop waits with it, so
    // the card never goes from under a hand about to press Save. Let go: its life left + the grace.
    ctx.command('cardHold', async (a) => {
      if (!card || !card.shown || !card.info || !a || a.seq !== card.info.seq) return { ok: false };
      armBackstop(a.held ? CARD_HOLD_MS : Math.max(0, Number(a.left) || 0) + CARD_BACKSTOP_GRACE_MS);
      return { ok: true };
    });
    // Save: the capture on the card, the same cut that was copied (saveHeld).
    ctx.command('cardSave', async (a) => {
      if (!card || !card.shown || !card.info || !a || a.seq !== card.info.seq) return { ok: false, reason: 'that screenshot is no longer on the card' };
      if (card.info.path) return { ok: true, already: true, name: card.info.name, folderName: card.info.folderName, url: card.info.url };
      const h = held;
      if (!h || h.seq !== a.seq) return { ok: false, reason: 'the picture is no longer kept: take the screenshot again' };
      return saveHeld(h, a.via === 'key' ? 'Ctrl+S' : 'the Save button');
    });

    /* --test only: a step's `card` list is played on the hidden card page through its REAL controls
       (the same click and key handlers Owen's pointer and keyboard reach), and its state is logged:
       "save" | "saveKey" (Ctrl+S) | "hover" | "leave" | "esc" | "wait:<ms>" | "state". */
    async function playCard(seq, acts) {
      const js = (code) => (card && !card.win.isDestroyed() ? card.win.webContents.executeJavaScript(code, true).catch((e) => ({ error: e.message })) : Promise.resolve(null));
      const live = () => !!(card && card.shown && card.info && card.info.seq === seq);
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      for (const act of acts) {
        const [verb, arg] = String(act).split(':');
        if (verb === 'wait') { await sleep(Number(arg) || 0); continue; }
        if (verb === 'state') {
          const st = await js('window.__cardState ? window.__cardState() : null');
          ctx.log(`TESTSHOT card state #${seq} ${JSON.stringify(Object.assign({ shown: live(), held: !!(held && held.seq === seq) }, st || {}))}`);
          continue;
        }
        if (!live()) { ctx.log(`TESTSHOT card act #${seq} ${verb}: the card is gone`); continue; }
        if (verb === 'save' || verb === 'saveKey') {
          await js(verb === 'save' ? "document.getElementById('save').click()"
            : "document.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }))");
          for (let i = 0; i < 40 && held && held.seq === seq && !held.saving; i++) await sleep(50);
          if (held && held.seq === seq && held.saving) await held.saving;
          await sleep(100);                  // the page's answer painted
        } else if (verb === 'hover' || verb === 'leave') {
          await js(`document.getElementById('card').dispatchEvent(new PointerEvent('${verb === 'hover' ? 'pointerenter' : 'pointerleave'}'))`);
        } else if (verb === 'esc') {
          await js("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
        }
      }
    }
    /* The saved file of the card ON SCREEN, and only when the page names that card (its seq): a
       late click from a card already put away (a double-click on the picture opened the file twice)
       or from an older card never acts on another capture's file. */
    function cardPath(a) {
      if (!card || !card.shown || !card.info || !a || a.seq !== card.info.seq) return null;
      return card.info.path || null;
    }
    ctx.command('cardOpen', async (x) => {
      const p = cardPath(x);
      if (!p) return { ok: false, reason: 'nothing was saved' };
      if (test) { ctx.log('TESTSHOT card open (test: not opened)'); return { ok: true }; }
      const err = await shell.openPath(p);
      if (err) ctx.log(`the screenshot could not be opened: ${noPaths(err)}`);
      // Said on the card, which stays up (card.js): Windows has no app for PNG files, the file was moved...
      return { ok: !err, reason: err ? plainError(err) : null };
    });
    ctx.command('cardFolder', async (x) => {
      const p = cardPath(x);
      if (!p) return { ok: false, reason: 'nothing was saved' };
      if (test) { ctx.log('TESTSHOT card folder (test: not opened)'); return { ok: true }; }
      shell.showItemInFolder(p);
      return { ok: true };
    });
    ctx.command('cardCopyPath', async (x) => {
      const p = cardPath(x);
      if (!p) return { ok: false, reason: 'nothing was saved' };
      if (test) { sink.text = { length: p.length }; ctx.log('TESTSHOT card copy path (test sink)'); return { ok: true }; }
      try { await clipboard.writeText(p); return { ok: true }; } catch (err) { return { ok: false, reason: plainError(err.message) }; }
    });

    /* -- start-up ---------------------------------------------------------------------------------------- */

    ctx.onChord('Win+Shift+S', start);
    ctx.onChord('PrintScreen', start);
    // The keyboard hook got a key it swallows past Windows' limit, so Windows got it too (Hotkey.cs
    // LATE KEYS; the "[sidecar warn] keyboard hook:" line is the log's). Kept to explain Windows' snip.
    ctx.sidecar.on('keylate', (e) => { lastLate = { words: String(e.words || `a key reached the keyboard hook ${e.ms} ms late`), at: Date.now() }; });
    ctx.onEnabled((on) => {
      if (on) {
        // The tray switch turned back on: the owner's word that the overlay should be tried again.
        clearDown('switched back on: the overlay gets another try (the self-healing timer is cleared)');
        return;
      }
      if (sess) { const s = endSession('switched off'); if (s) release(s); }
      parkCard('switched off');
    });
    const offReady = ctx.sidecar.onReady(async () => {
      // --test only: 15 s, not 4. A test instance starts beside other test instances (a ship runs
      // several), and on such a loaded start its sidecar answered this first call late: "did not answer
      // "shot.folder" within 4s" (lane r9-flake, 2026-10-01: 1 of 5 quiet runs, and ships 67-69 and 74
      // before quiet mode), so the test never saw "saves go to". Live keeps 4 s (12 of 12 live starts in
      // mantle.log answered in time).
      const f = await ctx.sidecar.send('shot.folder', {}, { timeoutMs: test ? 15000 : 4000 });
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
      await checkOcr();
    });
    /* Copy text: an OCR that cannot be reached leaves screenshots working and says why on its button.
       Asked when the sidecar is ready, and AGAIN at a capture while unavailable (ocrRecheck: a slow
       start-up that timed out, or a language added since, used to leave Copy text off until Mantle
       restarted); the overlays of the capture in hand hear the answer (screenshot.ocr). */
    function checkOcr() {
      if (ocrAsking) return ocrAsking;
      ocrAskedAt = Date.now();
      ocrAsking = ctx.sidecar.send('ocr.status', {}, { timeoutMs: 8000 }).then((o) => {
        const was = ocr.available;
        if (!o.ok) {
          ocr = { available: false, why: missingCommand(o.error)
            ? 'the sidecar has no ocr.status command (an older build): rebuild it with npm run build:sidecar'
            : `Windows’ OCR could not be asked (${o.error})` };
        } else if (!o.result.available) {
          ocr = { available: false, why: o.result.why || 'Windows’ OCR said it is unavailable and gave no reason' };
        } else {
          ocr = { available: true, why: null, lang: o.result.lang };
        }
        if (ocr.available !== was || !was) ctx.log(ocr.available ? `Copy text: Windows' OCR is ready (${o.result.lang}; installed: ${(o.result.langs || []).join(', ')})` : `Copy text is unavailable: ${noPaths(ocr.why)}`);
        if (sess && ocr.available !== was) for (const w of sess.used) ctx.push(w.win, 'screenshot.ocr', ocrForPage());
      }).finally(() => { ocrAsking = null; });
      return ocrAsking;
    }
    /** What the overlay's Copy text button needs: available, or why not in plain words. */
    function ocrForPage() {
      return { available: ocr.available, why: ocr.available ? null : plainError(ocr.why), lang: ocr.lang || null };
    }
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
    // NO card here any more (lane ramdiet): ensureCard() makes it when a capture is on screen.

    return {
      stop(why) {
        stopped = true;
        cardIdle.stop();
        clearTimeout(retakeTimer);
        clearTimeout(rebuildTimer);
        try { offReady(); } catch (_) { /* gone */ }
        screen.removeListener('display-added', onDisplays);
        screen.removeListener('display-removed', onDisplays);
        screen.removeListener('display-metrics-changed', onDisplays);
        const s = endSession(`Mantle is stopping (${why})`);
        held = null;                       // the card's frame: a new grab replaced it, or the release below frees it
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
