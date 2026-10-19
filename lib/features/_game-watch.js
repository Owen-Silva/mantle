'use strict';
/* THE SHARED GAME WATCH (lane mantle-idlefix-game, 2026-10-17). Game mode and the top bar each read the
 * whole process list on their own (the top bar every 1 s, game mode every 3 s): ~1.3 full
 * gamemode.scan {procs:true} a second at rest, each 5-15 ms of sidecar CPU and a ~310-row JSON over the
 * pipe (design notes: mantle-idle-cpu, suspect 1). Now game mode's watch (gamemode.js) is the ONE reader
 * and this hub hands every read it makes to the top bar:
 *   - drive(d): game mode says it reads (d.changed() = "someone's needs changed: schedule again");
 *     the returned off() at its stop. driven() = a reader is there; onDriver(fn) = it came or went.
 *   - join(sub): the top bar listens. sub.wants() = it needs the watch at all (on, between apply() and
 *     off()); sub.fastMs() = how often it needs a read right now (1000 while a known game runs, so an
 *     exit is seen as fast as before; null at rest); sub.fed() = its focus watch is live, so every
 *     foreground change already reaches game mode (sidecar "topbar" focus events) and the watch can
 *     rest on a slow backstop; sub.result(r) = one read, {ok:true, ...scan} or {ok:false, reason}.
 *   - publish(r) / wanted() / fastMs() / fed(): game mode's side of the same.
 * No reader (game mode stopped, not installed, or a test with the top bar alone): the top bar reads
 * on its own as it always did (topbar.js runLoop). Plain module state: both features run in main's one
 * Node process, so require() hands them the same hub; tests make their own with create().
 *
 * whole(mem, reply): a diff-only gamemode.scan answer (sidecar GameMode.cs, DIFF-ONLY ANSWERS: the
 * pids that came or went since the caller's last answer) made into the full list again, from mem
 * {gen, rows} that this call keeps. Returns the reply with `procs` (rows are fresh copies, so nothing
 * a caller does to a list reaches the next one), or null when the changes are against a list mem does
 * not hold (then mem is cleared and the caller asks once more without `since`, for the whole list). */

const SLIM = ['pid', 'ppid', 'file', 'session'];
const slim = (p) => { const o = {}; for (const k of SLIM) if (p[k] !== undefined) o[k] = p[k]; return o; };

function whole(mem, r) {
  if (!r || typeof r !== 'object') return r;
  if (Array.isArray(r.procs)) {
    if (r.procsGen != null && !r.procsReason) { mem.gen = r.procsGen; mem.rows = new Map(r.procs.map((p) => [p.pid, slim(p)])); }
    else { mem.gen = null; mem.rows = null; }
    return r;
  }
  if (Array.isArray(r.came) && Array.isArray(r.gone)) {
    if (!mem.rows || r.procsSince !== mem.gen || r.procsGen == null) { mem.gen = null; mem.rows = null; return null; }
    for (const pid of r.gone) mem.rows.delete(pid);
    for (const p of r.came) { mem.rows.delete(p.pid); mem.rows.set(p.pid, slim(p)); }   // a reused pid moves to the end, as a new process does
    mem.gen = r.procsGen;
    const out = Object.assign({}, r, { procs: Array.from(mem.rows.values(), (p) => Object.assign({}, p)) });
    delete out.came; delete out.gone; delete out.procsSince;
    return out;
  }
  return r;
}

function create() {
  const subs = new Set();
  const driverFns = new Set();
  let driver = null;
  const each = (fn) => { for (const s of Array.from(subs)) { try { fn(s); } catch (_) { /* one listener's throw never stops the rest */ } } };
  const ask = (s, k) => { try { return s[k] ? s[k]() : null; } catch (_) { return null; } };
  const hub = {
    drive(d) {
      const me = d || {};
      driver = me;
      for (const fn of Array.from(driverFns)) { try { fn(true); } catch (_) { /* ditto */ } }
      return () => {
        if (driver !== me) return;
        driver = null;
        for (const fn of Array.from(driverFns)) { try { fn(false); } catch (_) { /* ditto */ } }
      };
    },
    driven() { return !!driver; },
    onDriver(fn) { driverFns.add(fn); return () => driverFns.delete(fn); },
    join(sub) {
      subs.add(sub);
      hub.changed();
      return () => { if (subs.delete(sub)) hub.changed(); };
    },
    /** A listener's needs changed (it joined, left, a game started or exited): the reader schedules again. */
    changed() { if (driver && typeof driver.changed === 'function') { try { driver.changed(); } catch (_) { /* ditto */ } } },
    wanted() { let w = false; each((s) => { if (ask(s, 'wants')) w = true; }); return w; },
    fastMs() {
      let ms = null;
      each((s) => { if (!ask(s, 'wants')) return; const m = ask(s, 'fastMs'); if (typeof m === 'number' && m > 0 && (ms == null || m < ms)) ms = m; });
      return ms;
    },
    /** Every listener that wants the watch also feeds foreground changes to it (so a slow backstop is enough). */
    fed() { let any = false, all = true; each((s) => { if (!ask(s, 'wants')) return; any = true; if (!ask(s, 'fed')) all = false; }); return any && all; },
    publish(r) { each((s) => { if (ask(s, 'wants') && typeof s.result === 'function') s.result(r); }); },
  };
  return hub;
}

/* THE TOP BAR'S SIDE (topbar.js runLoop / runLoopStop / gameCheck): one follower per install.
 * h = { active(): on, not stopped, not ending; running(): a known game runs (S.run); fed(): its focus
 *   watch is live; read(): Promise<its own gamemode.scan answer>; seen(r): Promise, one answer handled
 *   (topbar.js gameSeen: the failure handling, runningGames and runChanged, all unchanged);
 *   gate: {get(), set(v)} = S.runBusy, one check at a time; later(ms, fn) -> t; clear(t); log(text);
 *   everyMs = RUN_MS }.
 * start(): listens to the hub; with no reader there it runs the old loop (a read every everyMs, the
 * next one after the last has finished). stop(): neither. check(): one read of its own now (apply():
 * a game already running when the top bar starts). An answer that comes while one is being handled
 * waits for it and is handled next (only the newest waits): nothing runs twice at once, as before. */
function follower(hub, h) {
  const F = { on: false, t: null, off: null, unDriver: null, next: null, wasRun: false };
  const sub = {
    wants: () => F.on && !!h.active(),
    fastMs: () => (h.running() ? h.everyMs : null),
    fed: () => !!h.fed(),
    result: (r) => { take(r); },
  };
  const stopTimer = () => { if (F.t) { h.clear(F.t); F.t = null; } };
  function flip() {   // a game started or exited: the reader goes to (or leaves) every everyMs now
    const run = !!h.running();
    if (run !== F.wasRun) { F.wasRun = run; hub.changed(); }
  }
  function drain() {
    const n = F.next; F.next = null;
    if (n && F.on) take(n);
  }
  function take(r) {
    if (!F.on || !h.active()) return;
    if (h.gate.get()) { F.next = r; return; }
    h.gate.set(true);
    Promise.resolve().then(() => h.seen(r))
      .catch((e) => h.log(`the game check threw: ${e.message}`))
      .then(() => { h.gate.set(false); flip(); drain(); });
  }
  async function check() {
    if (!h.active() || h.gate.get()) return;
    h.gate.set(true);
    try { await h.seen(await h.read()); } finally { h.gate.set(false); flip(); drain(); }
  }
  function loop() {
    if (F.t || !F.on || !h.active() || hub.driven()) return;
    F.t = h.later(h.everyMs, async () => {
      F.t = null;
      try { await check(); } catch (e) { h.log(`the game check threw: ${e.message}`); }
      loop();
    });
  }
  return {
    start() {
      if (!h.active()) return;
      F.on = true;
      F.wasRun = !!h.running();
      if (!F.unDriver) F.unDriver = hub.onDriver(() => { if (hub.driven()) stopTimer(); else loop(); });
      if (!F.off) F.off = hub.join(sub);
      loop();
    },
    stop() {
      F.on = false; F.next = null;
      stopTimer();
      if (F.unDriver) { F.unDriver(); F.unDriver = null; }
      if (F.off) { F.off(); F.off = null; }
    },
    check,
    _F: F,
  };
}

module.exports = Object.assign(create(), { create, whole, follower });
