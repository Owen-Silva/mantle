'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const { app, BrowserWindow, ipcMain, globalShortcut, Tray, Menu, screen } = require('electron');

const { parseArgs, ArgError } = require('./lib/args');
const { ShellState } = require('./lib/state');
const { Sidecar } = require('./lib/sidecar');
const { Apps, modulePathFor } = require('./lib/apps');
const { stats } = require('./lib/sys-stats');
const { trayImage } = require('./lib/tray-icon');
const { openTarget } = require('./lib/open-target');
const { probe } = require('./lib/net-probe');
const { placeholderUrl } = require('./lib/placeholder');
const { createBar, createLauncher, createDesktop, hwndOf, acrylicSupport, BAR_H } = require('./lib/windows');

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
const POPOVER_MAX = 320;
let restoreChain = Promise.resolve();

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
// The launcher's visibility, which three different things can change.
// ---------------------------------------------------------------------------
function showLauncher() {
  if (!launcherWin || launcherWin.isDestroyed()) return;
  if (flags.test) {
    // A test run must never take focus from whoever is at the machine.
    launcherWin.showInactive();
  } else {
    launcherWin.show();
    launcherWin.focus();
  }
  broadcast('launcher:visible', true);
}

function hideLauncher() {
  if (!launcherWin || launcherWin.isDestroyed()) return;
  if (!launcherWin.isVisible()) return;
  launcherWin.hide();
  broadcast('launcher:visible', false);
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

  // The bar window is only 44px tall, so a popover drawn inside it would be
  // clipped by the window, not by the screen. The bar asks for room before it
  // opens one and gives it back when it closes. The window grows AWAY from its
  // screen edge: the bottom bar keeps its bottom edge and rises, the top bar
  // keeps its top edge and descends, so the bar itself never appears to move.
  'bar.popover': async (a) => {
    if (!barWin || barWin.isDestroyed()) throw new Error('the bar window is gone, so there is nothing to make room in');
    const open = !!(a && a.open);
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
      // Live: anchor to the display rather than to the window's current bounds,
      // so a popover that opens twice cannot drift the bar up the screen.
      const d = screen.getPrimaryDisplay().bounds;
      barWin.setBounds({
        x: d.x,
        y: flags.barEdge === 'top' ? d.y : d.y + d.height - total,
        width: d.width,
        height: total,
      });
    }

    barPopover = extra ? { key: (a && a.key) || 'unnamed', height: extra } : null;
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
    return { ok: true, result: await fn(args || {}) };
  } catch (err) {
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
  state.set('tray', { status: 'unavailable', reason: `cannot read the notification area: ${reason}` });
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
}

/**
 * What test mode is NOT doing, said out loud at boot rather than after the
 * sidecar says hello -- these four are true whether or not it ever does.
 */
function testShellBaseline() {
  state.set('taskbar', { autohide: false, wasAutohide: null, reason: 'test mode: the Windows taskbar was left exactly as it is' });
  state.set('workarea', { reserved: false, reason: 'test mode: no app bar was registered, so no screen space was reserved' });
  state.set('desktop', {
    attached: false,
    mode: null,
    reason: flags.desktop
      ? 'test mode: the desktop window is an ordinary window, not reparented under the wallpaper'
      : '--no-desktop: the desktop layer was not created',
  });
  state.set('hotkey', { winTap: false, reason: 'test mode: the Win key hook was not installed' });
}

sidecar.on('ready', () => {
  // The shell changes are applied only once the sidecar has actually said hello;
  // firing them at spawn time would race its startup.
  applyMode().catch((err) => {
    state.set('sidecar', { status: 'down', reason: `Mantle could not set itself up: ${err.message}` });
  });
});

sidecar.on('windows', (msg) => {
  lastWindows = Array.isArray(msg.list) ? msg.list : [];
  broadcast('windows', lastWindows);
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
  const text = `[sidecar ${level}] ${msg && msg.message ? msg.message : ''}`;
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
    return;
  }

  await applyLive();
  startTrayPoll();
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
function placeBar(rect, dpiAware) {
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

async function applyLive() {
  // 0. Is the exe even new enough to be trusted with the shell? The old one
  //    answers `taskbar` by looking for a `show` key, and what it does without
  //    one is not something to discover on Owen's live desktop.
  const age = await sidecar.protocolAge();
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

  // 2. The bar becomes a REAL app bar. Explorer then keeps maximised windows off
  //    that strip AND drops the reservation itself the moment the window dies.
  //    There is deliberately NO SPI_SETWORKAREA fallback: that one outlives the
  //    process, which is the exact property this whole redesign exists to refuse.
  if (!barWin || barWin.isDestroyed()) {
    state.set('workarea', { reserved: false, reason: 'there is no bar window, so no screen space was reserved' });
  } else {
    try {
      const hwnd = hwndOf(barWin);
      const r = await sidecar.call('appbar', { hwnd, edge: flags.barEdge, size: BAR_H });
      appbarHwnd = hwnd;
      const placed = placeBar(r && r.rect, age.dpiAware);
      state.set('workarea', {
        reserved: true,
        reason: `Mantle's bar is registered as an app bar; Explorer keeps maximised windows off it and drops the reservation by itself if Mantle dies (${placed.how})`,
      });
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
      state.set('desktop', {
        attached: true,
        mode: (r && r.mode) || null,
        reason: `the desktop layer is under the wallpaper (${(r && r.mode) || 'mode not reported'})`,
      });
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

app.whenReady().then(() => {
  // Real Windows 11 acrylic, or the honest reason it is not. Decided ONCE, here,
  // and handed to both windows: `transparent` cannot be changed after a window is
  // built, so this is the last moment the question can be asked.
  const support = acrylicSupport();
  const useAcrylic = flags.acrylic && support.ok;
  if (flags.acrylic && !support.ok) {
    process.stderr.write(`mantle: no acrylic: ${support.reason}\n`);
  }

  const bar = createBar({ root: ROOT, test: flags.test, barEdge: flags.barEdge, acrylic: useAcrylic });
  barWin = bar.win;
  watchPage(barWin, 'The bar');
  barWin.once('ready-to-show', () => barWin.showInactive());
  barWin.webContents.on('did-finish-load', () => {
    // A reloaded bar has no popover open, so any room it borrowed is now room
    // nothing is using. Give it back rather than leaving a 300px-tall "bar".
    if (barPopover) COMMANDS['bar.popover']({ open: false }).catch(() => {});
  });
  if (!bar.load.loaded) process.stderr.write(`mantle: ${bar.load.reason}\n`);

  const launcher = createLauncher({ root: ROOT, test: flags.test, acrylic: useAcrylic });
  launcherWin = launcher.win;
  watchPage(launcherWin, 'The launcher');
  if (!launcher.load.loaded) process.stderr.write(`mantle: ${launcher.load.reason}\n`);

  // One state piece for two windows: 'acrylic' only when BOTH got it, because a
  // bar of real glass beside a launcher of painted-on glass is a bug report
  // waiting to happen, and the reason names whichever one missed out.
  const glassPieces = [bar.glass, launcher.glass];
  const bothAcrylic = glassPieces.every((g) => g && g.material === 'acrylic');
  state.set('glass', {
    material: bothAcrylic ? 'acrylic' : 'css',
    reason: !flags.acrylic
      ? '--no-acrylic: the bar and launcher are transparent windows with lane C\'s CSS glass, exactly as before'
      : bothAcrylic
        ? `${support.reason}; the bar and the launcher both blur the real desktop behind them`
        : glassPieces.map((g) => (g && g.reason) || 'a window did not report what glass it got').join('; '),
  });
  if (flags.test) {
    // In test mode the launcher is the thing being looked at, so it is up from
    // the start -- inactive, and with no hide-on-blur, or toback.ps1 sending it
    // to the back would make it vanish.
    launcherWin.once('ready-to-show', () => launcherWin.showInactive());
  } else {
    launcherWin.on('blur', () => hideLauncher());
  }

  if (flags.desktop) {
    const desktop = createDesktop({ root: ROOT, test: flags.test });
    desktopWin = desktop.win;
    watchPage(desktopWin, 'The desktop layer');
    desktopWin.once('ready-to-show', () => desktopWin.showInactive());
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
  sidecar.start();

  if (flags.screenshot) runScreenshots(path.resolve(flags.screenshot));
});
