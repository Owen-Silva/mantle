'use strict';
/**
 * _taskmgr-model.js - pure helpers that turn sidecar samples into the TM-SPEC model fields
 * (lane tm-data, 2026-10-28). No I/O here: lib/features/taskmgr.js calls the sidecar and these
 * shape the answers, so every rule is unit-tested in lib/features/taskmgr.test.js.
 *
 * Contract: TM-SPEC.md, the shared task manager contract (Processes row fields, totals, Settings, Users,
 * Startup apps, Services). Anything not measurable honestly is null, and `why` says so.
 */
const C = require('./_taskmgr-core.js');

const VIEWS = ['processes', 'performance', 'apphistory', 'startup', 'users', 'details', 'services', 'settings', 'game'];
/** 'apps' (old callers, tests) is Processes; anything unknown is Processes too. */
function normView(v) { return v === 'apps' ? 'processes' : VIEWS.includes(v) ? v : 'processes'; }

/* ---- Settings page (persisted under the feature's 'tm' key) ---------------------------------- */
const SPEEDS = { high: 500, normal: 1000, low: 4000, paused: 0 };
const DEFAULTS = Object.freeze({
  theme: 'system', startPage: 'processes', updateSpeed: 'normal', alwaysOnTop: false, minimizeOnUse: false,
  hideWhenMinimized: false, fullAccountName: false, historyAllProcesses: false, askBeforeEfficiency: true,
});
const BOOLS = ['alwaysOnTop', 'minimizeOnUse', 'hideWhenMinimized', 'fullAccountName', 'historyAllProcesses', 'askBeforeEfficiency'];

/** -> { ok, value } or { ok:false, reason }. Own keys only (never '__proto__'). */
function validateSetting(key, value) {
  if (typeof key !== 'string' || !Object.prototype.hasOwnProperty.call(DEFAULTS, key)) return { ok: false, reason: `"${String(key).slice(0, 40)}" is not a Task Manager setting` };
  if (BOOLS.includes(key)) return typeof value === 'boolean' ? { ok: true, value } : { ok: false, reason: `${key} is on or off (true/false)` };
  if (key === 'theme') return ['system', 'light', 'dark'].includes(value) ? { ok: true, value } : { ok: false, reason: 'theme is system, light or dark' };
  if (key === 'updateSpeed') return Object.prototype.hasOwnProperty.call(SPEEDS, value) ? { ok: true, value } : { ok: false, reason: 'update speed is high, normal, low or paused' };
  if (key === 'startPage') return VIEWS.includes(value) && value !== 'settings' ? { ok: true, value } : { ok: false, reason: 'that is not a page' };
  return { ok: false, reason: 'unknown setting' };
}
/** The saved object, cleaned: unknown keys dropped, bad values back to defaults. */
function settingsOf(saved) {
  const out = Object.assign({}, DEFAULTS);
  const s = saved && typeof saved === 'object' ? saved : {};
  for (const k of Object.keys(DEFAULTS)) if (Object.prototype.hasOwnProperty.call(s, k) && validateSetting(k, s[k]).ok) out[k] = s[k];
  return out;
}
/** Milliseconds to the next sample: the update speed while in front, never faster than behindMs behind
    other windows (the existing focused/behind cadence). 0 = paused (no sampling at all). */
function tickMs(settings, focused, behindMs) {
  const ms = SPEEDS[(settings && settings.updateSpeed) || 'normal'];
  if (!ms) return 0;
  return focused ? ms : Math.max(ms, behindMs || 3000);
}

/* ---- Per-process rates ------------------------------------------------------------------------ */
/** Disk bytes/s per process key from two snapshots' `io` (read+write transfer bytes, the
    GetProcessIoCounters numbers). Missing on the first sample of a process; never negative. */
function ioRates(prev, cur) {
  const out = new Map();
  if (!prev || !cur || !(cur.t > prev.t)) return out;
  const secs = (cur.t - prev.t) / 1000;
  const before = new Map(prev.procs.map((p) => [C.keyOf(p), p.io]));
  for (const p of cur.procs) {
    const b = before.get(C.keyOf(p));
    if (typeof b === 'number' && typeof p.io === 'number' && p.io >= b) out.set(C.keyOf(p), Math.round((p.io - b) / secs));
  }
  return out;
}

const NET_WHY = "per-app network use needs Windows' event tracing as administrator. Set up administrator access to see it (Windows asks once)";
/** Bytes/s per process from the elevated helper's trace ({byPid}) summed over procs; null when not measured. */
function netOf(net, procs) {
  const by = net && net.byPid;
  if (!by) return null;
  let n = 0;
  for (const p of procs) n += Number(by[p.pid]) || 0;
  return Math.round(n);
}
const POWER_WHY = "Windows' power estimate comes from its energy estimation engine, which apps cannot read";

/**
 * The extra Processes row fields (TM-SPEC Processes > Row fields) for one group from buildGroups.
 * s = { snap, io: Map key->B/s, gpu: { byPid: {pid:{pct, engine}} }|null, extra: Map key->{publisher, cmdline, efficiency, power}|null,
 *       net: { byPid: {pid: B/s}, why }|null (the elevated helper's taskmgr.netsample) }
 */
function rowExtras(g, s) {
  const st = s || {};
  const byKey = new Map(((st.snap && st.snap.procs) || []).map((p) => [C.keyOf(p), p]));
  const procs = (g.procs || []).map((q) => byKey.get(`${q.pid}|${q.created}`)).filter(Boolean);
  let disk = null;
  if (st.io && st.io.size) { disk = 0; for (const p of procs) disk += st.io.get(C.keyOf(p)) || 0; }
  let gpu = null, gpuEngine = null;
  const by = st.gpu && st.gpu.byPid;
  if (by) {
    let best = -1;
    gpu = 0;
    for (const p of procs) {
      const x = by[p.pid];
      if (!x || typeof x.pct !== 'number') continue;
      gpu += x.pct;
      if (x.pct > best) { best = x.pct; gpuEngine = x.engine || null; }
    }
    gpu = Math.round(Math.min(100, gpu) * 10) / 10;
  }
  const suspended = procs.length > 0 && procs.every((p) => p.suspended === true);
  const rootKey = `${g.root}|${g.created}`;
  const ex = st.extra ? st.extra.get(rootKey) || null : null;
  const efficiency = !!(ex && ex.efficiency);
  const status = g.hung ? 'Not responding' : suspended ? 'Suspended' : efficiency ? 'Efficiency mode' : null;
  return {
    disk, gpu, gpuEngine, net: netOf(st.net, procs), status, efficiency, suspended,
    type: g.kind === 'app' || g.kind === 'background' || g.kind === 'windows' ? g.kind : g.kind === 'mantle' ? 'app' : null,
    publisher: ex ? ex.publisher || null : null, pid: g.root, processName: g.file || null, cmdline: ex ? ex.cmdline || null : null,
    power: ex && ex.power ? ex.power : null, powerTrend: ex && ex.powerTrend ? ex.powerTrend : null,
    why: { net: st.net && st.net.byPid ? null : (st.net && st.net.why) || NET_WHY, power: ex && ex.power ? null : POWER_WHY, disk: disk === null ? 'the first sample has no rate yet' : null, gpu: gpu === null ? (st.gpu && st.gpu.why) || 'GPU use is read on the Processes and Performance pages' : null },
  };
}

/** model.totals: cpu %, mem % of RAM, the busiest disk's active %, network % and GPU % (null = not measured). */
function totals(o) {
  const x = o || {};
  const m = x.mem;
  const r1 = (v) => (typeof v === 'number' && isFinite(v) ? Math.round(Math.max(0, Math.min(100, v)) * 10) / 10 : null);
  return {
    cpu: r1(x.cpu), mem: m && m.total > 0 ? r1((100 * m.used) / m.total) : null,
    disk: r1(x.disk), net: r1(x.net), gpu: r1(x.gpu),
  };
}

/* ---- Users ------------------------------------------------------------------------------------- */
/** model.users.rows: the sidecar's sessions + per-session sums of CPU %, memory and disk from the
    snapshot (cpu: Map key->%, io: Map key->B/s). Network per user = the elevated helper's trace summed per session (null + why without it).
    gpu: the taskmgr.gpu reply's { byPid: {pid: {pct, engine}}, why } (Users reads it) or null. `current` = the session Mantle
    runs in (the sidecar's `self`). Each process carries pid + created (End task verifies both) and its exe path. */
const SESSION_NAME_WHY = "Windows' session name (Console, RDP-Tcp#n) is not read by Mantle yet";
const CLIENT_WHY = 'Not read by Mantle yet (Windows shows a client name only for a remote session)';
function usersRows(sessions, snap, cpu, io, fullAccountName, net, gpu) {
  const procs = (snap && snap.procs) || [];
  const by = gpu && gpu.byPid;
  const r1 = (v) => Math.round(v * 10) / 10;
  const gpuOf = (list) => {
    if (!by) return { gpu: null, gpuEngine: null };
    let sum = 0, best = -1, engine = null;
    for (const p of list) { const x = by[p.pid]; if (!x || typeof x.pct !== 'number') continue; sum += x.pct; if (x.pct > best) { best = x.pct; engine = x.engine || null; } }
    return { gpu: r1(Math.min(100, sum)), gpuEngine: engine };
  };
  const gpuWhy = by ? null : (gpu && gpu.why) || 'GPU use is read on the Processes, Performance and Users pages';
  const netWhy = net && net.byPid ? null : (net && net.why) || NET_WHY;
  return (sessions || []).map((u) => {
    const mine = procs.filter((p) => p.session === u.session);
    const sum = (f) => mine.reduce((a, p) => a + (f(p) || 0), 0);
    const g = gpuOf(mine);
    return {
      session: u.session, user: fullAccountName && u.domain ? `${u.domain}\\${u.user}` : u.user, fullName: u.fullName || null, status: u.status || null,
      current: u.self === true, sessionName: null, client: null,
      cpu: cpu && cpu.size ? r1(Math.min(100, sum((p) => cpu.get(C.keyOf(p))))) : null,
      mem: sum((p) => Math.max(0, p.pws || 0)), disk: io && io.size ? sum((p) => io.get(C.keyOf(p))) : null, net: netOf(net, mine),
      gpu: g.gpu, gpuEngine: g.gpuEngine,
      why: { net: netWhy, gpu: gpuWhy, sessionName: SESSION_NAME_WHY, client: CLIENT_WHY },
      procs: mine.map((p) => Object.assign({
        pid: p.pid, created: p.created, name: C.nameOf(p), processName: p.file || null, path: p.path || null,
        cpu: cpu ? r1(cpu.get(C.keyOf(p)) || 0) : null, mem: Math.max(0, p.pws || 0),
        disk: io && io.size ? io.get(C.keyOf(p)) || 0 : null, net: netOf(net, [p]),
      }, gpuOf([p]))).sort((a, b) => b.mem - a.mem),
    };
  });
}

/* ---- Startup apps ------------------------------------------------------------------------------ */
/** model.startup.rows from startup.list items + taskmgr.startupmeta rows (by command) + running exe paths. */
function startupRows(items, meta, runningPaths) {
  const byCmd = new Map(((meta && meta.rows) || []).map((r) => [r.command, r]));
  const running = runningPaths instanceof Set ? runningPaths : new Set();
  return (items || []).map((it) => {
    const m = byCmd.get(it.command) || {};
    const p = m.path || null;
    return {
      item: it.item, name: it.name, publisher: m.publisher || null, enabled: !!it.enabled, impact: m.impact || null,
      type: it.sourceLabel || it.source || null, diskIO: m.diskIO == null ? null : m.diskIO, cpuMs: m.cpuMs == null ? null : m.cpuMs,
      running: p ? running.has(String(p).toLowerCase()) : false, disabledAt: it.disabledAt || null, lastRun: null, cmdline: it.command || null, path: p,
      canToggle: it.canToggle !== false, reason: it.reason || null,
    };
  });
}

/** Lower-cased exe paths of every running process (Startup apps' "Running now"). */
function runningPaths(snap) { return new Set(((snap && snap.procs) || []).filter((p) => p.path).map((p) => String(p.path).toLowerCase())); }

module.exports = { VIEWS, normView, SPEEDS, DEFAULTS, validateSetting, settingsOf, tickMs, ioRates, rowExtras, totals, usersRows, startupRows, runningPaths, NET_WHY, POWER_WHY, SESSION_NAME_WHY, CLIENT_WHY };
