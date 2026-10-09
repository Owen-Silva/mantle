'use strict';
/*
 * theme.js - Mantle's OWN light / dark appearance (lane dm-core, 2026-10-08).
 *
 * Owen: "we need to make a dark mode for mantle. everything should still be glass ui like btw", then a
 * setting of Light / Dark / Match Windows, DEFAULT Match Windows ("but then there needs to be a way to
 * manually change it in settings"). This module is the one place that decides which theme Mantle shows.
 *
 *   mode   what Owen picked: 'system' (Match Windows, the default), 'light' or 'dark'. Saved in
 *          <userData>/theme.json as { "mode": ... }, written whole (tmp + rename) like switcher.json.
 *   theme  what Mantle shows now: 'light' | 'dark'. mode, or Windows' APP mode when mode is 'system'
 *          (HKCU\...\Themes\Personalize AppsUseLightTheme, which Electron's nativeTheme follows; main.js
 *          hands it in as windowsMode() and calls windowsChanged() on nativeTheme 'updated').
 *
 * HOW A PAGE GETS IT: preload.js asks main once, synchronously, as it starts (mantle:theme-now) and puts
 * <html data-theme="dark|light"> on the page before its first paint; every change after that is the
 * `theme` event, which preload.js applies live (no reload) and then fires `mantle-theme` on window.
 * The CSS is ui/shared/glass-light.css :root[data-theme="dark"].
 *
 * --theme=dark|light|system (a --test run only, lib/args.js) pins the mode for that instance: the
 * saved file is neither read for the mode nor ever written, and theme.set changes it until it quits.
 *
 * NOTHING FAILS SILENTLY: a theme.json that cannot be used is moved aside as theme.json.unreadable and
 * the reason stays in view().note (Mantle Settings shows it on the row); a save that fails still
 * applies the pick now and says it will not survive a restart; Windows' mode, when it cannot be
 * read, is null with windowsWhy, and Match Windows then shows light (Mantle's original look) and says so.
 */
const fs = require('fs');
const path = require('path');

const MODES = ['system', 'light', 'dark'];
const DEFAULT_MODE = 'system';
const FILE_MAX = 64 * 1024;
const MODE_WORDS = { system: 'Match Windows', light: 'Light', dark: 'Dark' };

function words(err) { return err && err.message ? err.message : String(err); }
function isMode(v) { return typeof v === 'string' && MODES.includes(v); }

/** The plain-words refusal for anything that is not a mode. Never repeats more than 40 characters of it. */
function badMode(v) {
  const shown = typeof v === 'string' ? `"${v.slice(0, 40)}"` : v === undefined || v === null ? 'nothing' : `a ${Array.isArray(v) ? 'list' : typeof v}`;
  return `Mantle's appearance can be "light", "dark" or "system" (Match Windows); it was sent ${shown}`;
}

/** mode + Windows' app mode ('dark' | 'light' | null) -> the theme Mantle shows. Unknown Windows = light. */
function resolve(mode, windows) {
  if (mode === 'light' || mode === 'dark') return mode;
  return windows === 'dark' ? 'dark' : 'light';
}

/**
 * createTheme({ file, windowsMode, override, test, log }) -> {
 *   get()            the view: { ok, mode, theme, windows, windowsWhy, pinned, note, reason }
 *   theme()          'dark' | 'light' (what preload.js paints)
 *   set(mode)        -> view + { value } | { ok:false, reason }; tells on() listeners
 *   windowsChanged() re-read Windows' mode; tells on() listeners when the view moved. -> bool (moved)
 *   on(fn)           fn(view) after every set and every Windows change that moved something. -> off()
 * }
 *   windowsMode() -> { mode: 'dark'|'light'|null, why: string|null }   (main.js: nativeTheme)
 *   override      'system'|'light'|'dark'|null   (--theme; already validated by lib/args.js)
 */
function createTheme(opts) {
  const o = opts || {};
  const log = typeof o.log === 'function' ? o.log : () => {};
  const file = typeof o.file === 'string' && o.file ? o.file : null;
  const override = isMode(o.override) ? o.override : null;
  const listeners = new Set();
  let loadNote = null;      // why the saved file was not used (stays on the row until a save works)
  let saveNote = null;      // why the last pick could not be saved

  function readWindows() {
    let r;
    try { r = typeof o.windowsMode === 'function' ? o.windowsMode() : { mode: null, why: 'Mantle was given no way to read Windows\' mode' }; } catch (err) {
      r = { mode: null, why: `Windows' mode could not be read (${words(err)})` };
    }
    const mode = r && (r.mode === 'dark' || r.mode === 'light') ? r.mode : null;
    return { mode, why: mode ? null : (r && typeof r.why === 'string' && r.why) || 'Windows did not say whether apps are light or dark' };
  }

  function load() {
    if (!file) return DEFAULT_MODE;
    let why = null;
    try {
      const st = fs.statSync(file);
      if (!st.isFile()) why = 'is not a file';
      else if (st.size > FILE_MAX) why = `is ${st.size} bytes, far more than a mode`;
      else {
        let v;
        try { v = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e instanceof SyntaxError) v = SyntaxError; else throw e; }
        if (v === SyntaxError) why = 'is not valid JSON';
        else if (!v || typeof v !== 'object' || Array.isArray(v)) why = 'does not hold a setting (not a JSON object)';
        else if (v.mode === undefined) return DEFAULT_MODE;
        else if (!isMode(v.mode)) why = `says ${badMode(v.mode).replace(/^.* it was sent /, '')}, which is not a mode`;
        else return v.mode;
      }
    } catch (e) {
      if (e && e.code === 'ENOENT') return DEFAULT_MODE;
      why = `could not be read (${e && e.code ? e.code : words(e)})`;
    }
    const name = path.basename(file);
    let kept = null;
    const aside = fs.existsSync(`${file}.unreadable`) ? `${file}.unreadable-${Date.now()}` : `${file}.unreadable`;
    try { fs.renameSync(file, aside); kept = path.basename(aside); } catch (_) { /* said below */ }
    loadNote = `The saved appearance was not used: ${name} ${why}; ${kept ? `kept as ${kept}, so ` : ''}Mantle is back to Match Windows`;
    log(`theme: ${loadNote}`);    // the file NAME only, never the path (privacy)
    return DEFAULT_MODE;
  }

  function save(mode) {
    if (!file) return 'Mantle has nowhere to save it';
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(`${file}.tmp`, JSON.stringify({ mode }, null, 2));
      fs.renameSync(`${file}.tmp`, file);
      return null;
    } catch (err) {
      return err && err.code ? err.code : words(err);
    }
  }

  let mode = override || load();
  let win = readWindows();
  let current = resolve(mode, win.mode);

  function view() {
    return {
      ok: true,
      mode,
      theme: current,
      windows: win.mode,
      windowsWhy: win.mode ? null : `${win.why}${mode === 'system' ? ', so Match Windows shows light' : ''}`,
      pinned: override ? `This test run was started with --theme=${override}, so a change here lasts until it quits and is never saved` : null,
      note: saveNote || loadNote,
      reason: null,
    };
  }
  function tell() {
    const v = view();
    for (const fn of Array.from(listeners)) {
      try { fn(view()); } catch (err) { log(`theme: a listener threw: ${words(err)}`); }
    }
    return v;
  }

  return {
    get: view,
    theme: () => current,
    mode: () => mode,
    set(m) {
      const want = m && typeof m === 'object' && !Array.isArray(m) ? m.mode : m;
      if (!isMode(want)) return { ok: false, reason: badMode(want) };
      const was = current;
      const wasMode = mode;
      mode = want;
      win = readWindows();
      current = resolve(mode, win.mode);
      if (!override) {
        const err = save(mode);
        saveNote = err ? `${MODE_WORDS[mode]} is on now, but it could not be saved (${err}), so Mantle goes back to the last saved appearance at its next start` : null;
        if (err) log(`theme: ${saveNote}`);
        else loadNote = null;   // a good save replaces the file the note was about
      }
      // every pick that moved something gets a line (a mode change that keeps the same look too)
      if (was !== current || wasMode !== mode) log(`theme: ${MODE_WORDS[mode]} -> Mantle is ${current}`);
      return Object.assign(tell(), { value: mode });
    },
    windowsChanged() {
      const before = `${win.mode}|${win.why}|${current}`;
      win = readWindows();
      current = resolve(mode, win.mode);
      if (`${win.mode}|${win.why}|${current}` === before) return false;
      log(`theme: Windows apps are ${win.mode || 'unknown'} now${mode === 'system' ? `, so Mantle is ${current}` : ` (Mantle stays ${current}: it is set to ${MODE_WORDS[mode]})`}`);
      tell();
      return true;
    },
    on(fn) {
      if (typeof fn !== 'function') throw new Error('theme.on needs a function');
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

/**
 * Windows' APP mode from Electron's nativeTheme. It follows AppsUseLightTheme only while nothing in
 * Mantle has set nativeTheme.themeSource (nothing does: lib/features/settings.js sets one window's frame
 * through the sidecar instead, on purpose); if something ever does, this says so instead of lying.
 */
function windowsModeFrom(nativeTheme) {
  if (!nativeTheme) return { mode: null, why: 'Electron\'s nativeTheme is not available' };
  if (nativeTheme.themeSource && nativeTheme.themeSource !== 'system') {
    return { mode: null, why: `Mantle's Electron is set to ${nativeTheme.themeSource}, so it cannot see Windows' own mode` };
  }
  return { mode: nativeTheme.shouldUseDarkColors ? 'dark' : 'light', why: null };
}

module.exports = { createTheme, resolve, badMode, isMode, windowsModeFrom, MODES, DEFAULT_MODE, MODE_WORDS };
