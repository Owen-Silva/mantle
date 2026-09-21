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
 *   --test                  test mode: sidecar runs --passive, three plain windows,
 *                           nothing on the real shell is touched.
 *   --profile-name=<x>      REQUIRED with --test. userData goes to
 *                           %TEMP%\mantle-test-<x>, which also keys Electron's
 *                           single-instance lock, so a test instance can never
 *                           block (or be blocked by) the live shell. tools/toback.ps1
 *                           matches on this exact flag text.
 *   --screenshot=<dir>      test mode only: capture the three windows, then quit.
 *   --bar-edge=top|bottom   which screen edge the bar sits on (default bottom).
 *   --no-desktop            do not create the wallpaper-layer desktop window.
 */

/** Flags that are fatal to get wrong. We refuse to boot rather than guess. */
class ArgError extends Error {}

function parseArgs(argv) {
  const flags = {
    test: false,
    profileName: null,
    screenshot: null,
    barEdge: 'bottom',
    desktop: true,
  };

  for (const raw of argv) {
    if (typeof raw !== 'string' || !raw.startsWith('--')) continue;
    const eq = raw.indexOf('=');
    const name = eq === -1 ? raw.slice(2) : raw.slice(2, eq);
    const value = eq === -1 ? '' : raw.slice(eq + 1);

    switch (name) {
      case 'test':
        flags.test = true;
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
      default:
        // Electron and Chromium add their own switches (--user-data-dir, and in
        // a packaged run a pile of others). Anything we do not recognise is
        // simply not ours; ignoring it is correct, not a silent failure.
        break;
    }
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
