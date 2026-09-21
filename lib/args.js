'use strict';
/*
 * Command line flags for Mantle.
 *
 * WHY a module of its own: the flags decide whether this process is allowed to
 * touch Windows at all (hide the taskbar, install the hook, reparent the desktop).
 * That decision has to be made once, in one obvious place, before anything else
 * runs -- not re-derived from argv in five different files where one of them
 * could get it wrong and start mutating the shell during a test run.
 *
 * Flags:
 *   --live                  REQUIRED to run live. Without it (and without --test)
 *                           Mantle prints how to run it and exits 2 having touched
 *                           nothing. See the WHY below.
 *   --test                  test mode: sidecar runs --passive, three plain windows,
 *                           nothing on the real shell is touched.
 *   --quit                  ask a RUNNING instance to put Windows back and exit.
 *                           Creates no window, spawns no sidecar, changes nothing
 *                           itself. Alone it talks to the live instance; with
 *                           --test --profile-name=<x> it talks to that test one.
 *   --profile-name=<x>      REQUIRED with --test. userData goes to
 *                           %TEMP%\mantle-test-<x>, which also keys Electron's
 *                           single-instance lock, so a test instance can never
 *                           block (or be blocked by) the live shell. tools/toback.ps1
 *                           matches on this exact flag text.
 *   --screenshot=<dir>      test mode only: capture the three windows, then quit.
 *   --bar-edge=top|bottom   which screen edge the bar sits on (default bottom).
 *   --no-desktop            do not create the wallpaper-layer desktop window.
 *   --no-acrylic            no Windows 11 acrylic on the bar and launcher: the
 *                           old transparent windows with lane C's CSS glass only.
 *
 * WHY --live exists (2026-09-21):
 * `electron .` used to mean "live" -- so a bare `electron .` typed to check that
 * the app still boots would reach into Owen's shell. On the first live run that
 * cost him a REBOOT in the middle of his work. Live mode now has to be asked
 * for by name. `npm start` deliberately stays `electron .`, i.e. the safe refusal;
 * `npm run live` is the one that means it.
 */

/** Flags that are fatal to get wrong. We refuse to boot rather than guess. */
class ArgError extends Error {}

function parseArgs(argv) {
  const flags = {
    live: false,
    test: false,
    quit: false,
    profileName: null,
    screenshot: null,
    barEdge: 'bottom',
    desktop: true,
    acrylic: true,
  };

  for (const raw of argv) {
    if (typeof raw !== 'string' || !raw.startsWith('--')) continue;
    const eq = raw.indexOf('=');
    const name = eq === -1 ? raw.slice(2) : raw.slice(2, eq);
    const value = eq === -1 ? '' : raw.slice(eq + 1);

    switch (name) {
      case 'live':
        flags.live = true;
        break;
      case 'test':
        flags.test = true;
        break;
      case 'quit':
        flags.quit = true;
        break;
      case 'profile-name':
        flags.profileName = value;
        break;
      case 'screenshot':
        flags.screenshot = value;
        break;
      case 'bar-edge':
        if (value !== 'top' && value !== 'bottom') {
          throw new ArgError(`--bar-edge must be "top" or "bottom", got "${value}"`);
        }
        flags.barEdge = value;
        break;
      case 'no-desktop':
        flags.desktop = false;
        break;
      case 'no-acrylic':
        flags.acrylic = false;
        break;
      default:
        // Electron and Chromium add their own switches (--user-data-dir, and in
        // a packaged run a pile of others). Anything we do not recognise is
        // simply not ours; ignoring it is correct, not a silent failure.
        break;
    }
  }

  // --live and --test mean opposite things about whether Windows may be touched.
  // Guessing which one wins is exactly the kind of decision that ends in a reboot.
  if (flags.live && flags.test) {
    throw new ArgError('--live and --test are opposites: --live changes the Windows shell, --test promises not to. Pick one.');
  }
  // --quit is a message to another process; it must not also be trying to BE one.
  // It MAY be combined with --test --profile-name=<x>, which does not make it an
  // instance -- it only says which single-instance lock to knock on, so a test
  // run can be stopped by script the same way the live one can. That is also the
  // only way the handshake can be exercised without starting live mode.
  if (flags.quit && flags.live) {
    throw new ArgError('--quit only asks a running Mantle to stop; it cannot be combined with --live');
  }

  // A test instance without a profile name would write into the LIVE userData
  // directory and take the live single-instance lock. Refuse, loudly.
  if (flags.test && !flags.profileName) {
    throw new ArgError('--test requires --profile-name=<x> (it keys the userData dir and the single-instance lock; without it a test run would collide with the live shell)');
  }
  // A screenshot run outside test mode would photograph the real shell and then
  // quit it out from under whoever is using it.
  if (flags.screenshot !== null && !flags.test) {
    throw new ArgError('--screenshot only works with --test (it quits the app when it is done, which would take the live shell down with it)');
  }
  if (flags.screenshot === '') {
    throw new ArgError('--screenshot needs a directory: --screenshot=<dir>');
  }

  return flags;
}

module.exports = { parseArgs, ArgError };
