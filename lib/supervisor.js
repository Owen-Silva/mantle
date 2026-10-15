'use strict';
/*
 * supervisor.js -- main's half of crash recovery (lane mantle-supervisor, 2026-10-15).
 *
 * THE GAP: on 10-14 at 20:11 Mantle's main process crashed (0xc000041d) and stayed down 14 minutes,
 * until a reboot. The logon task's RestartOnFailure never fires for that (Task Scheduler only retries a
 * task that failed to START), and main's own uncaughtException restart cannot run when main itself is gone.
 *
 * THE DESIGN: a tiny watcher outside main. `Mantle.Sidecar.exe --supervise=<main pid>` (sidecar/Supervisor.cs)
 * is spawned DETACHED, so it is not in libuv's kill-on-close job and outlives main. It owns nothing (no
 * window, no hook, no shell state) and only waits on main's process handle. When main dies it reads
 * <userData>/supervisor-main.json, which ONLY main writes:
 *   - standDown {why} for that pid = a deliberate quit: it exits and starts nothing;
 *   - otherwise a crash: it starts main again (same exe, args, folder) and watches the new one itself;
 *     the 3rd crash inside 2 minutes = a crash loop: no retry, the Windows taskbar put back
 *     (tools/restore-windows.ps1 -NoKill) and a dialog that says why.
 * It writes <userData>/supervisor-state.json (ONLY it writes that), which the next main reads to tell Owen once.
 *
 * Why not the other two options:
 *   - Task Scheduler restart-on-failure: proven not to fire (10-14), and golive.ps1 does not re-register the task.
 *   - The C# sidecar relaunching main: the sidecar is main's child and by design exits when main dies
 *     (Program.cs rule 2: it must not outlive main), and a crash that takes main often takes it too.
 *
 * WHO WATCHES THE WATCHER: main. A supervisor it spawned is a child ('exit' event); one that started
 * THIS main (env MANTLE_SUPERVISOR_PID) is adopted and polled. If it goes away while main is not
 * quitting, main starts a new one (at most 3 in 10 minutes).
 *
 * WHICH INSTANCES: --live always (unless --no-supervise); --test only with --supervise (an e2e opts in;
 * every other test kills its instance on purpose and must never see it come back).
 */

const WINDOW_MS = 120000;
const MAX_CRASHES = 3;
const MAIN_FILE = 'supervisor-main.json';
const STATE_FILE = 'supervisor-state.json';
const NOTICE_MAX_AGE_MS = 10 * 60 * 1000;
const RESPAWN_MAX = 3;
const RESPAWN_WINDOW_MS = 10 * 60 * 1000;
const ADOPT_POLL_MS = 10000;

/** -> {on, why}: whether this instance gets a supervisor. */
function wanted(flags) {
  const f = flags || {};
  if (f.noSupervise) return { on: false, why: 'started with --no-supervise' };
  if (f.live) return { on: true, why: 'live' };
  if (f.test && f.supervise) return { on: true, why: 'test instance started with --supervise' };
  if (f.test) return { on: false, why: 'test instance (crash recovery is opt-in there: --supervise)' };
  return { on: false, why: 'neither --live nor --test' };
}

/** NTSTATUS / exit code -> "0xC000041D"; null for none. */
function codeHex(code) {
  if (typeof code !== 'number' || !Number.isFinite(code)) return null;
  return `0x${(code >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
}

/*
 * Plain words for how main stopped. The SAME table as sidecar/Supervisor.cs ExitWords (its give-up dialog
 * says them too); lib/supervisor.test.js reads both and checks they agree.
 */
const EXIT_WORDS = {
  '0xC000041D': 'it crashed while Windows was calling into one of its windows',
  '0xC0000005': 'it crashed reading memory it did not own',
  '0x80000003': 'it stopped on an internal check that failed',
  '0xC0000409': 'it stopped itself on a safety check',
  '0xC00000FD': 'it ran out of stack space',
  '0xE0000008': 'it ran out of memory',
  '0xC0000017': 'it ran out of memory',
  '0x00000001': 'it was ended by another program (or Task Manager) or stopped with an error',
};
const CODE_ERROR_WORDS = "an error in Mantle's own code";
function exitWords(code, what) {
  if (what) return CODE_ERROR_WORDS;
  const hex = codeHex(code);
  return (hex && EXIT_WORDS[hex]) || 'it stopped unexpectedly';
}

function hhmm(t) {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/*
 * What the next start tells Owen, once: null, or {at, title, words, tray, log}.
 * state = supervisor-state.json; told = the `at` already told (from supervisor-main.json).
 * A restart = "Mantle restarted after a crash"; a crash loop it gave up on = "Mantle had stopped".
 */
function noticeFor(state, told, now) {
  const s = state && typeof state === 'object' ? state : {};
  const seen = typeof told === 'number' ? told : 0;
  const fresh = (x) => x && typeof x.at === 'number' && x.at > seen && x.at <= now + 5000 && now - x.at < NOTICE_MAX_AGE_MS;
  const g = s.gaveUp;
  const l = s.last;
  // The newest of the two wins; a give-up is newer than the restarts that led to it.
  if (fresh(g) && (!fresh(l) || g.at >= l.at)) {
    const words = g.words || 'it stopped unexpectedly';
    const n = g.count || MAX_CRASHES;
    const loop = g.startFailed ? `it could not be started again (${g.startFailed})` : `it stopped ${n} times in ${Math.round((g.windowMs || WINDOW_MS) / 60000)} minutes`;
    return {
      at: g.at,
      title: 'Mantle had stopped after repeated crashes',
      words: `${loop}, so it was not started again until now; the last time ${words}`,
      tray: `Stopped after repeated crashes at ${hhmm(g.at)}`,
      log: `crash recovery: Mantle had stopped at ${hhmm(g.at)}: ${loop} (last exit ${g.codeHex || 'unknown'}: ${words}); the Windows taskbar was put back: ${(g.restore && g.restore.result) || 'no result was recorded'}`,
    };
  }
  if (fresh(l) && l.restarted) {
    const words = l.words || 'it stopped unexpectedly';
    const secs = typeof l.startedInMs === 'number' ? Math.max(1, Math.round(l.startedInMs / 1000)) : null;
    return {
      at: l.at,
      title: 'Mantle restarted after a crash',
      words: `${words} at ${hhmm(l.at)}${secs ? `; it was started again ${secs} s later` : ''}`,
      tray: `Restarted by itself after a crash at ${hhmm(l.at)}`,
      log: `crash recovery: Mantle restarted after a crash: the previous main process (pid ${l.oldPid}) stopped at ${hhmm(l.at)}, exit ${l.codeHex || 'unknown'}: ${words}${l.what ? ` (${l.what})` : ''}; this one was started ${l.startedInMs} ms later by the supervisor`,
    };
  }
  return null;
}

/*
 * o: { fs, path, spawn, alive(pid)->bool, kill(pid), now()->ms, log(line), setInterval, clearInterval,
 *      pid, execPath, argv (process.argv.slice(1)), cwd, root, userData, exePath, flags, env }
 */
function makeSupervisor(o) {
  const fs = o.fs;
  const path = o.path;
  const now = o.now || Date.now;
  const log = o.log || (() => {});
  const mainFile = path.join(o.userData, MAIN_FILE);
  const stateFile = path.join(o.userData, STATE_FILE);
  let rec = null;              // what main last wrote to supervisor-main.json
  let sup = null;              // { pid, via: 'spawned'|'adopted', child?, timer? }
  let on = false;
  let offWhy = 'not started';
  let stopped = false;         // standDown: no new supervisor from here on
  const respawns = [];

  function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
  }
  function writeRec() {
    const tmp = `${mainFile}.tmp-${o.pid}`;
    fs.mkdirSync(o.userData, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(rec));
    fs.renameSync(tmp, mainFile);
  }

  function watchSpawned(child) {
    child.once('exit', (code) => {
      if (!sup || sup.child !== child) return;
      sup = null;
      lost(`it exited (code ${code})`);
    });
  }
  function watchAdopted(pid) {
    const timer = o.setInterval(() => {
      if (!sup || sup.pid !== pid) { o.clearInterval(timer); return; }
      if (o.alive(pid)) return;
      o.clearInterval(timer);
      sup = null;
      lost('it is no longer running');
    }, ADOPT_POLL_MS);
    if (timer && timer.unref) timer.unref();
    return timer;
  }
  function lost(how) {
    if (stopped) return;
    const t = now();
    while (respawns.length && t - respawns[0] >= RESPAWN_WINDOW_MS) respawns.shift();
    if (respawns.length >= RESPAWN_MAX) {
      on = false;
      offWhy = `the supervisor stopped ${RESPAWN_MAX + 1} times in 10 minutes`;
      log(`crash recovery is OFF: the supervisor ${how}, and it has stopped ${respawns.length} times in 10 minutes, so it is not started again; a crash now leaves Mantle down until it is started by hand`);
      return;
    }
    respawns.push(t);
    log(`crash recovery: the supervisor ${how}; starting a new one`);
    spawnOne();
  }

  function spawnOne() {
    const args = [`--supervise=${o.pid}`, `--supervise-dir=${o.userData}`];
    if (o.flags.test) args.push('--supervise-test', `--profile-name=${o.flags.profileName}`);
    if (!fs.existsSync(o.exePath)) {
      on = false;
      offWhy = 'the sidecar program is missing, so there is no supervisor to start';
      log(`crash recovery is OFF: ${offWhy}`);
      return;
    }
    let child;
    try {
      child = o.spawn(o.exePath, args, { detached: true, stdio: 'ignore', windowsHide: true, cwd: o.root });
    } catch (err) {
      on = false;
      offWhy = `the supervisor would not start (${err.message})`;
      log(`crash recovery is OFF: ${offWhy}`);
      return;
    }
    sup = { pid: child.pid, via: 'spawned', child };
    on = true;
    child.once('error', (err) => {
      if (sup && sup.child === child) sup = null;
      on = false;
      offWhy = `the supervisor would not start (${err.message})`;
      log(`crash recovery is OFF: ${offWhy}`);
    });
    child.once('spawn', () => {
      log(`crash recovery on: supervisor pid ${child.pid} watches this main process (pid ${o.pid}); ${MAX_CRASHES} crashes inside ${WINDOW_MS / 60000} minutes stop the retries`);
    });
    if (child.unref) child.unref();
    watchSpawned(child);
  }

  return {
    /** -> {on, via, why}. Writes the record first: a supervisor without it could not start main again. */
    start() {
      const env = o.env || {};
      const adoptRaw = env.MANTLE_SUPERVISOR_PID;
      delete env.MANTLE_SUPERVISOR_PID;    // never handed on to the sidecar or to apps Mantle opens
      const w = wanted(o.flags);
      if (!w.on) { offWhy = w.why; log(`crash recovery is off: ${w.why}`); return { on: false, via: null, why: w.why }; }
      const prev = readJson(mainFile) || {};
      rec = {
        v: 1, pid: o.pid, at: now(), exe: o.execPath, args: o.argv, cwd: o.cwd, root: o.root,
        standDown: null, crashNote: null, told: typeof prev.told === 'number' ? prev.told : 0,
      };
      try { writeRec(); } catch (err) {
        offWhy = `its record could not be written (${err.message})`;
        log(`crash recovery is OFF: ${offWhy}`);
        return { on: false, via: null, why: offWhy };
      }
      const adoptPid = /^\d+$/.test(String(adoptRaw || '')) ? Number(adoptRaw) : 0;
      if (adoptPid && o.alive(adoptPid)) {
        sup = { pid: adoptPid, via: 'adopted' };
        sup.timer = watchAdopted(adoptPid);
        on = true;
        log(`crash recovery on: supervisor pid ${adoptPid} started this main process (pid ${o.pid}) and keeps watching it`);
        return { on: true, via: 'adopted', why: w.why };
      }
      if (adoptRaw) log(`crash recovery: the supervisor that started this process (pid ${adoptRaw}) is gone; starting a new one`);
      spawnOne();
      return { on, via: on ? 'spawned' : null, why: on ? w.why : offWhy };
    },

    /*
     * A deliberate stop: the supervisor must not start main again. Called FIRST at every deliberate
     * entry point (before any restore), so a crash on the way out is still read as the quit it was.
     * The record is the channel; if it cannot be written the supervisor is stopped outright instead.
     */
    standDown(why) {
      if (!rec) { stopped = true; return { ok: true, via: 'none' }; }
      const first = !rec.standDown;
      stopped = true;
      rec.standDown = { why: String(why || 'no reason was given'), at: now() };
      try {
        writeRec();
        if (first) log(`crash recovery stands down: ${rec.standDown.why} (the supervisor will not start Mantle again)`);
        return { ok: true, via: 'record' };
      } catch (err) {
        const pid = sup && sup.pid;
        let killed = false;
        if (pid) { try { o.kill(pid); killed = true; } catch (_) { killed = false; } }
        log(`crash recovery stands down: ${rec.standDown.why}; the record could not be written (${err.message}), so the supervisor${pid ? ` (pid ${pid}) was ${killed ? 'stopped' : 'NOT stopped'}` : ' was not running'}`);
        return { ok: killed || !pid, via: 'kill' };
      }
    },

    /** An uncaught exception on its way out: the supervisor's words for it (it still starts main again). */
    crashNote(what) {
      if (!rec || rec.standDown) return;
      rec.crashNote = { what: String(what || ''), at: now() };
      try { writeRec(); } catch (_) { /* the exit code still says it crashed */ }
    },

    /** The notice for THIS start (once ever per event), or null. Marks it told. */
    takeNotice() {
      const n = noticeFor(readJson(stateFile), rec ? rec.told : (readJson(mainFile) || {}).told, now());
      if (!n) return null;
      if (rec) {
        rec.told = n.at;
        try { writeRec(); } catch (_) { /* told again next start: better twice than never */ }
      }
      return n;
    },

    status() { return { on, why: on ? null : offWhy, pid: sup ? sup.pid : null, via: sup ? sup.via : null, standDown: rec ? rec.standDown : null }; },
  };
}

module.exports = { wanted, codeHex, exitWords, noticeFor, makeSupervisor, EXIT_WORDS, WINDOW_MS, MAX_CRASHES, MAIN_FILE, STATE_FILE };
