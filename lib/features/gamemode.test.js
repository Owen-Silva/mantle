'use strict';
/* gamemode.test.js - game mode's rules and its whole on/off/restore cycle over a FAKE Windows
 * (made-up process lists, power state, Energy saver). Nothing here reaches the real machine:
 * no sidecar, no Electron. node lib/features/gamemode.test.js */
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('./_gamemode-plan');
const GM = require('./gamemode');

let pass = 0, fail = 0;
const fails = [];
function check(name, ok, detail) { if (ok) pass++; else { fail++; fails.push(`  FAIL ${name}${detail ? ` (${detail})` : ''}`); } }

/* ---------------------------------------------------------------- the pure rules */
const fg = (exe, title, extra) => Object.assign({ pid: 900, exe: `C:\\x\\${exe}`, title: title || '', fullscreen: false, verdict: {} }, extra);
check('Valorant in front is a game (even windowed)', P.detectGame(fg('VALORANT-Win64-Shipping.exe')).game === true);
check('Roblox in front is a game', P.detectGame(fg('RobloxPlayerBeta.exe', 'Roblox')).game === true);
check('javaw with a Minecraft window is a game', P.detectGame(fg('javaw.exe', 'Minecraft 1.21.1 - Singleplayer')).game === true);
check('javaw with another window is not', P.detectGame(fg('javaw.exe', 'IntelliJ IDEA')).game === false);
check('Riot Client (the launcher) is not a game', P.detectGame(fg('RiotClientServices.exe', 'Riot Client', { fullscreen: true, verdict: { gameStore: true } })).game === false);
check('a browser in F11 full screen is not a game', P.detectGame(fg('msedge.exe', 'YouTube', { fullscreen: true, verdict: { quns: 2 } })).game === false);
check("a Game Bar-listed exe that fills its monitor is a game", P.detectGame(fg('Hades.exe', 'Hades', { fullscreen: true, verdict: { gameStore: true } })).how === 'store');
check('a Game Bar-listed exe in a window is not (yet) a game', P.detectGame(fg('Hades.exe', 'Hades', { verdict: { gameStore: true } })).game === false);
check('exclusive full-screen D3D is a game', P.detectGame(fg('old.exe', 'x', { verdict: { quns: 3 } })).how === 'exclusive');
check('Mantle in front is never a game', P.detectGame(Object.assign(fg('VALORANT-Win64-Shipping.exe'), { self: true })).game === false);

const V = fg('VALORANT-Win64-Shipping.exe');
const procsWithGame = [{ pid: 900, file: 'VALORANT-Win64-Shipping.exe' }, { pid: 5, file: 'x' }];
let d = P.step({ on: false }, { fg: V }, 0, { auto: true });
check('step: off + game in front -> on', d.action === 'on' && d.game.pid === 900, JSON.stringify(d));
check('step: automatic off -> stays off', P.step({ on: false }, { fg: V }, 0, { auto: false }).action === null);
const on = { on: true, how: 'auto', game: { pid: 900, file: 'VALORANT-Win64-Shipping.exe', lastFront: 1000 } };
check('step: on + game in front -> front', P.step(on, { fg: V, procs: procsWithGame }, 2000).action === 'front');
check('step: on + game behind for 60 s -> stays on', P.step(on, { fg: fg('Discord.exe'), procs: procsWithGame }, 61000).action === null);
check('step: on + game behind for 90 s -> off', P.step(on, { fg: fg('Discord.exe'), procs: procsWithGame }, 91000).action === 'off');
check('step: on + game process gone -> off', /exited/.test(P.step(on, { fg: fg('explorer.exe'), procs: [{ pid: 5, file: 'x' }] }, 2000).why || ''));
check('step: a reused pid with another name counts as exited', P.step(on, { fg: fg('explorer.exe'), procs: [{ pid: 900, file: 'notepad.exe' }] }, 2000).action === 'off');
check('step: manual stays on with no game', P.step({ on: true, how: 'manual', game: { pid: 0 } }, { fg: fg('explorer.exe'), procs: [] }, 999999).action === null);
check('step: turned off by hand -> not back on for the same run', P.step({ on: false, suppress: { pid: 900 } }, { fg: V, procs: procsWithGame }, 0).action === null);
check('step: ...and armed again once that game exits', P.step({ on: false, suppress: { pid: 900 } }, { fg: fg('explorer.exe'), procs: [] }, 0).action === 'unsuppress');

/* valofix, 2026-09-26: an exe path the anti-cheat will not give out, and games RUNNING (not in front) */
const noPath = { pid: 900, exe: '', title: 'VALORANT  ', fullscreen: false, verdict: {} };
check('an unreadable exe path is named from the process list by pid', P.detectGame(noPath, procsWithGame).game === true && P.detectGame(noPath, procsWithGame).file === 'VALORANT-Win64-Shipping.exe');
check('...and without a list it stays unnamed (no guessing from the title)', P.detectGame(noPath).game === false);
check('step: game mode comes on for a game whose exe path could not be read', P.step({ on: false }, { fg: noPath, procs: procsWithGame }, 0, { auto: true }).action === 'on');
const rs = (procs, fgw, own) => ({ fg: fgw || fg('explorer.exe'), procs, ownSession: own === undefined ? 1 : own });
let seen = new Map();
let run = P.runningGames(rs([{ pid: 900, file: 'VALORANT-Win64-Shipping.exe', session: 1 }, { pid: 5, file: 'explorer.exe', session: 1 }]), { seen });
check('running: Valorant counts while it is BEHIND another window', run.length === 1 && run[0].pid === 900, JSON.stringify(run));
check('running: VALORANT.exe (the stub Riot Client starts first) counts too', P.runningGames(rs([{ pid: 41, file: 'valorant.exe', session: 1 }])).length === 1);
check('running: Riot Client and its services are not games', P.runningGames(rs([{ pid: 7, file: 'RiotClientServices.exe', session: 1 }, { pid: 8, file: 'Riot Client.exe', session: 1 }])).length === 0);
check('running: Roblox and Minecraft (Bedrock) count by name', P.runningGames(rs([{ pid: 10, file: 'RobloxPlayerBeta.exe', session: 1 }, { pid: 11, file: 'Minecraft.Windows.exe', session: 1 }])).length === 2);
check("running: another user's session does not count", P.runningGames(rs([{ pid: 900, file: 'VALORANT-Win64-Shipping.exe', session: 2 }])).length === 0);
check('running: a stand-in counts only when passed as extra (tests)', P.runningGames(rs([{ pid: 60, file: 'mantle-standin-game.exe', session: 1 }])).length === 0 &&
  P.runningGames(rs([{ pid: 60, file: 'mantle-standin-game.exe', session: 1 }]), { extra: ['mantle-standin-game.exe'] }).length === 1);
seen = new Map();
const java = [{ pid: 70, file: 'javaw.exe', session: 1 }, { pid: 71, file: 'javaw.exe', session: 1 }];
check('running: javaw is not a game by name alone', P.runningGames(rs(java), { seen }).length === 0);
run = P.runningGames(rs(java, Object.assign(fg('javaw.exe', 'Minecraft 1.21.1'), { pid: 70 })), { seen });
check('running: javaw counts once it was in front with a Minecraft window', run.length === 1 && run[0].pid === 70 && seen.get(70) === 'javaw.exe', JSON.stringify(run));
run = P.runningGames(rs(java, fg('Discord.exe')), { seen });
check('running: ...and still counts behind another window', run.length === 1 && run[0].pid === 70);
P.runningGames(rs([{ pid: 71, file: 'javaw.exe', session: 1 }]), { seen });
check('running: ...until that pid is gone (then it is forgotten)', !seen.has(70));
check('running: an empty list (a failed snapshot) forgets nothing', (() => { const s = new Map([[70, 'javaw.exe']]); P.runningGames({ fg: null, procs: [] }, { seen: s }); return s.has(70); })());
check('running: no scan at all is no games, not a throw', P.runningGames(null).length === 0 && P.runningGames({}).length === 0);

const U = 'C:\\Users\\user\\';
const PROCS = [
  { pid: 900, ppid: 800, file: 'VALORANT-Win64-Shipping.exe', session: 1 },
  { pid: 901, ppid: 900, file: 'CrashReportClient.exe', session: 1, path: 'C:\\Riot Games\\VALORANT\\crash.exe', created: '1', prio: 'normal' },
  { pid: 910, ppid: 1, file: 'vgtray.exe', session: 1 },
  { pid: 911, ppid: 1, file: 'vgc.exe', session: 0 },
  { pid: 920, ppid: 1, file: 'Discord.exe', session: 1, path: U + 'AppData\\Local\\Discord\\Discord.exe', created: '2', prio: 'normal' },
  { pid: 930, ppid: 1, file: 'Spotify.exe', session: 1, path: U + 'AppData\\Roaming\\Spotify\\Spotify.exe', created: '3', prio: 'normal' },
  { pid: 940, ppid: 1, file: 'claude.exe', session: 1, path: U + '.local\\bin\\claude.exe', created: '4', prio: 'normal' },
  { pid: 941, ppid: 1, file: 'claude.exe', session: 1, path: U + '.local\\bin\\claude.exe', created: '5', prio: 'idle' },
  { pid: 950, ppid: 1, file: 'msedgewebview2.exe', session: 1, path: 'C:\\Program Files (x86)\\Microsoft\\EdgeWebView\\msedgewebview2.exe', created: '6', prio: 'normal' },
  { pid: 960, ppid: 1, file: 'electron.exe', session: 1, path: U + 'browser\\node_modules\\electron\\dist\\electron.exe', created: '7', prio: 'normal' },
  { pid: 961, ppid: 960, file: 'electron.exe', session: 1, path: U + 'browser\\node_modules\\electron\\dist\\electron.exe', created: '8', prio: 'normal' },
  { pid: 970, ppid: 1, file: 'electron.exe', session: 1, path: U + 'mantle-live\\node_modules\\electron\\dist\\electron.exe', created: '9', prio: 'normal' },
  { pid: 971, ppid: 970, file: 'Mantle.Sidecar.exe', session: 1, path: U + 'mantle-live\\sidecar\\bin\\Mantle.Sidecar.exe', created: '10', prio: 'normal' },
  { pid: 980, ppid: 1, file: 'explorer.exe', session: 1, path: 'C:\\Windows\\explorer.exe', created: '11', prio: 'normal' },
  { pid: 981, ppid: 1, file: 'svchost.exe', session: 0, path: 'C:\\Windows\\System32\\svchost.exe' },
  { pid: 990, ppid: 1, file: 'Taskmgr.exe', session: 1, path: 'C:\\Windows\\System32\\Taskmgr.exe', created: '12', prio: 'high', elevated: true },
  { pid: 991, ppid: 1, file: 'tool.exe', session: 1, path: U + 'tool.exe', created: '13', prio: 'normal', elevated: true },
  { pid: 992, ppid: 1, file: 'lghub_agent.exe', session: 1, path: 'C:\\Program Files\\LGHUB\\lghub_agent.exe', created: '14', prio: 'normal' },
  { pid: 993, ppid: 1, file: 'Lively.exe', session: 1, path: U + 'AppData\\Local\\Programs\\Lively Wallpaper\\Lively.exe', created: '15', prio: 'normal' },
];
const pl = P.plan(PROCS, { gamePid: 900, gameFile: 'VALORANT-Win64-Shipping.exe', fgPid: 900, sidecarPid: 971, ownSession: 1,
  mantlePids: new Set([970]), audioPids: new Set([961]) });
const tp = new Set(pl.targets.map((t) => t.pid));
const leftWhy = (pid) => (pl.left.find((l) => l.file === PROCS.find((p) => p.pid === pid).file) || {}).why;
check('plan: the game is never a target', !tp.has(900));
check("plan: the game's child process is left alone", !tp.has(901) && leftWhy(901) === 'the game');
check('plan: anti-cheat is never a target', !tp.has(910) && !tp.has(911));
check('plan: Discord (voice) and Spotify (music) are left alone', !tp.has(920) && !tp.has(930));
check("plan: the custom browser playing sound keeps ALL its processes (audio is a different process from the page)", !tp.has(960) && !tp.has(961));
check("plan: Mantle's sidecar is never a target", !tp.has(971));
check("plan: Windows' own parts are left alone (explorer, svchost, Task Manager)", !tp.has(980) && !tp.has(981) && !tp.has(990));
check('plan: an elevated app is left alone', !tp.has(991));
check('plan: input-device software is left alone', !tp.has(992));
check('plan: background apps are targets (claude, webview2, Lively)', tp.has(940) && tp.has(941) && tp.has(950) && tp.has(993));
check("plan: Mantle's own Electron is a target in the 'mantle' group", (pl.targets.find((t) => t.pid === 970) || {}).group === 'mantle');
check('apply item: below-normal only when the app is at normal', P.applyItem(pl.targets.find((t) => t.pid === 940)).prio === 'belownormal' && P.applyItem(pl.targets.find((t) => t.pid === 941)).prio === null);
const ri = P.restoreItem({ pid: 940, created: '4', file: 'claude.exe', eco: { was: { control: 0, state: 0 }, set: { control: 1, state: 1 } }, prio: { was: 'normal', set: 'belownormal' } });
check('restore item: back to what it was, only if it is still what game mode set', ri.eco.control === 0 && ri.ecoIf.control === 1 && ri.prio === 'normal' && ri.prioIf === 'belownormal');
check('record entry: nothing changed = nothing recorded', P.recordEntry({ pid: 1 }, { ok: true, same: true, eco: { wrote: false }, prio: { wrote: false } }) === null);
check('names(): counts by name', P.names([{ file: 'a.exe' }, { file: 'a.exe' }, { file: 'b.exe' }]) === 'a ×2, b');

/* ---------------------------------------------------------------- the cycle over a fake Windows */
function fakeWindows(o) {
  const W = Object.assign({ source: 'battery', cfg: { ac: 'performance', battery: 'balanced' }, saver: false, saverAt: 100, fg: fg('explorer.exe'),
    procs: JSON.parse(JSON.stringify(PROCS)), audio: [{ pid: 961, active: true }], audioFail: false, calls: [] }, o);
  for (const p of W.procs) { p.eco = { control: 0, state: 0 }; }
  W.find = (pid) => W.procs.find((p) => p.pid === pid);
  W.send = async (cmd, a) => {
    W.calls.push({ cmd, a: JSON.parse(JSON.stringify(a || {})) });
    const R = (result) => ({ ok: true, result });
    switch (cmd) {
      case 'gamemode.scan': {
        const r = { fg: W.fg, ownPid: 971, ownSession: 1 };
        if (a.procs) r.procs = W.procs.map((p) => (a.detail ? p : { pid: p.pid, ppid: p.ppid, file: p.file, session: p.session }));
        return R(r);
      }
      case 'audio': return W.audioFail ? { ok: false, error: 'no audio' } : R({ ok: true, sessions: W.audio });
      case 'powermode.get': {
        const saver = W.saver && W.source === 'battery' && W.saverAt > 0;
        return R({ ok: true, available: true, settable: !saver, saver, source: W.source, configured: Object.assign({}, W.cfg),
          reason: saver ? 'Energy saver is on, so Windows runs Best power efficiency and the power mode can\'t be set' : null });
      }
      case 'gamemode.power': {
        const was = W.cfg[a.source];
        if (was === a.mode) return R({ ok: true, same: true, before: was, after: was });
        if (a.onlyIf && was !== a.onlyIf) return R({ ok: true, skipped: true, before: was, after: was, reason: `left as ${was}` });
        W.cfg[a.source] = a.mode; return R({ ok: true, same: false, before: was, after: a.mode });
      }
      case 'gamemode.saver': {
        const was = W.saverAt;
        if (was === a.at) return R({ ok: true, same: true, before: was, after: was, saver: W.saver ? 1 : 0 });
        if (a.onlyIf >= 0 && was !== a.onlyIf) return R({ ok: true, skipped: true, before: was, after: was });
        W.saverAt = a.at; W.saver = a.at > 0; return R({ ok: true, same: false, before: was, after: a.at, saver: W.saver ? 1 : 0 });
      }
      case 'gamemode.apply': {
        const results = a.items.map((it) => {
          const p = W.find(it.pid);
          if (!p || (it.created && p.created !== it.created)) return { pid: it.pid, ok: false, gone: true, why: 'it has exited' };
          const r = { pid: p.pid, file: p.file, created: p.created, ok: true };
          if (it.eco) {
            const before = Object.assign({}, p.eco);
            if (it.ecoIf && (before.control !== it.ecoIf.control || before.state !== it.ecoIf.state)) r.eco = { before, wrote: false, skipped: true };
            else if (before.control === it.eco.control && before.state === it.eco.state) r.eco = { before, wrote: false };
            else { p.eco = Object.assign({}, it.eco); r.eco = { before, wrote: true }; }
          }
          if (it.prio) {
            const before = p.prio;
            if (before === it.prio) r.prio = { before, wrote: false };
            else if (it.prioIf && before !== it.prioIf) r.prio = { before, wrote: false, skipped: true };
            else { p.prio = it.prio; r.prio = { before, wrote: true }; }
          }
          return r;
        });
        return R({ results });
      }
    }
    return { ok: false, error: `unknown command ${cmd}` };
  };
  return W;
}
function fakeCtx(W, flags, settings) {
  const store = Object.assign({}, settings);
  const ctx = {
    name: 'gamemode', flags: Object.assign({ test: false, live: false }, flags), logs: [], health_: null, pushes: [],
    log: (t) => ctx.logs.push(t), health: (ok, why) => { ctx.health_ = { ok, why }; },
    enabled: () => true, onEnabled: () => {}, broadcast: (ev, p) => ctx.pushes.push(p), replay: () => {},
    commands: {}, command: (v, fn) => { ctx.commands[v] = fn; },
    settings: { get: (k, dflt) => (k in store ? store[k] : dflt), set: (k, v) => { store[k] = v; }, file: path.join(os.tmpdir(), 'x', 'features', 'gamemode.json') },
    sidecar: { ready: true, send: (c, a) => W.send(c, a), on: () => () => {}, onReady: (fn) => { ctx.ready_ = fn; return () => {}; } },
  };
  return ctx;
}
const NEVER_PIDS = [900, 901, 910, 911, 920, 930, 960, 961, 971, 980, 981, 990, 991, 992];
function touched(W) { return W.calls.filter((c) => c.cmd === 'gamemode.apply').flatMap((c) => c.a.items.map((i) => i.pid)); }
function spawned() { const s = []; const fn = (exe, args) => { s.push(args.join(' ')); return { on: () => {} }; }; fn.list = s; return fn; }

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-test-'));
  let t = 0;
  const clock = () => t;
  const wp = { held: null, gameHold(x) { this.held = x; return { held: !!x, pause: { paused: true } }; } };

  // 1) a normal run: on for Valorant, everything recorded, all put back when it exits
  let W = fakeWindows();
  let sp = spawned();
  let ctx = fakeCtx(W);
  let inst = GM.install(ctx, { userData: dir, now: clock, mantlePids: () => [970], wallpaper: wp, spawn: sp });
  await ctx.ready_();
  await inst._tick();
  check('cycle: nothing in front -> off', !inst._S.on);
  W.fg = V; t = 1000;
  await inst._tick();
  const S = inst._S;
  check('cycle: Valorant in front -> on (auto)', S.on && S.how === 'auto', JSON.stringify(S.actions));
  check('cycle: Best performance on battery, was balanced', W.cfg.battery === 'performance' && W.cfg.ac === 'performance');
  check('cycle: background apps in Efficiency mode', W.find(940).eco.control === 1 && W.find(950).eco.state === 1 && W.find(993).eco.control === 1);
  check('cycle: below-normal only for apps that were normal', W.find(940).prio === 'belownormal' && W.find(941).prio === 'idle');
  check("cycle: Mantle's own Electron in Efficiency mode", W.find(970).eco.control === 1);
  check('cycle: ANTI-CHEAT / never-touch: none of them was ever sent to the sidecar', !touched(W).some((p) => NEVER_PIDS.includes(p)), touched(W).join(','));
  check('cycle: the wallpaper is held paused', /game mode/.test(wp.held || ''));
  check('cycle: Lively paused with its own command', sp.list[0] === 'app --play false', sp.list.join('|'));
  const rec = JSON.parse(fs.readFileSync(inst._record, 'utf8'));
  check('cycle: the restore record is on disk with what changed', rec.power.battery.was === 'balanced' && rec.procs.length >= 5 && rec.wallpaper && rec.lively, JSON.stringify(rec).slice(0, 200));
  check('cycle: every action has a row with a status and words', ['power', 'saver', 'background', 'mantle', 'wallpaper', 'lively', 'notify', 'game'].every((k) => S.actions.some((a) => a.key === k && a.status && a.text)), S.actions.map((a) => a.key).join(','));
  W.fg = fg('Discord.exe'); t = 60000;
  await inst._tick();
  check('cycle: alt-tab to Discord for a minute -> still on', S.on);
  W.fg = V; t = 70000; await inst._tick();
  W.procs = W.procs.filter((p) => p.pid !== 900); W.fg = fg('explorer.exe'); t = 80000;
  await inst._tick();
  check('cycle: Valorant exits -> off', !S.on && /exited/.test(S.last.why), JSON.stringify(S.last));
  check('cycle: power mode put back', W.cfg.battery === 'balanced');
  check('cycle: every app put back', W.procs.every((p) => p.eco.control === 0 && p.prio !== 'belownormal'), JSON.stringify(W.procs.filter((p) => p.eco.control || p.prio === 'belownormal').map((p) => p.pid)));
  check('cycle: wallpaper let go, Lively resumed', wp.held === null && sp.list[1] === 'app --play true', sp.list.join('|'));
  check('cycle: the record is gone after a clean restore', !fs.existsSync(inst._record));
  check('cycle: logged on and restore lines', ctx.logs.some((l) => /^on \(auto\)/.test(l)) && ctx.logs.some((l) => /^restore \(VALORANT/.test(l)), ctx.logs.join(' / '));
  // gamequiet (2026-09-28): the processes slowed are in the log by IMAGE NAME, one line per new batch.
  const slowedLines = ctx.logs.filter((l) => /^slowed /.test(l));
  const sl = slowedLines[0] || '';
  check('cycle: gamequiet: ONE "slowed" line (replans with nothing new add none)', slowedLines.length === 1, slowedLines.join(' / '));
  check('cycle: gamequiet: it names the slowed processes by image name (claude.exe, Lively.exe, Mantle\'s own)',
    /^slowed \d+ processes \(Efficiency mode, below-normal\): /.test(sl) && /\bclaude\.exe\b/.test(sl) && /\bLively\.exe\b/.test(sl) && sl.includes(PROCS.find((p) => p.pid === 970).file), sl);
  check('cycle: gamequiet: no path, no never-touch name in it', !/[\\/]/.test(sl) && !PROCS.some((p) => p.path && sl.includes(p.path)) && !/VALORANT|vgc|Discord|Spotify/i.test(sl), sl);

  // 2) Owen changes things mid-game: his change wins at restore
  W = fakeWindows(); W.fg = V; ctx = fakeCtx(W); t = 0;
  inst = GM.install(ctx, { userData: dir, now: clock, mantlePids: () => [970], wallpaper: wp, spawn: spawned() });
  await ctx.ready_(); await inst._tick();
  W.cfg.battery = 'efficiency'; W.find(950).eco = { control: 0, state: 0 }; W.find(940).prio = 'high';
  await ctx.commands.set({ on: false });
  check('his change wins: power left at his new choice', W.cfg.battery === 'efficiency');
  check('his change wins: an app that changed its own setting is left as it is', W.find(940).prio === 'high');
  check('turned off by hand: not back on while the same game runs', (await inst._tick(), !inst._S.on) && !!inst._S.suppress);

  // 3) crash: a record left on disk is put back at the next start
  W = fakeWindows(); W.fg = V; ctx = fakeCtx(W); t = 0;
  inst = GM.install(ctx, { userData: dir, now: clock, mantlePids: () => [970], wallpaper: wp, spawn: spawned() });
  await ctx.ready_(); await inst._tick();
  check('crash: on, record written', inst._S.on && fs.existsSync(inst._record));
  W.fg = fg('explorer.exe');   // Mantle "dies" here: no stop(); a new instance starts
  const ctx2 = fakeCtx(W);
  const inst2 = GM.install(ctx2, { userData: dir, now: clock, mantlePids: () => [970], wallpaper: wp, spawn: spawned() });
  await ctx2.ready_();
  check('crash: the next start put everything back', W.cfg.battery === 'balanced' && W.procs.every((p) => p.eco.control === 0 && p.prio !== 'belownormal'));
  check('crash: and says so in the panel', inst2._S.fromCrash && inst2._S.fromCrash.ok === true && /back to normal/.test(inst2._S.fromCrash.text), JSON.stringify(inst2._S.fromCrash));
  check('crash: record removed', !fs.existsSync(inst2._record));

  // 4) Energy saver on battery: said plainly and left alone, unless Owen opted in
  W = fakeWindows({ saver: true }); W.fg = V; ctx = fakeCtx(W); t = 0;
  inst = GM.install(ctx, { userData: dir, now: clock, mantlePids: () => [], wallpaper: wp, spawn: spawned() });
  await ctx.ready_(); await inst._tick();
  const saverRow = inst._S.actions.find((a) => a.key === 'saver');
  check('saver: left on and said plainly', saverRow.status === 'blocked' && /Energy saver is on/.test(saverRow.text) && /Lift Energy saver/.test(saverRow.text), saverRow.text);
  check('saver: no saver or power write', !W.calls.some((c) => c.cmd === 'gamemode.saver' || c.cmd === 'gamemode.power') && W.cfg.battery === 'balanced');
  await ctx.commands.set({ on: false });
  W = fakeWindows({ saver: true }); W.fg = V; ctx = fakeCtx(W, {}, { liftSaver: true }); t = 0;
  inst = GM.install(ctx, { userData: dir, now: clock, mantlePids: () => [], wallpaper: wp, spawn: spawned() });
  await ctx.ready_(); await inst._tick();
  check('saver (opted in): lifted to 0% and Best performance set', W.saverAt === 0 && W.cfg.battery === 'performance', JSON.stringify(inst._S.actions.find((a) => a.key === 'saver')));
  await ctx.commands.set({ on: false });
  check('saver (opted in): put back to 100% and balanced', W.saverAt === 100 && W.cfg.battery === 'balanced');

  // 5) sound unreadable: nothing is slowed (a call must never be)
  W = fakeWindows({ audioFail: true }); W.fg = V; ctx = fakeCtx(W); t = 0;
  inst = GM.install(ctx, { userData: dir, now: clock, mantlePids: () => [], wallpaper: wp, spawn: spawned() });
  await ctx.ready_(); await inst._tick();
  check('audio unreadable: background left alone, and said', !W.calls.some((c) => c.cmd === 'gamemode.apply') && inst._S.actions.find((a) => a.key === 'background').status === 'blocked');
  await ctx.commands.set({ on: false });

  // 6) the dry run (a --test Mantle): planned and shown, no write command sent at all
  W = fakeWindows(); W.fg = V; ctx = fakeCtx(W, { test: true }); t = 0;
  const sp6 = spawned();
  inst = GM.install(ctx, { userData: dir, now: clock, mantlePids: () => [970], wallpaper: wp, spawn: sp6 });
  await ctx.ready_(); await inst._tick();
  const writes = W.calls.filter((c) => /^gamemode\.(apply|power|saver)$/.test(c.cmd));
  check('dry run: on, with the plan shown', inst._S.on && inst._S.actions.some((a) => a.status === 'dry'), JSON.stringify(inst._S.actions.map((a) => a.status)));
  check('dry run: NO write command sent, nothing spawned, no record', writes.length === 0 && sp6.list.length === 0 && !fs.existsSync(inst._record) && wp.held === null, JSON.stringify(writes));
  W.procs = W.procs.filter((p) => p.pid !== 900); t = 5000; await inst._tick();
  check('dry run: off when the game exits', !inst._S.on);

  // 7) manual on with no game, and the tray's stop()
  W = fakeWindows(); ctx = fakeCtx(W); t = 0;
  inst = GM.install(ctx, { userData: dir, now: clock, mantlePids: () => [], wallpaper: wp, spawn: spawned() });
  await ctx.ready_(); await inst._tick();
  await ctx.commands.set({ on: true });
  check('manual: on with no game', inst._S.on && inst._S.how === 'manual');
  t = 10 * 60 * 1000; await inst._tick();
  check('manual: stays on', inst._S.on);
  await inst.stop('test');
  check('stop(): everything put back and the record removed', !inst._S.on && W.cfg.battery === 'balanced' && !fs.existsSync(inst._record));

  // Mantle RESTS while a game runs (lane memfix, 2026-09-26): the pure rule, then the cycle.
  {
    const run = [{ pid: 800, file: 'VALORANT.exe' }, { pid: 900, file: 'VALORANT-Win64-Shipping.exe' }];
    const resting = { resting: true, why: 'VALORANT runs', hold: null };
    check('rest: one label for the stub and the game', P.gameLabel(['VALORANT.exe', 'C:\\x\\VALORANT-Win64-Shipping.exe']) === 'VALORANT');
    let d = P.restStep({ resting: false }, { run, on: false });
    check('rest: a known game RUNNING, not in front, game mode off -> rest', d.action === 'rest' && d.why === 'VALORANT runs', JSON.stringify(d));
    check('rest: still running -> nothing', P.restStep(resting, { run, on: false }).action === null);
    d = P.restStep(resting, { run: [], on: false });
    check('rest: the last game exited -> wake, said plainly', d.action === 'wake' && d.why === 'VALORANT exited', JSON.stringify(d));
    check('rest: exited but game mode not off yet -> stays resting', P.restStep(resting, { run: [], on: true, how: 'auto', game: 'VALORANT-Win64-Shipping.exe' }).action === null);
    d = P.restStep({ resting: false }, { run: [], on: true, how: 'manual', game: null });
    check('rest: game mode on by hand, no game -> rest', d.action === 'rest' && d.why === 'game mode is on (by hand)', JSON.stringify(d));
    d = P.restStep(Object.assign({}, resting, { hold: [900] }), { run, on: false });
    check('rest: off by hand mid-game -> wake, and the hold is kept', d.action === 'wake' && /by hand/.test(d.why) && d.hold && d.hold[0] === 900, JSON.stringify(d));
    d = P.restStep({ resting: false, hold: [900] }, { run, on: false });
    check('rest: held for this run -> no rest again', d.action === null && d.hold);
    d = P.restStep({ resting: false, hold: [900] }, { run: [{ pid: 901, file: 'VALORANT-Win64-Shipping.exe' }], on: false });
    check('rest: the next run of the game (new pid) -> rest again, hold dropped', d.action === 'rest' && d.hold === null);
    d = P.restStep(resting, { run, on: false, enabled: false });
    check("rest: game mode switched off in the tray -> wake", d.action === 'wake' && /tray/.test(d.why));
    check('rest: the stand-in list counts (extra names)', P.runningGames({ procs: [{ pid: 7, file: 'memfix-standin.exe' }] }, { extra: ['memfix-standin.exe'] }).length === 1);
    // gamequiet (2026-09-28): main.js keeps the bar down and screen capture off only when the rest's
    // words say a GAME runs; game mode on by hand with no game changes nothing there.
    const whyOf = (R, x) => P.restStep(R, x).why;
    const gameWhys = [whyOf({ resting: false }, { run, on: false }),
      whyOf({ resting: false }, { run: run.concat([{ pid: 950, file: 'RobloxPlayerBeta.exe' }]), on: false }),
      whyOf({ resting: false }, { run: [], on: true, how: 'auto', game: 'VALORANT-Win64-Shipping.exe' }),
      whyOf({ resting: false }, { run: [], on: true, how: 'manual', game: 'cs2.exe' }),
      whyOf({ resting: false }, { run: [], on: true, how: 'auto', game: 'SomeStoreGame.exe' })];
    check('rest: gamequiet: every rest for a game reads as a game (restIsGame)', gameWhys.every((w) => P.restIsGame(w)), JSON.stringify(gameWhys));
    const noGame = [whyOf({ resting: false }, { run: [], on: true, how: 'manual', game: null }), whyOf({ resting: false }, { run: [], on: true, how: 'auto', game: null }), null, undefined, '', 'VALORANT exited'];
    check('rest: gamequiet: game mode on with no game, no rest, a wake: not a game', noGame.every((w) => !P.restIsGame(w)), JSON.stringify(noGame));

    W = fakeWindows(); W.fg = fg('explorer.exe'); ctx = fakeCtx(W); t = 0;
    const calls = [];
    ctx.host = { rest: async (on, why) => { calls.push([on, why]); return on ? { ok: true, text: 'closed 9 windows (launcher, switcher); Mantle\'s memory 585 MB -> 330 MB' } : { ok: true, back: ['launcher'] }; } };
    inst = GM.install(ctx, { userData: dir, now: clock, mantlePids: () => [], wallpaper: wp, spawn: spawned() });
    await ctx.ready_(); await inst._tick();
    let st = await ctx.commands.state();
    check('rest cycle: Valorant running behind explorer -> Mantle rests once, game mode stays off', calls.length === 1 && calls[0][0] === true && calls[0][1] === 'VALORANT runs' && !st.on, JSON.stringify(calls));
    check('rest cycle: the tile gets the words with the numbers', st.rest.on && /^Mantle is resting while VALORANT runs: closed 9 windows .*585 MB -> 330 MB/.test(st.rest.text), JSON.stringify(st.rest));
    check('rest cycle: one log line with before/after', ctx.logs.filter((l) => /^Mantle is resting while VALORANT runs: closed 9 windows.*585 MB -> 330 MB/.test(l)).length === 1, ctx.logs.join(' / '));
    t = 5000; await inst._tick();
    check('rest cycle: another tick -> no second rest', calls.length === 1);
    W.procs = W.procs.filter((p) => p.pid !== 900); t = 60000; await inst._tick();
    st = await ctx.commands.state();
    check('rest cycle: Valorant exits -> Mantle comes back', calls.length === 2 && calls[1][0] === false && calls[1][1] === 'VALORANT exited' && !st.rest.on, JSON.stringify(calls));
    check('rest cycle: said after, with how long', /Mantle rested under a minute \(VALORANT runs\) and is back: VALORANT exited/.test(st.rest.last && st.rest.last.text), JSON.stringify(st.rest));
    // By hand: on = rest; off while a game runs = back for this run of it
    await ctx.commands.set({ on: true });
    check('rest cycle: game mode on by hand -> rest', calls.length === 3 && calls[2][0] === true && calls[2][1] === 'game mode is on (by hand)', JSON.stringify(calls));
    W.procs.push({ pid: 902, ppid: 1, file: 'VALORANT-Win64-Shipping.exe', session: 1, created: 5, eco: { control: 0, state: 0 }, prio: 'normal' });
    t = 70000; await inst._tick();
    check('rest cycle: a game starts meanwhile -> the reason follows it', calls.length === 4 && calls[3][1] === 'VALORANT runs', JSON.stringify(calls));
    await ctx.commands.set({ on: false });
    check('rest cycle: off by hand while it runs -> Mantle back', calls.length === 5 && calls[4][0] === false, JSON.stringify(calls));
    t = 80000; await inst._tick();
    check('rest cycle: ...and it stays back for this run', calls.length === 5 && inst._S.rest.hold && inst._S.rest.hold[0] === 902, JSON.stringify(inst._S.rest));
    W.procs = W.procs.filter((p) => p.pid !== 902); t = 90000; await inst._tick();
    check('rest cycle: the hold ends with that run', inst._S.rest.hold === null && calls.length === 5);
    await inst.stop('test');
  }

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`GAMEMODE UNIT TEST: ${pass} passed, ${fail} failed`);
  if (fails.length) console.log(fails.join('\n'));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
