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
 *   --flyout=<app>          test mode only: open the bar's window flyout (live previews)
 *                           for the first running app whose name or exe contains <app>,
 *                           with the test bar kept at the BACK of the z-order; with
 *                           --screenshot=<dir> it captures the flyout instead of the
 *                           three windows, then quits.
 *   --bar-edge=top|bottom   which screen edge the bar sits on (default bottom).
 *   --no-desktop            do not create the wallpaper-layer desktop window.
 *   --no-acrylic            no Windows 11 acrylic on the bar and launcher: the
 *                           old transparent windows with lane C's CSS glass only.
 *   --theme=dark|light|system  test mode only: Mantle's appearance for THIS instance over the
 *                           saved setting (lib/theme.js), which it never reads for the mode
 *                           or writes. theme.set still switches it live until it quits.
 *   --first-run             test mode only: this test profile judges the first-start welcome
 *                           (lib/welcome.js) exactly as the live shell does. Without it a --test
 *                           run never shows the welcome and never writes its flag, so every other
 *                           test harness boots as before.
 *   --open=wallpapers       ask a RUNNING instance to open one of its own windows (lane
 *                           looksync-open, 2026-10-10: Quartz and Helm's "Open Mantle
 *                           Wallpapers" button). Like --quit it is a message, never an
 *                           instance: if no Mantle answers, the process exits 3 having
 *                           created nothing. The value is matched against OPEN_TARGETS
 *                           (allow-list, case-insensitive); anything else is refused by
 *                           the running instance in one log line. Nothing from argv is
 *                           ever opened, loaded or run as a path or URL.
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
    flyout: null,
    barEdge: 'bottom',
    desktop: true,
    acrylic: true,
    theme: null,
    open: null,
    firstRun: false,
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
      case 'flyout':
        flags.flyout = value;
        break;
      case 'bar-edge':
        if (value !== 'top' && value !== 'bottom') {
          throw new ArgError(`--bar-edge must be "top" or "bottom", got "${value}"`);
        }
        flags.barEdge = value;
        break;
      case 'open':
        // Kept raw here (the allow-list is openRequest's job), so the RUNNING instance is the one
        // that refuses an unknown value and its log says so.
        flags.open = value;
        break;
      case 'first-run':
        flags.firstRun = true;
        break;
      case 'no-desktop':
        flags.desktop = false;
        break;
      case 'no-acrylic':
        flags.acrylic = false;
        break;
      case 'theme':
        if (value !== 'dark' && value !== 'light' && value !== 'system') {
          throw new ArgError(`--theme must be "dark", "light" or "system", got "${value.slice(0, 40)}"`);
        }
        flags.theme = value;
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
  // --open is the same kind of message. With --live it would read as "start the shell AND open",
  // and a launcher that got the flags wrong must never be the thing that takes the shell over.
  if (flags.open !== null && flags.live) {
    throw new ArgError('--open only asks a running Mantle to open a window; it cannot be combined with --live (run it without --live)');
  }
  if (flags.open !== null && flags.quit) {
    throw new ArgError('--open and --quit ask a running Mantle for opposite things; pick one');
  }

  // A test instance without a profile name would write into the LIVE userData
  // directory and take the live single-instance lock. Refuse, loudly.
  if (flags.test && !flags.profileName) {
    throw new ArgError('--test requires --profile-name=<x> (it keys the userData dir and the single-instance lock; without it a test run would collide with the live shell)');
  }
  // core-lib (2026-09-29): the name becomes a folder (%TEMP%\mantle-test-<x>) and the text
  // kill-test.ps1 / toback.ps1 match on, so "..\" or a slash could put a TEST run's data next to the
  // live shell's, and a space or quote broke the match. Letters, digits, - _ . only (lib/args.test.js).
  if (flags.profileName !== null && flags.profileName !== ''
    && (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(flags.profileName) || flags.profileName.includes('..'))) {
    throw new ArgError(`--profile-name must be letters, digits, "-", "_" or "." (up to 64, starting with a letter or digit), not "${flags.profileName.slice(0, 70)}": it becomes a folder name`);
  }
  // A screenshot run outside test mode would photograph the real shell and then
  // quit it out from under whoever is using it.
  if (flags.screenshot !== null && !flags.test) {
    throw new ArgError('--screenshot only works with --test (it quits the app when it is done, which would take the live shell down with it)');
  }
  // The flyout hook drives the bar without a mouse; on the live shell that is a bar opening
  // itself over whatever Owen is doing.
  if (flags.flyout !== null && !flags.test) {
    throw new ArgError('--flyout only works with --test (it opens the bar\'s flyout by itself, which the live shell must never do)');
  }
  // The live shell's appearance is Owen's pick in Mantle Settings; a flag on the logon task that
  // quietly overrode it would be a setting he could not change from Settings.
  if (flags.theme !== null && !flags.test) {
    throw new ArgError('--theme only works with --test (the live shell takes its appearance from Mantle Settings > Personalization > Colors)');
  }
  // The live shell judges its first start from its own profile (lib/welcome.js); a flag on the logon
  // task must never be able to put the welcome in front of a profile that has been used.
  if (flags.firstRun && !flags.test) {
    throw new ArgError('--first-run only works with --test (the live shell decides from its own profile whether this is its first start)');
  }
  if (flags.screenshot === '') {
    throw new ArgError('--screenshot needs a directory: --screenshot=<dir>');
  }

  return flags;
}

/*
 * --open=<target>: what a second start may ask the running Mantle to open. An ALLOW-LIST of names,
 * never a path or a URL: Quartz and Helm launch Mantle with this, and anything that can start a
 * process with arguments must not be able to make the shell load something of its choosing.
 */
const OPEN_TARGETS = ['wallpapers'];
const OPEN_LABELS = { wallpapers: 'Wallpapers' };

/**
 * Pure: read a (second instance's) argv for --open=<x>.
 *   null                                  no --open at all
 *   { ok: true,  target, label, line }    an allowed target; line is what the running instance logs
 *   { ok: false, value, line }            refused; line is the one plain log line saying so
 * The last --open wins, as with every other flag. Non-string entries are skipped.
 */
function openRequest(argv) {
  if (!Array.isArray(argv)) return null;
  let value = null;
  for (const a of argv) {
    if (typeof a !== 'string') continue;
    if (a === '--open') value = '';
    else if (a.startsWith('--open=')) value = a.slice('--open='.length);
  }
  if (value === null) return null;
  const target = value.trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(OPEN_LABELS, target) && OPEN_TARGETS.includes(target)) {
    return { ok: true, target, label: OPEN_LABELS[target], line: `mantle: opened ${OPEN_LABELS[target]} for a second start (--open=${target})` };
  }
  // JSON.stringify quotes it and escapes newlines/control characters, so the value cannot forge
  // extra log lines; the slice keeps a megabyte of argv out of the log.
  const shown = JSON.stringify(value.length > 60 ? value.slice(0, 60) + '...' : value);
  return { ok: false, value, line: `mantle: a second start asked to open ${shown}, which is not something Mantle opens from outside (allowed: ${OPEN_TARGETS.join(', ')})` };
}

/** Pure: the one stderr line for a start with --open when no Mantle answered. */
function openNotRunningLine(req) {
  if (req && req.ok) return `Mantle is not running, so its ${req.label} could not be opened`;
  const why = req ? ` (and ${JSON.stringify(String(req.value).slice(0, 60))} is not something Mantle opens from outside; allowed: ${OPEN_TARGETS.join(', ')})` : '';
  return `Mantle is not running, so nothing could be opened${why}`;
}

module.exports = { parseArgs, ArgError, openRequest, openNotRunningLine, OPEN_TARGETS };
