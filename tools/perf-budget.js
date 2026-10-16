'use strict';
/*
 * tools/perf-budget.js - THE BUDGET GATE (P0 of notes/mantle-replace-windows.md; rules in PERF.md).
 *
 *   node tools/perf-budget.js [--n=10] [--slack=1.5] [--surfaces=settings,files,...] [--strict]
 *                             [--no-lock] [--no-rerun] [--settle=15] [--out=<file.json>] [--json]
 *
 * WHAT IT DOES. Starts ONE invisible `electron . --test` copy of this checkout (lib/test-quiet.js keeps every
 * window off the screen), then:
 *   1. checks nothing is pre-made: no hidden Settings / Task Manager / Files window exists at rest
 *      (Owen 2026-10-15: "no i dont want these open in the backround i need to save ram");
 *   2. samples total private RAM and the idle CPU of every hidden window (10 s, nothing happening);
 *   3. opens each owned surface COLD n times (its window destroyed first) and WARM n times (closed the way
 *      its X button closes it, then opened again), through the existing test hook: main's
 *      'second-instance' handler with --test-chord=<chord>, the same road a second `electron . --test-chord`
 *      takes, emitted in-process so the trigger is timestamped in main (PERF.md R2);
 *   4. reads each open's R7 log line ("<surface>: opened (warm|cold) via <trigger>: shown X, painted Y,
 *      interactive Z ms"). A surface that does not write one yet is reported "not instrumented yet" and
 *      judged on the OUTSIDE PROBE instead (below), never silently passed;
 *   5. measures the cost of a window a surface keeps hidden after a close (= what keepReady.<x> would cost),
 *      and of the surface while open;
 *   6. re-runs a broken surface once (machine noise) and fails only if the re-run breaks too;
 *   7. prints a table, FAIL lines, and ONE summary line:
 *        perf-budget: P passed, F failed; U not instrumented yet, D no data (slack 1.5x, n 10, machine cpu 23%) -- <what broke>
 *      Exit 0 = every budget kept; 1 = a budget broke (or, with --strict, a surface is not instrumented);
 *      2 = the gate could not run (no instance, a lock never came free).
 *
 * THE OUTSIDE PROBE. This same file, loaded into the test copy's MAIN process with
 * NODE_OPTIONS=--require=<this file> and MANTLE_PERF_PROBE=1 (never in a live Mantle), records every
 * BrowserWindow's create / show / ready-to-show / closed, the renderer's second requestAnimationFrame after a
 * show, every sidecar call and child-process spawn, and serves a localhost-only control port (fire a chord,
 * close or destroy a window, read app metrics). Painted = trigger -> second rAF after show; for a window a
 * --test run creates but never shows (Settings, Task Manager, Files keep hidden in --test), painted =
 * trigger -> ready-to-show (Chromium's first paint of the hidden page). A warm open of a window that is never
 * shown in --test has no outside view: only its R7 line can time it ("no data" until then).
 *
 * MACHINE RULES (Owen's laptop is an i3-1215U with 11.7 GB RAM): unless --no-lock (the caller already holds
 * it), the gate takes %TEMP%\claude-heavytest.mutex (atomic mkdir, owner.txt inside) and then
 * %TEMP%\claude-headless-browser.lock (an exclusive file holding {"pid","time","label"}; a dead pid's lock is
 * stale), waits for them checking every 60 s, waits for >= 2.5 GB free RAM, refuses while a
 * game runs, and runs at Below Normal (the Electron copy inherits it). It stops ONLY its own process tree, by
 * pid, plus tools/kill-test.ps1 for its own --profile-name. Never an image-name kill.
 *
 * SLACK. Every TIME budget is multiplied by --slack (default 1.5: the plan's runner headroom, and what a
 * Below Normal run on this i3 needs while other lanes build; measured 2026-10-15, see PERF.md). The 1 s cold
 * ceiling is Owen's "never" and is NOT scaled. RAM budgets are not scaled (load does not change bytes).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

// ------------------------------------------------------------------ budgets (PERF.md R2, R5, R6)
const BUDGET = {
  warmPaintedP50: 50,        // ms, trigger -> painted, warm
  warmPaintedP95: 100,
  warmInteractiveP95: 150,
  coldPaintedP95: 400,
  coldCeiling: 1000,         // ms, never scaled: no cold open past 1 s (painted or interactive)
  hiddenCpuPct: 0.1,         // % of ONE core, a hidden window at rest (R6 says 0; 0.1 is the sampling floor)
  totalPrivateMB: 650,       // Electron private total at rest with every keepReady flag off (R5)
  liveMainMB: 210,           // the live main process's share of it (live memory lines 10-16: 202-212 MB)
  keptHiddenPrivateMB: 45,   // a window kept hidden after a close = the keepReady cost (R5)
  openPrivateMB: 80,         // a visible surface (R5)
};

/** Owned surfaces. cold: its window is not pre-made, so a cold open exists. close: how its X / toggle closes it. */
const SURFACES = [
  { name: 'settings', match: '/ui/settings/', trigger: { chord: 'Win+I' }, cold: true, close: 'close', noPreload: true },
  { name: 'taskmgr', match: '/ui/taskmgr/', trigger: { chord: 'Ctrl+Shift+Esc' }, cold: true, close: 'close', noPreload: true },
  { name: 'files', match: '/ui/files/', trigger: { chord: 'Win+E' }, cold: true, close: 'close', noPreload: true },
  { name: 'launcher', match: '/ui/launcher/', trigger: { launcher: true }, cold: false, close: 'launcher' },
  { name: 'clipboard', match: '/ui/clipboard/', trigger: { chord: 'Win+V' }, cold: false, close: 'chord' },
  { name: 'notes', match: '/ui/notes/', trigger: { chord: 'Win+Alt+N' }, cold: false, close: 'close' },
];

// ------------------------------------------------------------------ pure helpers (tools/perf-budget.test.js)
/** Nearest-rank quantile, the same rule as mantle-notes/speed-work/measure.js. */
function quantile(a, p) {
  const s = a.filter((x) => typeof x === 'number' && isFinite(x)).sort((u, v) => u - v);
  if (!s.length) return null;
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))];
}
function stats(a) {
  const v = a.filter((x) => typeof x === 'number' && isFinite(x));
  return { n: v.length, p50: quantile(v, 0.5), p95: quantile(v, 0.95), max: v.length ? Math.max(...v) : null };
}

/** Budgets with the slack applied to the time budgets (never to the 1 s ceiling or to RAM). */
function budgets(slack) {
  const s = Number(slack) > 0 ? Number(slack) : 1;
  const r = Object.assign({}, BUDGET);
  for (const k of ['warmPaintedP50', 'warmPaintedP95', 'warmInteractiveP95', 'coldPaintedP95']) r[k] = Math.round(BUDGET[k] * s);
  r.hiddenCpuPct = Math.round(BUDGET.hiddenCpuPct * s * 1000) / 1000;
  r.slack = s;
  return r;
}

/**
 * One R7 open line -> {surface, kind, via, shown, painted, interactive} (ms, null when "-"), or null.
 * Accepts it with or without the "mantle: <feature>: " prefix, "ms" after each number or only the last.
 */
const R7_RE = /(?:^|[\s:])([a-z][\w-]*): opened \((warm|cold)\)(?: via ([^:]+?))?: (.*)$/i;
function parseOpenLine(line) {
  const m = R7_RE.exec(String(line || '').trim());
  if (!m) return null;
  const num = (name) => {
    const x = new RegExp('\\b' + name + '\\s+(-|n/a|\\d+(?:\\.\\d+)?)', 'i').exec(m[4]);
    if (!x) return undefined;
    return /^\d/.test(x[1]) ? Number(x[1]) : null;
  };
  const shown = num('shown'), painted = num('painted'), interactive = num('interactive');
  if (shown === undefined && painted === undefined && interactive === undefined) return null;
  return { surface: m[1].toLowerCase(), kind: m[2].toLowerCase(), via: m[3] ? m[3].trim() : null,
    shown: shown === undefined ? null : shown, painted: painted === undefined ? null : painted,
    interactive: interactive === undefined ? null : interactive };
}

/**
 * Judge one surface x mode. samples: [{created, painted, r7:{kind, painted, interactive}|null, refused}].
 * -> {source: 'r7'|'probe', status: 'pass'|'fail'|'nodata', noinstr, checks:[{what, value, limit, ok}], painted, interactive}
 */
function judgeOpens(mode, samples, b) {
  const ok = samples.filter((s) => !s.refused);
  const withR7 = ok.filter((s) => s.r7);
  const source = withR7.length && withR7.length >= Math.ceil(ok.length / 2) ? 'r7' : 'probe';
  const pick = (s, k) => (source === 'r7' ? (s.r7 ? s.r7[k] : null) : (k === 'painted' ? s.painted : null));
  const painted = stats(ok.map((s) => pick(s, 'painted')));
  const interactive = stats(ok.map((s) => pick(s, 'interactive')));
  const checks = [];
  const add = (what, value, limit) => { if (value !== null && value !== undefined) checks.push({ what, value, limit, ok: value <= limit }); };
  if (mode === 'warm') {
    add('painted p50', painted.p50, b.warmPaintedP50);
    add('painted p95', painted.p95, b.warmPaintedP95);
    add('interactive p95', interactive.p95, b.warmInteractiveP95);
  } else {
    add('painted p95', painted.p95, b.coldPaintedP95);
    add('painted max', painted.max, b.coldCeiling);
    add('interactive max', interactive.max, b.coldCeiling);
  }
  // R7 must be truthful: a line that says "warm" while a new window was made (or "cold" on a reused one)
  for (const s of withR7) {
    if (typeof s.created === 'boolean' && s.r7.kind !== (s.created ? 'cold' : 'warm')) {
      checks.push({ what: `log says "${s.r7.kind}" but ${s.created ? 'a new window was made' : 'the window was reused'}`, value: 1, limit: 0, ok: false });
      break;
    }
  }
  if (samples.length && !ok.length) checks.push({ what: 'opened at all', value: samples.length, limit: 0, ok: false, note: samples[0].refused });
  const status = !checks.length ? 'nodata' : checks.every((c) => c.ok) ? 'pass' : 'fail';
  return { source, noinstr: source !== 'r7', status, checks, painted, interactive, n: samples.length };
}

/** Private MB of the main (Browser) process vs every other process. procs: [{type, privateKB}] */
function splitMain(procs) {
  const mainKB = procs.filter((p) => p.type === 'Browser').reduce((t, p) => t + (p.privateKB || 0), 0);
  const allKB = procs.reduce((t, p) => t + (p.privateKB || 0), 0);
  return { mainPrivateMB: Math.round(mainKB / 1024), windowsPrivateMB: Math.round((allKB - mainKB) / 1024) };
}

/** CPU % of one core between two metric snapshots, per pid. */
function cpuPct(a, b) {
  const out = {};
  const wall = (b.at - a.at) / 1000;
  if (!(wall > 0)) return out;
  const before = new Map(a.procs.map((p) => [p.pid, p.cpuSec]));
  for (const p of b.procs) {
    if (!before.has(p.pid) || typeof p.cpuSec !== 'number' || typeof before.get(p.pid) !== 'number') continue;
    out[p.pid] = Math.round(((p.cpuSec - before.get(p.pid)) / wall) * 100 * 1000) / 1000;
  }
  return out;
}

/** The one summary line (the run-suite verdict reads "<label>: N passed, M failed"). */
function summaryLine(r) {
  const fails = r.checks.filter((c) => !c.ok);
  const head = `perf-budget: ${r.checks.length - fails.length} passed, ${fails.length} failed; ` +
    `${r.noinstr.length} not instrumented yet, ${r.nodata.length} no data ` +
    `(slack ${r.slack}x, n ${r.n}, machine cpu ${r.cpuBefore === null || r.cpuBefore === undefined ? '?' : r.cpuBefore + '%'})`;
  const tail = fails.length ? ' -- ' + fails.slice(0, 4).map((c) => `${c.scope} ${c.what} ${c.value} > ${c.limit}`).join('; ') + (fails.length > 4 ? `; +${fails.length - 4} more` : '')
    : r.noinstr.length ? ' -- not instrumented: ' + r.noinstr.join(', ') : '';
  return head + tail;
}

function parseArgs(argv) {
  const opt = (name, dflt) => {
    const a = argv.find((x) => x === '--' + name || x.startsWith('--' + name + '='));
    if (!a) return dflt;
    return a.includes('=') ? a.slice(a.indexOf('=') + 1) : true;
  };
  const n = Math.max(1, Math.min(50, Number(opt('n', 10)) || 10));
  const slack = Number(opt('slack', 1.5)) > 0 ? Number(opt('slack', 1.5)) : 1.5;
  const only = String(opt('surfaces', '') || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return { n, slack, only, strict: !!opt('strict', false), lock: !opt('no-lock', false), mutex: !opt('no-mutex', false), rerun: !opt('no-rerun', false),
    settleS: Number(opt('settle', 15)) || 15, out: opt('out', ''), json: !!opt('json', false), lockWaitMin: Number(opt('lock-wait', 240)) || 240 };
}

module.exports = { BUDGET, SURFACES, splitMain, quantile, stats, budgets, parseOpenLine, judgeOpens, cpuPct, summaryLine, parseArgs,
  takeFileLock: (...a) => takeFileLock(...a), dropFileLock: (...a) => dropFileLock(...a),
  joinQueue: (...a) => joinQueue(...a), myTurn: (...a) => myTurn(...a), leaveQueue: (...a) => leaveQueue(...a) };

// ------------------------------------------------------------------ the probe (inside the test copy's main)
function installProbe() {
  const Module = require('module');
  const http = require('http');
  const cp = require('child_process');
  delete process.env.NODE_OPTIONS;               // never into the sidecar, PowerShell or any child node
  const events = [];
  let inTrigger = false;                         // true only inside the synchronous tick of a fired chord
  const urls = new Map();                        // window id -> its page url
  const rec = (e) => { e.at = e.at || Date.now(); events.push(e); if (events.length > 20000) events.splice(0, 5000); };
  const urlOf = (wc) => { try { return String(wc.getURL() || '').replace(/\\/g, '/'); } catch (_) { return ''; } };
  for (const k of ['spawn', 'execFile', 'exec', 'fork']) {
    const orig = cp[k];
    if (typeof orig !== 'function') continue;
    cp[k] = function (file) { rec({ kind: 'spawn', what: path.basename(String(file || '')).slice(0, 60), inTrigger }); return orig.apply(this, arguments); };
  }
  let el = null;
  const origLoad = Module._load;
  Module._load = function (req) {
    const r = origLoad.apply(this, arguments);
    if (!el && req === 'electron' && r && r.app && r.BrowserWindow) { el = r; boot(); }
    if (/lib[\\/]sidecar(\.js)?$/.test(req) && r && r.Sidecar && r.Sidecar.prototype && !r.Sidecar.prototype.__perf) {
      const P = r.Sidecar.prototype; P.__perf = true;
      for (const m of ['call', 'send']) {
        if (typeof P[m] !== 'function') continue;
        const o = P[m];
        P[m] = function (cmd) { rec({ kind: 'sc', cmd: String(cmd).slice(0, 60), inTrigger }); return o.apply(this, arguments); };
      }
    }
    return r;
  };

  function frameAfter(win, id, kind, showAt) {
    const js = 'new Promise((r)=>{let d=0;const f=(t)=>{if(!d){d=1;r(t);}};' +
      'requestAnimationFrame(()=>requestAnimationFrame(()=>f(Date.now())));setTimeout(()=>f(-1),2000);})';
    win.webContents.executeJavaScript(js, true).then((t) => {
      rec({ kind, id, url: urls.get(id), at: t > 0 ? t : Date.now(), timedOut: !(t > 0), showAt });
    }, () => {});
  }

  function boot() {
    const { app, BrowserWindow } = el;
    app.on('browser-window-created', (_e, win) => {
      const id = win.id;
      rec({ kind: 'created', id });
      const seen = () => { const u = urlOf(win.webContents); if (u) urls.set(id, u); return u; };
      win.webContents.on('did-start-navigation', () => seen());
      win.webContents.on('did-finish-load', () => rec({ kind: 'loaded', id, url: seen() }));
      win.once('ready-to-show', () => rec({ kind: 'rts', id, url: seen() }));
      win.on('show', () => { const at = Date.now(); rec({ kind: 'show', id, url: seen(), at }); frameAfter(win, id, 'frame', at); });
      win.on('hide', () => rec({ kind: 'hide', id, url: seen() }));
      win.on('closed', () => rec({ kind: 'closed', id, url: urls.get(id) }));
    });
    const wins = (match) => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && (!match || urlOf(w.webContents).includes(match)));
    const winInfo = (w) => { let pid = null; try { pid = w.webContents.getOSProcessId(); } catch (_) { /* gone */ }
      return { id: w.id, url: urlOf(w.webContents), visible: w.isVisible(), pid }; };
    const routes = {
      ping: () => ({ ok: true, now: Date.now() }),
      fire: (q) => {
        const argv = [process.execPath, '.', '--test', '--test-chord=' + q.chord];
        const t0 = Date.now();
        inTrigger = true;                       // sidecar calls made in this same tick are the open path's own
        try { app.emit('second-instance', { preventDefault() {} }, argv, process.cwd()); } finally { inTrigger = false; }
        return { t0 };
      },
      // the other existing test hooks, allow-listed: --test-unload (every idle-unloadable window goes now, as
      // 10 unused minutes would: the steady state a live shell sits in) and --test-memory=<tag>
      hook: (q) => {
        if (!/^--test-(unload|memory=[\w-]{1,30})$/.test(String(q.arg))) return { error: 'not an allowed hook' };
        app.emit('second-instance', { preventDefault() {} }, [process.execPath, '.', '--test', q.arg], process.cwd());
        return { ok: true };
      },
      launcher: (q) => {
        const bar = wins('/ui/bar/')[0];
        if (!bar) return { error: 'no bar window' };
        const t0 = Date.now();
        bar.webContents.executeJavaScript(`mantle.call(${JSON.stringify(q.op === 'hide' ? 'launcher.hide' : 'launcher.show')})`, true).catch(() => {});
        return { t0 };
      },
      close: (q) => { const w = wins(q.match); for (const x of w) x.close(); return { n: w.length }; },
      destroy: (q) => { const w = wins(q.match); for (const x of w) x.destroy(); return { n: w.length }; },
      windows: () => ({ windows: wins().map(winInfo) }),
      metrics: () => ({
        at: Date.now(),
        procs: app.getAppMetrics().map((p) => ({ pid: p.pid, type: p.type, name: p.name || null,
          privateKB: (p.memory && p.memory.privateBytes) || 0, wsKB: (p.memory && p.memory.workingSetSize) || 0,
          cpuSec: p.cpu && typeof p.cpu.cumulativeCPUUsage === 'number' ? p.cpu.cumulativeCPUUsage : null })),
        windows: wins().map(winInfo),
      }),
      events: (q) => {
        const since = Number(q.since) || 0;
        return { now: Date.now(), events: events.filter((e) => e.at >= since).map((e) => Object.assign({}, e, { url: e.url || urls.get(e.id) || '' })) };
      },
    };
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      const fn = routes[u.pathname.slice(1)];
      let body;
      try { body = fn ? fn(Object.fromEntries(u.searchParams)) : { error: 'no such route' }; } catch (err) { body = { error: String(err && err.message) }; }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
    });
    server.listen(0, '127.0.0.1', () => {
      const file = process.env.MANTLE_PERF_PORT_FILE;
      if (file) { try { fs.writeFileSync(file, String(server.address().port)); } catch (_) { /* the gate times out and says so */ } }
      process.stdout.write(`mantle: perf probe: listening on 127.0.0.1:${server.address().port} (test only)\n`);
    });
    server.unref();
  }
}

// ------------------------------------------------------------------ the gate (CLI)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let onCrash = null;   // set by cli(): stop the test copy and drop the locks on any throw

function cpuSample(ms) {
  const t = () => os.cpus().reduce((acc, c) => { const v = c.times; acc.idle += v.idle; acc.all += v.user + v.nice + v.sys + v.idle + v.irq; return acc; }, { idle: 0, all: 0 });
  const a = t();
  return sleep(ms).then(() => { const b = t(); return Math.round(1000 * (1 - (b.idle - a.idle) / (b.all - a.all))) / 10; });
}

const GAME_RE = /^(VALORANT[\w-]*|RiotClient\w*|LeagueClient\w*|League of Legends|FortniteClient[\w-]*|cs2|RocketLeague|r5apex|javaw|Minecraft[\w.]*)\.exe$/i;
function gameRunning() {
  const { spawnSync } = require('child_process');
  const r = spawnSync('tasklist.exe', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
  for (const l of String(r.stdout || '').split(/\r?\n/)) { const m = /^"([^"]+)"/.exec(l); if (m && GAME_RE.test(m[1])) return m[1]; }
  return null;
}

function takeDirLock(dir, owner) {
  try { fs.mkdirSync(dir); } catch (_) { return false; }
  try { fs.writeFileSync(path.join(dir, 'owner.txt'), owner + '\n'); } catch (_) { /* the lock is the dir */ }
  return true;
}
function dropDirLock(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* someone else's now */ } }
function lockOwner(dir) { try { return fs.readFileSync(path.join(dir, 'owner.txt'), 'utf8').trim().slice(0, 160); } catch (_) { return '?'; } }

/* The heavy-test queue (the lanes' protocol): %TEMP%\claude-heavytest.queue\<n>-<lane>, holding "<n>-queued
   HH:MM:SS". Join with the next number; take the mutex only when no live ticket has a lower number; leave the
   queue once the mutex is ours. An integrate ticket goes first whatever its number. A ticket untouched for 3 h is a dead lane's and is not waited for. */
const QUEUE_STALE_MS = 3 * 3600 * 1000;
function queueDir() { return path.join(os.tmpdir(), 'claude-heavytest.queue'); }
function queueTickets(dir) {
  const q = dir || queueDir();
  let names = [];
  try { names = fs.readdirSync(q); } catch (_) { return []; }
  return names.map((name) => {
    const m = /^(\d+)-/.exec(name);
    if (!m) return null;
    let age = 0;
    try { age = Date.now() - fs.statSync(path.join(q, name)).mtimeMs; } catch (_) { return null; }
    return { n: Number(m[1]), name, age };
  }).filter(Boolean);
}
function joinQueue(label, dir) {
  const q = dir || queueDir();
  try { fs.mkdirSync(q, { recursive: true }); } catch (_) { return null; }
  for (let k = 0; k < 20; k++) {
    const n = Math.max(0, ...queueTickets(q).map((t) => t.n)) + 1;
    const name = `${n}-${label}`;
    try { fs.writeFileSync(path.join(q, name), `${n}-queued ${new Date().toTimeString().slice(0, 8)}\n`, { flag: 'wx' }); return { n, name, dir: q }; } catch (_) { /* raced: next number */ }
  }
  return null;
}
function myTurn(t) {
  return !queueTickets(t.dir).some((x) => x.name !== t.name && x.age < QUEUE_STALE_MS && (x.n < t.n || /integrate/i.test(x.name)));
}
function leaveQueue(t) { try { fs.rmSync(path.join(t.dir, t.name), { force: true }); } catch (_) { /* gone */ } }

/* The browser lock is a FILE, created exclusively, holding {"pid","time","label"} (the protocol the other
   lanes' headless runs use). A lock whose pid is gone is stale and is taken over. */
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
function takeFileLock(file, label) {
  const body = JSON.stringify({ pid: process.pid, time: Date.now(), label });
  try { fs.writeFileSync(file, body, { flag: 'wx' }); return true; } catch (_) { /* held, or stale */ }
  let cur = null;
  try { cur = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return false; }   // being written: next round
  if (cur && Number(cur.pid) > 0 && !pidAlive(Number(cur.pid))) {
    try { fs.rmSync(file, { force: true }); fs.writeFileSync(file, body, { flag: 'wx' }); return true; } catch (_) { return false; }
  }
  return false;
}
function dropFileLock(file) {
  try { const cur = JSON.parse(fs.readFileSync(file, 'utf8')); if (cur && cur.pid === process.pid) fs.rmSync(file, { force: true }); } catch (_) { /* not ours */ }
}
function fileLockOwner(file) { try { const c = JSON.parse(fs.readFileSync(file, 'utf8')); return `${c.label} pid ${c.pid}`; } catch (_) { return '?'; } }

async function cli() {
  const { spawn, spawnSync } = require('child_process');
  const A = parseArgs(process.argv.slice(2));
  const B = budgets(A.slack);
  const ROOT = path.resolve(__dirname, '..');
  const LANE = path.basename(ROOT).replace(/[^A-Za-z0-9_-]/g, '') || 'gate';
  const PROFILE = 'perfgate-' + LANE;
  const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const OUT = A.out ? path.resolve(String(A.out)) : path.join(os.tmpdir(), 'mantle-perf-' + LANE, STAMP + '.json');
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const say = (s) => console.log(s);
  const surfaces = SURFACES.filter((s) => !A.only.length || A.only.includes(s.name));
  const result = { root: ROOT, at: new Date().toISOString(), slack: A.slack, n: A.n, budgets: B, checks: [], noinstr: [], nodata: [], surfaces: {}, idle: {} };
  const locks = [];
  let child = null;
  let logFd = null;
  const finish = (code, why) => {
    if (child && child.exitCode === null) {
      spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    }
    spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'tools', 'kill-test.ps1'), '-Match', PROFILE], { stdio: 'ignore', windowsHide: true });
    for (const drop of locks.reverse()) drop();
    if (logFd !== null) { try { fs.closeSync(logFd); } catch (_) { /* closed */ } logFd = null; }
    if (why) result.error = why;
    try { fs.writeFileSync(OUT, JSON.stringify(result, null, 1)); } catch (_) { /* printed anyway */ }
    if (code === 2) say(`perf-budget: 0 passed, 1 failed; could not run: ${why}`);
    process.exitCode = code;
  };
  onCrash = (err) => finish(2, `crashed: ${err && err.stack || err}`);

  // ---- the machine rules: game, locks, RAM, priority, a quiet CPU
  const game = gameRunning();
  if (game) return finish(2, `a game is running (${game}); the gate never runs beside one`);
  try { os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch (_) { /* best effort; said below */ }
  if (A.lock && A.mutex) {
    const owner = `perf-budget pid ${process.pid} (${ROOT}) at ${new Date().toISOString()}`;
    const until = Date.now() + A.lockWaitMin * 60000;
    const mutex = path.join(os.tmpdir(), 'claude-heavytest.mutex');
    // the lanes' queue: a ticket "<n>-<lane>" in %TEMP%\claude-heavytest.queue; the lowest live ticket goes next
    const ticket = joinQueue('perfgate-' + LANE);
    if (ticket) locks.push(() => leaveQueue(ticket));
    let said = 0;
    while (!((!ticket || myTurn(ticket)) && takeDirLock(mutex, owner))) {
      if (Date.now() > until) return finish(2, `claude-heavytest.mutex stayed held for ${A.lockWaitMin} min (owner: ${lockOwner(mutex)})`);
      if (said++ % 10 === 0) say(`perf-budget: waiting for claude-heavytest.mutex (held by: ${lockOwner(mutex)}; queue ticket ${ticket ? ticket.name : 'none'}); checking every 60 s`);
      await sleep(60000);
    }
    if (ticket) leaveQueue(ticket);
    locks.push(() => dropDirLock(mutex));
  }
  if (A.lock) {
    const until = Date.now() + A.lockWaitMin * 60000;
    let said = 0;
    const blk = path.join(os.tmpdir(), 'claude-headless-browser.lock');
    while (!takeFileLock(blk, `perf-budget (${LANE})`)) {
      if (Date.now() > until) return finish(2, `claude-headless-browser.lock stayed held for ${A.lockWaitMin} min (owner: ${fileLockOwner(blk)})`);
      if (said++ % 10 === 0) say(`perf-budget: waiting for claude-headless-browser.lock (held by: ${fileLockOwner(blk)}); checking every 60 s`);
      await sleep(60000);
    }
    locks.push(() => dropFileLock(blk));
  }
  for (let i = 0; os.freemem() < 2.5 * 1024 ** 3; i++) {
    if (i >= 30) return finish(2, `under 2.5 GB free RAM for 30 min (${(os.freemem() / 1024 ** 3).toFixed(1)} GB)`);
    say(`perf-budget: ${(os.freemem() / 1024 ** 3).toFixed(1)} GB free RAM, waiting for 2.5 GB (checking every 60 s)`);
    await sleep(60000);
  }
  result.cpuBefore = await cpuSample(3000);
  for (let i = 0; i < 40 && result.cpuBefore > 45; i++) result.cpuBefore = await cpuSample(5000);   // up to ~3.5 min for a quieter machine
  result.freeGBBefore = Math.round(os.freemem() / 1024 ** 3 * 10) / 10;

  // ---- the invisible test copy, with the probe in its main process
  const portFile = path.join(os.tmpdir(), `mantle-perf-port-${PROFILE}.txt`);
  try { fs.rmSync(portFile, { force: true }); } catch (_) { /* fresh */ }
  const env = Object.assign({}, process.env, {
    NODE_OPTIONS: `--require=${__filename.replace(/\\/g, '/')}`, MANTLE_PERF_PROBE: '1', MANTLE_PERF_PORT_FILE: portFile,
  });
  delete env.MANTLE_TEST_VISIBLE;
  delete env.ELECTRON_RUN_AS_NODE;
  const ownExe = path.join(ROOT, 'sidecar', 'bin', 'Mantle.Sidecar.exe');
  if (!process.env.MANTLE_SIDECAR_EXE && fs.existsSync(ownExe)) env.MANTLE_SIDECAR_EXE = ownExe;
  const exe = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  if (!fs.existsSync(exe)) return finish(2, `no Electron at ${exe} (node_modules missing?)`);
  const lines = [];
  const logFile = OUT.replace(/\.json$/, '.log');
  logFd = fs.openSync(logFile, 'w');
  child = spawn(exe, ['.', '--test', `--profile-name=${PROFILE}`, '--test-live-bar'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const onData = (buf) => {
    const at = Date.now();
    try { if (logFd !== null) fs.writeSync(logFd, buf); } catch (_) { /* closed at the end */ }
    for (const l of String(buf).split(/\r?\n/)) if (l.trim()) lines.push({ at, line: l });
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  const t00 = Date.now();
  let port = null;
  while (!port && Date.now() - t00 < 60000 && child.exitCode === null) {
    try { port = Number(fs.readFileSync(portFile, 'utf8')) || null; } catch (_) { await sleep(200); }
  }
  if (!port) return finish(2, child.exitCode !== null ? `the test copy exited (${child.exitCode}); see ${logFile}` : `the probe never answered in 60 s (NODE_OPTIONS --require refused?); see ${logFile}`);
  const api = async (route, q) => {
    const u = `http://127.0.0.1:${port}/${route}` + (q ? '?' + new URLSearchParams(q) : '');
    const r = await fetch(u); return r.json();
  };
  while (!lines.some((l) => /features: started/.test(l.line)) && Date.now() - t00 < 90000 && child.exitCode === null) await sleep(250);
  if (child.exitCode !== null) return finish(2, `the test copy exited (${child.exitCode}) while starting; see ${logFile}`);
  result.startMs = Date.now() - t00;
  await sleep(A.settleS * 1000);

  const check = (scope, what, value, limit, extra) => {
    const c = Object.assign({ scope, what, value, limit, ok: value <= limit }, extra || {});
    result.checks.push(c); return c;
  };
  const surfaceWins = (ws, s) => ws.filter((w) => w.url.includes(s.match));

  // ---- 1. nothing pre-made (keepReady.* default false)
  let ws = (await api('windows')).windows;
  for (const s of surfaces.filter((x) => x.noPreload)) check(s.name, 'hidden windows at rest (keepReady off)', surfaceWins(ws, s).length, 0);

  // ---- 2. idle: total private RAM, hidden windows' CPU
  const idleSample = async (label) => {
    const a = await api('metrics');
    await sleep(10000);
    const b = await api('metrics');
    const pct = cpuPct(a, b);
    const totalMB = Math.round(b.procs.reduce((t, p) => t + p.privateKB, 0) / 1024);
    const hidden = b.windows.filter((w) => !w.visible && w.pid).map((w) => {
      const shared = b.windows.some((x) => x.pid === w.pid && x.visible);
      const p = b.procs.find((x) => x.pid === w.pid);
      return { page: (w.url.split('/ui/')[1] || w.url).replace(/\?.*$/, ''), pid: w.pid, cpuPct: pct[w.pid], shared,
        privateMB: p ? Math.round(p.privateKB / 1024) : null, wsMB: p ? Math.round(p.wsKB / 1024) : null };
    });
    const visibleCount = b.windows.filter((w) => w.visible).length;
    result.idle[label] = { totalPrivateMB: totalMB, hidden, visibleWindows: visibleCount, cpuMeasured: Object.keys(pct).length > 0 };
    return result.idle[label];
  };
  const idle0 = await idleSample('atRest');
  result.atRestTotalMB = idle0.totalPrivateMB;   // the --test copy's whole total (information only)
  if (!idle0.cpuMeasured) result.noinstr.push('hidden-window CPU (no cumulativeCPUUsage in app metrics)');
  // RAM at rest. A --test copy's MAIN process is not the live one's size: measured 10-16, a plain --test copy
  // (no probe) 479 MB, with the probe 455 / 458 / 373 MB, the live shell 202-212 MB (its own memory lines, at
  // 30 s and after hours). Every other process matched live: 341-355 MB in --test, 353-355 MB live. So the
  // gate judges everything EXCEPT the main process against the total less the live main's share, and only
  // reports the main process (the live total is the 30-min memory line's job).
  const rest = await api('metrics');
  Object.assign(result, splitMain(rest.procs));
  check('mantle', 'private at rest, every process but main (MB)', result.windowsPrivateMB, B.totalPrivateMB - B.liveMainMB);

  // ---- 3. opens
  const r7For = (s, since) => {
    for (const l of lines) {
      if (l.at < since) continue;
      const p = parseOpenLine(l.line);
      if (p && p.surface === s.name) return p;
    }
    return null;
  };
  const trigger = async (s, op) => (s.trigger.launcher ? api('launcher', { op: op || 'show' }) : api('fire', { chord: s.trigger.chord }));
  const closeIt = async (s) => {
    if (s.close === 'launcher') return api('launcher', { op: 'hide' });
    if (s.close === 'chord') return api('fire', { chord: s.trigger.chord });
    return api('close', { match: s.match });
  };
  const openOnce = async (s, mode) => {
    const since = Date.now();
    const r = await trigger(s);
    const t0 = r.t0 || since;
    const limit = mode === 'cold' ? 10000 : 5000;
    let probeDoneAt = null, r7 = null, r7At = null, ev = [];
    for (;;) {
      await sleep(25);
      ev = (await api('events', { since: t0 })).events;
      const createdIds = new Set(ev.filter((e) => e.kind === 'created').map((e) => e.id));
      const mine = ev.filter((e) => e.url && e.url.includes(s.match));
      const fr = mine.find((e) => e.kind === 'frame');
      const rts = mine.find((e) => e.kind === 'rts' && createdIds.has(e.id));
      if (!probeDoneAt && (fr || rts)) probeDoneAt = Date.now();
      if (!r7) { r7 = r7For(s, since); if (r7) r7At = Date.now(); }
      const waited = Date.now() - since;
      if (probeDoneAt && r7) break;
      if (probeDoneAt && Date.now() - probeDoneAt > 1500) break;
      if (r7 && Date.now() - r7At > 1500) break;
      if (!probeDoneAt && !r7 && mode === 'warm' && waited > 2500) break;
      if (waited > limit) break;
    }
    const createdIds = new Set(ev.filter((e) => e.kind === 'created').map((e) => e.id));
    const mine = ev.filter((e) => e.url && e.url.includes(s.match));
    const show = mine.find((e) => e.kind === 'show');
    const fr = mine.find((e) => e.kind === 'frame');
    const rts = mine.find((e) => e.kind === 'rts' && createdIds.has(e.id));
    const created = mine.some((e) => createdIds.has(e.id));
    const paintedAt = fr ? fr.at : rts ? rts.at : null;
    const before = (e) => paintedAt !== null && e.at <= paintedAt;
    const refusedLine = s.trigger.chord ? lines.find((l) => l.at >= since && l.line.includes(`${s.trigger.chord} from a second instance`) && /"ok":false|refused/.test(l.line)) : null;
    return {
      mode, created,
      shown: show ? show.at - t0 : null,
      painted: paintedAt !== null ? paintedAt - t0 : null,
      paintedHow: fr ? 'frame after show' : rts ? 'ready-to-show (not shown in --test)' : null,
      r7, refused: refusedLine && !paintedAt && !r7 ? refusedLine.line.slice(0, 200) : null,
      sidecarBefore: ev.filter((e) => e.kind === 'sc' && e.inTrigger && before(e)).map((e) => e.cmd),
      spawnsBefore: ev.filter((e) => e.kind === 'spawn' && e.inTrigger && before(e)).map((e) => e.what),
    };
  };
  const procOf = async (s) => {
    const m = await api('metrics');
    const w = surfaceWins(m.windows, s)[0];
    const p = w && m.procs.find((x) => x.pid === w.pid);
    return p ? { privateMB: Math.round(p.privateKB / 1024), wsMB: Math.round(p.wsKB / 1024), visible: w.visible } : null;
  };

  const runMode = async (s, mode) => {
    const samples = [];
    if (mode === 'warm') { await trigger(s); await sleep(1500); await closeIt(s); await sleep(900); }   // prime
    for (let i = 0; i < A.n; i++) {
      if (mode === 'cold') { await api('destroy', { match: s.match }); await sleep(1000); }
      const smp = await openOnce(s, mode);
      if (i === A.n - 1) { await sleep(500); smp.openCost = await procOf(s); }
      samples.push(smp);
      await sleep(400);
      await closeIt(s);
      await sleep(900);
      if (mode === 'warm' && i === 0) {
        const left = surfaceWins((await api('windows')).windows, s);
        if (!left.length) return { samples, noWarmPath: true };
      }
    }
    return { samples };
  };

  const judgeSurface = (s, mode, run) => {
    if (run.noWarmPath) return { status: 'nodata', note: 'no warm path: a close destroys the window', n: run.samples.length };
    const samples = mode === 'warm' ? run.samples.filter((x) => !x.created) : run.samples;
    const j = judgeOpens(mode, samples, B);
    j.sidecarBeforePaint = [...new Set(run.samples.flatMap((x) => x.sidecarBefore))];
    j.spawnsBeforePaint = [...new Set(run.samples.flatMap((x) => x.spawnsBefore))];
    j.paintedHow = [...new Set(run.samples.map((x) => x.paintedHow).filter(Boolean))];
    if (mode === 'warm' && run.samples.length - samples.length) j.note = `${run.samples.length - samples.length} of ${run.samples.length} "warm" opens made a new window`;
    return j;
  };

  for (const s of surfaces) {
    result.surfaces[s.name] = {};
    for (const mode of (s.cold ? ['cold', 'warm'] : ['warm'])) {
      let run = await runMode(s, mode);
      let j = judgeSurface(s, mode, run);
      if (j.status === 'fail' && A.rerun) {
        const first = j;
        run = await runMode(s, mode);
        j = judgeSurface(s, mode, run);
        j.rerun = { firstStatus: first.status, firstChecks: first.checks };
      }
      j.samples = run.samples;
      result.surfaces[s.name][mode] = j;
      const scope = `${s.name} ${mode}`;
      for (const c of j.checks || []) check(scope, c.what + (j.source === 'probe' ? ' (probe)' : ''), c.value, c.limit);
      if (j.status === 'nodata') result.nodata.push(scope + (j.note ? ` (${j.note})` : ' (no outside view in --test and no R7 line)'));
      else if (j.noinstr) result.noinstr.push(scope);
      const last = run.samples[run.samples.length - 1];
      if (last && last.openCost && mode === (s.cold ? 'cold' : 'warm')) check(s.name, 'private MB while open', last.openCost.privateMB, B.openPrivateMB);
    }
    // what keeping it hidden costs (= keepReady.<x> on): its window after a close, if it is kept
    if (s.noPreload) {
      await sleep(1500);
      const kept = await procOf(s);
      result.surfaces[s.name].keptAfterClose = kept;
      if (kept && !kept.visible) check(s.name, 'kept hidden after close: private MB (keepReady cost)', kept.privateMB, B.keptHiddenPrivateMB);
    }
  }

  // ---- 4. idle again, with whatever the surfaces kept after their closes
  const idle1 = await idleSample('afterCloses');
  // hidden-window CPU: a page seen in both samples is judged on the LOWER one (the first sample is ~20 s after
  // start and catches start-up work; 10-16: taskview 0.224 % then 0 %); a page seen once is judged on that one
  const pages = new Map();
  for (const h of idle0.hidden.concat(idle1.hidden)) {
    if (typeof h.cpuPct !== 'number' || h.shared) continue;
    const was = pages.get(h.page);
    pages.set(h.page, was === undefined ? h.cpuPct : Math.min(was, h.cpuPct));
  }
  for (const [page, pct] of pages) check('hidden ' + page, 'idle CPU (% of a core, lower of two 10 s samples)', pct, B.hiddenCpuPct);
  result.cpuEnd = await cpuSample(2000);


  // ---- report
  const f = (v) => (v === null || v === undefined ? '-' : String(v));
  say(`perf-budget: ${ROOT} (${new Date().toISOString()}), slack ${A.slack}x, n ${A.n}, machine cpu ${result.cpuBefore}% before / ${result.cpuEnd}% after, ${result.freeGBBefore} GB free, start ${result.startMs} ms`);
  say(`  at rest: every process but main ${result.windowsPrivateMB} MB (budget ${B.totalPrivateMB - B.liveMainMB}); main ${result.mainPrivateMB} MB (--test main, reported only; live ~${B.liveMainMB})`);
  say(`  at rest, fresh: hidden: ${idle0.hidden.map((h) => `${h.page} ${f(h.privateMB)} MB ${f(h.cpuPct)}%`).join(', ') || 'none'}`);
  for (const [name, m] of Object.entries(result.surfaces)) {
    for (const mode of ['cold', 'warm']) {
      const j = m[mode]; if (!j) continue;
      const src = j.status === 'nodata' ? 'no data' : j.source === 'r7' ? 'R7 line' : 'NOT INSTRUMENTED YET, outside probe';
      say(`  ${name.padEnd(9)} ${mode}: painted p50 ${f(j.painted && j.painted.p50)} p95 ${f(j.painted && j.painted.p95)} max ${f(j.painted && j.painted.max)}` +
        `, interactive p95 ${f(j.interactive && j.interactive.p95)} (n ${j.n}; ${src}${j.paintedHow && j.paintedHow.length ? '; ' + j.paintedHow.join('/') : ''})` +
        ` ${j.status.toUpperCase()}${j.rerun ? ' after a re-run' : ''}${j.note ? ' - ' + j.note : ''}` +
        (j.sidecarBeforePaint && j.sidecarBeforePaint.length ? ` | sidecar asked in the trigger's own tick: ${j.sidecarBeforePaint.join(',')}` : '') +
        (j.spawnsBeforePaint && j.spawnsBeforePaint.length ? ` | spawned in the trigger's own tick: ${j.spawnsBeforePaint.join(',')}` : ''));
    }
    if (m.keptAfterClose !== undefined) say(`  ${name.padEnd(9)} after close: ${m.keptAfterClose ? `kept ${m.keptAfterClose.visible ? 'VISIBLE' : 'hidden'}, ${m.keptAfterClose.privateMB} MB private / ${m.keptAfterClose.wsMB} MB ws` : 'destroyed (nothing kept)'}`);
  }
  say(`  after closes: electron private ${idle1.totalPrivateMB} MB; hidden: ${idle1.hidden.map((h) => `${h.page} ${f(h.privateMB)} MB ${f(h.cpuPct)}%`).join(', ') || 'none'}`);
  for (const c of result.checks.filter((x) => !x.ok)) say(`FAIL ${c.scope}: ${c.what} ${c.value} > ${c.limit}`);
  for (const n of result.noinstr) say(`  not instrumented yet: ${n} (no "<surface>: opened (warm|cold) via ...: shown X, painted Y, interactive Z ms" line; judged on the outside probe)`);
  for (const n of result.nodata) say(`  no data: ${n}`);
  say(`  json ${OUT}; log ${logFile}`);
  const line = summaryLine(result);
  result.summary = line;
  say(line);
  const broke = result.checks.some((c) => !c.ok) || (A.strict && result.noinstr.length > 0);
  finish(broke ? 1 : 0);
}

if (process.versions.electron && process.type === 'browser' && process.env.MANTLE_PERF_PROBE === '1') installProbe();
else if (require.main === module) {
  cli().catch((err) => {
    if (onCrash) onCrash(err);
    else { console.log(`perf-budget: 0 passed, 1 failed; crashed: ${err && err.stack || err}`); process.exitCode = 2; }
  });
}
