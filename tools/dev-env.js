/* dev-env.js: machine-specific paths for Mantle's TEST and TOOL scripts, read from config instead of
 * being written into the code.
 *
 * WHY: the test harnesses and screenshot tools need a few things that are not part of Mantle itself:
 * playwright-core (to drive a headless Chromium over the pages), an optional CPU-cap module that
 * serialises headless browsers on a small laptop, an ffmpeg/ffprobe for the media fixtures, and a
 * scratch folder for suite status. Where those live differs per machine, so they come from:
 *
 *   1. environment variables (win over the file):
 *        MANTLE_PLAYWRIGHT_CORE   one or more playwright-core folders, separated by ';'
 *        MANTLE_LOWCPU            a module to require before any browser starts (optional)
 *        MANTLE_FFMPEG, MANTLE_FFPROBE
 *        MANTLE_SCRATCH           a folder for suite status files and the on-screen test lock
 *        PLAYWRIGHT_BROWSERS_PATH where playwright's browsers are (playwright's own variable)
 *   2. a JSON file outside the repo: MANTLE_DEV_CONFIG, else ~/.mantle-dev.json, e.g.
 *        { "playwrightCore": ["D:/tools/node_modules/playwright-core"],
 *          "lowcpu": "D:/tools/lowcpu.js", "ffmpeg": "D:/tools/ffmpeg.exe",
 *          "ffprobe": "D:/tools/ffprobe.exe", "scratch": "D:/mantle-scratch" }
 *   3. defaults: playwright-core resolved normally (npm i -D playwright-core), no CPU cap, ffmpeg and
 *      ffprobe from PATH where a caller allows it, no scratch folder, browsers in
 *      %LOCALAPPDATA%\ms-playwright.
 *
 * Nothing here is used by Mantle at run time; only tests and tools/ load it. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

let cached = null;

/** The parsed config file, or {} when there is none. A file that exists but cannot be parsed is an
 *  error, said once, rather than a silent fall back to defaults. */
function config() {
  if (cached) return cached;
  const file = process.env.MANTLE_DEV_CONFIG || path.join(os.homedir(), '.mantle-dev.json');
  cached = {};
  let text = null;
  try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return cached; }
  try { cached = JSON.parse(text.replace(/^\uFEFF/, '')) || {}; } catch (e) {
    throw new Error('dev-env: ' + file + ' is not valid JSON (' + e.message + ')');
  }
  return cached;
}

function list(v) {
  if (!v) return [];
  return (Array.isArray(v) ? v : String(v).split(';')).map((s) => String(s).trim()).filter(Boolean);
}

/** Folders to try for playwright-core, configured ones first. */
function playwrightPaths() {
  return list(process.env.MANTLE_PLAYWRIGHT_CORE).concat(list(config().playwrightCore));
}

/** Everything to try, ending with a normal require('playwright-core'). */
function playwrightCandidates() {
  return playwrightPaths().concat(['playwright-core']);
}

/** The playwright-core module, or a thrown error naming every place that was tried. */
function playwright() {
  const tried = playwrightCandidates();
  for (const c of tried) { try { return require(c); } catch (_) { /* next */ } }
  throw new Error('playwright-core not found. Tried: ' + tried.join(', ') +
    '. Install it (npm i -D playwright-core) or set MANTLE_PLAYWRIGHT_CORE / ~/.mantle-dev.json playwrightCore.');
}

/** Load the configured CPU-cap module, if any. A configured module that fails to load stops the run
 *  (it exists to protect the machine), except on CI where it is never present. */
function lowcpu() {
  const p = process.env.MANTLE_LOWCPU || config().lowcpu;
  if (!p) return null;
  try { return require(p); } catch (e) {
    if (process.env.CI === 'true') return null;
    throw e;
  }
}

/** Where playwright keeps its downloaded browsers. */
function msPlaywrightDir() {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH && process.env.PLAYWRIGHT_BROWSERS_PATH !== '0') return process.env.PLAYWRIGHT_BROWSERS_PATH;
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(local, 'ms-playwright');
}

function ffmpeg() { return process.env.MANTLE_FFMPEG || config().ffmpeg || null; }
function ffprobe() { return process.env.MANTLE_FFPROBE || config().ffprobe || null; }

/** A scratch folder for suite status and the on-screen test lock, or null when none is configured. */
function scratch() { return process.env.MANTLE_SCRATCH || config().scratch || null; }

module.exports = { config, playwright, playwrightPaths, playwrightCandidates, lowcpu, msPlaywrightDir, ffmpeg, ffprobe, scratch };
