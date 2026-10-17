'use strict';
/* THE SHARED GAME WATCH (lane mantle-idlefix-game, 2026-10-17): game mode's watch is the one process-list
 * reader for itself and the top bar, driven by foreground changes with a 12 s backstop at rest, every
 * 1 s while a known game runs, and the sidecar answers keyed names-only reads with changes only.
 * Pure node: a fake clock and timers, a fake sidecar (which answers diff-only like GameMode.cs), the
 * top bar's side as _game-watch.js follower() with a stand-in for gameSeen (topbar.js keeps the real one).
 *   node lib/features/game-watch.test.js
 * GAMEMODE_JS=<path> runs it against another gamemode.js (the fail-before proof against 50014df). */
const path = require('path');
const fs = require('fs');
const os = require('os');
const GW = require('./_game-watch');
const P = require('./_gamemode-plan');
const GM = require(process.env.GAMEMODE_JS ? path.resolve(process.env.GAMEMODE_JS) : './gamemode');

let passed = 0; const failures = [];
function check(name, ok, detail) { if (ok) passed++; else failures.push(`${name}${detail ? ` | ${detail}` : ''}`); return ok; }

/* ---- fake time: setTimeout / clearTimeout / Date.now are swapped for virtual ones ---- */
const realImmediate = setImmediate;
let now = 1000000, seq = 0;
const timers = new Map();
global.setTimeout = (fn, ms) => { const id = { id: ++seq, at: now + Math.max(0, ms || 0), fn, unref() { return this; }, ref() { return this; } }; timers.set(id.id, id); return id; };
global.clearTimeout = (t) => { if (t && t.id) timers.delete(t.id); };
const flush = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => realImmediate(r)); };
async function advance(ms) {
  const end = now + ms;
  for (;;) {
    let next = null;
    for (const t of timers.values()) if (t.at <= end && (!next || t.at < next.at || (t.at === next.at && t.id < next.id))) next = t;
    if (!next) break;
    timers.delete(next.id);
    now = Math.max(now, next.at);
    next.fn();
    await flush();
  }
  now = end;
  await flush();
}

/* ---- the fake sidecar: gamemode.scan with the diff-only answers of GameMode.cs ---- */
const GAME = 'VALORANT-Win64-Shipping.exe';
function fakeSidecar() {
  const X = { procs: [{ pid: 4, ppid: 0, file: 'System', session: 0 }, { pid: 500, ppid: 4, file: 'explorer.exe', session: 1 }],
    fg: { hwnd: 1, pid: 500, file: 'explorer.exe', fullscreen: false }, calls: [], fail: null, bases: new Map(), gen: 0, handlers: new Map(), ready: true };
  for (let i = 0; i < 300; i++) X.procs.push({ pid: 1000 + i * 4, ppid: 500, file: `app${i}.exe`, session: 1 });
  X.send = async (cmd, a) => {
    a = a || {};
    X.calls.push({ cmd, a: JSON.parse(JSON.stringify(a)), at: now });
    if (cmd !== 'gamemode.scan') return { ok: true, result: {} };
    if (X.fail) return { ok: false, error: X.fail };
    const res = { fg: Object.assign({}, X.fg), ownPid: 971, ownSession: 1, quns: 5 };
    if (a.procs) {
      const rows = X.procs.map((p) => Object.assign({}, p));
      let diff = false;
      if (a.key) {
        const b = X.bases.get(a.key);
        const gen = ++X.gen;
        res.procsGen = gen;
        X.bases.set(a.key, { gen, rows: new Map(rows.map((p) => [p.pid, JSON.stringify(p)])) });
        if (!a.detail && 'since' in a && b && b.gen === a.since) {
          diff = true;
          res.came = rows.filter((p) => b.rows.get(p.pid) !== JSON.stringify(p));
          res.gone = Array.from(b.rows.keys()).filter((pid) => !rows.some((p) => p.pid === pid));
          res.procsSince = a.since;
        }
      }
      if (!diff) res.procs = rows;
    }
    return { ok: true, result: res };
  };
  X.emit = (ev, msg) => { for (const fn of X.handlers.get(ev) || []) fn(msg); };
  X.scans = () => X.calls.filter((c) => c.cmd === 'gamemode.scan');
  return X;
}
function fakeCtx(X, enabled) {
  const ctx = {
    name: 'gamemode', flags: { test: false, live: false }, logs: [], log: (t) => ctx.logs.push(t), health: () => {},
    on_: enabled !== false, enabled: () => ctx.on_, onEnabledFns: [], onEnabled: (fn) => ctx.onEnabledFns.push(fn),
    broadcast: () => {}, replay: () => {}, command: () => {},
    settings: { get: (k, d) => (k === 'auto' ? false : d), set: () => {}, file: path.join(os.tmpdir(), 'x', 'features', 'gamemode.json') },
    sidecar: {
      get ready() { return X.ready; },
      send: (c, a) => X.send(c, a),
      on: (ev, fn) => { if (!X.handlers.has(ev)) X.handlers.set(ev, []); X.handlers.get(ev).push(fn); return () => {}; },
      onReady: (fn) => { ctx.ready_ = fn; return () => {}; },
    },
  };
  ctx.setEnabled = (on) => { ctx.on_ = on; for (const fn of ctx.onEnabledFns) fn(on); };
  return ctx;
}
/** The top bar's side: the real follower; gameSeen stood in by the same rule topbar.js runs (a failed
 * check changes nothing; runningGames with seen + extra decides start / exit). */
function fakeTopbar(hub, X, o) {
  const T = { stopped: false, enabled: true, run: null, runBusy: false, watchOk: true, seen: new Map(), events: [], answers: [], reads: 0, failed: [] };
  T.f = GW.follower(hub, {
    active: () => !T.stopped && T.enabled,
    running: () => !!T.run,
    fed: () => T.watchOk,
    read: async () => { T.reads++; const r = await X.send('gamemode.scan', { procs: true }); return r.ok ? Object.assign({ ok: true }, r.result) : { ok: false, reason: r.error }; },
    seen: async (r) => {
      T.answers.push({ at: now, ok: r.ok, reason: r.reason, n: r.procs && r.procs.length });
      if (!r.ok || !Array.isArray(r.procs) || r.procsReason) { T.failed.push(r.reason || r.procsReason); return; }
      const list = P.runningGames(r, { seen: T.seen, extra: [] });
      if (list.length && !T.run) { T.run = { pid: list[0].pid }; T.events.push({ kind: 'started', at: now }); }
      else if (!list.length && T.run) { T.run = null; T.events.push({ kind: 'exited', at: now }); }
    },
    gate: { get: () => T.runBusy, set: (v) => { T.runBusy = v; } },
    later: (ms, fn) => setTimeout(fn, ms), clear: (t) => clearTimeout(t),
    log: () => {}, everyMs: 1000,
  });
  return T;
}
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-test-'));
const install = (X, ctx, hub) => GM.install(ctx, { userData, now: () => now, mantlePids: () => [], wallpaper: null, spawn: () => ({ on: () => {} }), gameWatch: hub });
const focus = (X) => X.emit('topbar', { kind: 'focus', hwnd: X.fg.hwnd });
const startGame = (X, pid, front) => { X.procs.push({ pid, ppid: 500, file: GAME, session: 1 }); if (front) X.fg = { hwnd: 77, pid, file: GAME, fullscreen: true, game: true }; };
const endGame = (X, pid) => { X.procs = X.procs.filter((p) => p.pid !== pid); X.fg = { hwnd: 1, pid: 500, file: 'explorer.exe', fullscreen: false }; };

(async () => {
  // ---- 1) at rest, both on: ONE reader, the backstop, diff-only answers ----
  {
    const X = fakeSidecar(); const hub = GW.create(); const ctx = fakeCtx(X);
    const gm = install(X, ctx, hub);
    const T = fakeTopbar(hub, X); T.f.start();
    await ctx.ready_(); await flush();
    const t0 = now, n0 = X.scans().length;
    await advance(120000);
    const scans = X.scans().filter((c) => c.at > t0);
    check(`rest: one reader, the 12 s backstop: ${scans.length} scans in 120 s (was 40 game mode + 120 top bar)`, scans.length >= 8 && scans.length <= 11, JSON.stringify(scans.map((c) => c.at - t0)));
    check('rest: the top bar reads nothing of its own while game mode reads', T.reads === 0, `reads=${T.reads}`);
    check('rest: every read reaches the top bar', T.answers.filter((a) => a.at > t0).length === scans.length, `${T.answers.length} answers, ${scans.length} scans, n0=${n0}`);
    check('rest: the reads ask for changes only (key + since)', scans.length > 0 && scans.every((c) => c.a.key === 'gamemode-watch' && typeof c.a.since === 'number' && c.a.procs === true && !c.a.detail), JSON.stringify(scans[0] && scans[0].a));
    check('rest: the top bar still gets the whole list every time (made from the changes)', T.answers.length > 1 && T.answers.every((a) => a.ok && a.n === X.procs.length), JSON.stringify(T.answers.slice(-2)));

    // ---- 2) a game takes the foreground: a read at once, the top bar steps aside within 1 s ----
    const tg = now;
    startGame(X, 7000, true); focus(X);
    await advance(1000);
    const st = T.events.find((e) => e.kind === 'started');
    check(`game in front: the top bar hears it ${st ? st.at - tg : 'never'} ms after the foreground change (was up to 1000)`, !!st && st.at - tg <= 300, JSON.stringify(T.events));
    // ---- 3) while it runs: a read every 1 s, so its exit is seen within ~1 s ----
    const tr = now;
    await advance(10000);
    const during = X.scans().filter((c) => c.at > tr);
    check(`game running: a read every second (${during.length} in 10 s)`, during.length >= 9 && during.length <= 13, JSON.stringify(during.map((c) => c.at - tr)));
    check('game running: still the top bar reads nothing of its own', T.reads === 0, `reads=${T.reads}`);
    const te = now;
    endGame(X, 7000);   // the game window goes; no focus event is needed for the exit
    await advance(1500);
    const ex = T.events.find((e) => e.kind === 'exited');
    check(`game exit: seen ${ex ? ex.at - te : 'never'} ms after the process went (was up to 1000)`, !!ex && ex.at - te <= 1100, JSON.stringify(T.events));
    // back at rest: the backstop again
    const tb = now;
    await advance(60000);
    const after = X.scans().filter((c) => c.at > tb);
    check(`after the exit: back to the backstop (${after.length} reads in 60 s)`, after.length >= 4 && after.length <= 6, JSON.stringify(after.map((c) => c.at - tb)));

    // ---- 4) a game started behind other windows, no foreground change: seen at the backstop ----
    const tbg = now;
    startGame(X, 7100, false);
    await advance(15000);
    const bg = T.events.filter((e) => e.kind === 'started').pop();
    check(`background game start: seen at the backstop (${bg ? bg.at - tbg : 'never'} ms, within 15 s)`, !!bg && bg.at > tbg && bg.at - tbg <= 12500, JSON.stringify(T.events));
    endGame(X, 7100); await advance(2000);

    // ---- 5) diff-only: answers when nothing changed carry no rows ----
    const big = JSON.stringify(X.procs).length;
    const r1 = await X.send('gamemode.scan', { procs: true, key: 'gamemode-watch', since: X.gen });
    check('diff: nothing changed = no procs, empty came/gone', !r1.result.procs && r1.result.came.length === 0 && r1.result.gone.length === 0 && JSON.stringify(r1.result).length < big / 20, JSON.stringify(Object.keys(r1.result)));
    // a failed read: the top bar is told, with the sidecar's own words, and nothing changes
    const runBefore = T.run, evBefore = T.events.length;
    X.fail = 'gamemode.scan: the game check has been stuck for 12 s (listing the processes)';
    focus(X); await advance(13000);
    check('a failed read reaches the top bar as a failure, in the sidecar\'s own words', T.failed.length > 0 && T.failed.every((w) => w === X.fail), JSON.stringify(T.failed.slice(-2)));
    check('a failed read changes nothing', T.run === runBefore && T.events.length === evBefore, JSON.stringify(T.events.slice(evBefore)));
    X.fail = null;
    // the whole list again after a failure (the base the sidecar holds may be ahead): no wrong list
    await advance(13000);
    check('after a failure the list is right again', T.answers.slice(-1)[0].ok && T.answers.slice(-1)[0].n === X.procs.length, JSON.stringify(T.answers.slice(-1)));

    // ---- 6) game mode stopped: the top bar reads on its own again, every 1 s ----
    await gm.stop('test');
    const ts = now; const reads0 = T.reads;
    await advance(5000);
    check(`game mode stopped: the top bar's own loop again (${T.reads - reads0} reads in 5 s)`, T.reads - reads0 >= 4 && T.reads - reads0 <= 6, '');
    T.f.stop();
    const reads1 = T.reads; await advance(5000);
    check('top bar off: nothing reads', T.reads === reads1 && X.scans().filter((c) => c.at > ts + 5000).length === T.reads - reads1, '');
  }

  // ---- 7) game mode OFF in the tray, top bar on: the top bar still steps aside for games ----
  {
    const X = fakeSidecar(); const hub = GW.create(); const ctx = fakeCtx(X, false);
    const gm = install(X, ctx, hub);
    const T = fakeTopbar(hub, X); T.f.start();
    await ctx.ready_(); await flush();
    const t0 = now;
    await advance(60000);
    const rest = X.scans().filter((c) => c.at > t0);
    check(`game mode off: the watch still runs for the top bar, on the backstop (${rest.length} reads in 60 s)`, rest.length >= 4 && rest.length <= 6 && T.reads === 0, JSON.stringify({ at: rest.map((c) => c.at - t0), reads: T.reads }));
    const tg = now; startGame(X, 7200, true); focus(X); await advance(1000);
    const st = T.events.find((e) => e.kind === 'started');
    check(`game mode off: a game in front reaches the top bar (${st ? st.at - tg : 'never'} ms)`, !!st && st.at - tg <= 300, JSON.stringify(T.events));
    const te = now; endGame(X, 7200); await advance(1500);
    const ex = T.events.find((e) => e.kind === 'exited');
    check(`game mode off: its exit is seen within ~1 s (${ex ? ex.at - te : 'never'} ms)`, !!ex && ex.at - te <= 1100, JSON.stringify(T.events));
    check('game mode off: game mode itself never turned on', !gm._S.on, '');
    // switched on again: its own ticks come back
    ctx.setEnabled(true); await advance(100);
    check('game mode switched back on: its own tick runs', X.scans().some((c) => c.at > now - 200), '');
    await gm.stop('test'); T.f.stop();
  }

  // ---- 8) top bar OFF, game mode on: game mode's own watch, unchanged (every 3 s) ----
  {
    const X = fakeSidecar(); const hub = GW.create(); const ctx = fakeCtx(X);
    const gm = install(X, ctx, hub);
    await ctx.ready_(); await flush();
    const t0 = now; await advance(30000);
    const n = X.scans().filter((c) => c.at > t0).length;
    check(`top bar off: game mode watches as before, every 3 s (${n} reads in 30 s)`, n >= 9 && n <= 11, '');
    // top bar with its focus watch NOT live: no foreground feed, so no backstop either
    const T = fakeTopbar(hub, X); T.watchOk = false; T.f.start();
    const t1 = now; await advance(30000);
    const n1 = X.scans().filter((c) => c.at > t1).length;
    check(`top bar on but its focus watch down: no slow backstop (${n1} reads in 30 s)`, n1 >= 9 && n1 <= 11 && T.answers.length >= 9, '');
    await gm.stop('test'); T.f.stop();
  }

  // ---- 9) whole(): changes against a list Mantle does not hold = ask again, never a wrong list ----
  {
    const mem = { gen: null, rows: null };
    check('whole: a reply with changes but no list held -> null (ask again)', GW.whole(mem, { came: [], gone: [], procsSince: 3, procsGen: 4 }) === null, '');
    GW.whole(mem, { procs: [{ pid: 1, file: 'a.exe', cpuMs: 5 }, { pid: 2, file: 'b.exe' }], procsGen: 7 });
    const w = GW.whole(mem, { came: [{ pid: 3, file: 'c.exe' }, { pid: 1, file: 'z.exe' }], gone: [2], procsSince: 7, procsGen: 8, fg: { pid: 3 } });
    check('whole: came/gone applied in order, no detail kept, fg passed through', JSON.stringify(w.procs) === JSON.stringify([{ pid: 3, file: 'c.exe' }, { pid: 1, file: 'z.exe' }]) && w.fg.pid === 3 && !w.came && !w.gone, JSON.stringify(w));
    check('whole: a stale since -> null and the list dropped', GW.whole(mem, { came: [], gone: [], procsSince: 7, procsGen: 9 }) === null && mem.rows === null, '');
    const old = GW.whole(mem, { procs: [{ pid: 9 }] });
    check('whole: an old sidecar (no procsGen) is passed through and nothing kept', old.procs.length === 1 && mem.gen === null, '');
  }

  const total = passed + failures.length;
  for (const f of failures) console.log(`  FAIL ${f}`);
  console.log(`GAME WATCH TEST: ${passed} passed, ${failures.length} failed${total ? '' : ' (nothing ran)'}`);
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.log(`GAME WATCH TEST: 0 passed, 1 failed\n  threw: ${e.stack}`); process.exit(1); });
