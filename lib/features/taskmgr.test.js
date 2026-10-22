'use strict';
/*
 * taskmgr.test.js - Mantle's task manager in node: no Electron, no sidecar, NO REAL PROCESS
 * (lane taskmgr, 2026-09-28).
 *
 *   node lib/features/taskmgr.test.js
 *
 * Every process here is a row in a FAKE table (made-up pids, names and paths); the fake sidecar
 * answers taskmgr.snapshot / close / trim / cmdline from it and never runs anything, and the fake
 * spawn only records what it was asked. Proves the grouping (Chrome is one row, a Steam game is its
 * own row, Mantle's row, apps Mantle started are NOT Mantle's, pid reuse), the memory sum, CPU %,
 * protection words, actions (force needs the confirm, protected refused before the sidecar, games
 * never trimmed, --test forces dry runs), closes that end / do not end and their words, Free up RAM
 * with ticks (protected/game/Spotify ticks ignored), the game-start option (off = nothing closes),
 * reopen after the game (Store app cannot, with its reason), the window's life (created on open,
 * never shown in --test, destroyed on close, no sampling after), and PRIVACY: no name, path or
 * title of the fake table in any log line.
 *
 * Prints one summary line, "TASKMGR: n passed, m failed"; exits 1 if anything failed.
 */
const path = require('path');
const C = require('./_taskmgr-core.js');
const F = require('./taskmgr.js');
const { validate } = require('../features.js');

let passed = 0;
const failures = [];
function check(name, ok, detail) { if (ok) passed++; else failures.push(name + (detail !== undefined ? ' -- ' + detail : '')); }
const show = (x) => JSON.stringify(x);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MB = 1048576;

/* ------------------------------------------------------------------ a fake process table */
const MANTLE = 9000;
function P(pid, ppid, file, o) {
  return Object.assign({ pid, ppid, file, created: String(1000 + pid), pws: 10 * MB, cpu: 0, session: 1, path: `C:\\Fake\\${file}`, desc: null, windows: 0, title: null }, o || {});
}
function table() {
  return [
    P(4, 0, 'System', { session: 0, path: null }),
    P(600, 4, 'csrss.exe', { session: 0, path: null }),
    P(700, 600, 'services.exe', { session: 0, path: null }),
    P(710, 700, 'svchost.exe', { session: 0, path: null }),
    P(1000, 999, 'explorer.exe', { windows: 1, title: 'File Explorer', pws: 80 * MB }),
    // Chrome: a browser process with a window and five children of the same exe
    P(2000, 1000, 'chrome.exe', { windows: 2, title: 'Made-up tab - Google Chrome', desc: 'Google Chrome', pws: 300 * MB, path: 'C:\\Fake Apps\\Chrome\\chrome.exe' }),
    ...[1, 2, 3, 4, 5].map((i) => P(2000 + i, 2000, 'chrome.exe', { pws: 100 * MB, path: 'C:\\Fake Apps\\Chrome\\chrome.exe' })),
    // Steam: its window belongs to a webhelper child; a game it started is its own row
    P(3000, 1000, 'steam.exe', { pws: 60 * MB }),
    P(3001, 3000, 'steamwebhelper.exe', { windows: 1, title: 'Steam', pws: 150 * MB }),
    P(3002, 3000, 'cs2.exe', { windows: 1, title: 'Counter-Strike 2', pws: 2000 * MB }),
    // Mantle: its Electron (main + two renderers), its sidecar and what the sidecar runs
    P(MANTLE, 1000, 'electron.exe', { pws: 120 * MB }),
    P(9001, MANTLE, 'electron.exe', { pws: 90 * MB }),
    P(9002, MANTLE, 'electron.exe', { pws: 40 * MB }),
    P(9003, MANTLE, 'Mantle.Sidecar.exe', { pws: 20 * MB }),
    P(9004, 9003, 'powershell.exe', { pws: 3 * MB }),
    // started BY Mantle (the launcher / the Spotify card): apps of their own, not Mantle's row
    P(9100, MANTLE, 'Spotify.exe', { pws: 280 * MB, desc: 'Spotify' }),
    P(9101, 9100, 'Spotify.exe', { pws: 40 * MB }),
    P(9200, MANTLE, 'Discord.exe', { windows: 1, title: 'Discord', desc: 'Discord', pws: 250 * MB, path: 'C:\\Users\\x\\AppData\\Local\\Discord\\app-1.0\\Discord.exe' }),
    P(9201, 9200, 'Discord.exe', { pws: 120 * MB, path: 'C:\\Users\\x\\AppData\\Local\\Discord\\app-1.0\\Discord.exe' }),
    // Lively, anti-cheat in the user session, a Store app, an elevated app (no path), another Mantle
    P(5000, 1000, 'Lively.exe', { pws: 70 * MB }),
    P(5100, 1000, 'vgtray.exe', { pws: 5 * MB }),
    P(5200, 710, 'Notes.exe', { windows: 1, title: 'Notes', pws: 90 * MB, path: 'C:\\Program Files\\WindowsApps\\Fake.Notes_1.0\\Notes.exe' }),
    P(5300, 1000, 'Tool.exe', { pws: 30 * MB, path: null }),
    P(5400, 1000, 'electron.exe', { pws: 50 * MB, path: 'C:\\Users\\x\\mantle-live\\node_modules\\electron\\dist\\electron.exe' }),
    P(5401, 5400, 'Mantle.Sidecar.exe', { pws: 20 * MB }),
    // pid reuse: this child's "parent" pid now belongs to a process YOUNGER than it
    P(6000, 1000, 'Updater.exe', { pws: 5 * MB, created: '9999999' }),
    P(6001, 6000, 'Orphan.exe', { pws: 7 * MB, created: '5000' }),
  ];
}
const NAMES = ['chrome', 'steam', 'Counter-Strike', 'Spotify', 'Discord', 'Lively', 'vgtray', 'Notes', 'Tool', 'Updater', 'Orphan', 'Fake', 'Made-up', 'explorer'];
const snap = (procs, t) => ({ t: t || 1000, cpus: 4, mem: { total: 16384 * MB, avail: 6000 * MB, used: 10384 * MB }, procs, parentPid: MANTLE, selfPid: 9003, method: 'NtQuerySystemInformation(SystemProcessInformation).WorkingSetPrivateSize' });

/* ------------------------------------------------------------------ core */
function coreTests() {
  const b = C.buildGroups(snap(table()), null, { mantlePid: MANTLE });
  const by = (pid) => b.groups.find((g) => g.root === pid);
  const chrome = by(2000);
  check('chrome: 6 processes are ONE row', chrome && chrome.count === 6 && b.groups.filter((g) => /chrome/.test(g.file)).length === 1, show(chrome && chrome.count));
  check('chrome: memory = sum of private working sets (300 + 5x100 MB)', chrome.mem === 800 * MB, chrome.mem / MB);
  check('chrome: named by its description, an app (it has a window)', chrome.name === 'Google Chrome' && chrome.kind === 'app');
  check('chrome: identity is its exe path, lower case', chrome.identity === 'c:\\fake apps\\chrome\\chrome.exe', chrome.identity);
  const steam = by(3000);
  check('steam: its webhelper (which owns the window) is on the Steam row', steam && steam.count === 2 && steam.kind === 'app', show(steam && steam.members.map((m) => m.pid)));
  const game = by(3002);
  check('a game Steam started is its OWN row (never closed with Steam), marked game', game && game.game && game.count === 1);
  check('game: close/force offered, trim never', show(C.actionsFor(game)) === show({ close: true, force: true, trim: false, why: C.actionsFor(game).why }) && /never trims a game/.test(C.actionsFor(game).why));
  const m = b.mantle;
  check('Mantle: one row = main + 2 renderers + sidecar + the sidecar\'s helper', m && m.root === MANTLE && m.count === 5 && m.mem === (120 + 90 + 40 + 20 + 3) * MB, show(m && m.members.map((x) => x.pid)));
  check('Mantle: protected with its words, kind mantle', m.kind === 'mantle' && /Mantle itself/.test(m.protected));
  check('Spotify started by Mantle is its own row, handled by the Spotify card', by(9100) && by(9100).count === 2 && by(9100).handledBy === 'spotify' && by(9100).kind === 'background');
  check('Discord started by Mantle is its own app row', by(9200) && by(9200).count === 2 && by(9200).kind === 'app');
  check('explorer: protected (the shell)', /Explorer/.test(by(1000).protected));
  check('csrss: a Windows row, protected', by(600).kind === 'windows' && !!by(600).protected);
  check('svchost children are their own rows (a service host is a launcher)', by(5200) && by(5200).count === 1);
  check('Lively: protected with its words', /Lively, your wallpaper app/.test(by(5000).protected));
  check('anti-cheat in the user session: protected', /anti-cheat/.test(by(5100).protected));
  check('another Mantle (its sidecar is in the tree): protected', /Another Mantle/.test(by(5400).protected) && by(5400).count === 2);
  check('an app whose path Windows would not give: marked elevated', by(5300).elevated === true);
  check('pid reuse: a child is never adopted by a YOUNGER process with its parent\'s pid', by(6001) && by(6000).count === 1);
  check('rows sorted by memory, biggest first', b.groups.every((g, i) => i === 0 || b.groups[i - 1].mem >= g.mem));
  const sum = b.groups.reduce((s, g) => s + g.mem, 0);
  check('every process is on exactly one row', b.groups.reduce((s, g) => s + g.count, 0) === table().length && sum === table().reduce((s, p) => s + p.pws, 0));
  check('protected rows offer no action', ['close', 'force', 'trim'].every((k) => C.actionsFor(m)[k] === false && C.actionsFor(by(5000))[k] === false));

  // CPU %: 4 cores, 1500 ms apart: 6000 ms of core time = 60,000,000 units of 100 ns
  const t1 = table(), t2 = table();
  t2.find((p) => p.pid === 2001).cpu = 15000000;     // 1.5 s of CPU in 1.5 s on 4 cores = 25 %
  t2.find((p) => p.pid === 2002).cpu = 6000000;      // 10 %
  const b2 = C.buildGroups(snap(t2, 2500), snap(t1, 1000), { mantlePid: MANTLE });
  check('CPU %: the group sums its members (25 + 10)', b2.groups.find((g) => g.root === 2000).cpu === 35, b2.groups.find((g) => g.root === 2000).cpu);
  check('CPU %: nothing on the first sample', C.buildGroups(snap(t1), null, {}).groups.every((g) => g.cpu === 0));

  // prep + plan
  const ticks = { [chrome.identity]: { on: true, reopen: true }, [by(9100).identity]: { on: true }, [m.identity]: { on: true }, [game.identity]: { on: true }, [by(5000).identity]: { on: true }, 'c:\\gone\\x.exe': { on: true } };
  const prep = C.prepRows(b.groups, ticks);
  const pr = (pid) => prep.find((r) => r.key === by(pid).key);
  check('prep: Spotify shows as handled by the Spotify card, not tickable', pr(9100) && !pr(9100).tickable && /Spotify card/.test(pr(9100).why));
  check('prep: Chrome ticked with reopen', pr(2000).ticked && pr(2000).reopen && pr(2000).tickable);
  check('prep: Mantle, Lively and the game are not tickable', !pr(MANTLE) && pr(5000) && !pr(5000).tickable && pr(3002) && !pr(3002).tickable, show([pr(MANTLE), pr(5000) && pr(5000).why, pr(3002) && pr(3002).why]));
  const plan = C.planFree(b.groups, ticks);
  check('plan: ONLY the ticked closable app (Chrome); ticks on Spotify/Mantle/game/Lively ignored', plan.length === 1 && plan[0].root === 2000 && plan[0].procs.length === 6 && plan[0].reopen, show(plan.map((p) => p.root)));
  check('plan: nothing ticked, nothing planned', C.planFree(b.groups, {}).length === 0);

  // command lines
  const cases = [
    ['"C:\\Program Files\\App\\app.exe" --a "b c" d', ['C:\\Program Files\\App\\app.exe', '--a', 'b c', 'd']],
    ['app.exe a\\\\"b c" "x""y" \\\\\\"q', ['app.exe', 'a\\b c', 'x"y', '\\"q']],
    ['C:\\x\\a.exe  --flag=C:\\dir\\ ', ['C:\\x\\a.exe', '--flag=C:\\dir\\']],
    ['"C:\\a b\\c.exe"', ['C:\\a b\\c.exe']],
  ];
  for (const [line, want] of cases) check(`cmdline split: ${line}`, show(C.splitCmdline(line)) === show(want), show(C.splitCmdline(line)));
  const yes = () => true;
  check('reopen: exe + args, Chromium --type= dropped', show(C.reopenPlan({ path: 'C:\\A\\a.exe', cmdline: '"C:\\A\\a.exe" --x --type=renderer' }, yes)) === show({ exe: 'C:\\A\\a.exe', args: ['--x'] }));
  check('reopen: a Store app cannot, and says why', /Store app/.test(C.reopenPlan({ path: 'C:\\Program Files\\WindowsApps\\X\\x.exe', cmdline: 'x' }, yes).why));
  check('reopen: no path (elevated) cannot, with a reason', C.reopenPlan({ path: null, why: 'Windows did not let Mantle read it (it runs as administrator)' }, yes).exe === null);
  check('reopen: a gone exe cannot', /no longer where/.test(C.reopenPlan({ path: 'C:\\A\\a.exe', cmdline: 'a' }, () => false).why));
  check('reopen: no command line reopens without arguments and says so', (() => { const r = C.reopenPlan({ path: 'C:\\A\\a.exe', cmdline: null, why: 'its command line could not be read' }, yes); return r.exe && r.args.length === 0 && /command line/.test(r.note); })());
  check('mb: Task Manager unit', C.mb(1234.4 * MB) === '1,234 MB' && C.mb(-1) === '—');
}

/* ------------------------------------------------------------------ the feature against a fake ctx */
function emitter(o) {
  const L = {};
  o.on = (ev, fn) => { (L[ev] = L[ev] || []).push(fn); return o; };
  o.once = (ev, fn) => { const w = (...a) => { o.off(ev, w); fn(...a); }; return o.on(ev, w); };
  o.off = o.removeListener = (ev, fn) => { L[ev] = (L[ev] || []).filter((f) => f !== fn); return o; };
  o.emit = (ev, ...a) => { for (const f of (L[ev] || []).slice()) f(...a); return (L[ev] || []).length > 0; };
  return o;
}
const made = [];
class FakeWin {
  constructor(opts) {
    emitter(this);
    this.opts = opts; this.shown = 0; this.focused = 0; this.destroyed = false;
    const self = this;
    this.webContents = emitter({ isDestroyed: () => self.destroyed, setWindowOpenHandler() {}, send() {} });
    made.push(this);
  }
  loadFile(p) { this.file = p; }
  setAppDetails(o) { this.appDetails = o; }
  show() { this.shown++; } focus() { this.focused++; } restore() {} minimize() {} maximize() {} unmaximize() {}
  isMinimized() { return false; } isMaximized() { return false; } getBounds() { return { x: 0, y: 0, width: 780, height: 640 }; }
  isDestroyed() { return this.destroyed; }
  destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('closed'); } }
}
const fakeScreen = { getPrimaryDisplay: () => ({ bounds: { x: 0, y: 0, width: 1536, height: 864 }, workArea: { x: 0, y: 0, width: 1536, height: 816 } }) };

function fakeCtx(o) {
  const opts = o || {};
  const c = { logs: [], health: [], pushes: [], commands: {}, sends: [], settings: Object.assign({}, opts.settings || {}), on: true, procs: table(), t: 1000, spawned: [], replays: {} };
  c.ctx = {
    name: 'taskmgr',
    flags: { test: !opts.live, live: !!opts.live },
    log: (t) => c.logs.push(String(t)),
    health: (ok, why) => c.health.push({ ok, why }),
    enabled: () => c.on,
    onEnabled: () => () => {},
    onChord: () => () => {},
    push: (w, ev, p) => { c.pushes.push({ ev, p }); return true; },
    replay: (ev, fn) => { c.replays[ev] = fn; },
    command: (verb, fn) => { c.commands[verb] = fn; return `taskmgr.${verb}`; },
    page: (f) => path.join(__dirname, '..', '..', 'ui', 'taskmgr', f || 'index.html'),
    preload: path.join(__dirname, '..', '..', 'preload.js'),
    settings: { get: (k, dflt) => (k in c.settings ? JSON.parse(JSON.stringify(c.settings[k])) : dflt), set: (k, v) => { c.settings[k] = JSON.parse(JSON.stringify(v)); } },
    sidecar: {
      ready: true,
      // A FAKE sidecar: answers from c.procs, never runs anything.
      send: async (cmd, args) => {
        c.sends.push({ cmd, args: JSON.parse(JSON.stringify(args || {})) });
        if (cmd === 'taskmgr.snapshot') { c.t += 1500; return { ok: true, result: snap(c.procs.map((p) => Object.assign({}, p)), c.t) }; }
        if (cmd === 'taskmgr.close') {
          if (opts.closeFails) return { ok: true, result: { done: false, how: 'taskkill', why: 'access denied: it runs as administrator or is protected', refused: [] } };
          return { ok: true, result: { done: true, how: args.force ? 'taskkill_force' : 'wm_close', windows: 1, posted: 1, refused: [], dryRun: !!args.dryRun, why: args.dryRun ? 'dry run: would send WM_CLOSE to 1 window(s)' : null } };
        }
        if (cmd === 'taskmgr.trim') return { ok: true, result: { trimmed: args.dryRun ? 0 : args.procs.length, before: 800 * MB, after: args.dryRun ? 800 * MB : 200 * MB, rows: [], refused: [], dryRun: !!args.dryRun, why: args.dryRun ? 'dry run: would call EmptyWorkingSet' : null } };
        if (cmd === 'taskmgr.cmdline') {
          const p = c.procs.find((q) => q.pid === args.pid);
          return { ok: true, result: { ok: !!(p && p.path), path: p && p.path, cmdline: p && p.path ? `"${p.path}" --made-up-flag` : null } };
        }
        if (cmd === 'icon') return { ok: true, result: { icon: null } };
        return { ok: false, error: `unknown command ${cmd}` };
      },
      on: () => () => {}, onReady: (fn) => { fn(); return () => {}; },
    },
  };
  c.deps = { BrowserWindow: FakeWin, screen: fakeScreen, app: emitter({}), pid: MANTLE, closeWaitMs: 60, idleMs: 2500, mantleIconUrl: 'data:image/png;base64,TUFOVExF',
    exists: opts.exists || (() => true),
    spawn: (exe, args) => { c.spawned.push({ exe, args }); return { on() {}, unref() {} }; } };
  c.install = () => (c.h = F._install(c.ctx, c.deps));
  c.call = (verb, a) => c.commands[verb](a);
  c.win = () => made.filter((w) => !w.destroyed).pop();
  c.model = () => c.commands.state();
  c.rowKey = (pid) => `${pid}|${1000 + pid}`;
  return c;
}

async function featureTests() {
  check('module passes lib/features.js validate()', validate(F, 'taskmgr') === null, validate(F, 'taskmgr'));
  check('module: rest true, defaultOn, chord only once Mantle knows it', F.rest === true && F.defaultOn === true && show(F.chords) === show(F.HAS_CHORD ? ['Ctrl+Shift+Esc'] : []));

  // --- test mode: window hidden, every action a dry run
  const a = fakeCtx();
  a.install();
  check('install: healthy, no window until opened, nothing sampled', a.health.pop().ok === true && made.length === 0 && a.sends.length === 0);
  const r0 = await a.call('open', { view: 'game' });
  const w = a.win();
  check('open: one window, frameless, resizable with a min size, in the taskbar/Alt+Tab, titled', w && w.opts.frame === false && w.opts.resizable === true && w.opts.minWidth > 0 && w.opts.skipTaskbar === false && w.opts.title === F.TITLE);
  check('open --test: never shown, never focused', r0.ok && r0.shown === false && w.shown === 0 && w.focused === 0);
  let m = await a.model();
  check('open: sampled once, model has apps/background/windows and the RAM bar', m.loaded && m.apps.length > 0 && m.background.length > 0 && m.windows.length > 0 && m.mem.total > 0, show(Object.keys(m)));
  check('model: Mantle\'s own usage as one number', m.mantle && m.mantle.mem === 273 * MB, show(m.mantle));
  check('model: view from open()', m.view === 'game');
  const f1 = await a.call('act', { action: 'force', key: a.rowKey(2000) });
  check('force without the confirm: refused, sidecar not asked', f1.needsConfirm === true && !a.sends.some((s) => s.cmd === 'taskmgr.close'));
  const f2 = await a.call('act', { action: 'force', key: a.rowKey(2000), confirmed: true });
  const sent = a.sends.filter((s) => s.cmd === 'taskmgr.close').pop();
  check('--test: a confirmed force is still a DRY RUN', f2.ok && f2.dryRun && sent.args.dryRun === true && sent.args.force === true);
  check('close is by pid + creation time, the whole group', sent.args.root === 2000 && sent.args.procs.length === 6 && sent.args.procs.every((p) => p.pid && p.created));
  const p1 = await a.call('act', { action: 'close', key: a.rowKey(MANTLE) });
  check('protected (Mantle): refused before the sidecar, with its words on the row', !p1.ok && /Mantle itself/.test(p1.reason) && a.sends.filter((s) => s.cmd === 'taskmgr.close').length === 1);
  const p2 = await a.call('act', { action: 'trim', key: a.rowKey(3002) });
  check('a game is never trimmed', !p2.ok && !a.sends.some((s) => s.cmd === 'taskmgr.trim'));
  const t1 = await a.call('act', { action: 'trim', key: a.rowKey(2000), dryRun: false });
  check('--test: trim is a dry run whatever the page says', t1.ok && t1.dryRun && a.sends.filter((s) => s.cmd === 'taskmgr.trim').pop().args.dryRun === true);
  check('a gone row: plain words, nothing done', /row is gone/.test((await a.call('act', { action: 'close', key: '1|1' })).reason));
  const wt = await a.call('windowsTaskManager');
  check('--test: Windows\' Task Manager is not started', wt.dryRun && a.spawned.length === 0);
  const memBefore = (await a.model()).mem;
  await a.call('win', { op: 'close' });
  check('close (keep ready off, the default): the window is DESTROYED, nothing kept', w.destroyed && !a.win() && a.logs.some((l) => /window closed \(closed by its button; nothing kept in memory\)/.test(l)), show(a.logs.slice(-2)));
  let n = a.sends.filter((s) => s.cmd === 'taskmgr.snapshot').length;
  await sleep(1700);
  check('closed: sampling stopped', a.sends.filter((s) => s.cmd === 'taskmgr.snapshot').length === n);
  const mc = await a.model();
  check('closed: main keeps the last list and memory for the next cold open\'s first frame', mc.apps.length > 0 && mc.mem && mc.mem.total === memBefore.total && mc.loaded === false, show(mc.mem));
  const r1 = await a.call('open', { view: 'apps' });
  check('open again: a NEW window (cold), sampled at once', r1.ok && r1.warm === false && r1.created === true && a.win() !== w && a.sends.filter((s) => s.cmd === 'taskmgr.snapshot').length === n + 1);
  check('open --test: the cold open logs its first paint', (a.win().emit('ready-to-show'), a.logs.some((l) => /^opened \(cold\) via a page \(view apps\) \(test: not shown\): ready \d+ ms$/.test(l))), show(a.logs.slice(-3)));
  await a.call('win', { op: 'close' });

  // keep ready ON: one hidden window made ahead, reused, kept on close, let go when the switch goes off
  const fs = require('fs'), os = require('os');
  const kdir = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-tm-keep-'));
  const store = require('../keep-ready.js').create({ file: path.join(kdir, 'keep-ready.json') });
  store.set('taskmgr', true);
  const k = fakeCtx();
  Object.assign(k.deps, { keepReady: store, prewarmMs: 0, cpuBusy: () => 0 });
  k.install();
  await sleep(30);
  const kw = k.win();
  check('keep on: a window is made ahead, hidden, nothing sampled', kw && k.h._S.hidden === true && k.sends.filter((s) => s.cmd === 'taskmgr.snapshot').length === 0 && k.logs.some((l) => /made ahead and kept hidden: keep ready is on \(about \d+ MB/.test(l)), show(k.logs));
  const kr = await k.call('open', { view: 'apps' });
  check('keep on: the open reuses it (warm), sampled at once', kr.ok && kr.warm === true && kr.created === false && k.win() === kw && k.sends.filter((s) => s.cmd === 'taskmgr.snapshot').length === 1);
  await k.call('win', { op: 'close' });
  await sleep(50);
  check('keep on: close HIDES it (no time limit)', !kw.destroyed && k.h._S.hidden === true && k.logs.some((l) => /kept for the next open \(keep ready is on\)/.test(l)));
  store.set('taskmgr', false);
  check('keep on -> off: the hidden window is let go at once', kw.destroyed && !k.win());
  await k.h.stop('test');
  fs.rmSync(kdir, { recursive: true, force: true });
  check('launcher: mantle-open:taskmgr is heard while on', a.deps.app.emit('mantle-open:taskmgr', 'game') === true);
  await sleep(20);
  check('launcher: ...and opens the window again', !!a.win());
  await a.h.stop('test');
  check('launcher: nobody listens after stop (listenerCount 0 = off or resting), window destroyed', a.deps.app.emit('mantle-open:taskmgr', 'apps') === false && !a.win());

  // --- a live ctx with the FAKE sidecar: closes that end, closes that do not
  const b = fakeCtx({ live: true });
  b.install();
  await b.call('open', {});
  check('live: shown and focused when ready', (b.win().emit('ready-to-show'), b.win().shown === 1 && b.win().focused === 1));
  const c1 = await b.call('act', { action: 'close', key: b.rowKey(9200) });
  check('live close: WM_CLOSE path, state closing', c1.ok && c1.how === 'wm_close' && b.h._S.states.get(b.rowKey(9200)).state === 'closing');
  b.procs = b.procs.filter((p) => p.pid !== 9200 && p.pid !== 9201);
  await b.h._sample();
  const st = b.h._S.states.get(b.rowKey(9200));
  check('the processes ended: closed, with what it freed', st.state === 'closed' && st.freed === 370 * MB, show(st));
  check('a "just closed" line for the window', b.h._S.recent[0] && /freed about 370 MB/.test(b.h._S.recent[0].text));
  await b.call('act', { action: 'close', key: b.rowKey(2000) });
  b.procs.find((p) => p.pid === 2000).windows = 0;     // the window went, the process stayed (tray)
  await sleep(80);
  await b.h._sample();
  const st2 = b.h._S.states.get(b.rowKey(2000));
  check('window closed but process kept running: said on the row', st2.state === 'still-running' && /kept running in the background/.test(st2.why), show(st2));
  await b.h.stop('test');
  const bf = fakeCtx({ live: true, closeFails: true });
  bf.install();
  await bf.call('open', {});
  const c3 = await bf.call('act', { action: 'close', key: bf.rowKey(5300) });
  check('a refused close: not ok, reason on the row', !c3.ok && /access denied/.test(bf.h._S.states.get(bf.rowKey(5300)).why));
  await bf.h.stop('test');

  // --- Free up RAM, ticks, reopen after the game, the game-start option
  const g = fakeCtx({ live: true });
  g.install();
  await g.call('open', { view: 'game' });
  const chromeId = 'c:\\fake apps\\chrome\\chrome.exe';
  const tk = await g.call('tick', { identity: chromeId, on: true, reopen: true });
  check('tick: remembered by exe path in settings', tk.ok && g.settings.ticks[chromeId].on && g.settings.ticks[chromeId].reopen);
  const sp = await g.call('tick', { identity: 'c:\\fake\\spotify.exe', on: true });
  check('Spotify cannot be ticked (the Spotify card handles it)', !sp.ok && /Spotify card/.test(sp.reason));
  await g.call('tick', { identity: 'c:\\program files\\windowsapps\\fake.notes_1.0\\notes.exe', on: true, reopen: true });
  await sleep(20);
  m = await g.model();
  const notesRow = m.prep.rows.find((r) => /notes/.test(r.identity));
  check('reopen: a Store app says on screen it cannot be reopened, and why', notesRow && /Cannot reopen: A Store app/.test(notesRow.reopenWhy || ''), show(notesRow));
  const fr = await g.call('free', {});
  const closes = g.sends.filter((s) => s.cmd === 'taskmgr.close');
  check('Free up RAM: closes ONLY the ticked apps, gracefully', fr.ok && fr.sent === 2 && closes.length === 2 && closes.every((s) => s.args.force === false && s.args.dryRun === false), show(closes.map((s) => s.args.root)));
  check('Free up RAM: says which cannot be reopened', fr.reopen.some((r) => !r.can && /Store app/.test(r.why)) && fr.reopen.some((r) => r.can));
  check('reopen record held for after a game (not armed yet)', F._carry() && F._carry().armed === false && F._carry().apps[0].exe === 'C:\\Fake Apps\\Chrome\\chrome.exe');
  g.procs = g.procs.filter((p) => !(p.pid >= 2000 && p.pid <= 2005));
  await g.h._sample();
  check('Free up RAM: freed MB counted from the closes that really ended', g.h._S.lastFree.freed === 800 * MB, g.h._S.lastFree.freed / MB);
  // a game starts (rest) with the option OFF: nothing is closed, the reopen is armed
  const before = g.sends.filter((s) => s.cmd === 'taskmgr.close').length;
  await g.h.stop('resting while VALORANT runs', { rest: true });
  check('game start, option OFF: nothing closed', g.sends.filter((s) => s.cmd === 'taskmgr.close').length === before && !g.win());
  check('game start: the reopen is armed', F._carry() && F._carry().armed === true);
  // the game exits: install() again reopens
  g.install();
  check('game over: the closed app is started again with its arguments', g.spawned.length === 1 && g.spawned[0].exe === 'C:\\Fake Apps\\Chrome\\chrome.exe' && show(g.spawned[0].args) === show(['--made-up-flag']), show(g.spawned));
  check('game over: what could not be reopened is recorded with why', g.settings.lastAuto.reopened.results.some((r) => !r.ok && /Store app/.test(r.why)) && F._carry() === null);
  await g.h.stop('test');

  // the option ON: a game start closes the ticked apps, and records the outcome
  const o = fakeCtx({ live: true, settings: { autoFree: true, ticks: { 'c:\\users\\x\\appdata\\local\\discord\\app-1.0\\discord.exe': { on: true } } } });
  o.install();
  const resting = o.h.stop('resting while VALORANT runs', { rest: true });
  await sleep(40);
  const oc = o.sends.filter((s) => s.cmd === 'taskmgr.close');
  check('game start, option ON: the ticked app is closed gracefully', oc.length === 1 && oc[0].args.root === 9200 && oc[0].args.force === false);
  o.procs = o.procs.filter((p) => p.pid !== 9200 && p.pid !== 9201);
  await resting;
  await sleep(100);
  check('game start: outcome saved for the window (closed, MB freed)', o.settings.lastAuto && o.settings.lastAuto.game === 'VALORANT runs' && o.settings.lastAuto.results[0].state === 'closed' && o.settings.lastAuto.freed === 370 * MB, show(o.settings.lastAuto));
  F._setCarry(null);
  const t2 = fakeCtx({ settings: { autoFree: true, ticks: { 'c:\\users\\x\\appdata\\local\\discord\\app-1.0\\discord.exe': { on: true } } } });
  t2.install();
  await t2.h.stop('resting while VALORANT runs', { rest: true });
  await sleep(40);
  check('--test game start: still only a dry run', t2.sends.filter((s) => s.cmd === 'taskmgr.close').every((s) => s.args.dryRun === true));
  await sleep(700);

  // PRIVACY: no name, path or title of the fake table in any log line
  const logs = [].concat(a.logs, b.logs, bf.logs, g.logs, o.logs, t2.logs);
  const leak = logs.find((l) => NAMES.some((nm) => l.toLowerCase().includes(nm.toLowerCase())) || /[A-Z]:\\/.test(l));
  check(`privacy: ${logs.length} log lines, no process name, path or title`, logs.length > 10 && !leak, leak);
}

/* lane taskmgrfx: the glass, its own icon, and the compact model the page gets every tick. */
async function lookTests() {
  const fs = require('fs');
  const icoPath = path.join(__dirname, '..', '..', 'assets', 'icons', 'mantle-taskmgr.ico');
  const a = fakeCtx();
  a.install();
  const r = await a.call('open', { view: 'apps' });
  const w = a.win();
  check('glass: Windows\' acrylic system backdrop, NOT a transparent window (it must resize)', w.opts.backgroundMaterial === 'acrylic' && w.opts.transparent === false && w.opts.resizable === true && /^#00000000$/i.test(w.opts.backgroundColor), show([w.opts.backgroundMaterial, w.opts.transparent, w.opts.backgroundColor]));
  check('icon: the window icon is assets/icons/mantle-taskmgr.ico', w.opts.icon === icoPath, w.opts.icon);
  check('icon: its own AppUserModelID + taskbar picture', w.appDetails && w.appDetails.appId === 'Mantle.TaskManager' && w.appDetails.appIconPath === icoPath && w.appDetails.appIconIndex === 0 && w.appDetails.relaunchDisplayName === F.TITLE, show(w.appDetails));
  let m = await a.model();
  const rows = [].concat(m.apps, m.background, m.windows);
  check('compact model: no pids, creation times or paths on a row', rows.every((g) => g.procs === undefined && g.created === undefined && g.path === undefined), show(Object.keys(rows[0])));
  check('compact model: a row\'s processes only while it is expanded', rows.every((g) => g.members === null));
  check('compact model: the game view\'s rows only while that view is on', m.prep.rows.length === 0 && r.ok);
  check('Mantle\'s row wears Mantle\'s icon (a reference, the picture travels once)', m.mantleRow && m.mantleRow.icon === 'mantle:self' && a.replays['taskmgr.icons']()['mantle:self'] === 'data:image/png;base64,TUFOVExF', show(m.mantleRow && m.mantleRow.icon));
  const chromeKey = a.rowKey(2000);
  await a.call('expand', { key: chromeKey, open: true });
  m = await a.model();
  check('expand: that row\'s processes arrive, the others stay out', m.apps.find((g) => g.key === chromeKey).members.length === 6 && [].concat(m.apps, m.background).filter((g) => g.members).length === 1);
  await a.call('view', { view: 'game' });
  m = await a.model();
  check('game view: its rows arrive', m.prep.rows.length > 0);
  check('look: the page is told the material and that the icon is there', m.look && m.look.material === 'acrylic' && m.look.icon === true, show(m.look));
  await a.h.stop('test');
  // the icon file missing: the window still opens, and the page says why
  const b = fakeCtx({ exists: (p) => p !== icoPath });
  b.install();
  const rb = await b.call('open', { view: 'apps' });
  const mb = await b.model();
  check('icon missing: the window still opens, no icon passed', rb.ok && b.win() && b.win().opts.icon === undefined && b.win().appDetails.appId === 'Mantle.TaskManager');
  check('icon missing: said on the page (No Silent Failures)', mb.look && mb.look.icon === false && /icon file is not there yet/.test(mb.look.iconWhy), show(mb.look));
  await b.h.stop('test');
  // the page: no CSS backdrop-filter, and the big surfaces let the material through
  const css = fs.readFileSync(path.join(__dirname, '..', '..', 'ui', 'taskmgr', 'taskmgr.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  /* dark FINAL RULES (2026-10-09): pop-ups get one --lg-fill over var(--lg-blur) (5px), so the small dark
     right-click .menu may blur; every big surface still may not (a large backdrop-filter measured 27% of a core) */
  const blurRules = css.split('}').filter((r) => /backdrop-filter/.test(r)).map((r) => r.trim());
  check('page: no CSS backdrop-filter except the small dark .menu (var(--lg-blur))',
    blurRules.every((r) => { const sel = r.split('{')[0]; return /data-theme="dark"/.test(sel) && /^[^,]*\.menu\s*$/.test(sel.trim()) && /backdrop-filter:\s*var\(--lg-blur\)/.test(r); }), blurRules.map((r) => r.split('{')[0].trim()));
  check('page: the body paints no opaque ground (the acrylic shows through)', /body\s*\{[^}]*background:\s*transparent/.test(css));
  check('page: long lists skip off-screen rows (content-visibility)', /\.row\s*\{[^}]*content-visibility:\s*auto/.test(css));
}

/* ------------------------------------------------------------------ gamequiet (2026-09-28)
   The user trimmed RiotClientServices 10 s before Valorant launched and Riot Client hung twice: TaskMgr.cs
   kept its OWN copy of the never-touch list and it lacked "Riot". Now TaskMgr.cs reads game mode's list
   (GameMode.cs GamePrefixes); these checks fail the moment the C# lists and _gamemode-plan.js NEVER
   differ, or a name the sidecar refuses has no reason on its row here. */
function gamequietTests() {
  const fs = require('fs');
  const GP = require('./_gamemode-plan.js');
  const SC = path.join(__dirname, '..', '..', 'sidecar');
  const gm = fs.readFileSync(path.join(SC, 'GameMode.cs'), 'utf8');
  const tm = fs.readFileSync(path.join(SC, 'TaskMgr.cs'), 'utf8');
  const csArray = (src, name) => {
    const m = new RegExp(`string\\[\\] ${name} = \\{([\\s\\S]*?)\\};`).exec(src);
    return m ? (m[1].match(/"[^"]*"/g) || []).map((s) => s.slice(1, -1)) : null;
  };
  const reNames = (re) => { const m = /^\^\((.*)\)$/.exec(re.source) || /^\^(.*)$/.exec(re.source); return m ? m[1].split('|').map((s) => s.replace(/\\\./g, '.')) : []; };
  const set = (l) => Array.from(new Set((l || []).map((s) => s.toLowerCase()))).sort();
  const same = (a, b) => show(set(a)) === show(set(b));
  const diff = (a, b) => { const B = new Set(set(b)); return set(a).filter((x) => !B.has(x)); };

  const games = csArray(gm, 'GamePrefixes');
  const others = csArray(gm, 'OtherNeverPrefixes');
  check('gamequiet: GameMode.cs has GamePrefixes and OtherNeverPrefixes', !!games && !!others && games.length > 10);
  if (!games || !others) return;
  const jsGames = reNames(GP.NEVER[0].re).concat(reNames(GP.NEVER[1].re));
  check('gamequiet: GameMode.cs GamePrefixes == _gamemode-plan.js NEVER[0..1], name for name', same(games, jsGames), `C# only: ${diff(games, jsGames)} | JS only: ${diff(jsGames, games)}`);
  const jsAll = [].concat(...GP.NEVER.map((n) => reNames(n.re)));
  const csAll = games.concat(others);
  check('gamequiet: GameMode.cs whole never-touch list == _gamemode-plan.js NEVER, name for name', same(csAll, jsAll), `C# only: ${diff(csAll, jsAll)} | JS only: ${diff(jsAll, csAll)}`);
  check('gamequiet: "Riot" is on the list (RiotClientServices, RiotClientUx, RiotClientCrashHandler)', set(games).includes('riot'));
  check('gamequiet: GameMode.cs NeverPrefixes is the two halves joined', /string\[\] NeverPrefixes = Join\(GamePrefixes, OtherNeverPrefixes\);/.test(gm));
  check('gamequiet: TaskMgr.cs NeverPrefixes IS game mode\'s list (+ Lively), not a copy', /string\[\] NeverPrefixes = GameMode\.Join\(GameMode\.GamePrefixes, new\[\] \{ "Lively" \}\);/.test(tm));
  const tmOwn = csArray(tm, 'NeverPrefixes');
  check('gamequiet: TaskMgr.cs names no game of its own (a copy could drift again)', tmOwn === null && !/"VALORANT"|"vgc"|"javaw"|"RobloxPlayer"/.test(tm), show(tmOwn));

  // Every name the sidecar refuses has its reason on the row BEFORE the sidecar is asked: protected
  // (no action at all) or a game (never trimmed). A row that offered a trim the sidecar refuses would
  // only say so after the click.
  const uncovered = games.filter((p) => {
    const f = `${p}MadeUp.exe`;
    const g = C.buildGroups(snap([P(4, 0, 'System', { session: 0, path: null }), P(1000, 999, 'explorer.exe'), P(7000, 1000, f)]), null, { mantlePid: MANTLE }).groups.find((x) => x.root === 7000);
    const a = C.actionsFor(g);
    return !(g && a.trim === false && a.why);
  });
  check('gamequiet: every game-list name is protected or a game on its row (no trim offered, a reason shown)', uncovered.length === 0, show(uncovered));

  const riot = [P(4, 0, 'System', { session: 0, path: null }), P(1000, 999, 'explorer.exe'),
    P(7100, 1000, 'RiotClientServices.exe', { pws: 120 * MB }), P(7101, 7100, 'RiotClientUx.exe', { windows: 1, title: 'Riot Client', pws: 200 * MB }),
    P(7102, 7100, 'RiotClientCrashHandler.exe', { pws: 3 * MB }), P(7200, 7100, 'VALORANT.exe', { pws: 20 * MB }),
    P(7201, 7200, 'VALORANT-Win64-Shipping.exe', { windows: 1, pws: 3000 * MB })];
  const rb = C.buildGroups(snap(riot), null, { mantlePid: MANTLE });
  const rg = rb.groups.find((x) => x.root === 7100);
  check('gamequiet: Riot Client is one row, protected, with its words', rg && rg.count === 3 && /Riot Client/.test(rg.protected) && /never closes or trims/.test(rg.protected), show(rg && { count: rg.count, protected: rg.protected }));
  const ra = C.actionsFor(rg);
  check('gamequiet: the Riot Client row offers no close, force or trim, and says why', ra.close === false && ra.force === false && ra.trim === false && ra.why === rg.protected, show(ra));
  check('gamequiet: the Riot Client row cannot be ticked for "Get ready to game"', /Riot Client/.test(C.tickWhy(rg) || ''));
  const vg = rb.groups.find((x) => x.root === 7200);
  check('gamequiet: VALORANT (started by Riot Client) is its own game row, not taken with it', vg && vg.game && !vg.protected, show(vg && { game: vg.game, protected: vg.protected }));
}

/* ------------------------------------------------------------------ sysmon pass (2026-09-29) */
async function sysmonTests() {
  // machine CPU from the Idle process's time
  const s0 = { t: 1000, cpus: 4, idle: 0 }, s1 = { t: 2000, cpus: 4, idle: 30000000 };   // 1 s x 4 cores = 40,000,000 units; 3/4 idle
  check('machineCpu: 1 - idle share (25% busy)', C.machineCpu(s0, s1) === 25, show(C.machineCpu(s0, s1)));
  check('machineCpu: unknown on the first sample, an older helper (no idle), or a clock that did not move',
    C.machineCpu(null, s1) === null && C.machineCpu({ t: 1000, cpus: 4 }, s1) === null && C.machineCpu(s1, Object.assign({}, s1)) === null);
  check('machineCpu: clamped to 0..100', C.machineCpu(s0, { t: 2000, cpus: 4, idle: 50000000 }) === 0 && C.machineCpu({ t: 1000, cpus: 4, idle: 0 }, { t: 2000, cpus: 4, idle: 0 }) === 100);
  // "Not responding"
  const hungT = table().map((p) => (p.pid === 9200 ? Object.assign(p, { hung: 1 }) : p.pid === 2000 ? Object.assign(p, { hung: 1 }) : p));
  const hb = C.buildGroups(snap(hungT), null, { mantlePid: MANTLE });
  check('hung: an app whose only window is not responding is flagged', hb.byKey.get('9200|10200').hung === true);
  check('hung: one of two windows hung is not the whole app', hb.byKey.get('2000|3000').hung === false);
  check('hung: a windowless row never is', hb.groups.filter((g) => !g.windows).every((g) => g.hung === false));

  const c = fakeCtx({ live: true });
  let idle = 0;
  const send0 = c.ctx.sidecar.send;
  c.ctx.sidecar.send = async (cmd, args) => {
    const r = await send0(cmd, args);
    if (cmd === 'taskmgr.snapshot' && r.ok) { idle += 1500 * 10000 * 4 * 0.6; r.result.idle = Math.round(idle); r.result.procs.forEach((p) => { if (p.pid === 9200) p.hung = 1; }); }
    return r;
  };
  c.install();
  await c.call('open', {});
  await c.h._sample();
  let m = await c.model();
  check('model: the machine CPU (40% busy) and both history lines', m.cpu === 40 && !!m.hist && m.hist.cpu.length === 1 && m.hist.mem.length === 2 && m.hist.mem[1] === Math.round(1000 * 10384 / 16384) / 10, show({ cpu: m.cpu, hist: m.hist }));
  check('model: a row says it is not responding and carries its file name for search', m.apps.find((r) => r.key === c.rowKey(9200)).hung === true && m.apps.find((r) => r.key === c.rowKey(9200)).file === 'Discord.exe');
  for (let i = 0; i < 70; i++) await c.h._sample();
  m = await c.model();
  check('history: capped at 60 samples', !!m.hist && m.hist.cpu.length === 60 && m.hist.mem.length === 60);

  // double-click on Close: one close request, not two
  const nClose = () => c.sends.filter((x) => x.cmd === 'taskmgr.close').length;
  const [d1, d2] = await Promise.all([c.call('act', { action: 'close', key: c.rowKey(9200) }), c.call('act', { action: 'close', key: c.rowKey(9200) })]);
  check('double-fire: two Close clicks at once send ONE close', nClose() === 1 && d1.ok && d2.already === true, show({ n: nClose(), d2 }));
  const d3 = await c.call('act', { action: 'close', key: c.rowKey(9200) });
  check('double-fire: Close again while it is closing does nothing twice', nClose() === 1 && d3.already === true);
  const d4 = await c.call('act', { action: 'force', key: c.rowKey(9200), confirmed: true });
  check('double-fire: Force close is still allowed while a close waits', d4.ok && nClose() === 2);

  // Free up RAM twice at once: the second is refused, each ticked app is asked once
  await c.call('tick', { identity: 'c:\\fake\\steam.exe', on: true });
  const nb = nClose();
  const [fa, fb] = await Promise.all([c.call('free', {}), c.call('free', {})]);
  check('free: two presses at once close each ticked app once', fa.ok && fb.ok === false && fb.busy === true && nClose() === nb + 1, show({ fa: fa.planned, fb, n: nClose() - nb }));

  // renderer abuse
  const tp = await c.call('tick', { identity: '__proto__', on: true });
  check('tick: "__proto__" is refused and nothing is saved', tp.ok === false && !('ticks' in c.settings && Object.getPrototypeOf(c.settings.ticks) !== Object.prototype));
  const tc = await c.call('tick', { identity: 'constructor', on: true });
  check('tick: an inherited name ("constructor") is not an app', tc.ok === false);
  await c.call('expand', { key: 'made-up|1', open: true });
  check('expand: a key that is no row is not kept', !c.h._S.expanded.has('made-up|1'));
  await c.call('expand', { key: c.rowKey(2000), open: true });
  check('expand: a real row is', c.h._S.expanded.has(c.rowKey(2000)));
  check('view: the old "startup" view opens Apps', (await c.call('view', { view: 'startup' })).view === 'apps' && (await c.call('open', { view: 'startup' })).view === 'apps');

  // a sidecar that throws: the loop keeps going, the words are plain
  c.ctx.sidecar.send = async (cmd) => { if (cmd === 'taskmgr.snapshot') throw new Error('pipe closed'); return { ok: true, result: {} }; };
  await c.h._sample();
  m = await c.model();
  check('a throwing read: plain words on the window, no "sidecar"', /could not read the list of running apps/.test(m.error) && !/sidecar/i.test(m.error), m.error);
  c.ctx.sidecar.send = async () => ({ ok: false, error: 'unknown command taskmgr.snapshot' });
  await c.h._sample();
  check('an old helper: says restart Mantle, no jargon', /restart Mantle/.test((await c.model()).error) && !/sidecar|npm/i.test((await c.model()).error));
  await c.h.stop('test');

  // Open file location: by row key, main's own path, a dry run in a test Mantle
  const rv = fakeCtx({ live: true });
  const shown = [];
  rv.deps.shell = { showItemInFolder: (p) => shown.push(p) };
  rv.install();
  await rv.call('open', {});
  const rv1 = await rv.call('reveal', { key: rv.rowKey(2000), path: 'C:\\Windows\\evil.exe' });
  check('reveal: Mantle Files off -> File Explorer shows the row\'s OWN exe (a path from the page is ignored), and says why', rv1.ok && rv1.in === 'explorer' && /Mantle Files is switched off/.test(rv1.reason) && shown.length === 1 && shown[0] === 'C:\\Fake Apps\\Chrome\\chrome.exe', show({ shown, rv1 }));
  // Mantle Files on (the user's file window): it gets the FILE path (it opens the folder with the file selected)
  const got = [];
  rv.deps.app.listenerCount = (ev) => (rv.deps.app.emit === undefined ? 0 : got.on && ev === 'mantle-open:files' ? 1 : 0);
  rv.deps.app.on('mantle-open:files', (o) => { got.push(o.path); o.reply.handled = true; o.reply.ok = got.fail ? false : true; o.reply.reason = got.fail ? 'made-up reason' : null; });
  got.on = true;
  const rv2 = await rv.call('reveal', { key: rv.rowKey(2000) });
  check('reveal: Mantle Files on -> opened there with the exe, File Explorer not used', rv2.ok && rv2.in === 'files' && got.join() === 'C:\\Fake Apps\\Chrome\\chrome.exe' && shown.length === 1, show({ rv2, got }));
  got.fail = true;
  const rv3 = await rv.call('reveal', { key: rv.rowKey(2000) });
  check('reveal: Mantle Files could not open -> File Explorer, and the reason is said', rv3.ok && rv3.in === 'explorer' && /Mantle Files did not open \(made-up reason\)/.test(rv3.reason) && shown.length === 2, show(rv3));
  shown.pop();
  check('reveal: a row with no readable path says why, opens nothing', /didn't let Mantle see/.test((await rv.call('reveal', { key: rv.rowKey(5300) })).reason) && shown.length === 1);
  check('reveal: a key that is no row opens nothing', (await rv.call('reveal', { key: 'x|1' })).ok === false && shown.length === 1);
  check('model: rows say whether they can be revealed', (await rv.model()).apps.find((r) => r.key === rv.rowKey(2000)).canReveal === true);
  await rv.h.stop('test');
  const rt = fakeCtx();
  rt.deps.shell = { showItemInFolder: (p) => shown.push(p) };
  rt.install();
  await rt.call('open', {});
  const rt1 = await rt.call('reveal', { key: rt.rowKey(2000) });
  check('reveal --test: a dry run, Explorer not opened', rt1.ok && rt1.dryRun && shown.length === 1);
  await rt.h.stop('test');

  // off-screen saved place (a monitor that is gone): centred on the primary again
  for (const [name, bounds, want] of [
    ['a place on a monitor that is gone', { x: 2400, y: 100, width: 780, height: 640 }, false],
    ['a place above every monitor (title bar unreachable)', { x: 100, y: -500, width: 780, height: 640 }, false],
    ['a place on the second monitor that is there', { x: 1700, y: 100, width: 780, height: 640 }, true],
    ['a place on the primary', { x: 50, y: 50, width: 780, height: 640 }, true],
  ]) {
    const e = fakeCtx({ settings: { bounds } });
    e.deps.screen = { getPrimaryDisplay: fakeScreen.getPrimaryDisplay, getAllDisplays: () => [fakeScreen.getPrimaryDisplay(), ...(name.includes('second') ? [{ bounds: { x: 1536, y: 0, width: 1920, height: 1080 }, workArea: { x: 1536, y: 0, width: 1920, height: 1040 } }] : [])] };
    e.install();
    await e.call('open', {});
    const o = e.win().opts;
    const kept = o.x === bounds.x && o.y === bounds.y;
    check(`bounds: ${name} is ${want ? 'kept' : 'replaced by the centre of the primary'}`, kept === want && (want || (o.x === Math.round((1536 - o.width) / 2))), show({ x: o.x, y: o.y }));
    await e.h.stop('test');
  }
}

(async () => {
  coreTests();
  try { gamequietTests(); } catch (e) { check('no exception (gamequiet)', false, e.stack); }
  try { await featureTests(); } catch (e) { check('no exception', false, e.stack); }
  try { await lookTests(); } catch (e) { check('no exception (look)', false, e.stack); }
  try { await sysmonTests(); } catch (e) { check('no exception (sysmon)', false, e.stack); }
  for (const f of failures) console.log('  FAIL ' + f);
  console.log(`TASKMGR: ${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();
