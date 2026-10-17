'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
// A --test run keeps every window off Owen's screen (lib/test-quiet.js); live it returns before touching anything.
require('./lib/test-quiet').install(process.argv, process.env);
const { app, BrowserWindow, ipcMain, globalShortcut, Tray, Menu, screen, shell, powerMonitor, nativeTheme } = require('electron');

const { parseArgs, ArgError } = require('./lib/args');
const { ShellState } = require('./lib/state');
const { Sidecar } = require('./lib/sidecar');
const { Apps, modulePathFor } = require('./lib/apps');
const iconFresh = require('./lib/icon-fresh');
const fgGrant = require('./lib/fg-grant');
const { stats } = require('./lib/sys-stats');
const MediaPick = require('./lib/media-pick');
const { trayImage } = require('./lib/tray-icon');
const { openTarget } = require('./lib/open-target');
const { openRouted } = require('./lib/open-route');
const spotifyLaunch = require('./lib/spotify-launch');
const { probe } = require('./lib/net-probe');
const { createCallLog, createSetLog } = require('./lib/call-log');
// lane mn-plainwords: raw codes ("COMException (0x8024402C)", "access denied (5)") become words where a
// reply, a push or a replay crosses to a page; the codes themselves go to the log, once each
const { toPage, plain } = require('./lib/plain-error');
const { placeholderUrl } = require('./lib/placeholder');
const { createTheme, windowsModeFrom } = require('./lib/theme');
const { createBar, createLauncher, createDesktop, hwndOf, BAR_H } = require('./lib/windows');
const raiseWin = require('./lib/raise');   // every pop-up on top, every time it shows (r7-ontop)
// The hover flyout's live window previews (DWM thumbnails through koffi). Requiring it is free:
// koffi itself is only loaded the first time a flyout asks for a picture. See lib/thumbs.js.
const thumbs = require('./lib/thumbs');
// A PARENT DYING IN ANOTHER PROCESS (lane mantle-crash, 2026-10-15). The desktop layer is a child of
// Explorer's Progman, and Explorer dying took Mantle's main down with it in the same second (0xc000041d,
// 10-11 and 10-14): Windows sends the orphan WM_NCDESTROY with no WM_DESTROY and Electron trips its own
// CHECK. Every window is guarded from the moment it exists, and every top-level one hears Explorer's
// TaskbarCreated when it comes back (lib/foreign-parent.js; shellRestarted below re-attaches).
const foreignParent = require('./lib/foreign-parent');
app.on('browser-window-created', (_e, w) => {
  foreignParent.guardWindow(w);
  foreignParent.hookShellRestart(w, (how) => shellRestarted(how));
});
// The bar window's shape: the part of an always-tall window that is the bar (see barTall).
const barShape = require('./lib/bar-shape');
// Mantle plays the desktop wallpaper itself (2026-09-22; Lively's player sat under the desktop
// layer and its panes hid it). Required HERE, before app 'ready', because it registers the
// mantle-wp:// scheme a web wallpaper is served on, which Electron only accepts before ready.
const wallpaper = require('./lib/wallpaper');
// Mantle's notification centre (2026-09-22): the bar's bell, over the sidecar's `notifications`.
const notifications = require('./lib/notifications');
// Mantle's Alt+Tab (2026-09-23): the overlay window and its off switch. The keys and the switch
// itself are the sidecar's (Hotkey.cs + AltTab.cs), so Alt+Tab works even when this process
// or the overlay page is stuck; lib/switcher.js only draws it.
const switcher = require('./lib/switcher');
// The feature seam (wave 3, 2026-09-24): every lib/features/<name>.js is found and started here,
// isolated, with its chords taken from Windows only while it is on AND healthy (lib/features.js).
const { createFeatures } = require('./lib/features');
// the known-game list (pure): a known game in front keeps the bar hidden even in a window (valofix)
const GamePlan = require('./lib/features/_gamemode-plan');
// hot corners (lane corners): an ACTIVE corner's square is the corner's, not the reveal band's
const HotCorners = require('./lib/features/_corners');

/*
 * The pinned-taskbar reader (lane C's file). It is REQUIRED IN A TRY on purpose:
 * this lane and that one land at different times, and a main process that will
 * not boot because a sibling file is not written yet is a worse failure than a
 * bar with no pins in it. Missing means `bar.pinned` answers ok:false with this
 * reason and the running apps only -- never an empty list with no explanation.
 */
let pinnedModule = null;
let pinnedModuleReason = null;
// The pins themselves (a reg.exe spawn + IShellLink over every .lnk) are read once and kept until the
// pins folder changes or five minutes pass. Before this cache every running-windows event rebuilt
// them, i.e. one reg.exe per second forever: 42% of a core at rest (profiled live 2026-09-21).
let pinsCache = null;
let pinsCacheAt = 0;
const PINS_CACHE_MS = 5 * 60 * 1000;
try {
  pinnedModule = require('./lib/pinned');
  if (!pinnedModule || typeof pinnedModule.listPinned !== 'function') {
    pinnedModuleReason = 'lib/pinned.js loaded but does not export listPinned(), so only running apps can be listed';
    pinnedModule = null;
  }
} catch (err) {
  pinnedModuleReason = `lib/pinned.js missing: ${err.message}`;
}

/*
 * Mantle's main process: a shell LAYER over Windows 11.
 *
 * explorer.exe keeps running underneath. Mantle puts the Windows taskbar into
 * auto-hide, puts its own bar, launcher and desktop layer on screen, and can put
 * everything back instantly. The dangerous half -- the taskbar's auto-hide flag,
 * the screen space the bar occupies, the wallpaper layer, the Win key -- is done
 * by one C# sidecar that restores whatever it changed the moment this process
 * dies, so the worst case for Owen is "Mantle disappeared", never "Windows has no
 * taskbar and I cannot get it back".
 *
 * This file owns: the flags, the three windows, the IPC bridge behind
 * window.mantle, the sidecar's lifetime, the tray menu, the kill switch, and the
 * restore path that every exit road leads to.
 *
 * ---------------------------------------------------------------------------
 * THE INCIDENT, 2026-09-21, which is why the next 200 lines look paranoid.
 * ---------------------------------------------------------------------------
 * Mantle's first live run hid the Shell_TrayWnd window with ShowWindow(SW_HIDE).
 * Owen's Windows taskbar is set to AUTO-HIDE. Hiding the window of an auto-hiding
 * taskbar wedges explorer's own show/hide state machine: when Mantle was killed
 * the sidecar's SW_SHOW ran, and the taskbar still did not come back. He had to
 * REBOOT, in the middle of his work. His words: "dont ever let that happen
 * again."
 *
 * The principle every rule below serves: A KILLED MANTLE MUST LEAVE WINDOWS
 * EXACTLY AS USABLE AS BEFORE. No shell state may need a living process to undo.
 *
 *   - The taskbar: only the OS-managed auto-hide flag (ABM_SETSTATE). Nothing in
 *     Mantle hides a window that belongs to explorer. Ever.
 *   - Screen space: the bar is a REAL app bar (SHAppBarMessage). Explorer drops
 *     an app bar's reservation by itself when the window dies, so a crash cannot
 *     leave a strip of screen missing. No SPI_SETWORKAREA fallback -- that one
 *     DOES survive the process, which is the exact property we are refusing.
 *   - The ORIGINAL state is written to a file BEFORE anything changes.
 *   - tools/restore-windows.ps1 puts Windows back from that file with no Node, no
 *     Electron and no Mantle running.
 *   - And nobody gets into live mode by accident: --live has to be typed.
 */

const ROOT = __dirname;

// The one line that fixes everything, built from __dirname so it stays true if
// the repo moves. Printed before Mantle touches the shell and again on every
// restore that could not be verified. Quoted: the path has spaces in it on
// plenty of machines, and the one time it matters is the one time nobody is in a
// state to debug a quoting bug.
const RESTORE_SCRIPT = path.join(ROOT, 'tools', 'restore-windows.ps1');
const RECOVERY_CMD = `powershell -NoProfile -ExecutionPolicy Bypass -File "${RESTORE_SCRIPT}"`;

// ---------------------------------------------------------------------------
// Flags. A bad flag stops the boot here, before anything can touch the shell.
// ---------------------------------------------------------------------------
let flags;
try {
  flags = parseArgs(process.argv.slice(1));
} catch (err) {
  if (err instanceof ArgError) {
    process.stderr.write(`mantle: ${err.message}\n`);
    app.exit(2);
  } else {
    throw err;
  }
}

const MODE = flags.test ? 'test' : 'live';

/*
 * --dock: the OLD bar, the one that reserves a permanent strip of screen with a
 * real app bar. It is OFF by default as of 2026-09-21, because Owen asked for the
 * opposite shape: "all my pinned to taskbar things just icons centered, and when
 * I put my mouse to the bottom of the screen it pulls up a glass UI taskbar".
 * A bar that is hidden until asked for must not be subtracting screen space from
 * every maximised window for the 99 % of the time nobody is pointing at it.
 *
 * Read here rather than in lib/args.js: that file is a shared surface another
 * lane is in, and an unknown --flag is already ignored there by design, so this
 * costs one line and collides with nobody.
 */
flags.dock = process.argv.slice(1).some((a) => a === '--dock');
const BAR_MODE = flags.dock ? 'dock' : 'hover';

/*
 * --pill: the bar is a floating pill instead of a full-width edge strip.
 *
 * EDGE (default) is flush with the bottom of the screen, full width. PILL is a
 * 1120-DIP rounded slab floating 14 DIP above the bottom edge, and the ROUNDING
 * IS THE WINDOW's (SetWindowRgn through the sidecar's morph), not CSS -- the
 * blur-behind glass is painted by DWM across the whole window, so a CSS radius
 * would leave frosted square corners poking out behind the page.
 *
 * KNOWN, and said out loud in State.bar.reason rather than discovered: Windows'
 * own auto-hide taskbar still answers the same bottom edge and comes up UNDER the
 * pill, in the 14-DIP gap and beside it. Pill mode is for a machine whose taskbar
 * lives on another edge. It works either way; it just looks doubled if not.
 */
/*
 * --log=<path>: everything Mantle prints goes to that file as well. For runs
 * that have no terminal -- the logon task (tools/install-autostart.ps1) -- this
 * is the only copy of the log there is. Appends, stamps each start, and never
 * takes Mantle down: a log file that cannot be written is simply not written.
 *
 * Every line in the FILE starts with the local time, HH:MM:SS.mmm, and the first
 * line of a run and the first after midnight carry the date too (the 2026-09-27
 * log review had to guess every duration: 62 of 33k lines had a time). The
 * terminal copy is left as it was. At 5 MB the file becomes <path>.1 (the old .1
 * becomes .2, the old .2 goes), always between two lines, so no line is split or
 * lost; the 3.3 MB of the first six days had grown with no end. A rotation that
 * fails (a reader holding the file) keeps writing where it was, says so IN the
 * log, and tries again 1 MB later.
 */
// <mainrel:logtee> (lib/main-rel.test.js runs this region on its own: no outside names in it)
function makeLogTee(fs, file, opts) {
  const o = Object.assign({ maxBytes: 5 * 1024 * 1024, keep: 2, retryBytes: 1024 * 1024, now: () => new Date(), clock: () => Number(process.hrtime.bigint()) / 1e6, say: () => {} }, opts || {});
  let fd = null;
  let lost = null;               // { since, tried, writes, reason } while a rotation left the file closed
  const REOPEN_MS = 5000;
  let size = 0;
  let atLineStart = true;
  let lastDay = '';
  let rotateAt = o.maxBytes;
  const two = (n) => String(n).padStart(2, '0');
  function stamp() {
    const d = o.now();
    const day = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
    const time = `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
    if (day === lastDay) return `${time} `;
    lastDay = day;
    return `${day} ${time} `;
  }
  function open() {
    fd = fs.openSync(file, 'a');
    size = fs.fstatSync(fd).size;
  }
  // Raw bytes, stamped one line at a time. '\n' is one byte that never occurs inside a UTF-8
  // sequence, so splitting the Buffer on it cannot cut a character in half.
  function put(chunk) {
    if (typeof chunk === 'string' && o.scrub) { try { chunk = o.scrub(chunk); } catch (_) { /* the line as it was */ } }
    const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);
    const parts = [];
    let i = 0;
    while (i < buf.length) {
      if (atLineStart) { parts.push(Buffer.from(stamp(), 'utf8')); atLineStart = false; }
      const j = buf.indexOf(0x0a, i);
      if (j === -1) { parts.push(buf.subarray(i)); break; }
      parts.push(buf.subarray(i, j + 1));
      atLineStart = true;
      i = j + 1;
    }
    const all = Buffer.concat(parts);
    fs.writeSync(fd, all);
    size += all.length;
  }
  function rotate(why) {
    const t0 = o.clock();
    const was = size;
    try { fs.closeSync(fd); } catch (_) { /* reopened below either way */ }
    fd = null;
    let failed = null;
    for (let k = o.keep; k >= 1 && !failed; k--) {
      const from = k === 1 ? file : `${file}.${k - 1}`;
      try { if (fs.existsSync(from)) fs.renameSync(from, `${file}.${k}`); } catch (err) { failed = `${from} -> .${k}: ${err && err.code ? err.code : err && err.message}`; }
    }
    try { open(); } catch (err) {
      fd = null;
      lost = { since: o.clock(), tried: o.clock(), writes: 0, reason: err && err.code ? err.code : String(err && err.message) };
      o.say(`mantle: the log file could not be reopened after rotating it (${err && err.message}); logging to the terminal only, trying again every ${REOPEN_MS / 1000} s\n`);
      return { ok: false, ms: o.clock() - t0, reason: err && err.message };
    }
    const ms = o.clock() - t0;
    rotateAt = failed ? size + o.retryBytes : o.maxBytes;
    const line = failed
      ? `mantle: log: could NOT rotate at ${(was / 1048576).toFixed(1)} MB (${failed}); still writing to this file, next try at ${(rotateAt / 1048576).toFixed(1)} MB\n`
      : `mantle: log: ${why}: the previous ${(was / 1048576).toFixed(1)} MB is now ${file.split(/[\\/]/).pop()}.1 (${o.keep} old files kept), rotated in ${ms.toFixed(1)} ms\n`;
    put(line);
    if (failed) o.say(line);
    return { ok: !failed, ms, reason: failed };
  }
  return {
    start(header) {
      open();
      if (size >= o.maxBytes) rotate('rotated at start');
      if (size > 0) { fs.writeSync(fd, '\n'); size += 1; }   // a blank line between runs, as before
      put(header);
    },
    write(chunk) {
      if (fd === null) {
        // Closed by a rotation that could not reopen it: it used to stay closed for the whole run (the
        // logon task has no terminal, so every later line was lost unsaid). Try again every
        // REOPEN_MS, and the first line back says how long and how many writes were lost.
        if (!lost) return;
        const t = o.clock();
        if (t - lost.tried < REOPEN_MS) { lost.writes++; return; }
        lost.tried = t;
        try { open(); } catch (_) { fd = null; lost.writes++; return; }
        const gone = lost;
        lost = null;
        atLineStart = true;
        put(`mantle: log: this file could not be opened for ${((t - gone.since) / 1000).toFixed(0)} s (${gone.reason}); ${gone.writes} writes to it were lost\n`);
      }
      put(chunk);
      if (atLineStart && size >= rotateAt) rotate(`rotated at ${(o.maxBytes / 1048576).toFixed(0)} MB`);
    },
    get size() { return size; },
  };
}

/*
 * THE LOG FILE NAMES NEITHER THE PERSON NOR THE PC (lane core-main, 2026-09-29). Every path under
 * the home folder is written from %USERPROFILE% (the one form that still works pasted into Run or
 * cmd, which matters for the recovery line), the user name anywhere else in a path as <user>, and
 * the computer's name as <pc>. It runs on every line the file gets, so a stack trace, a page's
 * console error and a lane's new log line are covered the day they are written; the lines that
 * carried a caller's own words (a Wi-Fi name, a file name) are fixed where they are written.
 * The terminal copy is left as it was: it is on screen, not on disk.
 */
function makeScrubber(who) {
  const w = who || {};
  const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rules = [];
  const home = typeof w.home === 'string' && w.home.length > 3 ? w.home.replace(/[\\/]+$/, '') : '';
  if (home) {
    const parts = home.split(/[\\/]+/).filter(Boolean);
    const sep = '(?:\\\\\\\\|\\\\|/)';                      // \\ (inside JSON), \ or /
    const forms = [parts.map(esc).join(sep)];
    const enc = parts.map((p) => encodeURI(p));
    if (enc.join('/') !== parts.join('/')) forms.push(enc.map(esc).join('/'));   // file:///C:/Users/Jo%20Smith
    for (const f of forms) rules.push([new RegExp(`${f}(?![A-Za-z0-9_.-])`, 'gi'), '%USERPROFILE%']);
  }
  const user = typeof w.user === 'string' && w.user.length >= 2 ? w.user : '';
  if (user) rules.push([new RegExp(`([\\\\/])${esc(user)}(?=[\\\\/"'\\s:;,)]|$)`, 'gi'), '$1<user>']);
  const host = typeof w.host === 'string' && w.host.length >= 3 ? w.host : '';
  if (host) rules.push([new RegExp(`(^|[^A-Za-z0-9_-])${esc(host)}(?![A-Za-z0-9_-])`, 'gi'), '$1<pc>']);
  return (text) => {
    let s = String(text);
    for (const [re, to] of rules) s = s.replace(re, to);
    return s;
  };
}
// </mainrel:logtee>
(function teeLogToFile() {
  const arg = process.argv.slice(1).find((a) => typeof a === 'string' && a.startsWith('--log='));
  const file = arg ? arg.slice('--log='.length).replace(/^"|"$/g, '') : '';
  if (!file) return;
  const fs = require('fs');
  const sayErr = process.stderr.write.bind(process.stderr);   // the terminal only: never back into the tee
  let tee = null;
  try {
    fs.mkdirSync(require('path').dirname(file), { recursive: true });
    let user = '';
    try { user = os.userInfo().username; } catch (_) { user = process.env.USERNAME || ''; }
    let host = '';
    try { host = os.hostname(); } catch (_) { host = process.env.COMPUTERNAME || ''; }
    tee = makeLogTee(fs, file, { say: (s) => { try { sayErr(s); } catch (_) {} }, scrub: makeScrubber({ home: os.homedir(), user, host }) });
    tee.start(`===== mantle start ${new Date().toISOString()} pid ${process.pid}: ${process.argv.slice(1).join(' ')}\n`);
  } catch (err) {
    process.stderr.write(`mantle: --log=${file} cannot be written (${err && err.message ? err.message : err}); logging to the terminal only\n`);
    return;
  }
  for (const stream of [process.stdout, process.stderr]) {
    const orig = stream.write.bind(stream);
    stream.write = (chunk, ...rest) => {
      try { tee.write(chunk); } catch (_) { /* never fatal */ }
      return orig(chunk, ...rest);
    };
  }
})();

const ARGV = process.argv.slice(1);
flags.pill = ARGV.some((a) => a === '--pill');       // still accepted; it is the default now
flags.flush = ARGV.some((a) => a === '--flush');     // the old full-width edge strip
const BAR_SHAPE = flags.flush && !flags.pill ? 'edge' : 'pill';

/*
 * --no-edgeclip: do not confine the cursor 2 px short of the bottom edge.
 *
 * THE ISLAND ONLY WORKS BECAUSE OF THIS. Owen's Windows taskbar is on auto-hide
 * on the same bottom edge, so the moment the cursor reaches the last row Windows
 * slides its taskbar up -- straight through the 14 DIP of air under the island
 * and out both sides of it, which is exactly the gap the glass is there to show.
 * A live probe settled it: with the cursor stopped 2 px short, the taskbar never
 * pops, and the gaps stay clean.
 *
 * It is a ClipCursor by 2 px, held by the SIDECAR, which drops it when it dies --
 * so the worst case is a mouse that can reach the bottom row again, never a mouse
 * trapped in a rectangle by a process that is gone. traywatch stays armed anyway:
 * an app flashing its taskbar button can still force the taskbar up on its own.
 */
flags.edgeclip = !ARGV.some((a) => a === '--no-edgeclip');

/*
 * --no-tbhide: do not make the Windows taskbar invisible (sidecar/TaskbarHide.cs).
 *
 * WHY IT EXISTS (probe, 2026-09-25): the auto-hidden taskbar slid up ~7 times in
 * 10 minutes, each time 35-50 ms after a FOREGROUND CHANGE -- mostly Mantle's own
 * bar opening an app -- with the cursor nowhere near the bottom edge and the edge
 * clip already dropped by that same foreground change. No cursor clip can stop
 * that. So the sidecar gives the taskbar an EMPTY WINDOW REGION: Explorer still
 * runs it (tray, Win+number, its auto-hide state machine all untouched), but a
 * reveal draws nothing and clicks fall through. Never ShowWindow/SetWindowPos.
 * A guard process clears the region if the sidecar dies; tools/restore-windows.ps1
 * and an Explorer restart clear it with no Mantle at all.
 */
flags.tbhide = !ARGV.some((a) => a === '--no-tbhide');
/*
 * --test-tbhide (TEST ONLY, 2026-10-01): a --test run hides a TEST'S STAND-IN taskbar the
 * way a live start hides the real one (ready -> tbhide -> retries), so the start-up timing
 * can be proven without touching Windows. Honoured only with --test AND
 * MANTLE_TBHIDE_TEST_CLASS set: the sidecar then sees that stand-in window and nothing else,
 * and refuses tbhide outright without it (passive).
 */
flags.testTbhide = !!flags.test && ARGV.some((a) => a === '--test-tbhide') && !!process.env.MANTLE_TBHIDE_TEST_CLASS;

/*
 * --os-morph: animate the WINDOW with the sidecar's per-frame SetWindowPos, the
 * way this did until Owen said "when the taskbar expands out it isn't that
 * smooth". Kept so the two can be compared side by side rather than argued about.
 * The default now: the window is placed once and the PAGE animates the pill.
 */
flags.osMorph = ARGV.some((a) => a === '--os-morph');
/*
 * --test-live-bar, --test-trace=<dir> (TEST ONLY, 2026-09-24). Owen: "when i press any of these
 * buttons the taskbar glitches down and then back up rq". A test bar is a framed window whose
 * popovers are one setContentBounds, so it could not show what the live bar does. --test-live-bar
 * makes the test bar the live way (frameless, transparent, placed and morphed by the sidecar)
 * but never on top of anything: every raise sends it to the back. --test-trace clicks each
 * right-cluster button through the page and records, frame by frame, the window's physical rect
 * and where the page draws the pill (runTrace). Both are ignored without --test.
 */
flags.testLiveBar = !!flags.test && ARGV.some((a) => a === '--test-live-bar');
const TRACE_ARG = ARGV.find((a) => typeof a === 'string' && a.startsWith('--test-trace='));
flags.trace = flags.test && TRACE_ARG ? TRACE_ARG.slice('--test-trace='.length) : null;
const REVEAL_BY = flags.osMorph ? 'morph' : 'page';

/*
 * --lessonplayer-media-controls: let the bar's play/pause/next reach an LESSONPLAYER media session.
 *
 * Absent by default, which means THE LESSONPLAYER RULE IS ON (Owen, 2026-09-22). He records his
 * school lessons in LessonPlayer, and LessonPlayer publishes a system media session like any music player
 * (measured: Contoso.LessonPlayer_8wekyb3d8bbwe!App, title "LessonPlayer", artist "Student").
 * One stray click on a play/pause glyph would pause the lesson under the recording, and nothing
 * on screen would say why. So by default:
 *   - an LessonPlayer session gets NO transport controls anywhere in Mantle; the media card says
 *     "LessonPlayer lesson · controls off so a stray click can't pause it" instead of drawing buttons,
 *   - main REFUSES media.control aimed at one, whatever a page asks (the page is not the guard),
 *   - the now-playing chip shows any other session in preference to it when both exist, and
 *     there is NO chip at all when an LessonPlayer lesson is the only session (Owen, same day).
 * Add this flag to the logon task's arguments to lift all three.
 */
// 2026-09-24: THE DEFAULT FLIPPED. Owen, looking at the card's "controls off" note: "i want to be
// able to pause it". LessonPlayer now gets play/pause like any player; --lessonplayer-guard puts the rule
// above back on for a recording session (--lessonplayer-media-controls is still accepted, and wins).
flags.lessonplayerMediaControls = ARGV.includes('--lessonplayer-media-controls') || !ARGV.includes('--lessonplayer-guard');

// A test instance gets its own userData directory, which is ALSO what keys
// Electron's single-instance lock -- that is the whole reason the profile name
// is mandatory. Without it a test run would take the live shell's lock and be
// refused, or worse, steal it.
if (flags.test) {
  app.setPath('userData', path.join(os.tmpdir(), 'mantle-test-' + flags.profileName));
}
app.setAppUserModelId('com.owensilva.mantle');

// Chromium stops painting a window it believes is covered. Mantle has two
// windows that are permanently "covered": the desktop layer lives UNDER the
// wallpaper, and the bar disappears behind any maximised window. A frozen clock
// and a blank capturePage() are both symptoms of the same optimisation, so it
// goes off. These pages are idle between ticks; the cost is not measurable.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
/*
 * The GPU service runs INSIDE the main process. Measured 2026-09-21 (private
 * bytes, 30 s after start, same pages): a separate GPU process held 148 MB and
 * the whole of Mantle 291 MB; in-process, main grew to 134 MB and the whole of
 * Mantle came to 242-246 MB. That is the process's own overhead (a second copy
 * of Chromium's runtime), not the textures, which cost the same either way.
 * Clicks, hide/reveal cycles, popovers and the backdrop blur were exercised on
 * it before it was adopted. The trade: a GPU driver crash now takes Mantle
 * down instead of a GPU process that would have restarted -- the logon task
 * restarts Mantle on a non-zero exit (tools/mantle-logon-task.xml).
 */
app.commandLine.appendSwitch('in-process-gpu');

// Where the sidecar records what Windows looked like BEFORE Mantle touched it.
// %APPDATA%\mantle\shell-state.json in live mode (Electron's userData for the app
// name in package.json), %TEMP%\mantle-test-<profile>\shell-state.json in a test
// run. tools/restore-windows.ps1 defaults to the live one, and this path is
// printed at every point where a human might need it.
const STATE_FILE = path.join(app.getPath('userData'), 'shell-state.json');

// First start (lib/welcome.js): judged HERE, by READING what is already in the profile, before the
// sidecar, the theme, the features or Chromium write anything this run. The flag is written later
// (whenReady), once this process holds the single-instance lock.
const welcomeVerdict = require('./lib/welcome').judge({ dir: app.getPath('userData'), test: flags.test, optIn: flags.firstRun });

// ---------------------------------------------------------------------------
// --quit: ask the RUNNING live Mantle to put Windows back and stop.
//
// WHY it works by failing to get the lock: the running instance already holds
// Electron's single-instance lock, and Electron hands OUR argv to it as a
// 'second-instance' event. So this process never creates a window, never spawns a
// sidecar and never touches the shell -- it is a message, not an instance. That
// makes "stop Mantle cleanly" scriptable without injecting a keystroke or
// clicking a tray menu, which matters because the alternative (killing it) is the
// path that has to be relied on least.
//
// Checked BEFORE the --live gate, so `electron . --quit` never prints the gate.
// ---------------------------------------------------------------------------
if (flags.quit) {
  // Look for a running Mantle BEFORE asking for the lock.
  //
  // WHY the lock's own answer is not enough, measured 2026-09-21: the instance we
  // notify starts shutting down inside its 'second-instance' handler and is gone
  // in milliseconds. Chromium's process singleton sees the process it just
  // notified disappear and hands US the lock, so requestSingleInstanceLock()
  // returns TRUE even though the message was delivered and acted on. Reporting
  // "nothing was running" there would be a plain lie, and a script branching on
  // the exit code would act on it. A process snapshot taken first cannot race
  // that way, and the lock's answer is still used as the second witness.
  const running = findOtherMantle();
  const delivered = !app.requestSingleInstanceLock();
  if (delivered || running.pids.length) {
    const who = running.pids.length ? ` (pid ${running.pids.join(', ')})` : '';
    process.stdout.write(`mantle: asked the running Mantle${who} to put Windows back and quit.\n`);
    if (!delivered) app.releaseSingleInstanceLock();
    app.exit(0);
  } else {
    process.stdout.write(`mantle: no Mantle is running (nothing answered on ${app.getPath('userData')}${running.reason ? `; ${running.reason}` : ''}), so there is nothing to quit.\n`);
    process.stdout.write(`mantle: if Windows still looks wrong, run: ${RECOVERY_CMD}\n`);
    app.releaseSingleInstanceLock();
    app.exit(1);
  }
}

// ---------------------------------------------------------------------------
// --open=wallpapers: ask the RUNNING Mantle to open one of its windows (lane looksync-open,
// 2026-10-10: Quartz and Helm's "Open Mantle Wallpapers" button runs exactly this).
//
// Same shape as --quit: a message through the single-instance lock, never an instance. Checked
// BEFORE the --live gate (it carries no --live) and before anything that makes a window, spawns the
// sidecar, builds the tray or touches the shell. If the lock is FREE, nobody is listening: this
// process must not become a shell just because a button was pressed, so it lets go and exits 3.
// (Unlike --quit, the instance asked stays up, so the lock's answer is a reliable witness.)
// The allow-list lives in lib/args.js openRequest; the running instance applies it and logs.
// ---------------------------------------------------------------------------
if (flags.open !== null) {
  const openReq = require('./lib/args').openRequest(process.argv.slice(1));
  if (app.requestSingleInstanceLock()) {
    process.stderr.write(require('./lib/args').openNotRunningLine(openReq) + '\n');
    app.releaseSingleInstanceLock();
    app.exit(3);
    // app.exit() before 'ready' ends the process on the spot (measured 2026-10-10: not one more
    // line of this script runs). process.exit is the second guard: everything below boots a Mantle.
    process.exit(3);
  } else if (openReq && openReq.ok) {
    process.stdout.write(`mantle: asked the running Mantle (${app.getPath('userData')}) to open its ${openReq.label}.\n`);
    app.exit(0);
    process.exit(0);
  } else {
    // Delivered, so the running instance logs the refusal too; this side says it as well.
    process.stderr.write(`${openReq ? openReq.line : 'mantle: --open needs a value'}\n`);
    app.exit(4);
    process.exit(4);
  }
}

/**
 * Every OTHER electron.exe running THIS repo (and, in test mode, this profile).
 * Same matching rule as tools/kill-test.ps1 and tools/restore-windows.ps1: the
 * repo's folder path inside the command line, which every Mantle has and no other
 * Electron app does. Owen's browser is an Electron app; nothing here may ever
 * count it, let alone touch it. This only ever READS the process list.
 */
function findOtherMantle() {
  const needle = flags.test ? `--profile-name=${flags.profileName}` : ROOT;
  const ps = [
    '$mine = ' + process.pid + ';',
    '$needle = ' + JSON.stringify(needle) + ';',
    "@(Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" |",
    '  Where-Object { $_.ProcessId -ne $mine -and $_.CommandLine -and $_.CommandLine.ToLowerInvariant().Contains($needle.ToLowerInvariant()) }) |',
    '  ForEach-Object { $_.ProcessId }',
  ].join(' ');
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      encoding: 'utf8', timeout: 15000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const pids = String(out || '').split(/\r?\n/).map((s) => s.trim()).filter((s) => /^\d+$/.test(s));
    return { pids, reason: '' };
  } catch (err) {
    // Not fatal: the lock is still a witness. But a check that quietly did not
    // run must not be mistaken for a check that found nothing.
    return { pids: [], reason: `could not read the process list to look for one (${err.message})` };
  }
}

// ---------------------------------------------------------------------------
// The --live gate. `electron .` with neither flag used to mean LIVE, so a bare
// "does it still boot?" reached into Owen's shell. It now costs nothing.
// Exits BEFORE any window is created and BEFORE the sidecar is spawned.
// ---------------------------------------------------------------------------
if (!flags.test && !flags.live) {
  process.stdout.write('mantle: live mode changes your Windows taskbar. Run with --live to accept, or --test --profile-name=<x> for a harmless test window.\n');
  app.exit(2);
}

if (flags.live) {
  // Printed BEFORE anything touches the shell, so the way out is already on
  // screen (and in the scrollback) by the time there is anything to get out of.
  process.stdout.write('mantle: starting LIVE. Windows will be put back on quit, on crash, and on kill.\n');
  process.stdout.write(`mantle: if anything goes wrong, run this and Windows comes back:\n    ${RECOVERY_CMD}\n`);
  process.stdout.write(`mantle: the original shell state is recorded in ${STATE_FILE}\n`);
  // The pause is for a person at a console. The logon task, the `mantle` command and every go-live
  // start Mantle through Task Scheduler, with no console to read or press Ctrl+C in, and the 3 s
  // was 3 s of Windows' own taskbar at every logon (lib/start-wake.js countdownVerdict).
  const countdown = require('./lib/start-wake').countdownVerdict({ live: true, tty: process.stdout.isTTY === true });
  process.stdout.write(`mantle: ${countdown.line}\n`);
  if (countdown.pause) sleepSync(countdown.pause);
}

/**
 * Block this thread for real, before the app is ready and before anything else
 * is running. A setTimeout would let the boot race past the pause it is supposed
 * to be, and the pause is the point: it is the window in which Owen can read the
 * recovery line and change his mind.
 */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch (err) {
    // Not worth failing a boot over, but not worth hiding either.
    process.stdout.write(`mantle: could not pause before starting (${err.message}); starting now\n`);
  }
}

if (!app.requestSingleInstanceLock()) {
  process.stderr.write(`mantle: another instance is already using ${app.getPath('userData')}; this one is exiting\n`);
  app.exit(0);
}

// ---------------------------------------------------------------------------
// Everything the process holds on to.
// ---------------------------------------------------------------------------
const state = new ShellState(MODE, flags.barEdge);

// Appended to the live reasons when a previous run died without restoring. The
// State has to say that it happened; a recovery that runs invisibly is just a
// mystery with a happy ending.
let dirtyStartNote = '';

dirtyStartGuard();

/*
 * MANTLE_SIDECAR_EXE=<path>: TEST ONLY. Run this instance against another sidecar exe.
 *
 * WHY (2026-09-22): the live Mantle holds sidecar/bin/Mantle.Sidecar.exe open, so a newly
 * built sidecar lands somewhere else (sidecar/bin-next/) and could not be tried from a test
 * bar at all -- every --test instance spawned the old v0.2 exe and the new commands (media,
 * the UIA tray) answered "unknown command". This lets one test instance point at the new exe
 * without touching sidecar/bin, which other test instances may be running.
 *
 * Honoured ONLY with --test: a live shell that quietly swapped its sidecar because of an
 * environment variable left over in some terminal is exactly the kind of surprise the --live
 * rule exists to prevent. An override that names no file is refused out loud and never
 * "fixed" by running build.ps1 into it (the default path's missing-exe build is kept).
 */
const SIDECAR_EXE_DEFAULT = path.join(ROOT, 'sidecar', 'bin', 'Mantle.Sidecar.exe');
const SIDECAR_EXE_OVERRIDE = (() => {
  const raw = process.env.MANTLE_SIDECAR_EXE;
  if (!raw) return null;
  if (!flags.test) {
    process.stdout.write(`mantle: MANTLE_SIDECAR_EXE=${raw} is ignored: it is honoured only with --test, and this is a live run\n`);
    return null;
  }
  const abs = path.resolve(ROOT, raw);
  process.stdout.write(`mantle: test run using the sidecar at ${abs} (MANTLE_SIDECAR_EXE), not ${SIDECAR_EXE_DEFAULT}\n`);
  return abs;
})();

/*
 * CRASH RECOVERY (lane mantle-supervisor, 2026-10-15; the whole design is at the top of lib/supervisor.js).
 * A detached `Mantle.Sidecar.exe --supervise=<this pid>` outlives this process and starts it again if it
 * dies without saying it quit on purpose. Started here, as early as the sidecar exe is known and the lock is
 * ours (a second instance never got this far), so a crash during the rest of the start is caught too.
 * Every deliberate way out calls supervisor.standDown(why) FIRST: shutdown(), the kill switch, and both
 * "Restore Windows taskbar" roads.
 */
const supervisor = require('./lib/supervisor').makeSupervisor({
  fs, path, spawn: require('child_process').spawn,
  alive: (pid) => { try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; } },
  kill: (pid) => process.kill(pid),
  // stand-down's last resort (its record could not be written): a hidden PowerShell, detached so a quit never
  // waits on it, stops every supervisor started for this main (twice: a copy can appear a moment after its launcher)
  killSupervisorsOf: (mainPid) => {
    const n = Number(mainPid);
    if (!Number.isInteger(n) || n <= 0) return;
    const ps = `foreach ($w in 800, 2500) { Start-Sleep -Milliseconds $w; Get-CimInstance Win32_Process -Filter "Name='Mantle.Sidecar.exe'" | Where-Object { $_.CommandLine -match '--supervise=${n}(\\s|"|$)' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } }`;
    const c = require('child_process').spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-Command', ps],
      { detached: true, stdio: 'ignore', windowsHide: true });
    c.on('error', () => { /* said by the caller's line; nothing else can be done on the way out */ });
    c.unref();
  },
  now: Date.now,
  log: (line) => process.stdout.write(`mantle: ${line}\n`),
  setInterval, clearInterval,
  pid: process.pid, execPath: process.execPath, argv: process.argv.slice(1), cwd: process.cwd(), root: ROOT,
  userData: app.getPath('userData'), exePath: SIDECAR_EXE_OVERRIDE || SIDECAR_EXE_DEFAULT, flags, env: process.env,
});
supervisor.start();

const sidecar = new Sidecar({
  exePath: SIDECAR_EXE_OVERRIDE || SIDECAR_EXE_DEFAULT,
  // null = never build: an override path is someone else's build output, not build.ps1's
  buildScript: SIDECAR_EXE_OVERRIDE ? null : path.join(ROOT, 'sidecar', 'build.ps1'),
  passive: flags.test,
  cwd: ROOT,
  stateFile: STATE_FILE,
  // The liveness check's timing (lib/sidecar.js: a ping every 15 s, 3 s limit, 3 misses). A --test run
  // may shorten it (MANTLE_TEST_SIDECAR_HEALTH=ms,limitMs,misses) so a frozen-helper test is quick.
  ...(() => {
    const t = flags.test && /^(\d+),(\d+),(\d+)$/.exec(process.env.MANTLE_TEST_SIDECAR_HEALTH || '');
    return t ? { healthMs: Number(t[1]), healthTimeoutMs: Number(t[2]), healthMisses: Number(t[3]) } : {};
  })(),
});

/**
 * A previous live run died without restoring. Put Windows back FIRST, then start.
 *
 * WHY before anything else: the sidecar is about to write a fresh "original" into
 * the state file. If the last run left the taskbar in a state it chose, that
 * state would be recorded as the original and become permanent -- one dirty exit
 * would turn into a setting Owen never picked. Recovering first means the
 * original we record is a real original.
 *
 * -NoKill because the process it would otherwise stop is this one.
 * Live only: a test run is not allowed to call SHAppBarMessage at all, and a
 * passive sidecar never changed anything for the file to be dirty about.
 */
/** The dirty-start note, ready to append to a reason. Empty when there was none. */
function note() {
  return dirtyStartNote ? ' ' + dirtyStartNote : '';
}

function dirtyStartGuard() {
  if (!flags.live) return;
  let raw;
  try {
    raw = fs.readFileSync(STATE_FILE, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      dirtyStartNote = `(could not read ${STATE_FILE} to check whether the last run exited cleanly: ${err.message})`;
      process.stdout.write(`mantle: ${dirtyStartNote}\n`);
    }
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.replace(/^﻿/, ''));
  } catch (err) {
    dirtyStartNote = `(${STATE_FILE} is not readable JSON: ${err.message}; Mantle could not tell whether the last run exited cleanly)`;
    process.stdout.write(`mantle: ${dirtyStartNote}\n`);
    return;
  }
  if (!parsed || parsed.restored !== false) return;

  process.stdout.write(`mantle: the last run left ${STATE_FILE} marked restored:false, so it died without putting Windows back. Recovering first.\n`);
  try {
    const out = execFileSync('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', RESTORE_SCRIPT,
      '-StateFile', STATE_FILE, '-NoKill',
    ], { cwd: ROOT, encoding: 'utf8', timeout: 30000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    process.stdout.write(String(out || '').trim() + '\n');
    dirtyStartNote = '(the previous run died without restoring; Windows was put back before this one started)';
  } catch (err) {
    const said = [err.stdout, err.stderr].map((s) => String(s || '').trim()).filter(Boolean).join(' / ');
    dirtyStartNote = `(the previous run died without restoring and the recovery script could not finish: ${err.message}${said ? ` -- it said: "${said}"` : ''}; run ${RECOVERY_CMD} by hand)`;
    process.stderr.write(`mantle: ${dirtyStartNote}\n`);
  }
}
// <mainrel:appicon> (lib/main-guard.test.js runs this region with a fake sidecar)
/*
 * THE LAUNCHER'S ICON RESOLVER. The index module asks us for icons; we ask the sidecar. A sidecar
 * that is down means "no icon", not "no index" -- a launcher list without pictures is still a
 * launcher list.
 * STORE APPS (core-needs, 2026-09-30): a Store app's row (Calculator, Notepad, Terminal, Photos...)
 * asks for 'shell:AppsFolder\<app id>'. That used to go to the sidecar's `icon` command, which reads
 * FILES: "no such file", a warning in the log, and the index then stopped asking the rest
 * (lib/launcher-index.js fillStoreIcons probes one first), so every Store app wore a letter tile.
 * The sidecar's `app` command is the one that asks the shell for an app id's picture (the pinned
 * list already uses it, lib/pinned.js); a Store path goes there now. Only a well-formed package app
 * id is sent -- the same shape the index keeps (PackageFamily_publisherid!App) -- so a crafted row
 * cannot hand the shell an arbitrary parsing name.
 */
const APPS_FOLDER = 'shell:appsfolder\\';
const STORE_AUMID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}_[A-Za-z0-9]{8,20}![A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PNG_URL = 'data:image/png;base64,';
/**
 * 'shell:AppsFolder\<id>' -> the id; null when it is not such a path; false when it is but the id is
 * not a package app id. A prefix test, not a regex with (.+): an id with a line break in it must
 * not fall through to `icon`.
 */
function storeAumidOf(p) {
  const s = p == null ? '' : String(p);
  if (s.slice(0, APPS_FOLDER.length).toLowerCase() !== APPS_FOLDER) return null;
  const id = s.slice(APPS_FOLDER.length);
  return STORE_AUMID_RE.test(id) ? id : false;
}
/** A Store app's picture out of the `app` reply, or null. */
function appReplyPng(r) {
  return r && r.ok !== false && typeof r.iconPng === 'string' && r.iconPng.startsWith(PNG_URL) ? r.iconPng : null;
}
function makeIconResolver(sc) {
  return async (p) => {
    const s = p == null ? '' : String(p);
    if (!s) return null;
    const store = storeAumidOf(s);
    try {
      if (store === false) return null;
      if (store) return appReplyPng(await sc.call('app', { aumid: store }, 4000));
      const r = await sc.call('icon', { path: s });
      return r && r.icon ? r.icon : null;
    } catch (_) {
      return null;
    }
  };
}
// </mainrel:appicon>
const apps = new Apps({ modulePath: modulePathFor(ROOT), icon: makeIconResolver(sidecar) });

let barWin = null;
let launcherWin = null;
let desktopWin = null;
let tray = null;
let lastWindows = [];      // last window list the sidecar sent, for replay on subscribe
let lastTray = null;       // last notification-area list, or null if never read
let trayTimer = null;
let barPopover = null;     // {key, height} while the bar has borrowed extra room
let lastThumbSync = null;  // the flyout's last bar.thumbs answer (lib/thumbs.js sync), for the --flyout capture
let shuttingDown = false;
// The hwnd we registered as an app bar, remembered rather than re-read: at
// restore time the bar window may already be destroyed, and hwndOf() on a dead
// window throws. A handle we can no longer ask for is a reservation we could no
// longer drop.
let appbarHwnd = null;
// The last {"ev":"restore"} the sidecar sent, so "the sidecar exited" is never
// reported as "Windows is back" on nothing but hope.
let lastRestoreEvent = null;

// The most the bar may grow for a popover. A cap, not a suggestion: a bar that
// asked for 4000px would become a full-screen always-on-top window.
// 640, was 480 (2026-09-27): the live log had Quick Settings asking 483-488 px (its main view
// had grown past the cap: 3-8 px of its top cut off, 15 times), 523-542 px, and 602-618 px with a
// list expanded (about 130 px cut off), 22 capped asks in all; 640 holds the largest seen. On
// Owen's 1536x864 DIP screen (1920x1080 at 125%) the tall window then reaches y=162 DIP, still
// well under the top bar. The pages that size themselves to "main's 480 cap" (spotify.js
// ROOM_MAX, qs-more.js, downloads/notifications) keep working: they ask for less.
// Was 320 before that: Quick Settings asked for 429 live (2026-09-21) and had its top cut off.
const POPOVER_MAX = 640;
// In hover mode the window is ALWAYS POPOVER_MAX taller than the bar (barTall), so this is also
// how much invisible window sits above the pill -- cut away by its shape until a popover opens.
// The popover's entrance: .pop's wipe in ui/bar/bar.css runs this long (the window's old 200 ms grow).
const POP_WIPE_MS = 200;
let restoreChain = Promise.resolve();
// lib/features.js's handle, from app ready on (null before, and in any path that runs before it).
let features = null;

// --- the hover bar -----------------------------------------------------------
// How close to the bottom edge the cursor has to get, in DIP. Two, not one:
// Windows parks the cursor ON the last row, but a display whose scale factor is
// not 1 rounds, and a one-pixel target that misses one time in five reads as
// "the bar is broken".
// Four, not two: the edge clip stops the cursor 2 px short of the bottom row, so
// a 2 DIP band would be a target the mouse can never land in. The band is the
// bottom 4 DIP of the display, full width, and the reachable half of it is real.
const REVEAL_BAND_DIP = 4;
const POLL_HIDDEN_MS = 80;     // cheap: one cursor read, no Win32 call
/*
 * How fast the bar gets out of the way (build 23, measured: the pill was still
 * fully up 856 ms after the cursor left, and Owen's read of that was "when it
 * goes away it just waits a second and then disappears").
 *
 * The delay was the grace period plus up to a whole poll interval: 500 + 120.
 * 180 + 60 puts the START of the exit ~200-240 ms after the cursor leaves, which
 * is quick enough to feel like a response and still long enough to survive the
 * cursor clipping a corner on its way past. The popover exception and the page's
 * own hover truth are untouched -- they are what make a short grace safe.
 */
const POLL_SHOWN_MS = 60;
const HIDE_GRACE_MS = 180;     // cursor outside the bar this long before it goes
const HIDE_SLIDE_MS = 350;     // between the 'bar.hide' event and barWin.hide(): the page's 320 ms exit, plus 30

/*
 * THE MOVEMENT. Owen: it must feel like the Northwind site's nav detaching.
 *
 * MAIN ANIMATES THE WINDOW; the page only fades paint properties. A renderer
 * cannot move its own window, so a CSS transform sliding the page inside a static
 * window would show the bar's glass already sitting there with an empty page
 * sliding through it. The sidecar's `morph` walks SetWindowPos + SetWindowRgn on
 * its own thread at ~60 fps, which is the only place the real edges can move.
 *
 * 560 ms out, 320 ms back: leaving is not an event, arriving is. The curve is the
 * Northwind nav's own -- fast off the mark, long settle, no overshoot.
 */
const REVEAL_MS = 560;
const HIDE_MS = 320;
const REVEAL_EASE = [0.22, 0.68, 0.30, 1];

// The pill's geometry, all DIP. Width is capped so it stays a pill on a wide
// monitor instead of becoming an edge bar with corners.
const PILL_MAX_W_DIP = 1120;
const PILL_SIDE_GAP_DIP = 28;   // total, both sides: the least air beside the pill
const PILL_LIFT_DIP = 14;       // how far it floats above the screen edge
const PILL_RADIUS_DIP = 0;      // was 24 (30 physical). A window REGION on a transparent Electron window
                                // (WS_EX_NOREDIRECTIONBITMAP, DirectComposition) blanks it: measured live
                                // 2026-09-21, the island drew NOTHING with its rounded region set and drew
                                // fine the instant the region was cleared. So the pill's ONLY shape is the
                                // CSS radius in ui/bar (24 dip); roundBarCorners just turns DWM's window
                                // border off so no square outline sits outside the CSS corners.
const PILL_START_W = 1;         // PARKED AT ITS FULL WIDTH (lane mantle-barpolish, 2026-10-15). It was 0.62: the
                                // window parked 62 % wide, so every reveal resized it 868 -> 1400 px and the page
                                // laid the dock out again (and re-judged "+N") on the reveal's first frames. The
                                // island no longer grows (ui/bar/bar.css: transform + opacity only), so the parked
                                // page is already laid out at the size it is shown at, and a reveal only MOVES it.
let hoverTimer = null;
let hoverHeld = null;           // the game the hover poll is stopped for (hoverTick / hoverAfterRest)
let barRevealed = false;
let barLeftAt = null;          // when the cursor last left the bar, or null while it is in
let barOutAt = null;           // when it last left the overshoot band too (lib/bar-intent.js), or null
// TEST ONLY: the hover poll's stand-in cursor (bar.testCursor), off the screen until a test moves it
let testCursor = flags.test && process.env.MANTLE_BAR_TEST_CURSOR === '1' ? { x: -10000, y: -10000 } : null;
let rendererHoverAt = 0;       // last 'bar.hover' {inside:true} from lane B's page
/*
 * THE BAR IS NEVER hide()-DEN: it is PARKED below the screen edge (build 29).
 *
 * Owen: "you had it at one point a few minutes ago it had started working now it
 * doesnt again". Measured with a WM_LBUTTONUP hook on the window and a mousedown
 * trace in the page (builds 26-28): the FIRST reveal after start took clicks;
 * after one hide()/showInactive() cycle the window still received every mouse
 * message but the page never saw another mousedown -- with the re-raise off too,
 * so it was the cycle itself, on this window (transparent, frameless,
 * focusable:false, always-on-top). Keeping the window shown and moving it below
 * the screen with the sidecar's `place` instead (build 29) kept clicks working
 * through every cycle, popovers included. So parkBar() is the hide, and
 * barWin.hide() is only the fallback when the sidecar cannot place the window.
 */
let barParked = false;         // the window is shown but sits below the screen edge
let hideTimer = null;
let foregroundReason = null;   // why the fullscreen check is not being made, if it is not
let hoverFirstTick = true;
const HOVER_DEBUG = process.env.MANTLE_HOVER_DEBUG === '1';
let hoverDebugAt = 0;

// --- the pinned/running list the bar renders ---------------------------------
let lastPinned = null;         // the last {ok, reason, items} pushed, for replay
let pinnedPushTimer = null;
let pinnedPushWhy = null;
let pinnedBuilding = null;     // in-flight build, so ten triggers make one list
let unwatchPins = null;
const iconCache = new Map();   // path (lowercased) -> {icon, reason} + its file stamp (lib/icon-fresh.js)
// A cached icon is asked for again when its file changed (a stat every 2 s at most) or after this
// long (a .lnk does not change when its target exe is rebuilt; the sidecar checks that, and answers
// from its own cache otherwise). Before 2026-10-08 an entry was kept until Mantle restarted, so a
// rebuilt app (Helm) kept its old picture on the bar.
const ICON_RECHECK_MS = 60 * 1000;
const pinById = new Map();     // Item id -> the pin record, for bar.open's lnkPath
// The key sequences the bar's system buttons are allowed to press. A whitelist,
// not a filter: 'keys' can type ANYTHING into the foreground window, and a bar
// button is not a reason to hand a renderer a keyboard.
const KEYS_ALLOWED = new Set(['win+a', 'win+n', 'win+d']);

// ---------------------------------------------------------------------------
// Talking to the pages.
// ---------------------------------------------------------------------------
// <mainrel:broadcast> (lib/main-rel.test.js runs this region with fake windows)
/*
 * A page whose renderer died is NOT destroyed: its webContents lives on until it reloads or its
 * window closes. Electron's send() to it does not throw -- it prints "Error sending from
 * webFrameMain: Render frame was disposed" with a stack, once per send (measured with a probe:
 * a renderer killed after one reload, 1 error per send; isCrashed() is already true inside its
 * render-process-gone handler). One mass kill put 142 of them and ~635 stack lines in the live
 * log, one per state change. So a dead page is skipped, and said once per death, not per send.
 */
const deadPagesSaid = new WeakSet();
let pushWords = (name, payload) => payload;   // set after this region: raw codes become words (lib/plain-error.js)
/* WHAT MOVES WITH THE BAR (lane mantle-corner, 2026-10-16). Owen: the corner pop-ups should sit in the
   corner and "just ... smoothly move up if the taskbar comes up". Called on the SAME tick the bar's page
   is told ('bar.reveal' / 'bar.hide'), so the bar and its neighbours start together. barUpNow is where the
   bar is headed: --dock is always up; a bar on its way out already counts as gone. */
const barMotionFns = new Set();
function barMotion(up, ms, why) {
  for (const fn of barMotionFns) {
    try { fn({ up, ms, why }); } catch (err) { process.stderr.write(`mantle: something that moves with the bar threw (${why}): ${err.message}\n`); }
  }
}
function barUpNow() { return !!flags.dock || (barRevealed && !hideTimer); }
function broadcast(name, payload) {
  payload = pushWords(name, payload);
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    const wc = win.webContents;
    if (!wc || wc.isDestroyed()) continue;
    let dead = false;
    try { dead = wc.isCrashed(); } catch (_) { dead = true; }
    if (dead) {
      if (!deadPagesSaid.has(wc)) {
        deadPagesSaid.add(wc);
        let url = '';
        try { url = String(wc.getURL() || ''); } catch (_) { /* gone */ }
        const page = (/\/ui\/([^?#]+)/.exec(url.replace(/\\/g, '/')) || [])[1] || 'a page';
        process.stdout.write(`mantle: ${page}'s renderer is gone, so it gets no state until it is reloaded (said once per death)\n`);
      }
      continue;
    }
    deadPagesSaid.delete(wc);
    try { wc.send('mantle:event', { name, payload }); } catch (_) { /* window went away mid-send */ }
  }
}
// </mainrel:broadcast>
pushWords = (name, payload) => toPage(`push ${name}`, payload);

/*
 * MANTLE'S APPEARANCE: light, dark or Match Windows (lane dm-core, 2026-10-08; lib/theme.js).
 * preload.js asks for it synchronously before each page's first paint (mantle:theme-now) and applies
 * the `theme` event live. Windows' app mode comes from nativeTheme, which follows AppsUseLightTheme
 * because nothing in Mantle sets nativeTheme.themeSource (one window's FRAME is set through the
 * sidecar instead; see lib/features/settings.js). Main-drawn colours follow through themeHost:
 * the solid window grounds and the DWM frames of the acrylic app windows.
 */
let themeCore = null;
let themeFakeWindows = null;   // --test only (theme.testWindows): a made-up Windows app mode, never Owen's
const themeFollowers = new Set();
function getTheme() {
  if (themeCore) return themeCore;
  themeCore = createTheme({
    file: path.join(app.getPath('userData'), 'theme.json'),
    windowsMode: () => (flags.test && themeFakeWindows ? { mode: themeFakeWindows, why: null } : windowsModeFrom(nativeTheme)),
    override: flags.theme,
    log: (line) => process.stdout.write(`mantle: ${line}\n`),
  });
  themeCore.on((view) => {
    // look sync: the payload carries the --lg-* overrides for the new theme (preload.js stamps them)
    broadcast('theme', themePayload(view));
    if (lookHost) lookHost.themeChanged(view);
    for (const fn of Array.from(themeFollowers)) {
      try { fn(view.theme); } catch (err) { process.stderr.write(`mantle: a theme follower threw: ${err && err.message ? err.message : err}\n`); }
    }
  });
  if (flags.theme) process.stdout.write(`mantle: --theme=${flags.theme}: this test run shows ${themeCore.theme()} and never saves a change\n`);
  return themeCore;
}
/** What lib/ modules get: the theme now, and fn('dark'|'light') after every change. -> off() */
const themeHost = {
  get: () => getTheme().theme(),
  onChange(fn) {
    if (typeof fn !== 'function') throw new Error('themeHost.onChange needs a function');
    themeFollowers.add(fn);
    return () => themeFollowers.delete(fn);
  },
};

/*
 * LOOK SYNC with Helm and Quartz (lane looksync-mantle, 2026-10-10; lib/look-host.js, lib/look-desktop.js,
 * vendored lib/look-sync.js; spec ~/look-sync/CONTRACT.md). Theme, accent hue and dark glass are shared
 * through %APPDATA%\look-sync\look.json (LOOK_SYNC_DIR in tests); Mantle also publishes the desktop
 * wallpaper there (a still first, then the record) and makes Windows' own wallpaper the same picture.
 * The look reaches every page as --lg-* overrides (lookHost.vars) on the 'theme' event and before first
 * paint (mantle:theme-now with 'look'); none at the seed values, so the default look is the stylesheet's.
 */
let lookHost = null;
let lookDesktop = null;
let lastDeskRec = null;               // the desktop record (rev|id) the wallpaper glass last heard of
function getLook() {
  if (lookHost) return lookHost;
  const core = getTheme();
  lookHost = require('./lib/look-host').makeLookHost({
    LS: require('./lib/look-sync'),
    accent: require('./lib/accent'),
    file: path.join(app.getPath('userData'), 'look-sync.json'),
    // A --test run NEVER shares Owen's real %APPDATA%\look-sync (2026-10-10: a test instance without
    // LOOK_SYNC_DIR published its own wallpaper into the real file and live Quartz followed it): it uses
    // LOOK_SYNC_DIR when a test sets one, else a look-sync folder inside its own temp profile.
    dir: process.env.LOOK_SYNC_DIR || (flags.test ? path.join(app.getPath('userData'), 'look-sync') : undefined),
    // --theme=<mode> pins a test run: a shared theme never overrides the pin
    theme: { mode: () => core.mode(), resolved: () => core.theme(),
      set: (m) => (flags.theme ? { ok: false, reason: `this test run is pinned by --theme=${flags.theme}` } : core.set(m)) },
    log: (line) => process.stdout.write(`mantle: ${line}\n`),
  });
  lookHost.onChange((e) => {
    if (e.varsChanged) broadcast('theme', themePayload(getTheme().get()));
    broadcast('look', e.view);
  });
  if (lookHost.sync && typeof lookHost.sync.on === 'function') {
    lookHost.sync.on('status', lookFallbackSaid);
    if (typeof lookHost.sync.status === 'function') lookFallbackSaid(lookHost.sync.status());
  }
  return lookHost;
}

/*
 * A FALLBACK LOOK IS NEVER SILENT (lane mn-recover, 2026-10-12, from mn-looksync). When sync is on but
 * the shared look cannot be used as it is (the file was damaged and reset, is from a newer version, or
 * cannot be read), the look changes or stops following with no word outside Settings. Its reason is shown ONCE in a toast,
 * the same pop-up page the keep-on-top shortcut uses (ui/ontop); the same failure is not said again
 * until the shared look has been fine in between. Never in front of Owen in a --test run (the page
 * still draws, so a test can read it). The log names the state only: the reason can hold a path.
 */
let lookToastSaid = null;    // the fallback state last shown (cleared by an ok)
let lookToastWin = null;
let lookToastTimer = null;
function lookFallbackSaid(s) {
  if (!s || typeof s !== 'object') return;
  if (s.state === 'ok') { lookToastSaid = null; return; }
  if (s.state !== 'corrupt' && s.state !== 'newer' && s.state !== 'error') return;
  if (lookHost && lookHost.sync && lookHost.sync.enabled === false) return;   // sync off: Mantle's own look is the choice
  // Once per state until an ok: 'error' repeats while lib/look-sync.js retries, each time with a new delay.
  if (s.state === lookToastSaid) return;
  lookToastSaid = s.state;
  // corrupt: lib/look-sync.js moved the damaged file aside and wrote Mantle's look in its place;
  // newer: another app's newer version wrote it, so Mantle only reads; error: it cannot be read at all.
  const text = s.state === 'corrupt' ? 'The shared look was reset' : s.state === 'newer' ? 'Look sync is read-only' : 'Look sync cannot reach the shared look';
  process.stdout.write(`mantle: look sync: the shared look is ${s.state}; a pop-up says why\n`);
  lookToastShow({ text, reason: s.reason || 'the shared look cannot be used, and no reason was given', tone: 'warn', did: 'failed' });
}

function lookToastShow(payload, label) {   // label: who the log lines name (default look sync)
  const who = label || 'look sync';
  if (!app.isReady()) { app.whenReady().then(() => lookToastShow(payload, label)); return; }
  const W = 360 + 36, H = 44 + 36;   // the ontop pop-up's own size (lib/features/ontop.js, MARGIN 18)
  try {
    if (!lookToastWin || lookToastWin.isDestroyed()) {
      lookToastWin = new BrowserWindow({
        show: false, frame: false, transparent: true, skipTaskbar: true, hasShadow: false, focusable: false,
        resizable: false, movable: false, minimizable: false, maximizable: false, alwaysOnTop: true,
        width: W, height: H, x: -32000, y: -32000,
        webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false },
      });
      lookToastWin.setAlwaysOnTop(true, 'screen-saver');
      lookToastWin.setIgnoreMouseEvents(true);
      const lw = lookToastWin;
      lw.webContents.on('will-navigate', (e) => e.preventDefault());
      lw.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      lw.webContents.on('render-process-gone', (_e, d) => {
        process.stdout.write(`mantle: ${who}: the pop-up page crashed (${d && d.reason})${who === 'look sync' ? '; the reason is still in Settings' : ''}\n`);
        if (lookToastWin === lw) lookToastWin = null;
        try { lw.destroy(); } catch (_) { /* gone */ }
      });
      lw.loadFile(path.join(ROOT, 'ui', 'ontop', 'index.html'));
    }
    const w = lookToastWin;
    const wa = screen.getPrimaryDisplay().workArea;
    w.setBounds({ x: Math.round(wa.x + (wa.width - W) / 2), y: Math.round(wa.y + wa.height - H - 8), width: W, height: H });
    const send = () => { if (!w.isDestroyed()) w.webContents.send('mantle:event', { name: 'ontop.toast', payload: toPage('ontop.toast', Object.assign({ hint: '', below: false }, payload)) }); };
    if (w.webContents.isLoading()) w.webContents.once('did-finish-load', send); else send();
    if (!flags.test) {
      w.showInactive();
      raiseWin.up(w, { what: `the ${who} pop-up`, log: (line) => process.stdout.write(`mantle: ${line}\n`), wanted: () => lookToastWin === w && !w.isDestroyed() && w.isVisible() });
      if (w.isVisible()) process.stdout.write(`mantle: ${who}: the pop-up is shown\n`);
    }
    clearTimeout(lookToastTimer);
    lookToastTimer = setTimeout(() => {
      lookToastTimer = null;
      if (lookToastWin && !lookToastWin.isDestroyed()) lookToastWin.destroy();
      lookToastWin = null;
    }, flags.test ? 30000 : 9000);   // a --test run keeps the page a while so a test can read it
    if (lookToastTimer.unref) lookToastTimer.unref();
  } catch (err) {
    process.stdout.write(`mantle: ${who}: the pop-up could not show (${err && err.message})${who === 'look sync' ? '; the reason is still in Settings' : ''}\n`);
  }
}
/**
 * The desktop wallpaper's publisher (lib/look-desktop.js): after lib/wallpaper.js has started. Runs with
 * look sync ON or OFF (the record is a fact about the screen); looks again on every wallpaper change
 * (State's `wallpaper` piece), never on a timer. A test run never touches Windows' wallpaper.
 */
function startLookDesktop() {
  if (lookDesktop) return;
  try {
    const look = getLook();
    const { nativeImage } = require('electron');
    lookDesktop = require('./lib/look-desktop').makeDesktopPublisher({
      sync: look.sync,
      LS: require('./lib/look-sync'),
      current: () => wallpaper.current(),
      screen: () => { const p = toPhys(screen.getPrimaryDisplay().bounds); return { w: p.w, h: p.h }; },
      nativeImage,
      gifFrame: require('./lib/gif-frame').firstFrame,
      frame: () => wallStill.frame(),
      capture: async () => {
        if (!desktopWin || desktopWin.isDestroyed()) throw new Error('the desktop layer is not there');
        return desktopWin.webContents.capturePage();
      },
      windows: {
        get: async () => {
          const r = await sidecar.call('perso.background', {}, 8000);
          return { ok: true, picture: r && r.picture, fit: r && r.fit };
        },
        set: async (file) => {
          const r = await sidecar.call('perso.set', { key: 'picture', value: file, dryRun: false }, 15000);
          if (!r || r.ok === false) return { ok: false, reason: (r && (r.reason || r.error)) || 'Windows did not say' };
          const bg = r.background || {};
          if (bg.fit && bg.fit !== 'fill') {
            const f = await sidecar.call('perso.set', { key: 'fit', value: 'fill', dryRun: false }, 15000).catch((e) => ({ ok: false, reason: e.message }));
            if (!f || f.ok === false) return { ok: true, note: `its fit stays "${bg.fit}": ${(f && (f.reason || f.error)) || 'Windows did not say'}` };
          }
          return { ok: true };
        },
      },
      // the lock screen shows the same picture (Owen, 2026-10-10): the sidecar's WinRT LockScreen route
      // (sidecar/SysPersoLock.cs). A sidecar built without it answers "Read only: ..." and that reason
      // is the status Settings shows. The publisher never calls this in a test run.
      lock: {
        get: async () => {
          const r = await sidecar.call('perso.lock', {}, 8000);
          if (!r || r.canSet === false) return { ok: false, reason: (r && r.pictureWhy) || 'Windows did not say' };
          return { ok: true, picture: r.picture || null };
        },
        set: async (file) => {
          const r = await sidecar.call('perso.lockPicture', { path: file, dryRun: false }, 30000);
          if (!r || r.ok === false) return { ok: false, reason: (r && (r.reason || r.error)) || 'Windows did not say' };
          return { ok: true };
        },
      },
      afterWindows: (why) => {
        // Explorer redraws its wallpaper: make sure the desktop layer is still in front of it (the same
        // check DESKTOP_RECHECK_MS runs), once, a moment after
        const t = setTimeout(() => {
          if (!desktopWin || desktopWin.isDestroyed() || !desktopRecheckTimer) return;
          sidecar.call('desktop', { hwnd: hwndOf(desktopWin), recheck: true }, 4000).then((r) => {
            if (r && r.moved) process.stdout.write(`mantle: desktop layer put back in front of the wallpaper after ${why}: ${r.covering || 'a window'} had been placed over it\n`);
          }, (err) => process.stdout.write(`mantle: the desktop layer could not be re-checked after ${why}: ${err.message}\n`));
        }, 1500);
        if (t.unref) t.unref();
      },
      test: !!flags.test,
      onChange: (st) => {
        look.setDesktop(st);
        // a new record (a new still) is the dark glass's source 2 (lib/wall-still.js): look again
        const rv = st && st.desktop ? `${st.desktop.rev}|${st.desktop.id}` : null;
        if (rv !== lastDeskRec) { lastDeskRec = rv; wallStill.invalidate('the shared desktop still changed'); }
      },
      log: (line) => process.stdout.write(`mantle: look: ${line}\n`),
      // the shared top-band darkening (lib/look-guard.js; CONTRACT.md desktop.guard): worked out on a worker
      // thread from each still, for the shared dark glass and the primary monitor (DIP)
      guard: require('./lib/look-guard').makeGuardComputer({ nativeImage }),
      glass: () => look.guardGlass(),
      monitor: () => { const b = screen.getPrimaryDisplay().bounds; return [b.width, b.height]; },
    });
    // a new dark or light dim or blur (from any app) republishes the record with a new guard (dark + light); nothing else here does
    const glassKey = () => { const g = look.guardGlass(); const l = g.light || {}; return `${g.dim}|${g.blurPx}|${l.dim}|${l.blurPx}`; };
    let lastGlass = glassKey();
    look.onChange(() => {
      const k = glassKey();
      if (k === lastGlass) return;
      lastGlass = k;
      lookDesktop.check('the glass changed');
    });
    let lastWall = null;
    const look1 = () => {
      const w = JSON.stringify(state.get().wallpaper || null);
      if (w === lastWall) return;
      lastWall = w;
      lookDesktop.check('the wallpaper changed');
    };
    state.on('change', look1);
    look1();
  } catch (err) {
    process.stderr.write(`mantle: the desktop wallpaper publisher could not start: ${err && err.stack ? err.stack : err}\n`);
    if (lookHost) lookHost.setDesktop({ desktop: { ok: false, text: 'Not shared: the publisher did not start', reason: err && err.message ? err.message : String(err), rev: null, id: null, title: null, type: null },
      windows: { ok: false, text: 'Windows\' wallpaper was not changed', reason: 'the publisher did not start' },
      lock: { ok: false, text: 'The lock screen was not changed', reason: 'the publisher did not start' } });
  }
}

/** The 'theme' event's payload: the theme view plus that theme's look overrides. */
function themePayload(view) {
  let look = {};
  try { look = lookHost ? lookHost.vars(view.theme) : {}; } catch (err) { process.stderr.write(`mantle: the look overrides could not be worked out: ${err && err.message ? err.message : err}\n`); }
  return Object.assign({}, view, { look });
}

let lastProblemLine = null;

state.on('change', (snapshot) => {
  broadcast('state', snapshot);
  requestTray();   // batched: at most one rebuild per 250 ms, none when the menu's inputs did not move
  // The terminal's copy of the desktop layer's "needs attention" strip. The
  // strip is what Owen reads; this is what whoever started Mantle from a shell
  // reads, and it is the only way to see the state when the desktop window is
  // not up (--no-desktop, or a page that failed to load).
  const problems = state.problems();
  const line = problems.length
    ? problems.map((p) => `${p.piece}: ${p.reason}`).join('\n              ')
    : 'everything is as it should be';
  if (line !== lastProblemLine) {
    lastProblemLine = line;
    process.stdout.write(`mantle state: ${line}\n`);
  }
});

// ---------------------------------------------------------------------------
// THE HOVER BAR (2026-09-21).
//
// Owen: "all my pinned to taskbar things just icons centered, and when I put my
// mouse to the bottom of the screen it pulls up a glass UI taskbar with the
// pinned app icons, and the regular stuff on the right too."
//
// So the bar window is created hidden and STAYS hidden until the cursor touches
// the bottom two DIP of the primary display. It reserves no screen space (see
// --dock for the old behaviour), which is why a maximised window now gets the
// whole screen back.
//
// WHY A CURSOR POLL and not a mouse hook or a 1px always-on-top tripwire window:
// a low-level mouse hook is a global hook on Owen's machine -- the class of thing
// that made the 2026-09-21 incident possible -- and a tripwire window is one more
// always-on-top window fighting the taskbar for the same edge. screen.getCursor-
// ScreenPoint() is a read, it changes nothing, it cannot outlive this process,
// and at 80 ms it is far below anything measurable. It stops dead on quit.
//
// The Windows taskbar answers the SAME bottom edge (it is on auto-hide), so both
// slide up together. Mantle's bar is 'screen-saver' level and the sidecar's
// 'traywatch' re-raises it whenever the taskbar surfaces; the Windows taskbar is
// never hidden, moved or reordered by Mantle -- it just ends up underneath, and
// it is still there the moment Mantle dies.
// ---------------------------------------------------------------------------

/** One place that writes State.bar, so `revealed` can never drift from reality. */
function setBar(patch) {
  // ok:false unless the caller says otherwise: the renderer shows a chip only for a NOT-ok reason, so the
  // healthy narration ("the bar is up: ...") stays in State for the overflow menu without becoming a chip.
  state.set('bar', Object.assign({ mode: BAR_MODE, shape: BAR_SHAPE, reveal: REVEAL_BY, ok: false }, patch));
}

/**
 * Every bar reason carries pill mode's one standing caveat, because it is true
 * all the time and not discovering it is the whole point: Owen's Windows taskbar
 * is on auto-hide on the BOTTOM edge, the same edge the pill floats above, and it
 * still comes up underneath and beside it (probed live, 2026-09-21). Pill mode is
 * for a taskbar that has been moved to another edge. It works either way.
 */
function barReason(text) {
  return BAR_SHAPE === 'pill'
    ? `${text} -- pill shape: the Windows taskbar shares this edge, so it still comes up under and beside the pill unless it is moved to another edge`
    : text;
}

/**
 * Trim a physical rectangle to the desktop, and say whether it had to be trimmed.
 *
 * The sidecar refuses a capture rectangle that is even one pixel off the screen
 * (build 20: "the rect 260,1003 1400x78 is outside the screen"), and three of
 * those in a row back the whole loop off and drop the window to a flat tint. A
 * pixel of rounding is not worth that, so it is clamped -- and said, because a
 * capture that is quietly a pixel short is still a thing worth knowing.
 */
function clampToDisplay(rect) {
  if (!rect || !(rect.w > 0) || !(rect.h > 0)) return { rect, changed: false, note: null };
  let disp;
  try {
    disp = toPhys(screen.getPrimaryDisplay().bounds);
  } catch (_) {
    return { rect, changed: false, note: null };
  }
  const x = Math.max(disp.x, rect.x);
  const y = Math.max(disp.y, rect.y);
  const w = Math.min(rect.x + rect.w, disp.x + disp.w) - x;
  const h = Math.min(rect.y + rect.h, disp.y + disp.h) - y;
  if (x === rect.x && y === rect.y && w === rect.w && h === rect.h) return { rect, changed: false, note: null };
  if (!(w > 0) || !(h > 0)) {
    return { rect, changed: false, note: `the capture rectangle ${rect.x},${rect.y} ${rect.w}x${rect.h} is entirely off the desktop (${disp.x},${disp.y} ${disp.w}x${disp.h})` };
  }
  return {
    rect: { x, y, w, h },
    changed: true,
    note: `the capture rectangle was trimmed to the desktop: asked ${rect.x},${rect.y} ${rect.w}x${rect.h}, took ${x},${y} ${w}x${h}`,
  };
}

/** A DIP rectangle in the PHYSICAL pixels the sidecar wants, however that has to happen. */
function toPhys(dip) {
  try {
    const p = screen.dipToScreenRect(null, dip);
    if (p && p.width > 0 && p.height > 0) return { x: p.x, y: p.y, w: p.width, h: p.height };
  } catch (_) { /* fall through to the scale factor */ }
  const sf = screen.getPrimaryDisplay().scaleFactor || 1;
  return { x: Math.round(dip.x * sf), y: Math.round(dip.y * sf), w: Math.round(dip.width * sf), h: Math.round(dip.height * sf) };
}

/**
 * Where the bar rests and where it comes from, in both units, for whichever
 * shape is on.
 *
 * `rest` is on screen; `start` is the off-screen rectangle it morphs out of and
 * back into -- just past the edge, so the animation is the window arriving rather
 * than the window appearing. `r` is the window REGION's corner radius in physical
 * pixels: 0 for the edge bar (DWM rounds its two top corners instead) and 24 DIP
 * for the pill, whose roundness cannot come from CSS because DWM paints the glass
 * across the whole window.
 *
 * Everything here is derived from the primary display's DIP bounds and converted
 * once, so a scale-factor change moves the whole geometry rather than three
 * quarters of it.
 */
function barGeometry() {
  const b = screen.getPrimaryDisplay().bounds;
  const sf = screen.getPrimaryDisplay().scaleFactor || 1;
  const atTop = flags.barEdge === 'top';
  const h = BAR_H;

  let restDip;
  let startDip;
  let r = 0;

  if (BAR_SHAPE === 'pill') {
    const w = Math.min(PILL_MAX_W_DIP, Math.max(120, b.width - PILL_SIDE_GAP_DIP));
    const w0 = Math.max(80, Math.round(w * PILL_START_W));
    /*
     * THE WINDOW REACHES THE SCREEN EDGE; the PILL does not (2026-09-21).
     *
     * Owen: "when the taskbar expands out it isn't that smooth". The cause was
     * animating the WINDOW: every frame of the old morph was a SetWindowPos
     * resize of a transparent Electron window, and each resize makes Chromium
     * relayout, repaint and reallocate its surface -- so the window's edge ran a
     * frame ahead of the content inside it.
     *
     * Now the window never moves during a reveal and the PAGE animates the pill,
     * composited and vsync-locked. For that the window has to already cover
     * everywhere the pill travels: it spans from the pill's resting top all the
     * way DOWN to the screen edge (pill height + the 14 DIP of lift). The pill is
     * the top 48 DIP of the page; the bottom 14 DIP stay transparent, which is
     * the air under the island.
     *
     * The hot zone needs no change: the column under the island was already in it.
     */
    restDip = {
      x: b.x + Math.round((b.width - w) / 2),
      y: atTop ? b.y : b.y + b.height - h - PILL_LIFT_DIP,
      width: w,
      height: h + PILL_LIFT_DIP,
    };
    startDip = {
      x: b.x + Math.round((b.width - w0) / 2),   // same centre, narrower
      y: atTop ? b.y - h : b.y + b.height,       // just past the edge
      width: w0,
      height: h,
    };
    r = Math.round(PILL_RADIUS_DIP * sf);
  } else {
    restDip = { x: b.x, y: atTop ? b.y : b.y + b.height - h, width: b.width, height: h };
    startDip = { x: b.x, y: atTop ? b.y - h : b.y + b.height, width: b.width, height: h };
  }

  const rDip = BAR_SHAPE === 'pill' ? PILL_RADIUS_DIP : 0;

  /*
   * THE BOTTOM EDGE IS COMPUTED, NEVER ROUNDED (build 20, measured live).
   *
   * 62 DIP x 1.25 is 77.5, and rounding the HEIGHT on its own gives 78 -- so the
   * window landed at y 1003 with height 78, i.e. one pixel PAST the bottom of a
   * 1080-px screen. The sidecar then refused every backdrop frame ("the rect
   * 260,1003 1400x78 is outside the screen"), three failures in a row backed the
   * loop off, and the island fell back to the flat tint. The height is therefore
   * derived from the screen edge -- bottom minus top -- and can never overshoot
   * it, whatever the scale factor does to the arithmetic.
   */
  const dispPhys = toPhys(b);
  const bottomPhys = dispPhys.y + dispPhys.h;   // toPhys speaks w/h, not width/height
  const restPhys = toPhys(restDip);
  if (!atTop) restPhys.h = bottomPhys - restPhys.y;

  // The PILL itself: the 48 DIP the page actually paints, which is the top of the
  // window at the bottom edge and the bottom of it at the top edge. This is what
  // gets captured -- capturing the whole window would drag 17 px of the wrong
  // scenery (the transparent strip under the island) into the pill's blur.
  const pillDip = {
    x: restDip.x,
    y: atTop && BAR_SHAPE === 'pill' ? restDip.y + PILL_LIFT_DIP : restDip.y,
    width: restDip.width,
    height: h,
  };

  // THE WINDOW while it is on screen: the resting rect, or in tall mode (barTall) the resting
  // rect plus POPOVER_MAX reaching away from the edge, so a popover never has to resize it.
  // Same bottom rule as `rest`: computed from the screen edge, never a rounded height.
  const winDip = barTall()
    ? { x: restDip.x, y: atTop ? restDip.y : restDip.y - POPOVER_MAX, width: restDip.width, height: restDip.height + POPOVER_MAX }
    : restDip;
  const winPhys = toPhys(winDip);
  if (!atTop) winPhys.h = bottomPhys - winPhys.y;

  return {
    shape: BAR_SHAPE,
    edge: atTop ? 'top' : 'bottom',
    scale: sf,
    radius: r,
    bottomPhys,
    rest: { dip: Object.assign({ r: rDip }, restDip), phys: Object.assign({ r }, restPhys) },
    start: { dip: Object.assign({ r: rDip }, startDip), phys: Object.assign({ r }, toPhys(startDip)) },
    pill: { dip: pillDip, phys: toPhys(pillDip) },
    win: { dip: Object.assign({ r: rDip }, winDip), phys: Object.assign({ r }, winPhys) },
  };
}

/**
 * One side of a morph, in the units the RUNNING sidecar reads rectangles in.
 * A DPI-aware sidecar gets physical pixels; a DPI-unaware one is handed
 * virtualised numbers by Windows, which are already DIP on the primary display,
 * and converting those would repeat the 200px-tall-bar bug of the first live run.
 */
function sideRect(side) {
  if (sidecarDpiAware === false) {
    return { x: side.dip.x, y: side.dip.y, w: side.dip.width, h: side.dip.height, r: side.dip.r || 0 };
  }
  return side.phys;
}

/** Where the bar window actually is right now, as a morph side. */
function currentSide(geo) {
  const b = barRect();
  if (!b) return geo.rest;
  const dip = { x: b.x, y: b.y, width: b.width, height: b.height, r: geo.rest.dip.r };
  return { dip, phys: Object.assign({ r: geo.radius }, toPhys(dip)) };
}

/**
 * The rectangle the bar should occupy with `extra` DIP of popover room, in DIP.
 * It grows AWAY from its screen edge, so the bar's own edge never appears to
 * move -- and in pill mode it keeps the pill's x, width and 14 DIP of lift.
 */
function popoverDipRect(extra) {
  const rest = barGeometry().rest.dip;
  return {
    x: rest.x,
    y: flags.barEdge === 'top' ? rest.y : rest.y - extra,
    width: rest.width,
    // rest.height, not BAR_H: in pill mode the window already includes the 14 DIP
    // of air under the island, and a popover must grow on top of that rather than
    // eat it.
    height: rest.height + extra,
  };
}

/*
 * THE BAR WINDOW NEVER CHANGES SIZE WHILE IT IS ON SCREEN (2026-09-24).
 *
 * Owen: "when i press any of these buttons the taskbar glitches down and then back up rq" (the
 * speaker, Wi-Fi, battery, clock, bell and "..." buttons). Every popover used to make its room
 * by MORPHING THE WINDOW: ~20 SetWindowPos resizes in 200 ms, up on open, down on close. The
 * bar is a transparent DirectComposition window, and after a resize DWM goes on showing the
 * page's PREVIOUS frame, pinned to the window's new top-left, until Chromium presents one at the
 * new size. The page is bottom-anchored, so on the way up the pill was drawn too HIGH and on the
 * way down it fell out of the bottom of the window. Measured through Windows' own capture of
 * the window (--test-trace, 2026-09-24): opening "..." drew the pill 80 px above its place for a
 * frame; closing it, DWM showed the bar with NO pill for four captured frames in a row (~110 ms)
 * and then 5 px low before it settled -- the dip. Same road for the pinned apps' flyouts.
 *
 * So in hover mode the window is ALWAYS POPOVER_MAX taller than the bar, reaching away from the
 * screen edge (barGeometry's `win`), and a popover changes only its SHAPE: a window region that
 * is the resting rect plus the room asked for (lib/bar-shape.js). A region changes what DWM
 * shows and what takes clicks, never the page's size, so nothing is re-laid out and nothing is
 * drawn stale. Outside it clicks go through to what is behind, as they did when the window was
 * only that big. Parking is unchanged: the window still shrinks to `start` below the screen,
 * where nothing can see it happen.
 *
 * Off for --dock (its rect is the app bar's), --os-morph (the old road animates the window
 * itself) and the framed --test bar (testFitPage); on for --test-live-bar, which is how it is
 * traced. And off, with the reason in State, if the first shape does not read back from
 * Windows: a tall window without its shape would be 480 DIP of invisible glass taking the
 * clicks above the bar.
 */
let barShapeBroken = null;   // why the tall window is off, once armBarShape found it could not work
function barTall() {
  return !flags.dock && !flags.osMorph && (!flags.test || flags.testLiveBar) && !barShapeBroken;
}

/* Set the shape for `extra` DIP of popover room; `check` also reads it back from Windows. A
   failure is logged and put in State (a popover may be clipped), never thrown. */
function setBarShape(extra, why, check) {
  if (!barTall() || !barWin || barWin.isDestroyed()) return { ok: true, reason: null };
  const geo = barGeometry();
  const rect = barShape.shapeRect({ edge: geo.edge, win: geo.win.dip, rest: geo.rest.dip, extra });
  let res = barShape.apply(barWin, rect);
  if (res.ok && check) res = barShape.verify(hwndOf(barWin), rect, geo.scale);
  if (!res.ok) {
    process.stdout.write(`mantle: the bar's shape could not be set for ${extra} dip of popover room (${why}): ${res.reason}\n`);
    setBar({ reason: `the bar's shape could not be set, so a popover may be cut off: ${res.reason}` });
  }
  return res;
}

/* The first shape, on the still-hidden window, READ BACK before the tall window is ever used. */
function armBarShape() {
  if (!barTall()) return;
  const res = setBarShape(0, 'the bar window was made', true);
  const geo = barGeometry();
  if (res.ok) {
    process.stdout.write(`mantle: bar shape armed: the window is ${JSON.stringify(sideRect(geo.win))} on screen and only ${JSON.stringify(res.box)} of it (window-relative px) is the bar; a popover changes that, never the window\n`);
    return;
  }
  barShapeBroken = res.reason;
  barShape.apply(barWin, null);   // no stray region on the rectangle the bar goes back to
  process.stdout.write(`mantle: bar shape NOT armed (${res.reason}): popovers resize the window again, and the pill may jump while one opens or closes\n`);
  setBar({ reason: `popovers resize the bar window, so the pill may jump while one opens or closes: its shape could not be set (${res.reason})` });
}

/** The bar window's rectangle in DIP, or null if there is no bar. In tall mode that is the bar's
    SHAPE (rest plus any popover room), not the window: the rest of the window is not there. */
function barRect() {
  if (!barWin || barWin.isDestroyed()) return null;
  if (barTall()) return popoverDipRect(barPopover ? barPopover.height : 0);
  try {
    return barWin.getBounds();
  } catch (_) {
    return null;
  }
}

/** Where the bar's PILL rests, in DIP, and its shape (lane mantle-corner4): the corner banners rest above the
    HIDDEN pill's footprint (lib/features/_toasts-core.js hiddenPillTop), at any display scale. In the pill
    shape the pill is the top BAR_H of the resting rect (the PILL_LIFT_DIP under it stay transparent). */
function barPillRest() {
  if (!barWin || barWin.isDestroyed()) return null;
  try {
    const geo = barGeometry();
    const r = geo.rest.dip;
    return { x: r.x, y: r.y, width: r.width, height: BAR_SHAPE === 'pill' ? BAR_H : r.height, shape: BAR_SHAPE, edge: geo.edge };
  } catch (_) {
    return null;
  }
}
function pointIn(rect, pt) {
  return !!rect && pt.x >= rect.x && pt.x < rect.x + rect.width
    && pt.y >= rect.y && pt.y < rect.y + rect.height;
}

/**
 * Is the cursor somewhere that counts as "still using the bar"?
 *
 * In pill mode this is a UNION, not the window rect, because the island floats 14
 * DIP above the screen edge: the cursor arrives in the band at the very bottom,
 * and the trip up into the island crosses a strip of bare wallpaper. Treating
 * that strip as outside would hide the bar out from under the pointer coming for
 * it -- and since the grace period came down to 180 ms (build 23), the whole trip
 * up from the band now takes longer than the hide would, so this union is what
 * makes the faster hide safe rather than twitchy.
 *
 *   the bar's own window rect
 *   + the reveal band (the bottom 4 DIP, full width)
 *   + in pill mode, the column under the island, from its bottom edge down to the
 *     screen's, no wider than the island itself.
 *
 * In flush mode the bar IS the edge, so the first two are the whole of it.
 *
 * Since 10-17 this union, plus the rest band and the overshoot band around the pill, is ONE pure
 * function, lib/bar-intent.js zone(), which hoverTick calls and lib/bar-intent.test.js sweeps.
 */

/*
 * Is something fullscreen in front of us? Asked of the sidecar, because Electron
 * cannot see another process's window state.
 *
 * DEGRADES TOWARDS REVEALING, with the reason recorded: a sidecar that is down or
 * too old must not mean "Owen's taskbar never appears again". The verdict is
 * cached for 600 ms so that a cursor parked on the edge asks a few times a
 * second, not twelve.
 *
 * EXCEPT WHILE A GAME RUNS (gameQuiet below): then the edge never reveals the bar,
 * the sidecar is not asked, and a slow or failed answer can never fall back to
 * revealing.
 */
// <mainrel:gamequiet> (lib/main-rel.test.js runs this region with a fake sidecar and rest)
/*
 * GAME QUIET (lane gamequiet, 2026-09-28). Valorant ran at 30 fps with stutter while mantle.log said
 * "reveal: the cursor reached the bottom edge" -> "bar revealed" -> "bar backdrop capture on: 4 fps",
 * three times, with Mantle RESTING for it: the sidecar had stalled, the fullscreen check below timed
 * out, and it degraded towards revealing, as it was built to. While a game runs (Mantle rests with a
 * why that names a game, _gamemode-plan.js restIsGame; NOT game mode on by hand with no game):
 *   - the bottom edge never reveals the bar, whatever the sidecar says or fails to say;
 *   - nothing captures the screen (the backdrop loops, the pre-reveal frame, the desktop reshoot):
 *     the bar and the launcher use their flat tint. Said once per rest in the log.
 * Outside a game nothing changes. The bar stays PARKED below the screen: never hide()/show() here.
 */
function gameQuiet() {
  return restState && GamePlan.restIsGame(restState.why) ? restState.why : null;
}
let backdropQuietSaid = null;    // the rest the "no screen capture" line was written for
/** Null when a backdrop capture may run, else why not (and the log says so once per rest). */
function backdropQuiet(label) {
  const game = gameQuiet();
  if (!game) return null;
  if (backdropQuietSaid !== restState) {
    backdropQuietSaid = restState;
    process.stdout.write(`mantle: backdrop: no screen capture while ${game}: the bar and the launcher use their flat tint until it exits\n`);
  }
  return `no screen capture while ${game}, so ${label} uses its flat tint`;
}
function quietVerdict(game) {
  const v = { blocked: true, reason: `Mantle is resting while ${game}, so the edge does not reveal the bar (it must not paint over a game)`, at: 0 };
  if (v.reason !== foregroundReason) {
    foregroundReason = v.reason;
    process.stdout.write(`mantle: bar reveal check: ${v.reason}\n`);
  }
  return v;
}
let fgVerdict = { blocked: false, reason: null, at: 0 };
async function foregroundBlocksReveal() {
  // Before the cache and before the sidecar: a game running is known without asking anything.
  const game = gameQuiet();
  if (game) return quietVerdict(game);
  const now = Date.now();
  if (now - fgVerdict.at < 600) return fgVerdict;
  const blocked = sidecar.blockedReason();
  if (blocked) {
    fgVerdict = { blocked: false, reason: `Mantle could not check for a fullscreen window (${blocked}), so the bar reveals anyway`, at: now };
    return fgVerdict;
  }
  try {
    const fg = await sidecar.call('foreground', {}, 1500);
    if (!fg || typeof fg.fullscreen !== 'boolean') {
      fgVerdict = { blocked: false, reason: `the sidecar answered "foreground" without a fullscreen flag (${JSON.stringify(fg)}), so the bar reveals anyway: run npm run build:sidecar`, at: now };
    } else if (fg.fullscreen) {
      const who = fg.exe ? path.basename(String(fg.exe)) : (fg.title || 'an unnamed window');
      fgVerdict = { blocked: true, reason: `${who} is fullscreen in front, so the bar stays hidden (it must not paint over a game)`, at: now };
    } else if (GamePlan.detectGame(fg).how === 'known') {
      // valofix, 2026-09-26: Valorant came up as a maximised WINDOW, which the full-screen test
      // above lets through; a topmost bar raised over a game on its way to full screen is exactly
      // what must not happen. A known game in front keeps the bar down, windowed or not.
      fgVerdict = { blocked: true, reason: `${path.basename(String(fg.exe))} (a known game) is in front, so the bar stays hidden even though it is not full screen`, at: now };
    } else {
      fgVerdict = { blocked: false, reason: null, at: now };
    }
  } catch (err) {
    const why = Sidecar.isOldExeError(err)
      ? `the sidecar exe has no "foreground" command (run npm run build:sidecar), so the bar reveals anyway and may cover a fullscreen window`
      : `Mantle could not check for a fullscreen window (${err.message}), so the bar reveals anyway`;
    fgVerdict = { blocked: false, reason: why, at: now };
  }
  // The rest can begin while the sidecar is being asked (up to 1.5 s): a late answer, or none,
  // never reveals over a game that started meanwhile.
  const late = gameQuiet();
  if (late) return quietVerdict(late);
  if (fgVerdict.reason !== foregroundReason) {
    foregroundReason = fgVerdict.reason;
    if (fgVerdict.reason) process.stdout.write(`mantle: bar reveal check: ${fgVerdict.reason}\n`);
  }
  return fgVerdict;
}
// </mainrel:gamequiet>

function cancelPendingHide() {
  if (!hideTimer) return false;
  clearTimeout(hideTimer);
  hideTimer = null;
  return true;
}

/*
 * Run one animation of the bar window.
 *
 * `morph` is the sidecar's: SetWindowPos + SetWindowRgn walked on its own thread
 * at ~60 fps, so the window's real edges move and its real corner radius grows.
 * Nothing in Chromium can do that -- a CSS transform moves the PAGE inside a
 * window that is already sitting there in full glass.
 *
 * A NEW MORPH CANCELS THE OLD ONE on the same hwnd (lane D), which is what makes
 * "the cursor came back half way down" work. The sequence number is this side's
 * half of that deal: a cancelled call's rejection must not overwrite the reason
 * the morph that replaced it has just written.
 *
 * Every failure road ends with the window EXACTLY where it was going anyway, via
 * a plain `place`, and a reason saying why it got there without moving.
 */
let morphSeq = 0;
async function runMorph(from, to, ms, what) {
  const seq = ++morphSeq;
  if (!barWin || barWin.isDestroyed()) return;

  const land = async (why) => {
    if (seq !== morphSeq) return;
    const placed = await placeBar([to.x, to.y, to.x + to.w, to.y + to.h], sidecarDpiAware, { quiet: true });
    process.stdout.write(`mantle: morph (${what}) to ${JSON.stringify(to)} landed without the animation: ${why}${placed.ok ? '' : `; and ${placed.how}`}\n`);
    setBar({ reason: `the bar ${what === 'reveal' ? 'appears' : 'goes'} without the animation: ${why}${placed.ok ? '' : `; and ${placed.how}`}` });
  };

  const blocked = sidecar.blockedReason();
  if (blocked) { await land(`the sidecar cannot be asked to animate it (${blocked})`); return seq === morphSeq; }

  try {
    await sidecar.call('morph', {
      hwnd: hwndOf(barWin), from, to, ms, ease: REVEAL_EASE,
    }, ms + 4000);
  } catch (err) {
    if (seq !== morphSeq) return false;   // the opposite morph took over; its reason wins
    await land(Sidecar.isOldExeError(err)
      ? 'the sidecar exe has no "morph" command yet, so it jumps instead of sliding: run npm run build:sidecar'
      : err.message);
  }
  // true = this morph is still the current one and the window is at `to`. False
  // means a newer morph replaced it, and whatever comes next is that one's job.
  return seq === morphSeq;
}

/**
 * Put the bar on screen. Never takes focus: the window is focusable:false.
 *
 * The window is normally already parked just off the screen edge (startup parks
 * it there, and every hide leaves it there), so showInactive() shows nothing and
 * the morph is what brings it in. The page is told at the SAME moment with the
 * duration, so its fade runs on the same clock as the window's travel.
 */
/**
 * The default reveal: place once, show, let the page do the 560 ms.
 *
 * Order matters and is the whole point. The backdrop frame is captured while the
 * window is still hidden -- no content protection, no risk of photographing
 * ourselves -- and broadcast BEFORE 'bar.reveal', so the page's first frame of
 * the rise already has the real wallpaper behind it instead of a flat tint that
 * pops a quarter of a second later. If that one capture fails it is skipped in
 * silence here: the 4 fps loop starts at landing and will fix it, and a reveal
 * must never wait on a screenshot.
 */
let revealLandTimer = null;
/*
 * TEST ONLY: give the framed test bar the live bar's PAGE, width and height (2026-09-22).
 *
 * The live bar window is frameless, so its page is the whole window: 1120 x 62 dip in pill mode
 * (the pill's 48 plus the 14 of air under it). The test window keeps a frame (lib/windows.js),
 * and a rectangle placed for the live window puts that frame INSIDE it. Measured on one run:
 *   - width: a 1120 dip test window held a 1106 css px page. 14 px decides whether a pin fits
 *     (a cell and its gap are 42), so the dock was judged on a bar the live shell never has;
 *   - height: the 77 px live rectangle left a 2 px page under the title bar, so --screenshot's
 *     bar.png came out 1400x2;
 *   - popovers: the old test path grew the WINDOW by deltas through setBounds, and at 1.25x each
 *     open or close rounded the frame up by 2 dip: the page crept 1120 -> 1132 over six popovers.
 * So the test bar is sized by its CONTENT (setContentBounds), from fixed numbers rather than from
 * whatever it was before, and nothing can accumulate: centre x kept, bottom kept (top at the top
 * edge). Pill width is the live pill's; an edge-mode test bar keeps the width it was made with.
 * Never on the live bar. Returns what changed, or null when nothing needed to.
 */
function testFitPage(heightDip) {
  if (!flags.test || !barWin || barWin.isDestroyed()) return null;
  try {
    const cb = barWin.getContentBounds();
    const width = BAR_SHAPE === 'pill' ? barGeometry().rest.dip.width : cb.width;
    const height = Math.max(1, Math.round(heightDip));
    if (cb.width === width && cb.height === height) return null;
    barWin.setContentBounds({
      x: Math.round(cb.x + (cb.width - width) / 2),
      y: flags.barEdge === 'top' ? cb.y : cb.y + cb.height - height,
      width,
      height,
    });
    const [w, h] = barWin.getContentSize();
    return { from: `${cb.width}x${cb.height}`, to: `${w}x${h}`, want: `${width}x${height}` };
  } catch (err) {
    process.stdout.write(`mantle: the test bar could not be given the live page size (${err.message}); its dock is judged on a different bar than the live one\n`);
    return null;
  }
}

async function revealByPage(geo, why, visible) {
  // the WINDOW's rect: the resting one, or in tall mode the resting one plus the popover room
  const rect = sideRect(geo.win);
  // Capture the PILL, place the WINDOW: the page hangs this image on the pill, and
  // the window also covers the transparent strip under it -- 17 px of scenery that
  // does not belong in the pill's blur.
  const shotRect = clampToDisplay(geo.pill ? geo.pill.phys : rect).rect;
  if (!visible || barParked) {
    try {
      // gamequiet: no pre-reveal picture while a game runs; the page keeps its flat tint.
      // dark (lane helm-wall): the wallpaper under the pill, cut from the still; v1's screen shot only
      // where there is no still (a web wallpaper) -- and in light, as before
      // lane mantle-seethru-bar-desktop: cut BAR_WALL_GROW_DIP past the pill and placed by `at` against the
      // window's resting rectangle (it lands there next); the landing's own frame re-places it on the real one
      const grown = geo.pill && geo.win && geo.win.phys ? growRect(geo.pill.phys, BAR_WALL_GROW_DIP) : null;
      const wall = backdropQuiet('the bar') || getTheme().get().theme !== 'dark' ? null
        : grown ? await wallStill.rect(grown, { pad: true }) : await wallStill.rect(shotRect);
      const skip = !!wall && (wall.ok || !wall.capture);   // the wallpaper answered, or there is nothing to capture instead
      const shot = skip ? null : backdropQuiet('the bar') ? null
        : await sidecar.call('backdrop', { x: shotRect.x, y: shotRect.y, w: shotRect.w, h: shotRect.h, scale: BACKDROP_SCALE }, 2000);
      if (wall && wall.ok) {
        const place = (grown && WallStill.placeAt(wall.rect, geo.win.phys, geo.win.dip)) || {};
        broadcast('bar.backdrop', Object.assign({ png: wall.png, w: wall.w, h: wall.h, rect: { x: wall.rect.x, y: wall.rect.y, w: wall.rect.w, h: wall.rect.h }, ms: wall.ms, source: wall.source }, place));
      } else if (shot && shot.png) {
        broadcast('bar.backdrop', { png: shot.png, w: shot.w, h: shot.h, rect: { x: shotRect.x, y: shotRect.y, w: shotRect.w, h: shotRect.h }, ms: Number(shot.ms) || 0 });
      }
    } catch (_) { /* the loop retries after landing; a reveal never waits on this */ }
    if (!barRevealed || !barWin || barWin.isDestroyed()) return;   // hidden again while we waited
    // Tall mode: the shape goes on BEFORE the window lands on screen, so the empty part of it
    // never takes a click, and is read back after (a region Windows lost would say so here).
    setBarShape(barPopover ? barPopover.height : 0, why);
    await placeBar([rect.x, rect.y, rect.x + rect.w, rect.y + rect.h], sidecarDpiAware, { quiet: true });
    setBarShape(barPopover ? barPopover.height : 0, `${why}, read back after placing`, true);
    if (flags.test && !flags.testLiveBar) {
      const fit = testFitPage(geo.rest.dip.height);
      if (fit) process.stdout.write(`mantle: test bar page fitted to the live bar's: ${fit.from} -> ${fit.to} css px (live ${fit.want})\n`);
    }
    barParked = false;
  }

  try {
    barWin.showInactive();
    if (!flags.test) barWin.setAlwaysOnTop(true, 'screen-saver');
    // ...and then prove it: alwaysOnTop only puts us IN the topmost band.
    raiseBar(why);
  } catch (err) {
    setBar({ revealed: false, reason: `the bar window would not show: ${err.message}` });
    return;
  }
  barMotion(true, REVEAL_MS, why);   // lane mantle-corner: the corner banners rise with it, told FIRST (corner3: never behind the pill)
  broadcast('bar.reveal', { why, mode: geo.shape, ms: REVEAL_MS });
  setBar({ ok: true, revealed: true, reason: barReason(`the bar is up: ${why}`) });
  // `rect` is the WINDOW (in hover mode POPOVER_MAX taller than the pill; its region shows the pill), so
  // it was never the pill the line used to call it: the window, then the pill and where it keeps (10-17).
  process.stdout.write(`mantle: bar revealed (${why}) -- window ${JSON.stringify(rect)}, ${geo.shape} ${JSON.stringify(geo.rest.dip)} (DIP), ${require("./lib/bar-intent").describe(geo.rest.dip, flags.barEdge)}; the page animates it over ${REVEAL_MS} ms\n`);

  // "Landed" is now a clock, not a reply: nothing in the main process is moving.
  if (revealLandTimer) clearTimeout(revealLandTimer);
  revealLandTimer = setTimeout(() => {
    revealLandTimer = null;
    if (barRevealed) startBackdrop('the bar landed');
  }, REVEAL_MS);
  if (revealLandTimer.unref) revealLandTimer.unref();
}

/*
 * MAKE SURE THE BAR IS ACTUALLY ON TOP (build 23).
 *
 * Owen: "im pressing them and they arent doing anything". WindowFromPoint over
 * every point of the revealed bar came back with an explorer.exe window of class
 * LockScreenBackstopFrame -- full-screen, visible, WS_EX_TOPMOST -- sitting above
 * ours inside the topmost band and swallowing every click. Clicks worked right
 * after start and stopped later, because Windows raised that window at a moment
 * of its own choosing. alwaysOnTop is not a promise that we are FIRST among
 * topmost windows; it only puts us in the band.
 *
 * So every reveal re-asserts it: moveTop() (free, in-process) and then the
 * sidecar's `raise`, which does the SetWindowPos and then asks WindowFromPoint at
 * the window's centre whether WE are what a click would hit. One retry, and if
 * something is still over us the State names it -- "the buttons do nothing" with
 * no explanation is exactly the failure the no-silent-failures rule is about.
 * At most two sidecar calls per reveal.
 */
let raiseComplaint = null;      // what was last found covering us, so it is logged once
async function raiseBar(why) {
  if (!barWin || barWin.isDestroyed()) return;
  // --test --flyout drives the bar with no one at it, possibly while Owen works (or records a
  // lesson) in front: every "raise" becomes "send to the back", so the test bar never covers
  // him. Its pictures are captured with PrintWindow, which does not need it on top.
  if (flags.test && (flags.flyout !== null || flags.testLiveBar)) { thumbs.toBack(hwndOf(barWin)); return; }
  try { barWin.moveTop(); } catch (_) { /* free when it works, nothing when it does not */ }
  if (sidecar.blockedReason()) return;

  const ask = async () => (await sidecar.call('raise', { hwnd: hwndOf(barWin) }, 3000)) || {};
  try {
    let r = await ask();
    if (r.onTop === false) r = await ask();          // once more: the cap is two calls
    if (r.onTop === false) {
      const o = r.over || {};
      const what = `${o.cls || 'an unnamed window'} '${o.title || ''}' (pid ${o.pid === undefined ? '?' : o.pid})`;
      setBar({ ok: false, revealed: true, reason: `something sits over the bar and takes its clicks: ${what}` });
      if (raiseComplaint !== what) {
        raiseComplaint = what;
        // No class and no title: either can name an app or a song, and logs carry none.
        // The pid only, worded as lib/raise.js words it.
        const whose = typeof o.pid !== 'number' ? 'another window'
          : o.pid === process.pid ? 'another Mantle window' : `another app's window (pid ${o.pid})`;
        process.stdout.write(`mantle: the bar is covered by ${whose}, so its buttons will not respond (${why})\n`);
      }
      return;
    }
    raiseComplaint = null;
  } catch (err) {
    setBar({
      revealed: true,
      reason: Sidecar.isOldExeError(err)
        ? 'the bar could not be raised above other topmost windows (the sidecar exe has no "raise" command yet: run npm run build:sidecar), so its buttons may not respond'
        : `the bar could not be raised above other topmost windows, so its buttons may not respond: ${err.message}`,
    });
  }
}

function revealBar(why) {
  if (!barWin || barWin.isDestroyed()) {
    setBar({ revealed: false, reason: `there is no bar window to reveal (${why})` });
    return;
  }
  const wasHiding = cancelPendingHide();
  barLeftAt = null;
  barOutAt = null;
  const visible = barWin.isVisible();
  if (barRevealed && visible && !wasHiding) return;
  barRevealed = true;
  process.stdout.write(`mantle: reveal: ${why}\n`);

  const geo = barGeometry();

  if (!flags.osMorph) {
    // THE PAGE ANIMATES IT. The window is placed once, at its resting rectangle,
    // and never moves during the reveal -- see barGeometry() for why a moving
    // window could never be smooth. One pre-show backdrop frame goes first so the
    // pill has something real to blur on its very first painted frame; the window
    // is still HIDDEN at that point, so nothing has to be excluded from the shot.
    revealByPage(geo, why, visible);
    return;
  }

  // --os-morph: the old road. Coming back mid-hide starts from wherever the
  // window got to, not from a jump back down to the edge.
  const from = visible ? sideRect(currentSide(geo)) : sideRect(geo.start);

  try {
    barWin.showInactive();
    // A window that was hidden can lose its band; re-assert rather than assume.
    if (!flags.test) barWin.setAlwaysOnTop(true, 'screen-saver');
    // ...and then prove it: alwaysOnTop only puts us IN the topmost band.
    raiseBar(why);
  } catch (err) {
    setBar({ revealed: false, reason: `the bar window would not show: ${err.message}` });
    return;
  }
  barMotion(true, REVEAL_MS, why);   // lane mantle-corner: the corner banners rise with it, told FIRST (corner3: never behind the pill)
  broadcast('bar.reveal', { why, mode: geo.shape, ms: REVEAL_MS });
  setBar({ ok: true, revealed: true, reason: barReason(`the bar is up: ${why}`) });
  process.stdout.write(`mantle: bar revealed (${why}) -- ${geo.shape} ${JSON.stringify(sideRect(geo.rest))} over ${REVEAL_MS} ms\n`);
  // Not awaited: the bar is "up" the instant the page is told, and the 560 ms of
  // travel must not hold up the poll. The .catch is belt to runMorph's braces --
  // an unhandled rejection here would be a shell animation crashing the log.
  runMorph(from, sideRect(geo.rest), REVEAL_MS, 'reveal')
    // Only once it has LANDED: a backdrop captured mid-flight is a smear of the
    // screen the bar was passing over, and the page would blur that.
    .then((landed) => { if (landed && barRevealed) startBackdrop('the bar landed'); })
    .catch((err) => setBar({ reason: `the bar is up, but its entrance threw: ${err && err.message ? err.message : err}` }));
}

/**
 * Tell the page first, morph the window back off the edge over 320 ms, and only
 * then hide it (at 340 ms, so the window is already gone from view when it goes).
 * Hiding immediately would make the bar vanish rather than leave.
 */
/*
 * Unregister every live preview in the bar window (lib/thumbs.js). Called from every road
 * out of the flyout -- popover resize, hide, park, page reload, window gone, quit -- because
 * a thumbnail nobody unregisters is drawn by DWM until Mantle exits. Cheap when there are
 * none, so the callers never check first. One log line when it actually removed something,
 * so a preview that vanished can be traced to the reason it was taken down.
 */
function clearThumbs(why) {
  let n = 0;
  try { n = thumbs.clear(why); } catch (err) {
    process.stderr.write(`mantle: the flyout previews could not be removed (${why}): ${err.message}\n`);
    return;
  }
  if (n) process.stdout.write(`mantle: removed ${n} flyout preview${n === 1 ? '' : 's'} (${why})\n`);
}

/*
 * Take the bar off the screen WITHOUT hiding the window: see barParked. The page
 * has already run its exit, so the window holds nothing but a transparent strip
 * when it goes below the edge. Only if the sidecar cannot place it does this fall
 * back to barWin.hide(), and it says so, because the next reveal then goes
 * through the hide()/showInactive() cycle that costs the page its clicks.
 */
function parkBar(geo, why) {
  // Nothing may be drawn into a parked window: a preview left registered here would be the
  // one thing on screen when the bar next comes up, sitting wherever its old box was.
  clearThumbs(`the bar parked: ${why}`);
  const start = sideRect(geo.start);
  const fallback = (how) => {
    barParked = false;
    try { barWin.hide(); } catch (err) {
      setBar({ revealed: true, reason: `the bar window would not hide: ${err.message}` });
      return;
    }
    process.stdout.write(`mantle: bar hidden instead of parked (${how}): the buttons may stop responding after this reveal\n`);
  };
  placeBar([start.x, start.y, start.x + start.w, start.y + start.h], sidecarDpiAware, { quiet: true })
    .then((placed) => {
      if (placed && placed.ok) {
        barParked = true;
        process.stdout.write(`mantle: bar parked below the screen at ${JSON.stringify(start)} (${why})\n`);
      } else {
        fallback(placed && placed.how ? placed.how : 'the sidecar did not place it');
      }
    })
    .catch((err) => fallback(err && err.message ? err.message : String(err)));
}

function beginHide(why) {
  if (!barRevealed || hideTimer) return;
  process.stdout.write(`mantle: hide: ${why}\n`);
  const geo = barGeometry();
  // The previews go FIRST: DWM draws them, not the page, so the page's 320 ms exit would slide
  // everything else away and leave the pictures hanging in mid-air.
  clearThumbs(`the bar is leaving: ${why}`);
  stopBackdrop(`the bar is leaving: ${why}`);
  // The panel goes with the bar: a 2 s poll for a panel nobody can see is pure cost.
  qsWatchStop(`the bar is hiding: ${why}`);
  broadcast('bar.hide', { why, ms: HIDE_MS });
  barMotion(false, HIDE_MS, why);    // lane mantle-corner: ...and go back to the corner with it
  setBar({ ok: true, revealed: true, reason: barReason(`the bar is leaving: ${why}`) });
  // A reveal that lands DURING an exit must not start capturing over the top of
  // it; revealBar() sets a fresh one if the cursor comes back.
  if (revealLandTimer) { clearTimeout(revealLandTimer); revealLandTimer = null; }
  if (flags.osMorph) {
    runMorph(sideRect(currentSide(geo)), sideRect(geo.start), HIDE_MS, 'hide')
      .catch((err) => setBar({ reason: `the bar is going, but its exit threw: ${err && err.message ? err.message : err}` }));
  }
  // On the default path nothing moves: the page runs its own 320 ms exit and the
  // window simply goes at 350 ms, 30 ms after the page has finished.
  hideTimer = setTimeout(() => {
    hideTimer = null;
    barRevealed = false;
    barLeftAt = null;
    barOutAt = null;
    if (barWin && !barWin.isDestroyed()) parkBar(geo, why);
    setBar({ ok: true, revealed: false, reason: barReason(`hidden: ${why}`) });
    process.stdout.write(`mantle: bar hidden (${why})\n`);
  }, HIDE_SLIDE_MS);
  if (hideTimer.unref) hideTimer.unref();
}

/*
 * POP-UPS CLOSE LIKE macOS MENUS (lane mn-pop, 2026-10-12, audit #1): on a click anywhere outside
 * them and on Esc, whichever app has the keyboard; the bar's and the app-volumes panel also on a switch
 * to another app (Alt+Tab, Win+Tab, Win+D: lane mantle-m6). lib/popwatch.js holds the list of open pop-ups
 * (the bar's, the timer's done card, the app-volumes panel) and the sidecar's mouse/Esc watch,
 * which exists only while one is open. The bar's pop-up joins it with barPopover (bar.popover).
 * The cursor's intent band (audit #6) is lib/bar-intent.js, used by hoverTick below.
 */
const BarIntent = require('./lib/bar-intent');
const popwatch = require('./lib/popwatch');

/** A pop-up key as the log may say it: its KIND, never the app or file it belongs to (the flyout's
    and the jump list's keys carry an app's pin name, e.g. "app:<name>.lnk"). */
function popKind(key) {
  const k = String(key || 'unnamed');
  const head = k.split(':')[0];
  if (head === 'app') return 'window previews';
  if (head === 'jl') return 'right-click menu';
  return k.indexOf(':') === -1 && /^[a-z][a-z0-9-]{0,15}$/i.test(k) ? k : (/^[a-z][a-z0-9-]{0,15}$/i.test(head) ? head : 'unnamed');
}

let barPopCloseT = null;
/** Ask the bar page to close its pop-up. A page that does not within 1 s (hung, or gone) has the
    room taken back by main, so a dead page can never hold the bar up or keep Esc from the apps. */
function closeBarPop(how) {
  if (!barPopover) return;
  const was = barPopover;
  process.stdout.write(`mantle: bar pop-up (${popKind(was.key)}) closed: ${how}\n`);
  broadcast('bar.popclose', { why: how });
  if (barPopCloseT) clearTimeout(barPopCloseT);
  barPopCloseT = setTimeout(() => {
    barPopCloseT = null;
    if (barPopover !== was) return;
    process.stdout.write(`mantle: the bar page did not close its pop-up (${popKind(was.key)}) within 1 s, so main took its room back\n`);
    COMMANDS['bar.popover']({ open: false }).catch(() => {});
  }, 1000);
  if (barPopCloseT.unref) barPopCloseT.unref();
}

/** The bar's pop-up in the watch, in step with barPopover. */
function popWatchBar() {
  if (barPopover && barWin && !barWin.isDestroyed()) {
    if (!popwatch.isOpen('bar')) {
      popwatch.open('bar', {
        contains: (pt) => pointIn(barRect(), pt),
        outside: (how) => closeBarPop(how),
        esc: (how) => closeBarPop(how),
        away: (how) => closeBarPop(how),   // Alt+Tab / Win+Tab / Win+D to another app (lane mantle-m6)
      });
    }
  } else popwatch.close('bar');
}

sidecar.on('popwatch', (ev) => { popwatch.onEvent(ev); });
app.on('browser-window-focus', () => popwatch.refresh());
popwatch.configure({
  // 4 s: the sidecar itself waits up to 3 s for its watch thread to start (Hotkey.cs StartThread), so
  // a shorter budget gave up on watches that then started anyway. The buttons are polled meanwhile
  // (lib/popwatch.js), so a slow answer never leaves a pop-up unwatched.
  call: (args) => sidecar.call('hotkey', Object.assign({ op: 'popwatch' }, args), 4000),
  log: (line) => process.stdout.write(`mantle: ${line}\n`),
  toDip: (pt) => screen.screenToDipPoint(pt),        // the hook's point is per-monitor physical
  cursor: () => screen.getCursorScreenPoint(),
  keys: () => raiseWin.keyStates(popwatch.VK),          // the fallback's buttons and Esc
  foreground: () => raiseWin.foreground(),              // a switch to another app closes a pop-up (Alt+Tab is no click)
  // The window whose own page handles Esc while it holds the keyboard: the sidecar leaves Esc to it.
  // The bar's (its Wi-Fi box), or any other Mantle window Owen is typing in (the launcher, notes,
  // Settings) -- but not the desktop: a click on it already closed the pop-up, and an Esc there
  // is meant for the pop-up.
  hwnd: () => {
    const f = BrowserWindow.getFocusedWindow();
    if (f && !f.isDestroyed() && f !== desktopWin) return hwndOf(f);
    return barWin && !barWin.isDestroyed() ? hwndOf(barWin) : null;
  },
  test: !!flags.test,
  testArm: !!flags.test && ARGV.some((a) => a === '--test-popwatch'),
  testAway: !!flags.test && ARGV.some((a) => a === '--test-popwatch-away'),
});

/**
 * One tick. Sequential by construction -- the next tick is scheduled only once
 * this one (including its await) has finished -- so the sidecar can never be
 * handed a queue of 'foreground' calls by a cursor sitting on the edge.
 */
async function hoverTick() {
  hoverTimer = null;
  if (shuttingDown || flags.dock) return;
  if (!barWin || barWin.isDestroyed()) return;   // nothing left to reveal; stop polling
  // Resting for a GAME the edge never reveals the bar (gameQuiet), so this 80 ms poll only woke the CPU
  // under the game (lane mantle-boost). It stops; hoverAfterRest starts it again once the game is over.
  if (!barRevealed && !barPopover && gameQuiet()) {
    hoverHeld = gameQuiet();
    process.stdout.write(`mantle: hover poll: stopped while ${hoverHeld} (the edge does not reveal the bar over a game)\n`);
    return;
  }

  let pt = null;
  try {
    pt = testCursor ? { x: testCursor.x, y: testCursor.y } : screen.getCursorScreenPoint();
  } catch (err) {
    setBar({ reason: `the cursor position could not be read, so the bar cannot reveal on hover: ${err.message}` });
    scheduleHoverTick();
    return;
  }

  const b = screen.getPrimaryDisplay().bounds;
  const atTop = flags.barEdge === 'top';
  // The trigger is the SCREEN edge, not the bar: in pill mode the bar floats 14
  // DIP above it, and a band that only covered the pill would be unreachable
  // until the pill was already there.
  const bandTop = atTop ? b.y : b.y + b.height - REVEAL_BAND_DIP;
  const bandBottom = atTop ? b.y + REVEAL_BAND_DIP : b.y + b.height;
  // A hot corner set to an action (lib/features/_corners.js) keeps its 6 DIP square: pushing into it
  // runs the corner and does NOT also reveal the bar; the rest of the edge reveals as before.
  const inBand = pt.x >= b.x && pt.x < b.x + b.width && pt.y >= bandTop && pt.y < bandBottom && !HotCorners.claims(pt, b);

  if (hoverFirstTick) {
    hoverFirstTick = false;
    const geo = barGeometry();
    process.stdout.write(`mantle: hover poll armed: cursor at ${pt.x},${pt.y}; the reveal band is y ${bandTop}..${bandBottom - 1} across x ${b.x}..${b.x + b.width - 1} (DIP), polled every ${POLL_HIDDEN_MS} ms while hidden\n`);
    process.stdout.write(`mantle: bar geometry: ${geo.shape} at ${geo.scale}x -- rests at physical ${JSON.stringify(sideRect(geo.rest))}, comes in from ${JSON.stringify(sideRect(geo.start))} over ${REVEAL_MS} ms\n`);
  } else if (HOVER_DEBUG && Date.now() - hoverDebugAt > 1000) {
    hoverDebugAt = Date.now();
    process.stdout.write(`mantle: [hover] cursor ${pt.x},${pt.y} inBand=${inBand} revealed=${barRevealed} popover=${barPopover ? popKind(barPopover.key) : 'none'}\n`);
  }

  if (!barRevealed) {
    if (barPopover) {
      revealBar('a bar popover is open');
    } else if (inBand) {
      const fg = await foregroundBlocksReveal();
      if (fg.blocked) setBar({ revealed: false, reason: fg.reason });
      else revealBar(fg.reason ? `the cursor reached the bottom edge (${fg.reason})` : 'the cursor reached the bottom edge');
    }
    scheduleHoverTick();
    return;
  }

  // Shown. Anything that counts as "Owen is still using it" resets the clock. The zone that KEEPS
  // the bar is wider than the band that reveals it (lib/bar-intent.js, audit #6): a cursor within
  // KEEP_ABOVE_DIP above the pill is still using it, so the bar no longer slides away under it.
  // Two bands since 10-17 (lane mantle-barhover, Owen: "i can hold my mouse a lot of pixels above it
  // without it going away"): the pill plus KEEP_ABOVE_DIP keeps it for as long as the cursor is there;
  // out to OVERSHOOT_ABOVE_DIP keeps it only for OVERSHOOT_MS, a pass on the way to an icon. Only 'in'
  // pulls a sliding-away bar back, so resting in the overshoot band can never bounce it.
  const where = BarIntent.zone(pt, { rest: barGeometry().rest.dip, win: barRect(), screen: b, edge: flags.barEdge, pill: BAR_SHAPE === 'pill', inBand });
  const rendererSaysInside = Date.now() - rendererHoverAt < HIDE_GRACE_MS;
  if (where === 'in' || barPopover || rendererSaysInside) {
    barLeftAt = null;
    barOutAt = null;
    // If the bar was already sliding away, the page has to be told to come back
    // -- cancelling the hide timer alone would leave the window up with a page
    // that has animated itself off the bottom of it.
    if (hideTimer) revealBar('the cursor came back before the bar finished sliding away');
    scheduleHoverTick();
    return;
  }
  const step = BarIntent.shownStep({ leftAt: barLeftAt, outAt: barOutAt }, Date.now(), where, HIDE_GRACE_MS);
  barLeftAt = step.leftAt;
  barOutAt = step.outAt;
  if (step.hide) {
    beginHide(step.outAt !== null
      ? `the cursor has been away from the bar (and the ${BarIntent.KEEP_ABOVE_DIP} DIP above it) for ${HIDE_GRACE_MS} ms`
      : `the cursor has rested ${BarIntent.KEEP_ABOVE_DIP + 1}..${BarIntent.OVERSHOOT_ABOVE_DIP} DIP off the bar for ${BarIntent.OVERSHOOT_MS} ms`);
  }
  scheduleHoverTick();
}

function scheduleHoverTick() {
  if (shuttingDown || hoverTimer) return;
  hoverTimer = setTimeout(() => {
    hoverTick().catch((err) => {
      setBar({ reason: `the hover poll threw and was restarted: ${err && err.message ? err.message : err}` });
      scheduleHoverTick();
    });
  }, barRevealed ? POLL_SHOWN_MS : POLL_HIDDEN_MS);
  // unref: a poll must never be the reason the process will not exit.
  if (hoverTimer.unref) hoverTimer.unref();
}

/*
 * THE BACKDROP LOOP: the bar blurs its own background.
 *
 * DWM could not give Owen "a little bit more translucent" -- acrylic ignores its
 * tint's alpha and blur-behind lays down a black slab (both measured live). So
 * the bar has no DWM glass at all, and instead gets a PICTURE of what is behind
 * it, four times a second, which the page blurs in CSS where translucency is a
 * number you can actually set.
 *
 * WHY setContentProtection AROUND THE CAPTURE: the sidecar screenshots the screen
 * region the bar occupies, and the bar is ON that region -- it would photograph
 * itself, blur that, and feed itself back into itself. Electron's content
 * protection sets WDA_EXCLUDEFROMCAPTURE, which makes the window invisible to
 * screen capture (not to the eye), so the shot is what is BEHIND it. It goes
 * straight back OFF in a finally, because a bar that is permanently excluded from
 * capture is a bar missing from every screenshot Owen takes.
 *
 * The rectangle is always the bar's RESTING rect, never the window's current one:
 * a popover makes the window taller, and the popover paints its own strong fill.
 */
const BACKDROP_MS = 250;              // 4 fps: it is a wallpaper, not a video
const BACKDROP_SCALE = 4;             // downscale; the page blurs it anyway
// dark: the bar's wallpaper cut reaches this far past the pill on every side (3.2 sigma of the 5px blur,
// so the rim takes < 0.1% of the picture's transparent edge); the page places it by `at`
const BAR_WALL_GROW_DIP = 16;
const BACKDROP_SETTLE_MS = 25;        // for the exclusion to take effect before the shot
const BACKDROP_MAX_FAILS = 3;
const WALL_WAIT_MS = 400;             // dark: a shown bar/launcher whose wallpaper is still loading looks again this often
const WALL_WAIT_TRIES = 10;           // ...at most this many times per show (4 s), then the State change / refresh()
// The desktop layer is the whole screen and sits under the wallpaper, so its
// picture can be tiny: 8x down is 240x135 here, which a heavy CSS blur cannot
// tell from the original.
const DESKTOP_BACKDROP_SCALE = 8;

function wait(ms) {
  return new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref(); });
}

/**
 * One piece of State.backdrop per window, merged rather than replaced: the three
 * windows fail independently and each has to keep its own reason.
 */
function setBackdropPiece(key, patch) {
  const cur = state.get().backdrop || {};
  state.set('backdrop', Object.assign({}, cur, { [key]: Object.assign({}, cur[key], patch) }));
}

/**
 * Take one picture of what is behind a window.
 *
 * `protect` is the difference between a capture of a window that is ON SCREEN and
 * one that is still hidden. On screen, the window would photograph itself and
 * feed its own blur back into itself, so Electron's content protection
 * (WDA_EXCLUDEFROMCAPTURE) hides it from the capture -- and goes straight back
 * off in a finally, because a window permanently excluded from capture is a
 * window missing from every screenshot Owen takes. Hidden, none of that is
 * needed, which is why every first frame is taken before the window is shown.
 */
async function captureBackdrop(win, rect, scale, protect, onProtectError) {
  // How many protected captures of this window are in flight, kept ON the window (lane see-glass,
  // 2026-10-09). The bar's 4 fps loop and a dark pop-up's one shot (barPopBackdrop) both protect the
  // bar window; without the count, whichever finished first switched protection off under the other
  // one's capture, and that one photographed the bar itself.
  const COUNT = Symbol.for('mantle.protectedCaptures');
  let protectedOn = false;
  const t0 = Date.now();
  try {
    if (protect && win && !win.isDestroyed()) {
      win[COUNT] = (win[COUNT] || 0) + 1;
      win.setContentProtection(true);
      protectedOn = true;
      await wait(BACKDROP_SETTLE_MS);
    }
    const res = await sidecar.call('backdrop', { x: rect.x, y: rect.y, w: rect.w, h: rect.h, scale }, 4000);
    if (!res || !res.png) throw new Error('the sidecar answered "backdrop" without a png');
    return { ok: true, png: res.png, w: res.w, h: res.h, ms: Number(res.ms) || (Date.now() - t0) };
  } catch (err) {
    return { ok: false, err };
  } finally {
    if (protectedOn) {
      const left = Math.max(0, (win[COUNT] || 1) - 1);
      win[COUNT] = left;
      if (!left && !win.isDestroyed()) {
        try { win.setContentProtection(false); } catch (e2) { onProtectError(e2); }
      }
    }
  }
}

/*
 * THE PICTURE BEHIND A DARK GLASS SURFACE (lane helm-wall, 2026-10-09). Owen: "you need to get the see
 * through to look just like helm". Helm's panels show only its blurred PHOTO, never the windows behind
 * it, so in dark every surface's picture is the WALLPAPER under its rectangle (lib/wall-still.js), not a
 * screen capture: same {ok, png, w, h, ms} as captureBackdrop, plus `rect` (the physical rectangle the
 * png covers exactly) and `source`. A web wallpaper or an unreadable video has no still: then v1's
 * capture, with `note` saying so. No wallpaper picture at all: {ok:false, err} and the page keeps its
 * fallback face with the reason, as before. Light: captureBackdrop, untouched.
 */
async function backdropPicture(win, rect, scale, protect, onProtectError, wallAsk) {
  if (getTheme().get().theme !== 'dark') return captureBackdrop(win, rect, scale, protect, onProtectError);
  // wallAsk (the bar, lane mantle-seethru-bar-desktop): the wallpaper is cut to THIS rectangle instead,
  // unclipped (edge pixels repeat past the display), so it covers the page's whole overscanned picture
  const w = wallAsk ? await wallStill.rect(wallAsk, { pad: true }) : await wallStill.rect(rect);
  if (w.ok) return { ok: true, png: w.png, w: w.w, h: w.h, ms: w.ms, rect: w.rect, source: w.source };
  if (!w.capture) return { ok: false, err: new Error(w.reason), wall: true, transient: !!w.transient };
  const r = await captureBackdrop(win, rect, scale, protect, onProtectError);
  return Object.assign(r, { source: 'screen', note: `a capture of the screen behind, not the wallpaper: ${w.reason}` });
}
/** A picture that came from the wallpaper (lib/wall-still.js sources), not from a screen capture. */
function isWallSource(s) { return s === 'mantle' || s === 'windows' || s === 'look'; }
function wallWords(s) { return s === 'windows' ? 'Windows wallpaper' : s === 'look' ? 'desktop wallpaper (its shared still)' : 'desktop wallpaper'; }
/** A PHYSICAL rectangle grown by `dip` DIP on every side (the primary display's scale; lib/wall-still.js). */
function growRect(r, dip) { return WallStill.growRect(r, dip, screen.getPrimaryDisplay().scaleFactor || 1); }
/*
 * Where a picture of the PHYSICAL rectangle `got` sits in `win` (lib/wall-still.js placeAt): `at` as fractions
 * of the window's content rectangle, `win` its content size in DIP. The window's REAL position is used
 * (getContentBounds), not the one the geometry asked for. {} if the window cannot say.
 */
function placeInWindow(win, got) {
  try { const cb = win.getContentBounds(); return WallStill.placeAt(got, toPhys(cb), cb) || {}; } catch (_) { return {}; }
}

/**
 * A backdrop source for one window: a first frame before it is shown, then an
 * optional loop while it is.
 *
 * Owen: "everything that we build for this wrapper, their UI needs to be this
 * exact same theme as the taskbar". The theme IS this mechanism -- the light
 * frost is a live picture of the screen behind the window, blurred in CSS -- so
 * the launcher and the desktop layer get it from the same code the bar does
 * rather than three lookalike implementations that drift.
 *
 *   opts.key     which piece of State.backdrop this writes
 *   opts.win()   the window, looked up late (it may not exist yet)
 *   opts.rect()  its rectangle in PHYSICAL px
 *   opts.event   the event the page listens for
 *   opts.ms      the loop's period, or 0 for one-shot only
 *   opts.scale   downscale factor (the page blurs it, so small is free)
 *   opts.label   what to call this window in a sentence
 *   opts.grow    DIP, dark wallpaper only (the bar): the cut is opts.rect() grown this much on every
 *                side, and the shot says where it sits in the window (`at`, `win`; placeInWindow), so
 *                the page lays the picture exactly over the screen it came from (lane
 *                mantle-seethru-bar-desktop: the bar's cut was the pill, stretched over a box 14 DIP
 *                bigger on every side, so it was magnified 1.58x tall and the wallpaper slid under it)
 *   opts.present OPTIONAL (shot, send): replaces the broadcast of a good frame (the desktop layer)
 */
function makeBackdrop(opts) {
  let timer = null;
  let fails = 0;
  let frames = 0;
  let off = null;                     // set once when the sidecar cannot do it at all
  const fps = opts.ms ? Math.round(1000 / opts.ms) : 0;
  const set = (patch) => setBackdropPiece(opts.key, Object.assign({ fps }, patch));
  const onProtectError = (e) => set({ ok: false, reason: `${opts.label} could not be put back into screen captures, so it will be missing from screenshots: ${e.message}` });

  let quiet = null;                   // set while a game runs: no capture at all (gameQuiet)
  // opts.wall (lane helm-wall): in dark the picture is the WALLPAPER under the window (backdropPicture),
  // which does not move, so a frame that came from it ends the loop: one cut per show or per change of
  // wallpaper (refresh), nothing on a timer. A web wallpaper's screen-capture fallback keeps the loop.
  let source = null;                  // where the last good frame came from: 'mantle' | 'windows' | 'screen'
  let active = false;                 // between start() and stop(): refresh() re-cuts only then
  let wallMiss = false;               // the last frame found no wallpaper picture (dark): 'wait' | 'none'
  let waits = 0;                      // looks again while the wallpaper loads (WALL_WAIT_TRIES at most per show)
  /** One frame. Returns true if it worked. Never throws. */
  async function frame(protect) {
    wallMiss = false;
    // gamequiet: checked before the content protection and the sidecar, on every frame, so a
    // loop that was running when the game started ends at its next tick.
    quiet = backdropQuiet(opts.label);
    if (quiet) { set({ on: false, ok: true, ms: 0, reason: quiet }); return false; }
    const win = opts.win();
    if (!win || win.isDestroyed()) return false;
    const asked = opts.rect();
    if (!asked || !(asked.w > 0) || !(asked.h > 0)) {
      set({ ok: false, reason: `${opts.label} has no rectangle to capture behind it` });
      return false;
    }
    // Clamped BEFORE the call, never after a refusal: a pixel of rounding past
    // the screen edge used to cost the whole loop.
    const fit = clampToDisplay(asked);
    const rect = fit.rect;
    const trimmed = fit.changed ? ` (${fit.note})` : '';
    const wallAsk = opts.wall && opts.grow > 0 && getTheme().get().theme === 'dark' ? growRect(asked, opts.grow) : null;
    const r = opts.wall ? await backdropPicture(win, rect, opts.scale, protect, onProtectError, wallAsk)
      : await captureBackdrop(win, rect, opts.scale, protect, onProtectError);
    if (r.ok) {
      fails = 0;
      frames++;
      source = r.source || 'screen';
      const got = r.rect || rect;
      const shot = { png: r.png, w: r.w, h: r.h, rect: { x: got.x, y: got.y, w: got.w, h: got.h }, ms: r.ms, source };
      // the grown wallpaper cut says where it sits; anything else (light, a screen capture) keeps v1's shape
      if (wallAsk && isWallSource(source)) Object.assign(shot, placeInWindow(win, got));
      if (opts.present) opts.present(shot, (s) => broadcast(opts.event, s));
      else broadcast(opts.event, shot);
      if (opts.onFrame) { try { opts.onFrame(shot); } catch (_) { /* a keeper of the last frame never stops the loop */ } }
      if (isWallSource(source)) {
        set({ on: false, ok: true, ms: r.ms, source, reason: `${opts.label} shows the ${wallWords(source)} under it, blurred (Helm's method): no capture, no loop${trimmed}` });
      } else {
        set(trimmed || r.note
          ? { ok: true, ms: r.ms, source, reason: `${opts.label} is blurring a live picture of what is behind it${trimmed}${r.note ? ` (${r.note})` : ''}` }
          : { ok: true, ms: r.ms, source });
      }
      return true;
    }
    if (r.wall) {
      // dark, and no wallpaper picture at all: the page keeps its fallback face and says why; no
      // retry loop (refresh() cuts again when the wallpaper picture changes)
      wallMiss = r.transient ? 'wait' : 'none';   // 'wait': the wallpaper is still loading
      broadcast(opts.event, { png: null, reason: r.err.message });
      set({ on: false, ok: false, ms: 0, reason: `${opts.label} has no wallpaper picture under it, so it shows its flat tint: ${r.err.message}` });
      return false;
    }
    if (Sidecar.isOldExeError(r.err)) {
      off = `the sidecar exe has no "backdrop" command yet, so ${opts.label} falls back to its flat tint: run npm run build:sidecar`;
      set({ on: false, ok: false, ms: 0, reason: off });
      return false;
    }
    fails++;
    set({ ok: fails < BACKDROP_MAX_FAILS, reason: `${opts.label}: a backdrop capture failed (${fails} of ${BACKDROP_MAX_FAILS}): ${r.err.message}` });
    return false;
  }

  async function tick() {
    timer = null;
    if (shuttingDown) return;
    const ok = await frame(true);
    if (!ok) {
      if (quiet) { stop(quiet); return; }
      if (off) { stop(off); return; }
      if (fails >= BACKDROP_MAX_FAILS) {
        stop(`${BACKDROP_MAX_FAILS} captures in a row failed, so ${opts.label} falls back to its flat tint`);
        return;
      }
    } else if (frames === 1) {
      process.stdout.write(isWallSource(source)
        ? `mantle: ${opts.key} backdrop: the ${source} wallpaper, cut in ${state.get().backdrop[opts.key].ms} ms (no loop)\n`
        : `mantle: ${opts.key} backdrop capture on: ${fps} fps, first frame ${state.get().backdrop[opts.key].ms} ms\n`);
    }
    // the wallpaper does not move: no loop (a failure without a picture waits for refresh() too)
    if (opts.wall && isWallSource(source) && ok) return;
    if (!ok && wallMiss) {
      // the wallpaper is still loading ('wait'): look again a few times while the window is SHOWN (the
      // State change when it draws also refreshes; this covers a draw that changes no State). Never while
      // hidden: stop() clears the timer.
      if (wallMiss === 'wait' && active && !shuttingDown && waits < WALL_WAIT_TRIES) {
        waits++;
        timer = setTimeout(() => { tick().catch(() => {}); }, WALL_WAIT_MS);
        if (timer.unref) timer.unref();
      }
      return;
    }
    if (ok) waits = 0;
    if (!shuttingDown && timer === null && opts.ms) {
      timer = setTimeout(() => { tick().catch(() => {}); }, opts.ms);
      if (timer.unref) timer.unref();
    }
  }

  return {
    /** One frame with the window still HIDDEN: no protection, nothing to exclude. */
    async once(why) {
      if (off) { set({ on: false, ok: false, reason: off }); return false; }
      const ok = await frame(false);
      // A failure has already written its own reason (which names this window);
      // leave it alone rather than paper over it with a cheerful one.
      if (ok) {
        set({ on: !!timer, ok: true, reason: isWallSource(source)
          ? `${opts.label} shows the ${wallWords(source)} under it, blurred (Helm's method) (${why})`
          : `${opts.label} has a fresh picture of what is behind it (${why})` });
      }
      return ok;
    },
    start(why) {
      active = true;
      waits = 0;
      if (timer || shuttingDown || !opts.ms) return;
      if (off) { set({ on: false, ok: false, reason: off }); return; }
      const q = backdropQuiet(opts.label);
      if (q) { set({ on: false, ok: true, ms: 0, reason: q }); return; }
      fails = 0;
      frames = 0;
      set({ on: true, ok: true, reason: `starting: ${why}` });
      tick().catch(() => {});
    },
    stop(why) { stop(why); },
    /**
     * The wallpaper or the theme changed: a SHOWN wall-backed window takes its picture again (no-op
     * when hidden or while v1's loop runs). One tick: in dark it cuts the wallpaper and stops; in light
     * it captures and the 4 fps loop runs again, as before.
     */
    refresh(why) {
      if (!opts.wall || !active || timer || shuttingDown || off) return;
      process.stdout.write(`mantle: ${opts.key} backdrop: picture again (${why})\n`);
      tick().catch(() => {});
    },
    peek: () => ({ timer: !!timer, fails, frames, off, source, active }),
  };

  function stop(why) {
    active = false;
    const wasRunning = !!timer || frames > 0;
    if (timer) clearTimeout(timer);
    timer = null;
    const win = opts.win();
    if (win && !win.isDestroyed()) {
      try { win.setContentProtection(false); } catch (_) { /* the window is going anyway */ }
    }
    const failed = fails >= BACKDROP_MAX_FAILS || !!off;
    set({ on: false, ok: !failed, ms: 0, reason: why });
    if (wasRunning) process.stdout.write(`mantle: ${opts.key} backdrop capture off after ${frames} frame${frames === 1 ? '' : 's'}: ${why}\n`);
  }
}

// The bar: the resting rectangle (never the window's current one -- a popover
// makes the window taller and the popover paints its own strong fill).
const barBackdrop = makeBackdrop({
  key: 'bar',
  label: 'the bar',
  event: 'bar.backdrop',
  ms: BACKDROP_MS,
  scale: BACKDROP_SCALE,
  win: () => barWin,
  // The PILL, not the window: the page attaches this image to the pill, and the
  // window also covers the transparent strip under it (17 px of wrong scenery).
  rect: () => barGeometry().pill.phys,
  wall: true,                         // dark: the wallpaper under the pill, one cut per landing (lane helm-wall)
  // dark: cut BAR_WALL_GROW_DIP past the pill on every side and placed by `at`: the page's picture
  // overscans its clip (so the blur pulls no transparency in at the rim) and is no longer stretched
  grow: BAR_WALL_GROW_DIP,
});

/*
 * A dark pop-up's picture of what is behind it (lane see-glass, 2026-10-09). Owen, in dark: "mantle
 * needs to be more see through everything ... even the taskbar". A pop-up had no blur under it (only
 * a near-opaque fill), so it could not be see-through and readable at once. The page asks for this
 * (bar.popover {backdrop: true}, dark theme only) and gets ONE protected shot of the bar window's
 * whole content rectangle, 4x down, as 'bar.popbackdrop'; it hangs the piece under the pop-up in a
 * blurred pseudo-element (bar.css) -- an image filter, NOT backdrop-filter, so the tall-card raster
 * tile glitch has nothing to do with it. One shot per open, no loop: a pop-up lives seconds and the
 * blur is ~48 px wide. `at` is where the shot sits in the window, as fractions of `win` (the content
 * size in DIP when it was taken), so the page needs no DPI arithmetic. A failure goes to the page,
 * which keeps the dense fill and says why.
 */
async function barPopBackdrop(key) {
  const send = (p) => broadcast('bar.popbackdrop', Object.assign({ key }, p));
  if (!barWin || barWin.isDestroyed()) return;
  const quiet = backdropQuiet('the pop-up');
  if (quiet) { send({ png: null, reason: quiet }); return; }
  let cb, phys;
  try { cb = barWin.getContentBounds(); phys = toPhys(cb); } catch (e) { send({ png: null, reason: `the bar window has no rectangle: ${e.message}` }); return; }
  const fit = clampToDisplay(phys);
  const r = await backdropPicture(barWin, fit.rect, BACKDROP_SCALE, true, (e) => {
    process.stdout.write(`mantle: the bar could not be put back into screen captures after a pop-up picture: ${e.message}\n`);
  });
  if (!r.ok) {
    process.stdout.write(`mantle: pop-up backdrop for ${popKind(key)} failed: ${r.err.message}\n`);
    send({ png: null, reason: Sidecar.isOldExeError(r.err) ? 'the sidecar exe has no "backdrop" command yet: run npm run build:sidecar' : r.err.message });
    return;
  }
  const got = r.rect || fit.rect;
  const at = { x: (got.x - phys.x) / phys.w, y: (got.y - phys.y) / phys.h, w: got.w / phys.w, h: got.h / phys.h };
  send({ png: r.png, w: r.w, h: r.h, at, win: { w: cb.width, h: cb.height }, ms: r.ms, source: r.source || 'screen' });
}

/*
 * The top bar's dropdowns: their picture of what is behind them, DARK ONLY (lane same-bars,
 * 2026-10-09; Owen: "everything at 50% ... it will all match way better if its the same"). A dropdown
 * hangs over the app in front, with nothing blurred under it, so it was a stacked near-opaque face.
 * The page asks ONCE per menu session (glass.topbarMenu, before it shows the first dropdown), and
 * main takes ONE protected shot (the top bar excluded from it) of everything a dropdown can cover:
 * the top bar window's width, from its top down to the work area's bottom, whatever size the window
 * is right now (it grows to the menu after). The answer IS the reply: {png, w, h, at} with `at` the
 * shot's rectangle in DIP relative to the window's content origin, so the page needs no DPI sums.
 * A game rest, light, or a failure answers {ok:false, reason}: the page keeps its fallback and says so.
 */
async function topbarPopBackdrop() {
  const t0 = Date.now();
  const win = BrowserWindow.getAllWindows().find((w) => {
    try { return !w.isDestroyed() && String(w.webContents.getURL() || '').replace(/\\/g, '/').split(/[?#]/)[0].toLowerCase().endsWith('/ui/topbar/index.html'); } catch (_) { return false; }
  });
  const done = (p) => {
    setBackdropPiece('topbar-menu', { ok: !!p.png, ms: Date.now() - t0, reason: p.reason || null, at: Date.now(), source: p.source || null });
    return p.png ? Object.assign({ ok: true }, p) : { ok: false, reason: p.reason };
  };
  if (!win) return done({ reason: 'the top bar window is not open' });
  if (getTheme().get().theme !== 'dark') return done({ reason: 'light: the dropdowns keep their own face, no picture is taken' });
  const quiet = backdropQuiet('the top bar\'s menus');
  if (quiet) return done({ reason: quiet });
  let cb, area, dip, phys;
  try {
    cb = win.getContentBounds();
    area = screen.getDisplayMatching(cb).workArea;
    dip = { x: cb.x, y: cb.y, width: cb.width, height: Math.max(cb.height, area.y + area.height - cb.y) };
    phys = toPhys(dip);
  } catch (e) { return done({ reason: `the top bar window has no rectangle: ${e.message}` }); }
  const fit = clampToDisplay(phys);
  if (fit.note && !fit.changed) return done({ reason: `the top bar is not on the desktop: ${fit.note}` });
  const r = await backdropPicture(win, fit.rect, BACKDROP_SCALE, true, (e) => {
    process.stdout.write(`mantle: the top bar could not be put back into screen captures after a menu picture: ${e.message}\n`);
  });
  if (!r.ok) {
    process.stdout.write(`mantle: top bar menu backdrop failed: ${r.err.message}\n`);
    return done({ reason: Sidecar.isOldExeError(r.err) ? 'the sidecar exe has no "backdrop" command yet: run npm run build:sidecar' : r.err.message });
  }
  const sx = dip.width / phys.w, sy = dip.height / phys.h;
  const got = r.rect || fit.rect;
  const at = { x: (got.x - phys.x) * sx, y: (got.y - phys.y) * sy, w: got.w * sx, h: got.h * sy };
  return done({ png: r.png, w: r.w, h: r.h, at, ms: r.ms, source: r.source || 'screen' });
}

/*
 * A floating HUD's picture of what is behind it, DARK ONLY (lane same-huds, 2026-10-09). Owen: "the
 * reason i want everything at 50% is cause it will all match way better if its the same". A HUD (the
 * volume pop-up, clipboard, notes, timer, the on-top and layouts toasts, the screenshot card, snap)
 * floats over any window with nothing blurred under it, so without a picture it can only be a .82
 * slab. The pop-ups' path (barPopBackdrop): the page asks once per show (hud.backdrop {key}, from
 * ui/shared/hud-backdrop.js, dark only), main takes ONE protected shot of that window's content
 * rectangle (protected always: a HUD shown during the shot must not photograph itself) and sends it
 * to THAT window alone as '<key>.backdrop' {png, w, h, at, win, ms}. No loop, nothing while hidden
 * or in light. A game rest or a failure goes to the page with the reason (it keeps its own face)
 * and into State.backdrop['hud-<key>'], which the checks and the dev console read.
 */
const HUD_BACKDROP_PAGES = {
  osd: 'osd/index.html', clipboard: 'clipboard/index.html', notes: 'notes/index.html', timer: 'timer/index.html',
  ontop: 'ontop/index.html', layouts: 'layouts/index.html', snap: 'snap/index.html', 'screenshot.card': 'screenshot/card.html',
  clips: 'clips/record.html',   // lane mantle-clips2: the Win+G Record panel
  emoji: 'emoji/index.html',
};
const HUD_PARK_WAIT_MS = 600;         // a parked HUD is moved in when its page has painted (snap: 150 ms at most)
async function hudBackdrop(key) {
  const page = Object.prototype.hasOwnProperty.call(HUD_BACKDROP_PAGES, key) ? HUD_BACKDROP_PAGES[key] : null;
  if (!page) return { ok: false, reason: `there is no HUD called "${String(key).slice(0, 40)}"` };
  const win = BrowserWindow.getAllWindows().find((w) => {
    try { return !w.isDestroyed() && String(w.webContents.getURL() || '').replace(/\\/g, '/').split(/[?#]/)[0].toLowerCase().endsWith(`/ui/${page}`); } catch (_) { return false; }
  });
  const done = (p) => {
    setBackdropPiece(`hud-${key}`, { ok: !!p.png, ms: p.ms || 0, reason: p.reason || null, at: Date.now(), source: p.source || null });
    if (win && !win.isDestroyed()) { try { win.webContents.send('mantle:event', { name: `${key}.backdrop`, payload: p }); } catch (_) { /* the page is reloading */ } }
    return p.png ? { ok: true, ms: p.ms, w: p.w, h: p.h } : { ok: false, reason: p.reason };
  };
  if (!win) return done({ png: null, reason: `the ${key} window is not open` });
  if (getTheme().get().theme !== 'dark') return done({ png: null, reason: 'light: the HUD keeps its own face, no picture is taken' });
  const quiet = backdropQuiet(`the ${key} pop-up`);
  if (quiet) return done({ png: null, reason: quiet });
  let cb, phys, fit;
  const measure = () => {
    try { cb = win.getContentBounds(); phys = toPhys(cb); } catch (e) { return `the ${key} window has no rectangle: ${e.message}`; }
    fit = clampToDisplay(phys);
    return fit.note && !fit.changed ? `the ${key} window is not on the desktop: ${fit.note}` : null;
  };
  let bad = measure();
  if (bad && !win.isDestroyed()) {
    // parked off screen (snap, the screenshot card park their window and move it in when painted):
    // the shot waits for that move, at most HUD_PARK_WAIT_MS, then measures again
    await new Promise((res) => {
      const moved = () => { clearTimeout(t); res(); };
      const t = setTimeout(() => { if (!win.isDestroyed()) win.removeListener('move', moved); res(); }, HUD_PARK_WAIT_MS);
      win.once('move', moved);
    });
    if (win.isDestroyed()) return done({ png: null, reason: `the ${key} window closed before its picture` });
    bad = measure();
  }
  if (bad) return done({ png: null, reason: bad });
  const r = await backdropPicture(win, fit.rect, BACKDROP_SCALE, true, (e) => {
    process.stdout.write(`mantle: the ${key} pop-up could not be put back into screen captures: ${e.message}\n`);
  });
  if (!r.ok) {
    process.stdout.write(`mantle: ${key} backdrop failed: ${r.err.message}\n`);
    return done({ png: null, reason: Sidecar.isOldExeError(r.err) ? 'the sidecar exe has no "backdrop" command yet: run npm run build:sidecar' : r.err.message });
  }
  const got = r.rect || fit.rect;
  const at = { x: (got.x - phys.x) / phys.w, y: (got.y - phys.y) / phys.h, w: got.w / phys.w, h: got.h / phys.h };
  return done({ png: r.png, w: r.w, h: r.h, at, win: { w: cb.width, h: cb.height }, ms: r.ms, source: r.source || 'screen' });
}

// The launcher: same loop, same 4 fps, its own window rectangle.
const launcherBackdrop = makeBackdrop({
  key: 'launcher',
  label: 'the launcher',
  event: 'launcher.backdrop',
  ms: BACKDROP_MS,
  scale: BACKDROP_SCALE,
  win: () => launcherWin,
  rect: () => windowPhysRect(launcherWin),
  wall: true,                         // dark: the wallpaper under the launcher, one cut per show (lane helm-wall)
});

// <mainrel:launcherwait> (lib/launcher-wait.test.js runs this region with a fake window and backdrop)
/*
 * THE LAUNCHER NEVER WAITS LONG FOR ITS PICTURE (lane mn-speed, 2026-10-12). showLauncher takes the
 * first backdrop frame while the window is still hidden, then shows it. That shot rides the sidecar's
 * capture lane with a 4 s limit, and when the lane was busy (the top bar's colour reads share it) the Win
 * key showed nothing for the whole wait: 2424 ms median with the lane held 2.5 s, against 27 ms
 * normally (C:\Users\user\mantle-notes\speed.md, launcherStall). Past LAUNCHER_PICTURE_WAIT_MS the
 * launcher opens on its flat tint, says so in State, and the picture lands when it comes. That late shot
 * was asked for UNPROTECTED (the window was hidden then), so the launcher is excluded from capture until
 * it lands, on the same per-window count the protected shots use (captureBackdrop), or the shot could
 * photograph the launcher itself.
 */
const LAUNCHER_PICTURE_WAIT_MS = 150;   // the first frame normally takes 20-64 ms (live log, 2026-10)
function launcherFirstPicture(win, show) {
  const COUNT = Symbol.for('mantle.protectedCaptures');
  let opened = false, held = false;
  const open = () => { if (opened) return; opened = true; show(); };
  const late = setTimeout(() => {
    if (opened || !win || win.isDestroyed()) return;
    try { win[COUNT] = (win[COUNT] || 0) + 1; win.setContentProtection(true); held = true; } catch (_) { /* it opens either way */ }
    setBackdropPiece('launcher', { ok: true, reason: `the launcher opened on its flat tint: its picture was not back after ${LAUNCHER_PICTURE_WAIT_MS} ms (the sidecar's capture lane is busy); it fills in when the picture lands` });
    process.stdout.write(`mantle: launcher: opened without waiting for its picture (not back after ${LAUNCHER_PICTURE_WAIT_MS} ms)\n`);
    open();
  }, LAUNCHER_PICTURE_WAIT_MS);
  const settle = () => {
    clearTimeout(late);
    if (held && !win.isDestroyed()) {
      const left = Math.max(0, (win[COUNT] || 1) - 1);
      win[COUNT] = left;
      if (!left) { try { win.setContentProtection(false); } catch (_) { /* the loop's own shots set it again */ } }
    }
    open();
  };
  launcherBackdrop.once('the launcher is opening').then(settle, settle);
}
// </mainrel:launcherwait>

/*
 * The desktop layer: ONE shot, no loop, no protection.
 *
 * It sits UNDER the wallpaper and covers the whole screen, so what is behind it
 * is the wallpaper and nothing else -- a picture that changes when the wallpaper
 * or the display does, and at no other time. Scale 8 makes it 240x135 on this
 * display, which is more than enough under a heavy blur and costs nothing.
 */
const desktopBackdrop = makeBackdrop({
  key: 'desktop',
  label: 'the desktop layer',
  event: 'desktop.backdrop',
  ms: 0,
  scale: DESKTOP_BACKDROP_SCALE,
  win: () => desktopWin,
  rect: () => windowPhysRect(desktopWin),
  // the panes' picture: in dark the wallpaper still (presentDesktop), in light this capture, as before
  present: (shot, send) => presentDesktop('the desktop layer was photographed', shot, send),
  // kept for the top bar (lib/topbar-strip.js): where the desktop page draws no wallpaper, this
  // picture of Windows' own wallpaper is what is under the bar
  onFrame: (shot) => { desktopStill = shot; if (shot && shot.png) wallStill.invalidate('Windows\' wallpaper was photographed again'); },
});
let desktopStill = null;
/*
 * THE DESKTOP PANES' PICTURE, DARK (lane mantle-seethru-bar-desktop, 2026-10-10). Owen: "this needs to
 * be see through the same as everything else". While Mantle draws the wallpaper the panes frost it live
 * (desktop.css body.has-wall); when it is paused off or unloaded they fall back to 'desktop.backdrop',
 * which was the capture above at 1/8 scale (blurry, and only re-shot on a display change, so a new
 * wallpaper left the old one behind the panes). In dark that picture is now the wallpaper still for the
 * whole display (lib/wall-still.js: the desktop's own drawing of it, else the look-sync record's still
 * cover-fit like Helm, else Windows' wallpaper), sharp and lined up, sent again whenever that still
 * changes. Light: the capture, exactly as before (a flip back to light re-sends it). `shot`/`send`: a
 * fresh capture from desktopBackdrop, sent as-is in light or when there is no still.
 */
let deskShown = null;                 // what the desktop page holds from here: 'wall' | 'capture' | null
let deskSeq = 0;
let deskFresh = null;                 // a capture not sent yet: a newer present (it supersedes) still carries it
function presentDesktop(why, shot, send) {
  const seq = ++deskSeq;
  if (shot) deskFresh = shot;
  const out = (s) => { if (send) send(s); else broadcast('desktop.backdrop', s); };
  const apply = (wall) => {
    const pick = WallStill.deskPick({ dark: !!wall, wall, fresh: deskFresh, last: desktopStill, shown: deskShown });
    if (!pick.send) return;
    deskFresh = null;
    deskShown = pick.shown;
    if (pick.shown === 'wall') {
      broadcast('desktop.backdrop', pick.send);
      setBackdropPiece('desktop', { ok: true, source: pick.source, reason: `the desktop's panes show the ${wallWords(pick.source)}, sharp and lined up, wherever Mantle is not drawing it (${why})` });
    } else {
      out(pick.send);
      if (wall) setBackdropPiece('desktop', { ok: true, source: 'screen', reason: `the desktop's panes show a 1/8-scale photo of Windows' wallpaper: ${wall.reason || 'there is no wallpaper still'}` });
    }
  };
  // light: the capture, exactly as before (no still is looked at)
  if (getTheme().get().theme !== 'dark') { apply(null); return; }
  let disp;
  try { disp = toPhys(screen.getPrimaryDisplay().bounds); } catch (_) { disp = null; }
  (disp ? wallStill.rect(disp) : Promise.resolve({ ok: false, reason: 'the display has no size' })).then(
    (w) => { if (seq === deskSeq) apply(w || { ok: false, reason: 'no answer' }); },
    () => { if (seq === deskSeq) apply({ ok: false, reason: 'the wallpaper still failed' }); });
}
// THE WALLPAPER PICTURE (lane helm-wall, 2026-10-09; lib/wall-still.js): what every dark glass surface
// shows under its tint -- the desktop's wallpaper at that surface's rectangle, as Helm shows its photo.
const WallStill = require('./lib/wall-still');
const wallStill = WallStill.makeWallStill({
  desktopWin: () => desktopWin,
  windowsStill: () => desktopStill,
  wallpaper: () => state.get().wallpaper || null,
  display: () => { const b = screen.getPrimaryDisplay().bounds; return { dip: { x: b.x, y: b.y, width: b.width, height: b.height }, phys: toPhys(b) }; },
  nativeImage: require('electron').nativeImage,
  dark: () => getTheme().get().theme === 'dark',
  log: (line) => process.stdout.write(`mantle: wallpaper glass: ${line}\n`),
  // source 2: the look-sync desktop record's still (lib/look-desktop.js), when the desktop draws none
  lookStill: () => {
    const d = lookHost && lookHost.sync ? lookHost.sync.desktop() : null;
    const rec = d && d.record;
    return rec && rec.ok && rec.still ? { file: rec.still, id: rec.id } : null;
  },
});
wallStill.onChange((why) => { barBackdrop.refresh(why); launcherBackdrop.refresh(why); if (desktopWin) presentDesktop(why); });
// a theme flip with the bar or launcher up: dark cuts the wallpaper, light restarts v1's capture loop
themeFollowers.add((t) => {
  barBackdrop.refresh(`the theme is now ${t}`); launcherBackdrop.refresh(`the theme is now ${t}`);
  if (desktopWin) presentDesktop(`the theme is now ${t}`);
});
/** What features and lib/switcher.js get (ctx.host.wall / ctx.wall). Dark only; light answers {ok:false}. */
const wallHost = {
  full: () => wallStill.full(),
  rect: (phys, opts) => wallStill.rect(phys, opts),
  onChange: (fn) => wallStill.onChange(fn),
};
// a different wallpaper (or one that just drew) is looked at again; never before the theme exists
// (getTheme() would make it, possibly ahead of a test profile's userData path)
state.on('change', () => { if (themeCore) wallStill.watch(); });
// THE TOP BAR'S GLASS (lane see-topbar, 2026-10-09): the top bar's backdrop is the desktop layer's
// own top strip, read from its page (no screen capture). ctx.host.desktopStrip; see lib/topbar-strip.js.
const topbarStrip = require('./lib/topbar-strip').makeStripReader({
  win: () => desktopWin,
  still: () => desktopStill || (state.get().backdrop || {}).desktop || null,
  nativeImage: require('electron').nativeImage,
});

/** A window's bounds in physical pixels, or null. */
function windowPhysRect(win) {
  if (!win || win.isDestroyed()) return null;
  try {
    const b = win.getBounds();
    return toPhys({ x: b.x, y: b.y, width: b.width, height: b.height });
  } catch (_) {
    return null;
  }
}

/**
 * Re-shoot the desktop layer's wallpaper picture with the window HIDDEN, then put
 * it back. It covers the whole screen, so leaving it up would photograph itself.
 *
 * ONLY WHEN THE PICTURE CHANGED (lane mn-wake, 2026-10-12; audit #9). Hidden is the only way: inside
 * Explorer's desktop the layer is a child window, which Windows will not leave out of a capture
 * (SetWindowDisplayAffinity: error 87). So each re-shoot blinks the wallpaper and the widgets, and it
 * ran on every wake and every work-area change, ~17 times a day. Now it runs when the main display's
 * physical size (or the main display) changed since the last good picture, and nothing else
 * (lib/start-wake.js desktopReshootVerdict); everything else keeps the picture and says why.
 */
const StartWake = require('./lib/start-wake');
let deskShotDisplay = null;   // {id, w, h}: the main display at the last good desktop picture
function mainDisplayPhys() {
  try {
    const d = screen.getPrimaryDisplay();
    const p = toPhys(d.bounds);
    return { id: d.id, w: p.w, h: p.h };
  } catch (_) { return null; }
}
async function reshootDesktopBackdrop(why) {
  if (!desktopWin || desktopWin.isDestroyed()) return;
  // gamequiet: a game switching its resolution fires this; nothing is hidden, shot or shown for it.
  const quiet = backdropQuiet('the desktop layer');
  if (quiet) { setBackdropPiece('desktop', { reason: `not re-shot (${why}): ${quiet}` }); return; }
  const now = mainDisplayPhys();
  const v = StartWake.desktopReshootVerdict({ last: deskShotDisplay, now });
  if (!v.reshoot) {
    process.stdout.write(`mantle: desktop layer: picture kept (${why}): ${v.reason}\n`);
    return;
  }
  process.stdout.write(`mantle: desktop layer: picture taken again (${why}): ${v.reason}\n`);
  const wasVisible = desktopWin.isVisible();
  try { if (wasVisible) desktopWin.hide(); } catch (_) { /* carry on: the shot is worth more than the hide */ }
  await wait(60);
  if (await desktopBackdrop.once(why)) deskShotDisplay = now;
  if (wasVisible) {
    try { desktopWin.showInactive(); } catch (err) {
      process.stderr.write(`mantle: the desktop layer was hidden for a backdrop capture and would not come back: ${err.message}\n`);
    }
  }
}

/*
 * THE HOVER WATCH WAITS FOR THE BAR'S FIRST PLACE (start-up polish; lane mn-wake, 2026-10-12). A live
 * start used to watch the bottom edge before the sidecar had said whether its rectangles are physical
 * pixels (sidecarDpiAware still null), so a reveal in the first seconds landed too high and then
 * jumped down. Live, the watch now starts once applyLive has placed the bar, or after
 * HOVER_START_FALLBACK_MS if that never comes (an old exe, a paused shell, a sidecar that will not
 * start), saying so. A test run and --dock start as before.
 */
const HOVER_START_FALLBACK_MS = 8000;
const hoverStart = { started: false, timer: null };
function startHoverWatchOnce(why) {
  if (hoverStart.started) return;
  hoverStart.started = true;
  if (hoverStart.timer) { clearTimeout(hoverStart.timer); hoverStart.timer = null; }
  process.stdout.write(`mantle: the bar's hover watch started: ${why}\n`);
  startHoverWatch();
}
function armHoverWatchStart() {
  setBar({ ok: true, revealed: false, reason: barReason('waiting for its first place on screen before it answers the bottom edge') });
  hoverStart.timer = setTimeout(() => startHoverWatchOnce(`the link to Windows had not placed the bar after ${HOVER_START_FALLBACK_MS / 1000} s, so it answers the edge anyway (a reveal can land a little off until it is placed)`), HOVER_START_FALLBACK_MS);
}

// Names the rest of this file already uses, kept so the bar's call sites read the
// same as they did when it was the only window with a backdrop.
function startBackdrop(why) { barBackdrop.start(why); }
function stopBackdrop(why) { barBackdrop.stop(why); }

/** Only the bar's own process polls; the launcher and desktop windows do not. */
function startHoverWatch() {
  if (flags.dock) {
    setBar({ ok: true, revealed: false, reason: '--dock: the bar is a permanent app bar and reserves its strip of screen, so nothing is hidden and nothing is polled' });
    return;
  }
  setBar({ ok: true, revealed: false, reason: barReason(`hidden until the cursor touches the ${flags.barEdge} edge of the screen`) });
  scheduleHoverTick();
}

function stopHoverWatch() {
  if (hoverTimer) clearTimeout(hoverTimer);
  hoverTimer = null;
  cancelPendingHide();
}

// ---------------------------------------------------------------------------
// The launcher's visibility, which three different things can change.
// ---------------------------------------------------------------------------
// <mainrel:launcher> (lib/launcher-gate.test.js runs this region with a fake window, backdrop, sidecar and clock)
// One state machine for every open/close request (lib/surface-gate.js, audit #14): the Win tap, the
// Start button, Alt+Space, Win+S, the tray, Esc and click-away all go through launcherGate, so the
// LAST request wins and a close during the first show's backdrop capture is never dropped.
const surfaceGate = require('./lib/surface-gate');
let launcherKbWatch = null;                               // the click-outside / Esc watch while it has no keyboard
let launcherKb = { ok: null, how: null, reason: null };   // the last keyboard verdict (tests and the log)

function launcherAlive() { return !!launcherWin && !launcherWin.isDestroyed(); }
function launcherSay(name, payload) {
  try { launcherWin.webContents.send('mantle:event', { name, payload: toPage(name, payload) }); } catch (_) { /* reloading: the next open says it again */ }
}
function stopLauncherKbWatch() { if (launcherKbWatch) { launcherKbWatch.stop(); launcherKbWatch = null; } }

const launcherGate = surfaceGate.createGate({
  isShown: () => launcherAlive() && launcherWin.isVisible(),
  log: (t) => process.stdout.write(`mantle: launcher: ${t}\n`),
  // The FIRST frame is captured while the window is still hidden -- no content protection needed,
  // and nothing to photograph itself -- so the launcher's frost is real on the frame it appears in
  // rather than a flat tint that pops a quarter of a second later. A close meanwhile wins (the gate).
  // Hidden: wait for the picture at most LAUNCHER_PICTURE_WAIT_MS (lane mn-speed: a slow capture must
  // not hold the Win key for seconds), then open on the flat tint (launcherFirstPicture). Up: as before.
  // A hidden launcher is centred on the main display AS IT IS NOW first (lane mn-display: after a
  // resolution or scale change it opened where the old display's centre was), so the first picture
  // is of what is behind it where it opens.
  prepare: () => (!launcherAlive() ? null
    : launcherWin.isVisible() ? launcherBackdrop.once('the launcher is opening')
      : (launcherRecentre('the launcher is opening'), new Promise((resolve) => launcherFirstPicture(launcherWin, resolve)))),
  reveal: ({ again }) => {
    if (!launcherAlive()) throw new Error('there is no launcher window');
    const wasVisible = launcherWin.isVisible();
    if (flags.test) {
      // A test run must never take focus from whoever is at the machine.
      launcherWin.showInactive();
    } else {
      launcherWin.show();
      launcherWin.focus();
      // On top EVERY time (r7-ontop, 2026-10-01): show() and focus() never re-order a window Windows
      // has let sink, and focus() is refused when Mantle is not the foreground app. 'floating' is the
      // level it was made with (lib/windows.js createLauncher).
      raiseWin.up(launcherWin, { level: 'floating', what: 'the launcher', wanted: () => launcherAlive() && launcherWin.isVisible() });
    }
    // An OPEN (the gate had it closed) tells the page, which then keeps or clears your query; a
    // repeat while it is up (Win+S over an open launcher) does not, so nothing typed is wiped.
    if (!again || !wasVisible) {
      broadcast('launcher:visible', true);
      launcherBackdrop.start('the launcher is open');
    }
    if (!flags.test) armLauncherKeyboard();
  },
  conceal: () => {
    stopLauncherKbWatch();
    launcherBackdrop.stop('the launcher closed');
    launcherWin.hide();
    broadcast('launcher:visible', false);
  },
});

/** Its keyboard, live only (audit #7): checked, retried once through the sidecar, else SAID. */
function armLauncherKeyboard() {
  const win = launcherWin;
  const seq = launcherGate.seq;
  const alive = () => launcherWin === win && !win.isDestroyed() && win.isVisible() && launcherGate.seq === seq;
  surfaceGate.ensureKeyboard({
    alive,
    isFocused: () => win.isFocused(),
    retry: async () => {
      // The Start click or the Win tap came to Mantle or the sidecar: hand the right on (lib/fg-grant.js).
      const g = fgGrant.grant(sidecar.info && sidecar.info.pid);
      try {
        const r = await sidecar.call('focus', { hwnd: hwndOf(win) }, 2000);
        process.stdout.write(`mantle: launcher: the keyboard retry ran (${fgGrant.howWords(r)}; right ${fgGrant.words(g)})\n`);
      } catch (err) {
        const e = fgGrant.splitTried(err.message);
        process.stdout.write(`mantle: launcher: the keyboard retry failed (right ${fgGrant.words(g)}${e.tried ? `; ${e.tried}` : ''})\n`);
        throw new Error(e.shown);
      }
    },
    onResult: (r) => launcherKeyboardResult(win, r),
  }).catch((err) => process.stdout.write(`mantle: launcher: the keyboard check threw (${err.message})\n`));
}

function launcherKeyboardResult(win, r) {
  if (launcherWin !== win || win.isDestroyed()) return;
  stopLauncherKbWatch();
  if (r.ok) {
    if (launcherKb.ok === false) launcherSay('launcher.keyboard', { ok: true });
    launcherKb = { ok: true, how: r.how, reason: null };
    return;
  }
  launcherKbWatch = surfaceGate.watchOutside({
    bounds: () => (launcherAlive() ? launcherWin.getBounds() : null),
    cursor: () => screen.getCursorScreenPoint(),
    onOutside: (why) => { launcherKbWatch = null; hideLauncher(why); },
  });
  launcherKb = { ok: false, how: null, reason: r.reason };
  launcherSay('launcher.keyboard', { ok: false, text: surfaceGate.noKeyboardWords(r.reason, launcherKbWatch.ok) });
  process.stdout.write(`mantle: launcher: shown WITHOUT the keyboard (${r.reason}); ${launcherKbWatch.ok ? 'a click outside or Esc closes it' : `no outside-click watch: ${launcherKbWatch.reason}`}\n`);
}

/** The page got the keyboard after all (a click in it): the no-keyboard line goes, blur works again. */
function launcherGotKeyboard(win) {
  if (launcherWin !== win || launcherKb.ok !== false) return;
  launcherKeyboardResult(win, { ok: true, how: 'click' });
}

const NO_LAUNCHER = { opened: false, reason: 'there is no launcher window' };
/** Open (or bring forward). Win+S, the tray and the search feature: always "open". */
function showLauncher(from) { return launcherAlive() ? launcherGate.open(from || 'open') : Promise.resolve(NO_LAUNCHER); }
/** Close, and cancel an open still on its way. */
function hideLauncher(why) { stopLauncherKbWatch(); return launcherAlive() ? launcherGate.close(why || 'hide') : { closed: false, was: 'hidden' }; }
/** The Win tap, the Start button and Alt+Space: the same key closes it, like Spotlight / Raycast. */
function toggleLauncher(from) { return launcherAlive() ? launcherGate.toggle(from || 'toggle') : Promise.resolve(NO_LAUNCHER); }
/** Centre the launcher on the main display as it is now (lib/display-fit.js recentre). Never throws. */
function launcherRecentre(why) {
  try {
    const r = require('./lib/display-fit').recentre(launcherWin, screen, 'the launcher');
    if (r.moved || !r.rect) process.stdout.write(`mantle: launcher: ${r.reason} (${why})\n`);
    return r;
  } catch (err) {
    process.stdout.write(`mantle: launcher: it could not be centred on the main display (${why}): ${err.message}\n`);
    return { moved: false, rect: null, reason: err.message };
  }
}
// </mainrel:launcher>

/** The volume pop-up down now, if it is up (a bar popover is opening where it would cover it). Never throws. */
function dismissOsd(why) {
  const hide = COMMANDS['osd.faded'];
  if (typeof hide !== 'function') return;   // the volume pop-up feature is off or not loaded: nothing is up
  Promise.resolve().then(() => hide({})).catch((err) => {
    process.stdout.write(`mantle: the volume pop-up could not be taken down when ${why}: ${err && err.message}\n`);
  });
}

// ---------------------------------------------------------------------------
// The feature seam (wave 3, 2026-09-24): lib/features.js does the work, this is its wiring.
// ---------------------------------------------------------------------------

/**
 * Discover and start every lib/features/<name>.js. MANTLE_FEATURES_DIR swaps the folder for a
 * fixture one, in --test ONLY: a live Mantle runs the features in its own tree and nothing else.
 */
function startFeatures() {
  const envDir = process.env.MANTLE_FEATURES_DIR;
  if (envDir && !flags.test) process.stdout.write(`mantle: MANTLE_FEATURES_DIR is set but ignored: only a --test run may load features from anywhere but lib/features\n`);
  const dir = envDir && flags.test ? path.resolve(envDir) : path.join(ROOT, 'lib', 'features');
  try {
    features = createFeatures({
      dir,
      test: flags.test,
      root: ROOT,
      userData: app.getPath('userData'),
      state,
      sidecar,
      commands: COMMANDS,
      broadcast,
      host: { openLauncher: openLauncherFor, barRect: () => barRect(), display: featureDisplay, rest: (on, why) => restMantle(on, why),
        // lane mantle-corner: is the bar up, and a call on the tick it starts coming in or going
        bar: { up: () => barUpNow(), pill: () => barPillRest(), onMotion:(fn) => { barMotionFns.add(fn); return () => barMotionFns.delete(fn); } },
        media: () => lastMedia, onMedia: (fn) => { mediaListeners.add(fn); return () => mediaListeners.delete(fn); },
        // lane mantle-crash: Explorer started again (TaskbarCreated): the top bar registers its strip again
        onShellRestart,
        // lane mantle-toasts: Mantle's own notification banners (lib/features/toasts.js) ride the
        // notification centre's list, and a click reaches the app's window or the bell's list
        toasts: {
          onList: (fn) => notifications.onPublish(fn),
          // lane mantle-toastfast: a new toast is coming (before its list read), so the banner window can start
          onIncoming: (fn) => notifications.onIncoming(fn),
          last: () => notifications.lastPayload(),
          // lane mantle-notif-safety: how new notifications reach Mantle now, for Settings' notification status
          watch: () => notifications.watchState(),
          // lane mantle-notif-safety2: a crash supervisor is watching main (it puts Windows' banners back the
          // moment main is gone), and main is on its way out (shutdown() has begun)
          supervised: () => supervisor.status().on,
          quitting: () => shuttingDown,
          // the app's window, through the bar's own grouping (AUMID first, exe second: groupRunning)
          targetFor: (aumid) => {
            const want = String(aumid || '').toLowerCase();
            if (!want || !lastPinned || !Array.isArray(lastPinned.items)) return null;
            const item = lastPinned.items.find((i) => i && i.aumid && String(i.aumid).toLowerCase() === want && Array.isArray(i.windows) && i.windows.length);
            if (!item) return null;
            const w = item.windows.find((x) => !x.minimized) || item.windows[0];
            return { hwnd: String(w.hwnd) };
          },
          focus: (hwnd) => COMMANDS['bar.window']({ hwnd, action: 'focus' }),
          open: (id) => COMMANDS['notifs.open']({ id }),
          openList: () => { broadcast('bar.winkey', { key: 'n', only: 'open' }); return { ok: true }; },
        },
        // lane settings: Mantle Settings shows and flips the tray's Alt+Tab and Win+N / Win+A switches
        switcher: { get: () => switcher.settingsView(), set: (patch, who) => { switcher.setSettings(patch, who); return switcher.settingsView(); } },
        // lane dm-core: Mantle's appearance for main-drawn colours (window grounds, DWM frames)
        theme: themeHost,
        // lane see-topbar: the desktop layer's top strip, for the top bar's frosted backdrop in dark
        // lane helm-wall: in dark the strip is the WALLPAPER's top rows (lib/wall-still.js), not the
        // desktop page (its widgets live there); the page's own strip where there is no still
        desktopStrip: async (a) => {
          if (getTheme().get().theme !== 'dark') return topbarStrip.read(a);
          const w = await wallStill.strip(a && a.h);
          if (w.ok) return w;
          if (w.capture) return topbarStrip.read(a);
          return { ok: false, transient: !!w.transient, reason: w.reason };
        },
        // lane helm-wall: the wallpaper picture for the app windows (Files, Task Manager, Settings, Task
        // view): full() the whole primary display's still, rect(phys) a cut, onChange(fn) -> off()
        wall: wallHost,
        // lane mantle-topbar-zero: what a Quartz / Helm "wash" top-row hint sits on (lib/toprow-hints.js
        // washRowFor): the look-sync desktop still and the shared glass blur -> {still, id, blurPx} | {still: null, why}
        toprowWash: () => {
          try {
            const d = lookHost && lookHost.sync ? lookHost.sync.desktop() : null;
            const rec = d && d.record;
            const g = getLook().guardGlass();
            if (!(rec && rec.ok && rec.still)) return { still: null, why: 'the look-sync desktop has no still yet' };
            return { still: rec.still, id: rec.id, blurPx: g && g.blurPx };
          } catch (err) { return { still: null, why: `the desktop still could not be read (${err && err.message ? err.message : err})` }; }
        },
        // lane guard-mantle: the SHARED top-band darkening for the top bar (lib/look-guard.js use):
        // get() -> {use, alpha, ...} | {use:false, why, failure}; onChange(fn) after a look or theme change -> off()
        lookGuard: {
          get: () => {
            try { return getLook().topGuard(getTheme().get().theme); } catch (err) {
              return { use: false, why: `the shared darkening could not be read (${err && err.message ? err.message : err}), so the top bar works out its own`, failure: true };
            }
          },
          onChange: (fn) => {
            let a = () => {};
            try { a = getLook().onChange(() => fn('look')); } catch (_) { /* get() says why */ }
            const b = themeHost.onChange(() => fn('theme'));
            return () => { a(); b(); };
          },
        } },
    });
    COMMANDS['features.list'] = async () => features.list();
    if (flags.test) {
      // A page (or a test's page) can drive a feature's chord in a test run: {chord} or {key}.
      COMMANDS['features.fire'] = async (a) => (a && a.chord ? features.fireChord(a.chord, 'a page') : features.fireKey(a && a.key, 'a page'));
    }
    features.load();
  } catch (err) {
    // lib/features.js isolates each feature; this is the seam itself failing, which must not take
    // the shell with it either.
    process.stderr.write(`mantle: the feature seam could not start: ${err && err.stack ? err.stack : err}\n`);
    state.set('features', { seam: { label: 'Features', on: true, ok: false, reason: `no feature started: the feature seam threw ${err && err.message ? err.message : err}`, keys: false, keysReason: '', broken: null, stopped: false } });
  }
}

/** Every feature's stop(), bounded (lib/features.js stopAll). Never throws. */
async function stopFeatures(why) {
  if (!features) return;
  try { await features.stopAll(why); } catch (err) { process.stderr.write(`mantle: stopping the features threw: ${err && err.message ? err.message : err}\n`); }
}

/**
 * ctx.host.openLauncher({mode, query}): the launcher page gets 'launcher.open' {mode, query, from}
 * BEFORE it is shown, so it can paint the right mode on its first frame ('search' is the search
 * lane's). Throws, in plain words, when there is no launcher to open.
 */
function openLauncherFor(a, from) {
  if (!launcherWin || launcherWin.isDestroyed()) throw new Error('there is no launcher window to open (MANTLE_NO_LAUNCHER, or it was closed)');
  const payload = { mode: String((a && a.mode) || 'apps'), query: String((a && a.query) || ''), from: from || null };
  try { launcherWin.webContents.send('mantle:event', { name: 'launcher.open', payload }); } catch (_) { /* the page is reloading; showLauncher still shows it */ }
  showLauncher();
  return payload;
}

/** The launcher window, at start and again after Mantle rested for a game (again = true). */
function makeLauncher(again) {
  const launcher = createLauncher({ root: ROOT, test: flags.test });
  const win = launcherWin = launcher.win;
  watchPage(win, 'The launcher');
  if (!launcher.load.loaded) process.stderr.write(`mantle: ${launcher.load.reason}\n`);
  // A reload rebuilds the page, not the window, so the composition attribute
  // should survive -- but "should" is cheap to stop relying on, and re-asking
  // costs one JSON line.
  win.webContents.on('did-finish-load', () => { if (launcherWin === win) reapplyGlass('the launcher', win, 'acrylic'); });
  if (flags.test) {
    // In test mode the launcher is the thing being looked at, so it is up from
    // the start -- inactive, and with no hide-on-blur, or toback.ps1 sending it
    // to the back would make it vanish. Made AGAIN mid-test it stays hidden: no
    // toback.ps1 runs then, and a test never puts a window in front of Owen.
    if (!again) win.once('ready-to-show', () => { if (!win.isDestroyed()) win.showInactive(); });
  } else {
    win.on('blur', () => hideLauncher('blur'));
    win.on('focus', () => launcherGotKeyboard(win));
    if (again) win.once('ready-to-show', () => { if (launcherWin === win) squareCorners('the launcher', win).catch(() => {}); });
  }
  return win;
}

/*
 * MANTLE RESTS WHILE A GAME RUNS (lane memfix, 2026-09-26). Owen had to close Mantle to play
 * Valorant: "it was taking up too much ram and it made my game stutter". Game mode's watch
 * (lib/features/gamemode.js) calls ctx.host.rest(true, 'VALORANT runs') while a known game runs or
 * game mode is on, and rest(false, ...) when the last one has exited. Resting:
 *   - every feature with `rest: true` is stopped (lib/features.js restAll): its windows are
 *     destroyed, its chords go back to Windows, it reads healthy, "resting while VALORANT runs";
 *   - the launcher window is destroyed and the Win key goes back to Windows' Start;
 *   - the switcher window is destroyed and Alt+Tab goes back to Windows (lib/switcher.js rest);
 *   - the wallpaper is unloaded, not paused (lib/wallpaper.js rest).
 * KEPT: the bar (Owen alt-tabs out between games, and it is the only way to reach Mantle), the
 * desktop layer's window (it is attached under the wallpaper; re-attaching is the fragile part of
 * start-up), the main process, the sidecar (the keyboard hook, game mode's own scan).
 * Waking makes everything again the way start-up makes it. One rest at a time (a chain).
 */
let restState = null;          // { why, since, closed:[names], before, after } while resting
let restChain = Promise.resolve();
function pageNames() {
  const names = [];
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue;
    const named = w === barWin ? 'bar' : w === launcherWin ? 'launcher' : w === desktopWin ? 'desktop' : w === switcher.overlayWindow() ? 'switcher' : null;
    const m = /\/ui\/([^/]+)\/(.+?)(?:\.html)?(?:[?#]|$)/.exec(String(w.webContents.getURL() || '').replace(/\\/g, '/'));
    names.push(named || (m ? (m[2] === 'index' ? m[1] : `${m[1]} ${m[2]}`) : (w.getTitle() || 'a window')));
  }
  return names;
}
function electronMB() {
  let priv = 0, ws = 0;
  try { for (const p of app.getAppMetrics()) { priv += p.memory.privateBytes || 0; ws += p.memory.workingSetSize || 0; } } catch (_) { /* no numbers */ }
  return { private: Math.round(priv / 1024), ws: Math.round(ws / 1024) };
}
function mb(n) { return n >= 1024 ? `${(n / 1024).toFixed(1)} GB` : `${n} MB`; }
function restMantle(on, why) {
  restChain = restChain.then(() => (on ? restNow(why) : wakeNow(why))).catch((err) => ({ ok: false, reason: err && err.message ? err.message : String(err) }));
  restChain.then(hoverAfterRest, hoverAfterRest);
  return restChain;
}
/** The hover poll stopped for a game (hoverTick) runs again once Mantle no longer rests for one. */
function hoverAfterRest() {
  if (!hoverHeld || gameQuiet()) return;
  process.stdout.write(`mantle: hover poll: running again (${hoverHeld.replace(/ runs$/, '')} is over)\n`);
  hoverHeld = null;
  scheduleHoverTick();
}
async function restNow(why) {
  if (shuttingDown) return { ok: false, reason: 'Mantle is closing' };
  if (restState) {
    if (restState.why !== why) { restState.why = why; if (features) await features.restAll(why); switcher.rest(why); }
    return Object.assign({ ok: true, same: true }, restState);
  }
  const t0 = Date.now();
  const before = electronMB();
  const pagesBefore = pageNames();
  restState = { why, since: t0, closed: [], before, after: null, text: null };
  if (features) await features.restAll(why);
  if (launcherWin && !launcherWin.isDestroyed()) {
    hideLauncher();
    const win = launcherWin;
    launcherWin = null;
    try { win.destroy(); } catch (_) { /* gone */ }
    if (!flags.test && sidecar && !sidecar.blockedReason()) sidecar.call('hotkey', { winTap: false }, 4000).catch(() => {});
    state.set('hotkey', { winTap: false, resting: true, reason: `the Win key opens Windows' Start while Mantle rests (${why}); Mantle's launcher is back when it exits` });
  }
  switcher.rest(why);
  const wp = wallpaper.rest(why);
  broadcast('mantle.rest', { on: true, why });   // the desktop page stops its clock, numbers and Mission Control
  // A destroyed window's renderer takes a moment to exit; the numbers are read after it has.
  await new Promise((r) => setTimeout(r, 1500));
  const pagesAfter = pageNames();
  const left = pagesAfter.slice();
  restState.closed = pagesBefore.filter((n) => { const i = left.indexOf(n); if (i < 0) return true; left.splice(i, 1); return false; });
  restState.after = electronMB();
  restState.wallpaper = wp.had ? 'unloaded' : 'none showing';
  // What is kept hands its idle pages back to Windows for the game (sidecar gamemode.trim: only
  // Mantle's own Electron processes, never the sidecar). Measured on the --test instance: the kept
  // processes' working set 429 MB -> 77 MB 30 s later. Private memory is unchanged by it.
  let trimWords = '';
  if (sidecar && !sidecar.blockedReason()) {
    try {
      const r = await sidecar.call('gamemode.trim', { pids: app.getAppMetrics().map((p) => p.pid) }, 6000);
      trimWords = `; idle pages of ${(r && r.trimmed) || 0} Mantle process${r && r.trimmed === 1 ? '' : 'es'} handed back to Windows`;
    } catch (err) {
      trimWords = `; its idle pages were NOT handed back to Windows (${err.message})`;
    }
  } else trimWords = '; its idle pages were NOT handed back to Windows (the sidecar is not running)';
  restState.text = `closed ${restState.closed.length} window${restState.closed.length === 1 ? '' : 's'} (${restState.closed.join(', ') || 'none'})` +
    `${wp.had ? ', wallpaper unloaded' : ''}; Mantle's memory ${mb(before.private)} -> ${mb(restState.after.private)}` +
    ` (working set ${mb(before.ws)} -> ${mb(restState.after.ws)})${trimWords}; kept: ${pagesAfter.join(', ') || 'no window'}, the sidecar and the main process`;
  process.stdout.write(`mantle: rest: resting while ${why} in ${Date.now() - t0} ms: ${restState.text}\n`);
  const mine = restState;
  const later = setTimeout(() => { if (restState === mine) process.stdout.write(`mantle: rest: 30 s later: Mantle's working set ${mb(electronMB().ws)} (private ${mb(electronMB().private)})\n`); }, 30000);
  if (later.unref) later.unref();
  return Object.assign({ ok: true }, restState);
}
/*
 * IDLE PAGES BACK TO WINDOWS (lane ramdiet, 2026-09-27). Start-up touches pages no idle Mantle
 * touches again (every page's first load and layout, the features' installs), and they sit in
 * Mantle's working set until Windows is short of RAM. TRIM_AFTER_MS after start, and after every
 * wake from a game, the sidecar's gamemode.trim (EmptyWorkingSet on Mantle's OWN Electron pids,
 * the rest's own call) hands them back. Private memory is unchanged by it; the numbers are logged.
 */
const TRIM_AFTER_MS = 60 * 1000;
let trimTimer = null;
function trimOwnSoon(why) {
  clearTimeout(trimTimer);
  trimTimer = setTimeout(() => { trimTimer = null; trimOwn(why).catch(() => {}); }, TRIM_AFTER_MS);
  if (trimTimer.unref) trimTimer.unref();
}
async function trimOwn(why) {
  if (shuttingDown || restState) return;   // resting: restNow trims already
  if (!sidecar || sidecar.blockedReason()) {
    process.stdout.write(`mantle: trim (${why}): NOT done: the sidecar is not running (${sidecar ? sidecar.blockedReason() : 'none'})\n`);
    return;
  }
  const before = electronMB();
  try {
    const r = await sidecar.call('gamemode.trim', { pids: app.getAppMetrics().map((p) => p.pid) }, 6000);
    const after = electronMB();
    process.stdout.write(`mantle: trim (${why}): idle pages of ${(r && r.trimmed) || 0} Mantle processes handed back to Windows; working set ${mb(before.ws)} -> ${mb(after.ws)} (private ${mb(after.private)}, unchanged by a trim)\n`);
  } catch (err) {
    process.stdout.write(`mantle: trim (${why}): NOT done: ${err.message}\n`);
  }
}
async function wakeNow(why) {
  if (!restState) return { ok: true, same: true, text: 'Mantle was not resting' };
  if (shuttingDown) { restState = null; return { ok: false, reason: 'Mantle is closing' }; }
  const t0 = Date.now();
  const was = restState;
  restState = null;
  const back = [];
  wallpaper.rest(null);
  broadcast('mantle.rest', { on: false, why });
  if (features) back.push(...await features.wakeAll(why));
  if (switcher.rest(null)) back.push('switcher');
  if ((!launcherWin || launcherWin.isDestroyed()) && process.env.MANTLE_NO_LAUNCHER !== '1') {
    makeLauncher(true);
    back.push('launcher');
    if (flags.test) state.set('hotkey', { winTap: false, reason: 'test mode: the Win key hook was not installed' });
    else if (sidecar && !sidecar.blockedReason()) {
      try {
        const r = await sidecar.call('hotkey', { winTap: true }, 4000);
        const installed = !!(r && r.installed);
        state.set('hotkey', { winTap: installed, reason: installed ? 'a tap of the Win key opens the Mantle launcher' : 'the sidecar did not install the Win key hook and did not say why' });
      } catch (err) {
        state.set('hotkey', { winTap: false, reason: `the Win key still opens the Windows Start menu: ${err.message}` });
      }
    }
  }
  const text = `back after ${Math.round((Date.now() - was.since) / 60000)} min (${why}): ${back.join(', ') || 'nothing to bring back'}${was.wallpaper === 'unloaded' ? ', wallpaper' : ''}`;
  process.stdout.write(`mantle: rest: ${text} in ${Date.now() - t0} ms\n`);
  trimOwnSoon(`${Math.round(TRIM_AFTER_MS / 1000)} s after the wake`);
  return { ok: true, back, text };
}

/** ctx.host.display(): the display under the cursor, which is where a feature's panel belongs. */
function featureDisplay() {
  const cursor = screen.getCursorScreenPoint();
  const d = screen.getDisplayNearestPoint(cursor);
  return { id: d.id, bounds: d.bounds, workArea: d.workArea, scaleFactor: d.scaleFactor, primary: d.id === screen.getPrimaryDisplay().id, cursor };
}

// ---------------------------------------------------------------------------
// THE PINNED + RUNNING LIST the bar draws as centred icons.
//
// Two sources, one list: lane C's lib/pinned.js reads Windows' own pinned-to-
// taskbar shortcuts (in taskbar order), and the sidecar's `windows` command says
// what is actually running. They are matched on the LOWERCASED FULL EXE PATH,
// which is the only key both sides can agree on -- a title changes with every
// tab, and a pin's .lnk name is whatever Owen renamed it to.
//
// Every failure in here is a reason on the item or on the reply, never a missing
// icon with no explanation: a blank square in a taskbar is indistinguishable
// from a bug, which is exactly what the no-silent-failures rule is about.
// ---------------------------------------------------------------------------

/**
 * Ask the sidecar for one icon per path, and remember what happened -- until the file changes or
 * the answer is ICON_RECHECK_MS old (lib/icon-fresh.js): a rebuilt app then shows its new picture.
 * `index` is the icon index out of a pin's IconLocation ("shell32.dll,14"); the
 * sidecar ignores it if its `icon` command does not take one, which is why it is
 * sent rather than used to pick a different call.
 */
async function iconFor(candidates, index) {
  const tried = [];
  const idx = Number.isInteger(index) ? index : null;
  for (const raw of candidates) {
    if (!raw) continue;
    const p = String(raw);
    const key = idx ? `${p.toLowerCase()}#${idx}` : p.toLowerCase();
    const hit = iconCache.get(key);
    if (hit && iconFresh.isFresh(hit, p, { recheckMs: ICON_RECHECK_MS })) {
      if (hit.icon) return hit;
      tried.push(`${path.basename(p)}: ${hit.reason}`);
      continue;
    }
    // `hit` (if any) is an answer due to be asked again. Its picture beats a blank while the sidecar
    // cannot answer: an unreachable sidecar never takes an icon off the bar.
    const blocked = sidecar.blockedReason();
    if (blocked) {
      if (hit && hit.icon) return { icon: hit.icon, reason: null };
      return { icon: null, reason: `no icon: the sidecar cannot be asked (${blocked})` };
    }
    let entry;
    // A Store app's id (a pin or a running app that has no exe picture) asks `app`, the way the
    // launcher does (makeIconResolver); an id that is not a package app id is not sent at all.
    const store = storeAumidOf(p);
    try {
      if (store === false) {
        entry = { icon: null, reason: 'not an app id Mantle asks Windows about' };
      } else if (store) {
        const r = await sidecar.call('app', { aumid: store }, 4000);
        const png = appReplyPng(r);
        entry = png ? { icon: png, reason: null } : { icon: null, reason: r && r.ok === false ? 'Windows does not know that app' : 'Windows had no icon for it' };
      } else {
        const r = await sidecar.call('icon', idx ? { path: p, index: idx } : { path: p }, 4000);
        entry = r && r.icon
          ? { icon: r.icon, reason: null }
          : { icon: null, reason: 'Windows had no icon for it' };
      }
    } catch (err) {
      // the ask failed (not "Windows has no icon"): keep the picture it had; asked again next time round
      entry = hit && hit.icon ? { icon: hit.icon, reason: null } : { icon: null, reason: err.message };
    }
    iconCache.set(key, iconFresh.stamp(entry, p));
    if (entry.icon) return entry;
    tried.push(`${path.basename(p)}: ${entry.reason}`);
  }
  return { icon: null, reason: tried.length ? `no icon (${tried.join('; ')})` : 'no icon: nothing to read one from (no shortcut, target or exe path)' };
}

/** A readable name for a running app that no pin claimed. */
function nameForExe(exe, fallback) {
  if (!exe) return fallback || 'Unnamed';
  const base = path.basename(String(exe)).replace(/\.exe$/i, '');
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : (fallback || 'Unnamed');
}

/*
 * MANTLE'S OWN WINDOWS ARE NEVER "RUNNING APPS" (2026-09-22). The sidecar already skips its
 * parent's windows (--parent-pid), but that is only THIS instance's: measured the same day, a
 * sidecar under any other parent lists the live shell's "Mantle bar" and "Mantle desktop" as
 * ordinary app windows, so a test bar showed the live shell as a running app (with previews of
 * it in the flyout), and the live bar would show a test instance's. Either mark is enough:
 *   - the AUMID com.owensilva.mantle (app.setAppUserModelId above). Measured: it does NOT come
 *     through on these windows today (the sidecar reads the per-window AUMID and Electron sets
 *     only the process's, so aumid was null), but it is the right mark the day it does;
 *   - an electron.exe window with one of the titles Mantle gives its windows (lib/windows.js,
 *     lib/wallpaper.js). electron.exe alone is NOT enough: Owen's browser is electron.exe too.
 * Filtered where the list comes IN (the sidecar push, windows.list, buildPinned's fallback), so
 * the dock, the flyout and anything else reading lastWindows all agree.
 */
const MANTLE_AUMID = 'com.owensilva.mantle';
const MANTLE_TITLES = new Set(['mantle bar', 'mantle desktop', 'mantle launcher', 'mantle wallpapers', 'mantle switcher',
  // wave 3 (2026-09-24): the feature pages (sidecar AltTab.cs MantleTitles has the same list)
  'mantle task view', 'mantle volume', 'mantle clipboard', 'mantle snap', 'mantle screenshot', 'mantle top bar']);
// Mantle's APP windows (lane settings, 2026-09-28): windows Owen works in like any app's, listed on
// the bar and in Alt+Tab (the sidecar's Switcher.IsMantleApp lets the same exact titles through).
const MANTLE_APP_TITLES = new Set(['Mantle Settings', 'Mantle Task Manager', 'Mantle Files']);
function isMantleWindow(w) {
  if (!w) return false;
  const exe0 = w.exe ? path.basename(String(w.exe)).toLowerCase() : '';
  if (exe0 === 'electron.exe' && MANTLE_APP_TITLES.has(String(w.title || ''))) return false;
  if (w.aumid && String(w.aumid).toLowerCase() === MANTLE_AUMID) return true;
  const exe = w.exe ? path.basename(String(w.exe)).toLowerCase() : '';
  return exe === 'electron.exe' && MANTLE_TITLES.has(String(w.title || '').trim().toLowerCase());
}
/*
 * MANTLE'S APP WINDOWS AS APPS (icons lane, 2026-09-28). Owen: "they need to have there own icons
 * that replace windows icons not just be electron". Mantle Settings and Mantle Task Manager are
 * electron.exe windows, so they came in with electron.exe's icon and, with no AUMID, grouped under
 * one electron.exe key (with each other, and with any other Electron app that has none).
 * lib/mantle-apps.js knows them; here each one gets, where the list comes IN:
 *   - an AUMID: its own per-window one (setAppDetails 'Mantle.Settings' / 'Mantle.TaskManager',
 *     read by the sidecar), else that same id filled in from the exact title, so groupRunning keys
 *     each app on its own and the two never merge with each other or with electron.exe;
 *   - its icon: the window's OWN (the sidecar asks the window, iconFrom 'window'), else Mantle's
 *     file from assets/icons, never electron.exe's (iconFrom 'exe');
 *   - mantleApp: 'settings' | 'taskmgr', which buildPinned, launchItem and the bar key on.
 */
let mantleApps = null;
try { mantleApps = require('./lib/mantle-apps'); } catch (err) { process.stderr.write(`mantle: lib/mantle-apps.js did not load (${err.message}): Mantle Settings / Task Manager show as Electron\n`); }
function markMantleApp(w) {
  const key = mantleApps && w ? mantleApps.forWindow(w) : null;
  if (!key) return w;
  const a = mantleApps.APPS[key];
  const own = w.icon && w.iconFrom === 'window';
  const file = own ? null : mantleApps.iconOf(key, 64);   // 64 like every other app's (sidecar Icons.cs): sharp at 200 %
  return Object.assign({}, w, {
    aumid: w.aumid || a.aumid,
    mantleApp: key,
    // a missing file is NO icon with its reason (the bar says it), never electron.exe's quietly
    icon: own ? w.icon : (file.icon || null),
    iconFrom: own ? 'window' : (file.icon ? 'mantle' : null),
    iconReason: own || file.icon ? null : file.reason,
  });
}
function withoutMantle(list) {
  return Array.isArray(list) ? list.filter((w) => !isMantleWindow(w)).map(markMantleApp) : [];
}

/** The running windows, grouped one bucket per exe, in the sidecar's order. */
function groupRunning(list) {
  const groups = new Map();
  for (const w of Array.isArray(list) ? list : []) {
    if (!w || w.hwnd === undefined || w.hwnd === null) continue;
    /*
     * AUMID FIRST, exe second (2026-09-21). Owen: "i want the apps when i have
     * them running to work the same as before". Grouping by exe path alone never
     * managed it for three whole classes of app:
     *   - Discord: the PIN points at Update.exe, the WINDOWS are Discord.exe.
     *   - Edge: the pin and the windows disagree about which exe path it is.
     *   - Any Store app: every window belongs to ApplicationFrameHost.exe.
     * The Application User Model ID is the one identifier Windows itself uses to
     * decide what belongs under which taskbar button, so it is the one we use.
     * The exe stays as the fallback key for everything that has no aumid.
     */
    const aumid = w.aumid ? String(w.aumid).toLowerCase() : null;
    const exe = w.exe ? String(w.exe).toLowerCase() : null;
    const key = aumid || exe || `hwnd:${w.hwnd}`;
    let g = groups.get(key);
    if (!g) {
      g = { key, aumid, exe, exeRaw: w.exe || null, host: w.host || null, icon: w.icon || null, title: w.title || '', windows: [] };
      if (w.mantleApp) { g.mantleApp = w.mantleApp; g.iconReason = w.iconReason || null; }
      groups.set(key, g);
    }
    if (!g.icon && w.icon) g.icon = w.icon;
    g.iconPending = !g.icon && (!!g.iconPending || !!w.iconPending);   // its icon is on its way (buildPinned)
    // A group can learn its other identifier from a later window: one window of an
    // app may carry an aumid and the next only an exe.
    if (!g.aumid && aumid) g.aumid = aumid;
    if (!g.exe && exe) { g.exe = exe; g.exeRaw = w.exe; }
    if (!g.host && w.host) g.host = w.host;
    g.windows.push({
      hwnd: String(w.hwnd),
      // The window's (app's) pid rides along so "Keep on top" can refuse a reused handle
      // (ontop.js compares it with the window's pid AND its app's pid; security review #19).
      pid: Number(w.pid) || 0,
      title: String(w.title || ''),
      active: !!w.foreground,
      minimized: !!w.minimized,
    });
  }
  return groups;
}

/**
 * Build the whole list. Never throws: the bar gets {ok:false, reason, items} with
 * whatever half of it worked, because a taskbar with the running apps in it and a
 * sentence about the missing pins beats an empty strip.
 */
async function buildPinned() {
  const problems = [];   // the list is WRONG: ok:false
  const notes = [];      // the list is right and something is worth saying: ok stays true

  // 1. The running apps. lastWindows is pushed by the sidecar; if nothing has
  //    arrived yet, ask once rather than render an empty bar on first paint.
  let running = lastWindows;
  let runningRead = true;   // false = the list below is not the truth, so the dragged order keeps every app in it
  if (!running.length) {
    try {
      const listed = await sidecar.call('windows', {}, 4000);
      running = withoutMantle(listed);
      lastWindows = running;
    } catch (err) {
      problems.push(`the running apps could not be read: ${err.message}`);
      running = [];
      runningRead = false;
    }
  }
  const groups = groupRunning(running);

  // 2. The pins, from lane C's module.
  let pins = [];
  if (!pinnedModule) {
    problems.push(pinnedModuleReason || 'lib/pinned.js is not loaded and did not say why');
  } else {
    try {
      let r = (pinsCache && Date.now() - pinsCacheAt < PINS_CACHE_MS) ? pinsCache : null;
      if (!r) {
        r = await pinnedModule.listPinned({ sidecarCall: (cmd, args, timeoutMs) => sidecar.call(cmd, args, timeoutMs) });
        // cache only a clean read: a fallback read (sidecar not ready yet) must be retried
        if (r && r.ok === true && !/sidecar/i.test(String(r.reason || ''))) { pinsCache = r; pinsCacheAt = Date.now(); }
      }
      if (r && Array.isArray(r.items)) pins = r.items;
      if (!r || r.ok !== true) problems.push(`the pinned list is incomplete: ${(r && r.reason) || 'lib/pinned.js did not say why'}`);
      // ok:true WITH a reason is lane C's notes channel ("nothing is pinned",
      // "shortcuts read without the sidecar"). True and worth saying, so it rides
      // along in the reply's reason without turning the list into a failure.
      else if (r.reason) notes.push(String(r.reason));
    } catch (err) {
      problems.push(`lib/pinned.js threw while reading the pinned shortcuts: ${err.message}`);
    }
  }
  pins = pins.slice().sort((a, b) => (Number(a && a.order) || 0) - (Number(b && b.order) || 0));
  /* Mantle's OWN "Pin to taskbar" / "Unpin from taskbar" (the right-click menu, lane jumplist,
     2026-09-24): an overlay kept by lib/features/jumplist.js, applied here, so Windows' own pins
     are never written. Unreadable = Windows' pins as they are, and the reason is said. */
  try {
    const own = require('./lib/features/_jumplist-pins');
    pins = own.apply(pins, own.read(app.getPath('userData')));
  } catch (err) {
    problems.push(err.message);
  }

  const items = [];
  const claimed = new Set();
  pinById.clear();

  // Two ways into the same groups: by aumid and by exe. A group keyed on its
  // aumid still has to be findable by a pin that only knows an exe, and vice
  // versa -- that asymmetry is exactly what left Discord's windows orphaned.
  const byAumid = new Map();
  const byExe = new Map();
  for (const g of groups.values()) {
    if (g.aumid && !byAumid.has(g.aumid)) byAumid.set(g.aumid, g);
    if (g.exe && !byExe.has(g.exe)) byExe.set(g.exe, g);
  }
  // Claims are namespaced: an aumid and an exe are different kinds of name and
  // must never collide in one Set.
  const claimAumid = (v) => { if (v) claimed.add('a:' + v); };
  const claimExe = (v) => { if (v) claimed.add('e:' + v); };
  const isClaimed = (g) => !!((g.aumid && claimed.has('a:' + g.aumid)) || (g.exe && claimed.has('e:' + g.exe)));

  /* A pin of WINDOWS' Settings or Task Manager (icons lane, 2026-09-28): Mantle's version stands in
     for it, the way Win+I and Ctrl+Shift+Esc already open Mantle's. The pin keeps its place and its
     shortcut (nothing about which pins exist changes, and Windows' pin data is never written); it
     shows Mantle's icon and name, gathers Mantle's windows, opens Mantle's (launchItem), and its
     right-click menu keeps "Windows Settings" / "Windows Task Manager" (ui/bar/jumplist.js). */
  const featureList = (() => { try { return features ? features.list() : []; } catch (_) { return []; } })();
  for (const pin of pins) {
    if (!pin) continue;
    /* A pin OF a Mantle app (lane barfiles, 2026-09-29; Owen: "mantle files it isnt letting me pin
       it to taskbar"): "Pin to taskbar" on a Mantle Files window stores electron.exe + 'mantle.files'.
       Treated as a plain pin it drew electron.exe's icon, borrowed ANY electron.exe window by exe once
       its own were closed (Mantle Settings' preview on hover), and a click started bare electron.exe.
       It is that Mantle app: its icon, its own windows only, and a click opens it. */
    const self = mantleApps && typeof mantleApps.forPin === 'function' ? mantleApps.forPin(pin) : null;
    const stand = self || (mantleApps ? mantleApps.standInFor(pin) : null);
    if (stand) {
      const a = mantleApps.APPS[stand];
      const mine = a.aumid.toLowerCase();
      if (claimed.has('a:' + mine)) continue;
      claimAumid(mine);
      const g = byAumid.get(mine) || null;
      const ico = mantleApps.iconOf(stand, 64);
      const avail = mantleApps.availability(stand, featureList);
      const id = String(pin.id || pin.lnkPath || pin.name || `pin:${items.length}`);
      // a Mantle app's own pin has no Windows shortcut (its target is electron.exe): Windows' own = windowsTarget
      if (!self) pinById.set(id, pin);
      items.push({
        id,
        name: a.title,
        kind: 'pinned',
        exe: pin.exe ? String(pin.exe).toLowerCase() : null,
        aumid: mine,
        icon: ico.icon || (g && g.icon) || null,
        iconReason: ico.icon ? null : ico.reason,
        mantleApp: stand,
        standsInFor: a.windowsName,
        selfPin: !!self,            // Mantle's own pin of it, not a Windows pin it stands in for
        // said on the icon while Mantle's cannot open (off, resting for a game): a click opens Windows'
        standInReason: avail.ok ? null : `${avail.reason}, so this opens ${a.windowsName}`,
        windows: g ? g.windows : [],
      });
      continue;
    }
    const pinAumid = pin.aumid ? String(pin.aumid).toLowerCase() : null;
    const exe = pin.exe ? String(pin.exe).toLowerCase() : null;
    // one Item per app, first pin wins
    if ((pinAumid && claimed.has('a:' + pinAumid)) || (exe && claimed.has('e:' + exe))) continue;
    const g = (pinAumid && byAumid.get(pinAumid)) || (exe && byExe.get(exe)) || null;
    // Claim the PIN's names and the MATCHED GROUP's names: Discord's pin is
    // Update.exe and its windows are Discord.exe, so claiming only the pin's
    // side would list Discord twice -- once pinned, once running.
    claimAumid(pinAumid);
    claimExe(exe);
    if (g) { claimAumid(g.aumid); claimExe(g.exe); }
    // last: the pin's Store app id (lib/pinned.js asks `app` already; this covers a pin it could not)
    const ico = pin.iconPng ? { icon: pin.iconPng, reason: null } : await iconFor([pin.iconPath, pin.target, pin.exe, g && g.exeRaw, pin.aumid ? APPS_FOLDER + pin.aumid : null], pin.iconIndex);
    const id = String(pin.id || pin.lnkPath || pin.name || `pin:${items.length}`);
    pinById.set(id, pin);
    /*
     * A pin can carry its own reason even when nothing failed -- lane C sets one
     * for a pin whose app has been uninstalled (Owen's Comet pin right now), which
     * is why `exe` comes back null and no window ever matches it. It goes on
     * iconReason, the one per-item channel the bar renders, when there is no icon
     * to draw; when there IS an icon it would sit next to a perfectly good picture,
     * so it rides in the reply's reason instead of being thrown away.
     */
    const pinNote = pin.reason ? String(pin.reason) : null;
    if (pinNote && ico.icon) notes.push(`${pin.name}: ${pinNote}`);
    items.push({
      id,
      name: String(pin.name || nameForExe(pin.exe, pin.lnkPath)),
      kind: 'pinned',
      exe: exe,
      aumid: pinAumid || (g && g.aumid) || null,
      icon: ico.icon,
      iconReason: ico.icon ? null : [pinNote, ico.reason].filter(Boolean).join(' -- '),
      windows: g ? g.windows : [],
    });
  }

  // 3. Everything running that no pin claimed, in the order Windows enumerated it.
  for (const [key, g] of groups) {
    if (isClaimed(g)) continue;
    // Mantle's app windows (markMantleApp): never electron.exe's icon, and named as themselves
    const ico = g.icon ? { icon: g.icon, reason: null }
      : g.mantleApp ? { icon: null, reason: g.iconReason || 'Mantle\'s icon file is missing' }
      // The sidecar is still reading this app's icon off its ui lane (Windows.cs QueueIcon, lane
      // r7-fg) and sends the list again with it within ~1 s: no icon until then, never a guessed one
      // (asking by exe first would give a Store app its exe's picture, not its own).
      : g.iconPending ? { icon: null, reason: 'still loading' }
      : await iconFor([g.exeRaw, g.aumid ? APPS_FOLDER + g.aumid : null]);
    items.push(Object.assign({
      id: `running:${key}`,
      name: g.mantleApp ? mantleApps.APPS[g.mantleApp].title : nameForExe(g.exeRaw, g.title),
      kind: 'running',
      exe: g.exe,
      aumid: g.aumid || null,
      icon: ico.icon,
      iconReason: ico.icon ? null : ico.reason,
      windows: g.windows,
    }, g.mantleApp ? { mantleApp: g.mantleApp, standsInFor: mantleApps.APPS[g.mantleApp].windowsName } : {}));
  }

  /* TEST ONLY: --test-dock-extra=N adds N filler cells (2026-09-22). The dock's squeeze -- the
     media chip compacting to art + glyph BEFORE any app is hidden -- depends on how many apps
     are running, which a test run cannot arrange without launching apps on Owen's machine. The
     fillers borrow a real icon, own no windows and no exe, and are named as what they are. */
  const extraArg = flags.test && ARGV.find((x) => typeof x === 'string' && x.startsWith('--test-dock-extra='));
  const extra = extraArg ? Math.max(0, Math.min(20, parseInt(extraArg.split('=')[1], 10) || 0)) : 0;
  const donor = items.find((it) => it.icon) || null;
  for (let k = 1; k <= extra; k++) {
    items.push({ id: `test-filler:${k}`, name: `Test filler ${k}`, kind: 'running', exe: null, aumid: null,
      icon: donor ? donor.icon : null, iconReason: donor ? null : 'test filler: no real icon to borrow', windows: [] });
  }

  const said = problems.concat(notes);
  return {
    ok: !problems.length,
    reason: said.length ? said.join('; ') : null,
    // the running-only apps in the order they were dragged to this session (lane bardrag, jumplist.order)
    items: require('./lib/features/_jumplist-pins').orderRunning(items, { prune: runningRead }),
  };
}

/** One build at a time, however many things ask for one at once. */
function pinnedOnce() {
  if (pinnedBuilding) return pinnedBuilding;
  pinnedBuilding = buildPinned()
    .catch((err) => ({ ok: false, reason: `the pinned list could not be built: ${err && err.message ? err.message : err}`, items: [] }))
    .then((res) => { pinnedBuilding = null; lastPinned = res; return res; });
  return pinnedBuilding;
}

let lastPinnedPushAt = 0;
let lastPinnedProblem = null;
/** Push to the bar, at most once a second however often the window set churns. */
function schedulePinnedPush(why) {
  pinnedPushWhy = pinnedPushWhy && pinnedPushWhy !== why ? `${pinnedPushWhy}; ${why}` : why;
  if (pinnedPushTimer) return;
  const wait = Math.max(0, 1000 - (Date.now() - lastPinnedPushAt));
  pinnedPushTimer = setTimeout(() => {
    pinnedPushTimer = null;
    const reason = pinnedPushWhy || 'something changed';
    pinnedPushWhy = null;
    lastPinnedPushAt = Date.now();
    pinnedOnce().then((res) => {
      broadcast('bar.pinned', res);
      // Once per CHANGE of reason, not once per second: the window set churns
      // every time Owen alt-tabs, and a terminal full of the same sentence is
      // how a real one stops being read.
      if (!res.ok && res.reason !== lastPinnedProblem) {
        lastPinnedProblem = res.reason;
        process.stderr.write(`mantle: the bar's pinned list is incomplete (${reason}): ${res.reason}\n`);
      } else if (res.ok && lastPinnedProblem) {
        lastPinnedProblem = null;
        process.stdout.write("mantle: the bar's pinned list is complete again\n");
      }
    });
  }, wait);
  if (pinnedPushTimer.unref) pinnedPushTimer.unref();
}

/**
 * Start an item: a .lnk pin through the shell, a Store-app pin through its AUMID.
 *
 * Five of Owen's fourteen taskbar pins are Store apps with NO shortcut file at
 * all -- there is no path to open, only an Application User Model ID, and the
 * only way to start one is ShellExecute on shell:AppsFolder\<aumid>, which is
 * what the sidecar's `launch` does. A running-only entry can be started the same
 * way if Windows gave its windows an aumid.
 */
/** Up next's port is only worth opening while the Spotify queue feature is on (its tray toggle). */
function spotifyQueueOn() {
  try {
    const f = features && features.list().find((x) => x && x.name === 'spotify');
    return !!(f && f.enabled && !f.stopped);
  } catch (_) {
    return false;
  }
}

/*
 * Mantle Settings / Mantle Task Manager from the bar (icons lane, 2026-09-28): a stand-in pin for
 * Windows' app, or Mantle's running entry. Opened the way the launcher opens them (lib/launcher-
 * index.js): Settings through app 'mantle-open' with a reply object that lib/features/settings.js
 * fills in, the task manager on its own 'mantle-open:taskmgr' event, which it listens to only
 * while on and awake. Not opened (off, resting for a game, not loaded) = WINDOWS' own opens, and
 * the answer carries fellBack, the reason, which the bar shows. --test only says what it would do.
 */
async function openMantleApp(item, via) {
  const key = item.mantleApp;
  const a = mantleApps.APPS[key];
  const avail = mantleApps.availability(key, (() => { try { return features ? features.list() : []; } catch (_) { return []; } })());
  // Mantle Files opens for real in --test: its test windows are made OFF SCREEN and never shown
  // (lib/features/files.js), so a test bar's click can be timed end to end (lane barfiles)
  if (flags.test && !(key === 'files' && avail.ok)) {
    const reason = `dry run: would open ${a.title}${avail.ok ? '' : ` -- but ${avail.reason}, so ${a.windowsName} would open`}`;
    process.stdout.write(`mantle: launch dry run (--test): ${reason}\n`);
    return { ok: true, reason, action: 'dry-run', dryRun: true, fellBack: avail.ok ? null : avail.reason };
  }
  let why = null;
  if (key === 'settings') {
    const reply = { handled: false, ok: false, reason: null };
    app.emit('mantle-open', 'settings', { section: null, row: null, uri: 'ms-settings:', via, reply });
    if (reply.handled && reply.ok) return { ok: true, reason: null, action: 'launched', mantleApp: key };
    why = reply.handled ? (reply.reason || `${a.title} did not open and did not say why`) : (avail.ok ? `${a.title} is not running` : avail.reason);
  } else {
    // the task manager (and any later app window) listens on its OWN event only while on and awake
    const ev = `mantle-open:${key}`;
    if (app.listenerCount(ev) > 0) {
      // Mantle Files: the same openWindow Win+E runs (lib/features/files.js 'mantle-open:files'), no explorer.exe
      // (files fills `reply` with openWindow's own answer; the task manager takes a view name and has none)
      const reply = { handled: false, ok: false, reason: null };
      try { app.emit(ev, key === 'taskmgr' ? 'apps' : { via, reply }); } catch (err) { return { ok: false, reason: `${a.title} did not open: ${err.message}` }; }
      if (reply.handled && !reply.ok) return { ok: false, reason: `${a.title} did not open: ${reply.reason || 'it did not say why'}` };
      return { ok: true, reason: null, action: 'launched', mantleApp: key };
    }
    why = avail.ok ? `${a.title} is off or resting while a game runs` : avail.reason;
  }
  const r = await openWindowsOwn(item);
  if (!r.ok) return { ok: false, reason: `${why}, and ${a.windowsName} did not open either: ${r.reason}` };
  process.stdout.write(`mantle: ${a.title} could not open (${why}): opened ${a.windowsName}\n`);
  return Object.assign(r, { reason: `opened ${a.windowsName}: ${why}`, fellBack: why });
}

/** Windows' own Settings / Task Manager for a Mantle app item: the stand-in pin's own shortcut, else Windows' target. */
async function openWindowsOwn(item) {
  const a = mantleApps.APPS[item.mantleApp];
  const pin = pinById.get(item.id);
  const target = (pin && (pin.lnkPath || pin.target)) || a.windowsTarget;
  if (flags.test) {
    process.stdout.write(`mantle: launch dry run (--test): would open ${a.windowsName} (${target})\n`);
    return { ok: true, reason: `dry run: would open ${a.windowsName} (${target})`, action: 'dry-run', dryRun: true };
  }
  try {
    if (/^ms-settings:/i.test(target)) await shell.openExternal(target);
    else {
      const err = await shell.openPath(String(target));
      if (err) return { ok: false, reason: `Windows would not open ${target}: ${err}` };
    }
    return { ok: true, reason: null, action: 'launched', path: String(target) };
  } catch (err) {
    return { ok: false, reason: `Windows would not open ${target}: ${err.message}` };
  }
}

async function launchItem(item, fresh) {
  if (item && item.mantleApp && mantleApps) return openMantleApp(item, item.kind === 'pinned' ? 'the pinned icon' : 'the bar');
  const pin = pinById.get(item.id);
  const lnk = pin && (pin.lnkPath || pin.target || pin.exe);
  const aumid = (pin && pin.aumid) || item.aumid || null;
  const again = fresh ? ' another copy of' : '';

  /* The Win32 Spotify, NOT running: start it with Up next's port and HIDDEN (spothide lane,
     2026-09-26: Spotify's --minimized, then its own window service hides it), the way the card does
     (lib/spotify-launch.js, 2026-09-25). Anything else, or a Spotify already running (bring it forward,
     never restart it), falls through to the launch below unchanged. --test only says what it would do. */
  if (lnk || aumid) {
    const sp = await spotifyLaunch.launchSpotifyWithPort(
      pin ? { exe: pin.exe, target: pin.target, args: pin.args, lnkPath: pin.lnkPath, aumid } : { aumid },
      { dryRun: !!flags.test, enabled: spotifyQueueOn(), source: pin ? 'the pinned icon' : 'the bar' });
    if (sp.handled) {
      process.stdout.write(`mantle: launch ${item.name}: ${sp.dryRun ? `${sp.reason} (--test)` : `started ${sp.path} ${sp.args.join(' ')}, pid ${sp.pid}; ${sp.hide}`}\n`);
      return sp.dryRun
        ? { ok: true, reason: sp.reason, action: 'dry-run', dryRun: true }
        : { ok: true, reason: null, action: 'launched', path: sp.path };
    }
    if (sp.why) process.stdout.write(`mantle: launch ${item.name}: ${sp.why}\n`);
  }

  // --test: a pinned icon clicked in a test bar starts nothing (osd2 lane, 2026-09-24).
  if (flags.test && (lnk || aumid)) {
    const what = lnk ? `open ${lnk}` : `start shell:AppsFolder\\${aumid}`;
    process.stdout.write(`mantle: launch dry run (--test): would${again} ${what} for ${item.name}\n`);
    return { ok: true, reason: `dry run: would${again} ${what}`, action: 'dry-run', dryRun: true };
  }

  if (lnk) {
    try {
      const err = await shell.openPath(String(lnk));
      if (err) return { ok: false, reason: `Windows would not start${again} ${item.name} from ${lnk}: ${err}` };
      return { ok: true, reason: null, action: 'launched', path: String(lnk) };
    } catch (err) {
      return { ok: false, reason: `Windows would not start${again} ${item.name} from ${lnk}: ${err.message}` };
    }
  }

  if (aumid) {
    try {
      // The sidecar starts it, so it needs the click's foreground right to pass on to the new app
      // (else a Store app such as Terminal opens behind the window Owen was in). lib/fg-grant.js.
      fgGrant.grant(sidecar.info && sidecar.info.pid);
      const r = await sidecar.call('launch', { aumid }, 8000);
      if (r && r.ok === false) {
        return { ok: false, reason: `Windows would not start${again} ${item.name}: ${r.reason || 'the sidecar did not say why'}` };
      }
      return { ok: true, reason: null, action: 'launched', aumid };
    } catch (err) {
      return {
        ok: false,
        reason: Sidecar.isOldExeError(err)
          ? `${item.name} is a Store app with no shortcut file, and the sidecar exe has no "launch" command yet: run npm run build:sidecar`
          : `Windows would not start${again} ${item.name} (${aumid}): ${err.message}`,
      };
    }
  }

  return {
    ok: false,
    reason: `${item.name} is not running and Mantle has nothing to start it from -- no shortcut and no app id (it is a running-apps entry, not a pin)`,
  };
}

/** Watch Windows' pinned-shortcuts folder through lane C's module, if it is there. */
function startPinWatch() {
  if (!pinnedModule || typeof pinnedModule.watchPins !== 'function') {
    process.stdout.write(`mantle: the pinned shortcuts are not being watched: ${pinnedModule ? 'lib/pinned.js exports no watchPins()' : pinnedModuleReason}\n`);
    return;
  }
  try {
    unwatchPins = pinnedModule.watchPins(() => { pinsCache = null; schedulePinnedPush('the pinned shortcuts changed'); });
  } catch (err) {
    process.stderr.write(`mantle: the pinned shortcuts could not be watched, so a new pin only appears when the window list changes: ${err.message}\n`);
  }
}

/*
 * QUICK SETTINGS: the right-hand cluster, done as Mantle's own panel.
 *
 * Owen: "these buttons need to go to a wrapper version of where they used to go
 * ... some of them just go to settings now". Clicking volume or Wi-Fi should
 * change volume or Wi-Fi, not dump him in the Windows Settings app -- so every
 * control is read and written here, through the sidecar, and the Settings app is
 * not in the path at all.
 *
 * EVERY PART IS ASKED INDEPENDENTLY (Promise.allSettled). A machine with no
 * Bluetooth radio, or a sidecar too old to know `nightlight`, must still show a
 * working volume slider: one dead part carries its own ok:false and its own
 * reason, and sinks nothing else. That is the whole shape of this reply.
 */
const QS_PARTS = [
  ['volume', 'volume', 'the volume'],
  ['wifi', 'wifi', 'Wi-Fi'],
  ['bluetooth', 'bluetooth', 'Bluetooth'],
  ['brightness', 'brightness', 'the screen brightness'],
  ['nightlight', 'nightlight', 'Night light'],
  ['power', 'power', 'the battery'],
];

/** One part, never throwing: a refusal becomes {ok:false, reason}.
 *
 * The sidecar's OWN ok/reason win whenever it gave them (2026-09-23). This used to force ok:true
 * and reason:null over every answer, so a part the sidecar was still reading for the first time
 * (QuickSettings.Pending: ok:false, pending:true, placeholder values and a reason) was drawn as a
 * real reading -- Wi-Fi "Off" in the seconds after a start -- and its reason never reached the
 * panel. A bare answer with no ok (volume's {level, muted}) is a reading, so it is ok. */
function qsNormalize(r, label) {
  if (!r || typeof r !== 'object') return { ok: false, reason: `${label} cannot be read: the sidecar answered with nothing` };
  const part = Object.assign({ ok: true, reason: null }, r);
  delete part.read;
  if (part.ok === false && !part.reason) part.reason = `${label} cannot be read, and the sidecar gave no reason`;
  return part;
}

async function qsPart(cmd, label, args) {
  try {
    return qsNormalize(await sidecar.call(cmd, args || {}, 4000), label);
  } catch (err) {
    return {
      ok: false,
      reason: Sidecar.isOldExeError(err)
        ? `${label} cannot be read: the sidecar exe has no "${cmd}" command yet, so run npm run build:sidecar`
        : `${label} cannot be read: ${err.message}`,
    };
  }
}

/** The whole panel from its parts. The panel is worth opening if the two things it is mostly
 * for answered; anything else missing is a control that draws itself disabled with a reason. */
function qsCompose(parts) {
  const out = { ok: false, reason: null };
  const dead = [];
  for (const [key, , label] of QS_PARTS) {
    out[key] = (parts && parts[key]) || { ok: false, pending: true, reason: `${label} has not been read yet` };
    if (!out[key].ok) dead.push(out[key].reason);
  }
  out.ok = !!(out.volume.ok && out.power.ok);
  out.reason = dead.length ? dead.join('; ') : null;
  return out;
}

async function qsRead() {
  const startedAt = Date.now();
  const results = await Promise.allSettled(QS_PARTS.map(([, cmd, label]) => qsPart(cmd, label)));
  results.forEach((res, i) => {
    const key = QS_PARTS[i][0];
    const label = QS_PARTS[i][2];
    // allSettled cannot reject here (qsPart swallows), but a thrown TypeError
    // inside it would still land as `rejected` rather than as a missing key.
    const part = res.status === 'fulfilled'
      ? res.value
      : { ok: false, reason: `${label} cannot be read: ${(res.reason && res.reason.message) || res.reason}` };
    if (key === 'volume') volumeStore(part, 'a full quick-settings read', startedAt);
    else qsStore(key, part, startedAt);
  });
  return qsCompose(qsLatest);
}

/*
 * WHAT MAIN KNOWS, PUSHED (qsx lane, 2026-09-23). Owen, live on 1c6afe3: "you need to make the
 * Internet thing and volume and brightness and all that stuff over there actually work and be
 * way more responsive". main used to learn about the panel by re-reading all six parts every 2 s
 * while it was open - 2 to 5 s behind a brightness key, and blind while it was closed. Now:
 *   volume     the sidecar's CoreAudio listener pushes {ev:'volume'} on every change, always
 *   network    {ev:'net'} for the readout, always (event-first; re-checked every 5 s, 1 s while
 *              the panel is open)
 *   the rest   {ev:'qs', part, state} from the sidecar's own watch while the panel is open (a
 *              lease main renews), so a change made anywhere shows within about a second
 * qs.get answers from qsLatest at once, so the panel opens on its last picture and the watch
 * fills it in (all six parts within 0.1-0.7 s of opening, measured). A qs.set's reply IS its
 * read-back. The old 2 s full re-read remains only for a sidecar too old to watch.
 */
let qsLatest = null;                    // part -> its state as qs.get shows it
const qsPartAt = Object.create(null);   // part -> when the answer held was asked for
let qsBroadcastTimer = null;

/** Keep a part's newest state. `at` is when it was ASKED FOR: a full read that started before a
 * push arrived is older than the push, however late it lands, and does not overwrite it. */
function qsStore(key, state, at) {
  if (!state || typeof state !== 'object') return false;
  if (qsPartAt[key] && at < qsPartAt[key]) return false;
  qsPartAt[key] = at;
  qsLatest = Object.assign({}, qsLatest || {}, { [key]: state });
  // The open panel hears it in the same frame; a closed one gets the whole picture from qs.get.
  if (qsWatching && !qsBroadcastTimer) {
    qsBroadcastTimer = setTimeout(() => { qsBroadcastTimer = null; broadcast('qs', qsCompose(qsLatest)); }, 8);
  }
  return true;
}

/* The speaker glyph's reading ('volume', replayed on subscribe) and the panel's volume part are
 * one value: every source of it - the CoreAudio push, the panel's watch, a set's read-back, a
 * full read - lands here. */
let lastVolume = null;

function volumeStore(part, why, at) {
  if (!part || typeof part !== 'object') return;
  const v = {
    ok: part.ok !== false && typeof part.level === 'number',
    level: typeof part.level === 'number' ? part.level : null,
    muted: !!part.muted,
    reason: null,
  };
  if (!v.ok) v.reason = part.reason || 'the volume reading came back without a level, and no reason';
  if (!qsStore('volume', Object.assign({}, v), at || Date.now())) return;
  const changed = !lastVolume || lastVolume.ok !== v.ok || lastVolume.level !== v.level ||
    lastVolume.muted !== v.muted || lastVolume.reason !== v.reason;
  lastVolume = v;
  if (!changed) return;
  if (!v.ok) process.stdout.write(`mantle: volume: ${v.reason} (${why})\n`);
  broadcast('volume', v);
}

/** part -> how to validate it, what to send, and which value of the read-back part it set.
 *
 * LEVELS ARE WHOLE PERCENTAGES, 0 to 100, the sidecar's own scale. Until 2026-09-23 the panel's
 * sliders sent 0-1 fractions (bar.js divided by 100 before calling), these checks let 0.42
 * through, and the sidecar rounded it to 0: dragging Volume or Brightness in the panel set
 * Windows to 0 or 1 %. A fraction is now refused WITH that reason instead of rounding silently. */
const QS_LEVEL = (what) => (v) => (Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 100
  ? null
  : `${what} must be a whole number from 0 to 100` + (Number(v) > 0 && Number(v) < 1 ? ` (${v} looks like a 0-1 fraction)` : ''));
const QS_WRITE = {
  volume: {
    key: 'volume',
    cmd: 'volume',
    label: 'the volume',
    args: (v) => ({ level: Number(v) }),
    check: QS_LEVEL('volume'),
    read: (p) => p.level,
  },
  mute: {
    key: 'volume',
    cmd: 'volume',
    label: 'mute',
    args: (v) => ({ muted: !!v }),
    check: (v) => (typeof v === 'boolean' ? null : 'mute must be true or false'),
    read: (p) => !!p.muted,
  },
  wifi: {
    key: 'wifi',
    cmd: 'wifi',
    label: 'Wi-Fi',
    args: (v) => ({ on: !!v }),
    check: (v) => (typeof v === 'boolean' ? null : 'wifi must be true or false'),
    read: (p) => !!p.on,
  },
  bluetooth: {
    key: 'bluetooth',
    cmd: 'bluetooth',
    label: 'Bluetooth',
    args: (v) => ({ on: !!v }),
    check: (v) => (typeof v === 'boolean' ? null : 'bluetooth must be true or false'),
    read: (p) => !!p.on,
  },
  brightness: {
    key: 'brightness',
    cmd: 'brightness',
    label: 'the screen brightness',
    args: (v) => ({ level: Number(v) }),
    check: QS_LEVEL('brightness'),
    read: (p) => p.level,
  },
  // A switch since 2026-09-23 (Display.SetNightLight); the tile did nothing before.
  nightlight: {
    key: 'nightlight',
    cmd: 'nightlight',
    label: 'Night light',
    args: (v) => ({ on: !!v }),
    check: (v) => (typeof v === 'boolean' ? null : 'nightlight must be true or false'),
    read: (p) => !!p.on,
  },
};

// The watch: one, ever, while the panel is open. The sidecar's own (qswatch) pushes each part
// as it changes; main holds a lease on it, renewed every QS_RENEW_MS, so a main that dies or
// forgets costs the sidecar at most QS_LEASE_MS of reads. Only a sidecar that cannot watch
// gets the old full re-read every QS_WATCH_MS instead.
let qsTimer = null;                // the fallback poll's timer
let qsWatching = false;
let qsPolling = false;
let qsLeaseTimer = null;
let qsWatchVia = null;             // 'push' | 'poll' | null, for qs.watch's reply and the log
const QS_WATCH_MS = 2000;
const QS_LEASE_MS = 60000;
const QS_RENEW_MS = 20000;
// More than one page can hold the watch (lane settings, 2026-09-28): the bar's quick-settings panel
// (no `who`: held until it lets go, exactly as before) and Mantle Settings (who:'settings', which must
// re-assert within QS_HOLD_MS or is dropped, so a window that closed without letting go cannot keep
// the sidecar watching). It stops only when nobody holds it: one page closing never stops the other's
// live values.
const QS_HOLD_MS = 90000;
const qsHolders = new Map();          // who -> expires at (Infinity for the panel)
function qsHoldersPrune() { const t = Date.now(); for (const [k, v] of qsHolders) if (v <= t) qsHolders.delete(k); }

/** A full re-read, broadcast to an open panel. */
function qsPush(why) {
  return qsRead().then((snap) => {
    if (!qsWatching) broadcast('qs', snap);      // an open panel already had it from qsStore
    return snap;
  }).catch((err) => {
    process.stderr.write(`mantle: the quick-settings push (${why}) threw: ${err.message}\n`);
    return null;
  });
}

/** The fallback: the full re-read every QS_WATCH_MS. The guard is `qsPolling`, NOT `qsTimer`:
 * the timer is null for as long as a push is in flight, so a second start in that window used to
 * begin a SECOND chain (caught by the harness, 2026-09-21). */
function qsPollStart() {
  if (qsPolling) return;
  const tick = () => {
    qsTimer = null;
    qsPush('the quick-settings panel is open').then(() => {
      if (!shuttingDown && qsWatching && qsPolling) {
        qsTimer = setTimeout(tick, QS_WATCH_MS);
        if (qsTimer.unref) qsTimer.unref();
      }
    });
  };
  qsPolling = true;
  tick();
}

function qsPollStop() {
  qsPolling = false;
  if (qsTimer) clearTimeout(qsTimer);
  qsTimer = null;
}

/** Start or renew the sidecar's watch (and the network readout's 1 s re-check). */
function qsLease(why) {
  if (!qsWatching || shuttingDown) return;
  qsHoldersPrune();
  if (!qsHolders.size) { qsWatchStop('every page that asked for it has gone'); return; }
  if (qsLeaseTimer) clearTimeout(qsLeaseTimer);
  qsLeaseTimer = setTimeout(() => { qsLeaseTimer = null; qsLease('the lease is renewed'); }, QS_RENEW_MS);
  if (qsLeaseTimer.unref) qsLeaseTimer.unref();
  sidecar.call('qswatch', { on: true, leaseMs: QS_LEASE_MS }, 4000).then((r) => {
    if (!qsWatching) return;
    if (qsWatchVia !== 'push') process.stdout.write(`mantle: quick settings: the sidecar pushes each change (${why})\n`);
    qsWatchVia = 'push';
    qsPollStop();
  }, (err) => {
    if (!qsWatching) return;
    const reason = Sidecar.isOldExeError(err)
      ? 'the sidecar exe has no quick-settings watch yet (run npm run build:sidecar)'
      : `the sidecar's quick-settings watch did not start: ${err.message}`;
    if (qsWatchVia !== 'poll') process.stdout.write(`mantle: quick settings: ${reason}, so the panel re-reads every ${QS_WATCH_MS / 1000} s instead\n`);
    qsWatchVia = 'poll';
    qsPollStart();
  });
  sidecar.call('net', { op: 'watch', on: true, fast: true }, 4000).catch(() => { /* the readout says so itself */ });
}

function qsWatchStart() {
  if (qsWatching) return false;      // already watching: not an error, just nothing to do
  qsWatching = true;
  qsLease('the panel opened');
  return true;
}

function qsWatchStop(why) {
  qsHolders.clear();                 // main stopped it (bar hiding, shutdown, last holder gone): pages re-assert
  if (!qsWatching && !qsTimer) return false;
  qsWatching = false;
  qsPollStop();
  if (qsLeaseTimer) clearTimeout(qsLeaseTimer);
  qsLeaseTimer = null;
  qsWatchVia = null;
  sidecar.call('qswatch', { on: false }, 4000).catch(() => { /* the lease runs out by itself */ });
  sidecar.call('net', { op: 'watch', on: true, fast: false }, 4000).catch(() => { /* the readout says so itself */ });
  process.stdout.write(`mantle: quick-settings watch off: ${why}\n`);
  return true;
}

sidecar.on('qs', (ev) => {
  if (!ev) return;
  if (!ev.part) {
    // The sidecar's watch died (it says why). NO SILENT FAILURES: the log says so, and an open
    // panel keeps updating through the old re-read.
    process.stdout.write(`mantle: quick settings: ${ev.reason || 'the sidecar\'s watch stopped without a reason'}; the panel re-reads every ${QS_WATCH_MS / 1000} s instead\n`);
    qsWatchVia = 'poll';
    if (qsWatching) qsPollStart();
    return;
  }
  const spec = QS_PARTS.find(([key]) => key === ev.part);
  if (!spec) return;
  const state = qsNormalize(ev.state, spec[2]);
  if (ev.part === 'volume') volumeStore(state, 'the panel\'s watch');
  else qsStore(ev.part, state, Date.now());
});

// The speaker glyph, live whether or not the panel is open (VolumeWatch.cs).
sidecar.on('volume', (ev) => {
  if (!ev) return;
  if (ev.ok === false) {
    // The listener failed, not the volume: say so, and read it the ordinary way.
    process.stdout.write(`mantle: volume watch: ${ev.reason || 'failed without a reason'}; the glyph updates when the panel opens\n`);
    qsPart('volume', 'the volume').then((p) => volumeStore(p, 'a read after the volume watch failed'));
    return;
  }
  volumeStore(ev, `the volume changed (${ev.via || 'no reason given'})`);
});

/*
 * THE NETWORK READOUT (qsx lane, 2026-09-23): the glyph beside the volume was a fixed Wi-Fi
 * drawing in index.html, full bars with the radio off, on Ethernet, or with no internet. The
 * sidecar's watch (NetState.cs) pushes {ev:'net'} whenever what the readout shows changes; pages
 * get 'net' (replayed on subscribe) and net.get answers the latest.
 */
let lastNet = null;

function netShown(r) {
  if (!r) return 'none';
  const w = r.wifi || {};
  const bars = typeof w.signal === 'number' && w.signal > 0 ? Math.min(4, Math.ceil(w.signal / 25)) : 0;
  return [r.ok, r.state, r.kind, r.internet, r.adapter, w.on, w.connected, w.ssid, bars, r.reason].join('|');
}

function netPush(r, why) {
  if (!r || typeof r !== 'object') return;
  const next = Object.assign({}, r);
  delete next.ev;
  delete next.id;
  const changed = netShown(next) !== netShown(lastNet);
  lastNet = next;
  if (!changed) return;
  if (next.ok === false) process.stdout.write(`mantle: network readout: ${next.reason || 'the reading failed without a reason'} (${why})\n`);
  broadcast('net', next);
}

function netFailure(err, what) {
  return {
    ok: false,
    state: 'unknown',
    reason: Sidecar.isOldExeError(err)
      ? 'the network state cannot be read: the sidecar exe has no "net" command yet, so run npm run build:sidecar'
      : `${what}: ${err.message}`,
  };
}

sidecar.on('net', (ev) => netPush(ev, `the network changed (${(ev && ev.via) || 'no reason given'})`));

/* The next push of a sidecar event, or null after ms. For a readout asked for before the sidecar
   is up: the bar's first volume.get and net.get land 2-8 s before the ready line on a loaded
   machine (measured 2026-09-23), and failing them put "cannot run volume/net: waiting for its
   ready line" on the readouts and two failure lines in the log on EVERY start - while the watches
   armed on 'ready' push the real readings 60-400 ms later anyway. Registered after main's own
   handlers, so the stores (lastVolume, lastNet) are already updated when this resolves. */
function sidecarNext(event, ms) {
  return new Promise((resolve) => {
    const onEv = () => { clearTimeout(timer); sidecar.removeListener(event, onEv); resolve(true); };
    const timer = setTimeout(() => { sidecar.removeListener(event, onEv); resolve(false); }, ms);
    if (timer.unref) timer.unref();
    sidecar.on(event, onEv);
  });
}

// Armed on EVERY sidecar start: a restarted sidecar has forgotten its watches.
// A failed arm is tried again (watchArmer, below): one timeout used to freeze the glyph until the next restart.
sidecar.on('ready', () => {
  armWatch('volume', () => sidecar.call('volwatch', { on: true }, 4000).then((r) => {
    if (r && r.ok === false) return r.reason || 'refused without a reason';
    return null;
  }, (err) => {
    if (!Sidecar.isOldExeError(err)) return err.message;
    process.stdout.write('mantle: volume watch not armed (the sidecar exe has no volwatch yet, run npm run build:sidecar); the glyph updates when the panel opens\n');
    return { final: true };
  }));
  armWatch('network', () => sidecar.call('net', { op: 'watch', on: true, fast: qsWatching }, 4000).then(() => null, (err) => {
    netPush(netFailure(err, 'the network readout is not being watched'), 'the watch could not be armed');
    return Sidecar.isOldExeError(err) ? { final: true } : err.message;
  }));
  if (qsWatching) qsLease('the sidecar restarted while the panel was open');
  // The first open of the panel should find a whole picture: the sidecar's own start-up read
  // (QuickSettings.WarmUp) lands at +1.5 s.
  const prime = setTimeout(() => { if (!shuttingDown) qsRead().catch(() => { /* each part says why */ }); }, 2500);
  if (prime.unref) prime.unref();
});

// A sidecar that is down reads nothing: the readout must not keep saying "connected".
sidecar.on('status', ({ status, reason }) => {
  if (status !== 'down' || shuttingDown || !lastNet || lastNet.ok === false) return;   // a quit is not news
  netPush({ ok: false, state: 'unknown', reason: `the network is not being read: ${reason}` }, 'the sidecar is down');
});

/*
 * QUICK SETTINGS, ONE LEVEL DOWN (qsx lane, 2026-09-23): the Wi-Fi network list,
 * the output-device picker and the volume mixer, so Owen never needs Windows' own
 * flyouts for them. The work is the sidecar's (sidecar/Wlan.cs, AudioMixer.cs);
 * these commands give every reply the same never-throwing {ok, reason} shape as
 * qs.get, and push a fresh qs snapshot after anything that moves a main-panel tile.
 *
 * Measured 2026-09-23 on Owen's machine: list 23-34 ms warm, a scan 3.6 s end to
 * end (Wlan.cs waits up to 6 s for Windows' scan-complete), a connect up to 25 s
 * for Windows' verdict, devices 4-5 ms, sessions 5-10 ms. Timeouts sit well past.
 */
const QS_MORE_MS = { list: 8000, scan: 15000, connect: 40000, disconnect: 15000, audio: 6000 };

async function qsMore(cmd, args, label, ms) {
  try {
    const r = await sidecar.call(cmd, args, ms);
    // Unlike qsPart, the sidecar's own ok/reason WIN: a list read with the radio
    // off is ok:true with its reason; a failed connect is ok:false in Windows' words.
    return Object.assign({ ok: true, reason: null }, r);
  } catch (err) {
    return {
      ok: false,
      reason: Sidecar.isOldExeError(err)
        ? `${label}: the sidecar exe has no "${cmd}" command yet, so run npm run build:sidecar`
        : `${label}: ${err.message}`,
    };
  }
}

/*
 * THE PAIRED BLUETOOTH DEVICES behind the Bluetooth tile's '>' (qsx lane,
 * 2026-09-23; the work is sidecar/BtDevices.cs). Measured on Owen's machine: a
 * list is 26 ms warm (radio 19, paired devices 18, batteries 15, sound routes
 * 12, partly overlapping), the watch's first push 0.3 s after it starts. A
 * connect waits up to 12 s for Windows to say it is connected (a disconnect up
 * to 8 s), so its timeout sits well past that. While the view is open the
 * sidecar's DeviceWatcher pushes {ev:'btdevices'}; main only relays it, and the
 * watch lapses on its own if the view stops renewing it.
 */
const QS_BT_MS = { list: 8000, watch: 6000, toggle: 25000 };

sidecar.on('btdevices', (ev) => broadcast('btdevices', ev));

async function qsBtToggle(op, a) {
  // "device", not "id": lib/sidecar.js refuses an argument named id (the protocol's own).
  const device = a && typeof a.device === 'string' ? a.device : '';
  if (!device) return { ok: false, op, reason: `qs.bt.${op} needs device: a row's id from qs.bt.list` };
  let r = await qsMore('btdevices', { op, device },
    `the Bluetooth device could not be ${op === 'connect' ? 'connected' : 'disconnected'}`, QS_BT_MS.toggle);
  // Security review #20: a failed connect's reason named the device ("Mantle is still connecting
  // <name>"), and a reason can reach the log. The row already shows which device it is.
  if (r && r.ok === false && typeof r.reason === 'string' && typeof r.name === 'string' && r.name.length > 1) r.reason = r.reason.split(r.name).join('the device');
  // The BUSY reply (BtDevices.cs Toggle: another toggle still running) carries NO name field but names
  // the OTHER device ("Mantle is still connecting <its name>; wait for it to finish"), so the split
  // above never saw it (security review 2).
  if (r && r.ok === false && typeof r.reason === 'string') r.reason = r.reason.replace(/^Mantle is still (connecting|disconnecting) [\s\S]+?; wait for it to finish$/, 'Mantle is still $1 another device; wait for it to finish');
  // A headset that connects usually becomes the sound output, so the main
  // panel's volume slider is repainted from a fresh read.
  if (qsWatching) qsPush(`a Bluetooth device ${r.ok ? (op === 'connect' ? 'connected' : 'disconnected') : 'did not ' + op}`);
  return r;
}

/*
 * THE WI-FI PASSWORD FIELD NEEDS THE KEYBOARD, AND THE BAR NEVER HAS IT. The bar
 * is focusable:false (lib/windows.js) so a click on it never takes focus from the
 * app Owen is in -- which also means a text field in it receives NO keys: they go
 * to whatever app is in front. A password typed there would land, keystroke by
 * keystroke, in that app. So the panel shows its password field only after
 * qs.keyboard {on:true} has read back barWin.isFocused() === true, and says why
 * when it cannot. {on:false} makes the bar unfocusable again and, if the bar still
 * holds focus (nothing else was clicked meanwhile), hands focus back to the window
 * that had it, through the same sidecar `focus` a taskbar click uses.
 * NOT verified live (2026-09-23): a test instance must never take focus, so this
 * path waits for Owen's go; see the qsx report's live-test steps.
 */
// <mainrel:qskbd> (lib/main-qskbd.test.js runs this region with a fake bar window and sidecar)
let qsKbPrev = null;       // the hwnd that was in front before the password field took the keyboard
let qsKbBlur = null;       // the bar's blur listener while it holds the keyboard

/* The bar lost focus on its own (Owen clicked another app, or a game took the
   screen): it goes back to focusable:false at once, and focus is NOT dragged back
   to the old window, because Owen went somewhere on purpose. */
function qsKbDisarm() {
  if (qsKbBlur && barWin && !barWin.isDestroyed()) barWin.removeListener('blur', qsKbBlur);
  qsKbBlur = null;
}

async function qsKeyboard(on) {
  if (!barWin || barWin.isDestroyed()) return { ok: false, focused: false, reason: 'the bar window is gone' };
  qsKbDisarm();
  if (on) {
    if (flags.test) {
      return { ok: false, focused: false, reason: 'a test instance never takes the keyboard from whoever is at the machine, so a password cannot be typed here' };
    }
    let note = null;
    try {
      const fg = await sidecar.call('foreground', {}, 1500);
      const h = fg && fg.hwnd ? String(fg.hwnd) : '';
      qsKbPrev = h && h !== '0' && h !== hwndOf(barWin) ? h : null;
    } catch (err) {
      qsKbPrev = null;
      note = `focus will not be handed back afterwards: the window in front could not be read (${err.message})`;
    }
    barWin.setFocusable(true);
    barWin.setSkipTaskbar(true);           // Electron's setFocusable(true) also un-skips the taskbar on Windows
    barWin.focus();
    barWin.webContents.focus();
    const focused = barWin.isFocused();
    if (!focused) {
      barWin.setFocusable(false);
      barWin.setSkipTaskbar(true);
      qsKbPrev = null;
      return { ok: false, focused: false, reason: 'Windows did not give the bar the keyboard (another window kept focus), so the password cannot be typed here' };
    }
    qsKbBlur = () => {
      qsKbDisarm();
      if (!barWin || barWin.isDestroyed()) return;
      barWin.setFocusable(false);
      barWin.setSkipTaskbar(true);
      qsKbPrev = null;
      process.stdout.write('mantle: the bar lost the keyboard (another window took focus); it is unfocusable again\n');
      // The page is told (audit #8): a password box left showing would look typeable while every
      // key went to the app in front. bar.js drops the field (qs-more.js keyboardLost) or closes
      // the pop-up whose box it was.
      broadcast('bar.keyboard.lost', { why: 'another window took focus' });
    };
    barWin.on('blur', qsKbBlur);
    return { ok: true, focused: true, note, reason: null };
  }
  const had = barWin.isFocused();
  barWin.setFocusable(false);
  barWin.setSkipTaskbar(true);
  const prev = qsKbPrev;
  qsKbPrev = null;
  if (!had || !prev) return { ok: true, focused: false, restored: null, reason: null };
  // The bar had the keyboard, so THIS process is the foreground one: hand that on (lib/fg-grant.js).
  const g = fgGrant.grant(sidecar.info && sidecar.info.pid);
  try {
    const r = await sidecar.call('focus', { hwnd: prev }, 4000);
    process.stdout.write(`mantle: qs.keyboard: focus went back (${fgGrant.howWords(r)}; right ${fgGrant.words(g)})\n`);
    return { ok: true, focused: false, restored: prev, reason: null };
  } catch (err) {
    const e = fgGrant.splitTried(err.message);
    process.stdout.write(`mantle: qs.keyboard: focus did not go back (right ${fgGrant.words(g)}${e.tried ? `; ${e.tried}` : ''})\n`);
    return { ok: false, focused: false, restored: null, reason: `the keyboard was released, but focus could not go back to the window that had it (${e.shown})` };
  }
}
// </mainrel:qskbd>

/*
 * NOW PLAYING (2026-09-22): the bar's media chip and card, over the sidecar's `media` command
 * (sidecar/Media.cs: get / control / watch, WinRT's system media sessions).
 *
 * EVENT-DRIVEN, NOT POLLED. The watch is armed once per sidecar start; the sidecar debounces
 * WinRT's change events into one {ev:"media", rev} line per burst, and only then does main ask
 * for the full picture (artwork is cached per track in the sidecar, so a repeat get is ~30 ms)
 * and push it to the bar. Nothing plays -> no events -> zero cost. TIMELINE-ONLY events (some
 * players republish their position every second) are skipped unless the media card is the open
 * popover: the chip shows no position, and the card ticks the bar locally from positionNowMs.
 * If the sidecar says its events could not be hooked, main falls back to a slow poll and the
 * card says so and why.
 *
 * WHICH SESSION the chip shows, in order: the one Owen picked in the card's source switcher
 * (until that session goes away), else Windows' current session, except that under the LessonPlayer
 * rule (flags.lessonplayerMediaControls, top of this file) any non-LessonPlayer session wins over an
 * LessonPlayer one, a playing one first, and an LessonPlayer lesson on its own shows no chip at all.
 *
 * CONTROL IS GUARDED HERE, not only in the page: media.control needs the target session's
 * AUMID (so a press can never land on whichever app happens to be current a moment later), and
 * under the LessonPlayer rule an LessonPlayer target is refused whatever the page asked. Measured:
 * control has never been exercised on a real session; a --test instance's sidecar is --passive
 * and refuses every control before it reaches WinRT.
 */
const MEDIA_POLL_MS = 10000;          // only when the sidecar could not hook the change events
const MEDIA_ACTIONS = new Set(['play', 'pause', 'toggle', 'next', 'previous', 'seek']);
const LESSONPLAYER_RE = /lessonplayer/i;
const LESSONPLAYER_GUARD_REASON = "LessonPlayer lesson · controls off so a stray click can't pause it";
const LESSONPLAYER_GUARD_HOW = 'Mantle was started with --lessonplayer-guard for a recording session; start it without that flag to allow them';
let lastMedia = null;       // the last payload pushed to the bar, for replay and the guard
let mediaPick = null;       // the pick Owen made in the card's switcher (lib/media-pick.js's shape), or null for automatic
let mediaPickDropped = null; // the last pick that timed out: said in the card until the next pick
let mediaPickTimer = null;  // a re-read when a held pick's grace runs out, so it drops on time
let mediaReading = null;    // the in-flight read, so a burst of triggers makes one read
let mediaAgain = false;     // a trigger arrived during that read: read once more after it
let mediaPollTimer = null;
const mediaListeners = new Set(); // features that read the sessions (ctx.host.onMedia: the top bar's full-screen video rule)

function sameAumid(a, b) { return !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase(); }

/** An LessonPlayer session, by AUMID (the Store app), app name, or title (its web player in a browser). */
function isLessonPlayer(s) {
  if (!s) return false;
  return LESSONPLAYER_RE.test(String(s.aumid || '')) ||
    LESSONPLAYER_RE.test(String((s.app && s.app.name) || '')) ||
    LESSONPLAYER_RE.test(String(s.title || ''));
}

function mediaGuardOn() { return !flags.lessonplayerMediaControls; }

/** Read the sessions and pick the one to show. Never throws: a failure is a payload with a reason. */
async function mediaRead() {
  const guard = mediaGuardOn()
    ? { on: true, reason: LESSONPLAYER_GUARD_REASON, how: LESSONPLAYER_GUARD_HOW }
    : { on: false, reason: 'LessonPlayer media controls are on (start Mantle with --lessonplayer-guard to turn them off while recording)', how: null };
  // `retry`: whether reading again can help (mediaPollArm). An old exe will never grow the command.
  const failed = (reason, retry) => ({ ok: false, present: false, reason, retry: retry !== false, rev: null, guard, sessions: [], shown: null, pick: null, events: false, eventsReason: null });
  const ask = async (extra) => {
    try {
      return await sidecar.call('media', Object.assign({ op: 'get', art: true }, extra || {}));
    } catch (err) {
      const old = Sidecar.isOldExeError(err);
      return {
        ok: false,
        old,
        reason: old
          ? 'this sidecar exe has no "media" command yet (run npm run build:sidecar)'
          : `the sessions could not be read: ${err.message}`,
      };
    }
  };
  const snap = await ask();
  if (!snap || snap.ok === false) return failed((snap && snap.reason) || 'the sidecar answered "media" with ok:false and gave no reason', !(snap && snap.old));

  const sessions = (Array.isArray(snap.sessions) ? snap.sessions : []).map((s) => ({
    aumid: s.aumid || null,
    app: s.app ? { name: s.app.name || null, icon: s.app.icon || null } : null,
    title: s.title || null,
    artist: s.artist || null,
    status: s.status || 'unknown',
    playing: !!s.playing,
    current: !!s.current,
    lessonplayer: isLessonPlayer(s),
  }));

  /* THE PICK IS STICKY (lane mediapick, 2026-09-25; lib/media-pick.js says how). Owen: "i press
     spotify but it keeps switching to accelus or automatic". The pick used to drop the instant
     its session was missing from ONE read, so a session blinking out put the card back on
     automatic for good. Now an absent pick is held for 60 s of continuous absence (by 'waiting',
     automatic shown meanwhile, said in the card) and applies again the moment it is back.
     Read and written in the same tick, with no await between: a media.select that lands during
     the sidecar read above is seen here, never overwritten by a stale pick. */
  const cur0 = snap.current ? Object.assign({}, snap.current, { lessonplayer: isLessonPlayer(snap.current) }) : null;
  const choice = MediaPick.choose({ pick: mediaPick, sessions, current: cur0, guardOn: mediaGuardOn(), now: Date.now() });
  mediaPick = choice.pick;
  if (choice.dropped) {
    mediaPickDropped = choice.dropped;
    process.stdout.write(`mantle: media pick dropped: ${choice.dropped.reason}\n`);
  }
  mediaPickArm(choice.waiting);
  const pickNote = (p) => Object.assign(p, choice.waiting ? { waiting: choice.waiting, reason: choice.waiting.reason } : {},
    choice.auto ? { auto: choice.auto } : {}, !mediaPick && mediaPickDropped ? { dropped: mediaPickDropped } : {});

  /* LESSONPLAYER ALONE = NO CHIP (Owen's call, 2026-09-22). With the rule on and nothing but an
     LessonPlayer lesson publishing a session, the bar shows no now-playing chip at all: a chip that
     can only ever say "LessonPlayer · Student" and offer nothing is noise over every lesson. With a
     player alongside it, the chip shows the player (below), and the card's source switcher still
     lets Owen pick the lesson, which then shows with its controls off. A pick of the lesson does
     not outlive the player: once LessonPlayer is alone again, this wins (lib/media-pick.js drops it).
     A pick of a PLAYER survives this (2026-09-25): the player blinking out for a moment is not
     Owen changing his mind. Not a failure: ok stays true, and the reason says what happened for
     anyone reading the payload. */
  if (choice.lessonplayerOnly) {
    return {
      ok: true,
      present: true,
      reason: 'only an LessonPlayer lesson has a media session, so the now-playing chip stays hidden (the LessonPlayer rule)',
      rev: snap.rev === undefined ? null : snap.rev,
      guard,
      sessions,
      shown: null,
      pick: pickNote({ aumid: null, by: 'lessonplayer-only' }),
      events: snap.events !== false,
      eventsReason: snap.eventsReason || null,
    };
  }

  /* Which session to show, and why: 'you' (the pick), 'waiting' (the pick's session is away,
     `auto` says which rule chose what shows meanwhile), 'current', 'lessonplayer-rule' or 'first'.
     The card says each out loud. */
  const want = choice.want;
  const by = choice.by;

  let shown = snap.current || null;
  let shownReason = null;
  if (want && !(shown && sameAumid(shown.aumid, want))) {
    const s2 = await ask({ aumid: want });
    if (s2 && s2.ok !== false && s2.session) shown = s2.session;
    else shownReason = (s2 && (s2.sessionReason || s2.reason)) || `the session from ${want} could not be read`;
  }
  if (shown) {
    shown = Object.assign({}, shown, { lessonplayer: isLessonPlayer(shown) });
    shown.controls = shown.lessonplayer && mediaGuardOn()
      ? { ok: false, reason: LESSONPLAYER_GUARD_REASON, how: LESSONPLAYER_GUARD_HOW }
      : { ok: true, reason: null, how: null };
  }
  return {
    ok: true,
    present: !!snap.present,
    reason: snap.reason || shownReason || null,
    rev: snap.rev === undefined ? null : snap.rev,
    guard,
    sessions,
    shown,
    pick: shown ? pickNote({ aumid: shown.aumid, by }) : null,
    events: snap.events !== false,
    eventsReason: snap.eventsReason || null,
  };
}

/* A held pick drops after its grace even when nothing else changes: a gone session sends no
   more events, so without this re-read the card would say "waiting" for ever. */
function mediaPickArm(waiting) {
  if (mediaPickTimer) { clearTimeout(mediaPickTimer); mediaPickTimer = null; }
  if (!waiting || shuttingDown) return;
  mediaPickTimer = setTimeout(() => {
    mediaPickTimer = null;
    mediaPush(`the picked source (${waiting.name || waiting.aumid}) may have used up its ${Math.round(waiting.graceMs / 1000)} s grace`);
  }, waiting.leftMs + 250);
  if (mediaPickTimer.unref) mediaPickTimer.unref();
}

/** Read and push to the bar. Coalesces: triggers during a read cause exactly one more read. */
function mediaPush(why) {
  if (mediaReading) { mediaAgain = true; return mediaReading; }
  mediaReading = (async () => {
    try {
      do {
        mediaAgain = false;
        const payload = await mediaRead();
        payload.why = why;
        lastMedia = payload;
        broadcast('media', payload);
        for (const fn of mediaListeners) { try { fn(payload); } catch (err) { process.stderr.write(`mantle: a media listener threw: ${err && err.message ? err.message : err}\n`); } }
        mediaPollArm(payload);
      } while (mediaAgain && !shuttingDown);
    } catch (err) {
      process.stderr.write(`mantle: the media push (${why}) threw: ${err && err.stack ? err.stack : err}\n`);
    } finally {
      mediaReading = null;
    }
    return lastMedia;
  })();
  return mediaReading;
}

/* The fallback poll runs ONLY while the sidecar says its change events are not hooked -- or,
   every MEDIA_RETRY_MS, while the last read FAILED in a way a retry can fix (2026-09-22). A
   test run on a loaded machine had its one read time out ("did not answer media within 8s")
   and nothing ever asked again: a paused session sends no events, so the chip stayed off for
   the run's whole life. Change events cannot rescue a read that never happened. */
const MEDIA_RETRY_MS = 5000;
function mediaPollArm(payload) {
  const failedRead = !!(payload && payload.ok === false && payload.retry !== false);
  const need = failedRead || !!(payload && payload.ok && payload.events === false);
  if (!need) {
    if (mediaPollTimer) { clearTimeout(mediaPollTimer); mediaPollTimer = null; }
    return;
  }
  if (mediaPollTimer || shuttingDown) return;
  mediaPollTimer = setTimeout(() => {
    mediaPollTimer = null;
    mediaPush(failedRead ? 'a retry after a failed media read' : 'the slow media poll (no change events)');
  }, failedRead ? MEDIA_RETRY_MS : MEDIA_POLL_MS);
  if (mediaPollTimer.unref) mediaPollTimer.unref();
}

// Armed on EVERY sidecar start: a restarted sidecar has forgotten the watch.
sidecar.on('ready', () => {
  armWatch('media', () => sidecar.call('media', { op: 'watch', on: true }).then((r) => {
    // A refusal is the sidecar's own verdict (no media API here) and the poll covers it: not retried.
    if (r && r.ok === false) process.stdout.write(`mantle: media watch: ${r.reason || 'refused without a reason'}; the bar polls instead\n`);
    mediaPush('the sidecar is ready');
    return null;
  }, (err) => {
    // The old exe has no media command: say so once in the log; the payload carries it to the bar.
    if (Sidecar.isOldExeError(err)) process.stdout.write(`mantle: media watch not armed: ${err.message}\n`);
    mediaPush('the sidecar is ready (no media watch)');
    return Sidecar.isOldExeError(err) ? { final: true } : err.message;
  }));
});

sidecar.on('media', (ev) => {
  if (lastMedia && ev && ev.rev !== undefined && ev.rev === lastMedia.rev) return;
  const reasons = Array.isArray(ev && ev.reasons) ? ev.reasons : [];
  const timelineOnly = reasons.length > 0 && reasons.every((r) => r === 'timeline');
  if (timelineOnly && !(barPopover && barPopover.key === 'media')) return;
  mediaPush(`media changed (${reasons.join(', ') || 'no reason given'})`);
});

// ---------------------------------------------------------------------------
// The battery (2026-09-23).
//
// Owen: "there are problems with it showing how charged my computer is". The
// readout was lib/sys-stats.js's PowerShell + Win32_Battery, asked on the bar's
// clock tick through a 60 s cache: 71 % where Windows said 72, a bolt for any
// laptop on AC, up to a minute behind a plug or unplug, and gone for the whole
// session after one slow PowerShell start. Now it is the sidecar's reading
// (sidecar/Battery.cs: GetSystemPowerStatus, the number Windows shows), and it
// is PUSHED: the watch is armed on every sidecar start, and the sidecar sends
// {ev:'battery'} whenever something shown changes. Pages get 'battery'
// (replayed on subscribe); sys.stats reads the same reading.
// ---------------------------------------------------------------------------
let lastBattery = null;        // the last reading pushed, for replay, sys.stats and the dedupe

/** The fields a page shows, as one string: a reading that changes none of them is not re-sent. */
function batteryShown(r) {
  if (!r) return 'none';
  return [r.ok, r.present, r.percent, r.ac, r.charging, r.saver, r.minutesLeft, r.reason].join('|');
}

function batteryPush(r, why) {
  if (!r || typeof r !== 'object') return;
  const next = Object.assign({}, r);
  delete next.ev;
  delete next.id;
  const changed = batteryShown(next) !== batteryShown(lastBattery);
  lastBattery = next;
  if (!changed) return;
  if (next.ok === false) process.stdout.write(`mantle: battery: ${next.reason || 'the reading failed without a reason'} (${why})\n`);
  broadcast('battery', next);
}

/** A fresh reading that never throws: a failure comes back as {ok:false, reason}. */
async function batteryRead() {
  try {
    return await sidecar.call('battery', {}, 3000);
  } catch (err) {
    return {
      ok: false,
      reason: Sidecar.isOldExeError(err)
        ? 'the battery cannot be read: the sidecar exe has no "battery" command yet, so run npm run build:sidecar'
        : `the battery cannot be read: ${err.message}`,
    };
  }
}

/** What battery.get and sys.stats answer: the pushed reading, or a fresh one before the first push. */
async function batteryLatest() {
  if (lastBattery) return lastBattery;
  const r = await batteryRead();
  batteryPush(r, 'the first read');
  return r;
}

// Armed on EVERY sidecar start: a restarted sidecar has forgotten the watch.
sidecar.on('ready', () => {
  armWatch('battery', () => sidecar.call('battery', { watch: true }, 4000).then((r) => {
    if (r && r.watchReason) process.stdout.write(`mantle: battery watch: ${r.watchReason}\n`);
    batteryPush(r, 'the sidecar is ready');
    return null;
  }, (err) => {
    batteryPush({
      ok: false,
      reason: Sidecar.isOldExeError(err)
        ? 'the battery cannot be read: the sidecar exe has no "battery" command yet, so run npm run build:sidecar'
        : `the battery watch could not start: ${err.message}`,
    }, 'the watch could not be armed');
    return Sidecar.isOldExeError(err) ? { final: true } : err.message;
  }));
});

sidecar.on('battery', (ev) => {
  // via:'recheck' is the sidecar's 30 s backstop finding a change. Windows' first time-left
  // estimate after an unplug has no notification of its own, so that one only ever arrives this
  // way (measured on a real unplug 2026-09-23: the unplug came via 'status' in the same second,
  // the estimate 32 s later via 'recheck'). Anything ELSE it catches is a change Windows did not
  // announce, and that line is the measurement of whether the backstop is needed for more.
  if (ev && ev.via === 'recheck' && lastBattery) {
    const bare = (r) => batteryShown(Object.assign({}, r, { minutesLeft: null, reason: null }));
    if (bare(ev) !== bare(lastBattery)) {
      process.stdout.write(`mantle: battery: the 30 s re-check caught a change no notification announced (was ${batteryShown(lastBattery)}, now ${batteryShown(ev)})\n`);
    }
  }
  batteryPush(ev, `the battery changed (${(ev && ev.via) || 'no reason given'})`);
});

// A sidecar that is down reads nothing: the readout must not keep a number nobody is vouching for.
sidecar.on('status', ({ status, reason }) => {
  if (status !== 'down' || !lastBattery || lastBattery.ok === false || lastBattery.present === false) return;
  batteryPush({ ok: false, present: lastBattery.present, reason: `the battery is not being read: ${reason}` }, 'the sidecar is down');
});

/*
 * SELF-HEALING READOUTS (lane mn-recover, 2026-10-12; audit #10). A real OS re-reads its state after
 * any gap. Three gaps used to leave the speaker, network and battery glyphs, the media chip and the
 * window list on old values with no reason shown:
 *   - an arm that failed once (a timeout on a busy start) was never tried again. makeWatchArmer re-runs
 *     it at 2, 5, 15 and 60 s, then stops and says so; every new sidecar process starts it over;
 *   - a wake or an unlock re-read nothing from the sidecar. Now every watch is armed again (each arm is
 *     idempotent in the sidecar: VolumeWatch.Set answers started:false when it already runs) and every
 *     readout is read again, 3 s after (devices are still coming back) and once more 20 s after;
 *   - a restarted sidecar (a crash, or lib/sidecar.js's liveness check ending a frozen one) was trusted
 *     to push everything anew. Now the same re-read runs 2.5 s after its ready line.
 * While the sidecar is down the speaker glyph and the media chip say so (network and battery already did).
 */
// <mainrel:rearm> (lib/main-recover.test.js runs this region with a fake clock)
function makeWatchArmer(o) {
  const watches = new Map();   // name -> { arm, tries, timer, run }
  // arm() resolves null (armed), { final: true } (this exe can never do it: the arm said why), or a
  // reason to try again. A throw or a rejection is a reason too.
  function attempt(name, w, run) {
    let p;
    try { p = Promise.resolve(w.arm()); } catch (e) { p = Promise.reject(e); }
    return p.then((res) => res, (e) => (e && e.message) || String(e)).then((res) => {
      if (w.run !== run) return 'stale';           // armed again since (a new sidecar, a wake): that run decides
      if (res === null || res === undefined || res === true) {
        if (w.tries) o.say(`mantle: the ${name} watch is armed (it took ${w.tries + 1} tries)\n`);
        w.tries = 0;
        return 'armed';
      }
      if (typeof res === 'object' && res.final) { w.tries = 0; return 'final'; }
      const why = typeof res === 'string' && res ? res : 'it did not say why';
      if (o.blocked()) { w.tries = 0; return 'blocked'; }   // down or quitting: the next ready arms it again
      if (w.tries >= o.delays.length) {
        o.say(`mantle: the ${name} watch could not be armed after ${w.tries + 1} tries (${why}); it is tried again when the sidecar restarts or the PC wakes\n`);
        w.tries = 0;
        return 'gave-up';
      }
      const delay = o.delays[w.tries];
      w.tries += 1;
      o.say(`mantle: the ${name} watch did not arm (${why}); trying again in ${Math.round(delay / 1000)} s (retry ${w.tries} of ${o.delays.length})\n`);
      w.timer = o.later(() => { w.timer = null; if (w.run === run) attempt(name, w, run); }, delay);
      return 'retry';
    });
  }
  const api = {
    /** (Re)start one watch with a fresh ladder; a retry still waiting from an older start is dropped. */
    arm(name, fn) {
      let w = watches.get(name);
      if (!w) { w = { arm: fn, tries: 0, timer: null, run: 0 }; watches.set(name, w); }
      if (typeof fn === 'function') w.arm = fn;
      if (w.timer) { o.cancel(w.timer); w.timer = null; }
      w.tries = 0;
      w.run += 1;
      return attempt(name, w, w.run);
    },
    /** Every watch armed so far, again (a wake, an unlock). */
    rearmAll() { return Promise.all([...watches.keys()].map((n) => api.arm(n))); },
    /** The watches waiting for a retry: [{ name, tries }]. */
    pending() { return [...watches].filter(([, w]) => w.timer).map(([name, w]) => ({ name, tries: w.tries })); },
  };
  return api;
}

/* When to re-read after a gap: one schedule for wakes, unlocks and sidecar restarts. A burst (resume
 * and unlock arrive together) is one schedule: a new gap restarts it, so it runs at `delays` after
 * the LAST trigger. */
function makeGapRereader(o) {
  let timers = [];
  let whys = [];
  return {
    gap(why) {
      for (const t of timers) o.cancel(t);
      if (!whys.includes(why)) whys.push(why);
      const said = whys.join(' and ');
      timers = o.delays.map((ms, i) => o.later(() => {
        if (i === o.delays.length - 1) { timers = []; whys = []; }
        o.reread(i === 0 ? said : `${said}, ${Math.round(ms / 1000)} s on`, i);
      }, ms));
    },
    waiting() { return timers.length; },
  };
}
// </mainrel:rearm>

const watchArmer = makeWatchArmer({
  delays: [2000, 5000, 15000, 60000],
  later: (fn, ms) => { const t = setTimeout(fn, ms); if (t.unref) t.unref(); return t; },
  cancel: (t) => clearTimeout(t),
  say: (line) => process.stdout.write(line),
  blocked: () => (shuttingDown ? 'Mantle is quitting' : sidecar.status !== 'ok' ? `the sidecar is ${sidecar.status}` : null),
});
function armWatch(name, fn) { return watchArmer.arm(name, fn); }

/** Read every readout the bar shows from the sidecar again. Each part says its own failure. */
function rereadReadouts(why) {
  if (shuttingDown || sidecar.status !== 'ok') return false;   // the next ready line re-reads it all
  process.stdout.write(`mantle: reading the bar's readouts again: ${why}\n`);
  qsRead().catch(() => { /* each part says why */ });          // the speaker glyph and every panel part
  sidecar.call('net', { op: 'get' }, 4000).then((r) => netPush(r, why),
    (err) => netPush(netFailure(err, 'the network state cannot be read'), why));
  batteryRead().then((r) => batteryPush(r, why));
  mediaPush(why);
  // The same whole list the sidecar pushes (WindowList.Build for both), through the same handlers.
  sidecar.call('windows', {}, 4000).then((list) => { if (Array.isArray(list)) sidecar.emit('windows', { ev: 'windows', list }); },
    (err) => process.stdout.write(`mantle: the window list could not be read again (${err.message}); the sidecar's next push brings it\n`));
  if (trayTimer) startTrayPoll();                                // live only: one tick now, then its 5 s rhythm
  return true;
}

// Windows drops low-level hooks on a wake without saying so: put them back, and say it if that fails.
const hookHealth = require('./lib/hook-health').makeHookHealth({
  state, call: (cmd, args, ms) => sidecar.call(cmd, args, ms), log: (l) => process.stdout.write(`mantle: ${l}\n`),
});
sidecar.on('switcher', hookHealth.onHook);

const gapRereader = makeGapRereader({
  delays: [3000, 20000],
  later: (fn, ms) => { const t = setTimeout(fn, ms); if (t.unref) t.unref(); return t; },
  cancel: (t) => clearTimeout(t),
  reread: (why, i) => {
    if (shuttingDown || sidecar.status !== 'ok') return;
    if (i === 0) hookHealth.rearm(why);
    if (i === 0) watchArmer.rearmAll().catch(() => { /* each arm says why */ });   // the second pass only reads
    rereadReadouts(why);
  },
});

let sidecarReadies = 0;
sidecar.on('ready', () => {
  // The first ready is the start: each watch's arm and the qs prime read it all already.
  if (sidecarReadies++ === 0) return;
  const t = setTimeout(() => rereadReadouts('the sidecar started again'), 2500);
  if (t.unref) t.unref();
});

// A sidecar that is down reads nothing: the speaker glyph and the media chip must not keep a value
// nobody is vouching for (the network and battery handlers above do the same for theirs).
sidecar.on('status', ({ status, reason }) => {
  if (status !== 'down' || shuttingDown) return;
  if (lastVolume && lastVolume.ok) volumeStore({ ok: false, reason: `the volume is not being read: ${reason}` }, 'the sidecar is down');
  if (lastMedia && lastMedia.ok !== false) mediaPush('the sidecar is down');
});

app.whenReady().then(() => {
  powerMonitor.on('resume', () => gapRereader.gap('the PC woke up'));
  powerMonitor.on('unlock-screen', () => gapRereader.gap('the screen was unlocked'));
});


// ---------------------------------------------------------------------------
// The command table behind mantle.call(). Every one of these either resolves
// with a value or throws an Error whose message is a sentence the page can show.
// ---------------------------------------------------------------------------
function needHwnd(args) {
  const h = args && args.hwnd;
  if (h === undefined || h === null || h === '') throw new Error('that command needs a window handle (hwnd)');
  // The sidecar reads anything else as window 0 (Json.GetHwnd's TryParse), so it stops here.
  const s = hwndArg(h);
  if (!s) throw new Error('that is not a window handle (a positive whole number)');
  return s;
}

/*
 * How a restart brings Mantle back (shell.restart). Never throws.
 *
 *   LIVE, started by the "Mantle" logon task -> via 'task': a DETACHED PowerShell waits for this
 *     process to exit AND for the task to stop saying Running, then runs the task (once more if
 *     nothing is up 5 s later). Not app.relaunch(): the relaunched
 *     Mantle would be OUR child rather than the Task Scheduler's, so it would not be the
 *     task's own process and could be reaped along with whatever session it ended up under. And it
 *     has to WAIT for the pid: the task is MultipleInstancesPolicy IgnoreNew
 *     (tools/mantle-logon-task.xml), so a /Run while this instance is still alive is ignored.
 *   LIVE otherwise (`npm run live`, or no task registered) -> via 'relaunch', same argv.
 *   TEST -> via 'relaunch', same argv, so a --test --profile-name lane proves the round trip.
 *
 * "Started by the task" = the task exists AND this process's parent is svchost.exe (the Task
 * Scheduler service runs an Exec action as its own child; checked on the live instance
 * 2026-09-22: parent svchost.exe). Either half missing -> relaunch, with the reason.
 * { assumeTask: true } skips both checks: that is the test run's dry-run log of the live command.
 */
async function restartPlan(opts) {
  const args = process.argv.slice(1);
  const helper = (why) => ({
    via: 'task',
    why,
    file: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-Command',
      // -ErrorAction SilentlyContinue: if this pid is already gone Wait-Process throws, and the
      // start must still happen. 90 s is well past shutdown()'s own 12 s hard stop.
      // Then wait for the TASK, not just the pid: Task Scheduler notices the exit a moment later,
      // and a Run while it still says Running is ignored (IgnoreNew). MEASURED 2026-09-23: a
      // `schtasks /Run` right after the old instance exited answered "currently running" and
      // Mantle stayed gone. Schedule.Service COM rather than schtasks' text, because State
      // (4 = running) does not depend on the Windows display language. One more Run if no
      // instance is up 5 s later.
      `Wait-Process -Id ${process.pid} -Timeout 90 -ErrorAction SilentlyContinue; ` +
      `$s = New-Object -ComObject Schedule.Service; $s.Connect(); $d = $s.GetFolder('\\'); ` +
      `$n = 0; while ($d.GetTask('Mantle').State -eq 4 -and $n -lt 120) { Start-Sleep -Milliseconds 250; $n++ }; ` +
      `[void]$d.GetTask('Mantle').Run($null); Start-Sleep -Seconds 5; ` +
      `if ($d.GetTask('Mantle').State -ne 4) { [void]$d.GetTask('Mantle').Run($null) }`],
  });
  if (opts && opts.assumeTask) return helper('dry run');
  if (flags.test) return { via: 'relaunch', args, why: 'test mode restarts itself' };
  const { execFile } = require('child_process');
  const run = (file, argv) => new Promise((resolve) => {
    execFile(file, argv, { windowsHide: true, timeout: 8000 }, (err, stdout) => resolve({ err, out: String(stdout || '') }));
  });
  const task = await run('schtasks', ['/Query', '/TN', 'Mantle']);
  if (task.err) return { via: 'relaunch', args, why: 'there is no "Mantle" scheduled task to start it from' };
  const parent = await run('tasklist', ['/FI', `PID eq ${process.ppid}`, '/FO', 'CSV', '/NH']);
  const name = (parent.out.match(/^"([^"]+)"/m) || [])[1] || '';
  if (!/^svchost\.exe$/i.test(name)) {
    return { via: 'relaunch', args, why: `this Mantle was not started by the "Mantle" task (its parent is ${name || `pid ${process.ppid}, which tasklist could not name`})` };
  }
  return helper('started by the "Mantle" logon task');
}

/*
 * Arrange for Mantle to come back once this process exits (restartPlan says how), without quitting.
 * {ok, via, why} or {ok:false, reason}: a way back that cannot be arranged is said, and the caller
 * decides (shell.restart does not quit; a crash still quits, since staying up is the worse choice).
 */
async function arrangeRestart() {
  const plan = await restartPlan();
  if (flags.test) {
    // The live road is never taken from a test run; its exact command line is logged instead,
    // so it can be read and checked without schtasks /Run ever being called.
    const dry = await restartPlan({ assumeTask: true });
    process.stdout.write(`mantle: restart dry run: a task-started live Mantle would spawn (detached): ${dry.file} ${dry.args.map((x) => (/\s/.test(x) ? `"${x}"` : x)).join(' ')}\n`);
  }
  if (plan.via === 'task') {
    const { spawn } = require('child_process');
    const started = await new Promise((resolve) => {
      let child;
      try {
        child = spawn(plan.file, plan.args, { detached: true, stdio: 'ignore', windowsHide: true });
      } catch (err) {
        resolve({ ok: false, reason: err.message });
        return;
      }
      child.once('error', (err) => resolve({ ok: false, reason: err.message }));
      child.once('spawn', () => { child.unref(); resolve({ ok: true, pid: child.pid }); });
    });
    if (!started.ok) {
      return { ok: false, reason: `Mantle was not restarted, and is still running: the helper that brings it back through the "Mantle" task would not start (${started.reason})` };
    }
    process.stdout.write(`mantle: restart helper pid ${started.pid} is waiting for pid ${process.pid} to exit, then runs the "Mantle" task\n`);
  } else {
    try {
      app.relaunch({ args: plan.args });
    } catch (err) {
      return { ok: false, reason: `Mantle was not restarted, and is still running: Electron would not arrange the relaunch (${err.message})` };
    }
  }
  return { ok: true, via: plan.via, why: plan.why || null };
}

const COMMANDS = {
  'state.get': async () => state.get(),

  // Mantle's own light / dark (lib/theme.js). get -> {mode, theme, windows, windowsWhy, pinned, note};
  // set {mode: 'system'|'light'|'dark'} switches every Mantle window at once and answers the same
  // (+ value), or {ok:false, reason} for anything that is not a mode.
  'theme.get': async () => getTheme().get(),
  'theme.set': async (a) => getTheme().set(a && typeof a === 'object' ? a.mode : undefined),
  // look sync (lib/look-host.js): Settings > Personalization > Colors, "Match Helm and Quartz"
  'look.get': async () => getLook().view(),
  'look.sync': async (a) => getLook().setSync(a && typeof a === 'object' ? a.on : undefined),
  'look.glass': async (a) => getLook().setGlass(a && typeof a === 'object' ? a : null),
  'look.accent': async (a) => (a && typeof a === 'object' && 'hue' in a ? getLook().setAccent(a.hue) : { ok: false, reason: 'the accent change came without a hue (null for Mantle\'s own)' }),

  'windows.list': async () => {
    const list = await sidecar.call('windows');
    lastWindows = withoutMantle(list);
    return lastWindows;
  },
  'win.toggle': async (a) => sidecar.call('toggle', { hwnd: needHwnd(a) }),
  'win.focus': async (a) => sidecar.call('focus', { hwnd: needHwnd(a) }),
  'win.minimize': async (a) => sidecar.call('minimize', { hwnd: needHwnd(a) }),
  'win.close': async (a) => sidecar.call('close', { hwnd: needHwnd(a) }),

  // ---- the hover bar's own calls ----
  // These four answer {ok, reason, ...} and never reject: the bar draws the
  // reason, and a rejected promise in a renderer is a sentence nobody reads.
  'bar.pinned': async () => pinnedOnce(),

  'bar.open': async (a) => {
    const id = a && a.id !== undefined && a.id !== null ? String(a.id) : '';
    if (!id) return { ok: false, reason: 'bar.open needs the id of an item in the bar' };
    const list = lastPinned && Array.isArray(lastPinned.items) && lastPinned.items.length
      ? lastPinned
      : await pinnedOnce();
    const item = (list.items || []).find((i) => i.id === id);
    if (!item) return { ok: false, reason: `the bar asked to open "${id}", which is not in the list Mantle last built` };

    /*
     * EXACTLY WHAT THE WINDOWS TASKBAR DOES, because Owen asked for the apps to
     * "work the same as before just on mantle":
     *   middle-click (fresh:true) -- a NEW instance, however many are running.
     *   nothing running            -- launch it.
     *   one window                 -- the one you are in minimises; any other one
     *                                 is focused, which also RESTORES it if it was
     *                                 minimised (verified in the sidecar:
     *                                 Windows.cs Focus() does SW_RESTORE on an
     *                                 iconic window before it raises it).
     *   two or more                -- Windows shows thumbnails and picks nothing.
     *                                 So does Mantle: it answers action:'list'
     *                                 with the windows and touches no window at
     *                                 all; the bar opens its own window list.
     */
    // "Windows Settings" / "Windows Task Manager" on a Mantle app's right-click menu (ui/bar/jumplist.js)
    if (a && a.windows) {
      if (!item.mantleApp || !mantleApps) return { ok: false, reason: `${item.name} is not one of Mantle's apps, so it has no Windows version to open` };
      return openWindowsOwn(item);
    }
    const fresh = !!(a && a.fresh);
    const wins = Array.isArray(item.windows) ? item.windows : [];
    // One line per click, so a click that "did nothing" can be read back from the log. No app
    // name in it (privacy rule, 10-01): the pin's kind says enough.
    process.stdout.write(`mantle: bar.open (${item.kind || 'item'}): ${wins.length} window(s)${fresh ? ', fresh' : ''}${wins.length === 1 ? `, active=${!!wins[0].active}, hwnd ${wins[0].hwnd}` : ''}\n`);

    if (!fresh && wins.length >= 2) {
      return { ok: true, reason: null, action: 'list', windows: wins };
    }
    if (!fresh && wins.length === 1) {
      const w = wins[0];
      const action = w.active ? 'minimize' : 'focus';
      // THIS process got the click: hand its foreground right to the sidecar first (lib/fg-grant.js).
      const g = action === 'focus' ? fgGrant.grant(sidecar.info && sidecar.info.pid) : null;
      try {
        const r = await sidecar.call(action, { hwnd: String(w.hwnd) }, 4000);
        process.stdout.write(`mantle: bar.open: ${action} of ${w.hwnd} done${g ? ` (${fgGrant.howWords(r)}; right ${fgGrant.words(g)})` : ''}\n`);
        return { ok: true, reason: null, action, hwnd: String(w.hwnd) };
      } catch (err) {
        const e = fgGrant.splitTried(err.message);
        if (g) process.stdout.write(`mantle: bar.open: focus of ${w.hwnd} lost (right ${fgGrant.words(g)}${e.tried ? `; ${e.tried}` : ''})\n`);
        return { ok: false, reason: `${item.name} is running but Mantle could not ${action} it: ${e.shown}` };
      }
    }
    return launchItem(item, fresh);
  },

  'bar.window': async (a) => {
    const hwnd = a && a.hwnd !== undefined && a.hwnd !== null ? hwndArg(a.hwnd) || '' : '';
    if (!hwnd) return { ok: false, reason: 'bar.window needs a window handle (hwnd), a positive whole number' };
    const action = String((a && a.action) || '');
    if (!['focus', 'minimize', 'close', 'toggle'].includes(action)) {
      return { ok: false, reason: `bar.window does not know the action "${action}" (it does focus, minimize, close and toggle)` };
    }
    // A click on the bar's window list: hand the click's foreground right on (lib/fg-grant.js).
    const g = action === 'focus' || action === 'toggle' ? fgGrant.grant(sidecar.info && sidecar.info.pid) : null;
    try {
      const r = await sidecar.call(action, { hwnd }, 4000);
      if (g) process.stdout.write(`mantle: bar.window: ${action} of ${hwnd} done (${fgGrant.howWords(r)}; right ${fgGrant.words(g)})\n`);
      return { ok: true, reason: null, action, hwnd };
    } catch (err) {
      const e = fgGrant.splitTried(err.message);
      if (g) process.stdout.write(`mantle: bar.window: ${action} of ${hwnd} lost (right ${fgGrant.words(g)}${e.tried ? `; ${e.tried}` : ''})\n`);
      return { ok: false, reason: `could not ${action} that window: ${e.shown}` };
    }
  },

  // The system buttons (action centre, notifications, show desktop). A WHITELIST:
  // 'keys' can type anything into whatever is in front, and "the bar asked" is not
  // a good enough reason to hand a web page a keyboard.
  'sys.keys': async (a) => {
    const combo = String((a && a.combo) || '').toLowerCase().trim();
    if (!combo) return { ok: false, reason: 'sys.keys needs a combo' };
    if (!KEYS_ALLOWED.has(combo)) {
      return { ok: false, reason: `Mantle will not press "${combo}": the bar may only send ${Array.from(KEYS_ALLOWED).join(', ')}` };
    }
    try {
      await sidecar.call('keys', { combo }, 4000);
      return { ok: true, reason: null, combo };
    } catch (err) {
      return {
        ok: false,
        reason: Sidecar.isOldExeError(err)
          ? `the sidecar exe has no "keys" command yet, so ${combo} did nothing: run npm run build:sidecar`
          : `${combo} was not pressed: ${err.message}`,
      };
    }
  },

  // The renderer's own hover truth. The cursor poll cannot see a mouse that is
  // over the bar's popover or mid-drag inside it, so the page says so and the
  // hide clock is held off for as long as it keeps saying it.
  'bar.hover': async (a) => {
    if (a && a.inside) {
      rendererHoverAt = Date.now();
      if (!barRevealed) revealBar('the bar page reported the cursor is in it');
      else cancelPendingHide();
    } else {
      rendererHoverAt = 0;
    }
    return { ok: true, reason: null };
  },

  // TEST ONLY (--test): hand lib/popwatch.js a made-up sidecar event ({op:'click', x, y}, in DIP
  // when dip:true; or {op:'esc'}), so a test proves the road from the watch to the page's close
  // without a real click or key on Owen's desktop. No ev: just the watch's state.
  'popwatch.test': async (a) => {
    if (!flags.test) throw new Error('popwatch.test exists only in a --test run');
    const ev = Object.assign({}, a && a.ev);
    if (ev.op === 'click' && a.dip) {
      const p = screen.dipToScreenPoint({ x: Number(ev.x), y: Number(ev.y) });
      ev.x = p.x; ev.y = p.y;
    }
    const result = ev.op ? popwatch.onEvent(ev) : null;
    return { ok: true, result, state: popwatch.state(), bar: barRect(), barPopover: barPopover ? popKind(barPopover.key) : null, revealed: barRevealed };
  },

  // The bar window is only 44px tall, so a popover drawn inside it would be
  // clipped by the window, not by the screen. The bar asks for room before it
  // opens one and gives it back when it closes. The window grows AWAY from its
  // screen edge: the bottom bar keeps its bottom edge and rises, the top bar
  // keeps its top edge and descends, so the bar itself never appears to move.
  // In hover mode (barTall, 2026-09-24) the window already HAS the room and only its shape
  // grows: resizing it was what made the pill jump.
  // a HUD page, dark only, once per show: one picture of what is behind its window (see hudBackdrop)
  'hud.backdrop': async (a) => hudBackdrop(String((a && a.key) || '')),
  // the top bar's dropdowns, dark: one picture of everything they can cover (lane same-bars; topbarPopBackdrop)
  'glass.topbarMenu': async () => topbarPopBackdrop(),
  'bar.popover': async (a) => {
    if (!barWin || barWin.isDestroyed()) throw new Error('the bar window is gone, so there is nothing to make room in');
    const open = !!(a && a.open);
    if (traceMarks) traceMarks.push({ t: traceNow(), what: 'popover', open, key: (a && a.key) || null, height: Number(a && a.height) || 0 });
    // A popover takes the volume pop-up down AT ONCE (r7-ontop, 2026-10-01). The app-volumes panel is
    // now really on top, so a left-click on the speaker within its ~1.5 s fade opened Quick settings
    // UNDER it. osd.faded with no seq is the pop-up's own unconditional hide (lib/features/osd.js).
    if (open) dismissOsd(`the bar opened a popover (${popKind(a && a.key)})`);
    // A popover is the bar being used, so it pins the bar on screen for as long
    // as it is open (the hover poll checks barPopover on every tick) and brings
    // it back if something raced it into hiding.
    if (open && !flags.dock) revealBar('a bar popover opened');
    // Previews go BEFORE the window changes size. Their rectangles are relative to the window's
    // top-left, and the window grows and shrinks from the top, so a preview left registered
    // across a resize slides down over the bar's own icons. The flyout re-sends its rectangles
    // once this call has resolved and the window has settled.
    clearThumbs(open ? `the bar popover is resizing (${popKind(a && a.key)})` : 'the bar popover closed');
    const asked = Number(a && a.height);
    const extra = open ? Math.max(0, Math.min(POPOVER_MAX, Number.isFinite(asked) ? Math.round(asked) : 0)) : 0;
    const total = BAR_H + extra;
    const wasOpen = !!barPopover;
    let shapeErr = null;

    if (barTall()) {
      // TALL MODE (barTall, 2026-09-24): the window already has the room, so only its SHAPE
      // changes -- no resize, no relayout, nothing drawn stale, and the pill cannot move.
      const set = setBarShape(extra, open ? `a popover opened (${popKind(a && a.key)})` : 'the popover closed');
      if (!set.ok) shapeErr = set.reason;
    } else if (flags.test && !flags.testLiveBar) {
      // A framed test window: sized by its CONTENT from fixed numbers (testFitPage), so the
      // frame stays out of the arithmetic and repeated popovers cannot creep the page wider.
      // Pill mode gets the live window's height (rest.height + extra, popoverDipRect's), so the
      // popover has the same room under it that it has live; edge mode keeps BAR_H + extra.
      testFitPage(BAR_SHAPE === 'pill' ? barGeometry().rest.dip.height + extra : total);
    } else {
      // Live: anchor to the BAR'S OWN resting rectangle rather than to the
      // window's current bounds, so a popover that opens twice cannot drift the
      // bar up the screen -- and so that in pill mode it keeps the pill's x, its
      // width and its 14 DIP of lift instead of snapping out to full width.
      const dip = popoverDipRect(extra);
      if (BAR_SHAPE === 'pill' && sidecarDpiAware !== null && !sidecar.blockedReason()) {
        // PILL: through a short MORPH, not a place. The pill's roundness is a
        // window REGION, and a region is cut for one size: `place` alone would
        // grow the window while the old rounded region went on clipping it, so
        // the popover would open inside a pill-shaped hole. A morph re-cuts it,
        // and 200 ms of travel reads as the pill growing rather than jumping.
        const geo = barGeometry();
        const side = { dip: Object.assign({ r: PILL_RADIUS_DIP }, dip), phys: Object.assign({ r: geo.radius }, toPhys(dip)) };
        // Same rule as the resting rect and the `place` path below: the BOTTOM is
        // the screen edge, computed, never a rounded height (62 DIP at 1.25x is
        // 77.5 px, and a 78 px window closed one pixel past the screen -- build 26).
        if (flags.barEdge !== 'top') side.phys.h = geo.bottomPhys - side.phys.y;
        await runMorph(sideRect(currentSide(geo)), sideRect(side), 200, open ? 'reveal' : 'hide');
      } else if (sidecarDpiAware === true && !sidecar.blockedReason()) {
        // Through the sidecar, not setBounds: see placeBar() -- setBounds clamps
        // into the work area, which would shove the bar up by its own height.
        // Same rule as the resting rect: the BOTTOM is the screen edge, computed,
        // never a rounded height that can land a pixel past it.
        const ph = toPhys(dip);
        if (flags.barEdge !== 'top') ph.h = barGeometry().bottomPhys - ph.y;
        await sidecar.call('place', { hwnd: hwndOf(barWin), x: ph.x, y: ph.y, w: ph.w, h: ph.h }, 4000);
      } else if (sidecarDpiAware === false) {
        barWin.setBounds(dip);
      } else {
        // Before applyLive has asked the sidecar (the bar page's first load fires
        // its popover release then): nothing is open yet, and a setBounds here
        // would be the clamped move this whole path exists to avoid.
        process.stdout.write('mantle: bar resize skipped: the sidecar has not been asked about DPI yet, so no placement path is safe\n');
      }
    }

    const popWas = barPopover ? barPopover.height : 0;
    barPopover = extra ? { key: (a && a.key) || 'unnamed', height: extra } : null;
    popWatchBar();   // a click outside it or Esc closes it from now on (lib/popwatch.js)
    // the notification banners sit above an open pop-up when the pill reaches their corner (lib/corner.js)
    if (popWas !== extra) require('./lib/corner').changed(`a bar pop-up ${extra ? `opened (${popKind(a && a.key)})` : 'closed'}`);
    if (traceMarks) traceMarks.push({ t: traceNow(), what: 'popover done', open, extra });
    try {
      process.stdout.write(`mantle: bar.popover ${open ? `open (${popKind(a && a.key)}, asked ${asked}px, got ${extra}px)` : 'closed'} -> window now ${JSON.stringify(barWin.getBounds())} (DIP)${barTall() ? `, the bar's shape ${JSON.stringify(barRect())}` : ''}\n`);
    } catch (_) { /* the window may be gone; the line is only a trace */ }
    // The window just changed size, which is another moment Windows can re-order
    // the topmost band -- and a popover nobody can click is worse than no popover.
    if (open && !flags.dock) raiseBar('a popover opened');
    // dark pop-ups: one picture of what is behind them, not awaited (see barPopBackdrop)
    if (open && extra && a && a.backdrop === true) barPopBackdrop((a && a.key) || 'unnamed').catch(() => {});
    if (open && extra < asked) {
      process.stdout.write(`mantle: the bar asked for ${asked}px of popover room and got ${extra}px (the cap is ${POPOVER_MAX}px)\n`);
    }
    // The page says so inside the popover ("this popover may be clipped"), not just the log.
    if (shapeErr && open) throw new Error(`its room could not be opened: ${shapeErr}`);
    // A FRESH open answers once the page's wipe (.pop in bar.css, POP_WIPE_MS) has uncovered it:
    // a flyout sends its live previews when this resolves, and DWM draws those over the page, so
    // sooner would put pictures on cards the wipe has not reached -- the order they had when
    // the window itself took 200 ms to grow. Not for a popover already open (no wipe runs).
    if (barTall() && open && extra && !wasOpen) await wait(POP_WIPE_MS);
    return { height: extra, total, capped: open && extra < asked, max: POPOVER_MAX };
  },

  /*
   * The hover flyout's live previews: {items:[{hwnd, x, y, w, h}], dpr} makes the set of DWM
   * thumbnails in the bar window EXACTLY those boxes (CSS px, viewport-relative), and
   * {items:[]} removes them all. Answers {ok, reason, thumbs:[{hwnd, ok, reason, ...}]} and
   * never rejects: every card whose picture cannot be drawn gets its own reason to print.
   *
   * It refuses unless a popover is holding room open AND the bar is up. Both are about the
   * leak: a preview drawn with no popover room sits over the bar itself, and one drawn into a
   * bar that is leaving stays on screen while the page's own content slides away under it.
   */
  'bar.thumbs': async (a) => {
    const items = Array.isArray(a && a.items) ? a.items : [];
    if (!items.length) {
      clearThumbs('the flyout asked for no previews');
      return { ok: true, reason: null, thumbs: [] };
    }
    const refuse = (reason) => {
      clearThumbs(reason);
      return { ok: false, reason, thumbs: items.map((e) => ({ hwnd: String(e && e.hwnd), ok: false, reason })) };
    };
    if (!barWin || barWin.isDestroyed()) return refuse('no live picture: the bar window is gone');
    if (!barPopover) return refuse('no live picture: the flyout has no room open in the bar window yet');
    if (!flags.dock && (!barRevealed || hideTimer)) return refuse('no live picture: the bar is leaving the screen');
    // Where the page starts on screen, in physical px: lib/thumbs.js subtracts the Win32 client
    // origin to find the page inside the client area (0 for the frameless live bar; the menu
    // bar for the framed --test bar). Without it the pictures are drawn as if it were 0.
    let contentOrigin = null;
    try {
      const cb = barWin.getContentBounds();
      contentOrigin = screen.dipToScreenPoint({ x: cb.x, y: cb.y });
    } catch (_) { /* thumbs.sync says so in its reason */ }
    const res = thumbs.sync(hwndOf(barWin), items, Number(a && a.dpr), contentOrigin);
    lastThumbSync = res;   // for the --test --flyout capture, which pastes these rectangles
    // (ok:false is logged by the IPC handler already; this is the "drawn, but" note, and one line
    // per card that got no picture, so "the flyout was empty" can be answered from the log.)
    if (res.ok && res.reason) process.stdout.write(`mantle: bar.thumbs: ${res.reason}\n`);
    for (const t of res.thumbs || []) if (!t.ok) process.stdout.write(`mantle: bar.thumbs: ${t.hwnd}: ${t.reason}\n`);
    return res;
  },

  'launcher.show': async () => { showLauncher('a page'); return { visible: true }; },
  'launcher.toggle': async () => { const r = await toggleLauncher('the Start button'); return { visible: !!(r && r.opened) }; },
  'launcher.hide': async () => { hideLauncher(); return { visible: false }; },

  'apps.index': async (a) => apps.index({ refresh: !!(a && a.refresh) }),
  'apps.search': async (a) => apps.search(a && a.q),
  // --test: every launch/open below is a DRY RUN with a log line (osd2 lane, 2026-09-24: Enter on
  // an app row in a test instance really started the app). The row is still resolved, so a dry run
  // proves the id; lib/launcher-index.js says what it WOULD have run. Live behaviour is unchanged.
  'apps.launch': async (a) => {
    const res = await apps.launch(a && a.id, { dryRun: !!flags.test, spotifyPort: spotifyQueueOn() });
    if (res && res.dryRun) process.stdout.write(`mantle: apps.launch dry run (--test): ${res.reason || 'nothing started'}\n`);
    if (res && res.ok && !res.dryRun) hideLauncher();
    return res;
  },
  // The launcher's power rows and Windows Search file rows. lib/launcher-index.js does the work;
  // main only lends it the sidecar (Sleep and file search live there), which lib/apps.js never
  // hands the index module. A --test instance is ALWAYS a power dry run.
  'launcher.power': async (a) => {
    const res = await require(modulePathFor(ROOT)).power(a, { sidecar: (c, x, ms) => sidecar.call(c, x, ms), dryRun: !!flags.test });
    if (res && res.ok && !res.dryRun) hideLauncher();
    return res;
  },
  'launcher.files': async (a) => require(modulePathFor(ROOT)).files(a, { sidecar: (c, x, ms) => sidecar.call(c, x, ms) }),
  'launcher.openFile': async (a) => {
    const res = await require(modulePathFor(ROOT)).openFile(a, { dryRun: !!flags.test });
    if (flags.test && res) {
      res.dryRun = true;
      process.stdout.write(`mantle: launcher.openFile dry run (--test): ${logSafe(a, res.reason) || (res.ok ? 'nothing opened' : 'refused')}\n`);
    }
    if (res && res.ok && !res.dryRun) hideLauncher();
    return res;
  },

  'volume.get': async () => {
    if (sidecar.status === 'starting' && await sidecarNext('volume', 15000) && lastVolume && lastVolume.ok) return lastVolume;
    return sidecar.call('volume');
  },
  'volume.set': async (a) => {
    const args = {};
    if (a && a.level !== undefined) args.level = a.level;
    if (a && a.muted !== undefined) args.muted = a.muted;
    if (!Object.keys(args).length) throw new Error('volume.set needs a level or a muted flag');
    return sidecar.call('volume', args);
  },

  // ---- Quick Settings: the bar's own panel, not a trip to the Settings app ----
  // The last whole picture at once when there is one (the panel opens on it, and the watch that
  // qs.watch starts fills in anything that moved); a full read only before the first.
  'qs.get': async () => {
    if (qsLatest && QS_PARTS.every(([key]) => qsLatest[key])) return Object.assign(qsCompose(qsLatest), { cached: true });
    return qsRead();
  },

  'net.get': async () => {
    if (lastNet) return lastNet;
    if (sidecar.status === 'starting' && await sidecarNext('net', 15000) && lastNet) return lastNet;
    let r;
    try { r = await sidecar.call('net', { op: 'get' }, 4000); } catch (err) { r = netFailure(err, 'the network state cannot be read'); }
    netPush(r, 'the first read');
    return r;
  },

  // EVERY CALL IS LOGGED with its result and latency (qsSetLog, lib/call-log.js): until
  // 2026-09-23 a set was never logged, so a switch that did nothing left no trace at all.
  'qs.set': async (a) => {
    const t0 = Date.now();
    const part = String((a && a.part) || '');
    const value = a ? a.value : undefined;
    const done = (reply) => {
      reply.ms = Date.now() - t0;
      qsSetLog.record(part, value, reply, reply.ms);
      return reply;
    };
    const spec = QS_WRITE[part];
    if (!spec) {
      return done({ ok: false, part, value: null, state: null, reason: `qs.set does not know the part "${part}" (it does ${Object.keys(QS_WRITE).join(', ')})` });
    }
    const bad = spec.check(value);
    if (bad) return done({ ok: false, part, value: null, state: null, reason: bad });
    let set;
    try {
      set = await sidecar.call(spec.cmd, spec.args(value), 4000);
    } catch (err) {
      return done({
        ok: false,
        part,
        value: null,
        state: null,
        reason: Sidecar.isOldExeError(err)
          ? `${spec.label} could not be changed: the sidecar exe has no "${spec.cmd}" command yet, so run npm run build:sidecar`
          : `${spec.label} could not be changed: ${err.message}`,
      });
    }
    // A switch Windows refused comes back from the sidecar as a RESULT, ok:false with its reason
    // (Network.Set: "Windows refused to switch the Wi-Fi radio (error 5 ...)"), not as an error,
    // and it wins: the tile did not move, and this says why.
    const refused = !!(set && typeof set === 'object' && set.ok === false);
    // THE REPLY IS THE READ-BACK (2026-09-23): every switch reads the hardware back itself
    // (QuickSettings.Settle, Display, Volume.Apply), so a slider that springs back is the truth
    // about a control that refused. A refused switch carries its plain read as `read`; only an
    // older sidecar without it costs a second read. This used to be a second read of every
    // part plus a full six-part push after EVERY set, a dragged slider's included.
    let now;
    if (!refused) now = qsNormalize(set, spec.label);
    else if (set.read && typeof set.read === 'object') now = qsNormalize(set.read, spec.label);
    else now = await qsPart(spec.cmd, spec.label);
    if (spec.key === 'volume') volumeStore(now, `qs.set ${part}`);
    else qsStore(spec.key, now, Date.now());
    // `value` is the one number or switch the part reads now, in the units it was set in; `state`
    // is the whole part as qs.get shows it.
    return done({
      ok: !refused && !!now.ok,
      part,
      value: now.ok ? spec.read(now) : null,
      state: now,
      reason: refused ? (set.reason || `${spec.label} was not changed, and the sidecar gave no reason`)
        : now.ok ? null : now.reason,
    });
  },

  'qs.watch': async (a) => {
    const on = !!(a && a.on);
    const who = a && typeof a.who === 'string' && /^[a-z]{1,20}$/.test(a.who) ? a.who : 'panel';
    qsHoldersPrune();
    if (!on) {
      qsHolders.delete(who);
      if (qsHolders.size && qsWatching) return { ok: true, watching: true, via: qsWatchVia || 'starting', leaseMs: QS_LEASE_MS, reason: `still watching: ${Array.from(qsHolders.keys()).join(' and ')} holds it` };
    }
    if (on) {
      qsHolders.set(who, who === 'panel' ? Infinity : Date.now() + QS_HOLD_MS);
      const started = qsWatchStart();
      return { ok: true, watching: true, via: qsWatchVia || 'starting', leaseMs: QS_LEASE_MS, reason: started ? null : 'the quick-settings watch was already running, so nothing was started twice' };
    }
    qsWatchStop('the panel asked');
    return { ok: true, watching: false, via: null, reason: null };
  },

  // ---- Quick Settings, one level down: Wi-Fi networks, output device, mixer ----
  'qs.wifi.list': async () => qsMore('wlan', { op: 'list' }, 'the Wi-Fi networks cannot be read', QS_MORE_MS.list),
  'qs.wifi.scan': async () => qsMore('wlan', { op: 'scan' }, 'the Wi-Fi scan did not finish', QS_MORE_MS.scan),

  'qs.wifi.connect': async (a) => {
    // THE PASSWORD LEAVES `a` BEFORE ANYTHING CAN FAIL OR AWAIT: the IPC handler
    // logs a failed call's args with JSON.stringify(args), and `a` IS that object.
    // From here it lives in one local, then in the one line written to the
    // sidecar's stdin, and nowhere else: no log, no state file, no error text.
    let password = null;
    if (a && Object.prototype.hasOwnProperty.call(a, 'password')) {
      password = a.password;
      delete a.password;
    }
    const ssid = a && typeof a.ssid === 'string' && a.ssid ? a.ssid : null;
    const hex = a && typeof a.hex === 'string' && a.hex ? a.hex : null;
    if (!ssid && !hex) return { ok: false, reason: "qs.wifi.connect needs ssid (the network's name) or hex" };
    if (password !== null && typeof password !== 'string') return { ok: false, ssid, reason: 'the Wi-Fi password must be text' };
    const args = { op: 'connect', auto: !(a && a.auto === false) };
    if (hex) args.hex = hex;
    else args.ssid = ssid;
    if (password) args.password = password;
    password = null;
    const pending = qsMore('wlan', args, `Mantle could not connect to "${ssid || 'that network'}"`, QS_MORE_MS.connect);
    delete args.password;                  // already serialized by sidecar.call
    const r = await pending;
    if (qsWatching) qsPush(`Wi-Fi ${r.ok ? 'joined' : 'did not join'} a network`);
    return r;
  },

  'qs.wifi.disconnect': async () => {
    const r = await qsMore('wlan', { op: 'disconnect' }, 'Wi-Fi could not be disconnected', QS_MORE_MS.disconnect);
    if (qsWatching) qsPush('Wi-Fi was disconnected');
    return r;
  },

  'qs.audio.devices': async () => qsMore('audio', { op: 'devices' }, 'the playback devices cannot be read', QS_MORE_MS.audio),

  'qs.audio.default': async (a) => {
    // "device", not "id": lib/sidecar.js refuses an argument named id (the protocol's own).
    const device = a && typeof a.device === 'string' ? a.device : '';
    if (!device) return { ok: false, reason: "qs.audio.default needs device: a playback device's id from qs.audio.devices" };
    const r = await qsMore('audio', { op: 'default', device }, 'the output device could not be changed', QS_MORE_MS.audio);
    // The main slider follows the default device, so repaint it from a fresh read.
    if (qsWatching) qsPush('the output device was changed');
    return r;
  },

  'qs.audio.sessions': async () => {
    const r = await qsMore('audio', { op: 'sessions' }, 'the apps playing sound cannot be read', QS_MORE_MS.audio);
    if (r.ok && Array.isArray(r.sessions)) {
      // Icons from each app's exe, cached per path by iconFor: one sidecar call per
      // app ever, so a 1.5 s refresh of an open mixer costs the session read only.
      await Promise.all(r.sessions.map(async (s) => {
        if (s.system) { s.icon = null; s.iconReason = null; return; }
        if (!s.path) { s.icon = null; s.iconReason = 'no icon: Windows gave no program path for this app'; return; }
        const got = await iconFor([s.path]);
        s.icon = got.icon;
        s.iconReason = got.reason;
      }));
    }
    return r;
  },

  'qs.audio.session': async (a) => {
    const key = a && typeof a.key === 'string' ? a.key : '';
    if (!key) return { ok: false, reason: "qs.audio.session needs key: a row's key from qs.audio.sessions" };
    const args = { op: 'session', key };
    if (a.level !== undefined) args.level = Number(a.level);
    if (a.muted !== undefined) args.muted = a.muted;
    return qsMore('audio', args, "that app's volume could not be changed", QS_MORE_MS.audio);
  },

  // ---- Quick Settings, one level down: the paired Bluetooth devices (see qsBtToggle) ----
  'qs.bt.list': async () => qsMore('btdevices', { op: 'list' }, 'the Bluetooth devices cannot be read', QS_BT_MS.list),
  'qs.bt.watch': async (a) => {
    const on = !!(a && a.on);
    return qsMore('btdevices', { op: 'watch', on }, `the Bluetooth device watch could not be turned ${on ? 'on' : 'off'}`, QS_BT_MS.watch);
  },
  'qs.bt.connect': async (a) => qsBtToggle('connect', a),
  'qs.bt.disconnect': async (a) => qsBtToggle('disconnect', a),

  // The Wi-Fi password field's keyboard: see qsKeyboard for why the bar must ask.
  'qs.keyboard': async (a) => qsKeyboard(!!(a && a.on)),

  // ms-settings: links from the bar open MANTLE Settings (lib/open-route.js; lane barfiles, 2026-09-29)
  // Only Settings pages, the Wi-Fi list and web links (openTargetVerdict): a page cannot use this to
  // start a program or open a file. --test never opens anything of Windows' (it said so in a line).
  'open': async (a) => {
    const bad = openTargetVerdict(a && a.target);
    if (bad) return { ok: false, reason: bad };
    const target = String(a.target).trim();
    const dryOpen = async (t) => {
      const scheme = (/^([a-z][a-z0-9+.-]*):/i.exec(t) || [])[1] || 'an';
      process.stdout.write(`mantle: open dry run (--test): would open a ${scheme.toLowerCase()}: address\n`);
      return { ok: true, dryRun: true, reason: 'dry run (--test): nothing was opened' };
    };
    return openRouted(target, { launch: (item, o) => require('./lib/launcher-index').launch(item, o), openTarget: flags.test ? dryOpen : openTarget, dryRun: !!flags.test });
  },

  'shell.restore': async () => {
    shellPaused = { at: Date.now(), why: 'a window asked for it' };
    // Windows was asked back: a crash while paused must not start Mantle (and its taskbar hiding) again.
    supervisor.standDown('Windows was put back ("Restore Windows taskbar")');
    await restoreShell('a window asked for it');
    updateTray();
    return state.get();
  },
  'shell.quit': async () => {
    // Answer first, quit on the next tick, so the page that asked is not waiting
    // on a promise that dies with the process.
    setTimeout(() => shutdown('a window asked Mantle to quit'), 0);
    return { quitting: true };
  },

  /*
   * "Restart Mantle", from the bar's overflow menu (Owen, 2026-09-22). The SAME clean quit as
   * shell.quit and `electron . --quit` -- shutdown(), which puts Windows back exactly as a quit
   * does -- and then Mantle comes back. How it comes back is the whole design (restartPlan).
   * If the way back cannot be arranged this answers ok:false with the reason and does NOT quit:
   * half a restart is a quit Owen did not ask for.
   */
  'shell.restart': async (a) => {
    if (shuttingDown) return { ok: false, reason: 'Mantle is already shutting down' };
    // Who asked, for the log: the bar menu by default, the tray menu says so (its own words only).
    const from = a && a.via === 'the tray menu' ? 'the tray menu' : 'the bar menu';
    const r = await arrangeRestart();
    if (!r.ok) return { ok: false, reason: r.reason };
    process.stdout.write(`mantle: restart requested from ${from} (via ${r.via})${r.why ? `: ${r.why}` : ''}\n`);
    // Answer first, quit on the next tick (same reason as shell.quit).
    setTimeout(() => shutdown(`a restart was requested from ${from}`), 0);
    return { ok: true, reason: null, via: r.via };
  },

  // The way back when the link to Windows (the sidecar) stopped and gave up restarting on its own
  // (lib/sidecar.js retry(): a fresh budget and one more start). The tray offers it right under the
  // fault; a page may offer it too. Once it says hello, applyMode puts the shell pieces back.
  'shell.reconnect': async () => {
    if (shuttingDown) return { ok: false, reason: 'Mantle is shutting down' };
    if (shellPaused) return { ok: false, reason: 'Mantle is paused because Windows was put back: restart Mantle to use it again' };
    if (sidecar.status === 'ok') return { ok: true, reason: 'Mantle is already connected to Windows' };
    let started = false;
    try { started = await sidecar.retry(); } catch (err) { return { ok: false, reason: `it did not start: ${err.message}` }; }
    process.stdout.write(`mantle: reconnect to Windows asked for: ${started ? 'the link started again' : 'it did not start'}\n`);
    if (started) return { ok: true, reason: null };
    return { ok: false, reason: shortReason((state.get().sidecar || {}).reason, 140) || 'it did not start, and gave no reason' };
  },

  // The same text "Copy diagnostic report" puts on the clipboard, for a page that wants to show it.
  'diag.report': async () => ({ ok: true, reason: null, text: await diagnosticReport() }),

  'sys.stats': async () => stats(batteryLatest),

  // The battery readout's first draw; after that it is pushed as 'battery'.
  'battery.get': async () => batteryLatest(),

  'tray.list': async () => {
    const list = await sidecar.call('tray');
    lastTray = trayForBar(list);
    return lastTray;
  },
  'tray.click': async (a) => {
    if (!a || !a.id || typeof a.id !== 'string' || a.id.length > 400) throw new Error('tray.click needs the id of a notification-area item');
    if (a.button !== undefined && !['left', 'right', 'middle', 'double'].includes(a.button)) throw new Error('tray.click clicks with the left or right button only');
    /* An icon the sidecar already said it cannot click (a hidden one, in Windows' hidden-icons
       flyout) is refused HERE with the sidecar's own reason, which names the Settings switch that
       fixes it, instead of being sent down to fail more vaguely. */
    const known = (lastTray || []).find((t) => t && t.id === a.id);
    if (known && known.clickable === false) {
      const err = new Error(known.reason || `${known.title || 'that icon'} cannot be clicked from Mantle, and Windows did not say why`);
      // The bar shows the icon's name; the log gets no tooltip text (an app's tooltip can carry an account or network name).
      err.logText = 'a notification-area icon Mantle cannot click (the bar shows which, and why)';
      throw err;
    }
    // `icon`, NOT `id` (fixed 2026-09-22): `id` is the sidecar protocol's request id. Sent as
    // `id`, the icon's id overwrote the request's own, the reply came back under an id nobody
    // was waiting for, and a click that had worked showed as a timeout. lib/sidecar.js now
    // refuses a reserved `id` argument outright; Program.cs's trayClick reads `icon`.
    return sidecar.call('trayClick', { icon: a.id, button: a.button || 'left' });
  },

  // ---- now playing (the NOW PLAYING block above says how and why) ----
  // Every one answers the whole payload ({ok, reason, sessions, shown, guard, ...}) and never
  // rejects, like the quick-settings calls: the bar draws the reason.
  'media.get': async () => mediaPush('the bar asked'),
  'media.select': async (a) => {
    // null / missing = back to automatic (Windows' current session, under the LessonPlayer rule).
    // A pick (even of the same source again) starts a fresh grace (lib/media-pick.js).
    const aumid = a && a.aumid ? String(a.aumid) : null;
    const known = aumid ? ((lastMedia && lastMedia.sessions) || []).find((s) => sameAumid(s.aumid, aumid)) : null;
    mediaPick = MediaPick.makePick(aumid, known || { aumid, lessonplayer: isLessonPlayer({ aumid }) }, Date.now());
    mediaPickDropped = null;
    return mediaPush(mediaPick ? `a source was picked in the media card (${mediaPick.aumid})` : 'the media card went back to automatic');
  },
  'media.control': async (a) => {
    const action = String((a && a.action) || '');
    const aumid = a && a.aumid ? String(a.aumid) : '';
    if (!MEDIA_ACTIONS.has(action)) {
      return { ok: false, action, reason: `media.control does not know the action "${action}" (it does ${Array.from(MEDIA_ACTIONS).join(', ')})` };
    }
    if (!aumid) {
      return { ok: false, action, reason: 'media.control needs the AUMID of the session the button belongs to, so a press can never land on a different app' };
    }
    // THE LESSONPLAYER RULE, enforced here and not only in the page. Judged on main's own last read
    // (title and app name included, for LessonPlayer's web player), then on the AUMID alone.
    if (mediaGuardOn()) {
      const known = ((lastMedia && lastMedia.sessions) || []).find((s) => sameAumid(s.aumid, aumid));
      if (isLessonPlayer(known || { aumid })) return { ok: false, action, aumid, reason: `${LESSONPLAYER_GUARD_REASON}. ${LESSONPLAYER_GUARD_HOW}.` };
    }
    const args = { op: 'control', action, aumid };
    if (action === 'seek') args.positionMs = Number(a && a.positionMs);
    let r;
    try {
      r = await sidecar.call('media', args);
    } catch (err) {
      return {
        ok: false,
        action,
        aumid,
        reason: Sidecar.isOldExeError(err)
          ? 'this sidecar exe has no "media" command yet, so nothing can be played or paused (run npm run build:sidecar)'
          : err.message,
      };
    }
    // The watch will report the change too; this makes the card catch up without waiting for it.
    mediaPush(`media ${action} was sent`);
    return r && typeof r === 'object' ? r : { ok: true, action, aumid, reason: null };
  },

  // Not part of the original four-lane contract: the desktop page needs to know
  // whether Mission Control is up AND why it is not, and a fetch() from a file://
  // page can only ever report "Failed to fetch". Loopback only; see lib/net-probe.js.
  'net.probe': async (a) => probe((a && a.url) || ''),
};

// A command that answers ok:false is a failure the page will show as a chip -- a 56 px pip in
// pill mode, which nobody reads. It goes to the log too, so "I clicked and nothing happened" can
// be answered from the log (2026-09-21) -- ONCE per command and arguments until the reason
// changes or it recovers (lib/call-log.js; a 30 s probe of a service that is not running wrote
// 436 identical lines in a morning). state./sys. answers are shown by their own pages, and
// qs.set writes a line of its own for every attempt.
const callLog = createCallLog({
  write: (line) => process.stdout.write(line + '\n'),
  skip: (name) => /^(state|sys)\./.test(name) || name === 'qs.set',
});
const qsSetLog = createSetLog({ write: (line) => process.stdout.write(line + '\n') });

const nodeUrl = require('url');
// <mainrel:ipcguard> (lib/main-rel.test.js runs this region with fake events and contents: no outside names in it but path and nodeUrl)
/*
 * WHO MAY ASK MAIN FOR ANYTHING, AND WHAT THEY MAY ASK (lane core-main, 2026-09-29).
 *
 * window.mantle (preload.js) is handed to every page that loads with the preload, and until this
 * was written main answered ANY caller: it never looked at who was asking. The question it now
 * asks is "what can a page that has been fooled -- a window title or file name that got rendered
 * as HTML, a page that navigated itself somewhere -- make Mantle do?", and the answers are:
 *   - only Mantle's OWN pages are answered: a frame whose address is a file inside <ROOT>/ui.
 *     A page that navigated to the web (or anywhere else) is refused, and no Mantle window can be
 *     navigated away from ui/ or open a new window in the first place (guardContents, below).
 *     MEASURED before: the desktop page mounts Mission Control (http://127.0.0.1:7373) in an
 *     iframe with no sandbox, and a frame like that can navigate the top window once it has had
 *     a click -- which would have handed that page window.mantle.
 *   - `open` opens Windows Settings pages and web links, nothing else. It used to hand any
 *     string to shell.openExternal / shell.openPath: any protocol handler, any program on disk,
 *     any file on a network share (\\host\share\x.exe) was one call away.
 *   - a window handle is a positive whole number or it is refused here, before the sidecar.
 * And the log never carries a caller's own words (logSafe): a failure's reason often repeats
 * what the page sent -- a Wi-Fi name, a file path -- and call-log.js only masks the ARGUMENTS.
 */
function isMantlePage(pageUrl, uiDir) {
  const u = typeof pageUrl === 'string' ? pageUrl : '';
  if (!uiDir || !/^file:\/\/\//i.test(u)) return false;       // file:///C:/...; file://host/share is a network path
  let p;
  try { p = nodeUrl.fileURLToPath(u); } catch (_) { return false; }   // encoded '/' or '\' is refused by Node itself
  const rel = path.relative(path.resolve(uiDir), path.resolve(p));  // case-insensitive on Windows
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** A main-frame navigation a Mantle window may make: to another ui/ page (a reload), or DevTools. */
function navigationVerdict(toUrl, uiDir) {
  const u = typeof toUrl === 'string' ? toUrl : '';
  if (isMantlePage(u, uiDir) || /^devtools:/i.test(u)) return { ok: true, why: null };
  const scheme = (/^([a-z][a-z0-9+.-]*):/i.exec(u) || [])[1];
  return { ok: false, why: `a Mantle window tried to leave its own page for ${scheme ? `a ${scheme.toLowerCase()}: address` : 'an address with no scheme'}, and was kept where it was` };
}

// ms-settings:<page>[?query], the Windows Wi-Fi list, and web links (lib/open-target.js opens those in
// Owen's own browser). Everything the bar and its panels open is one of these (ui/bar/*.js, 2026-09-29).
const OPEN_ALLOWED = [/^ms-settings:[a-z0-9-]*(\?[a-z0-9=&%._-]*)?$/i, /^ms-availablenetworks:$/i, /^https?:\/\/[^\s"'<>\\]+$/i];
function openTargetVerdict(target) {
  const t = typeof target === 'string' ? target.trim() : '';
  if (!t) return 'nothing to open: no address was given';
  if (t.length > 2048) return 'that address is too long to be a Settings page or a web link';
  if (OPEN_ALLOWED.some((re) => re.test(t))) return null;
  return 'Mantle only opens Windows Settings pages and web links from here, and this was neither';
}

/** A window handle as the sidecar reads it (decimal text), or null when it is not one. */
function hwndArg(v) {
  if (typeof v === 'number') return Number.isSafeInteger(v) && v > 0 ? String(v) : null;
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return /^[0-9]{1,19}$/.test(s) && /[1-9]/.test(s) ? s.replace(/^0+/, '') : null;
}

/*
 * The log's copy of a reason, with every string the CALLER sent replaced by its length. A search
 * text, a Wi-Fi name, a file path: whatever a page passed in comes back inside "could not connect
 * to <name>" and "it is gone from disk: <path>", and the page may show that, the log may not.
 * Keys whose values are Mantle's own words (a mode, an action) stay, as in lib/call-log.js.
 */
const LOG_SAFE_KEYS = new Set(['mode', 'kind', 'action', 'lane', 'corner', 'combo', 'side', 'state', 'level', 'what', 'via', 'verb', 'url', 'part', 'op', 'button', 'who', 'key']);
function logSafe(args, text) {
  let s = typeof text === 'string' ? text : (text === undefined || text === null ? '' : String(text));
  if (!s || !args || typeof args !== 'object') return s;
  const vals = [];
  const walk = (o, depth) => {
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (typeof v === 'string') { if (v.length >= 3 && !LOG_SAFE_KEYS.has(k)) vals.push(v); }
      else if (v && typeof v === 'object' && depth < 2) walk(v, depth + 1);
    }
  };
  try { walk(args, 0); } catch (_) { return s; }
  vals.sort((a, b) => b.length - a.length);                    // "C:\a\b.txt" before "b.txt"
  for (const v of vals) s = s.split(v).join(`<${v.length} chars>`);
  return s;
}
/** What call-log.js gets to see of a result: the same object, its reason made log-safe. */
function logView(args, result) {
  if (!result || typeof result !== 'object' || result.ok !== false || typeof result.reason !== 'string') return result;
  return Object.assign({}, result, { reason: logSafe(args, result.reason) });
}

/*
 * Every Mantle window, whoever creates it (main.js, lib/windows.js, lib/features/*, lib/wallpaper.js,
 * lib/switcher.js): its main frame stays on Mantle's own pages and it opens no windows of its own.
 * Several feature windows already did this for themselves; this makes it true of all of them,
 * including the bar, the launcher and the desktop, which did not. `say` gets one line per refusal
 * (the scheme only, never the address).
 */
function guardContents(contents, uiDir, say) {
  if (!contents || typeof contents.on !== 'function') return false;
  let type = 'window';
  try { if (typeof contents.getType === 'function') type = contents.getType(); } catch (_) { /* treat as a window */ }
  if (type !== 'window') return false;                          // the PDF viewer's guest, DevTools' own frames
  contents.on('will-navigate', (e, maybeUrl) => {
    const to = typeof maybeUrl === 'string' ? maybeUrl : (e && e.url) || '';
    const v = navigationVerdict(to, uiDir);
    if (v.ok) return;
    try { e.preventDefault(); } catch (_) { /* nothing to stop */ }
    say(`mantle: ${v.why}\n`);
  });
  contents.on('will-redirect', (e, maybeUrl, _inPlace, mainArg) => {
    const to = typeof maybeUrl === 'string' ? maybeUrl : (e && e.url) || '';
    const main = e && typeof e.isMainFrame === 'boolean' ? e.isMainFrame : mainArg !== false;
    if (!main) return;                                          // an iframe's own redirects are its business
    const v = navigationVerdict(to, uiDir);
    if (v.ok) return;
    try { e.preventDefault(); } catch (_) { /* nothing to stop */ }
    say(`mantle: ${v.why} (a redirect)\n`);
  });
  if (typeof contents.setWindowOpenHandler === 'function') {
    contents.setWindowOpenHandler((d) => {
      const scheme = (/^([a-z][a-z0-9+.-]*):/i.exec((d && d.url) || '') || [])[1];
      say(`mantle: a Mantle page asked to open a new window (${scheme ? `${scheme.toLowerCase()}:` : 'no address'}); Mantle pages open none\n`);
      return { action: 'deny' };
    });
  }
  return true;
}

/** Is this IPC event from one of Mantle's own pages? {ok, why}; why names the scheme, never the address. */
function callerVerdict(e, uiDir) {
  const frame = e && e.senderFrame;
  let u = '';
  try { u = frame ? String(frame.url || '') : ''; } catch (_) { u = ''; }
  if (!frame) return { ok: false, why: 'the page that asked is already gone' };
  if (isMantlePage(u, uiDir)) return { ok: true, why: null };
  const scheme = (/^([a-z][a-z0-9+.-]*):/i.exec(u) || [])[1];
  return { ok: false, why: `Mantle only answers its own pages, and this one is ${scheme ? `a ${scheme.toLowerCase()}: page` : 'not a page Mantle loaded'}` };
}
// </mainrel:ipcguard>

const UI_DIR = path.join(ROOT, 'ui');
const refusedCallers = new Set();       // one line per refused caller kind, not one per call
function refuseCaller(v, what) {
  const key = `${what}|${v.why}`;
  if (refusedCallers.has(key) || refusedCallers.size > 50) return;
  refusedCallers.add(key);
  process.stderr.write(`mantle: refused ${what}: ${v.why}\n`);
}
app.on('web-contents-created', (_e, contents) => {
  guardContents(contents, UI_DIR, (line) => process.stderr.write(line));
});

ipcMain.handle('mantle:call', async (e, name, args) => {
  const who = callerVerdict(e, UI_DIR);
  if (!who.ok) {
    refuseCaller(who, 'a call');
    return { ok: false, error: who.why };
  }
  if (typeof name !== 'string') return { ok: false, error: 'Mantle was asked for a command with no name' };
  const fn = Object.prototype.hasOwnProperty.call(COMMANDS, name) ? COMMANDS[name] : null;
  if (typeof fn !== 'function') return { ok: false, error: `Mantle has no command called "${name.slice(0, 60)}"` };
  const a = args && typeof args === 'object' ? args : {};
  try {
    const result = await fn(a);
    callLog.result(name, a, logView(a, result));
    return { ok: true, result: toPage(name, result) };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    callLog.threw(name, a, { message: logSafe(a, err && typeof err.logText === 'string' ? err.logText : msg) });
    return toPage(name, { ok: false, error: msg });
  }
});

// preload.js, before a page's first paint: which theme to stamp on <html>. Synchronous on purpose
// (the attribute has to be there before the first frame) and answered from memory. A page that is
// not Mantle's own gets 'light' and no other answer, like every other refused caller.
ipcMain.on('mantle:theme-now', (e, want) => {
  const who = callerVerdict(e, UI_DIR);
  if (!who.ok) {
    refuseCaller(who, 'a theme read');
    e.returnValue = 'light';
    return;
  }
  // 'look' (preload.js): the theme AND its look-sync overrides, so both are on <html> before first paint
  if (want === 'look') {
    try {
      const theme = getTheme().theme();
      e.returnValue = { theme, look: getLook().vars(theme) };
    } catch (err) {
      process.stderr.write(`mantle: a page could not be told the theme and look, so it starts light: ${err && err.message ? err.message : err}\n`);
      e.returnValue = { theme: 'light', look: {} };
    }
    return;
  }
  try { e.returnValue = getTheme().theme(); } catch (err) {
    process.stderr.write(`mantle: a page could not be told the theme, so it starts light: ${err && err.message ? err.message : err}\n`);
    e.returnValue = 'light';
  }
});

// mantle.on('state'|'windows'|...) replays the current value on subscribe, so a
// page never renders an empty first frame while it waits for a push.
ipcMain.handle('mantle:replay', async (e, name) => toPage(`replay ${String(name).slice(0, 40)}`, await replayAnswer(e, name)));
async function replayAnswer(e, name) {
  const who = callerVerdict(e, UI_DIR);
  if (!who.ok) {
    refuseCaller(who, 'a replay');
    return { has: false };
  }
  switch (name) {
    case 'state': return { has: true, payload: state.get() };
    case 'theme': return { has: true, payload: getTheme().get() };
    case 'look': return { has: true, payload: getLook().view() };
    case 'windows': return { has: true, payload: lastWindows };
    case 'launcher:visible': return { has: true, payload: !!(launcherWin && !launcherWin.isDestroyed() && launcherWin.isVisible()) };
    case 'tray': return lastTray ? { has: true, payload: lastTray } : { has: false };
    case 'media': return lastMedia ? { has: true, payload: lastMedia } : { has: false };
    case 'battery': return lastBattery ? { has: true, payload: lastBattery } : { has: false };
    case 'volume': return lastVolume ? { has: true, payload: lastVolume } : { has: false };
    case 'net': return lastNet ? { has: true, payload: lastNet } : { has: false };
    // The panel opens on this at once (bar.js keeps it); the watch fills in what moved.
    case 'qs': return qsLatest ? { has: true, payload: qsCompose(qsLatest) } : { has: false };
    case 'notifications': return notifications.replay(name);
    // The bar subscribes before it calls, and an empty first frame in a taskbar
    // looks exactly like a broken one. Build the list if nothing has yet.
    case 'bar.pinned': return { has: true, payload: lastPinned || await pinnedOnce() };
    // ms:0 -- the bar is ALREADY where it belongs, so the page should paint itself
    // arrived rather than replay a 560 ms entrance it missed.
    case 'bar.reveal': return barRevealed
      ? { has: true, payload: { why: 'the bar was already up when this page subscribed', mode: BAR_SHAPE, ms: 0 } }
      : { has: false };
    // 'wallpaper', 'wallpaper.library', 'wallpaper.pause': lib/wallpaper.js answers for its own.
    // A feature's own standing events (ctx.replay) first, then lib/wallpaper.js answers for its own.
    default: return (features && features.replay(name)) || wallpaper.replay(name);
  }
}

// ---------------------------------------------------------------------------
// The sidecar's side of the conversation.
// ---------------------------------------------------------------------------
sidecar.on('status', ({ status, reason }) => {
  state.set('sidecar', { status, reason });
  // Everything the sidecar does for us is undone (or never done) while it is not
  // running, and every one of those pieces has to say so in its OWN reason --
  // "sidecar: down" on one line and "taskbar: not started yet" on the next is
  // exactly the kind of half-truth the no-silent-failures rule is about.
  if (status !== 'ok') sidecarUnavailable(reason);
});

function sidecarUnavailable(reason) {
  state.set('tray', {
    status: 'unavailable',
    reason: `cannot read the notification area: ${reason}`,
    watch: 'off',
    watchReason: `the Windows taskbar is not being watched, so it can come up over Mantle's bar: ${reason}`,
  });
  if (flags.test) return;   // in test mode the shell pieces are deliberately untouched anyway
  state.set('taskbar', { autohide: false, reason: `the Windows taskbar is untouched and still where Owen put it: ${reason}` });
  state.set('workarea', { reserved: false, reason: `Mantle's bar is not registered as an app bar, so maximised windows will sit under it: ${reason}` });
  state.set('desktop', {
    attached: false,
    mode: null,
    // held hidden until it is under the icons (or not made yet: the sidecar starts first), so not floating
    reason: !flags.desktop ? '--no-desktop: the desktop layer was not created'
      : !desktopWin || desktopHeld(desktopWin) ? `the desktop layer is waiting, hidden, to go under the icons: ${reason}`
        : `the desktop layer is floating instead of sitting under the wallpaper: ${reason}`,
  });
  state.set('hotkey', { winTap: false, reason: `the Win key still opens the Windows Start menu: ${reason}` });
  if (state.get().edgeclip.on) {
    state.set('edgeclip', { applied: false, reason: `the cursor is not confined, so the Windows taskbar can slide up through the island's gaps: ${reason}` });
  }
  if (state.get().tbhide.on) {
    // The sidecar's guard process clears the taskbar's empty region the moment
    // the sidecar dies, so "not hidden" is the truth here, not a guess.
    state.set('tbhide', { applied: false, reason: `the Windows taskbar is visible again (the sidecar's guard clears its region when the sidecar stops): ${reason}` });
  }
}

/**
 * What test mode is NOT doing, said out loud at boot rather than after the
 * sidecar says hello -- these four are true whether or not it ever does.
 */
function testShellBaseline() {
  state.set('taskbar', { autohide: false, wasAutohide: null, reason: 'test mode: the Windows taskbar was left exactly as it is' });
  state.set('tray', {
    watch: 'off',
    // NOT "passive would refuse it": the sidecar allows traywatch in passive
    // (it only ever raises the caller's OWN window). It is simply not asked for,
    // because a test run's bar is an ordinary framed window that has no business
    // outranking Owen's real taskbar while he is working.
    watchReason: 'test mode: the sidecar was not asked to watch the Windows taskbar, so the real taskbar sits above the test bar as it should',
  });
  state.set('workarea', { reserved: false, reason: 'test mode: no app bar was registered, so no screen space was reserved' });
  state.set('desktop', {
    attached: false,
    mode: null,
    reason: flags.desktop
      ? 'test mode: the desktop window is an ordinary window, not reparented under the wallpaper'
      : '--no-desktop: the desktop layer was not created',
  });
  state.set('hotkey', { winTap: false, reason: 'test mode: the Win key hook was not installed' });
  state.set('tbhide', { on: false, applied: false, reason: 'test mode: the Windows taskbar was not made invisible (the passive sidecar refuses tbhide)' });
  state.set('edgeclip', {
    on: false,
    applied: false,
    // A test run must never take the bottom row of the screen away from whoever
    // is at the machine, so this is one more thing test mode deliberately does
    // not do -- and the island's gaps are therefore unprotected in a test run.
    reason: 'test mode: the cursor was not confined, so the real Windows taskbar can still pop up at the bottom edge',
  });
}

sidecar.on('ready', () => {
  // The shell changes are applied only once the sidecar has actually said hello;
  // firing them at spawn time would race its startup.
  // The first pinned build usually runs before this and fails on 'windows'; without a
  // change in the window set it would never be retried on a quiet desktop (seen live).
  schedulePinnedPush('the sidecar is ready');
  applyMode().catch((err) => {
    state.set('sidecar', { status: 'down', reason: `Mantle could not set itself up: ${err.message}` });
  });
});

/*
 * A STORE APP WAS UPDATED (storeicons, 2026-10-08). The sidecar re-checks a cached Store app's
 * package (sidecar/Apps.cs) and, when an update brought a new picture or name, says so here. Two
 * caches on this side would keep the old one: the pinned list (pinsCache, re-read every 5 minutes,
 * whose Store pins carry the sidecar's picture) and the bar's iconFor cache (re-asked every 60 s).
 * Drop both for that app and push the bar again, so the new icon shows now. The launcher's
 * G.icons re-asks the sidecar at its ten-minute rebuild with the old picture showing meanwhile,
 * and the sidecar answers the new one from then on (lib/launcher-index.js).
 */
sidecar.on('appchanged', (msg) => {
  const aumid = msg && typeof msg.aumid === 'string' ? msg.aumid : '';
  if (aumid) iconCache.delete((APPS_FOLDER + aumid).toLowerCase());
  pinsCache = null;
  schedulePinnedPush('a Store app was updated, so its new icon is shown');
});

sidecar.on('windows', (msg) => {
  lastWindows = withoutMantle(msg.list);
  broadcast('windows', lastWindows);
  // A preview whose window has closed draws nothing but still holds its box; drop it now and
  // tell the flyout which cards lost their window (it says so in the card, then rebuilds).
  if (thumbs.count()) {
    const gone = thumbs.prune(new Set(lastWindows.map((w) => String(w.hwnd))));
    if (gone.length) broadcast('bar.thumbs.gone', { hwnds: gone });
  }
  // The same change, in the shape the hover bar draws: which apps are running,
  // which of them a pin already covers, and which window is in front.
  schedulePinnedPush('the running windows changed');
});

/*
 * 'traywatch': the sidecar telling us the Windows taskbar just came up or went
 * away, having already re-raised OUR bar above it.
 *
 * Mantle does NOTHING to the taskbar here -- not a ShowWindow, not a SetWindowPos
 * on Shell_TrayWnd, not a registry key. The sidecar raises Mantle's own window;
 * Windows' taskbar is untouched and stays exactly as available as it was. This
 * handler exists to make the mechanism visible, once per change, and no more.
 */
let lastTrayWatchVisible = null;
function onTrayWatchEvent(msg) {
  const visible = !!(msg && msg.visible);
  if (visible === lastTrayWatchVisible) return;   // once per CHANGE, not per event
  lastTrayWatchVisible = visible;
  const rect = msg && Array.isArray(msg.rect) ? ` at ${JSON.stringify(msg.rect)}` : '';
  process.stdout.write(`mantle: the Windows taskbar is ${visible ? 'up' : 'away'}${rect}; Mantle's bar was re-raised above it (the Windows taskbar itself is untouched)\n`);
}
sidecar.on('tray', onTrayWatchEvent);

/*
 * The sidecar volunteering that the 2 px cursor clip went away under it -- a
 * fullscreen app took the screen, or another process claimed the cursor. Windows
 * does that on its own; the sidecar is reporting, not failing. It goes straight
 * into State so the bar can show a chip the moment the island's gaps stop being
 * protected, instead of Owen finding out when a taskbar slides through them.
 */
sidecar.on('edgeclip', (msg) => {
  const applied = !!(msg && msg.applied);
  const said = (msg && msg.reason) || (applied ? 'the sidecar re-applied it' : 'the sidecar did not say why');
  state.set('edgeclip', {
    applied,
    reason: applied
      ? `the cursor stops 2 px short of the bottom row (${said})`
      : `the 2 px edge clip is not in force, so the Windows taskbar can slide up through the island's gaps: ${said}`,
  });
  process.stdout.write(`mantle: edge clip ${applied ? 'back on' : 'yielded'}: ${said}\n`);
});

/*
 * 'tbhide': the sidecar saying the Windows taskbar's invisibility changed -- a
 * new taskbar window (Explorer restart, a new monitor) got its empty region, one
 * would not take it, another program shaped it, or the guard had to be replaced.
 * Once per change, with the sidecar's own reason.
 */
sidecar.on('tbhide', (msg) => {
  const applied = !!(msg && msg.applied);
  const said = (msg && msg.reason) || (applied ? 'the sidecar re-applied it' : 'the sidecar did not say why');
  const guard = msg && msg.guard ? `; guard ${msg.guard}` : '';
  state.set('tbhide', { applied, reason: `${said}${guard}` });
  process.stdout.write(`mantle: taskbar hiding ${applied ? 'in force' : 'NOT in force'}: ${said}${guard}\n`);
});

sidecar.on('hotkey', (msg) => {
  if (msg && msg.name === 'win') toggleLauncher('the Win key');
});

sidecar.on('taskbar', (msg) => {
  // The sidecar volunteers this whenever the auto-hide flag changes under it
  // (explorer restarts, Owen changes it in Settings). Trust its word over ours.
  if (!msg || typeof msg.autohide !== 'boolean') {
    // An exe that still sends the pre-2026-09-21 {hidden:bool} shape. Reading it
    // as "not auto-hide" would put a confident wrong sentence on screen, so the
    // state says what actually happened instead.
    state.set('taskbar', {
      autohide: false,
      reason: `the sidecar sent a taskbar event in the old shape (${JSON.stringify(msg)}), so Mantle does not know the auto-hide flag: run npm run build:sidecar`,
    });
    return;
  }
  state.set('taskbar', {
    autohide: msg.autohide,
    reason: msg.reason || (msg.autohide ? 'the Windows taskbar is on auto-hide' : 'the Windows taskbar is always visible'),
  });
});

sidecar.on('restore', (msg) => {
  lastRestoreEvent = msg || { done: false };
  // The sidecar's OWN safety path ran -- stdin EOF, parent death, Ctrl+C, an
  // unhandled error inside it. That is the path that matters most, because it is
  // the one that runs when Mantle is killed, so it is also the one that has to be
  // visible rather than assumed.
  const detail = (msg && msg.detail) || 'the sidecar did not say what it put back';
  if (flags.test) {
    // A passive sidecar runs the same safety path, but it never changed anything,
    // so "Windows is back" would imply something had been done to it. Test mode's
    // whole promise is that nothing was, and the wording has to keep saying so.
    state.set('taskbar', { autohide: false, reason: `test mode: the Windows taskbar was left exactly as it is, and the sidecar confirmed it on the way out (${detail})` });
    state.set('workarea', { reserved: false, reason: `test mode: no app bar was ever registered, and the sidecar confirmed it on the way out (${detail})` });
    return;
  }
  if (msg && msg.done) {
    markRestored(`the sidecar put Windows back on its way out: ${detail}`);
    process.stdout.write(`mantle: the sidecar restored Windows on its own: ${detail}\n`);
  } else {
    markUnrestored(`the sidecar tried to put Windows back on its way out and could not: ${detail}`);
    process.stderr.write(`mantle: the sidecar could NOT restore Windows: ${detail}\n    run: ${RECOVERY_CMD}\n`);
  }
});

sidecar.on('log', (msg) => {
  const level = (msg && msg.level) || 'info';
  const raw = msg && msg.message ? String(msg.message) : '';
  /*
   * lib/sidecar.js routes unsolicited lines by their `ev` key. The traywatch
   * notification is specified as {"event":"tray",...}, and a line with neither
   * `id` nor `ev` lands here as a warning instead of reaching onTrayWatchEvent.
   * Rather than lose the event (or edit a file this lane does not own), pick it
   * back out of the warning. Costs nothing when the sidecar uses `ev`.
   */
  if (raw.includes('neither id nor ev') && raw.includes('"tray"')) {
    const at = raw.indexOf('{');
    if (at !== -1) {
      try {
        const parsed = JSON.parse(raw.slice(at));
        if (parsed && parsed.event === 'tray') { onTrayWatchEvent(parsed); return; }
      } catch (_) { /* not the whole line, or truncated at 200 chars: fall through and log it */ }
    }
  }
  const text = `[sidecar ${level}] ${raw}`;
  if (level === 'error' || level === 'warn') process.stderr.write(text + '\n');
  else process.stdout.write(text + '\n');
});

sidecar.on('died', ({ code, signal }) => {
  stopTrayPoll();
  // The bar's app-bar registration belonged to the sidecar's process; a dead
  // sidecar holds nothing, and Explorer drops an app bar whose owner is gone.
  appbarHwnd = null;
  if (flags.test) {
    // Passive: it never changed anything, so there is nothing to have restored.
    return;
  }
  if (lastRestoreEvent && lastRestoreEvent.done) {
    markRestored(`the sidecar restored Windows and then exited (${signal ? `killed by ${signal}` : `code ${code}`})`);
    return;
  }
  // It went away WITHOUT confirming. It very probably restored anyway -- its
  // safety path runs on every exit road -- but "probably" is what cost Owen a
  // reboot, so this is a state with a fix attached, not a reassurance.
  markUnrestored(`the sidecar exited (${signal ? `killed by ${signal}` : `code ${code}`}) without confirming it put Windows back`);
  process.stderr.write(`mantle: the sidecar exited without confirming the restore. If the taskbar looks wrong:\n    ${RECOVERY_CMD}\n`);
});

// ---------------------------------------------------------------------------
// Applying (or deliberately not applying) the shell changes.
// ---------------------------------------------------------------------------
async function applyMode() {
  if (flags.test) {
    testShellBaseline();
    // The same protocol-age question live mode asks, asked here too -- `ping` is
    // read-only, so a passive sidecar answers it -- because "the exe is too old
    // to keep Windows recoverable" is exactly the thing a test run should be
    // able to tell you BEFORE anyone types --live.
    const age = await sidecar.protocolAge();
    if (flags.testLiveBar) sidecarDpiAware = age.dpiAware === true ? true : (age.dpiAware === false ? false : null);
    if (!age.current) {
      state.set('sidecar', { reason: `${state.get().sidecar.reason} -- but ${age.reason}` });
      process.stderr.write(`mantle: ${age.reason}\n`);
    } else {
      process.stdout.write(`mantle: ${age.reason}\n`);
    }
    // --test-tbhide: the live start's taskbar-hiding path (asked as soon as the sidecar is ready,
    // retried the same way), against the test's stand-in window only. Not awaited: the tray
    // probe below must not decide when it is asked.
    if (flags.testTbhide) applyTaskbarHide({ fresh: true }).catch(() => {});
    // One probe, not a poll: the tray list is worth knowing about in a test run,
    // but a five-second poll is not worth the CPU for a window nobody is watching.
    // Up to three TRIES of that one probe (2026-09-22): on a loaded machine the first
    // answer came 2.9 s after its 8 s timeout and was dropped, and a single miss left
    // the whole screenshot run with no tray. Not in the background: glass waits, as before.
    let trayErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const list = await sidecar.call('tray');
        lastTray = trayForBar(list);
        state.set('tray', { status: 'ok', reason: `test mode: probed once, ${lastTray.length} notification-area items (not polled)${attempt > 1 ? `; it took ${attempt} tries` : ''}` });
        broadcast('tray', lastTray);
        trayErr = null;
        break;
      } catch (err) {
        trayErr = err;
        if (attempt < 3) await wait(2000);
      }
    }
    if (trayErr) state.set('tray', { status: 'unavailable', reason: `${trayErr.message} (test mode: probed three times, not polled)` });
    // Glass runs in test mode too: it only ever touches Mantle's own two windows,
    // so passive allows it, and a test run is the only place this lane can see
    // whether it worked at all.
    await applyGlass();
    return;
  }

  // A throw part-way through applyLive used to cost the glass and the tray poll as well (the
  // shell-unset item, lane mn-wake 2026-10-12): they still run, and the error still reaches the
  // 'ready' handler, which says so.
  let liveErr = null;
  try { await applyLive(); } catch (err) { liveErr = err; }
  try { await applyGlass(); } finally { startTrayPoll(); }
  if (liveErr) throw liveErr;
}

/*
 * GLASS: the bar and the launcher get a Windows blur-behind backdrop.
 *
 * WHY NOT Electron's `backgroundMaterial: 'acrylic'`, which this file used for
 * about an hour on 2026-09-21: that is DWM's SYSTEM BACKDROP, and Windows draws a
 * system backdrop only on the ACTIVE window. The bar is `focusable: false` and is
 * never active by design; the launcher is inactive most of the time. Both showed
 * the solid fallback nearly always -- "it doesnt look glass ui like at all". The
 * API was doing exactly what it documents, on two windows that can never satisfy
 * it.
 *
 * The sidecar's `glass` command uses SetWindowCompositionAttribute blur-behind
 * instead, which does not care whether the window is active. It changes nothing
 * outside our own two windows, so it is allowed in passive mode and runs in
 * --test too -- which is the only way this lane can see it work at all.
 */
// A light frost, not a dark one: the page fill supplies the dark tone (--pane-glass-thin),
// the DWM tint supplies the milkiness. '#1C1E2240' (dark) over a dark wallpaper read as a
// solid strip live on 2026-09-21; a white accent at 38 % on the same window proved the
// blur-behind was working all along.
// ...and then a 15 % WHITE frost over a bright browser page turned the bar light grey and
// washed the labels out. Dark frost at 50 % keeps the bar dark whatever is behind it while
// the blurred colour still comes through; the .42 page fill does the rest.
// ...and 50 % dark was still "not transparent, like way more" (Owen, 14:31). 15 % dark:
// the blur does the work, the page fill is .20, the labels carry a drop shadow.
// ...and on 2026-09-21, with the hover bar, the whole look flipped: LIGHT frosted
// glass, the Northwind site's nav pill -- white over a blur, dark ink text. So the DWM
// tint is 40 % WHITE and the renderer paints a ~55 % white fill on top of it; the
// two together are the ~68 % white the design calls for, with the blur still
// carrying the colour of whatever is behind the bar.
// ...and 40 % white was "more glass ui like and less white" away from what he
// wanted -- the wallpaper behind the island has to READ through it. 35 %, with
// lane B's CSS fill down to .20: the blur still does the work, the colour behind
// it still comes through.
/*
 * GLASS_TINT is GONE (2026-09-21). Every Mantle window now blurs its OWN captured
 * backdrop, because no DWM mode could give Owen what he asked for: acrylic ignores
 * the alpha in its tint (a fixed, near-opaque frost) and blur-behind paints a black
 * slab -- both measured live. A tint constant that no call passes any more would
 * only be a thing to wonder about, so it is deleted rather than left at 0.
 */
// Whether the running sidecar reports rectangles in physical pixels (set once
// applyLive has asked it); the popover resize needs it to pick its placement path.
let sidecarDpiAware = null;

// Has the first glass pass run? A page's FIRST did-finish-load is not a reload,
// and calling it one produced "the launcher reloaded and its glass could not be
// put back" before anything had ever been applied -- a true sentence about the
// wrong event. applyGlass() owns the first application; reapplyGlass only ever
// speaks about what happens after it.
let glassPassDone = false;

/**
 * Ask for glass on both windows and record ONE honest answer for the pair.
 * Never throws: no glass is a look, not a failure, and it has to be a look with
 * a reason attached rather than a mystery.
 */
async function applyGlass() {
  glassPassDone = true;
  if (!flags.acrylic) {
    state.set('glass', {
      material: 'none',
      reason: '--no-acrylic: the bar and launcher are plain transparent windows, so their glass is whatever lane C and lane D paint in CSS',
    });
    return;
  }

  /*
   * THE BAR GETS NO DWM GLASS AT ALL (2026-09-21, after Owen saw it live: "now
   * its kinda just black, i just wanted it a little bit more translucent").
   *
   * Measured, not guessed: DWM's acrylic IGNORES the alpha in its tint -- the
   * frost is a fixed, near-opaque amount -- and plain blur-behind paints a black
   * slab under the window. Neither has a "a little more translucent" setting, so
   * no value of GLASS_TINT was ever going to be the answer. The bar therefore
   * turns DWM off on itself (ACCENT_DISABLED) and blurs its OWN backdrop instead:
   * main captures what is behind the bar and hands the page a picture of it, and
   * the page blurs that with CSS, where translucency is an actual number.
   *
   * AND NOW THE LAUNCHER TOO (Owen: "everything that we build for this wrapper,
   * their UI needs to be this exact same theme as the taskbar"). The theme is not
   * a colour, it is this mechanism -- a live picture of the screen behind the
   * window, blurred in CSS -- so the launcher is on the same path rather than
   * being a lookalike in a different technology that drifts from it. The desktop
   * layer has no DWM glass to turn off: it sits UNDER the wallpaper, so there is
   * nothing behind it to blur but the wallpaper, which it gets as one still.
   */
  const targets = [['the bar', barWin, 'off'], ['the launcher', launcherWin, 'off']];
  const applied = [];
  const problems = [];
  let oldExe = false;

  for (const [label, win, mode] of targets) {
    if (!win || win.isDestroyed()) {
      problems.push(`${label}: its window does not exist`);
      continue;
    }
    try {
      const r = await sidecar.call('glass', { hwnd: hwndOf(win), mode });
      // For mode 'off' the question is only "did the call go through": the
      // sidecar's `applied` flag describes an effect being turned ON, and reading
      // a disable's false as a failure would put a problem on screen for the one
      // outcome we asked for.
      if (mode === 'off') applied.push(`${label} (DWM glass off: it blurs its own backdrop instead)`);
      else if (r && r.applied) applied.push(`${label} (${(r && r.mode) || 'mode not reported'})`);
      else problems.push(`${label}: the sidecar ran the glass command and reported it was not applied`);
    } catch (err) {
      if (Sidecar.isOldExeError(err)) oldExe = true;
      problems.push(`${label}: ${err.message}`);
    }
  }

  if (oldExe) {
    state.set('glass', { material: 'none', reason: 'sidecar exe predates the glass command: run npm run build:sidecar' });
    process.stderr.write('mantle: sidecar exe predates the glass command: run npm run build:sidecar\n');
    return;
  }
  if (!problems.length) {
    const corners = `${await roundBarCorners()} ${await squareCorners('the launcher', launcherWin)}`;
    state.set('glass', {
      material: 'acrylic-blur-behind',
      reason: `${applied.join(' and ')}. No window uses a DWM backdrop any more: each one captures what is behind it and blurs that in CSS, which is the only way Mantle could be translucent by a settable amount. ${corners}`,
    });
    return;
  }
  state.set('glass', {
    material: 'none',
    reason: `${problems.join('; ')}${applied.length ? ` (${applied.join(' and ')} did get it)` : ''}`,
  });
}

/**
 * Round the bar's own corners through DWM (the sidecar's `corners` command).
 *
 * A frosted pill with square corners reads as a strip of screen, not as a
 * floating bar, and CSS border-radius cannot do it: the WINDOW is what has the
 * corner, and everything outside the page's rounded box is still opaque-ish glass
 * painted by DWM. Only the bar gets it -- the launcher already reads as a panel
 * and the desktop layer has no edge to round.
 *
 * Returns a sentence for State.glass.reason either way. A missing command is a
 * look, not a failure, but it is never a MYSTERY: it says which command to build.
 */
/**
 * Turn DWM's corner rounding OFF for a window whose shape is its CSS radius.
 *
 * Same reason as the bar's: on a transparent window with no DWM glass there is
 * nothing for DWM to round, but Windows 11 still draws its 1 px window border
 * with the small rounding around the WINDOW RECT -- which shows up as a faint
 * square outline outside the page's own rounded corners.
 */
async function squareCorners(label, win) {
  if (!win || win.isDestroyed()) return `${label} has no window to square off.`;
  try {
    const r = await sidecar.call('corners', { hwnd: hwndOf(win), mode: 'none' }, 4000);
    if (r && r.ok === false) return `${label} may show Windows' own rounded border outside its CSS corners: ${r.reason || 'the sidecar did not say why'}.`;
    return `${label}'s window border is squared off, so its CSS radius is the only shape.`;
  } catch (err) {
    return Sidecar.isOldExeError(err)
      ? `${label} may show Windows' own rounded border outside its CSS corners: the sidecar exe has no "corners" command yet, so run npm run build:sidecar.`
      : `${label} may show Windows' own rounded border outside its CSS corners: ${err.message}.`;
  }
}

async function roundBarCorners() {
  if (!barWin || barWin.isDestroyed()) return 'its corners were not rounded: there is no bar window.';
  /*
   * The island's visible shape is the CSS pill (24 dip radius) on a transparent
   * window with no DWM glass, so DWM has nothing to round -- but Windows 11 still
   * draws its 1 px WINDOW BORDER around the window rect, with the small 8 px
   * rounding, and on the live capture of 2026-09-21 that showed as a faint square
   * outline sitting outside every pill corner. So: corner preference 'none' (the
   * page is the shape) and DWMWA_BORDER_COLOR none (no outline at all).
   */
  try {
    const r = await sidecar.call('corners', { hwnd: hwndOf(barWin), mode: 'none', border: 'none' }, 4000);
    if (r && r.ok === false) return `the bar may show a faint square outline: the sidecar refused "corners" (${r.reason || 'it did not say why'}).`;
    if (r && r.borderReason) return `the bar may show a faint square outline: DWM kept its window border (${r.borderReason}).`;
    return "the bar's window border is off (DWM draws no outline around the pill).";
  } catch (err) {
    return Sidecar.isOldExeError(err)
      ? "the bar's corners are SQUARE: the sidecar exe has no \"corners\" command yet, so run npm run build:sidecar."
      : `the bar's corners are square: ${err.message}.`;
  }
}

/**
 * One window asked again after a reload. Silent when the sidecar is not up yet:
 * the first load fires before it has said hello, and applyGlass() is what covers
 * that moment -- recording a failure here would be reporting our own ordering.
 */
function reapplyGlass(label, win, mode) {
  if (!flags.acrylic) return;
  if (!glassPassDone) return;            // first load: applyGlass() has this
  if (sidecar.blockedReason()) return;
  if (!win || win.isDestroyed()) return;
  // `mode` is the SAME value applyGlass() used for this window: the bar is 'off'
  // (it blurs its own backdrop) and a reload that put DWM blur-behind back on
  // it would paint the black slab Owen already rejected.
  sidecar.call('glass', { hwnd: hwndOf(win), mode }).then((r) => {
    if (mode !== 'off' && !(r && r.applied)) {
      state.set('glass', { material: 'none', reason: `${label} reloaded and the sidecar did not put its glass back` });
    }
  }).catch((err) => {
    state.set('glass', {
      material: 'none',
      reason: Sidecar.isOldExeError(err)
        ? 'sidecar exe predates the glass command: run npm run build:sidecar'
        : `${label} reloaded and its glass could not be put back: ${err.message}`,
    });
  });
}

/**
 * The exe on disk predates the commands that keep Windows recoverable. Say so in
 * every piece and change NOTHING. Half a shell applied by an exe whose restore
 * path we cannot reason about is exactly how the incident happened.
 */
function oldExeBaseline(reason) {
  const fix = `${reason}. Nothing on the Windows shell was touched.`;
  state.set('taskbar', { autohide: false, wasAutohide: null, reason: fix });
  state.set('workarea', { reserved: false, reason: fix });
  state.set('desktop', { attached: false, mode: null, reason: fix });
  state.set('hotkey', { winTap: false, reason: fix });
  process.stderr.write(`mantle: ${fix}\n`);
}

/**
 * Put the bar window exactly where the app bar was accepted.
 *
 * WHICH UNITS, and why it matters (measured on the first live run, 2026-09-21):
 * SHAppBarMessage deals in PHYSICAL pixels even when the caller is DPI-unaware,
 * but everything ELSE Windows hands an unaware process is virtualised. On Owen's
 * 125% display that is a 25% error in both directions -- the bar came out 200px
 * tall at 80% of the screen width. So:
 *
 *   dpiAware true  -> the rectangle is physical pixels; convert to DIP.
 *   dpiAware false -> the sidecar's numbers are already DIP on the primary
 *                     display; converting again would repeat the mistake.
 *   dpiAware null  -> the sidecar is too old to say, and applyLive never gets
 *                     this far, but the reason says so rather than guessing.
 *
 * Returns how it was placed, for the reason string: "the bar is in the wrong
 * place" with no explanation is a bug report nobody can act on.
 */
async function placeBar(rect, dpiAware, opts) {
  // `quiet`: the hover bar places itself on every reveal and every failed morph,
  // and a stdout line per hover would bury the lines that matter. Failures are
  // never quiet.
  const quiet = !!(opts && opts.quiet);
  const say = (line) => { if (!quiet) process.stdout.write(line); };
  if (!barWin || barWin.isDestroyed()) return { ok: false, how: 'the bar window went away before it could be moved' };
  if (!Array.isArray(rect) || rect.length !== 4 || !rect.every((n) => Number.isFinite(Number(n)))) {
    return { ok: false, how: `the sidecar did not send back a usable rectangle (${JSON.stringify(rect)}), so the bar is where Electron first put it` };
  }
  const [l, t, r, b] = rect.map(Number);
  const phys = { x: l, y: t, width: r - l, height: b - t };
  if (phys.width <= 0 || phys.height <= 0) {
    return { ok: false, how: `the app-bar rectangle came back empty (${l},${t},${r},${b}), so the bar is where Electron first put it` };
  }

  if (dpiAware === false) {
    try {
      barWin.setBounds(phys);
    } catch (err) {
      return { ok: false, how: `the app bar was accepted but the bar window would not move to it: ${err.message}` };
    }
    return { ok: true, how: 'placed from the app bar\'s rectangle as-is: the sidecar reports dpiAware:false, so Windows already virtualised its numbers into DIP for the primary display' };
  }

  if (dpiAware === true) {
    // NOT barWin.setBounds: Electron clamps a window into the WORK AREA, and the
    // app bar has just shrunk the work area by exactly the bar's own height, so
    // setBounds put the bar a bar-height above its slot every time (live,
    // 2026-09-21 14:30: window 774..818 with the work area at 820). A raw
    // SetWindowPos from the sidecar does not clamp, and Electron accepts the
    // resulting WM_WINDOWPOSCHANGED as its new bounds.
    //
    // AND THEN IT READS THE RESULT BACK (added after a code review, 2026-09-21).
    // Chromium refits a window into the work area on the FIRST move after a
    // work-area change, which is exactly the move we are making: the SetWindowPos
    // lands, Chromium immediately moves it again, and the bar ends up a
    // bar-height above its own slot with every log line claiming success. So the
    // sidecar's read-back rectangle is compared with what was asked for, and a
    // mismatch is retried once -- by then the work-area change is no longer new
    // and the second move sticks. Either way the outcome is printed, because "the
    // bar is in the wrong place" with a cheerful log above it is worse than no
    // log at all.
    const want = { x: phys.x, y: phys.y, w: phys.width, h: phys.height };
    const asked = [want.x, want.y, want.x + want.w, want.y + want.h];
    const attempt = async () => {
      const moved = await sidecar.call('place', { hwnd: hwndOf(barWin), x: want.x, y: want.y, w: want.w, h: want.h }, 4000);
      const got = moved && Array.isArray(moved.rect) && moved.rect.length === 4 ? moved.rect.map(Number) : null;
      const near = got && got.every((n) => Number.isFinite(n))
        && Math.abs(got[0] - asked[0]) <= 1 && Math.abs(got[1] - asked[1]) <= 1
        && Math.abs(got[2] - asked[2]) <= 1 && Math.abs(got[3] - asked[3]) <= 1;
      return { near, got };
    };
    try {
      let r = await attempt();
      if (!r.near) {
        process.stdout.write(`mantle: bar placement came back wrong: asked for ${JSON.stringify(asked)}, the window is at ${JSON.stringify(r.got)}; retrying once (Chromium refits a window into the work area on the first move after a work-area change)\n`);
        r = await attempt();
        if (!r.near) {
          const how = `the sidecar moved the bar to ${JSON.stringify(asked)} TWICE and it is at ${JSON.stringify(r.got)} instead -- something else is moving it`;
          process.stderr.write(`mantle: bar ${how}\n`);
          return { ok: false, how };
        }
        const how = `placed by the sidecar with SetWindowPos at physical ${JSON.stringify(r.got)}, on the second try (the first landed at the wrong rectangle)`;
        process.stdout.write(`mantle: bar ${how}\n`);
        return { ok: true, how };
      }
      const how = `placed by the sidecar with SetWindowPos at physical ${JSON.stringify(r.got)}, verified against what was asked for (Electron's own setBounds clamps the bar into the work area)`;
      say(`mantle: bar ${how}\n`);   // the strip only prints non-ok pieces; placement must be visible either way
      return { ok: true, how };
    } catch (err) {
      const how = `the bar could not be moved to ${JSON.stringify(asked)}: ${err.message}`;
      process.stderr.write(`mantle: bar ${how}\n`);
      return { ok: false, how };
    }
  }

  let dip = null;
  let how = '';
  try {
    dip = screen.screenToDipRect(null, phys);
    how = `placed from the app bar's physical-pixel rectangle with screen.screenToDipRect${dpiAware === true ? '' : ' (the sidecar did not say whether it is DPI-aware, so physical was assumed)'}`;
  } catch (err) {
    how = `screen.screenToDipRect would not run (${err.message}), so `;
  }
  if (!dip || !(dip.width > 0) || !(dip.height > 0)) {
    const sf = screen.getPrimaryDisplay().scaleFactor || 1;
    dip = {
      x: Math.round(phys.x / sf), y: Math.round(phys.y / sf),
      width: Math.round(phys.width / sf), height: Math.round(phys.height / sf),
    };
    how += `placed by dividing the sidecar's physical pixels by the primary display's scale factor (${sf})`;
  }
  try {
    barWin.setBounds(dip);
  } catch (err) {
    return { ok: false, how: `the app bar was accepted but the bar window would not move to it: ${err.message}` };
  }
  return { ok: true, how };
}

/**
 * Hover mode's placement: the bar sits on the bottom edge of the primary display,
 * full width, BAR_H tall, over everything. No app bar, so nothing has shrunk the
 * work area -- but Chromium still refits a window into the work area on its first
 * move, which is why this goes through placeBar() and its read-back rather than
 * setBounds().
 */
async function placeBottomStrip(why, dpiAware) {
  const geo = barGeometry();
  // PARKED OFF-SCREEN while hidden, not sitting at the edge. That is what makes
  // every reveal start from the same place: showInactive() puts nothing on screen
  // and the morph is the whole arrival. If the bar happens to be up when a
  // re-check fires, it goes to its resting rectangle instead of being yanked away.
  // (`win` is `rest` unless the window is tall, when it is rest plus the popover room: barTall)
  const side = barRevealed ? geo.win : geo.start;
  const r = sideRect(side);
  if (barRevealed) setBarShape(barPopover ? barPopover.height : 0, why);
  const placed = await placeBar([r.x, r.y, r.x + r.w, r.y + r.h], dpiAware, { quiet: true });
  process.stdout.write(`mantle: bar ${barRevealed ? 'resting' : 'parked off-screen'} (${why}): ${geo.shape} ${JSON.stringify(r)} -- ${placed.how}\n`);
  return placed;
}

/**
 * Ask the sidecar to keep Mantle's bar above the Windows taskbar.
 *
 * WHAT THIS IS NOT: it does not hide, move, reorder or disable the Windows
 * taskbar, and it writes nothing to the registry. The taskbar is on auto-hide --
 * an OS flag Windows itself owns -- and it answers the SAME bottom screen edge
 * Mantle's bar does, so the two surface together. The sidecar watches for that
 * and re-raises OUR window to HWND_TOPMOST. Explorer's window is untouched and is
 * exactly as available as it was before Mantle started; kill Mantle mid-hover and
 * the Windows taskbar is still there.
 *
 * Failure here is cosmetic (the taskbar may cover the bar) and so is recorded as
 * a reason rather than treated as a shell problem.
 */
/**
 * Confine the cursor 2 px short of the bottom row, so Windows' auto-hide taskbar
 * never slides up through the island's gaps.
 *
 * SAFE BY CONSTRUCTION: the clip is a ClipCursor held by the SIDECAR, which drops
 * it on every exit road it has, and Windows drops it anyway when another process
 * claims the cursor or a fullscreen app takes over. The failure mode is "the
 * mouse can reach the bottom row again", never "the mouse is stuck". That is the
 * whole reason it lives there and not here.
 *
 * In flush mode it is a nicety (the strip covers the edge itself), so a failure
 * is narrated and nothing more; in island mode it is what keeps the gaps clean,
 * so it goes in State with its reason.
 */
async function applyEdgeClip() {
  const optional = BAR_SHAPE !== 'pill';
  if (!flags.edgeclip) {
    state.set('edgeclip', { on: false, applied: false, reason: '--no-edgeclip: the cursor can reach the bottom row, so the Windows taskbar may slide up through the island\'s gaps' });
    return;
  }
  try {
    const r = await sidecar.call('edgeclip', { on: true, inset: 2 }, 4000);
    const applied = !!(r && r.applied);
    state.set('edgeclip', {
      on: true,
      applied,
      reason: applied
        ? 'the cursor stops 2 px short of the bottom row, so the auto-hide Windows taskbar stays down and the air around the island stays clean'
        : `Mantle asked for the 2 px edge clip and it is not in force, so the Windows taskbar can slide up through the island's gaps: ${(r && r.reason) || 'the sidecar did not say why'}`,
    });
  } catch (err) {
    const why = Sidecar.isOldExeError(err)
      ? 'the sidecar exe has no "edgeclip" command yet: run npm run build:sidecar'
      : err.message;
    if (optional) {
      state.set('edgeclip', { on: false, applied: false, reason: `not used: the full-width bar covers the bottom edge itself, and the clip was unavailable anyway (${why})` });
      process.stdout.write(`mantle: the 2 px edge clip was not applied, which only matters for the island shape: ${why}\n`);
      return;
    }
    state.set('edgeclip', { on: true, applied: false, reason: `the Windows taskbar can slide up through the island's gaps: ${why}` });
  }
}

/** Give the cursor the bottom row back. Called on the way out, before the sidecar goes. */
function releaseEdgeClip(why) {
  if (!flags.edgeclip || flags.test || flags.dock) return Promise.resolve();
  if (sidecar.blockedReason()) return Promise.resolve();
  return sidecar.call('edgeclip', { on: false }, 3000).then(() => {
    state.set('edgeclip', { on: false, applied: false, reason: `the cursor can reach the bottom row again: ${why}` });
  }).catch((err) => {
    // Not an emergency: the sidecar drops the clip when it dies, which is the
    // very next thing that happens. Said out loud anyway.
    process.stdout.write(`mantle: the edge clip was not released by hand (${err.message}); the sidecar drops it as it exits\n`);
  });
}

// <mainrel:tbhide> (lib/main-tbhide.test.js runs this region with a fake sidecar and clock)
/**
 * Make the Windows taskbar invisible while Mantle runs (sidecar/TaskbarHide.cs):
 * an EMPTY WINDOW REGION on Shell_TrayWnd / Shell_SecondaryTrayWnd. Explorer
 * keeps running it -- the tray, Win+number and its auto-hide machine are
 * untouched -- but the reveals a foreground change triggers draw nothing.
 *
 * The sidecar refuses to set a region until its guard process is armed, so a
 * sidecar killed any way at all cannot leave the taskbar invisible. Called on
 * every sidecar 'ready' ({fresh: true}: a new sidecar starts the retries over),
 * so a restarted sidecar picks it straight back up.
 */
async function applyTaskbarHide(opts) {
  if (!flags.tbhide) {
    state.set('tbhide', { on: false, applied: false, reason: '--no-tbhide: the Windows taskbar can show when Explorer reveals it (a foreground change, a flashing app, the Win key)' });
    return;
  }
  if (opts && opts.fresh) {
    if (tbhideRetry) { clearTimeout(tbhideRetry); tbhideRetry = null; }
    tbhideTries = 0;
  }
  try {
    const r = await sidecar.call('tbhide', { on: true }, 9000);
    const applied = !!(r && r.applied);
    const said = (r && r.reason) || 'the sidecar did not say why';
    const guard = r && r.guard ? `; guard ${r.guard}` : '';
    // How long after the sidecar's ready line: the number a slow start is judged by.
    const since = applied && sidecar.readyAt ? ` (${((Date.now() - sidecar.readyAt) / 1000).toFixed(1)} s after the sidecar was ready)` : '';
    const again = applied ? (tbhideTries = 0, '') : retryTaskbarHide();
    state.set('tbhide', { on: true, applied, reason: `${said}${guard}${again}` });
    process.stdout.write(`mantle: taskbar hiding ${applied ? 'in force' : 'NOT in force'}: ${said}${guard}${since}${again}\n`);
  } catch (err) {
    const old = Sidecar.isOldExeError(err);
    const why = old
      ? 'the sidecar exe has no "tbhide" command yet: run npm run build:sidecar'
      : err.message;
    const again = old ? '' : retryTaskbarHide();
    state.set('tbhide', { on: true, applied: false, reason: `the Windows taskbar can show when Explorer reveals it: ${why}${again}` });
    process.stdout.write(`mantle: taskbar hiding NOT in force: ${why}${again}\n`);
  }
}

/*
 * A refused tbhide is retried instead of left off for the whole run. The FIRST tries
 * are quick (2026-10-01): the go-lives of 2026-09-30 17:56 and 2026-10-01 13:28 missed
 * the guard's arming window and the old first retry came 15 s later, so the Windows
 * taskbar showed for those 15 s. The guard now starts with the sidecar and is kept while
 * it starts (TaskbarHide.cs), so asking again every second for the first ~10 s puts the
 * hiding in force within ~1 s of the guard arming; each ask holds the sidecar's ui lane
 * for at most 1 s. Then 2 s, 4 s, 8 s, 15 s, 45 s, 2 min, and every 5 min after that.
 * Never in test mode (but --test-tbhide), never once quitting. Returns the note for the
 * reason line.
 */
const TBHIDE_RETRY_MS = [1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 2000, 4000, 8000, 15000, 45000, 120000];
let tbhideRetry = null, tbhideTries = 0, tbhideQuitting = false;
function retryTaskbarHide() {
  if (!flags.tbhide || (flags.test && !flags.testTbhide) || tbhideQuitting) return '';
  if (tbhideRetry) return '; trying again soon';
  const ms = TBHIDE_RETRY_MS[tbhideTries] || 300000;
  tbhideTries++;
  tbhideRetry = setTimeout(() => { tbhideRetry = null; if (!tbhideQuitting) applyTaskbarHide(); }, ms);
  if (tbhideRetry.unref) tbhideRetry.unref();
  return `; trying again in ${Math.round(ms / 1000)} s (attempt ${tbhideTries + 1})`;
}

/** Let the Windows taskbar draw again. Called on the way out, before the sidecar goes. */
function releaseTaskbarHide(why) {
  tbhideQuitting = true;
  if (tbhideRetry) { clearTimeout(tbhideRetry); tbhideRetry = null; }
  if (!flags.tbhide || (flags.test && !flags.testTbhide)) return Promise.resolve();
  if (sidecar.blockedReason()) return Promise.resolve();
  return sidecar.call('tbhide', { on: false }, 3000).then((r) => {
    const said = (r && r.reason) || 'released';
    state.set('tbhide', { on: false, applied: false, reason: `the Windows taskbar draws again: ${why} (${said})` });
    process.stdout.write(`mantle: taskbar hiding off: ${said} (${why})\n`);
  }).catch((err) => {
    // Not an emergency: the sidecar clears it on every exit road, and its guard
    // clears it if the sidecar dies. Said out loud anyway.
    process.stdout.write(`mantle: the taskbar region was not cleared by hand (${err.message}); the sidecar and its guard clear it as it exits\n`);
  });
}
// </mainrel:tbhide>

// A "traywatch" that times out is retried: the sidecar's one command thread is
// often backed up for several seconds right after start (every piece asks for
// something at once), and a single 4 s attempt lost the watch for the whole run
// (2026-09-22). A refusal or an old exe is not retried -- asking again changes
// nothing.
const TRAYWATCH_RETRY_MS = [10000, 30000, 60000];
let trayWatchRetry = null;

async function armTrayWatch(attempt = 0) {
  if (trayWatchRetry) { clearTimeout(trayWatchRetry); trayWatchRetry = null; }
  if (shuttingDown) return;
  if (!barWin || barWin.isDestroyed()) {
    state.set('tray', { watch: 'off', watchReason: 'there is no bar window to keep above the Windows taskbar' });
    return;
  }
  try {
    const r = await sidecar.call('traywatch', { hwnd: hwndOf(barWin) }, 4000);
    if (r && r.ok === false) {
      state.set('tray', { watch: 'off', watchReason: `the sidecar refused to watch the Windows taskbar, so it can come up over Mantle's bar: ${r.reason || 'it did not say why'}` });
      return;
    }
    if (r && r.watching === false) {
      state.set('tray', { watch: 'off', watchReason: "the sidecar accepted \"traywatch\" but reported it is not watching, so the Windows taskbar can come up over Mantle's bar" });
      return;
    }
    state.set('tray', { watch: 'on', watchReason: "the sidecar re-raises Mantle's bar whenever the Windows taskbar pops up on the same bottom edge (the Windows taskbar itself is never hidden, moved or reordered)" });
    process.stdout.write('mantle: traywatch armed on the bar window\n');
  } catch (err) {
    const oldExe = Sidecar.isOldExeError(err);
    const wait = oldExe ? null : TRAYWATCH_RETRY_MS[attempt];
    state.set('tray', {
      watch: 'off',
      watchReason: oldExe
        ? "the sidecar exe has no \"traywatch\" command yet, so the auto-hide Windows taskbar can come up OVER Mantle's bar: run npm run build:sidecar"
        : `the Windows taskbar is not being watched, so it can come up over Mantle's bar: ${err.message}` +
          (wait ? ` (trying again in ${wait / 1000} s)` : ` (gave up after ${attempt + 1} tries)`),
    });
    if (wait) {
      trayWatchRetry = setTimeout(() => armTrayWatch(attempt + 1), wait);
      if (trayWatchRetry.unref) trayWatchRetry.unref();
    }
  }
}

// Whatever "put the bar back where it belongs" means in the mode we are in.
// ONE function, replaced (not accumulated) every time applyLive runs, and ONE
// screen listener registered at boot that calls it -- the old code added a fresh
// display-metrics-changed listener on every sidecar restart, so a shell that had
// restarted its sidecar five times re-placed the bar five times per display change.
let rePlaceBar = null;

// <mainrel:burst> (lib/main-rel.test.js runs this region with a fake clock: no outside names in it)
/*
 * Leading + trailing coalescing for events that come in bursts (display changes): the first runs
 * at once (the bar never waits), anything more inside quietMs becomes ONE more run after the burst,
 * with every reason it swallowed. A DPI change used to re-place the bar once per event.
 */
function makeBurst(run, o) {
  const quiet = (o && o.quietMs) || 400;
  let timer = null;
  let pending = [];
  let hot = false;
  function settle() {
    timer = null;
    if (pending.length) {
      const why = pending.length === 1 ? pending[0] : `${pending.length} changes: ${Array.from(new Set(pending)).join(', ')}`;
      pending = [];
      try { run(why); } catch (_) { /* the next event tries again */ }
      timer = o.setTimeout(settle, quiet);         // stay hot until a full quiet gap with nothing new
      return;
    }
    hot = false;
  }
  return function fire(why) {
    if (!hot) {
      hot = true;
      try { run(why); } catch (_) { /* the trailing run tries again */ }
      timer = o.setTimeout(settle, quiet);
      return 'now';
    }
    pending.push(why);
    if (timer) o.clearTimeout(timer);
    timer = o.setTimeout(settle, quiet);
    return 'later';
  };
}
// </mainrel:burst>

/*
 * THE DESKTOP LAYER FOLLOWS THE DISPLAY (lane mn-display, 2026-10-12). It was sized once, from the
 * display Mantle started on; a resolution change left it at the old size. Each display burst sizes
 * it to the main display through the sidecar (physical px, mapped into the window it is a child of)
 * BEFORE the picture is retaken, and a layer held hidden on its way under the icons is sized when
 * it gets there, before it is shown (attachDesktop). Never shown from here. lib/display-fit.js.
 */
const desktopFit = require('./lib/display-fit').makeDesktopFit({
  win: () => desktopWin,
  held: (w) => desktopHeld(w),
  test: () => !!flags.test,
  paused: () => !!shellPaused,
  hwndOf,
  sidecar,
  screen,
  page: (w) => w.webContents.executeJavaScript('({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio })', true),
  log: (t) => process.stdout.write(`mantle: desktop layer: ${t}\n`),
  setState: (p) => state.set('desktop', p),
});

/*
 * THE FIRST PING, ASKED AGAIN (the shell-unset item; lane mn-wake, 2026-10-12). One slow answer right
 * after the sidecar starts (a loaded logon) came back from protocolAge() as current:false, which
 * applyLive read as "the exe is too old": the taskbar, the Win key and the desktop layer stayed
 * Windows' for the whole session. Only an exe that ANSWERED too old is final; no answer is asked
 * again at 2, 5 and 15 s (lib/start-wake.js pingVerdict), with nothing of Windows' touched meanwhile
 * and the state strip saying so. -> the age to act on, or null if this ask was superseded.
 */
let protocolAskGen = 0;
async function askProtocolAge() {
  const gen = ++protocolAskGen;
  const stale = () => gen !== protocolAskGen || shuttingDown || !!shellPaused;
  for (let n = 0; ; n++) {
    const age = await sidecar.protocolAge();
    if (stale()) return null;
    const v = StartWake.pingVerdict(age, n);
    if (v.next === 'go' || v.next === 'old') {
      if (n > 0) process.stdout.write(`mantle: the sidecar answered its ping on ask ${n + 1}: ${age.reason}\n`);
      return age;
    }
    if (v.next === 'give-up') return Object.assign({}, age, { reason: v.reason });
    process.stdout.write(`mantle: ${v.reason}\n`);
    const fix = `waiting: ${v.reason}`;
    state.set('taskbar', { autohide: false, wasAutohide: null, reason: fix });
    state.set('desktop', { attached: false, mode: null, reason: desktopHeld(desktopWin) ? `the desktop layer is waiting, hidden: ${v.reason}` : fix });
    state.set('hotkey', { winTap: false, reason: fix });
    await wait(v.waitMs);
    if (stale()) return null;
  }
}

async function applyLive() {
  // PAUSED ("Put Windows back (keep Mantle open)"): Windows stays Windows' until a restart, even
  // when the link to Windows comes back on its own. Before this, a sidecar that died and restarted
  // after a "Put Windows back" quietly took the taskbar, the Win key and Alt+Tab back.
  if (shellPaused) {
    process.stdout.write(`mantle: the link to Windows is up, but Mantle is paused (${shellPaused.why} put Windows back), so nothing of Windows' was changed\n`);
    return;
  }
  // 0. Is the exe even new enough to be trusted with the shell? The old one
  //    answers `taskbar` by looking for a `show` key, and what it does without
  //    one is not something to discover on Owen's live desktop.
  //    A ping that got NO answer is asked again (askProtocolAge), never read as an old exe.
  const age = await askProtocolAge();
  if (!age) return;   // a newer sidecar start, a quit or "Put Windows back" came while it asked again
  sidecarDpiAware = age.dpiAware === true ? true : (age.dpiAware === false ? false : null);
  if (!age.current) {
    oldExeBaseline(age.reason);
    return;
  }

  // 0b. The desktop layer goes under the icons FIRST (lane mn-wake, 2026-10-12; audit #3). It is
  //     made HIDDEN and is shown only once it is there (makeDesktopWindow holdShow), so until this
  //     lands Owen sees Windows' own wallpaper, never a full-screen layer over his apps. It used to
  //     be shown as soon as its first picture landed and go under the icons only after the taskbar,
  //     the bar, the edge clip and the taskbar hiding: ~3 s over every open app at every start.
  //     Explorer's desktop can still be getting ready at logon, so a held layer that could not go
  //     under is tried again on the Explorer-restart back-off, and closed (never shown) if it never can.
  if (!flags.desktop) {
    state.set('desktop', { attached: false, mode: null, reason: '--no-desktop: the desktop layer was not created' });
  } else if (desktopWin && !desktopWin.isDestroyed()) {
    const held = desktopHeld(desktopWin);
    const r = await attachDesktop();
    if (r.ok) { if (desktopRemake.timer) { clearTimeout(desktopRemake.timer); desktopRemake.timer = null; } }
    else if (held && desktopHeld(desktopWin)) scheduleDesktopAttach(0, false, 'at start');
  }
  // (else: Explorer took the layer down with it and desktopGone is making a new one, which
  // attaches itself; its state line already says so)

  // 1. The Windows taskbar goes to AUTO-HIDE. Not hidden -- auto-hide. This is
  //    the whole lesson of 2026-09-21: auto-hide is a flag the OS owns and can
  //    put back without help, a hidden window is a wedge only a reboot cleared.
  try {
    const r = await sidecar.call('taskbar', { mode: 'autohide' });
    const on = !!(r && r.autohide);
    const was = r && typeof r.wasAutohide === 'boolean' ? r.wasAutohide : null;
    const wasText = was === true ? 'it was already auto-hide'
      : was === false ? 'it was always visible before'
        : 'the sidecar did not say what it was before, so the restore aims at "always visible"';
    const unverified = r && r.verified === false ? ' -- the sidecar could not read the flag back to confirm it' : '';
    state.set('taskbar', {
      autohide: on,
      wasAutohide: was,
      reason: on
        ? `Windows taskbar set to auto-hide (${wasText}; the original is put back on exit)${unverified}${note()}`
        : `the sidecar ran the auto-hide command and the Windows taskbar is still always visible${note()}`,
    });
  } catch (err) {
    if (Sidecar.isOldExeError(err)) { oldExeBaseline(`the sidecar refused "taskbar auto-hide": ${err.message}`); return; }
    state.set('taskbar', { autohide: false, reason: `could not put the Windows taskbar on auto-hide, so it is untouched: ${err.message}${note()}` });
  }

  // 2. Screen space -- or, by default now, deliberately none of it.
  //
  //    HOVER (default): no app bar at all. The bar is hidden until the cursor
  //    reaches the bottom edge, so reserving a permanent strip would take screen
  //    away from every maximised window for a bar that is not on screen. The work
  //    area is the whole display because step 1 put the Windows taskbar on
  //    auto-hide.
  //
  //    --dock: the old behaviour. A REAL app bar (SHAppBarMessage): Explorer keeps
  //    maximised windows off that strip AND drops the reservation itself the
  //    moment the window dies. There is deliberately NO SPI_SETWORKAREA fallback:
  //    that one outlives the process, which is the exact property this whole
  //    redesign exists to refuse.
  if (!barWin || barWin.isDestroyed()) {
    state.set('workarea', { reserved: false, reason: 'there is no bar window, so no screen space was reserved' });
  } else if (!flags.dock) {
    state.set('workarea', {
      reserved: false,
      reason: 'hover mode: the bar reserves no screen space on purpose -- it is hidden until the cursor touches the bottom edge, and maximised windows get the whole display because the Windows taskbar is on auto-hide. Run with --dock for the old permanent strip.',
    });
    const placed = await placeBottomStrip('startup', age.dpiAware);
    startHoverWatchOnce(`the bar has its first place on screen (${placed.how})`);   // no reveal before its units are known
    setBar({ ok: true, reason: barReason(`hidden until the cursor touches the ${flags.barEdge} edge (${placed.how})`) });
    // Re-place UNCONDITIONALLY on three ticks. Not "only if something changed":
    // the failure this guards against is a move that silently did not take, and
    // that move looks identical to a move that was never needed.
    for (const [ms, why] of [[300, '300 ms after start'], [1500, '1.5 s after start'], [6000, '6 s after start']]) {
      const t = setTimeout(() => { placeBottomStrip(why, age.dpiAware).catch(() => {}); }, ms);
      if (t.unref) t.unref();
    }
    rePlaceBar = (why) => placeBottomStrip(why, age.dpiAware).catch(() => {});
    await armTrayWatch();
    // traywatch STAYS armed alongside the clip: an app flashing its taskbar
    // button can still force the Windows taskbar up whatever the cursor does.
    await applyEdgeClip();
    // ...and the reveals no clip can stop (a foreground change, a flash, the Win
    // key) are made invisible: an empty window region, guarded (TaskbarHide.cs).
    await applyTaskbarHide({ fresh: true });
  } else {
    try {
      const hwnd = hwndOf(barWin);
      // SIZE IS IN THE SIDECAR'S UNITS, not ours. A DPI-aware sidecar reads 44 as
      // 44 PHYSICAL pixels, which on Owen's 125% display is 35 DIP -- measured on
      // the live run: the bar window came back 0,1036..1080 physical, a 35pt-tall
      // bar under a 44pt-tall page. BAR_H is a DIP number (it is what lane C's CSS
      // uses), so it has to be scaled on the way out and the returned rect scaled
      // back on the way in. A DPI-unaware sidecar is already handed virtualised
      // numbers, so for it 44 means 44.
      const scale = screen.getPrimaryDisplay().scaleFactor || 1;
      const size = age.dpiAware === true ? Math.round(BAR_H * scale) : BAR_H;
      const r = await sidecar.call('appbar', { hwnd, edge: flags.barEdge, size });
      appbarHwnd = hwnd;
      const placed = await placeBar(r && r.rect, age.dpiAware);
      state.set('workarea', {
        reserved: true,
        reason: `Mantle's bar is registered as an app bar ${size}px tall${size === BAR_H ? '' : ` (${BAR_H}dip at ${scale}x)`}; Explorer keeps maximised windows off it and drops the reservation by itself if Mantle dies (${placed.how})`,
      });
      // Explorer answers ABM_QUERYPOS against the app bars it knows at that
      // instant. Restart Mantle and the previous bar's slot can still be on its
      // books for a moment, so the new bar is stacked ABOVE it; then the old one
      // is released and ours floats a bar-height over an empty strip (seen live
      // 2026-09-21 14:28: bar at 774..818 with the work area already at 820).
      // Asking again once things have settled gets the real slot; a display
      // change (scale, resolution, monitor) needs the same re-ask.
      let lastRect = JSON.stringify(r && r.rect);
      const recheck = async (why) => {
        if (!appbarHwnd || !barWin || barWin.isDestroyed()) return;
        try {
          const again = await sidecar.call('appbar', { hwnd: appbarHwnd, edge: flags.barEdge, size });
          const now = JSON.stringify(again && again.rect);
          // RE-PLACE UNCONDITIONALLY (changed after a code review, 2026-09-21).
          // The old code only moved the bar when Explorer's rectangle had CHANGED,
          // which misses the failure that actually happened: the rectangle is
          // right, the first move was silently refitted into the work area by
          // Chromium, and so the bar sits a bar-height above a correct slot and
          // every check agrees with itself. Moving to the same rectangle again is
          // free; being wrong about it cost a live run.
          const moved = await placeBar(again && again.rect, age.dpiAware);
          process.stdout.write(`mantle: app bar re-checked (${why}): slot ${now === lastRect ? `unchanged ${now}` : `${lastRect} -> ${now}`}; ${moved.how}\n`);
          lastRect = now;
        } catch (err) {
          process.stderr.write(`mantle: app bar re-check (${why}) failed: ${err.message}\n`);
        }
      };
      for (const [ms, why] of [[300, '300 ms after start'], [1500, '1.5 s after start'], [6000, '6 s after start']]) {
        const t = setTimeout(() => recheck(why), ms);
        if (t.unref) t.unref();
      }
      // NOT screen.on(...) here: applyLive runs again on every sidecar restart,
      // and this used to add one more listener each time. One listener, at boot,
      // calls whatever rePlaceBar currently is.
      rePlaceBar = (why) => recheck(why);
      await armTrayWatch();
      await applyTaskbarHide({ fresh: true });
    } catch (err) {
      if (Sidecar.isOldExeError(err)) { oldExeBaseline(`the sidecar refused "appbar": ${err.message}`); return; }
      state.set('workarea', {
        reserved: false,
        reason: `Mantle's bar could not be registered as an app bar, so maximised windows will sit under it: ${err.message}. Nothing was reserved by any other means -- the old work-area call is gone because it survived a crash.`,
      });
    }
  }

  // 3. (the desktop layer went under the icons first, above)

  // 4. The solo-Win-tap hook that opens the launcher (not while Mantle rests for a game: the
  // launcher window is closed then, and the Win key is Windows' Start until the game exits).
  if (restState && (!launcherWin || launcherWin.isDestroyed())) {
    await sidecar.call('hotkey', { winTap: false }).catch(() => {});
    state.set('hotkey', { winTap: false, resting: true, reason: `the Win key opens Windows' Start while Mantle rests (${restState.why}); Mantle's launcher is back when it exits` });
  } else try {
    const r = await sidecar.call('hotkey', { winTap: true });
    const installed = !!(r && r.installed);
    state.set('hotkey', {
      winTap: installed,
      reason: installed ? 'a tap of the Win key opens the Mantle launcher'
        : 'the sidecar did not install the Win key hook and did not say why',
    });
  } catch (err) {
    state.set('hotkey', { winTap: false, reason: `the Win key still opens the Windows Start menu: ${err.message}` });
  }

  // 5. Alt+Tab, Win+N and Win+A, on the same hook, as the tray menu's switches say (lib/switcher.js).
  await switcher.applyLive('the sidecar is up and Mantle owns the shell');

  // 6. The feature chords (Win+S, Win+V, ...), on the same hook, for every feature that is on and
  //    healthy (lib/features.js). Every sidecar start: a new sidecar process holds no chords.
  if (features) await features.applyLive('the sidecar is up and Mantle owns the shell');
}

// ---------------------------------------------------------------------------
// Keeping the desktop layer in front of a video wallpaper.
//
// progman-front puts the layer straight under the icons, above a wallpaper
// app's player (Lively's mpv). That app re-inserts its player whenever it
// restarts or changes wallpaper, which can cover the layer again, so every
// DESKTOP_RECHECK_MS the sidecar looks at what sits between the icons and us
// and puts us back. A move is logged with the window that had got in the way;
// a failed check goes to the state strip, once per distinct reason.
// ---------------------------------------------------------------------------
const DESKTOP_RECHECK_MS = 30000;
let desktopRecheckTimer = null;

function stopDesktopRecheck() {
  if (desktopRecheckTimer) clearInterval(desktopRecheckTimer);
  desktopRecheckTimer = null;
}

function armDesktopRecheck(mode) {
  stopDesktopRecheck();   // applyLive runs again on every sidecar restart
  if (mode !== 'progman-front') return;
  let lastErr = null;
  desktopRecheckTimer = setInterval(async () => {
    if (!desktopWin || desktopWin.isDestroyed()) { stopDesktopRecheck(); return; }
    try {
      const r = await sidecar.call('desktop', { hwnd: hwndOf(desktopWin), recheck: true }, 4000);
      if (lastErr) {
        lastErr = null;
        state.set('desktop', { attached: true, mode, reason: 'the desktop layer is behind the icons and in front of the wallpaper again' });
      }
      if (r && r.moved) {
        process.stdout.write(`mantle: desktop layer put back in front of the wallpaper: ${r.covering || 'a window'} had been placed over it\n`);
      }
    } catch (err) {
      if (err.message === lastErr) return;
      lastErr = err.message;
      state.set('desktop', { attached: false, mode, reason: `the desktop layer may be covered by the wallpaper: its position check failed: ${err.message}` });
    }
  }, DESKTOP_RECHECK_MS);
  if (desktopRecheckTimer.unref) desktopRecheckTimer.unref();
}

/** Put the desktop layer under the wallpaper (applyLive, and a layer made again). Never throws. */
async function attachDesktop() {
  const win = desktopWin;
  if (!win || win.isDestroyed()) return { ok: false, reason: 'the desktop layer is not there' };
  try {
    const r = await sidecar.call('desktop', { hwnd: hwndOf(win) });
    const mode = (r && r.mode) || null;
    state.set('desktop', {
      attached: true,
      mode,
      reason: mode === 'progman-front'
        ? 'the desktop layer is behind the icons and in front of the wallpaper, including a video wallpaper (progman-front)'
        : `the desktop layer is under the wallpaper (${mode || 'mode not reported'})`,
    });
    armDesktopRecheck(mode);
    // A display change while it was held hidden: sized now that it is under the icons and BEFORE it
    // is shown, so it is never seen at the old size (lib/display-fit.js; nothing to do otherwise).
    if (desktopFit.pending()) await desktopFit.afterAttach().catch(() => {});
    showDesktopWhenReady(win);   // a layer made again waits hidden for this (makeDesktopWindow holdShow)
    return { ok: true, mode };
  } catch (err) {
    // a layer made again is held hidden until it is in place, so it is NOT floating (makeDesktopWindow holdShow)
    const held = !!(desktopShowGate && desktopShowGate.win === win && !desktopShowGate.cleared);
    state.set('desktop', { attached: false, mode: null, reason: held
      ? `the new desktop layer is waiting, hidden, to go under the icons (trying again): ${err.message}`
      : `the desktop layer could not go under the wallpaper, so it is floating as an ordinary window: ${err.message}` });
    return { ok: false, reason: err.message };
  }
}

// ---------------------------------------------------------------------------
// A NEW DESKTOP LAYER AFTER AN EXPLORER RESTART (core-needs, 2026-09-30).
//
// The layer lives inside Explorer's desktop window (Progman). When Explorer restarts (a crash, or
// Task Manager's "Restart"), Windows can destroy our window along with its parent. Before, that was
// the end of it: desktopWin was gone, the 30 s recheck stopped itself, lib/wallpaper.js kept a dead
// window, and the desktop stayed on Windows' own picture until Mantle was restarted. Now a layer
// that closes while Mantle runs (not quitting, not after "Put Windows back") is made again: a new
// window, handed to the wallpaper (setDesktopWin) and put under the icons. It stays HIDDEN until it
// is attached -- a full-screen layer shown before the new Progman exists would sit over Owen's
// windows -- and attaching is retried with a back-off, because Explorer takes a few seconds to make
// its new desktop. One that keeps dying is not remade forever (desktopRemakeVerdict).
// (A layer that SURVIVES as an orphan is the recheck's job: sidecar Desktop.cs Recheck rejoins it.)
// ---------------------------------------------------------------------------
// <mainrel:desktopremake> (lib/main-guard.test.js runs this region: no outside names in it)
const DESKTOP_REMAKE_MAX = 5;                          // remakes allowed in DESKTOP_REMAKE_SPAN_MS
const DESKTOP_REMAKE_SPAN_MS = 10 * 60 * 1000;
const DESKTOP_ATTACH_BACKOFF_MS = [1500, 3000, 5000, 8000, 12000, 20000];   // ~50 s in all
/**
 * Should a desktop layer that just closed be made again? o: {shuttingDown, paused, at (times of
 * earlier remakes), now}. -> {remake, at (the list to keep), reason (the state line)}.
 */
function desktopRemakeVerdict(o) {
  const now = o.now;
  const at = (Array.isArray(o.at) ? o.at : []).filter((t) => now - t < DESKTOP_REMAKE_SPAN_MS);
  if (o.shuttingDown) return { remake: false, at, reason: null };
  if (o.paused) return { remake: false, at, reason: 'the desktop layer closed while Windows was put back; restart Mantle to bring it back' };
  if (at.length >= DESKTOP_REMAKE_MAX) {
    return { remake: false, at, reason: `the desktop layer closed ${at.length + 1} times in ten minutes, so Mantle stopped making it again; restart Mantle to bring it back` };
  }
  return { remake: true, at: at.concat([now]), reason: 'the desktop layer closed (Explorer restarted?); Mantle is making a new one' };
}
/**
 * Explorer came back (TaskbarCreated, or Progman found by the poll): what happens to the desktop layer?
 * o: {test, shuttingDown, paused, pending (a try is waiting on its back-off timer), layer (a live window),
 * held (that window is still hidden, waiting to go under the icons: a try is on its way)}.
 * -> 'none' | 'try-now' (run the waiting try at once) | 'make' (it was given up on: make it again) |
 *    'wait' (a try is in flight; it retries by itself) |
 *    'recheck' (it is still there: the sidecar's recheck rejoins it if it was orphaned). (lane mantle-crash)
 */
function shellBackAction(o) {
  if (o.test || o.shuttingDown || o.paused) return 'none';
  if (o.pending) return 'try-now';
  if (!o.layer) return 'make';
  if (o.held) return 'wait';
  return 'recheck';
}
/** After attach attempt n (0-based) on a layer made again: 'done', 'retry' or 'give-up'. Never "show it anyway". */
function desktopAttachNext(ok, n) {
  if (ok) return 'done';
  return n + 1 < DESKTOP_ATTACH_BACKOFF_MS.length ? 'retry' : 'give-up';
}
/*
 * OUT OF TRIES: the layer is CLOSED, never shown (review of inc-3, 2026-09-30). It is full-screen,
 * transparent and cannot take focus; shown without a place under the icons it can sit ABOVE Owen's
 * windows and eat every click -- the stuck-screen failure this shell has had before. So the window
 * goes (d.clear() first, so its 'closed' is not read as one more Explorer restart), the wallpaper
 * lets go of it, and Windows' own wallpaper shows. The state line says why and what to do.
 * d: {win, clear(), releaseWallpaper(), stopRecheck(), setState(v), log(line), tries, why}.
 */
function desktopGiveUp(d) {
  d.clear();
  d.stopRecheck();
  try { d.releaseWallpaper(); } catch (_) { /* the wallpaper keeps a dead window: it checks before sending */ }
  let closed = false;
  try { if (d.win && !d.win.isDestroyed()) { d.win.destroy(); closed = true; } } catch (_) { /* already gone */ }
  // d.when: 'at start' for the layer made at start-up, held hidden until it is in place (lane mn-wake)
  const reason = d.when
    ? `the desktop layer could not go under the icons ${d.when} (${d.tries} tries: ${d.why || 'no reason given'}), so Windows' own wallpaper shows; restart Mantle to bring it back`
    : `the desktop layer could not go back under the icons after Explorer restarted (${d.tries} tries: ${d.why || 'no reason given'}), so Windows' own wallpaper shows; restart Mantle to bring it back`;
  d.setState({ attached: false, mode: null, reason });
  d.log(`desktop layer: ${d.when ? `could not go under the icons ${d.when}` : 'made again but could not go under the icons'} after ${d.tries} tries, so it was closed (never shown over the apps): ${d.why || 'no reason given'}`);
  return { closed, reason };
}
// </mainrel:desktopremake>
const desktopRemake = { at: [], timer: null, made: 0, pending: null };
let desktopShowGate = null;   // {win, ready, cleared, why}: the layer is shown once ready AND cleared

/** Make the desktop layer's window. holdShow: stay hidden until showDesktopWhenReady(win) clears it. */
function makeDesktopWindow(why, holdShow) {
  const desktop = createDesktop({ root: ROOT, test: flags.test });
  const win = desktop.win;
  desktopWin = win;
  watchPage(win, 'The desktop layer');
  desktopShowGate = { win, ready: false, cleared: !holdShow, why };
  // One capture of the wallpaper BEFORE the layer covers the screen. It is
  // still hidden here, so there is nothing to exclude from the shot, and the
  // picture it gets is the only thing behind it that will ever be there.
  win.once('ready-to-show', () => {
    if (desktopShowGate && desktopShowGate.win === win) { desktopShowGate.ready = true; showDesktopGated(); }
  });
  win.on('closed', () => desktopGone(win));
  if (!desktop.load.loaded) process.stderr.write(`mantle: ${desktop.load.reason}\n`);
  return win;
}
function showDesktopGated() {
  const g = desktopShowGate;
  if (!g || !g.ready || !g.cleared) return;
  desktopShowGate = null;
  const display = mainDisplayPhys();
  desktopBackdrop.once(g.why)
    .catch(() => false)
    .then((ok) => {
      if (ok) deskShotDisplay = display;   // what a later display change is compared with (reshootDesktopBackdrop)
      if (desktopWin !== g.win || g.win.isDestroyed()) return;
      g.win.showInactive();
      // said only after looking (the start-up order is the proof that it never floated over the apps)
      const d = state.get().desktop || {};
      const where = d.attached ? `under the icons (${d.mode || 'mode not reported'})`
        : flags.test ? 'as an ordinary window (a test run never puts it under the icons)' : 'NOT under the icons';
      process.stdout.write(`mantle: desktop layer: ${g.win.isVisible() ? `shown ${where}` : `asked to show ${where}, and it is still not visible`} (${g.why})\n`);
    });
}
/** Is this layer made but held hidden until it is under the icons (makeDesktopWindow holdShow)? */
function desktopHeld(win) {
  return !!(win && desktopShowGate && desktopShowGate.win === win && !desktopShowGate.cleared);
}
function showDesktopWhenReady(win) {
  if (desktopShowGate && desktopShowGate.win === win) { desktopShowGate.cleared = true; showDesktopGated(); }
}

function desktopGone(win) {
  if (desktopWin !== win) return;          // a window already replaced
  desktopWin = null;
  if (desktopShowGate && desktopShowGate.win === win) desktopShowGate = null;
  stopDesktopRecheck();
  const v = desktopRemakeVerdict({ shuttingDown, paused: !!shellPaused, at: desktopRemake.at, now: Date.now() });
  desktopRemake.at = v.at;
  if (!v.reason) return;                   // quitting: nothing to say
  state.set('desktop', { attached: false, mode: null, reason: v.reason });
  process.stdout.write(`mantle: desktop layer: it closed while Mantle runs: ${v.remake ? `making a new one (${v.at.length} of ${DESKTOP_REMAKE_MAX} in ten minutes)` : v.reason}\n`);
  if (v.remake) scheduleDesktopAttach(0, true);
}

/** Attempt `n`: make the window (first attempt only) and try to put it under the icons. */
/** when: null after an Explorer restart, 'at start' for the start-up layer held hidden (applyLive 0b). */
function scheduleDesktopAttach(n, make, when) {
  if (desktopRemake.timer) clearTimeout(desktopRemake.timer);
  desktopRemake.pending = { n, make, when: when || null };   // what shellRestarted runs at once instead of waiting
  desktopRemake.timer = setTimeout(() => {
    desktopRemake.timer = null;
    desktopRemake.pending = null;
    remakeDesktop(n, make, when || null).catch((err) => process.stderr.write(`mantle: desktop layer: making it again failed: ${err.message}\n`));
  }, DESKTOP_ATTACH_BACKOFF_MS[Math.min(n, DESKTOP_ATTACH_BACKOFF_MS.length - 1)]);
}

// ---------------------------------------------------------------------------
// EXPLORER CAME BACK (lane mantle-crash, 2026-10-15).
//
// Explorer broadcasts TaskbarCreated to every top-level window when it starts (lib/foreign-parent.js
// hookShellRestart). Then: a layer waiting for its next attach try goes NOW instead of after the
// back-off; a layer that was given up on (Explorer took longer than the ~50 s of tries) is made again;
// a layer still there is re-checked (Desktop.cs Recheck rejoins an orphan); and the features hear it
// (the top bar takes its strip again: ctx.host.onShellRestart). Every top-level Mantle window hears the
// same broadcast, so one per 3 s. If the tries ran out because there was NO Progman at all, a slow poll
// (every 5 s, FindWindow) stands in for a TaskbarCreated that never reached us.
// ---------------------------------------------------------------------------
const shellBack = { at: 0, count: 0, listeners: new Set(), poll: null };
function shellRestarted(how) {
  const now = Date.now();
  if (now - shellBack.at < 3000) return;
  shellBack.at = now;
  shellBack.count++;
  stopShellPoll();
  process.stdout.write(`mantle: Explorer is back (${how}, ${shellBack.count} this run): ${flags.test
    ? 'a test run never touches the shell, so nothing is re-attached'
    : 'putting the desktop layer back under the icons and taking the top bar\'s strip again'}\n`);
  for (const fn of shellBack.listeners) {
    try { fn(how); } catch (err) { process.stderr.write(`mantle: Explorer is back: a listener failed: ${err.message}\n`); }
  }
  const act = shellBackAction({ test: flags.test, shuttingDown, paused: !!shellPaused,
    pending: !!(desktopRemake.timer && desktopRemake.pending), layer: !!(desktopWin && !desktopWin.isDestroyed()), held: desktopHeld(desktopWin) });
  if (act === 'none') return;
  if (act === 'wait') { process.stdout.write('mantle: desktop layer: Explorer is back and a try to put it under the icons is already on its way\n'); return; }
  if (act === 'try-now') {   // waiting for its next try: try now
    const p = desktopRemake.pending;
    clearTimeout(desktopRemake.timer);
    desktopRemake.timer = null;
    desktopRemake.pending = null;
    remakeDesktop(p.n, p.make, p.when).catch((err) => process.stderr.write(`mantle: desktop layer: making it again failed: ${err.message}\n`));
    return;
  }
  if (act === 'make') {      // given up on (or never made again): make it now
    const v = desktopRemakeVerdict({ shuttingDown, paused: !!shellPaused, at: desktopRemake.at, now });
    desktopRemake.at = v.at;
    if (!v.remake) { process.stderr.write(`mantle: desktop layer: Explorer is back but it is not made again: ${v.reason}\n`); return; }
    process.stdout.write(`mantle: desktop layer: making it again now that Explorer is back (${v.at.length} of ${DESKTOP_REMAKE_MAX} in ten minutes)\n`);
    state.set('desktop', { attached: false, mode: null, reason: 'Explorer is back; Mantle is making the desktop layer again' });
    scheduleDesktopAttach(0, true);
    return;
  }
  // still there (a layer that was not inside the old Progman): the recheck puts it back if it is orphaned
  sidecar.call('desktop', { hwnd: hwndOf(desktopWin), recheck: true }, 4000)
    .then((r) => process.stdout.write(`mantle: desktop layer: re-checked after Explorer came back: ${r && r.moved ? `put back (${r.covering || 'it had moved'})` : 'still in place'}\n`))
    .catch((err) => process.stderr.write(`mantle: desktop layer: re-check after Explorer came back failed: ${err.message}\n`));
}
function onShellRestart(fn) { shellBack.listeners.add(fn); return () => shellBack.listeners.delete(fn); }
function stopShellPoll() { if (shellBack.poll) clearInterval(shellBack.poll); shellBack.poll = null; }
/** The layer's tries ran out with NO Progman: look for one every 5 s until Explorer is back. */
function startShellPoll(why) {
  if (shellBack.poll || flags.test) return;
  process.stdout.write(`mantle: desktop layer: waiting for Explorer's desktop to come back (${why}); looking every 5 s\n`);
  shellBack.poll = setInterval(() => {
    if (shuttingDown || shellPaused) { stopShellPoll(); return; }
    if (foreignParent.progmanThere()) shellRestarted('Explorer\'s desktop window is there again');
  }, 5000);
  if (shellBack.poll.unref) shellBack.poll.unref();
}
async function remakeDesktop(n, make, when) {
  if (shuttingDown || shellPaused) return;
  if (make || !desktopWin || desktopWin.isDestroyed()) {
    const win = makeDesktopWindow('Explorer restarted: a new desktop layer', !flags.test);
    desktopRemake.made++;
    try { wallpaper.setDesktopWin(win); } catch (err) { process.stderr.write(`mantle: desktop layer: the wallpaper could not be handed the new layer: ${err.message}\n`); }
    if (flags.test) {
      // A test run never touches the shell: the new layer is made and handed over, never attached.
      state.set('desktop', { attached: false, mode: null, reason: 'test run: the desktop layer was made again after it closed (not attached: a test run never touches the shell)' });
      win.webContents.once('did-finish-load', () => process.stdout.write(`mantle: desktop layer: made again (${desktopRemake.made}); its page loaded and the wallpaper has it\n`));
      return;
    }
  }
  const r = await attachDesktop();
  const next = desktopAttachNext(r.ok, n);
  if (next === 'done') {
    process.stdout.write(when
      ? `mantle: desktop layer: under the icons (${r.mode || 'mode not reported'}) on retry ${n + 1} ${when} (Explorer's desktop was not ready the first time)\n`
      : `mantle: desktop layer: made again and back under the icons (${r.mode || 'mode not reported'}) on attempt ${n + 1}\n`);
    return;
  }
  if (next === 'retry') { scheduleDesktopAttach(n + 1, false, when); return; }
  // Out of tries: closed, NEVER shown over the apps (desktopGiveUp says why).
  const win = desktopWin;
  desktopGiveUp({
    win,
    clear: () => { if (desktopWin === win) desktopWin = null; if (desktopShowGate && desktopShowGate.win === win) desktopShowGate = null; },
    releaseWallpaper: () => wallpaper.setDesktopWin(null),
    stopRecheck: stopDesktopRecheck,
    setState: (v) => state.set('desktop', v),
    log: (line) => process.stderr.write(`mantle: ${line}\n`),
    tries: n + 1,
    why: r.reason,
    when,
  });
  // No Progman at all = Explorer is not running yet: not "restart Mantle" but "it comes back with Explorer"
  if (/no Progman window/.test(r.reason || '')) {
    state.set('desktop', { attached: false, mode: null, reason: `Explorer's desktop is not there (${r.reason}), so Windows' own wallpaper shows; the desktop layer comes back by itself when Explorer does` });
    startShellPoll(r.reason);
  }
}

/* TEST ONLY: --test-apps-icons rebuilds the index 25 s after start and logs how many rows have a picture, Store
   apps counted apart: the Electron proof that Store apps get theirs (makeIconResolver). Counts only. */
function armAppsIconsTest() {
  if (!flags.test || !ARGV.includes('--test-apps-icons')) return;
  const t = setTimeout(() => {
    apps.index({ refresh: true }).then((idx) => {   // a rebuild: the first one may predate the Store list
      const rows = idx.items.filter(Boolean);
      const store = rows.filter((i) => i.aumid);
      const pic = (i) => typeof i.icon === 'string' && i.icon.startsWith('data:image/');
      process.stdout.write(`mantle: --test-apps-icons: ${rows.length} launcher rows, ${rows.filter(pic).length} with a picture; Store apps ${store.length}, ${store.filter(pic).length} with a picture\n`);
    }).catch((err) => process.stdout.write(`mantle: --test-apps-icons: the index failed: ${err.message}\n`));
  }, 25000);
  if (t.unref) t.unref();
}

/* TEST ONLY: --test-desktop-gone=MS destroys the desktop layer MS after start, the way Explorer's
   restart can, so a --test run proves it is made again (Explorer itself is never touched). */
function armDesktopGoneTest() {
  const arg = flags.test && ARGV.find((x) => typeof x === 'string' && x.startsWith('--test-desktop-gone='));
  const ms = arg ? Number(arg.slice('--test-desktop-gone='.length)) : NaN;
  if (!Number.isFinite(ms) || ms < 0) return;
  const t = setTimeout(() => {
    if (!desktopWin || desktopWin.isDestroyed()) return;
    process.stdout.write('mantle: desktop layer: --test-desktop-gone: destroying it the way an Explorer restart can\n');
    desktopWin.destroy();
  }, ms);
  if (t.unref) t.unref();
}

// ---------------------------------------------------------------------------
// The notification-area mirror the bar renders.
// ---------------------------------------------------------------------------
/*
 * The notification area as the bar draws it: the sidecar's list minus MANTLE'S OWN icon.
 *
 * Mantle's Electron Tray icon (createTray, the no-keyboard escape hatch) sits in Windows'
 * notification area like any other, so the sidecar lists it, and the bar drew a button for the
 * shell it is part of (or, in a test instance, for the LIVE shell). Measured 2026-09-22 through
 * the UIA tray: it lists as title "Electron", exe
 * C:\Users\user\mantle\node_modules\electron\dist\electron.exe, hidden. Owen's own browser is
 * ALSO electron.exe (C:\Users\user\browser\...), so the exe NAME alone would hide his browser's
 * icon too. The match is an electron.exe that lives in a mantle checkout (mantle, mantle-live,
 * any mantle-*), this process's own exe, or a live tooltip in the "Mantle (live|test)" form
 * updateTray() writes.
 */
const MANTLE_ELECTRON_RE = /[\\/]mantle(?:-[^\\/]*)?[\\/]node_modules[\\/]electron[\\/]dist[\\/]electron\.exe$/i;
function isMantleTrayIcon(t) {
  if (!t) return false;
  const exe = t.exe ? String(t.exe) : '';
  if (exe && (MANTLE_ELECTRON_RE.test(exe) || path.resolve(exe).toLowerCase() === path.resolve(process.execPath).toLowerCase())) return true;
  return /^Mantle \((live|test)\)/.test(String(t.title || t.tooltip || ''));
}
function trayForBar(list) {
  return Array.isArray(list) ? list.filter((t) => !isMantleTrayIcon(t)) : [];
}

function startTrayPoll() {
  stopTrayPoll();
  const tick = async () => {
    let delay = 5000;
    try {
      const list = await sidecar.call('tray');
      lastTray = trayForBar(list);
      state.set('tray', { status: 'ok', reason: `${lastTray.length} notification-area items` });
      broadcast('tray', lastTray);
    } catch (err) {
      // Backing off rather than hammering: if the tray cannot be read at all,
      // asking twelve times a minute will not change that.
      delay = 60000;
      state.set('tray', { status: 'unavailable', reason: `${err.message}; retrying once a minute` });
    }
    if (!shuttingDown) {
      trayTimer = setTimeout(tick, delay);
      if (trayTimer.unref) trayTimer.unref();
    }
  };
  tick();
}

function stopTrayPoll() {
  if (trayTimer) clearTimeout(trayTimer);
  trayTimer = null;
}

// ---------------------------------------------------------------------------
// Putting Windows back. Every exit road leads here, and it must never throw.
// ---------------------------------------------------------------------------
function markRestored(why) {
  state.set('taskbar', { autohide: false, reason: `the Windows taskbar is back the way Owen had it: ${why}` });
  state.set('workarea', { reserved: false, reason: `the app bar is gone and the whole screen is available again: ${why}` });
  state.set('desktop', { attached: false, mode: null, reason: `the desktop layer is detached: ${why}` });
  state.set('hotkey', { winTap: false, reason: `the Win key opens the Windows Start menu again: ${why}` });
  switcher.released(why);
  if (features) features.released(why);
}

/**
 * The half of markRestored that has to exist: Windows is NOT back, and saying so
 * with the one command that fixes it is the difference between a bad minute and
 * a reboot.
 */
function markUnrestored(why) {
  const tail = `${why}. Run this and Windows comes back: ${RECOVERY_CMD}`;
  state.set('taskbar', { autohide: false, reason: tail });
  state.set('workarea', { reserved: false, reason: tail });
}

/**
 * Put Windows back with no sidecar, by running the standalone script.
 *
 * SYNCHRONOUS on purpose: this is called on the way out, and an async spawn would
 * race app.exit(). execFileSync means the process cannot leave until Windows is
 * back. -NoKill because the only Mantle process the script would stop is THIS
 * one, and killing ourselves half way through would lose the very output that
 * says whether it worked.
 */
function restoreWithScript(why, because) {
  process.stdout.write(`mantle: restoring Windows with ${RESTORE_SCRIPT} instead (${because})\n`);
  try {
    const out = execFileSync('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', RESTORE_SCRIPT,
      '-StateFile', STATE_FILE, '-NoKill',
    ], { cwd: ROOT, encoding: 'utf8', timeout: 30000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    process.stdout.write(String(out || '').trim() + '\n');
    markRestored(`${why}; ${because}, so tools/restore-windows.ps1 put Windows back and verified it`);
  } catch (err) {
    const said = [err.stdout, err.stderr].map((s) => String(s || '').trim()).filter(Boolean).join('\n');
    if (said) process.stdout.write(said + '\n');
    markUnrestored(`${why}: the sidecar was gone and tools/restore-windows.ps1 did not finish cleanly (${err.message})`);
    process.stderr.write(`mantle: RESTORE NOT VERIFIED. Run this, and if it still looks wrong add -RestartExplorer:\n    ${RECOVERY_CMD}\n`);
  }
}

/**
 * Idempotent, serialised, and it swallows everything. Calling it twice is fine;
 * calling it when nothing was ever applied is fine; calling it with a dead
 * sidecar is fine (the standalone script takes over).
 *
 * ORDER MATTERS: the app bar goes first, then the taskbar's auto-hide flag. The
 * app bar is what Explorer is subtracting from the work area, and letting go of
 * it before changing the taskbar means Explorer only recomputes the layout once,
 * with both facts already true.
 */
function restoreShell(why) {
  restoreChain = restoreChain.then(async () => {
    if (flags.test) {
      state.set('taskbar', { autohide: false, reason: 'test mode: nothing was changed, so there is nothing to restore' });
      state.set('workarea', { reserved: false, reason: 'test mode: no app bar was registered, so there is nothing to give back' });
      // A test run's features still get their stop(): it is how a lane proves its stop() puts back
      // what it would have changed (and a test feature may have made windows and timers).
      await stopFeatures(why);
      return;
    }

    const blocked = sidecar.blockedReason();
    if (blocked) {
      restoreWithScript(why, `the sidecar cannot be asked: ${blocked}`);
      return;
    }

    const done = [];
    const failures = [];

    // 0. Give the cursor the bottom row back FIRST. It is the only thing Mantle
    //    does that a person can feel in their hand, so it is the first thing
    //    undone -- and the sidecar is still alive to be asked at this point.
    await releaseEdgeClip(why);
    // ...and let the Windows taskbar draw again, while the sidecar can still be
    // asked. Its own exit path and its guard do this too; this is the clean road.
    await releaseTaskbarHide(why);

    // 1. Give the strip of screen back.
    if (appbarHwnd) {
      try {
        await sidecar.call('appbar', { hwnd: appbarHwnd, remove: true }, 4000);
        appbarHwnd = null;
        done.push('app bar removed');
      } catch (err) {
        failures.push(`the app bar is still registered (${err.message})`);
      }
    } else {
      done.push('no app bar was registered');
    }

    // 2. Put the taskbar's auto-hide flag back to whatever Owen had it on.
    let taskbarLine = null;
    try {
      const r = await sidecar.call('taskbar', { restore: true }, 4000);
      const original = r && r.state !== undefined && r.state !== null
        ? (Number(r.state) & 1 ? 'auto-hide' : 'always visible')
        : (state.get().taskbar.wasAutohide ? 'auto-hide' : 'always visible');

      // `restored:false` on its own is NOT a failure, and reading it as one cried
      // wolf on the first live run (2026-09-21): Owen's taskbar is already
      // auto-hide, so Mantle never changed it, and the sidecar correctly answered
      // {restored:false, changedByUs:false, verified:true} -- "there was nothing
      // to put back". The log shouted RESTORE INCOMPLETE at a perfectly healthy
      // desktop. A restore only fails when there was something to undo AND it did
      // not get undone.
      const neverChanged = r && r.changedByUs === false;
      if (!neverChanged && r && r.restored === false) {
        failures.push(`the taskbar's auto-hide flag is NOT back to ${original}`);
      } else if (r && r.verified === false) {
        failures.push(`the taskbar's auto-hide flag was set back to ${original} but the sidecar could not read it back to confirm`);
      } else {
        taskbarLine = neverChanged
          ? 'taskbar auto-hide left as it was (Mantle never changed it)'
          : `taskbar auto-hide back to ${original}`;
        done.push(taskbarLine);
        done.push('verified');
      }
    } catch (err) {
      failures.push(`the taskbar's auto-hide flag could not be put back (${err.message})`);
    }

    // 2b. Every feature's stop(): the Windows settings a feature changed (a hidden OSD, a
    //     registry value) go back. All at once, each with its own deadline (lib/features.js), so a
    //     stuck one costs at most 2.5 s and never the restore. Before the hook comes out, so no
    //     feature is still re-asking for its chords while they are being taken back.
    await stopFeatures(why);

    // 3. The pieces that were always safe: the hook and the wallpaper layer.
    // ALL of the hook's features, or Alt+Tab would stay Mantle's after Windows was "put back" --
    // and every feature chord and observed key with them (chords/observe: [] = none).
    const rest = [['the keyboard hook (Win key, Alt+Tab, Win+N, Win+A, feature shortcuts)', () => sidecar.call('hotkey', { winTap: false, altTab: false, winKeys: false, chords: [], observe: [] }, 4000)]];
    stopDesktopRecheck();   // or it re-places the layer while it is being detached
    if (desktopWin && !desktopWin.isDestroyed()) {
      rest.push(['the desktop layer', () => sidecar.call('desktop', { hwnd: hwndOf(desktopWin), detach: true }, 4000)]);
    }
    for (const [label, run] of rest) {
      try { await run(); } catch (err) { failures.push(`${label} (${err.message})`); }
    }

    // 4. Say what happened, in words, where whoever started Mantle can read it.
    if (!failures.length) {
      process.stdout.write(`mantle: restored: ${done.join('; ')}\n`);
      markRestored(why);
      return;
    }
    process.stderr.write(`mantle: RESTORE INCOMPLETE (${why}): ${failures.join('; ')}\n    run this and Windows comes back:\n    ${RECOVERY_CMD}\n`);
    markUnrestored(`${why}: ${failures.join('; ')}`);
  }).catch((err) => {
    process.stderr.write(`mantle: restore path threw, which it never should: ${err && err.stack ? err.stack : err}\n    run: ${RECOVERY_CMD}\n`);
  });
  return restoreChain;
}

// opts.exitCode: 1 after a crash, so the logon task records a failure; opts.before: a promise the
// exit waits for (the crash's restart being arranged), inside the same 12 s hard stop.
function shutdown(why, opts) {
  if (shuttingDown) return;
  shuttingDown = true;
  // Before anything else: a quit that crashes half way out is still a quit (lib/supervisor.js).
  // opts.crash: the uncaught-exception road, which wants the supervisor to bring Mantle back.
  if (!(opts && opts.crash)) supervisor.standDown(why);
  const exitCode = opts && Number.isInteger(opts.exitCode) ? opts.exitCode : 0;
  const before = opts && opts.before ? Promise.resolve(opts.before).catch(() => {}) : Promise.resolve();
  process.stdout.write(`mantle: shutting down (${why})\n`);
  qsSetLog.flushAll();          // a slider dragged just before quitting still gets its summary line
  stopTrayPoll();
  // The cursor poll stops DEAD here, before anything else: it is the only thing
  // in Mantle that runs many times a second, and a poll still ticking through a
  // restore is a poll that can show a bar window mid-shutdown.
  stopHoverWatch();
  // DWM drops a dead process's thumbnails on its own, but the restore below can take seconds
  // and the bar is still on screen for all of them.
  clearThumbs('Mantle is shutting down');
  // the Alt+Tab overlay's previews and timers; from here the hook going away is said as quitting, not a fault
  switcher.stop(`Mantle is quitting (${why})`);
  // ...and with it the capture loop, which is the one thing that can leave a
  // window excluded from Owen's screenshots if it is stopped carelessly.
  stopBackdrop('Mantle is shutting down');
  qsWatchStop('Mantle is shutting down');
  if (mediaPollTimer) { clearTimeout(mediaPollTimer); mediaPollTimer = null; }
  if (pinnedPushTimer) { clearTimeout(pinnedPushTimer); pinnedPushTimer = null; }
  if (unwatchPins) {
    try { unwatchPins(); } catch (err) { process.stderr.write(`mantle: the pinned-shortcuts watcher would not stop: ${err.message}\n`); }
    unwatchPins = null;
  }
  apps.stopRefresh();
  try { globalShortcut.unregisterAll(); } catch (_) {}

  // A hung sidecar must not hold the exit forever: it restores on its own when
  // its stdin closes, so eventually we stop waiting and go. Twelve seconds, not
  // three: the restore is two 4-second calls back to back now, and cutting the
  // taskbar's auto-hide flag off half way through is the failure this whole file
  // was rewritten to make impossible. A slow quit is a nuisance; a wrong shell is
  // a reboot.
  const hardStop = setTimeout(() => {
    process.stderr.write(`mantle: the restore did not finish in 12s, leaving anyway. If the taskbar looks wrong:\n    ${RECOVERY_CMD}\n`);
    try { sidecar.stop(); } catch (_) {}
    app.exit(exitCode);
  }, 12000);
  if (hardStop.unref) hardStop.unref();

  restoreShell(why).finally(() => before).finally(() => {
    clearTimeout(hardStop);
    try { sidecar.stop(); } catch (_) {}
    try { if (tray) tray.destroy(); } catch (_) {}
    // exit() rather than quit(): quit() would re-enter before-quit and we have
    // already done every piece of cleanup there is.
    app.exit(exitCode);
  });
}

// ---------------------------------------------------------------------------
// `electron . --quit` from anywhere: the scriptable clean stop.
//
// Electron hands us the second launch's argv. Nothing else about that launch
// reaches this process -- it created no window and spawned no sidecar -- so this
// is simply a request, and it takes the same verified restore road as the tray
// menu and the kill switch.
// ---------------------------------------------------------------------------
app.on('second-instance', (_event, argv) => {
  // TEST ONLY: `electron . --test --profile-name=<x> --test-click=restart` asks THIS test instance's
  // bar to click its own "Restart Mantle" item (the real button, through the DOM), so the restart
  // can be proven by script without a mouse. A live instance ignores it (no --profile-name reaches
  // the live lock anyway), and the relaunched instance gets its own original argv, not this one.
  const click = flags.test && Array.isArray(argv) ? argv.find((a) => typeof a === 'string' && a.startsWith('--test-click=')) : null;
  if (click) {
    process.stdout.write(`mantle: a second instance asked the bar to click "${click.slice('--test-click='.length)}" (test mode)\n`);
    broadcast('bar.test.click', { what: click.slice('--test-click='.length) });
    return;
  }
  // TEST ONLY: `electron . --test --profile-name=<x> --test-memory=<tag>` logs this test instance's
  // memory line now (logMemory), so a measurement can be taken at a chosen moment.
  const mem = flags.test && Array.isArray(argv) ? argv.find((a) => typeof a === 'string' && a.startsWith('--test-memory=')) : null;
  if (mem) {
    const tag = mem.slice('--test-memory='.length) || 'asked';
    logMemory(tag);
    // ...and each feature's health and keys, the Win key and Alt+Tab, in one line each (the rest's proof).
    const st = state.get();
    for (const [name, p] of Object.entries(st.features || {})) {
      process.stdout.write(`mantle: state (${tag}): ${name}: ${p.ok ? 'healthy' : 'NOT healthy'}${p.resting ? ' RESTING' : ''}${p.stopped ? ' STOPPED' : ''}: ${p.reason} | ${p.keysReason}\n`);
    }
    process.stdout.write(`mantle: state (${tag}): Win key: ${st.hotkey && st.hotkey.reason} | Alt+Tab: ${st.switcher && st.switcher.reason} | windows: ${pageNames().join(', ')}\n`);
    return;
  }
  // TEST ONLY (lane core-main): `--test-report` runs the tray's "Copy diagnostic report" (a test run
  // writes it to its own profile, never the clipboard); `--test-tray` logs the tray menu's rows;
  // `--test-crash` throws an uncaught exception on the next tick, to prove the crash road end to end.
  if (flags.test && Array.isArray(argv) && argv.includes('--test-report')) {
    copyDiagnosticReport('a second instance (test)').catch((err) => process.stdout.write(`mantle: test-report failed: ${err.message}\n`));
    return;
  }
  if (flags.test && Array.isArray(argv) && argv.includes('--test-tray')) {
    const shown = (items, depth) => items.map((i) => (i.type === 'separator' ? `${depth}---` : `${depth}${i.label}${i.accelerator ? ` [${i.accelerator}]` : ''}${i.enabled === false ? ' (text)' : ''}${i.submenu ? ` (${i.submenu.length} inside)` : ''}`)).join(' | ');
    const o = lastTrayView;
    process.stdout.write(`mantle: test-tray: ${o ? shown(trayTemplate(o), '') : 'the tray was never built'}\n`);
    return;
  }
  if (flags.test && Array.isArray(argv) && argv.includes('--test-crash')) {
    process.stdout.write('mantle: test-crash: throwing an uncaught exception on the next tick (test mode)\n');
    setTimeout(() => { throw new Error('test crash asked for by a second instance'); }, 0);
    return;
  }
  // TEST ONLY (lane ramdiet): `electron . --test --profile-name=<x> --test-unload` unloads every
  // idle-unloadable window NOW (lib/features/_idle-unload.js), as IDLE_UNLOAD_MS unused would.
  if (flags.test && Array.isArray(argv) && argv.includes('--test-unload')) {
    let went = [];
    try { went = require('./lib/features/_idle-unload').unloadAll('a second instance asked (test)'); } catch (err) { went = [`failed: ${err.message}`]; }
    process.stdout.write(`mantle: test-unload: ${went.length ? went.join(', ') : 'nothing to unload'}\n`);
    return;
  }
  // TEST ONLY: `electron . --test --profile-name=<x> --test-chord=Win+V` (or --test-key=VolumeUp)
  // makes THIS test instance act as if the hook had seen that chord: the feature lanes' end-to-end
  // proof, with no keyboard hook and no synthetic keystroke anywhere near Owen's desktop.
  const fire = flags.test && features && Array.isArray(argv)
    ? argv.find((a) => typeof a === 'string' && (a.startsWith('--test-chord=') || a.startsWith('--test-key='))) : null;
  if (fire) {
    const isChord = fire.startsWith('--test-chord=');
    const what = fire.slice(fire.indexOf('=') + 1);
    try {
      const r = isChord ? features.fireChord(what, 'a second instance') : features.fireKey(what, 'a second instance');
      process.stdout.write(`mantle: ${what} from a second instance: ${JSON.stringify(r)}\n`);
    } catch (err) {
      process.stdout.write(`mantle: ${what} from a second instance was refused: ${err.message}\n`);
    }
    return;
  }
  // `--open=wallpapers` (lane looksync-open, 2026-10-10): Quartz and Helm's "Open Mantle Wallpapers"
  // button. ALLOW-LIST only (lib/args.js openRequest): anything else is one refusal line and nothing
  // else; no path or URL from argv is ever opened. Live: the window opens and comes to the front
  // (openLibrary shows + focuses; the second start lets us take the foreground). --test: created and
  // loaded only, never shown or focused here (openLibrary's showInactive is made invisible by
  // the test-run quieting). Live failures also reach the tray, so a dead button is never silent.
  const openReq = Array.isArray(argv) && !argv.includes('--quit') ? require('./lib/args').openRequest(argv) : null;
  if (openReq) {
    if (!openReq.ok) { process.stdout.write(openReq.line + '\n'); return; }
    try {
      if (openReq.target === 'wallpapers') wallpaper.openLibrary();
      process.stdout.write(openReq.line + '\n');
    } catch (err) {
      process.stdout.write(`mantle: a second start asked for ${openReq.label} (--open=${openReq.target}), but it did not open: ${err.message}\n`);
      if (!flags.test) trayNotice(`${openReq.label} did not open`, err.message);
    }
    return;
  }
  const asked = Array.isArray(argv) && argv.some((a) => a === '--quit');
  if (!asked) {
    process.stdout.write('mantle: another Mantle tried to start; this one is already running, so that one exited.\n');
    return;
  }
  process.stdout.write('mantle: quit requested by a second instance\n');
  shutdown('a second instance asked Mantle to quit');
});

app.on('before-quit', (e) => {
  if (shuttingDown) return;
  e.preventDefault();
  shutdown('before-quit');
});
app.on('will-quit', (e) => {
  if (shuttingDown) return;
  e.preventDefault();
  shutdown('will-quit');
});
app.on('window-all-closed', () => shutdown('every window was closed'));

// <mainrel:crash> (lib/main-rel.test.js runs this region with a fake clock: no outside names in it)
/*
 * A CRASH BRINGS MANTLE BACK, BUT NOT FOREVER (lane core-main, 2026-09-29).
 *
 * An uncaught exception has always meant "put Windows back and go" (a shell in an unknown state is
 * worse than no shell). But it went with exit code 0, so the logon task's RestartOnFailure
 * (tools/mantle-logon-task.xml) never saw a failure, and one bad moment left Owen with no bar and
 * no launcher until he noticed and started Mantle by hand. Now the crash is written down
 * (<userData>/crash.json), Mantle arranges its own way back exactly as "Restart Mantle" does
 * (arrangeRestart), and exits with code 1 so the task records the failure too. At most 3 of those
 * in 10 minutes: the 4th crash stays down, and says why, rather than flicker the taskbar forever.
 * The next start says it happened, on the tray menu and in the diagnostic report (recoveryLine).
 * 2026-10-15 (lane mantle-supervisor): that RestartOnFailure never fires for a crash (it only retries a task
 * that failed to START). A supervisor process now brings Mantle back after ANY death, native crashes and kills
 * included (lib/supervisor.js); arrangeRestart is only the fallback when no supervisor is running.
 */
const CRASH_WINDOW_MS = 10 * 60 * 1000;
const CRASH_MAX_RESTARTS = 3;
function crashPlan(history, now) {
  const recent = (Array.isArray(history) ? history : []).filter((t) => typeof t === 'number' && t <= now && now - t < CRASH_WINDOW_MS);
  const all = recent.concat([now]);
  if (all.length > CRASH_MAX_RESTARTS) {
    return { restart: false, history: all.slice(-10), recent: all.length, why: `stopped with an error ${all.length} times in 10 minutes, so it was not started again` };
  }
  return { restart: true, history: all.slice(-10), recent: all.length,
    why: all.length === 1 ? 'stopped with an error, so it is starting again' : `stopped with an error (${all.length} times in 10 minutes), so it is starting again` };
}
/** The line the NEXT start shows (tray menu, report) for a crash under an hour old; null otherwise. */
function recoveryLine(rec, now, fmtTime) {
  if (!rec || typeof rec.at !== 'number' || rec.at > now || now - rec.at > 60 * 60 * 1000) return null;
  const t = fmtTime(rec.at);
  return rec.restarted ? `Restarted by itself after an error at ${t}` : `Stopped after repeated errors at ${t}`;
}
/** The error's first line, short: the file and the report never get a stack (paths live there). */
function crashWhat(err) {
  const m = err && err.message ? String(err.message) : String(err);
  const line = m.split(/\r?\n/)[0].replace(/\s+/g, ' ').trim();
  return line.length > 160 ? `${line.slice(0, 159)}…` : (line || 'no message');
}
/** Unhandled rejections: every distinct one is written; a repeat only at the 10th, 100th, 1000th... */
function makeRejectionLog(write, maxKeys) {
  const seen = new Map();
  return (err) => {
    const key = crashWhat(err);
    const n = (seen.get(key) || 0) + 1;
    seen.delete(key);
    seen.set(key, n);
    while (seen.size > (maxKeys || 100)) seen.delete(seen.keys().next().value);
    if (n === 1) write(`mantle: unhandled promise rejection: ${err && err.stack ? err.stack : err}\n`);
    else if (/^10+$/.test(String(n))) write(`mantle: the same unhandled promise rejection has now happened ${n} times: ${key}\n`);
    return n;
  };
}
// </mainrel:crash>

let crashing = false;
function crashFile() { return path.join(app.getPath('userData'), 'crash.json'); }
process.on('uncaughtException', (err) => {
  process.stderr.write(`mantle: uncaught exception: ${err && err.stack ? err.stack : err}\n`);
  // Already on the way out (the hard stop still ends it), or a second throw mid-crash: nothing more.
  if (shuttingDown || crashing) return;
  crashing = true;
  // A shell in an unknown state is worse than no shell: put Windows back and go -- and come back.
  let plan = { restart: false, why: 'stopped with an error, and the crash could not be written down, so it was not started again' };
  try {
    let prev = {};
    try { prev = JSON.parse(fs.readFileSync(crashFile(), 'utf8')) || {}; } catch (_) { prev = {}; }
    const now = Date.now();
    plan = crashPlan(prev.history, now);
    fs.mkdirSync(path.dirname(crashFile()), { recursive: true });
    fs.writeFileSync(crashFile(), JSON.stringify({ history: plan.history, last: { at: now, what: crashWhat(err), restarted: plan.restart } }));
  } catch (e) {
    plan = { restart: false, why: `stopped with an error, and the crash could not be written down (${e.message}), so it was not started again` };
  }
  process.stderr.write(`mantle: Mantle ${plan.why}\n`);
  // With a supervisor watching (lib/supervisor.js) IT is the way back: arranging a restart here as well
  // would start two. It gets the error's words; a 4th error in 10 minutes still stays down (standDown).
  const supervised = supervisor.status().on;
  if (supervised) {
    if (plan.restart) supervisor.crashNote(crashWhat(err));
    else supervisor.standDown(`Mantle ${plan.why}`);
  }
  const back = plan.restart && !supervised
    ? arrangeRestart().then((r) => { if (!r.ok) process.stderr.write(`mantle: ${r.reason}\n`); }, (e) => process.stderr.write(`mantle: the restart after the error could not be arranged: ${e && e.message}\n`))
    : null;
  shutdown('an uncaught exception', { exitCode: 1, before: back, crash: true });
});
const rejectionLog = makeRejectionLog((line) => process.stderr.write(line));
process.on('unhandledRejection', (err) => {
  // Not fatal, but it is never nothing. It goes where someone will see it -- once, not once a second.
  rejectionLog(err);
});

/** The tray's recovery line for this start, from the last crash on record (null when there is none). */
function loadRecoveryNote() {
  try {
    const rec = JSON.parse(fs.readFileSync(crashFile(), 'utf8'));
    const two = (n) => String(n).padStart(2, '0');
    return recoveryLine(rec && rec.last, Date.now(), (t) => { const d = new Date(t); return `${two(d.getHours())}:${two(d.getMinutes())}`; });
  } catch (_) { return null; }
}
let recoveryNote = null;

// ---------------------------------------------------------------------------
// The tray icon: the escape hatch that does not need a keyboard.
// ---------------------------------------------------------------------------
// <mainrel:tray> (lib/main-rel.test.js runs this region with fake problems and items: no outside names in it)
/*
 * THE TRAY MENU, AS WORDS AND ORDER ONLY (lane core-main, 2026-09-29). Owen: "minimalistic and
 * super easy to use and obvious what to do". Before: 30+ rows -- a "Mantle — live" title, the
 * health as internal piece names ("2 things to look at: sidecar, edge clip"), two switches and
 * a reason line for Alt+Tab, a switch and often a reason for each of 20 features -- then the
 * two ways out at the very bottom, with no shortcut shown for either and no way to restart.
 * Now: what state Mantle is in, in words (and what is wrong, one short line each); the things
 * people open (launcher, Settings, Wallpapers) with their shortcuts; the feature switches one
 * level down; and the ways out -- report, restart, put Windows back, quit -- with the kill
 * switch's keys on Quit, which is what that chord does.
 * The menu is rebuilt only when this template changes (menuSignature): state changes many times a
 * minute (the bar's reveal alone), and every one used to rebuild all 30 rows.
 */
const PIECE_WORDS = {
  sidecar: "Mantle's link to Windows", taskbar: 'Taskbar auto-hide', 'screen space': 'Room for the bar',
  'desktop layer': 'Desktop', 'Win key': 'Win key', tray: 'Notification-area icons', 'taskbar watch': 'Keeping the taskbar tucked away',
  'edge clip': 'Bottom-edge guard', 'taskbar hiding': 'Hiding the Windows taskbar', 'window glass': 'Glass effect',
  shortcuts: 'Keyboard shortcuts', notifications: 'Notifications', 'Alt+Tab': 'Alt+Tab',
};
function pieceWords(piece) {
  const p = String(piece || '');
  if (PIECE_WORDS[p]) return PIECE_WORDS[p];
  const bd = /^(.+) backdrop$/.exec(p);
  if (bd) return `${bd[1].charAt(0).toUpperCase()}${bd[1].slice(1)} background`;
  return p ? p.charAt(0).toUpperCase() + p.slice(1) : 'Something';
}
/*
 * PLAIN WORDS FOR EVERY LINE ON THE MENU (core-needs, 2026-09-30). Reasons are written for the log
 * ("the sidecar did not install the Win key hook"). The health rows had "sidecar" swapped out, but
 * "hook" got through, and the reason lines under Features (lib/switcher.js, lib/features.js) and a
 * failed action's balloon went on screen untouched. One pass, for every line a person reads here.
 */
const TRAY_WORDS = [
  [/\b(?:the )?sidecar's\b/gi, "Mantle's"],
  [/\b(?:the )?sidecar\b/gi, "Mantle's link to Windows"],
  [/\b(the )?(?:low-level )?keyboard hooks?\b/gi, (_m, the) => `${the || ''}keyboard watcher`],
  [/\bWin[- ]key hooks?\b/gi, 'Win key watcher'],
  [/\bhooks?\b/gi, 'keyboard watcher'],
  [/\s*\((?:HRESULT |error )?0x[0-9a-f]{8}\)/gi, ''],
  [/\b(?:HRESULT )?0x[0-9a-f]{8}\b/gi, 'an error'],
  [/\bhwnd\b/gi, 'window'],
  [/\brenderer\b/gi, 'page'],
  [/\bAUMID\b/gi, 'app id'],
  [/\bdryRun\b/g, 'test run'],
];
function trayWords(text) {
  let s = String(text == null ? '' : text);
  for (const [re, to] of TRAY_WORDS) s = s.replace(re, to);
  return s;
}
/** Every label under Features, in place: the switches and their reason lines (submenus too). */
function plainMenu(items) {
  for (const it of Array.isArray(items) ? items : []) {
    if (!it) continue;
    if (typeof it.label === 'string') it.label = trayWords(it.label);
    if (typeof it.sublabel === 'string') it.sublabel = trayWords(it.sublabel);
    if (typeof it.toolTip === 'string') it.toolTip = trayWords(it.toolTip);
    if (Array.isArray(it.submenu)) plainMenu(it.submenu);
  }
  return items;
}
/** One short line: the first clause of a reason, capped (a menu row is not a paragraph). */
function shortReason(text, max) {
  const n = max || 70;
  let s = trayWords(String(text || '').replace(/\s+/g, ' ').trim());
  const cut = s.search(/(; |\. | -- | \()/);
  if (cut > 12) s = s.slice(0, cut);
  s = s.replace(/[.;:,]$/, '');
  return s.length > n ? `${s.slice(0, n - 1).replace(/\s+\S*$/, '')}…` : s;
}
/** {head, lines, tip}: the menu's first row, the rows under it, and the icon's hover text. */
function trayHealth(problems, o) {
  const opt = o || {};
  const list = Array.isArray(problems) ? problems : [];
  const name = opt.test ? 'Mantle (test run)' : 'Mantle';
  if (opt.paused) {
    return { head: 'Paused: Windows is back to normal', lines: ['Restart Mantle to use it again'], tip: `${name}\nPaused: Windows is back to normal` };
  }
  if (!list.length) return { head: 'Mantle is running normally', lines: [], tip: `${name}\nRunning normally` };
  // ONE cause, one line: while the link to Windows is down, every piece that needs it says so with
  // the same reason tacked on (sidecarUnavailable), and seven lines of one fault read as seven faults.
  const root = list.find((p) => p.piece === 'sidecar');
  const rootWhy = root ? String(root.reason || '') : '';
  const waiting = root && rootWhy ? list.filter((p) => p !== root && String(p.reason || '').endsWith(rootWhy)) : [];
  const rest = list.filter((p) => p !== root && !waiting.includes(p));
  const sc = opt.sidecar || {};
  const rootLine = root
    ? `Mantle's link to Windows ${sc.status === 'starting' ? 'is starting' : sc.gaveUp ? 'stopped' : 'stopped; trying again'}${waiting.length ? ` (${waiting.length} ${waiting.length === 1 ? 'thing waits' : 'things wait'} on it)` : ''}`
    : null;
  const count = (root ? 1 : 0) + rest.length;
  const head = `${count} ${count === 1 ? 'thing needs' : 'things need'} a look`;
  const shown = (rootLine ? [rootLine] : []).concat(rest.slice(0, rootLine ? 3 : 4).map((p) => `${pieceWords(p.piece)}: ${shortReason(p.reason, 64)}`));
  const hidden = count - shown.length;
  if (hidden > 0) shown.push(`…and ${hidden} more, listed in Mantle Settings`);
  const names = (root ? ["Mantle's link to Windows"] : []).concat(rest.map((p) => pieceWords(p.piece))).join(', ');
  const tip = `${name}\n${head}: ${names}`;
  return { head, lines: shown, tip: tip.length > 120 ? `${tip.slice(0, 119)}…` : tip };
}
/*
 * The template, with ids where main attaches the clicks. o: {test, paused, problems, recovery,
 * shortcuts:{launcher, killSwitch}, hasSettings, featureItems}. featureItems arrive ready-made from
 * lib/switcher.js and lib/features.js (their own clicks) and go one level down, under "Features".
 */
function trayTemplate(o) {
  const h = trayHealth(o.problems, o);
  const out = [{ label: h.head, enabled: false }];
  for (const l of h.lines) out.push({ label: `    ${l}`, enabled: false });
  // The way back sits right under the fault it fixes: the link gave up restarting on its own.
  if (!o.paused && o.sidecar && o.sidecar.gaveUp) out.push({ id: 'retry', label: 'Reconnect Mantle to Windows' });
  if (o.recovery) out.push({ label: `    ${o.recovery}`, enabled: false });
  out.push({ type: 'separator' });
  const keys = o.shortcuts || {};
  out.push(Object.assign({ id: 'launcher', label: 'Open launcher' }, keys.launcher ? { accelerator: 'Alt+Space', registerAccelerator: false } : {}));
  if (o.hasSettings) out.push({ id: 'settings', label: 'Open Mantle Settings', accelerator: 'Super+I', registerAccelerator: false });
  out.push({ id: 'wallpapers', label: 'Wallpapers…' });
  const feats = plainMenu(Array.isArray(o.featureItems) ? o.featureItems : []);
  if (feats.length) out.push({ label: 'Features', submenu: feats });
  out.push({ type: 'separator' });
  out.push({ id: 'report', label: 'Copy diagnostic report' });
  out.push({ id: 'restart', label: o.paused ? 'Restart Mantle to resume' : 'Restart Mantle' });
  // No "hide the Windows taskbar" item, ever: that item called the command behind the 2026-09-21
  // reboot, and a menu entry whose only job is a state Mantle must be alive to undo has no place here.
  if (!o.paused) out.push({ id: 'restore', label: 'Put Windows back (keep Mantle open)' });
  out.push({ type: 'separator' });
  out.push(Object.assign({ id: 'quit', label: 'Quit Mantle' }, keys.killSwitch ? { accelerator: 'Ctrl+Alt+Shift+Backspace', registerAccelerator: false } : {}));
  return out;
}
/** What the menu LOOKS like (functions dropped): equal signatures need no rebuild. */
function menuSignature(items) {
  return JSON.stringify(items, (k, v) => (typeof v === 'function' ? undefined : v));
}
/** Attach a click from `handlers` to every item whose id has one (submenus included). */
function wireTray(items, handlers) {
  for (const it of items) {
    if (it && it.id && typeof handlers[it.id] === 'function') it.click = handlers[it.id];
    if (it && Array.isArray(it.submenu)) wireTray(it.submenu, handlers);
  }
  return items;
}
// </mainrel:tray>

let trayMenuSig = '';
let trayTipText = '';
let shellPaused = null;        // {at, why} once "Put Windows back" ran and Mantle is still up
function trayFeatureItems() {
  const out = [];
  try { out.push(...switcher.trayItems()); } catch (err) { out.push({ label: `Alt+Tab switches could not be listed: ${plain(err.message)}`, enabled: false }); }
  if (features && features.size) {
    if (out.length) out.push({ type: 'separator' });
    try { out.push(...features.trayItems()); } catch (err) { out.push({ label: `The features could not be listed: ${err.message}`, enabled: false }); }
  }
  return out;
}
/*
 * The tray menu is rebuilt in batches (lane mn-state, 2026-10-12; lib/tray-batch.js says why): a State
 * change only asks, and the menu is rebuilt at most once per 250 ms, and only when what it shows moved.
 * trayInputKey is that "what it shows": State pieces by identity (lib/state.js keeps an unchanged piece
 * the same object), the problem list's words, and the few inputs that live outside State. Everything
 * else calls updateTray(), which rebuilds at once.
 */
var trayBatch = null;   // var, not const: a State change can ask before this line has run
function trayInputKey() {
  const st = state.get();
  return [st.features, st.switcher, st.shortcuts, JSON.stringify(state.problems()), shellPaused, recoveryNote,
    sidecar.status, !!sidecar.gaveUp, typeof COMMANDS['settings.open'] === 'function', features ? features.size : 0];
}
function trayBatcher() {
  if (!trayBatch) {
    trayBatch = require('./lib/tray-batch').createTrayBatch({ ms: 250, key: trayInputKey, run: updateTrayNow,
      onError: (err, where) => process.stderr.write(`mantle: the tray menu ${where === 'key' ? 'inputs could not be read' : 'could not be rebuilt'}: ${err && err.message}\n`) });
  }
  return trayBatch;
}
function requestTray() { trayBatcher().request(); }
function updateTray() { trayBatcher().force(); }
function updateTrayNow() {
  if (!tray || tray.isDestroyed()) return;
  const st = state.get();
  const o = {
    test: flags.test,
    paused: !!shellPaused,
    problems: state.problems(),
    recovery: recoveryNote,
    sidecar: { status: sidecar.status, gaveUp: !!sidecar.gaveUp },
    shortcuts: st.shortcuts || {},
    hasSettings: typeof COMMANDS['settings.open'] === 'function',
    featureItems: trayFeatureItems(),
  };
  const items = trayTemplate(o);
  const tip = trayHealth(o.problems, o).tip;
  lastTrayView = o;
  if (tip !== trayTipText) {
    try { tray.setToolTip(tip); trayTipText = tip; } catch (_) { /* the icon went away */ }
  }
  const sig = menuSignature(items);
  if (sig === trayMenuSig) return;
  try {
    tray.setContextMenu(Menu.buildFromTemplate(wireTray(items, TRAY_ACTIONS)));
    trayMenuSig = sig;
  } catch (err) {
    process.stderr.write(`mantle: could not build the tray menu: ${err.message}\n`);
  }
}
/** A tray action that failed says so on screen (a Windows notification from the icon), not only in the log. */
function trayNotice(title, content) {
  process.stdout.write(`mantle: tray: ${title}: ${content}\n`);   // the log keeps the exact words
  try { if (tray && !tray.isDestroyed()) tray.displayBalloon({ title: trayWords(title), content: trayWords(content), iconType: 'warning', noSound: true }); } catch (_) { /* the log line stands */ }
}
const TRAY_ACTIONS = {
  launcher: () => { try { showLauncher(); } catch (err) { trayNotice('The launcher did not open', err.message); } },
  settings: () => {
    const open = COMMANDS['settings.open'];
    if (typeof open !== 'function') { trayNotice('Mantle Settings did not open', 'the Settings feature is turned off'); return; }
    Promise.resolve(open({ via: 'the tray menu' })).then((r) => {
      if (r && r.ok === false) trayNotice('Mantle Settings did not open', r.reason || 'no reason was given');
    }, (err) => trayNotice('Mantle Settings did not open', err.message));
  },
  wallpapers: () => { try { wallpaper.openLibrary(); } catch (err) { trayNotice('Wallpapers did not open', err.message); } },
  report: () => { copyDiagnosticReport('the tray menu').catch((err) => trayNotice('The report was not copied', err.message)); },
  restart: () => {
    COMMANDS['shell.restart']({ via: 'the tray menu' }).then((r) => {
      if (r && r.ok === false) trayNotice('Mantle did not restart', r.reason || 'no reason was given');
    }, (err) => trayNotice('Mantle did not restart', err.message));
  },
  restore: () => {
    shellPaused = { at: Date.now(), why: 'the tray menu' };
    // Windows was asked back: a crash while paused must not start Mantle (and its taskbar hiding) again.
    supervisor.standDown('Windows was put back from the tray menu ("Restore Windows taskbar")');
    restoreShell('the tray menu asked for it').finally(() => updateTray());
  },
  retry: () => {
    COMMANDS['shell.reconnect']().then((r) => {
      if (r && r.ok === false) trayNotice('Mantle could not reconnect to Windows', r.reason || 'no reason was given');
    }, (err) => trayNotice('Mantle could not reconnect to Windows', err.message));
  },
  quit: () => shutdown('the tray menu'),
};
let lastTrayView = null;       // what the tray last showed, for the diagnostic report

// <mainrel:report> (lib/main-rel.test.js runs this region with a made-up snapshot: no outside names in it)
/*
 * "COPY DIAGNOSTIC REPORT" (tray menu; lane core-main, 2026-09-29). When something is off, the
 * question is always the same handful -- which build, how long up, what does Mantle itself say is
 * wrong, what went wrong lately -- and the answers were spread over a 5 MB log and the Settings
 * page. This is all of it in one paste, safe to put in a chat or an issue: no window titles, no
 * file or device names (the health lines are Mantle's own words, the recent lines are Mantle's own
 * log lines), and the user name, PC name and home folder removed by the log's own scrubber.
 * snap: {when, version, commit, electron, windows, mode, uptimeS, displays:[{w,h,scale,primary}],
 * memMB:{main, all, processes}, health:{head, lines}, paused, recovery, features:{on, off, down:[]},
 * link:{status, restarts, gaveUp}, recent:[lines]}.
 */
function buildReport(snap, scrub) {
  const s = snap || {};
  const out = [];
  const dur = (sec) => {
    const n = Math.max(0, Math.round(Number(sec) || 0));
    const h = Math.floor(n / 3600);
    const m = Math.floor((n % 3600) / 60);
    return h ? `${h} h ${m} min` : `${m} min`;
  };
  out.push('Mantle diagnostic report');
  out.push(`Made ${s.when || 'at an unknown time'}. User name, PC name and home folder are left out; read it before you share it.`);
  out.push('');
  out.push(`Mantle ${s.version || '?'}${s.commit ? ` (${s.commit})` : ''}, ${s.mode === 'test' ? 'a test run' : 'running live'}, up ${dur(s.uptimeS)}`);
  out.push(`Windows ${s.windows || '?'}, Electron ${s.electron || '?'}`);
  const ds = Array.isArray(s.displays) ? s.displays : [];
  out.push(`Displays: ${ds.length ? ds.map((d) => `${d.w}x${d.h} at ${Math.round((Number(d.scale) || 1) * 100)}%${d.primary ? ' (main)' : ''}`).join(', ') : 'none reported'}`);
  if (s.memMB) out.push(`Memory: ${s.memMB.all} MB in ${s.memMB.processes} processes (Mantle's main process ${s.memMB.main} MB)`);
  out.push('');
  const h = s.health || {};
  out.push(`Health: ${h.head || 'not known'}`);
  for (const l of h.lines || []) out.push(`  - ${l}`);
  if (s.recovery) out.push(`  - ${s.recovery}`);
  const l = s.link || {};
  out.push(`Link to Windows: ${l.status || '?'}${l.gaveUp ? ', gave up restarting' : ''}${l.restarts ? `, ${l.restarts} restart(s) in a row` : ''}`);
  const f = s.features || {};
  out.push(`Features: ${f.on || 0} on, ${f.off || 0} off${(f.down || []).length ? `; not working: ${f.down.join(', ')}` : ''}`);
  const recent = Array.isArray(s.recent) ? s.recent : [];
  out.push('');
  out.push(recent.length ? `Last ${recent.length} warnings and errors this run, oldest first:` : 'No warnings or errors this run.');
  for (const r of recent) out.push(`  ${r}`);
  const text = out.join('\n') + '\n';
  return typeof scrub === 'function' ? scrub(text) : text;
}
/** A bounded list of the last `max` lines written to stderr, each stamped HH:MM:SS and cut to 240 chars. */
function makeRecentLines(max, now) {
  const lines = [];
  const two = (n) => String(n).padStart(2, '0');
  return {
    add(chunk) {
      const d = now();
      const t = `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
      for (const raw of String(chunk).split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        lines.push(`${t} ${line.length > 240 ? `${line.slice(0, 239)}…` : line}`);
        if (lines.length > max) lines.shift();
      }
    },
    list() { return lines.slice(); },
  };
}
// </mainrel:report>

const recentProblems = makeRecentLines(15, () => new Date());
(function keepRecentProblems() {
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    try { recentProblems.add(chunk); } catch (_) { /* never in the way of a write */ }
    return orig(chunk, ...rest);
  };
})();
let reportScrub = null;
function scrubForReport(text) {
  if (!reportScrub) {
    let user = '';
    try { user = os.userInfo().username; } catch (_) { user = process.env.USERNAME || ''; }
    let host = '';
    try { host = os.hostname(); } catch (_) { host = process.env.COMPUTERNAME || ''; }
    reportScrub = makeScrubber({ home: os.homedir(), user, host });
  }
  return reportScrub(text);
}
async function diagnosticReport() {
  const two = (n) => String(n).padStart(2, '0');
  const d = new Date();
  let version = '?';
  try { version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || '?'; } catch (_) { /* '?' */ }
  const commit = await new Promise((resolve) => {
    require('child_process').execFile('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, windowsHide: true, timeout: 3000 }, (err, out) => resolve(err ? '' : String(out || '').trim()));
  });
  let displays = [];
  try {
    const primary = screen.getPrimaryDisplay().id;
    displays = screen.getAllDisplays().map((x) => ({ w: x.size.width, h: x.size.height, scale: x.scaleFactor, primary: x.id === primary }));
  } catch (_) { /* none reported */ }
  let memMB = null;
  try {
    const m = app.getAppMetrics();
    const kb = (p) => (p.memory && (p.memory.privateBytes || p.memory.workingSetSize)) || 0;
    const main = m.find((p) => p.type === 'Browser');
    memMB = { all: Math.round(m.reduce((t, p) => t + kb(p), 0) / 1024), processes: m.length, main: main ? Math.round(kb(main) / 1024) : '?' };
  } catch (_) { /* left out */ }
  const st = state.get();
  const feats = Object.values(st.features || {});
  const view = lastTrayView || { problems: state.problems(), paused: !!shellPaused, test: flags.test, sidecar: { status: sidecar.status, gaveUp: !!sidecar.gaveUp } };
  const health = trayHealth(view.problems, view);
  return buildReport({
    when: `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`,
    version, commit, electron: process.versions.electron, windows: os.release(), mode: MODE,
    uptimeS: process.uptime(), displays, memMB, health, paused: !!shellPaused, recovery: recoveryNote,
    features: { on: feats.filter((p) => p && p.on).length, off: feats.filter((p) => p && !p.on).length,
      down: feats.filter((p) => p && p.on && p.ok === false && !p.resting).map((p) => p.label || 'a feature') },
    link: { status: sidecar.status, restarts: sidecar.restarts || 0, gaveUp: !!sidecar.gaveUp },
    recent: recentProblems.list(),
  }, scrubForReport);
}
/** The tray item: onto the clipboard, and a notice that says it happened. A test run writes a file instead. */
async function copyDiagnosticReport(via) {
  const text = await diagnosticReport();
  if (flags.test) {
    // Never Owen's clipboard from a test run: the report goes into the test profile instead.
    const file = path.join(app.getPath('userData'), 'diagnostic-report.txt');
    fs.writeFileSync(file, text);
    process.stdout.write(`mantle: diagnostic report (${text.split('\n').length} lines, asked from ${via}) written to the test profile, not the clipboard (test run)\n`);
    return { ok: true, dryRun: true, lines: text.split('\n').length };
  }
  require('electron').clipboard.writeText(text);
  process.stdout.write(`mantle: diagnostic report copied to the clipboard (${text.split('\n').length} lines, asked from ${via})\n`);
  try { if (tray && !tray.isDestroyed()) tray.displayBalloon({ title: 'Diagnostic report copied', content: 'Paste it wherever you need it. Your user name, PC name and home folder were left out.', iconType: 'info', noSound: true }); } catch (_) { /* the log line stands */ }
  return { ok: true };
}

function createTray() {
  try {
    tray = new Tray(trayImage());
    // A left click opens the same menu as a right click: the icon's one job is that menu, and a
    // first click that does nothing reads as broken.
    tray.on('click', () => { try { tray.popUpContextMenu(); } catch (_) { /* the right click still works */ } });
    updateTray();
  } catch (err) {
    // No tray means no mouse-driven escape hatch, which the keyboard kill switch
    // and the desktop state strip both still cover -- but say so.
    tray = null;
    process.stderr.write(`mantle: could not create the tray icon: ${err.message}\n`);
    state.set('shortcuts', { reason: `${state.get().shortcuts.reason}; the tray icon could not be created either (${err.message})` });
  }
}

// ---------------------------------------------------------------------------
// Global shortcuts.
// ---------------------------------------------------------------------------
function registerShortcuts() {
  if (flags.test) {
    // globalShortcut is system-wide: a test run would swallow Owen's Alt+Space
    // for as long as it is up. Nothing was changed in test mode, so there is
    // nothing for a kill switch to undo either.
    state.set('shortcuts', {
      killSwitch: false,
      launcher: false,
      reason: 'test mode: no global shortcuts were registered (they would swallow Alt+Space system-wide while the test runs)',
    });
    return;
  }

  const problems = [];
  let killSwitch = false;
  let launcher = false;
  try {
    killSwitch = globalShortcut.register('Ctrl+Alt+Shift+Backspace', () => {
      supervisor.standDown('the kill switch');   // first: a crash during the restore must not bring it back
      restoreShell('the kill switch').finally(() => shutdown('the kill switch'));
    });
  } catch (err) {
    problems.push(`Ctrl+Alt+Shift+Backspace threw (${err.message})`);
  }
  if (!killSwitch && !problems.length) problems.push('Ctrl+Alt+Shift+Backspace is already taken by another app, so the kill switch is NOT armed');

  try {
    launcher = globalShortcut.register('Alt+Space', () => {
      toggleLauncher('Alt+Space');
    });
  } catch (err) {
    problems.push(`Alt+Space threw (${err.message})`);
  }
  if (!launcher && !problems.some((p) => p.includes('Alt+Space'))) problems.push('Alt+Space is already taken by another app, so it will not open the launcher');

  state.set('shortcuts', {
    killSwitch,
    launcher,
    reason: problems.length
      ? problems.join('; ')
      : 'Ctrl+Alt+Shift+Backspace puts Windows back, Alt+Space opens the launcher',
  });
}

// ---------------------------------------------------------------------------
// Screenshot mode: photograph the three windows, then leave.
// ---------------------------------------------------------------------------
function settled(win) {
  // Resolve on whichever comes first: a finished load, a failed one, or 20s.
  return new Promise((resolve) => {
    if (!win || win.isDestroyed()) { resolve(); return; }
    const wc = win.webContents;
    if (!wc.isLoading()) { resolve(); return; }
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    wc.once('did-finish-load', finish);
    wc.once('did-fail-load', finish);
    const t = setTimeout(finish, 20000);
    if (t.unref) t.unref();
  });
}

async function runScreenshots(dir) {
  // The bar is hidden by default now, and capturePage() on a window that has
  // never been shown photographs nothing. A screenshot run wants to SEE it.
  revealBar('a screenshot run asked for the bar');
  stopHoverWatch();   // ...and the poll must not take it away again mid-settle
  const targets = [['bar', barWin], ['launcher', launcherWin], ['desktop', desktopWin]];
  await Promise.all(targets.map(([, w]) => settled(w)));
  // Four seconds of settling: web fonts, the first stats tick, the Mission
  // Control probe and whatever the other lanes' pages do on load.
  await new Promise((r) => setTimeout(r, 4000));
  /* --test-pops (below) photographs what the SIDECAR feeds (the tray probe, now playing), which on
     a loaded machine can land after those four seconds: wait for both, up to 20 s more, and say so
     if they never came. */
  const popsArg = ARGV.find((x) => typeof x === 'string' && x.startsWith('--test-pops='));
  const pops = popsArg ? popsArg.slice('--test-pops='.length).split(',').map((x) => x.trim()).filter(Boolean) : [];
  if (pops.length) {
    /* ...and for the PINS: on a loaded machine the pinned list has landed 35 s after start (one
       run, 2026-09-22), and a dock photographed before it is an empty dock, which proves nothing
       about whether the chip and the pins fit together. 60 s, then it says what was missing. */
    const t0 = Date.now();
    const until = t0 + 60000;
    const pageW = () => (barWin && !barWin.isDestroyed() ? barWin.getContentSize()[0] : 0);
    const liveW = barGeometry().rest.dip.width;
    const pinsIn = () => !!(lastPinned && Array.isArray(lastPinned.items) && lastPinned.items.length);
    while (Date.now() < until && !(lastMedia && lastMedia.ok && lastTray && pinsIn() && pageW() === liveW)) await wait(250);
    process.stdout.write(`mantle: --test-pops: after ${((Date.now() - t0) / 1000).toFixed(1)} s: bar page ${pageW()} css px wide (the live pill's is ${liveW}), ` +
      `pins ${pinsIn() ? `in (${lastPinned.items.length} items)` : 'NOT in'}\n`);
    await wait(1500);   // the dock settles 50 ms after the resize, the media chip after the pill lands
    // What the page decided, in words: the media chip's state and every status chip, so a pass
    // ("no apps hidden while the chip shows") is read off the page rather than off a picture.
    try {
      const seen = await barWin.webContents.executeJavaScript(
        "(function(){var m=document.getElementById('media');return JSON.stringify({page:innerWidth+'x'+innerHeight,media:m?(m.hidden?'hidden':m.className):'none'," +
        "title:(document.querySelector('#mchip .mtxt')||{}).textContent||''," +
        "cells:document.querySelectorAll('#dock .cell').length," +
        "chips:Array.prototype.map.call(document.querySelectorAll('.chip'),function(c){return c.title;})});})()");
      process.stdout.write(`mantle: --test-pops: page says ${seen}\n`);
    } catch (err) {
      process.stdout.write(`mantle: --test-pops: could not read the page's state: ${err.message}\n`);
    }
    process.stdout.write(`mantle: --test-pops: media ${lastMedia ? (lastMedia.ok ? 'read' : `read FAILED (${lastMedia.reason})`) : 'NOT read in time'}, tray ${lastTray ? `read (${lastTray.length} icons)` : 'NOT read in time'}\n`);
    await wait(800);   // the pushes' paint
  }

  // The directory is printed RESOLVED: a --screenshot path that lost its
  // backslashes on the way through a shell once wrote three PNGs into the repo
  // root under a mangled name, and nothing said where they had gone.
  process.stdout.write(`mantle: screenshots are going to ${dir}\n`);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    process.stderr.write(`mantle: cannot write screenshots to ${dir}: ${err.message}\n`);
    shutdown('the screenshot directory could not be made');
    return;
  }

  for (const [name, win] of targets) {
    const out = path.join(dir, `${name}.png`);
    if (!win || win.isDestroyed()) {
      process.stdout.write(`mantle: no ${name} window to capture (skipped ${out})\n`);
      continue;
    }
    try {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(out, img.toPNG());
      const size = img.getSize();
      process.stdout.write(`mantle: wrote ${out} (${size.width}x${size.height})\n`);
    } catch (err) {
      process.stderr.write(`mantle: could not capture the ${name} window: ${err.message}\n`);
    }
  }

  /* --test-pops=media,more,...: after the three windows, open each named bar popover through
     the page's own test hook (bar.test.click, the real open path, no mouse) and capture the bar
     window with it up, as bar-<name>.png. For photographing the media card and the overflow's
     hidden tray icons from a real test instance. Test only: runScreenshots itself is. */
  for (const what of pops) {
    if (!barWin || barWin.isDestroyed()) break;
    broadcast('bar.test.click', { what });
    await new Promise((r) => setTimeout(r, 1800));   // the popover's room, its first read, a paint
    if (what === 'qs' || what === 'qs-nightlight') {
      /* The panel in words, as the real sidecar's watch filled it (2026-09-23): each tile, the two
         levels, the notes, and the network and speaker readouts, so a run is read, not squinted at. */
      try {
        const seen = await barWin.webContents.executeJavaScript(
          "(function(){var q=function(s){return Array.prototype.slice.call(document.querySelectorAll(s));};return JSON.stringify({" +
          "tiles:q('.qstile').map(function(t){return (t.querySelector('.qslbl')||{}).textContent+'='+(t.classList.contains('on')?'on':'off')+(t.classList.contains('dead')?',dead':'')+(t.classList.contains('pending')?',pending':'')+' ('+(t.querySelector('.qssub')||{}).textContent+')';})," +
          "levels:q('.qsrow .qsval').map(function(v){return v.textContent;}),notes:q('.qsnotes .note').map(function(n){return n.textContent;})," +
          "network:(document.getElementById('network')||{dataset:{}}).dataset.state,speaker:((document.getElementById('volume')||{}).title||'').split(String.fromCharCode(10))[0]});})()");
        process.stdout.write(`mantle: --test-pops qs: page says ${seen}\n`);
      } catch (err) {
        process.stdout.write(`mantle: --test-pops qs: could not read the panel: ${err.message}\n`);
      }
    }
    const out = path.join(dir, `bar-${what}.png`);
    try {
      const img = await barWin.webContents.capturePage();
      fs.writeFileSync(out, img.toPNG());
      const size = img.getSize();
      process.stdout.write(`mantle: wrote ${out} (${size.width}x${size.height})\n`);
    } catch (err) {
      process.stderr.write(`mantle: could not capture the bar with "${what}" open: ${err.message}\n`);
    }
    broadcast('bar.test.click', { what: 'close' });
    await new Promise((r) => setTimeout(r, 500));
  }
  shutdown('the screenshots are done');
}

/*
 * --test-trace=<dir> (TEST ONLY; see the flag). For each right-cluster button: 300 ms at rest,
 * a click through the page (the same click handler a mouse runs), 1 s, a second click to close
 * it, 1 s. Meanwhile the page records every frame (its size, the pill's rect, the popover's) and
 * main reads the window's physical rect every millisecond (GetWindowRect, timer resolution
 * raised to 1 ms for the run). Also: a panel swapped for another while open, and a pinned app's
 * window flyout. trace.json holds every sample; one line per target says how far the WINDOW
 * moved and how far the PILL moved on screen, where the pill on screen is the window's top plus
 * where the page's last frame drew it (a DirectComposition window shows its last frame at the
 * window's top-left until the page draws one at the new size).
 */
let traceMarks = null;
const traceNow = () => performance.timeOrigin + performance.now();
/* TEST ONLY (lane mantle-corner): a --test run moves the bar itself, for the corner-glide trace. The hover
   watch stops on the first call (the real cursor is Owen's: it must not reveal or hide a test bar), and only
   then, so a reveal asked for mid-hide is still a reveal. Never registered live. */
let testMoveArmed = false;
if (flags.test) {
  /* TEST ONLY (lane mantle-barhover): with MANTLE_BAR_TEST_CURSOR=1 the hover poll reads THIS point,
     never the real cursor (Owen's), from its first tick; bar.testCursor {x, y} (DIP) moves it and says
     what the bar is doing, so a test can sweep the keep band through the real hoverTick. */
  COMMANDS['bar.testCursor'] = async (a) => {
    if (!testCursor) return { ok: false, reason: 'start the test with MANTLE_BAR_TEST_CURSOR=1, or the poll reads the real cursor' };
    if (a && Number.isFinite(a.x) && Number.isFinite(a.y)) testCursor = { x: a.x, y: a.y };
    let geo = null;
    try { geo = barGeometry(); } catch (_) { /* no display */ }
    return {
      ok: true, cursor: testCursor, revealed: barRevealed, hiding: !!hideTimer, up: barRevealed && !hideTimer,
      popover: barPopover ? { kind: popKind(barPopover.key), height: barPopover.height } : null,
      rect: barRect(), rest: geo ? geo.rest.dip : null, screen: screen.getPrimaryDisplay().bounds, tall: barTall(),
      polling: !!hoverTimer,
    };
  };
  COMMANDS['bar.testMove'] = async (a) => {
    if (!testMoveArmed) { testMoveArmed = true; stopHoverWatch(); }
    if (a && a.up) revealBar('a test asked for the bar'); else beginHide('a test asked the bar to go');
    return { ok: true, up: barUpNow(), rect: barRect(), tall: barTall() };
  };
}

async function runTrace(dir) {
  const say = (s) => process.stdout.write(`mantle: --test-trace: ${s}\n`);
  const out = path.resolve(dir);
  try { fs.mkdirSync(out, { recursive: true }); } catch (err) { say(`cannot write to ${out}: ${err.message}`); shutdown('the trace directory could not be made'); return; }
  await settled(barWin);
  // the live roads need the sidecar (placement) and, for the flyout, a running app in the pins
  for (let i = 0; i < 60 && (sidecar.status !== 'ok' || (flags.testLiveBar && sidecarDpiAware === null)); i++) await wait(500);
  for (let i = 0; i < 40; i++) {
    const items = lastPinned && Array.isArray(lastPinned.items) ? lastPinned.items : [];
    if (items.some((it) => Array.isArray(it.windows) && it.windows.length)) break;
    await wait(500);
  }
  revealBar('a trace run asked for the bar');
  stopHoverWatch();                     // the real cursor is Owen's: it must not hide or reveal this bar
  await wait(REVEAL_MS + 1800);         // landed, and the backdrop loop running, as it is when Owen clicks

  let koffi, getRect, beginPeriod, endPeriod;
  try {
    koffi = require('koffi');
    try { koffi.struct('MANTLE_TRACE_RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' }); } catch (_) { /* defined by an earlier run in this process */ }
    const user32 = koffi.load('user32.dll');
    const winmm = koffi.load('winmm.dll');
    getRect = user32.func('int __stdcall GetWindowRect(intptr_t hwnd, _Out_ MANTLE_TRACE_RECT *rect)');
    beginPeriod = winmm.func('uint32 __stdcall timeBeginPeriod(uint32 p)');
    endPeriod = winmm.func('uint32 __stdcall timeEndPeriod(uint32 p)');
  } catch (err) {
    say(`GetWindowRect could not be bound (${err.message}), so there is nothing to trace`);
    shutdown('the trace could not start');
    return;
  }
  const hwnd = Number(hwndOf(barWin));
  const sf = screen.getPrimaryDisplay().scaleFactor || 1;
  const wc = barWin.webContents;
  const js = (code) => wc.executeJavaScript(code, true);
  // the page's clock against main's, both epoch milliseconds: the midpoint of one round trip
  const t0 = traceNow();
  const pageT = await js('performance.timeOrigin + performance.now()');
  const skew = pageT - (t0 + traceNow()) / 2;
  const REC = "(function(){var T=window.__trace={frames:[],on:true};var bar=document.querySelector('.bar'),pop=document.getElementById('pop');" +
    "function f(){if(!T.on)return;var r=bar.getBoundingClientRect(),p=pop&&!pop.hidden?pop.getBoundingClientRect():null;" +
    "T.frames.push([performance.timeOrigin+performance.now(),innerWidth,innerHeight,Math.round(r.left*10)/10,Math.round(r.top*10)/10,Math.round(r.width*10)/10,Math.round(r.height*10)/10,p?Math.round(p.top):null,p?Math.round(p.height):null]);" +
    "requestAnimationFrame(f);}requestAnimationFrame(f);return true;})()";
  const clickJs = (sel) => `(function(){var e=document.querySelector(${JSON.stringify(sel)});if(!e)return 'no '+${JSON.stringify(sel)};e.click();return 'clicked';})()`;

  const targets = [
    { name: 'speaker (quick settings)', open: '#volume', close: '#volume' },
    { name: 'network (quick settings)', open: '#network', close: '#network' },
    { name: 'battery (quick settings)', open: '#battery', close: '#battery' },
    { name: 'clock (calendar)', open: '#clock', close: '#clock' },
    { name: 'bell (notifications)', open: '#notifs', close: '#notifs' },
    { name: '... (more)', open: '#more', close: '#more' },
    { name: 'speaker, then clock while it is open', open: '#volume', swap: '#clock', close: '#clock' },
    { name: 'a pinned app\'s window flyout', fly: true },
  ];
  const results = [];
  const cap = await traceCaptureStart(out, barWin);
  say(cap.why ? `DWM's own frames are NOT recorded (${cap.why}); only the model is` : 'recording DWM\'s own frames of the bar window as well');
  beginPeriod(1);
  try {
    for (const tg of targets) {
      const tStart = traceNow();
      const samples = [];
      let last = null;
      const rect = {};
      const sample = () => {
        if (!getRect(hwnd, rect)) return;
        const k = rect.left + ',' + rect.top + ',' + rect.right + ',' + rect.bottom;
        const t = traceNow();
        if (k !== last) { samples.push([t, rect.left, rect.top, rect.right, rect.bottom]); last = k; }
      };
      const timer = setInterval(sample, 1);
      traceMarks = [];
      await js(REC);
      await wait(300);
      const events = [];
      if (tg.fly) {
        const items = lastPinned && Array.isArray(lastPinned.items) ? lastPinned.items : [];
        const it = items.find((x) => Array.isArray(x.windows) && x.windows.length);
        const match = it ? (it.name || it.title || it.id || '') : '';
        events.push({ t: traceNow(), what: 'flyout open', match });
        broadcast('bar.test.flyout', { match });
        await wait(1500);
        events.push({ t: traceNow(), what: 'flyout close' });
        broadcast('bar.test.click', { what: 'close' });
        await wait(1000);
      } else {
        events.push({ t: traceNow(), what: 'click ' + tg.open, r: await js(clickJs(tg.open)) });
        await wait(1000);
        if (tg.swap) {
          events.push({ t: traceNow(), what: 'click ' + tg.swap, r: await js(clickJs(tg.swap)) });
          await wait(1000);
        }
        events.push({ t: traceNow(), what: 'click ' + tg.close + ' (close)', r: await js(clickJs(tg.close)) });
        await wait(1000);
      }
      clearInterval(timer);
      const tEnd = traceNow();
      const frames = await js('(function(){var T=window.__trace;T.on=false;return T.frames;})()');
      const marks = traceMarks;
      traceMarks = null;
      results.push(Object.assign(traceAnalyse(tg.name, samples, frames.map((f) => [f[0] - skew].concat(f.slice(1))), events, marks, sf), { samples, frames, events, marks, tStart, tEnd }));
      await wait(300);
    }
  } finally {
    endPeriod(1);
  }
  let dwm = null;
  if (!cap.why) {
    dwm = await cap.stop();
    say(`DWM frames: ${dwm.frames.length} captured${dwm.err ? `, then the capture failed: ${dwm.err}` : ''}; stream ${JSON.stringify(dwm.settings)}`);
    for (const r of results) {
      r.dwm = traceDwmAnalyse(dwm.frames, r.tStart, r.events.length ? r.events[0].t : r.tStart, r.tEnd);
      r.line += `; DWM: ${r.dwm.line}`;
    }
  }
  fs.writeFileSync(path.join(out, 'trace.json'), JSON.stringify({ at: new Date().toISOString(), liveBar: flags.testLiveBar, scale: sf, skewMs: skew, dwm, results }, null, 1));
  for (const r of results) say(r.line);
  say(`wrote ${path.join(out, 'trace.json')}`);
  shutdown('the trace is done');
}

/* One target's numbers. The pill on screen at time t is where DWM draws it: the window's top at t
   (physical, /sf) plus the pill's top in the page's LAST frame before t. At rest the two agree;
   while the window's size changes faster than the page redraws, they do not. */
function traceAnalyse(name, samples, frames, events, marks, sf) {
  const at = (arr, t) => { let v = null; for (const x of arr) { if (x[0] <= t) v = x; else break; } return v; };
  const tClick = events.length ? events[0].t : 0;
  const base = at(samples, tClick) || samples[0];
  const baseFrame = at(frames, tClick) || frames[0];
  const onScreen = (s, f) => s[2] / sf + f[4];            // window top (DIP) + pill top in the page
  const restTop = base && baseFrame ? onScreen(base, baseFrame) : null;
  let winMoves = 0, maxWinDy = 0, maxWinDh = 0, maxPill = 0, maxPillAt = null, stale = 0;
  const times = samples.map((s) => s[0]).concat(frames.map((f) => f[0])).sort((a, b) => a - b);
  for (const t of times) {
    if (t < tClick) continue;
    const s = at(samples, t), f = at(frames, t);
    if (!s || !f || restTop === null) continue;
    const d = onScreen(s, f) - restTop;
    if (Math.abs(d) > Math.abs(maxPill)) { maxPill = d; maxPillAt = Math.round(t - tClick); }
  }
  for (const s of samples) {
    if (s[0] < tClick || !base) continue;
    if (s !== base) winMoves++;
    maxWinDy = Math.max(maxWinDy, Math.abs(s[2] - base[2]));
    maxWinDh = Math.max(maxWinDh, Math.abs((s[4] - s[2]) - (base[4] - base[2])));
  }
  for (const f of frames) {
    if (f[0] < tClick) continue;
    const s = at(samples, f[0]);
    if (s && Math.abs(f[2] - (s[4] - s[2]) / sf) > 1.5) stale++;
  }
  const line = `${name}: window rect changed ${winMoves} time(s), top moved up to ${maxWinDy} px, height up to ${maxWinDh} px; ` +
    `the pill on screen moved up to ${Math.round(maxPill * 10) / 10} dip (${maxPillAt === null ? 'never' : `at +${maxPillAt} ms`}); ` +
    `${stale} page frame(s) drawn for a window size it no longer had`;
  return { name, line, winMoves, maxWinDy, maxWinDh, maxPill, maxPillAt, stale };
}

/*
 * What DWM actually composed for the bar window, frame by frame (TEST ONLY, --test-trace).
 * The page's frames say what it DREW and GetWindowRect says where the window WAS; neither is the
 * picture. So this asks Windows for the window's own composed image through Chromium's desktop
 * capturer (Windows.Graphics.Capture for a window: it sees the window while others cover it, and
 * it sees ONLY this window -- nothing of Owen's screen is captured). Nothing is kept but numbers:
 * per frame its size and the rows where glass as wide as the pill is lit.
 */
async function traceCaptureStart(out, target) {
  // The bar's own id: no list of other windows is ever asked for.
  let id;
  try { id = target.getMediaSourceId(); } catch (err) { return { why: `the bar window has no capture id (${err.message})` }; }
  // a file:// page, because getUserMedia needs a secure context; it lives in the trace dir
  const html = path.join(out, 'capture.html');
  fs.writeFileSync(html, '<!doctype html><meta charset="utf-8"><title>mantle trace capture</title>');
  const win = new BrowserWindow({ show: false, width: 200, height: 200, webPreferences: { backgroundThrottling: false, contextIsolation: true, sandbox: true, nodeIntegration: false } });
  try {
    await win.loadFile(html);
    const t0 = traceNow();
    const pageT = await win.webContents.executeJavaScript('performance.timeOrigin + performance.now()', true);
    const skew = pageT - (t0 + traceNow()) / 2;
    const started = await win.webContents.executeJavaScript(`(${traceCaptureInPage.toString()})(${JSON.stringify(id)})`, true);
    if (started !== true) { win.destroy(); return { why: String(started) }; }
    return {
      why: null,
      async stop() {
        let res;
        try { res = await win.webContents.executeJavaScript('window.__cap.stop()', true); } catch (err) { res = { err: err.message, frames: [] }; }
        try { win.destroy(); } catch (_) { /* gone already */ }
        return { settings: res.settings || null, err: res.err || null, frames: (res.frames || []).map((f) => [f[0] - skew].concat(f.slice(1))) };
      },
    };
  } catch (err) {
    try { win.destroy(); } catch (_) { /* gone already */ }
    return { why: `the capture page failed: ${err.message}` };
  }
}

/* Runs INSIDE the capture page: traceCaptureStart stringifies it; main never calls it. Per frame:
   [t, width, height, timestamp us, runs], runs = [top, bottom] rows where most of 9 columns
   (10%..90% across) are lit. The window's transparent parts come through black; the glass does
   not. A popover is narrower than the pill, so only the pill (and the calendar) make a run. */
function traceCaptureInPage(id) {
  const C = window.__cap = { frames: [], settings: null, err: null, on: true };
  const N = 9;
  const LIT = 40;
  return navigator.mediaDevices.getUserMedia({ audio: false, video: { mandatory: {
    chromeMediaSource: 'desktop', chromeMediaSourceId: id,
    minWidth: 1, maxWidth: 4096, minHeight: 1, maxHeight: 4096, minFrameRate: 30, maxFrameRate: 60,
  } } }).then((stream) => {
    const track = stream.getVideoTracks()[0];
    C.settings = track.getSettings();
    const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
    const cv = new OffscreenCanvas(N, 8);
    const g = cv.getContext('2d', { willReadFrequently: true });
    let done;
    const finished = new Promise((r) => { done = r; });
    C.stop = () => { C.on = false; try { track.stop(); } catch (_) { /* stopped */ } return finished.then(() => ({ settings: C.settings, err: C.err, frames: C.frames })); };
    (async () => {
      try {
        while (C.on) {
          const r = await reader.read();
          if (r.done) break;
          const fr = r.value;
          const t = performance.timeOrigin + performance.now();
          const w = fr.displayWidth;
          const h = fr.displayHeight;
          if (cv.height !== h) cv.height = h;
          for (let i = 0; i < N; i++) g.drawImage(fr, Math.round(w * (0.1 + 0.8 * i / (N - 1))), 0, 1, h, i, 0, 1, h);
          const ts = fr.timestamp;
          fr.close();
          const d = g.getImageData(0, 0, N, h).data;
          const runs = [];
          let start = -1;
          let gap = 0;
          let anyTop = -1;   // the highest row ANY column is lit on: a popover shows up here
          for (let y = 0; y < h; y++) {
            let n = 0;
            for (let i = 0; i < N; i++) { const k = (y * N + i) * 4; if (0.2126 * d[k] + 0.7152 * d[k + 1] + 0.0722 * d[k + 2] > LIT) n++; }
            if (n && anyTop < 0) anyTop = y;
            if (n * 2 > N) { if (start < 0) start = y; gap = 0; } else if (start >= 0 && ++gap > 2) { runs.push([start, y - gap]); start = -1; gap = 0; }
          }
          if (start >= 0) runs.push([start, h - 1 - gap]);
          C.frames.push([t, w, h, ts, runs, anyTop]);
        }
      } catch (e) { C.err = String((e && e.message) || e); }
      done();
    })();
    return true;
  }).catch((e) => `the capture would not start: ${(e && e.message) || e}`);
}

/* One target's DWM frames: where the pill was drawn relative to the window's bottom edge (which
   is the screen's), against where it was in the frames before the click. */
function traceDwmAnalyse(frames, t0, tClick, t1) {
  const pillOf = (f) => { const runs = f[4].filter((r) => r[1] - r[0] + 1 >= 20); return runs.length ? runs[runs.length - 1] : null; };
  const inRange = frames.filter((f) => f[0] >= t0 && f[0] <= t1);
  const gaps = inRange.filter((f) => f[0] < tClick).map((f) => { const p = pillOf(f); return p ? f[2] - 1 - p[1] : null; }).filter((v) => v !== null).sort((a, b) => a - b);
  if (!gaps.length) return { n: inRange.length, line: `${inRange.length} frame(s), none before the click showed the pill, so nothing to compare with` };
  const base = gaps[Math.floor(gaps.length / 2)];
  let n = 0, moved = 0, missing = 0, up = 0, down = 0, firstAt = null, above = 0, highest = null;
  for (const f of inRange) {
    if (f[0] < tClick) continue;
    n++;
    const p = pillOf(f);
    // something lit well above the pill = a popover DWM actually showed
    if (p && f[5] >= 0 && f[5] < p[0] - 20) { above++; highest = highest === null ? p[0] - f[5] : Math.max(highest, p[0] - f[5]); }
    if (!p) { missing++; if (firstAt === null) firstAt = Math.round(f[0] - tClick); continue; }
    const dy = (f[2] - 1 - p[1]) - base;          // > 0: drawn HIGHER than at rest
    if (Math.abs(dy) > 1) {
      moved++;
      if (firstAt === null) firstAt = Math.round(f[0] - tClick);
      if (dy > up) up = dy;
      if (-dy > down) down = -dy;
    }
  }
  const line = `${n} frame(s) after the click, the pill out of place in ${moved} (up to ${up} px higher, ${down} px lower) and missing from ${missing}` +
    (firstAt === null ? '' : ` (first at +${firstAt} ms)`) +
    `; a popover drawn above it in ${above}${highest === null ? '' : ` (reaching ${highest} px above the pill)`}`;
  return { n, moved, missing, up, down, base, firstAt, above, highest, line };
}

/*
 * --test --flyout=<app> [--screenshot=<dir>]: open the bar's window flyout for the first
 * running app matching <app>, exactly as a 400 ms hover would, and (with a dir) photograph it
 * WITH its live previews. Nobody's mouse moves and no input is injected: the page is sent
 * 'bar.test.flyout', which runs the same openFly() the hover dwell runs, and the test bar is
 * kept at the BACK of the z-order throughout (raiseBar sends it back instead of up).
 *
 * The photo takes two captures because no one capture has both halves: capturePage() has the
 * page but not the previews (DWM draws those over the page from outside it), PrintWindow has
 * the previews but not the page (see lib/thumbs.js capture). flyout-page.png and flyout-dwm.png
 * are those two as they came; flyout.png is the page with every preview rectangle pasted in
 * from the DWM capture, i.e. the flyout as it looks on screen.
 */
async function runFlyoutTest(match, dir) {
  const { nativeImage } = require('electron');
  const say = (s) => process.stdout.write(`mantle: --flyout: ${s}\n`);
  stopHoverWatch();   // nobody is hovering the test bar, so the poll would only take it away mid-test
  await settled(barWin);
  // There is nothing to hover until the pinned list has arrived with a running app in it.
  for (let i = 0; i < 90; i++) {
    const items = lastPinned && Array.isArray(lastPinned.items) ? lastPinned.items : [];
    if (items.some((it) => Array.isArray(it.windows) && it.windows.length)) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  revealBar('the --flyout test opened the bar');
  await new Promise((r) => setTimeout(r, 2000));
  say(`asking the bar page to open the flyout for "${match}"`);
  broadcast('bar.test.flyout', { match });
  // the popover's resize, the page's two-frame wait, the first bar.thumbs, and DWM's first frame
  await new Promise((r) => setTimeout(r, 5000));
  const res = lastThumbSync;
  say(res
    ? res.thumbs.map((t) => `${t.hwnd}: ${t.ok ? `live, source ${t.source.w}x${t.source.h}${t.minimized ? ', minimized' : ''}` : t.reason}`).join(' | ') || 'bar.thumbs was called with no cards'
    : 'the bar page never asked for previews');
  if (!dir) return;

  try {
    fs.mkdirSync(dir, { recursive: true });
    const page = await barWin.webContents.capturePage();
    const dpr = screen.getDisplayMatching(barWin.getBounds()).scaleFactor;
    const sz = page.getSize();
    // The page at physical size, so the physical preview rectangles paste 1:1. capturePage()
    // already answers in physical px on this machine (measured: 1383 px for 1106 DIP at 1.25);
    // only if it ever answers in DIP is it scaled up.
    const cb = barWin.getContentBounds();
    const pw = Math.round(cb.width * dpr);
    const ph = Math.round(cb.height * dpr);
    const phys = Math.abs(sz.width - pw) <= 2 ? page : page.resize({ width: pw, height: ph, quality: 'best' });
    const pbmp = Buffer.from(phys.toBitmap());
    const pageW = phys.getSize().width;
    const pageH = phys.getSize().height;
    fs.writeFileSync(path.join(dir, 'flyout-page.png'), phys.toPNG());

    const shot = thumbs.capture(hwndOf(barWin));
    if (!shot.ok) {
      say(`no DWM capture (${shot.reason}); flyout-page.png shows the cards without their pictures`);
    } else {
      fs.writeFileSync(path.join(dir, 'flyout-dwm.png'), nativeImage.createFromBitmap(shot.bgra, { width: shot.width, height: shot.height }).toPNG());
      const off = (res && res.offset) || { x: 0, y: 0 };
      // Where each picture SHOULD be in flyout-dwm.png (window px), to check against where DWM put it.
      say(`client at ${shot.client.x},${shot.client.y} in the window, page at +${off.x},+${off.y} in the client; pictures expected at ${((res && res.thumbs) || []).filter((t) => t.ok).map((t) => `x ${shot.client.x + t.drawn.left}..${shot.client.x + t.drawn.right - 1} y ${shot.client.y + t.drawn.top}..${shot.client.y + t.drawn.bottom - 1}`).join(', ') || 'nowhere (none live)'}`);
      let pasted = 0;
      for (const t of (res && res.thumbs) || []) {
        if (!t.ok || !t.drawn) continue;
        const w = t.drawn.right - t.drawn.left;
        const h = t.drawn.bottom - t.drawn.top;
        for (let row = 0; row < h; row++) {
          const sy = shot.client.y + t.drawn.top + row;
          const dy = t.drawn.top - off.y + row;
          if (sy < 0 || sy >= shot.height || dy < 0 || dy >= pageH) continue;
          const sx = shot.client.x + t.drawn.left;
          const dx = t.drawn.left - off.x;
          const cols = Math.min(w, shot.width - sx, pageW - dx);
          if (cols <= 0 || sx < 0 || dx < 0) continue;
          shot.bgra.copy(pbmp, (dy * pageW + dx) * 4, (sy * shot.width + sx) * 4, (sy * shot.width + sx + cols) * 4);
        }
        pasted++;
      }
      fs.writeFileSync(path.join(dir, 'flyout.png'), nativeImage.createFromBitmap(pbmp, { width: pageW, height: pageH }).toPNG());
      say(`wrote flyout.png (${pageW}x${pageH}, ${pasted} live preview${pasted === 1 ? '' : 's'} pasted in), flyout-page.png and flyout-dwm.png to ${dir}`);
    }
  } catch (err) {
    say(`the capture failed: ${err.message}`);
  }
  shutdown('the --flyout screenshots are done');
}

// ---------------------------------------------------------------------------
// Boot.
// ---------------------------------------------------------------------------
// <mainrel:revive> (lib/main-rel.test.js runs this region with a fake clock)
/*
 * A page whose renderer dies (render-process-gone, not a clean exit) is reloaded: its WINDOW stays
 * exactly as it is (the bar is parked below the screen and is never hide()/show()n), only the page
 * is loaded again. Bounded: at most `tries` reloads in `windowMs`, spaced by `delays`; one more
 * death inside that window and Mantle stops and SAYS so (report -> the desktop strip and the tray,
 * through the same features piece a broken feature uses). Never while Mantle is quitting or
 * Windows is ending the session (blocked()), when every page is dying on purpose.
 */
function makePageReviver(o) {
  const pages = new Map();   // key -> { deaths: [ms], timer, gaveUp }
  const secs = (ms) => `${Math.round(ms / 100) / 10} s`;
  function rec(key) {
    if (!pages.has(key)) pages.set(key, { deaths: [], timer: null, gaveUp: false });
    return pages.get(key);
  }
  return {
    died(key, label, reason, reload) {
      if (reason === 'clean-exit') return 'clean';   // the page ended on purpose (its window closing)
      const p = rec(key);
      const blocked = o.blocked();
      if (blocked) {
        o.report(key, false, `${label}'s renderer died (${reason}) and was not reloaded: ${blocked}`);
        return 'blocked';
      }
      const t = o.now();
      p.deaths = p.deaths.filter((d) => t - d < o.windowMs);
      p.deaths.push(t);
      if (p.timer) { o.cancel(p.timer); p.timer = null; }
      if (p.gaveUp || p.deaths.length > o.tries) {
        p.gaveUp = true;
        const why = `${label}'s renderer died ${p.deaths.length} times in ${Math.round(o.windowMs / 60000)} min (the last: ${reason}), so Mantle stopped reloading it: restart Mantle from its tray icon`;
        o.report(key, false, why);
        o.say(`mantle: ${why}\n`);
        return 'gave-up';
      }
      const n = p.deaths.length;
      const delay = o.delays[Math.min(n - 1, o.delays.length - 1)];
      o.report(key, false, `${label}'s renderer died (${reason}); reloading it in ${secs(delay)} (try ${n} of ${o.tries} in ${Math.round(o.windowMs / 60000)} min)`);
      o.say(`mantle: ${label}'s renderer died (${reason}); reloading the page in ${secs(delay)}, try ${n} of ${o.tries}\n`);
      p.timer = o.later(() => {
        p.timer = null;
        const late = o.blocked();
        if (late) { o.report(key, false, `${label}'s renderer died (${reason}) and was not reloaded: ${late}`); return; }
        let err = null;
        try { err = reload(); } catch (e) { err = e && e.message ? e.message : String(e); }
        // reload() answers null (reloading), false (its window was closed since: nothing to reload), or why not
        if (err === false) { p.deaths = []; o.report(key, true, `${label}'s window was closed before its reload, so there was nothing to reload`); }
        else if (err) o.report(key, false, `${label}'s renderer died (${reason}) and could not be reloaded: ${err}`);
      }, delay);
      return 'reload';
    },
    // did-finish-load: the page is back (a reload of ours, or any other load after a death).
    loaded(key, label) {
      const p = pages.get(key);
      if (!p || !p.deaths.length) return false;
      const n = p.deaths.length;
      if (p.gaveUp) { p.gaveUp = false; p.deaths = []; }
      o.report(key, true, `${label} was reloaded after its renderer died (${n} time${n === 1 ? '' : 's'} in the last ${Math.round(o.windowMs / 60000)} min)`);
      return true;
    },
  };
}
// </mainrel:revive>

const PAGE_KEYS = { 'The bar': 'page.bar', 'The launcher': 'page.launcher', 'The desktop layer': 'page.desktop' };
// watchPage's recovery (mn-recover, audit #12): a failed load is tried again at these delays (at most this
// many in PAGE_LOAD_RETRY_SPAN_MS), and a page still hung PAGE_HANG_MS after 'unresponsive' is restarted.
// MANTLE_TEST_PAGE_HANG_MS shortens the hang wait in a --test run only.
const PAGE_LOAD_RETRY_MS = [1000, 5000, 30000];
const PAGE_LOAD_RETRY_SPAN_MS = 10 * 60 * 1000;
const PAGE_HANG_MS = (flags.test && Number(process.env.MANTLE_TEST_PAGE_HANG_MS) > 0) ? Number(process.env.MANTLE_TEST_PAGE_HANG_MS) : 10000;
const pageReviver = makePageReviver({
  tries: 3, windowMs: 2 * 60 * 1000, delays: [1000, 5000, 15000],
  now: () => Date.now(),
  later: (fn, ms) => setTimeout(fn, ms),
  cancel: (t) => clearTimeout(t),
  say: (line) => process.stdout.write(line),
  blocked: () => (shuttingDown ? 'Mantle is quitting' : sessionEndingReason()),
  // The same piece shape a feature publishes (lib/features.js), which the desktop strip and the
  // tray already list when ok is false: a dead page is said where Owen looks, not only here.
  report: (key, ok, reason) => {
    const label = key === 'page.bar' ? 'The bar page' : key === 'page.launcher' ? 'The launcher page' : 'The desktop page';
    state.set('features', { [key]: { label, on: true, ok, reason, keys: false, keysReason: '', broken: null, stopped: false } });
  },
});

/*
 * WINDOWS ENDING THE SESSION (sign-out, restart, shut down). Electron's before-quit/will-quit do
 * NOT fire then, so until 2026-09-27 the clean restore never ran: the pages were killed one by one
 * (each reloaded into a dying session), and the next start's guard had to clear the taskbar
 * region (3 times in the log). Every top-level window gets WM_QUERYENDSESSION/WM_ENDSESSION, so
 * every watched window listens and the first one acts:
 *   query-session-end (the question, which another app can still cancel): no reloads for 60 s;
 *   session-end (it WILL end): the same shutdown() road as the tray's Quit. It starts inside the
 *   WM_ENDSESSION handler; Windows may end the process before the sidecar's async restore
 *   finishes, which is what the sidecar's own exit restore, its guard and the restore record
 *   at the next start are for.
 */
// <mainrel:session> (lib/main-rel.test.js runs this region with a fake shutdown)
let sessionEnding = null;   // { phase: 'query'|'end', reasons, at }
function sessionEndingReason() {
  if (!sessionEnding) return null;
  if (sessionEnding.phase === 'end') return `Windows is ending the session (${sessionEnding.reasons})`;
  const ago = Date.now() - sessionEnding.at;
  return ago < 60000 ? `Windows asked to end the session (${sessionEnding.reasons}) ${Math.round(ago / 1000)} s ago` : null;
}
function onSessionEnd(phase, e) {
  const reasons = e && Array.isArray(e.reasons) && e.reasons.length ? e.reasons.join(', ') : 'no reason given';
  if (sessionEnding && sessionEnding.phase === 'end') return;
  if (phase === 'query') {
    if (sessionEnding && Date.now() - sessionEnding.at < 5000) return;   // every window is asked: one line
    sessionEnding = { phase, reasons, at: Date.now() };
    process.stdout.write(`mantle: Windows asked whether the session may end (${reasons}): yes; dead pages are not reloaded for the next 60 s\n`);
    return;
  }
  sessionEnding = { phase: 'end', reasons, at: Date.now() };
  shutdown(`Windows is ending the session (${reasons})`);
}
// </mainrel:session>

function watchPage(win, label) {
  const wc = win.webContents;
  const pageKey = PAGE_KEYS[label] || `page.${label}`;
  win.on('query-session-end', (e) => onSessionEnd('query', e));
  win.on('session-end', (e) => onSessionEnd('end', e));
  let hangTimer = null;        // a hung page's last chance to answer (the 'unresponsive' handler below)
  let stoppedShown = false;    // past the reload cap: the window shows ui/shared/page-stopped.html
  // The "stopped" page (pageStopped, below) is not the page coming back: it must not clear the death record.
  wc.on('did-finish-load', () => { if (!stoppedShown) pageReviver.loaded(pageKey, label); });
  // A page that will not load must say so on screen, not leave a blank window. A failed load is tried
  // again at 1, 5 and 30 s first (mn-recover, audit #12): one failure used to swap in the error page
  // for good, so a load that lost a race (a file being replaced, a busy disk at logon) killed the bar.
  let swapped = false;
  let loadFails = 0, loadFailAt = 0;
  wc.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
    if (!isMainFrame || swapped) return;
    if (code === -3) return;   // ERR_ABORTED: a load we replaced ourselves
    if (Date.now() - loadFailAt > PAGE_LOAD_RETRY_SPAN_MS) loadFails = 0;   // at most 3 retries in 10 min
    loadFailAt = Date.now();
    if (loadFails < PAGE_LOAD_RETRY_MS.length && !shuttingDown && !stoppedShown) {
      const delay = PAGE_LOAD_RETRY_MS[loadFails++];
      process.stderr.write(`mantle: ${label} did not load its page (${description}, ${code}); loading it again in ${delay / 1000} s (try ${loadFails} of ${PAGE_LOAD_RETRY_MS.length})\n`);
      const t = setTimeout(() => { if (!win.isDestroyed() && !wc.isDestroyed() && !shuttingDown && !swapped) win.loadURL(url); }, delay);
      if (t.unref) t.unref();
      return;
    }
    swapped = true;
    process.stderr.write(`mantle: ${label} failed to load ${url}: ${description} (${code})\n`);
    win.loadURL(placeholderUrl({
      title: label,
      file: `${url} — ${description}`,
      owner: `Electron refused to load it (error ${code})`,
      compact: label === 'The bar',
    }));
  });
  wc.on('render-process-gone', (_e, details) => {
    const reason = (details && details.reason) || 'no reason given';
    process.stderr.write(`mantle: ${label}'s renderer died: ${reason}\n`);
    // The flyout that asked for the previews is gone, and nothing will ever ask to remove them.
    if (win === barWin) clearThumbs(`the bar page died (${reason})`);
    if (hangTimer) { clearTimeout(hangTimer); hangTimer = null; }
    if (stoppedShown) return;   // the stopped page itself died: nothing more to try until a restart
    // Reload the PAGE, never the window: the bar stays parked where it is (no hide/show).
    const verdict = pageReviver.died(pageKey, label, reason, () => {
      if (win.isDestroyed() || wc.isDestroyed()) return false;   // closed since (an idle unload): nothing left to reload
      wc.reload();
      return null;
    });
    // Past the reload cap the window is never left dead and blank: a plain page says what stopped and why.
    if (verdict === 'gave-up') pageStopped(win, label, `its page crashed again and again (the last: ${reason})`);
  });
  // A HUNG page (mn-recover, audit #12): Electron says 'unresponsive' when the page has not answered
  // input for a while, and nothing listened, so a frozen bar stayed frozen until a restart. Still hung
  // PAGE_HANG_MS later, its renderer is ended on purpose and the death above reloads it (and counts
  // it, so a page that hangs every time it loads stops at the same cap).
  wc.on('unresponsive', () => {
    if (hangTimer || shuttingDown || stoppedShown) return;
    process.stdout.write(`mantle: ${label} stopped responding; its page is restarted if it is still stuck in ${PAGE_HANG_MS / 1000} s\n`);
    hangTimer = setTimeout(() => {
      hangTimer = null;
      if (win.isDestroyed() || wc.isDestroyed() || shuttingDown) return;
      process.stdout.write(`mantle: ${label} did not respond for ${PAGE_HANG_MS / 1000} s, so its page is restarted\n`);
      try { wc.forcefullyCrashRenderer(); } catch (err) {
        process.stderr.write(`mantle: ${label}'s stuck page could not be ended (${err && err.message}); reloading it instead\n`);
        try { wc.reload(); } catch (_) { /* the death handler or a restart is all that is left */ }
      }
    }, PAGE_HANG_MS);
    if (hangTimer.unref) hangTimer.unref();
  });
  wc.on('responsive', () => {
    if (!hangTimer) return;
    clearTimeout(hangTimer);
    hangTimer = null;
    process.stdout.write(`mantle: ${label} is responding again\n`);
  });
  function pageStopped(w, what, why) {
    if (stoppedShown || w.isDestroyed()) return;
    stoppedShown = true;
    process.stdout.write(`mantle: ${what} shows a "stopped" page instead of a blank window: ${why}\n`);
    try {
      w.loadFile(path.join(ROOT, 'ui', 'shared', 'page-stopped.html'), { query: { what, why, compact: w === barWin ? '1' : '' } });
    } catch (err) { process.stderr.write(`mantle: ${what}'s "stopped" page could not load (${err && err.message})\n`); }
  }
  if (win === barWin) {
    // Same for a reload: the new page starts with no flyout open, over whatever the old one drew.
    wc.on('did-start-navigation', (e, ...legacy) => {
      const main = e && typeof e.isMainFrame === 'boolean' ? e.isMainFrame : legacy[2];
      const same = e && typeof e.isSameDocument === 'boolean' ? e.isSameDocument : legacy[1];
      if (main && !same) clearThumbs('the bar page is loading again');
    });
    win.on('closed', () => clearThumbs('the bar window closed'));
  }
  // Electron moved console-message from (event, level, message, line, source) to
  // (event, details) partway through v3x, and the level went from a number to a
  // string. Accept both rather than silently logging nothing on one of them.
  wc.on('console-message', (...a) => {
    const d = a[1] && typeof a[1] === 'object' && 'message' in a[1] ? a[1] : null;
    const level = d ? d.level : a[1];
    const message = d ? d.message : a[2];
    const line = d ? d.lineNumber : a[3];
    const source = d ? d.sourceId : a[4];
    const bad = typeof level === 'string' ? (level === 'error' || level === 'warning') : level >= 2;
    // Renderer errors belong where a human running Mantle from a terminal sees
    // them; the pages show their own state, this is the developer's copy.
    // The source as Mantle's own relative path (ui/bar/bar.js), not a file:// address with the
    // home folder in it; and one screenful at most, so a page dumping an object cannot flood the file.
    if (!bad) return;
    const src = String(source || '').replace(/\\/g, '/');
    const at = src.lastIndexOf('/ui/');
    const where = at >= 0 ? src.slice(at + 1) : (src.split('/').pop() || 'the page');
    const text = String(message);
    process.stderr.write(`mantle: [${label}] ${text.length > 600 ? `${text.slice(0, 597)}...` : text} (${where}:${line})\n`);
  });
}

/*
 * One line of memory numbers per process, 30 s after start and then every 30
 * minutes: private bytes per page (what each renderer alone holds), main's
 * heap, and the GPU/utility working sets. Owen asked for the footprint to come
 * down "as much as possible without making it worse", and the only way to
 * know either is to have the numbers in the log where the pages are named.
 */
async function logMemory(tag) {
  const parts = [];
  try {
    // app.getAppMetrics() is the one source that covers every process, and on
    // Windows it carries privateBytes (KB). Renderers are matched to their
    // window through the OS pid, so the log names the page, not "renderer".
    const byPid = new Map(app.getAppMetrics().map((p) => [p.pid, p]));
    const fmt = (p, w) => `private ${Math.round((p.memory.privateBytes || 0) / 1024)} MB, ws ${Math.round(p.memory.workingSetSize / 1024)} MB${w ? (w.isVisible() ? ', visible' : ', hidden') : ''}`;
    let privateTotal = 0;
    for (const p of byPid.values()) privateTotal += (p.memory.privateBytes || 0);
    for (const [name, w] of [['bar', barWin], ['launcher', launcherWin], ['desktop', desktopWin], ['switcher', switcher.overlayWindow()]]) {
      if (!w || w.isDestroyed()) { parts.push(`${name}: no window`); continue; }
      const pid = w.webContents.getOSProcessId();
      const p = byPid.get(pid);
      parts.push(`${name} pid ${pid}: ${p ? fmt(p, w) : 'not in the app metrics'}`);
      byPid.delete(pid);
    }
    // Every other window (the features' own, the wallpaper's), named by its page: ui/<dir>/<file>.
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.isDestroyed()) continue;
      const pid = w.webContents.getOSProcessId();
      const p = byPid.get(pid);
      if (!p) continue;
      const m = /\/ui\/(.+?)(?:[?#]|$)/.exec(String(w.webContents.getURL() || '').replace(/\\/g, '/'));
      parts.push(`${m ? m[1] : (w.getTitle() || 'a window')} pid ${pid}: ${fmt(p, w)}`);
      byPid.delete(pid);
    }
    const mu = process.memoryUsage();
    for (const p of byPid.values()) {
      const who = p.type === 'Browser' ? 'main' : `${p.type}${p.name ? ` ${p.name}` : ''}`;
      parts.push(`${who} pid ${p.pid}: ${fmt(p)}${p.type === 'Browser' ? `, js heap ${Math.round(mu.heapUsed / 1048576)} MB, external ${Math.round(mu.external / 1048576)} MB` : ''}`);
    }
    parts.unshift(`electron private total ${Math.round(privateTotal / 1024)} MB (the sidecar is not counted)`);
  } catch (err) {
    parts.push(`could not read the rest: ${err && err.message ? err.message : err}`);
  }
  process.stdout.write(`mantle: memory (${tag}): ${parts.join(' | ')}\n`);
}

app.whenReady().then(() => {
  // THE SIDECAR STARTS FIRST (lane mn-wake, 2026-10-12; audit #4). It used to be the last line here,
  // after every window and feature was made, so its own start-up (~1 s here, longer at a loaded
  // logon) was added to that time instead of running beside it. Safe this early: everything below
  // runs in this same tick, so every 'ready' listener is in place long before its ready line can be
  // read, and calls made meanwhile wait for that line (lib/sidecar.js _callWhenReady). The
  // shell-state.json baseline is the sidecar's own first act (Program.cs), before any request.
  sidecar.start();
  // Mantle's appearance first: every window below asks for it before its first paint. Match Windows
  // follows Windows live: nativeTheme 'updated' fires when AppsUseLightTheme changes (and on other
  // theme news, which windowsChanged() ignores unless the mode actually moved).
  getTheme();
  // look sync next (lib/look-host.js): it reads the shared look.json and may set the theme (fromSync)
  try { getLook().start(); } catch (err) { process.stderr.write(`mantle: look sync could not start: ${err && err.stack ? err.stack : err}\n`); }
  nativeTheme.on('updated', () => {
    try { getTheme().windowsChanged(); } catch (err) { process.stderr.write(`mantle: Windows' light/dark change could not be followed: ${err && err.message ? err.message : err}\n`); }
  });
  if (flags.test) {
    // TEST ONLY (lib/theme.e2e.test.js): "Windows changed to <mode>" without touching Owen's Windows.
    // It sets a made-up app mode and fires nativeTheme's own 'updated', so the path a real change
    // takes (listener -> windowsChanged -> broadcast -> preload) is the one exercised. null = real again.
    COMMANDS['theme.testWindows'] = async (a) => {
      const m = a && (a.mode === 'dark' || a.mode === 'light') ? a.mode : a && a.mode === null ? null : undefined;
      if (m === undefined) return { ok: false, reason: 'theme.testWindows takes {mode: "dark" | "light" | null}' };
      themeFakeWindows = m;
      nativeTheme.emit('updated');
      return getTheme().get();
    };
  }
  const bar = createBar({ root: ROOT, test: flags.test, barEdge: flags.barEdge, liveShape: flags.testLiveBar });
  barWin = bar.win;
  armBarShape();   // hover mode: the always-tall window's shape, proved before it is ever shown
  watchPage(barWin, 'The bar');
  // NO show here any more. The bar is a hover bar: it is created hidden and the
  // cursor poll is the only thing that puts it on screen (plus --dock, which
  // shows it once and leaves it). Showing it at ready-to-show would flash a bar
  // on Owen's screen at every start and then take it away again.
  barWin.webContents.on('did-finish-load', () => {
    // A reloaded bar has no popover open, so any room it borrowed is now room
    // nothing is using. Give it back rather than leaving a 300px-tall "bar".
    if (barPopover) COMMANDS['bar.popover']({ open: false }).catch(() => {});
    reapplyGlass('the bar', barWin, 'off');
  });
  if (!bar.load.loaded) process.stderr.write(`mantle: ${bar.load.reason}\n`);

  // First start (lib/welcome.js): the flag judged at the top is written now (the lock is ours), and
  // the welcome comes in once the bar's page is up. Settings > About "Show again" uses welcome.show.
  const welcome = require('./lib/welcome').host({
    verdict: welcomeVerdict, dir: app.getPath('userData'), test: flags.test,
    preload: path.join(ROOT, 'preload.js'), page: path.join(ROOT, 'ui', 'welcome', 'index.html'), BrowserWindow, screen,
    log: (l) => process.stdout.write(`mantle: welcome: ${l}\n`), quitting: () => shuttingDown,
    focusHelp: (w) => sidecar.call('focus', { hwnd: hwndOf(w) }, 2000),
  });
  Object.assign(COMMANDS, welcome.commands);
  welcome.record();
  barWin.webContents.once('did-finish-load', () => welcome.start());

  if (flags.test) {
    // TEST ONLY (lane ramdiet): how long each window takes from new BrowserWindow to its page loaded,
    // the cost an idle-unloaded window pays again on its next use.
    app.on('browser-window-created', (_e, w) => {
      const t0 = Date.now();
      w.webContents.once('did-finish-load', () => {
        if (w.isDestroyed()) return;
        const m = /\/ui\/(.+?)(?:[?#]|$)/.exec(String(w.webContents.getURL() || '').replace(/\\/g, '/'));
        process.stdout.write(`mantle: window loaded: ${m ? m[1] : (w.getTitle() || 'a window')} in ${Date.now() - t0} ms\n`);
      });
    });
  }
  trimOwnSoon(`${Math.round(TRIM_AFTER_MS / 1000)} s after start`);
  const memFirst = setTimeout(() => logMemory('30 s after start'), 30000);
  if (memFirst.unref) memFirst.unref();
  const memEvery = setInterval(() => logMemory('every 30 min'), 30 * 60 * 1000);
  if (memEvery.unref) memEvery.unref();

  if (process.env.MANTLE_NO_LAUNCHER === '1') {
    // Measurement switch only: how much of the footprint is the launcher window.
    process.stdout.write('mantle: MANTLE_NO_LAUNCHER=1: the launcher window was not created (measurement run; the Win key does nothing)\n');
  } else {
    makeLauncher(false);
  }

  if (flags.desktop) {
    // HELD HIDDEN until it is under the icons (audit #3), as a layer made after an Explorer restart
    // always was: shown before that it is a full-screen window over every open app. A test run
    // never attaches it, so it shows as before (and stays invisible: lib/test-quiet.js).
    // TEST ONLY: --test-desktop-hold holds it in a test run too, and says 3 s after its page is ready
    // whether anything showed it (nothing attaches it in a test run, so it must still be hidden).
    const holdTest = flags.test && ARGV.includes('--test-desktop-hold');
    const deskWin = makeDesktopWindow('the desktop layer is starting', !flags.test || holdTest);
    if (holdTest) {
      deskWin.once('ready-to-show', () => setTimeout(() => process.stdout.write(`mantle: --test-desktop-hold: 3 s after its page was ready the held layer is ${deskWin.isDestroyed() ? 'gone' : deskWin.isVisible() ? 'VISIBLE, which it must not be before it is under the icons' : 'still hidden, waiting to go under the icons'}\n`), 3000));
    }
    if (!flags.test) {
      state.set('desktop', { attached: false, mode: null, reason: 'the desktop layer is waiting, hidden, to go under the icons; Windows\' own wallpaper shows until it is there' });
    }
    armDesktopGoneTest();
  } else {
    state.set('desktop', { attached: false, mode: null, reason: '--no-desktop: the desktop layer was not created' });
  }
  // The wallpaper library, its pause rules and the Wallpapers window: all in lib/wallpaper.js.
  wallpaper.start({ root: ROOT, test: flags.test, state, sidecar, commands: COMMANDS, desktopWin, theme: themeHost });
  startLookDesktop();
  // The notification centre's list, watch and commands (notifs.*): all in lib/notifications.js.
  notifications.start({ test: flags.test, state, sidecar, commands: COMMANDS, broadcast });
  // Alt+Tab's overlay window (parked off screen, never shown in a test run) and switcher.*.
  // Win+N / Win+A arrive through it too, and the bar opens its own panel for them.
  switcher.start({
    root: ROOT,
    test: flags.test,
    state,
    sidecar,
    commands: COMMANDS,
    pinned: () => lastPinned,
    windows: () => lastWindows,
    iconFor: (candidates) => iconFor(candidates),
    onWinKey: (key) => broadcast('bar.winkey', { key }),
    // lane helm-wall: in dark the overlay's picture is the wallpaper under it, not a screen capture
    wall: wallHost,
    dark: () => getTheme().get().theme === 'dark',
  });
  startFeatures();

  // Order matters: the shortcuts write their own state before the tray reads the
  // state to build its menu, and test mode's four "deliberately not done" reasons
  // are true from the first frame, not from whenever the sidecar answers.
  if (flags.test) testShellBaseline();
  recoveryNote = loadRecoveryNote();
  if (recoveryNote) process.stdout.write(`mantle: ${recoveryNote} (the tray menu says so for the next hour)\n`);
  // The supervisor brought this process back after a crash (or had given up on a crash loop): say it ONCE,
  // in words: the log gets the codes, the tray menu a line for the next hour, Owen a pop-up once the
  // desktop is up (start/wake holds the layer ~3 s). A --test run draws the pop-up but never shows it.
  const crashNotice = supervisor.takeNotice();
  if (crashNotice) {
    process.stdout.write(`mantle: ${crashNotice.log}\n`);
    process.stdout.write(`mantle: tells Owen once: ${crashNotice.title}: ${crashNotice.words}\n`);
    recoveryNote = crashNotice.tray;
    setTimeout(() => {
      if (shuttingDown) return;
      lookToastShow({ text: crashNotice.title, reason: crashNotice.words, tone: 'warn', did: 'failed' }, 'crash recovery');
    }, 4000);
  }
  registerShortcuts();
  createTray();
  apps.startRefresh();
  armAppsIconsTest();

  // ONE display listener for the whole process, calling whatever "put the bar
  // back" means right now. applyLive re-runs on every sidecar restart and used to
  // add another listener each time it did.
  // A monitor plugged in or out, and waking from sleep (monitors re-enumerate, the main one may be
  // another one now), are the same "put the bar back" as a scale change -- and none of them was
  // listened for (lane core-main, 2026-09-29). One 125% -> 150% change fires metrics-changed 3-6
  // times: the first runs at once, the rest become one run when the burst is over (makeBurst).
  const displayBurst = makeBurst((why) => {
    if (rePlaceBar) rePlaceBar(why);
    // The desktop layer is sized to the main display first (lane mn-display), THEN its picture --
    // the wallpaper, which a resolution change reflows -- is retaken at the new size. The picture
    // is a still, so this is the only thing that redates it.
    desktopFit.run(why).catch(() => {}).then(() => reshootDesktopBackdrop(why)).catch(() => {});
    // a launcher that is up while the display changes is centred on it again (a hidden one is on its next open)
    if (launcherAlive() && launcherWin.isVisible()) launcherRecentre(why);
    // the shared top-band darkening is worked out for the primary monitor's size (lib/look-desktop.js)
    if (lookDesktop) lookDesktop.check(why);
  }, { quietMs: 400, setTimeout, clearTimeout });
  screen.on('display-metrics-changed', () => displayBurst('display metrics changed'));
  screen.on('display-added', () => displayBurst('a display was connected'));
  screen.on('display-removed', () => displayBurst('a display was disconnected'));
  let sleptAt = 0;
  powerMonitor.on('suspend', () => { sleptAt = Date.now(); process.stdout.write('mantle: the PC is going to sleep\n'); });
  powerMonitor.on('resume', () => {
    // On this PC Windows often sends its sleep notice only AT wake (43 of 88 wakes logged "0 min
    // asleep", audit 2026-10-12), so a notice seconds old says nothing about how long it slept.
    const slept = sleptAt ? Date.now() - sleptAt : 0;
    const asleep = !sleptAt ? '' : slept < 15000 ? ' (Windows sent its sleep notice only now, so how long it slept is not known)'
      : ` after ${Math.round(slept / 60000)} min asleep`;
    process.stdout.write(`mantle: the PC woke up${asleep}; the bar is put back in 1.5 s, and the desktop picture is kept unless the display changed\n`);
    sleptAt = 0;
    const t = setTimeout(() => displayBurst('the PC woke from sleep'), 1500);
    if (t.unref) t.unref();
    // fs.watch can miss events across sleep (CONTRACT section 2): read the shared look once
    if (lookHost) lookHost.refresh('the PC woke from sleep');
  });
  powerMonitor.on('unlock-screen', () => { if (lookHost) lookHost.refresh('the screen was unlocked'); });

  if (flags.dock) {
    // --dock: the old permanent bar. Shown once, and it stays.
    barWin.once('ready-to-show', () => {
      barWin.showInactive();
      barRevealed = true;
      setBar({ ok: true, revealed: true, reason: '--dock: the bar is permanently on screen and reserves its strip' });
    });
  } else if (flags.test) {
    startHoverWatch();
  } else {
    armHoverWatchStart();   // live: once the bar has its first place (applyLive), so a reveal never lands off
  }
  startPinWatch();
  schedulePinnedPush('Mantle started');

  // (the sidecar was started first thing above, so its start-up runs beside all of this)

  // --flyout owns --screenshot when both are given: it photographs the flyout, not the three windows
  if (flags.flyout !== null) runFlyoutTest(flags.flyout, flags.screenshot ? path.resolve(flags.screenshot) : null);
  else if (flags.trace) runTrace(flags.trace);
  else if (flags.screenshot) runScreenshots(path.resolve(flags.screenshot));
});
