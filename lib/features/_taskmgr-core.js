'use strict';
/*
 * _taskmgr-core.js - the task manager's decisions, PURE (lane taskmgr, 2026-09-28). No Electron, no
 * sidecar, no clock: lib/features/taskmgr.js feeds it sidecar/TaskMgr.cs snapshots and
 * lib/features/taskmgr.test.js feeds it fake process tables. Nothing here can close anything.
 *
 * GROUPING ("Chrome's 20 processes are ONE row"). A process joins its parent's row unless
 *   - the parent is a LAUNCHER, whose children are apps in their own right: Explorer, Windows'
 *     service hosts, and Mantle's own Electron (the launcher, the Spotify card and friends start apps
 *     from there; only Mantle's own Electron children and its sidecar stay on Mantle's row), or
 *   - the child is a game (a Steam or Riot Client game is its own row, never closed with its
 *     launcher), or
 *   - the parent is gone, or is younger than the child (Windows reused the parent's pid).
 * A parent link is by pid AND creation time, so a reused pid never adopts a stranger.
 *
 * MEMORY = the sum of every member's private working set (Task Manager's Processes tab "Memory";
 * how it is read: sidecar/TaskMgr.cs header). CPU % = the members' CPU time over the last interval
 * / (interval x logical processors), Task Manager's Details-tab arithmetic.
 */
const path = require('path');
const GP = require('./_gamemode-plan.js');

const MB = 1048576;
/* Windows' own processes (lower case). The same list as TaskMgr.cs SystemNames, which refuses them
   again whatever the page asks. */
const SYSTEM = new Set(['system', 'registry', 'secure system', 'memory compression', 'idle', 'smss.exe', 'csrss.exe', 'wininit.exe',
  'winlogon.exe', 'services.exe', 'lsass.exe', 'lsaiso.exe', 'svchost.exe', 'dwm.exe', 'fontdrvhost.exe', 'msmpeng.exe', 'nissrv.exe',
  'securityhealthservice.exe', 'sihost.exe', 'ctfmon.exe', 'audiodg.exe', 'taskmgr.exe', 'conhost.exe', 'runtimebroker.exe',
  'startmenuexperiencehost.exe', 'shellexperiencehost.exe', 'searchhost.exe', 'textinputhost.exe', 'applicationframehost.exe',
  'dllhost.exe', 'userinit.exe', 'wudfhost.exe', 'spoolsv.exe']);
const LAUNCHERS = new Set(['explorer.exe', 'svchost.exe', 'services.exe', 'wininit.exe', 'winlogon.exe', 'userinit.exe', 'sihost.exe', 'smss.exe']);
const ANTICHEAT = /^(vgc|vgtray|vgk|vanguard|EasyAntiCheat|EAAntiCheat|BEService|BattlEye|FACEIT)/i;
const GAME_RE = GP.NEVER[1].re;                    // javaw|Minecraft|Roblox|cs2|... (_gamemode-plan.js)
/* A game's client (lane gamequiet, 2026-09-28): the user trimmed RiotClientServices 10 s before Valorant
   launched and Riot Client hung twice. Every name on game mode's never-touch list for games
   (_gamemode-plan.js NEVER[0..1] = sidecar GameMode.cs GamePrefixes, which TaskMgr.cs refuses) is a
   game (isGame), anti-cheat (ANTICHEAT) or this; lib/features/taskmgr.test.js fails if one is none. */
const GAME_CLIENT = /^(Riot|League)/i;
const LIVELY = /^Lively/i;
const SPOTIFY = /^Spotify\.exe$/i;
const SIDECAR = /^Mantle\.Sidecar\.exe$/i;

const low = (s) => String(s || '').toLowerCase();
/* FILETIMEs as decimal strings: compared as numbers without a BigInt per call (buildGroups asks
   once per process per tick; the BigInt parse was most of its cost). Non-digits count as 0. */
const digits = (s) => { const t = String(s == null ? '' : s).replace(/^0+/, ''); return /^\d*$/.test(t) ? t : ''; };
const newer = (a, b) => { const x = digits(a), y = digits(b); return x.length !== y.length ? x.length > y.length : x > y; };
/* A process key, made once per snapshot object (buildGroups looks each one up several times a tick). */
const keyOf = (p) => p._k || (p._k = `${p.pid}|${p.created}`);

const gameMemo = new Map();
function isGame(file) {
  const f = String(file || '');
  if (gameMemo.has(f)) return gameMemo.get(f);
  if (gameMemo.size > 4000) gameMemo.clear();
  const v = GP.RUN_EXES.some((g) => low(g) === low(f)) || GP.KNOWN_GAMES.some((g) => low(g) === low(f)) || GAME_RE.test(f) || /^VALORANT/i.test(f);
  gameMemo.set(f, v);
  return v;
}

/** The app's identity for remembered ticks: its exe path (lower case), else its file name. */
function identityOf(p) { return p.path ? low(p.path) : `file:${low(p.file)}`; }

/** "Google Chrome" (the exe's description, as Task Manager shows it), else "chrome". */
function nameOf(p) {
  if (p.desc && p.desc.trim()) return p.desc.trim();
  return String(p.file || `pid ${p.pid}`).replace(/\.exe$/i, '');
}

/**
 * Why this ROOT's row may never be closed (null = it may). mantleRoot: the row is Mantle's own.
 * Shown on the row, in these words.
 */
function protectedWhy(root, mantleRoot, members) {
  if (mantleRoot) return "Mantle itself: close Mantle from its tray menu";
  const f = low(root.file);
  if (root.pid <= 4 || root.session === 0) return 'A Windows service: Windows needs it running';
  if (f === 'explorer.exe') return "Windows' shell (Explorer): closing it takes the desktop and file windows with it";
  if (SYSTEM.has(f)) return 'Part of Windows: Windows needs it running';
  if (LIVELY.test(root.file)) return 'Lively, your wallpaper app: Mantle never closes it';
  if (ANTICHEAT.test(root.file)) return "A game's anti-cheat: closing it stops the game from starting";
  if (GAME_CLIENT.test(root.file) && !isGame(root.file)) return "A game's client (Riot Client, League): Mantle never closes or trims it; a trim made Riot Client hang";
  if ((members || []).some((m) => SIDECAR.test(m.file))) return 'Another Mantle (its sidecar runs here)';
  return null;
}

/**
 * CPU % per process key from two snapshots (null for the first sample of a process).
 */
function cpuMap(prev, cur) {
  const out = new Map();
  if (!prev || !cur || !(cur.t > prev.t)) return out;
  const span = (cur.t - prev.t) * 10000 * Math.max(1, cur.cpus || 1);   // ms -> 100 ns units, x cores
  const before = new Map(prev.procs.map((p) => [keyOf(p), p.cpu]));
  for (const p of cur.procs) {
    const b = before.get(keyOf(p));
    if (b !== undefined && p.cpu >= b) out.set(keyOf(p), Math.min(100, (100 * (p.cpu - b)) / span));
  }
  return out;
}

/**
 * The whole machine's CPU % between two snapshots, from the Idle process's time (sysmon 2026-09-29):
 * 100 x (1 - idle growth / (interval x cores)), the number Windows' Task Manager shows. It counts
 * interrupts and DPCs, which no process row carries. null when it cannot be known (first sample, an
 * older helper without `idle`, a clock that did not move).
 */
function machineCpu(prev, cur) {
  if (!prev || !cur || !(cur.t > prev.t) || !(prev.idle >= 0) || !(cur.idle >= prev.idle)) return null;
  const span = (cur.t - prev.t) * 10000 * Math.max(1, cur.cpus || 1);
  const busy = 100 * (1 - (cur.idle - prev.idle) / span);
  return Math.round(Math.max(0, Math.min(100, busy)) * 10) / 10;
}

/**
 * The rows. snap = taskmgr.snapshot's result; prev = the one before (for CPU); o.mantlePid = main's
 * process.pid (Mantle's Electron; the snapshot's parentPid says the same when the sidecar is ours).
 * Returns { groups: [...sorted by memory], mantle: group|null, byKey: Map }.
 */
function buildGroups(snap, prev, o) {
  const opts = o || {};
  const procs = (snap && Array.isArray(snap.procs) ? snap.procs : []).filter((p) => p && p.pid > 0);
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const cpu = cpuMap(prev, snap);
  const mantlePid = opts.mantlePid || (snap && snap.parentPid) || 0;
  const mantleMain = byPid.get(mantlePid) || null;
  const mantleFile = mantleMain ? low(mantleMain.file) : null;

  const parentOf = (p) => {
    const q = byPid.get(p.ppid);
    if (!q || q.pid === p.pid || newer(q.created, p.created)) return null;
    return q;
  };
  // Mantle's own row: its Electron main, that Electron's same-exe children, its sidecar, and what
  // the sidecar runs (taskkill, PowerShell helpers). Anything else Mantle started is an app.
  const inMantle = new Map();
  const mantleMember = (p) => {
    if (!mantleMain) return false;
    if (inMantle.has(p.pid)) return inMantle.get(p.pid);
    let v = false;
    if (p.pid === mantleMain.pid) v = true;
    else {
      const q = parentOf(p);
      if (q && mantleMember(q)) {
        const qf = low(q.file), f = low(p.file);
        v = (q.pid === mantleMain.pid && (f === mantleFile || SIDECAR.test(p.file))) || (q.pid !== mantleMain.pid && (f === qf || SIDECAR.test(q.file)));
      }
    }
    inMantle.set(p.pid, v);
    return v;
  };

  const rootMemo = new Map();
  const rootOf = (p, depth) => {
    if (rootMemo.has(p.pid)) return rootMemo.get(p.pid);
    let r = p;
    if (mantleMember(p)) r = mantleMain;
    else if (!isGame(p.file) && (depth || 0) < 64) {
      const q = parentOf(p);
      const launcher = q && (LAUNCHERS.has(low(q.file)) || q.session === 0 || SYSTEM.has(low(q.file)) || (mantleMain && mantleMember(q)));
      if (q && !launcher) r = rootOf(q, (depth || 0) + 1);
    }
    rootMemo.set(p.pid, r);
    return r;
  };

  const groups = new Map();
  for (const p of procs) {
    const r = rootOf(p);
    let g = groups.get(r.pid);
    if (!g) groups.set(r.pid, g = { root: r, members: [] });
    g.members.push(p);
  }
  const out = [];
  let mantle = null;
  for (const { root, members } of groups.values()) {
    const isMantle = !!mantleMain && root.pid === mantleMain.pid;
    const mem = members.reduce((s, m) => s + Math.max(0, m.pws || 0), 0);
    const c = members.reduce((s, m) => s + (cpu.get(keyOf(m)) || 0), 0);
    const windows = members.reduce((s, m) => s + (m.windows || 0), 0);
    const hung = members.reduce((s, m) => s + (m.hung > 0 ? m.hung : 0), 0);
    const prot = protectedWhy(root, isMantle, members);
    const game = !isMantle && members.some((m) => isGame(m.file));
    const titled = members.find((m) => m.windows > 0 && m.title);
    const g = {
      key: keyOf(root), identity: identityOf(root), name: isMantle ? 'Mantle' : nameOf(root),
      file: root.file, path: root.path || null, root: root.pid, created: root.created,
      mem, cpu: Math.round(c * 10) / 10, count: members.length, windows,
      // "Not responding": every one of its app windows is hung (one frozen tab strip of two windows is not the app)
      hung: windows > 0 && hung >= windows,
      title: titled ? titled.title : null,
      kind: isMantle ? 'mantle' : prot && (root.session === 0 || SYSTEM.has(low(root.file)) || root.pid <= 4) ? 'windows' : windows > 0 ? 'app' : 'background',
      protected: prot, game, handledBy: SPOTIFY.test(root.file) ? 'spotify' : null,
      // no path = Windows would not let Mantle open it: it runs as administrator or as another user
      elevated: !root.path && root.session !== 0 && !prot,
      procs: members.map((m) => ({ pid: m.pid, created: m.created })),
      members: members.map((m) => ({ pid: m.pid, created: m.created, file: m.file, mem: Math.max(0, m.pws || 0), cpu: Math.round((cpu.get(keyOf(m)) || 0) * 10) / 10, windows: m.windows || 0 }))
        .sort((a, b) => b.mem - a.mem),
    };
    if (isMantle) mantle = g;
    out.push(g);
  }
  // ties by name, plain code-unit order: localeCompare (ICU) was the top cost of this function
  out.sort((a, b) => b.mem - a.mem || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { groups: out, mantle, byKey: new Map(out.map((g) => [g.key, g])) };
}

/** Which actions a row offers, and why not the others. */
function actionsFor(g) {
  if (!g) return { close: false, force: false, trim: false, why: 'it is no longer running' };
  if (g.protected) return { close: false, force: false, trim: false, why: g.protected };
  return { close: true, force: true, trim: !g.game, why: g.game ? 'A game: Mantle never trims a game (it would stutter)' : null };
}

/** Can this row be ticked in "Get ready to game"? null = yes, else why not (shown instead of a box). */
function tickWhy(g) {
  if (g.handledBy === 'spotify') return 'Handled by the Spotify card: it closes an idle Spotify when a game starts';
  if (g.protected) return g.protected;
  if (g.game) return 'A game';
  if (g.kind === 'windows') return 'Part of Windows';
  return null;
}

/**
 * The "Get ready to game" list: every row that could be closed, biggest first, with its tick.
 * ticks = settings { [identity]: { on, reopen, name } }.
 */
function prepRows(groups, ticks) {
  const t = ticks || {};
  return groups.filter((g) => g.kind === 'app' || g.kind === 'background' || g.handledBy === 'spotify')
    .map((g) => {
      const why = tickWhy(g);
      const rec = t[g.identity] || {};
      return { key: g.key, identity: g.identity, name: g.name, mem: g.mem, kind: g.kind, tickable: !why, why,
        ticked: !why && !!rec.on, reopen: !why && !!rec.reopen, elevated: g.elevated };
    });
}

/**
 * What "Free up RAM" (or the game-start option) would close: ticked, running, closable rows only.
 * A tick on a protected row, a game or Spotify is ignored here even if the settings file says so.
 */
function planFree(groups, ticks) {
  const t = ticks || {};
  const seen = new Set();
  const out = [];
  for (const g of groups) {
    const rec = t[g.identity];
    if (!rec || !rec.on || tickWhy(g) || seen.has(g.key)) continue;
    seen.add(g.key);
    out.push({ key: g.key, identity: g.identity, name: g.name, root: g.root, created: g.created, procs: g.procs, mem: g.mem, reopen: !!rec.reopen, windows: g.windows });
  }
  return out;
}

/** CommandLineToArgvW's rules: backslashes before a quote, "" inside quotes, argv[0] plain. */
function splitCmdline(line) {
  const s = String(line || '');
  const out = [];
  let i = 0;
  // argv[0]: up to the next space, or between quotes, with NO backslash rules
  while (i < s.length && /\s/.test(s[i])) i++;
  if (i >= s.length) return out;
  let a0 = '';
  if (s[i] === '"') { i++; while (i < s.length && s[i] !== '"') a0 += s[i++]; i++; }
  else while (i < s.length && !/\s/.test(s[i])) a0 += s[i++];
  out.push(a0);
  for (;;) {
    while (i < s.length && /[ \t]/.test(s[i])) i++;
    if (i >= s.length) break;
    let cur = '', inQ = false;
    while (i < s.length && (inQ || !/[ \t]/.test(s[i]))) {
      if (s[i] === '\\') {
        let n = 0;
        while (s[i] === '\\') { n++; i++; }
        if (s[i] === '"') { cur += '\\'.repeat(Math.floor(n / 2)); if (n % 2) { cur += '"'; i++; } }
        else cur += '\\'.repeat(n);
      } else if (s[i] === '"') {
        if (inQ && s[i + 1] === '"') { cur += '"'; i += 2; }
        else { inQ = !inQ; i++; }
      } else cur += s[i++];
    }
    out.push(cur);
  }
  return out;
}

/**
 * How an app closed for a game would be started again: { exe, args } or { exe:null, why }.
 * info = taskmgr.cmdline's result for its root. existsFn(path) -> bool.
 */
function reopenPlan(info, existsFn) {
  if (!info || !info.path) return { exe: null, why: (info && info.why) || 'its exe path could not be read (it runs as administrator)' };
  const exe = info.path;
  if (/\\WindowsApps\\/i.test(exe)) return { exe: null, why: 'A Store app: Mantle cannot start it from its exe (open it from Start after the game)' };
  if (existsFn && !existsFn(exe)) return { exe: null, why: 'its exe is no longer where it ran from (updated or moved)' };
  if (!info.cmdline) return { exe, args: [], note: info.why || 'its command line could not be read: it reopens without arguments' };
  const argv = splitCmdline(info.cmdline);
  // argv[0] is how it was started; the exe path above is what runs. Drop Chromium's per-process
  // switches: a root never has --type=, and a relaunch must not claim to be a child.
  const args = argv.slice(1).filter((a) => !/^--type=/.test(a));
  return { exe, args };
}

/** "532 MB" / "1,234 MB" (Task Manager's unit). */
function mb(bytes) {
  if (!(bytes >= 0)) return '—';
  return `${Math.round(bytes / MB).toLocaleString('en-US')} MB`;
}

module.exports = { MB, SYSTEM, LAUNCHERS, isGame, identityOf, nameOf, protectedWhy, cpuMap, machineCpu, buildGroups, actionsFor, tickWhy, prepRows, planFree, splitCmdline, reopenPlan, mb, keyOf, baseName: (p) => path.win32.basename(String(p || '')) };
