'use strict';
/* apppower-core.js - the pure half of App power (lane mantle-power, 2026-10-14).
 *
 * Owen, looking at the top bar's CPU dropdown: "a way to limit cpu use or select what things that are
 * open can use whatever amount of cpu usage", "and gpu and ram too obviously", "i want to be able to
 * do the cpu limits and gpu and ram and stuff from here". So every TOP PROCESSES row of the CPU, RAM
 * and GPU dropdowns can be tamed: Efficiency mode, priority, a CPU limit, lower memory priority, free
 * up memory, a memory limit, lower graphics priority, the graphics preference (2+ GPUs only),
 * remembered per app.
 *
 * Three parts (contract: mantle-notes/power-CONTRACT.md):
 *   - sidecar/AppPower.cs does every Win32 write and keeps enforcing the rule table on new processes;
 *     sidecar/TopbarStats.cs groups the top processes by app and says who may be changed;
 *   - THIS file: which app a row is (key, friendly name), what Mantle must never touch and why, the
 *     rules store (validate, change, merge with phase 2's Auto rules), the words for a refusal, and
 *     decorate(): the stats sample with each row's state, for the dropdown;
 *   - lib/features/apppower.js: the commands the dropdown and Settings call, persistence, the sidecar.
 *
 * PURE: no Electron, no sidecar, no files. `live` is the one shared state (the feature writes it,
 * lib/features/topbar.js reads it through live.decorate on every sample).
 *
 * PHASE 2 HOOK ("Auto": background apps throttled by default, game mode's tie-in): call
 * live.setAuto([{ key, exe, path, label, set }]) with the rules Auto wants right now. They go to the
 * sidecar under the user's rules (a user rule for the same app always wins, see mergeTable), and
 * live.onChange tells the feature to re-send the table. Nothing calls setAuto yet.
 */
/* Image names grouped by exe PATH, not name: one runtime, many apps (sidecar/TopbarStats.cs has the
 * same list). Mantle, Helm's dev copy and a test instance are all electron.exe. */
const GENERIC = new Set(['electron', 'node', 'python', 'pythonw', 'py', 'java', 'javaw', 'dotnet']);

/* Never offered, whatever happens: Windows itself, security, the shell Mantle sits on, and Mantle.
 * sidecar/AppPower.cs refuses the same names again (defence in depth). Lower case, no ".exe". */
const PROTECTED = new Set([
  'system', 'idle', 'registry', 'smss', 'csrss', 'wininit', 'winlogon', 'services', 'lsass', 'lsaiso',
  'svchost', 'dwm', 'fontdrvhost', 'audiodg', 'msmpeng', 'nissrv', 'mpdefendercoreservice',
  'securityhealthservice', 'securityhealthsystray', 'sgrmbroker', 'memory compression', 'memcompression',
  'secure system', 'system interrupts', 'interrupts', 'explorer', 'sihost', 'ctfmon', 'logonui',
  'wudfhost', 'dllhost', 'taskhostw', 'conhost', 'startmenuexperiencehost', 'shellexperiencehost',
  'textinputhost', 'searchhost', 'searchindexer', 'lockapp', 'userinit', 'spoolsv', 'mantle.sidecar',
]);
const PROTECTED_WORDS = 'Windows protects this process';
const MANTLE_WORDS = 'This is Mantle';
const GAME_WORDS = 'Mantle never changes games or anti-cheat';   // sidecar access 'game' (GameMode.GamePrefixes)
const UNKNOWN_APP_WORDS = 'Mantle can’t tell which app this is, so it leaves it alone';

/* The names people know. Anything else shows as Windows names it (the exe without ".exe"). */
const FRIENDLY = {
  svchost: 'Service Host', msmpeng: 'Microsoft Defender', mpdefendercoreservice: 'Microsoft Defender',
  nissrv: 'Microsoft Defender', system: 'System', dwm: 'Desktop Window Manager', explorer: 'File Explorer',
  'memory compression': 'Memory compression', memcompression: 'Memory compression', audiodg: 'Windows audio',
  csrss: 'Windows client runtime', lsass: 'Windows sign-in', searchhost: 'Windows Search', searchindexer: 'Windows Search indexer',
  msedge: 'Microsoft Edge', msedgewebview2: 'Edge WebView', chrome: 'Google Chrome', firefox: 'Firefox', opera: 'Opera',
  code: 'Visual Studio Code', windowsterminal: 'Terminal', openconsole: 'Terminal', powershell: 'PowerShell',
  pwsh: 'PowerShell', cmd: 'Command Prompt', node: 'Node.js', python: 'Python', pythonw: 'Python', py: 'Python',
  java: 'Java', javaw: 'Java', dotnet: '.NET', claude: 'Claude Code', quartz: 'Quartz', helm: 'Helm',
  spotify: 'Spotify', discord: 'Discord', taskmgr: 'Task Manager', runtimebroker: 'Runtime Broker',
  phoneexperiencehost: 'Phone Link', onedrive: 'OneDrive', teams: 'Microsoft Teams', 'ms-teams': 'Microsoft Teams',
  steam: 'Steam', steamwebhelper: 'Steam', obs64: 'OBS Studio', winword: 'Word', excel: 'Excel', powerpnt: 'PowerPoint',
  outlook: 'Outlook', olk: 'Outlook', notepad: 'Notepad', mspaint: 'Paint', vlc: 'VLC',
};

// Mantle's own electron (live, a worktree, a test copy): same rule as main.js MANTLE_ELECTRON_RE
const MANTLE_ELECTRON_RE = /[\\/]mantle(?:-[^\\/]*)?[\\/]node_modules[\\/]electron[\\/]dist[\\/]electron\.exe$/i;

const MANTLE_WT_RE = /[\\/]mantle-wt[\\/][^\\/]+[\\/]node_modules[\\/]electron[\\/]dist[\\/]electron\.exe$/i;

const PRIORITIES = ['low', 'belownormal', 'normal', 'abovenormal'];
const GPU_PREFS = ['default', 'saving', 'performance'];
const CPU_CAPS = [0, 75, 50, 25, 10];   // what the dropdown offers; any 1..99 is accepted
const MB = 1024 * 1024;
const MEM_CAP_MIN = 64 * MB, MEM_CAP_MAX = 64 * 1024 * MB;
const DEFAULT_SET = Object.freeze({ eco: false, priority: null, cpuCap: 0, memLow: false, memCap: 0, gpuLow: false, gpuPref: 'default' });

const lower = (s) => String(s == null ? '' : s).toLowerCase();
/** "electron (13)" -> "electron"; "Quartz.exe" -> "Quartz". */
function exeOf(e) {
  const raw = e && e.exe ? String(e.exe) : String((e && e.name) || '').replace(/\s+\(\d+\)$/, '');
  return raw.replace(/\.exe$/i, '');
}
function countOf(e) {
  if (e && Number.isInteger(e.n) && e.n > 0) return e.n;
  const m = /\((\d+)\)$/.exec(String((e && e.name) || ''));
  return m ? +m[1] : 1;
}
const normPath = (p) => (p ? String(p).replace(/\//g, '\\').toLowerCase() : '');

/** The app a row is: its image name, and for a GENERIC runtime also its exe path. Null when a generic
 * runtime came without a path (it could be any app, Mantle included: never offered). */
function keyFor(exe, exePath) {
  const x = lower(exe).replace(/\.exe$/, '');
  if (!x) return null;
  if (!GENERIC.has(x)) return x;
  const p = normPath(exePath);
  return p ? x + '|' + p : null;
}

function isMantle(exe, exePath, ownExe) {
  const x = lower(exe);
  if (x === 'mantle.sidecar' || x === 'mantle') return true;
  if (!exePath) return false;
  if (MANTLE_ELECTRON_RE.test(String(exePath))) return true;
  if (MANTLE_WT_RE.test(String(exePath))) return true;   // a lane worktree's copy (a --test instance)
  return !!ownExe && normPath(exePath) === normPath(ownExe);
}

/** The folder an Electron / Node app lives in: ...\<app>\node_modules\electron\dist\electron.exe -> <app>. */
function appFolder(exePath) {
  const parts = String(exePath || '').split(/[\\/]+/);
  const nm = parts.map(lower).lastIndexOf('node_modules');
  return nm > 0 ? parts[nm - 1] : null;
}

/** The friendly name for a row. */
function friendlyName(exe, exePath, ownExe) {
  const x = lower(exe).replace(/\.exe$/, '');
  if (isMantle(x, exePath, ownExe)) return 'Mantle';
  if (x === 'electron' && exePath) {
    const dir = lower(appFolder(exePath));
    if (dir === 'browser') return 'Quartz';
    if (dir === 'helm' || /^helm-/.test(dir)) return 'Helm';
    if (dir) return appFolder(exePath) + ' (Electron)';
  }
  if (FRIENDLY[x]) return FRIENDLY[x];
  return String(exe || '').replace(/\.exe$/i, '') || 'This app';
}

/** Why a row gets no controls (plain words), or null when it may be changed. */
function protectedWhy(exe, exePath, access, label, ownExe) {
  const x = lower(exe).replace(/\.exe$/, '');
  if (isMantle(x, exePath, ownExe)) return MANTLE_WORDS;
  if (PROTECTED.has(x)) return PROTECTED_WORDS;
  if (access === 'protected' || access === 'system') return PROTECTED_WORDS;
  if (access === 'game') return GAME_WORDS;
  if (access === 'admin') return `Windows doesn’t let Mantle change ${label}: it runs as administrator`;
  if (GENERIC.has(x) && !exePath) return UNKNOWN_APP_WORDS;
  return null;
}

/* ---- the settings of one app -------------------------------------------------------------- */
function normalizeSet(s) {
  const o = s && typeof s === 'object' ? s : {};
  const out = Object.assign({}, DEFAULT_SET);
  if (o.eco === true) out.eco = true;
  if (PRIORITIES.includes(o.priority) && o.priority !== 'normal') out.priority = o.priority;
  if (Number.isInteger(o.cpuCap) && o.cpuCap >= 1 && o.cpuCap <= 99) out.cpuCap = o.cpuCap;
  if (o.memLow === true) out.memLow = true;
  if (Number.isInteger(o.memCap) && o.memCap >= MEM_CAP_MIN && o.memCap <= MEM_CAP_MAX) out.memCap = o.memCap;
  if (o.gpuLow === true) out.gpuLow = true;
  if (GPU_PREFS.includes(o.gpuPref)) out.gpuPref = o.gpuPref;
  return out;
}
function isDefaultSet(s) {
  const n = normalizeSet(s);
  return Object.keys(DEFAULT_SET).every((k) => n[k] === DEFAULT_SET[k]);
}

/** One change from the dropdown, checked. caps = the sidecar's apppower.caps.
 * -> { ok: true, set } (the new whole set) or { ok: false, reason }. */
function applyChange(cur, change, caps) {
  const c = change && typeof change === 'object' ? change : {};
  const keys = Object.keys(c);
  const no = (reason) => ({ ok: false, reason });
  if (keys.length !== 1) return no('Mantle didn’t understand that change');
  const k = keys[0], v = c[k];
  const set = normalizeSet(cur);
  switch (k) {
    case 'eco': case 'memLow': case 'gpuLow':
      if (typeof v !== 'boolean') return no('Mantle didn’t understand that change');
      if (k === 'gpuLow' && v && caps && caps.gpuLow === false) return no(caps.gpuLowWhy || 'Windows doesn’t let Mantle change graphics priority here');
      set[k] = v; break;
    case 'priority':
      if (v !== null && !PRIORITIES.includes(v)) return no(/high|realtime/i.test(String(v)) ? 'Mantle never raises an app above “Above normal”: it could freeze the PC' : 'Mantle didn’t understand that priority');
      set.priority = v === 'normal' ? null : v; break;
    case 'cpuCap':
      if (!Number.isInteger(v) || v < 0 || v > 99) return no('A CPU limit is between 1% and 99%');
      set.cpuCap = v; break;
    case 'memCap':
      if (!Number.isInteger(v) || (v !== 0 && (v < MEM_CAP_MIN || v > MEM_CAP_MAX))) return no('A memory limit is between 64 MB and 64 GB');
      set.memCap = v; break;
    case 'gpuPref':
      if (!GPU_PREFS.includes(v)) return no('Mantle didn’t understand that graphics preference');
      if (v !== 'default' && !(caps && caps.gpuPref)) return no('This PC has one graphics processor, so there is nothing to choose between');
      set.gpuPref = v; break;
    default: return no('Mantle didn’t understand that change');
  }
  return { ok: true, set };
}

function fmtBytes(b) {
  if (!(b > 0)) return '0 MB';
  if (b >= 1024 * MB) { const g = b / (1024 * MB); return (g >= 10 || Number.isInteger(g) ? Math.round(g) : g.toFixed(1)) + ' GB'; }
  return Math.max(1, Math.round(b / MB)) + ' MB';
}
const PRIORITY_WORDS = { low: 'Low priority', belownormal: 'Below normal priority', abovenormal: 'Above normal priority' };
const GPU_PREF_WORDS = { saving: 'Graphics: power saving', performance: 'Graphics: high performance' };
/** "Efficiency mode, CPU limit 25%" (Settings' list). */
function summary(s) {
  const n = normalizeSet(s), out = [];
  if (n.eco) out.push('Efficiency mode');
  if (n.priority) out.push(PRIORITY_WORDS[n.priority]);
  if (n.cpuCap) out.push(`CPU limit ${n.cpuCap}%`);
  if (n.memLow) out.push('Lower memory priority');
  if (n.memCap) out.push(`Memory limit ${fmtBytes(n.memCap)}`);
  if (n.gpuLow) out.push('Lower graphics priority');
  if (GPU_PREF_WORDS[n.gpuPref]) out.push(GPU_PREF_WORDS[n.gpuPref]);
  return out.join(', ') || 'Normal';
}

/** A stored rule, checked (a hand-edited or old settings file never reaches the sidecar as it is).
 * -> the clean rule or null. */
function cleanRule(r) {
  if (!r || typeof r !== 'object') return null;
  const exe = exeOf({ exe: r.exe });
  const p = r.path ? String(r.path) : null;
  if (p && (p.length > 1024 || !/^[a-z]:\\|^\\\\/i.test(p.replace(/\//g, '\\')))) return null;
  const key = keyFor(exe, p);
  if (!key || (r.key && r.key !== key)) return null;
  if (PROTECTED.has(lower(exe)) || isMantle(exe, p, null)) return null;
  const set = normalizeSet(r.set);
  if (isDefaultSet(set)) return null;
  const label = typeof r.label === 'string' && r.label.trim() ? r.label.trim().slice(0, 80) : friendlyName(exe, p, null);
  return { key, exe, path: p, label, set, remember: r.remember !== false, at: Number.isFinite(r.at) ? r.at : 0 };
}

/** The table for the sidecar: the user's rules, then Auto's for apps the user has not set (phase 2). */
function mergeTable(userRules, autoRules) {
  const out = [], seen = new Set();
  for (const r of userRules || []) { if (r && !seen.has(r.key)) { seen.add(r.key); out.push(r); } }
  for (const r of autoRules || []) {
    const c = cleanRule(Object.assign({}, r, { remember: false }));
    if (c && !seen.has(c.key)) { seen.add(c.key); out.push(Object.assign(c, { source: 'auto' })); }
  }
  return out;
}
/** What apppower.rules gets: gpuPref is a registry value, not a process setting, so it stays here. */
function sidecarRules(table) {
  return table.map((r) => {
    const s = normalizeSet(r.set);
    return { key: r.key, label: r.label, match: { exe: r.exe, path: r.path || null },
      set: { eco: s.eco, priority: s.priority, cpuCap: s.cpuCap, memLow: s.memLow, memCap: s.memCap, gpuLow: s.gpuLow } };
  });
}

/** A refusal, in Owen's words. denied = [{ access, n }] from the sidecar; applied = processes changed. */
function denyWords(label, applied, denied) {
  const by = {};
  for (const d of Array.isArray(denied) ? denied : []) if (d && d.n > 0 && d.access !== 'gone') by[d.access] = (by[d.access] || 0) + d.n;
  const admin = by.admin || 0, prot = (by.system || 0) + (by.protected || 0), err = by.error || 0;
  if (by.game && !applied) return GAME_WORDS;
  if (!admin && !prot && !err) return null;
  const some = applied > 0;
  if (admin) return some ? `Windows didn’t let Mantle change ${admin === 1 ? 'one' : admin} of ${label}’s processes: ${admin === 1 ? 'it runs' : 'they run'} as administrator`
    : `Windows didn’t let Mantle change ${label}: it runs as administrator`;
  if (prot) return some ? `Windows protects ${prot === 1 ? 'one' : prot} of ${label}’s processes, so ${prot === 1 ? 'it was' : 'they were'} left alone` : PROTECTED_WORDS;
  return some ? `Windows didn’t let Mantle change ${err === 1 ? 'one' : err} of ${label}’s processes` : `Windows didn’t let Mantle change ${label}. Try again in a moment`;
}

/* ---- the shared live state ------------------------------------------------------------------ */
const KNOWN_MAX = 300;
function createLive() {
  const L = {
    running: false,           // the feature is installed, on and has a sidecar
    test: false,              // a --test instance: every write is a dry run
    ownExe: process.execPath,
    rules: new Map(),         // key -> clean rule (the user's: remembered or this session only)
    auto: [],                 // phase 2: Auto's rules (see the header)
    status: new Map(),        // key -> { applied, denied, shared } from the sidecar
    caps: { gpus: null, gpuLow: false, gpuLowWhy: null, gpuPref: false },
    known: new Map(),         // key -> { exe, path, label }: rows the dropdown was shown (its calls must name one)
    onChange: null,           // the feature: re-send the table
  };
  L.remember = function remember(key, info) {
    if (L.known.has(key)) L.known.delete(key);
    L.known.set(key, info);
    if (L.known.size > KNOWN_MAX) L.known.delete(L.known.keys().next().value);
  };
  L.row = function row(key, extra) {
    const info = L.known.get(key) || L.rules.get(key);
    if (!info) return null;
    const rule = L.rules.get(key);
    const st = L.status.get(key);
    const label = (rule && rule.label) || info.label;
    const why = protectedWhy(info.exe, info.path, extra && extra.access, label, L.ownExe);
    return {
      key, label, n: (extra && extra.n) || info.n || 1,
      ctl: !why, why,
      deny: st && !why ? denyWords(label, st.applied || 0, st.denied) : null,
      set: rule ? Object.assign({}, rule.set) : Object.assign({}, DEFAULT_SET),
      remembered: !!(rule && rule.remember),
      shared: st && (rule && (rule.set.cpuCap || rule.set.memCap)) ? (st.shared == null ? null : !!st.shared) : null,
      test: L.test,
    };
  };
  /** The stats sample with every CPU / RAM / GPU top row's state. Unchanged while not running. */
  L.decorate = function decorate(payload) {
    if (!L.running || !payload || typeof payload !== 'object') return payload;
    const out = Object.assign({}, payload);
    for (const kind of ['cpu', 'mem', 'gpu']) {
      const d = payload[kind];
      if (!d || !Array.isArray(d.top)) continue;
      out[kind] = Object.assign({}, d, { top: d.top.map((e) => {
        const exe = exeOf(e);
        const key = keyFor(exe, e.path);
        const n = countOf(e);
        if (!key) return Object.assign({}, e, { key: null, label: friendlyName(exe, e.path, L.ownExe), n, ctl: false, why: protectedWhy(exe, null, e.access, exe, L.ownExe) || UNKNOWN_APP_WORDS, deny: null, set: Object.assign({}, DEFAULT_SET), remembered: false, shared: null, test: L.test });
        const label = friendlyName(exe, e.path, L.ownExe);
        L.remember(key, { exe, path: e.path || null, label, access: e.access || null, n });
        return Object.assign({}, e, L.row(key, { n, access: e.access }));
      }) });
    }
    out.apppower = { gpus: L.caps.gpus, gpuLow: !!L.caps.gpuLow, gpuLowWhy: L.caps.gpuLowWhy || null, gpuPref: !!L.caps.gpuPref, test: L.test };
    return out;
  };
  /** The table the sidecar enforces. */
  L.table = function table() { return mergeTable([...L.rules.values()], L.auto); };
  /** PHASE 2: Auto's rules now (see the header). */
  L.setAuto = function setAuto(list) {
    L.auto = Array.isArray(list) ? list.slice() : [];
    if (typeof L.onChange === 'function') L.onChange('auto');
  };
  return L;
}

module.exports = {
  GENERIC, PROTECTED, PROTECTED_WORDS, MANTLE_WORDS, GAME_WORDS, UNKNOWN_APP_WORDS, PRIORITIES, GPU_PREFS, CPU_CAPS, DEFAULT_SET,
  MEM_CAP_MIN, MEM_CAP_MAX, MANTLE_ELECTRON_RE,
  exeOf, countOf, keyFor, isMantle, friendlyName, protectedWhy, normalizeSet, isDefaultSet, applyChange,
  fmtBytes, summary, cleanRule, mergeTable, sidecarRules, denyWords, createLive,
  live: createLive(),
};
