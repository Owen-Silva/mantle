'use strict';
/*
 * lib/run-line.js - what a line typed in the launcher's Run mode (Win+R) means (lane keysrun, 2026-10-15).
 *
 * Windows' Run box takes: environment variables (%appdata%, %temp%), folder and file paths, shell:
 * folders, URLs and other protocols, a program on PATH or in App Paths, a program with arguments,
 * and Ctrl+Shift+Enter for "as administrator". It parses the line and hands the parts to
 * ShellExecuteEx. This file is that parse, PURE but for the `stat` it is given:
 *
 *   plan(line, deps) -> Promise of ONE of
 *     { kind: 'empty' }
 *     { kind: 'folder', path, shown }          open in Mantle Files (Explorer when Files is off)
 *     { kind: 'url', url }                     http(s) / www.: the launcher's URL road (Quartz)
 *     { kind: 'settings', uri }                ms-settings: -> Mantle Settings where it claims the page
 *     { kind: 'exec', file, params }           ShellExecuteEx(lpFile = file, lpParameters = params)
 *
 * SAFETY: nothing here (or downstream) builds a command line for a shell. `file` and `params` are
 * kept apart and go to ShellExecuteEx as they are, which is exactly what the Run box does: the typed
 * arguments reach the program verbatim, and no cmd.exe / PowerShell ever reads them unless the
 * program you typed IS cmd or powershell. Control characters are refused (a pasted line break).
 *
 * deps: { env (process.env-like), profile (the working folder: the user's profile, as the Run box),
 *         stat(path) -> Promise<'dir' | 'file' | null>, known: { downloads, documents, ... } }
 */
const path = require('path');

const MAX_LINE = 8192;

/** %NAME% -> its value, as ExpandEnvironmentStrings: names are case-blind, an unknown %NAME% stays
 *  as typed, and its closing % may open the next name ("%nope%appdata%" keeps "%nope" and expands the rest). */
function expandEnv(s, env) {
  const src = String(s == null ? '' : s);
  const e = env || {};
  const lower = {};
  for (const k of Object.keys(e)) if (lower[k.toLowerCase()] === undefined) lower[k.toLowerCase()] = e[k];
  let out = '';
  let i = 0;
  while (i < src.length) {
    const a = src.indexOf('%', i);
    if (a < 0) { out += src.slice(i); break; }
    const b = src.indexOf('%', a + 1);
    if (b < 0) { out += src.slice(i); break; }
    out += src.slice(i, a);
    const name = src.slice(a + 1, b);
    const v = name ? lower[name.toLowerCase()] : undefined;
    if (typeof v === 'string') { out += v; i = b + 1; } else { out += src.slice(a, b); i = b; }
  }
  return out;
}

/* shell: names that are plain folders, so they can open in Mantle Files. Anything else (shell:AppsFolder,
   shell:RecycleBinFolder, shell:::{CLSID}) is a virtual folder: Windows' own road (ShellExecuteEx). */
function shellFolders(env, known) {
  const e = (k) => (env && typeof env[k] === 'string' && env[k]) || null;
  const j = (base, ...rest) => (base ? path.win32.join(base, ...rest) : null);
  const k = known || {};
  const roam = e('APPDATA');
  const win = e('SystemRoot') || e('SYSTEMROOT') || e('windir');
  return {
    appdata: roam,
    'local appdata': e('LOCALAPPDATA'),
    localappdata: e('LOCALAPPDATA'),
    profile: e('USERPROFILE'),
    startup: j(roam, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'),
    programs: j(roam, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    'start menu': j(roam, 'Microsoft', 'Windows', 'Start Menu'),
    sendto: j(roam, 'Microsoft', 'Windows', 'SendTo'),
    recent: j(roam, 'Microsoft', 'Windows', 'Recent'),
    templates: j(roam, 'Microsoft', 'Windows', 'Templates'),
    'common startup': j(e('ProgramData') || e('PROGRAMDATA'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'StartUp'),
    'common programs': j(e('ProgramData') || e('PROGRAMDATA'), 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    programfiles: e('ProgramFiles') || e('PROGRAMFILES'),
    programfilesx86: e('ProgramFiles(x86)') || e('PROGRAMFILES(X86)'),
    windows: win,
    system: j(win, 'System32'),
    // the redirectable ones come from Windows' own known-folder answer (Electron app.getPath), never guessed
    downloads: k.downloads || null,
    personal: k.documents || null,
    documents: k.documents || null,
    desktop: k.desktop || null,
    'my pictures': k.pictures || null,
    'my music': k.music || null,
    'my video': k.videos || null,
  };
}

/** A shell: line -> the plain folder it names (with any \sub\path after it), or null (virtual: Windows'). */
function shellFolder(line, env, known) {
  const m = /^shell:([^\\/]+)([\\/].*)?$/i.exec(String(line).trim());
  if (!m) return null;
  const base = shellFolders(env, known)[m[1].trim().toLowerCase()];
  if (!base) return null;
  return m[2] ? path.win32.join(base, m[2]) : base;
}

/** "a b" c -> { file: 'a b', params: 'c' }; a b c -> { file: 'a', params: 'b c' }. Params keep their
 *  own quotes and spacing (they go to the program verbatim); only the gap after the file is dropped. */
function splitFirst(s) {
  const t = String(s).replace(/^\s+/, '');
  if (t[0] === '"') {
    const close = t.indexOf('"', 1);
    if (close < 0) return { file: t.slice(1).trim(), params: '', quoted: true };
    return { file: t.slice(1, close), params: t.slice(close + 1).replace(/^\s+/, ''), quoted: true };
  }
  const sp = t.search(/\s/);
  if (sp < 0) return { file: t, params: '', quoted: false };
  return { file: t.slice(0, sp), params: t.slice(sp).replace(/^\s+/, ''), quoted: false };
}

/** Unquoted "C:\Program Files\App\app.exe -x": every split at a space, LONGEST file first. */
function splits(s) {
  const t = String(s).trim();
  const out = [{ file: t, params: '' }];
  for (let i = t.lastIndexOf(' '); i > 0; i = t.lastIndexOf(' ', i - 1)) {
    const file = t.slice(0, i).trimEnd();
    if (file && !out.some((o) => o.file === file)) out.push({ file, params: t.slice(i).replace(/^\s+/, '') });
  }
  return out;
}

const looksLikePath = (s) => /^([a-zA-Z]:|\\\\|\\|\.{1,2}([\\/]|$))/.test(s) || /[\\/]/.test(s);
const URL_RE = /^(https?|ftp):\/\/\S/i;
const WWW_RE = /^www\.[^\s/\\]+\.[^\s\\]*$/i;
const SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]+):/;     // 2+ letters, so "C:\..." is a drive, not a scheme

function problem(line) {
  if (typeof line !== 'string') return 'Type a program, folder, document or website.';
  if (line.length > MAX_LINE) return 'That line is too long to run.';
  if (/[\x00-\x08\x0a-\x1f]/.test(line)) return 'That line has a line break in it. Run one command at a time.';
  return null;
}

/**
 * The line -> what to do with it (the header). Never throws; a refusal is { kind: 'bad', reason }.
 */
async function plan(line, deps) {
  const d = deps || {};
  const bad = problem(line);
  if (bad) return { kind: 'bad', reason: bad };
  const trimmed = line.trim();
  if (!trimmed) return { kind: 'empty' };
  const env = d.env || {};
  let x = expandEnv(trimmed, env);
  if (/^[a-zA-Z]:$/.test(x)) x += '\\';          // "C:" is the drive's root, not the folder you were last in on it
  const stat = typeof d.stat === 'function' ? d.stat : async () => null;
  const profile = d.profile || env.USERPROFILE || null;
  const statSafe = async (p) => { try { return await stat(p); } catch (_) { return null; } };
  const abs = (p) => (path.win32.isAbsolute(p) && !/^\\(?!\\)/.test(p) ? p : profile ? path.win32.resolve(profile, p) : null);

  if (URL_RE.test(x)) return { kind: 'url', url: x };
  if (WWW_RE.test(x)) return { kind: 'url', url: 'http://' + x };
  if (/^ms-settings:/i.test(x)) return { kind: 'settings', uri: x.split(/\s/)[0] };
  if (/^shell:/i.test(x)) {
    const f = shellFolder(x, env, d.known);
    if (f && await statSafe(f) === 'dir') return { kind: 'folder', path: f, shown: trimmed };
    return { kind: 'exec', file: x, params: '' };          // virtual folders: Windows' own road (Explorer)
  }
  const scheme = SCHEME_RE.exec(x);
  if (scheme && !/\s/.test(x.slice(0, scheme[0].length))) return { kind: 'exec', file: x, params: '' };   // mailto:, steam://, spotify:

  // The whole line names something (a folder with spaces, "Documents" in the profile, ".")
  const unq = x.length > 1 && x[0] === '"' && x[x.length - 1] === '"' && x.indexOf('"', 1) === x.length - 1 ? x.slice(1, -1) : x;
  const whole = abs(unq);
  if (whole) {
    const s = await statSafe(whole);
    if (s === 'dir') return { kind: 'folder', path: whole, shown: trimmed };
    if (s === 'file' && looksLikePath(unq)) return { kind: 'exec', file: whole, params: '' };
  }

  const first = splitFirst(x);
  if (!first.file) return { kind: 'bad', reason: 'Type a program, folder, document or website.' };
  // An unquoted path with spaces: the longest prefix that exists is the program, the rest its arguments
  if (!first.quoted && looksLikePath(first.file) && /\s/.test(x)) {
    for (const c of splits(x)) {
      const p = abs(c.file);
      if (!p) continue;
      const s = await statSafe(p);
      if (s === 'file') return { kind: 'exec', file: p, params: c.params };
      if (s === 'dir' && !c.params) return { kind: 'folder', path: p, shown: trimmed };
    }
  }
  if (looksLikePath(first.file)) {
    const p = abs(first.file);
    if (p && !first.params && await statSafe(p) === 'dir') return { kind: 'folder', path: p, shown: trimmed };
    return { kind: 'exec', file: p || first.file, params: first.params };
  }
  return { kind: 'exec', file: first.file, params: first.params };
}

/* ---- words for what Windows answered ---------------------------------------------------- */

const CODE_WORDS = {
  2: (f) => `Windows can't find "${f}". Check the spelling, then try again.`,
  3: (f) => `Windows can't find "${f}". Check the spelling, then try again.`,
  5: (f) => `Windows refused to open "${f}": you don't have permission.`,
  8: () => 'Windows ran out of memory starting it. Close something, then try again.',
  193: (f) => `"${f}" isn't a program Windows can run.`,
  216: (f) => `"${f}" isn't a program Windows can run.`,
  225: (f) => `Windows Security blocked "${f}" as unsafe.`,
  740: (f) => `"${f}" needs administrator rights. Press Ctrl+Shift+Enter to run it as administrator.`,
  1155: (f) => `No app is set to open "${f}".`,
  1156: (f) => `The app for "${f}" didn't answer Windows. Try again.`,
  1223: (f, admin) => (admin ? `You said no to the administrator prompt, so "${f}" didn't run.` : `Opening "${f}" was cancelled.`),
  1260: (f) => `A Windows policy on this PC blocks "${f}".`,
};

/** A run.exec outcome {ok, code, message} -> null (it ran) or one plain sentence. */
function words(outcome, file, admin) {
  if (outcome && outcome.ok) return null;
  const f = shortName(file);
  const code = outcome && Number(outcome.code);
  if (code && CODE_WORDS[code]) return CODE_WORDS[code](f, !!admin);
  const m = outcome && typeof outcome.message === 'string' ? outcome.message.trim().replace(/\.$/, '') : '';
  return m ? `Windows couldn't open "${f}": ${m.charAt(0).toLowerCase() + m.slice(1)}.` : `Windows couldn't open "${f}".`;
}
function shortName(file) {
  const f = String(file == null ? '' : file);
  return f.length > 80 ? f.slice(0, 38) + '…' + f.slice(-38) : f;
}

/* ---- history ---------------------------------------------------------------------------- */

const HISTORY_MAX = 50;
const same = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

/** Mantle's own first (newest first), then Windows' RunMRU entries Mantle has not got. */
function mergeHistory(own, mru) {
  const out = [];
  for (const list of [own, mru]) {
    for (const v of Array.isArray(list) ? list : []) {
      if (typeof v !== 'string' || !v.trim() || problem(v)) continue;
      if (!out.some((o) => same(o, v))) out.push(v.trim());
      if (out.length >= HISTORY_MAX) return out;
    }
  }
  return out;
}

/** A line that ran -> the new own list (it first, no case-blind repeat, capped). */
function remember(own, line) {
  const v = String(line == null ? '' : line).trim();
  const list = Array.isArray(own) ? own.filter((o) => typeof o === 'string' && !same(o, v)) : [];
  if (!v || problem(v)) return list.slice(0, HISTORY_MAX);
  return [v].concat(list).slice(0, HISTORY_MAX);
}

/** What the history offers for `typed`: starts-with first, then contains; all of it for nothing typed. */
function complete(history, typed, max) {
  const n = max || 8;
  const list = Array.isArray(history) ? history : [];
  const q = String(typed == null ? '' : typed).trim().toLowerCase();
  if (!q) return list.slice(0, n);
  const starts = list.filter((h) => h.toLowerCase().startsWith(q));
  const has = list.filter((h) => !h.toLowerCase().startsWith(q) && h.toLowerCase().includes(q));
  return starts.concat(has).slice(0, n);
}

/**
 * Folder completion, as the Run box's drop-down: "%appdata%\.mine" -> the entries of %APPDATA%
 * starting with ".mine", written the way you typed the folder part. deps.list(dir) ->
 * Promise<[{name, dir}]>. Resolves [] for anything that is not a path being typed.
 */
async function completePath(typed, deps) {
  const d = deps || {};
  const t = String(typed == null ? '' : typed);
  if (problem(t) || t.length > 1024) return [];
  const cut = t.lastIndexOf('\\');
  if (cut < 0) return [];
  const head = t.slice(0, cut + 1);
  const dir = expandEnv(head.replace(/^"/, ''), d.env || {});
  if (!/^([a-zA-Z]:\\|\\\\[^\\]+\\[^\\]+\\)/.test(dir)) return [];
  const prefix = t.slice(cut + 1).toLowerCase();
  let entries;
  try { entries = await d.list(dir); } catch (_) { return []; }
  return (Array.isArray(entries) ? entries : [])
    .filter((e) => e && typeof e.name === 'string' && e.name.toLowerCase().startsWith(prefix))
    .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
    .slice(0, d.max || 12)
    .map((e) => ({ text: head + e.name + (e.dir ? '\\' : ''), dir: !!e.dir }));
}

module.exports = { plan, expandEnv, splitFirst, splits, shellFolder, words, mergeHistory, remember, complete, completePath, problem, HISTORY_MAX };
