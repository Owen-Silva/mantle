/* quartz-exe.js - which exe IS Owen's browser, Quartz (lane mantle-quartz-exe, 2026-10-10).
 *
 * Quartz runs from ~/browser with Electron's runtime. It used to start as the bare
 * node_modules\electron\dist\electron.exe; since 2026-10-10 that folder also holds Quartz.exe, an
 * rcedit-stamped copy of electron.exe (browser/tools/make-quartz-exe.js) so Task Manager names it.
 * Quartz.exe is gone again right after an Electron update until the generator re-runs, and a Quartz
 * started before the switch keeps running as electron.exe for a while. So:
 *   - STARTING Quartz uses browserExe(): Quartz.exe when it exists, else electron.exe;
 *   - RECOGNISING Quartz (a window, a saved layout entry) uses isBrowserExe(): EITHER path.
 * Only these two paths under the browser folder count: Mantle's own electron.exe (under mantle-live)
 * or any other electron.exe is never Quartz.
 * Plain node, no Electron; `exists` is injectable for tests.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

// Derived, never hard-coded: MANTLE_BROWSER_DIR, else ~/browser.
const BROWSER_DIR = process.env.MANTLE_BROWSER_DIR || path.join(os.homedir(), 'browser');

/** The candidate exes for a browser folder, preferred first: [Quartz.exe, electron.exe]. */
function candidates(dir) {
  const dist = path.join(dir || BROWSER_DIR, 'node_modules', 'electron', 'dist');
  return [path.join(dist, 'Quartz.exe'), path.join(dist, 'electron.exe')];
}

const safeExists = (p) => { try { return fs.existsSync(p); } catch (_) { return false; } };

/** The exe to START Quartz with: the first candidate that exists. When none does, the preferred
 *  one (Quartz.exe), so a caller's own existsSync() check fails and its message names a real path. */
function browserExe(opts) {
  const o = opts || {};
  const exists = o.exists || safeExists;
  const list = candidates(o.dir);
  return list.find((p) => exists(p)) || list[0];
}

const norm = (p) => String(p || '').replace(/\//g, '\\').toLowerCase();

/** Is this exe path Quartz (either candidate, any case or slash style)? */
function isBrowserExe(exe, dir) {
  if (!exe) return false;
  const e = norm(exe);
  return candidates(dir).some((c) => norm(c) === e);
}

module.exports = { BROWSER_DIR, candidates, browserExe, isBrowserExe };
