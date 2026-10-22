'use strict';
/*
 * gamemode-boost.e2e.test.js - the game-mode boost end to end on REAL processes (lane mantle-boost,
 * 2026-10-15): lib/features/gamemode.js (not a dry run) + a PASSIVE sidecar of this checkout
 * (sidecar/GameMode.cs gamemode.apply / gamemode.trimbg) + throwaway processes this test starts.
 *
 *   node lib/features/gamemode-boost.e2e.test.js      (needs sidecar\bin\Mantle.Sidecar.exe and csc)
 *
 * NEVER ON THE USER'S APPS, three ways:
 *   1. every process is a burner (sidecar/apppower-burner.js) this test compiles into
 *      %TEMP%\mantle-apppower-test\run-<id>\ and starts itself; each is killed by pid in the finally;
 *   2. the feature sees a process list FILTERED to those pids (the real scan, other rows dropped), and
 *      the wrapper refuses to forward any write that names another pid;
 *   3. a passive sidecar writes only to mpburn-* exes under %TEMP% (GameMode.cs IsBurner), so even a
 *      bug in 1 and 2 cannot reach a real app (checked below with an mpctl-* decoy).
 * The "game" is a burner the wrapper reports as the full-screen exclusive Direct3D app in front.
 * Read back from each burner's OWN report of itself (priority class, power throttling, working set),
 * never through the sidecar's code.
 *
 * Prints "GAMEMODE BOOST E2E TEST: n passed, m failed".
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const T = require('../../sidecar/test-lib');
const B = require('../../sidecar/apppower-burner');
const GM = require('./gamemode');

const MB = 1048576;
const NORMAL = 0x20, BELOW = 0x4000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t = T.checker('GAMEMODE BOOST E2E');

async function waitFor(fn, ms, step) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(step || 250);
  }
}

/** Elevated (a CI runner runs as administrator): every process it starts is an administrator's, and game
 * mode leaves those alone by rule (plan() and GameMode.cs Refuse), so nothing here could be eased. */
function elevated() {
  try { require('child_process').execFileSync('net', ['session'], { stdio: 'ignore', windowsHide: true, timeout: 10000 }); return true; } catch (_) { return false; }
}

(async () => {
  if (elevated()) {
    console.log('GAMEMODE BOOST E2E: skipped: this runs as administrator (a CI runner), so every burner is an administrator\'s process, which game mode never touches by rule. Run it in a normal desktop session.');
    process.exit(0);
  }
  const run = B.runDir();
  const started = [];
  let s = null;
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-boost-e2e-'));
  const insts = [];
  try {
    // ---- the processes: all burners, three exe names so "the game's exe", "the app playing sound" and
    // "a background app" are different apps; a decoy copy NOT allowed to be written (mpctl-*)
    const exe = B.build(run.dir, run.name);
    const gameExe = path.join(run.dir, run.name + 'g.exe');
    const sndExe = path.join(run.dir, run.name + 's.exe');
    const ctlExe = path.join(run.dir, run.name.replace(/^mpburn-/, 'mpctl-') + '.exe');
    for (const x of [gameExe, sndExe, ctlExe]) fs.copyFileSync(exe, x);
    const st = (x, args) => { const p = B.start(x, args, { life: 300 }); started.push(p); return p; };
    const game = st(gameExe, ['idle']);
    const A = st(exe, ['touch', '96']);              // idle background app holding memory: eased + trimmed once
    const busy = st(exe, ['spin', '1']);             // busy through the minute: eased, never trimmed
    const helm = st(exe, ['touch', '64']);           // reported as Helm.exe: eased, never trimmed
    const disc = st(exe, ['touch', '64']);           // reported as Discord.exe: never touched
    const expl = st(exe, ['touch', '64']);           // reported as explorer.exe: never touched
    const mainP = st(exe, ['touch', '64']);          // stands in for Mantle's main process: never touched
    const snd = st(sndExe, ['touch', '64']);         // "playing sound": never touched
    const ctl = st(ctlExe, ['touch', '64']);         // not allowed for a passive sidecar
    const R = st(exe, ['parent']);                   // an app's main process with two children of its own exe
    const r1Info = path.join(run.dir, 'r1.json'), r2Info = path.join(run.dir, 'r2.json');
    R.send(`spawn touch 96 --type=renderer --info ${r1Info} --life 300`);
    await waitFor(() => R.lines.filter((l) => /^CHILD /.test(l)).length >= 1, 8000);
    R.send(`spawn touch 64 --type=gpu-process --info ${r2Info} --life 300`);
    await waitFor(() => R.lines.filter((l) => /^CHILD /.test(l)).length >= 2, 8000);
    const kids = R.lines.filter((l) => /^CHILD /.test(l)).map((l) => Number(l.split(' ')[1]));
    const r1 = { pid: kids[0], info: () => B.readInfo(r1Info) }, r2 = { pid: kids[1], info: () => B.readInfo(r2Info) };
    t.check('setup: the app with two children started them', kids.length === 2 && kids.every((k) => k > 0), R.lines.join('|'));
    const all = [game, A, busy, helm, disc, expl, mainP, snd, ctl, R, r1, r2];
    const MINE = new Set(all.map((p) => p.pid));
    const LABEL = new Map([[helm.pid, 'Helm.exe'], [disc.pid, 'Discord.exe'], [expl.pid, 'explorer.exe']]);
    await waitFor(() => all.every((p) => { const i = p.info(); return i && i.ws > 0 && (p === game || p === busy || p === R || i.alloc > 0); }), 15000);

    s = await T.startPassive();
    // ---- 1. the sidecar's own rules for the one trim (direct calls)
    const scan0 = (await s.send('gamemode.scan', { procs: true, detail: true }, 15000)).result || {};
    await waitFor(async () => { const r = (await s.send('gamemode.scan', { procs: true, detail: true }, 15000)).result; return r && r.procs.filter((p) => MINE.has(p.pid)).every((p) => p.created); }, 15000, 500);
    const rows = ((await s.send('gamemode.scan', { procs: true, detail: true }, 15000)).result || {}).procs || [];
    const row = (pid) => rows.find((p) => p.pid === pid) || {};
    t.check('scan: a detail row carries the working set (bytes)', row(A.pid).ws > 90 * MB, JSON.stringify(row(A.pid)));
    t.check('scan: answered', !!scan0.procs);
    const tb = async (items) => (await s.send('gamemode.trimbg', { items }, 15000)).result || {};
    const one = async (p, extra) => ((await tb([Object.assign({ pid: p.pid, created: row(p.pid).created, file: 'x' }, extra)])).results || [])[0] || {};
    let r = await one(R);
    t.check("trimbg: an app's main process (children of its own exe) is refused", !r.ok && /main process/.test(r.why || ''), JSON.stringify(r));
    r = await one(r2);
    t.check("trimbg: a Chromium helper that is not a page (--type=gpu-process) is refused", !r.ok && r.kind === 'gpu-process' && /graphics process/.test(r.why || ''), JSON.stringify(r));
    const ctlWs = ctl.info().ws;
    r = await one(ctl);
    t.check('trimbg: a passive sidecar refuses anything that is not the test burner', !r.ok && /passive/.test(r.why || '') && /would have handed back/.test(r.why || ''), JSON.stringify(r));
    r = await one(A, { created: '1' });
    t.check('trimbg: a pid with another start time is a different process: left alone', !r.ok && r.gone === true, JSON.stringify(r));
    r = await one({ pid: process.pid });
    t.check("trimbg: the process that started the sidecar (Mantle's main) is refused", !r.ok && /Mantle's own/.test(r.why || ''), JSON.stringify(r));
    await sleep(600);
    t.check('trimbg: the refused decoy kept its memory', ctl.info().ws > ctlWs * 0.8, `${ctlWs} -> ${ctl.info().ws}`);

    // ---- 2. the feature, not a dry run, over the filtered process list
    const audio = [{ pid: snd.pid, active: true }];
    const bad = [];
    let gameFront = true;                            // the stand-in game is the window in front (while it runs)
    const trimItems = [];                            // [[pid...] per gamemode.trimbg call]
    const send = async (cmd, a) => {
      if (cmd === 'audio') return { ok: true, result: { ok: true, sessions: audio } };
      if (cmd === 'gamemode.scan') {
        // whole lists only through this filter: a diff-only answer (key + since, GameMode.cs DIFF-ONLY
        // ANSWERS, lane idlefix) carries no procs to filter, so the feature would never see the stand-in
        // game. The feature takes a whole list as it always did (_game-watch.js whole()).
        const ask = Object.assign({}, a); delete ask.key; delete ask.since;
        const res = await s.send(cmd, ask, 15000);
        if (!res.ok) return res;
        const out = Object.assign({}, res.result);
        const alive = (res.result.procs || []).some((p) => p.pid === game.pid);
        out.fg = gameFront && alive ? { pid: game.pid, exe: gameExe, title: 'Stand-in game', fullscreen: true, verdict: { quns: 3 } } : { pid: 0 };
        out.procs = (res.result.procs || []).filter((p) => MINE.has(p.pid)).map((p) => (LABEL.has(p.pid) ? Object.assign({}, p, { file: LABEL.get(p.pid) }) : p));
        return { ok: true, result: out };
      }
      if (cmd === 'gamemode.apply' || cmd === 'gamemode.trimbg') {
        const stray = (a.items || []).filter((i) => !MINE.has(i.pid));
        if (stray.length) { bad.push(cmd + ' ' + stray.map((i) => i.pid).join(',')); return { ok: false, error: 'the test refused a pid it did not start' }; }
        if (cmd === 'gamemode.trimbg') trimItems.push((a.items || []).map((i) => i.pid));
        return s.send(cmd, a, 15000);
      }
      if (cmd === 'powermode.get' || cmd === 'gamemode.power' || cmd === 'gamemode.saver') return s.send(cmd, a, 15000);
      return { ok: false, error: `${cmd} is not part of this test` };
    };
    const mkCtx = () => {
      const store = {};
      const ctx = { name: 'gamemode', flags: { test: false, live: false }, logs: [], pushes: [], commands: {},
        log: (x) => ctx.logs.push(x), health: () => {}, enabled: () => true, onEnabled: () => {}, broadcast: (ev, p) => ctx.pushes.push(p), replay: () => {},
        command: (v, fn) => { ctx.commands[v] = fn; },
        settings: { get: (k, d) => (k in store ? store[k] : d), set: (k, v) => { store[k] = v; }, file: path.join(userData, 'features', 'gamemode.json') },
        sidecar: { ready: true, send: (c, a) => send(c, a), on: () => () => {}, onReady: (fn) => { ctx.ready_ = fn; return () => {}; } } };
      return ctx;
    };
    const opts = { userData, mantlePids: () => [], mainPid: mainP.pid, wallpaper: { gameHold: () => ({ pause: { paused: false } }) },
      spawn: () => ({ on: () => {} }), trimAfterMs: 4000, idleCpuMs: 2500 };
    const prioOf = (p) => (p.info() || {}).prio;
    const ecoOf = (p) => { const i = p.info() || {}; return i.thrCtl === 1 && i.thrState === 1; };
    const before = new Map(all.map((p) => [p.pid, p.info() || {}]));

    let ctx = mkCtx();
    let inst = GM.install(ctx, opts); insts.push(inst);
    await ctx.ready_();
    const eased = [A, busy, helm, R, r1, r2];
    await waitFor(async () => { await inst._tick(); return inst._S.on && eased.every((p) => prioOf(p) === BELOW && ecoOf(p)); }, 20000, 400);
    t.check('on: the full-screen stand-in game turns game mode on', inst._S.on && /exclusive full-screen/.test(inst._S.game.why || ''), JSON.stringify(inst._S.game));
    t.check('on: background apps are eased for real (below-normal + Efficiency mode, read from inside each)', eased.every((p) => prioOf(p) === BELOW && ecoOf(p)),
      eased.map((p) => `${p.pid}:${prioOf(p)}/${ecoOf(p)}`).join(' '));
    const never = [game, disc, expl, mainP, snd, ctl];
    t.check('on: the game, Discord, explorer, Mantle main and the app playing sound are untouched', never.every((p) => prioOf(p) === NORMAL && !ecoOf(p)),
      never.map((p) => `${p.pid}:${prioOf(p)}/${ecoOf(p)}`).join(' '));
    let v = await ctx.commands.state();
    t.check('on: the tile says the boost is on and what it eased', v.boostNow && v.boostNow.state === 'waiting' && /^Boost: eased \d+ background apps?; idle memory is handed back a minute in$/.test(v.boostNow.text), JSON.stringify(v.boostNow));
    const wsA = A.info().ws, wsR1 = r1.info().ws, wsR2 = r2.info().ws;
    await waitFor(async () => { await inst._tick(); return inst._S.boost && inst._S.boost.state !== 'waiting' && inst._S.boost.state !== 'trimming'; }, 20000, 500);
    await sleep(800);
    v = await ctx.commands.state();
    t.check('trim: done, said on the tile ("Freed ... and eased ...")', v.boostNow && v.boostNow.state === 'done' && /^Boost: freed \d+(\.\d)? (MB|GB) and eased \d+ background apps?/.test(v.boostNow.text), JSON.stringify(v.boostNow));
    t.check('trim: the idle app handed its memory back (its own report)', A.info().ws < wsA * 0.4, `${wsA} -> ${A.info().ws}`);
    t.check("trim: the idle page (--type=renderer) of an app handed its memory back", r1.info().ws < wsR1 * 0.4, `${wsR1} -> ${r1.info().ws}`);
    t.check("trim: the app's graphics helper kept its memory", r2.info().ws > wsR2 * 0.7, `${wsR2} -> ${r2.info().ws}`);
    t.check('trim: Helm and every never-touch process kept their memory',
      [helm, disc, expl, mainP, snd, ctl].every((p) => p.info().ws > (before.get(p.pid).ws || 0) * 0.7), [helm, disc, expl, mainP, snd, ctl].map((p) => `${p.pid}:${before.get(p.pid).ws}->${p.info().ws}`).join(' '));
    const trimSent = ctx.logs.filter((l) => /^boost: /.test(l));
    t.check('trim: one log line with the numbers', trimSent.length >= 1 && /handed back/.test(trimSent[0]), trimSent.join(' / '));
    t.check('trim: the record on disk lists the trimmed pids', ((JSON.parse(fs.readFileSync(inst._record, 'utf8')).trim || {}).pids || []).includes(A.pid));
    const nTrim = ctx.logs.filter((l) => /handed back/.test(l)).length;
    for (let i = 0; i < 3; i++) { await inst._tick(); await sleep(300); }
    t.check('trim: never twice in one game', ctx.logs.filter((l) => /handed back/.test(l)).length === nTrim);

    // ---- 3. a crash mid-game: the record stays, the next start puts everything back (same pid AND start time)
    inst._S.stopped = true; clearTimeout(inst._S.timer);
    const rec = JSON.parse(fs.readFileSync(inst._record, 'utf8'));
    rec.procs.push({ pid: disc.pid, created: '1', file: 'Discord.exe', group: 'background', eco: { was: { control: 0, state: 0 }, set: { control: 1, state: 1 } } });
    fs.writeFileSync(inst._record, JSON.stringify(rec));
    t.check('crash: the eased apps are still eased while Mantle is gone', eased.every((p) => prioOf(p) === BELOW));
    gameFront = false;                               // the user is on the desktop when Mantle comes back: the restore alone is seen
    ctx = mkCtx();
    const inst2 = GM.install(ctx, opts); insts.push(inst2);
    await ctx.ready_();
    await sleep(600);
    t.check('crash: the next start put every eased app back', eased.every((p) => prioOf(p) === NORMAL && !ecoOf(p)) && inst2._S.fromCrash && inst2._S.fromCrash.ok,
      eased.map((p) => `${p.pid}:${prioOf(p)}/${ecoOf(p)}`).join(' ') + ' ' + JSON.stringify(inst2._S.fromCrash));
    t.check('crash: a record entry whose pid now has another start time was left alone', prioOf(disc) === NORMAL && !ecoOf(disc) && /had exited/.test(inst2._S.fromCrash.text || ''), inst2._S.fromCrash.text);
    // the game still runs: on again, eased again, and the apps trimmed before the crash are not trimmed twice
    const calls1 = trimItems.length;
    gameFront = true;
    await waitFor(async () => { await inst2._tick(); return inst2._S.on && eased.every((p) => prioOf(p) === BELOW); }, 20000, 400);
    await waitFor(async () => { await inst2._tick(); return inst2._S.boost && inst2._S.boost.state === 'done'; }, 20000, 500);
    const again = trimItems.slice(calls1).flat();
    t.check('crash: game mode came back on for the same game, without trimming the same apps again',
      inst2._S.on && inst2._S.trimDone.has(A.pid) && inst2._S.trimDone.has(r1.pid) && !again.includes(A.pid) && !again.includes(r1.pid), `sent after the restart: ${again.join(',') || 'none'}`);

    // ---- 4. the game exits: everything back
    B.kill(game.pid);
    await waitFor(async () => { await inst2._tick(); return !inst2._S.on; }, 20000, 500);
    await sleep(600);
    t.check('exit: game mode off when the game exits', !inst2._S.on && /exited/.test((inst2._S.last || {}).why || ''), JSON.stringify(inst2._S.last));
    t.check('exit: every eased app back to normal priority and Windows-managed efficiency (its own report)', eased.every((p) => prioOf(p) === NORMAL && !ecoOf(p)),
      eased.map((p) => `${p.pid}:${prioOf(p)}/${ecoOf(p)}`).join(' '));
    t.check('exit: the record is gone', !fs.existsSync(inst2._record));
    t.check('never: no write ever named a pid this test did not start', bad.length === 0, bad.join(' | '));
  } catch (e) {
    t.fail('the test threw', e && e.stack ? e.stack.split('\n').slice(0, 3).join(' ') : String(e));
  } finally {
    for (const i of insts) { try { i._S.stopped = true; clearTimeout(i._S.timer); } catch (_) { /* gone */ } }
    for (const p of started) B.kill(p.pid);
    try { const kids = started.find((p) => p.lines && p.lines.some((l) => /^CHILD /.test(l))); if (kids) for (const l of kids.lines) if (/^CHILD /.test(l)) B.kill(Number(l.split(' ')[1])); } catch (_) { /* gone */ }
    if (s) await s.stop();
    await B.cleanup(run.dir);
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) { /* busy */ }
  }
  process.exit(t.summary());
})();
