'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
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
const { createBar, createLauncher, createDesktop, hwndOf, BAR_H } = require('./lib/windows');

/*
 * Mantle's main process: a shell LAYER over Windows 11.
 *
 * explorer.exe keeps running underneath. Mantle hides the Windows taskbar, puts
 * its own bar, launcher and desktop layer on screen, and can put everything back
 * instantly. The dangerous half -- taskbar, work area, the wallpaper layer, the
 * Win key -- is done by one C# sidecar that restores whatever it changed the
 * moment this process dies, so the worst case for Owen is "Mantle disappeared",
 * never "Windows has no taskbar and I cannot get it back".
 *
 * This file owns: the flags, the three windows, the IPC bridge behind
 * window.mantle, the sidecar's lifetime, the tray menu, the kill switch, and the
 * restore path that every exit road leads to.
 */

const ROOT = __dirname;

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

if (!app.requestSingleInstanceLock()) {
  process.stderr.write(`mantle: another instance is already using ${app.getPath('userData')}; this one is exiting\n`);
  app.exit(0);
}

// ---------------------------------------------------------------------------
// Everything the process holds on to.
// ---------------------------------------------------------------------------
const state = new ShellState(MODE, flags.barEdge);
const sidecar = new Sidecar({
  exePath: path.join(ROOT, 'sidecar', 'bin', 'Mantle.Sidecar.exe'),
  buildScript: path.join(ROOT, 'sidecar', 'build.ps1'),
  passive: flags.test,
  cwd: ROOT,
});
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
  state.set('taskbar', { hidden: false, reason: `the Windows taskbar is untouched: ${reason}` });
  state.set('workarea', { reserved: false, reason: `no screen space is reserved for the bar, so maximised windows will sit under it: ${reason}` });
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
  state.set('taskbar', { hidden: false, reason: 'test mode: the Windows taskbar was left alone' });
  state.set('workarea', { reserved: false, reason: 'test mode: the work area was left alone' });
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
  // The sidecar volunteers this whenever the taskbar's visibility changes under
  // it (explorer restarts, another app unhides it). Trust its word over ours.
  state.set('taskbar', {
    hidden: !!msg.hidden,
    reason: msg.reason || (msg.hidden ? 'the Windows taskbar is hidden' : 'the Windows taskbar is showing'),
  });
});

sidecar.on('log', (msg) => {
  const level = (msg && msg.level) || 'info';
  const text = `[sidecar ${level}] ${msg && msg.message ? msg.message : ''}`;
  if (level === 'error' || level === 'warn') process.stderr.write(text + '\n');
  else process.stdout.write(text + '\n');
});

sidecar.on('died', () => {
  // The sidecar puts Windows back itself when its parent dies or its stdin closes,
  // so there is nothing left for us to undo -- but the state has to stop claiming
  // the taskbar is hidden when it is not.
  markRestored('the sidecar stopped, so Windows put itself back');
  stopTrayPoll();
});

// ---------------------------------------------------------------------------
// Applying (or deliberately not applying) the shell changes.
// ---------------------------------------------------------------------------
async function applyMode() {
  if (flags.test) {
    testShellBaseline();
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

async function applyLive() {
  // 1. Hide the Windows taskbar.
  try {
    const r = await sidecar.call('taskbar', { show: false });
    const hidden = !!(r && r.hidden);
    state.set('taskbar', {
      hidden,
      reason: hidden ? 'the Windows taskbar is hidden; Mantle\'s bar is standing in for it'
        : 'the sidecar ran the hide but the taskbar is still showing',
    });
  } catch (err) {
    state.set('taskbar', { hidden: false, reason: `could not hide the Windows taskbar: ${err.message}` });
  }

  // 2. Reserve the bar's strip of screen, so maximised windows stop above it.
  try {
    const args = flags.barEdge === 'top' ? { top: BAR_H } : { bottom: BAR_H };
    await sidecar.call('workarea', args);
    state.set('workarea', { reserved: true, reason: `${BAR_H}px reserved at the ${flags.barEdge} of the screen for the bar` });
  } catch (err) {
    state.set('workarea', { reserved: false, reason: `could not reserve ${BAR_H}px for the bar, so maximised windows will sit under it: ${err.message}` });
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
  state.set('taskbar', { hidden: false, reason: `the Windows taskbar is back: ${why}` });
  state.set('workarea', { reserved: false, reason: `the work area is back to full screen: ${why}` });
  state.set('desktop', { attached: false, mode: null, reason: `the desktop layer is detached: ${why}` });
  state.set('hotkey', { winTap: false, reason: `the Win key opens the Windows Start menu again: ${why}` });
}

/**
 * Idempotent, serialised, and it swallows everything. Calling it twice is fine;
 * calling it when nothing was ever applied is fine; calling it with a dead
 * sidecar is fine (the sidecar has already restored on its own by then).
 */
function restoreShell(why) {
  restoreChain = restoreChain.then(async () => {
    if (flags.test) {
      state.set('taskbar', { hidden: false, reason: 'test mode: nothing was changed, so there is nothing to restore' });
      return;
    }
    const steps = [
      ['the taskbar', () => sidecar.call('taskbar', { show: true }, 4000)],
      ['the work area', () => sidecar.call('workarea', { reset: true }, 4000)],
      ['the Win key hook', () => sidecar.call('hotkey', { winTap: false }, 4000)],
    ];
    if (desktopWin && !desktopWin.isDestroyed()) {
      steps.push(['the desktop layer', () => sidecar.call('desktop', { hwnd: hwndOf(desktopWin), detach: true }, 4000)]);
    }
    const failures = [];
    for (const [label, run] of steps) {
      try {
        await run();
      } catch (err) {
        failures.push(`${label} (${err.message})`);
      }
    }
    if (failures.length) {
      // The sidecar restores everything on its own when it exits, so a failure
      // here is not the end of the world -- but it must be said out loud.
      markRestored(`${why}; Mantle could not restore ${failures.join(', ')} directly, the sidecar will do it when it exits`);
    } else {
      markRestored(why);
    }
  }).catch((err) => {
    process.stderr.write(`mantle: restore path threw, which it never should: ${err && err.message}\n`);
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

  // A hung sidecar must not hold the exit: it restores on its own when its stdin
  // closes, so after three seconds we stop waiting and go.
  const hardStop = setTimeout(() => { try { sidecar.stop(); } catch (_) {} app.exit(0); }, 3000);
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
      {
        label: 'Restore Windows taskbar',
        click: () => { restoreShell('the tray menu asked for it'); },
      },
      {
        label: 'Hide Windows taskbar',
        click: async () => {
          try {
            const r = await sidecar.call('taskbar', { show: false });
            state.set('taskbar', { hidden: !!(r && r.hidden), reason: r && r.hidden ? 'the Windows taskbar is hidden (asked from the tray menu)' : 'the tray menu asked to hide the taskbar and it is still showing' });
          } catch (err) {
            state.set('taskbar', { hidden: false, reason: `the tray menu could not hide the taskbar: ${err.message}` });
          }
        },
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
  const bar = createBar({ root: ROOT, test: flags.test, barEdge: flags.barEdge });
  barWin = bar.win;
  watchPage(barWin, 'The bar');
  barWin.once('ready-to-show', () => barWin.showInactive());
  barWin.webContents.on('did-finish-load', () => {
    // A reloaded bar has no popover open, so any room it borrowed is now room
    // nothing is using. Give it back rather than leaving a 300px-tall "bar".
    if (barPopover) COMMANDS['bar.popover']({ open: false }).catch(() => {});
  });
  if (!bar.load.loaded) process.stderr.write(`mantle: ${bar.load.reason}\n`);

  const launcher = createLauncher({ root: ROOT, test: flags.test });
  launcherWin = launcher.win;
  watchPage(launcherWin, 'The launcher');
  if (!launcher.load.loaded) process.stderr.write(`mantle: ${launcher.load.reason}\n`);
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
