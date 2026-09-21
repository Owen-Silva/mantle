'use strict';
const fs = require('fs');
const path = require('path');
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
 *   http(s)          -> Owen's OWN browser (~/browser, an Electron app). Windows'
 *                       default-browser setting still points elsewhere and only he
 *                       can change it, so we launch his browser directly instead of
 *                       handing the URL to the shell and getting Opera GX.
 *   scheme:          -> shell.openExternal (ms-settings:, mailto:, steam:, ...)
 *   a path           -> shell.openPath (files and folders)
 *
 * Always resolves {ok, reason?}. A failure to open something is a sentence on
 * screen, never a rejected promise nobody catches.
 */

const BROWSER_DIR = 'C:\\Users\\user\\browser';
const BROWSER_EXE = path.join(BROWSER_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');

function looksLikeUrl(target) {
  return /^https?:\/\//i.test(target);
}

function looksLikeScheme(target) {
  // scheme:rest, but NOT a drive letter (C:\...), which is a path.
  return /^[a-z][a-z0-9+.-]{1,}:/i.test(target) && !/^[a-z]:[\\/]/i.test(target);
}

async function openTarget(target) {
  if (typeof target !== 'string' || !target.trim()) {
    return { ok: false, reason: 'nothing to open: the target was empty' };
  }
  const t = target.trim();
  const shell = electronShell();
  if (!shell) {
    return { ok: false, reason: 'openTarget was called outside Electron, where nothing can be opened' };
  }

  if (looksLikeUrl(t)) {
    if (!fs.existsSync(BROWSER_EXE)) {
      // Rather than quietly falling back to whatever Windows would do, say what
      // is missing -- then try the fallback, and say that too.
      try {
        await shell.openExternal(t);
        return { ok: true, reason: `Owen's browser is not at ${BROWSER_EXE}, so this opened in the Windows default browser` };
      } catch (err) {
        return { ok: false, reason: `Owen's browser is not at ${BROWSER_EXE} and the Windows default browser refused it too: ${err.message}` };
      }
    }
    try {
      const child = spawn(BROWSER_EXE, [BROWSER_DIR, t], {
        detached: true,          // it outlives Mantle; closing the shell must not close his tabs
        windowsHide: true,
        stdio: 'ignore',
      });
      child.unref();
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: `could not start Owen's browser: ${err.message}` };
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

module.exports = { openTarget, BROWSER_EXE, BROWSER_DIR };
