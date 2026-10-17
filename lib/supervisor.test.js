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
// MANTLE_SUPERVISOR_JS: run these same checks against another copy (the code from before a fix)
const S = require(process.env.MANTLE_SUPERVISOR_JS ? path.resolve(process.env.MANTLE_SUPERVISOR_JS) : './supervisor');

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
  const timeouts = [];
  let t = T;
  const o = Object.assign({
    fs, path,
    spawn: (exe, args, opts) => {
      const c = new EventEmitter();
      c.pid = 5000 + spawned.length;
      c.unref = () => { c.unrefd = true; };
      // stdout: the --supervise-detach answer pipe (lane mantle-notif-safety). Like a real child, its
      // pipe ends when the process exits.
      c.stdout = new EventEmitter();
      c.stdout.setEncoding = () => {};
      c.stdout.destroy = () => { c.stdout.destroyed = true; };
      c.answer = (line) => c.stdout.emit('data', `${line}\n`);
      const emit = c.emit.bind(c);
      c.emit = (ev, ...a) => { const r = emit(ev, ...a); if (ev === 'exit') c.stdout.emit('end'); return r; };
      spawned.push({ exe, args, opts, child: c });
      return c;
    },
    alive: () => true,
    kill: (pid) => killed.push(pid),
    now: () => t,
    log: (line) => logs.push(line),
    setInterval: (fn, ms) => { const h = { fn, ms }; intervals.push(h); return h; },
    setTimeout: (fn, ms) => { const h = { fn, ms }; timeouts.push(h); return h; },
    clearTimeout: (h) => { h.cleared = true; },
    clearInterval: (h) => { h.cleared = true; },
    pid: 4242, execPath: 'C:\\x\\electron.exe', argv: ['.', '--live', '--log=C:\\l\\mantle.log'], cwd: 'C:\\x', root: 'C:\\x',
    userData: dir, exePath: path.join(ROOT, 'package.json'), flags: { live: true }, env: {},
  }, over || {});
  const sup = S.makeSupervisor(o);
  return { sup, o, logs, spawned, killed, intervals, timeouts, tick: (ms) => { t += ms; } };
}
const readMain = () => JSON.parse(fs.readFileSync(path.join(dir, S.MAIN_FILE), 'utf8'));

{
  const r = rig();
  const st = r.sup.start();
  check('live start spawns a supervisor', st.on === true && st.via === 'spawned' && r.spawned.length === 1, st);
  const sp = r.spawned[0];
  // Was stdio:'ignore' (no pipes at all). Since --supervise-detach (lane mantle-notif-safety, 10-17) stdout
  // is a pipe for the ONE answer line, destroyed right after it; stdin and stderr stay ignored.
  check('spawned DETACHED, only stdout piped (for the one answer line)', sp && sp.opts.detached === true && JSON.stringify(sp.opts.stdio) === '["ignore","pipe","ignore"]' && sp.opts.windowsHide === true, sp && sp.opts);
  // Was args.length === 2: --supervise-detach is the third (and last) argument now.
  check('its arguments: this pid, the profile folder and --supervise-detach', sp && sp.args[0] === '--supervise=4242' && sp.args[1] === `--supervise-dir=${dir}` && sp.args[2] === '--supervise-detach' && sp.args.length === 3, sp && sp.args);
  check('unref: main never waits on it to exit', sp && sp.child.unrefd === true);
  const m = readMain();
  check('the record says how to start main again', m.pid === 4242 && m.exe === 'C:\\x\\electron.exe' && m.args.join(' ') === '. --live --log=C:\\l\\mantle.log' && m.cwd === 'C:\\x' && m.root === 'C:\\x' && m.standDown === null, m);
  sp.child.emit('spawn');
  // "crash recovery on" now waits for the answer, which names the pid that really watches. This one
  // could not detach, so it watches itself and everything below is the child-exit watch as before.
  sp.child.answer('{"supervisor":5000,"detached":false,"why":"a test said no"}');
  check('detached:false: still via spawned, the why said, the pipe destroyed', r.sup.status().via === 'spawned' && r.logs.some((l) => /could not move out of Mantle's process tree \(a test said no\)/.test(l)) && sp.child.stdout.destroyed === true, { st: r.sup.status(), logs: r.logs });
  check('the log says it is on', r.logs.some((l) => /crash recovery on: supervisor pid 5000 watches this main process \(pid 4242\)/.test(l)), r.logs);
  // the supervisor dies under main: a new one
  sp.child.emit('exit', 1);
  check('a lost supervisor is replaced', r.spawned.length === 2 && r.logs.some((l) => /the supervisor it exited \(code 1\); starting a new one/.test(l)), r.logs.slice(-2));
  r.spawned[1].child.emit('exit', 1);
  r.spawned[2].child.emit('exit', 1);
  r.spawned[3].child.emit('exit', 1);
  check('...but not forever: 3 in 10 minutes, then off and said', r.spawned.length === 4 && r.sup.status().on === false && r.logs.some((l) => /crash recovery is OFF/.test(l)), { n: r.spawned.length, logs: r.logs.slice(-2) });
}
// ---- --supervise-detach: out of main's process tree (lane mantle-notif-safety) ----
{
  // the normal case: the launcher names its copy and exits; the copy is adopted and polled
  const r = rig();
  r.sup.start();
  const sp = r.spawned[0];
  sp.child.answer('{"supervisor":6100,"detached":true}');
  check('detached:true: the copy is the supervisor (via detached), polled like an adopted one', r.sup.status().pid === 6100 && r.sup.status().via === 'detached' && r.intervals.length === 1 && r.intervals[0].ms === 10000, r.sup.status());
  check('detached:true: "on" names the copy, the 5 s timer is cleared, the pipe destroyed', r.logs.some((l) => /crash recovery on: supervisor pid 6100 watches this main process \(pid 4242\), from outside its process tree/.test(l)) && r.timeouts[0] && r.timeouts[0].ms === 5000 && r.timeouts[0].cleared === true && sp.child.stdout.destroyed === true, r.logs);
  sp.child.emit('exit', 0);
  check('the launcher exiting after its answer is not a lost supervisor', r.spawned.length === 1 && r.sup.status().pid === 6100);
  r.o.alive = () => false;
  r.intervals[0].fn();
  check('the detached copy going away goes through lost(): a new supervisor', r.spawned.length === 2 && r.logs.some((l) => /the supervisor it is no longer running; starting a new one/.test(l)), r.logs.slice(-2));
}
{
  // 'exit' before the line has been read (node does not order them): the line still wins
  const r = rig();
  r.sup.start();
  const c = r.spawned[0].child;
  c.emit('exit', 0);   // the rig's stdout ends with it, so give the line first through a fresh rig order
  check('exit then stdout end, no line: lost() at once', r.spawned.length === 2 && r.logs.some((l) => /exited \(code 0\)/.test(l)), r.logs.slice(-2));
  const r2 = rig();
  r2.sup.start();
  const c2 = r2.spawned[0].child;
  const realEmit = c2.emit;
  c2.emit = (ev, ...a) => (ev === 'exit' ? EventEmitter.prototype.emit.call(c2, ev, ...a) : realEmit(ev, ...a));   // exit WITHOUT its pipe ending
  c2.emit('exit', 0);
  c2.answer('{"supervisor":6200,"detached":true}');
  check('exit, THEN the line: the copy is adopted, nothing respawned', r2.spawned.length === 1 && r2.sup.status().pid === 6200 && r2.sup.status().via === 'detached', r2.sup.status());
}
{
  // an exe from before the flag: no line in 5 s while it runs = it supervises itself, said once. Since
  // lane notif-safety2 the pipe stays open after the 5 s (a LATE line is still adopted): was destroyed === true.
  const r = rig();
  r.sup.start();
  const sp = r.spawned[0];
  r.timeouts[0].fn();
  check('no answer in 5 s: via spawned, the old-exe words once, "on" names it', r.sup.status().via === 'spawned' && r.sup.status().pid === 5000 && r.logs.filter((l) => /predates|from before it/.test(l)).length === 1 && r.logs.some((l) => /npm run build:sidecar/.test(l)) && r.logs.some((l) => /crash recovery on: supervisor pid 5000 watches/.test(l)) && sp.child.stdout.destroyed !== true, r.logs);
  sp.child.emit('exit', 1);
  check('...and its exit is a lost supervisor, as before', r.spawned.length === 2 && r.logs.some((l) => /the supervisor it exited \(code 1\); starting a new one/.test(l)), r.logs.slice(-2));
  r.timeouts[1].fn();
  check('...the old-exe words are said once, not per supervisor', r.logs.filter((l) => /from before it/.test(l)).length === 1, r.logs);
}
{
  // standDown's kill path (the record could not be written) works for a detached copy
  const r = rig();
  r.sup.start();
  r.spawned[0].child.answer('{"supervisor":6300,"detached":true}');
  const realRename = fs.renameSync;
  fs.renameSync = () => { throw new Error('disk full'); };
  let sd;
  try { sd = r.sup.standDown('the tray menu'); } finally { fs.renameSync = realRename; }
  check('standDown with no record kills the DETACHED copy (pid 6300)', sd.via === 'kill' && r.killed[0] === 6300 && r.logs.some((l) => /supervisor \(pid 6300\) was stopped/.test(l)), { sd, killed: r.killed });
  // ...and while the answer is still on its way: the launcher now, the copy it names the moment it is read
  const r2 = rig();
  r2.sup.start();
  fs.renameSync = () => { throw new Error('disk full'); };
  try { r2.sup.standDown('the tray menu'); } finally { fs.renameSync = realRename; }
  r2.spawned[0].child.answer('{"supervisor":6400,"detached":true}');
  check('standDown kill while the answer is pending: launcher AND the copy stopped', r2.killed.join(',') === '5000,6400' && r2.sup.status().pid === null && r2.spawned.length === 1, { killed: r2.killed, st: r2.sup.status() });
}
{
  // a test supervisor can be pointed at a scratch banners key; a live one never gets the flag
  const r = rig({ flags: { test: true, supervise: true, profileName: 'mnsup' }, testBannersKey: 'Software\\MantleTest\\x\\Settings' });
  r.sup.start();
  const a = r.spawned[0].args;
  check('--supervise-banners-key only for a test supervisor, before --supervise-detach', a.includes('--supervise-banners-key=Software\\MantleTest\\x\\Settings') && a[a.length - 1] === '--supervise-detach', a);
  const r2 = rig({ testBannersKey: 'Software\\MantleTest\\x\\Settings' });
  r2.sup.start();
  check('a live supervisor never gets --supervise-banners-key', !r2.spawned[0].args.some((x) => /banners-key/.test(x)), r2.spawned[0].args);
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

// ---- ONE supervisor per main: a LATE --supervise-detach answer (lane mantle-notif-safety2, review 6 finding 1) ----
const poll = (x) => { const iv = x.intervals[x.intervals.length - 1]; if (iv) iv.fn(); };   // the adopted poll, if there is one
{
  // The review's repro: the launcher answers AFTER the 5 s, then exits 0. Before the fix the 5 s destroyed
  // stdout, the launcher's exit read as a lost supervisor, and a SECOND launcher (and copy) started while the
  // first copy, unknown to main, kept watching: two supervisors on one main, both restarting it after a crash.
  const r = rig();
  r.sup.start();
  const c = r.spawned[0].child;
  r.timeouts[0].fn();                                   // 5 s, no line yet
  c.answer('{"supervisor":6100,"detached":true}');       // the line, late
  c.emit('exit', 0);                                     // the launcher's exit (the rig ends its pipe with it)
  check('LATE answer: exactly one launcher was ever spawned', r.spawned.length === 1, { spawned: r.spawned.length, logs: r.logs });
  check('LATE answer: the copy main knows is the one that watches (6100, detached)', r.sup.status().pid === 6100 && r.sup.status().via === 'detached', r.sup.status());
  check('LATE answer: said in words', r.logs.some((l) => /answered after \d+ s/.test(l)), r.logs);
  r.o.alive = () => false;
  poll(r);
  check('LATE answer: the copy going away later starts exactly ONE new launcher', r.spawned.length === 2, r.spawned.length);
}
{
  // the same, with node delivering the launcher's exit BEFORE the late line (and no pipe end with it)
  const r = rig();
  r.sup.start();
  const c = r.spawned[0].child;
  const realEmit = c.emit;
  c.emit = (ev, ...a) => (ev === 'exit' ? EventEmitter.prototype.emit.call(c, ev, ...a) : realEmit(ev, ...a));
  r.timeouts[0].fn();
  c.emit('exit', 0);
  check('LATE, exit first: nothing respawned while its line may still come', r.spawned.length === 1, r.spawned.length);
  c.answer('{"supervisor":6150,"detached":true}');
  check('LATE, exit first, then the line: the copy is adopted, one launcher only', r.spawned.length === 1 && r.sup.status().pid === 6150 && r.sup.status().via === 'detached', r.sup.status());
}
{
  // late, then it exits with NO line (its pipe ends): a real loss, one replacement
  const r = rig();
  r.sup.start();
  r.timeouts[0].fn();
  r.spawned[0].child.emit('exit', 1);
  check('LATE, then an exit with no line: one replacement', r.spawned.length === 2 && r.logs.some((l) => /the supervisor it exited \(code 1\); starting a new one/.test(l)), r.logs.slice(-2));
}
{
  // an exit whose pipe something else still holds open: settled after 3 s, not never
  const r = rig();
  r.sup.start();
  const c = r.spawned[0].child;
  const realEmit = c.emit;
  c.emit = (ev, ...a) => (ev === 'exit' ? EventEmitter.prototype.emit.call(c, ev, ...a) : realEmit(ev, ...a));
  c.emit('exit', 0);
  const drain = r.timeouts.find((h) => h.ms === 3000);
  check('exit with its pipe still open: a 3 s drain', !!drain, r.timeouts.map((h) => h.ms));
  if (drain) drain.fn();
  check('...which settles it as lost: one replacement', r.spawned.length === 2, r.spawned.length);
}
{
  // a launcher that found a supervisor ALREADY watching this main names it (existing): adopted, no copy
  const r = rig();
  r.sup.start();
  r.spawned[0].child.answer('{"supervisor":6500,"detached":true,"existing":true}');
  check('existing: the holder is adopted (pid 6500, polled), said so', r.sup.status().pid === 6500 && r.sup.status().via === 'detached' && r.logs.some((l) => /6500 watches .*already watching it/.test(l)), { st: r.sup.status(), logs: r.logs });
}
// ---- the adopted poll knows a pid Windows handed on (review 6 finding 6) ----
{
  const stFile = path.join(dir, S.STATE_FILE);
  const lockFile = path.join(dir, 'supervisor.lock');
  let free = false;
  const r = rig({ lockFree: () => free });
  r.sup.start();
  r.spawned[0].child.answer('{"supervisor":6600,"detached":true}');
  fs.writeFileSync(stFile, JSON.stringify({ v: 1, supervisorPid: 6600, lock: true, watching: 4242 }));
  poll(r);
  check('supervisor.lock held: the adopted supervisor is kept', r.spawned.length === 1 && r.sup.status().pid === 6600);
  free = true;
  poll(r);
  check('its pid alive but its supervisor.lock free: lost (the pid is another process), one replacement', r.spawned.length === 2 && r.logs.some((l) => /supervisor\.lock is free, so pid 6600 belongs to another process/.test(l)), r.logs.slice(-2));
  // the pid alone decides when the state names another supervisor, or comes from an exe without the lock
  const r2 = rig({ lockFree: () => true });
  r2.sup.start();
  r2.spawned[0].child.answer('{"supervisor":6700,"detached":true}');
  fs.writeFileSync(stFile, JSON.stringify({ v: 1, supervisorPid: 6800, lock: true }));
  poll(r2);
  check('the state naming another supervisor: kept (the pid alone decides)', r2.spawned.length === 1 && r2.sup.status().pid === 6700);
  fs.writeFileSync(stFile, JSON.stringify({ v: 1, supervisorPid: 6700 }));
  poll(r2);
  check('an exe from before supervisor.lock (no lock in its state): kept', r2.spawned.length === 1 && r2.sup.status().pid === 6700);
  // the default look: fs.openSync on the real file (no file = cannot tell = kept; opens = free = lost)
  const r3 = rig();
  r3.sup.start();
  r3.spawned[0].child.answer('{"supervisor":6900,"detached":true}');
  fs.writeFileSync(stFile, JSON.stringify({ v: 1, supervisorPid: 6900, lock: true }));
  try { fs.unlinkSync(lockFile); } catch (_) { /* none */ }
  poll(r3);
  check('default look, no supervisor.lock file: kept', r3.spawned.length === 1);
  fs.writeFileSync(lockFile, '');
  poll(r3);
  check('default look, supervisor.lock opens freely: lost, one replacement', r3.spawned.length === 2, r3.logs.slice(-2));
  try { fs.unlinkSync(stFile); } catch (_) { /* gone */ }
  try { fs.unlinkSync(lockFile); } catch (_) { /* gone */ }
}
// ---- standDown's kill road sweeps copies nobody named (review 6 finding 5) ----
{
  const calls = [];
  const r = rig({ killSupervisorsOf: (pid) => calls.push(pid) });
  r.sup.start();
  const realRename = fs.renameSync;
  fs.renameSync = () => { throw new Error('disk full'); };
  try { r.sup.standDown('the tray menu'); } finally { fs.renameSync = realRename; }
  check('standDown kill road: every supervisor of THIS main is swept by its command line', calls.length === 1 && calls[0] === 4242 && r.logs.some((l) => /stopped by its command line/.test(l)), { calls, logs: r.logs.slice(-1) });
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  check('main.js gives it a detached, hidden PowerShell that matches --supervise=<pid> exactly', /killSupervisorsOf: \(mainPid\) =>/.test(main) && main.includes("--supervise=${n}(\\\\s|\"|$)") && /detached: true, stdio: 'ignore', windowsHide: true/.test(main));
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
