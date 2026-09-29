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
  await a.call('win', { op: 'close' });
  check('close: the window is HIDDEN, not destroyed (warm for the next open)', !w.destroyed && a.h._S.hidden === true && a.win() === w);
  let n = a.sends.filter((s) => s.cmd === 'taskmgr.snapshot').length;
  await sleep(1700);
  check('closed: sampling stopped', a.sends.filter((s) => s.cmd === 'taskmgr.snapshot').length === n);
  const r1 = await a.call('open', { view: 'apps' });
  check('open again: the SAME window, warm, sampled at once', r1.ok && r1.warm === true && r1.created === false && a.win() === w && a.sends.filter((s) => s.cmd === 'taskmgr.snapshot').length === n + 1);
  await a.call('win', { op: 'close' });
  n = a.sends.filter((s) => s.cmd === 'taskmgr.snapshot').length;
  await sleep(2800);
  check('hidden longer than the idle time: DESTROYED, no sample in between', w.destroyed && !a.win() && a.sends.filter((s) => s.cmd === 'taskmgr.snapshot').length === n);
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
  check('page: no CSS backdrop-filter anywhere', !/backdrop-filter/.test(css));
  check('page: the body paints no opaque ground (the acrylic shows through)', /body\s*\{[^}]*background:\s*transparent/.test(css));
  check('page: long lists skip off-screen rows (content-visibility)', /\.row\s*\{[^}]*content-visibility:\s*auto/.test(css));
}

(async () => {
  coreTests();
  try { await featureTests(); } catch (e) { check('no exception', false, e.stack); }
  try { await lookTests(); } catch (e) { check('no exception (look)', false, e.stack); }
  for (const f of failures) console.log('  FAIL ' + f);
  console.log(`TASKMGR: ${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();
