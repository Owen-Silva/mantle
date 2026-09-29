'use strict';
/*
 * _files-core.js - the pure half of Mantle Files (lane files, 2026-09-28): paths, the test-mode
 * write guard, undo plans, per-folder views, previews. No Electron, no sidecar, so
 * lib/features/files.test.js proves all of it in plain node.
 *
 * WHY a guard in main AND in the sidecar (sidecar/FilesGuard.cs). Owen's rule: tests never touch
 * his real files. A --test Mantle runs a passive sidecar, which refuses every write outside the
 * sandbox on its own; this file refuses the same writes before they are even asked for, so a bug
 * in one of the two still leaves the other standing. Live (not --test) nothing here refuses:
 * Mantle Files is the real Explorer replacement there.
 */
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const W = path.win32;
const VIRTUAL = ['mantle:home', 'mantle:thispc', 'mantle:recycle', 'mantle:network'];
const KNOWN_LABELS = { desktop: 'Desktop', downloads: 'Downloads', documents: 'Documents', pictures: 'Pictures',
  music: 'Music', videos: 'Videos', onedrive: 'OneDrive', home: 'Home folder', recent: 'Recent' };

const isVirtual = (p) => VIRTUAL.includes(String(p || ''));

/**
 * A typed or given path in Windows' one spelling: backslashes, no doubled separators (a UNC
 * prefix keeps its two), no . or .. segments, "C:" -> "C:\", no trailing backslash except on a
 * root. null for something that is not an absolute Windows path.
 */
function normPath(p) {
  if (p == null) return null;
  let s = String(p).trim();
  if (s.length > 1 && s[0] === '"' && s[s.length - 1] === '"') s = s.slice(1, -1).trim();
  if (!s) return null;
  if (isVirtual(s)) return s;
  s = s.replace(/\//g, '\\');
  if (/^[a-zA-Z]:$/.test(s)) s += '\\';
  const unc = s.startsWith('\\\\');
  if (!unc && !/^[a-zA-Z]:\\/.test(s)) return null;
  if (unc && !/^\\\\[^\\]+\\[^\\]+/.test(s)) return null;      // \\server alone is not a folder
  let n = W.normalize(s);
  if (/^[a-z]:/.test(n)) n = n[0].toUpperCase() + n.slice(1);
  // One spelling per folder: a drive root keeps its backslash (C: alone means "the current folder
  // on C:"), everything else, a share root included, drops it.
  if (n.length > 3 && n.endsWith('\\') && !/^[a-zA-Z]:\\$/.test(n)) n = n.replace(/\\+$/, '');
  return n;
}

/** C:\ or \\server\share (with or without its trailing slash). */
function isRoot(p) {
  const s = String(p || '');
  return /^[a-zA-Z]:\\?$/.test(s) || /^\\\\[^\\]+\\[^\\]+\\?$/.test(s);
}

/** The folder above, or null at a drive root / share root / a virtual location. */
function parentOf(p) {
  const n = normPath(p);
  if (!n || isVirtual(n) || isRoot(n)) return null;
  const up = W.dirname(n);
  return up === n ? null : normPath(up);
}

/** Case-insensitive "is p the root itself or inside it" with a separator boundary. */
function isInside(root, p) {
  const r = normPath(root);
  const n = normPath(p);
  if (!r || !n || isVirtual(r) || isVirtual(n)) return false;
  const a = r.toLowerCase().replace(/\\+$/, '');
  const b = n.toLowerCase();
  return b === a || b.startsWith(a + '\\');
}

/**
 * The address bar's crumbs: [{label, path}], first a virtual parent (This PC for a drive path,
 * Network for a UNC one). `names` maps a lower-cased path to a nicer label (a drive's volume
 * label, a known folder's name).
 */
function crumbs(p, names) {
  const n = normPath(p);
  const nm = names || {};
  if (!n) return [];
  if (n === 'mantle:home') return [{ label: 'Home', path: n }];
  if (n === 'mantle:thispc') return [{ label: 'This PC', path: n }];
  if (n === 'mantle:recycle') return [{ label: 'Recycle Bin', path: n }];
  if (n === 'mantle:network') return [{ label: 'Network', path: n }];
  const out = [];
  let root;
  let rest;
  if (n.startsWith('\\\\')) {
    const m = /^(\\\\[^\\]+\\[^\\]+)\\?(.*)$/.exec(n);
    root = m[1];
    rest = m[2];
    out.push({ label: 'Network', path: 'mantle:network' });
    out.push({ label: nm[root.toLowerCase()] || root.slice(2), path: root });
  } else {
    root = n.slice(0, 3);
    rest = n.slice(3);
    out.push({ label: 'This PC', path: 'mantle:thispc' });
    out.push({ label: nm[root.toLowerCase()] || root.slice(0, 2), path: root });
  }
  let cur = root.endsWith('\\') ? root.slice(0, -1) : root;
  for (const seg of rest.split('\\').filter(Boolean)) {
    cur = cur + '\\' + seg;
    out.push({ label: nm[cur.toLowerCase()] || seg, path: cur });
  }
  return out;
}

/* ---- the test-mode guard ---------------------------------------------------------------------- */

/**
 * MANTLE_FILES_SANDBOX, checked the way sidecar/FilesGuard.cs checks it: absolute, under the
 * temp folder, a path segment named "sandbox", and it exists. `{root}` or `{root:null, why}`.
 */
function sandboxRoot(envValue, tmpdir, exists) {
  if (!envValue) return { root: null, why: 'MANTLE_FILES_SANDBOX is not set, so a test run writes nothing' };
  const r = normPath(envValue);
  if (!r || isVirtual(r)) return { root: null, why: 'MANTLE_FILES_SANDBOX is not an absolute folder path' };
  if (!isInside(tmpdir, r) || normPath(tmpdir).toLowerCase() === r.toLowerCase()) return { root: null, why: 'MANTLE_FILES_SANDBOX must be inside the temp folder' };
  if (!r.toLowerCase().split('\\').includes('sandbox')) return { root: null, why: 'MANTLE_FILES_SANDBOX must have a folder named "sandbox" in its path' };
  if (exists && !exists(r)) return { root: null, why: 'MANTLE_FILES_SANDBOX does not exist' };
  return { root: r };
}

/**
 * May a write touch these paths? Live: yes. Test: only inside the sandbox, by name AND by the
 * real path of the nearest existing ancestor (`realpath`, fs.realpathSync.native in files.js), so
 * a junction inside the sandbox that points out of it is refused too. The reason never names a
 * path (it can reach mantle.log through main's call-log).
 */
function guardWrite(test, sandbox, paths, realpath) {
  if (!test) return { ok: true };
  if (!sandbox || !sandbox.root) return { ok: false, reason: `test mode: writes are refused (${sandbox && sandbox.why ? sandbox.why : 'no sandbox'})` };
  let realRoot = sandbox.root;
  try { if (realpath) realRoot = normPath(realpath(sandbox.root)) || sandbox.root; } catch (_) { /* compare by name only */ }
  for (const raw of paths || []) {
    const p = normPath(raw);
    if (!p || isVirtual(p)) return { ok: false, reason: 'test mode: a write needs real paths inside the files test sandbox' };
    if (!isInside(sandbox.root, p)) return { ok: false, reason: 'test mode: outside the files test sandbox, refused' };
    if (realpath) {
      let probe = p;
      for (;;) {
        let real = null;
        try { real = realpath(probe); } catch (_) { real = null; }
        if (real) {
          if (!isInside(realRoot, real) && !isInside(sandbox.root, real)) return { ok: false, reason: 'test mode: a link inside the sandbox points outside it, refused' };
          break;
        }
        const up = parentOf(probe);
        if (!up) break;
        probe = up;
      }
    }
  }
  return { ok: true };
}

/* ---- undo --------------------------------------------------------------------------------------- */

const UNDO_MAX = 30;
const plural = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`;

/**
 * The inverse of a finished operation, from what actually happened (the sidecar's per-item
 * results, only the ok ones), or null when it cannot be undone (a permanent delete). Labels are
 * name-free on purpose: they are written to mantle.log with the undo.
 *   copy -> recycle the copies        move -> move each back under its old name
 *   rename -> rename back             new folder/file, zip, extract, restore -> recycle what was made
 *   recycle -> restore from the bin by key
 */
function inverseOf(rec) {
  if (!rec || !Array.isArray(rec.results)) return null;
  const ok = rec.results.filter((r) => r && r.ok !== false && !r.skipped);
  if (!ok.length) return null;
  const n = ok.length;
  switch (rec.op) {
    case 'copy': {
      const items = ok.map((r) => r.dst).filter(Boolean);
      return items.length ? { op: 'recycle', items, label: `Undo copy (${plural(items.length, 'item')})` } : null;
    }
    case 'move': {
      const items = ok.filter((r) => r.src && r.dst).map((r) => ({ src: r.dst, dest: W.dirname(normPath(r.src)), name: W.basename(normPath(r.src)) }));
      return items.length ? { op: 'move', items, label: `Undo move (${plural(items.length, 'item')})` } : null;
    }
    case 'rename': {
      if (n > 1) {                                    // rename many: every one back in one job
        const items = ok.filter((r) => r.src && r.dst).map((r) => ({ src: r.dst, name: W.basename(normPath(r.src)) }));
        return items.length ? { op: 'rename', items, label: `Undo rename (${plural(items.length, 'item')})` } : null;
      }
      const r = ok[0];
      return r.src && r.dst ? { op: 'rename', items: [r.dst], name: W.basename(normPath(r.src)), label: 'Undo rename' } : null;
    }
    case 'newfolder': case 'newfile': case 'zip': case 'unzip': case 'restore': {
      const items = ok.map((r) => r.dst).filter(Boolean);
      const what = { newfolder: 'new folder', newfile: 'new file', zip: 'compress', unzip: 'extract', restore: 'restore' }[rec.op];
      return items.length ? { op: 'recycle', items, label: `Undo ${what}${n > 1 ? ` (${plural(n, 'item')})` : ''}` } : null;
    }
    case 'recycle': {
      const keys = ok.map((r) => r.key).filter(Boolean);
      return keys.length ? { op: 'restore', keys, label: `Undo delete (${plural(keys.length, 'item')})` } : null;
    }
    default:
      return null;     // delete, purge, empty: gone for good
  }
}

function createUndoStack(max) {
  const cap = max || UNDO_MAX;
  const list = [];
  return {
    push(rec) { const inv = inverseOf(rec); if (!inv) return null; list.push(inv); while (list.length > cap) list.shift(); return inv; },
    putBack(inv) { if (inv) list.push(inv); while (list.length > cap) list.shift(); },
    peek() { return list.length ? list[list.length - 1] : null; },
    pop() { return list.pop() || null; },
    get size() { return list.length; },
    clear() { list.length = 0; },
  };
}

/* ---- views per folder (a bounded map, oldest dropped first) ------------------------------------- */

const VIEW_KEYS = ['view', 'sort', 'dir', 'group', 'cols', 'size'];
const VIEWS_MAX = 400;
function cleanView(v) {
  const o = {};
  if (!v || typeof v !== 'object') return o;
  if (['details', 'list', 'grid'].includes(v.view)) o.view = v.view;
  if (['name', 'date', 'type', 'size', 'created', 'deleted', 'location'].includes(v.sort)) o.sort = v.sort;
  if (v.dir === 'asc' || v.dir === 'desc') o.dir = v.dir;
  if (['none', 'type', 'date', 'size', 'letter'].includes(v.group)) o.group = v.group;
  if (Array.isArray(v.cols)) o.cols = v.cols.filter((c) => typeof c === 'string').slice(0, 10);
  if (['small', 'medium', 'large'].includes(v.size)) o.size = v.size;
  return o;
}
function putView(views, p, v) {
  const key = String(normPath(p) || p).toLowerCase();
  const out = Object.assign({}, views || {});
  delete out[key];
  out[key] = Object.assign(cleanView(v), { at: Date.now() });
  const keys = Object.keys(out);
  for (let i = 0; i < keys.length - VIEWS_MAX; i++) delete out[keys[i]];
  return out;
}
function getView(views, p) {
  const v = views && views[String(normPath(p) || p).toLowerCase()];
  if (!v) return null;
  const o = cleanView(v);
  return Object.keys(o).length ? o : null;
}

/* ---- previews ----------------------------------------------------------------------------------- */

const EXT_KIND = {};
for (const e of ['png', 'jpg', 'jpeg', 'jfif', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif', 'apng']) EXT_KIND[e] = 'image';
for (const e of ['mp4', 'webm', 'mkv', 'mov', 'm4v', 'ogv']) EXT_KIND[e] = 'video';
for (const e of ['mp3', 'wav', 'ogg', 'oga', 'flac', 'm4a', 'aac', 'opus', 'weba']) EXT_KIND[e] = 'audio';
EXT_KIND.pdf = 'pdf';
for (const e of ['txt', 'md', 'markdown', 'log', 'csv', 'tsv', 'json', 'jsonc', 'json5', 'xml', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'env',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'css', 'scss', 'less', 'html', 'htm', 'vue', 'svelte', 'py', 'rb', 'go', 'rs', 'c', 'h', 'cpp', 'hpp', 'cc',
  'cs', 'java', 'kt', 'swift', 'php', 'sh', 'bash', 'zsh', 'ps1', 'psm1', 'bat', 'cmd', 'sql', 'lua', 'r', 'dart', 'gradle', 'properties',
  'gitignore', 'gitattributes', 'editorconfig', 'dockerfile', 'makefile', 'srt', 'vtt', 'reg', 'nfo', 'tex', 'rst', 'diff', 'patch']) EXT_KIND[e] = 'text';
// Media Chromium cannot play (mkv usually can; avi/wmv never): named so the pane says why.
const NO_PREVIEW = { avi: 'video', wmv: 'video', flv: 'video', wma: 'audio', heic: 'image', heif: 'image', tif: 'image', tiff: 'image', psd: 'image', raw: 'image' };
const TEXT_MAX = 256 * 1024;

function extOf(p) {
  const b = W.basename(String(p || ''));
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(i + 1).toLowerCase() : (b.startsWith('.') ? b.slice(1).toLowerCase() : '');
}
/** 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'sniff' (unknown: look at the bytes) | 'none'. */
function previewKind(p) {
  const e = extOf(p);
  if (EXT_KIND[e]) return EXT_KIND[e];
  if (NO_PREVIEW[e]) return 'none';
  return 'sniff';
}
function noPreviewWhy(p) {
  const e = extOf(p);
  return NO_PREVIEW[e] ? `Mantle cannot preview .${e} ${NO_PREVIEW[e]} files yet; open it in its app` : 'no preview for this kind of file';
}

/** Bytes -> {text} or {binary:true}. BOM-aware; a NUL in the first 8 KB means binary. */
function decodeText(buf) {
  if (!buf || !buf.length) return { text: '', encoding: 'empty' };
  if (buf[0] === 0xFF && buf[1] === 0xFE) return { text: new TextDecoder('utf-16le').decode(buf.subarray(2)), encoding: 'UTF-16 LE' };
  if (buf[0] === 0xFE && buf[1] === 0xFF) return { text: new TextDecoder('utf-16be').decode(buf.subarray(2)), encoding: 'UTF-16 BE' };
  let start = 0;
  let enc = 'UTF-8';
  if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) { start = 3; enc = 'UTF-8 (BOM)'; }
  const head = buf.subarray(start, Math.min(buf.length, start + 8192));
  if (head.includes(0)) return { binary: true };
  return { text: new TextDecoder('utf-8').decode(buf.subarray(start)), encoding: enc };
}

/* ---- small things ------------------------------------------------------------------------------- */

/** "Copy path": each path quoted, one per line (Explorer's Ctrl+Shift+C). */
const quotePaths = (paths) => (paths || []).map((p) => `"${p}"`).join('\r\n');

/** C: or \\server\share, lower-cased: two paths on the same volume move, across volumes copy. */
function volumeOf(p) {
  const n = normPath(p);
  if (!n || isVirtual(n)) return null;
  if (n.startsWith('\\\\')) { const m = /^(\\\\[^\\]+\\[^\\]+)/.exec(n); return m ? m[1].toLowerCase() : null; }
  return n.slice(0, 2).toLowerCase();
}
/** Explorer's drop rule: 'copy' / 'move' as asked; 'auto' = move on the same volume, else copy. */
function dropEffect(effect, paths, dest) {
  if (effect === 'copy' || effect === 'move') return effect;
  const v = volumeOf(dest);
  return (paths || []).every((p) => volumeOf(p) === v) ? 'move' : 'copy';
}
/** Is dest the item itself or inside it (a folder dropped into itself)? */
const intoItself = (paths, dest) => (paths || []).some((p) => isInside(p, dest));

/** The disk-cache name of a thumbnail: the same file at the same size and date is the same image. */
const thumbKey = (p, m, s, px, mode) => crypto.createHash('sha1').update(`${String(p).toLowerCase()}|${m}|${s}|${px}|${mode}`).digest('hex');

const fileUrl = (p) => pathToFileURL(p).href;

/** A name that does not exist yet in `dir`: "x", "x (2)", "x (3)" ... (`exists` is injected). */
function uniqueName(dir, name, exists, isDir) {
  if (!exists(W.join(dir, name))) return name;
  const i = name.lastIndexOf('.');
  const hasExt = i > 0 && !isDir;
  const base = hasExt ? name.slice(0, i) : name;
  const ext = hasExt ? name.slice(i) : '';
  for (let k = 2; k < 1000; k++) {
    const cand = `${base} (${k})${ext}`;
    if (!exists(W.join(dir, cand))) return cand;
  }
  return `${base} (${Date.now()})${ext}`;
}

/** A name Windows accepts for a file or folder, or the reason it does not. */
function badName(name) {
  const s = String(name == null ? '' : name);
  if (!s.trim()) return 'a name cannot be empty';
  if (/[\\/:*?"<>|]/.test(s) || /[\x00-\x1f]/.test(s)) return 'a name cannot contain \\ / : * ? " < > |';
  if (/[. ]$/.test(s)) return 'a name cannot end with a dot or a space';
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i.test(s)) return 'that name is reserved by Windows';
  if (s.length > 255) return 'a name can be at most 255 characters';
  return null;
}

/** Newest first, one entry per path (case-insensitive), at most `max`. */
function mergeRecent(lists, max) {
  const seen = new Set();
  const all = [].concat(...lists.map((l) => l || [])).filter((x) => x && x.path).sort((a, b) => (b.m || 0) - (a.m || 0));
  const out = [];
  for (const x of all) {
    const k = String(x.path).toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
    if (out.length >= (max || 40)) break;
  }
  return out;
}

module.exports = {
  VIRTUAL, KNOWN_LABELS, TEXT_MAX, UNDO_MAX, VIEWS_MAX,
  isVirtual, normPath, isRoot, parentOf, isInside, crumbs,
  sandboxRoot, guardWrite,
  inverseOf, createUndoStack,
  cleanView, putView, getView,
  extOf, previewKind, noPreviewWhy, decodeText,
  quotePaths, volumeOf, dropEffect, intoItself, thumbKey, fileUrl, uniqueName, badName, mergeRecent,
};
