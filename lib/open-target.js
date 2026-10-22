'use strict';
const fs = require('fs');
const path = require('path');
const QUARTZ = require('./quartz-exe');
const { spawn } = require('child_process');

/*
 * electron is required lazily, and only when this module is actually running
 * inside Electron. Plain `node` resolving 'electron' gets the npm package's
 * index.js, which prints a path -- and on a machine where the postinstall never
 * ran it kicks off the installer. A unit test that loads this file must not do
 * either, so the require happens at call time, behind the version check.
 */
function electronShell() {
  if (!process.versions.electron) return null;
  return require('electron').shell;
}

/*
 * Opening things. One entry point for the bar, the launcher and the desktop.
 *
 * Three different destinations, because they really are different:
 *   http(s)          -> a browser checked out at ~/browser (an Electron app such as
 *                       Quartz; MANTLE_BROWSER_DIR moves it) when that folder exists,
 *                       launched directly so links reach it even when Windows'
 *                       default-browser setting points elsewhere. No such folder =
 *                       the Windows default browser, with nothing to report.
 *   scheme:          -> shell.openExternal (ms-settings:, mailto:, steam:, ...)
 *   a path           -> shell.openPath (files and folders)
 *
 * Always resolves {ok, reason?}. A failure to open something is a sentence on
 * screen, never a rejected promise nobody catches.
 */

const BROWSER_DIR = QUARTZ.BROWSER_DIR;
// Quartz.exe when it exists, else the bare electron.exe (lib/quartz-exe.js); resolved per open, since an
// Electron update removes Quartz.exe until its generator re-runs. BROWSER_EXE is the pick at load.
let browserExists = (p) => { try { return fs.existsSync(p); } catch (_) { return false; } };   // tests swap this
const browserExe = () => QUARTZ.browserExe({ dir: BROWSER_DIR, exists: browserExists });
const BROWSER_EXE = browserExe();

function looksLikeUrl(target) {
  return /^https?:\/\//i.test(target);
}

function looksLikeScheme(target) {
  // scheme:rest, but NOT a drive letter (C:\...), which is a path.
  return /^[a-z][a-z0-9+.-]{1,}:/i.test(target) && !/^[a-z]:[\\/]/i.test(target);
}

/*
 * What is refused before anything reaches the shell (core-lib quality pass, 2026-09-29). main.js's
 * 'open' command already filters what a page may pass; this is the floor under EVERY caller
 * (lib/features/downloads.js, and whatever comes next), for targets no Mantle surface means:
 *   script schemes   javascript:, vbscript:, data: -- code, not a place
 *   file: URLs       run an .exe through the browser road; a real file is opened by its path
 *   exploit handlers ms-msdt: (Follina), search-ms: / search: (remote search folders), and the
 *                    Office / installer / setup handlers used to start code from a link
 *   network paths    \\server\share or //server/share: opening one sends the Windows sign-in hash
 *                    to whoever runs that server; \\?\ and \\.\ device paths go the same way
 *   control chars    a newline or NUL splits an argument
 * Tested: lib/open-target.test.js.
 */
const OPEN_MAX = 8192;
const NEVER_SCHEMES = new Set(['ms-msdt', 'search-ms', 'search', 'ms-officecmd', 'ms-appinstaller', 'ms-cxh', 'ms-cxh-full',
  'ms-word', 'ms-excel', 'ms-powerpoint', 'ms-access', 'ms-publisher', 'ms-visio', 'ms-project', 'ms-infopath', 'ms-spd',
  'ms-its', 'mk', 'its', 'hcp', 'ms-help', 'shell', 'vscode-insiders', 'jar']);

/** null when `target` may be opened, else the plain-words reason it is not. PURE. */
function refuseReason(target) {
  if (typeof target !== 'string') return 'nothing to open: the address was not text';
  const t = target.trim();
  if (!t) return 'nothing to open: the target was empty';
  if (t.length > OPEN_MAX) return 'that address is too long to open';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(t)) return 'that address has a control character in it (a line break or similar), so Mantle did not open it';
  const scheme = (/^([a-z][a-z0-9+.-]*):/i.exec(t) || [])[1];
  if (scheme && !/^[a-z]:[\\/]/i.test(t)) {
    const s = scheme.toLowerCase();
    if (s === 'javascript' || s === 'vbscript' || s === 'data') return `a ${s}: address is a script, not a place, so Mantle did not open it`;
    if (s === 'file') return 'a file: address can start a program, so Mantle opens files by their path instead and did not open this one';
    if (NEVER_SCHEMES.has(s)) return `Mantle never opens ${s}: links: they can start programs or reach other computers`;
    return null;
  }
  if (/^[\\/]{2}/.test(t)) return 'that is a network location (\\\\server\\share) or a device path; Mantle does not open those from here, since Windows would send your sign-in to that computer';
  return null;
}

async function openTarget(target) {
  const refused = refuseReason(target);
  if (refused) return { ok: false, reason: refused };
  const t = target.trim();
  const shell = electronShell();
  if (!shell) {
    return { ok: false, reason: 'openTarget was called outside Electron, where nothing can be opened' };
  }

  if (looksLikeUrl(t)) {
    const bexe = browserExe();
    if (!browserExists(BROWSER_DIR)) {
      // No browser folder on this machine: the Windows default browser is the plain answer.
      try {
        await shell.openExternal(t);
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: `the Windows default browser refused it: ${err.message}` };
      }
    }
    if (!browserExists(bexe)) {
      // Rather than quietly falling back to whatever Windows would do, say what
      // is missing -- then try the fallback, and say that too.
      try {
        await shell.openExternal(t);
        return { ok: true, reason: `the browser is not at ${bexe}, so this opened in the Windows default browser` };
      } catch (err) {
        return { ok: false, reason: `the browser is not at ${bexe} and the Windows default browser refused it too: ${err.message}` };
      }
    }
    try {
      const child = spawn(bexe, [BROWSER_DIR, t], {
        detached: true,          // it outlives Mantle; closing the shell must not close their tabs
        windowsHide: true,
        stdio: 'ignore',
      });
      child.unref();
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: `could not start the browser: ${err.message}` };
    }
  }

  if (looksLikeScheme(t)) {
    try {
      await shell.openExternal(t);
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: `Windows would not handle "${t}": ${err.message}` };
    }
  }

  // A filesystem path. openPath answers with '' on success and a message on failure.
  try {
    const msg = await shell.openPath(t);
    if (msg) return { ok: false, reason: `could not open ${t}: ${msg}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `could not open ${t}: ${err.message}` };
  }
}

module.exports = { openTarget, refuseReason, BROWSER_EXE, BROWSER_DIR, browserExe,
  _setBrowserExistsForTest(fn) { const was = browserExists; browserExists = fn; return was; } };
