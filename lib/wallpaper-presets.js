'use strict';
/*
 * wallpaper-presets.js -- Mantle's built-in wallpapers (lane mantle-bg-presets, 2026-10-09).
 *
 * The user: "can you also make it so that mantle can have the same backrounds preset as quartz and
 * helm". assets/backgrounds/ holds Helm's 23 Unsplash photos, a 400 px thumb of each in thumbs/,
 * Helm's catalog.json ([{file, title, category, credit, url}]) unchanged, and CREDITS.md. Quartz
 * ships the same folder, so a photo added to one app's catalog drops into the others by copying it.
 *
 * WHAT THIS FILE IS: the catalog, read and checked against the disk, nothing else. lib/wallpaper.js
 * owns the pick: a preset is chosen through the same wallpaper.set as the user's own wallpapers and
 * saved in the same library.json `selected`, so it survives a restart like any other pick. Nothing
 * is copied into his library (<userData>/wallpapers/): the photos stay in the app folder and are
 * listed apart from his own items, so the 23 of them never bury his Lively library.
 *
 * IDS: "builtin:" + the file name without its extension ("builtin:forest" for forest.jpg). The
 * colon is the point: a library id must be a plain folder name (safeId in wallpaper-lively.js, no
 * colon), so a preset id can never be mistaken for one of his wallpapers, never reaches a
 * library-only command (remove, props, the mantle-wp:// protocol) and never names a folder. The id
 * comes from the file name, not the position in the catalog, so reordering or adding photos keeps
 * every saved pick pointing at the same photo.
 *
 * NO SILENT FAILURES: a catalog that is missing or unreadable is {ok:false, reason}; a photo whose
 * file is gone or empty is listed with health {ok:false, reason} (its card says why, and picking it
 * is refused with that reason); a missing thumb falls back to the full photo and says so (note);
 * damaged catalog lines are left out and counted in the listing's note. Reasons are plain words.
 */

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const PREFIX = 'builtin:';
/** A catalog file name Mantle turns into a URL: one plain name with a picture extension. */
const FILE_RE = /^[a-z0-9][a-z0-9._-]*\.(?:jpe?g|png|webp)$/i;
const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const OTHER = 'Other';

/** The folder in an app tree (the dev repo or mantle-live). */
function dirFor(root) { return path.join(root, 'assets', 'backgrounds'); }

/** "forest.jpg" -> "builtin:forest". */
function idOf(file) { return PREFIX + String(file).replace(/\.[^.]+$/, '').toLowerCase(); }

/** Is this a preset id (it may still be one the catalog no longer has)? */
function isPresetId(id) { return typeof id === 'string' && id.startsWith(PREFIX) && SLUG_RE.test(id.slice(PREFIX.length)); }

/** {ok, reason} for one file on disk: there, a file, and not empty. */
function fileState(abs, name) {
  let st;
  try { st = fs.statSync(abs); } catch (_) { return { ok: false, reason: `its photo "${name}" is missing from Mantle's built-in wallpapers folder` }; }
  if (!st.isFile()) return { ok: false, reason: `its photo "${name}" is not a file` };
  if (!st.size) return { ok: false, reason: `its photo "${name}" is empty` };
  return { ok: true, reason: '' };
}

/**
 * The catalog, checked against the disk. Never throws.
 *   {ok, reason, note, dir, categories: [name], items: [{id, file, title, category, credit,
 *    creditUrl, abs, thumbAbs, preset: true, type: 'picture'}]}
 * categories keep the catalog's order of first appearance (Mountains first, as Helm shows them).
 */
function load(dir) {
  const out = { ok: false, reason: '', note: '', dir, categories: [], items: [] };
  let list;
  try {
    list = JSON.parse(fs.readFileSync(path.join(dir, 'catalog.json'), 'utf8'));
  } catch (err) {
    out.reason = err && err.code === 'ENOENT'
      ? 'the list of built-in wallpapers (catalog.json) is missing from this copy of Mantle'
      : `the list of built-in wallpapers could not be read (${String((err && err.message) || err).slice(0, 160)})`;
    return out;
  }
  if (!Array.isArray(list)) { out.reason = 'the list of built-in wallpapers is damaged: it is not a list'; return out; }
  const seen = new Set();
  let damaged = 0;
  let twice = 0;
  for (const x of list) {
    if (!x || typeof x.file !== 'string' || !FILE_RE.test(x.file)) { damaged++; continue; }
    const id = idOf(x.file);
    if (!isPresetId(id)) { damaged++; continue; }
    if (seen.has(id)) { twice++; continue; }
    seen.add(id);
    const category = x.category ? String(x.category).slice(0, 40) : OTHER;
    if (!out.categories.includes(category)) out.categories.push(category);
    const thumbAbs = path.join(dir, 'thumbs', x.file);
    out.items.push({
      id,
      file: x.file,
      title: String(x.title || x.file.replace(/\.[^.]+$/, '')).slice(0, 120),
      category,
      credit: x.credit ? String(x.credit).slice(0, 120) : '',
      creditUrl: /^https:\/\/[^\s"'<>]+$/.test(x.url || '') ? x.url : '',
      abs: path.join(dir, x.file),
      thumbAbs,
      preset: true,
      type: 'picture',
    });
  }
  const notes = [];
  if (damaged) notes.push(`${damaged} line${damaged === 1 ? ' was' : 's were'} damaged and left out`);
  if (twice) notes.push(`${twice} photo${twice === 1 ? ' was' : 's were'} listed twice and shown once`);
  out.note = notes.length ? `In the list of built-in wallpapers, ${notes.join(' and ')}.` : '';
  out.ok = true;
  if (!out.items.length) { out.ok = false; out.reason = 'the list of built-in wallpapers has no usable photos in it'; }
  return out;
}

/**
 * The preset for an id, or a stand-in that says why it is not there (a pick saved before the photo
 * was taken out of the catalog must not just show black). null when the id is not a preset id.
 */
function find(cat, id) {
  if (!isPresetId(id)) return null;
  const it = cat && cat.items.find((x) => x.id === id);
  if (it) return it;
  const slug = id.slice(PREFIX.length);
  return {
    id, file: '', title: slug.charAt(0).toUpperCase() + slug.slice(1).replace(/[-_.]+/g, ' '),
    category: OTHER, credit: '', creditUrl: '', abs: '', thumbAbs: '', preset: true, type: 'picture',
    gone: cat && !cat.ok
      ? `Mantle's built-in wallpapers cannot be read: ${cat.reason}`
      : 'it is no longer one of Mantle\'s built-in wallpapers. Pick another one',
  };
}

/** Is this preset's photo usable right now? {ok, reason}. Read at every listing, like the library's. */
function health(item) {
  if (!item) return { ok: false, reason: 'no such built-in wallpaper' };
  if (item.gone) return { ok: false, reason: item.gone };
  return fileState(item.abs, item.file);
}

/** The small picture for a card: the thumb, or the full photo with a note when the thumb is gone. */
function thumbOf(item) {
  if (!item || item.gone) return { url: null, note: '' };
  if (fileState(item.thumbAbs, item.file).ok) return { url: pathToFileURL(item.thumbAbs).href, note: '' };
  if (fileState(item.abs, item.file).ok) return { url: pathToFileURL(item.abs).href, note: 'Its small preview is missing, so the full photo is shown instead.' };
  return { url: null, note: '' };
}

/**
 * A random usable preset in `category` (all of them when empty or 'All'), never `notId` unless it
 * is the only one. null when none is usable, with nothing picked.
 */
function shuffle(cat, category, notId, rand) {
  const r = typeof rand === 'function' ? rand : Math.random;
  const usable = (cat ? cat.items : []).filter((x) => health(x).ok);
  const inCat = category && category !== 'All' ? usable.filter((x) => x.category === category) : usable;
  let pool = inCat.filter((x) => x.id !== notId);
  if (!pool.length) pool = inCat;
  if (!pool.length) return null;
  return pool[Math.min(pool.length - 1, Math.floor(r() * pool.length))];
}

module.exports = { PREFIX, dirFor, idOf, isPresetId, load, find, health, thumbOf, shuffle };
