'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const { app, BrowserWindow, ipcMain, globalShortcut, Tray, Menu, screen, shell } = require('electron');

const { parseArgs, ArgError } = require('./lib/args');
const { ShellState } = require('./lib/state');
const { Sidecar } = require('./lib/sidecar');
const { Apps, modulePathFor } = require('./lib/apps');
const { stats } = require('./lib/sys-stats');
const { trayImage } = require('./lib/tray-icon');
const { openTarget } = require('./lib/open-target');
const { probe } = require('./lib/net-probe');
const { placeholderUrl } = require('./lib/placeholder');
const { createBar, createLauncher, createDesktop, hwndOf, BAR_H } = require('./lib/windows');

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
 */
(function teeLogToFile() {
  const arg = process.argv.slice(1).find((a) => typeof a === 'string' && a.startsWith('--log='));
  const file = arg ? arg.slice('--log='.length).replace(/^"|"$/g, '') : '';
  if (!file) return;
  const fs = require('fs');
  let fd = null;
  try {
    fs.mkdirSync(require('path').dirname(file), { recursive: true });
    fd = fs.openSync(file, 'a');
    fs.writeSync(fd, `\n===== mantle start ${new Date().toISOString()} pid ${process.pid}: ${process.argv.slice(1).join(' ')}\n`);
  } catch (err) {
    process.stderr.write(`mantle: --log=${file} cannot be written (${err && err.message ? err.message : err}); logging to the terminal only\n`);
    return;
  }
  for (const stream of [process.stdout, process.stderr]) {
    const orig = stream.write.bind(stream);
    stream.write = (chunk, ...rest) => {
      try { fs.writeSync(fd, typeof chunk === 'string' ? chunk : Buffer.from(chunk)); } catch (_) { /* never fatal */ }
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
 * --os-morph: animate the WINDOW with the sidecar's per-frame SetWindowPos, the
 * way this did until Owen said "when the taskbar expands out it isn't that
 * smooth". Kept so the two can be compared side by side rather than argued about.
 * The default now: the window is placed once and the PAGE animates the pill.
 */
flags.osMorph = ARGV.some((a) => a === '--os-morph');
const REVEAL_BY = flags.osMorph ? 'morph' : 'page';

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
  process.stdout.write('mantle: starting in 3 seconds. Ctrl+C now if that was not what you meant.\n');
  sleepSync(3000);
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

const sidecar = new Sidecar({
  exePath: path.join(ROOT, 'sidecar', 'bin', 'Mantle.Sidecar.exe'),
  buildScript: path.join(ROOT, 'sidecar', 'build.ps1'),
  passive: flags.test,
  cwd: ROOT,
  stateFile: STATE_FILE,
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
const apps = new Apps({
  modulePath: modulePathFor(ROOT),
  // The index module asks us for icons; we ask the sidecar. A sidecar that is
  // down means "no icon", not "no index" -- a launcher list without pictures is
  // still a launcher list.
  icon: async (p) => {
    try {
      const r = await sidecar.call('icon', { path: p });
      return r && r.icon ? r.icon : null;
    } catch (_) {
      return null;
    }
  },
});

let barWin = null;
let launcherWin = null;
let desktopWin = null;
let tray = null;
let lastWindows = [];      // last window list the sidecar sent, for replay on subscribe
let lastTray = null;       // last notification-area list, or null if never read
let trayTimer = null;
let barPopover = null;     // {key, height} while the bar has borrowed extra room
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
const POPOVER_MAX = 480;   // was 320: the Quick Settings panel asked for 429 live (2026-09-21) and had its top cut off
let restoreChain = Promise.resolve();

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
const PILL_START_W = 0.62;      // it grows out from 62 % of its width as it rises
let hoverTimer = null;
let barRevealed = false;
let barLeftAt = null;          // when the cursor last left the bar, or null while it is in
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
const iconCache = new Map();   // path (lowercased) -> {icon, reason}
const pinById = new Map();     // Item id -> the pin record, for bar.open's lnkPath
// The key sequences the bar's system buttons are allowed to press. A whitelist,
// not a filter: 'keys' can type ANYTHING into the foreground window, and a bar
// button is not a reason to hand a renderer a keyboard.
const KEYS_ALLOWED = new Set(['win+a', 'win+n', 'win+d']);

// ---------------------------------------------------------------------------
// Talking to the pages.
// ---------------------------------------------------------------------------
function broadcast(name, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    const wc = win.webContents;
    if (!wc || wc.isDestroyed()) continue;
    try { wc.send('mantle:event', { name, payload }); } catch (_) { /* window went away mid-send */ }
  }
}

let lastProblemLine = null;

state.on('change', (snapshot) => {
  broadcast('state', snapshot);
  updateTray();
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

  return {
    shape: BAR_SHAPE,
    edge: atTop ? 'top' : 'bottom',
    scale: sf,
    radius: r,
    bottomPhys,
    rest: { dip: Object.assign({ r: rDip }, restDip), phys: Object.assign({ r }, restPhys) },
    start: { dip: Object.assign({ r: rDip }, startDip), phys: Object.assign({ r }, toPhys(startDip)) },
    pill: { dip: pillDip, phys: toPhys(pillDip) },
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

/** The bar window's rectangle in DIP, or null if there is no bar. */
function barRect() {
  if (!barWin || barWin.isDestroyed()) return null;
  try {
    return barWin.getBounds();
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
 */
function inHotZone(pt, rect, inBand) {
  if (inBand) return true;
  if (pointIn(rect, pt)) return true;
  if (BAR_SHAPE !== 'pill') return false;
  const b = screen.getPrimaryDisplay().bounds;
  const rest = barGeometry().rest.dip;
  const column = flags.barEdge === 'top'
    ? { x: rest.x, y: b.y, width: rest.width, height: rest.y - b.y }
    : { x: rest.x, y: rest.y + rest.height, width: rest.width, height: (b.y + b.height) - (rest.y + rest.height) };
  return column.height > 0 && pointIn(column, pt);
}

/*
 * Is something fullscreen in front of us? Asked of the sidecar, because Electron
 * cannot see another process's window state.
 *
 * DEGRADES TOWARDS REVEALING, with the reason recorded: a sidecar that is down or
 * too old must not mean "Owen's taskbar never appears again". The verdict is
 * cached for 600 ms so that a cursor parked on the edge asks a few times a
 * second, not twelve.
 */
let fgVerdict = { blocked: false, reason: null, at: 0 };
async function foregroundBlocksReveal() {
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
    } else {
      fgVerdict = { blocked: false, reason: null, at: now };
    }
  } catch (err) {
    const why = Sidecar.isOldExeError(err)
      ? `the sidecar exe has no "foreground" command (run npm run build:sidecar), so the bar reveals anyway and may cover a fullscreen window`
      : `Mantle could not check for a fullscreen window (${err.message}), so the bar reveals anyway`;
    fgVerdict = { blocked: false, reason: why, at: now };
  }
  if (fgVerdict.reason !== foregroundReason) {
    foregroundReason = fgVerdict.reason;
    if (fgVerdict.reason) process.stdout.write(`mantle: bar reveal check: ${fgVerdict.reason}\n`);
  }
  return fgVerdict;
}

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
async function revealByPage(geo, why, visible) {
  const rect = sideRect(geo.rest);
  // Capture the PILL, place the WINDOW: the page hangs this image on the pill, and
  // the window also covers the transparent strip under it -- 17 px of scenery that
  // does not belong in the pill's blur.
  const shotRect = clampToDisplay(geo.pill ? geo.pill.phys : rect).rect;
  if (!visible || barParked) {
    try {
      const shot = await sidecar.call('backdrop', { x: shotRect.x, y: shotRect.y, w: shotRect.w, h: shotRect.h, scale: BACKDROP_SCALE }, 2000);
      if (shot && shot.png) {
        broadcast('bar.backdrop', { png: shot.png, w: shot.w, h: shot.h, rect: { x: shotRect.x, y: shotRect.y, w: shotRect.w, h: shotRect.h }, ms: Number(shot.ms) || 0 });
      }
    } catch (_) { /* the loop retries after landing; a reveal never waits on this */ }
    if (!barRevealed || !barWin || barWin.isDestroyed()) return;   // hidden again while we waited
    await placeBar([rect.x, rect.y, rect.x + rect.w, rect.y + rect.h], sidecarDpiAware, { quiet: true });
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
  broadcast('bar.reveal', { why, mode: geo.shape, ms: REVEAL_MS });
  setBar({ ok: true, revealed: true, reason: barReason(`the bar is up: ${why}`) });
  process.stdout.write(`mantle: bar revealed (${why}) -- ${geo.shape} ${JSON.stringify(rect)}, the page animates it over ${REVEAL_MS} ms\n`);

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
        process.stdout.write(`mantle: the bar is covered by ${what}, so its buttons will not respond (${why})\n`);
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
 * Take the bar off the screen WITHOUT hiding the window: see barParked. The page
 * has already run its exit, so the window holds nothing but a transparent strip
 * when it goes below the edge. Only if the sidecar cannot place it does this fall
 * back to barWin.hide(), and it says so, because the next reveal then goes
 * through the hide()/showInactive() cycle that costs the page its clicks.
 */
function parkBar(geo, why) {
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
  stopBackdrop(`the bar is leaving: ${why}`);
  // The panel goes with the bar: a 2 s poll for a panel nobody can see is pure cost.
  qsWatchStop(`the bar is hiding: ${why}`);
  broadcast('bar.hide', { why, ms: HIDE_MS });
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
    if (barWin && !barWin.isDestroyed()) parkBar(geo, why);
    setBar({ ok: true, revealed: false, reason: barReason(`hidden: ${why}`) });
    process.stdout.write(`mantle: bar hidden (${why})\n`);
  }, HIDE_SLIDE_MS);
  if (hideTimer.unref) hideTimer.unref();
}

/**
 * One tick. Sequential by construction -- the next tick is scheduled only once
 * this one (including its await) has finished -- so the sidecar can never be
 * handed a queue of 'foreground' calls by a cursor sitting on the edge.
 */
async function hoverTick() {
  hoverTimer = null;
  if (shuttingDown || flags.dock) return;
  if (!barWin || barWin.isDestroyed()) return;   // nothing left to reveal; stop polling

  let pt = null;
  try {
    pt = screen.getCursorScreenPoint();
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
  const inBand = pt.x >= b.x && pt.x < b.x + b.width && pt.y >= bandTop && pt.y < bandBottom;

  if (hoverFirstTick) {
    hoverFirstTick = false;
    const geo = barGeometry();
    process.stdout.write(`mantle: hover poll armed: cursor at ${pt.x},${pt.y}; the reveal band is y ${bandTop}..${bandBottom - 1} across x ${b.x}..${b.x + b.width - 1} (DIP), polled every ${POLL_HIDDEN_MS} ms while hidden\n`);
    process.stdout.write(`mantle: bar geometry: ${geo.shape} at ${geo.scale}x -- rests at physical ${JSON.stringify(sideRect(geo.rest))}, comes in from ${JSON.stringify(sideRect(geo.start))} over ${REVEAL_MS} ms\n`);
  } else if (HOVER_DEBUG && Date.now() - hoverDebugAt > 1000) {
    hoverDebugAt = Date.now();
    process.stdout.write(`mantle: [hover] cursor ${pt.x},${pt.y} inBand=${inBand} revealed=${barRevealed} popover=${barPopover ? barPopover.key : 'none'}\n`);
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

  // Shown. Anything that counts as "Owen is still using it" resets the clock.
  const inside = inHotZone(pt, barRect(), inBand);
  const rendererSaysInside = Date.now() - rendererHoverAt < HIDE_GRACE_MS;
  if (inside || barPopover || rendererSaysInside) {
    barLeftAt = null;
    // If the bar was already sliding away, the page has to be told to come back
    // -- cancelling the hide timer alone would leave the window up with a page
    // that has animated itself off the bottom of it.
    if (hideTimer) revealBar('the cursor came back before the bar finished sliding away');
    scheduleHoverTick();
    return;
  }
  if (barLeftAt === null) barLeftAt = Date.now();
  else if (Date.now() - barLeftAt >= HIDE_GRACE_MS) {
    beginHide(`the cursor has been away from the bar for ${HIDE_GRACE_MS} ms`);
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
const BACKDROP_SETTLE_MS = 25;        // for the exclusion to take effect before the shot
const BACKDROP_MAX_FAILS = 3;
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
  let protectedOn = false;
  const t0 = Date.now();
  try {
    if (protect && win && !win.isDestroyed()) {
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
    if (protectedOn && win && !win.isDestroyed()) {
      try { win.setContentProtection(false); } catch (e2) { onProtectError(e2); }
    }
  }
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
 */
function makeBackdrop(opts) {
  let timer = null;
  let fails = 0;
  let frames = 0;
  let off = null;                     // set once when the sidecar cannot do it at all
  const fps = opts.ms ? Math.round(1000 / opts.ms) : 0;
  const set = (patch) => setBackdropPiece(opts.key, Object.assign({ fps }, patch));
  const onProtectError = (e) => set({ ok: false, reason: `${opts.label} could not be put back into screen captures, so it will be missing from screenshots: ${e.message}` });

  /** One frame. Returns true if it worked. Never throws. */
  async function frame(protect) {
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
    const r = await captureBackdrop(win, rect, opts.scale, protect, onProtectError);
    if (r.ok) {
      fails = 0;
      frames++;
      broadcast(opts.event, { png: r.png, w: r.w, h: r.h, rect: { x: rect.x, y: rect.y, w: rect.w, h: rect.h }, ms: r.ms });
      set(trimmed
        ? { ok: true, ms: r.ms, reason: `${opts.label} is blurring a live picture of what is behind it${trimmed}` }
        : { ok: true, ms: r.ms });
      return true;
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
      if (off) { stop(off); return; }
      if (fails >= BACKDROP_MAX_FAILS) {
        stop(`${BACKDROP_MAX_FAILS} captures in a row failed, so ${opts.label} falls back to its flat tint`);
        return;
      }
    } else if (frames === 1) {
      process.stdout.write(`mantle: ${opts.key} backdrop capture on: ${fps} fps, first frame ${state.get().backdrop[opts.key].ms} ms\n`);
    }
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
      if (ok) set({ on: !!timer, ok: true, reason: `${opts.label} has a fresh picture of what is behind it (${why})` });
      return ok;
    },
    start(why) {
      if (timer || shuttingDown || !opts.ms) return;
      if (off) { set({ on: false, ok: false, reason: off }); return; }
      fails = 0;
      frames = 0;
      set({ on: true, ok: true, reason: `starting: ${why}` });
      tick().catch(() => {});
    },
    stop(why) { stop(why); },
    peek: () => ({ timer: !!timer, fails, frames, off }),
  };

  function stop(why) {
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
});

// The launcher: same loop, same 4 fps, its own window rectangle.
const launcherBackdrop = makeBackdrop({
  key: 'launcher',
  label: 'the launcher',
  event: 'launcher.backdrop',
  ms: BACKDROP_MS,
  scale: BACKDROP_SCALE,
  win: () => launcherWin,
  rect: () => windowPhysRect(launcherWin),
});

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
 */
async function reshootDesktopBackdrop(why) {
  if (!desktopWin || desktopWin.isDestroyed()) return;
  const wasVisible = desktopWin.isVisible();
  try { if (wasVisible) desktopWin.hide(); } catch (_) { /* carry on: the shot is worth more than the hide */ }
  await wait(60);
  await desktopBackdrop.once(why);
  if (wasVisible) {
    try { desktopWin.showInactive(); } catch (err) {
      process.stderr.write(`mantle: the desktop layer was hidden for a backdrop capture and would not come back: ${err.message}\n`);
    }
  }
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
function showLauncher() {
  if (!launcherWin || launcherWin.isDestroyed()) return;
  // The FIRST frame is captured while the window is still hidden -- no content
  // protection needed, and nothing to photograph itself -- so the launcher's
  // frost is real on the frame it appears in rather than a flat tint that pops a
  // quarter of a second later. Then the same 4 fps loop the bar runs.
  const show = () => {
    if (!launcherWin || launcherWin.isDestroyed()) return;
    if (flags.test) {
      // A test run must never take focus from whoever is at the machine.
      launcherWin.showInactive();
    } else {
      launcherWin.show();
      launcherWin.focus();
    }
    broadcast('launcher:visible', true);
    launcherBackdrop.start('the launcher is open');
  };
  if (launcherWin.isVisible()) { show(); return; }
  launcherBackdrop.once('the launcher is opening').then(show, show);
}

function hideLauncher() {
  if (!launcherWin || launcherWin.isDestroyed()) return;
  if (!launcherWin.isVisible()) return;
  launcherBackdrop.stop('the launcher closed');
  launcherWin.hide();
  broadcast('launcher:visible', false);
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
 * Ask the sidecar for one icon, once per path, and remember what happened.
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
    if (iconCache.has(key)) {
      const hit = iconCache.get(key);
      if (hit.icon) return hit;
      tried.push(`${path.basename(p)}: ${hit.reason}`);
      continue;
    }
    const blocked = sidecar.blockedReason();
    if (blocked) return { icon: null, reason: `no icon: the sidecar cannot be asked (${blocked})` };
    let entry;
    try {
      const r = await sidecar.call('icon', idx ? { path: p, index: idx } : { path: p }, 4000);
      entry = r && r.icon
        ? { icon: r.icon, reason: null }
        : { icon: null, reason: 'Windows had no icon for it' };
    } catch (err) {
      entry = { icon: null, reason: err.message };
    }
    iconCache.set(key, entry);
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
      groups.set(key, g);
    }
    if (!g.icon && w.icon) g.icon = w.icon;
    // A group can learn its other identifier from a later window: one window of an
    // app may carry an aumid and the next only an exe.
    if (!g.aumid && aumid) g.aumid = aumid;
    if (!g.exe && exe) { g.exe = exe; g.exeRaw = w.exe; }
    if (!g.host && w.host) g.host = w.host;
    g.windows.push({
      hwnd: String(w.hwnd),
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
  if (!running.length) {
    try {
      const listed = await sidecar.call('windows', {}, 4000);
      running = Array.isArray(listed) ? listed : [];
      lastWindows = running;
    } catch (err) {
      problems.push(`the running apps could not be read: ${err.message}`);
      running = [];
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

  for (const pin of pins) {
    if (!pin) continue;
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
    const ico = pin.iconPng ? { icon: pin.iconPng, reason: null } : await iconFor([pin.iconPath, pin.target, pin.exe, g && g.exeRaw], pin.iconIndex);
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
    const ico = g.icon ? { icon: g.icon, reason: null } : await iconFor([g.exeRaw]);
    items.push({
      id: `running:${key}`,
      name: nameForExe(g.exeRaw, g.title),
      kind: 'running',
      exe: g.exe,
      aumid: g.aumid || null,
      icon: ico.icon,
      iconReason: ico.icon ? null : ico.reason,
      windows: g.windows,
    });
  }

  const said = problems.concat(notes);
  return {
    ok: !problems.length,
    reason: said.length ? said.join('; ') : null,
    items,
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
async function launchItem(item, fresh) {
  const pin = pinById.get(item.id);
  const lnk = pin && (pin.lnkPath || pin.target || pin.exe);
  const aumid = (pin && pin.aumid) || item.aumid || null;
  const again = fresh ? ' another copy of' : '';

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

/** One part, never throwing: a refusal becomes {ok:false, reason}. */
async function qsPart(cmd, label, args) {
  try {
    const r = await sidecar.call(cmd, args || {}, 4000);
    return Object.assign({}, r, { ok: true, reason: null });
  } catch (err) {
    return {
      ok: false,
      reason: Sidecar.isOldExeError(err)
        ? `${label} cannot be read: the sidecar exe has no "${cmd}" command yet, so run npm run build:sidecar`
        : `${label} cannot be read: ${err.message}`,
    };
  }
}

async function qsRead() {
  const results = await Promise.allSettled(QS_PARTS.map(([, cmd, label]) => qsPart(cmd, label)));
  const out = { ok: false, reason: null };
  const dead = [];
  results.forEach((res, i) => {
    const key = QS_PARTS[i][0];
    const label = QS_PARTS[i][2];
    // allSettled cannot reject here (qsPart swallows), but a thrown TypeError
    // inside it would still land as `rejected` rather than as a missing key.
    out[key] = res.status === 'fulfilled'
      ? res.value
      : { ok: false, reason: `${label} cannot be read: ${(res.reason && res.reason.message) || res.reason}` };
    if (!out[key].ok) dead.push(out[key].reason);
  });
  // The panel is worth opening if the two things it is mostly for answered.
  // Anything else missing is a control that draws itself disabled with a reason.
  out.ok = !!(out.volume.ok && out.power.ok);
  out.reason = dead.length ? dead.join('; ') : null;
  return out;
}

/** part -> how to validate it and what to send. */
const QS_WRITE = {
  volume: {
    cmd: 'volume',
    label: 'the volume',
    args: (v) => ({ level: v }),
    check: (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 100
      ? null : 'volume must be a number from 0 to 100'),
  },
  mute: {
    cmd: 'volume',
    label: 'mute',
    args: (v) => ({ muted: !!v }),
    check: (v) => (typeof v === 'boolean' ? null : 'mute must be true or false'),
  },
  wifi: {
    cmd: 'wifi',
    label: 'Wi-Fi',
    args: (v) => ({ on: !!v }),
    check: (v) => (typeof v === 'boolean' ? null : 'wifi must be true or false'),
  },
  bluetooth: {
    cmd: 'bluetooth',
    label: 'Bluetooth',
    args: (v) => ({ on: !!v }),
    check: (v) => (typeof v === 'boolean' ? null : 'bluetooth must be true or false'),
  },
  brightness: {
    cmd: 'brightness',
    label: 'the screen brightness',
    args: (v) => ({ level: Number(v) }),
    check: (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 100
      ? null : 'brightness must be a number from 0 to 100'),
  },
};

// The watcher: one, ever. Two would double every sidecar call for a panel that
// can only be open once.
let qsTimer = null;
let qsWatching = false;
const QS_WATCH_MS = 2000;

function qsPush(why) {
  return qsRead().then((snap) => {
    broadcast('qs', snap);
    return snap;
  }).catch((err) => {
    process.stderr.write(`mantle: the quick-settings push (${why}) threw: ${err.message}\n`);
    return null;
  });
}

function qsWatchStart() {
  // The guard is `qsWatching`, NOT `qsTimer`: the timer is null for as long as a
  // push is in flight, so a second qs.watch arriving in that window used to start
  // a SECOND chain -- two pushes per tick, two sets of sidecar calls, and a stop
  // that only cancelled one of them. Caught by the harness, 2026-09-21.
  if (qsWatching) return false;      // already watching: not an error, just nothing to do
  const tick = () => {
    qsTimer = null;
    qsPush('the quick-settings panel is open').then(() => {
      if (!shuttingDown && qsWatching) {
        qsTimer = setTimeout(tick, QS_WATCH_MS);
        if (qsTimer.unref) qsTimer.unref();
      }
    });
  };
  qsWatching = true;
  tick();
  return true;
}

function qsWatchStop(why) {
  if (!qsWatching && !qsTimer) return false;
  qsWatching = false;
  if (qsTimer) clearTimeout(qsTimer);
  qsTimer = null;
  process.stdout.write(`mantle: quick-settings watch off: ${why}\n`);
  return true;
}


// ---------------------------------------------------------------------------
// The command table behind mantle.call(). Every one of these either resolves
// with a value or throws an Error whose message is a sentence the page can show.
// ---------------------------------------------------------------------------
function needHwnd(args) {
  const h = args && args.hwnd;
  if (h === undefined || h === null || h === '') throw new Error('that command needs a window handle (hwnd)');
  return String(h);
}

const COMMANDS = {
  'state.get': async () => state.get(),

  'windows.list': async () => {
    const list = await sidecar.call('windows');
    lastWindows = Array.isArray(list) ? list : [];
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
    const fresh = !!(a && a.fresh);
    const wins = Array.isArray(item.windows) ? item.windows : [];
    // One line per click, so a click that "did nothing" can be read back from the log.
    process.stdout.write(`mantle: bar.open ${item.name}: ${wins.length} window(s)${fresh ? ', fresh' : ''}${wins.length === 1 ? `, active=${!!wins[0].active}, hwnd ${wins[0].hwnd}` : ''}\n`);

    if (!fresh && wins.length >= 2) {
      return { ok: true, reason: null, action: 'list', windows: wins };
    }
    if (!fresh && wins.length === 1) {
      const w = wins[0];
      const action = w.active ? 'minimize' : 'focus';
      try {
        await sidecar.call(action, { hwnd: String(w.hwnd) }, 4000);
        process.stdout.write(`mantle: bar.open ${item.name}: ${action} of ${w.hwnd} done\n`);
        return { ok: true, reason: null, action, hwnd: String(w.hwnd) };
      } catch (err) {
        return { ok: false, reason: `${item.name} is running but Mantle could not ${action} it: ${err.message}` };
      }
    }
    return launchItem(item, fresh);
  },

  'bar.window': async (a) => {
    const hwnd = a && a.hwnd !== undefined && a.hwnd !== null ? String(a.hwnd) : '';
    if (!hwnd) return { ok: false, reason: 'bar.window needs a window handle (hwnd)' };
    const action = String((a && a.action) || '');
    if (!['focus', 'minimize', 'close', 'toggle'].includes(action)) {
      return { ok: false, reason: `bar.window does not know the action "${action}" (it does focus, minimize, close and toggle)` };
    }
    try {
      await sidecar.call(action, { hwnd }, 4000);
      return { ok: true, reason: null, action, hwnd };
    } catch (err) {
      return { ok: false, reason: `could not ${action} that window: ${err.message}` };
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

  // The bar window is only 44px tall, so a popover drawn inside it would be
  // clipped by the window, not by the screen. The bar asks for room before it
  // opens one and gives it back when it closes. The window grows AWAY from its
  // screen edge: the bottom bar keeps its bottom edge and rises, the top bar
  // keeps its top edge and descends, so the bar itself never appears to move.
  'bar.popover': async (a) => {
    if (!barWin || barWin.isDestroyed()) throw new Error('the bar window is gone, so there is nothing to make room in');
    const open = !!(a && a.open);
    // A popover is the bar being used, so it pins the bar on screen for as long
    // as it is open (the hover poll checks barPopover on every tick) and brings
    // it back if something raced it into hiding.
    if (open && !flags.dock) revealBar('a bar popover opened');
    const asked = Number(a && a.height);
    const extra = open ? Math.max(0, Math.min(POPOVER_MAX, Number.isFinite(asked) ? Math.round(asked) : 0)) : 0;
    const total = BAR_H + extra;

    if (flags.test) {
      // A framed test window: work in deltas off the current content size, so the
      // frame's own height stays out of the arithmetic.
      const [, contentH] = barWin.getContentSize();
      const delta = total - contentH;
      if (delta !== 0) {
        const b = barWin.getBounds();
        barWin.setBounds({
          x: b.x,
          y: flags.barEdge === 'top' ? b.y : b.y - delta,
          width: b.width,
          height: b.height + delta,
        });
      }
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

    barPopover = extra ? { key: (a && a.key) || 'unnamed', height: extra } : null;
    try {
      process.stdout.write(`mantle: bar.popover ${open ? `open (${(a && a.key) || 'unnamed'}, asked ${asked}px, got ${extra}px)` : 'closed'} -> window now ${JSON.stringify(barWin.getBounds())} (DIP)\n`);
    } catch (_) { /* the window may be gone; the line is only a trace */ }
    // The window just changed size, which is another moment Windows can re-order
    // the topmost band -- and a popover nobody can click is worse than no popover.
    if (open && !flags.dock) raiseBar('a popover opened');
    if (open && extra < asked) {
      process.stdout.write(`mantle: the bar asked for ${asked}px of popover room and got ${extra}px (the cap is ${POPOVER_MAX}px)\n`);
    }
    return { height: extra, total, capped: open && extra < asked, max: POPOVER_MAX };
  },

  'launcher.show': async () => { showLauncher(); return { visible: true }; },
  'launcher.hide': async () => { hideLauncher(); return { visible: false }; },

  'apps.index': async (a) => apps.index({ refresh: !!(a && a.refresh) }),
  'apps.search': async (a) => apps.search(a && a.q),
  'apps.launch': async (a) => {
    const res = await apps.launch(a && a.id);
    if (res && res.ok) hideLauncher();
    return res;
  },

  'volume.get': async () => sidecar.call('volume'),
  'volume.set': async (a) => {
    const args = {};
    if (a && a.level !== undefined) args.level = a.level;
    if (a && a.muted !== undefined) args.muted = a.muted;
    if (!Object.keys(args).length) throw new Error('volume.set needs a level or a muted flag');
    return sidecar.call('volume', args);
  },

  // ---- Quick Settings: the bar's own panel, not a trip to the Settings app ----
  'qs.get': async () => qsRead(),

  'qs.set': async (a) => {
    const part = String((a && a.part) || '');
    const spec = QS_WRITE[part];
    if (!spec) {
      return { ok: false, part, value: null, reason: `qs.set does not know the part "${part}" (it does ${Object.keys(QS_WRITE).join(', ')})` };
    }
    const bad = spec.check(a && a.value);
    if (bad) return { ok: false, part, value: null, reason: bad };
    try {
      await sidecar.call(spec.cmd, spec.args(a.value), 4000);
    } catch (err) {
      return {
        ok: false,
        part,
        value: null,
        reason: Sidecar.isOldExeError(err)
          ? `${spec.label} could not be changed: the sidecar exe has no "${spec.cmd}" command yet, so run npm run build:sidecar`
          : `${spec.label} could not be changed: ${err.message}`,
      };
    }
    // READ IT BACK rather than echoing what was asked for: a slider that springs
    // back is the truth about a control that refused, and a slider that lies
    // about where it is is the silent failure this rule exists to stop.
    const now = await qsPart(spec.cmd, spec.label);
    if (qsWatching) qsPush(`${part} was changed`);
    return { ok: !!now.ok, part, value: now, reason: now.ok ? null : now.reason };
  },

  'qs.watch': async (a) => {
    const on = !!(a && a.on);
    if (on) {
      const started = qsWatchStart();
      return { ok: true, watching: true, everyMs: QS_WATCH_MS, reason: started ? null : 'the quick-settings watch was already running, so nothing was started twice' };
    }
    qsWatchStop('the panel asked');
    return { ok: true, watching: false, everyMs: QS_WATCH_MS, reason: null };
  },

  'open': async (a) => openTarget(a && a.target),

  'shell.restore': async () => {
    await restoreShell('a window asked for it');
    return state.get();
  },
  'shell.quit': async () => {
    // Answer first, quit on the next tick, so the page that asked is not waiting
    // on a promise that dies with the process.
    setTimeout(() => shutdown('a window asked Mantle to quit'), 0);
    return { quitting: true };
  },

  'sys.stats': async () => stats(),

  'tray.list': async () => {
    const list = await sidecar.call('tray');
    lastTray = Array.isArray(list) ? list : [];
    return lastTray;
  },
  'tray.click': async (a) => {
    if (!a || !a.id) throw new Error('tray.click needs the id of a notification-area item');
    return sidecar.call('trayClick', { id: a.id, button: a.button || 'left' });
  },

  // Not part of the original four-lane contract: the desktop page needs to know
  // whether Mission Control is up AND why it is not, and a fetch() from a file://
  // page can only ever report "Failed to fetch". Loopback only; see lib/net-probe.js.
  'net.probe': async (a) => probe((a && a.url) || ''),
};

ipcMain.handle('mantle:call', async (_e, name, args) => {
  const fn = COMMANDS[name];
  if (!fn) return { ok: false, error: `Mantle has no command called "${name}"` };
  try {
    const result = await fn(args || {});
    // A command that answers ok:false is a failure the page will show as a chip --
    // a 56 px pip in pill mode, which nobody reads. It goes to the log too, so
    // "I clicked and nothing happened" can be answered from the log (2026-09-21).
    if (result && typeof result === 'object' && result.ok === false && !/^(state|sys)\./.test(name)) {
      process.stdout.write(`mantle: ${name} ${args ? JSON.stringify(args).slice(0, 120) : ''} -> ${result.reason || 'ok:false, no reason'}\n`);
    }
    return { ok: true, result };
  } catch (err) {
    process.stdout.write(`mantle: ${name} threw: ${err && err.message ? err.message : String(err)}\n`);
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
});

// mantle.on('state'|'windows'|...) replays the current value on subscribe, so a
// page never renders an empty first frame while it waits for a push.
ipcMain.handle('mantle:replay', async (_e, name) => {
  switch (name) {
    case 'state': return { has: true, payload: state.get() };
    case 'windows': return { has: true, payload: lastWindows };
    case 'launcher:visible': return { has: true, payload: !!(launcherWin && !launcherWin.isDestroyed() && launcherWin.isVisible()) };
    case 'tray': return lastTray ? { has: true, payload: lastTray } : { has: false };
    // The bar subscribes before it calls, and an empty first frame in a taskbar
    // looks exactly like a broken one. Build the list if nothing has yet.
    case 'bar.pinned': return { has: true, payload: lastPinned || await pinnedOnce() };
    // ms:0 -- the bar is ALREADY where it belongs, so the page should paint itself
    // arrived rather than replay a 560 ms entrance it missed.
    case 'bar.reveal': return barRevealed
      ? { has: true, payload: { why: 'the bar was already up when this page subscribed', mode: BAR_SHAPE, ms: 0 } }
      : { has: false };
    default: return { has: false };
  }
});

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
    reason: desktopWin
      ? `the desktop layer is floating instead of sitting under the wallpaper: ${reason}`
      : '--no-desktop: the desktop layer was not created',
  });
  state.set('hotkey', { winTap: false, reason: `the Win key still opens the Windows Start menu: ${reason}` });
  if (state.get().edgeclip.on) {
    state.set('edgeclip', { applied: false, reason: `the cursor is not confined, so the Windows taskbar can slide up through the island's gaps: ${reason}` });
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

sidecar.on('windows', (msg) => {
  lastWindows = Array.isArray(msg.list) ? msg.list : [];
  broadcast('windows', lastWindows);
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

sidecar.on('hotkey', (msg) => {
  if (msg && msg.name === 'win') showLauncher();
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
    if (!age.current) {
      state.set('sidecar', { reason: `${state.get().sidecar.reason} -- but ${age.reason}` });
      process.stderr.write(`mantle: ${age.reason}\n`);
    } else {
      process.stdout.write(`mantle: ${age.reason}\n`);
    }
    // One probe, not a poll: the tray list is worth knowing about in a test run,
    // but a five-second poll is not worth the CPU for a window nobody is watching.
    try {
      const list = await sidecar.call('tray');
      lastTray = Array.isArray(list) ? list : [];
      state.set('tray', { status: 'ok', reason: `test mode: probed once, ${lastTray.length} notification-area items (not polled)` });
      broadcast('tray', lastTray);
    } catch (err) {
      state.set('tray', { status: 'unavailable', reason: `${err.message} (test mode: probed once, not polled)` });
    }
    // Glass runs in test mode too: it only ever touches Mantle's own two windows,
    // so passive allows it, and a test run is the only place this lane can see
    // whether it worked at all.
    await applyGlass();
    return;
  }

  await applyLive();
  await applyGlass();
  startTrayPoll();
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
  const side = barRevealed ? geo.rest : geo.start;
  const r = sideRect(side);
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

async function applyLive() {
  // 0. Is the exe even new enough to be trusted with the shell? The old one
  //    answers `taskbar` by looking for a `show` key, and what it does without
  //    one is not something to discover on Owen's live desktop.
  const age = await sidecar.protocolAge();
  sidecarDpiAware = age.dpiAware === true ? true : (age.dpiAware === false ? false : null);
  if (!age.current) {
    oldExeBaseline(age.reason);
    return;
  }

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
    } catch (err) {
      if (Sidecar.isOldExeError(err)) { oldExeBaseline(`the sidecar refused "appbar": ${err.message}`); return; }
      state.set('workarea', {
        reserved: false,
        reason: `Mantle's bar could not be registered as an app bar, so maximised windows will sit under it: ${err.message}. Nothing was reserved by any other means -- the old work-area call is gone because it survived a crash.`,
      });
    }
  }

  // 3. Put the desktop layer under the wallpaper.
  if (!desktopWin || desktopWin.isDestroyed()) {
    state.set('desktop', { attached: false, mode: null, reason: '--no-desktop: the desktop layer was not created' });
  } else {
    try {
      const r = await sidecar.call('desktop', { hwnd: hwndOf(desktopWin) });
      const mode = (r && r.mode) || null;
      state.set('desktop', {
        attached: true,
        mode,
        reason: mode === 'progman-front'
          ? 'the desktop layer is behind the icons and in front of the wallpaper, including a video wallpaper (progman-front)'
          : `the desktop layer is under the wallpaper (${mode || 'mode not reported'})`,
      });
      armDesktopRecheck(mode);
    } catch (err) {
      state.set('desktop', { attached: false, mode: null, reason: `the desktop layer could not go under the wallpaper, so it is floating as an ordinary window: ${err.message}` });
    }
  }

  // 4. The solo-Win-tap hook that opens the launcher.
  try {
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
const DESKTOP_RECHECK_MS = 5000;
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

// ---------------------------------------------------------------------------
// The notification-area mirror the bar renders.
// ---------------------------------------------------------------------------
function startTrayPoll() {
  stopTrayPoll();
  const tick = async () => {
    let delay = 5000;
    try {
      const list = await sidecar.call('tray');
      lastTray = Array.isArray(list) ? list : [];
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

    // 3. The pieces that were always safe: the hook and the wallpaper layer.
    const rest = [['the Win key hook', () => sidecar.call('hotkey', { winTap: false }, 4000)]];
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

function shutdown(why) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write(`mantle: shutting down (${why})\n`);
  stopTrayPoll();
  // The cursor poll stops DEAD here, before anything else: it is the only thing
  // in Mantle that runs many times a second, and a poll still ticking through a
  // restore is a poll that can show a bar window mid-shutdown.
  stopHoverWatch();
  // ...and with it the capture loop, which is the one thing that can leave a
  // window excluded from Owen's screenshots if it is stopped carelessly.
  stopBackdrop('Mantle is shutting down');
  qsWatchStop('Mantle is shutting down');
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
    app.exit(0);
  }, 12000);
  if (hardStop.unref) hardStop.unref();

  restoreShell(why).finally(() => {
    clearTimeout(hardStop);
    try { sidecar.stop(); } catch (_) {}
    try { if (tray) tray.destroy(); } catch (_) {}
    // exit() rather than quit(): quit() would re-enter before-quit and we have
    // already done every piece of cleanup there is.
    app.exit(0);
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

process.on('uncaughtException', (err) => {
  process.stderr.write(`mantle: uncaught exception: ${err && err.stack ? err.stack : err}\n`);
  // A shell in an unknown state is worse than no shell: put Windows back and go.
  shutdown('an uncaught exception');
});
process.on('unhandledRejection', (err) => {
  // Not fatal, but it is never nothing. It goes where someone will see it.
  process.stderr.write(`mantle: unhandled promise rejection: ${err && err.stack ? err.stack : err}\n`);
});

// ---------------------------------------------------------------------------
// The tray icon: the escape hatch that does not need a keyboard.
// ---------------------------------------------------------------------------
function updateTray() {
  if (!tray || tray.isDestroyed()) return;
  const problems = state.problems();
  const summary = problems.length
    ? `${problems.length} thing${problems.length === 1 ? '' : 's'} to look at: ${problems.map((p) => p.piece).join(', ')}`
    : 'everything is as it should be';
  try {
    tray.setToolTip(`Mantle (${MODE})\n${summary}`);
  } catch (_) {}
  try {
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: `Mantle — ${MODE}`, enabled: false },
      { label: summary, enabled: false },
      { type: 'separator' },
      // Two items, and neither of them can make things worse. There is
      // deliberately NO "hide the Windows taskbar" any more: that item called the
      // command that caused the 2026-09-21 reboot, and a menu entry whose only
      // job is to put the shell into a state Mantle has to be alive to undo has
      // no business existing.
      {
        label: 'Put Windows back (keep Mantle open)',
        click: () => { restoreShell('the tray menu asked for it'); },
      },
      { type: 'separator' },
      { label: 'Quit Mantle', click: () => shutdown('the tray menu') },
    ]));
  } catch (err) {
    process.stderr.write(`mantle: could not build the tray menu: ${err.message}\n`);
  }
}

function createTray() {
  try {
    tray = new Tray(trayImage());
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
      restoreShell('the kill switch').finally(() => shutdown('the kill switch'));
    });
  } catch (err) {
    problems.push(`Ctrl+Alt+Shift+Backspace threw (${err.message})`);
  }
  if (!killSwitch && !problems.length) problems.push('Ctrl+Alt+Shift+Backspace is already taken by another app, so the kill switch is NOT armed');

  try {
    launcher = globalShortcut.register('Alt+Space', () => {
      if (launcherWin && !launcherWin.isDestroyed() && launcherWin.isVisible()) hideLauncher();
      else showLauncher();
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
  shutdown('the screenshots are done');
}

// ---------------------------------------------------------------------------
// Boot.
// ---------------------------------------------------------------------------
function watchPage(win, label) {
  const wc = win.webContents;
  // A page that will not load must say so on screen, not leave a blank window.
  let swapped = false;
  wc.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
    if (!isMainFrame || swapped) return;
    if (code === -3) return;   // ERR_ABORTED: a load we replaced ourselves
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
    process.stderr.write(`mantle: the ${label} renderer died: ${details.reason}\n`);
  });
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
    if (bad) process.stderr.write(`mantle: [${label}] ${message} (${source}:${line})\n`);
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
    const fmt = (p) => `private ${Math.round((p.memory.privateBytes || 0) / 1024)} MB, ws ${Math.round(p.memory.workingSetSize / 1024)} MB`;
    let privateTotal = 0;
    for (const p of byPid.values()) privateTotal += (p.memory.privateBytes || 0);
    for (const [name, w] of [['bar', barWin], ['launcher', launcherWin], ['desktop', desktopWin]]) {
      if (!w || w.isDestroyed()) { parts.push(`${name}: no window`); continue; }
      const pid = w.webContents.getOSProcessId();
      const p = byPid.get(pid);
      parts.push(`${name} pid ${pid}: ${p ? fmt(p) : 'not in the app metrics'}`);
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
  const bar = createBar({ root: ROOT, test: flags.test, barEdge: flags.barEdge });
  barWin = bar.win;
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

  const memFirst = setTimeout(() => logMemory('30 s after start'), 30000);
  if (memFirst.unref) memFirst.unref();
  const memEvery = setInterval(() => logMemory('every 30 min'), 30 * 60 * 1000);
  if (memEvery.unref) memEvery.unref();

  if (process.env.MANTLE_NO_LAUNCHER === '1') {
    // Measurement switch only: how much of the footprint is the launcher window.
    process.stdout.write('mantle: MANTLE_NO_LAUNCHER=1: the launcher window was not created (measurement run; the Win key does nothing)\n');
  } else {
    const launcher = createLauncher({ root: ROOT, test: flags.test });
    launcherWin = launcher.win;
    watchPage(launcherWin, 'The launcher');
    if (!launcher.load.loaded) process.stderr.write(`mantle: ${launcher.load.reason}\n`);
    // A reload rebuilds the page, not the window, so the composition attribute
    // should survive -- but "should" is cheap to stop relying on, and re-asking
    // costs one JSON line.
    launcherWin.webContents.on('did-finish-load', () => { reapplyGlass('the launcher', launcherWin, 'acrylic'); });
    if (flags.test) {
      // In test mode the launcher is the thing being looked at, so it is up from
      // the start -- inactive, and with no hide-on-blur, or toback.ps1 sending it
      // to the back would make it vanish.
      launcherWin.once('ready-to-show', () => launcherWin.showInactive());
    } else {
      launcherWin.on('blur', () => hideLauncher());
    }
  }

  if (flags.desktop) {
    const desktop = createDesktop({ root: ROOT, test: flags.test });
    desktopWin = desktop.win;
    watchPage(desktopWin, 'The desktop layer');
    // One capture of the wallpaper BEFORE the layer covers the screen. It is
    // still hidden here, so there is nothing to exclude from the shot, and the
    // picture it gets is the only thing behind it that will ever be there.
    desktopWin.once('ready-to-show', () => {
      desktopBackdrop.once('the desktop layer is starting')
        .catch(() => {})
        .then(() => { if (desktopWin && !desktopWin.isDestroyed()) desktopWin.showInactive(); });
    });
    if (!desktop.load.loaded) process.stderr.write(`mantle: ${desktop.load.reason}\n`);
  } else {
    state.set('desktop', { attached: false, mode: null, reason: '--no-desktop: the desktop layer was not created' });
  }

  // Order matters: the shortcuts write their own state before the tray reads the
  // state to build its menu, and test mode's four "deliberately not done" reasons
  // are true from the first frame, not from whenever the sidecar answers.
  if (flags.test) testShellBaseline();
  registerShortcuts();
  createTray();
  apps.startRefresh();

  // ONE display listener for the whole process, calling whatever "put the bar
  // back" means right now. applyLive re-runs on every sidecar restart and used to
  // add another listener each time it did.
  screen.on('display-metrics-changed', () => {
    if (rePlaceBar) rePlaceBar('display metrics changed');
    // The desktop layer's picture is the wallpaper, which a resolution or scale
    // change reflows. It is a still, so this is the only thing that redates it.
    reshootDesktopBackdrop('the display metrics changed').catch(() => {});
  });

  if (flags.dock) {
    // --dock: the old permanent bar. Shown once, and it stays.
    barWin.once('ready-to-show', () => {
      barWin.showInactive();
      barRevealed = true;
      setBar({ ok: true, revealed: true, reason: '--dock: the bar is permanently on screen and reserves its strip' });
    });
  } else {
    startHoverWatch();
  }
  startPinWatch();
  schedulePinnedPush('Mantle started');

  sidecar.start();

  if (flags.screenshot) runScreenshots(path.resolve(flags.screenshot));
});
