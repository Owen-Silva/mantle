'use strict';
/*
 * wallpaper-lively.js -- reading Lively Wallpaper's files, and Mantle's own wallpaper library on
 * disk. Plain node, no Electron: every function here can be run from a shell against the real
 * folders, which is how the import was checked before any window drew a frame.
 *
 * WHY MANTLE HAS A WALLPAPER LIBRARY AT ALL (2026-09-22). The desktop layer sits in front of the
 * wallpaper, and Lively's mpv player is a SEPARATE window underneath it. Windows cannot show one
 * process's window through another's transparent Electron child window, so Mantle's glass panes
 * covered Owen's video. His decision: "make it so this fully replaces lively so i can add new
 * videos and still have my library of videos i have on lively rn." So the wallpaper now plays
 * INSIDE the desktop page, and this file is how his Lively library becomes Mantle's.
 *
 * THE IMPORT COPIES, it never links. Mantle's library is <userData>/wallpapers/<id>/, one folder
 * per wallpaper, so it survives Lively being uninstalled. Lively's own files are only ever READ.
 * The Lively id (e.g. "jh143p0b.t1j") is kept as Mantle's id, so a folder in either library can
 * be traced to the other by name.
 *
 * WHAT IS READ FROM LIVELY, and what each thing means (enums verified by reflecting
 * Lively.Models.dll 2.2.1.0, not guessed):
 *   Library/SaveData/wptmp/<id>/LivelyInfo.json   a video/gif/picture wallpaper Owen added
 *   Library/wallpapers/<id>/LivelyInfo.json       a web wallpaper (Type 1 web, 2 webaudio)
 *   Library/SaveData/wpdata/<id>/1/LivelyProperties.json   his SAVED customisation values
 *   WallpaperLayout.json   LivelyInfoPath = the wallpaper on screen now (Mantle's default)
 *   Settings.json          the pause rules (AppRules enum: pause=0, ignore=1, kill=2)
 *   AppRules.json          per-app rules [{AppName, Rule}]
 * LivelyProperties.json files are JSONC in the wild (one of Owen's has "//div by 100" in it),
 * which Lively's Newtonsoft reader accepts, so jsonc() below does too.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// Lively.Models.Enums.WallpaperType, verbatim.
const LIVELY_TYPE = { app: 0, web: 1, webaudio: 2, url: 3, bizhawk: 4, unity: 5, godot: 6, video: 7, gif: 8, unityaudio: 9, videostream: 10, picture: 11 };
const RULE_NAME = ['pause', 'ignore', 'kill'];              // AppRules
const SCALER = ['none', 'fill', 'uniform', 'uniformFill', 'auto'];   // WallpaperScaler
const MONITOR_ALGO = ['foreground', 'all', 'gamemode', 'grid'];     // ProcessMonitorAlgorithm

const VIDEO_EXT = new Set(['.mp4', '.m4v', '.webm', '.ogv', '.mov', '.mkv']);
const GIF_EXT = new Set(['.gif']);
const PICTURE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.avif']);

/*
 * The customisable properties of a video, gif or picture wallpaper. Lively ships these as a
 * template for its mpv player; Owen's saved values (speed 0.5 on three of his videos, -20
 * saturation and brightness on the sci-fi planet, "Uniform Fill" on all nine) are read into this
 * shape. Each maps onto the <video>: speed -> playbackRate, the four colour sliders -> a CSS
 * filter, scaler -> object-fit. Gamma has no CSS equivalent and Chromium has no per-element
 * gamma, so it is not offered rather than offered and ignored. Mute is not offered either: the
 * desktop plays every video muted (a wallpaper is not a speaker).
 */
const VIDEO_PROPS = {
  speed: { type: 'slider', text: 'Speed', min: 0.25, max: 5, step: 0.01, value: 1 },
  scaler: { type: 'scalerDropdown', text: 'Fit', items: ['None', 'Stretch', 'Fit', 'Fill'], value: 3,
    help: 'None: actual size. Stretch: fill the screen, ignoring shape. Fit: whole picture, bars if needed. Fill: cover the screen, cropping the edges.' },
  saturation: { type: 'slider', text: 'Saturation', min: -100, max: 100, step: 1, value: 0 },
  hue: { type: 'slider', text: 'Hue', min: -100, max: 100, step: 1, value: 0 },
  brightness: { type: 'slider', text: 'Brightness', min: -100, max: 100, step: 1, value: 0 },
  contrast: { type: 'slider', text: 'Contrast', min: -100, max: 100, step: 1, value: 0 },
};
const STILL_PROPS = { scaler: VIDEO_PROPS.scaler };   // a picture or gif: only the fit means anything

/** JSON with comments and trailing commas, the way Lively's reader takes it. */
function jsonc(text) {
  const raw = String(text);
  const s = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;   // a byte-order mark
  let out = '';
  let i = 0;
  let inStr = false;
  while (i < s.length) {
    const c = s[i];
    if (inStr) {
      out += c;
      if (c === '\\') { out += s[i + 1] || ''; i += 2; continue; }
      if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    if (c === '/' && s[i + 1] === '/') { while (i < s.length && s[i] !== '\n') i++; continue; }
    if (c === '/' && s[i + 1] === '*') { const end = s.indexOf('*/', i + 2); i = end < 0 ? s.length : end + 2; continue; }
    out += c;
    i++;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

function readJsonc(file) {
  return jsonc(fs.readFileSync(file, 'utf8'));
}

/** Where Lively keeps its data, or null. Never throws. */
function livelyRoot() {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const root = path.join(local, 'Lively Wallpaper');
  return fs.existsSync(root) ? root : null;
}

/**
 * Lively's settings, reduced to the rules Mantle carries over -- each with the raw value, what it
 * means, and whether Mantle honours it (and if not, why). The Wallpapers window prints this list,
 * so "carried over" is something Owen can read rather than take on trust.
 */
function readLivelySettings(root) {
  const out = { ok: false, reason: '', raw: {}, rules: [], appRules: [] };
  if (!root) { out.reason = 'Lively Wallpaper is not installed for this user (no %LOCALAPPDATA%\\Lively Wallpaper)'; return out; }
  let s;
  try { s = readJsonc(path.join(root, 'Settings.json')); } catch (err) {
    out.reason = `Lively's Settings.json could not be read: ${err.message}`;
    return out;
  }
  const pick = ['AppFocusPause', 'AppFullscreenPause', 'BatteryPause', 'RemoteDesktopPause', 'PowerSaveModePause',
    'DisplayPauseSettings', 'ProcessMonitorAlgorithm', 'ProcessTimerInterval', 'ScalerVideo', 'ScalerGif',
    'VideoPlayerHwAccel', 'InputForward', 'AudioVolumeGlobal', 'AudioOnlyOnDesktop', 'ProcessMonitorGridTileCoverageThreshold'];
  for (const k of pick) if (k in s) out.raw[k] = s[k];
  try {
    const rules = readJsonc(path.join(root, 'AppRules.json'));
    if (Array.isArray(rules)) {
      out.appRules = rules
        .filter((r) => r && typeof r.AppName === 'string' && r.AppName)
        .map((r) => ({ app: r.AppName, rule: RULE_NAME[r.Rule] || 'pause' }));
    }
  } catch (_) { /* no AppRules.json is the same as an empty one */ }
  out.ok = true;
  return out;
}

/** The Lively rule values, normalised to 'pause' | 'ignore' | 'kill', with Lively's own defaults. */
function playbackRules(settings) {
  const raw = (settings && settings.raw) || {};
  const rule = (k, dflt) => (typeof raw[k] === 'number' && RULE_NAME[raw[k]]) || dflt;
  return {
    fullscreen: rule('AppFullscreenPause', 'pause'),
    focus: rule('AppFocusPause', 'ignore'),
    battery: rule('BatteryPause', 'ignore'),
    remote: rule('RemoteDesktopPause', 'pause'),
    powerSave: rule('PowerSaveModePause', 'ignore'),
    algorithm: MONITOR_ALGO[raw.ProcessMonitorAlgorithm] || 'foreground',
    inputForward: raw.InputForward === undefined ? 1 : raw.InputForward,
    scalerVideo: SCALER[raw.ScalerVideo] || 'fill',
    appRules: (settings && settings.appRules) || [],
    from: settings && settings.ok ? 'lively' : 'defaults',
  };
}

/** Which wallpaper Lively has on screen now: its folder, or null with a reason. */
function readLivelyCurrent(root) {
  if (!root) return { dir: null, reason: 'no Lively install' };
  try {
    const layout = readJsonc(path.join(root, 'WallpaperLayout.json'));
    const first = Array.isArray(layout) ? layout.find((l) => l && l.LivelyInfoPath) : null;
    if (!first) return { dir: null, reason: 'WallpaperLayout.json names no wallpaper' };
    return { dir: first.LivelyInfoPath, id: path.basename(first.LivelyInfoPath).toLowerCase(), reason: '' };
  } catch (err) {
    return { dir: null, reason: `WallpaperLayout.json could not be read: ${err.message}` };
  }
}

/** Every wallpaper in Lively's library, each with {livelyId, dir, info} or {livelyId, dir, error}. */
function listLivelyLibrary(root) {
  const found = [];
  if (!root) return found;
  const lib = path.join(root, 'Library');
  for (const sub of [path.join('SaveData', 'wptmp'), 'wallpapers']) {
    const base = path.join(lib, sub);
    let names = [];
    try { names = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch (_) { continue; }
    for (const name of names) {
      const dir = path.join(base, name);
      const entry = { livelyId: name.toLowerCase(), dir };
      try { entry.info = readJsonc(path.join(dir, 'LivelyInfo.json')); } catch (err) {
        entry.error = fs.existsSync(path.join(dir, 'LivelyInfo.json'))
          ? `its LivelyInfo.json could not be read: ${err.message}`
          : 'the folder has no LivelyInfo.json, so Lively itself could not have loaded it';
      }
      found.push(entry);
    }
  }
  return found;
}

/** Lively's saved values for one wallpaper: {name: value}, or {} if it never saved any. */
function readSavedValues(root, livelyId) {
  if (!root) return {};
  const file = path.join(root, 'Library', 'SaveData', 'wpdata', livelyId, '1', 'LivelyProperties.json');
  try {
    const j = readJsonc(file);
    const out = {};
    for (const k of Object.keys(j)) if (j[k] && typeof j[k] === 'object' && 'value' in j[k]) out[k] = j[k].value;
    return out;
  } catch (_) {
    return {};
  }
}

/** Mantle's type name for a Lively type number, or null with the reason it is not supported. */
function typeFromLively(n) {
  if (n === LIVELY_TYPE.video) return { type: 'video' };
  if (n === LIVELY_TYPE.gif) return { type: 'gif' };
  if (n === LIVELY_TYPE.picture) return { type: 'picture' };
  if (n === LIVELY_TYPE.web || n === LIVELY_TYPE.webaudio) return { type: 'web' };
  const name = Object.keys(LIVELY_TYPE).find((k) => LIVELY_TYPE[k] === n) || `type ${n}`;
  return { type: null, reason: `a Lively "${name}" wallpaper (an external program or stream), which only Lively can run` };
}

function typeFromExt(file) {
  const ext = path.extname(file).toLowerCase();
  if (VIDEO_EXT.has(ext)) return 'video';
  if (GIF_EXT.has(ext)) return 'gif';
  if (PICTURE_EXT.has(ext)) return 'picture';
  return null;
}

/** The property definitions a wallpaper offers, merged with its saved values. Never throws. */
function propsFor(item, itemDir) {
  let defs = null;
  let reason = '';
  if (item.type === 'web') {
    const f = path.join(itemDir, 'LivelyProperties.json');
    if (fs.existsSync(f)) {
      try { defs = readJsonc(f); } catch (err) { reason = `its LivelyProperties.json could not be read: ${err.message}`; }
    }
  } else if (item.type === 'video') {
    defs = JSON.parse(JSON.stringify(VIDEO_PROPS));
  } else {
    defs = JSON.parse(JSON.stringify(STILL_PROPS));
  }
  if (!defs) return { defs: {}, values: {}, reason };
  const values = {};
  for (const k of Object.keys(defs)) {
    const d = defs[k];
    if (!d || typeof d !== 'object') { delete defs[k]; continue; }
    const saved = item.values && Object.prototype.hasOwnProperty.call(item.values, k) ? item.values[k] : undefined;
    values[k] = saved !== undefined ? saved : d.value;
  }
  return { defs, values, reason };
}

/**
 * The list a web wallpaper gets at load: [name, value] in Lively's order and Lively's shapes.
 * Labels have no value and buttons are actions, so neither is sent (Lively skips them too). A
 * folderDropdown value is sent as "<folder>/<file>", the relative path the wallpaper loads.
 */
function sendableProps(defs, values) {
  const list = [];
  for (const k of Object.keys(defs)) {
    const d = defs[k];
    if (!d || d.type === 'label' || d.type === 'button') continue;
    let v = values[k];
    if (v === undefined) continue;
    if (d.type === 'folderDropdown') {
      if (!v) continue;
      v = `${String(d.folder || '').replace(/\\/g, '/').replace(/\/+$/, '')}/${v}`;
    }
    list.push([k, v]);
  }
  return list;
}

/** Files a folderDropdown can choose from. */
function folderOptions(itemDir, def) {
  const dir = path.join(itemDir, String(def.folder || ''));
  if (!isInside(itemDir, dir)) return [];
  const pats = String(def.filter || '*.*').split('|').map((p) => p.trim().toLowerCase().replace(/^\*/, '')).filter(Boolean);
  try {
    return fs.readdirSync(dir).filter((f) => pats.includes('.*') || pats.some((p) => f.toLowerCase().endsWith(p))).sort();
  } catch (_) {
    return [];
  }
}

function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function newId() {
  return 'm' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
}

/* ---- Mantle's library on disk ------------------------------------------ */

class Library {
  constructor(dir) {
    this.dir = dir;                              // <userData>/wallpapers
    this.file = path.join(dir, 'library.json');
    this.data = null;
  }

  load() {
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!this.data || !Array.isArray(this.data.items)) throw new Error('it has no items list');
      this.loadError = '';
    } catch (err) {
      // A missing file is a first run. A BROKEN one is kept aside, not overwritten, so whatever
      // was in it can still be recovered by hand -- and the reason is shown, not swallowed.
      if (fs.existsSync(this.file)) {
        const aside = `${this.file}.broken-${Date.now()}`;
        try { fs.renameSync(this.file, aside); } catch (_) { /* leave it where it is */ }
        this.loadError = `library.json could not be read (${err.message}); it was moved aside to ${path.basename(aside)} and the library rebuilt`;
      } else {
        this.loadError = '';
      }
      this.data = { version: 1, selected: null, items: [], removed: [], lively: null };
    }
    if (!Array.isArray(this.data.removed)) this.data.removed = [];
    return this.data;
  }

  save() {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);   // never a half-written library.json
  }

  itemDir(id) { return path.join(this.dir, id); }
  get(id) { return this.data.items.find((i) => i.id === id) || null; }

  /**
   * Is this item playable from disk right now? {ok, reason}. Checked at every load and every
   * listing, because a file can vanish between the two and "it just shows black" is not allowed.
   */
  health(item) {
    if (!item) return { ok: false, reason: 'no such wallpaper in the library' };
    if (!item.type) return { ok: false, reason: item.unsupported || 'Mantle cannot play this kind of wallpaper' };
    const dir = this.itemDir(item.id);
    if (!fs.existsSync(dir)) return { ok: false, reason: `its folder is gone from the library (${dir})` };
    const entry = path.join(dir, item.entry || '');
    if (!item.entry || !fs.existsSync(entry)) return { ok: false, reason: `its file is missing: ${item.entry || '(none recorded)'} in ${dir}` };
    if (item.error) return { ok: false, reason: item.error };
    return { ok: true, reason: '' };
  }
}

/**
 * Copy ONE Lively wallpaper into Mantle's library. Resolves the report line for it:
 *   {livelyId, title, ok, reason, item?}
 * A wallpaper Mantle cannot play (an app, a stream) is still reported, as not imported, with why.
 */
/**
 * A readable name for a wallpaper whose Lively title is just its download's file slug.
 * Owen's library had "portal-to-another-dimension-moewalls-com-ezgif.com-resize-video1920-1080"
 * next to hand-typed titles like "Earth From Space" (2026-09-22). Only a slug is touched --
 * anything with a space in it was typed by a person and is kept exactly, typos included.
 *   "void-hole-moewalls-com-ezgif.com-resize-video1920-1080" -> "Void hole"
 */
function tidyTitle(raw) {
  const s = String(raw || '').trim();
  if (!s || /\s/.test(s) || !/[-_]/.test(s)) return s;
  const cut = s
    .replace(/[-_]?moewalls[-_.]com.*$/i, '')          // the site credit and everything after it
    .replace(/[-_]?ezgif[-_.]com.*$/i, '')             // the converter's credit
    .replace(/[-_]?(resize[-_]?)?(video)?\d{3,4}[-_x]\d{3,4}$/i, '')   // "video1920-1080", "1920x1080"
    .replace(/[-_]+/g, ' ')
    .trim();
  if (!cut) return s;
  return cut.charAt(0).toUpperCase() + cut.slice(1);
}

async function importOne(lib, root, entry, origin) {
  const title = tidyTitle(entry.info && entry.info.Title ? String(entry.info.Title) : entry.livelyId);
  const base = { livelyId: entry.livelyId, title };
  if (entry.error) return Object.assign(base, { ok: false, reason: entry.error });
  const info = entry.info;
  const t = typeFromLively(info.Type);
  if (!t.type) return Object.assign(base, { ok: false, reason: `not imported: it is ${t.reason}` });
  if (info.IsAbsolutePath && info.FileName && path.isAbsolute(info.FileName)) {
    // Lively can point at a file outside its library. Copy that file in, so the import still
    // stands alone once Lively is gone.
    if (!fs.existsSync(info.FileName)) return Object.assign(base, { ok: false, reason: `its file ${info.FileName} no longer exists` });
  }
  const src = entry.dir;
  const dst = lib.itemDir(entry.livelyId);
  const fileName = info.FileName ? String(info.FileName) : '';
  const entryAbs = path.isAbsolute(fileName) ? fileName : path.join(src, fileName);
  if (!fileName || !fs.existsSync(entryAbs)) {
    return Object.assign(base, { ok: false, reason: `its ${t.type === 'web' ? 'page' : 'file'} "${fileName || '(none named)'}" is missing from ${src}` });
  }
  try {
    await fsp.mkdir(dst, { recursive: true });
    await fsp.cp(src, dst, { recursive: true, force: true, errorOnExist: false });
    let entryName = path.isAbsolute(fileName) ? path.basename(fileName) : fileName;
    if (path.isAbsolute(fileName)) await fsp.copyFile(fileName, path.join(dst, entryName));
    // Normalise to forward slashes: it becomes part of a URL.
    entryName = entryName.split(path.sep).join('/');
    const thumb = info.Thumbnail && fs.existsSync(path.join(dst, info.Thumbnail)) ? String(info.Thumbnail) : null;
    const preview = info.Preview && fs.existsSync(path.join(dst, info.Preview)) ? String(info.Preview) : null;
    const item = {
      id: entry.livelyId,
      title,
      type: t.type,
      entry: entryName,
      thumb,
      preview,
      desc: info.Desc || '',
      author: info.Author || '',
      args: info.Arguments || '',
      values: readSavedValues(root, entry.livelyId),
      origin: origin || { from: 'lively', livelyId: entry.livelyId, path: src },
      addedAt: new Date().toISOString(),
    };
    return Object.assign(base, { ok: true, reason: thumb ? 'copied' : 'copied; no thumbnail yet, one is made from the video when the Wallpapers window opens', item });
  } catch (err) {
    return Object.assign(base, { ok: false, reason: `copying ${src} failed: ${err.message}` });
  }
}

/**
 * Import Owen's Lively library. `force` re-imports wallpapers he removed from Mantle; otherwise a
 * removed one stays removed (deleting it and having it come back on the next start would be a
 * bug). Items already in the library are left exactly as they are, customisation included.
 * `onProgress(done, total, line)` fires per wallpaper. The CURRENT Lively wallpaper goes first,
 * so the desktop can start playing it while the rest copy.
 */
async function importLively(lib, { force = false, onProgress } = {}) {
  const root = livelyRoot();
  const report = { at: new Date().toISOString(), root, ok: false, reason: '', lines: [], current: null };
  if (!root) { report.reason = 'Lively Wallpaper is not installed for this user, so there was nothing to import'; return report; }
  const current = readLivelyCurrent(root);
  report.current = current.id || null;
  const all = listLivelyLibrary(root);
  if (!all.length) { report.reason = `Lively's library at ${path.join(root, 'Library')} has no wallpapers in it`; return report; }
  all.sort((a, b) => (b.livelyId === current.id) - (a.livelyId === current.id));
  let done = 0;
  for (const entry of all) {
    let line;
    if (lib.get(entry.livelyId)) {
      line = { livelyId: entry.livelyId, title: (lib.get(entry.livelyId) || {}).title || entry.livelyId, ok: true, reason: 'already in the library; left as it is' };
    } else if (!force && lib.data.removed.includes(entry.livelyId)) {
      line = { livelyId: entry.livelyId, title: (entry.info && entry.info.Title) || entry.livelyId, ok: true, skipped: true, reason: 'you removed it from Mantle, so it was not copied again' };
    } else {
      line = await importOne(lib, root, entry);
      if (line.item) {
        lib.data.items.push(line.item);
        lib.data.removed = lib.data.removed.filter((r) => r !== entry.livelyId);
        if (!lib.data.selected && current.id === entry.livelyId) lib.data.selected = entry.livelyId;
        lib.save();   // per wallpaper: a crash mid-import keeps everything already copied
        delete line.item;
      }
    }
    report.lines.push(line);
    done++;
    if (onProgress) { try { onProgress(done, all.length, line); } catch (_) { /* a progress hook never stops an import */ } }
  }
  if (!lib.data.selected) {
    const first = lib.data.items.find((i) => lib.health(i).ok);
    if (first) lib.data.selected = first.id;
  }
  const failed = report.lines.filter((l) => !l.ok);
  report.ok = failed.length === 0;
  report.reason = failed.length
    ? `${failed.length} of ${all.length} could not be imported`
    : `${report.lines.filter((l) => l.ok && !l.skipped).length} of ${all.length} in the library`;
  lib.data.lively = { importedAt: report.at, root, current: report.current, report };
  lib.save();
  return report;
}

module.exports = {
  jsonc, readJsonc, livelyRoot, readLivelySettings, playbackRules, readLivelyCurrent, listLivelyLibrary,
  readSavedValues, typeFromLively, typeFromExt, propsFor, importOne, sendableProps, folderOptions, isInside, newId,
  importLively, Library, VIDEO_EXT, GIF_EXT, PICTURE_EXT, LIVELY_TYPE, tidyTitle,
};
