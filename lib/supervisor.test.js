'use strict';
/*
 * supervisor.test.js -- main's half of crash recovery (lib/supervisor.js), with fake spawn/clock, and the
 * source facts the design rests on (every deliberate way out stands the supervisor down FIRST; the
 * scripts that stop Mantle stop the supervisor before main; the C# words match the JS words).
 *   node lib/supervisor.test.js   -> "SUPERVISOR: n passed, m failed"
 * The real processes are proven by lib/supervisor.e2e.test.js.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const S = require('./supervisor');

const ROOT = path.join(__dirname, '..');
let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(name + (detail !== undefined ? ' -- ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 500) : ''));
}

// ---- wanted ----
check('live is supervised', S.wanted({ live: true }).on === true);
check('live + --no-supervise is not', S.wanted({ live: true, noSupervise: true }).on === false);
check('a plain --test run is NOT supervised (tests kill their instances on purpose)', S.wanted({ test: true, profileName: 'x' }).on === false);
check('--test --supervise is', S.wanted({ test: true, supervise: true, profileName: 'x' }).on === true);
check('neither flag: off', S.wanted({}).on === false);

// ---- words ----
check('codeHex of a negative NTSTATUS', S.codeHex(-1073740771) === '0xC000041D', S.codeHex(-1073740771));
check('codeHex of the unsigned form', S.codeHex(0xC000041D) === '0xC000041D');
check('codeHex of 1', S.codeHex(1) === '0x00000001');
check('codeHex of nothing', S.codeHex(null) === null);
check('the 10-14 crash in words', /Windows was calling into one of its windows/.test(S.exitWords(0xC000041D)));
check('a kill in words', /ended by another program/.test(S.exitWords(1)));
check('an unknown code', S.exitWords(0x12345) === 'it stopped unexpectedly');
check('an uncaught exception names its own code, not the exit code', S.exitWords(1, 'boom') === "an error in Mantle's own code");
for (const [hex, words] of Object.entries(S.EXIT_WORDS)) {
  check(`no raw code in the words for ${hex}`, !/0x|[0-9]{3,}/i.test(words), words);
}

// ---- the C# table says the same words ----
const cs = fs.readFileSync(path.join(ROOT, 'sidecar', 'Supervisor.cs'), 'utf8');
const csCases = {};
for (const m of cs.matchAll(/case (0x[0-9A-Fa-f]+|\d+): return "([^"]+)";/g)) {
  csCases[`0x${Number(m[1]).toString(16).toUpperCase().padStart(8, '0')}`] = m[2];
}
check('Supervisor.cs has the same codes as EXIT_WORDS', JSON.stringify(Object.keys(csCases).sort()) === JSON.stringify(Object.keys(S.EXIT_WORDS).sort()), { cs: Object.keys(csCases), js: Object.keys(S.EXIT_WORDS) });
for (const [hex, words] of Object.entries(S.EXIT_WORDS)) check(`Supervisor.cs says the same words for ${hex}`, csCases[hex] === words, csCases[hex]);
check('Supervisor.cs default words agree', /default: return "it stopped unexpectedly";/.test(cs));
check('Supervisor.cs own-code words agree', cs.includes(`return "an error in Mantle's own code";`));
check('Supervisor.cs window and count agree', new RegExp(`WindowMs = ${S.WINDOW_MS};`).test(cs) && new RegExp(`MaxCrashes = ${S.MAX_CRASHES};`).test(cs));
check('Supervisor.cs reads the files main writes', cs.includes(`"${S.MAIN_FILE}"`) && cs.includes(`"${S.STATE_FILE}"`));
check('Supervisor.cs: a test supervisor never shows the dialog or runs the restore', /if \(_test\) restoreResult = "not run \(test instance\)"/.test(cs) && /if \(_test\) return false;\s*\n\s*string text = /.test(cs));
check('Supervisor.cs hands the new main its pid and drops ELECTRON_RUN_AS_NODE', cs.includes('psi.EnvironmentVariables["MANTLE_SUPERVISOR_PID"]') && cs.includes('Remove("ELECTRON_RUN_AS_NODE")'));
check('Supervisor.cs: stand-down is checked before anything restarts', cs.indexOf('"standDown"') > -1 && cs.indexOf('"standDown"') < cs.indexOf('int newPid = Launch('));
check('Supervisor.cs: Windows shutting down is never a crash', cs.indexOf('SM_SHUTTINGDOWN) != 0') < cs.indexOf('crashes.Add(diedAt)'));
const prog = fs.readFileSync(path.join(ROOT, 'sidecar', 'Program.cs'), 'utf8');
check('Program.cs routes --supervise= before the sidecar proper', prog.indexOf('return Supervisor.Run(args)') > -1 && prog.indexOf('return Supervisor.Run(args)') < prog.indexOf('OwnPid = Process.GetCurrentProcess().Id;'));

// ---- noticeFor ----
const T = Date.parse('2026-10-14T20:11:52');
const last = { at: T, oldPid: 17680, codeHex: '0xC000041D', words: S.exitWords(0xC000041D), restarted: true, newPid: 999, startedInMs: 2400 };
const n1 = S.noticeFor({ last }, 0, T + 5000);
check('a restart is told', n1 && n1.title === 'Mantle restarted after a crash', n1);
check('the words are plain: what happened, when, how long', n1 && /Windows was calling/.test(n1.words) && /20:11/.test(n1.words) && /2 s later/.test(n1.words) && !/0x/i.test(n1.words), n1 && n1.words);
check('the log line keeps the code', n1 && /0xC000041D/.test(n1.log) && /pid 17680/.test(n1.log), n1 && n1.log);
check('the tray line', n1 && n1.tray === 'Restarted by itself after a crash at 20:11', n1 && n1.tray);
check('told once: the same event is not told again', S.noticeFor({ last }, T, T + 6000) === null);
check('an old event (11 min) is not told', S.noticeFor({ last }, 0, T + 11 * 60000) === null);
check('a failed restart is not told as a restart', S.noticeFor({ last: Object.assign({}, last, { restarted: false }) }, 0, T + 1000) === null);
const gaveUp = { at: T + 30000, count: 3, windowMs: 120000, codeHex: '0x00000001', words: S.exitWords(1), restore: { result: 'done and verified' } };
const n2 = S.noticeFor({ last, gaveUp }, 0, T + 60000);
check('a give-up newer than the last restart wins', n2 && n2.title === 'Mantle had stopped after repeated crashes' && /3 times in 2 minutes/.test(n2.words), n2);
check('a give-up log line says the taskbar result', n2 && /done and verified/.test(n2.log));
check('nothing at all: null', S.noticeFor(null, 0, T) === null && S.noticeFor({}, 0, T) === null);

// ---- makeSupervisor, with a real temp folder and a fake spawn ----
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-supervisor-test-'));
function rig(over) {
  const logs = [];
  const spawned = [];
  const killed = [];
  const intervals = [];
  let t = T;
  const o = Object.assign({
    fs, path,
    spawn: (exe, args, opts) => {
      const c = new EventEmitter();
      c.pid = 5000 + spawned.length;
      c.unref = () => { c.unrefd = true; };
      spawned.push({ exe, args, opts, child: c });
      return c;
    },
    alive: () => true,
    kill: (pid) => killed.push(pid),
    now: () => t,
    log: (line) => logs.push(line),
    setInterval: (fn, ms) => { const h = { fn, ms }; intervals.push(h); return h; },
    clearInterval: (h) => { h.cleared = true; },
    pid: 4242, execPath: 'C:\\x\\electron.exe', argv: ['.', '--live', '--log=C:\\l\\mantle.log'], cwd: 'C:\\x', root: 'C:\\x',
    userData: dir, exePath: path.join(ROOT, 'package.json'), flags: { live: true }, env: {},
  }, over || {});
  const sup = S.makeSupervisor(o);
  return { sup, o, logs, spawned, killed, intervals, tick: (ms) => { t += ms; } };
}
const readMain = () => JSON.parse(fs.readFileSync(path.join(dir, S.MAIN_FILE), 'utf8'));

{
  const r = rig();
  const st = r.sup.start();
  check('live start spawns a supervisor', st.on === true && st.via === 'spawned' && r.spawned.length === 1, st);
  const sp = r.spawned[0];
  check('spawned DETACHED with no pipes (it must outlive main)', sp && sp.opts.detached === true && sp.opts.stdio === 'ignore' && sp.opts.windowsHide === true, sp && sp.opts);
  check('its arguments: this pid and the profile folder', sp && sp.args[0] === '--supervise=4242' && sp.args[1] === `--supervise-dir=${dir}` && sp.args.length === 2, sp && sp.args);
  check('unref: main never waits on it to exit', sp && sp.child.unrefd === true);
  const m = readMain();
  check('the record says how to start main again', m.pid === 4242 && m.exe === 'C:\\x\\electron.exe' && m.args.join(' ') === '. --live --log=C:\\l\\mantle.log' && m.cwd === 'C:\\x' && m.root === 'C:\\x' && m.standDown === null, m);
  sp.child.emit('spawn');
  check('the log says it is on', r.logs.some((l) => /crash recovery on: supervisor pid 5000 watches this main process \(pid 4242\)/.test(l)), r.logs);
  // the supervisor dies under main: a new one
  sp.child.emit('exit', 1);
  check('a lost supervisor is replaced', r.spawned.length === 2 && r.logs.some((l) => /the supervisor it exited \(code 1\); starting a new one/.test(l)), r.logs.slice(-2));
  r.spawned[1].child.emit('exit', 1);
  r.spawned[2].child.emit('exit', 1);
  r.spawned[3].child.emit('exit', 1);
  check('...but not forever: 3 in 10 minutes, then off and said', r.spawned.length === 4 && r.sup.status().on === false && r.logs.some((l) => /crash recovery is OFF/.test(l)), { n: r.spawned.length, logs: r.logs.slice(-2) });
}
{
  const r = rig();
  r.sup.start();
  const sd = r.sup.standDown('the tray menu');
  const m = readMain();
  check('standDown writes the record for THIS pid', sd.ok && sd.via === 'record' && m.pid === 4242 && m.standDown && m.standDown.why === 'the tray menu', m);
  check('standDown says so once', r.logs.filter((l) => /crash recovery stands down/.test(l)).length === 1);
  r.sup.standDown('the kill switch');
  check('a second standDown keeps the record (latest why) but does not log again', readMain().standDown.why === 'the kill switch' && r.logs.filter((l) => /stands down/.test(l)).length === 1);
  r.spawned[0].child.emit('exit', 0);
  check('after standDown, a supervisor leaving is not replaced', r.spawned.length === 1);
  r.sup.crashNote('boom');
  check('a crash note after standDown is ignored (the quit wins)', !readMain().crashNote);
}
{
  const r = rig();
  r.sup.start();
  r.sup.crashNote('Cannot read properties of undefined');
  check('crashNote is written for the supervisor\'s words', readMain().crashNote && readMain().crashNote.what === 'Cannot read properties of undefined');
}
{
  // the record cannot be written: the supervisor is stopped outright instead
  const r = rig();
  r.sup.start();
  const realRename = fs.renameSync;
  fs.renameSync = () => { throw new Error('disk full'); };
  let sd;
  try { sd = r.sup.standDown('the tray menu'); } finally { fs.renameSync = realRename; }
  check('standDown with no record: the supervisor is killed instead', sd.via === 'kill' && r.killed[0] === 5000 && r.logs.some((l) => /could not be written \(disk full\), so the supervisor \(pid 5000\) was stopped/.test(l)), { sd, killed: r.killed, logs: r.logs.slice(-1) });
}
{
  const env = { MANTLE_SUPERVISOR_PID: '7777', OTHER: '1' };
  const r = rig({ env });
  const st = r.sup.start();
  check('a main the supervisor started ADOPTS it (no second supervisor)', st.via === 'adopted' && r.spawned.length === 0 && r.sup.status().pid === 7777, st);
  check('MANTLE_SUPERVISOR_PID is removed from the environment (apps Mantle opens never get it)', !('MANTLE_SUPERVISOR_PID' in env) && env.OTHER === '1');
  check('an adopted supervisor is polled', r.intervals.length === 1 && r.intervals[0].ms === 10000);
  r.o.alive = () => false;
  r.intervals[0].fn();
  check('an adopted supervisor that goes away is replaced', r.spawned.length === 1 && r.intervals[0].cleared === true, r.logs.slice(-2));
}
{
  const r = rig({ env: { MANTLE_SUPERVISOR_PID: '7777' }, alive: () => false });
  const st = r.sup.start();
  check('a named supervisor that is gone: a new one, said', st.via === 'spawned' && r.logs.some((l) => /pid 7777\) is gone; starting a new one/.test(l)), r.logs);
}
{
  const r = rig({ flags: { test: true, profileName: 'mnsup' } });
  const st = r.sup.start();
  check('a plain --test run: off, said, nothing spawned, no record', st.on === false && r.spawned.length === 0 && r.logs.some((l) => /crash recovery is off: test instance/.test(l)));
}
{
  const r = rig({ flags: { test: true, supervise: true, profileName: 'mnsup' } });
  r.sup.start();
  const a = r.spawned[0] && r.spawned[0].args;
  check('a --test --supervise run: the test supervisor carries --supervise-test and the profile flag kill-test.ps1 matches', a && a.includes('--supervise-test') && a.includes('--profile-name=mnsup'), a);
}
{
  const r = rig({ exePath: path.join(dir, 'missing.exe') });
  const st = r.sup.start();
  check('no sidecar exe: off, with the reason', st.on === false && /sidecar program is missing/.test(st.why), st);
}
{
  // takeNotice: told once, across starts
  fs.writeFileSync(path.join(dir, S.STATE_FILE), JSON.stringify({ last }));
  const r = rig();
  r.tick(4000);
  r.sup.start();
  const n = r.sup.takeNotice();
  check('the next start takes the notice', n && n.title === 'Mantle restarted after a crash', n);
  check('...and marks it told', readMain().told === T);
  check('...so asking again gives nothing', r.sup.takeNotice() === null);
  const r2 = rig();
  r2.tick(9000);
  r2.sup.start();
  check('a later start carries "told" on and does not tell it again', readMain().told === T && r2.sup.takeNotice() === null);
}

// ---- main.js: every deliberate way out stands the supervisor down FIRST ----
const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const between = (a, b) => { const i = main.indexOf(a); const j = main.indexOf(b, i + 1); return i > -1 && j > i ? main.slice(i, j) : ''; };
check('the supervisor starts before the sidecar is made', main.indexOf('supervisor.start();') > -1 && main.indexOf('supervisor.start();') < main.indexOf('const sidecar = new Sidecar('));
check('...and after the single-instance lock (a second instance never gets one)', main.indexOf("if (!app.requestSingleInstanceLock()) {\n  process.stderr.write(`mantle: another instance") < main.indexOf('supervisor.start();'));
const sd = between('function shutdown(why, opts) {', 'const exitCode =');
check('shutdown() stands down before anything else (unless it is the crash road)', /shuttingDown = true;[\s\S]*if \(!\(opts && opts\.crash\)\) supervisor\.standDown\(why\);/.test(sd), sd);
const ks = between("globalShortcut.register('Ctrl+Alt+Shift+Backspace'", '});');
check('the kill switch stands down BEFORE the restore', ks.indexOf('supervisor.standDown(') > -1 && ks.indexOf('supervisor.standDown(') < ks.indexOf('restoreShell('), ks);
const sr = between("'shell.restore': async () => {", 'await restoreShell(');
check('"Restore Windows taskbar" (shell.restore) stands down before the restore', sr.includes('supervisor.standDown('), sr);
const tr = between('  restore: () => {', 'restoreShell(');
check('the tray\'s "Restore Windows taskbar" stands down before the restore', tr.includes('supervisor.standDown('), tr);
const uc = between("process.on('uncaughtException'", "process.on('unhandledRejection'");
check('an uncaught exception keeps the supervisor (crash: true) and never arranges a second restart', /shutdown\('an uncaught exception', \{[^}]*crash: true/.test(uc) && /plan\.restart && !supervised\s*\?\s*arrangeRestart\(\)/.test(uc), uc.slice(0, 300));
check('...a 4th error in 10 minutes stands it down instead', /else supervisor\.standDown\(/.test(uc));
check('the next start tells Owen once', /const crashNotice = supervisor\.takeNotice\(\);/.test(main) && /lookToastShow\(\{ text: crashNotice\.title, reason: crashNotice\.words/.test(main));

// ---- the scripts that stop Mantle stop the supervisor FIRST ----
const kt = fs.readFileSync(path.join(ROOT, 'tools', 'kill-test.ps1'), 'utf8');
check('kill-test.ps1 stops a test supervisor before the instance', kt.indexOf("Contains('--supervise=')") > -1 && kt.indexOf("Contains('--supervise=')") < kt.indexOf("Filter \"Name='electron.exe'\""));
const rw = fs.readFileSync(path.join(ROOT, 'tools', 'restore-windows.ps1'), 'utf8');
check('restore-windows.ps1 stops the supervisors before Mantle', rw.indexOf("Contains('--supervise=')") > -1 && rw.indexOf("Contains('--supervise=')") < rw.indexOf("Filter \"Name='electron.exe'\""));
check('the supervisor runs the restore with -NoKill (it must not stop itself)', cs.includes('"restore-windows.ps1"') && cs.includes('-NoKill -StateFile'));

try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* temp */ }
for (const f of failures) console.log('FAIL ' + f);
console.log(`SUPERVISOR: ${passed} passed, ${failures.length} failed`);
process.exitCode = failures.length ? 1 : 0;
